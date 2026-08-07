import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
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
      embeddingApiKeyConfigured: false,
      embeddingApiKeyInherited: true,
      embeddingBaseUrl: "",
      embeddingBaseUrlInherited: true,
      embeddingModel: "",
      embeddingConfigured: false,
      embeddingMissingFields: ["API key", "Base URL", "Model"],
      semanticIndex: {
        status: "unconfigured",
        configuredModel: "",
        activeModel: null,
        indexedDocumentCount: 0,
        totalDocumentCount: 0,
        coverage: 0,
        error: null,
      },
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
      embeddingApiKeyConfigured: true,
      embeddingApiKeyInherited: true,
      embeddingBaseUrl: "https://llm.example.test/v1",
      embeddingBaseUrlInherited: true,
      embeddingModel: "",
      embeddingConfigured: false,
      embeddingMissingFields: ["Model"],
      semanticIndex: {
        status: "unconfigured",
        configuredModel: "",
        activeModel: null,
        indexedDocumentCount: 0,
        totalDocumentCount: 0,
        coverage: 0,
        error: null,
      },
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
      embeddingApiKeyConfigured: false,
      embeddingApiKeyInherited: true,
      embeddingBaseUrl: "",
      embeddingBaseUrlInherited: true,
      embeddingModel: "",
      embeddingConfigured: false,
      embeddingMissingFields: ["API key", "Base URL", "Model"],
      semanticIndex: {
        status: "unconfigured",
        configuredModel: "",
        activeModel: null,
        indexedDocumentCount: 0,
        totalDocumentCount: 0,
        coverage: 0,
        error: null,
      },
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
      embeddingApiKeyConfigured: false,
      embeddingApiKeyInherited: true,
      embeddingBaseUrl: "",
      embeddingBaseUrlInherited: true,
      embeddingModel: "",
      embeddingConfigured: false,
      embeddingMissingFields: ["API key", "Base URL", "Model"],
      semanticIndex: {
        status: "unconfigured",
        configuredModel: "",
        activeModel: null,
        indexedDocumentCount: 0,
        totalDocumentCount: 0,
        coverage: 0,
        error: null,
      },
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

  it("inherits LLM credentials while requiring an explicit embedding model", () => {
    const dbPath = makeTempDb();

    const saved = updateSystemSettings(dbPath, {
      llmApiKey: "sk-test",
      llmBaseUrl: "https://llm.example.test/v1",
      embeddingModel: "text-embedding-3-small",
    });

    expect(saved.embeddingApiKeyConfigured).toBe(true);
    expect(saved.embeddingApiKeyInherited).toBe(true);
    expect(saved.embeddingBaseUrl).toBe("https://llm.example.test/v1");
    expect(saved.embeddingBaseUrlInherited).toBe(true);
    expect(saved.embeddingConfigured).toBe(true);
    expect(saved.embeddingMissingFields).toEqual([]);
    expect(saved.semanticIndex.status).toBe("validating");
  });

  it("stores independent embedding credentials without exposing the key", () => {
    const dbPath = makeTempDb();

    const saved = updateSystemSettings(dbPath, {
      embeddingApiKey: "embed-secret",
      embeddingBaseUrl: "https://embedding.example.test/v1",
      embeddingModel: "text-embedding-v4",
    });

    expect(saved.embeddingApiKeyConfigured).toBe(true);
    expect(saved.embeddingApiKeyInherited).toBe(false);
    expect(saved.embeddingBaseUrlInherited).toBe(false);
    expect(saved.embeddingBaseUrl).toBe("https://embedding.example.test/v1");
    expect(JSON.stringify(saved)).not.toContain("embed-secret");
  });

  it("ignores a retired generation while a model is being reactivated", () => {
    const dbPath = makeTempDb();
    updateSystemSettings(dbPath, {
      embeddingApiKey: "embed-secret",
      embeddingBaseUrl: "https://embedding.example.test/v1",
      embeddingModel: "text-embedding-3-small",
    });
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO semantic_index_generations(
         id, model, base_url, profile_version, status, is_active,
         indexed_document_count, total_document_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'retired', 0, 0, 0, ?, ?)`,
    ).run(
      "semgen_retired",
      "text-embedding-3-small",
      "https://embedding.example.test/v1",
      "document-node-v1",
      "2026-08-08T00:00:00Z",
      "2026-08-08T00:00:00Z",
    );
    db.close();

    const settings = getSystemSettings(dbPath);

    expect(settings.semanticIndex.status).toBe("validating");
    expect(settings.semanticIndex.activeModel).toBeNull();
  });
});
