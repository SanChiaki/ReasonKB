from __future__ import annotations

import mimetypes
from pathlib import Path, PurePosixPath
from typing import Any, Iterator

from services.common.source_formats import is_ignored_name, media_type_for_name
from services.remote_corpus.smb_paths import build_smb_url
from services.source_worker.connectors.local import COPY_CHUNK_SIZE, ROOT_COLLECTION_ID
from services.source_worker.models import (
    EMPTY_EXCLUSION_PLAN,
    CollectionDescriptor,
    ExclusionPlan,
    SourceItemMetadata,
)

FILE_ATTRIBUTE_REPARSE_POINT = 0x400


class SmbConnector:
    kind = "smb"

    def __init__(
        self,
        *,
        host: str,
        share: str,
        base_path: str = "",
        port: int = 445,
        auth_protocol: str = "ntlm",
        username: str = "",
        password: str = "",
        domain: str = "",
        smbclient_module: Any | None = None,
    ):
        self.host = host
        self.share = share
        self.base_path = base_path
        self.port = port
        self.auth_protocol = auth_protocol
        self.username = username
        self.password = password
        self.domain = domain
        self._smbclient = smbclient_module
        self._registered = False

    @property
    def smbclient(self):
        if self._smbclient is None:
            import smbclient

            self._smbclient = smbclient
        return self._smbclient

    @property
    def root_url(self) -> str:
        return build_smb_url(self.host, self.share, self.base_path)

    def validate(self) -> None:
        self._ensure_session()
        iterator = iter(self.smbclient.scandir(self.root_url, port=self.port))
        next(iterator, None)

    def discover_collections(self) -> Iterator[CollectionDescriptor]:
        self._ensure_session()
        has_root_documents = False
        entries = self.smbclient.scandir(self.root_url, port=self.port)
        for entry in sorted(entries, key=lambda value: value.name.casefold()):
            if is_ignored_name(entry.name) or self._is_link(entry):
                continue
            if entry.is_dir():
                yield CollectionDescriptor(
                    identity_key=f"path:{entry.name}",
                    external_id=entry.name,
                    display_name=entry.name,
                )
            elif entry.is_file():
                has_root_documents = True
        if has_root_documents:
            yield CollectionDescriptor(
                identity_key=f"path:{ROOT_COLLECTION_ID}",
                external_id=ROOT_COLLECTION_ID,
                display_name="Root Collection",
            )

    def scan_collection(
        self,
        collection: CollectionDescriptor,
        exclusions: ExclusionPlan = EMPTY_EXCLUSION_PLAN,
    ) -> Iterator[SourceItemMetadata]:
        self._ensure_session()
        if collection.external_id == ROOT_COLLECTION_ID:
            for entry in self.smbclient.scandir(self.root_url, port=self.port):
                if (
                    not is_ignored_name(entry.name)
                    and not self._is_link(entry)
                    and entry.is_file()
                ):
                    yield self._file_metadata(entry, entry.name, entry.name, None)
            return
        remote_root = build_smb_url(
            self.host, self.share, self._join(self.base_path, collection.external_id)
        )
        yield from self._walk(remote_root, collection.external_id, None, exclusions)

    def _walk(
        self,
        remote_path: str,
        source_prefix: str,
        parent_external_id: str | None,
        exclusions: ExclusionPlan,
    ) -> Iterator[SourceItemMetadata]:
        entries = self.smbclient.scandir(remote_path, port=self.port)
        for entry in sorted(entries, key=lambda value: value.name.casefold()):
            if is_ignored_name(entry.name) or self._is_link(entry):
                continue
            external_id = f"{source_prefix}/{entry.name}"
            relative_path = external_id.split("/", 1)[1]
            if entry.is_dir():
                yield SourceItemMetadata(
                    external_id=external_id,
                    parent_external_id=parent_external_id,
                    item_type="folder",
                    name=entry.name,
                    relative_path=relative_path,
                )
                if exclusions.excludes(external_id, "folder"):
                    continue
                yield from self._walk(entry.path, external_id, external_id, exclusions)
            elif entry.is_file():
                yield self._file_metadata(
                    entry, external_id, relative_path, parent_external_id
                )

    def _file_metadata(
        self,
        entry,
        external_id: str,
        relative_path: str,
        parent_external_id: str | None,
    ) -> SourceItemMetadata:
        stat = self._entry_stat(entry)
        mtime_ns = getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000))
        return SourceItemMetadata(
            external_id=external_id,
            parent_external_id=parent_external_id,
            item_type="document",
            name=entry.name,
            relative_path=relative_path,
            mime_type=mimetypes.guess_type(entry.name)[0] or "application/octet-stream",
            size_bytes=stat.st_size,
            source_revision=f"smb:{mtime_ns}:{stat.st_size}",
            fetch_locator=entry.path,
            media_type=media_type_for_name(entry.name),
            metadata={"mtimeNs": mtime_ns},
        )

    def fetch_item(
        self,
        item: SourceItemMetadata,
        destination: Path,
        expected_revision: str,
        maximum_bytes: int,
    ) -> None:
        self._ensure_session()
        remote_path = build_smb_url(
            self.host, self.share, self._join(self.base_path, item.external_id)
        )
        stat = self.smbclient.stat(remote_path, port=self.port)
        mtime_ns = getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000))
        revision = f"smb:{mtime_ns}:{stat.st_size}"
        if revision != expected_revision:
            raise RuntimeError("SMB Source Revision changed before fetch")
        if stat.st_size > maximum_bytes:
            raise ValueError("SMB document exceeds the configured size limit")
        destination.parent.mkdir(parents=True, exist_ok=True)
        copied = 0
        try:
            with self.smbclient.open_file(remote_path, mode="rb", port=self.port) as source:
                with destination.open("wb") as target:
                    while chunk := source.read(COPY_CHUNK_SIZE):
                        copied += len(chunk)
                        if copied > maximum_bytes:
                            raise ValueError("SMB document exceeded the size limit during fetch")
                        target.write(chunk)
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        if copied != stat.st_size:
            destination.unlink(missing_ok=True)
            raise RuntimeError("Downloaded SMB document size does not match source metadata")

    def _ensure_session(self) -> None:
        if self._registered:
            return
        username = self.username
        if username and self.domain:
            username = f"{self.domain}\\{username}"
        self.smbclient.register_session(
            self.host,
            username=username or None,
            password=self.password or None,
            port=self.port,
            auth_protocol=self.auth_protocol,
        )
        self._registered = True

    def _is_link(self, entry) -> bool:
        is_symlink = getattr(entry, "is_symlink", None)
        if callable(is_symlink) and is_symlink():
            return True
        try:
            attributes = getattr(self._entry_stat(entry), "st_file_attributes", 0)
        except OSError:
            return True
        return bool(attributes & FILE_ATTRIBUTE_REPARSE_POINT)

    @staticmethod
    def _entry_stat(entry):
        try:
            return entry.stat(follow_symlinks=False)
        except TypeError:
            return entry.stat()

    @staticmethod
    def _join(*parts: str) -> str:
        segments: list[str] = []
        for part in parts:
            segments.extend(value for value in part.replace("\\", "/").split("/") if value)
        return "/".join(segments)
