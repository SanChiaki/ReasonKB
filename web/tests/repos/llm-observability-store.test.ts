import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { getLlmProviderHealth } from "@/lib/repos/llm-observability-store";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("LLM provider observability store", () => {
  it("derives status from the latest failure streak and expires stale health", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-llm-health-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "app.db");
    migrateDatabase(dbPath);
    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO llm_provider_events (
         id, occurred_at, operation, stage, model, provider_host,
         outcome, error_class, status_code, elapsed_ms, attempt, retryable
       ) VALUES (?, ?, ?, 'pageindex', ?, 'api.deepseek.com', ?, ?, ?, 1000, 1, 1)`,
    );

    insert.run("old-failure", "2026-08-04T11:55:00.000Z", "index", "model-a", "failure", "timeout", 408);
    insert.run("prior-success", "2026-08-04T11:56:00.000Z", "index", "model-a", "success", null, null);
    insert.run("failure-1", "2026-08-04T11:57:00.000Z", "index", "model-a", "failure", "provider_unavailable", 503);
    insert.run("failure-2", "2026-08-04T11:58:00.000Z", "index", "model-a", "failure", "provider_unavailable", 503);
    insert.run("failure-3", "2026-08-04T11:59:00.000Z", "index", "model-a", "failure", "provider_unavailable", 503);
    insert.run("latest-success", "2026-08-04T11:59:30.000Z", "retrieval", "model-b", "success", null, null);
    insert.run("stale-success", "2026-08-04T11:30:00.000Z", "answer", "model-c", "success", null, null);
    db.close();

    const result = getLlmProviderHealth(dbPath, new Date("2026-08-04T12:00:00.000Z"));

    expect(result.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "index",
          model: "model-a",
          status: "unavailable",
          consecutiveFailures: 3,
          recentFailureCount: 4,
          lastFailureStatusCode: 503,
        }),
        expect.objectContaining({
          operation: "retrieval",
          model: "model-b",
          status: "healthy",
          consecutiveFailures: 0,
        }),
        expect.objectContaining({
          operation: "answer",
          model: "model-c",
          status: "unknown",
        }),
      ]),
    );
    expect(result.recentFailures[0]).toMatchObject({
      id: "failure-3",
      errorClass: "provider_unavailable",
      statusCode: 503,
    });
  });
});
