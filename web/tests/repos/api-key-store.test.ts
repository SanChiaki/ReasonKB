import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import {
  MAX_AGENT_PROJECT_IDS,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
} from "@/lib/repos/api-key-store";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.REASONKB_API_KEY_PEPPER;
  delete process.env.REASONKB_API_KEY_PEPPER_FILE;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-api-key-store-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  return dbPath;
}

describe("api key store", () => {
  it("creates, verifies, lists, and revokes hashed API keys", () => {
    const dbPath = makeTempDb();

    const created = createApiKey(dbPath, {
      ownerUserId: "user_demo",
      name: "Codex",
      scopes: ["read:projects", "query"],
      projectIds: ["proj_1", "proj_1"],
    });

    expect(created.apiKey).toMatch(/^rkb_live_/);
    expect(created.projectIds).toEqual(["proj_1"]);
    expect(listApiKeys(dbPath, "user_demo")[0]).not.toHaveProperty("apiKey");

    const verified = verifyApiKey(dbPath, created.apiKey);
    expect(verified).toMatchObject({
      id: created.id,
      ownerUserId: "user_demo",
      scopes: ["read:projects", "query"],
      projectIds: ["proj_1"],
    });
    expect(verifyApiKey(dbPath, "wrong")).toBeNull();

    expect(revokeApiKey(dbPath, {
      ownerUserId: "user_demo",
      keyId: created.id,
    })).toBe(true);
    expect(verifyApiKey(dbPath, created.apiKey)).toBeNull();

    const db = new Database(dbPath, { readonly: true });
    const auditEvents = db
      .prepare(
        `SELECT action, target_type, target_id, before_json, after_json
           FROM admin_audit_events
          ORDER BY created_at`,
      )
      .all() as Array<Record<string, string | null>>;
    db.close();
    expect(auditEvents.map((event) => event.action)).toEqual([
      "api_key.create",
      "api_key.revoke",
    ]);
    expect(auditEvents.every((event) => event.target_type === "api_key")).toBe(true);
    expect(auditEvents.every((event) => event.target_id === created.id)).toBe(true);
    expect(JSON.stringify(auditEvents)).not.toContain(created.apiKey);
    expect(auditEvents[1].before_json).toContain('"revokedAt":null');
    expect(auditEvents[1].after_json).toMatch(/"revokedAt":".+"/);
  });

  it("reads the API key pepper from a mounted secret file", () => {
    const dbPath = makeTempDb();
    const secretPath = path.join(path.dirname(dbPath), "api_key_pepper");
    fs.writeFileSync(secretPath, "stable-docker-pepper\n");
    process.env.REASONKB_API_KEY_PEPPER_FILE = secretPath;

    const created = createApiKey(dbPath, {
      ownerUserId: "user_demo",
      name: "Docker",
    });
    expect(verifyApiKey(dbPath, created.apiKey)?.id).toBe(created.id);

    fs.writeFileSync(secretPath, "different-pepper\n");
    expect(verifyApiKey(dbPath, created.apiKey)).toBeNull();
  });

  it("rejects API keys with an excessive project scope", () => {
    const dbPath = makeTempDb();

    expect(() =>
      createApiKey(dbPath, {
        ownerUserId: "user_demo",
        name: "Too broad",
        projectIds: Array.from(
          { length: MAX_AGENT_PROJECT_IDS + 1 },
          (_, index) => `proj_${index}`,
        ),
      }),
    ).toThrow(`at most ${MAX_AGENT_PROJECT_IDS} projects`);
  });

  it("rolls back API key mutations when their audit event cannot be stored", () => {
    const createDbPath = makeTempDb();
    const createDb = new Database(createDbPath);
    createDb.exec("DROP TABLE admin_audit_events");
    createDb.close();

    expect(() =>
      createApiKey(createDbPath, {
        ownerUserId: "user_demo",
        name: "No audit",
      }),
    ).toThrow();
    expect(listApiKeys(createDbPath, "user_demo")).toEqual([]);

    const revokeDbPath = makeTempDb();
    const created = createApiKey(revokeDbPath, {
      ownerUserId: "user_demo",
      name: "Revoke rollback",
    });
    const revokeDb = new Database(revokeDbPath);
    revokeDb.exec("DROP TABLE admin_audit_events");
    revokeDb.close();

    expect(() =>
      revokeApiKey(revokeDbPath, {
        ownerUserId: "user_demo",
        keyId: created.id,
      }),
    ).toThrow();
    expect(verifyApiKey(revokeDbPath, created.apiKey)?.id).toBe(created.id);
  });
});
