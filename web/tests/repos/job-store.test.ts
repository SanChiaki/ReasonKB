import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { createIndexJob } from "@/lib/repos/job-store";
import { createProject } from "@/tests/helpers/source-project";

const tempDirs: string[] = [];

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-job-store-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  return dbPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("document index jobs", () => {
  it("makes a delayed retry immediately available when an administrator reindexes", () => {
    const dbPath = makeTempDb();
    const project = createProject(dbPath, { name: "Seeyon Library", sourceKind: "seeyon" });
    const oldUpdatedAt = "2026-07-13T09:13:39.726779+00:00";
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO documents (
         id, project_id, owner_user_id, file_name, storage_path, mime_type,
         file_size, status, source_id, source_collection_id, source_revision,
         expected_source_revision, expected_source_config_revision,
         lifecycle_state, created_at, updated_at
       ) VALUES ('doc_1', ?, 'deployment', 'template.xlsx', 'seeyon://template',
                 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                 11529, 'uploaded', ?, ?, 'r1', 'r1', 1, 'active', ?, ?)`,
    ).run(project.id, project.sourceId, project.collectionId, oldUpdatedAt, oldUpdatedAt);
    db.prepare(
      `INSERT INTO jobs (
         id, type, document_id, payload_json, status, error_message,
         source_id, source_collection_id, expected_source_revision,
         expected_source_config_revision, priority, attempt_count, max_attempts,
         available_at, created_at, updated_at
       ) VALUES ('job_retry', 'document_index', 'doc_1', '{}', 'queued',
                 'OPENAI_API_KEY is not configured', ?, ?, 'r1', 1,
                 300, 4, 6, '2099-01-01T00:00:00.000Z', ?, ?)`,
    ).run(project.sourceId, project.collectionId, oldUpdatedAt, oldUpdatedAt);
    db.close();

    const before = Date.now();
    expect(createIndexJob(dbPath, "doc_1")).toEqual({ id: "job_retry", status: "queued" });
    const after = Date.now();

    const check = new Database(dbPath, { readonly: true });
    const job = check
      .prepare(
        `SELECT priority, attempt_count, available_at, error_message, updated_at
           FROM jobs WHERE id = 'job_retry'`,
      )
      .get() as {
      priority: number;
      attempt_count: number;
      available_at: string;
      error_message: string | null;
      updated_at: string;
    };
    check.close();

    const availableAt = Date.parse(job.available_at);
    expect(job.priority).toBe(50);
    expect(job.attempt_count).toBe(0);
    expect(job.error_message).toBeNull();
    expect(job.updated_at).not.toBe(oldUpdatedAt);
    expect(availableAt).toBeGreaterThanOrEqual(before);
    expect(availableAt).toBeLessThanOrEqual(after);
  });
});
