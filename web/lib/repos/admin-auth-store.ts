import crypto from "node:crypto";
import Database from "better-sqlite3";
import { hashPassword, verifyPassword } from "@/lib/security/password";

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

function open(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function tokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

export function isAdminConfigured(dbPath: string) {
  const db = open(dbPath);
  try {
    return Boolean(db.prepare("SELECT 1 FROM admin_credentials WHERE id = 1").get());
  } finally {
    db.close();
  }
}

export function bootstrapAdminPassword(dbPath: string, password: string) {
  const passwordHash = hashPassword(password);
  const now = new Date().toISOString();
  const db = open(dbPath);
  try {
    const result = db
      .prepare(
        `INSERT INTO admin_credentials (
           id, password_hash, password_changed_at, created_at
         ) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(passwordHash, now, now);
    return result.changes === 1;
  } finally {
    db.close();
  }
}

export function replaceAdminPassword(
  dbPath: string,
  currentPassword: string,
  newPassword: string,
) {
  const db = open(dbPath);
  try {
    const row = db
      .prepare("SELECT password_hash FROM admin_credentials WHERE id = 1")
      .get() as { password_hash: string } | undefined;
    if (!row || !verifyPassword(currentPassword, row.password_hash)) {
      return false;
    }
    const now = new Date().toISOString();
    const nextHash = hashPassword(newPassword);
    db.transaction(() => {
      db.prepare(
        `UPDATE admin_credentials
            SET password_hash = ?, password_changed_at = ?
          WHERE id = 1`,
      ).run(nextHash, now);
      db.prepare(
        `UPDATE admin_sessions
            SET revoked_at = ?
          WHERE revoked_at IS NULL`,
      ).run(now);
    })();
    return true;
  } finally {
    db.close();
  }
}

export function verifyAdminCredentials(dbPath: string, password: string) {
  const db = open(dbPath);
  try {
    const row = db
      .prepare("SELECT password_hash FROM admin_credentials WHERE id = 1")
      .get() as { password_hash: string } | undefined;
    return row ? verifyPassword(password, row.password_hash) : false;
  } finally {
    db.close();
  }
}

export function createAdminSession(
  dbPath: string,
  now = new Date(),
  durationMs = SESSION_DURATION_MS,
) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  const id = `session_${crypto.randomUUID()}`;
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + durationMs).toISOString();
  const db = open(dbPath);
  try {
    db.prepare(
      `INSERT INTO admin_sessions (
         id, token_hash, csrf_token_hash, created_at, expires_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, tokenHash(token), tokenHash(csrfToken), createdAt, expiresAt, createdAt);
  } finally {
    db.close();
  }
  return { id, token, csrfToken, expiresAt };
}

export function validateAdminSession(
  dbPath: string,
  token: string,
  csrfToken?: string,
  now = new Date(),
) {
  const db = open(dbPath);
  try {
    const row = db
      .prepare(
        `SELECT id, csrf_token_hash, expires_at
           FROM admin_sessions
          WHERE token_hash = ?
            AND revoked_at IS NULL
            AND expires_at > ?`,
      )
      .get(tokenHash(token), now.toISOString()) as
      | { id: string; csrf_token_hash: string; expires_at: string }
      | undefined;
    if (!row) {
      return null;
    }
    if (csrfToken !== undefined) {
      const actual = Buffer.from(tokenHash(csrfToken));
      const expected = Buffer.from(row.csrf_token_hash);
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        return null;
      }
    }
    db.prepare("UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?").run(
      now.toISOString(),
      row.id,
    );
    return { id: row.id, expiresAt: row.expires_at };
  } finally {
    db.close();
  }
}

export function revokeAdminSession(dbPath: string, token: string, now = new Date()) {
  const db = open(dbPath);
  try {
    const result = db
      .prepare(
        `UPDATE admin_sessions
            SET revoked_at = ?
          WHERE token_hash = ?
            AND revoked_at IS NULL`,
      )
      .run(now.toISOString(), tokenHash(token));
    return result.changes === 1;
  } finally {
    db.close();
  }
}

export function deleteExpiredAdminSessions(dbPath: string, now = new Date()) {
  const db = open(dbPath);
  try {
    return db
      .prepare("DELETE FROM admin_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL")
      .run(now.toISOString()).changes;
  } finally {
    db.close();
  }
}
