import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from services.source_worker.engine import (
    MAX_SOURCE_BACKOFF_SECONDS,
    OBSERVATION_BATCH_SIZE,
    SourceWorkerEngine,
    jittered_delay_seconds,
    source_backoff_seconds,
)
from services.source_worker.models import (
    CollectionDescriptor,
    SourceAccessDenied,
    SourceItemMetadata,
)


def _schema_sql() -> str:
    repo_root = Path(__file__).resolve().parents[2]
    return (repo_root / "web" / "lib" / "db" / "schema.sql").read_text(encoding="utf-8")


def _create_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "app.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_schema_sql())
    conn.close()
    return db_path


def _insert_local_source(
    db_path: Path,
    root: Path,
    *,
    source_id: str = "src_local",
    display_name: str = "Local",
    selection_policy: str = "all",
    maximum_bytes: int = 100 * 1024 * 1024,
) -> None:
    now = "2026-01-01T00:00:00+00:00"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO corpus_sources (
          id, kind, display_name, state, scope_json, config_json,
          config_revision, selection_policy, schedule_mode,
          sync_interval_seconds, max_document_size_bytes, health_state,
          validation_requested_at, created_at, updated_at
        ) VALUES (?, 'local', ?, 'draft', ?, '{}', 1, ?, 'scheduled',
                  30, ?, 'unknown', ?, ?, ?)
        """,
        (
            source_id,
            display_name,
            json.dumps({"rootPath": str(root)}),
            selection_policy,
            maximum_bytes,
            now,
            now,
            now,
        ),
    )
    conn.commit()
    conn.close()


def _run_until_idle(engine: SourceWorkerEngine, limit: int = 10) -> None:
    for _ in range(limit):
        summary = engine.run_once()
        if not any(summary.values()):
            return
    raise AssertionError("Source worker did not become idle")


def test_validates_discovers_and_synchronizes_local_collections(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    project = access_root / "Engineering"
    (project / "design").mkdir(parents=True)
    (project / "design" / "report.md").write_text("# Report", encoding="utf-8")
    (access_root / "root.txt").write_text("root", encoding="utf-8")
    _insert_local_source(db_path, access_root)
    engine = SourceWorkerEngine(str(db_path), access_root)

    _run_until_idle(engine)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    source = conn.execute(
        "SELECT state, selection_policy, health_state FROM corpus_sources WHERE id = 'src_local'"
    ).fetchone()
    collections = conn.execute(
        "SELECT external_id, selected, lifecycle_state FROM source_collections ORDER BY external_id"
    ).fetchall()
    projects = conn.execute(
        "SELECT name, lifecycle_state, retrieval_eligible FROM projects ORDER BY name"
    ).fetchall()
    documents = conn.execute(
        """
        SELECT source_item_external_id, source_revision, lifecycle_state, status
          FROM documents ORDER BY source_item_external_id
        """
    ).fetchall()
    jobs = conn.execute(
        "SELECT expected_source_revision, priority, status FROM jobs ORDER BY created_at"
    ).fetchall()
    conn.close()

    assert dict(source) == {
        "state": "active",
        "selection_policy": "all",
        "health_state": "normal",
    }
    assert [tuple(row) for row in collections] == [
        ("Engineering", 1, "active"),
        ("__root__", 1, "active"),
    ]
    assert [tuple(row) for row in projects] == [
        ("Engineering", "active", 1),
        ("Root Collection", "active", 1),
    ]
    assert [tuple(row) for row in documents] == [
        ("Engineering/design/report.md", documents[0]["source_revision"], "active", "uploaded"),
        ("root.txt", documents[1]["source_revision"], "active", "uploaded"),
    ]
    assert all(row["source_revision"].startswith("local:") for row in documents)
    assert [tuple(row)[1:] for row in jobs] == [(200, "queued"), (200, "queued")]


def test_only_a_complete_scan_marks_an_unseen_document_missing(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    project = access_root / "Engineering"
    project.mkdir(parents=True)
    report = project / "report.md"
    report.write_text("report", encoding="utf-8")
    _insert_local_source(db_path, access_root)
    engine = SourceWorkerEngine(str(db_path), access_root)
    _run_until_idle(engine)
    report.unlink()
    conn = sqlite3.connect(db_path)
    collection_id = conn.execute(
        "SELECT id FROM source_collections WHERE external_id = 'Engineering'"
    ).fetchone()[0]
    conn.execute(
        """
        INSERT INTO sync_runs (
          id, source_id, collection_id, source_config_revision,
          trigger_kind, status, started_at
        ) VALUES ('sync_missing', 'src_local', ?, 1, 'manual', 'queued', ?)
        """,
        (collection_id, "2026-01-02T00:00:00+00:00"),
    )
    conn.commit()
    conn.close()

    engine.run_once()

    conn = sqlite3.connect(db_path)
    assert conn.execute(
        "SELECT lifecycle_state, retrieval_eligible, status FROM documents"
    ).fetchone() == ("missing", 0, "deleted")
    assert conn.execute(
        "SELECT status, missing_item_count FROM sync_runs WHERE id = 'sync_missing'"
    ).fetchone() == ("completed", 1)
    conn.close()


def test_failed_scan_preserves_previously_known_document_state(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    project = access_root / "Engineering"
    project.mkdir(parents=True)
    (project / "report.md").write_text("report", encoding="utf-8")
    _insert_local_source(db_path, access_root)
    engine = SourceWorkerEngine(str(db_path), access_root)
    _run_until_idle(engine)
    conn = sqlite3.connect(db_path)
    collection_id = conn.execute(
        "SELECT id FROM source_collections WHERE external_id = 'Engineering'"
    ).fetchone()[0]
    conn.execute(
        "UPDATE corpus_sources SET scope_json = ? WHERE id = 'src_local'",
        (json.dumps({"rootPath": str(access_root / "missing")}),),
    )
    conn.execute(
        """
        INSERT INTO sync_runs (
          id, source_id, collection_id, source_config_revision,
          trigger_kind, status, started_at
        ) VALUES ('sync_failed', 'src_local', ?, 1, 'manual', 'queued', ?)
        """,
        (collection_id, "2026-01-02T00:00:00+00:00"),
    )
    conn.commit()
    conn.close()

    engine.run_once()

    conn = sqlite3.connect(db_path)
    assert conn.execute(
        "SELECT lifecycle_state, deleted_at FROM documents"
    ).fetchone() == ("active", None)
    assert conn.execute(
        "SELECT status FROM sync_runs WHERE id = 'sync_failed'"
    ).fetchone() == ("failed",)
    conn.close()


def test_stale_configuration_discards_staged_observations(tmp_path, monkeypatch):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    access_root.mkdir()
    _insert_local_source(db_path, access_root, selection_policy="none")
    conn = sqlite3.connect(db_path)
    now = "2026-01-01T00:00:00+00:00"
    conn.execute(
        "UPDATE corpus_sources SET state = 'active', validation_requested_at = NULL WHERE id = 'src_local'"
    )
    conn.execute(
        """
        INSERT INTO source_collections (
          id, source_id, identity_key, external_id, display_name, origin,
          registration_state, validation_state, lifecycle_state, selected,
          created_at, updated_at
        ) VALUES ('collection_a', 'src_local', 'path:A', 'A', 'A', 'discovered',
                  'active', 'valid', 'pending', 1, ?, ?)
        """,
        (now, now),
    )
    conn.execute(
        """
        INSERT INTO projects (
          id, owner_user_id, name, source_id, source_collection_id,
          lifecycle_state, retrieval_eligible, created_at, updated_at
        ) VALUES ('proj_a', 'deployment', 'A', 'src_local', 'collection_a',
                  'pending', 0, ?, ?)
        """,
        (now, now),
    )
    conn.execute(
        """
        INSERT INTO sync_runs (
          id, source_id, collection_id, source_config_revision,
          trigger_kind, status, started_at
        ) VALUES ('sync_stale', 'src_local', 'collection_a', 1, 'manual', 'queued', ?)
        """,
        (now,),
    )
    conn.commit()
    conn.close()

    class StaleConnector:
        def scan_collection(self, collection: CollectionDescriptor):
            yield SourceItemMetadata(
                external_id="A/report.md",
                parent_external_id=None,
                item_type="document",
                name="report.md",
                relative_path="report.md",
                mime_type="text/markdown",
                size_bytes=10,
                source_revision="local:1:10",
                fetch_locator="/tmp/report.md",
                media_type="markdown",
            )
            connection = sqlite3.connect(db_path)
            connection.execute(
                "UPDATE corpus_sources SET config_revision = 2 WHERE id = 'src_local'"
            )
            connection.commit()
            connection.close()

    monkeypatch.setattr(
        "services.source_worker.engine.build_connector",
        lambda source, local_access_root, credentials=None: StaleConnector(),
    )
    engine = SourceWorkerEngine(str(db_path), access_root)

    engine.run_once()

    conn = sqlite3.connect(db_path)
    assert conn.execute("SELECT status FROM sync_runs WHERE id = 'sync_stale'").fetchone() == (
        "superseded",
    )
    assert conn.execute("SELECT COUNT(*) FROM sync_run_observations").fetchone() == (0,)
    assert conn.execute("SELECT COUNT(*) FROM documents").fetchone() == (0,)
    conn.close()


def test_collection_access_denial_immediately_fences_project_and_queued_jobs(
    tmp_path, monkeypatch
):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    project = access_root / "Engineering"
    project.mkdir(parents=True)
    (project / "report.md").write_text("report", encoding="utf-8")
    _insert_local_source(db_path, access_root)
    engine = SourceWorkerEngine(str(db_path), access_root)
    _run_until_idle(engine)

    conn = sqlite3.connect(db_path)
    collection_id = conn.execute(
        "SELECT id FROM source_collections WHERE external_id = 'Engineering'"
    ).fetchone()[0]
    now = "2026-01-02T00:00:00+00:00"
    conn.execute(
        "UPDATE documents SET status = 'ready', retrieval_eligible = 1"
    )
    conn.execute(
        """
        INSERT INTO sync_runs (
          id, source_id, collection_id, source_config_revision,
          trigger_kind, status, started_at
        ) VALUES ('sync_denied', 'src_local', ?, 1, 'manual', 'queued', ?)
        """,
        (collection_id, now),
    )
    conn.commit()
    conn.close()

    class DeniedConnector:
        def scan_collection(self, collection: CollectionDescriptor):
            raise SourceAccessDenied(
                "collection",
                collection.external_id,
                "Collection root access denied",
            )

    monkeypatch.setattr(
        "services.source_worker.engine.build_connector",
        lambda source, local_access_root, credentials=None: DeniedConnector(),
    )

    result = engine.run_once()

    conn = sqlite3.connect(db_path)
    assert result["failed"] == 1
    assert conn.execute(
        "SELECT status FROM sync_runs WHERE id = 'sync_denied'"
    ).fetchone() == ("failed",)
    assert conn.execute(
        "SELECT lifecycle_state FROM source_collections WHERE id = ?", (collection_id,)
    ).fetchone() == ("access_revoked",)
    assert conn.execute(
        "SELECT lifecycle_state, retrieval_eligible FROM projects WHERE source_collection_id = ?",
        (collection_id,),
    ).fetchone() == ("access_revoked", 0)
    assert conn.execute(
        "SELECT retrieval_eligible FROM documents"
    ).fetchone() == (0,)
    assert conn.execute("SELECT status FROM jobs").fetchone() == ("superseded",)
    assert conn.execute(
        "SELECT health_state, consecutive_failure_count FROM corpus_sources WHERE id = 'src_local'"
    ).fetchone() == ("needs_attention", 1)
    conn.close()


def test_schedule_jitter_is_stable_and_bounded():
    delay = jittered_delay_seconds("source-a", 100, "schedule:fixed")

    assert delay == jittered_delay_seconds("source-a", 100, "schedule:fixed")
    assert 90 <= delay <= 110
    assert jittered_delay_seconds("source-b", 0, "schedule:fixed") == 1


def test_source_failure_backoff_starts_at_twice_interval_and_stays_capped():
    first_delay = source_backoff_seconds("source-a", 60, 1)

    assert 108 <= first_delay <= 132
    assert source_backoff_seconds("source-a", 60, 0) == first_delay
    assert source_backoff_seconds("source-a", 60 * 60, 20) <= MAX_SOURCE_BACKOFF_SECONDS


def test_claim_due_source_schedules_next_claim_with_bounded_jitter(tmp_path, monkeypatch):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    access_root.mkdir()
    _insert_local_source(db_path, access_root)
    fixed_now = datetime(2026, 1, 2, tzinfo=timezone.utc)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE corpus_sources
           SET state = 'active', validation_requested_at = NULL,
               sync_interval_seconds = 100, next_sync_at = ?
         WHERE id = 'src_local'
        """,
        ("2026-01-01T00:00:00+00:00",),
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr("services.source_worker.engine.utc_now", lambda: fixed_now)

    claimed = SourceWorkerEngine(str(db_path), access_root)._claim_due_source()

    conn = sqlite3.connect(db_path)
    next_sync_at = conn.execute(
        "SELECT next_sync_at FROM corpus_sources WHERE id = 'src_local'"
    ).fetchone()[0]
    conn.close()
    delay = (datetime.fromisoformat(next_sync_at) - fixed_now).total_seconds()
    assert claimed is not None
    assert 90 <= delay <= 110


def test_source_failures_back_off_only_the_failed_source_and_escalate(tmp_path, monkeypatch):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    access_root.mkdir()
    _insert_local_source(db_path, access_root, source_id="source-a")
    _insert_local_source(
        db_path, access_root, source_id="source-b", display_name="Local B"
    )
    fixed_now = datetime(2026, 1, 2, tzinfo=timezone.utc)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE corpus_sources
           SET state = 'active', validation_requested_at = NULL, next_sync_at = ?
        """,
        (fixed_now.isoformat(),),
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr("services.source_worker.engine.utc_now", lambda: fixed_now)
    engine = SourceWorkerEngine(str(db_path), access_root)

    engine._fail_source_operation("source-a", RuntimeError("connection failed"))

    conn = sqlite3.connect(db_path)
    first = conn.execute(
        """
        SELECT health_state, consecutive_failure_count, error_summary, next_sync_at
          FROM corpus_sources WHERE id = 'source-a'
        """
    ).fetchone()
    untouched = conn.execute(
        """
        SELECT health_state, consecutive_failure_count, error_summary, next_sync_at
          FROM corpus_sources WHERE id = 'source-b'
        """
    ).fetchone()
    conn.close()
    first_delay = (datetime.fromisoformat(first[3]) - fixed_now).total_seconds()
    assert first[:3] == ("degraded", 1, "RuntimeError: connection failed")
    assert 54 <= first_delay <= 66
    assert untouched == ("unknown", 0, None, fixed_now.isoformat())

    engine._fail_source_operation("source-a", RuntimeError("connection failed"))
    engine._fail_source_operation("source-a", RuntimeError("connection failed"))

    conn = sqlite3.connect(db_path)
    escalated = conn.execute(
        "SELECT health_state, consecutive_failure_count FROM corpus_sources WHERE id = 'source-a'"
    ).fetchone()
    conn.close()
    assert escalated == ("needs_attention", 3)


def test_manual_source_failure_keeps_next_sync_at_null(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    access_root.mkdir()
    _insert_local_source(db_path, access_root)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE corpus_sources
           SET state = 'active', schedule_mode = 'manual',
               validation_requested_at = NULL, next_sync_at = NULL
         WHERE id = 'src_local'
        """
    )
    conn.commit()
    conn.close()

    SourceWorkerEngine(str(db_path), access_root)._fail_source_operation(
        "src_local", RuntimeError("manual failure")
    )

    conn = sqlite3.connect(db_path)
    source = conn.execute(
        "SELECT health_state, consecutive_failure_count, next_sync_at FROM corpus_sources"
    ).fetchone()
    conn.close()
    assert source == ("degraded", 1, None)


def test_successful_sync_resets_source_failure_state(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    project = access_root / "Engineering"
    project.mkdir(parents=True)
    (project / "report.md").write_text("report", encoding="utf-8")
    _insert_local_source(db_path, access_root)
    engine = SourceWorkerEngine(str(db_path), access_root)
    _run_until_idle(engine)
    conn = sqlite3.connect(db_path)
    collection_id = conn.execute(
        "SELECT id FROM source_collections WHERE external_id = 'Engineering'"
    ).fetchone()[0]
    conn.execute(
        """
        UPDATE corpus_sources
           SET health_state = 'needs_attention', consecutive_failure_count = 3,
               error_summary = 'previous failure'
         WHERE id = 'src_local'
        """
    )
    conn.execute(
        """
        INSERT INTO sync_runs (
          id, source_id, collection_id, source_config_revision,
          trigger_kind, status, started_at
        ) VALUES ('sync_recovery', 'src_local', ?, 1, 'manual', 'queued', ?)
        """,
        (collection_id, "2026-01-02T00:00:00+00:00"),
    )
    conn.commit()
    conn.close()

    result = engine.run_once()

    conn = sqlite3.connect(db_path)
    source = conn.execute(
        """
        SELECT health_state, consecutive_failure_count, error_summary, last_success_at
          FROM corpus_sources WHERE id = 'src_local'
        """
    ).fetchone()
    conn.close()
    assert result["synchronized"] == 1
    assert source[:3] == ("normal", 0, None)
    assert source[3] is not None


def test_partial_traversal_failure_discards_observations_and_preserves_documents(
    tmp_path, monkeypatch
):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    project = access_root / "Engineering"
    project.mkdir(parents=True)
    (project / "report.md").write_text("report", encoding="utf-8")
    _insert_local_source(db_path, access_root)
    engine = SourceWorkerEngine(str(db_path), access_root)
    _run_until_idle(engine)
    conn = sqlite3.connect(db_path)
    collection_id = conn.execute(
        "SELECT id FROM source_collections WHERE external_id = 'Engineering'"
    ).fetchone()[0]
    conn.execute(
        """
        INSERT INTO sync_runs (
          id, source_id, collection_id, source_config_revision,
          trigger_kind, status, started_at
        ) VALUES ('sync_partial', 'src_local', ?, 1, 'manual', 'queued', ?)
        """,
        (collection_id, "2026-01-02T00:00:00+00:00"),
    )
    conn.commit()
    conn.close()

    class PartialConnector:
        def scan_collection(self, collection: CollectionDescriptor):
            for index in range(OBSERVATION_BATCH_SIZE):
                yield SourceItemMetadata(
                    external_id=f"partial-{index}",
                    parent_external_id=None,
                    item_type="document",
                    name=f"partial-{index}.md",
                    relative_path=f"partial-{index}.md",
                    mime_type="text/markdown",
                    size_bytes=10,
                    source_revision=f"seeyon:{index}:10",
                    fetch_locator=str(index),
                    media_type="markdown",
                )
            raise ConnectionError("traversal interrupted")

    monkeypatch.setattr(engine, "_build_connector", lambda source: PartialConnector())

    result = engine.run_once()

    conn = sqlite3.connect(db_path)
    document = conn.execute(
        "SELECT source_item_external_id, lifecycle_state, deleted_at FROM documents"
    ).fetchone()
    run = conn.execute(
        "SELECT status, error_summary FROM sync_runs WHERE id = 'sync_partial'"
    ).fetchone()
    observation_count = conn.execute(
        "SELECT COUNT(*) FROM sync_run_observations WHERE run_id = 'sync_partial'"
    ).fetchone()[0]
    conn.close()
    assert result["failed"] == 1
    assert document == ("Engineering/report.md", "active", None)
    assert run == ("failed", "ConnectionError: traversal interrupted")
    assert observation_count == 0


def test_seeyon_replacement_keeps_document_identity_and_queues_new_revision(
    tmp_path, monkeypatch
):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    access_root.mkdir()
    _insert_local_source(db_path, access_root)
    now = "2026-01-01T00:00:00+00:00"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE corpus_sources
           SET state = 'active', schedule_mode = 'manual',
               validation_requested_at = NULL, next_sync_at = NULL
         WHERE id = 'src_local'
        """
    )
    conn.execute(
        """
        INSERT INTO source_collections (
          id, source_id, identity_key, external_id, root_external_id,
          display_name, origin, registration_state, validation_state,
          lifecycle_state, selected, created_at, updated_at
        ) VALUES ('collection_seeyon', 'src_local', 'seeyon:lib:root', 'lib', 'root',
                  'Seeyon Documents', 'registered', 'active', 'valid',
                  'pending', 1, ?, ?)
        """,
        (now, now),
    )
    conn.execute(
        """
        INSERT INTO projects (
          id, owner_user_id, name, source_id, source_collection_id,
          lifecycle_state, retrieval_eligible, created_at, updated_at
        ) VALUES ('project_seeyon', 'deployment', 'Seeyon Documents', 'src_local',
                  'collection_seeyon', 'pending', 0, ?, ?)
        """,
        (now, now),
    )
    conn.execute(
        """
        INSERT INTO sync_runs (
          id, source_id, collection_id, source_config_revision,
          trigger_kind, status, started_at
        ) VALUES ('sync_v1', 'src_local', 'collection_seeyon', 1, 'manual', 'queued', ?)
        """,
        (now,),
    )
    conn.commit()
    conn.close()

    class ReplacementConnector:
        file_id = "-97296373722364001"
        size = 11818

        def scan_collection(self, collection: CollectionDescriptor):
            yield SourceItemMetadata(
                external_id="5194972540313029554",
                parent_external_id=None,
                item_type="document",
                name="equipment.xlsx",
                relative_path="equipment.xlsx",
                mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                size_bytes=self.size,
                source_revision=f"seeyon:{self.file_id}:{self.size}",
                fetch_locator=self.file_id,
                media_type="office",
            )

    connector = ReplacementConnector()
    engine = SourceWorkerEngine(str(db_path), access_root)
    monkeypatch.setattr(engine, "_build_connector", lambda source: connector)

    first_result = engine.run_once()

    conn = sqlite3.connect(db_path)
    first = conn.execute(
        "SELECT id, source_item_id, source_revision FROM documents"
    ).fetchone()
    conn.execute(
        """
        INSERT INTO document_indexes (
          id, document_id, doc_name, doc_description, structure_json,
          pages_json, index_version, indexed_at, source_revision, is_current
        ) VALUES ('index_v1', ?, 'equipment.xlsx', '', '[]', '[]',
                  'v1', ?, ?, 1)
        """,
        (first[0], now, first[2]),
    )
    conn.execute(
        "UPDATE documents SET status = 'ready', retrieval_eligible = 1 WHERE id = ?",
        (first[0],),
    )
    conn.execute(
        "UPDATE jobs SET status = 'completed' WHERE document_id = ?",
        (first[0],),
    )
    conn.execute(
        """
        INSERT INTO sync_runs (
          id, source_id, collection_id, source_config_revision,
          trigger_kind, status, started_at
        ) VALUES ('sync_v2', 'src_local', 'collection_seeyon', 1, 'manual', 'queued', ?)
        """,
        ("2026-01-02T00:00:00+00:00",),
    )
    conn.commit()
    conn.close()

    connector.file_id = "-1082062512454808173"
    connector.size = 11529
    second_result = engine.run_once()

    conn = sqlite3.connect(db_path)
    second = conn.execute(
        """
        SELECT id, source_item_id, source_item_external_id, source_revision,
               expected_source_revision, storage_path, status, retrieval_eligible
          FROM documents
        """
    ).fetchone()
    old_index = conn.execute(
        "SELECT is_current, retired_at FROM document_indexes WHERE id = 'index_v1'"
    ).fetchone()
    jobs = conn.execute(
        "SELECT expected_source_revision, status FROM jobs ORDER BY created_at"
    ).fetchall()
    conn.close()
    expected_revision = "seeyon:-1082062512454808173:11529"
    assert first_result["synchronized"] == 1
    assert second_result["synchronized"] == 1
    assert second[:3] == (first[0], first[1], "5194972540313029554")
    assert second[3:] == (
        expected_revision,
        expected_revision,
        "-1082062512454808173",
        "uploaded",
        0,
    )
    assert old_index[0] == 0
    assert old_index[1] is not None
    assert jobs == [
        ("seeyon:-97296373722364001:11818", "completed"),
        (expected_revision, "queued"),
    ]


def test_successful_sync_repairs_missing_index_job_for_uploaded_document(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    project = access_root / "Engineering"
    project.mkdir(parents=True)
    (project / "report.md").write_text("# Report", encoding="utf-8")
    _insert_local_source(db_path, access_root)
    engine = SourceWorkerEngine(str(db_path), access_root)

    _run_until_idle(engine)

    conn = sqlite3.connect(db_path)
    document_id = conn.execute("SELECT id FROM documents").fetchone()[0]
    assert conn.execute(
        "SELECT status FROM jobs WHERE document_id = ?", (document_id,)
    ).fetchone() == ("queued",)
    conn.execute("DELETE FROM jobs WHERE document_id = ?", (document_id,))
    conn.execute(
        "UPDATE corpus_sources SET next_sync_at = '2026-01-01T00:00:00+00:00'"
    )
    conn.commit()
    conn.close()

    _run_until_idle(engine)

    conn = sqlite3.connect(db_path)
    jobs = conn.execute(
        "SELECT status, expected_source_revision FROM jobs WHERE document_id = ?",
        (document_id,),
    ).fetchall()
    document = conn.execute(
        "SELECT status, source_revision FROM documents WHERE id = ?", (document_id,)
    ).fetchone()
    conn.close()
    assert jobs == [("queued", document[1])]
    assert document[0] == "uploaded"


def test_source_failure_error_summary_redacts_secret_terms(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    access_root.mkdir()
    _insert_local_source(db_path, access_root)
    engine = SourceWorkerEngine(str(db_path), access_root)

    engine._fail_source_operation(
        "src_local", RuntimeError("password super-secret token leaked")
    )

    conn = sqlite3.connect(db_path)
    error_summary = conn.execute(
        "SELECT error_summary FROM corpus_sources WHERE id = 'src_local'"
    ).fetchone()[0]
    conn.close()
    assert error_summary == "RuntimeError: details redacted"
    assert "super-secret" not in error_summary


def test_worker_startup_recovers_abandoned_runs_and_releases_sync_queue(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    access_root.mkdir()
    _insert_local_source(db_path, access_root)
    now = "2026-01-01T00:00:00+00:00"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE corpus_sources
           SET state = 'active', health_state = 'normal', validation_requested_at = NULL
         WHERE id = 'src_local'
        """
    )
    conn.execute(
        """
        INSERT INTO source_collections (
          id, source_id, identity_key, external_id, display_name, origin,
          registration_state, validation_state, lifecycle_state, selected,
          created_at, updated_at
        ) VALUES ('collection_abandoned', 'src_local', 'local:abandoned', 'abandoned',
                  'Abandoned', 'discovered', 'active', 'validating', 'active', 1, ?, ?)
        """,
        (now, now),
    )
    conn.execute(
        """
        INSERT INTO sync_runs (
          id, source_id, collection_id, source_config_revision,
          trigger_kind, status, started_at
        ) VALUES ('sync_abandoned', 'src_local', 'collection_abandoned', 1,
                  'scheduled', 'running', ?)
        """,
        (now,),
    )
    conn.execute(
        """
        INSERT INTO sync_run_observations (
          run_id, external_id, item_type, name, relative_path, observed_at
        ) VALUES ('sync_abandoned', 'partial', 'document', 'partial.md',
                  'partial.md', ?)
        """,
        (now,),
    )
    conn.execute(
        """
        INSERT INTO source_discovery_runs (
          id, source_id, source_config_revision, status, started_at
        ) VALUES ('discovery_abandoned', 'src_local', 1, 'running', ?)
        """,
        (now,),
    )
    conn.commit()
    conn.close()

    recovered = SourceWorkerEngine(str(db_path), access_root).recover_abandoned_work()

    conn = sqlite3.connect(db_path)
    sync_run = conn.execute(
        "SELECT status, completed_at, error_summary FROM sync_runs WHERE id = 'sync_abandoned'"
    ).fetchone()
    discovery_run = conn.execute(
        """
        SELECT status, completed_at, error_summary
          FROM source_discovery_runs WHERE id = 'discovery_abandoned'
        """
    ).fetchone()
    source = conn.execute(
        """
        SELECT health_state, consecutive_failure_count, next_sync_at
          FROM corpus_sources WHERE id = 'src_local'
        """
    ).fetchone()
    validation_state = conn.execute(
        "SELECT validation_state FROM source_collections WHERE id = 'collection_abandoned'"
    ).fetchone()[0]
    observations = conn.execute(
        "SELECT COUNT(*) FROM sync_run_observations WHERE run_id = 'sync_abandoned'"
    ).fetchone()[0]
    conn.execute(
        """
        INSERT INTO sync_runs (
          id, source_id, collection_id, source_config_revision,
          trigger_kind, status, started_at
        ) VALUES ('sync_requeued', 'src_local', 'collection_abandoned', 1,
                  'manual', 'queued', ?)
        """,
        (now,),
    )
    conn.commit()
    conn.close()

    assert recovered == {
        "sync_runs": 1,
        "discovery_runs": 1,
        "collection_validations": 1,
        "source_validations": 0,
    }
    assert sync_run[0] == "failed"
    assert sync_run[1] is not None
    assert sync_run[2] == "RuntimeError: source worker stopped during operation"
    assert discovery_run[0] == "failed"
    assert discovery_run[1] is not None
    assert discovery_run[2] == "RuntimeError: source worker stopped during operation"
    assert source[0:2] == ("degraded", 1)
    assert source[2] is not None
    assert validation_state == "unvalidated"
    assert observations == 0


def test_worker_startup_requeues_abandoned_source_validation(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    access_root.mkdir()
    _insert_local_source(db_path, access_root)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE corpus_sources
           SET state = 'validating', validation_requested_at = NULL
         WHERE id = 'src_local'
        """
    )
    conn.commit()
    conn.close()

    recovered = SourceWorkerEngine(str(db_path), access_root).recover_abandoned_work()

    conn = sqlite3.connect(db_path)
    source = conn.execute(
        "SELECT state, validation_requested_at FROM corpus_sources WHERE id = 'src_local'"
    ).fetchone()
    conn.close()
    assert recovered["source_validations"] == 1
    assert source[0] == "draft"
    assert source[1] is not None


def test_manual_sync_request_discovers_collections_then_clears_one_time_schedule(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    (access_root / "Engineering").mkdir(parents=True)
    _insert_local_source(db_path, access_root, selection_policy="none")
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE corpus_sources
           SET state = 'active', schedule_mode = 'manual',
               validation_requested_at = NULL,
               next_sync_at = '2026-01-01T00:00:00+00:00'
         WHERE id = 'src_local'
        """
    )
    conn.commit()
    conn.close()

    result = SourceWorkerEngine(str(db_path), access_root).run_once()

    conn = sqlite3.connect(db_path)
    source = conn.execute(
        "SELECT schedule_mode, next_sync_at FROM corpus_sources WHERE id = 'src_local'"
    ).fetchone()
    collections = conn.execute(
        "SELECT external_id, selected FROM source_collections ORDER BY external_id"
    ).fetchall()
    conn.close()
    assert result["discovered"] == 1
    assert source == ("manual", None)
    assert collections == [("Engineering", 0)]


def test_one_source_outage_does_not_block_another_due_source(tmp_path, monkeypatch):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    access_root.mkdir()
    _insert_local_source(db_path, access_root, source_id="source_bad")
    _insert_local_source(
        db_path, access_root, source_id="source_good", display_name="Local Good"
    )
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE corpus_sources
           SET state = 'active', validation_requested_at = NULL,
               health_state = 'normal', next_sync_at =
                 CASE id WHEN 'source_bad' THEN '2026-01-01T00:00:00+00:00'
                         ELSE '2026-01-01T00:00:01+00:00' END
        """
    )
    conn.commit()
    conn.close()

    class FailedConnector:
        def discover_collections(self):
            raise ConnectionError("source unavailable")

    class HealthyConnector:
        def discover_collections(self):
            return iter(())

    engine = SourceWorkerEngine(str(db_path), access_root)
    monkeypatch.setattr(
        engine,
        "_build_connector",
        lambda source: FailedConnector()
        if source["id"] == "source_bad"
        else HealthyConnector(),
    )

    first = engine.run_once()
    second = engine.run_once()

    conn = sqlite3.connect(db_path)
    bad = conn.execute(
        """
        SELECT health_state, consecutive_failure_count
          FROM corpus_sources WHERE id = 'source_bad'
        """
    ).fetchone()
    good_discoveries = conn.execute(
        """
        SELECT COUNT(*) FROM source_discovery_runs
         WHERE source_id = 'source_good' AND status = 'completed'
        """
    ).fetchone()[0]
    conn.close()
    assert first["failed"] == 1
    assert second["discovered"] == 1
    assert bad == ("degraded", 1)
    assert good_discoveries == 1


def test_validation_does_not_erase_concurrent_manual_discovery_request(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    (access_root / "Engineering").mkdir(parents=True)
    _insert_local_source(db_path, access_root, selection_policy="none")
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE corpus_sources
           SET schedule_mode = 'manual',
               next_sync_at = '2026-01-01T00:00:00+00:00'
         WHERE id = 'src_local'
        """
    )
    conn.commit()
    conn.close()

    result = SourceWorkerEngine(str(db_path), access_root).run_once()

    conn = sqlite3.connect(db_path)
    source = conn.execute(
        "SELECT state, schedule_mode, next_sync_at FROM corpus_sources WHERE id = 'src_local'"
    ).fetchone()
    collections = conn.execute(
        "SELECT external_id FROM source_collections ORDER BY external_id"
    ).fetchall()
    conn.close()
    assert result["validated"] == 1
    assert result["discovered"] == 1
    assert source == ("active", "manual", None)
    assert collections == [("Engineering",)]


def test_worker_startup_requeues_abandoned_active_source_validation(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    access_root.mkdir()
    _insert_local_source(db_path, access_root)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE corpus_sources
           SET state = 'active', health_state = 'unknown', validated_at = NULL,
               ever_validated_at = '2026-01-01T00:00:00+00:00',
               validation_requested_at = NULL
         WHERE id = 'src_local'
        """
    )
    conn.commit()
    conn.close()

    recovered = SourceWorkerEngine(str(db_path), access_root).recover_abandoned_work()

    conn = sqlite3.connect(db_path)
    source = conn.execute(
        "SELECT state, validation_requested_at FROM corpus_sources WHERE id = 'src_local'"
    ).fetchone()
    conn.close()
    assert recovered["source_validations"] == 1
    assert source[0] == "active"
    assert source[1] is not None
