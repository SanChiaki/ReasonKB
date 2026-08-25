from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path

from services.common.source_credentials import decrypt_source_credentials, load_master_key
from services.common.sqlite_store import open_db
from services.source_worker.connectors.factory import build_connector
from services.source_worker.models import (
    CollectionDescriptor,
    ExclusionPlan,
    SourceAccessDenied,
    SourceItemMetadata,
)

RECONCILE_BATCH_SIZE = 250
OBSERVATION_BATCH_SIZE = 500
MAX_SOURCE_BACKOFF_SECONDS = 6 * 60 * 60


class SyncRunSuperseded(RuntimeError):
    pass


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat()


def stable_item_id(source_id: str, external_id: str) -> str:
    value = uuid.uuid5(uuid.NAMESPACE_URL, f"reasonkb:{source_id}:{external_id}")
    return f"item_{value}"


def jittered_delay_seconds(source_id: str, base_seconds: int, salt: str) -> int:
    digest = hashlib.sha256(f"{source_id}:{salt}".encode("utf-8")).digest()
    jitter = 0.9 + (int.from_bytes(digest[:2], "big") / 65535) * 0.2
    return max(1, round(base_seconds * jitter))


def source_backoff_seconds(source_id: str, interval: int, failures: int) -> int:
    failures = max(1, failures)
    base = min(
        MAX_SOURCE_BACKOFF_SECONDS,
        max(1, interval) * (2 ** min(failures, 10)),
    )
    return min(
        MAX_SOURCE_BACKOFF_SECONDS,
        jittered_delay_seconds(source_id, base, f"failure:{failures}"),
    )


class SourceWorkerEngine:
    def __init__(
        self,
        db_path: str,
        local_access_root: str | Path,
        master_key_path: str | Path | None = None,
        progress_callback: Callable[[], None] | None = None,
    ):
        self.db_path = db_path
        self.local_access_root = Path(local_access_root)
        self.master_key_path = Path(master_key_path) if master_key_path else None
        self.progress_callback = progress_callback

    def _report_progress(self) -> None:
        if self.progress_callback is not None:
            self.progress_callback()

    def recover_abandoned_work(self) -> dict[str, int]:
        now = iso_now()
        error_summary = "RuntimeError: source worker stopped during operation"
        affected_sources: set[str] = set()
        with open_db(self.db_path) as conn:
            sync_runs = conn.execute(
                "SELECT id, source_id FROM sync_runs WHERE status = 'running'"
            ).fetchall()
            discovery_runs = conn.execute(
                "SELECT id, source_id FROM source_discovery_runs WHERE status = 'running'"
            ).fetchall()
            migrations = conn.execute(
                "SELECT id FROM corpus_source_migrations WHERE status IN ('validating', 'syncing', 'applying')"
            ).fetchall()
            affected_sources.update(str(row["source_id"]) for row in sync_runs)
            affected_sources.update(str(row["source_id"]) for row in discovery_runs)
            if sync_runs:
                run_ids = [str(row["id"]) for row in sync_runs]
                placeholders = ",".join("?" for _ in run_ids)
                conn.execute(
                    f"DELETE FROM sync_run_observations WHERE run_id IN ({placeholders})",
                    run_ids,
                )
                conn.execute(
                    f"""
                    UPDATE sync_runs SET status = 'failed', completed_at = ?, error_summary = ?
                     WHERE id IN ({placeholders})
                    """,
                    [now, error_summary, *run_ids],
                )
            if discovery_runs:
                run_ids = [str(row["id"]) for row in discovery_runs]
                placeholders = ",".join("?" for _ in run_ids)
                conn.execute(
                    f"""
                    UPDATE source_discovery_runs
                       SET status = 'failed', completed_at = ?, error_summary = ?
                     WHERE id IN ({placeholders})
                    """,
                    [now, error_summary, *run_ids],
                )
            for migration in migrations:
                self._cancel_migration_in_connection(
                    conn, str(migration["id"]), now, error_summary, failed=True
                )
            collection_validations = conn.execute(
                """
                UPDATE source_collections
                   SET validation_state = 'unvalidated', validation_error = ?, updated_at = ?
                 WHERE validation_state = 'validating'
                """,
                (error_summary, now),
            ).rowcount
            draft_source_validations = conn.execute(
                """
                UPDATE corpus_sources
                   SET state = 'draft', validation_requested_at = ?, updated_at = ?
                 WHERE state = 'validating'
                """,
                (now, now),
            ).rowcount
            active_source_validations = conn.execute(
                """
                UPDATE corpus_sources
                   SET validation_requested_at = ?, updated_at = ?
                 WHERE state = 'active' AND health_state = 'unknown'
                   AND validated_at IS NULL AND validation_requested_at IS NULL
                """,
                (now, now),
            ).rowcount
        for source_id in affected_sources:
            self._fail_source_operation(
                source_id,
                RuntimeError("source worker stopped during operation"),
            )
        return {
            "sync_runs": len(sync_runs),
            "discovery_runs": len(discovery_runs),
            "collection_validations": collection_validations,
            "source_validations": draft_source_validations + active_source_validations,
        }

    def run_once(self) -> dict[str, int]:
        self._report_progress()
        summary = {"validated": 0, "discovered": 0, "synchronized": 0, "migrated": 0, "failed": 0}
        validation = self._claim_validation()
        if validation:
            try:
                self._validate_source(validation)
                summary["validated"] += 1
            except Exception as error:
                self._fail_validation(validation, error)
                summary["failed"] += 1

        collection_validation = self._claim_collection_validation()
        if collection_validation:
            try:
                self._validate_collection(collection_validation)
                summary["validated"] += 1
            except Exception as error:
                self._fail_collection_validation(collection_validation, error)
                summary["failed"] += 1

        migration = self._claim_migration()
        if migration:
            try:
                if self._validate_migration(migration):
                    summary["migrated"] += 1
            except Exception as error:
                self._fail_migration(migration, error)
                summary["failed"] += 1

        due_source = self._claim_due_source()
        if due_source:
            try:
                self._discover_source(due_source)
                summary["discovered"] += 1
            except Exception as error:
                self._fail_source_operation(due_source["id"], error)
                summary["failed"] += 1

        run = self._claim_sync_run()
        if run:
            try:
                if self._scan_and_reconcile(run):
                    summary["synchronized"] += 1
            except Exception as error:
                if self._run_is_current(run):
                    self._fail_sync_run(run, error)
                    summary["failed"] += 1
                else:
                    self._supersede_sync_run(run)
        return summary

    def _claim_migration(self) -> dict[str, object] | None:
        with open_db(self.db_path) as conn:
            row = conn.execute(
                """
                SELECT m.*, s.kind, s.state, s.config_revision,
                       s.max_document_size_bytes
                  FROM corpus_source_migrations m
                  JOIN corpus_sources s ON s.id = m.source_id
                 WHERE m.status = 'requested'
                   AND s.state = 'active' AND s.deleted_at IS NULL
                 ORDER BY m.created_at
                 LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            changed = conn.execute(
                """
                UPDATE corpus_source_migrations
                   SET status = 'validating', started_at = COALESCE(started_at, ?), updated_at = ?
                 WHERE id = ? AND status = 'requested'
                """,
                (iso_now(), iso_now(), row["id"]),
            ).rowcount
            return dict(row) if changed else None

    def _validate_migration(self, migration: dict[str, object]) -> bool:
        connector = self._build_connector(
            {
                **migration,
                "scope_json": migration["target_scope_json"],
                "config_json": migration["target_config_json"],
                "migration_id": migration["id"],
            }
        )
        connector.validate()
        now = iso_now()
        with open_db(self.db_path) as conn:
            current = conn.execute(
                "SELECT config_revision, state FROM corpus_sources WHERE id = ?",
                (migration["source_id"],),
            ).fetchone()
            if (
                current is None
                or current["config_revision"] != migration["source_config_revision"]
                or current["state"] != "active"
            ):
                self._cancel_migration_in_connection(conn, str(migration["id"]), now, "Source configuration changed during migration")
                return False
            blocked = conn.execute(
                """
                SELECT COUNT(*) AS count FROM source_collections
                 WHERE source_id = ? AND selected = 1
                   AND registration_state = 'active' AND validation_state = 'valid'
                   AND lifecycle_state IN ('missing', 'access_revoked')
                   AND deleted_at IS NULL
                """,
                (migration["source_id"],),
            ).fetchone()
            if blocked and int(blocked["count"] or 0) > 0:
                raise RuntimeError("Cannot migrate while a selected Seeyon collection is missing or access-revoked")
            collections = conn.execute(
                """
                SELECT id, filter_revision FROM source_collections
                 WHERE source_id = ? AND selected = 1
                   AND validation_state = 'valid'
                   AND registration_state = 'active'
                   AND lifecycle_state NOT IN ('missing', 'access_revoked')
                   AND deleted_at IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM source_exclusion_rules e
                      WHERE e.collection_id = source_collections.id
                        AND e.target_type = 'collection'
                   )
                 ORDER BY id
                """,
                (migration["source_id"],),
            ).fetchall()
            conn.execute(
                "UPDATE corpus_source_migrations SET status = 'syncing', updated_at = ? WHERE id = ?",
                (now, migration["id"]),
            )
            for collection in collections:
                conn.execute(
                    """
                    INSERT INTO sync_runs (
                      id, source_id, collection_id, migration_id,
                      source_config_revision, collection_filter_revision,
                      trigger_kind, status, started_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'migration', 'queued', ?)
                    """,
                    (
                        f"sync_{uuid.uuid4()}",
                        migration["source_id"],
                        collection["id"],
                        migration["id"],
                        migration["source_config_revision"],
                        collection["filter_revision"],
                        now,
                    ),
                )
            if not collections:
                self._apply_migration_in_connection(conn, migration, now)
                return True
        return False

    def _claim_validation(self) -> dict[str, object] | None:
        with open_db(self.db_path) as conn:
            row = conn.execute(
                """
                SELECT *
                  FROM corpus_sources
                 WHERE validation_requested_at IS NOT NULL
                   AND state NOT IN ('disabled', 'pending_purge')
                   AND deleted_at IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM corpus_source_migrations m
                      WHERE m.source_id = corpus_sources.id
                        AND m.status IN ('requested', 'validating', 'syncing', 'applying')
                   )
                 ORDER BY validation_requested_at
                 LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            changed = conn.execute(
                """
                UPDATE corpus_sources
                   SET state = CASE WHEN state = 'active' THEN 'active' ELSE 'validating' END,
                       validated_at = NULL,
                       validation_requested_at = NULL,
                       updated_at = ?
                 WHERE id = ? AND validation_requested_at IS NOT NULL
                """,
                (iso_now(), row["id"]),
            ).rowcount
            return dict(row) if changed else None

    def _validate_source(self, source: dict[str, object]) -> None:
        connector = self._build_connector(source)
        connector.validate()
        now = iso_now()
        with open_db(self.db_path) as conn:
            current = conn.execute(
                """
                SELECT config_revision, schedule_mode, next_sync_at
                  FROM corpus_sources WHERE id = ?
                """,
                (source["id"],),
            ).fetchone()
            if current is None or current["config_revision"] != source["config_revision"]:
                return
            conn.execute(
                """
                UPDATE corpus_sources
                   SET state = 'active', validated_at = ?, ever_validated_at = ?,
                       health_state = 'normal', consecutive_failure_count = 0,
                       error_summary = NULL, next_sync_at = ?, updated_at = ?
                 WHERE id = ?
                """,
                (
                    now,
                    now,
                    now
                    if current["schedule_mode"] == "scheduled"
                    else current["next_sync_at"],
                    now,
                    source["id"],
                ),
            )

    def _fail_validation(self, source: dict[str, object], error: Exception) -> None:
        now = iso_now()
        summary = self._safe_error(error)
        with open_db(self.db_path) as conn:
            current = conn.execute(
                "SELECT config_revision, ever_validated_at FROM corpus_sources WHERE id = ?",
                (source["id"],),
            ).fetchone()
            if current is None or current["config_revision"] != source["config_revision"]:
                return
            state = "needs_attention" if current["ever_validated_at"] else "draft"
            conn.execute(
                """
                UPDATE corpus_sources
                   SET state = ?, validated_at = NULL,
                       health_state = 'needs_attention', error_summary = ?,
                       next_sync_at = NULL, updated_at = ?
                 WHERE id = ?
                """,
                (state, summary, now, source["id"]),
            )

    def _claim_due_source(self) -> dict[str, object] | None:
        now = iso_now()
        with open_db(self.db_path) as conn:
            row = conn.execute(
                """
                SELECT *
                  FROM corpus_sources
                 WHERE state = 'active'
                   AND (
                     (schedule_mode = 'scheduled'
                       AND (next_sync_at IS NULL OR next_sync_at <= ?))
                     OR
                     (schedule_mode = 'manual'
                       AND next_sync_at IS NOT NULL AND next_sync_at <= ?)
                   )
                   AND deleted_at IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM corpus_source_migrations m
                      WHERE m.source_id = corpus_sources.id
                        AND m.status IN ('requested', 'validating', 'syncing', 'applying')
                   )
                 ORDER BY COALESCE(next_sync_at, created_at)
                 LIMIT 1
                """,
                (now, now),
            ).fetchone()
            if row is None:
                return None
            interval = int(row["sync_interval_seconds"] or 60)
            claimed_at = utc_now()
            delay = jittered_delay_seconds(
                str(row["id"]),
                interval,
                f"schedule:{claimed_at.isoformat()}",
            )
            claimed_until = (claimed_at + timedelta(seconds=delay)).isoformat()
            changed = conn.execute(
                """
                UPDATE corpus_sources
                   SET next_sync_at = ?, updated_at = ?
                 WHERE id = ? AND state = 'active' AND next_sync_at IS ?
                """,
                (claimed_until, now, row["id"], row["next_sync_at"]),
            ).rowcount
            return dict(row) if changed else None

    def _claim_collection_validation(self) -> dict[str, object] | None:
        with open_db(self.db_path) as conn:
            row = conn.execute(
                """
                SELECT c.*, s.kind, s.scope_json, s.config_json, s.config_revision,
                       s.selection_policy
                  FROM source_collections c
                  JOIN corpus_sources s ON s.id = c.source_id
                 WHERE c.origin = 'registered'
                   AND c.registration_state = 'active'
                   AND c.validation_state = 'unvalidated'
                   AND s.state = 'active'
                   AND s.deleted_at IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM corpus_source_migrations m
                      WHERE m.source_id = s.id
                        AND m.status IN ('requested', 'validating', 'syncing', 'applying')
                   )
                 ORDER BY c.created_at
                 LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            changed = conn.execute(
                """
                UPDATE source_collections SET validation_state = 'validating', updated_at = ?
                 WHERE id = ? AND validation_state = 'unvalidated'
                """,
                (iso_now(), row["id"]),
            ).rowcount
            return dict(row) if changed else None

    def _validate_collection(self, collection: dict[str, object]) -> None:
        connector = self._build_connector(collection)
        validator = getattr(connector, "validate_collection", None)
        if validator is None:
            raise RuntimeError("Connector does not support Collection Registration validation")
        descriptor = CollectionDescriptor(
            identity_key=str(collection["identity_key"]),
            external_id=str(collection["external_id"]),
            root_external_id=str(collection["root_external_id"]),
            display_name=str(collection["display_name"]),
        )
        validator(descriptor)
        now = iso_now()
        with open_db(self.db_path) as conn:
            source = conn.execute(
                "SELECT config_revision, selection_policy FROM corpus_sources WHERE id = ?",
                (collection["source_id"],),
            ).fetchone()
            if source is None or source["config_revision"] != collection["config_revision"]:
                conn.execute(
                    "UPDATE source_collections SET validation_state = 'unvalidated' WHERE id = ?",
                    (collection["id"],),
                )
                return
            selected = 1 if source["selection_policy"] == "all" else 0
            collection_excluded = bool(
                conn.execute(
                    """
                    SELECT 1 FROM source_exclusion_rules
                     WHERE collection_id = ? AND target_type = 'collection'
                     LIMIT 1
                    """,
                    (collection["id"],),
                ).fetchone()
            )
            conn.execute(
                """
                UPDATE source_collections SET validation_state = 'valid',
                       validation_error = NULL, selected = ?, lifecycle_state = ?,
                       updated_at = ? WHERE id = ?
                """,
                (
                    selected,
                    "excluded" if collection_excluded else ("pending" if selected else "inactive"),
                    now,
                    collection["id"],
                ),
            )
            if selected:
                self._ensure_project(
                    conn,
                    str(collection["source_id"]),
                    str(collection["id"]),
                    str(collection["display_name"]),
                    now,
                )
            if collection_excluded:
                conn.execute(
                    """
                    UPDATE projects SET lifecycle_state = 'excluded', retrieval_eligible = 0,
                           updated_at = ? WHERE source_collection_id = ?
                    """,
                    (now, collection["id"]),
                )

    def _fail_collection_validation(
        self, collection: dict[str, object], error: Exception
    ) -> None:
        access_denied = isinstance(error, SourceAccessDenied)
        now = iso_now()
        with open_db(self.db_path) as conn:
            conn.execute(
                """
                UPDATE source_collections SET validation_state = 'invalid',
                       validation_error = ?, selected = 0, lifecycle_state = 'inactive',
                       updated_at = ? WHERE id = ?
                """,
                (self._safe_error(error), now, collection["id"]),
            )
            if access_denied:
                conn.execute(
                    """
                    UPDATE corpus_sources SET health_state = 'needs_attention',
                           consecutive_failure_count = consecutive_failure_count + 1,
                           error_summary = ?, updated_at = ? WHERE id = ?
                    """,
                    (self._safe_error(error), now, collection["source_id"]),
                )

    def _discover_source(self, source: dict[str, object]) -> None:
        run_id = f"discovery_{uuid.uuid4()}"
        now = iso_now()
        with open_db(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO source_discovery_runs (
                  id, source_id, source_config_revision, status, started_at
                ) VALUES (?, ?, ?, 'running', ?)
                """,
                (run_id, source["id"], source["config_revision"], now),
            )
            migration = conn.execute(
                """
                SELECT 1 FROM corpus_source_migrations
                 WHERE source_id = ?
                   AND status IN ('requested', 'validating', 'syncing', 'applying')
                 LIMIT 1
                """,
                (source["id"],),
            ).fetchone()
            if migration:
                conn.execute(
                    "UPDATE source_discovery_runs SET status = 'superseded', completed_at = ? WHERE id = ?",
                    (iso_now(), run_id),
                )
                return

        connector = self._build_connector(source)

        count = 0
        for descriptor in connector.discover_collections():
            self._upsert_discovered_collection(source, run_id, descriptor)
            count += 1
            self._report_progress()

        with open_db(self.db_path) as conn:
            current = conn.execute(
                "SELECT config_revision, state, schedule_mode FROM corpus_sources WHERE id = ?",
                (source["id"],),
            ).fetchone()
            if (
                current is None
                or current["config_revision"] != source["config_revision"]
                or current["state"] != "active"
            ):
                conn.execute(
                    "UPDATE source_discovery_runs SET status = 'superseded', completed_at = ? WHERE id = ?",
                    (iso_now(), run_id),
                )
                return
            missing = conn.execute(
                """
                SELECT id FROM source_collections
                 WHERE source_id = ? AND origin = 'discovered'
                   AND registration_state = 'active'
                   AND (last_discovery_run_id IS NULL OR last_discovery_run_id <> ?)
                """,
                (source["id"], run_id),
            ).fetchall()
            for collection in missing:
                conn.execute(
                    "UPDATE source_collections SET lifecycle_state = 'missing', updated_at = ? WHERE id = ?",
                    (iso_now(), collection["id"]),
                )
                conn.execute(
                    """
                    UPDATE projects SET lifecycle_state = 'inactive', retrieval_eligible = 0,
                           updated_at = ? WHERE source_collection_id = ?
                    """,
                    (iso_now(), collection["id"]),
                )
            conn.execute(
                """
                UPDATE source_discovery_runs
                   SET status = 'completed', completed_at = ?, item_count = ?
                 WHERE id = ?
                """,
                (iso_now(), count, run_id),
            )
            if current["schedule_mode"] == "manual":
                conn.execute(
                    "UPDATE corpus_sources SET next_sync_at = NULL, updated_at = ? WHERE id = ?",
                    (iso_now(), source["id"]),
                )
            selected = conn.execute(
                """
                SELECT id FROM source_collections
                 WHERE source_id = ? AND selected = 1
                   AND validation_state = 'valid' AND registration_state = 'active'
                   AND lifecycle_state NOT IN ('missing', 'excluded', 'access_revoked')
                   AND deleted_at IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM source_exclusion_rules e
                      WHERE e.collection_id = source_collections.id
                        AND e.target_type = 'collection'
                   )
                """,
                (source["id"],),
            ).fetchall()
            for collection in selected:
                self._queue_sync_run_in_connection(
                    conn,
                    str(source["id"]),
                    collection["id"],
                    int(source["config_revision"]),
                    "manual" if source["schedule_mode"] == "manual" else "scheduled",
                )

    def _upsert_discovered_collection(
        self,
        source: dict[str, object],
        run_id: str,
        descriptor: CollectionDescriptor,
    ) -> None:
        now = iso_now()
        with open_db(self.db_path) as conn:
            row = conn.execute(
                "SELECT id, selected, lifecycle_state FROM source_collections WHERE source_id = ? AND identity_key = ?",
                (source["id"], descriptor.identity_key),
            ).fetchone()
            selected = 1 if source["selection_policy"] == "all" else (row["selected"] if row else 0)
            collection_excluded = bool(
                row
                and conn.execute(
                    """
                    SELECT 1 FROM source_exclusion_rules
                     WHERE collection_id = ? AND target_type = 'collection'
                     LIMIT 1
                    """,
                    (row["id"],),
                ).fetchone()
            )
            lifecycle = "excluded" if collection_excluded else ("pending" if selected else "inactive")
            if row:
                collection_id = row["id"]
                conn.execute(
                    """
                    UPDATE source_collections
                       SET external_id = ?, root_external_id = ?, display_name = ?,
                           origin = 'discovered', registration_state = 'active',
                           validation_state = 'valid', lifecycle_state = ?, selected = ?,
                           validation_error = NULL, last_discovered_at = ?,
                           last_discovery_run_id = ?, updated_at = ?
                     WHERE id = ?
                    """,
                    (
                        descriptor.external_id,
                        descriptor.root_external_id,
                        descriptor.display_name,
                        lifecycle,
                        selected,
                        now,
                        run_id,
                        now,
                        collection_id,
                    ),
                )
            else:
                collection_id = f"collection_{uuid.uuid4()}"
                conn.execute(
                    """
                    INSERT INTO source_collections (
                      id, source_id, identity_key, external_id, root_external_id,
                      display_name, origin, registration_state, validation_state,
                      lifecycle_state, selected, last_discovered_at,
                      last_discovery_run_id, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'discovered', 'active', 'valid',
                              ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        collection_id,
                        source["id"],
                        descriptor.identity_key,
                        descriptor.external_id,
                        descriptor.root_external_id,
                        descriptor.display_name,
                        lifecycle,
                        selected,
                        now,
                        run_id,
                        now,
                        now,
                    ),
                )
            if selected:
                self._ensure_project(conn, str(source["id"]), collection_id, descriptor.display_name, now)
            if collection_excluded:
                conn.execute(
                    """
                    UPDATE projects SET lifecycle_state = 'excluded', retrieval_eligible = 0,
                           updated_at = ? WHERE source_collection_id = ?
                    """,
                    (now, collection_id),
                )

    def _queue_sync_run_in_connection(
        self,
        conn: sqlite3.Connection,
        source_id: str,
        collection_id: str,
        config_revision: int,
        trigger: str,
    ) -> None:
        collection = conn.execute(
            """
            SELECT c.filter_revision, c.selected, c.lifecycle_state,
                   c.registration_state, c.validation_state, c.deleted_at,
                   s.state, s.config_revision
              FROM source_collections c
              JOIN corpus_sources s ON s.id = c.source_id
             WHERE c.id = ? AND c.source_id = ?
            """,
            (collection_id, source_id),
        ).fetchone()
        if (
            collection is None
            or collection["state"] != "active"
            or int(collection["config_revision"]) != config_revision
            or not collection["selected"]
            or collection["registration_state"] != "active"
            or collection["validation_state"] != "valid"
            or collection["lifecycle_state"] in ("missing", "access_revoked")
            or collection["deleted_at"] is not None
            or conn.execute(
                """
                SELECT 1 FROM corpus_source_migrations
                 WHERE source_id = ?
                   AND status IN ('requested', 'validating', 'syncing', 'applying')
                 LIMIT 1
                """,
                (source_id,),
            ).fetchone()
            or conn.execute(
                """
                SELECT 1 FROM source_exclusion_rules
                 WHERE collection_id = ? AND target_type = 'collection'
                 LIMIT 1
                """,
                (collection_id,),
            ).fetchone()
        ):
            return
        active = conn.execute(
            "SELECT id FROM sync_runs WHERE collection_id = ? AND status IN ('queued', 'running')",
            (collection_id,),
        ).fetchone()
        if active:
            return
        conn.execute(
            """
            INSERT INTO sync_runs (
              id, source_id, collection_id, source_config_revision, collection_filter_revision,
              trigger_kind, status, started_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
            """,
            (
                f"sync_{uuid.uuid4()}",
                source_id,
                collection_id,
                config_revision,
                int(collection["filter_revision"]),
                trigger,
                iso_now(),
            ),
        )

    def _claim_sync_run(self) -> dict[str, object] | None:
        with open_db(self.db_path) as conn:
            stale_runs = conn.execute(
                """
                SELECT r.* FROM sync_runs r
                 WHERE r.status = 'queued'
                   AND NOT EXISTS (
                     SELECT 1
                       FROM source_collections c
                       JOIN corpus_sources s ON s.id = c.source_id
                      WHERE c.id = r.collection_id AND s.id = r.source_id
                        AND s.state = 'active'
                        AND s.config_revision = r.source_config_revision
                        AND c.filter_revision = r.collection_filter_revision
                        AND c.selected = 1
                        AND c.registration_state = 'active'
                        AND c.validation_state = 'valid'
                        AND c.lifecycle_state NOT IN ('missing', 'access_revoked')
                        AND c.deleted_at IS NULL
                        AND (
                          r.migration_id IS NULL OR EXISTS (
                            SELECT 1 FROM corpus_source_migrations m
                             WHERE m.id = r.migration_id AND m.source_id = r.source_id
                               AND m.status = 'syncing'
                          )
                        )
                        AND (
                          r.migration_id IS NOT NULL OR NOT EXISTS (
                            SELECT 1 FROM corpus_source_migrations m
                             WHERE m.source_id = r.source_id
                               AND m.status IN ('requested', 'validating', 'syncing', 'applying')
                          )
                        )
                        AND NOT EXISTS (
                          SELECT 1 FROM source_exclusion_rules e
                           WHERE e.collection_id = c.id AND e.target_type = 'collection'
                        )
                   )
                """
            ).fetchall()
            for stale_run in stale_runs:
                self._supersede_sync_run_in_connection(conn, dict(stale_run), iso_now())
            row = conn.execute(
                """
                SELECT r.*, c.external_id, c.root_external_id, c.display_name,
                       c.identity_key, s.kind,
                       CASE WHEN r.migration_id IS NULL THEN s.scope_json ELSE m.target_scope_json END AS scope_json,
                       CASE WHEN r.migration_id IS NULL THEN s.config_json ELSE m.target_config_json END AS config_json,
                       s.max_document_size_bytes
                  FROM sync_runs r
                  JOIN source_collections c ON c.id = r.collection_id
                  JOIN corpus_sources s ON s.id = r.source_id
                  LEFT JOIN corpus_source_migrations m ON m.id = r.migration_id
                 WHERE r.status = 'queued' AND s.state = 'active' AND c.selected = 1
                   AND s.config_revision = r.source_config_revision
                   AND c.filter_revision = r.collection_filter_revision
                   AND c.registration_state = 'active' AND c.validation_state = 'valid'
                   AND c.lifecycle_state NOT IN ('missing', 'access_revoked')
                   AND c.deleted_at IS NULL
                   AND (
                     (r.migration_id IS NOT NULL AND m.source_id = s.id AND m.status = 'syncing')
                     OR
                     (r.migration_id IS NULL AND NOT EXISTS (
                       SELECT 1 FROM corpus_source_migrations active_migration
                        WHERE active_migration.source_id = r.source_id
                          AND active_migration.status IN ('requested', 'validating', 'syncing', 'applying')
                     ))
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM source_exclusion_rules e
                      WHERE e.collection_id = c.id AND e.target_type = 'collection'
                   )
                 ORDER BY CASE r.trigger_kind WHEN 'manual' THEN 0 ELSE 1 END,
                          r.started_at
                 LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            changed = conn.execute(
                "UPDATE sync_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
                (iso_now(), row["id"]),
            ).rowcount
            return dict(row) if changed else None

    def _scan_and_reconcile(self, run: dict[str, object]) -> bool:
        exclusions = self._load_exclusion_plan(run)
        if exclusions is None or exclusions.collection_excluded:
            self._supersede_sync_run(run)
            return False
        connector = self._build_connector(run)
        collection = CollectionDescriptor(
            identity_key=str(run["identity_key"]),
            external_id=str(run["external_id"]),
            root_external_id=run["root_external_id"] and str(run["root_external_id"]),
            display_name=str(run["display_name"]),
        )
        count = 0
        observations: list[SourceItemMetadata] = []
        for item in connector.scan_collection(collection, exclusions):
            observations.append(item)
            count += 1
            if len(observations) >= OBSERVATION_BATCH_SIZE:
                self._store_observations(str(run["id"]), observations)
                observations.clear()
                self._report_progress()
        if observations:
            self._store_observations(str(run["id"]), observations)

        if not self._run_is_current(run):
            self._supersede_sync_run(run)
            return False

        if run.get("migration_id"):
            with open_db(self.db_path) as conn:
                conn.execute(
                    """
                    UPDATE sync_runs SET status = 'scanned', seen_item_count = ?,
                           completed_at = ?
                     WHERE id = ? AND status = 'running'
                    """,
                    (count, iso_now(), run["id"]),
                )
            self._maybe_apply_migration(str(run["migration_id"]))
            return True

        changed = 0
        try:
            while True:
                batch_changed, reconciled = self._reconcile_pending_batch(run, exclusions)
                if not reconciled:
                    break
                changed += batch_changed
                self._report_progress()
        except SyncRunSuperseded:
            self._supersede_sync_run(run)
            return False

        return self._complete_sync_run(run, count, changed)

    def _maybe_apply_migration(self, migration_id: str) -> bool:
        now = iso_now()
        with open_db(self.db_path) as conn:
            migration_row = conn.execute(
                "SELECT * FROM corpus_source_migrations WHERE id = ?",
                (migration_id,),
            ).fetchone()
            if migration_row is None or migration_row["status"] != "syncing":
                return False
            runs = conn.execute(
                "SELECT status FROM sync_runs WHERE migration_id = ?",
                (migration_id,),
            ).fetchall()
            if not runs or any(row["status"] != "scanned" for row in runs):
                return False
            self._apply_migration_in_connection(conn, dict(migration_row), now)
            return True

    def _apply_migration_in_connection(
        self,
        conn: sqlite3.Connection,
        migration: dict[str, object],
        now: str,
    ) -> None:
        conn.execute(
            "UPDATE corpus_source_migrations SET status = 'applying', updated_at = ? WHERE id = ?",
            (now, migration["id"]),
        )
        runs = conn.execute(
            """
            SELECT r.*, c.external_id, c.root_external_id, c.display_name, c.identity_key,
                   s.kind, m.target_scope_json AS scope_json,
                   m.target_config_json AS config_json, s.max_document_size_bytes
              FROM sync_runs r
              JOIN source_collections c ON c.id = r.collection_id
              JOIN corpus_sources s ON s.id = r.source_id
              JOIN corpus_source_migrations m ON m.id = r.migration_id
             WHERE r.migration_id = ? AND r.status = 'scanned'
             ORDER BY r.id
            """,
            (migration["id"],),
        ).fetchall()
        for raw_run in runs:
            run = dict(raw_run)
            exclusions = self._exclusion_plan_in_connection(conn, str(run["collection_id"]))
            observations = conn.execute(
                """
                SELECT * FROM sync_run_observations
                 WHERE run_id = ? ORDER BY CASE item_type WHEN 'folder' THEN 0 ELSE 1 END, external_id
                """,
                (run["id"],),
            ).fetchall()
            run_changed = 0
            for observation in observations:
                run_changed += self._reconcile_observation_in_connection(
                    conn, run, dict(observation), exclusions, preserve_index=True
                )
            missing_rows = conn.execute(
                """
                SELECT id FROM source_items
                 WHERE collection_id = ? AND deleted_at IS NULL
                   AND (last_seen_run_id IS NULL OR last_seen_run_id <> ?)
                   AND lifecycle_state <> 'missing'
                """,
                (run["collection_id"], run["id"]),
            ).fetchall()
            conn.execute(
                """
                UPDATE documents SET lifecycle_state = 'missing', retrieval_eligible = 0,
                       status = 'deleted', deleted_at = ?, updated_at = ?
                 WHERE source_item_id IN (
                   SELECT id FROM source_items
                    WHERE collection_id = ? AND deleted_at IS NULL
                      AND (last_seen_run_id IS NULL OR last_seen_run_id <> ?)
                      AND lifecycle_state <> 'missing'
                 )
                """,
                (now, now, run["collection_id"], run["id"]),
            )
            conn.execute(
                """
                UPDATE source_items SET lifecycle_state = 'missing', updated_at = ?
                 WHERE collection_id = ? AND deleted_at IS NULL
                   AND (last_seen_run_id IS NULL OR last_seen_run_id <> ?)
                   AND lifecycle_state <> 'missing'
                """,
                (now, run["collection_id"], run["id"]),
            )
            conn.execute(
                """
                UPDATE projects SET lifecycle_state = 'active', retrieval_eligible = 1,
                       deleted_at = NULL, updated_at = ? WHERE source_collection_id = ?
                """,
                (now, run["collection_id"]),
            )
            conn.execute(
                """
                UPDATE sync_runs SET status = 'completed', completed_at = ?,
                       seen_item_count = ?, changed_item_count = ?,
                       missing_item_count = ?
                 WHERE id = ?
                """,
                (now, len(observations), run_changed, len(missing_rows), run["id"]),
            )
            conn.execute("DELETE FROM sync_run_observations WHERE run_id = ?", (run["id"],))

        source = conn.execute(
            "SELECT config_revision, schedule_mode FROM corpus_sources WHERE id = ?",
            (migration["source_id"],),
        ).fetchone()
        if source is None or source["config_revision"] != migration["source_config_revision"]:
            raise RuntimeError("Source configuration changed during Seeyon URL migration")
        next_revision = int(source["config_revision"]) + 1
        next_sync_at = now if source["schedule_mode"] == "scheduled" else None
        conn.execute(
            """
            UPDATE corpus_sources
               SET scope_json = ?, config_json = ?, config_revision = ?,
                   validated_at = ?, ever_validated_at = COALESCE(ever_validated_at, ?),
                   health_state = 'normal', consecutive_failure_count = 0,
                   error_summary = NULL, next_sync_at = ?, updated_at = ?
             WHERE id = ?
            """,
            (
                migration["target_scope_json"],
                migration["target_config_json"],
                next_revision,
                now,
                now,
                next_sync_at,
                now,
                migration["source_id"],
            ),
        )
        conn.execute(
            """
            UPDATE source_credentials SET encrypted_payload = ?, updated_at = ?
             WHERE source_id = ?
            """,
            (migration["encrypted_credentials"], now, migration["source_id"]),
        )
        conn.execute(
            "UPDATE documents SET expected_source_config_revision = ? WHERE source_id = ?",
            (next_revision, migration["source_id"]),
        )
        conn.execute(
            "UPDATE jobs SET expected_source_config_revision = ?, migration_id = NULL WHERE source_id = ? AND status = 'queued'",
            (next_revision, migration["source_id"]),
        )
        conn.execute(
            "UPDATE corpus_source_migrations SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
            (now, now, migration["id"]),
        )
        conn.execute(
            """
            INSERT INTO admin_audit_events (
              id, action, target_type, target_id, outcome, after_json, created_at
            ) VALUES (?, 'source.migration.completed', 'corpus_source', ?, 'success', ?, ?)
            """,
            (
                f"audit_{uuid.uuid4()}",
                migration["source_id"],
                json.dumps({"migrationId": migration["id"], "configRevision": next_revision}),
                now,
            ),
        )

    @staticmethod
    def _exclusion_plan_in_connection(
        conn: sqlite3.Connection, collection_id: str
    ) -> ExclusionPlan:
        rows = conn.execute(
            "SELECT target_type, target_external_id FROM source_exclusion_rules WHERE collection_id = ?",
            (collection_id,),
        ).fetchall()
        return ExclusionPlan(
            collection_excluded=any(row["target_type"] == "collection" for row in rows),
            folder_external_ids=frozenset(
                str(row["target_external_id"]) for row in rows if row["target_type"] == "folder"
            ),
            document_external_ids=frozenset(
                str(row["target_external_id"])
                for row in rows if row["target_type"] == "document"
            ),
        )

    def _fail_migration(self, migration: dict[str, object], error: Exception) -> None:
        now = iso_now()
        summary = self._safe_error(error)
        with open_db(self.db_path) as conn:
            self._cancel_migration_in_connection(conn, str(migration["id"]), now, summary, failed=True)

    @staticmethod
    def _cancel_migration_in_connection(
        conn: sqlite3.Connection,
        migration_id: str,
        now: str,
        summary: str,
        *,
        failed: bool = False,
    ) -> None:
        status = "failed" if failed else "cancelled"
        source = conn.execute(
            "SELECT source_id FROM corpus_source_migrations WHERE id = ?",
            (migration_id,),
        ).fetchone()
        conn.execute(
            "UPDATE corpus_source_migrations SET status = ?, error_summary = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')",
            (status, summary, now, now, migration_id),
        )
        conn.execute(
            "UPDATE sync_runs SET status = 'superseded', completed_at = ?, error_summary = ? WHERE migration_id = ? AND status IN ('queued', 'running', 'scanned')",
            (now, summary, migration_id),
        )
        conn.execute(
            "DELETE FROM sync_run_observations WHERE run_id IN (SELECT id FROM sync_runs WHERE migration_id = ?)",
            (migration_id,),
        )
        if source:
            conn.execute(
                "UPDATE corpus_sources SET next_sync_at = ?, updated_at = ? WHERE id = ? AND state = 'active'",
                (now, now, source["source_id"]),
            )

    def _load_exclusion_plan(self, run: dict[str, object]) -> ExclusionPlan | None:
        with open_db(self.db_path) as conn:
            if not self._run_is_current_in_connection(conn, run):
                return None
            rows = conn.execute(
                """
                SELECT target_type, target_external_id
                  FROM source_exclusion_rules
                 WHERE collection_id = ?
                """,
                (run["collection_id"],),
            ).fetchall()
        return ExclusionPlan(
            collection_excluded=any(row["target_type"] == "collection" for row in rows),
            folder_external_ids=frozenset(
                str(row["target_external_id"])
                for row in rows
                if row["target_type"] == "folder"
            ),
            document_external_ids=frozenset(
                str(row["target_external_id"])
                for row in rows
                if row["target_type"] == "document"
            ),
        )

    def _store_observations(
        self,
        run_id: str,
        items: list[SourceItemMetadata],
    ) -> None:
        observed_at = iso_now()
        with open_db(self.db_path) as conn:
            conn.executemany(
                """
                INSERT INTO sync_run_observations (
                  run_id, external_id, parent_external_id, item_type, name,
                  relative_path, mime_type, size_bytes, source_revision,
                  fetch_locator, media_type, metadata_json, observed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id, external_id) DO UPDATE SET
                  parent_external_id = excluded.parent_external_id,
                  item_type = excluded.item_type, name = excluded.name,
                  relative_path = excluded.relative_path, mime_type = excluded.mime_type,
                  size_bytes = excluded.size_bytes,
                  source_revision = excluded.source_revision,
                  fetch_locator = excluded.fetch_locator, media_type = excluded.media_type,
                  metadata_json = excluded.metadata_json,
                  observed_at = excluded.observed_at
                """,
                [
                    (
                        run_id,
                        item.external_id,
                        item.parent_external_id,
                        item.item_type,
                        item.name,
                        item.relative_path,
                        item.mime_type,
                        item.size_bytes,
                        item.source_revision,
                        item.fetch_locator,
                        item.media_type,
                        json.dumps(item.metadata, ensure_ascii=False),
                        observed_at,
                    )
                    for item in items
                ],
            )

    def _run_is_current(self, run: dict[str, object]) -> bool:
        with open_db(self.db_path) as conn:
            return self._run_is_current_in_connection(conn, run)

    def _reconcile_pending_batch(
        self,
        run: dict[str, object],
        exclusions: ExclusionPlan,
    ) -> tuple[int, bool]:
        with open_db(self.db_path) as conn:
            if not self._run_is_current_in_connection(conn, run):
                raise SyncRunSuperseded("Sync Run was superseded during reconciliation")
            rows = conn.execute(
                """
                SELECT * FROM sync_run_observations
                 WHERE run_id = ? AND reconciled_at IS NULL
                 ORDER BY CASE item_type WHEN 'folder' THEN 0 ELSE 1 END, external_id
                 LIMIT ?
                """,
                (run["id"], RECONCILE_BATCH_SIZE),
            ).fetchall()
            if not rows:
                return 0, False
            changed = 0
            for row in rows:
                changed += self._reconcile_observation_in_connection(
                    conn,
                    run,
                    dict(row),
                    exclusions,
                )
            return changed, True

    def _reconcile_observation_in_connection(
        self,
        conn: sqlite3.Connection,
        run: dict[str, object],
        observation: dict[str, object],
        exclusions: ExclusionPlan,
        *,
        preserve_index: bool = False,
    ) -> int:
        now = iso_now()
        parent_id = None
        if observation["parent_external_id"]:
            parent = conn.execute(
                "SELECT id FROM source_items WHERE source_id = ? AND external_id = ?",
                (run["source_id"], observation["parent_external_id"]),
            ).fetchone()
            parent_id = parent["id"] if parent else None
        existing = conn.execute(
            "SELECT * FROM source_items WHERE source_id = ? AND external_id = ?",
            (run["source_id"], observation["external_id"]),
        ).fetchone()
        item_id = existing["id"] if existing else stable_item_id(
            str(run["source_id"]), str(observation["external_id"])
        )
        lifecycle = self._item_lifecycle(run, observation, exclusions)
        if existing:
            conn.execute(
                """
                UPDATE source_items
                   SET collection_id = ?, parent_item_id = ?, item_type = ?,
                       name = ?, relative_path = ?, mime_type = ?, size_bytes = ?,
                       source_revision = ?, fetch_locator = ?, lifecycle_state = ?,
                       metadata_json = ?, last_seen_run_id = ?, deleted_at = NULL,
                       updated_at = ?
                 WHERE id = ?
                """,
                (
                    run["collection_id"],
                    parent_id,
                    observation["item_type"],
                    observation["name"],
                    observation["relative_path"],
                    observation["mime_type"],
                    observation["size_bytes"],
                    observation["source_revision"],
                    observation["fetch_locator"],
                    lifecycle,
                    observation["metadata_json"],
                    run["id"],
                    now,
                    item_id,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO source_items (
                  id, source_id, collection_id, external_id, parent_item_id,
                  item_type, name, relative_path, mime_type, size_bytes,
                  source_revision, fetch_locator, lifecycle_state, metadata_json,
                  last_seen_run_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item_id,
                    run["source_id"],
                    run["collection_id"],
                    observation["external_id"],
                    parent_id,
                    observation["item_type"],
                    observation["name"],
                    observation["relative_path"],
                    observation["mime_type"],
                    observation["size_bytes"],
                    observation["source_revision"],
                    observation["fetch_locator"],
                    lifecycle,
                    observation["metadata_json"],
                    run["id"],
                    now,
                    now,
                ),
            )
        changed = 0
        if observation["item_type"] == "document":
            changed = self._reconcile_document(
                conn, run, observation, item_id, lifecycle, now, preserve_index=preserve_index
            )
        elif lifecycle == "excluded":
            self._exclude_known_descendants(conn, run, item_id, now)
        conn.execute(
            "UPDATE sync_run_observations SET reconciled_at = ? WHERE run_id = ? AND external_id = ?",
            (now, run["id"], observation["external_id"]),
        )
        return changed

    def _item_lifecycle(
        self,
        run: dict[str, object],
        observation: dict[str, object],
        exclusions: ExclusionPlan,
    ) -> str:
        if exclusions.excludes(str(observation["external_id"]), str(observation["item_type"])):
            return "excluded"
        if observation["item_type"] != "document":
            return "active"
        if observation["media_type"] == "unsupported":
            return "unsupported"
        size = int(observation["size_bytes"] or 0)
        if size > int(run["max_document_size_bytes"]):
            return "oversized"
        return "active"

    @staticmethod
    def _exclude_known_descendants(
        conn: sqlite3.Connection,
        run: dict[str, object],
        folder_item_id: str,
        now: str,
    ) -> None:
        conn.execute(
            """
            WITH RECURSIVE descendants(id) AS (
              SELECT id FROM source_items
               WHERE parent_item_id = ? AND deleted_at IS NULL
              UNION ALL
              SELECT child.id
                FROM source_items child
                JOIN descendants parent ON child.parent_item_id = parent.id
               WHERE child.deleted_at IS NULL
            )
            UPDATE source_items
               SET lifecycle_state = 'excluded', last_seen_run_id = ?,
                   updated_at = ?
             WHERE id IN (SELECT id FROM descendants)
            """,
            (folder_item_id, run["id"], now),
        )
        conn.execute(
            """
            WITH RECURSIVE descendants(id) AS (
              SELECT id FROM source_items
               WHERE parent_item_id = ? AND deleted_at IS NULL
              UNION ALL
              SELECT child.id
                FROM source_items child
                JOIN descendants parent ON child.parent_item_id = parent.id
               WHERE child.deleted_at IS NULL
            )
            UPDATE documents
               SET lifecycle_state = 'excluded', retrieval_eligible = 0,
                   last_seen_run_id = ?, updated_at = ?
             WHERE source_item_id IN (SELECT id FROM descendants)
               AND deleted_at IS NULL
            """,
            (folder_item_id, run["id"], now),
        )
        conn.execute(
            """
            WITH RECURSIVE descendants(id) AS (
              SELECT id FROM source_items
               WHERE parent_item_id = ? AND deleted_at IS NULL
              UNION ALL
              SELECT child.id
                FROM source_items child
                JOIN descendants parent ON child.parent_item_id = parent.id
               WHERE child.deleted_at IS NULL
            )
            UPDATE jobs
               SET status = 'superseded', superseded_at = ?, updated_at = ?,
                   finished_at = ?, error_message = 'Document excluded by source rule'
             WHERE status = 'queued'
               AND document_id IN (
                 SELECT document_id FROM source_items
                  WHERE id IN (SELECT id FROM descendants) AND document_id IS NOT NULL
               )
            """,
            (folder_item_id, now, now, now),
        )

    def _reconcile_document(
        self,
        conn: sqlite3.Connection,
        run: dict[str, object],
        observation: dict[str, object],
        item_id: str,
        lifecycle: str,
        now: str,
        *,
        preserve_index: bool = False,
    ) -> int:
        project = conn.execute(
            "SELECT id FROM projects WHERE source_collection_id = ?",
            (run["collection_id"],),
        ).fetchone()
        if project is None:
            raise RuntimeError("Selected Source Collection has no Project")
        existing = conn.execute(
            "SELECT * FROM documents WHERE source_id = ? AND source_item_external_id = ?",
            (run["source_id"], observation["external_id"]),
        ).fetchone()
        revision_changed = existing is None or existing["source_revision"] != observation["source_revision"]
        document_id = existing["id"] if existing else f"doc_{uuid.uuid4()}"
        supported = lifecycle == "active"
        metadata = json.loads(str(observation["metadata_json"]))
        if lifecycle == "excluded" and existing:
            status = str(existing["status"])
            import_status = str(existing["import_status"])
            import_error = existing["import_error"]
        else:
            status = "uploaded" if supported else "skipped"
            import_status = "imported" if supported else "skipped"
            import_error = None
            if lifecycle == "unsupported":
                import_error = metadata.get("unsupportedReason") or "Unsupported file type"
            elif lifecycle == "oversized":
                import_error = "Document exceeds the configured size limit"
            elif lifecycle == "excluded":
                import_error = "Document excluded by source rule"
        if existing:
            current_index = conn.execute(
                """
                SELECT source_revision FROM document_indexes
                 WHERE document_id = ? AND is_current = 1
                 ORDER BY indexed_at DESC LIMIT 1
                """,
                (document_id,),
            ).fetchone()
            index_matches_revision = bool(
                current_index
                and (
                    current_index["source_revision"] == observation["source_revision"]
                    or (current_index["source_revision"] is None and not revision_changed)
                )
            )
            if supported and index_matches_revision:
                status = "ready"
            elif supported and not revision_changed and existing["status"] == "failed":
                status = "failed"
            conn.execute(
                """
                UPDATE documents
                   SET project_id = ?, file_name = ?, storage_path = ?, mime_type = ?,
                       file_size = ?, status = ?, error_message = NULL,
                       source_root = ?, source_relative_path = ?, project_relative_path = ?,
                       source_mtime = ?, source_size = ?, media_type = ?,
                       import_status = ?, import_error = ?, source_collection_id = ?,
                       source_item_id = ?, source_revision = ?,
                       expected_source_revision = ?, expected_source_config_revision = ?,
                       lifecycle_state = ?, retrieval_eligible = ?, last_seen_run_id = ?,
                       deleted_at = NULL, updated_at = ?
                 WHERE id = ?
                """,
                (
                    project["id"],
                    observation["name"],
                    observation["fetch_locator"] or "",
                    observation["mime_type"] or "application/octet-stream",
                    observation["size_bytes"] or 0,
                    status,
                    json.loads(str(run["scope_json"])).get("rootPath", ""),
                    observation["external_id"],
                    observation["relative_path"],
                    metadata.get("mtimeNs"),
                    observation["size_bytes"],
                    observation["media_type"] or "unsupported",
                    import_status,
                    import_error,
                    run["collection_id"],
                    item_id,
                    observation["source_revision"],
                    observation["source_revision"],
                    run["source_config_revision"],
                    lifecycle,
                    1 if supported and status == "ready" else 0,
                    run["id"],
                    now,
                    document_id,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO documents (
                  id, project_id, owner_user_id, file_name, storage_path, mime_type,
                  file_size, status, source_kind, source_root, source_relative_path,
                  project_relative_path, source_size, media_type, import_status,
                  import_error, source_id, source_collection_id, source_item_id,
                  source_item_external_id, source_revision, expected_source_revision,
                  expected_source_config_revision, lifecycle_state, retrieval_eligible,
                  last_seen_run_id, created_at, updated_at
                ) VALUES (?, ?, 'deployment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                          ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
                """,
                (
                    document_id,
                    project["id"],
                    observation["name"],
                    observation["fetch_locator"] or "",
                    observation["mime_type"] or "application/octet-stream",
                    observation["size_bytes"] or 0,
                    status,
                    "directory" if run["kind"] == "local" else run["kind"],
                    json.loads(str(run["scope_json"])).get("rootPath", ""),
                    observation["external_id"],
                    observation["relative_path"],
                    observation["size_bytes"],
                    observation["media_type"] or "unsupported",
                    import_status,
                    import_error,
                    run["source_id"],
                    run["collection_id"],
                    item_id,
                    observation["external_id"],
                    observation["source_revision"],
                    observation["source_revision"],
                    run["source_config_revision"],
                    lifecycle,
                    run["id"],
                    now,
                    now,
                ),
            )
            conn.execute("UPDATE source_items SET document_id = ? WHERE id = ?", (document_id, item_id))
        if supported and existing and not index_matches_revision and not preserve_index:
            conn.execute(
                "UPDATE document_indexes SET is_current = 0, retired_at = ? WHERE document_id = ?",
                (now, document_id),
            )
        if lifecycle == "excluded":
            conn.execute(
                """
                UPDATE jobs SET status = 'superseded', superseded_at = ?, updated_at = ?,
                       finished_at = ?, error_message = 'Document excluded by source rule'
                 WHERE document_id = ? AND status = 'queued'
                """,
                (now, now, now, document_id),
            )
        if supported and status == "uploaded":
            self._queue_index_job(conn, run, document_id, str(observation["source_revision"]), now)
        return 1 if revision_changed else 0

    def _queue_index_job(
        self,
        conn: sqlite3.Connection,
        run: dict[str, object],
        document_id: str,
        revision: str,
        now: str,
    ) -> None:
        active = conn.execute(
            """
            SELECT 1 FROM jobs
             WHERE document_id = ? AND expected_source_revision = ?
               AND status IN ('queued', 'running')
            """,
            (document_id, revision),
        ).fetchone()
        if active:
            return
        had_index = conn.execute(
            "SELECT 1 FROM document_indexes WHERE document_id = ?",
            (document_id,),
        ).fetchone()
        priority = 100 if had_index else 200
        conn.execute(
            """
            INSERT INTO jobs (
              id, type, document_id, payload_json, status, source_id,
              source_collection_id, migration_id, expected_source_revision,
              expected_source_config_revision, priority, available_at,
              max_attempts, created_at, updated_at
            ) VALUES (?, 'document_index', ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, 6, ?, ?)
            """,
            (
                f"job_{uuid.uuid4()}",
                document_id,
                json.dumps({"documentId": document_id, "expectedSourceRevision": revision}),
                run["source_id"],
                run["collection_id"],
                run.get("migration_id"),
                revision,
                run["source_config_revision"],
                priority,
                now,
                now,
                now,
            ),
        )

    def _complete_sync_run(self, run: dict[str, object], count: int, changed: int) -> bool:
        now = iso_now()
        with open_db(self.db_path) as conn:
            if not self._run_is_current_in_connection(conn, run):
                self._supersede_sync_run_in_connection(conn, run, now)
                return False
            missing_count = conn.execute(
                """
                SELECT COUNT(*) FROM source_items
                 WHERE collection_id = ? AND deleted_at IS NULL
                   AND (last_seen_run_id IS NULL OR last_seen_run_id <> ?)
                   AND lifecycle_state <> 'missing'
                """,
                (run["collection_id"], run["id"]),
            ).fetchone()[0]
            conn.execute(
                """
                UPDATE documents SET lifecycle_state = 'missing', retrieval_eligible = 0,
                       status = 'deleted', deleted_at = ?, updated_at = ?
                 WHERE source_item_id IN (
                   SELECT id FROM source_items
                    WHERE collection_id = ? AND deleted_at IS NULL
                      AND (last_seen_run_id IS NULL OR last_seen_run_id <> ?)
                      AND lifecycle_state <> 'missing'
                 )
                """,
                (now, now, run["collection_id"], run["id"]),
            )
            conn.execute(
                """
                UPDATE source_items SET lifecycle_state = 'missing', updated_at = ?
                 WHERE collection_id = ? AND deleted_at IS NULL
                   AND (last_seen_run_id IS NULL OR last_seen_run_id <> ?)
                   AND lifecycle_state <> 'missing'
                """,
                (now, run["collection_id"], run["id"]),
            )
            conn.execute(
                """
                UPDATE projects SET lifecycle_state = 'active', retrieval_eligible = 1,
                       deleted_at = NULL, updated_at = ? WHERE source_collection_id = ?
                """,
                (now, run["collection_id"]),
            )
            conn.execute(
                "UPDATE source_collections SET lifecycle_state = 'active', updated_at = ? WHERE id = ?",
                (now, run["collection_id"]),
            )
            follow_up = conn.execute(
                "SELECT follow_up_requested FROM sync_runs WHERE id = ?", (run["id"],)
            ).fetchone()["follow_up_requested"]
            conn.execute(
                """
                UPDATE sync_runs SET status = 'completed', completed_at = ?,
                       seen_item_count = ?, changed_item_count = ?, missing_item_count = ?
                 WHERE id = ?
                """,
                (now, count, changed, missing_count, run["id"]),
            )
            conn.execute("DELETE FROM sync_run_observations WHERE run_id = ?", (run["id"],))
            conn.execute(
                """
                UPDATE corpus_sources SET health_state = 'normal',
                       consecutive_failure_count = 0, last_success_at = ?,
                       error_summary = NULL, updated_at = ? WHERE id = ?
                """,
                (now, now, run["source_id"]),
            )
            if follow_up:
                self._queue_sync_run_in_connection(
                    conn,
                    str(run["source_id"]),
                    str(run["collection_id"]),
                    int(run["source_config_revision"]),
                    "manual",
                )
        return True

    def _supersede_sync_run(self, run: dict[str, object]) -> None:
        with open_db(self.db_path) as conn:
            self._supersede_sync_run_in_connection(conn, run, iso_now())

    def _supersede_sync_run_in_connection(
        self,
        conn: sqlite3.Connection,
        run: dict[str, object],
        now: str,
    ) -> None:
        conn.execute(
            """
            UPDATE sync_runs SET status = 'superseded', completed_at = ?,
                   error_summary = NULL
             WHERE id = ? AND status IN ('queued', 'running')
            """,
            (now, run["id"]),
        )
        conn.execute("DELETE FROM sync_run_observations WHERE run_id = ?", (run["id"],))
        current = conn.execute(
            """
            SELECT s.config_revision, s.state, c.filter_revision, c.selected,
                   c.lifecycle_state, c.registration_state, c.validation_state,
                   c.deleted_at
              FROM corpus_sources s
              JOIN source_collections c ON c.source_id = s.id
             WHERE s.id = ? AND c.id = ?
            """,
            (run["source_id"], run["collection_id"]),
        ).fetchone()
        if current is None:
            return
        filter_changed = (
            int(current["config_revision"]) == int(run["source_config_revision"])
            and int(current["filter_revision"]) != int(run["collection_filter_revision"])
        )
        collection_excluded = conn.execute(
            """
            SELECT 1 FROM source_exclusion_rules
             WHERE collection_id = ? AND target_type = 'collection'
             LIMIT 1
            """,
            (run["collection_id"],),
        ).fetchone()
        eligible = (
            current["state"] == "active"
            and current["selected"]
            and current["registration_state"] == "active"
            and current["validation_state"] == "valid"
            and current["lifecycle_state"] not in ("missing", "access_revoked")
            and current["deleted_at"] is None
            and not collection_excluded
        )
        if filter_changed and eligible:
            self._queue_sync_run_in_connection(
                conn,
                str(run["source_id"]),
                str(run["collection_id"]),
                int(current["config_revision"]),
                str(run.get("trigger_kind") or "manual"),
            )

    def _fail_sync_run(self, run: dict[str, object], error: Exception) -> None:
        now = iso_now()
        summary = self._safe_error(error)
        with open_db(self.db_path) as conn:
            if run.get("migration_id"):
                conn.execute(
                    "UPDATE sync_runs SET status = 'failed', completed_at = ?, error_summary = ? WHERE id = ?",
                    (now, summary, run["id"]),
                )
                self._cancel_migration_in_connection(
                    conn, str(run["migration_id"]), now, summary, failed=True
                )
                return
            conn.execute(
                "UPDATE sync_runs SET status = 'failed', completed_at = ?, error_summary = ? WHERE id = ?",
                (now, summary, run["id"]),
            )
            conn.execute("DELETE FROM sync_run_observations WHERE run_id = ?", (run["id"],))
            row = conn.execute(
                """
                SELECT consecutive_failure_count, schedule_mode, sync_interval_seconds
                  FROM corpus_sources WHERE id = ?
                """,
                (run["source_id"],),
            ).fetchone()
            failures = int(row["consecutive_failure_count"] if row else 0) + 1
            collection_denied = isinstance(error, SourceAccessDenied) and error.scope == "collection"
            health = "needs_attention" if collection_denied or failures >= 3 else "degraded"
            next_sync_at = None
            if row and row["schedule_mode"] == "scheduled":
                delay = source_backoff_seconds(
                    str(run["source_id"]),
                    int(row["sync_interval_seconds"] or 60),
                    failures,
                )
                next_sync_at = (utc_now() + timedelta(seconds=delay)).isoformat()
            conn.execute(
                """
                UPDATE corpus_sources SET health_state = ?, consecutive_failure_count = ?,
                       error_summary = ?, next_sync_at = ?, updated_at = ? WHERE id = ?
                """,
                (health, failures, summary, next_sync_at, now, run["source_id"]),
            )
            if collection_denied:
                conn.execute(
                    """
                    UPDATE source_collections SET lifecycle_state = 'access_revoked', updated_at = ?
                     WHERE id = ?
                    """,
                    (now, run["collection_id"]),
                )
                conn.execute(
                    """
                    UPDATE projects SET lifecycle_state = 'access_revoked',
                           retrieval_eligible = 0, updated_at = ?
                     WHERE source_collection_id = ?
                    """,
                    (now, run["collection_id"]),
                )
                conn.execute(
                    """
                    UPDATE documents SET retrieval_eligible = 0, updated_at = ?
                     WHERE source_collection_id = ? AND deleted_at IS NULL
                    """,
                    (now, run["collection_id"]),
                )
                conn.execute(
                    """
                    UPDATE jobs SET status = 'superseded', superseded_at = ?,
                           updated_at = ?, finished_at = ?, error_message = ?
                     WHERE source_collection_id = ? AND status = 'queued'
                    """,
                    (now, now, now, summary, run["collection_id"]),
                )

    def _fail_source_operation(self, source_id: object, error: Exception) -> None:
        now = iso_now()
        summary = self._safe_error(error)
        with open_db(self.db_path) as conn:
            row = conn.execute(
                """
                SELECT consecutive_failure_count, schedule_mode, sync_interval_seconds
                  FROM corpus_sources WHERE id = ?
                """,
                (source_id,),
            ).fetchone()
            failures = int(row["consecutive_failure_count"] if row else 0) + 1
            next_sync_at = None
            if row and row["schedule_mode"] == "scheduled":
                delay = source_backoff_seconds(
                    str(source_id),
                    int(row["sync_interval_seconds"] or 60),
                    failures,
                )
                next_sync_at = (utc_now() + timedelta(seconds=delay)).isoformat()
            conn.execute(
                """
                UPDATE corpus_sources SET health_state = ?, consecutive_failure_count = ?,
                       error_summary = ?, next_sync_at = ?, updated_at = ? WHERE id = ?
                """,
                (
                    "needs_attention" if failures >= 3 else "degraded",
                    failures,
                    summary,
                    next_sync_at,
                    now,
                    source_id,
                ),
            )

    @staticmethod
    def _run_is_current_in_connection(
        conn: sqlite3.Connection, run: dict[str, object]
    ) -> bool:
        row = conn.execute(
            """
            SELECT s.config_revision, s.state, c.filter_revision, c.selected,
                   c.lifecycle_state, c.registration_state, c.validation_state,
                   c.deleted_at
              FROM corpus_sources s JOIN source_collections c ON c.source_id = s.id
             WHERE s.id = ? AND c.id = ?
            """,
            (run["source_id"], run["collection_id"]),
        ).fetchone()
        return bool(
            row
            and row["config_revision"] == run["source_config_revision"]
            and row["filter_revision"] == run["collection_filter_revision"]
            and row["state"] == "active"
            and row["selected"]
            and row["registration_state"] == "active"
            and row["validation_state"] == "valid"
            and row["lifecycle_state"] not in ("missing", "access_revoked")
            and row["deleted_at"] is None
            and (
                not run.get("migration_id")
                or conn.execute(
                    "SELECT 1 FROM corpus_source_migrations WHERE id = ? AND source_id = ? AND status = 'syncing'",
                    (run["migration_id"], run["source_id"]),
                ).fetchone()
            )
            and not conn.execute(
                """
                SELECT 1 FROM source_exclusion_rules
                 WHERE collection_id = ? AND target_type = 'collection'
                 LIMIT 1
                """,
                (run["collection_id"],),
            ).fetchone()
        )

    @staticmethod
    def _ensure_project(
        conn: sqlite3.Connection,
        source_id: str,
        collection_id: str,
        display_name: str,
        now: str,
    ) -> str:
        row = conn.execute(
            "SELECT id FROM projects WHERE source_collection_id = ?", (collection_id,)
        ).fetchone()
        if row:
            conn.execute(
                """
                UPDATE projects SET name = ?, lifecycle_state = 'pending',
                       retrieval_eligible = 0, deleted_at = NULL, updated_at = ? WHERE id = ?
                """,
                (display_name, now, row["id"]),
            )
            return str(row["id"])
        project_id = f"proj_{uuid.uuid4()}"
        conn.execute(
            """
            INSERT INTO projects (
              id, owner_user_id, name, source_id, source_collection_id,
              lifecycle_state, retrieval_eligible, created_at, updated_at
            ) VALUES (?, 'deployment', ?, ?, ?, 'pending', 0, ?, ?)
            """,
            (project_id, display_name, source_id, collection_id, now, now),
        )
        return project_id

    @staticmethod
    def _safe_error(error: Exception) -> str:
        message = str(error)
        lowered = message.lower()
        if any(term in lowered for term in ("password", "secret", "credential", "token")):
            return f"{type(error).__name__}: details redacted"
        return f"{type(error).__name__}: {message}"[:500]

    def _build_connector(self, source: dict[str, object]):
        return build_connector(
            source,
            self.local_access_root,
            self._credentials_for_source(source),
        )

    def _credentials_for_source(self, source: dict[str, object]) -> dict[str, object]:
        if source["kind"] == "local":
            return {}
        if self.master_key_path is None:
            raise RuntimeError("Source credential master key is not configured")
        with open_db(self.db_path) as conn:
            source_id = str(source["source_id"] if "source_id" in source else source["id"])
            if source.get("migration_id"):
                row = conn.execute(
                    "SELECT encrypted_credentials AS encrypted_payload FROM corpus_source_migrations WHERE id = ?",
                    (source["migration_id"],),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT encrypted_payload FROM source_credentials WHERE source_id = ?",
                    (source_id,),
                ).fetchone()
        if row is None:
            raise RuntimeError("Source credentials are not configured")
        return decrypt_source_credentials(
            load_master_key(self.master_key_path),
            source_id,
            row["encrypted_payload"],
        )
