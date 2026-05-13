import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { createDocumentRecord } from "@/lib/repos/document-store";
import { createProject } from "@/lib/repos/project-store";

const tempDirs: string[] = [];

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-route-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  return { dir, dbPath };
}

function mockConfig(dbPath: string, uploadRoot: string) {
  vi.doMock("@/lib/config", () => ({
    appConfig: {
      dbPath,
      uploadRoot,
    },
  }));
}

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  vi.unmock("@/lib/repos/document-store");
  vi.unmock("@/lib/repos/job-store");
  vi.unmock("@/lib/repos/project-store");
  vi.unmock("@/lib/storage/local-files");
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("task2 route hardening", () => {
  it("returns 400 for invalid project create payload", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));

    const { POST } = await import("@/app/api/projects/route");
    const response = await POST(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("renames a project through the detail route", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const { PATCH } = await import("@/app/api/projects/[projectId]/route");
    const response = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Beta Launch" }),
      }),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.name).toBe("Beta Launch");
  });

  it("returns 400 for invalid project rename payload", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const { PATCH } = await import("@/app/api/projects/[projectId]/route");
    const response = await PATCH(
      new Request(`http://localhost/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "   " }),
      }),
      { params: Promise.resolve({ projectId: project.id }) },
    );

    expect(response.status).toBe(400);
  });

  it("returns 404 when renaming a missing project", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));

    const { PATCH } = await import("@/app/api/projects/[projectId]/route");
    const response = await PATCH(
      new Request("http://localhost/api/projects/proj_missing", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Beta Launch" }),
      }),
      { params: Promise.resolve({ projectId: "proj_missing" }) },
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 for invalid conversation project payload", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));

    const { PUT } = await import(
      "@/app/api/conversations/[conversationId]/projects/route"
    );
    const response = await PUT(
      new Request("http://localhost/api/conversations/conv_1/projects", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectIds: [""] }),
      }),
      { params: Promise.resolve({ conversationId: "conv_1" }) },
    );

    expect(response.status).toBe(400);
  });

  it("returns 404 when upload target project is missing", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));

    const { POST } = await import(
      "@/app/api/projects/[projectId]/documents/upload/route"
    );
    const form = new FormData();
    form.set(
      "file",
      new File([Buffer.from("%PDF-1.7\nhello")], "x.pdf", {
        type: "application/pdf",
      }),
    );
    const response = await POST(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: form,
      }) as any,
      { params: Promise.resolve({ projectId: "proj_missing" }) },
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 when upload content is not a PDF signature", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/documents/upload/route"
    );
    const form = new FormData();
    form.set(
      "file",
      new File([Buffer.from("not-a-pdf")], "x.pdf", {
        type: "application/pdf",
      }),
    );
    const response = await POST(
      {
        formData: async () => form,
      } as Pick<Request, "formData"> as any,
      { params: Promise.resolve({ projectId: project.id }) },
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 when upload request contains no files", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/documents/upload/route"
    );
    const response = await POST(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: new FormData(),
      }) as any,
      { params: Promise.resolve({ projectId: project.id }) },
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("No files were provided.");
    expect(json.uploaded).toEqual([]);
    expect(json.failed).toEqual([]);
  });

  it("supports partial success for batch uploads", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/documents/upload/route"
    );
    const form = new FormData();
    form.append(
      "files",
      new File([Buffer.from("%PDF-1.7\nvalid")], "alpha.pdf", {
        type: "application/pdf",
      }),
    );
    form.append(
      "files",
      new File([Buffer.from("not-a-pdf")], "broken.pdf", {
        type: "application/pdf",
      }),
    );
    const request = {
      formData: async () => form,
    } as Pick<Request, "formData"> as any;

    const response = await POST(
      request,
      { params: Promise.resolve({ projectId: project.id }) },
    );
    const json = await response.json();

    const db = new Database(dbPath, { readonly: true });
    const documents = db
      .prepare(`SELECT file_name FROM documents ORDER BY file_name ASC`)
      .all() as Array<{ file_name: string }>;
    const jobs = db.prepare(`SELECT COUNT(*) AS count FROM jobs`).get() as {
      count: number;
    };
    db.close();

    expect(response.status).toBe(201);
    expect(json.uploaded).toHaveLength(1);
    expect(json.uploaded[0].fileName).toBe("alpha.pdf");
    expect(json.failed).toEqual([
      {
        fileName: "broken.pdf",
        error: "Uploaded file is not a valid PDF.",
      },
    ]);
    expect(documents).toEqual([{ file_name: "alpha.pdf" }]);
    expect(jobs.count).toBe(1);
  });

  it("accepts Office uploads and stores their media type", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/documents/upload/route"
    );
    const form = new FormData();
    form.append(
      "files",
      new File([Buffer.from("word body")], "scope.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );
    form.append(
      "files",
      new File([Buffer.from("legacy spreadsheet")], "budget.xls", {
        type: "application/vnd.ms-excel",
      }),
    );
    form.append(
      "files",
      new File([Buffer.from("macro spreadsheet")], "macro.xlsm", {
        type: "application/vnd.ms-excel.sheet.macroEnabled.12",
      }),
    );

    const response = await POST(
      {
        formData: async () => form,
      } as Pick<Request, "formData"> as any,
      { params: Promise.resolve({ projectId: project.id }) },
    );
    const json = await response.json();

    const db = new Database(dbPath, { readonly: true });
    const documents = db
      .prepare(
        `SELECT file_name, media_type, mime_type FROM documents ORDER BY file_name ASC`,
      )
      .all() as Array<{
      file_name: string;
      media_type: string;
      mime_type: string;
    }>;
    db.close();

    expect(response.status).toBe(201);
    expect(json.failed).toEqual([]);
    expect(json.uploaded.map((item: { fileName: string }) => item.fileName)).toEqual([
      "scope.docx",
      "budget.xls",
      "macro.xlsm",
    ]);
    expect(documents).toEqual([
      {
        file_name: "budget.xls",
        media_type: "office",
        mime_type: "application/vnd.ms-excel",
      },
      {
        file_name: "macro.xlsm",
        media_type: "office",
        mime_type: "application/vnd.ms-excel.sheet.macroenabled.12",
      },
      {
        file_name: "scope.docx",
        media_type: "office",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ]);
  });

  it("returns 400 with an error when every file in the batch fails", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/documents/upload/route"
    );
    const form = new FormData();
    form.append(
      "files",
      new File([Buffer.from("not-a-pdf")], "broken.pdf", {
        type: "application/pdf",
      }),
    );
    form.append(
      "files",
      new File([Buffer.from("%PDF-1.7\nbody")], "notes.txt", {
        type: "text/plain",
      }),
    );

    const response = await POST(
      {
        formData: async () => form,
      } as Pick<Request, "formData"> as any,
      { params: Promise.resolve({ projectId: project.id }) },
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("All uploads failed.");
    expect(json.uploaded).toEqual([]);
    expect(json.failed).toEqual([
      {
        fileName: "broken.pdf",
        error: "Uploaded file is not a valid PDF.",
      },
      {
        fileName: "notes.txt",
        error: "Unsupported file type. Upload PDF, Word, Excel, or PowerPoint files.",
      },
    ]);
  });

  it("continues processing the batch when queuing one document fails", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    vi.doMock("@/lib/repos/job-store", async () => {
      const actual = await vi.importActual<typeof import("@/lib/repos/job-store")>(
        "@/lib/repos/job-store"
      );
      let calls = 0;

      return {
        ...actual,
        createIndexJob: (currentDbPath: string, documentId: string) => {
          calls += 1;
          if (calls === 1) {
            throw new Error("queue unavailable");
          }
          return actual.createIndexJob(currentDbPath, documentId);
        },
      };
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/documents/upload/route"
    );
    const form = new FormData();
    form.append(
      "files",
      new File([Buffer.from("%PDF-1.7\nfirst")], "first.pdf", {
        type: "application/pdf",
      }),
    );
    form.append(
      "files",
      new File([Buffer.from("%PDF-1.7\nsecond")], "second.pdf", {
        type: "application/pdf",
      }),
    );

    const response = await POST(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: form,
      }) as any,
      { params: Promise.resolve({ projectId: project.id }) },
    );
    const json = await response.json();

    const db = new Database(dbPath, { readonly: true });
    const documents = db
      .prepare(`SELECT file_name FROM documents ORDER BY file_name ASC`)
      .all() as Array<{ file_name: string }>;
    const jobs = db.prepare(`SELECT COUNT(*) AS count FROM jobs`).get() as {
      count: number;
    };
    db.close();

    const projectUploadDir = path.join(dir, "uploads", project.id);
    const storedFiles = fs.existsSync(projectUploadDir)
      ? fs.readdirSync(projectUploadDir)
      : [];

    expect(response.status).toBe(201);
    expect(json.uploaded).toHaveLength(1);
    expect(json.uploaded[0].fileName).toBe("second.pdf");
    expect(json.failed).toEqual([
      {
        fileName: "first.pdf",
        error: "Failed to queue document for indexing.",
      },
    ]);
    expect(documents).toEqual([{ file_name: "second.pdf" }]);
    expect(jobs.count).toBe(1);
    expect(storedFiles).toHaveLength(1);
  });

  it("stores a fallback file name when the uploaded file name is empty", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));
    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/documents/upload/route"
    );
    const form = new FormData();
    form.set(
      "file",
      new File([Buffer.from("%PDF-1.7\nbody")], "", {
        type: "application/pdf",
      }),
    );

    const response = await POST(
      {
        formData: async () => form,
      } as Pick<Request, "formData"> as any,
      { params: Promise.resolve({ projectId: project.id }) },
    );
    const json = await response.json();

    const db = new Database(dbPath, { readonly: true });
    const documents = db
      .prepare(`SELECT file_name FROM documents ORDER BY file_name ASC`)
      .all() as Array<{ file_name: string }>;
    db.close();

    expect(response.status).toBe(201);
    expect(json.uploaded[0].fileName).toBe("unknown.pdf");
    expect(documents).toEqual([{ file_name: "unknown.pdf" }]);
  });

  it("returns 404 when reindexing a missing document", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));

    const { POST } = await import("@/app/api/documents/[documentId]/reindex/route");
    const response = await POST(new Request("http://localhost/reindex", { method: "POST" }), {
      params: Promise.resolve({ documentId: "doc_missing" }),
    });

    expect(response.status).toBe(404);
  });

  it("does not expose storagePath in document detail response", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));

    const project = createProject(dbPath, {
      ownerUserId: "user_demo",
      name: "Alpha",
    });
    const document = createDocumentRecord(dbPath, {
      ownerUserId: "user_demo",
      projectId: project.id,
      fileName: "alpha.pdf",
      storagePath: "/tmp/secret/alpha.pdf",
      mimeType: "application/pdf",
      fileSize: 16,
    });

    const { GET } = await import("@/app/api/documents/[documentId]/route");
    const response = await GET(new Request("http://localhost/doc"), {
      params: Promise.resolve({ documentId: document.id }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.storagePath).toBeUndefined();
  });

  it("returns 400 for invalid pages filter", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));

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
      fileSize: 16,
    });

    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO document_indexes (
         id, document_id, doc_name, doc_description, structure_json, pages_json, index_version, indexed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "idx_1",
      document.id,
      "alpha",
      "alpha",
      "[]",
      JSON.stringify([{ page: 1, content: "a" }]),
      "v1",
      new Date().toISOString(),
    );
    db.close();

    const { GET } = await import("@/app/api/documents/[documentId]/pages/route");
    const request = new NextRequest("http://localhost/doc/pages?pages=abc");
    const response = await GET(request, {
      params: Promise.resolve({ documentId: document.id }),
    });

    expect(response.status).toBe(400);
  });

  it("returns 400 for overly large pages ranges", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));

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
      fileSize: 16,
    });

    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO document_indexes (
         id, document_id, doc_name, doc_description, structure_json, pages_json, index_version, indexed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "idx_2",
      document.id,
      "alpha",
      "alpha",
      "[]",
      JSON.stringify([{ page: 1, content: "a" }]),
      "v1",
      new Date().toISOString(),
    );
    db.close();

    const { GET } = await import("@/app/api/documents/[documentId]/pages/route");
    const request = new NextRequest("http://localhost/doc/pages?pages=1-999999");
    const response = await GET(request, {
      params: Promise.resolve({ documentId: document.id }),
    });

    expect(response.status).toBe(400);
  });

  it("returns 400 for non-digit page tokens like scientific notation", async () => {
    const { dir, dbPath } = makeTempDb();
    mockConfig(dbPath, path.join(dir, "uploads"));

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
      fileSize: 16,
    });

    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO document_indexes (
         id, document_id, doc_name, doc_description, structure_json, pages_json, index_version, indexed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "idx_3",
      document.id,
      "alpha",
      "alpha",
      "[]",
      JSON.stringify([{ page: 1, content: "a" }]),
      "v1",
      new Date().toISOString(),
    );
    db.close();

    const { GET } = await import("@/app/api/documents/[documentId]/pages/route");
    const request = new NextRequest("http://localhost/doc/pages?pages=1e3");
    const response = await GET(request, {
      params: Promise.resolve({ documentId: document.id }),
    });

    expect(response.status).toBe(400);
  });

  it("returns 500 when upload storage fails unexpectedly", async () => {
    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath: "/tmp/unused.db",
        uploadRoot: "/tmp/uploads",
      },
    }));
    vi.doMock("@/lib/repos/project-store", () => ({
      getProjectById: () => ({ id: "proj_1", name: "Alpha" }),
    }));
    vi.doMock("@/lib/storage/local-files", () => ({
      UploadValidationError: class UploadValidationError extends Error {},
      saveUploadedDocument: async () => {
        throw new Error("disk failure");
      },
    }));

    const { POST } = await import(
      "@/app/api/projects/[projectId]/documents/upload/route"
    );
    const form = new FormData();
    form.set(
      "file",
      new File([Buffer.from("%PDF-1.7\nbody")], "x.pdf", {
        type: "application/pdf",
      }),
    );

    const response = await POST(
      new Request("http://localhost/api/upload", {
        method: "POST",
        body: form,
      }) as any,
      { params: Promise.resolve({ projectId: "proj_1" }) },
    );

    expect(response.status).toBe(500);
  });

  it("returns 500 when document pages retrieval fails unexpectedly", async () => {
    vi.doMock("@/lib/config", () => ({
      appConfig: {
        dbPath: "/tmp/unused.db",
        uploadRoot: "/tmp/uploads",
      },
    }));
    vi.doMock("@/lib/repos/document-store", () => ({
      InvalidPagesFilterError: class InvalidPagesFilterError extends Error {},
      getDocumentPages: () => {
        throw new Error("decode failure");
      },
    }));

    const { GET } = await import("@/app/api/documents/[documentId]/pages/route");
    const request = new NextRequest("http://localhost/doc/pages?pages=1");
    const response = await GET(request, {
      params: Promise.resolve({ documentId: "doc_1" }),
    });

    expect(response.status).toBe(500);
  });
});
