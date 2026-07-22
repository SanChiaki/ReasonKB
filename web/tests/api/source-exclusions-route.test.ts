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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-exclusion-route-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  bootstrapAdminPassword(dbPath, "initial admin password");
  const project = createProject(dbPath, { name: "Operations" });
  const now = new Date().toISOString();
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO source_items (
       id, source_id, collection_id, external_id, item_type, name,
       relative_path, lifecycle_state, created_at, updated_at
     ) VALUES ('item_report', ?, ?, 'report.pdf', 'document', 'report.pdf',
               'report.pdf', 'active', ?, ?)`,
  ).run(project.sourceId, project.collectionId, now, now);
  db.close();
  const session = createAdminSession(dbPath);
  vi.doMock("@/lib/config", () => ({ appConfig: { dbPath } }));
  return {
    dbPath,
    project,
    sessionHeaders: {
      cookie: `reasonkb_admin_session=${session.token}`,
      "x-reasonkb-csrf": session.csrfToken,
      "content-type": "application/json",
    },
  };
}

describe("source exclusion administration routes", () => {
  it("requires authentication and CSRF for writes", async () => {
    const { project, sessionHeaders } = fixture();
    const route = await import("@/app/api/admin/sources/[sourceId]/exclusions/route");
    const context = { params: Promise.resolve({ sourceId: project.sourceId }) };

    expect(
      (await route.GET(new Request("http://localhost/api/admin/sources/x/exclusions"), context))
        .status,
    ).toBe(401);
    const noCsrf = new Request("http://localhost/api/admin/sources/x/exclusions", {
      method: "POST",
      headers: { cookie: sessionHeaders.cookie, "content-type": "application/json" },
      body: JSON.stringify({ targetType: "collection", collectionId: project.collectionId }),
    });
    expect((await route.POST(noCsrf, context)).status).toBe(401);
  });

  it("creates, lists, and deletes server-derived exclusion rules", async () => {
    const { project, sessionHeaders } = fixture();
    const route = await import("@/app/api/admin/sources/[sourceId]/exclusions/route");
    const context = { params: Promise.resolve({ sourceId: project.sourceId }) };
    const createResponse = await route.POST(
      new Request("http://localhost/api/admin/sources/x/exclusions", {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ targetType: "item", sourceItemId: "item_report" }),
      }),
      context,
    );
    const created = await createResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created.exclusion).toMatchObject({
      targetType: "document",
      targetExternalId: "report.pdf",
      displayPath: "report.pdf",
    });
    const listResponse = await route.GET(
      new Request("http://localhost/api/admin/sources/x/exclusions", {
        headers: sessionHeaders,
      }),
      context,
    );
    expect(await listResponse.json()).toEqual({ exclusions: [created.exclusion] });

    const deleteRoute = await import(
      "@/app/api/admin/sources/[sourceId]/exclusions/[ruleId]/route"
    );
    const deleteResponse = await deleteRoute.DELETE(
      new Request("http://localhost/api/admin/sources/x/exclusions/y", {
        method: "DELETE",
        headers: sessionHeaders,
      }),
      {
        params: Promise.resolve({
          sourceId: project.sourceId,
          ruleId: created.exclusion.id,
        }),
      },
    );
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toMatchObject({ restorationPending: true });
  });

  it("rejects client-supplied identity and path fields", async () => {
    const { project, sessionHeaders } = fixture();
    const route = await import("@/app/api/admin/sources/[sourceId]/exclusions/route");
    const response = await route.POST(
      new Request("http://localhost/api/admin/sources/x/exclusions", {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({
          targetType: "collection",
          collectionId: project.collectionId,
          targetExternalId: "forged",
          displayPath: "forged",
        }),
      }),
      { params: Promise.resolve({ sourceId: project.sourceId }) },
    );
    expect(response.status).toBe(400);
  });
});
