import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import {
  createApiKey,
  revokeApiKey,
} from "@/lib/repos/api-key-store";

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-agent-auth-verify-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  vi.doMock("@/lib/config", () => ({ appConfig: { dbPath } }));
  return dbPath;
}

describe("agent API key verification route", () => {
  it("accepts a valid key without requiring a tool scope", async () => {
    const dbPath = makeTempDb();
    const key = createApiKey(dbPath, {
      ownerUserId: "user_demo",
      name: "MCP handshake",
      scopes: ["query"],
    });
    const { POST } = await import("@/app/api/agent/auth/verify/route");
    const response = await POST(
      new Request("http://localhost/api/agent/auth/verify", {
        method: "POST",
        headers: { Authorization: "Bearer " + key.apiKey },
      }),
    );

    expect(response.status).toBe(204);
  });

  it("rejects missing and revoked keys", async () => {
    const dbPath = makeTempDb();
    const key = createApiKey(dbPath, {
      ownerUserId: "user_demo",
      name: "Revoked MCP key",
    });
    revokeApiKey(dbPath, {
      ownerUserId: "user_demo",
      keyId: key.id,
    });
    const { POST } = await import("@/app/api/agent/auth/verify/route");

    const missing = await POST(
      new Request("http://localhost/api/agent/auth/verify", { method: "POST" }),
    );
    const revoked = await POST(
      new Request("http://localhost/api/agent/auth/verify", {
        method: "POST",
        headers: { Authorization: "Bearer " + key.apiKey },
      }),
    );

    expect(missing.status).toBe(401);
    expect(revoked.status).toBe(401);
  });
});
