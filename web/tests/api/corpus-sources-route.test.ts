import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import {
  bootstrapAdminPassword,
  createAdminSession,
} from "@/lib/repos/admin-auth-store";

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-source-route-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  const masterKeyPath = path.join(dir, "master.key");
  const localSourceAccessRoot = path.join(dir, "sources");
  fs.mkdirSync(localSourceAccessRoot);
  fs.writeFileSync(masterKeyPath, crypto.randomBytes(32));
  migrateDatabase(dbPath);
  bootstrapAdminPassword(dbPath, "initial admin password");
  const session = createAdminSession(dbPath);
  vi.doMock("@/lib/config", () => ({
    appConfig: { dbPath, masterKeyPath, localSourceAccessRoot },
  }));
  return {
    dbPath,
    headers: {
      cookie: `reasonkb_admin_session=${session.token}`,
      "x-reasonkb-csrf": session.csrfToken,
      "content-type": "application/json",
    },
  };
}

describe("Corpus Source administration routes", () => {
  it("requires administrator authentication", async () => {
    fixture();
    const { GET, POST } = await import("@/app/api/admin/sources/route");

    expect((await GET(new Request("http://localhost/api/admin/sources"))).status).toBe(401);
    expect(
      (
        await POST(
          new Request("http://localhost/api/admin/sources", {
            method: "POST",
            body: "{}",
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("creates, lists, and updates a Seeyon source without exposing credentials", async () => {
    const { headers } = fixture();
    const collectionRoute = await import("@/app/api/admin/sources/route");
    const itemRoute = await import("@/app/api/admin/sources/[sourceId]/route");
    const createResponse = await collectionRoute.POST(
      new Request("http://localhost/api/admin/sources", {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "seeyon",
          displayName: "Seeyon Production",
          scope: { endpoint: "https://seeyon.example.test/" },
          config: { loginName: "document-reader" },
          credentials: { username: "rest-reader", password: "top-secret" },
        }),
      }),
    );
    const created = await createResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created.source).toMatchObject({
      kind: "seeyon",
      state: "draft",
      selectionPolicy: "none",
      scope: { endpoint: "https://seeyon.example.test" },
      schedule: { intervalSeconds: 600 },
    });
    expect(JSON.stringify(created)).not.toContain("top-secret");
    expect(JSON.stringify(created)).not.toContain("rest-reader");

    const listResponse = await collectionRoute.GET(
      new Request("http://localhost/api/admin/sources", { headers }),
    );
    expect((await listResponse.json()).sources).toHaveLength(1);

    const patchResponse = await itemRoute.PATCH(
      new Request(`http://localhost/api/admin/sources/${created.source.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ displayName: "Seeyon Main", credentials: { password: "new" } }),
      }),
      { params: Promise.resolve({ sourceId: created.source.id }) },
    );
    expect(patchResponse.status).toBe(200);
    expect((await patchResponse.json()).source).toMatchObject({
      displayName: "Seeyon Main",
      configRevision: 2,
    });
  });

  it("rejects local roots outside the pre-mounted access boundary", async () => {
    const { headers } = fixture();
    const { POST } = await import("@/app/api/admin/sources/route");
    const response = await POST(
      new Request("http://localhost/api/admin/sources", {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "local",
          displayName: "Outside",
          scope: { rootPath: "/etc" },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Local Source Access Root/);
  });

  it("rejects attempts to mutate immutable source scope", async () => {
    const { headers } = fixture();
    const collectionRoute = await import("@/app/api/admin/sources/route");
    const itemRoute = await import("@/app/api/admin/sources/[sourceId]/route");
    const create = await collectionRoute.POST(
      new Request("http://localhost/api/admin/sources", {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "seeyon",
          displayName: "Seeyon",
          scope: { endpoint: "https://seeyon.example.test" },
          config: { loginName: "reader" },
          credentials: { username: "rest", password: "secret" },
        }),
      }),
    );
    const { source } = await create.json();

    const response = await itemRoute.PATCH(
      new Request(`http://localhost/api/admin/sources/${source.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ scope: { endpoint: "https://other.example.test" } }),
      }),
      { params: Promise.resolve({ sourceId: source.id }) },
    );

    expect(response.status).toBe(400);
  });
});
