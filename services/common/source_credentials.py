from __future__ import annotations

import base64
import json
import stat
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _decode_base64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def load_master_key(path: str | Path) -> bytes:
    raw = Path(path).read_bytes()
    if len(raw) == 32:
        return raw
    text = raw.decode("utf-8").strip()
    if len(text) == 64:
        try:
            decoded = bytes.fromhex(text)
        except ValueError:
            decoded = b""
        if len(decoded) == 32:
            return decoded
    try:
        decoded = base64.b64decode(text, validate=True)
    except ValueError:
        decoded = b""
    if len(decoded) != 32:
        raise ValueError("ReasonKB master key must contain exactly 32 bytes")
    return decoded


def validate_master_key_file(path: str | Path) -> bytes:
    key_path = Path(path)
    mode = key_path.stat().st_mode
    if not stat.S_ISREG(mode):
        raise ValueError("ReasonKB master key must be a regular file")
    if stat.S_IMODE(mode) & 0o077:
        raise PermissionError("ReasonKB master key permissions must not allow group or other access")
    return load_master_key(key_path)


def decrypt_source_credentials(key: bytes, source_id: str, payload: str) -> dict[str, object]:
    if len(key) != 32:
        raise ValueError("ReasonKB master key must contain exactly 32 bytes")
    parts = payload.split(".")
    if len(parts) != 4 or parts[0] != "v1":
        raise ValueError("Unsupported encrypted credential payload")
    nonce = _decode_base64url(parts[1])
    ciphertext = _decode_base64url(parts[2])
    tag = _decode_base64url(parts[3])
    if len(nonce) != 12 or len(tag) != 16:
        raise ValueError("Invalid encrypted credential payload")
    aad = f"reasonkb-source-credential:{source_id}:v1".encode()
    plaintext = AESGCM(key).decrypt(nonce, ciphertext + tag, aad)
    value = json.loads(plaintext)
    if not isinstance(value, dict):
        raise ValueError("Invalid decrypted credential payload")
    return value


if __name__ == "__main__":
    try:
        validate_master_key_file(sys.argv[1])
    except (IndexError, OSError, ValueError) as error:
        print(f"master key validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
