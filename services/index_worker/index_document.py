import json
import inspect
import asyncio
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
from services.common.sqlite_store import open_db
from services.index_worker.office_conversion import convert_office_to_pdf
from services.index_worker.remote_fetch import prepared_index_file
from services.index_worker.vision import VisionExtractionSkipped, extract_image_evidence_text


class DocumentIndexSkipped(RuntimeError):
    pass


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
        pages = [
            {"page": index + 1, "content": page.extract_text() or ""}
            for index, page in enumerate(reader.pages)
        ]
    return {
        "doc_name": result["doc_name"],
        "doc_description": _with_source_description(result.get("doc_description", ""), document),
        "structure": result["structure"],
        "pages": pages,
        "page_count": len(pages),
        "evidence_kind": "pdf_text",
        "visual_assets": [],
        "source_metadata": _source_metadata(document),
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
                   d.source_size, p.name AS project_name
            FROM jobs j
            JOIN documents d ON d.id = j.document_id
            JOIN projects p ON p.id = d.project_id
            WHERE j.id = ?
              AND j.type = 'document_index'
              AND j.status = 'running'
            """,
            (job_id,),
        ).fetchone()

        if row is None:
            raise ValueError(f"Job {job_id} not found")

    document = dict(row)
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
            with prepared_index_file(document) as prepared_file:
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
    with open_db(db_path) as conn:
        conn.execute(
            """
            INSERT INTO document_indexes (
              id, document_id, doc_name, doc_description, structure_json,
              pages_json, evidence_kind, visual_assets_json, source_metadata_json,
              index_version, indexed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(document_id) DO UPDATE SET
              doc_name = excluded.doc_name,
              doc_description = excluded.doc_description,
              structure_json = excluded.structure_json,
              pages_json = excluded.pages_json,
              evidence_kind = excluded.evidence_kind,
              visual_assets_json = excluded.visual_assets_json,
              source_metadata_json = excluded.source_metadata_json,
              index_version = excluded.index_version,
              indexed_at = excluded.indexed_at
            """,
            (
                f"idx_{document['document_id']}",
                document["document_id"],
                payload["doc_name"],
                payload["doc_description"],
                json.dumps(payload["structure"], ensure_ascii=False),
                json.dumps(payload["pages"], ensure_ascii=False),
                payload.get("evidence_kind", "pdf_text"),
                json.dumps(payload.get("visual_assets", []), ensure_ascii=False),
                json.dumps(payload.get("source_metadata", {}), ensure_ascii=False),
                "v1",
                finished_at,
            ),
        )

        conn.execute(
            """
            UPDATE documents
               SET status = ?, page_count = ?, error_message = NULL,
                   import_status = ?,
                   content_hash = COALESCE(?, content_hash),
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
    _finish_run(db_path, run_id, "completed", snapshot, duration_ms, finished_at, None)


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
