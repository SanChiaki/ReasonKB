from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import shutil

from services.common.settings import CONVERTED_ROOT, REMOTE_CACHE_ROOT, UPLOAD_ROOT
from services.common.sqlite_store import open_db


MISSING_INDEX_RETENTION_DAYS = 30
AUDIT_RETENTION_DAYS = 180
TEMP_RETENTION_HOURS = 24


class SourceMaintenance:
    def __init__(
        self,
        db_path: str,
        converted_root: Path = CONVERTED_ROOT,
        remote_cache_root: Path = REMOTE_CACHE_ROOT,
    ) -> None:
        self.db_path = db_path
        self.converted_root = Path(converted_root)
        self.remote_cache_root = Path(remote_cache_root)

    def run_once(self, now: datetime | None = None) -> dict[str, int]:
        current = now or datetime.now(timezone.utc)
        purged_sources, purged_document_ids = self._purge_due_sources(current)
        retired_indexes = self._purge_expired_missing_indexes(current)
        audit_events = self._purge_expired_audit_events(current)
        managed_files = self._purge_managed_files(current)
        temporary_paths = self._purge_stale_temporary_paths(current, purged_document_ids)
        return {
            "purged_sources": purged_sources,
            "retired_indexes": retired_indexes,
            "audit_events": audit_events,
            "managed_files": managed_files,
            "temporary_paths": temporary_paths,
        }

    def run_due_purges(self, now: datetime | None = None) -> dict[str, int]:
        current = now or datetime.now(timezone.utc)
        purged_sources, purged_document_ids = self._purge_due_sources(current)
        managed_files = self._purge_managed_files(current)
        temporary_paths = self._purge_stale_temporary_paths(current, purged_document_ids)
        return {
            "purged_sources": purged_sources,
            "managed_files": managed_files,
            "temporary_paths": temporary_paths,
        }

    def _purge_due_sources(self, now: datetime) -> tuple[int, list[str]]:
        now_iso = now.isoformat()
        document_ids: list[str] = []
        with open_db(self.db_path) as conn:
            sources = conn.execute(
                """
                SELECT id FROM corpus_sources
                 WHERE state = 'pending_purge' AND purge_after <= ?
                   AND deleted_at IS NULL
                 ORDER BY purge_after
                """,
                (now_iso,),
            ).fetchall()
            for source in sources:
                source_id = source["id"]
                projects = conn.execute(
                    "SELECT id FROM projects WHERE source_id = ?", (source_id,)
                ).fetchall()
                project_ids = [row["id"] for row in projects]
                documents = conn.execute(
                    "SELECT id FROM documents WHERE source_id = ?", (source_id,)
                ).fetchall()
                source_document_ids = [row["id"] for row in documents]
                document_ids.extend(source_document_ids)
                self._queue_converted_artifacts(conn, source_document_ids, now_iso, "source-purge")
                if project_ids:
                    placeholders = ",".join("?" for _ in project_ids)
                    conn.execute(
                        f"DELETE FROM conversation_projects WHERE project_id IN ({placeholders})",
                        project_ids,
                    )
                if source_document_ids:
                    placeholders = ",".join("?" for _ in source_document_ids)
                    conn.execute(
                        f"DELETE FROM document_index_runs WHERE document_id IN ({placeholders})",
                        source_document_ids,
                    )
                    conn.execute(
                        f"DELETE FROM document_indexes WHERE document_id IN ({placeholders})",
                        source_document_ids,
                    )
                    conn.execute(
                        f"DELETE FROM jobs WHERE document_id IN ({placeholders})",
                        source_document_ids,
                    )
                conn.execute(
                    """
                    UPDATE source_items SET parent_item_id = NULL, document_id = NULL,
                           last_seen_run_id = NULL WHERE source_id = ?
                    """,
                    (source_id,),
                )
                conn.execute("DELETE FROM documents WHERE source_id = ?", (source_id,))
                conn.execute("DELETE FROM projects WHERE source_id = ?", (source_id,))
                conn.execute("DELETE FROM corpus_sources WHERE id = ?", (source_id,))
        return len(sources), document_ids

    def _purge_expired_missing_indexes(self, now: datetime) -> int:
        cutoff = (now - timedelta(days=MISSING_INDEX_RETENTION_DAYS)).isoformat()
        with open_db(self.db_path) as conn:
            rows = conn.execute(
                """
                SELECT d.id FROM documents d
                JOIN document_indexes di ON di.document_id = d.id
                 WHERE d.lifecycle_state = 'missing'
                   AND COALESCE(d.deleted_at, d.updated_at) <= ?
                """,
                (cutoff,),
            ).fetchall()
            document_ids = [row["id"] for row in rows]
            self._queue_converted_artifacts(conn, document_ids, now.isoformat(), "missing-index-retention")
            if document_ids:
                placeholders = ",".join("?" for _ in document_ids)
                conn.execute(
                    f"DELETE FROM document_index_runs WHERE document_id IN ({placeholders})",
                    document_ids,
                )
                conn.execute(
                    f"DELETE FROM document_indexes WHERE document_id IN ({placeholders})",
                    document_ids,
                )
        return len(document_ids)

    def _purge_expired_audit_events(self, now: datetime) -> int:
        cutoff = (now - timedelta(days=AUDIT_RETENTION_DAYS)).isoformat()
        with open_db(self.db_path) as conn:
            return conn.execute(
                "DELETE FROM admin_audit_events WHERE created_at < ?", (cutoff,)
            ).rowcount

    def _queue_converted_artifacts(
        self,
        conn,
        document_ids: list[str],
        now_iso: str,
        reason: str,
    ) -> None:
        for document_id in document_ids:
            for path in self.converted_root.glob(f"{document_id}-*.pdf"):
                conn.execute(
                    """
                    INSERT INTO managed_file_purge_queue (path, reason, created_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(path) DO UPDATE SET reason = excluded.reason,
                      purged_at = NULL, error_summary = NULL
                    """,
                    (str(path.resolve()), reason, now_iso),
                )

    def _purge_managed_files(self, now: datetime) -> int:
        allowed_roots = [
            self.converted_root.resolve(),
            Path(UPLOAD_ROOT).resolve(),
        ]
        purged = 0
        with open_db(self.db_path) as conn:
            rows = conn.execute(
                "SELECT path FROM managed_file_purge_queue WHERE purged_at IS NULL ORDER BY created_at"
            ).fetchall()
            for row in rows:
                path = Path(row["path"]).resolve()
                try:
                    if not any(path.is_relative_to(root) for root in allowed_roots):
                        raise ValueError("Managed purge path is outside an allowed root")
                    if path.exists() and not path.is_file():
                        raise ValueError("Managed purge path is not a file")
                    path.unlink(missing_ok=True)
                    conn.execute(
                        "UPDATE managed_file_purge_queue SET purged_at = ?, error_summary = NULL WHERE path = ?",
                        (now.isoformat(), row["path"]),
                    )
                    purged += 1
                except Exception as error:
                    conn.execute(
                        "UPDATE managed_file_purge_queue SET error_summary = ? WHERE path = ?",
                        (f"{type(error).__name__}: {str(error)[:300]}", row["path"]),
                    )
        return purged

    def _purge_stale_temporary_paths(self, now: datetime, purged_document_ids: list[str]) -> int:
        purged = 0
        for document_id in purged_document_ids:
            path = self.remote_cache_root / document_id
            if path.exists():
                shutil.rmtree(path, ignore_errors=True)
                purged += 1
        cutoff = now.timestamp() - TEMP_RETENTION_HOURS * 60 * 60
        if self.remote_cache_root.exists():
            for path in self.remote_cache_root.iterdir():
                try:
                    if path.stat().st_mtime >= cutoff:
                        continue
                    if path.is_dir():
                        shutil.rmtree(path)
                    else:
                        path.unlink()
                    purged += 1
                except FileNotFoundError:
                    continue
        return purged
