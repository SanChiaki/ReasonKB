from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from services.common.settings import DB_PATH, PROJECTS_ROOT
from services.common.sqlite_store import open_db

DEMO_USER_ID = "user_demo"

SUPPORTED_MEDIA_BY_EXTENSION = {
    ".pdf": "pdf",
    ".doc": "office",
    ".docx": "office",
    ".xls": "office",
    ".xlsx": "office",
    ".xlsm": "office",
    ".ppt": "office",
    ".pptx": "office",
    ".md": "markdown",
    ".markdown": "markdown",
    ".txt": "text",
    ".text": "text",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".tif": "image",
    ".tiff": "image",
}

IGNORED_NAMES = {".DS_Store", "Thumbs.db"}


@dataclass
class SourceFile:
    path: Path
    project_name: str
    source_relative_path: str
    project_relative_path: str
    media_type: str
    mime_type: str
    size: int
    mtime: str
    content_hash: str
    source_kind: str = "directory"
    source_root: str = ""
    storage_path: str = ""


def _utc_iso_from_timestamp(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def metadata_fingerprint(source_root: str, source_relative_path: str, mtime: str, size: int) -> str:
    digest = hashlib.sha256()
    digest.update(source_root.encode("utf-8"))
    digest.update(b"\0")
    digest.update(source_relative_path.encode("utf-8"))
    digest.update(b"\0")
    digest.update(mtime.encode("utf-8"))
    digest.update(b"\0")
    digest.update(str(size).encode("utf-8"))
    return f"smb-meta:{digest.hexdigest()}"


def _media_type(path: Path) -> str:
    return SUPPORTED_MEDIA_BY_EXTENSION.get(path.suffix.lower(), "unsupported")


def classify_source_file(root: Path, file_path: Path) -> SourceFile | None:
    relative = file_path.relative_to(root)
    if len(relative.parts) < 2:
        return None
    if any(part.startswith(".") for part in relative.parts):
        return None
    if file_path.name in IGNORED_NAMES:
        return None

    stat = file_path.stat()
    media_type = _media_type(file_path)
    mime_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    return SourceFile(
        path=file_path,
        project_name=relative.parts[0],
        source_relative_path=relative.as_posix(),
        project_relative_path=Path(*relative.parts[1:]).as_posix(),
        media_type=media_type,
        mime_type=mime_type,
        size=stat.st_size,
        mtime=_utc_iso_from_timestamp(stat.st_mtime),
        content_hash=_hash_file(file_path),
        source_root=str(root),
        storage_path=str(file_path),
    )


def _iter_source_files(root: Path) -> list[SourceFile]:
    if not root.exists():
        return []
    source_files: list[SourceFile] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        source_file = classify_source_file(root, path)
        if source_file:
            source_files.append(source_file)
    return source_files


def _iter_project_directory_names(root: Path) -> set[str]:
    if not root.exists():
        return set()
    return {
        path.name
        for path in root.iterdir()
        if path.is_dir() and not path.name.startswith(".") and path.name not in IGNORED_NAMES
    }


def _get_or_create_project(conn: sqlite3.Connection, project_name: str, now: str) -> str:
    row = conn.execute(
        """
        SELECT id
          FROM projects
         WHERE owner_user_id = ?
           AND name = ?
           AND deleted_at IS NULL
         LIMIT 1
        """,
        (DEMO_USER_ID, project_name),
    ).fetchone()
    if row:
        project_id = row["id"]
        conn.execute(
            "UPDATE projects SET updated_at = ? WHERE id = ?",
            (now, project_id),
        )
        return project_id

    project_id = f"proj_{uuid.uuid4()}"
    conn.execute(
        """
        INSERT INTO projects (id, owner_user_id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (project_id, DEMO_USER_ID, project_name, now, now),
    )
    return project_id


def _has_active_index_job(conn: sqlite3.Connection, document_id: str) -> bool:
    row = conn.execute(
        """
        SELECT 1
          FROM jobs
         WHERE document_id = ?
           AND type = 'document_index'
           AND status IN ('queued', 'running')
         LIMIT 1
        """,
        (document_id,),
    ).fetchone()
    return row is not None


def _queue_index_job(conn: sqlite3.Connection, document_id: str, now: str) -> None:
    if _has_active_index_job(conn, document_id):
        return
    job_id = f"job_{uuid.uuid4()}"
    conn.execute(
        """
        INSERT INTO jobs (
          id, type, document_id, payload_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_id,
            "document_index",
            document_id,
            json.dumps({"documentId": document_id}),
            "queued",
            now,
            now,
        ),
    )


def _upsert_source_file(
    conn: sqlite3.Connection,
    root: Path,
    source_file: SourceFile,
    now: str,
) -> str:
    project_id = _get_or_create_project(conn, source_file.project_name, now)
    source_root = source_file.source_root or str(root)
    storage_path = source_file.storage_path or str(source_file.path)
    if source_file.source_kind == "smb":
        existing = conn.execute(
            """
            SELECT id, content_hash, source_mtime, source_size, media_type,
                   import_status, source_root, storage_path
              FROM documents
             WHERE source_kind = ?
               AND source_root = ?
               AND source_relative_path = ?
             LIMIT 1
            """,
            (source_file.source_kind, source_root, source_file.source_relative_path),
        ).fetchone()
    else:
        existing = conn.execute(
            """
            SELECT id, content_hash, source_mtime, source_size, media_type,
                   import_status, source_root, storage_path
              FROM documents
             WHERE source_kind = ?
               AND source_relative_path = ?
             LIMIT 1
            """,
            (source_file.source_kind, source_file.source_relative_path),
        ).fetchone()

    unsupported_reason = (
        f"Unsupported file type: {source_file.path.suffix or 'no extension'}"
        if source_file.media_type == "unsupported"
        else None
    )
    status = "skipped" if unsupported_reason else "uploaded"
    import_status = "skipped" if unsupported_reason else "imported"

    if existing is None:
        document_id = f"doc_{uuid.uuid4()}"
        conn.execute(
            """
            INSERT INTO documents (
              id, project_id, owner_user_id, file_name, storage_path, mime_type,
              file_size, source_kind, source_root, source_relative_path,
              project_relative_path, content_hash, source_mtime, source_size,
              media_type, import_status, import_error, status, created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                document_id,
                project_id,
                DEMO_USER_ID,
                source_file.path.name,
                storage_path,
                source_file.mime_type,
                source_file.size,
                source_file.source_kind,
                source_root,
                source_file.source_relative_path,
                source_file.project_relative_path,
                source_file.content_hash,
                source_file.mtime,
                source_file.size,
                source_file.media_type,
                import_status,
                unsupported_reason,
                status,
                now,
                now,
            ),
        )
        if not unsupported_reason:
            _queue_index_job(conn, document_id, now)
            return "created"
        return "skipped"

    document_id = existing["id"]
    content_hash_changed = (
        source_file.source_kind != "smb"
        and existing["content_hash"] != source_file.content_hash
    )
    content_changed = (
        content_hash_changed
        or existing["source_mtime"] != source_file.mtime
        or existing["source_size"] != source_file.size
        or existing["media_type"] != source_file.media_type
        or existing["import_status"] == "deleted"
    )
    locator_changed = (
        existing["source_root"] != source_root
        or existing["storage_path"] != storage_path
    )
    if not content_changed and not locator_changed:
        return "unchanged"

    conn.execute(
        """
        UPDATE documents
           SET project_id = ?, file_name = ?, storage_path = ?, mime_type = ?,
               file_size = ?, source_root = ?, project_relative_path = ?,
               content_hash = ?, source_mtime = ?, source_size = ?,
               media_type = ?, import_status = ?, import_error = ?,
               status = ?, deleted_at = NULL, updated_at = ?
         WHERE id = ?
        """,
        (
            project_id,
            source_file.path.name,
            storage_path,
            source_file.mime_type,
            source_file.size,
            source_root,
            source_file.project_relative_path,
            source_file.content_hash,
            source_file.mtime,
            source_file.size,
            source_file.media_type,
            import_status,
            unsupported_reason,
            status,
            now,
            document_id,
        ),
    )
    if content_changed and not unsupported_reason:
        _queue_index_job(conn, document_id, now)
        return "updated"
    return "skipped" if unsupported_reason else "updated"


def _mark_missing_deleted(
    conn: sqlite3.Connection,
    seen_paths: set[str],
    now: str,
    source_kind: str = "directory",
    source_root: str | None = None,
) -> int:
    source_root_filter = "" if source_root is None else "AND source_root = ?"
    params: tuple[str, ...] = (source_kind,) if source_root is None else (source_kind, source_root)
    rows = conn.execute(
        f"""
        SELECT id, source_relative_path
          FROM documents
         WHERE source_kind = ?
           {source_root_filter}
           AND deleted_at IS NULL
        """,
        params,
    ).fetchall()
    deleted = 0
    for row in rows:
        if row["source_relative_path"] in seen_paths:
            continue
        conn.execute(
            """
            UPDATE documents
               SET status = 'deleted', import_status = 'deleted',
                   deleted_at = ?, updated_at = ?
             WHERE id = ?
            """,
            (now, now, row["id"]),
        )
        deleted += 1
    return deleted


def _mark_missing_projects_deleted(
    conn: sqlite3.Connection,
    seen_project_names: set[str],
    now: str,
    source_kind: str = "directory",
    source_root: str | None = None,
) -> int:
    if source_root is None:
        exists_source_root_filter = ""
        other_active_filter = "AND d.source_kind <> ?"
        params: tuple[str, ...] = (DEMO_USER_ID, source_kind, source_kind)
    else:
        exists_source_root_filter = "AND d.source_root = ?"
        other_active_filter = "AND NOT (d.source_kind = ? AND d.source_root = ?)"
        params = (DEMO_USER_ID, source_kind, source_root, source_kind, source_root)
    rows = conn.execute(
        f"""
        SELECT p.id, p.name
          FROM projects p
         WHERE p.owner_user_id = ?
           AND p.deleted_at IS NULL
           AND EXISTS (
             SELECT 1
              FROM documents d
             WHERE d.project_id = p.id
                AND d.source_kind = ?
                {exists_source_root_filter}
           )
           AND NOT EXISTS (
             SELECT 1
               FROM documents d
              WHERE d.project_id = p.id
                AND d.deleted_at IS NULL
                {other_active_filter}
           )
        """,
        params,
    ).fetchall()
    deleted = 0
    for row in rows:
        if row["name"] in seen_project_names:
            continue
        conn.execute(
            """
            UPDATE projects
               SET deleted_at = ?, updated_at = ?
             WHERE id = ?
            """,
            (now, now, row["id"]),
        )
        deleted += 1
    return deleted


def sync_once(db_path: str, projects_root: str | Path) -> dict[str, int]:
    root = Path(projects_root).resolve()
    now = datetime.now(timezone.utc).isoformat()
    summary = {"created": 0, "updated": 0, "unchanged": 0, "deleted": 0, "skipped": 0}
    source_files = _iter_source_files(root)
    seen_paths = {source_file.source_relative_path for source_file in source_files}
    seen_project_names = _iter_project_directory_names(root)

    with open_db(db_path) as conn:
        for source_file in source_files:
            outcome = _upsert_source_file(conn, root, source_file, now)
            summary[outcome] += 1
        summary["deleted"] = _mark_missing_deleted(conn, seen_paths, now, "directory")
        _mark_missing_projects_deleted(conn, seen_project_names, now, "directory")

    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--db-path", default=str(DB_PATH))
    parser.add_argument("--projects-root", default=str(PROJECTS_ROOT))
    args = parser.parse_args()

    summary = sync_once(args.db_path, args.projects_root)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
