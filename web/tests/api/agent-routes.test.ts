import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import {
  MAX_AGENT_PROJECT_IDS,
  createApiKey,
} from "@/lib/repos/api-key-store";
import { createDocumentRecord } from "@/lib/repos/document-store";
import { createSourceExclusion } from "@/lib/repos/source-exclusion-store";
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

function createRetrievableDocument(
  dbPath: string,
  projectId: string,
  fileName: string,
) {
  const document = createDocumentRecord(dbPath, {
    ownerUserId: "user_demo",
    projectId,
    fileName,
    storagePath: `/tmp/${fileName}`,
    mimeType: "application/pdf",
    fileSize: 100,
  });
  const now = new Date().toISOString();
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO document_indexes (
         id, document_id, doc_name, doc_description, structure_json, pages_json,
         index_version, indexed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `idx_${document.id}`,
      document.id,
      fileName,
      `${fileName} description`,
      JSON.stringify([{ title: "Root", node_id: "0000" }]),
      JSON.stringify([{ page: 1, content: `${fileName} content` }]),
      "v1",
      now,
    );
    db.prepare(
      `UPDATE documents
          SET status = 'ready', retrieval_eligible = 1, page_count = 1,
              last_indexed_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(now, now, document.id);
  } finally {
    db.close();
  }
  return document;
}

function readDocumentsKey(dbPath: string, projectId: string) {
  return createApiKey(dbPath, {
    ownerUserId: "user_demo",
    name: "Documents",
    scopes: ["read:documents"],
    projectIds: [projectId],
  });
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
      citations: [
        {
          projectId: alpha.id,
          projectName: "Alpha",
          documentId: "doc_seeyon",
          documentName: "Seeyon.pdf",
          documentUrl: "https://oa.example.test/seeyon/doc.do?docId=doc_seeyon",
          pages: "1",
        },
      ],
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
    expect(await response.json()).toHaveProperty(
      "citations.0.documentUrl",
      "https://oa.example.test/seeyon/doc.do?docId=doc_seeyon",
    );
    expect(sendRetrievalQuery).toHaveBeenCalledWith({
      query: "What changed?",
      projectIds: [alpha.id],
      mode: "answer",
    });
  });

  it("preserves original-document links in evidence responses", async () => {
    const dbPath = makeTempDb();
    mockConfig(dbPath);
    const alpha = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });
    const documentUrl = "https://oa.example.test/seeyon/doc.do?docId=doc_seeyon";
    const sendRetrievalQuery = vi.fn().mockResolvedValue({
      answer: "",
      citations: [],
      selectedDocuments: [{ documentId: "doc_seeyon" }],
      evidence: [
        {
          projectId: alpha.id,
          projectName: "Alpha",
          documentId: "doc_seeyon",
          documentName: "Seeyon.pdf",
          documentUrl,
          pages: "1",
          evidenceKind: "pdf_text",
          content: "Evidence",
        },
      ],
    });
    vi.doMock("@/lib/retrieval-client", () => ({ sendRetrievalQuery }));
    const key = createApiKey(dbPath, {
      ownerUserId: "user_demo",
      name: "Evidence",
      scopes: ["evidence"],
      projectIds: [alpha.id],
    });

    const { POST } = await import("@/app/api/agent/evidence/route");
    const response = await POST(
      new Request("http://localhost/api/agent/evidence", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "Show evidence" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("evidence.0.documentUrl", documentUrl);
    expect(sendRetrievalQuery).toHaveBeenCalledWith({
      query: "Show evidence",
      projectIds: [alpha.id],
      mode: "evidence",
    });
  });

  it.each(["query", "evidence"] as const)(
    "rejects excessive project IDs on the %s route",
    async (routeName) => {
      const dbPath = makeTempDb();
      mockConfig(dbPath);
      const sendRetrievalQuery = vi.fn();
      vi.doMock("@/lib/retrieval-client", () => ({ sendRetrievalQuery }));
      const key = createApiKey(dbPath, {
        ownerUserId: "user_demo",
        name: "Bounded request",
        scopes: [routeName],
      });
      const route =
        routeName === "query"
          ? await import("@/app/api/agent/query/route")
          : await import("@/app/api/agent/evidence/route");

      const response = await route.POST(
        new Request(`http://localhost/api/agent/${routeName}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: "What changed?",
            projectIds: Array.from(
              { length: MAX_AGENT_PROJECT_IDS + 1 },
              (_, index) => `proj_${index}`,
            ),
          }),
        }),
      );

      expect(response.status).toBe(400);
      expect(sendRetrievalQuery).not.toHaveBeenCalled();
    },
  );

  it("returns pages and structure only while a document is retrievable", async () => {
    const dbPath = makeTempDb();
    mockConfig(dbPath);
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });
    const document = createRetrievableDocument(dbPath, project.id, "alpha.pdf");
    const key = readDocumentsKey(dbPath, project.id);
    const headers = { Authorization: `Bearer ${key.apiKey}` };
    const context = { params: Promise.resolve({ documentId: document.id }) };
    const { GET: getPages } = await import(
      "@/app/api/agent/documents/[documentId]/pages/route"
    );
    const { GET: getStructure } = await import(
      "@/app/api/agent/documents/[documentId]/structure/route"
    );

    const pagesResponse = await getPages(
      new NextRequest(
        `http://localhost/api/agent/documents/${document.id}/pages`,
        { headers },
      ),
      context,
    );
    const structureResponse = await getStructure(
      new Request(
        `http://localhost/api/agent/documents/${document.id}/structure`,
        { headers },
      ),
      context,
    );

    expect(pagesResponse.status).toBe(200);
    expect(await pagesResponse.json()).toMatchObject({
      pages: [{ page: 1, content: "alpha.pdf content" }],
    });
    expect(structureResponse.status).toBe(200);
    expect(await structureResponse.json()).toHaveProperty("tree.documentId", document.id);

    const db = new Database(dbPath);
    db.prepare("UPDATE documents SET retrieval_eligible = 0 WHERE id = ?").run(document.id);
    db.close();

    const blockedPages = await getPages(
      new NextRequest(
        `http://localhost/api/agent/documents/${document.id}/pages`,
        { headers },
      ),
      context,
    );
    const blockedStructure = await getStructure(
      new Request(
        `http://localhost/api/agent/documents/${document.id}/structure`,
        { headers },
      ),
      context,
    );

    expect(blockedPages.status).toBe(404);
    expect(await blockedPages.json()).toEqual({ error: "Document pages not found." });
    expect(blockedStructure.status).toBe(404);
    expect(await blockedStructure.json()).toEqual({
      error: "Document index tree not found.",
    });
  });

  it("hides excluded, missing, ineligible, unready, and stale-index documents", async () => {
    const dbPath = makeTempDb();
    mockConfig(dbPath);
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });
    const visible = createRetrievableDocument(dbPath, project.id, "visible.pdf");
    const missing = createRetrievableDocument(dbPath, project.id, "missing.pdf");
    const ineligible = createRetrievableDocument(dbPath, project.id, "ineligible.pdf");
    const unready = createRetrievableDocument(dbPath, project.id, "unready.pdf");
    const staleIndex = createRetrievableDocument(dbPath, project.id, "stale.pdf");
    const excluded = createRetrievableDocument(dbPath, project.id, "excluded.pdf");
    const db = new Database(dbPath);
    try {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO source_items (
           id, source_id, collection_id, external_id, item_type, name,
           relative_path, source_revision, lifecycle_state, document_id,
           created_at, updated_at
         ) VALUES ('item_agent_excluded', ?, ?, 'excluded.pdf', 'document',
                   'excluded.pdf', 'excluded.pdf', 'revision:excluded', 'active',
                   ?, ?, ?)`,
      ).run(project.sourceId, project.collectionId, excluded.id, now, now);
      db.prepare(
        `UPDATE documents
            SET source_id = ?, source_collection_id = ?,
                source_item_id = 'item_agent_excluded',
                source_item_external_id = 'excluded.pdf',
                source_revision = 'revision:excluded',
                expected_source_revision = 'revision:excluded',
                expected_source_config_revision = 1
          WHERE id = ?`,
      ).run(project.sourceId, project.collectionId, excluded.id);
      db.prepare(
        `UPDATE documents
            SET lifecycle_state = 'missing', retrieval_eligible = 0
          WHERE id = ?`,
      ).run(missing.id);
      db.prepare("UPDATE documents SET retrieval_eligible = 0 WHERE id = ?").run(
        ineligible.id,
      );
      db.prepare("UPDATE documents SET status = 'failed' WHERE id = ?").run(unready.id);
      db.prepare("UPDATE document_indexes SET is_current = 0 WHERE document_id = ?").run(
        staleIndex.id,
      );
    } finally {
      db.close();
    }
    createSourceExclusion(dbPath, project.sourceId, {
      targetType: "item",
      sourceItemId: "item_agent_excluded",
    });
    const key = readDocumentsKey(dbPath, project.id);
    const { GET } = await import(
      "@/app/api/agent/projects/[projectId]/documents/route"
    );
    const response = await GET(
      new Request(`http://localhost/api/agent/projects/${project.id}/documents`, {
        headers: { Authorization: `Bearer ${key.apiKey}` },
      }),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.documents.map((item: { id: string }) => item.id)).toEqual([visible.id]);
  });

  it("blocks document content after its source is revoked", async () => {
    const dbPath = makeTempDb();
    mockConfig(dbPath);
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });
    const document = createRetrievableDocument(dbPath, project.id, "revoked.pdf");
    const key = readDocumentsKey(dbPath, project.id);
    const db = new Database(dbPath);
    db.prepare("UPDATE corpus_sources SET state = 'disabled' WHERE id = ?").run(
      project.sourceId,
    );
    db.close();
    const headers = { Authorization: `Bearer ${key.apiKey}` };
    const context = { params: Promise.resolve({ documentId: document.id }) };
    const { GET: getPages } = await import(
      "@/app/api/agent/documents/[documentId]/pages/route"
    );
    const { GET: getStructure } = await import(
      "@/app/api/agent/documents/[documentId]/structure/route"
    );

    const pagesResponse = await getPages(
      new NextRequest(
        `http://localhost/api/agent/documents/${document.id}/pages`,
        { headers },
      ),
      context,
    );
    const structureResponse = await getStructure(
      new Request(
        `http://localhost/api/agent/documents/${document.id}/structure`,
        { headers },
      ),
      context,
    );

    expect(pagesResponse.status).toBe(404);
    expect(structureResponse.status).toBe(404);
  });
});
