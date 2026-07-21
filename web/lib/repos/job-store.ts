import crypto from "node:crypto";
import Database from "better-sqlite3";

function open(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

type Db = ReturnType<typeof open>;

type IndexableDocument = {
  id: string;
  source_id: string | null;
  source_collection_id: string | null;
  expected_source_revision: string | null;
  expected_source_config_revision: number | null;
  lifecycle_state: string;
  source_state: string | null;
  config_revision: number | null;
  selected: number | null;
  collection_state: string | null;
  project_state: string;
};

type QueueOutcome = "created" | "requeued" | "running";

function getIndexableDocument(db: Db, documentId: string) {
  return db
    .prepare(
      `SELECT d.id, d.source_id, d.source_collection_id,
              d.expected_source_revision, d.expected_source_config_revision,
              d.lifecycle_state, s.state AS source_state,
              s.config_revision, c.selected, c.lifecycle_state AS collection_state,
              p.lifecycle_state AS project_state
         FROM documents d
         JOIN projects p ON p.id = d.project_id
         LEFT JOIN corpus_sources s ON s.id = d.source_id
         LEFT JOIN source_collections c ON c.id = d.source_collection_id
        WHERE d.id = ? AND d.deleted_at IS NULL`,
    )
    .get(documentId) as IndexableDocument | undefined;
}

function assertDocumentIsIndexable(document: IndexableDocument | undefined) {
  if (!document) throw new Error("Document not found.");
  if (
    document.source_id &&
    (document.lifecycle_state !== "active" ||
      document.source_state !== "active" ||
      !document.selected ||
      !["pending", "active"].includes(document.collection_state ?? "") ||
      !["pending", "active"].includes(document.project_state) ||
      document.expected_source_config_revision !== document.config_revision)
  ) {
    throw new Error("Document source is not currently eligible for indexing.");
  }
  return document;
}

function queueIndexJob(
  db: Db,
  document: IndexableDocument,
): { job: { id: string; status: string }; outcome: QueueOutcome } {
  const existing = db
    .prepare(
      `SELECT id, status FROM jobs
        WHERE document_id = ? AND status IN ('queued', 'running')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(document.id) as { id: string; status: "queued" | "running" } | undefined;
  const now = new Date().toISOString();
  if (existing?.status === "queued") {
    const result = db
      .prepare(
        `UPDATE jobs
            SET payload_json = ?, progress = 0, error_message = NULL,
                updated_at = ?, finished_at = NULL, source_id = ?,
                source_collection_id = ?, expected_source_revision = ?,
                expected_source_config_revision = ?, priority = 50,
                attempt_count = 0, max_attempts = 6, available_at = ?,
                claimed_at = NULL, worker_id = NULL, superseded_at = NULL
          WHERE id = ? AND status = 'queued'`,
      )
      .run(
        JSON.stringify({
          documentId: document.id,
          expectedSourceRevision: document.expected_source_revision,
        }),
        now,
        document.source_id,
        document.source_collection_id,
        document.expected_source_revision,
        document.expected_source_config_revision,
        now,
        existing.id,
      );
    if (result.changes > 0) {
      return { job: existing, outcome: "requeued" };
    }
  }
  if (existing) {
    return { job: existing, outcome: "running" };
  }

  const id = `job_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO jobs (
       id, type, document_id, payload_json, status, source_id,
       source_collection_id, expected_source_revision,
       expected_source_config_revision, priority, max_attempts, available_at,
       created_at, updated_at
     ) VALUES (?, 'document_index', ?, ?, 'queued', ?, ?, ?, ?, 50, 6, ?, ?, ?)`,
  ).run(
    id,
    document.id,
    JSON.stringify({
      documentId: document.id,
      expectedSourceRevision: document.expected_source_revision,
    }),
    document.source_id,
    document.source_collection_id,
    document.expected_source_revision,
    document.expected_source_config_revision,
    now,
    now,
    now,
  );
  return { job: { id, status: "queued" }, outcome: "created" };
}

function resetDocumentMetrics(db: Db, documentId: string) {
  db.prepare(
    `UPDATE documents
        SET page_count = NULL, error_message = NULL,
            last_index_duration_ms = NULL, last_index_total_tokens = NULL,
            last_index_llm_call_count = NULL, last_indexed_at = NULL,
            updated_at = ?
      WHERE id = ?`,
  ).run(new Date().toISOString(), documentId);
}

export function createIndexJob(dbPath: string, documentId: string) {
  const db = open(dbPath);
  try {
    return db.transaction(() => {
      const document = assertDocumentIsIndexable(getIndexableDocument(db, documentId));
      return queueIndexJob(db, document).job;
    })();
  } finally {
    db.close();
  }
}

export function reindexPendingDocumentsByProject(dbPath: string, projectId: string) {
  const db = open(dbPath);
  try {
    return db.transaction(() => {
      const documents = db
        .prepare(
          `SELECT d.id
             FROM documents d
             JOIN projects p ON p.id = d.project_id
             JOIN corpus_sources s ON s.id = d.source_id
             JOIN source_collections c ON c.id = d.source_collection_id
            WHERE d.project_id = ?
              AND d.status = 'uploaded'
              AND d.deleted_at IS NULL
              AND d.lifecycle_state = 'active'
              AND p.deleted_at IS NULL
              AND p.source_id = d.source_id
              AND p.source_collection_id = d.source_collection_id
              AND p.lifecycle_state = 'active'
              AND p.retrieval_eligible = 1
              AND s.deleted_at IS NULL
              AND s.state = 'active'
              AND c.deleted_at IS NULL
              AND c.source_id = s.id
              AND c.registration_state = 'active'
              AND c.validation_state = 'valid'
              AND c.selected = 1
              AND c.lifecycle_state = 'active'
              AND d.expected_source_config_revision = s.config_revision
            ORDER BY d.created_at, d.id`,
        )
        .all(projectId) as Array<{ id: string }>;
      const result = {
        matched: documents.length,
        created: 0,
        requeued: 0,
        alreadyRunning: 0,
      };
      for (const row of documents) {
        const document = assertDocumentIsIndexable(getIndexableDocument(db, row.id));
        const queued = queueIndexJob(db, document);
        resetDocumentMetrics(db, row.id);
        if (queued.outcome === "created") result.created += 1;
        if (queued.outcome === "requeued") result.requeued += 1;
        if (queued.outcome === "running") result.alreadyRunning += 1;
      }
      return result;
    })();
  } finally {
    db.close();
  }
}

export function getJob(dbPath: string, jobId: string) {
  const db = open(dbPath);
  try {
    const row = db
      .prepare(`SELECT id, status, progress, error_message FROM jobs WHERE id = ?`)
      .get(jobId) as
      | { id: string; status: string; progress: number; error_message: string | null }
      | undefined;
    return row
      ? { id: row.id, status: row.status, progress: row.progress, error: row.error_message }
      : null;
  } finally {
    db.close();
  }
}
