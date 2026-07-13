import crypto from "node:crypto";

const KEY_LENGTH = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const MAX_MEMORY = 64 * 1024 * 1024;

export function validateAdminPassword(password: string) {
  if (password.length < 12) {
    throw new Error("Administrator password must contain at least 12 characters.");
  }
  if (password.length > 1024) {
    throw new Error("Administrator password is too long.");
  }
}

export function hashPassword(password: string) {
  validateAdminPassword(password);
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEMORY,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export function verifyPassword(password: string, encoded: string) {
  const [algorithm, nValue, rValue, pValue, saltValue, digestValue, extra] =
    encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    !nValue ||
    !rValue ||
    !pValue ||
    !saltValue ||
    !digestValue ||
    extra !== undefined
  ) {
    return false;
  }
  const n = Number.parseInt(nValue, 10);
  const r = Number.parseInt(rValue, 10);
  const p = Number.parseInt(pValue, 10);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) {
    return false;
  }
  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(digestValue, "base64url");
    if (salt.length !== 16 || expected.length !== KEY_LENGTH) {
      return false;
    }
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAX_MEMORY,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
