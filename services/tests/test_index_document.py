from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from services.common.sqlite_store import open_db
from services.common.system_settings import get_index_worker_concurrency
from services.index_worker.index_document import process_document_job
from services.index_worker import index_document
from services.index_worker.remote_fetch import (
    RemoteFetchError,
    _source_cache_file_name,
    prepared_index_file,
)
from services.index_worker.worker import (
    INDEX_JOB_TIMEOUT_SECONDS,
    INDEX_WORKER_CONCURRENCY,
    ActiveDocumentJob,
    collect_finished_jobs,
    claim_next_job,
    fail_orphaned_running_jobs,
    fail_document_job,
    run_document_job_with_timeout,
    start_queued_jobs,
    sweep_stale_running_runs,
)


def _schema_sql() -> str:
    repo_root = Path(__file__).resolve().parents[2]
    schema_path = repo_root / "web" / "lib" / "db" / "schema.sql"
    return schema_path.read_text(encoding="utf-8")


def _seed_single_document_job_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "app.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_schema_sql())

    conn.execute(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ("proj_1", "user_demo", "Alpha", "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z"),
    )
    conn.execute(
        """INSERT INTO documents
           (id, project_id, owner_user_id, file_name, storage_path, mime_type, file_size, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            "doc_1",
            "proj_1",
            "user_demo",
            "alpha.pdf",
            str(tmp_path / "alpha.pdf"),
            "application/pdf",
            100,
            "indexing",
            "2026-04-19T00:00:00Z",
            "2026-04-19T00:00:00Z",
        ),
    )
    conn.execute(
        """INSERT INTO jobs
           (id, type, document_id, payload_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            "job_1",
            "document_index",
            "doc_1",
            json.dumps({"documentId": "doc_1"}),
            "running",
            "2026-04-19T00:00:00Z",
            "2026-04-19T00:00:00Z",
        ),
    )
    conn.commit()
    conn.close()
    return db_path


def _seed_queued_document_jobs_db(tmp_path: Path, count: int) -> Path:
    db_path = tmp_path / "app.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_schema_sql())
    conn.execute(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ("proj_1", "user_demo", "Alpha", "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z"),
    )
    for index in range(count):
        suffix = index + 1
        created_at = f"2026-04-19T00:00:{suffix:02d}Z"
        document_id = f"doc_{suffix}"
        conn.execute(
            """INSERT INTO documents
               (id, project_id, owner_user_id, file_name, storage_path, mime_type, file_size, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                document_id,
                "proj_1",
                "user_demo",
                f"doc-{suffix}.pdf",
                str(tmp_path / f"doc-{suffix}.pdf"),
                "application/pdf",
                100 + suffix,
                "uploaded",
                created_at,
                created_at,
            ),
        )
        conn.execute(
            """INSERT INTO jobs
               (id, type, document_id, payload_json, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                f"job_{suffix}",
                "document_index",
                document_id,
                json.dumps({"documentId": document_id}),
                "queued",
                created_at,
                created_at,
            ),
        )
    conn.commit()
    conn.close()
    return db_path


def test_process_document_job_marks_document_ready(tmp_path, monkeypatch):
    db_path = _seed_single_document_job_db(tmp_path)

    monkeypatch.setattr(
        "services.index_worker.index_document.build_pageindex_payload",
        lambda file_path: {
            "doc_name": "alpha.pdf",
            "doc_description": "Alpha test document",
            "structure": [{"title": "Intro", "node_id": "0001", "start_index": 1, "end_index": 1, "summary": "Intro"}],
            "pages": [{"page": 1, "content": "hello"}],
            "page_count": 1,
        },
    )

    process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    status = conn.execute("SELECT status, page_count FROM documents WHERE id = 'doc_1'").fetchone()
    index_row = conn.execute("SELECT doc_name, doc_description FROM document_indexes WHERE document_id = 'doc_1'").fetchone()
    job_status = conn.execute("SELECT status FROM jobs WHERE id = 'job_1'").fetchone()
    conn.close()

    assert status == ("ready", 1)
    assert index_row == ("alpha.pdf", "Alpha test document")
    assert job_status == ("completed",)


def test_process_document_job_records_completed_index_run(tmp_path, monkeypatch):
    db_path = _seed_single_document_job_db(tmp_path)

    monkeypatch.setattr(
        "services.index_worker.index_document.build_pageindex_payload",
        lambda file_path, document=None: {
            "doc_name": "alpha.pdf",
            "doc_description": "Alpha test document",
            "structure": [{"title": "Intro", "node_id": "0001", "start_index": 1, "end_index": 1, "summary": "Intro"}],
            "pages": [{"page": 1, "content": "hello"}],
            "page_count": 1,
            "evidence_kind": "pdf_text",
            "visual_assets": [],
            "source_metadata": {"sourceRelativePath": "Alpha/alpha.pdf"},
            "index_version": "v2-layout",
            "page_blocks": [
                {
                    "page": 1,
                    "layout_status": "structured",
                    "blocks": [{"type": "table", "schemaVersion": "TableBlockV1"}],
                    "diagnostics": {"tableCount": 1},
                }
            ],
        },
    )

    process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    run = conn.execute(
        """
        SELECT status, duration_ms, llm_call_count, total_tokens, token_source
          FROM document_index_runs
         WHERE document_id = 'doc_1'
        """
    ).fetchone()
    document_metrics = conn.execute(
        """
        SELECT last_index_duration_ms, last_index_total_tokens,
               last_index_llm_call_count, last_indexed_at
          FROM documents
         WHERE id = 'doc_1'
        """
    ).fetchone()
    index_metadata = conn.execute(
        """
        SELECT evidence_kind, visual_assets_json, source_metadata_json, index_version
          FROM document_indexes
         WHERE document_id = 'doc_1'
        """
    ).fetchone()
    page_blocks = conn.execute(
        """
        SELECT page_number, layout_status, blocks_json, diagnostics_json
          FROM document_page_blocks
         WHERE document_index_id = 'idx_doc_1'
        """
    ).fetchone()
    conn.close()

    assert run[0] == "completed"
    assert run[1] >= 0
    assert run[2:] == (0, 0, "estimated")
    assert document_metrics[0] == run[1]
    assert document_metrics[1:3] == (0, 0)
    assert document_metrics[3] is not None
    assert index_metadata[0] == "pdf_text"
    assert json.loads(index_metadata[1]) == []
    assert json.loads(index_metadata[2]) == {"sourceRelativePath": "Alpha/alpha.pdf"}
    assert index_metadata[3] == "v2-layout"
    assert page_blocks[:2] == (1, "structured")
    assert json.loads(page_blocks[2]) == [
        {"type": "table", "schemaVersion": "TableBlockV1"}
    ]
    assert json.loads(page_blocks[3]) == {"tableCount": 1}


def test_extract_pdf_pages_only_projects_structured_pages_in_html_mode(monkeypatch):
    legacy_pages = [
        {"page": 1, "content": "legacy table text"},
        {"page": 2, "content": "legacy ambiguous text"},
    ]
    monkeypatch.setattr(
        index_document,
        "extract_pdf_layout",
        lambda _path: {
            "extractor": "pymupdf",
            "extractor_version": "1.26.4",
            "pages": [
                {
                    "page": 1,
                    "content": "<table><tr><td>3000</td></tr></table>",
                    "layout_status": "structured",
                    "blocks": [{"type": "table"}],
                    "diagnostics": {"tableCount": 1, "warnings": []},
                },
                {
                    "page": 2,
                    "content": "uncertain projection",
                    "layout_status": "ambiguous",
                    "blocks": [{"type": "text"}],
                    "diagnostics": {"tableCount": 1, "warnings": ["uncertain"]},
                },
            ],
        },
    )

    html_pages, page_blocks, metadata = index_document._extract_pdf_pages(
        "/tmp/policy.pdf",
        legacy_pages,
        "html",
    )
    detect_pages, _, _ = index_document._extract_pdf_pages(
        "/tmp/policy.pdf",
        legacy_pages,
        "detect",
    )

    assert html_pages == [
        {"page": 1, "content": "<table><tr><td>3000</td></tr></table>"},
        {"page": 2, "content": "legacy ambiguous text"},
    ]
    assert detect_pages == legacy_pages
    assert [page["layout_status"] for page in page_blocks] == [
        "structured",
        "ambiguous",
    ]
    assert metadata["pdfStructuredPageCount"] == 1


def test_process_document_job_indexes_plain_text_document(tmp_path):
    db_path = _seed_single_document_job_db(tmp_path)
    text_path = tmp_path / "notes.txt"
    text_path.write_text("Delivery scope\nAcceptance evidence", encoding="utf-8")

    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE documents
           SET file_name = ?, storage_path = ?, mime_type = ?, media_type = ?
         WHERE id = 'doc_1'
        """,
        ("notes.txt", str(text_path), "text/plain", "text"),
    )
    conn.commit()
    conn.close()

    process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    row = conn.execute(
        """
        SELECT di.doc_name, di.doc_description, di.structure_json, di.pages_json,
               di.evidence_kind, d.status, d.page_count
          FROM document_indexes di
          JOIN documents d ON d.id = di.document_id
         WHERE di.document_id = 'doc_1'
        """
    ).fetchone()
    conn.close()

    structure = json.loads(row[2])
    pages = json.loads(row[3])
    assert row[0] == "notes.txt"
    assert "notes.txt" in row[1]
    assert structure[0]["title"] == "notes.txt"
    assert pages == [{"page": 1, "content": "Delivery scope\nAcceptance evidence"}]
    assert row[4:] == ("text", "ready", 1)


def test_process_document_job_indexes_markdown_document_without_llm(tmp_path):
    db_path = _seed_single_document_job_db(tmp_path)
    markdown_path = tmp_path / "handover.md"
    markdown_path.write_text(
        "# Handover\n\nAcceptance evidence\n\n## Checklist\n\n- Signed report",
        encoding="utf-8",
    )

    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE documents
           SET file_name = ?, storage_path = ?, mime_type = ?, media_type = ?
         WHERE id = 'doc_1'
        """,
        ("handover.md", str(markdown_path), "text/markdown", "markdown"),
    )
    conn.commit()
    conn.close()

    process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    row = conn.execute(
        """
        SELECT di.doc_name, di.doc_description, di.structure_json,
               di.pages_json, di.evidence_kind
          FROM document_indexes di
         WHERE di.document_id = 'doc_1'
        """
    ).fetchone()
    run = conn.execute(
        "SELECT status, llm_call_count FROM document_index_runs WHERE document_id = 'doc_1'"
    ).fetchone()
    conn.close()

    structure = json.loads(row[2])
    pages = json.loads(row[3])
    assert row[0] == "handover"
    assert "handover.md" in row[1]
    assert structure[0]["title"] == "Handover"
    assert pages[0]["content"].startswith("# Handover")
    assert row[4] == "markdown_text"
    assert run == ("completed", 0)


def test_process_document_job_fetches_smb_file_before_indexing(tmp_path, monkeypatch):
    db_path = _seed_single_document_job_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE documents
           SET file_name = ?, storage_path = ?, source_kind = ?, source_root = ?,
               source_relative_path = ?, project_relative_path = ?, media_type = ?,
               content_hash = ?, source_mtime = ?, source_size = ?
         WHERE id = 'doc_1'
        """,
        (
            "remote.md",
            "smb://server/share/Alpha/remote.md",
            "smb",
            "smb://server/share",
            "Alpha/remote.md",
            "remote.md",
            "markdown",
            "smb-meta:old",
            "2026-07-06T00:00:00+00:00",
            11,
        ),
    )
    conn.commit()
    conn.close()

    fetched_paths = []

    def fake_fetch(document, destination):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("# Remote", encoding="utf-8")
        fetched_paths.append(destination)
        return "sha256:realhash"

    monkeypatch.setattr("services.index_worker.remote_fetch.fetch_smb_document", fake_fetch)
    monkeypatch.setattr(
        "services.index_worker.index_document.build_pageindex_payload",
        lambda file_path, document=None: {
            "doc_name": Path(file_path).name,
            "doc_description": document["content_hash"],
            "structure": [{"title": "Remote"}],
            "pages": [{"page": 1, "content": Path(file_path).read_text(encoding="utf-8")}],
            "page_count": 1,
            "evidence_kind": "markdown_text",
            "visual_assets": [],
            "source_metadata": {"contentHash": document["content_hash"]},
        },
    )

    process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    document_hash = conn.execute("SELECT content_hash FROM documents WHERE id = 'doc_1'").fetchone()[0]
    description = conn.execute("SELECT doc_description FROM document_indexes WHERE document_id = 'doc_1'").fetchone()[0]
    conn.close()

    assert fetched_paths
    assert document_hash == "sha256:realhash"
    assert description == "sha256:realhash"


def test_process_document_job_fails_smb_download_without_leaking_password(tmp_path, monkeypatch):
    db_path = _seed_single_document_job_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE documents
           SET storage_path = ?, source_kind = ?, source_root = ?,
               source_relative_path = ?, media_type = ?
         WHERE id = 'doc_1'
        """,
        ("smb://server/share/Alpha/remote.md", "smb", "smb://server/share", "Alpha/remote.md", "markdown"),
    )
    conn.commit()
    conn.close()

    def fake_fetch(document, destination):
        raise RuntimeError("bad password super-secret")

    monkeypatch.setattr("services.index_worker.remote_fetch.fetch_smb_document", fake_fetch)

    with pytest.raises(RuntimeError, match="SMB download failed"):
        process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    run_error = conn.execute("SELECT error_message FROM document_index_runs WHERE document_id = 'doc_1'").fetchone()[0]
    conn.close()
    assert "Alpha/remote.md" in run_error
    assert "super-secret" not in run_error
    assert "password" not in run_error.lower()


def test_process_document_job_preserves_llm_error_after_source_download(tmp_path, monkeypatch):
    db_path = _seed_single_document_job_db(tmp_path)
    now = "2026-04-19T00:00:00Z"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """INSERT INTO corpus_sources
           (id, kind, display_name, state, scope_json, config_json, config_revision,
            selection_policy, schedule_mode, max_document_size_bytes, health_state,
            created_at, updated_at)
           VALUES ('src_1', 'local', 'Source', 'active', '{}', '{}', 1,
                   'all', 'scheduled', 104857600, 'normal', ?, ?)""",
        (now, now),
    )
    conn.execute(
        """INSERT INTO source_collections
           (id, source_id, identity_key, external_id, display_name, origin,
            registration_state, validation_state, lifecycle_state, selected,
            created_at, updated_at)
           VALUES ('collection_1', 'src_1', 'local:root', 'root', 'Root', 'discovered',
                   'active', 'valid', 'active', 1, ?, ?)""",
        (now, now),
    )
    conn.execute(
        """INSERT INTO source_items
           (id, source_id, collection_id, external_id, item_type, name, relative_path,
            source_revision, fetch_locator, lifecycle_state, metadata_json, document_id,
            created_at, updated_at)
           VALUES ('item_1', 'src_1', 'collection_1', 'remote-alpha', 'document',
                   'alpha.pdf', 'alpha.pdf', 'r1', 'alpha.pdf', 'active', '{}',
                   'doc_1', ?, ?)""",
        (now, now),
    )
    conn.execute(
        """UPDATE projects SET source_id = 'src_1', source_collection_id = 'collection_1',
                   lifecycle_state = 'active' WHERE id = 'proj_1'"""
    )
    conn.execute(
        """UPDATE documents SET source_id = 'src_1', source_collection_id = 'collection_1',
                   source_item_id = 'item_1', source_revision = 'r1',
                   expected_source_revision = 'r1', expected_source_config_revision = 1,
                   lifecycle_state = 'active' WHERE id = 'doc_1'"""
    )
    conn.execute(
        """UPDATE jobs SET source_id = 'src_1', source_collection_id = 'collection_1',
                   expected_source_revision = 'r1', expected_source_config_revision = 1
             WHERE id = 'job_1'"""
    )
    conn.commit()
    conn.close()

    cache_root = tmp_path / "remote-cache"
    monkeypatch.setattr("services.index_worker.remote_fetch.REMOTE_CACHE_ROOT", cache_root)

    class FakeConnector:
        def fetch_item(self, metadata, destination, expected_revision, max_size_bytes):
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(b"downloaded pdf")

    monkeypatch.setattr(
        "services.index_worker.remote_fetch.build_connector",
        lambda source, local_root, credentials: FakeConnector(),
    )

    def fail_pageindex(file_path, document=None):
        assert Path(file_path).read_bytes() == b"downloaded pdf"
        raise RuntimeError("OPENAI_API_KEY is not configured")

    monkeypatch.setattr(
        "services.index_worker.index_document.build_pageindex_payload",
        fail_pageindex,
    )

    with pytest.raises(RuntimeError, match="^OPENAI_API_KEY is not configured$"):
        process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    run = conn.execute(
        "SELECT status, error_message FROM document_index_runs WHERE document_id = 'doc_1'"
    ).fetchone()
    conn.close()

    assert run == ("failed", "OPENAI_API_KEY is not configured")
    assert not (cache_root / "doc_1").exists()


def test_prepared_index_file_rejects_smb_source_root_mismatch_without_fetching(tmp_path, monkeypatch):
    fetch_calls = []

    class FakeSmbSource:
        source_root = "smb://server/share-b"

        def __init__(self, config):
            self.config = config

        def fetch_file(self, source_relative_path, destination):
            fetch_calls.append((source_relative_path, destination))
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text("# Wrong share", encoding="utf-8")

    monkeypatch.setattr("services.index_worker.remote_fetch.SmbCorpusSource", FakeSmbSource)
    monkeypatch.setattr("services.index_worker.remote_fetch.REMOTE_CACHE_ROOT", tmp_path / "remote-cache")
    document = {
        "document_id": "doc_remote",
        "source_kind": "smb",
        "source_root": "smb://server/share-a",
        "source_relative_path": "Alpha/remote.md",
        "storage_path": "smb://server/share-a/Alpha/remote.md",
        "file_name": "remote.md",
    }

    with pytest.raises(RemoteFetchError, match="SMB download failed for Alpha/remote.md"):
        with prepared_index_file(document):
            raise AssertionError("source root mismatch should fail before yielding")

    assert fetch_calls == []


def test_source_cache_file_name_preserves_original_extension_for_opaque_source_id():
    assert _source_cache_file_name(
        {
            "file_name": "doc_mine_type.xlsx",
            "project_relative_path": "Documents/doc_mine_type.xlsx",
            "source_relative_path": "5594372999647937129",
        }
    ) == "doc_mine_type.xlsx"


def test_process_document_job_indexes_office_document_via_converted_pdf(tmp_path, monkeypatch):
    db_path = _seed_single_document_job_db(tmp_path)
    office_path = tmp_path / "scope.docx"
    office_path.write_bytes(b"office body")
    converted_pdf = tmp_path / "converted" / "doc_1.pdf"

    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE documents
           SET file_name = ?, storage_path = ?, mime_type = ?, media_type = ?
         WHERE id = 'doc_1'
        """,
        (
            "scope.docx",
            str(office_path),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "office",
        ),
    )
    conn.commit()
    conn.close()

    def fake_convert(file_path, document):
        assert file_path == str(office_path)
        assert document["document_id"] == "doc_1"
        converted_pdf.parent.mkdir(parents=True, exist_ok=True)
        converted_pdf.write_bytes(b"%PDF-1.7\nconverted")
        return str(converted_pdf)

    def fake_pdf_payload(file_path, document):
        assert file_path == str(converted_pdf)
        return {
            "doc_name": "doc_1.pdf",
            "doc_description": "Converted Office evidence",
            "structure": [
                {
                    "title": "Scope",
                    "node_id": "0001",
                    "start_index": 2,
                    "end_index": 2,
                    "summary": "Acceptance evidence",
                }
            ],
            "pages": [{"page": 2, "content": "Acceptance evidence"}],
            "page_count": 2,
            "evidence_kind": "pdf_text",
            "visual_assets": [],
            "source_metadata": {"converted": True},
        }

    monkeypatch.setattr(
        "services.index_worker.index_document.convert_office_to_pdf",
        fake_convert,
    )
    monkeypatch.setattr(
        "services.index_worker.index_document._build_pdf_payload",
        fake_pdf_payload,
    )

    process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    row = conn.execute(
        """
        SELECT di.doc_name, di.evidence_kind, di.source_metadata_json,
               d.status, d.page_count
          FROM document_indexes di
          JOIN documents d ON d.id = di.document_id
         WHERE di.document_id = 'doc_1'
        """
    ).fetchone()
    conn.close()

    metadata = json.loads(row[2])
    assert row[0] == "doc_1.pdf"
    assert row[1] == "office_pdf_text"
    assert metadata["sourceFileName"] == "scope.docx"
    assert metadata["sourceMediaType"] == "office"
    assert metadata["evidencePdfPath"] == str(converted_pdf)
    assert row[3:] == ("ready", 2)


def test_process_document_job_skips_image_without_vision_model(tmp_path, monkeypatch):
    db_path = _seed_single_document_job_db(tmp_path)
    image_path = tmp_path / "site.png"
    image_path.write_bytes(b"not-a-real-image")

    monkeypatch.delenv("VISION_MODEL", raising=False)
    monkeypatch.setenv("VISION_EXTRACTION_ENABLED", "true")

    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE documents
           SET file_name = ?, storage_path = ?, mime_type = ?, media_type = ?
         WHERE id = 'doc_1'
        """,
        ("site.png", str(image_path), "image/png", "image"),
    )
    conn.commit()
    conn.close()

    process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    document = conn.execute(
        "SELECT status, error_message, import_status, import_error FROM documents WHERE id = 'doc_1'"
    ).fetchone()
    job = conn.execute("SELECT status, error_message FROM jobs WHERE id = 'job_1'").fetchone()
    run = conn.execute(
        "SELECT status, total_tokens, error_message FROM document_index_runs WHERE document_id = 'doc_1'"
    ).fetchone()
    index_count = conn.execute(
        "SELECT COUNT(*) FROM document_indexes WHERE document_id = 'doc_1'"
    ).fetchone()[0]
    conn.close()

    expected_error = "Image indexing requires VISION_EXTRACTION_ENABLED=true and VISION_MODEL to be configured."
    assert document[0] == "skipped"
    assert document[1] == expected_error
    assert document[2] == "skipped"
    assert document[3] == expected_error
    assert job == ("completed", None)
    assert run[0] == "skipped"
    assert run[1] == 0
    assert run[2] == expected_error
    assert index_count == 0


def test_process_document_job_reindex_is_idempotent_for_same_document(tmp_path, monkeypatch):
    db_path = _seed_single_document_job_db(tmp_path)
    payloads = iter(
        [
            {
                "doc_name": "alpha-v1.pdf",
                "doc_description": "Alpha test document v1",
                "structure": [{"title": "Intro"}],
                "pages": [{"page": 1, "content": "hello"}],
                "page_count": 1,
            },
            {
                "doc_name": "alpha-v2.pdf",
                "doc_description": "Alpha test document v2",
                "structure": [{"title": "Updated"}],
                "pages": [{"page": 1, "content": "hello again"}],
                "page_count": 1,
            },
        ]
    )
    monkeypatch.setattr(
        "services.index_worker.index_document.build_pageindex_payload",
        lambda file_path: next(payloads),
    )

    process_document_job(str(db_path), "job_1")
    conn = sqlite3.connect(db_path)
    conn.execute(
        "UPDATE jobs SET status = 'running', progress = 50, error_message = 'old error', finished_at = NULL WHERE id = 'job_1'"
    )
    conn.execute(
        "UPDATE documents SET status = 'indexing', error_message = 'stale doc error' WHERE id = 'doc_1'"
    )
    conn.commit()
    conn.close()
    process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    row_count = conn.execute("SELECT COUNT(*) FROM document_indexes WHERE document_id = 'doc_1'").fetchone()[0]
    index_row = conn.execute(
        "SELECT doc_name, doc_description FROM document_indexes WHERE document_id = 'doc_1'"
    ).fetchone()
    job_row = conn.execute("SELECT status, error_message, finished_at FROM jobs WHERE id = 'job_1'").fetchone()
    document_row = conn.execute("SELECT status, error_message FROM documents WHERE id = 'doc_1'").fetchone()
    conn.close()

    assert row_count == 1
    assert index_row == ("alpha-v2.pdf", "Alpha test document v2")
    assert job_row[0] == "completed"
    assert job_row[1] is None
    assert job_row[2] is not None
    assert document_row == ("ready", None)


def test_process_document_job_updates_legacy_index_row_with_same_document_id(tmp_path, monkeypatch):
    db_path = _seed_single_document_job_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO document_indexes (
          id, document_id, doc_name, doc_description, structure_json,
          pages_json, index_version, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "legacy_idx_1",
            "doc_1",
            "legacy-name.pdf",
            "legacy description",
            json.dumps([{"title": "Legacy"}]),
            json.dumps([{"page": 1, "content": "legacy"}]),
            "v0",
            "2026-04-19T00:00:00Z",
        ),
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(
        "services.index_worker.index_document.build_pageindex_payload",
        lambda file_path: {
            "doc_name": "alpha-new.pdf",
            "doc_description": "new description",
            "structure": [{"title": "Updated"}],
            "pages": [{"page": 1, "content": "new"}],
            "page_count": 1,
        },
    )

    process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    row_count = conn.execute("SELECT COUNT(*) FROM document_indexes WHERE document_id = 'doc_1'").fetchone()[0]
    index_row = conn.execute(
        "SELECT id, doc_name, doc_description FROM document_indexes WHERE document_id = 'doc_1'"
    ).fetchone()
    conn.close()

    assert row_count == 1
    assert index_row == ("legacy_idx_1", "alpha-new.pdf", "new description")


def test_process_document_job_requires_running_document_index_job(tmp_path):
    db_path = _seed_single_document_job_db(tmp_path)

    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE jobs SET type = 'other_job', status = 'queued' WHERE id = 'job_1'")
    conn.commit()
    conn.close()

    try:
        process_document_job(str(db_path), "job_1")
    except ValueError as exc:
        assert "not found" in str(exc)
    else:
        raise AssertionError("expected ValueError for non-running document_index job")


def test_claim_next_job_claims_queued_jobs_in_order(tmp_path):
    db_path = _seed_queued_document_jobs_db(tmp_path, 2)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """INSERT INTO jobs
           (id, type, document_id, payload_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            "job_3",
            "other_job",
            "doc_2",
            json.dumps({"documentId": "doc_2"}),
            "queued",
            "2026-04-19T00:00:03Z",
            "2026-04-19T00:00:03Z",
        ),
    )
    conn.commit()
    conn.close()

    first = claim_next_job(str(db_path))
    second = claim_next_job(str(db_path))
    third = claim_next_job(str(db_path))

    conn = sqlite3.connect(db_path)
    rows = conn.execute("SELECT id, status, progress FROM jobs ORDER BY id").fetchall()
    doc_rows = conn.execute("SELECT id, status FROM documents ORDER BY id").fetchall()
    conn.close()

    assert first == "job_1"
    assert second == "job_2"
    assert third is None
    assert rows == [
        ("job_1", "running", 5),
        ("job_2", "running", 5),
        ("job_3", "queued", 0),
    ]
    assert doc_rows == [("doc_1", "indexing"), ("doc_2", "indexing")]


def test_claim_next_job_does_not_duplicate_concurrent_claims(tmp_path):
    db_path = _seed_queued_document_jobs_db(tmp_path, 8)

    with ThreadPoolExecutor(max_workers=8) as executor:
        claimed = list(executor.map(lambda _: claim_next_job(str(db_path)), range(8)))

    conn = sqlite3.connect(db_path)
    running_jobs = conn.execute(
        "SELECT id FROM jobs WHERE status = 'running' ORDER BY id"
    ).fetchall()
    conn.close()

    assert sorted(claimed) == [f"job_{index}" for index in range(1, 9)]
    assert [row[0] for row in running_jobs] == [f"job_{index}" for index in range(1, 9)]


def test_start_queued_jobs_respects_available_slots(monkeypatch):
    claimed_jobs = iter(["job_1", "job_2", "job_3"])
    started = []

    monkeypatch.setattr(
        "services.index_worker.worker.claim_next_job",
        lambda db_path: next(claimed_jobs, None),
    )

    class FakeProcess:
        def __init__(self, job_id):
            self.job_id = job_id

    def fake_start(db_path, job_id):
        started.append(job_id)
        return FakeProcess(job_id)

    monkeypatch.setattr("services.index_worker.worker.start_document_job", fake_start)

    active_jobs = {"job_existing": FakeProcess("job_existing")}

    assert start_queued_jobs("app.db", active_jobs, concurrency=3) == 2
    assert list(active_jobs.keys()) == ["job_existing", "job_1", "job_2"]
    assert started == ["job_1", "job_2"]


def test_start_queued_jobs_uses_updated_concurrency_for_same_source_queue(
    tmp_path,
    monkeypatch,
):
    db_path = _seed_queued_document_jobs_db(tmp_path, 3)
    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE projects SET source_id = 'source_1'")
    conn.execute("UPDATE documents SET source_id = 'source_1'")
    conn.execute("UPDATE jobs SET source_id = 'source_1'")
    conn.execute(
        "INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
        ("indexWorkerConcurrency", "1", "2026-04-19T00:01:00Z"),
    )
    conn.commit()

    started = []

    def fake_start(db_path, job_id):
        started.append(job_id)
        return SimpleNamespace(job_id=job_id)

    monkeypatch.setattr("services.index_worker.worker.start_document_job", fake_start)

    active_jobs = {}
    initial_concurrency = get_index_worker_concurrency(str(db_path), default=1)

    assert initial_concurrency == 1
    assert start_queued_jobs(
        str(db_path),
        active_jobs,
        concurrency=initial_concurrency,
    ) == 1
    assert list(active_jobs) == ["job_1"]

    conn.execute(
        "UPDATE system_settings SET value_json = ?, updated_at = ? WHERE key = ?",
        ("3", "2026-04-19T00:02:00Z", "indexWorkerConcurrency"),
    )
    conn.commit()
    conn.close()

    runtime_concurrency = get_index_worker_concurrency(str(db_path), default=1)

    assert runtime_concurrency == 3
    assert start_queued_jobs(
        str(db_path),
        active_jobs,
        concurrency=runtime_concurrency,
    ) == 2
    assert list(active_jobs) == ["job_1", "job_2", "job_3"]
    assert started == ["job_1", "job_2", "job_3"]


def test_collect_finished_jobs_records_child_exception_message(tmp_path):
    db_path = _seed_single_document_job_db(tmp_path)

    class FakeQueue:
        def get(self, timeout=None):
            return ("ValueError", "bad document")

    class FakeProcess:
        exitcode = 1

        def join(self, timeout=None):
            return None

        def is_alive(self):
            return False

    active_jobs = {
        "job_1": ActiveDocumentJob(
            process=FakeProcess(),
            error_queue=FakeQueue(),
            started_at=0,
        )
    }

    assert collect_finished_jobs(str(db_path), active_jobs) == 1

    conn = sqlite3.connect(db_path)
    job = conn.execute("SELECT status, error_message FROM jobs WHERE id = 'job_1'").fetchone()
    document = conn.execute("SELECT status, error_message FROM documents WHERE id = 'doc_1'").fetchone()
    conn.close()

    assert active_jobs == {}
    assert job == ("failed", "ValueError: bad document")
    assert document == ("failed", "ValueError: bad document")


def test_stop_active_jobs_terminates_running_children():
    events = []

    class FakeProcess:
        def __init__(self):
            self.alive = True

        def is_alive(self):
            return self.alive

        def terminate(self):
            events.append("terminate")

        def join(self, timeout=None):
            events.append(("join", timeout))
            if timeout == 5:
                self.alive = False

        def kill(self):
            events.append("kill")
            self.alive = False

    from services.index_worker.worker import stop_active_jobs

    active_jobs = {
        "job_1": ActiveDocumentJob(
            process=FakeProcess(),
            error_queue=None,
            started_at=0,
        )
    }

    stop_active_jobs(active_jobs)

    assert active_jobs == {}
    assert events == ["terminate", ("join", 5)]


def test_fail_orphaned_running_jobs_schedules_retry(tmp_path):
    db_path = _seed_single_document_job_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO document_index_runs (
          id, document_id, job_id, status, started_at
        ) VALUES (?, ?, ?, ?, ?)
        """,
        ("run_1", "doc_1", "job_1", "running", "2026-04-19T00:00:00Z"),
    )
    conn.commit()
    conn.close()

    assert fail_orphaned_running_jobs(str(db_path)) == 1

    conn = sqlite3.connect(db_path)
    job = conn.execute("SELECT status, error_message, available_at FROM jobs WHERE id = 'job_1'").fetchone()
    document = conn.execute("SELECT status, error_message FROM documents WHERE id = 'doc_1'").fetchone()
    run = conn.execute("SELECT status, error_message FROM document_index_runs WHERE id = 'run_1'").fetchone()
    conn.close()

    assert job[0] == "queued"
    assert "left running by a previous worker process" in job[1]
    assert job[2] is not None
    assert document == ("uploaded", None)
    assert run == ("failed", job[1])


def test_run_document_job_with_timeout_raises_timeout(monkeypatch):
    def never_finishes(db_path: str, job_id: str):
        import time

        time.sleep(1)

    monkeypatch.setattr("services.index_worker.worker.process_document_job", never_finishes)

    with pytest.raises(TimeoutError, match="timed out"):
        run_document_job_with_timeout("app.db", "job_1", timeout_seconds=0.05)


def test_index_job_timeout_default_is_long_enough_for_large_documents():
    assert INDEX_JOB_TIMEOUT_SECONDS == 1800


def test_index_worker_concurrency_defaults_to_serial_processing():
    assert INDEX_WORKER_CONCURRENCY == 1


def test_run_forever_reloads_runtime_concurrency(monkeypatch):
    concurrency_values = iter([1, 3])
    observed_concurrency = []
    sleep_count = 0

    monkeypatch.setattr(
        "services.index_worker.worker.fail_orphaned_running_jobs",
        lambda db_path: 0,
    )
    monkeypatch.setattr(
        "services.index_worker.worker.sweep_stale_running_runs",
        lambda db_path: 0,
    )
    monkeypatch.setattr(
        "services.index_worker.worker.collect_finished_jobs",
        lambda db_path, active_jobs: 0,
    )
    monkeypatch.setattr(
        "services.index_worker.worker.get_index_worker_concurrency",
        lambda db_path, default: next(concurrency_values),
    )

    def fake_start_queued_jobs(db_path, active_jobs, concurrency, token_cache=None):
        assert token_cache is not None
        observed_concurrency.append(concurrency)
        return 0

    def fake_sleep(seconds):
        nonlocal sleep_count
        sleep_count += 1
        if sleep_count == 2:
            raise KeyboardInterrupt

    monkeypatch.setattr("services.index_worker.worker.start_queued_jobs", fake_start_queued_jobs)
    monkeypatch.setattr("services.index_worker.worker.time.sleep", fake_sleep)
    monkeypatch.setattr("services.index_worker.worker.stop_active_jobs", lambda active_jobs, db_path=None: None)

    with pytest.raises(KeyboardInterrupt):
        from services.index_worker.worker import run_forever

        run_forever(poll_seconds=0, concurrency=1)

    assert observed_concurrency == [1, 3]


def test_fail_document_job_schedules_transient_retry_and_records_attempt_reason(tmp_path):
    db_path = _seed_single_document_job_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO document_index_runs (
          id, document_id, job_id, status, started_at
        ) VALUES (?, ?, ?, ?, ?)
        """,
        ("run_1", "doc_1", "job_1", "running", "2026-04-19T00:00:00Z"),
    )
    conn.commit()
    conn.close()

    fail_document_job(str(db_path), "job_1", "Document index job job_1 timed out after 1800 seconds")

    conn = sqlite3.connect(db_path)
    job = conn.execute(
        "SELECT status, error_message, finished_at, available_at FROM jobs WHERE id = 'job_1'"
    ).fetchone()
    document = conn.execute(
        "SELECT status, error_message FROM documents WHERE id = 'doc_1'"
    ).fetchone()
    run = conn.execute(
        """
        SELECT status, finished_at, duration_ms, error_message
          FROM document_index_runs
         WHERE id = 'run_1'
        """
    ).fetchone()
    conn.close()

    expected_error = "Document index job job_1 timed out after 1800 seconds"
    assert job[0] == "queued"
    assert job[1] == expected_error
    assert job[2] is None
    assert job[3] is not None
    assert document == ("uploaded", None)
    assert run[0] == "failed"
    assert run[1] is not None
    assert run[2] >= 0
    assert run[3] == expected_error


def test_fail_document_job_stops_after_max_attempts(tmp_path):
    db_path = _seed_single_document_job_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE jobs SET attempt_count = max_attempts WHERE id = 'job_1'")
    conn.commit()
    conn.close()

    fail_document_job(str(db_path), "job_1", "ConnectionError: upstream unavailable")

    conn = sqlite3.connect(db_path)
    job = conn.execute("SELECT status, finished_at FROM jobs WHERE id = 'job_1'").fetchone()
    document = conn.execute("SELECT status, error_message FROM documents WHERE id = 'doc_1'").fetchone()
    conn.close()
    assert job[0] == "failed"
    assert job[1] is not None
    assert document == ("failed", "ConnectionError: upstream unavailable")


def test_fail_document_job_marks_definitive_item_denial_access_revoked(tmp_path):
    db_path = _seed_single_document_job_db(tmp_path)
    now = "2026-04-19T00:00:00Z"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """INSERT INTO corpus_sources
           (id, kind, display_name, state, scope_json, config_json, config_revision,
            selection_policy, schedule_mode, max_document_size_bytes, health_state,
            created_at, updated_at)
           VALUES ('src_1', 'seeyon', 'Seeyon', 'active', '{}', '{}', 1,
                   'all', 'scheduled', 104857600, 'normal', ?, ?)""",
        (now, now),
    )
    conn.execute(
        """INSERT INTO source_collections
           (id, source_id, identity_key, external_id, root_external_id, display_name,
            origin, registration_state, validation_state, lifecycle_state, selected,
            created_at, updated_at)
           VALUES ('collection_1', 'src_1', 'seeyon:1:2', '1', '2', 'Library',
                   'registered', 'active', 'valid', 'active', 1, ?, ?)""",
        (now, now),
    )
    conn.execute(
        """UPDATE projects SET source_id = 'src_1', source_collection_id = 'collection_1',
                   lifecycle_state = 'active', retrieval_eligible = 1 WHERE id = 'proj_1'"""
    )
    conn.execute(
        """INSERT INTO source_items
           (id, source_id, collection_id, external_id, item_type, name, relative_path,
            source_revision, lifecycle_state, metadata_json, document_id, created_at, updated_at)
           VALUES ('item_1', 'src_1', 'collection_1', '5594372999647937129',
                   'document', 'denied.xlsx', 'denied.xlsx', 'seeyon:99:100',
                   'active', '{}', 'doc_1', ?, ?)""",
        (now, now),
    )
    conn.execute(
        """UPDATE documents SET source_id = 'src_1', source_collection_id = 'collection_1',
                   source_item_id = 'item_1', source_item_external_id = '5594372999647937129',
                   source_revision = 'seeyon:99:100', expected_source_revision = 'seeyon:99:100',
                   expected_source_config_revision = 1, lifecycle_state = 'active',
                   retrieval_eligible = 1, status = 'ready' WHERE id = 'doc_1'"""
    )
    conn.execute(
        """UPDATE jobs SET source_id = 'src_1', source_collection_id = 'collection_1',
                   expected_source_revision = 'seeyon:99:100',
                   expected_source_config_revision = 1, attempt_count = 1 WHERE id = 'job_1'"""
    )
    conn.execute(
        """INSERT INTO document_indexes
           (id, document_id, doc_name, doc_description, structure_json, pages_json,
            index_version, indexed_at, source_revision, is_current)
           VALUES ('index_1', 'doc_1', 'denied.xlsx', 'Denied', '[]', '[]',
                   'v1', ?, 'seeyon:99:100', 1)""",
        (now,),
    )
    conn.commit()
    conn.close()

    fail_document_job(
        str(db_path),
        "job_1",
        "SourceAccessDenied: Seeyon source item access denied",
    )

    conn = sqlite3.connect(db_path)
    assert conn.execute(
        "SELECT status, attempt_count FROM jobs WHERE id = 'job_1'"
    ).fetchone() == ("failed", 1)
    assert conn.execute(
        "SELECT status, lifecycle_state, retrieval_eligible FROM documents WHERE id = 'doc_1'"
    ).fetchone() == ("failed", "access_revoked", 0)
    assert conn.execute(
        "SELECT lifecycle_state FROM source_items WHERE id = 'item_1'"
    ).fetchone() == ("access_revoked",)
    assert conn.execute(
        "SELECT is_current FROM document_indexes WHERE id = 'index_1'"
    ).fetchone() == (0,)
    assert conn.execute(
        "SELECT health_state, consecutive_failure_count FROM corpus_sources WHERE id = 'src_1'"
    ).fetchone() == ("needs_attention", 1)
    conn.close()


def test_claim_next_job_rotates_across_sources_at_same_priority(tmp_path):
    db_path = _seed_queued_document_jobs_db(tmp_path, 4)
    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE jobs SET source_id = 'src_a' WHERE id IN ('job_1', 'job_2', 'job_3')")
    conn.execute("UPDATE jobs SET source_id = 'src_b' WHERE id = 'job_4'")
    conn.commit()
    conn.close()

    assert claim_next_job(str(db_path)) == "job_1"
    assert claim_next_job(str(db_path)) == "job_4"
    assert claim_next_job(str(db_path)) == "job_2"
    assert claim_next_job(str(db_path)) == "job_3"
    assert claim_next_job(str(db_path)) is None


def test_claim_next_job_allows_one_source_to_use_available_slots(tmp_path):
    db_path = _seed_queued_document_jobs_db(tmp_path, 3)
    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE jobs SET source_id = 'src_a'")
    conn.commit()
    conn.close()

    assert claim_next_job(str(db_path)) == "job_1"
    assert claim_next_job(str(db_path)) == "job_2"
    assert claim_next_job(str(db_path)) == "job_3"
    assert claim_next_job(str(db_path)) is None


def test_stale_failed_job_is_superseded_without_mutating_new_document_revision(tmp_path):
    db_path = _seed_single_document_job_db(tmp_path)
    now = "2026-04-19T00:00:00Z"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """INSERT INTO corpus_sources
           (id, kind, display_name, state, scope_json, config_json, config_revision,
            selection_policy, schedule_mode, max_document_size_bytes, health_state,
            created_at, updated_at)
           VALUES ('src_1', 'local', 'Source', 'active', '{}', '{}', 2,
                   'all', 'scheduled', 104857600, 'normal', ?, ?)""",
        (now, now),
    )
    conn.execute(
        """INSERT INTO source_collections
           (id, source_id, identity_key, external_id, display_name, origin,
            registration_state, validation_state, lifecycle_state, selected,
            created_at, updated_at)
           VALUES ('collection_1', 'src_1', 'local:root', 'root', 'Root', 'discovered',
                   'active', 'valid', 'active', 1, ?, ?)""",
        (now, now),
    )
    conn.execute(
        """UPDATE projects SET source_id = 'src_1', source_collection_id = 'collection_1',
                   lifecycle_state = 'active' WHERE id = 'proj_1'"""
    )
    conn.execute(
        """UPDATE documents SET source_id = 'src_1', source_collection_id = 'collection_1',
                   source_revision = 'r2', expected_source_revision = 'r2',
                   lifecycle_state = 'active', status = 'uploaded' WHERE id = 'doc_1'"""
    )
    conn.execute(
        """UPDATE jobs SET source_id = 'src_1', source_collection_id = 'collection_1',
                   expected_source_revision = 'r1', expected_source_config_revision = 1,
                   attempt_count = 1 WHERE id = 'job_1'"""
    )
    conn.commit()
    conn.close()

    fail_document_job(str(db_path), "job_1", "TimeoutError: old attempt")

    conn = sqlite3.connect(db_path)
    job = conn.execute("SELECT status FROM jobs WHERE id = 'job_1'").fetchone()
    document = conn.execute("SELECT status, expected_source_revision FROM documents WHERE id = 'doc_1'").fetchone()
    conn.close()
    assert job == ("superseded",)
    assert document == ("uploaded", "r2")


def test_sweep_stale_running_runs_records_failed_job_reason(tmp_path):
    db_path = _seed_single_document_job_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE jobs
           SET status = 'failed',
               error_message = 'previous timeout',
               finished_at = '2026-04-19T00:05:00Z'
         WHERE id = 'job_1'
        """
    )
    conn.execute(
        """
        INSERT INTO document_index_runs (
          id, document_id, job_id, status, started_at
        ) VALUES (?, ?, ?, ?, ?)
        """,
        ("run_1", "doc_1", "job_1", "running", "2026-04-19T00:00:00Z"),
    )
    conn.commit()
    conn.close()

    assert sweep_stale_running_runs(str(db_path)) == 1

    conn = sqlite3.connect(db_path)
    run = conn.execute(
        "SELECT status, finished_at, duration_ms, error_message FROM document_index_runs WHERE id = 'run_1'"
    ).fetchone()
    conn.close()

    assert run == ("failed", "2026-04-19T00:05:00Z", 300000, "previous timeout")


def test_open_db_enables_foreign_keys_and_busy_timeout(tmp_path):
    db_path = tmp_path / "app.db"

    with open_db(str(db_path)) as conn:
        foreign_keys = conn.execute("PRAGMA foreign_keys").fetchone()[0]
        busy_timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]

    assert foreign_keys == 1
    assert busy_timeout >= 5000


def test_open_db_rolls_back_on_exception(tmp_path):
    db_path = tmp_path / "app.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_schema_sql())
    conn.close()

    with pytest.raises(RuntimeError):
        with open_db(str(db_path)) as writable:
            writable.execute(
                "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                ("proj_x", "user_demo", "Rollback Test", "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z"),
            )
            raise RuntimeError("force rollback")

    conn = sqlite3.connect(db_path)
    count = conn.execute("SELECT COUNT(*) FROM projects WHERE id = 'proj_x'").fetchone()[0]
    conn.close()
    assert count == 0


def test_index_publication_rolls_back_when_document_update_fails(tmp_path, monkeypatch):
    db_path = _seed_single_document_job_db(tmp_path)
    monkeypatch.setattr(
        "services.index_worker.index_document.build_pageindex_payload",
        lambda file_path: {
            "doc_name": "alpha.pdf",
            "doc_description": "Alpha",
            "structure": [],
            "pages": [{"page": 1, "content": "alpha"}],
            "page_count": 1,
        },
    )
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TRIGGER inject_document_update_failure
        BEFORE UPDATE OF status ON documents
        WHEN NEW.status = 'ready'
        BEGIN
          SELECT RAISE(ABORT, 'injected persistence crash');
        END
        """
    )
    conn.commit()
    conn.close()

    with pytest.raises(sqlite3.IntegrityError, match="injected persistence crash"):
        process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    assert conn.execute("SELECT COUNT(*) FROM document_indexes").fetchone() == (0,)
    assert conn.execute("SELECT status FROM documents WHERE id = 'doc_1'").fetchone() == (
        "indexing",
    )
    assert conn.execute("SELECT status FROM jobs WHERE id = 'job_1'").fetchone() == (
        "running",
    )
    assert conn.execute("SELECT status FROM document_index_runs").fetchone() == ("failed",)
    conn.close()


def test_index_publication_is_superseded_when_source_is_disabled_during_build(
    tmp_path, monkeypatch
):
    db_path = _seed_single_document_job_db(tmp_path)
    now = "2026-04-19T00:00:00Z"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO corpus_sources (
          id, kind, display_name, state, scope_json, config_json,
          config_revision, selection_policy, schedule_mode,
          max_document_size_bytes, health_state, created_at, updated_at
        ) VALUES ('src_1', 'local', 'Source', 'active', '{}', '{}', 1,
                  'all', 'scheduled', 104857600, 'normal', ?, ?)
        """,
        (now, now),
    )
    conn.execute(
        """
        INSERT INTO source_collections (
          id, source_id, identity_key, external_id, display_name, origin,
          registration_state, validation_state, lifecycle_state, selected,
          created_at, updated_at
        ) VALUES ('collection_1', 'src_1', 'local:root', 'root', 'Root',
                  'discovered', 'active', 'valid', 'active', 1, ?, ?)
        """,
        (now, now),
    )
    conn.execute(
        """
        UPDATE projects SET source_id = 'src_1', source_collection_id = 'collection_1'
         WHERE id = 'proj_1'
        """
    )
    conn.execute(
        """
        UPDATE documents
           SET source_id = 'src_1', source_collection_id = 'collection_1',
               source_revision = 'r1', expected_source_revision = 'r1',
               expected_source_config_revision = 1, lifecycle_state = 'active',
               retrieval_eligible = 0
         WHERE id = 'doc_1'
        """
    )
    conn.execute(
        """
        UPDATE jobs
           SET source_id = 'src_1', source_collection_id = 'collection_1',
               expected_source_revision = 'r1', expected_source_config_revision = 1
         WHERE id = 'job_1'
        """
    )
    conn.commit()
    conn.close()

    def build_then_disable(file_path):
        connection = sqlite3.connect(db_path)
        connection.execute("UPDATE corpus_sources SET state = 'disabled' WHERE id = 'src_1'")
        connection.commit()
        connection.close()
        return {
            "doc_name": "alpha.pdf",
            "doc_description": "Alpha",
            "structure": [],
            "pages": [{"page": 1, "content": "alpha"}],
            "page_count": 1,
        }

    monkeypatch.setattr(
        "services.index_worker.index_document.build_pageindex_payload", build_then_disable
    )

    @contextmanager
    def prepared(document, db_path):
        yield SimpleNamespace(local_path=Path(document["storage_path"]), content_hash=None)

    monkeypatch.setattr(
        "services.index_worker.index_document.prepared_index_file", prepared
    )

    process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    assert conn.execute("SELECT COUNT(*) FROM document_indexes").fetchone() == (0,)
    assert conn.execute("SELECT status FROM jobs WHERE id = 'job_1'").fetchone() == (
        "superseded",
    )
    assert conn.execute("SELECT retrieval_eligible FROM documents WHERE id = 'doc_1'").fetchone() == (
        0,
    )
    conn.close()


@pytest.mark.parametrize(
    "error_message",
    [
        "OSError: [Errno 28] No space left on device",
        "Seeyon request failed with HTTP 429",
        "RuntimeError: office conversion failed",
    ],
)
def test_operational_capacity_failures_are_retried(tmp_path, error_message):
    db_path = _seed_single_document_job_db(tmp_path)

    fail_document_job(str(db_path), "job_1", error_message)

    conn = sqlite3.connect(db_path)
    job = conn.execute(
        "SELECT status, available_at, error_message FROM jobs WHERE id = 'job_1'"
    ).fetchone()
    document = conn.execute(
        "SELECT status, retrieval_eligible FROM documents WHERE id = 'doc_1'"
    ).fetchone()
    conn.close()
    assert job[0] == "queued"
    assert job[1] is not None
    assert job[2] == error_message
    assert document == ("uploaded", 1)


@pytest.mark.parametrize(
    "error_message",
    [
        "KeyError: 'completed'",
        "TypeError: unsupported operand type(s) for +: 'int' and 'NoneType'",
        "Exception: Failed to complete toc transformation after maximum retries",
    ],
)
def test_pageindex_toc_failures_are_retried(tmp_path, error_message):
    db_path = _seed_single_document_job_db(tmp_path)

    fail_document_job(str(db_path), "job_1", error_message)

    conn = sqlite3.connect(db_path)
    job = conn.execute(
        "SELECT status, available_at, error_message FROM jobs WHERE id = 'job_1'"
    ).fetchone()
    document = conn.execute(
        "SELECT status, retrieval_eligible FROM documents WHERE id = 'doc_1'"
    ).fetchone()
    conn.close()

    assert job[0] == "queued"
    assert job[1] is not None
    assert job[2] == error_message
    assert document == ("uploaded", 1)
