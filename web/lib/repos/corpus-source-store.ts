import crypto from "node:crypto";
import Database from "better-sqlite3";
import { runImmediateTransaction } from "@/lib/db/immediate-transaction";
import type {
  CreateCorpusSourceInput,
  UpdateCorpusSourceInput,
} from "@/lib/corpus-source-input";
import {
  decryptSourceCredentials,
  encryptSourceCredentials,
} from "@/lib/security/source-credentials";

function open(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function parseJsonObject(value: string) {
  return JSON.parse(value) as Record<string, unknown>;
}

function sourceView(row: Record<string, unknown>) {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    state: row.state,
    scope: parseJsonObject(row.scope_json as string),
    config: parseJsonObject(row.config_json as string),
    configRevision: row.config_revision,
    selectionPolicy: row.selection_policy,
    schedule: {
      mode: row.schedule_mode,
      intervalSeconds: row.sync_interval_seconds,
      maxDocumentSizeBytes: row.max_document_size_bytes,
    },
    health: {
      state: row.health_state,
      consecutiveFailureCount: row.consecutive_failure_count,
      lastSuccessAt: row.last_success_at,
      nextSyncAt: row.next_sync_at,
      errorSummary: row.error_summary,
    },
    validatedAt: row.validated_at,
    purgeAfter: row.purge_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertAudit(
  db: InstanceType<typeof Database>,
  input: {
    action: string;
    targetId: string;
    outcome?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    errorSummary?: string | null;
    now: string;
  },
) {
  db.prepare(
    `INSERT INTO admin_audit_events (
       id, action, target_type, target_id, outcome, before_json, after_json,
       error_summary, created_at
     ) VALUES (?, ?, 'corpus_source', ?, ?, ?, ?, ?, ?)`,
  ).run(
    `audit_${crypto.randomUUID()}`,
    input.action,
    input.targetId,
    input.outcome ?? "success",
    input.before ? JSON.stringify(input.before) : null,
    input.after ? JSON.stringify(input.after) : null,
    input.errorSummary ?? null,
    input.now,
  );
}

export function listCorpusSources(dbPath: string) {
  const db = open(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT *
           FROM corpus_sources
          WHERE deleted_at IS NULL
          ORDER BY display_name COLLATE NOCASE`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(sourceView);
  } finally {
    db.close();
  }
}

export function getCorpusSource(dbPath: string, sourceId: string) {
  const db = open(dbPath);
  try {
    const row = db
      .prepare("SELECT * FROM corpus_sources WHERE id = ? AND deleted_at IS NULL")
      .get(sourceId) as Record<string, unknown> | undefined;
    return row ? sourceView(row) : null;
  } finally {
    db.close();
  }
}

export function createCorpusSource(
  dbPath: string,
  masterKey: Buffer,
  input: CreateCorpusSourceInput,
) {
  const sourceId = `src_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const encrypted = encryptSourceCredentials(masterKey, sourceId, input.credentials);
  const db = open(dbPath);
  try {
    runImmediateTransaction(db, () => {
      db.prepare(
        `INSERT INTO corpus_sources (
           id, kind, display_name, state, scope_json, config_json,
           config_revision, selection_policy, schedule_mode,
           sync_interval_seconds, max_document_size_bytes, health_state,
           validation_requested_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'draft', ?, ?, 1, 'none', ?, ?, ?, 'unknown', ?, ?, ?)`,
      ).run(
        sourceId,
        input.kind,
        input.displayName,
        JSON.stringify(input.scope),
        JSON.stringify(input.config),
        input.schedule.mode,
        input.schedule.intervalSeconds,
        input.schedule.maxDocumentSizeBytes,
        now,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO source_credentials (
           source_id, encrypted_payload, key_version, created_at, updated_at
         ) VALUES (?, ?, 1, ?, ?)`,
      ).run(sourceId, encrypted, now, now);
      insertAudit(db, {
        action: "source.create",
        targetId: sourceId,
        after: { kind: input.kind, displayName: input.displayName, scope: input.scope },
        now,
      });
    });
  } finally {
    db.close();
  }
  return getCorpusSource(dbPath, sourceId)!;
}

function principalChanged(
  kind: string,
  oldConfig: Record<string, unknown>,
  nextConfig: Record<string, unknown>,
  oldCredentials: Record<string, unknown>,
  nextCredentials: Record<string, unknown>,
) {
  if (kind === "seeyon" && oldConfig.loginName !== nextConfig.loginName) {
    return true;
  }
  if (kind === "seeyon" || kind === "smb") {
    return oldCredentials.username !== nextCredentials.username;
  }
  return false;
}

export function updateCorpusSource(
  dbPath: string,
  masterKey: Buffer,
  sourceId: string,
  input: UpdateCorpusSourceInput,
) {
  const db = open(dbPath);
  try {
    return runImmediateTransaction(db, () => {
      const row = db
        .prepare("SELECT * FROM corpus_sources WHERE id = ? AND deleted_at IS NULL")
        .get(sourceId) as Record<string, unknown> | undefined;
      if (!row) {
        return null;
      }
      const oldView = sourceView(row);
      const oldConfig = parseJsonObject(row.config_json as string);
      const oldCredentialRow = db
        .prepare("SELECT encrypted_payload FROM source_credentials WHERE source_id = ?")
        .get(sourceId) as { encrypted_payload: string } | undefined;
      const oldCredentials = oldCredentialRow
        ? decryptSourceCredentials(masterKey, sourceId, oldCredentialRow.encrypted_payload)
        : {};
      const nextConfig = input.config ? { ...oldConfig, ...input.config } : oldConfig;
      const nextCredentials = input.credentials
        ? { ...oldCredentials, ...input.credentials }
        : oldCredentials;
      const changedPrincipal = principalChanged(
        row.kind as string,
        oldConfig,
        nextConfig,
        oldCredentials,
        nextCredentials,
      );
      const now = new Date().toISOString();
      const requiresValidation = Boolean(input.config || input.credentials);
      const nextState = !requiresValidation
        ? row.state
        : row.state === "draft"
          ? "draft"
          : row.state === "active" && !changedPrincipal
            ? "active"
            : "validation_pending";
      const validationRequestedAt = requiresValidation
        ? now
        : row.validation_requested_at;
      const nextHealthState = requiresValidation ? "unknown" : row.health_state;
      db.prepare(
        `UPDATE corpus_sources
            SET display_name = ?, config_json = ?, config_revision = config_revision + 1,
                schedule_mode = ?, sync_interval_seconds = ?,
                max_document_size_bytes = ?, state = ?, validated_at = NULL,
                validation_requested_at = ?, health_state = ?,
                error_summary = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.displayName ?? row.display_name,
        JSON.stringify(nextConfig),
        input.schedule?.mode ?? row.schedule_mode,
        input.schedule?.intervalSeconds ?? row.sync_interval_seconds,
        input.schedule?.maxDocumentSizeBytes ?? row.max_document_size_bytes,
        nextState,
        validationRequestedAt,
        nextHealthState,
        now,
        sourceId,
      );
      if (input.credentials) {
        const encrypted = encryptSourceCredentials(masterKey, sourceId, nextCredentials);
        db.prepare(
          `INSERT INTO source_credentials (
             source_id, encrypted_payload, key_version, created_at, updated_at
           ) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(source_id) DO UPDATE SET
             encrypted_payload = excluded.encrypted_payload,
             key_version = excluded.key_version,
             updated_at = excluded.updated_at`,
        ).run(sourceId, encrypted, now, now);
      }
      if (changedPrincipal) {
        db.prepare(
          `UPDATE projects
              SET retrieval_eligible = 0, updated_at = ?
            WHERE source_id = ?`,
        ).run(now, sourceId);
      }
      const nextRow = db.prepare("SELECT * FROM corpus_sources WHERE id = ?").get(sourceId) as Record<
        string,
        unknown
      >;
      insertAudit(db, {
        action: input.credentials ? "source.credentials.update" : "source.update",
        targetId: sourceId,
        before: oldView,
        after: sourceView(nextRow),
        now,
      });
      return sourceView(nextRow);
    });
  } finally {
    db.close();
  }
}
