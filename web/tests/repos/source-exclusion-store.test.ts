import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { isDocumentRetrievable } from "@/lib/repos/document-store";
import {
  createSourceExclusion,
  deleteSourceExclusion,
  listSourceExclusions,
} from "@/lib/repos/source-exclusion-store";
import {
  listSourceCollections,
  setCollectionSelectionPolicy,
  setCollectionValidation,
} from "@/lib/repos/source-collection-store";
import {
  getSourceRuntimeStatus,
  listSourceItems,
} from "@/lib/repos/source-observability-store";
import { createProject } from "@/tests/helpers/source-project";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-exclusion-"));
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
     ) VALUES ('item_folder', ?, ?, 'archive', 'folder', 'Archive',
               'Archive', 'active', ?, ?)`,
  ).run(project.sourceId, project.collectionId, now, now);
  db.prepare(
    `INSERT INTO source_items (
       id, source_id, collection_id, external_id, parent_item_id, item_type,
       name, relative_path, source_revision, lifecycle_state, created_at, updated_at
     ) VALUES ('item_document', ?, ?, 'archive/report.pdf', 'item_folder',
               'document', 'report.pdf', 'Archive/report.pdf', 'revision:1',
               'active', ?, ?)`,
  ).run(project.sourceId, project.collectionId, now, now);
  db.prepare(
    `INSERT INTO documents (
       id, project_id, owner_user_id, file_name, storage_path, mime_type,
       file_size, status, source_kind, media_type, import_status,
       source_id, source_collection_id, source_item_id, source_item_external_id,
       source_revision, expected_source_revision, expected_source_config_revision,
       lifecycle_state, retrieval_eligible, created_at, updated_at
     ) VALUES ('doc_report', ?, 'deployment', 'report.pdf', '/source/report.pdf',
               'application/pdf', 100, 'ready', 'directory', 'pdf', 'imported',
               ?, ?, 'item_document', 'archive/report.pdf', 'revision:1',
               'revision:1', 1, 'active', 1, ?, ?)`,
  ).run(project.id, project.sourceId, project.collectionId, now, now);
  db.prepare("UPDATE source_items SET document_id = 'doc_report' WHERE id = 'item_document'").run();
  db.prepare(
    `INSERT INTO document_indexes (
       id, document_id, doc_name, doc_description, structure_json, pages_json,
       index_version, indexed_at, source_revision, is_current
     ) VALUES ('idx_report', 'doc_report', 'report.pdf', 'Report', '[]', '[]',
               'v1', ?, 'revision:1', 1)`,
  ).run(now);
  db.prepare(
    `INSERT INTO jobs (
       id, type, document_id, payload_json, status, source_id,
       source_collection_id, expected_source_revision,
       expected_source_config_revision, created_at, updated_at
     ) VALUES ('job_report', 'document_index', 'doc_report', '{}', 'queued',
               ?, ?, 'revision:1', 1, ?, ?)`,
  ).run(project.sourceId, project.collectionId, now, now);
  db.close();
  return { dbPath, project };
}

describe("source exclusion store", () => {
  it("immediately fences a folder tree while retaining its index", () => {
    const { dbPath, project } = fixture();
    expect(isDocumentRetrievable(dbPath, "doc_report")).toBe(true);

    const created = createSourceExclusion(dbPath, project.sourceId, {
      targetType: "item",
      sourceItemId: "item_folder",
    });

    expect(created).toMatchObject({
      exclusion: {
        collectionId: project.collectionId,
        targetType: "folder",
        targetExternalId: "archive",
        displayPath: "Archive",
      },
      sync: { queued: 1, coalesced: 0 },
    });
    expect(isDocumentRetrievable(dbPath, "doc_report")).toBe(false);

    const db = new Database(dbPath, { readonly: true });
    expect(
      db.prepare("SELECT filter_revision FROM source_collections WHERE id = ?").get(
        project.collectionId,
      ),
    ).toEqual({ filter_revision: 2 });
    expect(
      db
        .prepare("SELECT id, lifecycle_state FROM source_items ORDER BY id")
        .all(),
    ).toEqual([
      { id: "item_document", lifecycle_state: "excluded" },
      { id: "item_folder", lifecycle_state: "excluded" },
    ]);
    expect(
      db
        .prepare("SELECT lifecycle_state, retrieval_eligible FROM documents WHERE id = 'doc_report'")
        .get(),
    ).toEqual({ lifecycle_state: "excluded", retrieval_eligible: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM document_indexes").get()).toEqual({
      count: 1,
    });
    expect(
      db.prepare("SELECT status FROM jobs WHERE id = 'job_report'").get(),
    ).toEqual({ status: "superseded" });
    expect(
      db
        .prepare(
          `SELECT status, trigger_kind, collection_filter_revision
             FROM sync_runs WHERE collection_id = ?`,
        )
        .get(project.collectionId),
    ).toEqual({
      status: "queued",
      trigger_kind: "filter_change",
      collection_filter_revision: 2,
    });
    db.close();

    const rootPage = listSourceItems(dbPath, project.sourceId, {
      collectionId: project.collectionId,
    });
    expect(rootPage?.items).toEqual([
      expect.objectContaining({
        id: "item_folder",
        exclusionRuleId: created.exclusion.id,
        excludedByRuleId: created.exclusion.id,
      }),
    ]);
    const childPage = listSourceItems(dbPath, project.sourceId, {
      collectionId: project.collectionId,
      parentId: "item_folder",
    });
    expect(childPage?.items).toEqual([
      expect.objectContaining({
        id: "item_document",
        exclusionRuleId: null,
        excludedByRuleId: created.exclusion.id,
        excludedByPath: "Archive",
      }),
    ]);
    expect(getSourceRuntimeStatus(dbPath, project.sourceId)?.coverage).toMatchObject({
      totalDocuments: 1,
      excludedDocuments: 1,
      retrievableDocuments: 0,
      percent: 100,
    });
  });

  it("preserves Collection selection intent across exclusion and policy updates", () => {
    const { dbPath, project } = fixture();
    const created = createSourceExclusion(dbPath, project.sourceId, {
      targetType: "collection",
      collectionId: project.collectionId,
    });

    expect(listSourceCollections(dbPath, project.sourceId)).toEqual([
      expect.objectContaining({
        id: project.collectionId,
        selected: true,
        lifecycleState: "excluded",
        exclusionRuleId: created.exclusion.id,
        filterRevision: 2,
      }),
    ]);
    setCollectionSelectionPolicy(dbPath, project.sourceId, "none");
    expect(listSourceCollections(dbPath, project.sourceId)[0]).toMatchObject({
      selected: false,
      lifecycleState: "excluded",
    });
    setCollectionSelectionPolicy(dbPath, project.sourceId, "all");
    expect(listSourceCollections(dbPath, project.sourceId)[0]).toMatchObject({
      selected: true,
      lifecycleState: "excluded",
    });
    expect(
      setCollectionValidation(dbPath, project.collectionId, { valid: true }),
    ).toMatchObject({ selected: true, lifecycleState: "excluded" });

    const db = new Database(dbPath, { readonly: true });
    expect(
      db
        .prepare("SELECT lifecycle_state, retrieval_eligible FROM projects WHERE id = ?")
        .get(project.id),
    ).toEqual({ lifecycle_state: "excluded", retrieval_eligible: 0 });
    db.close();
  });

  it("keeps overlapping exclusions effective and defers restoration to sync", () => {
    const { dbPath, project } = fixture();
    const folder = createSourceExclusion(dbPath, project.sourceId, {
      targetType: "item",
      sourceItemId: "item_folder",
    });
    const document = createSourceExclusion(dbPath, project.sourceId, {
      targetType: "item",
      sourceItemId: "item_document",
    });
    expect(document.sync).toEqual({ queued: 0, coalesced: 1 });

    const deletedDocument = deleteSourceExclusion(
      dbPath,
      project.sourceId,
      document.exclusion.id,
    );
    expect(deletedDocument).toMatchObject({
      stillExcluded: true,
      restorationPending: false,
    });
    const child = listSourceItems(dbPath, project.sourceId, {
      collectionId: project.collectionId,
      parentId: "item_folder",
    });
    expect(child?.items[0]).toMatchObject({
      exclusionRuleId: null,
      excludedByRuleId: folder.exclusion.id,
    });

    const deletedFolder = deleteSourceExclusion(
      dbPath,
      project.sourceId,
      folder.exclusion.id,
    );
    expect(deletedFolder).toMatchObject({
      stillExcluded: false,
      restorationPending: true,
      sync: { queued: 0, coalesced: 1 },
    });
    expect(listSourceExclusions(dbPath, project.sourceId)).toEqual([]);

    const db = new Database(dbPath, { readonly: true });
    expect(
      db.prepare("SELECT lifecycle_state FROM documents WHERE id = 'doc_report'").get(),
    ).toEqual({ lifecycle_state: "excluded" });
    expect(
      db
        .prepare("SELECT filter_revision FROM source_collections WHERE id = ?")
        .get(project.collectionId),
    ).toEqual({ filter_revision: 5 });
    expect(
      db
        .prepare("SELECT collection_filter_revision FROM sync_runs WHERE collection_id = ?")
        .get(project.collectionId),
    ).toEqual({ collection_filter_revision: 5 });
    db.close();
  });

  it("requests a follow-up without rewriting an in-flight sync revision", () => {
    const { dbPath, project } = fixture();
    const now = new Date().toISOString();
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO sync_runs (
         id, source_id, collection_id, source_config_revision,
         collection_filter_revision, trigger_kind, status, started_at
       ) VALUES ('sync_running', ?, ?, 1, 1, 'scheduled', 'running', ?)`,
    ).run(project.sourceId, project.collectionId, now);
    db.close();

    expect(
      createSourceExclusion(dbPath, project.sourceId, {
        targetType: "item",
        sourceItemId: "item_document",
      }).sync,
    ).toEqual({ queued: 0, coalesced: 1 });

    const check = new Database(dbPath, { readonly: true });
    expect(
      check
        .prepare(
          `SELECT collection_filter_revision, follow_up_requested
             FROM sync_runs WHERE id = 'sync_running'`,
        )
        .get(),
    ).toEqual({ collection_filter_revision: 1, follow_up_requested: 1 });
    expect(
      check
        .prepare("SELECT filter_revision FROM source_collections WHERE id = ?")
        .get(project.collectionId),
    ).toEqual({ filter_revision: 2 });
    check.close();
  });
});
