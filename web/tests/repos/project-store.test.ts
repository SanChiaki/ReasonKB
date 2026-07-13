import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { getProjectById, listProjects } from "@/lib/repos/project-store";
import { createProject } from "@/tests/helpers/source-project";

const tempDirs: string[] = [];

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-project-store-"));
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

describe("deployment-shared source projects", () => {
  it("returns active source projects with source identity", () => {
    const dbPath = makeTempDb();
    const project = createProject(dbPath, {
      ownerUserId: "deployment",
      name: "Operations",
      sourceKind: "seeyon",
      sourceDisplayName: "OA Production",
    });

    expect(listProjects(dbPath)).toEqual([
      expect.objectContaining({
        id: project.id,
        name: "Operations",
        documentCount: 0,
        source: {
          id: project.sourceId,
          displayName: "OA Production",
          kind: "seeyon",
        },
      }),
    ]);
    expect(getProjectById(dbPath, project.id)?.collection.id).toBe(project.collectionId);
  });

  it("does not expose pending, disabled, deselected, or retrieval-fenced projects", () => {
    const dbPath = makeTempDb();
    const pending = createProject(dbPath, { name: "Pending" });
    const disabled = createProject(dbPath, { name: "Disabled" });
    const deselected = createProject(dbPath, { name: "Deselected" });
    const fenced = createProject(dbPath, { name: "Fenced" });
    const db = new Database(dbPath);
    db.prepare("UPDATE projects SET lifecycle_state = 'pending' WHERE id = ?").run(pending.id);
    db.prepare("UPDATE corpus_sources SET state = 'disabled' WHERE id = ?").run(disabled.sourceId);
    db.prepare("UPDATE source_collections SET selected = 0 WHERE id = ?").run(
      deselected.collectionId,
    );
    db.prepare("UPDATE projects SET retrieval_eligible = 0 WHERE id = ?").run(fenced.id);
    db.close();

    expect(listProjects(dbPath)).toEqual([]);
    expect(getProjectById(dbPath, fenced.id)).toBeNull();
  });

  it("counts only active, current, retrieval-eligible documents", () => {
    const dbPath = makeTempDb();
    const project = createProject(dbPath, { name: "Indexed" });
    const now = new Date().toISOString();
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO documents (
         id, project_id, owner_user_id, file_name, storage_path, mime_type,
         file_size, status, source_kind, media_type, import_status,
         source_id, source_collection_id, lifecycle_state, retrieval_eligible,
         created_at, updated_at
       ) VALUES (?, ?, 'deployment', 'ready.pdf', '', 'application/pdf', 1,
                 'ready', 'local', 'pdf', 'imported', ?, ?, 'active', 1, ?, ?)`,
    ).run("doc_ready", project.id, project.sourceId, project.collectionId, now, now);
    db.prepare(
      `INSERT INTO document_indexes (
         id, document_id, doc_name, doc_description, structure_json, pages_json,
         index_version, indexed_at, is_current
       ) VALUES ('idx_ready', 'doc_ready', 'ready', '', '[]', '[]', 'v1', ?, 1)`,
    ).run(now);
    db.close();

    expect(listProjects(dbPath)[0].documentCount).toBe(1);
  });
});
