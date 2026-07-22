from __future__ import annotations

import mimetypes
import os
from pathlib import Path
from typing import Iterator

from services.common.source_formats import is_ignored_name, media_type_for_name
from services.source_worker.models import (
    EMPTY_EXCLUSION_PLAN,
    CollectionDescriptor,
    ExclusionPlan,
    SourceItemMetadata,
)

ROOT_COLLECTION_ID = "__root__"
COPY_CHUNK_SIZE = 1024 * 1024


class LocalConnector:
    kind = "local"

    def __init__(self, root_path: str | Path, access_root: str | Path):
        self.root = Path(root_path).resolve()
        self.access_root = Path(access_root).resolve()

    def validate(self) -> None:
        self._ensure_within_access_root(self.root)
        if not self.root.exists():
            raise FileNotFoundError(f"Local source root does not exist: {self.root}")
        if not self.root.is_dir():
            raise NotADirectoryError(f"Local source root is not a directory: {self.root}")

    def discover_collections(self) -> Iterator[CollectionDescriptor]:
        self.validate()
        has_root_documents = False
        with os.scandir(self.root) as entries:
            for entry in sorted(entries, key=lambda value: value.name.casefold()):
                if is_ignored_name(entry.name) or entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    yield CollectionDescriptor(
                        identity_key=f"path:{entry.name}",
                        external_id=entry.name,
                        display_name=entry.name,
                    )
                elif entry.is_file(follow_symlinks=False):
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
        self.validate()
        if collection.external_id == ROOT_COLLECTION_ID:
            yield from self._scan_root_documents()
            return
        collection_root = self.root / collection.external_id
        self._ensure_safe_path(collection_root)
        if not collection_root.is_dir():
            raise FileNotFoundError(f"Local collection root does not exist: {collection.external_id}")
        yield from self._walk_directory(
            collection_root,
            collection.external_id,
            None,
            exclusions,
        )

    def fetch_item(
        self,
        item: SourceItemMetadata,
        destination: Path,
        expected_revision: str,
        maximum_bytes: int,
    ) -> None:
        source = self.root / item.external_id
        self._ensure_safe_path(source)
        if not source.is_file() or source.is_symlink():
            raise FileNotFoundError(f"Local source item is unavailable: {item.external_id}")
        stat = source.stat(follow_symlinks=False)
        actual_revision = self._revision(stat)
        if actual_revision != expected_revision:
            raise RuntimeError("Local source item revision changed before fetch")
        if stat.st_size > maximum_bytes:
            raise ValueError("Local source item exceeds the configured size limit")
        destination.parent.mkdir(parents=True, exist_ok=True)
        copied = 0
        with source.open("rb") as input_file, destination.open("wb") as output_file:
            while chunk := input_file.read(COPY_CHUNK_SIZE):
                copied += len(chunk)
                if copied > maximum_bytes:
                    raise ValueError("Local source item exceeded the configured size limit during fetch")
                output_file.write(chunk)
        if copied != stat.st_size:
            raise RuntimeError("Local source item size changed during fetch")

    def _scan_root_documents(self) -> Iterator[SourceItemMetadata]:
        with os.scandir(self.root) as entries:
            for entry in sorted(entries, key=lambda value: value.name.casefold()):
                if is_ignored_name(entry.name) or entry.is_symlink():
                    continue
                if entry.is_file(follow_symlinks=False):
                    yield self._file_metadata(entry, entry.name, entry.name, None)

    def _walk_directory(
        self,
        directory: Path,
        source_prefix: str,
        parent_external_id: str | None,
        exclusions: ExclusionPlan,
    ) -> Iterator[SourceItemMetadata]:
        with os.scandir(directory) as entries:
            sorted_entries = sorted(entries, key=lambda value: value.name.casefold())
        for entry in sorted_entries:
            if is_ignored_name(entry.name) or entry.is_symlink():
                continue
            external_id = f"{source_prefix}/{entry.name}"
            relative_path = external_id.split("/", 1)[1]
            if entry.is_dir(follow_symlinks=False):
                metadata = SourceItemMetadata(
                    external_id=external_id,
                    parent_external_id=parent_external_id,
                    item_type="folder",
                    name=entry.name,
                    relative_path=relative_path,
                    fetch_locator=None,
                )
                yield metadata
                if exclusions.excludes(external_id, "folder"):
                    continue
                yield from self._walk_directory(
                    Path(entry.path),
                    external_id,
                    external_id,
                    exclusions,
                )
            elif entry.is_file(follow_symlinks=False):
                yield self._file_metadata(
                    entry,
                    external_id,
                    relative_path,
                    parent_external_id,
                )

    def _file_metadata(
        self,
        entry: os.DirEntry[str],
        external_id: str,
        relative_path: str,
        parent_external_id: str | None,
    ) -> SourceItemMetadata:
        stat = entry.stat(follow_symlinks=False)
        media_type = media_type_for_name(entry.name)
        return SourceItemMetadata(
            external_id=external_id,
            parent_external_id=parent_external_id,
            item_type="document",
            name=entry.name,
            relative_path=relative_path,
            mime_type=mimetypes.guess_type(entry.name)[0] or "application/octet-stream",
            size_bytes=stat.st_size,
            source_revision=self._revision(stat),
            fetch_locator=str(Path(entry.path)),
            media_type=media_type,
            metadata={"mtimeNs": stat.st_mtime_ns},
        )

    @staticmethod
    def _revision(stat: os.stat_result) -> str:
        return f"local:{stat.st_mtime_ns}:{stat.st_size}"

    def _ensure_within_access_root(self, target: Path) -> None:
        try:
            target.relative_to(self.access_root)
        except ValueError as error:
            raise ValueError("Local source root is outside the Local Source Access Root") from error

    def _ensure_safe_path(self, target: Path) -> None:
        self._ensure_within_access_root(target.resolve())
        current = target
        while current != self.access_root:
            if current.is_symlink():
                raise ValueError(f"Local source path contains a symbolic link: {current}")
            if current == self.root:
                break
            current = current.parent
