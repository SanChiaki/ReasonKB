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
    ExclusionPlan,
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
    columns = {
        row[1] for row in conn.execute("PRAGMA table_info(source_collections)").fetchall()
    }
    if "filter_revision" not in columns:
        conn.execute(
            "ALTER TABLE source_collections ADD COLUMN filter_revision INTEGER NOT NULL DEFAULT 1"
        )
    columns = {row[1] for row in conn.execute("PRAGMA table_info(sync_runs)").fetchall()}
    if "collection_filter_revision" not in columns:
        conn.execute(
            "ALTER TABLE sync_runs ADD COLUMN collection_filter_revision INTEGER NOT NULL DEFAULT 1"
        )
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS source_exclusion_rules (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          collection_id TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_external_id TEXT NOT NULL,
          display_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(collection_id, target_type, target_external_id)
        );
        """
    )
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


def _queue_sync(
    conn: sqlite3.Connection,
    collection_id: str,
    run_id: str,
    filter_revision: int,
) -> None:
    conn.execute(
        """
        INSERT INTO sync_runs (
          id, source_id, collection_id, source_config_revision,
          collection_filter_revision, trigger_kind, status, started_at
        ) VALUES (?, 'src_local', ?, 1, ?, 'manual', 'queued', ?)
        """,
        (run_id, collection_id, filter_revision, "2026-01-02T00:00:00+00:00"),
    )


def _add_current_index(
    conn: sqlite3.Connection,
    document_id: str,
    source_revision: str,
) -> None:
    conn.execute(
        """
        INSERT INTO document_indexes (
          id, document_id, doc_name, doc_description, structure_json,
          pages_json, index_version, indexed_at, source_revision, is_current
        ) VALUES (?, ?, 'report.md', '', '[]', '[]', 'v1', ?, ?, 1)
        """,
        (
            f"index_{document_id}",
            document_id,
            "2026-01-01T00:00:00+00:00",
            source_revision,
        ),
    )
    conn.execute(
        "UPDATE documents SET status = 'ready', retrieval_eligible = 1 WHERE id = ?",
        (document_id,),
    )
    conn.execute(
        "UPDATE jobs SET status = 'completed' WHERE document_id = ?",
        (document_id,),
    )


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


def test_excluded_folder_marks_known_descendants_seen_and_prunes_new_descendants(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    project = access_root / "Engineering"
    archive = project / "archive"
    archive.mkdir(parents=True)
    (archive / "old.md").write_text("old", encoding="utf-8")
    (archive / "purged.md").write_text("purged", encoding="utf-8")
    (project / "current.md").write_text("current", encoding="utf-8")
    _insert_local_source(db_path, access_root)
    engine = SourceWorkerEngine(str(db_path), access_root)
    _run_until_idle(engine)

    conn = sqlite3.connect(db_path)
    collection_id = conn.execute(
        "SELECT id FROM source_collections WHERE external_id = 'Engineering'"
    ).fetchone()[0]
    conn.execute(
        """
        UPDATE source_items SET lifecycle_state = 'missing', deleted_at = ?
         WHERE external_id = 'Engineering/archive/purged.md'
        """,
        ("2026-01-01T12:00:00+00:00",),
    )
    conn.execute(
        """
        UPDATE documents SET lifecycle_state = 'missing', retrieval_eligible = 0,
               status = 'deleted', deleted_at = ?
         WHERE source_item_external_id = 'Engineering/archive/purged.md'
        """,
        ("2026-01-01T12:00:00+00:00",),
    )
    conn.execute(
        """
        INSERT INTO source_exclusion_rules (
          id, source_id, collection_id, target_type, target_external_id,
          display_path, created_at
        ) VALUES ('exclude_archive', 'src_local', ?, 'folder',
                  'Engineering/archive', 'archive', ?)
        """,
        (collection_id, "2026-01-02T00:00:00+00:00"),
    )
    conn.execute(
        "UPDATE source_collections SET filter_revision = 2 WHERE id = ?",
        (collection_id,),
    )
    _queue_sync(conn, collection_id, "sync_excluded_folder", 2)
    conn.commit()
    conn.close()

    assert engine.run_once()["synchronized"] == 1

    conn = sqlite3.connect(db_path)
    known = conn.execute(
        """
        SELECT external_id, lifecycle_state, last_seen_run_id
          FROM source_items WHERE collection_id = ? AND deleted_at IS NULL
         ORDER BY external_id
        """,
        (collection_id,),
    ).fetchall()
    run = conn.execute(
        "SELECT status, missing_item_count FROM sync_runs WHERE id = 'sync_excluded_folder'"
    ).fetchone()
    document = conn.execute(
        """
        SELECT lifecycle_state, retrieval_eligible
          FROM documents WHERE source_item_external_id = 'Engineering/archive/old.md'
        """
    ).fetchone()
    job = conn.execute(
        """
        SELECT status FROM jobs
         WHERE document_id = (
           SELECT id FROM documents
            WHERE source_item_external_id = 'Engineering/archive/old.md'
         )
        """
    ).fetchone()
    purged = conn.execute(
        """
        SELECT si.lifecycle_state, si.deleted_at, d.lifecycle_state, d.deleted_at
          FROM source_items si JOIN documents d ON d.source_item_id = si.id
         WHERE si.external_id = 'Engineering/archive/purged.md'
        """
    ).fetchone()
    conn.close()
    assert known == [
        ("Engineering/archive", "excluded", "sync_excluded_folder"),
        ("Engineering/archive/old.md", "excluded", "sync_excluded_folder"),
        ("Engineering/current.md", "active", "sync_excluded_folder"),
    ]
    assert run == ("completed", 0)
    assert document == ("excluded", 0)
    assert job == ("superseded",)
    assert purged[0] == "missing"
    assert purged[1] is not None
    assert purged[2] == "missing"
    assert purged[3] is not None

    (archive / "new.md").write_text("new", encoding="utf-8")
    conn = sqlite3.connect(db_path)
    _queue_sync(conn, collection_id, "sync_still_excluded", 2)
    conn.commit()
    conn.close()
    assert engine.run_once()["synchronized"] == 1
    conn = sqlite3.connect(db_path)
    assert conn.execute(
        "SELECT COUNT(*) FROM source_items WHERE external_id = 'Engineering/archive/new.md'"
    ).fetchone() == (0,)

    conn.execute("DELETE FROM source_exclusion_rules WHERE id = 'exclude_archive'")
    conn.execute(
        "UPDATE source_collections SET filter_revision = 3 WHERE id = ?",
        (collection_id,),
    )
    _queue_sync(conn, collection_id, "sync_restored_folder", 3)
    conn.commit()
    conn.close()
    assert engine.run_once()["synchronized"] == 1
    conn = sqlite3.connect(db_path)
    restored = conn.execute(
        """
        SELECT external_id, lifecycle_state FROM source_items
         WHERE external_id LIKE 'Engineering/archive/%' ORDER BY external_id
        """
    ).fetchall()
    conn.close()
    assert restored == [
        ("Engineering/archive/new.md", "active"),
        ("Engineering/archive/old.md", "active"),
        ("Engineering/archive/purged.md", "active"),
    ]


def test_unchanged_excluded_document_restores_retained_index_without_new_job(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    project = access_root / "Engineering"
    project.mkdir(parents=True)
    (project / "report.md").write_text("unchanged", encoding="utf-8")
    _insert_local_source(db_path, access_root)
    engine = SourceWorkerEngine(str(db_path), access_root)
    _run_until_idle(engine)

    conn = sqlite3.connect(db_path)
    collection_id = conn.execute(
        "SELECT id FROM source_collections WHERE external_id = 'Engineering'"
    ).fetchone()[0]
    document_id, source_revision = conn.execute(
        "SELECT id, source_revision FROM documents WHERE source_item_external_id = 'Engineering/report.md'"
    ).fetchone()
    _add_current_index(conn, document_id, source_revision)
    conn.execute(
        """
        INSERT INTO source_exclusion_rules (
          id, source_id, collection_id, target_type, target_external_id,
          display_path, created_at
        ) VALUES ('exclude_unchanged', 'src_local', ?, 'document',
                  'Engineering/report.md', 'report.md', ?)
        """,
        (collection_id, "2026-01-02T00:00:00+00:00"),
    )
    conn.execute(
        "UPDATE source_collections SET filter_revision = 2 WHERE id = ?",
        (collection_id,),
    )
    _queue_sync(conn, collection_id, "sync_exclude_unchanged", 2)
    conn.commit()
    conn.close()
    assert engine.run_once()["synchronized"] == 1

    conn = sqlite3.connect(db_path)
    conn.execute("DELETE FROM source_exclusion_rules WHERE id = 'exclude_unchanged'")
    conn.execute(
        "UPDATE source_collections SET filter_revision = 3 WHERE id = ?",
        (collection_id,),
    )
    _queue_sync(conn, collection_id, "sync_restore_unchanged", 3)
    conn.commit()
    conn.close()
    assert engine.run_once()["synchronized"] == 1

    conn = sqlite3.connect(db_path)
    document = conn.execute(
        "SELECT lifecycle_state, retrieval_eligible, status FROM documents WHERE id = ?",
        (document_id,),
    ).fetchone()
    index_state = conn.execute(
        "SELECT is_current, retired_at FROM document_indexes WHERE document_id = ?",
        (document_id,),
    ).fetchone()
    jobs = conn.execute(
        "SELECT status FROM jobs WHERE document_id = ? ORDER BY created_at",
        (document_id,),
    ).fetchall()
    conn.close()
    assert document == ("active", 1, "ready")
    assert index_state == (1, None)
    assert jobs == [("completed",)]


def test_document_changed_while_excluded_reindexes_when_rule_is_removed(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    project = access_root / "Engineering"
    project.mkdir(parents=True)
    report = project / "report.md"
    report.write_text("old", encoding="utf-8")
    _insert_local_source(db_path, access_root)
    engine = SourceWorkerEngine(str(db_path), access_root)
    _run_until_idle(engine)

    conn = sqlite3.connect(db_path)
    collection_id = conn.execute(
        "SELECT id FROM source_collections WHERE external_id = 'Engineering'"
    ).fetchone()[0]
    document_id, original_revision = conn.execute(
        "SELECT id, source_revision FROM documents WHERE source_item_external_id = 'Engineering/report.md'"
    ).fetchone()
    _add_current_index(conn, document_id, original_revision)
    conn.execute(
        """
        INSERT INTO source_exclusion_rules (
          id, source_id, collection_id, target_type, target_external_id,
          display_path, created_at
        ) VALUES ('exclude_report', 'src_local', ?, 'document',
                  'Engineering/report.md', 'report.md', ?)
        """,
        (collection_id, "2026-01-02T00:00:00+00:00"),
    )
    conn.execute(
        "UPDATE source_collections SET filter_revision = 2 WHERE id = ?",
        (collection_id,),
    )
    _queue_sync(conn, collection_id, "sync_excluded_document", 2)
    conn.commit()
    conn.close()
    assert engine.run_once()["synchronized"] == 1

    report.write_text("new revision with another size", encoding="utf-8")
    conn = sqlite3.connect(db_path)
    _queue_sync(conn, collection_id, "sync_excluded_changed", 2)
    conn.commit()
    conn.close()
    assert engine.run_once()["synchronized"] == 1

    conn = sqlite3.connect(db_path)
    excluded = conn.execute(
        "SELECT lifecycle_state, retrieval_eligible, source_revision FROM documents WHERE id = ?",
        (document_id,),
    ).fetchone()
    retained_index = conn.execute(
        "SELECT is_current, source_revision FROM document_indexes WHERE document_id = ?",
        (document_id,),
    ).fetchone()
    assert excluded[0:2] == ("excluded", 0)
    assert excluded[2] != original_revision
    assert retained_index == (1, original_revision)

    conn.execute("DELETE FROM source_exclusion_rules WHERE id = 'exclude_report'")
    conn.execute(
        "UPDATE source_collections SET filter_revision = 3 WHERE id = ?",
        (collection_id,),
    )
    _queue_sync(conn, collection_id, "sync_restored_document", 3)
    conn.commit()
    conn.close()
    assert engine.run_once()["synchronized"] == 1

    conn = sqlite3.connect(db_path)
    restored = conn.execute(
        "SELECT lifecycle_state, retrieval_eligible, status, source_revision FROM documents WHERE id = ?",
        (document_id,),
    ).fetchone()
    old_index = conn.execute(
        "SELECT is_current, retired_at FROM document_indexes WHERE document_id = ?",
        (document_id,),
    ).fetchone()
    queued = conn.execute(
        """
        SELECT status, expected_source_revision FROM jobs
         WHERE document_id = ? ORDER BY created_at DESC LIMIT 1
        """,
        (document_id,),
    ).fetchone()
    conn.close()
    assert restored[0:3] == ("active", 0, "uploaded")
    assert old_index[0] == 0
    assert old_index[1] is not None
    assert queued == ("queued", restored[3])


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
        def scan_collection(
            self, collection: CollectionDescriptor, exclusions: ExclusionPlan
        ):
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


def test_filter_revision_change_supersedes_run_and_queues_clean_follow_up(
    tmp_path, monkeypatch
):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    access_root.mkdir()
    _insert_local_source(db_path, access_root, selection_policy="none")
    now = "2026-01-01T00:00:00+00:00"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE corpus_sources SET state = 'active', health_state = 'normal',
               schedule_mode = 'manual', next_sync_at = NULL,
               validation_requested_at = NULL WHERE id = 'src_local'
        """
    )
    conn.execute(
        """
        INSERT INTO source_collections (
          id, source_id, identity_key, external_id, display_name, origin,
          registration_state, validation_state, lifecycle_state, selected,
          filter_revision, created_at, updated_at
        ) VALUES ('collection_a', 'src_local', 'path:A', 'A', 'A', 'discovered',
                  'active', 'valid', 'pending', 1, 1, ?, ?)
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
    _queue_sync(conn, "collection_a", "sync_filter_stale", 1)
    conn.commit()
    conn.close()

    class FilterChangingConnector:
        def scan_collection(
            self, collection: CollectionDescriptor, exclusions: ExclusionPlan
        ):
            assert exclusions == ExclusionPlan()
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
                "UPDATE source_collections SET filter_revision = 2 WHERE id = 'collection_a'"
            )
            connection.commit()
            connection.close()

    monkeypatch.setattr(
        "services.source_worker.engine.build_connector",
        lambda source, local_access_root, credentials=None: FilterChangingConnector(),
    )
    result = SourceWorkerEngine(str(db_path), access_root).run_once()

    conn = sqlite3.connect(db_path)
    runs = conn.execute(
        """
        SELECT status, collection_filter_revision FROM sync_runs
         WHERE collection_id = 'collection_a' ORDER BY started_at, id
        """
    ).fetchall()
    source = conn.execute(
        "SELECT health_state, consecutive_failure_count FROM corpus_sources WHERE id = 'src_local'"
    ).fetchone()
    observations = conn.execute("SELECT COUNT(*) FROM sync_run_observations").fetchone()
    documents = conn.execute("SELECT COUNT(*) FROM documents").fetchone()
    conn.close()
    assert result["failed"] == 0
    assert runs == [("superseded", 1), ("queued", 2)]
    assert source == ("normal", 0)
    assert observations == (0,)
    assert documents == (0,)


def test_collection_exclusion_supersedes_queued_sync_without_claiming_it(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    (access_root / "A").mkdir(parents=True)
    _insert_local_source(db_path, access_root, selection_policy="none")
    now = "2026-01-01T00:00:00+00:00"
    conn = sqlite3.connect(db_path)
    conn.execute(
        "UPDATE corpus_sources SET state = 'active', validation_requested_at = NULL WHERE id = 'src_local'"
    )
    conn.execute(
        """
        INSERT INTO source_collections (
          id, source_id, identity_key, external_id, display_name, origin,
          registration_state, validation_state, lifecycle_state, selected,
          filter_revision, created_at, updated_at
        ) VALUES ('collection_excluded', 'src_local', 'path:A', 'A', 'A',
                  'discovered', 'active', 'valid', 'excluded', 1, 2, ?, ?)
        """,
        (now, now),
    )
    conn.execute(
        """
        INSERT INTO source_exclusion_rules (
          id, source_id, collection_id, target_type, target_external_id,
          display_path, created_at
        ) VALUES ('exclude_collection', 'src_local', 'collection_excluded',
                  'collection', 'A', 'A', ?)
        """,
        (now,),
    )
    conn.execute(
        """
        INSERT INTO projects (
          id, owner_user_id, name, source_id, source_collection_id,
          lifecycle_state, retrieval_eligible, created_at, updated_at
        ) VALUES ('project_excluded', 'deployment', 'A', 'src_local',
                  'collection_excluded', 'excluded', 0, ?, ?)
        """,
        (now, now),
    )
    _queue_sync(conn, "collection_excluded", "sync_collection_excluded", 2)
    conn.commit()
    conn.close()

    result = SourceWorkerEngine(str(db_path), access_root).run_once()

    conn = sqlite3.connect(db_path)
    run = conn.execute(
        "SELECT status, error_summary FROM sync_runs WHERE id = 'sync_collection_excluded'"
    ).fetchone()
    run_count = conn.execute("SELECT COUNT(*) FROM sync_runs").fetchone()
    conn.close()
    assert result["synchronized"] == 0
    assert result["failed"] == 0
    assert run == ("superseded", None)
    assert run_count == (1,)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("DELETE FROM source_exclusion_rules WHERE id = 'exclude_collection'")
    conn.execute(
        """
        UPDATE source_collections SET filter_revision = 3, lifecycle_state = 'pending'
         WHERE id = 'collection_excluded'
        """
    )
    SourceWorkerEngine(str(db_path), access_root)._queue_sync_run_in_connection(
        conn,
        "src_local",
        "collection_excluded",
        1,
        "manual",
    )
    conn.commit()
    restored_run = conn.execute(
        """
        SELECT status, collection_filter_revision FROM sync_runs
         WHERE id <> 'sync_collection_excluded'
        """
    ).fetchone()
    conn.close()
    assert tuple(restored_run) == ("queued", 3)

    result = SourceWorkerEngine(str(db_path), access_root).run_once()
    conn = sqlite3.connect(db_path)
    restored = conn.execute(
        """
        SELECT c.lifecycle_state, p.lifecycle_state, p.retrieval_eligible
          FROM source_collections c
          JOIN projects p ON p.source_collection_id = c.id
         WHERE c.id = 'collection_excluded'
        """
    ).fetchone()
    conn.close()
    assert result["synchronized"] == 1
    assert restored == ("active", "active", 1)


def test_excluded_registered_collection_creates_project_before_restoration(
    tmp_path, monkeypatch
):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    access_root.mkdir()
    _insert_local_source(db_path, access_root, selection_policy="all")
    now = "2026-01-01T00:00:00+00:00"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE corpus_sources
           SET state = 'active', schedule_mode = 'manual', next_sync_at = NULL,
               validation_requested_at = NULL
         WHERE id = 'src_local'
        """
    )
    conn.execute(
        """
        INSERT INTO source_collections (
          id, source_id, identity_key, external_id, root_external_id, display_name,
          origin, registration_state, validation_state, lifecycle_state, selected,
          filter_revision, created_at, updated_at
        ) VALUES ('collection_registered', 'src_local', 'registered:A', 'A', 'A',
                  'Registered A', 'registered', 'active', 'unvalidated', 'excluded',
                  0, 2, ?, ?)
        """,
        (now, now),
    )
    conn.execute(
        """
        INSERT INTO source_exclusion_rules (
          id, source_id, collection_id, target_type, target_external_id,
          display_path, created_at
        ) VALUES ('exclude_registered', 'src_local', 'collection_registered',
                  'collection', 'A', 'Registered A', ?)
        """,
        (now,),
    )
    conn.commit()
    conn.close()

    class RegisteredConnector:
        def validate_collection(self, collection: CollectionDescriptor) -> None:
            assert collection.external_id == "A"

        def scan_collection(
            self, collection: CollectionDescriptor, exclusions: ExclusionPlan
        ):
            yield SourceItemMetadata(
                external_id="A/report.md",
                parent_external_id=None,
                item_type="document",
                name="report.md",
                relative_path="report.md",
                mime_type="text/markdown",
                size_bytes=10,
                source_revision="registered:1:10",
                fetch_locator="/tmp/report.md",
                media_type="markdown",
            )

    monkeypatch.setattr(
        "services.source_worker.engine.build_connector",
        lambda source, local_access_root, credentials=None: RegisteredConnector(),
    )
    engine = SourceWorkerEngine(str(db_path), access_root)

    engine.run_once()

    conn = sqlite3.connect(db_path)
    excluded_state = conn.execute(
        """
        SELECT c.validation_state, c.selected, c.lifecycle_state,
               p.lifecycle_state, p.retrieval_eligible
          FROM source_collections c
          JOIN projects p ON p.source_collection_id = c.id
         WHERE c.id = 'collection_registered'
        """
    ).fetchone()
    assert excluded_state == ("valid", 1, "excluded", "excluded", 0)

    conn.row_factory = sqlite3.Row
    conn.execute("DELETE FROM source_exclusion_rules WHERE id = 'exclude_registered'")
    conn.execute(
        """
        UPDATE source_collections
           SET filter_revision = 3, lifecycle_state = 'pending'
         WHERE id = 'collection_registered'
        """
    )
    engine._queue_sync_run_in_connection(
        conn,
        "src_local",
        "collection_registered",
        1,
        "manual",
    )
    conn.commit()
    conn.close()

    result = engine.run_once()

    conn = sqlite3.connect(db_path)
    restored_state = conn.execute(
        """
        SELECT c.lifecycle_state, p.lifecycle_state, p.retrieval_eligible
          FROM source_collections c
          JOIN projects p ON p.source_collection_id = c.id
         WHERE c.id = 'collection_registered'
        """
    ).fetchone()
    document = conn.execute(
        """
        SELECT lifecycle_state, status
          FROM documents WHERE source_item_external_id = 'A/report.md'
        """
    ).fetchone()
    conn.close()

    assert result["synchronized"] == 1
    assert restored_state == ("active", "active", 1)
    assert document == ("active", "uploaded")


def test_excluded_discovered_collection_creates_selected_project(tmp_path):
    db_path = _create_db(tmp_path)
    access_root = tmp_path / "sources"
    access_root.mkdir()
    _insert_local_source(db_path, access_root, selection_policy="all")
    now = "2026-01-01T00:00:00+00:00"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO source_collections (
          id, source_id, identity_key, external_id, display_name, origin,
          registration_state, validation_state, lifecycle_state, selected,
          filter_revision, created_at, updated_at
        ) VALUES ('collection_discovered', 'src_local', 'path:A', 'A', 'A',
                  'discovered', 'active', 'valid', 'inactive', 0, 2, ?, ?)
        """,
        (now, now),
    )
    conn.execute(
        """
        INSERT INTO source_exclusion_rules (
          id, source_id, collection_id, target_type, target_external_id,
          display_path, created_at
        ) VALUES ('exclude_discovered', 'src_local', 'collection_discovered',
                  'collection', 'A', 'A', ?)
        """,
        (now,),
    )
    conn.commit()
    conn.close()

    SourceWorkerEngine(str(db_path), access_root)._upsert_discovered_collection(
        {"id": "src_local", "selection_policy": "all"},
        "discovery_1",
        CollectionDescriptor(
            identity_key="path:A",
            external_id="A",
            root_external_id=None,
            display_name="A",
        ),
    )

    conn = sqlite3.connect(db_path)
    state = conn.execute(
        """
        SELECT c.selected, c.lifecycle_state,
               p.lifecycle_state, p.retrieval_eligible
          FROM source_collections c
          JOIN projects p ON p.source_collection_id = c.id
         WHERE c.id = 'collection_discovered'
        """
    ).fetchone()
    conn.close()

    assert state == (1, "excluded", "excluded", 0)


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
        def scan_collection(
            self, collection: CollectionDescriptor, exclusions: ExclusionPlan
        ):
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
        def scan_collection(
            self, collection: CollectionDescriptor, exclusions: ExclusionPlan
        ):
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

        def scan_collection(
            self, collection: CollectionDescriptor, exclusions: ExclusionPlan
        ):
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


def _insert_seeyon_migration_fixture(db_path: Path) -> None:
    now = "2026-01-01T00:00:00+00:00"
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        INSERT INTO corpus_sources (
          id, kind, display_name, state, scope_json, config_json, config_revision,
          selection_policy, schedule_mode, sync_interval_seconds,
          max_document_size_bytes, health_state, created_at, updated_at
        ) VALUES ('src_seeyon', 'seeyon', 'Seeyon', 'active',
                  '{"endpoint":"http://old.intranet"}',
                  '{"loginName":"reader"}', 1, 'explicit', 'manual', 600,
                  104857600, 'normal', '2025-12-01T00:00:00+00:00', '2025-12-01T00:00:00+00:00');
        INSERT INTO source_credentials (source_id, encrypted_payload, created_at, updated_at)
          VALUES ('src_seeyon', 'placeholder', '2025-12-01T00:00:00+00:00', '2025-12-01T00:00:00+00:00');
        INSERT INTO source_collections (
          id, source_id, identity_key, external_id, root_external_id, display_name,
          origin, registration_state, validation_state, lifecycle_state, selected,
          created_at, updated_at
        ) VALUES ('collection_seeyon', 'src_seeyon', 'seeyon:1:2', '1', '2', 'Docs',
                  'registered', 'active', 'valid', 'active', 1, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
        INSERT INTO projects (
          id, owner_user_id, name, source_id, source_collection_id,
          lifecycle_state, retrieval_eligible, created_at, updated_at
        ) VALUES ('project_seeyon', 'deployment', 'Docs', 'src_seeyon', 'collection_seeyon',
                  'active', 1, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
        INSERT INTO source_items (
          id, source_id, collection_id, external_id, item_type, name, relative_path,
          mime_type, size_bytes, source_revision, fetch_locator, lifecycle_state,
          last_seen_run_id, created_at, updated_at
        ) VALUES ('item_seeyon', 'src_seeyon', 'collection_seeyon', 'doc-1', 'document',
                  'guide.pdf', 'guide.pdf', 'application/pdf', 10, 'seeyon:file-1:10',
                      'file-1', 'active', NULL, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
        INSERT INTO documents (
          id, project_id, owner_user_id, file_name, storage_path, mime_type, file_size,
          status, source_kind, source_id, source_collection_id, source_item_id,
          source_item_external_id, source_revision, expected_source_revision,
          expected_source_config_revision, lifecycle_state, retrieval_eligible,
          created_at, updated_at
        ) VALUES ('document_seeyon', 'project_seeyon', 'deployment', 'guide.pdf', 'file-1',
                  'application/pdf', 10, 'ready', 'seeyon', 'src_seeyon', 'collection_seeyon',
                  'item_seeyon', 'doc-1', 'seeyon:file-1:10', 'seeyon:file-1:10', 1,
                      'active', 1, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
        UPDATE source_items SET document_id = 'document_seeyon' WHERE id = 'item_seeyon';
        INSERT INTO document_indexes (
          id, document_id, doc_name, doc_description, structure_json, pages_json,
          index_version, indexed_at, source_revision, is_current
        ) VALUES ('index_seeyon', 'document_seeyon', 'guide.pdf', '', '[]', '[]',
                  'v1', '2026-01-01T00:00:00+00:00', 'seeyon:file-1:10', 1);
        """,
    )
    conn.execute(
        "INSERT INTO corpus_source_migrations (id, source_id, source_config_revision, target_scope_json, target_config_json, encrypted_credentials, status, created_at, updated_at) VALUES ('migration_1', 'src_seeyon', 1, ?, ?, 'placeholder', 'requested', ?, ?)",
        ('{"endpoint":"https://public.example"}', '{"loginName":"reader"}', now, now),
    )
    conn.commit()
    conn.close()


def test_seeyon_url_migration_reuses_document_and_index_identity(tmp_path, monkeypatch):
    db_path = _create_db(tmp_path)
    _insert_seeyon_migration_fixture(db_path)

    class Connector:
        def validate(self):
            return None

        def scan_collection(self, collection, exclusions):
            yield SourceItemMetadata(
                external_id="doc-1",
                parent_external_id=None,
                item_type="document",
                name="guide.pdf",
                relative_path="guide.pdf",
                mime_type="application/pdf",
                size_bytes=10,
                source_revision="seeyon:file-1:10",
                fetch_locator="file-1",
                media_type="pdf",
            )

    engine = SourceWorkerEngine(str(db_path), tmp_path)
    monkeypatch.setattr(engine, "_build_connector", lambda source: Connector())
    result = engine.run_once()

    conn = sqlite3.connect(db_path)
    source = conn.execute("SELECT scope_json, config_revision FROM corpus_sources WHERE id = 'src_seeyon'").fetchone()
    migration = conn.execute("SELECT status FROM corpus_source_migrations WHERE id = 'migration_1'").fetchone()
    document = conn.execute("SELECT id, status, retrieval_eligible, expected_source_config_revision FROM documents WHERE id = 'document_seeyon'").fetchone()
    index = conn.execute("SELECT id, is_current FROM document_indexes WHERE document_id = 'document_seeyon'").fetchone()
    conn.close()
    assert result["synchronized"] == 1
    assert json.loads(source[0])["endpoint"] == "https://public.example"
    assert source[1] == 2
    assert migration == ("completed",)
    assert document == ("document_seeyon", "ready", 1, 2)
    assert index == ("index_seeyon", 1)


def test_seeyon_url_migration_preserves_old_index_until_changed_document_reindexes(
    tmp_path, monkeypatch
):
    db_path = _create_db(tmp_path)
    _insert_seeyon_migration_fixture(db_path)

    class Connector:
        def validate(self):
            return None

        def scan_collection(self, collection, exclusions):
            yield SourceItemMetadata(
                external_id="doc-1",
                parent_external_id=None,
                item_type="document",
                name="guide.pdf",
                relative_path="guide.pdf",
                mime_type="application/pdf",
                size_bytes=20,
                source_revision="seeyon:file-1:20",
                fetch_locator="file-1",
                media_type="pdf",
            )

    engine = SourceWorkerEngine(str(db_path), tmp_path)
    monkeypatch.setattr(engine, "_build_connector", lambda source: Connector())
    assert engine.run_once()["synchronized"] == 1

    conn = sqlite3.connect(db_path)
    document = conn.execute(
        "SELECT id, status, retrieval_eligible, source_revision FROM documents WHERE id = 'document_seeyon'"
    ).fetchone()
    index = conn.execute(
        "SELECT id, is_current, source_revision FROM document_indexes WHERE document_id = 'document_seeyon'"
    ).fetchone()
    job = conn.execute(
        "SELECT status, migration_id, expected_source_revision, expected_source_config_revision FROM jobs WHERE document_id = 'document_seeyon' ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    conn.close()

    assert document == ("document_seeyon", "uploaded", 0, "seeyon:file-1:20")
    assert index == ("index_seeyon", 1, "seeyon:file-1:10")
    assert job == ("queued", None, "seeyon:file-1:20", 2)


def test_seeyon_url_migration_rejects_empty_target_before_mutating_documents(
    tmp_path, monkeypatch
):
    db_path = _create_db(tmp_path)
    _insert_seeyon_migration_fixture(db_path)

    class Connector:
        def validate(self):
            return None

        def scan_collection(self, collection, exclusions):
            if False:
                yield None

    engine = SourceWorkerEngine(str(db_path), tmp_path)
    monkeypatch.setattr(engine, "_build_connector", lambda source: Connector())
    engine.run_once()

    conn = sqlite3.connect(db_path)
    source = conn.execute(
        "SELECT scope_json, config_revision FROM corpus_sources WHERE id = 'src_seeyon'"
    ).fetchone()
    migration = conn.execute(
        "SELECT status, error_summary, preflight_json FROM corpus_source_migrations WHERE id = 'migration_1'"
    ).fetchone()
    document = conn.execute(
        "SELECT status, retrieval_eligible, lifecycle_state FROM documents WHERE id = 'document_seeyon'"
    ).fetchone()
    index = conn.execute(
        "SELECT id, is_current FROM document_indexes WHERE document_id = 'document_seeyon'"
    ).fetchone()
    conn.close()

    report = json.loads(migration[2])
    assert json.loads(source[0])["endpoint"] == "http://old.intranet"
    assert source[1] == 1
    assert migration[0] == "failed"
    assert "administrator confirmation" in migration[1]
    assert report["requiresConfirmation"] is True
    assert report["collections"][0]["reasons"] == [
        "target-empty",
        "no-stable-id-overlap",
        "existing-overlap-below-50-percent",
    ]
    assert document == ("ready", 1, "active")
    assert index == ("index_seeyon", 1)


def test_confirmed_risky_seeyon_url_migration_can_continue_explicitly(
    tmp_path, monkeypatch
):
    db_path = _create_db(tmp_path)
    _insert_seeyon_migration_fixture(db_path)

    class Connector:
        def validate(self):
            return None

        def scan_collection(self, collection, exclusions):
            if False:
                yield None

    engine = SourceWorkerEngine(str(db_path), tmp_path)
    monkeypatch.setattr(engine, "_build_connector", lambda source: Connector())
    engine.run_once()

    conn = sqlite3.connect(db_path)
    conn.execute(
        "UPDATE corpus_source_migrations SET status = 'requested', allow_risk = 1, error_summary = NULL WHERE id = 'migration_1'"
    )
    conn.commit()
    conn.close()
    engine.run_once()
    engine.run_once()

    conn = sqlite3.connect(db_path)
    source = conn.execute(
        "SELECT scope_json, config_revision FROM corpus_sources WHERE id = 'src_seeyon'"
    ).fetchone()
    migration = conn.execute(
        "SELECT status, allow_risk, preflight_json FROM corpus_source_migrations WHERE id = 'migration_1'"
    ).fetchone()
    document = conn.execute(
        "SELECT status, retrieval_eligible, lifecycle_state FROM documents WHERE id = 'document_seeyon'"
    ).fetchone()
    conn.close()

    assert json.loads(source[0])["endpoint"] == "https://public.example"
    assert source[1] == 2
    assert migration[:2] == ("completed", 1)
    assert len(json.loads(migration[2])["collections"]) == 1
    assert document == ("deleted", 0, "missing")


def test_failed_seeyon_url_migration_keeps_old_scope(tmp_path, monkeypatch):
    db_path = _create_db(tmp_path)
    _insert_seeyon_migration_fixture(db_path)

    class Connector:
        def validate(self):
            raise RuntimeError("target endpoint unavailable")

    engine = SourceWorkerEngine(str(db_path), tmp_path)
    monkeypatch.setattr(engine, "_build_connector", lambda source: Connector())
    engine.run_once()

    conn = sqlite3.connect(db_path)
    source = conn.execute("SELECT scope_json, config_revision FROM corpus_sources WHERE id = 'src_seeyon'").fetchone()
    migration = conn.execute("SELECT status, error_summary FROM corpus_source_migrations WHERE id = 'migration_1'").fetchone()
    conn.close()
    assert json.loads(source[0])["endpoint"] == "http://old.intranet"
    assert source[1] == 1
    assert migration[0] == "failed"
    assert "target endpoint unavailable" in migration[1]


def test_normal_sync_runs_are_not_claimed_during_seeyon_url_migration(tmp_path):
    db_path = _create_db(tmp_path)
    _insert_seeyon_migration_fixture(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO sync_runs (
          id, source_id, collection_id, source_config_revision,
          collection_filter_revision, trigger_kind, status, started_at
        ) VALUES ('sync_normal', 'src_seeyon', 'collection_seeyon', 1, 1, 'scheduled', 'queued', ?)
        """,
        ("2026-01-01T00:00:00+00:00",),
    )
    conn.execute("UPDATE corpus_source_migrations SET status = 'syncing' WHERE id = 'migration_1'")
    conn.commit()
    conn.close()

    engine = SourceWorkerEngine(str(db_path), tmp_path)
    assert engine._claim_sync_run() is None


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
