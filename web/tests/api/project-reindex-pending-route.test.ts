import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import {
  bootstrapAdminPassword,
  createAdminSession,
} from "@/lib/repos/admin-auth-store";
import { createProject } from "@/tests/helpers/source-project";

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-bulk-reindex-route-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  bootstrapAdminPassword(dbPath, "initial admin password");
  const session = createAdminSession(dbPath);
  const project = createProject(dbPath, {
    name: "Seeyon Library",
    sourceKind: "seeyon",
  });
  const now = new Date().toISOString();
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO documents (
       id, project_id, owner_user_id, file_name, storage_path, mime_type,
       file_size, status, source_id, source_collection_id, source_revision,
       expected_source_revision, expected_source_config_revision,
       lifecycle_state, created_at, updated_at
     ) VALUES ('doc_uploaded', ?, 'deployment', 'pending.pdf', 'seeyon://pending',
               'application/pdf', 10, 'uploaded', ?, ?, 'r1', 'r1', 1,
               'active', ?, ?)`,
  ).run(project.id, project.sourceId, project.collectionId, now, now);
  db.close();
  vi.doMock("@/lib/config", () => ({ appConfig: { dbPath } }));
  return {
    dbPath,
    projectId: project.id,
    headers: {
      cookie: `reasonkb_admin_session=${session.token}`,
      "x-reasonkb-csrf": session.csrfToken,
    },
  };
}

describe("project pending-document reindex route", () => {
  it("requires administrator authentication", async () => {
    const { projectId } = fixture();
    const { POST } = await import("@/app/api/projects/[projectId]/reindex-pending/route");
    const response = await POST(
      new Request(`http://localhost/api/projects/${projectId}/reindex-pending`, {
        method: "POST",
      }),
      { params: Promise.resolve({ projectId }) },
    );

    expect(response.status).toBe(401);
  });

  it("queues every uploaded document in the project", async () => {
    const { dbPath, projectId, headers } = fixture();
    const { POST } = await import("@/app/api/projects/[projectId]/reindex-pending/route");
    const response = await POST(
      new Request(`http://localhost/api/projects/${projectId}/reindex-pending`, {
        method: "POST",
        headers,
      }),
      { params: Promise.resolve({ projectId }) },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      matched: 1,
      created: 1,
      requeued: 0,
      alreadyRunning: 0,
    });
    const db = new Database(dbPath, { readonly: true });
    expect(
      db.prepare("SELECT document_id, status FROM jobs").all(),
    ).toEqual([{ document_id: "doc_uploaded", status: "queued" }]);
    db.close();
  });
});
