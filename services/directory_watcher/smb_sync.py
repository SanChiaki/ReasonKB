from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from services.common.sqlite_store import open_db
from services.directory_watcher.sync import (
    SourceFile,
    _mark_missing_deleted,
    _mark_missing_projects_deleted,
    _upsert_source_file,
    metadata_fingerprint,
)
from services.remote_corpus.models import RemoteCorpusFile


class RemoteCorpusSource(Protocol):
    def list_files(self) -> list[RemoteCorpusFile]:
        ...


def _source_file_from_remote(remote_file: RemoteCorpusFile) -> SourceFile:
    return SourceFile(
        path=Path(remote_file.source_relative_path),
        project_name=remote_file.project_name,
        source_relative_path=remote_file.source_relative_path,
        project_relative_path=remote_file.project_relative_path,
        media_type=remote_file.media_type,
        mime_type=remote_file.mime_type,
        size=remote_file.size,
        mtime=remote_file.mtime,
        content_hash=metadata_fingerprint(
            remote_file.source_root,
            remote_file.source_relative_path,
            remote_file.mtime,
            remote_file.size,
        ),
        source_kind="smb",
        source_root=remote_file.source_root,
        storage_path=remote_file.locator,
    )


def sync_smb_once(db_path: str, remote_source: RemoteCorpusSource) -> dict[str, int]:
    now = datetime.now(timezone.utc).isoformat()
    summary = {"created": 0, "updated": 0, "unchanged": 0, "deleted": 0, "skipped": 0}
    remote_files = remote_source.list_files()
    source_files = [_source_file_from_remote(remote_file) for remote_file in remote_files]
    seen_paths = {source_file.source_relative_path for source_file in source_files}
    seen_project_names = {source_file.project_name for source_file in source_files}
    source_root = source_files[0].source_root if source_files else getattr(remote_source, "source_root", "")

    with open_db(db_path) as conn:
        for source_file in source_files:
            outcome = _upsert_source_file(conn, Path(source_file.source_root), source_file, now)
            summary[outcome] += 1
        if source_root:
            summary["deleted"] = _mark_missing_deleted(conn, seen_paths, now, "smb", source_root)
            _mark_missing_projects_deleted(conn, seen_project_names, now, "smb", source_root)

    return summary
