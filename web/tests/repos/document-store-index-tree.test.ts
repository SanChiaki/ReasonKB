import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import {
  createDocumentRecord,
  getDocumentIndexTree,
  listDocumentsByProject,
} from "@/lib/repos/document-store";
import { createProject } from "@/lib/repos/project-store";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-index-tree-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  return dbPath;
}

function insertIndex(
  dbPath: string,
  documentId: string,
  structure: unknown,
  indexedAt = "2026-05-18T10:00:00.000Z",
) {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO document_indexes (
      id, document_id, doc_name, doc_description, structure_json, pages_json,
      index_version, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `idx_${documentId}`,
    documentId,
    "Alpha design",
    "Design workbook",
    JSON.stringify(structure),
    JSON.stringify([]),
    "v1",
    indexedAt,
  );
  db.close();
}

describe("document index tree repository helpers", () => {
  it("marks project documents that have a stored PageIndex tree", () => {
    const dbPath = makeTempDb();
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });
    const indexed = createDocumentRecord(dbPath, {
      ownerUserId: "user_demo",
      projectId: project.id,
      fileName: "indexed.pdf",
      storagePath: "/tmp/indexed.pdf",
      mimeType: "application/pdf",
      fileSize: 100,
    });
    createDocumentRecord(dbPath, {
      ownerUserId: "user_demo",
      projectId: project.id,
      fileName: "queued.pdf",
      storagePath: "/tmp/queued.pdf",
      mimeType: "application/pdf",
      fileSize: 100,
    });
    insertIndex(dbPath, indexed.id, [{ title: "Root", node_id: "0000" }]);

    const rows = listDocumentsByProject(dbPath, project.id);

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: indexed.id,
          hasIndexTree: true,
        }),
        expect.objectContaining({
          fileName: "queued.pdf",
          hasIndexTree: false,
        }),
      ]),
    );
  });

  it("normalizes nested PageIndex structure with stable ids, depth, page range, and counts", () => {
    const dbPath = makeTempDb();
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });
    const document = createDocumentRecord(dbPath, {
      ownerUserId: "user_demo",
      projectId: project.id,
      fileName: "alpha.pdf",
      storagePath: "/tmp/alpha.pdf",
      mimeType: "application/pdf",
      fileSize: 100,
    });
    insertIndex(dbPath, document.id, [
      {
        title: "总体设计",
        node_id: "0000",
        start_index: 1,
        end_index: 6,
        summary: "总体设计摘要",
        nodes: [
          {
            title: "网络规划",
            node_id: "0001",
            start_index: 2,
            end_index: 4,
            summary: "网络规划摘要",
          },
          {
            title: "存储规划",
            start_index: 5,
            end_index: 6,
            nodes: [],
          },
        ],
      },
    ]);

    const result = getDocumentIndexTree(dbPath, document.id);

    expect(result).toEqual({
      documentId: document.id,
      indexedAt: "2026-05-18T10:00:00.000Z",
      stats: {
        nodeCount: 3,
        leafCount: 2,
        maxDepth: 1,
      },
      roots: [
        {
          id: "0000",
          title: "总体设计",
          summary: "总体设计摘要",
          pageRange: "1-6",
          depth: 0,
          children: [
            {
              id: "0001",
              title: "网络规划",
              summary: "网络规划摘要",
              pageRange: "2-4",
              depth: 1,
              children: [],
            },
            {
              id: "node-0-1",
              title: "存储规划",
              summary: null,
              pageRange: "5-6",
              depth: 1,
              children: [],
            },
          ],
        },
      ],
    });
  });

  it("returns null when a document has no stored PageIndex tree", () => {
    const dbPath = makeTempDb();
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });
    const document = createDocumentRecord(dbPath, {
      ownerUserId: "user_demo",
      projectId: project.id,
      fileName: "queued.pdf",
      storagePath: "/tmp/queued.pdf",
      mimeType: "application/pdf",
      fileSize: 100,
    });

    expect(getDocumentIndexTree(dbPath, document.id)).toBeNull();
  });
});
