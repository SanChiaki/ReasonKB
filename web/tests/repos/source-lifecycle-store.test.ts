import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { createCorpusSource } from "@/lib/repos/corpus-source-store";
import {
  registerSeeyonCollection,
  setCollectionSelectionPolicy,
  setCollectionValidation,
} from "@/lib/repos/source-collection-store";
import {
  disableCorpusSource,
  enableCorpusSource,
  queueManualSourceSync,
  recordSourceValidation,
  requestCorpusSourcePurge,
  restoreCorpusSource,
} from "@/lib/repos/source-lifecycle-store";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-source-lifecycle-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  const source = createCorpusSource(dbPath, crypto.randomBytes(32), {
    kind: "seeyon",
    displayName: "Seeyon",
    scope: { endpoint: "https://seeyon.example.test" },
    config: { loginName: "reader" },
    credentials: { username: "rest", password: "secret" },
    schedule: {
      mode: "scheduled",
      intervalSeconds: 600,
      maxDocumentSizeBytes: 100 * 1024 * 1024,
    },
  });
  const sourceId = source.id as string;
  recordSourceValidation(dbPath, sourceId, { valid: true });
  const collection = registerSeeyonCollection(dbPath, sourceId, {
    displayName: "Library",
    docLibId: "1001",
    rootArchiveId: "1002",
  });
  setCollectionValidation(dbPath, collection.id as string, { valid: true });
  setCollectionSelectionPolicy(dbPath, sourceId, "all");
  return { dbPath, sourceId, collectionId: collection.id as string };
}

describe("Corpus Source lifecycle", () => {
  it("coalesces overlapping manual sync requests per collection", () => {
    const { dbPath, sourceId } = fixture();

    expect(queueManualSourceSync(dbPath, sourceId)).toEqual({
      queued: 1,
      coalesced: 0,
      discoveryRequested: true,
    });
    expect(queueManualSourceSync(dbPath, sourceId)).toEqual({
      queued: 0,
      coalesced: 1,
      discoveryRequested: true,
    });
    const db = new Database(dbPath, { readonly: true });
    expect(
      db
        .prepare(
          `SELECT status, trigger_kind, follow_up_requested
             FROM sync_runs WHERE source_id = ?`,
        )
        .all(sourceId),
    ).toEqual([{ status: "queued", trigger_kind: "manual", follow_up_requested: 1 }]);
    expect(
      db.prepare("SELECT next_sync_at FROM corpus_sources WHERE id = ?").get(sourceId),
    ).toMatchObject({ next_sync_at: expect.any(String) });
    db.close();
  });

  it("disables retrieval and queued work immediately and re-enables through validation", () => {
    const { dbPath, sourceId } = fixture();
    queueManualSourceSync(dbPath, sourceId);

    expect(disableCorpusSource(dbPath, sourceId)).toBe(true);
    let db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT state FROM corpus_sources WHERE id = ?").get(sourceId)).toEqual({
      state: "disabled",
    });
    expect(
      db.prepare("SELECT retrieval_eligible FROM projects WHERE source_id = ?").get(sourceId),
    ).toEqual({ retrieval_eligible: 0 });
    expect(db.prepare("SELECT status FROM sync_runs WHERE source_id = ?").get(sourceId)).toEqual({
      status: "superseded",
    });
    db.close();

    expect(enableCorpusSource(dbPath, sourceId)).toBe(true);
    db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT state FROM corpus_sources WHERE id = ?").get(sourceId)).toEqual({
      state: "validation_pending",
    });
    db.close();
  });

  it("places deletion in a recoverable seven-day pending purge state", () => {
    const { dbPath, sourceId } = fixture();

    const requested = requestCorpusSourcePurge(dbPath, sourceId);
    expect(Date.parse(requested!.purgeAfter)).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    let db = new Database(dbPath, { readonly: true });
    expect(
      db.prepare("SELECT state, purge_after FROM corpus_sources WHERE id = ?").get(sourceId),
    ).toMatchObject({ state: "pending_purge", purge_after: requested!.purgeAfter });
    expect(
      db.prepare("SELECT lifecycle_state FROM projects WHERE source_id = ?").get(sourceId),
    ).toEqual({ lifecycle_state: "pending_purge" });
    db.close();

    expect(restoreCorpusSource(dbPath, sourceId)).toBe(true);
    db = new Database(dbPath, { readonly: true });
    expect(
      db.prepare("SELECT state, purge_after FROM corpus_sources WHERE id = ?").get(sourceId),
    ).toEqual({ state: "disabled", purge_after: null });
    db.close();
  });

  it("waits for a concurrent worker write instead of failing with database locked", async () => {
    const { dbPath, sourceId } = fixture();
    const blocker = spawn("python3", [
      "-c",
      [
        "import sqlite3,sys,time",
        "conn=sqlite3.connect(sys.argv[1])",
        "conn.execute('BEGIN IMMEDIATE')",
        "print('ready', flush=True)",
        "time.sleep(0.25)",
        "conn.commit()",
      ].join(";"),
      dbPath,
    ]);
    await once(blocker.stdout, "data");

    const startedAt = Date.now();
    expect(disableCorpusSource(dbPath, sourceId)).toBe(true);
    const elapsed = Date.now() - startedAt;
    if (blocker.exitCode === null) await once(blocker, "exit");

    expect(elapsed).toBeGreaterThanOrEqual(150);
    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT state FROM corpus_sources WHERE id = ?").get(sourceId)).toEqual({
      state: "disabled",
    });
    db.close();
  });
});
