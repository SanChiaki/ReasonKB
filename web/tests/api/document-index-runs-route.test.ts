import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { createDocumentRecord } from "@/lib/repos/document-store";
import { createProject } from "@/tests/helpers/source-project";

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-index-runs-route-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  return dbPath;
}

describe("document index runs route", () => {
  it("returns newest index runs for a document", async () => {
    const dbPath = makeTempDb();
    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath,
      },
    }));
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });
    const document = createDocumentRecord(dbPath, {
      ownerUserId: "user_demo",
      projectId: project.id,
      fileName: "handover.md",
      storagePath: "/tmp/handover.md",
      mimeType: "text/markdown",
      fileSize: 100,
    });

    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO document_index_runs (
        id, document_id, job_id, status, started_at, finished_at,
        duration_ms, text_extraction_ms, pageindex_ms, vision_extraction_ms,
        persist_ms, llm_call_count, prompt_tokens, completion_tokens,
        reasoning_tokens, total_tokens, token_source, models_json, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run_new",
      document.id,
      null,
      "completed",
      "2026-04-25T10:00:00Z",
      "2026-04-25T10:01:20Z",
      80000,
      1200,
      76000,
      0,
      200,
      12,
      38000,
      4200,
      3100,
      42200,
      "provider_usage",
      JSON.stringify({ "gpt-4.1": 12 }),
      null,
    );
    db.prepare(
      `INSERT INTO document_index_runs (
        id, document_id, job_id, status, started_at, finished_at,
        duration_ms, text_extraction_ms, pageindex_ms, vision_extraction_ms,
        persist_ms, llm_call_count, prompt_tokens, completion_tokens,
        total_tokens, token_source, models_json, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run_old",
      document.id,
      null,
      "completed",
      "2026-04-25T09:00:00Z",
      "2026-04-25T09:00:10Z",
      10000,
      100,
      9000,
      0,
      100,
      2,
      1000,
      200,
      1200,
      "provider_usage",
      JSON.stringify({ "gpt-4.1": 2 }),
      null,
    );
    db.close();

    const { GET } = await import("@/app/api/documents/[documentId]/index-runs/route");
    const response = await GET(
      new Request(`http://localhost/api/documents/${document.id}/index-runs`),
      { params: Promise.resolve({ documentId: document.id }) },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      runs: [
        {
          id: "run_new",
          status: "completed",
          startedAt: "2026-04-25T10:00:00Z",
          finishedAt: "2026-04-25T10:01:20Z",
          durationMs: 80000,
          textExtractionMs: 1200,
          pageindexMs: 76000,
          visionExtractionMs: 0,
          persistMs: 200,
          llmCallCount: 12,
          promptTokens: 38000,
          completionTokens: 4200,
          reasoningTokens: 3100,
          totalTokens: 42200,
          tokenSource: "provider_usage",
          models: { "gpt-4.1": 12 },
          errorMessage: null,
        },
        {
          id: "run_old",
          status: "completed",
          startedAt: "2026-04-25T09:00:00Z",
          finishedAt: "2026-04-25T09:00:10Z",
          durationMs: 10000,
          textExtractionMs: 100,
          pageindexMs: 9000,
          visionExtractionMs: 0,
          persistMs: 100,
          llmCallCount: 2,
          promptTokens: 1000,
          completionTokens: 200,
          reasoningTokens: null,
          totalTokens: 1200,
          tokenSource: "provider_usage",
          models: { "gpt-4.1": 2 },
          errorMessage: null,
        },
      ],
    });
  });
});
