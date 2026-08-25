import crypto from "node:crypto";
import Database from "better-sqlite3";
import { runImmediateTransaction } from "@/lib/db/immediate-transaction";

type Db = InstanceType<typeof Database>;

function open(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function audit(db: Db, action: string, sourceId: string, now: string) {
  db.prepare(
    `INSERT INTO admin_audit_events (
       id, action, target_type, target_id, outcome, created_at
     ) VALUES (?, ?, 'corpus_source', ?, 'success', ?)`,
  ).run(`audit_${crypto.randomUUID()}`, action, sourceId, now);
}

function sourceState(db: Db, sourceId: string) {
  return db
    .prepare(
      `SELECT id, state, config_revision, validated_at, ever_validated_at
         FROM corpus_sources
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(sourceId) as
    | {
        id: string;
        state: string;
        config_revision: number;
        validated_at: string | null;
        ever_validated_at: string | null;
      }
    | undefined;
}

export function recordSourceValidation(
  dbPath: string,
  sourceId: string,
  result: { valid: boolean; errorSummary?: string },
) {
  const now = new Date().toISOString();
  const db = open(dbPath);
  try {
    return runImmediateTransaction(db, () => {
      const source = sourceState(db, sourceId);
      if (!source) {
        return false;
      }
      if (result.valid) {
        db.prepare(
          `UPDATE corpus_sources
              SET state = 'active', validated_at = ?, ever_validated_at = ?,
                  health_state = 'normal',
                  consecutive_failure_count = 0, error_summary = NULL,
                  validation_requested_at = NULL, next_sync_at = ?, updated_at = ?
            WHERE id = ?`,
        ).run(now, now, now, now, sourceId);
      } else {
        const nextState = source.ever_validated_at ? "needs_attention" : "draft";
        db.prepare(
          `UPDATE corpus_sources
              SET state = ?, validated_at = NULL, health_state = 'needs_attention',
                  validation_requested_at = NULL, error_summary = ?,
                  next_sync_at = NULL, updated_at = ?
            WHERE id = ?`,
        ).run(
          nextState,
          (result.errorSummary ?? "Source validation failed.").slice(0, 500),
          now,
          sourceId,
        );
      }
      audit(db, result.valid ? "source.validation.succeeded" : "source.validation.failed", sourceId, now);
      return true;
    });
  } finally {
    db.close();
  }
}

export function disableCorpusSource(dbPath: string, sourceId: string) {
  const now = new Date().toISOString();
  const db = open(dbPath);
  try {
    return runImmediateTransaction(db, () => {
      if (!sourceState(db, sourceId)) {
        return false;
      }
      if (hasActiveSourceMigration(db, sourceId)) {
        throw new Error("Cancel the active Seeyon URL migration before disabling this source.");
      }
      db.prepare(
        `UPDATE corpus_sources
            SET state = 'disabled', next_sync_at = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(now, sourceId);
      db.prepare(
        `UPDATE projects
            SET lifecycle_state = 'inactive', retrieval_eligible = 0, updated_at = ?
          WHERE source_id = ?`,
      ).run(now, sourceId);
      db.prepare(
        `UPDATE jobs
            SET status = 'superseded', superseded_at = ?, updated_at = ?, finished_at = ?
          WHERE source_id = ? AND status = 'queued'`,
      ).run(now, now, now, sourceId);
      db.prepare(
        `UPDATE sync_runs
            SET status = 'superseded', completed_at = ?, error_summary = 'Source disabled'
          WHERE source_id = ? AND status = 'queued'`,
      ).run(now, sourceId);
      audit(db, "source.disable", sourceId, now);
      return true;
    });
  } finally {
    db.close();
  }
}

export function enableCorpusSource(dbPath: string, sourceId: string) {
  const now = new Date().toISOString();
  const db = open(dbPath);
  try {
    return runImmediateTransaction(db, () => {
      const source = sourceState(db, sourceId);
      if (!source) {
        return false;
      }
      if (source.state !== "disabled" && source.state !== "needs_attention") {
        throw new Error("Only a disabled or needs-attention source can be enabled.");
      }
      db.prepare(
        `UPDATE corpus_sources
            SET state = 'validation_pending', validated_at = NULL,
                validation_requested_at = ?, health_state = 'unknown',
                error_summary = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(now, now, sourceId);
      audit(db, "source.enable", sourceId, now);
      return true;
    });
  } finally {
    db.close();
  }
}

export function requestSourceValidation(dbPath: string, sourceId: string) {
  const now = new Date().toISOString();
  const db = open(dbPath);
  try {
    return runImmediateTransaction(db, () => {
      const source = sourceState(db, sourceId);
      if (!source) {
        return false;
      }
      if (source.state === "disabled" || source.state === "pending_purge") {
        throw new Error("Disabled or pending-purge sources cannot be validated.");
      }
      if (hasActiveSourceMigration(db, sourceId)) {
        throw new Error("Wait for the active Seeyon URL migration to finish before validating this source.");
      }
      db.prepare(
        `UPDATE corpus_sources
            SET validation_requested_at = ?, health_state = 'unknown',
                error_summary = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(now, now, sourceId);
      audit(db, "source.validation.request", sourceId, now);
      return true;
    });
  } finally {
    db.close();
  }
}

export function queueManualSourceSync(dbPath: string, sourceId: string) {
  const now = new Date().toISOString();
  const db = open(dbPath);
  try {
    return runImmediateTransaction(db, () => {
      const source = sourceState(db, sourceId);
      if (!source) {
        throw new Error("Corpus Source not found.");
      }
      if (source.state !== "active") {
        throw new Error("Only an active Corpus Source can synchronize.");
      }
      const migration = db
        .prepare(
          `SELECT 1 FROM corpus_source_migrations
            WHERE source_id = ? AND status IN ('requested', 'validating', 'syncing', 'applying')
            LIMIT 1`,
        )
        .get(sourceId);
      if (migration) {
        throw new Error("Cannot synchronize while a Seeyon URL migration is in progress.");
      }
      db.prepare(
        `UPDATE corpus_sources SET next_sync_at = ?, updated_at = ? WHERE id = ?`,
      ).run(now, now, sourceId);
      const collections = db
        .prepare(
          `SELECT id, filter_revision
             FROM source_collections
            WHERE source_id = ?
              AND selected = 1
              AND validation_state = 'valid'
              AND registration_state = 'active'
              AND deleted_at IS NULL`,
        )
        .all(sourceId) as Array<{ id: string; filter_revision: number }>;
      let queued = 0;
      let coalesced = 0;
      for (const collection of collections) {
        const active = db
          .prepare(
            `SELECT id FROM sync_runs
              WHERE collection_id = ? AND status IN ('queued', 'running')`,
          )
          .get(collection.id) as { id: string } | undefined;
        if (active) {
          db.prepare("UPDATE sync_runs SET follow_up_requested = 1 WHERE id = ?").run(active.id);
          coalesced += 1;
          continue;
        }
        db.prepare(
          `INSERT INTO sync_runs (
             id, source_id, collection_id, source_config_revision,
             collection_filter_revision, trigger_kind, status, started_at
           ) VALUES (?, ?, ?, ?, ?, 'manual', 'queued', ?)`,
        ).run(
          `sync_${crypto.randomUUID()}`,
          sourceId,
          collection.id,
          source.config_revision,
          collection.filter_revision,
          now,
        );
        queued += 1;
      }
      audit(db, "source.sync.manual", sourceId, now);
      return { queued, coalesced, discoveryRequested: true };
    });
  } finally {
    db.close();
  }
}

export function requestCorpusSourcePurge(
  dbPath: string,
  sourceId: string,
  options: { immediate?: boolean } = {},
) {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const purgeAfter = options.immediate
    ? now
    : new Date(nowDate.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const db = open(dbPath);
  try {
    return runImmediateTransaction(db, () => {
      if (!sourceState(db, sourceId)) {
        return null;
      }
      if (hasActiveSourceMigration(db, sourceId)) {
        throw new Error("Cancel the active Seeyon URL migration before purging this source.");
      }
      disableCorpusSourceWithinTransaction(db, sourceId, now);
      db.prepare(
        `UPDATE corpus_sources
            SET state = 'pending_purge', purge_after = ?, updated_at = ?
          WHERE id = ?`,
      ).run(purgeAfter, now, sourceId);
      db.prepare(
        `UPDATE source_collections
            SET lifecycle_state = 'pending_purge', purge_after = ?, updated_at = ?
          WHERE source_id = ?`,
      ).run(purgeAfter, now, sourceId);
      db.prepare(
        `UPDATE projects
            SET lifecycle_state = 'pending_purge', purge_after = ?,
                retrieval_eligible = 0, updated_at = ?
          WHERE source_id = ?`,
      ).run(purgeAfter, now, sourceId);
      audit(db, options.immediate ? "source.purge.immediate" : "source.purge.request", sourceId, now);
      return { purgeAfter };
    });
  } finally {
    db.close();
  }
}

function hasActiveSourceMigration(db: Db, sourceId: string) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM corpus_source_migrations
          WHERE source_id = ? AND status IN ('requested', 'validating', 'syncing', 'applying')
          LIMIT 1`,
      )
      .get(sourceId),
  );
}

export function restoreCorpusSource(dbPath: string, sourceId: string) {
  const now = new Date().toISOString();
  const db = open(dbPath);
  try {
    return runImmediateTransaction(db, () => {
      const source = sourceState(db, sourceId);
      if (!source) {
        return false;
      }
      if (source.state !== "pending_purge") {
        throw new Error("Only a pending-purge source can be restored.");
      }
      db.prepare(
        `UPDATE corpus_sources
            SET state = 'disabled', purge_after = NULL, validated_at = NULL,
                health_state = 'unknown', updated_at = ?
          WHERE id = ?`,
      ).run(now, sourceId);
      db.prepare(
        `UPDATE source_collections
            SET lifecycle_state = 'inactive', purge_after = NULL, updated_at = ?
          WHERE source_id = ?`,
      ).run(now, sourceId);
      db.prepare(
        `UPDATE projects
            SET lifecycle_state = 'inactive', purge_after = NULL,
                retrieval_eligible = 0, updated_at = ?
          WHERE source_id = ?`,
      ).run(now, sourceId);
      audit(db, "source.purge.restore", sourceId, now);
      return true;
    });
  } finally {
    db.close();
  }
}

function disableCorpusSourceWithinTransaction(db: Db, sourceId: string, now: string) {
  db.prepare(
    `UPDATE jobs
        SET status = 'superseded', superseded_at = ?, updated_at = ?, finished_at = ?
      WHERE source_id = ? AND status = 'queued'`,
  ).run(now, now, now, sourceId);
  db.prepare(
    `UPDATE sync_runs
        SET status = 'superseded', completed_at = ?, error_summary = 'Source pending purge'
      WHERE source_id = ? AND status = 'queued'`,
  ).run(now, sourceId);
}
