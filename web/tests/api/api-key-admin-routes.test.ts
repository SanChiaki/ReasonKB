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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-api-key-routes-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  bootstrapAdminPassword(dbPath, "initial admin password");
  const session = createAdminSession(dbPath);
  vi.doMock("@/lib/config", () => ({ appConfig: { dbPath } }));
  return {
    headers: {
      cookie: `reasonkb_admin_session=${session.token}`,
      "x-reasonkb-csrf": session.csrfToken,
      "content-type": "application/json",
    },
  };
}

describe("API key administration routes", () => {
  it("requires administrator authentication", async () => {
    const { headers } = fixture();
    const collectionRoute = await import("@/app/api/admin/api-keys/route");

    expect(
      (await collectionRoute.GET(new Request("http://localhost/api/admin/api-keys")))
        .status,
    ).toBe(401);
    expect(
      (
        await collectionRoute.POST(
          new Request("http://localhost/api/admin/api-keys", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "unauthorized" }),
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await collectionRoute.POST(
          new Request("http://localhost/api/admin/api-keys", {
            method: "POST",
            headers: {
              cookie: headers.cookie,
              "content-type": "application/json",
            },
            body: JSON.stringify({ name: "missing-csrf" }),
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("creates, lists, and revokes an API key", async () => {
    const { headers } = fixture();
    const collectionRoute = await import("@/app/api/admin/api-keys/route");
    const createResponse = await collectionRoute.POST(
      new Request("http://localhost/api/admin/api-keys", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Codex", scopes: ["read:projects"] }),
      }),
    );
    const created = await createResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created.apiKey.apiKey).toMatch(/^rkb_live_/);

    const listResponse = await collectionRoute.GET(
      new Request("http://localhost/api/admin/api-keys", { headers }),
    );
    const listed = await listResponse.json();
    expect(listed.apiKeys).toHaveLength(1);
    expect(listed.apiKeys[0]).not.toHaveProperty("apiKey");

    const itemRoute = await import("@/app/api/admin/api-keys/[keyId]/route");
    const revokeResponse = await itemRoute.DELETE(
      new Request(`http://localhost/api/admin/api-keys/${created.apiKey.id}`, {
        method: "DELETE",
        headers,
      }),
      { params: Promise.resolve({ keyId: created.apiKey.id }) },
    );
    expect(revokeResponse.status).toBe(200);
  });
});
