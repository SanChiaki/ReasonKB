import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "@/lib/db/migrate";
import {
  readSourceCredentials,
  saveSourceCredentials,
} from "@/lib/repos/source-credential-store";
import {
  decryptSourceCredentials,
  encryptSourceCredentials,
  loadMasterKey,
} from "@/lib/security/source-credentials";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonkb-credentials-"));
  tempDirs.push(dir);
  return dir;
}

describe("source credential encryption", () => {
  it("loads raw, hexadecimal, and base64 256-bit master keys", () => {
    const dir = tempDir();
    const key = crypto.randomBytes(32);
    const rawPath = path.join(dir, "raw.key");
    const hexPath = path.join(dir, "hex.key");
    const base64Path = path.join(dir, "base64.key");
    fs.writeFileSync(rawPath, key);
    fs.writeFileSync(hexPath, key.toString("hex"));
    fs.writeFileSync(base64Path, key.toString("base64"));

    expect(loadMasterKey(rawPath)).toEqual(key);
    expect(loadMasterKey(hexPath)).toEqual(key);
    expect(loadMasterKey(base64Path)).toEqual(key);
  });

  it("binds authenticated ciphertext to one source identity", () => {
    const key = crypto.randomBytes(32);
    const credentials = { username: "svc_reasonkb", password: "not-in-plaintext" };
    const first = encryptSourceCredentials(key, "src_a", credentials);
    const second = encryptSourceCredentials(key, "src_a", credentials);

    expect(first).not.toBe(second);
    expect(first).not.toContain(credentials.password);
    expect(decryptSourceCredentials(key, "src_a", first)).toEqual(credentials);
    expect(() => decryptSourceCredentials(key, "src_b", first)).toThrow();

    const parts = first.split(".");
    const tamperedCiphertext = Buffer.from(parts[2], "base64url");
    tamperedCiphertext[0] ^= 1;
    parts[2] = tamperedCiphertext.toString("base64url");
    const tampered = parts.join(".");
    expect(() => decryptSourceCredentials(key, "src_a", tampered)).toThrow();
  });

  it("persists only ciphertext and decrypts for the matching source", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "app.db");
    migrateDatabase(dbPath);
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO corpus_sources (
         id, kind, display_name, state, scope_json, config_json, created_at, updated_at
       ) VALUES ('src_test', 'smb', 'Test SMB', 'active', '{}', '{}', ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
    db.close();
    const key = crypto.randomBytes(32);

    saveSourceCredentials(dbPath, key, "src_test", {
      username: "domain\\reader",
      password: "super-secret-password",
    });

    expect(readSourceCredentials(dbPath, key, "src_test")).toEqual({
      username: "domain\\reader",
      password: "super-secret-password",
    });
    const persisted = new Database(dbPath, { readonly: true })
      .prepare("SELECT encrypted_payload FROM source_credentials WHERE source_id = 'src_test'")
      .get() as { encrypted_payload: string };
    expect(persisted.encrypted_payload).not.toContain("super-secret-password");
    expect(persisted.encrypted_payload).not.toContain("domain\\reader");
  });
});
