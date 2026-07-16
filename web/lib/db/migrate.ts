import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { appConfig } from "@/lib/config";
import {
  ensureMultiSourceCompatibilityColumns,
  schemaMigrations,
} from "@/lib/db/migrations";
import { bootstrapAdminPassword } from "@/lib/repos/admin-auth-store";
import {
  purgeQueuedManagedFiles,
  type LegacyCorpusMigrationOptions,
} from "@/lib/db/legacy-corpus-migration";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(moduleDir, "schema.sql");

type SqliteDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    all(): unknown[];
  };
};

export function migrateDatabase(
  dbPath: string,
  options: LegacyCorpusMigrationOptions = {},
) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  try {
    try {
      db.exec(schemaSql);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("no such column")
      ) {
        ensureLegacyColumns(db);
        ensureMultiSourceCompatibilityColumns(db);
        db.exec(schemaSql);
      } else {
        throw error;
      }
    }
    ensureLegacyColumns(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      )
    `);

    const applyMigration = db.transaction(
      (migration: (typeof schemaMigrations)[number]) => {
        migration.up(db, options);
        db.prepare(
          `INSERT INTO schema_migrations (version, name, applied_at)
           VALUES (?, ?, ?)`,
        ).run(migration.version, migration.name, new Date().toISOString());
      },
    );
    for (const migration of schemaMigrations) {
      const applied = db
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(migration.version);
      if (!applied) {
        applyMigration(migration);
      }
    }
    purgeQueuedManagedFiles(db, options.uploadRoot);
  } finally {
    db.close();
  }
}

function ensureColumn(
  db: SqliteDatabase,
  table: string,
  column: string,
  ddl: string,
) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function ensureLegacyColumns(db: SqliteDatabase) {
  const documentColumns: Array<[string, string]> = [
    ["source_kind", "source_kind TEXT NOT NULL DEFAULT 'upload'"],
    ["source_root", "source_root TEXT"],
    ["source_relative_path", "source_relative_path TEXT"],
    ["project_relative_path", "project_relative_path TEXT"],
    ["content_hash", "content_hash TEXT"],
    ["source_mtime", "source_mtime TEXT"],
    ["source_size", "source_size INTEGER"],
    ["media_type", "media_type TEXT NOT NULL DEFAULT 'pdf'"],
    ["import_status", "import_status TEXT NOT NULL DEFAULT 'imported'"],
    ["import_error", "import_error TEXT"],
    ["last_index_duration_ms", "last_index_duration_ms INTEGER"],
    ["last_index_total_tokens", "last_index_total_tokens INTEGER"],
    ["last_index_llm_call_count", "last_index_llm_call_count INTEGER"],
    ["last_indexed_at", "last_indexed_at TEXT"],
  ];
  for (const [column, ddl] of documentColumns) {
    ensureColumn(db, "documents", column, ddl);
  }

  const indexColumns: Array<[string, string]> = [
    ["evidence_kind", "evidence_kind TEXT NOT NULL DEFAULT 'pdf_text'"],
    ["visual_assets_json", "visual_assets_json TEXT NOT NULL DEFAULT '[]'"],
    ["source_metadata_json", "source_metadata_json TEXT NOT NULL DEFAULT '{}'"],
  ];
  for (const [column, ddl] of indexColumns) {
    ensureColumn(db, "document_indexes", column, ddl);
  }
}

function isMainModule() {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entryPath);
}

if (isMainModule()) {
  fs.mkdirSync(path.dirname(appConfig.dbPath), { recursive: true });
  migrateDatabase(appConfig.dbPath, {
    legacyLocalRoot: appConfig.projectsRoot,
    legacySmbRoot: appConfig.smbCorpusTarget,
    uploadRoot: appConfig.uploadRoot,
    masterKeyPath: appConfig.masterKeyPath,
    legacySmbUsernameFile: appConfig.legacySmbUsernameFile,
    legacySmbPasswordFile: appConfig.legacySmbPasswordFile,
    legacySmbDomain: appConfig.legacySmbDomain,
    legacySmbPort: appConfig.legacySmbPort,
    legacySmbAuthProtocol: appConfig.legacySmbAuthProtocol,
  });
  if (appConfig.adminPasswordFile && fs.existsSync(appConfig.adminPasswordFile)) {
    const password = fs.readFileSync(appConfig.adminPasswordFile, "utf8").trimEnd();
    bootstrapAdminPassword(appConfig.dbPath, password);
  }
  console.log(`migrated ${appConfig.dbPath}`);
}
