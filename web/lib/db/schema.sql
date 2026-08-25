PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  source_id TEXT,
  source_collection_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  retrieval_eligible INTEGER NOT NULL DEFAULT 1,
  purge_after TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  page_count INTEGER,
  status TEXT NOT NULL,
  error_message TEXT,
  source_kind TEXT NOT NULL DEFAULT 'upload',
  source_root TEXT,
  source_relative_path TEXT,
  project_relative_path TEXT,
  content_hash TEXT,
  source_mtime TEXT,
  source_size INTEGER,
  media_type TEXT NOT NULL DEFAULT 'pdf',
  import_status TEXT NOT NULL DEFAULT 'imported',
  import_error TEXT,
  last_index_duration_ms INTEGER,
  last_index_total_tokens INTEGER,
  last_index_llm_call_count INTEGER,
  last_indexed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  source_id TEXT,
  source_collection_id TEXT,
  source_item_id TEXT,
  source_item_external_id TEXT,
  source_revision TEXT,
  expected_source_revision TEXT,
  expected_source_config_revision INTEGER,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  retrieval_eligible INTEGER NOT NULL DEFAULT 1,
  last_seen_run_id TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS document_indexes (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE,
  doc_name TEXT NOT NULL,
  doc_description TEXT NOT NULL,
  structure_json TEXT NOT NULL,
  pages_json TEXT NOT NULL,
  evidence_kind TEXT NOT NULL DEFAULT 'pdf_text',
  visual_assets_json TEXT NOT NULL DEFAULT '[]',
  source_metadata_json TEXT NOT NULL DEFAULT '{}',
  index_version TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  source_revision TEXT,
  is_current INTEGER NOT NULL DEFAULT 1,
  retired_at TEXT,
  FOREIGN KEY(document_id) REFERENCES documents(id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(
  document_id UNINDEXED,
  file_name UNINDEXED,
  metadata_text,
  description,
  structure_search_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS document_indexes_search_delete
AFTER DELETE ON document_indexes
BEGIN
  DELETE FROM document_search WHERE document_id = OLD.document_id;
END;

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

CREATE TABLE IF NOT EXISTS semantic_index_generations (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  base_url TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  dimension INTEGER,
  status TEXT NOT NULL
    CHECK (status IN ('validating', 'backfilling', 'ready', 'degraded', 'retired')),
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  indexed_document_count INTEGER NOT NULL DEFAULT 0,
  total_document_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  next_retry_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  activated_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_generations_one_active
  ON semantic_index_generations(is_active)
  WHERE is_active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_generations_one_current_config
  ON semantic_index_generations(model, base_url, profile_version)
  WHERE status != 'retired';
CREATE INDEX IF NOT EXISTS idx_semantic_generations_config
  ON semantic_index_generations(model, base_url, profile_version, created_at DESC);

CREATE TABLE IF NOT EXISTS semantic_embeddings (
  generation_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_index_id TEXT NOT NULL,
  profile_kind TEXT NOT NULL CHECK (profile_kind IN ('document', 'node')),
  profile_id TEXT NOT NULL,
  node_id TEXT,
  start_page INTEGER,
  end_page INTEGER,
  text_hash TEXT NOT NULL,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(generation_id, document_id, profile_kind, profile_id),
  FOREIGN KEY(generation_id) REFERENCES semantic_index_generations(id) ON DELETE CASCADE,
  FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY(document_index_id) REFERENCES document_indexes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_semantic_embeddings_generation_kind
  ON semantic_embeddings(generation_id, profile_kind, document_id);

CREATE TABLE IF NOT EXISTS document_index_runs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  text_extraction_ms INTEGER NOT NULL DEFAULT 0,
  pageindex_ms INTEGER NOT NULL DEFAULT 0,
  vision_extraction_ms INTEGER NOT NULL DEFAULT 0,
  persist_ms INTEGER NOT NULL DEFAULT 0,
  llm_call_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  token_source TEXT NOT NULL DEFAULT 'estimated',
  models_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  FOREIGN KEY(document_id) REFERENCES documents(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS llm_provider_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  request_id TEXT,
  operation TEXT NOT NULL
    CHECK (operation IN ('index', 'retrieval', 'answer', 'health_test')),
  stage TEXT NOT NULL,
  model TEXT,
  provider_host TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  error_class TEXT,
  status_code INTEGER,
  exception_type TEXT,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  retryable INTEGER NOT NULL DEFAULT 0,
  provider_request_id TEXT,
  retry_after TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  reasoning_tokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_llm_provider_events_occurred
  ON llm_provider_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_provider_events_provider
  ON llm_provider_events(operation, model, provider_host, occurred_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS conversation_projects (
  conversation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, project_id),
  FOREIGN KEY(conversation_id) REFERENCES conversations(id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  citations_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  document_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  source_id TEXT,
  source_collection_id TEXT,
  migration_id TEXT,
  expected_source_revision TEXT,
  expected_source_config_revision INTEGER,
  priority INTEGER NOT NULL DEFAULT 300,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 6,
  available_at TEXT,
  claimed_at TEXT,
  worker_id TEXT,
  superseded_at TEXT,
  FOREIGN KEY(document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS source_credentials (
  source_id TEXT PRIMARY KEY,
  encrypted_payload TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(source_id) REFERENCES corpus_sources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS corpus_source_migrations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_config_revision INTEGER NOT NULL,
  target_scope_json TEXT NOT NULL,
  target_config_json TEXT NOT NULL,
  encrypted_credentials TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('requested', 'validating', 'syncing', 'applying', 'completed', 'failed', 'cancelled')),
  error_summary TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  allow_risk INTEGER NOT NULL DEFAULT 0,
  preflight_json TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(source_id) REFERENCES corpus_sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_source_migrations_source_status
  ON corpus_source_migrations(source_id, status, created_at DESC);

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
  filter_revision INTEGER NOT NULL DEFAULT 1,
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

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  migration_id TEXT,
  source_config_revision INTEGER NOT NULL,
  collection_filter_revision INTEGER NOT NULL DEFAULT 1,
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
  FOREIGN KEY(collection_id) REFERENCES source_collections(id) ON DELETE CASCADE,
  FOREIGN KEY(migration_id) REFERENCES corpus_source_migrations(id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS source_exclusion_rules (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('collection', 'folder', 'document')),
  target_external_id TEXT NOT NULL,
  display_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(source_id) REFERENCES corpus_sources(id) ON DELETE CASCADE,
  FOREIGN KEY(collection_id) REFERENCES source_collections(id) ON DELETE CASCADE,
  UNIQUE(collection_id, target_type, target_external_id)
);

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

CREATE TABLE IF NOT EXISTS managed_file_purge_queue (
  path TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  purged_at TEXT,
  error_summary TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  project_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_owner_updated
  ON projects(owner_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_documents_project_status_updated
  ON documents(project_id, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_source_relative_path
  ON documents(source_kind, source_relative_path)
  WHERE source_kind = 'directory' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_smb_source_relative_path
  ON documents(source_root, source_relative_path)
  WHERE source_kind = 'smb' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_owner_updated
  ON conversations(owner_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON conversation_messages(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_document_index_runs_document_started
  ON document_index_runs(document_id, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_corpus_sources_display_name
  ON corpus_sources(display_name)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_corpus_sources_due
  ON corpus_sources(state, schedule_mode, next_sync_at)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_source_collections_source_state
  ON source_collections(source_id, selected, lifecycle_state)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_source_discovery_runs_source_started
  ON source_discovery_runs(source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_collection_started
  ON sync_runs(collection_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_runs_one_active_collection
  ON sync_runs(collection_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_sync_run_observations_pending
  ON sync_run_observations(run_id, reconciled_at, external_id);
CREATE INDEX IF NOT EXISTS idx_source_items_collection_parent
  ON source_items(collection_id, parent_item_id, name)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_source_items_last_seen
  ON source_items(collection_id, last_seen_run_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_source_exclusion_rules_source
  ON source_exclusion_rules(source_id, collection_id, created_at);
CREATE INDEX IF NOT EXISTS idx_source_exclusion_rules_target
  ON source_exclusion_rules(collection_id, target_type, target_external_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry
  ON admin_sessions(expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_audit_events_created
  ON admin_audit_events(created_at DESC);
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
CREATE INDEX IF NOT EXISTS idx_api_keys_owner_created
  ON api_keys(owner_user_id, created_at DESC);
