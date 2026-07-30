import json
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache
import logging
import math
import os
from queue import Empty, Queue
import re
from threading import Event
from typing import Any, Generator, Iterable, Literal
from urllib.parse import urlencode, urlsplit, urlunsplit

from services.common.pageindex_runtime import (
    configure_pageindex_runtime,
    llm_request_scope,
)
from services.common.sqlite_store import open_db
from services.common.system_settings import get_retrieval_document_limit
from services.retrieval_api.select_documents import (
    EVIDENCE_VALIDATION_REASON_KEY,
    select_candidate_documents,
)

configure_pageindex_runtime()

from pageindex.utils import ConfigLoader

MAX_PAGE_RANGE_SIZE = 1000
MAX_PAGE_SELECTION_SIZE = 1000
MAX_PARALLEL_DOCUMENT_RETRIEVALS = 5
MAX_TREE_SEARCH_ROUNDS = 3
MAX_TREE_SEARCH_PAGES_PER_ROUND = 8
MAX_TREE_SEARCH_PAGES = 16
MAX_TREE_ASSESSMENT_CHARS = 48000
MAX_EVIDENCE_VALIDATION_CHARS = 48000
DEFAULT_RETRIEVAL_DOCUMENT_LIMIT = 5
DEFAULT_RETRIEVAL_LLM_TIMEOUT_SECONDS = 120.0
DOCUMENT_DEGRADED_REASONS_KEY = "_reasonkb_retrieval_degraded_reasons"
logger = logging.getLogger(__name__)
_DOCUMENT_RETRIEVAL_EXECUTOR = ThreadPoolExecutor(
    max_workers=MAX_PARALLEL_DOCUMENT_RETRIEVALS,
    thread_name_prefix="reasonkb-retrieval",
)

RetrievalStatus = Literal["matched", "no_match", "degraded"]


@dataclass(frozen=True)
class _EvidenceValidationResult:
    document_results: tuple[dict[str, Any], ...]
    status: RetrievalStatus
    degraded_reason: str | None = None
    attempted_count: int = 0
    accepted_count: int = 0


class _PageWindow(str):
    def __new__(
        cls,
        value: str,
        degraded_reason: str | None = None,
    ) -> "_PageWindow":
        instance = super().__new__(cls, value)
        instance.degraded_reason = degraded_reason
        return instance


@dataclass(frozen=True)
class _EvidenceAssessment:
    sufficient: bool
    next_pages: str | None
    degraded_reason: str | None = None

    def __iter__(self):
        yield self.sufficient
        yield self.next_pages


class _DocumentResults(list[dict[str, Any]]):
    def __init__(
        self,
        results: Iterable[dict[str, Any]],
        *,
        attempted_count: int,
        degraded_reasons: Iterable[str] = (),
    ) -> None:
        super().__init__(results)
        self.attempted_count = attempted_count
        self.degraded_reasons = tuple(dict.fromkeys(degraded_reasons))


class _CancellationSignal:
    def __init__(self, *events: Event | None):
        self._events = tuple(event for event in events if event is not None)

    def is_set(self) -> bool:
        return any(event.is_set() for event in self._events)


def _retrieval_llm_timeout_seconds() -> float:
    try:
        value = float(
            os.getenv(
                "RETRIEVAL_LLM_REQUEST_TIMEOUT_SECONDS",
                str(DEFAULT_RETRIEVAL_LLM_TIMEOUT_SECONDS),
            )
        )
    except (TypeError, ValueError):
        return DEFAULT_RETRIEVAL_LLM_TIMEOUT_SECONDS
    if not math.isfinite(value) or value <= 0:
        return DEFAULT_RETRIEVAL_LLM_TIMEOUT_SECONDS
    return min(value, 600.0)


def _progress_event(stage: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"type": "progress", "stage": stage, "data": data or {}}


def _result_event(result: dict[str, Any]) -> dict[str, Any]:
    return {"type": "result", "data": result}


def _document_summary(document: dict[str, Any]) -> dict[str, Any]:
    summary = {
        "documentId": document["id"],
        "documentName": document["file_name"],
        "projectName": document["project_name"],
        "sourceRelativePath": document.get("source_relative_path"),
    }
    if document.get("document_url"):
        summary["documentUrl"] = document["document_url"]
    if document.get("source_display_name"):
        summary["sourceDisplayName"] = document["source_display_name"]
        summary["sourceKind"] = document.get("source_kind")
    return summary


def _build_seeyon_document_url(
    endpoint: object,
    external_id: object,
) -> str | None:
    """Build a browser URL from the stable Seeyon document resource ID."""
    if not isinstance(endpoint, str) or not endpoint.strip():
        return None
    if not isinstance(external_id, (str, int)) or not str(external_id).strip():
        return None

    try:
        parsed = urlsplit(endpoint.strip())
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        if parsed.username is not None or parsed.password is not None:
            return None
        port = parsed.port
    except ValueError:
        return None

    hostname = parsed.hostname
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    netloc = hostname if port is None else f"{hostname}:{port}"
    path = parsed.path.rstrip("/")
    if not path.endswith("/seeyon"):
        path = f"{path}/seeyon" if path else "/seeyon"
    path = f"{path}/doc.do"
    base_url = urlunsplit((parsed.scheme, netloc, path, "", ""))
    resource_id = str(external_id).strip()
    query = urlencode(
        {
            "method": "knowledgeBrowse",
            "docResId": resource_id,
            "entranceType": "5",
            "docId": resource_id,
        }
    )
    return f"{base_url}?{query}"


def _document_url(document: dict[str, Any]) -> str | None:
    if document.get("source_kind") != "seeyon":
        return None
    return _build_seeyon_document_url(
        document.get("source_endpoint"),
        document.get("source_item_external_id"),
    )


@lru_cache(maxsize=1)
def _get_retrieval_model() -> str | None:
    config = ConfigLoader().load()
    return getattr(config, "retrieve_model", None) or getattr(config, "model", None)


def _retrieval_completion(prompt: str) -> tuple[str | None, str | None]:
    from pageindex.utils import llm_completion

    try:
        completion_result = llm_completion(
            model=_get_retrieval_model(),
            prompt=prompt,
            return_finish_reason=True,
        )
    except Exception:
        return None, "provider_error"

    if isinstance(completion_result, tuple) and len(completion_result) == 2:
        raw, finish_reason = completion_result
    else:
        raw, finish_reason = completion_result, None
    if finish_reason == "error" or not isinstance(raw, str) or not raw.strip():
        return None, "provider_error"
    return raw, None


_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_LATIN_RE = re.compile(r"[a-z0-9]+")


def build_citation(
    project: dict[str, str],
    document: dict[str, Any],
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
    if project.get("sourceDisplayName"):
        citation["sourceDisplayName"] = project["sourceDisplayName"]
        citation["sourceKind"] = project.get("sourceKind")
    if document.get("document_url"):
        citation["documentUrl"] = document["document_url"]
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
        page_number = page if _is_page_number(page) else None
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
            if isinstance(page, dict) and _is_page_number(page.get("page"))
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
            if isinstance(page, dict) and _is_page_number(page.get("page"))
        }
    )
    return page_numbers


def _is_page_number(value: Any) -> bool:
    return type(value) is int and value > 0


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


def _format_page_window(page_numbers: Iterable[int]) -> str:
    pages = sorted(set(page_numbers))
    if not pages:
        return ""

    ranges: list[str] = []
    start = previous = pages[0]
    for page in pages[1:]:
        if page == previous + 1:
            previous = page
            continue
        ranges.append(str(start) if start == previous else f"{start}-{previous}")
        start = previous = page
    ranges.append(str(start) if start == previous else f"{start}-{previous}")
    return ",".join(ranges)


def _bounded_page_numbers(
    pages: str,
    document: dict[str, Any],
    *,
    exclude: Iterable[int] = (),
    limit: int = MAX_TREE_SEARCH_PAGES_PER_ROUND,
) -> list[int]:
    parsed = _parse_page_window(pages)
    if not parsed or limit <= 0:
        return []
    available = set(_available_page_numbers(document))
    excluded = set(exclude)
    return [page for page in parsed if page in available and page not in excluded][:limit]


def _iter_structure_nodes(structure: Any) -> Iterable[dict[str, Any]]:
    stack = list(reversed(structure)) if isinstance(structure, list) else [structure]
    while stack:
        item = stack.pop()
        if not isinstance(item, dict):
            continue
        yield item
        children = item.get("nodes")
        if isinstance(children, list):
            stack.extend(reversed(children))


def _has_searchable_tree(document: dict[str, Any]) -> bool:
    return any(
        node.get("node_id") is not None
        and _is_page_number(node.get("start_index"))
        for node in _iter_structure_nodes(document.get("structure", []))
    )


def _pages_for_node_ids(document: dict[str, Any], node_ids: Any) -> list[int]:
    if not isinstance(node_ids, list):
        return []
    requested_ids = {
        str(node_id).strip()
        for node_id in node_ids
        if isinstance(node_id, (str, int))
        and not isinstance(node_id, bool)
        and str(node_id).strip()
    }
    if not requested_ids:
        return []

    pages: set[int] = set()
    for node in _iter_structure_nodes(document.get("structure", [])):
        if str(node.get("node_id", "")).strip() not in requested_ids:
            continue
        start = node.get("start_index")
        end = node.get("end_index", start)
        if not _is_page_number(start) or not _is_page_number(end) or end < start:
            continue
        if end - start + 1 > MAX_PAGE_RANGE_SIZE:
            continue
        pages.update(range(start, end + 1))
    return sorted(pages)


def _page_selection_from_payload(
    payload: Any,
    document: dict[str, Any],
    *,
    exclude: Iterable[int] = (),
    limit: int = MAX_TREE_SEARCH_PAGES_PER_ROUND,
) -> list[int]:
    if not isinstance(payload, dict) or limit <= 0:
        return []

    excluded = set(exclude)
    available = set(_available_page_numbers(document))
    node_ids = (
        payload.get("next_node_list")
        or payload.get("next_node_ids")
        or payload.get("node_list")
        or payload.get("node_ids")
    )
    node_pages = [
        page
        for page in _pages_for_node_ids(document, node_ids)
        if page in available and page not in excluded
    ]
    if node_pages:
        return node_pages[:limit]

    pages = payload.get("next_pages") or payload.get("pages")
    if not isinstance(pages, str):
        return []
    return _bounded_page_numbers(
        pages,
        document,
        exclude=excluded,
        limit=limit,
    )


def _page_selection_request_state(
    payload: dict[str, Any],
    keys: tuple[str, ...],
) -> Literal["empty", "requested", "missing", "invalid"]:
    seen = False
    for key in keys:
        if key not in payload:
            continue
        seen = True
        value = payload[key]
        if isinstance(value, list):
            if value:
                return "requested"
            continue
        if isinstance(value, str):
            if value.strip():
                return "requested"
            continue
        return "invalid"
    return "empty" if seen else "missing"


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


def choose_page_window(
    query: str,
    document: dict[str, Any],
    mode: str = "answer",
) -> str:
    from pageindex.retrieve import get_document_structure
    from pageindex.utils import extract_json

    document_map = _build_document_map(document)
    fallback = _default_page_window(document)
    try:
        structure_json = get_document_structure(document_map, document["id"])
    except Exception:
        return _PageWindow(fallback, "page_structure_failed")
    selection_goal = (
        "Find all distinct, specific tree nodes likely to contain relevant evidence. "
        "Favor recall across sections, but exclude nodes with no plausible relevance."
        if mode == "evidence"
        else (
            "Find the smallest set of specific tree nodes likely to contain enough "
            "evidence to answer the question accurately."
        )
    )
    prompt = f"""
You are performing PageIndex tree search over a document.
{selection_goal}
Prefer leaf nodes or narrow sections. Do not select a broad parent when a specific child is enough.

Question: {query}
Structure:
{structure_json}

Return JSON only:
{{"thinking": "brief reason", "node_list": ["0007"], "pages": "3-5"}}
Use node_list when node IDs are available. Also return the corresponding physical pages.
"""
    raw, completion_error = _retrieval_completion(prompt)
    if completion_error:
        return _PageWindow(fallback, "page_selection_provider_error")
    try:
        parsed = extract_json(raw)
    except Exception:
        return _PageWindow(fallback, "page_selection_malformed")
    if not isinstance(parsed, dict):
        return _PageWindow(fallback, "page_selection_malformed")

    selected_pages = _page_selection_from_payload(parsed, document)
    if selected_pages:
        return _PageWindow(_format_page_window(selected_pages))
    selection_state = _page_selection_request_state(
        parsed,
        ("node_list", "node_ids", "pages"),
    )
    if selection_state == "empty":
        return _PageWindow(fallback)
    return _PageWindow(fallback, "page_selection_invalid")


def _load_page_excerpt(document: dict[str, Any], pages: str) -> list[dict[str, Any]]:
    from pageindex.retrieve import get_page_content

    document_map = _build_document_map(document)
    raw = get_page_content(document_map, document["id"], pages)
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []

    return parsed if isinstance(parsed, list) else []


def _compact_evidence_for_assessment(evidence: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compact: list[dict[str, Any]] = []
    remaining = MAX_TREE_ASSESSMENT_CHARS
    for item in evidence:
        if remaining <= 0 or not isinstance(item, dict):
            break
        content = item.get("content")
        if not isinstance(content, str):
            continue
        excerpt = content[:remaining]
        compact.append({"page": item.get("page"), "content": excerpt})
        remaining -= len(excerpt)
    return compact


def _assess_evidence_and_choose_next_pages(
    query: str,
    document: dict[str, Any],
    evidence: list[dict[str, Any]],
    inspected_pages: set[int],
    mode: str,
) -> _EvidenceAssessment:
    from pageindex.utils import extract_json, remove_fields

    if set(_available_page_numbers(document)).issubset(inspected_pages):
        return _EvidenceAssessment(True, None)

    purpose = (
        "Decide whether the evidence is sufficient to answer the question accurately and completely."
        if mode != "evidence"
        else (
            "Decide whether the evidence provides strong search-result coverage for a downstream caller. "
            "Prefer recall: continue when another distinct section is likely to contain relevant evidence. "
            "Do not answer the question."
        )
    )
    structure = remove_fields(document.get("structure", []), fields=["text"])
    prompt = f"""
You are continuing a bounded PageIndex tree search.
{purpose}

Question: {query}
Document: {document.get("file_name", "")}
Already inspected pages: {_format_page_window(inspected_pages)}
Document tree:
{json.dumps(structure, ensure_ascii=False)}

Collected evidence:
{json.dumps(_compact_evidence_for_assessment(evidence), ensure_ascii=False)}

If more evidence is needed, select only uninspected, specific nodes or physical pages.
Return JSON only:
{{
  "sufficient": true,
  "thinking": "brief reason",
  "next_node_list": [],
  "next_pages": ""
}}
"""
    raw, completion_error = _retrieval_completion(prompt)
    if completion_error:
        return _EvidenceAssessment(True, None, "tree_assessment_provider_error")
    try:
        parsed = extract_json(raw)
    except Exception:
        return _EvidenceAssessment(True, None, "tree_assessment_malformed")
    if not isinstance(parsed, dict):
        return _EvidenceAssessment(True, None, "tree_assessment_malformed")

    sufficient = parsed.get("sufficient")
    if isinstance(sufficient, str):
        normalized = sufficient.strip().lower()
        sufficient = True if normalized in {"true", "yes"} else False if normalized in {"false", "no"} else None
    if not isinstance(sufficient, bool):
        return _EvidenceAssessment(True, None, "tree_assessment_malformed")
    if sufficient:
        return _EvidenceAssessment(True, None)

    remaining_budget = MAX_TREE_SEARCH_PAGES - len(inspected_pages)
    next_pages = _page_selection_from_payload(
        parsed,
        document,
        exclude=inspected_pages,
        limit=min(MAX_TREE_SEARCH_PAGES_PER_ROUND, remaining_budget),
    )
    if not next_pages:
        selection_state = _page_selection_request_state(
            parsed,
            (
                "next_node_list",
                "next_node_ids",
                "node_list",
                "node_ids",
                "next_pages",
                "pages",
            ),
        )
        if selection_state == "empty":
            return _EvidenceAssessment(True, None)
        degraded_reason = (
            "tree_assessment_malformed"
            if selection_state == "missing"
            else "tree_assessment_invalid_next_pages"
        )
        return _EvidenceAssessment(True, None, degraded_reason)
    return _EvidenceAssessment(False, _format_page_window(next_pages))


def _merge_page_evidence(
    existing: list[dict[str, Any]],
    additional: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_page: dict[int, dict[str, Any]] = {}
    unnumbered: list[dict[str, Any]] = []
    for item in [*existing, *additional]:
        if not isinstance(item, dict):
            continue
        page = item.get("page")
        if _is_page_number(page):
            by_page[page] = item
        else:
            unnumbered.append(item)
    return [by_page[page] for page in sorted(by_page)] + unnumbered


# Synchronous and SSE callers consume the same steps so retrieval behavior cannot drift.
def _document_tree_search_steps(
    query: str,
    document: dict[str, Any],
    mode: str,
) -> Iterable[dict[str, Any]]:
    degraded_reasons: list[str] = []
    fallback_pages = _default_page_window(document)
    selected = choose_page_window(query, document, mode)
    selection_degraded_reason = getattr(selected, "degraded_reason", None)
    if selection_degraded_reason:
        degraded_reasons.append(selection_degraded_reason)
    selected_numbers = _bounded_page_numbers(selected, document)
    used_fallback = not selected_numbers
    if not selected_numbers:
        selected_numbers = _bounded_page_numbers(fallback_pages, document)
    if not selected_numbers:
        yield {"type": "empty", "reason": "invalid_page_selection"}
        return

    pages = _format_page_window(selected_numbers)
    yield {
        "type": "pages_selected",
        "pages": pages,
        "round": 1,
        "fallback": used_fallback,
    }
    evidence = _load_page_excerpt(document, pages)

    fallback_numbers = _bounded_page_numbers(fallback_pages, document)
    fallback_window = _format_page_window(fallback_numbers)
    if not evidence and fallback_window and pages != fallback_window:
        selected_numbers = fallback_numbers
        pages = fallback_window
        yield {
            "type": "pages_selected",
            "pages": pages,
            "round": 1,
            "fallback": True,
        }
        evidence = _load_page_excerpt(document, pages)

    if not evidence:
        yield {"type": "empty", "reason": "empty_evidence"}
        return

    inspected_pages = set(selected_numbers)
    if _has_searchable_tree(document):
        for round_number in range(2, MAX_TREE_SEARCH_ROUNDS + 1):
            if len(inspected_pages) >= MAX_TREE_SEARCH_PAGES:
                break
            assessment = _assess_evidence_and_choose_next_pages(
                query,
                document,
                evidence,
                inspected_pages,
                mode,
            )
            sufficient, next_pages = assessment
            assessment_degraded_reason = getattr(
                assessment,
                "degraded_reason",
                None,
            )
            if assessment_degraded_reason:
                degraded_reasons.append(assessment_degraded_reason)
            if sufficient or not next_pages:
                break
            next_numbers = _bounded_page_numbers(
                next_pages,
                document,
                exclude=inspected_pages,
                limit=min(
                    MAX_TREE_SEARCH_PAGES_PER_ROUND,
                    MAX_TREE_SEARCH_PAGES - len(inspected_pages),
                ),
            )
            if not next_numbers:
                break
            next_window = _format_page_window(next_numbers)
            inspected_pages.update(next_numbers)
            yield {
                "type": "pages_selected",
                "pages": next_window,
                "round": round_number,
                "fallback": False,
            }
            evidence = _merge_page_evidence(
                evidence,
                _load_page_excerpt(document, next_window),
            )

    yield {
        "type": "result",
        "pages": _format_page_window(inspected_pages),
        "evidence": evidence,
        "degraded_reasons": tuple(dict.fromkeys(degraded_reasons)),
    }


def _generate_answer(query: str, context_blocks: list[dict[str, Any]]) -> str:
    prompt = f"""
Answer the user's question only from the provided document evidence.
Answer every material part of the question. For lists, indicators, and taxonomies,
preserve the source's level of abstraction and parent-child grouping. Do not replace
a requested top-level category with its detailed subcriteria, and do not flatten
distinct groups into one list.

Question: {query}

Evidence:
{json.dumps(context_blocks, ensure_ascii=False)}

Return only the answer text.
"""
    answer, _completion_error = _retrieval_completion(prompt)
    return answer.strip() if answer else ""


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


def _assemble_document_result(
    query: str,
    document: dict[str, Any],
    mode: str,
    pages: str,
    evidence: list[dict[str, Any]],
) -> dict[str, Any]:
    focus_page, excerpt = _select_citation_anchor(query, evidence)
    context_block = {
        "project": document["project_name"],
        "source": document.get("source_display_name"),
        "sourceKind": document.get("source_kind"),
        "document": document["file_name"],
        "sourceRelativePath": document.get("source_relative_path"),
        "projectRelativePath": document.get("project_relative_path"),
        "pages": pages,
        "evidence": evidence,
    }
    citation = None
    if mode != "evidence":
        citation = build_citation(
            project={
                "id": document["project_id"],
                "name": document["project_name"],
                "sourceDisplayName": document.get("source_display_name"),
                "sourceKind": document.get("source_kind"),
            },
            document={
                "id": document["id"],
                "file_name": document["file_name"],
                "document_url": document.get("document_url"),
            },
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
    if document.get("document_url"):
        evidence_block["documentUrl"] = document["document_url"]
    if document.get("source_display_name"):
        evidence_block["sourceDisplayName"] = document["source_display_name"]
        evidence_block["sourceKind"] = document.get("source_kind")
    return {
        "document": document,
        "contextBlock": context_block,
        "citation": citation,
        "evidenceBlock": evidence_block,
    }


def _compact_validation_content(query: str, content: str, limit: int) -> str:
    if len(content) <= limit:
        return content
    if limit <= 32:
        return content[:limit]

    separator = "\n...\n"
    available = max(1, limit - 2 * len(separator))
    head_budget = max(1, available // 4)
    tail_budget = max(1, available // 4)
    focus_budget = max(1, available - head_budget - tail_budget)
    focus_block = max(
        _split_excerpt_blocks(content) or [content],
        key=lambda block: (_score_excerpt_block(query, block), -len(block)),
    )
    if len(focus_block) > focus_budget:
        lowered = focus_block.lower()
        positions = [
            lowered.find(token.lower())
            for token in sorted(set(_tokenize_query(query)), key=len, reverse=True)
            if len(token) >= 2 and lowered.find(token.lower()) >= 0
        ]
        center = positions[0] if positions else len(focus_block) // 2
        start = max(0, min(len(focus_block) - focus_budget, center - focus_budget // 2))
        focus_block = focus_block[start : start + focus_budget]

    compact = separator.join(
        (
            content[:head_budget],
            focus_block[:focus_budget],
            content[-tail_budget:],
        )
    )
    return compact[:limit]


def _compact_validation_candidates(
    query: str,
    document_results: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not document_results:
        return []

    per_document_budget = max(
        1,
        MAX_EVIDENCE_VALIDATION_CHARS // len(document_results),
    )
    candidates: list[dict[str, Any]] = []
    for index, result in enumerate(document_results):
        evidence = result.get("contextBlock", {}).get("evidence", [])
        page_items = [
            item
            for item in evidence
            if isinstance(item, dict)
            and _is_page_number(item.get("page"))
            and isinstance(item.get("content"), str)
            and item["content"].strip()
        ]
        per_page_budget = max(
            1,
            per_document_budget // max(len(page_items), 1),
        )
        candidates.append(
            {
                "candidate_id": f"D{index + 1:03d}",
                "document_name": result.get("document", {}).get("file_name", ""),
                "pages": [
                    {
                        "page": item["page"],
                        "content": _compact_validation_content(
                            query,
                            item["content"],
                            per_page_budget,
                        ),
                    }
                    for item in page_items
                ],
            }
        )
    return candidates


def _parse_evidence_validation_matches(
    payload: Any,
    document_results: list[dict[str, Any]],
    *,
    require_complete_answer: bool = False,
) -> dict[int, set[int]] | None:
    if not isinstance(payload, dict) or not isinstance(payload.get("matches"), list):
        return None

    raw_matches = payload["matches"]
    if require_complete_answer:
        sufficient = payload.get("sufficient")
        if type(sufficient) is not bool:
            return None
        if not sufficient:
            return {}
    if not raw_matches:
        return None if require_complete_answer else {}

    result_indexes: dict[str, int] = {}
    available_pages: dict[int, set[int]] = {}
    for index, result in enumerate(document_results):
        result_indexes[f"D{index + 1:03d}"] = index
        document_id = str(result.get("document", {}).get("id") or "").strip()
        if document_id:
            result_indexes[document_id] = index
        available_pages[index] = {
            item["page"]
            for item in result.get("contextBlock", {}).get("evidence", [])
            if isinstance(item, dict)
            and _is_page_number(item.get("page"))
            and isinstance(item.get("content"), str)
            and item["content"].strip()
        }

    accepted: dict[int, set[int]] = {}
    for item in raw_matches:
        if not isinstance(item, dict):
            return None
        raw_identifier = item.get("candidate_id") or item.get("document_id")
        if not isinstance(raw_identifier, str) or not raw_identifier.strip():
            return None
        identifier = raw_identifier.strip()
        result_index = result_indexes.get(identifier)
        if result_index is None:
            return None

        raw_pages = item.get("supporting_pages")
        if isinstance(raw_pages, str):
            parsed_pages = _parse_page_window(raw_pages)
        elif isinstance(raw_pages, list):
            parsed_pages = raw_pages if all(_is_page_number(page) for page in raw_pages) else None
        else:
            parsed_pages = None
        if not parsed_pages:
            return None
        supported_pages = set(parsed_pages)
        if not supported_pages.issubset(available_pages[result_index]):
            return None
        accepted.setdefault(result_index, set()).update(supported_pages)

    return accepted or None


def _validate_retrieved_evidence(
    query: str,
    document_results: list[dict[str, Any]],
    mode: str,
) -> _EvidenceValidationResult:
    validation_indexes = [
        index
        for index, result in enumerate(document_results)
        if result.get("document", {}).get(EVIDENCE_VALIDATION_REASON_KEY)
    ]
    if not validation_indexes:
        return _EvidenceValidationResult(
            tuple(document_results),
            "matched" if document_results else "no_match",
        )

    validation_results = [document_results[index] for index in validation_indexes]
    candidates = _compact_validation_candidates(query, validation_results)
    validation_goal = (
        "Keep pages only when their combined text directly supports every material part of the "
        "question and is sufficient to answer it accurately and completely. If the text supports "
        "only part of the requested result, mark it insufficient and return no matches."
        if mode != "evidence"
        else (
            "Keep a candidate only when its page text directly supports the requested fact and "
            "all of the query's qualifiers, such as year, version, product level, or audience. "
            "A neighboring topic or a different year's threshold is not safe evidence."
        )
    )
    output_contract = (
        "Return JSON only:\n"
        '{"sufficient":true,"matches":[{"candidate_id":"D001",'
        '"supporting_pages":[1,3]}]}\n'
        'Return {"sufficient":false,"matches":[]} when the collected pages cannot '
        "fully answer the question."
        if mode != "evidence"
        else (
            "Return JSON only:\n"
            '{"matches":[{"candidate_id":"D001","supporting_pages":[1,3]}]}\n'
            'Return {"matches":[]} when none of the candidates are directly relevant evidence.'
        )
    )
    prompt = f"""
You are validating page evidence collected by the retrieval candidate stage.
{validation_goal}

Question: {query}
Candidate page text:
{json.dumps(candidates, ensure_ascii=False)}

Exclude candidates that merely share keywords, discuss a neighboring topic, or do not contain
the requested fact. Never infer a fact that is absent from the page text. A page that mentions
the requested year only in an unrelated note does not support a year-specific answer; the fact
itself must be stated for that year. Never use a different year's value as evidence.
{output_contract}
"""

    from pageindex.utils import extract_json

    try:
        raw, completion_error = _retrieval_completion(prompt)
        if completion_error:
            raise ValueError(completion_error)
        parsed = extract_json(raw)
        accepted_local_indexes = _parse_evidence_validation_matches(
            parsed,
            validation_results,
            require_complete_answer=mode != "evidence",
        )
    except Exception:
        accepted_local_indexes = None

    if accepted_local_indexes is None:
        retained = tuple(
            result
            for index, result in enumerate(document_results)
            if index not in validation_indexes
        )
        logger.warning(
            "Retrieved evidence validation failed mode=%s attempted=%d retained=%d",
            mode,
            len(validation_indexes),
            len(retained),
        )
        return _EvidenceValidationResult(
            retained,
            "degraded",
            degraded_reason="evidence_validation_failed",
            attempted_count=len(validation_indexes),
            accepted_count=0,
        )

    accepted_by_global_index = {
        validation_indexes[local_index]: pages
        for local_index, pages in accepted_local_indexes.items()
    }
    retained_results: list[dict[str, Any]] = []
    accepted_count = 0
    for index, result in enumerate(document_results):
        if index not in validation_indexes:
            retained_results.append(result)
            continue
        supporting_pages = accepted_by_global_index.get(index)
        if not supporting_pages:
            continue
        supporting_evidence = [
            item
            for item in result.get("contextBlock", {}).get("evidence", [])
            if isinstance(item, dict)
            and item.get("page") in supporting_pages
            and isinstance(item.get("content"), str)
            and item["content"].strip()
        ]
        if not supporting_evidence:
            continue
        retained_results.append(
            _assemble_document_result(
                query,
                result["document"],
                mode,
                _format_page_window(supporting_pages),
                supporting_evidence,
            )
        )
        accepted_count += 1

    logger.info(
        "Retrieved evidence validation completed mode=%s attempted=%d accepted=%d",
        mode,
        len(validation_indexes),
        accepted_count,
    )
    return _EvidenceValidationResult(
        tuple(retained_results),
        "matched" if retained_results else "no_match",
        attempted_count=len(validation_indexes),
        accepted_count=accepted_count,
    )


def _finalize_document_results(
    selected: list[dict[str, Any]],
    results: Iterable[dict[str, Any] | None],
) -> _DocumentResults:
    retained = [result for result in results if result is not None]
    degraded_reasons = [
        reason
        for result in retained
        for reason in result.get(DOCUMENT_DEGRADED_REASONS_KEY, ())
        if isinstance(reason, str) and reason
    ]
    if len(retained) < len(selected):
        degraded_reasons.append("evidence_collection_failed")
    return _DocumentResults(
        retained,
        attempted_count=len(selected),
        degraded_reasons=degraded_reasons,
    )


def _load_ready_documents(
    db_path: str,
    project_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
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
                   d.source_item_external_id,
                   s.display_name AS source_display_name, s.kind AS source_kind,
                   s.scope_json AS source_scope_json,
                   di.doc_description, di.structure_json, di.pages_json,
                   di.evidence_kind, di.visual_assets_json
              FROM documents d
              JOIN projects p ON p.id = d.project_id
              JOIN document_indexes di ON di.document_id = d.id
              LEFT JOIN corpus_sources s ON s.id = d.source_id
              LEFT JOIN source_collections c ON c.id = d.source_collection_id
             WHERE d.status = 'ready'
               AND d.deleted_at IS NULL
               AND d.lifecycle_state = 'active'
               AND d.retrieval_eligible = 1
               AND di.is_current = 1
               AND p.deleted_at IS NULL
               AND p.lifecycle_state = 'active'
               AND p.retrieval_eligible = 1
               AND (
                 d.source_id IS NULL OR (
                   s.deleted_at IS NULL AND s.state = 'active'
                   AND c.deleted_at IS NULL AND c.selected = 1
                   AND c.registration_state = 'active'
                   AND c.validation_state = 'valid'
                   AND c.lifecycle_state = 'active'
                 )
               )
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
        document = {
            "id": row["id"],
            "project_id": row["project_id"],
            "project_name": row["project_name"],
            "source_display_name": row["source_display_name"],
            "source_kind": row["source_kind"],
            "source_item_external_id": row["source_item_external_id"],
            "source_endpoint": None,
            "file_name": row["file_name"],
            "source_relative_path": row["source_relative_path"],
            "project_relative_path": row["project_relative_path"],
            "doc_description": row["doc_description"],
            "evidence_kind": row["evidence_kind"],
            "visual_assets": _parse_json_list(row["visual_assets_json"]),
            "structure": structure,
            "pages": pages,
        }
        if row["source_kind"] == "seeyon":
            try:
                source_scope = json.loads(row["source_scope_json"] or "{}")
            except (json.JSONDecodeError, TypeError):
                source_scope = {}
            if isinstance(source_scope, dict):
                document["source_endpoint"] = source_scope.get("endpoint")
        document["document_url"] = _document_url(document)
        docs.append(document)
    return docs


def _selected_documents_payload(
    used_documents: list[dict[str, Any]],
    mode: str,
) -> list[dict[str, str | None]]:
    return [
        {"documentId": document["id"]}
        if mode != "evidence" or not document.get("source_relative_path")
        else {
            "documentId": document["id"],
            "sourceRelativePath": document.get("source_relative_path"),
        }
        for document in used_documents
    ]


def _selection_status(selected: list[dict[str, Any]]) -> tuple[RetrievalStatus, str | None]:
    outcome = getattr(selected, "model_outcome", None)
    if outcome in {"provider_error", "malformed", "invalid_ids", "partial"}:
        return "degraded", f"candidate_selection_{outcome}"
    return "matched", None


def _evidence_collection_degraded_reason(
    selected: list[dict[str, Any]],
    document_results: list[dict[str, Any]],
) -> str | None:
    degraded_reasons = getattr(document_results, "degraded_reasons", ())
    for reason in degraded_reasons:
        if isinstance(reason, str) and reason:
            return reason
    if len(document_results) < len(selected):
        return "evidence_collection_failed"
    return None


def _combine_retrieval_status(
    selected: list[dict[str, Any]],
    validation: _EvidenceValidationResult,
    collection_degraded_reason: str | None = None,
) -> tuple[RetrievalStatus, str | None]:
    selection_status, selection_reason = _selection_status(selected)
    if validation.status == "degraded":
        return "degraded", validation.degraded_reason
    if collection_degraded_reason:
        return "degraded", collection_degraded_reason
    if selection_status == "degraded":
        return selection_status, selection_reason
    return validation.status, validation.degraded_reason


def _empty_retrieval_result(
    message: str,
    mode: str,
    *,
    status: RetrievalStatus = "no_match",
    degraded_reason: str | None = None,
) -> dict[str, Any]:
    result = {
        "answer": "" if mode == "evidence" else message,
        "citations": [],
        "selectedDocuments": [],
        "evidence": [],
        "retrievalStatus": status,
    }
    if degraded_reason:
        result["degradedReason"] = degraded_reason
    return result


def _build_answer_result(
    query: str,
    document_results: list[dict[str, Any]],
    mode: str,
    *,
    status: RetrievalStatus = "matched",
    degraded_reason: str | None = None,
) -> dict[str, Any]:
    context_blocks = [result["contextBlock"] for result in document_results]
    citations = [
        result["citation"]
        for result in document_results
        if result["citation"] is not None
    ]
    evidence_blocks = [result["evidenceBlock"] for result in document_results]
    used_documents = [result["document"] for result in document_results]

    if not used_documents:
        return _empty_retrieval_result(
            "I could not find usable evidence in selected documents.",
            mode,
            status="no_match" if status == "matched" else status,
            degraded_reason=degraded_reason,
        )

    answer = "" if mode == "evidence" else _generate_answer(query, context_blocks)
    if mode != "evidence" and not answer:
        answer = "I could not generate an answer from the selected documents."
        status = "degraded"
        degraded_reason = "answer_generation_failed"

    result = {
        "answer": answer,
        "citations": citations,
        "selectedDocuments": _selected_documents_payload(used_documents, mode),
        "evidence": evidence_blocks if mode == "evidence" else [],
        "retrievalStatus": status,
    }
    if degraded_reason:
        result["degradedReason"] = degraded_reason
    return result


def answer_question(
    db_path: str,
    query: str,
    project_ids: list[str] | None = None,
    mode: str = "answer",
) -> dict:
    result: dict[str, Any] | None = None
    for event in _execute_retrieval_events(db_path, query, project_ids, mode=mode):
        if event.get("type") != "result":
            if result is not None:
                raise RuntimeError("retrieval execution emitted an event after its result")
            continue
        if result is not None:
            raise RuntimeError("retrieval execution produced multiple result events")
        event_result = event.get("data")
        if not isinstance(event_result, dict):
            raise RuntimeError("retrieval result event did not contain an object")
        result = event_result

    if result is None:
        raise RuntimeError("retrieval execution completed without a result event")
    return result


def _build_document_evidence_events(
    query: str,
    document: dict[str, Any],
    mode: str,
) -> Iterable[dict[str, Any]]:
    summary = _document_summary(document)
    yield _progress_event("document_evidence_started", {"document": summary})
    try:
        for step in _document_tree_search_steps(query, document, mode):
            if step["type"] == "pages_selected":
                yield _progress_event(
                    "document_pages_selected",
                    {
                        "document": summary,
                        "pages": step["pages"],
                        "round": step["round"],
                        "fallback": step["fallback"],
                    },
                )
                continue
            if step["type"] == "empty":
                yield _progress_event(
                    "document_evidence_skipped",
                    {"document": summary, "reason": step["reason"]},
                )
                return
            if step["type"] != "result":
                continue

            result = _assemble_document_result(
                query,
                document,
                mode,
                step["pages"],
                step["evidence"],
            )
            degraded_reasons = step.get("degraded_reasons", ())
            if degraded_reasons:
                result[DOCUMENT_DEGRADED_REASONS_KEY] = tuple(degraded_reasons)
            validation_reason = document.get(EVIDENCE_VALIDATION_REASON_KEY)
            progress_data = {
                "document": summary,
                "pages": step["pages"],
                "evidenceCount": len(step["evidence"]),
            }
            if validation_reason:
                progress_data["validationReason"] = validation_reason
                progress_stage = "document_evidence_pending_validation"
            else:
                progress_data["excerpt"] = result["evidenceBlock"]["excerpt"]
                progress_stage = "document_evidence_loaded"
            yield _progress_event(progress_stage, progress_data)
            yield {"type": "document_result", "data": result}
    except Exception:
        logger.exception(
            "Failed to build retrieval evidence for document %s",
            document.get("id"),
        )
        yield _progress_event(
            "document_evidence_skipped",
            {"document": summary, "reason": "error"},
        )


def _build_selected_documents_evidence_events(
    query: str,
    selected: list[dict[str, Any]],
    mode: str,
    cancellation_event: Event | None = None,
) -> Generator[dict[str, Any], None, _DocumentResults]:
    if not selected:
        return _DocumentResults([], attempted_count=0)

    event_queue: Queue[tuple[int, object]] = Queue()
    done_marker = object()
    stop_event = Event()
    cancellation_signal = _CancellationSignal(stop_event, cancellation_event)
    document_results: list[dict[str, Any] | None] = [None] * len(selected)

    def process_document(index: int, document: dict[str, Any]) -> None:
        events = None
        try:
            if cancellation_signal.is_set():
                return

            events = _build_document_evidence_events(query, document, mode)
            while not cancellation_signal.is_set():
                with llm_request_scope(
                    cancellation_signal,
                    timeout_seconds=_retrieval_llm_timeout_seconds(),
                ):
                    try:
                        event = next(events)
                    except StopIteration:
                        break
                if cancellation_signal.is_set():
                    break
                event_queue.put((index, event))
        except Exception:
            if not cancellation_signal.is_set():
                logger.exception(
                    "Failed to stream retrieval evidence for document %s",
                    document.get("id"),
                )
                event_queue.put(
                    (
                        index,
                        _progress_event(
                            "document_evidence_skipped",
                            {"document": _document_summary(document), "reason": "error"},
                        ),
                    )
                )
        finally:
            try:
                close = getattr(events, "close", None) if events is not None else None
                if callable(close):
                    close()
            except Exception:
                if not cancellation_signal.is_set():
                    logger.exception(
                        "Failed to close retrieval event iterator for document %s",
                        document.get("id"),
                    )

    futures: dict[int, Future] = {}
    next_index = 0

    def submit_document(index: int) -> None:
        future = _DOCUMENT_RETRIEVAL_EXECUTOR.submit(
            process_document,
            index,
            selected[index],
        )
        futures[index] = future
        future.add_done_callback(
            lambda _future, document_index=index: event_queue.put(
                (document_index, done_marker)
            )
        )

    try:
        initial_count = min(MAX_PARALLEL_DOCUMENT_RETRIEVALS, len(selected))
        for _ in range(initial_count):
            submit_document(next_index)
            next_index += 1

        completed = 0
        while completed < len(selected):
            if cancellation_signal.is_set():
                break
            try:
                index, item = event_queue.get(timeout=0.1)
            except Empty:
                continue
            if item is done_marker:
                completed += 1
                futures.pop(index, None)
                if next_index < len(selected):
                    submit_document(next_index)
                    next_index += 1
                continue

            event = item
            if not isinstance(event, dict):
                continue
            if event.get("type") == "document_result":
                document_results[index] = event["data"]
                continue
            yield event
    finally:
        stop_event.set()
        for future in tuple(futures.values()):
            future.cancel()

    return _finalize_document_results(selected, document_results)


# Canonical orchestration shared by the synchronous and streaming adapters.
def _execute_retrieval_events(
    db_path: str,
    query: str,
    project_ids: list[str] | None = None,
    mode: str = "answer",
    cancellation_event: Event | None = None,
) -> Iterable[dict[str, Any]]:
    yield _progress_event(
        "retrieval_started",
        {"query": query, "projectIds": project_ids or [], "mode": mode},
    )
    docs = _load_ready_documents(db_path, project_ids)
    yield _progress_event("documents_loaded", {"documentCount": len(docs)})

    retrieval_limit = get_retrieval_document_limit(
        db_path,
        default=DEFAULT_RETRIEVAL_DOCUMENT_LIMIT,
    )
    yield _progress_event(
        "document_selection_started",
        {"documentCount": len(docs), "limit": retrieval_limit},
    )
    with llm_request_scope(
        cancellation_event,
        timeout_seconds=_retrieval_llm_timeout_seconds(),
    ):
        selected = select_candidate_documents(
            query,
            docs,
            limit=retrieval_limit,
            model=_get_retrieval_model(),
            mode=mode,
        )
    if cancellation_event is not None and cancellation_event.is_set():
        return
    yield _progress_event(
        "documents_selected",
        {
            "documentCount": len(selected),
            "documents": [_document_summary(document) for document in selected],
            "selectionStrategy": getattr(selected, "strategy", "unspecified"),
            "modelOutcome": getattr(selected, "model_outcome", "unspecified"),
        },
    )
    if not selected:
        status, degraded_reason = _selection_status(selected)
        if status == "matched":
            status = "no_match"
        result = _empty_retrieval_result(
            (
                "Candidate document selection could not be completed reliably."
                if status == "degraded"
                else "No ready documents matched the retrieval scope."
                if not docs
                else "No relevant documents were found in the retrieval scope."
            ),
            mode,
            status=status,
            degraded_reason=degraded_reason,
        )
        yield _progress_event(
            "retrieval_completed",
            {"documentCount": 0, "retrievalStatus": status},
        )
        yield _result_event(result)
        return

    yield _progress_event("evidence_started", {"documentCount": len(selected)})
    document_results = yield from _build_selected_documents_evidence_events(
        query,
        selected,
        mode,
        cancellation_event,
    )
    if cancellation_event is not None and cancellation_event.is_set():
        return
    collection_degraded_reason = _evidence_collection_degraded_reason(
        selected,
        document_results,
    )

    validation_candidate_count = sum(
        bool(document.get(EVIDENCE_VALIDATION_REASON_KEY)) for document in selected
    )
    if validation_candidate_count:
        yield _progress_event(
            "evidence_validation_started",
            {"documentCount": validation_candidate_count},
        )
    with llm_request_scope(
        cancellation_event,
        timeout_seconds=_retrieval_llm_timeout_seconds(),
    ):
        validation = _validate_retrieved_evidence(query, document_results, mode)
    if cancellation_event is not None and cancellation_event.is_set():
        return
    status, degraded_reason = _combine_retrieval_status(
        selected,
        validation,
        collection_degraded_reason,
    )
    document_results = list(validation.document_results)
    if validation_candidate_count:
        yield _progress_event(
            "evidence_validation_completed",
            {
                "attemptedCount": validation.attempted_count,
                "acceptedCount": validation.accepted_count,
                "retrievalStatus": status,
            },
        )

    if not document_results:
        result = _empty_retrieval_result(
            (
                "Retrieval could not be completed reliably; no evidence was returned."
                if status == "degraded"
                else "No directly supporting evidence was found in the selected documents."
            ),
            mode,
            status=status,
            degraded_reason=degraded_reason,
        )
        yield _progress_event(
            "retrieval_completed",
            {"documentCount": 0, "retrievalStatus": status},
        )
        yield _result_event(result)
        return

    if mode != "evidence":
        yield _progress_event(
            "answer_generation_started",
            {"evidenceDocumentCount": len(document_results)},
        )
    with llm_request_scope(
        cancellation_event,
        timeout_seconds=_retrieval_llm_timeout_seconds(),
    ):
        result = _build_answer_result(
            query,
            document_results,
            mode,
            status=status,
            degraded_reason=degraded_reason,
        )
    if cancellation_event is not None and cancellation_event.is_set():
        return
    if mode != "evidence":
        yield _progress_event(
            "answer_generation_completed",
            {"citationCount": len(result["citations"])},
        )
    yield _progress_event(
        "retrieval_completed",
        {
            "documentCount": len(result["selectedDocuments"]),
            "retrievalStatus": result["retrievalStatus"],
        },
    )
    yield _result_event(result)


def answer_question_events(
    db_path: str,
    query: str,
    project_ids: list[str] | None = None,
    mode: str = "answer",
    cancellation_event: Event | None = None,
) -> Iterable[dict[str, Any]]:
    yield from _execute_retrieval_events(
        db_path,
        query,
        project_ids,
        mode=mode,
        cancellation_event=cancellation_event,
    )
