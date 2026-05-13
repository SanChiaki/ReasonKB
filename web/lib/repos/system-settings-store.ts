import Database from "better-sqlite3";

export type SystemSettings = {
  indexWorkerConcurrency: number;
  retrievalDocumentLimit: number;
};

type SystemSettingsDefaults = SystemSettings;

const INDEX_WORKER_CONCURRENCY_KEY = "indexWorkerConcurrency";
const RETRIEVAL_DOCUMENT_LIMIT_KEY = "retrievalDocumentLimit";
const FALLBACK_DEFAULTS: SystemSettingsDefaults = {
  indexWorkerConcurrency: 1,
  retrievalDocumentLimit: 5,
};
const CREATE_SYSTEM_SETTINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

function open(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

function normalizeIndexWorkerConcurrency(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("Index worker concurrency must be an integer.");
  }
  if (value < 1 || value > 16) {
    throw new Error("Index worker concurrency must be between 1 and 16.");
  }
  return value;
}

function normalizeRetrievalDocumentLimit(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("Retrieval document limit must be an integer.");
  }
  if (value < 1 || value > 50) {
    throw new Error("Retrieval document limit must be between 1 and 50.");
  }
  return value;
}

function ensureSystemSettingsTable(db: InstanceType<typeof Database>) {
  db.exec(CREATE_SYSTEM_SETTINGS_TABLE_SQL);
}

function readSetting(db: InstanceType<typeof Database>, key: string) {
  let row: { value_json: string } | undefined;
  try {
    row = db
      .prepare("SELECT value_json FROM system_settings WHERE key = ?")
      .get(key) as { value_json: string } | undefined;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("no such table: system_settings")
    ) {
      return undefined;
    }
    throw error;
  }
  if (!row) {
    return undefined;
  }
  return JSON.parse(row.value_json) as unknown;
}

export function getSystemSettings(
  dbPath: string,
  defaults: Partial<SystemSettingsDefaults> = {},
): SystemSettings {
  const normalizedDefaults = { ...FALLBACK_DEFAULTS, ...defaults };
  const db = open(dbPath);
  try {
    const savedConcurrency = readSetting(db, INDEX_WORKER_CONCURRENCY_KEY);
    const savedRetrievalDocumentLimit = readSetting(db, RETRIEVAL_DOCUMENT_LIMIT_KEY);
    return {
      indexWorkerConcurrency:
        savedConcurrency === undefined
          ? normalizedDefaults.indexWorkerConcurrency
          : normalizeIndexWorkerConcurrency(savedConcurrency),
      retrievalDocumentLimit:
        savedRetrievalDocumentLimit === undefined
          ? normalizedDefaults.retrievalDocumentLimit
          : normalizeRetrievalDocumentLimit(savedRetrievalDocumentLimit),
    };
  } finally {
    db.close();
  }
}

export function updateSystemSettings(
  dbPath: string,
  updates: Partial<SystemSettings>,
  defaults: Partial<SystemSettingsDefaults> = FALLBACK_DEFAULTS,
): SystemSettings {
  const db = open(dbPath);
  const now = new Date().toISOString();
  try {
    ensureSystemSettingsTable(db);
    const transaction = db.transaction(() => {
      if (updates.indexWorkerConcurrency !== undefined) {
        const value = normalizeIndexWorkerConcurrency(updates.indexWorkerConcurrency);
        db.prepare(
          `INSERT INTO system_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
        ).run(INDEX_WORKER_CONCURRENCY_KEY, JSON.stringify(value), now);
      }
      if (updates.retrievalDocumentLimit !== undefined) {
        const value = normalizeRetrievalDocumentLimit(updates.retrievalDocumentLimit);
        db.prepare(
          `INSERT INTO system_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
        ).run(RETRIEVAL_DOCUMENT_LIMIT_KEY, JSON.stringify(value), now);
      }
    });
    transaction();
    return getSystemSettings(dbPath, defaults);
  } finally {
    db.close();
  }
}
