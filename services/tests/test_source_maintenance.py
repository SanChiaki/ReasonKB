from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3

from services.source_worker.maintenance import SourceMaintenance


def _schema_sql() -> str:
    return (
        Path(__file__).resolve().parents[2] / "web" / "lib" / "db" / "schema.sql"
    ).read_text(encoding="utf-8")


def _db(tmp_path: Path) -> Path:
    db_path = tmp_path / "app.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_schema_sql())
    conn.close()
    return db_path


def _seed_source(conn: sqlite3.Connection, now: str, purge_after: str | None = None) -> None:
    state = "pending_purge" if purge_after else "active"
    conn.execute(
        """INSERT INTO corpus_sources
           (id, kind, display_name, state, scope_json, config_json, config_revision,
            selection_policy, schedule_mode, max_document_size_bytes, health_state,
            purge_after, created_at, updated_at)
           VALUES ('src_1', 'local', 'Source', ?, '{}', '{}', 1, 'all',
                   'scheduled', 104857600, 'normal', ?, ?, ?)""",
        (state, purge_after, now, now),
    )
    conn.execute(
        """INSERT INTO source_collections
           (id, source_id, identity_key, external_id, display_name, origin,
            registration_state, validation_state, lifecycle_state, selected,
            created_at, updated_at)
           VALUES ('collection_1', 'src_1', 'local:root', 'root', 'Root',
                   'discovered', 'active', 'valid', 'active', 1, ?, ?)""",
        (now, now),
    )
    conn.execute(
        """INSERT INTO projects
           (id, owner_user_id, name, source_id, source_collection_id,
            lifecycle_state, retrieval_eligible, created_at, updated_at)
           VALUES ('proj_1', 'deployment', 'Root', 'src_1', 'collection_1',
                   'active', 1, ?, ?)""",
        (now, now),
    )


def test_purges_source_after_recovery_window_and_removes_converted_artifact(tmp_path):
    now = datetime(2026, 7, 13, tzinfo=timezone.utc)
    db_path = _db(tmp_path)
    converted = tmp_path / "converted"
    remote = tmp_path / "remote"
    converted.mkdir()
    artifact = converted / "doc_1-abcd.pdf"
    artifact.write_bytes(b"%PDF")
    conn = sqlite3.connect(db_path)
    _seed_source(conn, now.isoformat(), (now - timedelta(seconds=1)).isoformat())
    conn.execute(
        """INSERT INTO documents
           (id, project_id, owner_user_id, file_name, storage_path, mime_type,
            file_size, status, source_kind, source_id, source_collection_id,
            lifecycle_state, created_at, updated_at)
           VALUES ('doc_1', 'proj_1', 'deployment', 'a.pdf', '', 'application/pdf',
                   4, 'ready', 'local', 'src_1', 'collection_1', 'active', ?, ?)""",
        (now.isoformat(), now.isoformat()),
    )
    conn.commit()
    conn.close()

    result = SourceMaintenance(str(db_path), converted, remote).run_once(now)

    conn = sqlite3.connect(db_path)
    assert conn.execute("SELECT COUNT(*) FROM corpus_sources").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0
    conn.close()
    assert result["purged_sources"] == 1
    assert not artifact.exists()


def test_purges_missing_index_after_thirty_days_but_keeps_tombstone(tmp_path):
    now = datetime(2026, 7, 13, tzinfo=timezone.utc)
    old = (now - timedelta(days=31)).isoformat()
    db_path = _db(tmp_path)
    conn = sqlite3.connect(db_path)
    _seed_source(conn, old)
    conn.execute(
        """INSERT INTO documents
           (id, project_id, owner_user_id, file_name, storage_path, mime_type,
            file_size, status, source_kind, source_id, source_collection_id,
            lifecycle_state, retrieval_eligible, deleted_at, created_at, updated_at)
           VALUES ('doc_1', 'proj_1', 'deployment', 'a.pdf', '', 'application/pdf',
                   4, 'deleted', 'local', 'src_1', 'collection_1', 'missing', 0,
                   ?, ?, ?)""",
        (old, old, old),
    )
    conn.execute(
        """INSERT INTO document_indexes
           (id, document_id, doc_name, doc_description, structure_json, pages_json,
            index_version, indexed_at, is_current)
           VALUES ('idx_1', 'doc_1', 'a', '', '[]', '[]', 'v1', ?, 0)""",
        (old,),
    )
    conn.commit()
    conn.close()

    result = SourceMaintenance(str(db_path), tmp_path / "converted", tmp_path / "remote").run_once(now)

    conn = sqlite3.connect(db_path)
    assert conn.execute("SELECT COUNT(*) FROM document_indexes").fetchone()[0] == 0
    assert conn.execute("SELECT lifecycle_state FROM documents WHERE id = 'doc_1'").fetchone() == ("missing",)
    conn.close()
    assert result["retired_indexes"] == 1


def test_removes_audit_events_older_than_180_days(tmp_path):
    now = datetime(2026, 7, 13, tzinfo=timezone.utc)
    db_path = _db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """INSERT INTO admin_audit_events
           (id, action, target_type, outcome, created_at)
           VALUES ('old', 'source.create', 'corpus_source', 'success', ?),
                  ('new', 'source.create', 'corpus_source', 'success', ?)""",
        ((now - timedelta(days=181)).isoformat(), now.isoformat()),
    )
    conn.commit()
    conn.close()

    result = SourceMaintenance(str(db_path), tmp_path / "converted", tmp_path / "remote").run_once(now)

    conn = sqlite3.connect(db_path)
    assert conn.execute("SELECT id FROM admin_audit_events").fetchall() == [("new",)]
    conn.close()
    assert result["audit_events"] == 1


def test_file_cleanup_resumes_after_crash_between_database_and_file_purge(tmp_path):
    now = datetime(2026, 7, 13, tzinfo=timezone.utc)
    db_path = _db(tmp_path)
    converted = tmp_path / "converted"
    remote = tmp_path / "remote"
    converted.mkdir()
    artifact = converted / "doc_1-recoverable.pdf"
    artifact.write_bytes(b"%PDF")
    conn = sqlite3.connect(db_path)
    _seed_source(conn, now.isoformat(), (now - timedelta(seconds=1)).isoformat())
    conn.execute(
        """INSERT INTO documents
           (id, project_id, owner_user_id, file_name, storage_path, mime_type,
            file_size, status, source_kind, source_id, source_collection_id,
            lifecycle_state, created_at, updated_at)
           VALUES ('doc_1', 'proj_1', 'deployment', 'a.pdf', '', 'application/pdf',
                   4, 'ready', 'local', 'src_1', 'collection_1', 'active', ?, ?)""",
        (now.isoformat(), now.isoformat()),
    )
    conn.commit()
    conn.close()
    maintenance = SourceMaintenance(str(db_path), converted, remote)

    purged_sources, _ = maintenance._purge_due_sources(now)

    assert purged_sources == 1
    assert artifact.exists()
    conn = sqlite3.connect(db_path)
    assert conn.execute(
        "SELECT purged_at FROM managed_file_purge_queue WHERE path = ?", (str(artifact.resolve()),)
    ).fetchone() == (None,)
    conn.close()

    result = maintenance.run_once(now + timedelta(seconds=1))

    assert result["managed_files"] == 1
    assert not artifact.exists()


def test_lightweight_due_purge_does_not_run_long_term_retention(tmp_path):
    now = datetime(2026, 7, 13, tzinfo=timezone.utc)
    old = (now - timedelta(days=181)).isoformat()
    db_path = _db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO admin_audit_events
          (id, action, target_type, outcome, created_at)
        VALUES ('old', 'source.create', 'corpus_source', 'success', ?)
        """,
        (old,),
    )
    conn.commit()
    conn.close()

    result = SourceMaintenance(
        str(db_path), tmp_path / "converted", tmp_path / "remote"
    ).run_due_purges(now)

    conn = sqlite3.connect(db_path)
    audit_count = conn.execute("SELECT COUNT(*) FROM admin_audit_events").fetchone()[0]
    conn.close()
    assert result["purged_sources"] == 0
    assert audit_count == 1
