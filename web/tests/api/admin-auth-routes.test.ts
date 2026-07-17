import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import { bootstrapAdminPassword } from "@/lib/repos/admin-auth-store";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
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

async function loginAt(url: string, headers: HeadersInit = {}) {
  const { POST } = await import("@/app/api/admin/auth/login/route");
  return POST(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ password: "initial admin password" }),
    }),
  );
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

  it("uses the actual access protocol for administrator cookie security", async () => {
    configureAdmin();
    vi.stubEnv("REASONKB_ADMIN_COOKIE_SECURE", "auto");

    const httpLogin = await loginAt("http://192.168.72.120/api/admin/auth/login");
    expect(httpLogin.headers.get("set-cookie")).not.toContain("Secure");

    const httpsLogin = await loginAt("https://reasonkb.example/api/admin/auth/login");
    expect(httpsLogin.headers.get("set-cookie")).toContain("Secure");

    const proxiedHttpsLogin = await loginAt(
      "http://reasonkb-web:3000/api/admin/auth/login",
      { "x-forwarded-proto": "https" },
    );
    expect(proxiedHttpsLogin.headers.get("set-cookie")).toContain("Secure");
  });

  it("allows administrator cookie security to be explicitly overridden", async () => {
    configureAdmin();
    vi.stubEnv("REASONKB_ADMIN_COOKIE_SECURE", "false");
    const forcedInsecure = await loginAt("https://reasonkb.example/api/admin/auth/login");
    expect(forcedInsecure.headers.get("set-cookie")).not.toContain("Secure");

    vi.stubEnv("REASONKB_ADMIN_COOKIE_SECURE", "true");
    const forcedSecure = await loginAt("http://192.168.72.120/api/admin/auth/login");
    expect(forcedSecure.headers.get("set-cookie")).toContain("Secure");
  });

  it("changes the administrator password and revokes every session", async () => {
    configureAdmin();
    const loginRoute = await import("@/app/api/admin/auth/login/route");
    const passwordRoute = await import("@/app/api/admin/auth/password/route");
    const sessionRoute = await import("@/app/api/admin/auth/session/route");

    const login = await loginRoute.POST(
      new Request("http://localhost/api/admin/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "initial admin password" }),
      }),
    );
    const loginBody = await login.json();
    const cookie = sessionCookie(login);

    const missingCsrf = await passwordRoute.PATCH(
      new Request("http://localhost/api/admin/auth/password", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          currentPassword: "initial admin password",
          newPassword: "replacement admin password",
        }),
      }),
    );
    expect(missingCsrf.status).toBe(401);

    const wrongCurrentPassword = await passwordRoute.PATCH(
      new Request("http://localhost/api/admin/auth/password", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-reasonkb-csrf": loginBody.csrfToken,
        },
        body: JSON.stringify({
          currentPassword: "incorrect current password",
          newPassword: "replacement admin password",
        }),
      }),
    );
    expect(wrongCurrentPassword.status).toBe(400);
    expect(await wrongCurrentPassword.json()).toMatchObject({
      code: "invalid_current_password",
    });

    const changed = await passwordRoute.PATCH(
      new Request("http://localhost/api/admin/auth/password", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-reasonkb-csrf": loginBody.csrfToken,
        },
        body: JSON.stringify({
          currentPassword: "initial admin password",
          newPassword: "replacement admin password",
        }),
      }),
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ changed: true });
    expect(changed.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970");

    const revoked = await sessionRoute.GET(
      new Request("http://localhost/api/admin/auth/session", {
        headers: { cookie },
      }),
    );
    expect(await revoked.json()).toMatchObject({ authenticated: false });

    const oldPasswordLogin = await loginRoute.POST(
      new Request("http://localhost/api/admin/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "initial admin password" }),
      }),
    );
    expect(oldPasswordLogin.status).toBe(401);

    const newPasswordLogin = await loginRoute.POST(
      new Request("http://localhost/api/admin/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "replacement admin password" }),
      }),
    );
    expect(newPasswordLogin.status).toBe(200);
  });
});
