import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { bootstrapAdminPassword, createAdminSession } from "@/lib/repos/admin-auth-store";

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-source-migration-"));
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

async function createSource(headers: Record<string, string>) {
  const route = await import("@/app/api/admin/sources/route");
  const response = await route.POST(
    new Request("http://localhost/api/admin/sources", {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "seeyon",
        displayName: "Seeyon source",
        scope: { endpoint: "http://intranet.example/seeyon" },
        config: { loginName: "reader" },
        credentials: { username: "rest-reader", password: "secret" },
      }),
    }),
  );
  return (await response.json()).source as { id: string };
}

describe("Seeyon source URL migration route", () => {
  it("requires administrator authentication", async () => {
    fixture();
    const { POST } = await import("@/app/api/admin/sources/[sourceId]/migration/route");
    const response = await POST(
      new Request("http://localhost/api/admin/sources/src/migration", {
        method: "POST",
        body: JSON.stringify({ scope: { endpoint: "https://public.example" } }),
      }),
      { params: Promise.resolve({ sourceId: "src" }) },
    );
    expect(response.status).toBe(401);
  });

  it("stages a new URL without changing the active source scope", async () => {
    const { dbPath, headers } = fixture();
    const source = await createSource(headers);
    const db = new Database(dbPath);
    db.prepare(
      `UPDATE corpus_sources SET state = 'active', validated_at = ?, ever_validated_at = ?, health_state = 'normal' WHERE id = ?`,
    ).run(new Date().toISOString(), new Date().toISOString(), source.id);
    db.close();

    const { POST } = await import("@/app/api/admin/sources/[sourceId]/migration/route");
    const response = await POST(
      new Request(`http://localhost/api/admin/sources/${source.id}/migration`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          scope: { endpoint: "https://public.example/" },
          config: { loginName: "reader-public" },
        }),
      }),
      { params: Promise.resolve({ sourceId: source.id }) },
    );
    const payload = await response.json();
    expect(response.status).toBe(202);
    expect(payload.migration).toMatchObject({
      status: "requested",
      targetScope: { endpoint: "https://public.example" },
      targetConfig: { loginName: "reader-public" },
    });
    expect(JSON.stringify(payload)).not.toContain("secret");

    const sourceRoute = await import("@/app/api/admin/sources/[sourceId]/route");
    const sourceResponse = await sourceRoute.GET(
      new Request(`http://localhost/api/admin/sources/${source.id}`, { headers }),
      { params: Promise.resolve({ sourceId: source.id }) },
    );
    const sourcePayload = await sourceResponse.json();
    expect(sourcePayload.source.scope.endpoint).toBe("http://intranet.example/seeyon");
    expect(sourcePayload.source.migration.status).toBe("requested");
  });
});
