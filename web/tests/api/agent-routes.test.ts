import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { createApiKey } from "@/lib/repos/api-key-store";
import { createProject } from "@/tests/helpers/source-project";

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  vi.unmock("@/lib/retrieval-client");
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-agent-routes-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  return dbPath;
}

function mockConfig(dbPath: string) {
  vi.doMock("@/lib/config", () => ({
    appConfig: {
      dbPath,
      retrievalBaseUrl: "http://retrieval.test",
      retrievalInternalApiKey: "",
    },
  }));
}

describe("agent routes", () => {
  it("requires an API key before listing projects", async () => {
    const dbPath = makeTempDb();
    mockConfig(dbPath);

    const { GET } = await import("@/app/api/agent/projects/route");
    const response = await GET(new Request("http://localhost/api/agent/projects"));
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.error).toMatch(/api key/i);
  });

  it("filters visible projects by API key project scope", async () => {
    const dbPath = makeTempDb();
    mockConfig(dbPath);
    const alpha = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });
    createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Beta",
    });
    const key = createApiKey(dbPath, {
      ownerUserId: "user_demo",
      name: "Scoped",
      scopes: ["read:projects"],
      projectIds: [alpha.id],
    });

    const { GET } = await import("@/app/api/agent/projects/route");
    const response = await GET(
      new Request("http://localhost/api/agent/projects", {
        headers: { Authorization: `Bearer ${key.apiKey}` },
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.projects).toHaveLength(1);
    expect(json.projects[0].id).toBe(alpha.id);
  });

  it("passes scoped project IDs to retrieval queries", async () => {
    const dbPath = makeTempDb();
    mockConfig(dbPath);
    const alpha = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });
    const sendRetrievalQuery = vi.fn().mockResolvedValue({
      answer: "answer",
      citations: [],
      selectedDocuments: [],
      evidence: [],
    });
    vi.doMock("@/lib/retrieval-client", () => ({
      sendRetrievalQuery,
    }));
    const key = createApiKey(dbPath, {
      ownerUserId: "user_demo",
      name: "Query",
      scopes: ["query"],
      projectIds: [alpha.id],
    });

    const { POST } = await import("@/app/api/agent/query/route");
    const response = await POST(
      new Request("http://localhost/api/agent/query", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "What changed?" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(sendRetrievalQuery).toHaveBeenCalledWith({
      query: "What changed?",
      projectIds: [alpha.id],
      mode: "answer",
    });
  });
});
