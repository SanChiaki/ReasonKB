import crypto from "node:crypto";
import Database from "better-sqlite3";
import { runImmediateTransaction } from "@/lib/db/immediate-transaction";
import type { SeeyonSourceMigrationInput } from "@/lib/corpus-source-input";
import {
  decryptSourceCredentials,
  encryptSourceCredentials,
} from "@/lib/security/source-credentials";

type Db = InstanceType<typeof Database>;

const ACTIVE_STATUSES = ["requested", "validating", "syncing", "applying"] as const;

function open(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function parseJson(value: unknown) {
  return JSON.parse(String(value ?? "{}")) as Record<string, unknown>;
}

function migrationView(db: Db, row: Record<string, unknown>) {
  const progress = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status IN ('queued', 'running', 'scanned') THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM sync_runs WHERE migration_id = ?`,
    )
    .get(row.id) as Record<string, unknown>;
  return {
    id: row.id,
    status: row.status,
    targetScope: parseJson(row.target_scope_json),
    targetConfig: parseJson(row.target_config_json),
    errorSummary: row.error_summary,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    progress: {
      totalCollections: Number(progress.total ?? 0),
      completedCollections: Number(progress.completed ?? 0),
      pendingCollections: Number(progress.pending ?? 0),
      failedCollections: Number(progress.failed ?? 0),
    },
  };
}

export function latestSourceMigration(dbPath: string, sourceId: string) {
  const db = open(dbPath);
  try {
    return latestSourceMigrationInDatabase(db, sourceId);
  } finally {
    db.close();
  }
}

export function latestSourceMigrationInDatabase(db: Db, sourceId: string) {
  const row = db
    .prepare(
      `SELECT * FROM corpus_source_migrations
        WHERE source_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sourceId) as Record<string, unknown> | undefined;
  return row ? migrationView(db, row) : null;
}

export function requestSeeyonSourceMigration(
  dbPath: string,
  masterKey: Buffer,
  sourceId: string,
  input: SeeyonSourceMigrationInput,
) {
  const migrationId = `migration_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const db = open(dbPath);
  try {
    return runImmediateTransaction(db, () => {
      const source = db
        .prepare("SELECT * FROM corpus_sources WHERE id = ? AND deleted_at IS NULL")
        .get(sourceId) as Record<string, unknown> | undefined;
      if (!source) throw new Error("Corpus Source not found.");
      if (source.kind !== "seeyon") {
        throw new Error("Only Seeyon sources support URL migration.");
      }
      if (source.state !== "active") {
        throw new Error("Only an active Seeyon source can migrate its URL.");
      }
      const active = db
        .prepare(
          `SELECT id FROM corpus_source_migrations
            WHERE source_id = ? AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})
            LIMIT 1`,
        )
        .get(sourceId, ...ACTIVE_STATUSES);
      if (active) throw new Error("A Seeyon URL migration is already in progress.");
      const runningSync = db
        .prepare(
          `SELECT 1 FROM sync_runs WHERE source_id = ? AND status IN ('queued', 'running') LIMIT 1`,
        )
        .get(sourceId);
      if (runningSync) throw new Error("Wait for the current source synchronization to finish before migrating.");
      const runningJob = db
        .prepare(
          `SELECT 1 FROM jobs WHERE source_id = ? AND status = 'running' LIMIT 1`,
        )
        .get(sourceId);
      if (runningJob) throw new Error("Wait for current document indexing to finish before migrating.");

      const oldScope = parseJson(source.scope_json);
      const nextScope = { endpoint: input.scope.endpoint.replace(/\/+$/, "") };
      const oldEndpoint = typeof oldScope.endpoint === "string"
        ? oldScope.endpoint.replace(/\/+$/, "")
        : oldScope.endpoint;
      if (oldEndpoint === nextScope.endpoint) {
        throw new Error("The migration endpoint must differ from the current endpoint.");
      }
      const oldConfig = parseJson(source.config_json);
      const nextConfig = { ...oldConfig, ...(input.config ?? {}) };
      const credentialsRow = db
        .prepare("SELECT encrypted_payload FROM source_credentials WHERE source_id = ?")
        .get(sourceId) as { encrypted_payload: string } | undefined;
      if (!credentialsRow) throw new Error("Source credentials are not configured.");
      const oldCredentials = decryptSourceCredentials(masterKey, sourceId, credentialsRow.encrypted_payload);
      const nextCredentials = { ...oldCredentials, ...(input.credentials ?? {}) };
      if (!nextCredentials.username || !nextCredentials.password) {
        throw new Error("Seeyon migration credentials are incomplete.");
      }
      const encryptedCredentials = encryptSourceCredentials(masterKey, sourceId, nextCredentials);
      db.prepare(
        `INSERT INTO corpus_source_migrations (
           id, source_id, source_config_revision, target_scope_json,
           target_config_json, encrypted_credentials, status,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?)`,
      ).run(
        migrationId,
        sourceId,
        source.config_revision,
        JSON.stringify(nextScope),
        JSON.stringify(nextConfig),
        encryptedCredentials,
        now,
        now,
      );
      db.prepare(
        `UPDATE sync_runs SET status = 'superseded', completed_at = ?,
               error_summary = 'Superseded by Seeyon URL migration'
          WHERE source_id = ? AND status = 'queued'`,
      ).run(now, sourceId);
      db.prepare(
        `UPDATE corpus_sources SET next_sync_at = NULL, updated_at = ? WHERE id = ?`,
      ).run(now, sourceId);
      db.prepare(
        `INSERT INTO admin_audit_events (
           id, action, target_type, target_id, outcome, before_json, after_json, created_at
         ) VALUES (?, 'source.migration.request', 'corpus_source', ?, 'success', ?, ?, ?)`,
      ).run(
        `audit_${crypto.randomUUID()}`,
        sourceId,
        JSON.stringify({ scope: oldScope, configRevision: source.config_revision }),
        JSON.stringify({ scope: nextScope, migrationId }),
        now,
      );
      const row = db.prepare("SELECT * FROM corpus_source_migrations WHERE id = ?").get(migrationId) as Record<string, unknown>;
      return migrationView(db, row);
    });
  } finally {
    db.close();
  }
}

export function cancelSourceMigration(dbPath: string, sourceId: string) {
  const now = new Date().toISOString();
  const db = open(dbPath);
  try {
    return runImmediateTransaction(db, () => {
      const migration = db
        .prepare(
          `SELECT * FROM corpus_source_migrations
            WHERE source_id = ? AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(sourceId, ...ACTIVE_STATUSES) as Record<string, unknown> | undefined;
      if (!migration) return null;
      db.prepare(
        `UPDATE corpus_source_migrations SET status = 'cancelled',
               completed_at = ?, updated_at = ?, error_summary = 'Cancelled by administrator'
          WHERE id = ?`,
      ).run(now, now, migration.id);
      db.prepare(
        `UPDATE sync_runs SET status = 'superseded', completed_at = ?,
               error_summary = 'Seeyon URL migration cancelled'
          WHERE migration_id = ? AND status IN ('queued', 'running', 'scanned')`,
      ).run(now, migration.id);
      db.prepare("DELETE FROM sync_run_observations WHERE run_id IN (SELECT id FROM sync_runs WHERE migration_id = ?)").run(migration.id);
      db.prepare("UPDATE corpus_sources SET next_sync_at = ?, updated_at = ? WHERE id = ?").run(now, now, sourceId);
      db.prepare(
        `INSERT INTO admin_audit_events (
           id, action, target_type, target_id, outcome, created_at
         ) VALUES (?, 'source.migration.cancel', 'corpus_source', ?, 'success', ?)`,
      ).run(`audit_${crypto.randomUUID()}`, sourceId, now);
      return migrationView(db, db.prepare("SELECT * FROM corpus_source_migrations WHERE id = ?").get(migration.id) as Record<string, unknown>);
    });
  } finally {
    db.close();
  }
}
