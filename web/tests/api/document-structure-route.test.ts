import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { createDocumentRecord } from "@/lib/repos/document-store";
import { createProject } from "@/lib/repos/project-store";

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-structure-route-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  return dbPath;
}

describe("document structure route", () => {
  it("returns a normalized PageIndex tree for a document", async () => {
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
      fileName: "alpha.pdf",
      storagePath: "/tmp/alpha.pdf",
      mimeType: "application/pdf",
      fileSize: 100,
    });

    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO document_indexes (
        id, document_id, doc_name, doc_description, structure_json, pages_json,
        index_version, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `idx_${document.id}`,
      document.id,
      "Alpha",
      "Alpha document",
      JSON.stringify([{ title: "Root", node_id: "0000", nodes: [{ title: "Child" }] }]),
      JSON.stringify([]),
      "v1",
      "2026-05-18T10:00:00.000Z",
    );
    db.close();

    const { GET } = await import("@/app/api/documents/[documentId]/structure/route");
    const response = await GET(
      new Request(`http://localhost/api/documents/${document.id}/structure`),
      { params: Promise.resolve({ documentId: document.id }) },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      documentId: document.id,
      stats: {
        nodeCount: 2,
        leafCount: 1,
        maxDepth: 1,
      },
      roots: [
        {
          id: "0000",
          title: "Root",
          children: [
            {
              id: "node-0-0",
              title: "Child",
            },
          ],
        },
      ],
    });
  });

  it("returns 404 when a document has no stored PageIndex tree", async () => {
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
      fileName: "queued.pdf",
      storagePath: "/tmp/queued.pdf",
      mimeType: "application/pdf",
      fileSize: 100,
    });

    const { GET } = await import("@/app/api/documents/[documentId]/structure/route");
    const response = await GET(
      new Request(`http://localhost/api/documents/${document.id}/structure`),
      { params: Promise.resolve({ documentId: document.id }) },
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.error).toBe("Document index tree not found");
  });
});
