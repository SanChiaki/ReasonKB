import json
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
import logging
import re
from typing import Any

from services.common.pageindex_runtime import configure_pageindex_runtime
from services.common.sqlite_store import open_db
from services.common.system_settings import get_retrieval_document_limit
from services.retrieval_api.select_documents import select_candidate_documents

configure_pageindex_runtime()

from pageindex.utils import ConfigLoader

MAX_PAGE_RANGE_SIZE = 1000
MAX_PAGE_SELECTION_SIZE = 1000
MAX_PARALLEL_DOCUMENT_RETRIEVALS = 5
DEFAULT_RETRIEVAL_DOCUMENT_LIMIT = 5
logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _get_retrieval_model() -> str | None:
    config = ConfigLoader().load()
    return getattr(config, "retrieve_model", None) or getattr(config, "model", None)


_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_LATIN_RE = re.compile(r"[a-z0-9]+")


def build_citation(
    project: dict[str, str],
    document: dict[str, str],
    pages: str,
    *,
    focus_page: int | None = None,
    excerpt: str | None = None,
) -> dict:
    citation = {
        "projectId": project["id"],
        "projectName": project["name"],
        "documentId": document["id"],
        "documentName": document["file_name"],
        "pages": pages,
    }
    if focus_page is not None:
        citation["focusPage"] = focus_page
    if excerpt:
        citation["excerpt"] = excerpt
    return citation


def _tokenize_query(text: str) -> list[str]:
    lowered = text.lower()
    latin_tokens = _LATIN_RE.findall(lowered)
    cjk_chars = _CJK_RE.findall(text)
    cjk_tokens = list(cjk_chars)
    if len(cjk_chars) > 1:
        cjk_tokens.extend(
            "".join(cjk_chars[index : index + 2]) for index in range(len(cjk_chars) - 1)
        )
    return [token for token in [*latin_tokens, *cjk_tokens] if token]


def _normalize_whitespace(text: str) -> str:
    return " ".join(text.replace("\u3000", " ").split())


def _split_excerpt_blocks(text: str) -> list[str]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    normalized = re.sub(r"[ \t]{4,}", "\n", normalized)
    normalized = re.sub(r"\s+(?=(?:#{1,6}\s|>\s|\|\s|- ))", "\n", normalized)
    blocks: list[str] = []
    current: list[str] = []

    def flush_current():
        if current:
            block = _normalize_whitespace(" ".join(current))
            if block:
                blocks.append(block)
            current.clear()

    for raw_line in normalized.split("\n"):
        line = raw_line.strip()
        if not line:
            flush_current()
            continue
        if line.startswith(("- ", "•", "* ", "1.", "2.", "3.", "4.", "5.", "#", ">", "|")):
            flush_current()
            text_blocks = [_normalize_whitespace(part) for part in re.split(r"(?<=[。！？；.!?])\s+", line)]
            blocks.extend([part for part in text_blocks if part])
            continue
        current.append(line)

    flush_current()
    expanded_blocks: list[str] = []
    for block in blocks:
        if len(block) <= 180:
            expanded_blocks.append(block)
            continue
        text_blocks = [_normalize_whitespace(part) for part in re.split(r"(?<=[。！？；.!?])\s+", block)]
        expanded_blocks.extend([part for part in text_blocks if part])

    if expanded_blocks:
        return expanded_blocks

    fallback = _normalize_whitespace(text)
    return [fallback] if fallback else []


def _score_excerpt_block(query: str, block: str) -> int:
    haystack = block.lower()
    score = 0
    for token in _tokenize_query(query):
        if not token or token not in haystack:
            continue
        score += 4 if len(token) >= 2 else 1
    score *= 100
    score -= min(len(block), 400) // 4
    if block.startswith("#"):
        score -= 220
    elif block.startswith((">", "|")):
        score -= 80
    if block.startswith(("- ", "•", "* ")):
        score += 40
    return score


def _truncate_excerpt(text: str, max_length: int = 220) -> str:
    if len(text) <= max_length:
        return text
    return f"{text[: max_length - 1].rstrip()}..."


def _select_citation_anchor(
    query: str,
    evidence: list[dict[str, Any]],
) -> tuple[int | None, str | None]:
    best_page: int | None = None
    best_block: str | None = None
    best_score = -10**9

    for item in evidence:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        page = item.get("page")
        page_number = page if isinstance(page, int) else None
        blocks = _split_excerpt_blocks(content)
        if not blocks:
            continue

        for block in blocks:
            if block.startswith(("#", "|")):
                continue
            score = _score_excerpt_block(query, block)
            if best_block is None or score > best_score or (
                score == best_score
                and best_block is not None
                and len(block) < len(best_block)
            ):
                best_score = score
                best_page = page_number
                best_block = block

    if best_block is None:
        return None, None
    return best_page, _truncate_excerpt(best_block)


def _default_page_window(document: dict[str, Any]) -> str:
    page_numbers = sorted(
        {
            int(page["page"])
            for page in document.get("pages", [])
            if isinstance(page, dict) and isinstance(page.get("page"), int)
        }
    )
    if not page_numbers:
        return "1"
    if len(page_numbers) == 1:
        return str(page_numbers[0])
    return f"{page_numbers[0]}-{page_numbers[1]}"


def _available_page_numbers(document: dict[str, Any]) -> list[int]:
    page_numbers = sorted(
        {
            int(page["page"])
            for page in document.get("pages", [])
            if isinstance(page, dict) and isinstance(page.get("page"), int)
        }
    )
    return page_numbers


def _parse_page_window(pages: str) -> list[int] | None:
    if not isinstance(pages, str):
        return None
    text = pages.strip()
    if not text:
        return None

    selected_pages: set[int] = set()
    for token in text.split(","):
        part = token.strip()
        if not part:
            return None
        if "-" in part:
            left, right = part.split("-", 1)
            if not left.strip().isdigit() or not right.strip().isdigit():
                return None
            start = int(left.strip())
            end = int(right.strip())
            if start <= 0 or end < start:
                return None
            span = end - start + 1
            if span > MAX_PAGE_RANGE_SIZE:
                return None
            if len(selected_pages) + span > MAX_PAGE_SELECTION_SIZE:
                return None
            for page in range(start, end + 1):
                selected_pages.add(page)
            continue
        if not part.isdigit():
            return None
        page = int(part)
        if page <= 0:
            return None
        selected_pages.add(page)
        if len(selected_pages) > MAX_PAGE_SELECTION_SIZE:
            return None

    if not selected_pages:
        return None
    return sorted(selected_pages)


def _is_valid_page_window(pages: str, document: dict[str, Any]) -> bool:
    selected = _parse_page_window(pages)
    if not selected:
        return False
    available = set(_available_page_numbers(document))
    if not available:
        return False
    return all(page in available for page in selected)


def _build_document_map(document: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        document["id"]: {
            "type": "pdf",
            "page_count": len(document.get("pages", [])),
            "doc_name": document.get("file_name", ""),
            "doc_description": document.get("doc_description", ""),
            "structure": document.get("structure", []),
            "pages": document.get("pages", []),
        }
    }


def choose_page_window(query: str, document: dict[str, Any]) -> str:
    from pageindex.retrieve import get_document_structure
    from pageindex.utils import extract_json, llm_completion

    document_map = _build_document_map(document)
    fallback = _default_page_window(document)
    structure_json = get_document_structure(document_map, document["id"])
    prompt = f"""
You are selecting the smallest useful page range for a PDF question.

Question: {query}
Structure:
{structure_json}

Return JSON only:
{{"pages": "3-5"}}
"""
    try:
        parsed = extract_json(llm_completion(model=_get_retrieval_model(), prompt=prompt))
    except Exception:
        return fallback

    pages = parsed.get("pages") if isinstance(parsed, dict) else None
    if isinstance(pages, str) and pages.strip():
        pages = pages.strip()
        if _is_valid_page_window(pages, document):
            return pages
    return fallback


def _load_page_excerpt(document: dict[str, Any], pages: str) -> list[dict[str, Any]]:
    from pageindex.retrieve import get_page_content

    document_map = _build_document_map(document)
    raw = get_page_content(document_map, document["id"], pages)
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []

    return parsed if isinstance(parsed, list) else []


def _generate_answer(query: str, context_blocks: list[dict[str, Any]]) -> str:
    from pageindex.utils import llm_completion

    prompt = f"""
Answer the user's question only from the provided document evidence.

Question: {query}

Evidence:
{json.dumps(context_blocks, ensure_ascii=False)}

Return only the answer text.
"""
    try:
        answer = llm_completion(model=_get_retrieval_model(), prompt=prompt).strip()
    except Exception:
        answer = ""
    return answer or "I could not generate an answer from the selected documents."


def _parse_json_list(value: str | None) -> list:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return []
    return parsed if isinstance(parsed, list) else []


def _join_evidence_content(evidence: list[dict[str, Any]]) -> str:
    return "\n\n".join(
        item["content"]
        for item in evidence
        if isinstance(item, dict) and isinstance(item.get("content"), str)
    )


def _build_document_evidence(
    query: str,
    document: dict[str, Any],
    mode: str,
) -> dict[str, Any] | None:
    try:
        pages = choose_page_window(query, document)
        fallback_pages = _default_page_window(document)
        if not _is_valid_page_window(pages, document):
            pages = fallback_pages
        evidence = _load_page_excerpt(document, pages)
        if not evidence and pages != fallback_pages:
            pages = fallback_pages
            evidence = _load_page_excerpt(document, pages)
        if not evidence:
            return None
        focus_page, excerpt = _select_citation_anchor(query, evidence)
        context_block = {
            "project": document["project_name"],
            "document": document["file_name"],
            "sourceRelativePath": document.get("source_relative_path"),
            "projectRelativePath": document.get("project_relative_path"),
            "pages": pages,
            "evidence": evidence,
        }
        citation = None
        if mode != "evidence":
            citation = build_citation(
                project={"id": document["project_id"], "name": document["project_name"]},
                document={"id": document["id"], "file_name": document["file_name"]},
                pages=pages,
                focus_page=focus_page,
                excerpt=excerpt,
            )
        evidence_block = {
            "projectId": document["project_id"],
            "projectName": document["project_name"],
            "documentId": document["id"],
            "documentName": document["file_name"],
            "sourceRelativePath": document.get("source_relative_path"),
            "projectRelativePath": document.get("project_relative_path"),
            "pages": pages,
            "evidenceKind": document.get("evidence_kind") or "text",
            "excerpt": excerpt,
            "content": _join_evidence_content(evidence),
            "visualAssets": document.get("visual_assets", []),
        }
        return {
            "document": document,
            "contextBlock": context_block,
            "citation": citation,
            "evidenceBlock": evidence_block,
        }
    except Exception:
        logger.exception(
            "Failed to build retrieval evidence for document %s",
            document.get("id"),
        )
        return None


def _build_selected_documents_evidence(
    query: str,
    selected: list[dict[str, Any]],
    mode: str,
) -> list[dict[str, Any]]:
    if not selected:
        return []
    max_workers = min(MAX_PARALLEL_DOCUMENT_RETRIEVALS, len(selected))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        results = executor.map(
            lambda document: _build_document_evidence(query, document, mode),
            selected,
        )
        return [result for result in results if result is not None]


def answer_question(
    db_path: str,
    query: str,
    project_ids: list[str] | None = None,
    mode: str = "answer",
) -> dict:
    project_filter = ""
    project_params: list[str] = []
    if project_ids:
        placeholders = ",".join("?" for _ in project_ids)
        project_filter = f"AND d.project_id IN ({placeholders})"
        project_params = project_ids

    with open_db(db_path) as conn:
        rows = conn.execute(
            f"""
            SELECT d.id, d.project_id, d.file_name, p.name AS project_name,
                   d.source_relative_path, d.project_relative_path,
                   di.doc_description, di.structure_json, di.pages_json,
                   di.evidence_kind, di.visual_assets_json
              FROM documents d
              JOIN projects p ON p.id = d.project_id
              JOIN document_indexes di ON di.document_id = d.id
             WHERE d.status = 'ready'
               AND d.deleted_at IS NULL
               {project_filter}
            """,
            project_params,
        ).fetchall()

    docs = []
    for row in rows:
        try:
            structure = json.loads(row["structure_json"])
            pages = json.loads(row["pages_json"])
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(structure, list) or not isinstance(pages, list):
            continue
        docs.append(
            {
                "id": row["id"],
                "project_id": row["project_id"],
                "project_name": row["project_name"],
                "file_name": row["file_name"],
                "source_relative_path": row["source_relative_path"],
                "project_relative_path": row["project_relative_path"],
                "doc_description": row["doc_description"],
                "evidence_kind": row["evidence_kind"],
                "visual_assets": _parse_json_list(row["visual_assets_json"]),
                "structure": structure,
                "pages": pages,
            }
        )

    selected = select_candidate_documents(
        query,
        docs,
        limit=get_retrieval_document_limit(
            db_path,
            default=DEFAULT_RETRIEVAL_DOCUMENT_LIMIT,
        ),
        model=_get_retrieval_model(),
    )
    if not selected:
        return {
            "answer": "No ready documents matched the retrieval scope.",
            "citations": [],
            "selectedDocuments": [],
            "evidence": [],
        }

    document_results = _build_selected_documents_evidence(query, selected, mode)
    context_blocks = [result["contextBlock"] for result in document_results]
    citations = [
        result["citation"]
        for result in document_results
        if result["citation"] is not None
    ]
    evidence_blocks = [result["evidenceBlock"] for result in document_results]
    used_documents = [result["document"] for result in document_results]

    if not used_documents:
        return {
            "answer": "I could not find usable evidence in selected documents.",
            "citations": [],
            "selectedDocuments": [],
            "evidence": [],
        }

    selected_documents = [
        {"documentId": document["id"]}
        if mode != "evidence" or not document.get("source_relative_path")
        else {
            "documentId": document["id"],
            "sourceRelativePath": document.get("source_relative_path"),
        }
        for document in used_documents
    ]

    return {
        "answer": "" if mode == "evidence" else _generate_answer(query, context_blocks),
        "citations": citations,
        "selectedDocuments": selected_documents,
        "evidence": evidence_blocks if mode == "evidence" else [],
    }
