import crypto from "node:crypto";
import fs from "node:fs";

const VERSION = "v1";
const AAD_PREFIX = "reasonkb-source-credential";

function decodeTextKey(value: string) {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

export function loadMasterKey(filePath: string) {
  const raw = fs.readFileSync(filePath);
  if (raw.length === 32) {
    return raw;
  }
  const decoded = decodeTextKey(raw.toString("utf8"));
  if (!decoded) {
    throw new Error("ReasonKB master key must contain exactly 32 bytes.");
  }
  return decoded;
}

function associatedData(sourceId: string) {
  return Buffer.from(`${AAD_PREFIX}:${sourceId}:${VERSION}`, "utf8");
}

export function encryptSourceCredentials(
  key: Buffer,
  sourceId: string,
  credentials: Record<string, unknown>,
) {
  if (key.length !== 32) {
    throw new Error("ReasonKB master key must contain exactly 32 bytes.");
  }
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associatedData(sourceId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function decryptSourceCredentials(
  key: Buffer,
  sourceId: string,
  payload: string,
) {
  if (key.length !== 32) {
    throw new Error("ReasonKB master key must contain exactly 32 bytes.");
  }
  const [version, nonceValue, ciphertextValue, tagValue, extra] = payload.split(".");
  if (
    version !== VERSION ||
    !nonceValue ||
    !ciphertextValue ||
    !tagValue ||
    extra !== undefined
  ) {
    throw new Error("Unsupported encrypted credential payload.");
  }
  const nonce = Buffer.from(nonceValue, "base64url");
  const ciphertext = Buffer.from(ciphertextValue, "base64url");
  const tag = Buffer.from(tagValue, "base64url");
  if (nonce.length !== 12 || tag.length !== 16) {
    throw new Error("Invalid encrypted credential payload.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(associatedData(sourceId));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const value: unknown = JSON.parse(plaintext.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid decrypted credential payload.");
  }
  return value as Record<string, unknown>;
}
