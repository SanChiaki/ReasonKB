from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import tracemalloc

from services.source_worker.engine import SourceWorkerEngine
from services.source_worker.models import CollectionDescriptor, SourceItemMetadata


class SyntheticConnector:
    def __init__(self, document_count: int):
        self.document_count = document_count

    def scan_collection(self, collection: CollectionDescriptor):
        for index in range(self.document_count):
            name = f"document-{index:06d}.txt"
            yield SourceItemMetadata(
                external_id=name,
                parent_external_id=None,
                item_type="document",
                name=name,
                relative_path=name,
                mime_type="text/plain",
                size_bytes=32,
                source_revision=f"synthetic:{index}:32",
                fetch_locator=f"/synthetic/{name}",
                media_type="text",
            )


class CapacityEngine(SourceWorkerEngine):
    def __init__(self, db_path: str, connector: SyntheticConnector):
        super().__init__(db_path, "/synthetic")
        self.connector = connector

    def _build_connector(self, source: dict[str, object]):
        return self.connector


def schema_sql() -> str:
    repo_root = Path(__file__).resolve().parents[2]
    return (repo_root / "web" / "lib" / "db" / "schema.sql").read_text(
        encoding="utf-8"
    )


def seed_topology(db_path: Path, source_count: int, project_count: int) -> None:
    now = "2026-01-01T00:00:00+00:00"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(schema_sql())
        conn.executemany(
            """
            INSERT INTO corpus_sources (
              id, kind, display_name, state, scope_json, config_json,
              config_revision, selection_policy, schedule_mode,
              sync_interval_seconds, max_document_size_bytes, health_state,
              created_at, updated_at
            ) VALUES (?, 'local', ?, 'active', ?, '{}', 1, 'all', 'manual',
                      30, 104857600, 'normal', ?, ?)
            """,
            [
                (
                    f"src_capacity_{index:03d}",
                    f"Capacity Source {index:03d}",
                    json.dumps({"rootPath": f"/synthetic/source-{index:03d}"}),
                    now,
                    now,
                )
                for index in range(source_count)
            ],
        )
        collections = []
        projects = []
        for index in range(project_count):
            source_id = f"src_capacity_{index % source_count:03d}"
            collection_id = f"collection_capacity_{index:04d}"
            collections.append(
                (
                    collection_id,
                    source_id,
                    f"path:collection-{index:04d}",
                    f"collection-{index:04d}",
                    f"Capacity Collection {index:04d}",
                    now,
                    now,
                )
            )
            projects.append(
                (
                    f"project_capacity_{index:04d}",
                    f"Capacity Collection {index:04d}",
                    source_id,
                    collection_id,
                    now,
                    now,
                )
            )
        conn.executemany(
            """
            INSERT INTO source_collections (
              id, source_id, identity_key, external_id, display_name, origin,
              registration_state, validation_state, lifecycle_state, selected,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'discovered', 'active', 'valid', 'active', 1, ?, ?)
            """,
            collections,
        )
        conn.executemany(
            """
            INSERT INTO projects (
              id, owner_user_id, name, source_id, source_collection_id,
              lifecycle_state, retrieval_eligible, created_at, updated_at
            ) VALUES (?, 'deployment', ?, ?, ?, 'active', 1, ?, ?)
            """,
            projects,
        )
        conn.execute(
            """
            INSERT INTO sync_runs (
              id, source_id, collection_id, source_config_revision,
              trigger_kind, status, started_at
            ) VALUES ('sync_capacity', 'src_capacity_000',
                      'collection_capacity_0000', 1, 'manual', 'queued', ?)
            """,
            (now,),
        )


def sqlite_lock_probe(db_path: Path, stop: threading.Event, waits: list[float]) -> None:
    index = 0
    while not stop.is_set():
        started = time.perf_counter()
        try:
            conn = sqlite3.connect(db_path, timeout=5)
            try:
                conn.execute("PRAGMA busy_timeout = 5000")
                conn.execute(
                    """
                    INSERT INTO system_settings (key, value_json, updated_at)
                    VALUES ('capacity_probe', ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(key) DO UPDATE SET
                      value_json = excluded.value_json,
                      updated_at = excluded.updated_at
                    """,
                    (json.dumps({"iteration": index}),),
                )
                conn.commit()
            finally:
                conn.close()
            waits.append(time.perf_counter() - started)
        except sqlite3.OperationalError:
            waits.append(5.0)
        index += 1
        stop.wait(0.01)


def project_list_latency(db_path: Path) -> tuple[int, float]:
    query = """
      SELECT p.id, COUNT(DISTINCT di.document_id) AS document_count
        FROM projects p
        JOIN corpus_sources s ON s.id = p.source_id
        JOIN source_collections c ON c.id = p.source_collection_id
        LEFT JOIN documents d
          ON d.project_id = p.id
         AND d.deleted_at IS NULL
         AND d.lifecycle_state = 'active'
         AND d.retrieval_eligible = 1
         AND d.status = 'ready'
        LEFT JOIN document_indexes di
          ON di.document_id = d.id AND di.is_current = 1
       WHERE p.deleted_at IS NULL
         AND p.lifecycle_state = 'active' AND p.retrieval_eligible = 1
         AND s.deleted_at IS NULL AND s.state = 'active'
         AND c.deleted_at IS NULL AND c.registration_state = 'active'
         AND c.validation_state = 'valid' AND c.lifecycle_state = 'active'
         AND c.selected = 1
       GROUP BY p.id
       ORDER BY p.updated_at DESC, p.name COLLATE NOCASE
    """
    started = time.perf_counter()
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(query).fetchall()
    return len(rows), time.perf_counter() - started


def run_check(
    source_count: int,
    project_count: int,
    document_count: int,
    maximum_peak_mib: float,
    maximum_lock_wait_seconds: float,
) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="reasonkb-capacity-") as temp_dir:
        db_path = Path(temp_dir) / "app.db"
        seed_topology(db_path, source_count, project_count)
        stop_probe = threading.Event()
        lock_waits: list[float] = []
        probe = threading.Thread(
            target=sqlite_lock_probe,
            args=(db_path, stop_probe, lock_waits),
            daemon=True,
        )
        connector = SyntheticConnector(document_count)
        engine = CapacityEngine(str(db_path), connector)
        probe.start()
        tracemalloc.start()
        started = time.perf_counter()
        result = engine.run_once()
        elapsed = time.perf_counter() - started
        _, peak_bytes = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        stop_probe.set()
        probe.join(10)

        with sqlite3.connect(db_path) as conn:
            counts = {
                "sources": conn.execute("SELECT COUNT(*) FROM corpus_sources").fetchone()[0],
                "projects": conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0],
                "items": conn.execute("SELECT COUNT(*) FROM source_items").fetchone()[0],
                "documents": conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0],
                "jobs": conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0],
            }
            sync_run = conn.execute(
                """
                SELECT status, seen_item_count, changed_item_count, missing_item_count
                  FROM sync_runs WHERE id = 'sync_capacity'
                """
            ).fetchone()
        listed_projects, list_seconds = project_list_latency(db_path)
        peak_mib = peak_bytes / (1024 * 1024)
        maximum_lock_wait = max(lock_waits, default=0.0)
        expected = {
            "sources": source_count,
            "projects": project_count,
            "items": document_count,
            "documents": document_count,
            "jobs": document_count,
        }
        if counts != expected:
            raise AssertionError(f"capacity counts differ: {counts} != {expected}")
        if sync_run != ("completed", document_count, document_count, 0):
            raise AssertionError(f"unexpected Sync Run result: {sync_run}")
        if result["synchronized"] != 1 or result["failed"] != 0:
            raise AssertionError(f"unexpected worker result: {result}")
        if listed_projects != project_count:
            raise AssertionError(
                f"project list returned {listed_projects}, expected {project_count}"
            )
        if peak_mib > maximum_peak_mib:
            raise AssertionError(
                f"peak traced memory {peak_mib:.1f} MiB exceeds {maximum_peak_mib:.1f} MiB"
            )
        if maximum_lock_wait > maximum_lock_wait_seconds:
            raise AssertionError(
                "maximum SQLite lock wait "
                f"{maximum_lock_wait:.3f}s exceeds {maximum_lock_wait_seconds:.3f}s"
            )
        return {
            "counts": counts,
            "workerElapsedSeconds": round(elapsed, 3),
            "peakTracedMemoryMiB": round(peak_mib, 1),
            "lockProbeCount": len(lock_waits),
            "maximumSqliteLockWaitSeconds": round(maximum_lock_wait, 3),
            "projectListSeconds": round(list_seconds, 3),
            "databaseMiB": round(db_path.stat().st_size / (1024 * 1024), 1),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="ReasonKB multi-source capacity check")
    parser.add_argument("--sources", type=int, default=100)
    parser.add_argument("--projects", type=int, default=1_000)
    parser.add_argument("--documents", type=int, default=100_000)
    parser.add_argument("--maximum-peak-mib", type=float, default=128)
    parser.add_argument("--maximum-lock-wait-seconds", type=float, default=2)
    args = parser.parse_args()
    result = run_check(
        args.sources,
        args.projects,
        args.documents,
        args.maximum_peak_mib,
        args.maximum_lock_wait_seconds,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
