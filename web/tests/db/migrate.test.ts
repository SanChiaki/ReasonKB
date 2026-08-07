import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("migrateDatabase", () => {
  it("creates the project chat tables", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-migrate-"));
    tempDirs.push(dir);

    const dbPath = path.join(dir, "app.db");
    migrateDatabase(dbPath);

    const db = new Database(dbPath, { readonly: true });
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "projects",
        "documents",
        "document_indexes",
        "document_search",
        "document_page_blocks",
        "conversations",
        "conversation_projects",
        "conversation_messages",
        "jobs",
        "system_settings",
      ]),
    );

    db.close();
  });

  it("creates parent directories for a nested db path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-migrate-parent-"));
    tempDirs.push(dir);

    const dbPath = path.join(dir, "nested", "deeper", "app.db");
    migrateDatabase(dbPath);

    expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("resolves schema independently of cwd and is safe to run twice", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-migrate-cwd-"));
    tempDirs.push(dir);

    const dbPath = path.join(dir, "app.db");
    const unrelatedCwd = path.join(dir, "other-working-dir");
    fs.mkdirSync(unrelatedCwd, { recursive: true });

    process.chdir(unrelatedCwd);
    migrateDatabase(dbPath);
    migrateDatabase(dbPath);

    const db = new Database(dbPath, { readonly: true });
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("projects") as { name: string } | undefined;

    expect(table?.name).toBe("projects");
    db.close();
  });

  it("creates directory source metadata and index run observability fields", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-migrate-observe-"));
    tempDirs.push(dir);

    const dbPath = path.join(dir, "app.db");
    migrateDatabase(dbPath);
    migrateDatabase(dbPath);

    const db = new Database(dbPath, { readonly: true });
    const documentColumns = (
      db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    const indexColumns = (
      db.prepare("PRAGMA table_info(document_indexes)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    const runTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("document_index_runs") as { name: string } | undefined;
    const runColumns = (
      db.prepare("PRAGMA table_info(document_index_runs)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>
    );

    expect(documentColumns).toEqual(
      expect.arrayContaining([
        "source_kind",
        "source_relative_path",
        "project_relative_path",
        "content_hash",
        "media_type",
        "import_status",
        "last_index_duration_ms",
        "last_index_total_tokens",
        "last_index_llm_call_count",
        "last_indexed_at",
      ]),
    );
    expect(indexColumns).toEqual(
      expect.arrayContaining([
        "evidence_kind",
        "visual_assets_json",
        "source_metadata_json",
      ]),
    );
    expect(runTable?.name).toBe("document_index_runs");
    expect(runColumns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "reasoning_tokens",
          notnull: 0,
          dflt_value: null,
        }),
      ]),
    );
    db.close();
  });

  it("backfills the FTS5 document index for existing PageIndex rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-migrate-fts-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "app.db");
    migrateDatabase(dbPath);

    const db = new Database(dbPath);
    const now = "2026-08-06T00:00:00.000Z";
    db.prepare(
      `INSERT INTO projects (id, owner_user_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("project_1", "user_demo", "交付项目", now, now);
    db.prepare(
      `INSERT INTO documents (
         id, project_id, owner_user_id, file_name, storage_path, mime_type,
         file_size, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "document_1",
      "project_1",
      "user_demo",
      "终验报告.pdf",
      "/data/终验报告.pdf",
      "application/pdf",
      100,
      "ready",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO document_indexes (
         id, document_id, doc_name, doc_description, structure_json,
         pages_json, index_version, indexed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "index_1",
      "document_1",
      "终验报告.pdf",
      "网络项目最终验收结论",
      JSON.stringify([{ title: "终验检查", summary: "遗留事项" }]),
      "[]",
      "v1",
      now,
    );
    db.exec("DELETE FROM document_search");
    db.prepare("DELETE FROM schema_migrations WHERE version = 10").run();
    db.close();

    migrateDatabase(dbPath);

    const migrated = new Database(dbPath, { readonly: true });
    const row = migrated
      .prepare(
        `SELECT document_id FROM document_search
         WHERE document_search MATCH ?`,
      )
      .get('"终验"') as { document_id: string } | undefined;
    expect(row?.document_id).toBe("document_1");
    migrated.close();
  });
});
