import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import {
  bootstrapAdminPassword,
  createAdminSession,
  isAdminConfigured,
  replaceAdminPassword,
  resetAdminPassword,
  validateAdminSession,
  verifyAdminCredentials,
} from "@/lib/repos/admin-auth-store";
import { hashPassword, verifyPassword } from "@/lib/security/password";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-admin-auth-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "app.db");
  migrateDatabase(dbPath);
  return dbPath;
}

describe("administrator authentication", () => {
  it("hashes passwords with a salted scrypt encoding", () => {
    const first = hashPassword("correct horse battery staple");
    const second = hashPassword("correct horse battery staple");

    expect(first).toMatch(/^scrypt\$/);
    expect(second).not.toBe(first);
    expect(verifyPassword("correct horse battery staple", first)).toBe(true);
    expect(verifyPassword("wrong password", first)).toBe(false);
    expect(verifyPassword("anything", "invalid")).toBe(false);
  });

  it("bootstraps exactly one administrator credential", () => {
    const dbPath = tempDb();

    expect(isAdminConfigured(dbPath)).toBe(false);
    expect(bootstrapAdminPassword(dbPath, "initial admin password")).toBe(true);
    expect(bootstrapAdminPassword(dbPath, "replacement password")).toBe(false);
    expect(isAdminConfigured(dbPath)).toBe(true);
    expect(verifyAdminCredentials(dbPath, "initial admin password")).toBe(true);
    expect(verifyAdminCredentials(dbPath, "replacement password")).toBe(false);
  });

  it("validates session and CSRF tokens and rejects expired sessions", () => {
    const dbPath = tempDb();
    bootstrapAdminPassword(dbPath, "initial admin password");
    const now = new Date("2026-01-01T00:00:00Z");
    const session = createAdminSession(dbPath, now, 60_000);

    expect(validateAdminSession(dbPath, session.token, undefined, now)).toMatchObject({
      id: session.id,
    });
    expect(validateAdminSession(dbPath, session.token, session.csrfToken, now)).toMatchObject({
      id: session.id,
    });
    expect(validateAdminSession(dbPath, session.token, "wrong", now)).toBeNull();
    expect(
      validateAdminSession(dbPath, session.token, undefined, new Date("2026-01-01T00:02:00Z")),
    ).toBeNull();
  });

  it("revokes all existing sessions when the password changes", () => {
    const dbPath = tempDb();
    bootstrapAdminPassword(dbPath, "initial admin password");
    const session = createAdminSession(dbPath);

    expect(replaceAdminPassword(dbPath, "wrong password", "replacement password")).toBe(false);
    expect(
      replaceAdminPassword(dbPath, "initial admin password", "replacement password"),
    ).toBe(true);
    expect(validateAdminSession(dbPath, session.token)).toBeNull();
    expect(verifyAdminCredentials(dbPath, "replacement password")).toBe(true);
  });

  it("resets a forgotten password and revokes all existing sessions", () => {
    const dbPath = tempDb();
    bootstrapAdminPassword(dbPath, "initial admin password");
    const session = createAdminSession(dbPath);

    resetAdminPassword(dbPath, "recovered admin password");

    expect(validateAdminSession(dbPath, session.token)).toBeNull();
    expect(verifyAdminCredentials(dbPath, "initial admin password")).toBe(false);
    expect(verifyAdminCredentials(dbPath, "recovered admin password")).toBe(true);
  });

  it("can reset an administrator that was never bootstrapped", () => {
    const dbPath = tempDb();

    resetAdminPassword(dbPath, "recovered admin password");

    expect(isAdminConfigured(dbPath)).toBe(true);
    expect(verifyAdminCredentials(dbPath, "recovered admin password")).toBe(true);
  });
});
