import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import {
  getSourceRuntimeStatus,
  listSourceItems,
} from "@/lib/repos/source-observability-store";
import { createProject } from "@/tests/helpers/source-project";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("source observability store", () => {
  it("returns document status and a human-readable item reason", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-source-status-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "app.db");
    migrateDatabase(dbPath);
    const project = createProject(dbPath, { name: "Operations" });
    const now = new Date().toISOString();
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO source_items (
         id, source_id, collection_id, external_id, item_type, name,
         relative_path, lifecycle_state, created_at, updated_at
       ) VALUES ('item_1', ?, ?, 'oversized.pdf', 'document', 'oversized.pdf',
                 'oversized.pdf', 'oversized', ?, ?)`,
    ).run(project.sourceId, project.collectionId, now, now);
    db.prepare(
      `INSERT INTO documents (
         id, project_id, owner_user_id, file_name, storage_path, mime_type,
         file_size, status, source_kind, media_type, import_status, import_error,
         source_id, source_collection_id, source_item_id,
         source_item_external_id, lifecycle_state, retrieval_eligible,
         created_at, updated_at
       ) VALUES ('doc_1', ?, 'deployment', 'oversized.pdf', '', 'application/pdf',
                 999, 'skipped', 'directory', 'pdf', 'skipped',
                 'Document exceeds the configured size limit', ?, ?, 'item_1',
                 'oversized.pdf', 'oversized', 0, ?, ?)`,
    ).run(project.id, project.sourceId, project.collectionId, now, now);
    db.prepare("UPDATE source_items SET document_id = 'doc_1' WHERE id = 'item_1'").run();
    db.close();

    expect(
      listSourceItems(dbPath, project.sourceId, { collectionId: project.collectionId }),
    ).toEqual([
      expect.objectContaining({
        id: "item_1",
        lifecycleState: "oversized",
        documentStatus: "skipped",
        statusReason: "Document exceeds the configured size limit",
      }),
    ]);
    expect(getSourceRuntimeStatus(dbPath, project.sourceId)?.coverage).toMatchObject({
      totalDocuments: 1,
      retrievableDocuments: 0,
      oversizedDocuments: 1,
    });
  });
});
