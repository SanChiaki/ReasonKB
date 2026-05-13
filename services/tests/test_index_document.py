from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3
from pathlib import Path

import pytest

from services.common.sqlite_store import open_db
from services.index_worker.index_document import process_document_job
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
        SELECT evidence_kind, visual_assets_json, source_metadata_json
          FROM document_indexes
         WHERE document_id = 'doc_1'
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


def test_fail_orphaned_running_jobs_records_restart_reason(tmp_path):
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
    job = conn.execute("SELECT status, error_message FROM jobs WHERE id = 'job_1'").fetchone()
    document = conn.execute("SELECT status, error_message FROM documents WHERE id = 'doc_1'").fetchone()
    run = conn.execute("SELECT status, error_message FROM document_index_runs WHERE id = 'run_1'").fetchone()
    conn.close()

    assert job[0] == "failed"
    assert "left running by a previous worker process" in job[1]
    assert document[0] == "failed"
    assert document[1] == job[1]
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


def test_fail_document_job_records_failed_run_reason(tmp_path):
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
        "SELECT status, error_message, finished_at FROM jobs WHERE id = 'job_1'"
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
    assert job[0] == "failed"
    assert job[1] == expected_error
    assert job[2] is not None
    assert document == ("failed", expected_error)
    assert run[0] == "failed"
    assert run[1] is not None
    assert run[2] >= 0
    assert run[3] == expected_error


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
