import Database from "better-sqlite3";
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

export function saveSourceCredentials(
  dbPath: string,
  masterKey: Buffer,
  sourceId: string,
  credentials: Record<string, unknown>,
) {
  const payload = encryptSourceCredentials(masterKey, sourceId, credentials);
  const now = new Date().toISOString();
  const db = open(dbPath);
  try {
    db.prepare(
      `INSERT INTO source_credentials (
         source_id, encrypted_payload, key_version, created_at, updated_at
       ) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         encrypted_payload = excluded.encrypted_payload,
         key_version = excluded.key_version,
         updated_at = excluded.updated_at`,
    ).run(sourceId, payload, now, now);
  } finally {
    db.close();
  }
}

export function readSourceCredentials(
  dbPath: string,
  masterKey: Buffer,
  sourceId: string,
) {
  const db = open(dbPath);
  try {
    const row = db
      .prepare(
        `SELECT encrypted_payload
           FROM source_credentials
          WHERE source_id = ?`,
      )
      .get(sourceId) as { encrypted_payload: string } | undefined;
    return row
      ? decryptSourceCredentials(masterKey, sourceId, row.encrypted_payload)
      : null;
  } finally {
    db.close();
  }
}

export function deleteSourceCredentials(dbPath: string, sourceId: string) {
  const db = open(dbPath);
  try {
    return db.prepare("DELETE FROM source_credentials WHERE source_id = ?").run(sourceId)
      .changes;
  } finally {
    db.close();
  }
}
