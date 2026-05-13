import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-settings-route-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  vi.doMock("@/lib/config", () => ({
    appConfig: { dbPath },
  }));
  return dbPath;
}

describe("system settings route", () => {
  it("returns current runtime settings", async () => {
    makeTempDb();

    const { GET } = await import("@/app/api/admin/settings/route");
    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.settings.indexWorkerConcurrency).toBe(1);
    expect(json.settings.retrievalDocumentLimit).toBe(5);
  });

  it("updates runtime settings", async () => {
    makeTempDb();

    const { PATCH } = await import("@/app/api/admin/settings/route");
    const response = await PATCH(
      new Request("http://localhost/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ indexWorkerConcurrency: 3, retrievalDocumentLimit: 12 }),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.settings.indexWorkerConcurrency).toBe(3);
    expect(json.settings.retrievalDocumentLimit).toBe(12);
  });

  it("rejects invalid concurrency values", async () => {
    makeTempDb();

    const { PATCH } = await import("@/app/api/admin/settings/route");
    const response = await PATCH(
      new Request("http://localhost/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ indexWorkerConcurrency: 0 }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects invalid retrieval document limits", async () => {
    makeTempDb();

    const { PATCH } = await import("@/app/api/admin/settings/route");
    const response = await PATCH(
      new Request("http://localhost/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ retrievalDocumentLimit: 0 }),
      }),
    );

    expect(response.status).toBe(400);
  });
});
