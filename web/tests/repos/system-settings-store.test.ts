import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import {
  getSystemSettings,
  updateSystemSettings,
} from "@/lib/repos/system-settings-store";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-settings-store-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  return dbPath;
}

describe("system settings store", () => {
  it("returns defaults when no runtime settings are saved", () => {
    const dbPath = makeTempDb();

    expect(getSystemSettings(dbPath, { indexWorkerConcurrency: 3 })).toEqual({
      indexWorkerConcurrency: 3,
      retrievalDocumentLimit: 5,
    });
  });

  it("persists validated runtime settings", () => {
    const dbPath = makeTempDb();

    const saved = updateSystemSettings(dbPath, {
      indexWorkerConcurrency: 4,
      retrievalDocumentLimit: 12,
    });

    expect(saved.indexWorkerConcurrency).toBe(4);
    expect(saved.retrievalDocumentLimit).toBe(12);
    expect(getSystemSettings(dbPath, { indexWorkerConcurrency: 1 })).toEqual({
      indexWorkerConcurrency: 4,
      retrievalDocumentLimit: 12,
    });
  });

  it("returns defaults when the settings table does not exist yet", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-settings-legacy-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "app.db");
    fs.closeSync(fs.openSync(dbPath, "w"));

    expect(getSystemSettings(dbPath, { indexWorkerConcurrency: 2 })).toEqual({
      indexWorkerConcurrency: 2,
      retrievalDocumentLimit: 5,
    });
  });

  it("creates the settings table when updating a legacy database", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-settings-update-legacy-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "app.db");
    fs.closeSync(fs.openSync(dbPath, "w"));

    expect(
      updateSystemSettings(dbPath, { indexWorkerConcurrency: 6 }).indexWorkerConcurrency,
    ).toBe(6);
    expect(getSystemSettings(dbPath, { indexWorkerConcurrency: 1 })).toEqual({
      indexWorkerConcurrency: 6,
      retrievalDocumentLimit: 5,
    });
  });
});
