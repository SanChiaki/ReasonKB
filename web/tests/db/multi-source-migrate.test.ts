import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { decryptSourceCredentials } from "@/lib/security/source-credentials";

const tempDirs: string[] = [];
const testDir = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(testDir, "../../lib/db/schema.sql");
const preMultiSourceSchemaPath = path.resolve(
  testDir,
  "../fixtures/pre-multi-source-schema.sql",
);
type TestDatabase = InstanceType<typeof Database>;

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDatabase(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(schemaPath, "utf8"));
  return { dir, dbPath, db };
}

function preMultiSourceDatabase(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(preMultiSourceSchemaPath, "utf8"));
  return { dir, dbPath, db };
}

function insertProject(db: TestDatabase, id: string, name: string) {
  db.prepare(
    `INSERT INTO projects (id, owner_user_id, name, created_at, updated_at)
     VALUES (?, 'user_demo', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(id, name);
}

function insertDocument(
  db: TestDatabase,
  input: {
    id: string;
    projectId: string;
    sourceKind: "directory" | "smb" | "upload";
    sourceRoot?: string;
    relativePath?: string;
    storagePath: string;
    deletedAt?: string;
  },
) {
  const relativePath = input.relativePath ?? `${input.projectId}/report.md`;
  db.prepare(
    `INSERT INTO documents (
       id, project_id, owner_user_id, file_name, storage_path, mime_type,
       file_size, status, source_kind, source_root, source_relative_path,
       project_relative_path, content_hash, source_mtime, source_size,
       media_type, import_status, created_at, updated_at, deleted_at
     ) VALUES (?, ?, 'user_demo', 'report.md', ?, 'text/markdown', 12, 'ready',
               ?, ?, ?, 'report.md', 'sha256:legacy', '2026-01-01T00:00:00Z',
               12, 'markdown', 'imported', '2026-01-01T00:00:00Z',
               '2026-01-01T00:00:00Z', ?)`,
  ).run(
    input.id,
    input.projectId,
    input.storagePath,
    input.sourceKind,
    input.sourceRoot ?? null,
    relativePath,
    input.deletedAt ?? null,
  );
}

describe("multi-source schema migration", () => {
  it("upgrades the pre-multi-source schema before creating new indexes", () => {
    const { dbPath, db } = preMultiSourceDatabase("reasonkb-pre-multi-source-");
    insertProject(db, "proj_legacy", "Legacy");
    insertProject(db, "proj_empty_demo", "Empty demo Project");
    insertDocument(db, {
      id: "doc_legacy",
      projectId: "proj_legacy",
      sourceKind: "directory",
      sourceRoot: "/data/projects",
      relativePath: "Legacy/report.md",
      storagePath: "/data/projects/Legacy/report.md",
    });
    db.prepare(
      `INSERT INTO conversations (id, owner_user_id, title, created_at, updated_at)
       VALUES ('conv_empty_demo', 'user_demo', 'Old demo chat',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO conversation_projects (conversation_id, project_id, created_at)
       VALUES ('conv_empty_demo', 'proj_empty_demo', '2026-01-01T00:00:00Z')`,
    ).run();
    db.close();

    migrateDatabase(dbPath, { legacyLocalRoot: "/data/projects" });

    const migrated = new Database(dbPath, { readonly: true });
    expect(
      migrated.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    expect(
      migrated
        .prepare(
          `SELECT id, source_id, source_collection_id
             FROM projects WHERE id = 'proj_legacy'`,
        )
        .get(),
    ).toEqual({
      id: "proj_legacy",
      source_id: expect.any(String),
      source_collection_id: expect.any(String),
    });
    expect(
      migrated
        .prepare(
          `SELECT id, source_item_id, source_item_external_id
             FROM documents WHERE id = 'doc_legacy'`,
        )
        .get(),
    ).toEqual({
      id: "doc_legacy",
      source_item_id: expect.any(String),
      source_item_external_id: "Legacy/report.md",
    });
    expect(migrated.prepare("SELECT id FROM projects ORDER BY id").all()).toEqual([
      { id: "proj_legacy" },
    ]);
    expect(
      migrated
        .prepare(
          "SELECT 1 FROM conversation_projects WHERE project_id = 'proj_empty_demo'",
        )
        .get(),
    ).toBeUndefined();
    migrated.close();
  });

  it("creates versioned multi-source foundation tables and compatibility columns", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-foundation-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "app.db");

    migrateDatabase(dbPath);

    const db = new Database(dbPath, { readonly: true });
    const versions = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    const documentColumns = new Set(
      (db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );

    expect(versions).toEqual([
      { version: 1, name: "multi-source-foundation" },
      { version: 2, name: "migrate-legacy-corpus" },
      { version: 3, name: "five-transient-index-retries" },
      { version: 4, name: "index-job-revision-lookup" },
    ]);
    expect(tables).toEqual(
      expect.objectContaining(
        new Set([
          "corpus_sources",
          "source_credentials",
          "source_collections",
          "source_items",
          "source_discovery_runs",
          "sync_runs",
          "admin_credentials",
          "admin_sessions",
          "admin_audit_events",
        ]),
      ),
    );
    expect(documentColumns).toEqual(
      expect.objectContaining(
        new Set([
          "source_id",
          "source_collection_id",
          "source_item_id",
          "source_item_external_id",
          "source_revision",
          "expected_source_revision",
          "expected_source_config_revision",
          "lifecycle_state",
          "retrieval_eligible",
          "last_seen_run_id",
        ]),
      ),
    );
    db.close();
  });

  it("backfills a legacy local corpus without changing existing identities", () => {
    const { dbPath, db } = tempDatabase("reasonkb-legacy-local-");
    insertProject(db, "proj_alpha", "Alpha");
    insertDocument(db, {
      id: "doc_alpha",
      projectId: "proj_alpha",
      sourceKind: "directory",
      sourceRoot: "/data/projects",
      relativePath: "Alpha/report.md",
      storagePath: "/data/projects/Alpha/report.md",
    });
    db.prepare(
      `INSERT INTO document_indexes (
         id, document_id, doc_name, doc_description, structure_json, pages_json,
         index_version, indexed_at
       ) VALUES ('idx_alpha', 'doc_alpha', 'report.md', '', '{}', '[]', 'v1',
                 '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO jobs (
         id, type, document_id, payload_json, status, created_at, updated_at
       ) VALUES ('job_alpha', 'document_index', 'doc_alpha', '{}', 'finished',
                 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO conversations (id, owner_user_id, title, created_at, updated_at)
       VALUES ('conv_alpha', 'user_demo', 'Alpha chat', '2026-01-01T00:00:00Z',
               '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO conversation_projects (conversation_id, project_id, created_at)
       VALUES ('conv_alpha', 'proj_alpha', '2026-01-01T00:00:00Z')`,
    ).run();
    db.close();

    migrateDatabase(dbPath, { legacyLocalRoot: "/data/projects" });

    const migrated = new Database(dbPath, { readonly: true });
    const source = migrated
      .prepare(
        `SELECT kind, state, selection_policy, scope_json
           FROM corpus_sources`,
      )
      .get() as {
      kind: string;
      state: string;
      selection_policy: string;
      scope_json: string;
    };
    const project = migrated
      .prepare(
        `SELECT id, source_id, source_collection_id, lifecycle_state
           FROM projects WHERE id = 'proj_alpha'`,
      )
      .get() as Record<string, unknown>;
    const document = migrated
      .prepare(
        `SELECT id, source_item_id, source_item_external_id, source_revision
           FROM documents WHERE id = 'doc_alpha'`,
      )
      .get() as Record<string, unknown>;

    expect(source).toMatchObject({ kind: "local", state: "active", selection_policy: "all" });
    expect(JSON.parse(source.scope_json)).toEqual({ rootPath: "/data/projects" });
    expect(project).toMatchObject({ id: "proj_alpha", lifecycle_state: "active" });
    expect(project.source_id).toBeTruthy();
    expect(project.source_collection_id).toBeTruthy();
    expect(document).toMatchObject({
      id: "doc_alpha",
      source_item_external_id: "Alpha/report.md",
      source_revision: "sha256:legacy",
    });
    expect(document.source_item_id).toBeTruthy();
    expect(
      migrated
        .prepare(
          `SELECT 1 FROM conversation_projects
            WHERE conversation_id = 'conv_alpha' AND project_id = 'proj_alpha'`,
        )
        .get(),
    ).toBeTruthy();
    expect(
      migrated.prepare("SELECT source_revision FROM document_indexes WHERE id = 'idx_alpha'").get(),
    ).toEqual({ source_revision: "sha256:legacy" });
    expect(
      migrated.prepare("SELECT source_id FROM jobs WHERE id = 'job_alpha'").get(),
    ).toEqual({ source_id: project.source_id });
    migrated.close();
  });

  it("imports legacy SMB scope and credentials into the encrypted source", () => {
    const { dir, dbPath, db } = tempDatabase("reasonkb-legacy-smb-");
    insertProject(db, "proj_smb", "Engineering");
    insertDocument(db, {
      id: "doc_smb",
      projectId: "proj_smb",
      sourceKind: "smb",
      sourceRoot: "//files.example.test:1445/share/base",
      relativePath: "Engineering/report.md",
      storagePath: "Engineering/report.md",
    });
    db.close();
    const key = crypto.randomBytes(32);
    const masterKeyPath = path.join(dir, "master.key");
    const usernamePath = path.join(dir, "smb_username");
    const passwordPath = path.join(dir, "smb_password");
    fs.writeFileSync(masterKeyPath, key);
    fs.writeFileSync(usernamePath, "reader");
    fs.writeFileSync(passwordPath, "secret-value");

    migrateDatabase(dbPath, {
      legacySmbRoot: "//files.example.test:1445/share/base",
      masterKeyPath,
      legacySmbUsernameFile: usernamePath,
      legacySmbPasswordFile: passwordPath,
      legacySmbDomain: "CORP",
      legacySmbPort: 1445,
      legacySmbAuthProtocol: "negotiate",
    });

    const migrated = new Database(dbPath, { readonly: true });
    const source = migrated
      .prepare("SELECT id, scope_json, config_json FROM corpus_sources")
      .get() as { id: string; scope_json: string; config_json: string };
    const encrypted = migrated
      .prepare("SELECT encrypted_payload FROM source_credentials WHERE source_id = ?")
      .get(source.id) as { encrypted_payload: string };
    migrated.close();
    expect(JSON.parse(source.scope_json)).toEqual({
      host: "files.example.test",
      share: "share",
      basePath: "base",
      port: 1445,
    });
    expect(JSON.parse(source.config_json)).toMatchObject({ authProtocol: "negotiate" });
    expect(decryptSourceCredentials(key, source.id, encrypted.encrypted_payload)).toEqual({
      username: "reader",
      password: "secret-value",
      domain: "CORP",
    });
    expect(encrypted.encrypted_payload).not.toContain("secret-value");
  });

  it("retains a missing legacy source document as a non-retrievable tombstone", () => {
    const { dbPath, db } = tempDatabase("reasonkb-legacy-missing-");
    insertProject(db, "proj_missing", "Missing");
    insertDocument(db, {
      id: "doc_missing",
      projectId: "proj_missing",
      sourceKind: "directory",
      sourceRoot: "/data/projects",
      relativePath: "Missing/report.md",
      storagePath: "/data/projects/Missing/report.md",
      deletedAt: "2026-02-01T00:00:00Z",
    });
    db.close();

    migrateDatabase(dbPath, { legacyLocalRoot: "/data/projects" });

    const migrated = new Database(dbPath, { readonly: true });
    expect(
      migrated
        .prepare(
          `SELECT lifecycle_state, retrieval_eligible
             FROM documents WHERE id = 'doc_missing'`,
        )
        .get(),
    ).toEqual({ lifecycle_state: "missing", retrieval_eligible: 0 });
    expect(
      migrated
        .prepare(
          `SELECT lifecycle_state FROM source_items WHERE document_id = 'doc_missing'`,
        )
        .get(),
    ).toEqual({ lifecycle_state: "missing" });
    migrated.close();
  });

  it("purges demo upload records and managed files", () => {
    const { dir, dbPath, db } = tempDatabase("reasonkb-legacy-upload-");
    const uploadRoot = path.join(dir, "uploads");
    const uploadedFile = path.join(uploadRoot, "doc_upload", "report.md");
    fs.mkdirSync(path.dirname(uploadedFile), { recursive: true });
    fs.writeFileSync(uploadedFile, "demo upload");
    insertProject(db, "proj_upload", "Uploaded");
    insertDocument(db, {
      id: "doc_upload",
      projectId: "proj_upload",
      sourceKind: "upload",
      storagePath: uploadedFile,
    });
    db.prepare(
      `INSERT INTO document_indexes (
         id, document_id, doc_name, doc_description, structure_json, pages_json,
         index_version, indexed_at
       ) VALUES ('idx_upload', 'doc_upload', 'report.md', '', '{}', '[]', 'v1',
                 '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO jobs (
         id, type, document_id, payload_json, status, created_at, updated_at
       ) VALUES ('job_upload', 'document_index', 'doc_upload', '{}', 'finished',
                 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    db.close();

    migrateDatabase(dbPath, { uploadRoot });

    const migrated = new Database(dbPath, { readonly: true });
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 0 });
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM documents").get()).toEqual({ count: 0 });
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM document_indexes").get()).toEqual({
      count: 0,
    });
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 0 });
    expect(
      migrated
        .prepare("SELECT purged_at, error_summary FROM managed_file_purge_queue")
        .get(),
    ).toMatchObject({ error_summary: null, purged_at: expect.any(String) });
    expect(fs.existsSync(uploadedFile)).toBe(false);
    migrated.close();
  });

  it("preserves source-backed records while removing mixed demo uploads", () => {
    const { dir, dbPath, db } = tempDatabase("reasonkb-legacy-mixed-");
    const uploadRoot = path.join(dir, "uploads");
    const uploadedFile = path.join(uploadRoot, "doc_upload", "temporary.md");
    fs.mkdirSync(path.dirname(uploadedFile), { recursive: true });
    fs.writeFileSync(uploadedFile, "temporary upload");
    insertProject(db, "proj_source", "Source Project");
    insertDocument(db, {
      id: "doc_source",
      projectId: "proj_source",
      sourceKind: "directory",
      sourceRoot: "/data/projects",
      relativePath: "Source Project/report.md",
      storagePath: "/data/projects/Source Project/report.md",
    });
    insertProject(db, "proj_upload", "Upload Project");
    insertDocument(db, {
      id: "doc_upload",
      projectId: "proj_upload",
      sourceKind: "upload",
      storagePath: uploadedFile,
    });
    db.close();

    migrateDatabase(dbPath, { legacyLocalRoot: "/data/projects", uploadRoot });

    const migrated = new Database(dbPath, { readonly: true });
    expect(migrated.prepare("SELECT id FROM projects ORDER BY id").all()).toEqual([
      { id: "proj_source" },
    ]);
    expect(migrated.prepare("SELECT id FROM documents ORDER BY id").all()).toEqual([
      { id: "doc_source" },
    ]);
    expect(
      migrated.prepare("SELECT source_id FROM projects WHERE id = 'proj_source'").get(),
    ).toMatchObject({ source_id: expect.any(String) });
    migrated.close();
    expect(fs.existsSync(uploadedFile)).toBe(false);
  });

  it("rolls back legacy backfill when the database contains multiple source scopes", () => {
    const { dbPath, db } = tempDatabase("reasonkb-legacy-ambiguous-");
    insertProject(db, "proj_a", "A");
    insertProject(db, "proj_b", "B");
    insertDocument(db, {
      id: "doc_a",
      projectId: "proj_a",
      sourceKind: "directory",
      sourceRoot: "/data/a",
      relativePath: "A/report.md",
      storagePath: "/data/a/A/report.md",
    });
    insertDocument(db, {
      id: "doc_b",
      projectId: "proj_b",
      sourceKind: "directory",
      sourceRoot: "/data/b",
      relativePath: "B/report.md",
      storagePath: "/data/b/B/report.md",
    });
    db.close();

    expect(() => migrateDatabase(dbPath)).toThrow(/contains 2 source scopes/);

    const rolledBack = new Database(dbPath, { readonly: true });
    expect(
      rolledBack.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }]);
    expect(rolledBack.prepare("SELECT COUNT(*) AS count FROM corpus_sources").get()).toEqual({
      count: 0,
    });
    expect(
      rolledBack.prepare("SELECT source_id FROM projects WHERE id = 'proj_a'").get(),
    ).toEqual({ source_id: null });
    rolledBack.close();

    const repaired = new Database(dbPath);
    repaired
      .prepare("UPDATE documents SET source_root = '/data/a' WHERE id = 'doc_b'")
      .run();
    repaired.close();

    migrateDatabase(dbPath, { legacyLocalRoot: "/data/a" });
    migrateDatabase(dbPath, { legacyLocalRoot: "/data/a" });

    const resumed = new Database(dbPath, { readonly: true });
    expect(
      resumed.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    expect(resumed.prepare("SELECT COUNT(*) AS count FROM corpus_sources").get()).toEqual({
      count: 1,
    });
    resumed.close();
  });
});
