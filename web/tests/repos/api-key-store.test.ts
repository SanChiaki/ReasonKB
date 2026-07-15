import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
} from "@/lib/repos/api-key-store";

const tempDirs: string[] = [];

afterEach(() => {
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
  });
});
