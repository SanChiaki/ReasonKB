import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { createCorpusSource } from "@/lib/repos/corpus-source-store";
import {
  deregisterSourceCollection,
  listSourceCollections,
  registerSeeyonCollection,
  setCollectionSelectionPolicy,
  setCollectionValidation,
} from "@/lib/repos/source-collection-store";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-collection-store-"));
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
  return { dbPath, sourceId: source.id as string };
}

function register(dbPath: string, sourceId: string, suffix: string) {
  return registerSeeyonCollection(dbPath, sourceId, {
    displayName: `Library ${suffix}`,
    docLibId: `${suffix}001`,
    rootArchiveId: `${suffix}002`,
  });
}

describe("Source Collection store", () => {
  it("registers Seeyon libraries unselected and rejects duplicate identity", () => {
    const { dbPath, sourceId } = fixture();
    const collection = register(dbPath, sourceId, "1");

    expect(collection).toMatchObject({
      sourceId,
      externalId: "1001",
      rootExternalId: "1002",
      origin: "registered",
      validationState: "unvalidated",
      lifecycleState: "inactive",
      selected: false,
      projectId: null,
    });
    expect(() => register(dbPath, sourceId, "1")).toThrow(/already registered/);
  });

  it("implements None, Explicit, and continuous All selection semantics", () => {
    const { dbPath, sourceId } = fixture();
    const first = register(dbPath, sourceId, "1");
    const second = register(dbPath, sourceId, "2");
    setCollectionValidation(dbPath, first.id as string, { valid: true });
    setCollectionValidation(dbPath, second.id as string, { valid: true });

    const explicit = setCollectionSelectionPolicy(dbPath, sourceId, "explicit", [
      first.id as string,
    ]);
    expect(explicit.collections.map((item) => [item.id, item.selected])).toEqual([
      [first.id, true],
      [second.id, false],
    ]);
    expect(explicit.collections.find((item) => item.id === first.id)?.projectId).toBeTruthy();

    const all = setCollectionSelectionPolicy(dbPath, sourceId, "all");
    expect(all.collections.every((item) => item.selected)).toBe(true);

    const snapshot = setCollectionSelectionPolicy(dbPath, sourceId, "explicit");
    expect(snapshot.collections.every((item) => item.selected)).toBe(true);

    const none = setCollectionSelectionPolicy(dbPath, sourceId, "none");
    expect(none.collections.every((item) => !item.selected)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM projects
            WHERE source_id = ? AND retrieval_eligible = 0 AND lifecycle_state = 'inactive'`,
        )
        .get(sourceId),
    ).toEqual({ count: 2 });
    db.close();
  });

  it("automatically selects a newly validated registration under All", () => {
    const { dbPath, sourceId } = fixture();
    setCollectionSelectionPolicy(dbPath, sourceId, "all");
    const collection = register(dbPath, sourceId, "3");

    const validated = setCollectionValidation(dbPath, collection.id as string, { valid: true });

    expect(validated).toMatchObject({ selected: true, lifecycleState: "pending" });
    expect(validated?.projectId).toBeTruthy();
  });

  it("requires deselection before deregistration and restores the same identity", () => {
    const { dbPath, sourceId } = fixture();
    const collection = register(dbPath, sourceId, "4");
    setCollectionValidation(dbPath, collection.id as string, { valid: true });
    setCollectionSelectionPolicy(dbPath, sourceId, "explicit", [collection.id as string]);
    expect(() => deregisterSourceCollection(dbPath, collection.id as string)).toThrow(
      /Deselect/,
    );
    setCollectionSelectionPolicy(dbPath, sourceId, "none");

    expect(deregisterSourceCollection(dbPath, collection.id as string)).toBe(true);
    expect(listSourceCollections(dbPath, sourceId)).toEqual([]);
    const restored = registerSeeyonCollection(dbPath, sourceId, {
      displayName: "Restored Library",
      docLibId: "4001",
      rootArchiveId: "4002",
    });
    expect(restored.id).toBe(collection.id);
    expect(restored.displayName).toBe("Restored Library");
  });
});
