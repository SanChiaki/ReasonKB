import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeCorpusSourceInput } from "@/lib/corpus-source-input";
import { migrateDatabase } from "@/lib/db/migrate";
import {
  createCorpusSource,
  getCorpusSource,
  listCorpusSources,
  updateCorpusSource,
} from "@/lib/repos/corpus-source-store";
import { readSourceCredentials } from "@/lib/repos/source-credential-store";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-source-store-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  return { dbPath, dir, key: crypto.randomBytes(32) };
}

describe("Corpus Source store", () => {
  it("creates a draft source with no enabled collections and hides credentials", () => {
    const { dbPath, dir, key } = fixture();
    const sourceRoot = path.join(dir, "sources", "engineering");
    const input = normalizeCorpusSourceInput(
      {
        kind: "local",
        displayName: "Engineering Files",
        scope: { rootPath: sourceRoot },
        config: {},
        credentials: {},
        schedule: {
          mode: "scheduled",
          maxDocumentSizeBytes: 100 * 1024 * 1024,
        },
      },
      path.join(dir, "sources"),
    );

    const source = createCorpusSource(dbPath, key, input);

    expect(source).toMatchObject({
      kind: "local",
      displayName: "Engineering Files",
      state: "draft",
      configRevision: 1,
      selectionPolicy: "none",
      scope: { rootPath: sourceRoot },
      schedule: { mode: "scheduled", intervalSeconds: 30 },
    });
    expect(listCorpusSources(dbPath)).toEqual([source]);
    expect(JSON.stringify(source)).not.toContain("encrypted_payload");
    expect(readSourceCredentials(dbPath, key, source.id as string)).toEqual({});
  });

  it("increments configuration revision and fences Projects on principal changes", () => {
    const { dbPath, key } = fixture();
    const source = createCorpusSource(dbPath, key, {
      kind: "seeyon",
      displayName: "Seeyon Production",
      scope: { endpoint: "https://seeyon.example.test" },
      config: { loginName: "reader-a" },
      credentials: { username: "rest-a", password: "secret-a" },
      schedule: {
        mode: "scheduled",
        intervalSeconds: 600,
        maxDocumentSizeBytes: 100 * 1024 * 1024,
      },
    });
    const sourceId = source.id as string;
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO projects (
         id, owner_user_id, name, source_id, lifecycle_state,
         retrieval_eligible, created_at, updated_at
       ) VALUES ('proj_seeyon', 'user_demo', 'Library', ?, 'active', 1, ?, ?)`,
    ).run(sourceId, new Date().toISOString(), new Date().toISOString());
    db.close();

    const passwordRotation = updateCorpusSource(dbPath, key, sourceId, {
      credentials: { password: "secret-b" },
    });
    expect(passwordRotation).toMatchObject({ configRevision: 2 });
    let check = new Database(dbPath, { readonly: true });
    expect(
      check.prepare("SELECT retrieval_eligible FROM projects WHERE id = 'proj_seeyon'").get(),
    ).toEqual({ retrieval_eligible: 1 });
    check.close();

    const principalChange = updateCorpusSource(dbPath, key, sourceId, {
      credentials: { username: "rest-b" },
    });
    expect(principalChange).toMatchObject({ configRevision: 3, state: "draft" });
    check = new Database(dbPath, { readonly: true });
    expect(
      check.prepare("SELECT retrieval_eligible FROM projects WHERE id = 'proj_seeyon'").get(),
    ).toEqual({ retrieval_eligible: 0 });
    expect(
      check
        .prepare(
          `SELECT COUNT(*) AS count
             FROM admin_audit_events
            WHERE target_id = ?`,
        )
        .get(sourceId),
    ).toEqual({ count: 3 });
    check.close();
    expect(readSourceCredentials(dbPath, key, sourceId)).toEqual({
      username: "rest-b",
      password: "secret-b",
    });
    expect(getCorpusSource(dbPath, sourceId)?.scope).toEqual({
      endpoint: "https://seeyon.example.test",
    });
  });
});
