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
      }>
    ).map((row) => row.name);

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
    expect(runColumns).toContain("reasoning_tokens");
    db.close();
  });
});
