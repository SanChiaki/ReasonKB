import json
import sqlite3
from pathlib import Path

from services.directory_watcher.sync import sync_once


def _schema_sql() -> str:
    repo_root = Path(__file__).resolve().parents[2]
    schema_path = repo_root / "web" / "lib" / "db" / "schema.sql"
    return schema_path.read_text(encoding="utf-8")


def _create_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "app.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_schema_sql())
    conn.close()
    return db_path


def test_sync_once_imports_nested_project_files_and_queues_jobs(tmp_path):
    db_path = _create_db(tmp_path)
    root = tmp_path / "projects"
    (root / "ProjectA" / "delivery").mkdir(parents=True)
    (root / "ProjectA" / "photos").mkdir(parents=True)
    (root / "ProjectB" / "handover").mkdir(parents=True)
    (root / "ProjectA" / "delivery" / "report.md").write_text("# Report", encoding="utf-8")
    (root / "ProjectA" / "photos" / "site.png").write_bytes(b"png")
    (root / "ProjectB" / "handover" / "report.txt").write_text("handover", encoding="utf-8")

    summary = sync_once(str(db_path), root)

    conn = sqlite3.connect(db_path)
    projects = conn.execute("SELECT name FROM projects ORDER BY name").fetchall()
    documents = conn.execute(
        """
        SELECT file_name, source_relative_path, project_relative_path, media_type,
               source_kind, import_status, status
          FROM documents
         ORDER BY source_relative_path
        """
    ).fetchall()
    jobs = conn.execute("SELECT type, status, payload_json FROM jobs ORDER BY created_at").fetchall()
    conn.close()

    assert summary == {"created": 3, "updated": 0, "unchanged": 0, "deleted": 0, "skipped": 0}
    assert projects == [("ProjectA",), ("ProjectB",)]
    assert documents == [
        (
            "report.md",
            "ProjectA/delivery/report.md",
            "delivery/report.md",
            "markdown",
            "directory",
            "imported",
            "uploaded",
        ),
        (
            "site.png",
            "ProjectA/photos/site.png",
            "photos/site.png",
            "image",
            "directory",
            "imported",
            "uploaded",
        ),
        (
            "report.txt",
            "ProjectB/handover/report.txt",
            "handover/report.txt",
            "text",
            "directory",
            "imported",
            "uploaded",
        ),
    ]
    assert [row[0:2] for row in jobs] == [
        ("document_index", "queued"),
        ("document_index", "queued"),
        ("document_index", "queued"),
    ]
    assert all(json.loads(row[2])["documentId"].startswith("doc_") for row in jobs)


def test_sync_once_imports_office_files_and_queues_jobs(tmp_path):
    db_path = _create_db(tmp_path)
    root = tmp_path / "projects"
    (root / "ProjectA" / "office").mkdir(parents=True)
    (root / "ProjectA" / "office" / "scope.docx").write_bytes(b"docx")
    (root / "ProjectA" / "office" / "budget.xls").write_bytes(b"xls")
    (root / "ProjectA" / "office" / "macro.xlsm").write_bytes(b"xlsm")
    (root / "ProjectA" / "office" / "deck.ppt").write_bytes(b"ppt")

    summary = sync_once(str(db_path), root)

    conn = sqlite3.connect(db_path)
    documents = conn.execute(
        """
        SELECT file_name, media_type, import_status, status
          FROM documents
         ORDER BY file_name
        """
    ).fetchall()
    job_count = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    conn.close()

    assert summary == {"created": 4, "updated": 0, "unchanged": 0, "deleted": 0, "skipped": 0}
    assert documents == [
        ("budget.xls", "office", "imported", "uploaded"),
        ("deck.ppt", "office", "imported", "uploaded"),
        ("macro.xlsm", "office", "imported", "uploaded"),
        ("scope.docx", "office", "imported", "uploaded"),
    ]
    assert job_count == 4


def test_sync_once_requeues_changed_files_and_marks_missing_files_deleted(tmp_path):
    db_path = _create_db(tmp_path)
    root = tmp_path / "projects"
    (root / "ProjectA" / "delivery").mkdir(parents=True)
    report_path = root / "ProjectA" / "delivery" / "report.md"
    delete_path = root / "ProjectA" / "delivery" / "old.txt"
    report_path.write_text("# Report v1", encoding="utf-8")
    delete_path.write_text("old", encoding="utf-8")

    sync_once(str(db_path), root)
    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE jobs SET status = 'completed'")
    original_hash = conn.execute(
        "SELECT content_hash FROM documents WHERE source_relative_path = ?",
        ("ProjectA/delivery/report.md",),
    ).fetchone()[0]
    conn.commit()
    conn.close()

    report_path.write_text("# Report v2", encoding="utf-8")
    delete_path.unlink()
    summary = sync_once(str(db_path), root)

    conn = sqlite3.connect(db_path)
    changed = conn.execute(
        """
        SELECT content_hash, status, import_status
          FROM documents
         WHERE source_relative_path = ?
        """,
        ("ProjectA/delivery/report.md",),
    ).fetchone()
    deleted = conn.execute(
        """
        SELECT status, import_status, deleted_at
          FROM documents
         WHERE source_relative_path = ?
        """,
        ("ProjectA/delivery/old.txt",),
    ).fetchone()
    queued_jobs = conn.execute("SELECT COUNT(*) FROM jobs WHERE status = 'queued'").fetchone()[0]
    conn.close()

    assert summary["updated"] == 1
    assert summary["deleted"] == 1
    assert changed[0] != original_hash
    assert changed[1:] == ("uploaded", "imported")
    assert deleted[0:2] == ("deleted", "deleted")
    assert deleted[2] is not None
    assert queued_jobs == 1


def test_sync_once_marks_unsupported_files_skipped_without_jobs(tmp_path):
    db_path = _create_db(tmp_path)
    root = tmp_path / "projects"
    (root / "ProjectA" / "binaries").mkdir(parents=True)
    (root / "ProjectA" / "binaries" / "archive.zip").write_bytes(b"zip")

    summary = sync_once(str(db_path), root)

    conn = sqlite3.connect(db_path)
    document = conn.execute(
        """
        SELECT media_type, import_status, status, import_error
          FROM documents
         WHERE source_relative_path = ?
        """,
        ("ProjectA/binaries/archive.zip",),
    ).fetchone()
    job_count = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    conn.close()

    assert summary == {"created": 0, "updated": 0, "unchanged": 0, "deleted": 0, "skipped": 1}
    assert document[0:3] == ("unsupported", "skipped", "skipped")
    assert "Unsupported file type" in document[3]
    assert job_count == 0
