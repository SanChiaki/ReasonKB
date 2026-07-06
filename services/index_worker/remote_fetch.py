from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
import hashlib
import shutil
from typing import Iterator

from services.common.settings import (
    REMOTE_CACHE_ROOT,
    SMB_AUTH_PROTOCOL,
    SMB_BASE_PATH,
    SMB_DOMAIN,
    SMB_HOST,
    SMB_PASSWORD_FILE,
    SMB_PORT,
    SMB_SHARE,
    SMB_USERNAME_FILE,
)
from services.remote_corpus.models import SmbConfig
from services.remote_corpus.smb_paths import safe_cache_file_name
from services.remote_corpus.smb_source import SmbCorpusSource


@dataclass(frozen=True)
class PreparedIndexFile:
    local_path: Path
    content_hash: str | None = None


class RemoteFetchError(RuntimeError):
    pass


@contextmanager
def prepared_index_file(document: dict) -> Iterator[PreparedIndexFile]:
    if document.get("source_kind") != "smb":
        yield PreparedIndexFile(Path(document["storage_path"]))
        return

    document_id = document["document_id"]
    source_path = document.get("source_relative_path") or document.get("file_name") or "downloaded-file"
    document_cache_dir = REMOTE_CACHE_ROOT / document_id
    destination = document_cache_dir / safe_cache_file_name(source_path)

    try:
        try:
            content_hash = fetch_smb_document(document, destination)
        except Exception as exc:
            raise RemoteFetchError(f"SMB download failed for {source_path}") from exc
        yield PreparedIndexFile(destination, content_hash)
    finally:
        shutil.rmtree(document_cache_dir, ignore_errors=True)


def fetch_smb_document(document: dict, destination: Path) -> str:
    source_relative_path = document.get("source_relative_path")
    if not source_relative_path:
        raise ValueError("SMB document is missing source_relative_path")

    source = SmbCorpusSource(
        SmbConfig(
            host=SMB_HOST,
            share=SMB_SHARE,
            base_path=SMB_BASE_PATH,
            username_file=_optional_secret_path(SMB_USERNAME_FILE),
            password_file=_optional_secret_path(SMB_PASSWORD_FILE),
            domain=SMB_DOMAIN,
            port=SMB_PORT,
            auth_protocol=SMB_AUTH_PROTOCOL,
        )
    )
    source.fetch_file(source_relative_path, destination)
    return f"sha256:{_sha256_file(destination)}"


def _optional_secret_path(path: str) -> Path | None:
    return Path(path) if path else None


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()
