import Database from "better-sqlite3";
import {
  migrateLegacyCorpus,
  repairLegacySmbUriScopes,
  type LegacyCorpusMigrationOptions,
} from "@/lib/db/legacy-corpus-migration";

export type MigrationDatabase = InstanceType<typeof Database>;
export type MigrationContext = LegacyCorpusMigrationOptions;

export type SchemaMigration = {
  version: number;
  name: string;
  up(db: MigrationDatabase, context: MigrationContext): void;
};

function tableColumns(db: MigrationDatabase, table: string) {
  return new Set(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((entry) => entry.name),
  );
}

function ensureColumns(
  db: MigrationDatabase,
  table: string,
  columns: Array<[name: string, ddl: string]>,
) {
  const existing = tableColumns(db, table);
  for (const [name, ddl] of columns) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      existing.add(name);
    }
  }
}

export function ensureMultiSourceCompatibilityColumns(db: MigrationDatabase) {
  ensureColumns(db, "projects", [
    ["source_id", "source_id TEXT"],
    ["source_collection_id", "source_collection_id TEXT"],
    ["lifecycle_state", "lifecycle_state TEXT NOT NULL DEFAULT 'active'"],
    ["retrieval_eligible", "retrieval_eligible INTEGER NOT NULL DEFAULT 1"],
    ["purge_after", "purge_after TEXT"],
  ]);
  ensureColumns(db, "documents", [
    ["source_id", "source_id TEXT"],
    ["source_collection_id", "source_collection_id TEXT"],
    ["source_item_id", "source_item_id TEXT"],
    ["source_item_external_id", "source_item_external_id TEXT"],
    ["source_revision", "source_revision TEXT"],
    ["expected_source_revision", "expected_source_revision TEXT"],
    ["expected_source_config_revision", "expected_source_config_revision INTEGER"],
    ["lifecycle_state", "lifecycle_state TEXT NOT NULL DEFAULT 'active'"],
    ["retrieval_eligible", "retrieval_eligible INTEGER NOT NULL DEFAULT 1"],
    ["last_seen_run_id", "last_seen_run_id TEXT"],
  ]);
  ensureColumns(db, "document_indexes", [
    ["source_revision", "source_revision TEXT"],
    ["is_current", "is_current INTEGER NOT NULL DEFAULT 1"],
    ["retired_at", "retired_at TEXT"],
  ]);
  ensureColumns(db, "jobs", [
    ["source_id", "source_id TEXT"],
    ["source_collection_id", "source_collection_id TEXT"],
    ["expected_source_revision", "expected_source_revision TEXT"],
    ["expected_source_config_revision", "expected_source_config_revision INTEGER"],
    ["priority", "priority INTEGER NOT NULL DEFAULT 300"],
    ["attempt_count", "attempt_count INTEGER NOT NULL DEFAULT 0"],
    ["max_attempts", "max_attempts INTEGER NOT NULL DEFAULT 6"],
    ["available_at", "available_at TEXT"],
    ["claimed_at", "claimed_at TEXT"],
    ["worker_id", "worker_id TEXT"],
    ["superseded_at", "superseded_at TEXT"],
  ]);
}

function createMultiSourceFoundation(db: MigrationDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS corpus_sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL COLLATE NOCASE,
      state TEXT NOT NULL DEFAULT 'draft',
      scope_json TEXT NOT NULL DEFAULT '{}',
      config_json TEXT NOT NULL DEFAULT '{}',
      config_revision INTEGER NOT NULL DEFAULT 1,
      selection_policy TEXT NOT NULL DEFAULT 'none',
      schedule_mode TEXT NOT NULL DEFAULT 'scheduled',
      sync_interval_seconds INTEGER,
      max_document_size_bytes INTEGER NOT NULL DEFAULT 104857600,
      health_state TEXT NOT NULL DEFAULT 'unknown',
      consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
      last_success_at TEXT,
      next_sync_at TEXT,
      error_summary TEXT,
      validated_at TEXT,
      ever_validated_at TEXT,
      validation_requested_at TEXT,
      purge_after TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_corpus_sources_display_name
      ON corpus_sources(display_name)
      WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_corpus_sources_due
      ON corpus_sources(state, schedule_mode, next_sync_at)
      WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS source_credentials (
      source_id TEXT PRIMARY KEY,
      encrypted_payload TEXT NOT NULL,
      key_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(source_id) REFERENCES corpus_sources(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS source_collections (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      external_id TEXT NOT NULL,
      root_external_id TEXT,
      display_name TEXT NOT NULL,
      origin TEXT NOT NULL,
      registration_state TEXT NOT NULL DEFAULT 'active',
      validation_state TEXT NOT NULL DEFAULT 'unvalidated',
      lifecycle_state TEXT NOT NULL DEFAULT 'inactive',
      selected INTEGER NOT NULL DEFAULT 0,
      validation_error TEXT,
      last_discovered_at TEXT,
      last_discovery_run_id TEXT,
      purge_after TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY(source_id) REFERENCES corpus_sources(id) ON DELETE CASCADE,
      UNIQUE(source_id, identity_key)
    );

    CREATE INDEX IF NOT EXISTS idx_source_collections_source_state
      ON source_collections(source_id, selected, lifecycle_state)
      WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS source_discovery_runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_config_revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      item_count INTEGER NOT NULL DEFAULT 0,
      cursor_json TEXT,
      error_summary TEXT,
      FOREIGN KEY(source_id) REFERENCES corpus_sources(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_source_discovery_runs_source_started
      ON source_discovery_runs(source_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      source_config_revision INTEGER NOT NULL,
      trigger_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      follow_up_requested INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      seen_item_count INTEGER NOT NULL DEFAULT 0,
      changed_item_count INTEGER NOT NULL DEFAULT 0,
      missing_item_count INTEGER NOT NULL DEFAULT 0,
      cursor_json TEXT,
      error_summary TEXT,
      FOREIGN KEY(source_id) REFERENCES corpus_sources(id) ON DELETE CASCADE,
      FOREIGN KEY(collection_id) REFERENCES source_collections(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sync_runs_collection_started
      ON sync_runs(collection_id, started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_runs_one_active_collection
      ON sync_runs(collection_id)
      WHERE status IN ('queued', 'running');

    CREATE TABLE IF NOT EXISTS sync_run_observations (
      run_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      parent_external_id TEXT,
      item_type TEXT NOT NULL,
      name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      source_revision TEXT,
      fetch_locator TEXT,
      media_type TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      observed_at TEXT NOT NULL,
      reconciled_at TEXT,
      PRIMARY KEY(run_id, external_id),
      FOREIGN KEY(run_id) REFERENCES sync_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sync_run_observations_pending
      ON sync_run_observations(run_id, reconciled_at, external_id);

    CREATE TABLE IF NOT EXISTS source_items (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      parent_item_id TEXT,
      item_type TEXT NOT NULL,
      name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      source_revision TEXT,
      fetch_locator TEXT,
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      last_seen_run_id TEXT,
      document_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY(source_id) REFERENCES corpus_sources(id) ON DELETE CASCADE,
      FOREIGN KEY(collection_id) REFERENCES source_collections(id) ON DELETE CASCADE,
      FOREIGN KEY(parent_item_id) REFERENCES source_items(id),
      FOREIGN KEY(last_seen_run_id) REFERENCES sync_runs(id),
      FOREIGN KEY(document_id) REFERENCES documents(id),
      UNIQUE(source_id, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_source_items_collection_parent
      ON source_items(collection_id, parent_item_id, name)
      WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_source_items_last_seen
      ON source_items(collection_id, last_seen_run_id)
      WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS admin_credentials (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      password_hash TEXT NOT NULL,
      password_changed_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry
      ON admin_sessions(expires_at)
      WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS admin_audit_events (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL DEFAULT 'deployment-admin',
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      outcome TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      error_summary TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_admin_audit_events_created
      ON admin_audit_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS managed_file_purge_queue (
      path TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      purged_at TEXT,
      error_summary TEXT
    );
  `);

  ensureMultiSourceCompatibilityColumns(db);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_source_collection
      ON projects(source_collection_id)
      WHERE source_collection_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_projects_retrieval
      ON projects(retrieval_eligible, lifecycle_state, updated_at DESC)
      WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_source_item
      ON documents(source_id, source_item_external_id)
      WHERE source_id IS NOT NULL AND source_item_external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_documents_retrieval
      ON documents(project_id, retrieval_eligible, lifecycle_state, status)
      WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_jobs_claim
      ON jobs(status, priority, available_at, created_at)
      WHERE status = 'queued';
    CREATE INDEX IF NOT EXISTS idx_jobs_document_revision_state
      ON jobs(document_id, expected_source_revision, status);
  `);
}

export const schemaMigrations: SchemaMigration[] = [
  {
    version: 1,
    name: "multi-source-foundation",
    up: createMultiSourceFoundation,
  },
  {
    version: 2,
    name: "migrate-legacy-corpus",
    up: migrateLegacyCorpus,
  },
  {
    version: 3,
    name: "five-transient-index-retries",
    up(db) {
      db.prepare("UPDATE jobs SET max_attempts = 6 WHERE max_attempts = 5").run();
    },
  },
  {
    version: 4,
    name: "index-job-revision-lookup",
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_jobs_document_revision_state
          ON jobs(document_id, expected_source_revision, status)
      `);
    },
  },
  {
    version: 5,
    name: "repair-legacy-smb-uri-scope",
    up: repairLegacySmbUriScopes,
  },
  {
    version: 6,
    name: "source-exclusion-rules",
    up(db) {
      ensureColumns(db, "source_collections", [
        ["filter_revision", "filter_revision INTEGER NOT NULL DEFAULT 1"],
      ]);
      ensureColumns(db, "sync_runs", [
        [
          "collection_filter_revision",
          "collection_filter_revision INTEGER NOT NULL DEFAULT 1",
        ],
      ]);
      db.exec(`
        CREATE TABLE IF NOT EXISTS source_exclusion_rules (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          collection_id TEXT NOT NULL,
          target_type TEXT NOT NULL
            CHECK (target_type IN ('collection', 'folder', 'document')),
          target_external_id TEXT NOT NULL,
          display_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(source_id) REFERENCES corpus_sources(id) ON DELETE CASCADE,
          FOREIGN KEY(collection_id) REFERENCES source_collections(id) ON DELETE CASCADE,
          UNIQUE(collection_id, target_type, target_external_id)
        );
        CREATE INDEX IF NOT EXISTS idx_source_exclusion_rules_source
          ON source_exclusion_rules(source_id, collection_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_source_exclusion_rules_target
          ON source_exclusion_rules(collection_id, target_type, target_external_id);
      `);
    },
  },
  {
    version: 7,
    name: "document-page-layout-blocks",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS document_page_blocks (
          document_index_id TEXT NOT NULL,
          page_number INTEGER NOT NULL CHECK (page_number > 0),
          layout_status TEXT NOT NULL
            CHECK (layout_status IN ('no_table', 'structured', 'ambiguous', 'visual_only')),
          blocks_json TEXT NOT NULL DEFAULT '[]',
          diagnostics_json TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY(document_index_id, page_number),
          FOREIGN KEY(document_index_id) REFERENCES document_indexes(id) ON DELETE CASCADE
        );
      `);
    },
  },
  {
    version: 8,
    name: "index-run-reasoning-tokens",
    up(db) {
      ensureColumns(db, "document_index_runs", [
        ["reasoning_tokens", "reasoning_tokens INTEGER"],
      ]);
    },
  },
];
