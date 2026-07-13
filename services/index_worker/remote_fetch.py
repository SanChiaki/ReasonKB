from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
import hashlib
import json
import shutil
from typing import Iterator

from services.common.settings import (
    LOCAL_SOURCE_ACCESS_ROOT,
    MASTER_KEY_PATH,
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
from services.common.source_credentials import decrypt_source_credentials, load_master_key
from services.common.sqlite_store import open_db
from services.remote_corpus.models import SmbConfig
from services.remote_corpus.smb_paths import safe_cache_file_name
from services.remote_corpus.smb_source import SmbCorpusSource
from services.source_worker.connectors.factory import build_connector
from services.source_worker.models import SourceAccessDenied, SourceItemMetadata


@dataclass(frozen=True)
class PreparedIndexFile:
    local_path: Path
    content_hash: str | None = None


class RemoteFetchError(RuntimeError):
    pass


@contextmanager
def prepared_index_file(document: dict, db_path: str | None = None) -> Iterator[PreparedIndexFile]:
    if document.get("source_id") and db_path:
        with _prepared_source_item(db_path, document) as prepared:
            yield prepared
        return
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


@contextmanager
def _prepared_source_item(db_path: str, document: dict) -> Iterator[PreparedIndexFile]:
    document_id = document["document_id"]
    source_path = document.get("source_relative_path") or document.get("file_name") or "downloaded-file"
    document_cache_dir = REMOTE_CACHE_ROOT / document_id
    destination = document_cache_dir / _source_cache_file_name(document)
    try:
        try:
            with open_db(db_path) as conn:
                source = conn.execute(
                    "SELECT * FROM corpus_sources WHERE id = ?",
                    (document["source_id"],),
                ).fetchone()
                item = conn.execute(
                    "SELECT * FROM source_items WHERE id = ?",
                    (document["source_item_id"],),
                ).fetchone()
                credential_row = conn.execute(
                    "SELECT encrypted_payload FROM source_credentials WHERE source_id = ?",
                    (document["source_id"],),
                ).fetchone()
            if source is None or item is None:
                raise RemoteFetchError("Source-backed document configuration is missing")
            source_dict = dict(source)
            credentials: dict[str, object] = {}
            if source["kind"] != "local":
                if credential_row is None:
                    raise RemoteFetchError("Source credentials are missing")
                credentials = decrypt_source_credentials(
                    load_master_key(MASTER_KEY_PATH),
                    str(document["source_id"]),
                    credential_row["encrypted_payload"],
                )
            connector = build_connector(source_dict, LOCAL_SOURCE_ACCESS_ROOT, credentials)
            metadata = SourceItemMetadata(
                external_id=item["external_id"],
                parent_external_id=None,
                item_type=item["item_type"],
                name=item["name"],
                relative_path=item["relative_path"],
                mime_type=item["mime_type"],
                size_bytes=item["size_bytes"],
                source_revision=item["source_revision"],
                fetch_locator=item["fetch_locator"],
                media_type=document.get("media_type"),
                metadata=json.loads(item["metadata_json"]),
            )
            connector.fetch_item(
                metadata,
                destination,
                str(document["job_expected_source_revision"] or document["expected_source_revision"]),
                int(source["max_document_size_bytes"]),
            )
        except Exception as exc:
            if isinstance(exc, (RemoteFetchError, SourceAccessDenied)):
                raise
            raise RemoteFetchError(f"Source download failed for {source_path}") from exc
        yield PreparedIndexFile(destination)
    finally:
        shutil.rmtree(document_cache_dir, ignore_errors=True)


def _source_cache_file_name(document: dict) -> str:
    # Source-relative identities may be opaque IDs. Office conversion relies on
    # the original extension advertised by the source item.
    source_name = (
        document.get("file_name")
        or document.get("project_relative_path")
        or document.get("source_relative_path")
        or "downloaded-file"
    )
    return safe_cache_file_name(str(source_name))


def fetch_smb_document(document: dict, destination: Path) -> str:
    source_relative_path = document.get("source_relative_path")
    if not source_relative_path:
        raise ValueError("SMB document is missing source_relative_path")
    document_source_root = document.get("source_root")
    if not document_source_root:
        raise ValueError("SMB document is missing source_root")

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
    if source.source_root != document_source_root:
        raise ValueError("SMB document source_root does not match the configured SMB source")
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
