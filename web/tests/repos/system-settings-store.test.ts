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

    expect(
      getSystemSettings(dbPath, {
        indexWorkerConcurrency: 3,
        projectsRootHostPath: "/Users/oam/.reasonkb/projects",
      }),
    ).toEqual({
      indexWorkerConcurrency: 3,
      retrievalDocumentLimit: 5,
      llmApiKeyConfigured: false,
      llmBaseUrl: "",
      llmModel: "openai/deepseek-v4-flash",
      llmRetrievalModel: "openai/deepseek-v4-flash",
      llmConfigured: false,
      llmMissingFields: ["API key", "Base URL"],
      currentProjectsRootHostPath: "/Users/oam/.reasonkb/projects",
      pendingProjectsRootHostPath: "",
      projectsRootSwitchStatus: "idle",
      projectsRootSwitchUpdatedAt: null,
    });
  });

  it("persists validated runtime settings", () => {
    const dbPath = makeTempDb();

    const saved = updateSystemSettings(dbPath, {
      indexWorkerConcurrency: 4,
      retrievalDocumentLimit: 12,
      llmApiKey: "sk-test",
      llmBaseUrl: "https://llm.example.test/v1",
      llmModel: "openai/deepseek-v4-flash",
      llmRetrievalModel: "openai/deepseek-v4-flash",
    });

    expect(saved.indexWorkerConcurrency).toBe(4);
    expect(saved.retrievalDocumentLimit).toBe(12);
    expect(saved.llmApiKeyConfigured).toBe(true);
    expect(saved.llmBaseUrl).toBe("https://llm.example.test/v1");
    expect(saved.llmConfigured).toBe(true);
    expect(
      getSystemSettings(dbPath, {
        indexWorkerConcurrency: 1,
        projectsRootHostPath: "/Users/oam/.reasonkb/projects",
      }),
    ).toEqual({
      indexWorkerConcurrency: 4,
      retrievalDocumentLimit: 12,
      llmApiKeyConfigured: true,
      llmBaseUrl: "https://llm.example.test/v1",
      llmModel: "openai/deepseek-v4-flash",
      llmRetrievalModel: "openai/deepseek-v4-flash",
      llmConfigured: true,
      llmMissingFields: [],
      currentProjectsRootHostPath: "/Users/oam/.reasonkb/projects",
      pendingProjectsRootHostPath: "",
      projectsRootSwitchStatus: "idle",
      projectsRootSwitchUpdatedAt: null,
    });
  });

  it("tracks a pending projects root switch until Docker reports the new host mount", () => {
    const dbPath = makeTempDb();

    const saved = updateSystemSettings(
      dbPath,
      { projectsRootHostPath: "/Volumes/Corpus/ReasonKB" },
      { projectsRootHostPath: "/Users/oam/.reasonkb/projects" },
    );

    expect(saved.currentProjectsRootHostPath).toBe("/Users/oam/.reasonkb/projects");
    expect(saved.pendingProjectsRootHostPath).toBe("/Volumes/Corpus/ReasonKB");
    expect(saved.projectsRootSwitchStatus).toBe("pending");
    expect(saved.projectsRootSwitchUpdatedAt).toEqual(expect.any(String));

    const completed = getSystemSettings(dbPath, {
      projectsRootHostPath: "/Volumes/Corpus/ReasonKB",
    });
    expect(completed.pendingProjectsRootHostPath).toBe("/Volumes/Corpus/ReasonKB");
    expect(completed.projectsRootSwitchStatus).toBe("complete");
  });

  it("returns defaults when the settings table does not exist yet", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-settings-legacy-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "app.db");
    fs.closeSync(fs.openSync(dbPath, "w"));

    expect(
      getSystemSettings(dbPath, {
        indexWorkerConcurrency: 2,
        projectsRootHostPath: "/Users/oam/.reasonkb/projects",
      }),
    ).toEqual({
      indexWorkerConcurrency: 2,
      retrievalDocumentLimit: 5,
      llmApiKeyConfigured: false,
      llmBaseUrl: "",
      llmModel: "openai/deepseek-v4-flash",
      llmRetrievalModel: "openai/deepseek-v4-flash",
      llmConfigured: false,
      llmMissingFields: ["API key", "Base URL"],
      currentProjectsRootHostPath: "/Users/oam/.reasonkb/projects",
      pendingProjectsRootHostPath: "",
      projectsRootSwitchStatus: "idle",
      projectsRootSwitchUpdatedAt: null,
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
    expect(
      getSystemSettings(dbPath, {
        indexWorkerConcurrency: 1,
        projectsRootHostPath: "/Users/oam/.reasonkb/projects",
      }),
    ).toEqual({
      indexWorkerConcurrency: 6,
      retrievalDocumentLimit: 5,
      llmApiKeyConfigured: false,
      llmBaseUrl: "",
      llmModel: "openai/deepseek-v4-flash",
      llmRetrievalModel: "openai/deepseek-v4-flash",
      llmConfigured: false,
      llmMissingFields: ["API key", "Base URL"],
      currentProjectsRootHostPath: "/Users/oam/.reasonkb/projects",
      pendingProjectsRootHostPath: "",
      projectsRootSwitchStatus: "idle",
      projectsRootSwitchUpdatedAt: null,
    });
  });

  it("clears a saved API key without clearing the public model fields", () => {
    const dbPath = makeTempDb();

    updateSystemSettings(dbPath, {
      llmApiKey: "sk-test",
      llmBaseUrl: "https://llm.example.test/v1",
      llmModel: "openai/deepseek-v4-flash",
      llmRetrievalModel: "openai/deepseek-v4-flash",
    });
    const cleared = updateSystemSettings(dbPath, {
      llmApiKey: null,
    });

    expect(cleared.llmApiKeyConfigured).toBe(false);
    expect(cleared.llmBaseUrl).toBe("https://llm.example.test/v1");
    expect(cleared.llmMissingFields).toEqual(["API key"]);
  });
});
