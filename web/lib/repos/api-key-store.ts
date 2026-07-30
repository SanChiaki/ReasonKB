import crypto from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";
import { runImmediateTransaction } from "@/lib/db/immediate-transaction";

export const AGENT_SCOPES = [
  "read:projects",
  "read:documents",
  "query",
  "evidence",
] as const;

export const MAX_AGENT_PROJECT_IDS = 100;

export type AgentScope = (typeof AGENT_SCOPES)[number];

export type ApiKeyRecord = {
  id: string;
  ownerUserId: string;
  name: string;
  prefix: string;
  scopes: AgentScope[];
  projectIds: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type CreatedApiKey = ApiKeyRecord & {
  apiKey: string;
};

const API_KEY_PREFIX = "rkb_live";
const KEY_SECRET_BYTES = 32;
const PREFIX_BYTES = 6;

type Db = InstanceType<typeof Database>;

const CREATE_API_KEYS_TABLE_SQL = `
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
  )
`;

function open(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function ensureApiKeysTable(db: InstanceType<typeof Database>) {
  db.exec(CREATE_API_KEYS_TABLE_SQL);
}

function keyPepper() {
  const configured = process.env.REASONKB_API_KEY_PEPPER?.trim();
  if (configured) {
    return configured;
  }
  const pepperFile = process.env.REASONKB_API_KEY_PEPPER_FILE?.trim();
  if (!pepperFile) {
    return "";
  }
  try {
    const pepper = fs.readFileSync(pepperFile, "utf8").trimEnd();
    if (!pepper) {
      throw new Error("API key pepper file is empty.");
    }
    return pepper;
  } catch (error) {
    throw new Error(
      `Unable to read API key pepper file: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}

function hashApiKey(apiKey: string) {
  return crypto
    .createHash("sha256")
    .update(`${keyPepper()}:${apiKey}`)
    .digest("hex");
}

function generateApiKey() {
  const prefix = crypto.randomBytes(PREFIX_BYTES).toString("hex");
  const secret = crypto.randomBytes(KEY_SECRET_BYTES).toString("base64url");
  return {
    prefix,
    apiKey: `${API_KEY_PREFIX}_${prefix}_${secret}`,
  };
}

function normalizeName(value: string) {
  const name = value.trim();
  if (!name || name.length > 120) {
    throw new Error("API key name must be between 1 and 120 characters.");
  }
  return name;
}

function normalizeScopes(scopes: string[] | undefined): AgentScope[] {
  const requested = scopes && scopes.length > 0 ? scopes : [...AGENT_SCOPES];
  const uniqueScopes = [...new Set(requested)];
  for (const scope of uniqueScopes) {
    if (!AGENT_SCOPES.includes(scope as AgentScope)) {
      throw new Error(`Unsupported API key scope: ${scope}`);
    }
  }
  return uniqueScopes as AgentScope[];
}

function normalizeProjectIds(projectIds: string[] | undefined) {
  const normalized = [
    ...new Set(
      (projectIds ?? [])
        .map((projectId) => projectId.trim())
        .filter(Boolean),
    ),
  ];
  if (normalized.length > MAX_AGENT_PROJECT_IDS) {
    throw new Error(`API keys can target at most ${MAX_AGENT_PROJECT_IDS} projects.`);
  }
  return normalized;
}

function parseJsonArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toApiKeyRecord(row: {
  id: string;
  owner_user_id: string;
  name: string;
  prefix: string;
  scopes_json: string;
  project_ids_json: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}): ApiKeyRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseJsonArray(row.scopes_json) as AgentScope[],
    projectIds: parseJsonArray(row.project_ids_json),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function auditApiKeyChange(
  db: Db,
  input: {
    action: "api_key.create" | "api_key.revoke";
    record: ApiKeyRecord;
    before?: ApiKeyRecord;
    now: string;
  },
) {
  const safeView = (record: ApiKeyRecord) => ({
    name: record.name,
    prefix: record.prefix,
    scopes: record.scopes,
    projectIds: record.projectIds,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  });
  db.prepare(
    `INSERT INTO admin_audit_events (
       id, actor, action, target_type, target_id, outcome,
       before_json, after_json, created_at
     ) VALUES (?, ?, ?, 'api_key', ?, 'success', ?, ?, ?)`,
  ).run(
    `audit_${crypto.randomUUID()}`,
    input.record.ownerUserId,
    input.action,
    input.record.id,
    input.before ? JSON.stringify(safeView(input.before)) : null,
    JSON.stringify(safeView(input.record)),
    input.now,
  );
}

export function createApiKey(
  dbPath: string,
  input: {
    ownerUserId: string;
    name: string;
    scopes?: string[];
    projectIds?: string[];
  },
): CreatedApiKey {
  const name = normalizeName(input.name);
  const scopes = normalizeScopes(input.scopes);
  const projectIds = normalizeProjectIds(input.projectIds);
  const now = new Date().toISOString();
  const { prefix, apiKey } = generateApiKey();
  const row = {
    id: `key_${crypto.randomUUID()}`,
    owner_user_id: input.ownerUserId,
    name,
    prefix,
    key_hash: hashApiKey(apiKey),
    scopes_json: JSON.stringify(scopes),
    project_ids_json: JSON.stringify(projectIds),
    created_at: now,
  };
  const db = open(dbPath);

  try {
    ensureApiKeysTable(db);
    const record = toApiKeyRecord({
      ...row,
      last_used_at: null,
      revoked_at: null,
    });
    runImmediateTransaction(db, () => {
      db.prepare(
        `INSERT INTO api_keys (
           id, owner_user_id, name, prefix, key_hash, scopes_json,
           project_ids_json, created_at
         ) VALUES (
           @id, @owner_user_id, @name, @prefix, @key_hash, @scopes_json,
           @project_ids_json, @created_at
         )`,
      ).run(row);
      auditApiKeyChange(db, {
        action: "api_key.create",
        record,
        now,
      });
    });
    return { ...record, apiKey };
  } finally {
    db.close();
  }
}

export function listApiKeys(dbPath: string, ownerUserId: string): ApiKeyRecord[] {
  const db = open(dbPath);
  try {
    ensureApiKeysTable(db);
    const rows = db
      .prepare(
        `SELECT id, owner_user_id, name, prefix, scopes_json, project_ids_json,
                created_at, last_used_at, revoked_at
           FROM api_keys
          WHERE owner_user_id = ?
          ORDER BY created_at DESC`,
      )
      .all(ownerUserId) as Array<Parameters<typeof toApiKeyRecord>[0]>;
    return rows.map(toApiKeyRecord);
  } finally {
    db.close();
  }
}

export function revokeApiKey(
  dbPath: string,
  input: { ownerUserId: string; keyId: string },
) {
  const db = open(dbPath);
  const now = new Date().toISOString();
  try {
    ensureApiKeysTable(db);
    return runImmediateTransaction(db, () => {
      const row = db
        .prepare(
          `SELECT id, owner_user_id, name, prefix, scopes_json, project_ids_json,
                  created_at, last_used_at, revoked_at
             FROM api_keys
            WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
        )
        .get(input.keyId, input.ownerUserId) as
        | Parameters<typeof toApiKeyRecord>[0]
        | undefined;
      if (!row) {
        return false;
      }
      const before = toApiKeyRecord(row);
      db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(now, input.keyId);
      auditApiKeyChange(db, {
        action: "api_key.revoke",
        before,
        record: { ...before, revokedAt: now },
        now,
      });
      return true;
    });
  } finally {
    db.close();
  }
}

export function verifyApiKey(dbPath: string, apiKey: string): ApiKeyRecord | null {
  const normalized = apiKey.trim();
  if (!normalized) {
    return null;
  }
  const db = open(dbPath);
  try {
    ensureApiKeysTable(db);
    const row = db
      .prepare(
        `SELECT id, owner_user_id, name, prefix, scopes_json, project_ids_json,
                created_at, last_used_at, revoked_at
           FROM api_keys
          WHERE key_hash = ?
            AND revoked_at IS NULL`,
      )
      .get(hashApiKey(normalized)) as Parameters<typeof toApiKeyRecord>[0] | undefined;
    if (!row) {
      return null;
    }
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      row.id,
    );
    return toApiKeyRecord(row);
  } finally {
    db.close();
  }
}
