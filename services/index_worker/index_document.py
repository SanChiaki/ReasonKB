import json
import inspect
import asyncio
import logging
import uuid
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter

from PyPDF2 import PdfReader

from services.common.pageindex_runtime import configure_pageindex_runtime

configure_pageindex_runtime()

from pageindex.page_index import page_index
from pageindex.page_index_md import md_to_tree
from services.common.index_metrics import current_index_metrics, index_run_metrics
from services.common.models import IndexedDocumentPayload
from services.common.settings import get_pdf_table_mode
from services.common.sqlite_store import open_db
from services.index_worker.office_conversion import convert_office_to_pdf
from services.index_worker.pdf_layout import extract_pdf_layout
from services.index_worker.remote_fetch import prepared_index_file
from services.index_worker.vision import VisionExtractionSkipped, extract_image_evidence_text


class DocumentIndexSkipped(RuntimeError):
    pass


logger = logging.getLogger(__name__)


def build_pageindex_payload(file_path: str, document: dict | None = None) -> IndexedDocumentPayload:
    media_type = _infer_media_type(file_path, document)
    if media_type == "pdf":
        return _build_pdf_payload(file_path, document)
    if media_type == "markdown":
        return _build_markdown_payload(file_path, document)
    if media_type == "text":
        return _build_text_payload(file_path, document)
    if media_type == "image":
        return _build_image_payload(file_path, document)
    if media_type == "office":
        return _build_office_payload(file_path, document)
    raise DocumentIndexSkipped(f"Unsupported media type for indexing: {media_type}")


def _infer_media_type(file_path: str, document: dict | None) -> str:
    if document and document.get("media_type"):
        return document["media_type"]
    suffix = Path(file_path).suffix.lower()
    if suffix == ".pdf":
        return "pdf"
    if suffix in {".md", ".markdown"}:
        return "markdown"
    if suffix in {".txt", ".text"}:
        return "text"
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}:
        return "image"
    if suffix in {".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"}:
        return "office"
    return "unsupported"


def _timer(field_name: str):
    metrics = current_index_metrics()
    return metrics.timer(field_name) if metrics else nullcontext()


def _source_metadata(document: dict | None) -> dict:
    if not document:
        return {}
    return {
        "projectName": document.get("project_name"),
        "sourceRelativePath": document.get("source_relative_path"),
        "projectRelativePath": document.get("project_relative_path"),
        "mediaType": document.get("media_type"),
        "contentHash": document.get("content_hash"),
        "sourceMtime": document.get("source_mtime"),
        "sourceSize": document.get("source_size"),
    }


def _source_context(document: dict | None) -> str:
    if not document:
        return ""
    parts = []
    if document.get("project_name"):
        parts.append(f"Project: {document['project_name']}")
    if document.get("project_relative_path"):
        parts.append(f"Path: {document['project_relative_path']}")
    return "\n".join(parts)


def _with_source_description(description: str, document: dict | None) -> str:
    source_context = _source_context(document)
    if not source_context:
        return description
    if description:
        return f"{source_context}\n\n{description}"
    return source_context


def _build_pdf_payload(file_path: str, document: dict | None) -> IndexedDocumentPayload:
    with _timer("pageindex_ms"):
        result = page_index(
            doc=file_path,
            if_add_node_summary="yes",
            if_add_node_text="yes",
            if_add_node_id="yes",
            if_add_doc_description="yes",
        )
    with _timer("text_extraction_ms"):
        reader = PdfReader(file_path)
        legacy_pages = [
            {"page": index + 1, "content": page.extract_text() or ""}
            for index, page in enumerate(reader.pages)
        ]
        table_mode = get_pdf_table_mode()
        pages, page_blocks, layout_metadata = _extract_pdf_pages(
            file_path,
            legacy_pages,
            table_mode,
        )
    return {
        "doc_name": result["doc_name"],
        "doc_description": _with_source_description(result.get("doc_description", ""), document),
        "structure": result["structure"],
        "pages": pages,
        "page_count": len(pages),
        "evidence_kind": "pdf_text",
        "visual_assets": [],
        "source_metadata": {
            **_source_metadata(document),
            **layout_metadata,
        },
        "page_blocks": page_blocks,
        "index_version": "v2-layout" if table_mode != "off" else "v1",
    }


def _extract_pdf_pages(
    file_path: str,
    legacy_pages: list[dict],
    table_mode: str,
) -> tuple[list[dict], list[dict], dict]:
    if table_mode == "off":
        return legacy_pages, [], {"pdfTableMode": table_mode}

    try:
        layout = extract_pdf_layout(file_path)
    except Exception as exc:
        logger.warning(
            "PDF layout extraction failed; preserving legacy page text path=%s error=%s",
            file_path,
            type(exc).__name__,
        )
        warning = {
            "code": "layout_extraction_failed",
            "exceptionType": type(exc).__name__,
            "message": str(exc),
        }
        page_blocks = [
            {
                "page": page["page"],
                "layout_status": "ambiguous",
                "blocks": [],
                "diagnostics": {
                    "extractor": "pymupdf",
                    "mode": table_mode,
                    "tableCount": 0,
                    "warnings": [warning],
                },
            }
            for page in legacy_pages
        ]
        return legacy_pages, page_blocks, {
            "pdfTableMode": table_mode,
            "pdfLayoutExtractor": "pymupdf",
            "pdfLayoutStatus": "fallback",
        }

    layout_by_page = {page["page"]: page for page in layout["pages"]}
    pages: list[dict] = []
    page_blocks: list[dict] = []
    for legacy_page in legacy_pages:
        page_number = legacy_page["page"]
        layout_page = layout_by_page.get(page_number)
        if layout_page is None:
            pages.append(legacy_page)
            page_blocks.append(
                {
                    "page": page_number,
                    "layout_status": "ambiguous",
                    "blocks": [],
                    "diagnostics": {
                        "extractor": layout["extractor"],
                        "extractorVersion": layout["extractor_version"],
                        "mode": table_mode,
                        "tableCount": 0,
                        "warnings": [{"code": "layout_page_missing"}],
                    },
                }
            )
            continue

        use_projection = table_mode == "html" and layout_page["layout_status"] == "structured"
        pages.append(
            {
                "page": page_number,
                "content": (
                    layout_page["content"]
                    if use_projection
                    else legacy_page["content"]
                ),
            }
        )
        page_blocks.append(
            {
                "page": page_number,
                "layout_status": layout_page["layout_status"],
                "blocks": layout_page["blocks"],
                "diagnostics": {
                    **layout_page["diagnostics"],
                    "extractor": layout["extractor"],
                    "extractorVersion": layout["extractor_version"],
                    "mode": table_mode,
                },
            }
        )

    structured_page_count = sum(
        page["layout_status"] == "structured" for page in page_blocks
    )
    return pages, page_blocks, {
        "pdfTableMode": table_mode,
        "pdfLayoutExtractor": layout["extractor"],
        "pdfLayoutExtractorVersion": layout["extractor_version"],
        "pdfStructuredPageCount": structured_page_count,
    }


def _build_office_payload(file_path: str, document: dict | None) -> IndexedDocumentPayload:
    if document is None:
        raise DocumentIndexSkipped("Office indexing requires document metadata.")
    converted_pdf_path = convert_office_to_pdf(file_path, document)
    payload = _build_pdf_payload(converted_pdf_path, document)
    source_metadata = {
        **payload.get("source_metadata", {}),
        "sourceFileName": document.get("file_name") or Path(file_path).name,
        "sourceStoragePath": file_path,
        "sourceMediaType": document.get("media_type"),
        "evidencePdfPath": converted_pdf_path,
        "evidenceMediaType": "pdf",
    }
    return {
        **payload,
        "evidence_kind": "office_pdf_text",
        "source_metadata": source_metadata,
    }


def _build_markdown_payload(file_path: str, document: dict | None) -> IndexedDocumentPayload:
    with _timer("text_extraction_ms"):
        content = Path(file_path).read_text(encoding="utf-8")
    with _timer("pageindex_ms"):
        result = asyncio.run(
            md_to_tree(
                file_path,
                if_add_node_summary="no",
                if_add_doc_description="no",
                if_add_node_text="yes",
                if_add_node_id="yes",
            )
        )
    structure = result.get("structure") or _synthetic_structure(Path(file_path).name, content)
    return {
        "doc_name": result.get("doc_name") or Path(file_path).name,
        "doc_description": _with_source_description(
            result.get("doc_description", f"Markdown document: {Path(file_path).name}"),
            document,
        ),
        "structure": structure,
        "pages": [{"page": 1, "content": content}],
        "page_count": 1,
        "evidence_kind": "markdown_text",
        "visual_assets": [],
        "source_metadata": _source_metadata(document),
    }


def _synthetic_structure(title: str, content: str) -> list[dict]:
    return [
        {
            "title": title,
            "node_id": "0001",
            "start_index": 1,
            "end_index": 1,
            "summary": content[:500],
            "text": content,
            "nodes": [],
        }
    ]


def _build_text_payload(file_path: str, document: dict | None) -> IndexedDocumentPayload:
    with _timer("text_extraction_ms"):
        content = Path(file_path).read_text(encoding="utf-8")
    title = document.get("file_name") if document else Path(file_path).name
    title = title or Path(file_path).name
    return {
        "doc_name": title,
        "doc_description": _with_source_description(f"Text document: {title}", document),
        "structure": _synthetic_structure(title, content),
        "pages": [{"page": 1, "content": content}],
        "page_count": 1,
        "evidence_kind": "text",
        "visual_assets": [],
        "source_metadata": _source_metadata(document),
    }


def _build_image_payload(file_path: str, document: dict | None) -> IndexedDocumentPayload:
    project_name = (document or {}).get("project_name") or ""
    project_relative_path = (document or {}).get("project_relative_path") or Path(file_path).name
    with _timer("vision_extraction_ms"):
        try:
            content = extract_image_evidence_text(
                file_path,
                project_name=project_name,
                project_relative_path=project_relative_path,
            )
        except VisionExtractionSkipped as exc:
            raise DocumentIndexSkipped(str(exc)) from exc
    title = (document or {}).get("file_name") or Path(file_path).name
    visual_assets = [
        {
            "path": file_path,
            "projectRelativePath": project_relative_path,
        }
    ]
    return {
        "doc_name": title,
        "doc_description": _with_source_description(f"Image evidence: {title}", document),
        "structure": _synthetic_structure(title, content),
        "pages": [{"page": 1, "content": content}],
        "page_count": 1,
        "evidence_kind": "image_caption",
        "visual_assets": visual_assets,
        "source_metadata": _source_metadata(document),
    }


def process_document_job(db_path: str, job_id: str):
    now = datetime.now(timezone.utc).isoformat()

    with open_db(db_path) as conn:
        row = conn.execute(
            """
            SELECT j.id AS job_id, d.id AS document_id, d.storage_path,
                   d.file_name, d.media_type, d.source_kind, d.source_root,
                   d.source_relative_path,
                   d.project_relative_path, d.content_hash, d.source_mtime,
                   d.source_size, d.source_id, d.source_collection_id,
                   d.source_item_id, d.source_revision, d.expected_source_revision,
                   d.expected_source_config_revision, d.lifecycle_state,
                   j.expected_source_revision AS job_expected_source_revision,
                   j.expected_source_config_revision AS job_expected_source_config_revision,
                   s.config_revision AS current_source_config_revision,
                   s.state AS source_state, c.selected AS collection_selected,
                   c.lifecycle_state AS collection_lifecycle_state,
                   p.lifecycle_state AS project_lifecycle_state,
                   p.name AS project_name
            FROM jobs j
            JOIN documents d ON d.id = j.document_id
            JOIN projects p ON p.id = d.project_id
            LEFT JOIN corpus_sources s ON s.id = d.source_id
            LEFT JOIN source_collections c ON c.id = d.source_collection_id
            WHERE j.id = ?
              AND j.type = 'document_index'
              AND j.status = 'running'
            """,
            (job_id,),
        ).fetchone()

        if row is None:
            raise ValueError(f"Job {job_id} not found")

    document = dict(row)
    if _document_job_is_superseded(document):
        _mark_job_superseded(db_path, job_id, document["document_id"])
        return
    run_id = f"run_{uuid.uuid4()}"
    started_at = datetime.now(timezone.utc).isoformat()
    started_perf = perf_counter()
    with open_db(db_path) as conn:
        conn.execute(
            """
            INSERT INTO document_index_runs (
              id, document_id, job_id, status, started_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (run_id, document["document_id"], job_id, "running", started_at),
        )

    metrics = None
    try:
        with index_run_metrics() as metrics:
            with prepared_index_file(document, db_path) as prepared_file:
                document_for_payload = {
                    **document,
                    "storage_path": str(prepared_file.local_path),
                }
                if prepared_file.content_hash:
                    document_for_payload["content_hash"] = prepared_file.content_hash
                payload = _invoke_payload_builder(document_for_payload)
                if prepared_file.content_hash:
                    document["content_hash"] = prepared_file.content_hash
            snapshot = metrics.snapshot()
            finished_at = datetime.now(timezone.utc).isoformat()
            duration_ms = int((perf_counter() - started_perf) * 1000)
            with metrics.timer("persist_ms"):
                _persist_completed_document(
                    db_path,
                    document,
                    payload,
                    job_id,
                    run_id,
                    snapshot,
                    duration_ms,
                    finished_at,
                )
    except DocumentIndexSkipped as exc:
        snapshot = metrics.snapshot() if metrics else _empty_metrics_snapshot()
        _persist_skipped_document(
            db_path,
            document,
            job_id,
            run_id,
            snapshot,
            int((perf_counter() - started_perf) * 1000),
            datetime.now(timezone.utc).isoformat(),
            str(exc),
        )
    except Exception as exc:
        snapshot = metrics.snapshot() if metrics else _empty_metrics_snapshot()
        _finish_run(
            db_path,
            run_id,
            "failed",
            snapshot,
            int((perf_counter() - started_perf) * 1000),
            datetime.now(timezone.utc).isoformat(),
            str(exc),
        )
        raise


def _invoke_payload_builder(document: dict) -> IndexedDocumentPayload:
    signature = inspect.signature(build_pageindex_payload)
    if "document" in signature.parameters:
        return build_pageindex_payload(document["storage_path"], document=document)
    return build_pageindex_payload(document["storage_path"])


def _document_job_is_superseded(document: dict) -> bool:
    if not document.get("source_id"):
        return False
    return bool(
        document.get("job_expected_source_revision") != document.get("expected_source_revision")
        or document.get("job_expected_source_config_revision")
        != document.get("current_source_config_revision")
        or document.get("source_state") != "active"
        or not document.get("collection_selected")
        or document.get("collection_lifecycle_state") in {"inactive", "missing", "pending_purge"}
        or document.get("project_lifecycle_state") not in {"pending", "active"}
        or document.get("lifecycle_state") != "active"
    )


def _mark_job_superseded(db_path: str, job_id: str, document_id: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with open_db(db_path) as conn:
        conn.execute(
            """
            UPDATE jobs SET status = 'superseded', superseded_at = ?,
                   updated_at = ?, finished_at = ? WHERE id = ?
            """,
            (now, now, now, job_id),
        )
        active_job = conn.execute(
            """
            SELECT 1 FROM jobs WHERE document_id = ? AND status IN ('queued', 'running')
              AND id <> ? LIMIT 1
            """,
            (document_id, job_id),
        ).fetchone()
        if not active_job:
            conn.execute(
                "UPDATE documents SET status = 'uploaded', updated_at = ? WHERE id = ? AND status = 'indexing'",
                (now, document_id),
            )


def _empty_metrics_snapshot() -> dict:
    return {
        "text_extraction_ms": 0,
        "pageindex_ms": 0,
        "vision_extraction_ms": 0,
        "persist_ms": 0,
        "llm_call_count": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "token_source": "estimated",
        "models": {},
    }


def _persist_completed_document(
    db_path: str,
    document: dict,
    payload: IndexedDocumentPayload,
    job_id: str,
    run_id: str,
    snapshot: dict,
    duration_ms: int,
    finished_at: str,
) -> None:
    superseded = False
    with open_db(db_path) as conn:
        if document.get("source_id"):
            current = conn.execute(
                """
                SELECT d.expected_source_revision, d.lifecycle_state,
                       s.config_revision AS current_source_config_revision,
                       s.state AS source_state, c.selected AS collection_selected,
                       c.lifecycle_state AS collection_lifecycle_state,
                       p.lifecycle_state AS project_lifecycle_state
                  FROM documents d
                  JOIN corpus_sources s ON s.id = d.source_id
                  JOIN source_collections c ON c.id = d.source_collection_id
                  JOIN projects p ON p.id = d.project_id
                 WHERE d.id = ?
                """,
                (document["document_id"],),
            ).fetchone()
            if current is None or _document_job_is_superseded(
                {
                    **document,
                    **dict(current or {}),
                }
            ):
                conn.execute(
                    """
                    UPDATE jobs SET status = 'superseded', superseded_at = ?,
                           updated_at = ?, finished_at = ? WHERE id = ?
                    """,
                    (finished_at, finished_at, finished_at, job_id),
                )
                superseded = True
        if superseded:
            pass
        else:
            index_id = f"idx_{document['document_id']}"
            conn.execute(
                """
                INSERT INTO document_indexes (
                  id, document_id, doc_name, doc_description, structure_json,
                  pages_json, evidence_kind, visual_assets_json, source_metadata_json,
                  index_version, indexed_at, source_revision, is_current, retired_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
                ON CONFLICT(document_id) DO UPDATE SET
                  doc_name = excluded.doc_name,
                  doc_description = excluded.doc_description,
                  structure_json = excluded.structure_json,
                  pages_json = excluded.pages_json,
                  evidence_kind = excluded.evidence_kind,
                  visual_assets_json = excluded.visual_assets_json,
                  source_metadata_json = excluded.source_metadata_json,
                  index_version = excluded.index_version,
                  indexed_at = excluded.indexed_at,
                  source_revision = excluded.source_revision,
                  is_current = 1,
                  retired_at = NULL
                """,
                (
                    index_id,
                    document["document_id"],
                    payload["doc_name"],
                    payload["doc_description"],
                    json.dumps(payload["structure"], ensure_ascii=False),
                    json.dumps(payload["pages"], ensure_ascii=False),
                    payload.get("evidence_kind", "pdf_text"),
                    json.dumps(payload.get("visual_assets", []), ensure_ascii=False),
                    json.dumps(payload.get("source_metadata", {}), ensure_ascii=False),
                    payload.get("index_version", "v1"),
                    finished_at,
                    document.get("job_expected_source_revision")
                    or document.get("source_revision"),
                ),
            )
            conn.execute(
                "DELETE FROM document_page_blocks WHERE document_index_id = ?",
                (index_id,),
            )
            conn.executemany(
                """
                INSERT INTO document_page_blocks (
                  document_index_id, page_number, layout_status,
                  blocks_json, diagnostics_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                [
                    (
                        index_id,
                        page["page"],
                        page["layout_status"],
                        json.dumps(page.get("blocks", []), ensure_ascii=False),
                        json.dumps(page.get("diagnostics", {}), ensure_ascii=False),
                    )
                    for page in payload.get("page_blocks", [])
                ],
            )

            conn.execute(
                """
                UPDATE documents
                   SET status = ?, page_count = ?, error_message = NULL,
                       import_status = ?,
                       content_hash = COALESCE(?, content_hash),
                       retrieval_eligible = 1,
                       last_index_duration_ms = ?,
                       last_index_total_tokens = ?,
                       last_index_llm_call_count = ?,
                       last_indexed_at = ?,
                       updated_at = ?
                 WHERE id = ?
                """,
                (
                    "ready",
                    payload["page_count"],
                    "imported",
                    document.get("content_hash"),
                    duration_ms,
                    snapshot["total_tokens"],
                    snapshot["llm_call_count"],
                    finished_at,
                    finished_at,
                    document["document_id"],
                ),
            )
            conn.execute(
                """
                UPDATE jobs
                   SET status = ?, progress = ?, updated_at = ?, finished_at = ?, error_message = NULL
                 WHERE id = ?
                """,
                ("completed", 100, finished_at, finished_at, job_id),
            )
    _finish_run(
        db_path,
        run_id,
        "superseded" if superseded else "completed",
        snapshot,
        duration_ms,
        finished_at,
        None,
    )


def _persist_skipped_document(
    db_path: str,
    document: dict,
    job_id: str,
    run_id: str,
    snapshot: dict,
    duration_ms: int,
    finished_at: str,
    error_message: str,
) -> None:
    with open_db(db_path) as conn:
        conn.execute(
            """
            UPDATE documents
               SET status = ?, error_message = ?, import_status = ?,
                   import_error = ?, last_index_duration_ms = ?,
                   last_index_total_tokens = ?, last_index_llm_call_count = ?,
                   last_indexed_at = ?, updated_at = ?
             WHERE id = ?
            """,
            (
                "skipped",
                error_message,
                "skipped",
                error_message,
                duration_ms,
                snapshot["total_tokens"],
                snapshot["llm_call_count"],
                finished_at,
                finished_at,
                document["document_id"],
            ),
        )
        conn.execute(
            """
            UPDATE jobs
               SET status = ?, progress = ?, updated_at = ?, finished_at = ?, error_message = NULL
             WHERE id = ?
            """,
            ("completed", 100, finished_at, finished_at, job_id),
        )
    _finish_run(db_path, run_id, "skipped", snapshot, duration_ms, finished_at, error_message)


def _finish_run(
    db_path: str,
    run_id: str,
    status: str,
    snapshot: dict,
    duration_ms: int,
    finished_at: str,
    error_message: str | None,
) -> None:
    with open_db(db_path) as conn:
        conn.execute(
            """
            UPDATE document_index_runs
               SET status = ?, finished_at = ?, duration_ms = ?,
                   text_extraction_ms = ?, pageindex_ms = ?,
                   vision_extraction_ms = ?, persist_ms = ?,
                   llm_call_count = ?, prompt_tokens = ?,
                   completion_tokens = ?, total_tokens = ?,
                   token_source = ?, models_json = ?, error_message = ?
             WHERE id = ?
            """,
            (
                status,
                finished_at,
                duration_ms,
                snapshot["text_extraction_ms"],
                snapshot["pageindex_ms"],
                snapshot["vision_extraction_ms"],
                snapshot["persist_ms"],
                snapshot["llm_call_count"],
                snapshot["prompt_tokens"],
                snapshot["completion_tokens"],
                snapshot["total_tokens"],
                snapshot["token_source"],
                json.dumps(snapshot["models"], ensure_ascii=False),
                error_message,
                run_id,
            ),
        )
