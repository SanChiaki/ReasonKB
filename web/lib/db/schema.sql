PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
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
  FOREIGN KEY(document_id) REFERENCES documents(id)
);

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
  total_tokens INTEGER NOT NULL DEFAULT 0,
  token_source TEXT NOT NULL DEFAULT 'estimated',
  models_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  FOREIGN KEY(document_id) REFERENCES documents(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

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
  FOREIGN KEY(document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
