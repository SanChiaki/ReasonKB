import sqlite3
from pathlib import Path

import pytest

from services.directory_watcher.smb_sync import sync_smb_once
from services.remote_corpus.models import RemoteCorpusFile, SmbConfig
from services.remote_corpus.smb_source import SmbCorpusSource


def _schema_sql() -> str:
    repo_root = Path(__file__).resolve().parents[2]
    return (repo_root / "web" / "lib" / "db" / "schema.sql").read_text(encoding="utf-8")


def _create_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "app.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_schema_sql())
    conn.close()
    return db_path


class FakeRemoteSource:
    def __init__(self, files=None, exc=None, source_root=""):
        self.files = files or []
        self.exc = exc
        self.fetch_count = 0
        self.source_root = source_root

    def list_files(self):
        if self.exc:
            raise self.exc
        return self.files

    def fetch_file(self, source_relative_path, destination):
        self.fetch_count += 1
        raise AssertionError("metadata sync must not download file contents")


def remote_file(
    path,
    *,
    size=10,
    mtime="2026-07-06T00:00:00+00:00",
    source_root="smb://server/share",
    media_type="markdown",
    mime_type="text/markdown",
):
    file_name = path.rsplit("/", 1)[-1]
    project, rest = path.split("/", 1)
    return RemoteCorpusFile(
        locator=f"{source_root}/{path}",
        project_name=project,
        source_root=source_root,
        source_relative_path=path,
        project_relative_path=rest,
        file_name=file_name,
        media_type=media_type,
        mime_type=mime_type,
        size=size,
        mtime=mtime,
    )


def test_sync_smb_once_creates_documents_from_metadata_without_download(tmp_path):
    db_path = _create_db(tmp_path)
    source = FakeRemoteSource([remote_file("ProjectA/report.md", size=12)])

    summary = sync_smb_once(str(db_path), source)

    conn = sqlite3.connect(db_path)
    document = conn.execute(
        """SELECT file_name, storage_path, source_kind, source_root,
                  source_relative_path, project_relative_path, content_hash,
                  source_mtime, source_size, media_type, status
             FROM documents"""
    ).fetchone()
    jobs = conn.execute("SELECT COUNT(*) FROM jobs WHERE status = 'queued'").fetchone()[0]
    conn.close()

    assert summary == {"created": 1, "updated": 0, "unchanged": 0, "deleted": 0, "skipped": 0}
    assert document[0:6] == (
        "report.md",
        "smb://server/share/ProjectA/report.md",
        "smb",
        "smb://server/share",
        "ProjectA/report.md",
        "report.md",
    )
    assert document[6].startswith("smb-meta:")
    assert document[7:11] == ("2026-07-06T00:00:00+00:00", 12, "markdown", "uploaded")
    assert jobs == 1
    assert source.fetch_count == 0


def test_sync_smb_once_uses_mtime_and_size_for_change_detection(tmp_path):
    db_path = _create_db(tmp_path)
    sync_smb_once(str(db_path), FakeRemoteSource([remote_file("ProjectA/report.md", size=12)]))
    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE jobs SET status = 'completed'")
    original_hash = conn.execute("SELECT content_hash FROM documents").fetchone()[0]
    conn.commit()
    conn.close()

    summary = sync_smb_once(
        str(db_path),
        FakeRemoteSource([remote_file("ProjectA/report.md", size=13, mtime="2026-07-06T00:01:00+00:00")]),
    )

    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT content_hash, source_size, status FROM documents").fetchone()
    queued = conn.execute("SELECT COUNT(*) FROM jobs WHERE status = 'queued'").fetchone()[0]
    conn.close()

    assert summary["updated"] == 1
    assert row[0] != original_hash
    assert row[1:] == (13, "uploaded")
    assert queued == 1


def test_sync_smb_once_does_not_requeue_when_indexer_replaces_smb_content_hash(tmp_path):
    db_path = _create_db(tmp_path)
    source_file = remote_file("ProjectA/report.md", size=12)
    sync_smb_once(str(db_path), FakeRemoteSource([source_file]))
    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE jobs SET status = 'completed'")
    conn.execute("UPDATE documents SET content_hash = 'sha256:downloaded-content'")
    conn.commit()
    conn.close()

    summary = sync_smb_once(str(db_path), FakeRemoteSource([source_file]))

    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT content_hash, source_size, status FROM documents").fetchone()
    queued = conn.execute("SELECT COUNT(*) FROM jobs WHERE status = 'queued'").fetchone()[0]
    conn.close()

    assert summary == {"created": 0, "updated": 0, "unchanged": 1, "deleted": 0, "skipped": 0}
    assert row == ("sha256:downloaded-content", 12, "uploaded")
    assert queued == 0


def test_sync_smb_once_marks_unsupported_files_skipped_without_jobs(tmp_path):
    db_path = _create_db(tmp_path)
    source = FakeRemoteSource(
        [
            remote_file(
                "ProjectA/archive.zip",
                media_type="unsupported",
                mime_type="application/zip",
            )
        ],
        source_root="smb://server/share",
    )

    summary = sync_smb_once(str(db_path), source)

    conn = sqlite3.connect(db_path)
    document = conn.execute(
        """
        SELECT media_type, import_status, status, import_error
          FROM documents
         WHERE source_relative_path = ?
        """,
        ("ProjectA/archive.zip",),
    ).fetchone()
    job_count = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    conn.close()

    assert summary == {"created": 0, "updated": 0, "unchanged": 0, "deleted": 0, "skipped": 1}
    assert document[0:3] == ("unsupported", "skipped", "skipped")
    assert "Unsupported file type" in document[3]
    assert job_count == 0


def test_failed_smb_scan_does_not_delete_existing_documents(tmp_path):
    db_path = _create_db(tmp_path)
    sync_smb_once(str(db_path), FakeRemoteSource([remote_file("ProjectA/report.md")]))

    with pytest.raises(ConnectionError):
        sync_smb_once(str(db_path), FakeRemoteSource(exc=ConnectionError("server unreachable")))

    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT status, deleted_at FROM documents").fetchone()
    conn.close()
    assert row == ("uploaded", None)


class EmptySmbClient:
    def register_session(self, *args, **kwargs):
        return None

    def scandir(self, remote_path, **kwargs):
        return []


def test_empty_successful_smb_scan_marks_existing_documents_deleted_when_source_root_is_exposed(tmp_path):
    db_path = _create_db(tmp_path)
    sync_smb_once(str(db_path), FakeRemoteSource([remote_file("ProjectA/report.md")]))

    source = SmbCorpusSource(
        SmbConfig(host="server", share="share"),
        smbclient_module=EmptySmbClient(),
    )
    summary = sync_smb_once(str(db_path), source)

    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT status, import_status, deleted_at FROM documents").fetchone()
    conn.close()

    assert summary["deleted"] == 1
    assert row[0:2] == ("deleted", "deleted")
    assert row[2] is not None


def test_empty_smb_scan_only_deletes_projects_for_matching_source_root(tmp_path):
    db_path = _create_db(tmp_path)
    sync_smb_once(
        str(db_path),
        FakeRemoteSource(
            [remote_file("ProjectA/report.md", source_root="smb://server/share-a")],
            source_root="smb://server/share-a",
        ),
    )
    sync_smb_once(
        str(db_path),
        FakeRemoteSource(
            [remote_file("ProjectB/report.md", source_root="smb://server/share-b")],
            source_root="smb://server/share-b",
        ),
    )

    summary = sync_smb_once(str(db_path), FakeRemoteSource(source_root="smb://server/share-a"))

    conn = sqlite3.connect(db_path)
    projects = conn.execute(
        """
        SELECT p.name, p.deleted_at, d.status, d.deleted_at
          FROM projects p
          JOIN documents d ON d.project_id = p.id
         ORDER BY p.name
        """
    ).fetchall()
    conn.close()

    assert summary["deleted"] == 1
    assert projects[0][0] == "ProjectA"
    assert projects[0][1] is not None
    assert projects[0][2] == "deleted"
    assert projects[0][3] is not None
    assert projects[1] == ("ProjectB", None, "uploaded", None)
