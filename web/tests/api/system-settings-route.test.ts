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
    appConfig: {
      dbPath,
      currentProjectsRootHostPath: "/Users/oam/.reasonkb/projects",
      envFilePath: path.join(dir, ".env"),
      composeCommand:
        "docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans",
    },
  }));
  return { dbPath, dir };
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
    expect(json.settings.llmApiKeyConfigured).toBe(false);
    expect(json.settings.llmConfigured).toBe(false);
    expect(json.settings.currentProjectsRootHostPath).toBe(
      "/Users/oam/.reasonkb/projects",
    );
    expect(json.settings.projectsRootSwitchStatus).toBe("idle");
  });

  it("updates runtime settings", async () => {
    makeTempDb();

    const { PATCH } = await import("@/app/api/admin/settings/route");
    const response = await PATCH(
      new Request("http://localhost/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          indexWorkerConcurrency: 3,
          retrievalDocumentLimit: 12,
          llmApiKey: "sk-test",
          llmBaseUrl: "https://llm.example.test/v1",
          llmModel: "openai/deepseek-v4-flash",
          llmRetrievalModel: "openai/deepseek-v4-flash",
        }),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.settings.indexWorkerConcurrency).toBe(3);
    expect(json.settings.retrievalDocumentLimit).toBe(12);
    expect(json.settings.llmApiKeyConfigured).toBe(true);
    expect(json.settings.llmBaseUrl).toBe("https://llm.example.test/v1");
    expect(json.settings.llmConfigured).toBe(true);
  });

  it("saves a pending projects root switch and writes the Docker env file", async () => {
    const { dir } = makeTempDb();

    const { PATCH } = await import("@/app/api/admin/settings/route");
    const response = await PATCH(
      new Request("http://localhost/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectsRootHostPath: "/Volumes/Corpus/ReasonKB",
        }),
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.settings.pendingProjectsRootHostPath).toBe(
      "/Volumes/Corpus/ReasonKB",
    );
    expect(json.settings.projectsRootSwitchStatus).toBe("pending");
    expect(json.projectsRootSwitch).toEqual({
      envFilePath: path.join(dir, ".env"),
      composeCommand:
        "docker compose --env-file ./.env -f compose.yml up -d --force-recreate --remove-orphans",
      pendingHostPath: "/Volumes/Corpus/ReasonKB",
    });
    expect(fs.readFileSync(path.join(dir, ".env"), "utf-8")).toContain(
      "REASONKB_PROJECTS_ROOT=/Volumes/Corpus/ReasonKB",
    );
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

  it("rejects invalid LLM base URLs", async () => {
    makeTempDb();

    const { PATCH } = await import("@/app/api/admin/settings/route");
    const response = await PATCH(
      new Request("http://localhost/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llmBaseUrl: "not-a-url" }),
      }),
    );

    expect(response.status).toBe(400);
  });
});
