import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { bootstrapAdminPassword } from "@/lib/repos/admin-auth-store";

const tempDirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.unmock("@/lib/config");
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function configureAdmin(configured = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-admin-routes-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  if (configured) {
    bootstrapAdminPassword(dbPath, "initial admin password");
  }
  vi.doMock("@/lib/config", () => ({ appConfig: { dbPath } }));
  return dbPath;
}

function sessionCookie(response: Response) {
  const header = response.headers.get("set-cookie") ?? "";
  const match = /reasonkb_admin_session=([^;]+)/.exec(header);
  if (!match) {
    throw new Error("Admin session cookie was not set");
  }
  return `reasonkb_admin_session=${match[1]}`;
}

describe("administrator authentication routes", () => {
  it("reports when administrator bootstrap is incomplete", async () => {
    configureAdmin(false);
    const { POST } = await import("@/app/api/admin/auth/login/route");

    const response = await POST(
      new Request("http://localhost/api/admin/auth/login", {
        method: "POST",
        body: JSON.stringify({ password: "anything" }),
      }),
    );

    expect(response.status).toBe(503);
  });

  it("logs in, validates the session, and requires CSRF for logout", async () => {
    configureAdmin();
    const loginRoute = await import("@/app/api/admin/auth/login/route");
    const sessionRoute = await import("@/app/api/admin/auth/session/route");
    const logoutRoute = await import("@/app/api/admin/auth/logout/route");
    const failed = await loginRoute.POST(
      new Request("http://localhost/api/admin/auth/login", {
        method: "POST",
        body: JSON.stringify({ password: "wrong" }),
      }),
    );
    expect(failed.status).toBe(401);

    const login = await loginRoute.POST(
      new Request("http://localhost/api/admin/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "initial admin password" }),
      }),
    );
    const loginBody = await login.json();
    const cookie = sessionCookie(login);
    expect(login.status).toBe(200);
    expect(loginBody).toMatchObject({
      authenticated: true,
      csrfToken: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("SameSite=strict");

    const session = await sessionRoute.GET(
      new Request("http://localhost/api/admin/auth/session", {
        headers: { cookie },
      }),
    );
    expect(await session.json()).toMatchObject({ configured: true, authenticated: true });

    const missingCsrf = await logoutRoute.POST(
      new Request("http://localhost/api/admin/auth/logout", {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(missingCsrf.status).toBe(401);

    const logout = await logoutRoute.POST(
      new Request("http://localhost/api/admin/auth/logout", {
        method: "POST",
        headers: { cookie, "x-reasonkb-csrf": loginBody.csrfToken },
      }),
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970");

    const expired = await sessionRoute.GET(
      new Request("http://localhost/api/admin/auth/session", {
        headers: { cookie },
      }),
    );
    expect(await expired.json()).toMatchObject({ configured: true, authenticated: false });
  });
});
