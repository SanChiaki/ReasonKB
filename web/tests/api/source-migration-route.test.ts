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

    const updateResponse = await sourceRoute.PATCH(
      new Request(`http://localhost/api/admin/sources/${source.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ displayName: "renamed source" }),
      }),
      { params: Promise.resolve({ sourceId: source.id }) },
    );
    expect(updateResponse.status).toBe(409);

    const actionsRoute = await import("@/app/api/admin/sources/[sourceId]/actions/route");
    const validationResponse = await actionsRoute.POST(
      new Request(`http://localhost/api/admin/sources/${source.id}/actions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "validate" }),
      }),
      { params: Promise.resolve({ sourceId: source.id }) },
    );
    expect(validationResponse.status).toBe(409);
  });

  it("waits for an active source discovery before staging a URL migration", async () => {
    const { dbPath, headers } = fixture();
    const source = await createSource(headers);
    const db = new Database(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE corpus_sources
          SET state = 'active', validated_at = ?, ever_validated_at = ?, health_state = 'normal'
        WHERE id = ?`,
    ).run(now, now, source.id);
    db.prepare(
      `INSERT INTO source_discovery_runs (
         id, source_id, source_config_revision, status, started_at
       ) VALUES (?, ?, 1, 'running', ?)`,
    ).run("discovery_running", source.id, now);
    db.close();

    const { POST } = await import("@/app/api/admin/sources/[sourceId]/migration/route");
    const response = await POST(
      new Request(`http://localhost/api/admin/sources/${source.id}/migration`, {
        method: "POST",
        headers,
        body: JSON.stringify({ scope: { endpoint: "https://public.example" } }),
      }),
      { params: Promise.resolve({ sourceId: source.id }) },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("source discovery");
  });

  it("requires an explicit administrator confirmation to retry a risky preflight", async () => {
    const { dbPath, headers } = fixture();
    const source = await createSource(headers);
    const db = new Database(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE corpus_sources
          SET state = 'active', validated_at = ?, ever_validated_at = ?, health_state = 'normal'
        WHERE id = ?`,
    ).run(now, now, source.id);
    db.prepare(
      `INSERT INTO corpus_source_migrations (
         id, source_id, source_config_revision, target_scope_json, target_config_json,
         encrypted_credentials, status, error_summary, allow_risk, preflight_json,
         created_at, updated_at
       ) VALUES (?, ?, 1, ?, ?, 'placeholder', 'failed', ?, 0, ?, ?, ?)`,
    ).run(
      "migration_risk",
      source.id,
      JSON.stringify({ endpoint: "https://public.example" }),
      JSON.stringify({ loginName: "reader" }),
      "Target library identity could not be verified; administrator confirmation is required",
      JSON.stringify({ requiresConfirmation: true, collections: [] }),
      now,
      now,
    );
    db.close();

    const { POST } = await import("@/app/api/admin/sources/[sourceId]/migration/confirm/route");
    const response = await POST(
      new Request(`http://localhost/api/admin/sources/${source.id}/migration/confirm`, {
        method: "POST",
        headers,
        body: JSON.stringify({ migrationId: "migration_risk" }),
      }),
      { params: Promise.resolve({ sourceId: source.id }) },
    );

    expect(response.status).toBe(202);
    expect((await response.json()).migration).toMatchObject({
      id: "migration_risk",
      status: "requested",
      requiresConfirmation: false,
    });
    const after = new Database(dbPath, { readonly: true });
    expect(after.prepare("SELECT allow_risk FROM corpus_source_migrations WHERE id = ?").get("migration_risk")).toEqual({ allow_risk: 1 });
    after.close();
  });
});
