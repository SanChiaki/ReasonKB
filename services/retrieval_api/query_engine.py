import json
from contextlib import contextmanager
from contextvars import ContextVar
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, replace
import logging
import math
import os
from queue import Empty, Queue
import re
import sqlite3
from threading import Condition, Event
from time import monotonic, perf_counter
from typing import Any, Generator, Iterable, Literal
from urllib.parse import urlencode, urlsplit, urlunsplit
from uuid import uuid4

from services.common.pageindex_runtime import (
    configure_pageindex_runtime,
    llm_request_scope,
)
from services.common.retrieval_llm import complete as complete_retrieval_llm
from services.common.sqlite_store import open_db
from services.common.system_settings import (
    get_llm_runtime_settings,
    get_retrieval_document_limit,
)
from services.retrieval_api.select_documents import (
    EVIDENCE_VALIDATION_REASON_KEY,
    candidate_completion_scope,
    document_supports_query_dealer_tier,
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
MAX_LIST_OVERVIEW_PAGES = 4
MAX_TREE_ASSESSMENT_CHARS = 48000
MAX_EVIDENCE_VALIDATION_CHARS = 48000
DEFAULT_RETRIEVAL_DOCUMENT_LIMIT = 5
DEFAULT_RETRIEVAL_LLM_TIMEOUT_SECONDS = 300.0
DEFAULT_ANSWER_LLM_TIMEOUT_SECONDS = 300.0
DEFAULT_RETRIEVAL_REQUEST_TIMEOUT_SECONDS = 600.0
DEFAULT_RETRIEVAL_LLM_CONCURRENCY = 2
DEFAULT_RETRIEVAL_DOCUMENT_CONCURRENCY = 2
DEFAULT_EVIDENCE_INITIAL_DOCUMENTS = 2
DEFAULT_ANSWER_LLM_MAX_ATTEMPTS = 1
DEFAULT_ANSWER_MAX_OUTPUT_TOKENS = 4096
CANDIDATE_SELECTION_MAX_TOKENS = 512
PAGE_SELECTION_MAX_TOKENS = 384
EVIDENCE_ASSESSMENT_MAX_TOKENS = 384
TREE_ASSESSMENT_ESCALATION_MAX_TOKENS = 512
EVIDENCE_VALIDATION_MAX_TOKENS = 768
EVIDENCE_COVERAGE_MAX_TOKENS = 384
DOCUMENT_DEGRADED_REASONS_KEY = "_reasonkb_retrieval_degraded_reasons"
logger = logging.getLogger(__name__)
_DOCUMENT_RETRIEVAL_EXECUTOR = ThreadPoolExecutor(
    max_workers=MAX_PARALLEL_DOCUMENT_RETRIEVALS,
    thread_name_prefix="reasonkb-retrieval",
)

RetrievalStatus = Literal["matched", "no_match", "degraded"]
EvidenceCoverage = Literal["complete", "incomplete", "unknown"]
EvidenceCoverageConfidence = Literal["high", "medium", "low"]


@dataclass(frozen=True)
class _QueryLlmContext:
    request_id: str
    retrieval_model: str
    answer_model: str
    api_key: str
    base_url: str
    deadline: float
    cancellation_event: Any = None
    db_path: str = ""


_QUERY_LLM_CONTEXT: ContextVar[_QueryLlmContext | None] = ContextVar(
    "reasonkb_query_llm_context",
    default=None,
)
_TREE_ASSESSMENT_REASONING: ContextVar[str] = ContextVar(
    "reasonkb_tree_assessment_reasoning",
    default="disabled",
)


@dataclass(frozen=True)
class _EvidenceValidationResult:
    document_results: tuple[dict[str, Any], ...]
    status: RetrievalStatus
    degraded_reason: str | None = None
    attempted_count: int = 0
    accepted_count: int = 0


@dataclass(frozen=True)
class _EvidenceCoverageResult:
    coverage: EvidenceCoverage
    confidence: EvidenceCoverageConfidence
    unresolved: tuple[str, ...] = ()
    degraded_reason: str | None = None


@dataclass(frozen=True)
class _EvidenceExpansionResult:
    document_results: "_DocumentResults"
    attempted_documents: tuple[dict[str, Any], ...]
    coverage: _EvidenceCoverageResult | None = None
    coverage_failed: bool = False


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


class _RetrievalLlmCapacity:
    def __init__(self) -> None:
        self._condition = Condition()
        self._active = 0

    def acquire(
        self,
        *,
        limit: int,
        deadline: float,
        cancellation_signal: Any,
    ) -> bool:
        with self._condition:
            while self._active >= limit:
                if _signal_is_set(cancellation_signal):
                    return False
                remaining = deadline - monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(timeout=min(0.05, remaining))
            if _signal_is_set(cancellation_signal) or monotonic() >= deadline:
                return False
            self._active += 1
            return True

    def release(self) -> None:
        with self._condition:
            self._active -= 1
            self._condition.notify_all()


_RETRIEVAL_LLM_CAPACITY = _RetrievalLlmCapacity()


def _signal_is_set(signal: Any) -> bool:
    is_set = getattr(signal, "is_set", None)
    return bool(callable(is_set) and is_set())


def _configured_timeout_seconds(name: str, default: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default
    if not math.isfinite(value) or value <= 0:
        return default
    return min(value, 600.0)


def _retrieval_llm_timeout_seconds() -> float:
    return _configured_timeout_seconds(
        "RETRIEVAL_LLM_REQUEST_TIMEOUT_SECONDS",
        DEFAULT_RETRIEVAL_LLM_TIMEOUT_SECONDS,
    )


def _answer_llm_timeout_seconds() -> float:
    return _configured_timeout_seconds(
        "ANSWER_LLM_REQUEST_TIMEOUT_SECONDS",
        DEFAULT_ANSWER_LLM_TIMEOUT_SECONDS,
    )


def _retrieval_request_timeout_seconds() -> float:
    return _configured_timeout_seconds(
        "RETRIEVAL_REQUEST_TIMEOUT_SECONDS",
        DEFAULT_RETRIEVAL_REQUEST_TIMEOUT_SECONDS,
    )


def _configured_attempts(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default
    return min(max(value, 1), 2)


def _retrieval_llm_max_attempts() -> int:
    return _configured_attempts("RETRIEVAL_LLM_MAX_ATTEMPTS", 2)


def _answer_llm_max_attempts() -> int:
    return _configured_attempts(
        "ANSWER_LLM_MAX_ATTEMPTS",
        DEFAULT_ANSWER_LLM_MAX_ATTEMPTS,
    )


def _answer_max_output_tokens() -> int:
    try:
        value = int(
            os.getenv(
                "ANSWER_LLM_MAX_OUTPUT_TOKENS",
                str(DEFAULT_ANSWER_MAX_OUTPUT_TOKENS),
            )
        )
    except (TypeError, ValueError):
        return DEFAULT_ANSWER_MAX_OUTPUT_TOKENS
    return min(max(value, 256), 8192)


_ANSWER_COMPLEXITY_RE = re.compile(
    r"(?:\b(?:compare|comparison|contrast|difference|why|how|impact|steps?|"
    r"trade[- ]?offs?)\b|比较|对比|差异|分别|各自|为什么|为何|如何|影响|原因|"
    r"步骤|同时|并且|跨文档|多跳|优缺点|异同)",
    re.IGNORECASE,
)

_RETRIEVAL_COMPLEXITY_RE = re.compile(
    r"(?:\b(?:compare|comparison|contrast|difference|relationship|cause|why|"
    r"impact|across\s+documents?|multi[- ]?hop|trade[- ]?offs?)\b|"
    r"比较|对比|差异|异同|关联|关系|原因|为什么|为何|影响|跨文档|多跳|权衡)",
    re.IGNORECASE,
)


def _tree_assessment_reasoning_mode(
    query: str,
    round_number: int,
) -> Literal["disabled", "low"]:
    if round_number < MAX_TREE_SEARCH_ROUNDS:
        return "disabled"
    query_text = query.strip() if isinstance(query, str) else ""
    if len(query_text) > 160 or _RETRIEVAL_COMPLEXITY_RE.search(query_text):
        return "low"
    return "disabled"


def _answer_reasoning_mode(
    query: str,
    context_blocks: list[dict[str, Any]],
) -> Literal["disabled", "low", "default"]:
    """Choose answer reasoning without making provider-default thinking implicit.

    Retrieval already performs the evidence navigation.  Ordinary synthesis is
    therefore sent with explicit non-thinking controls; only clearly multi-step
    questions or unusually broad evidence sets receive bounded low reasoning.
    Operators can override the policy with ANSWER_REASONING_MODE.
    """
    configured = os.getenv("ANSWER_REASONING_MODE", "auto").strip().lower()
    if configured in {"disabled", "low", "default"}:
        return configured  # type: ignore[return-value]
    if configured not in {"", "auto"}:
        logger.warning(
            "Unsupported ANSWER_REASONING_MODE=%r; using auto policy",
            configured,
        )

    query_text = query.strip() if isinstance(query, str) else ""
    if len(query_text) > 160 or _ANSWER_COMPLEXITY_RE.search(query_text):
        return "low"
    if len(context_blocks) > 2:
        return "low"
    evidence_chars = sum(
        len(item.get("content", ""))
        for block in context_blocks
        if isinstance(block, dict)
        for item in block.get("evidence", [])
        if isinstance(item, dict) and isinstance(item.get("content"), str)
    )
    return "low" if len(context_blocks) > 1 and evidence_chars > 24000 else "disabled"


def _retrieval_llm_concurrency() -> int:
    try:
        value = int(
            os.getenv(
                "RETRIEVAL_LLM_CONCURRENCY",
                str(DEFAULT_RETRIEVAL_LLM_CONCURRENCY),
            )
        )
    except (TypeError, ValueError):
        return DEFAULT_RETRIEVAL_LLM_CONCURRENCY
    return min(max(value, 1), MAX_PARALLEL_DOCUMENT_RETRIEVALS)


def _retrieval_document_concurrency() -> int:
    try:
        value = int(
            os.getenv(
                "RETRIEVAL_DOCUMENT_CONCURRENCY",
                str(DEFAULT_RETRIEVAL_DOCUMENT_CONCURRENCY),
            )
        )
    except (TypeError, ValueError):
        return DEFAULT_RETRIEVAL_DOCUMENT_CONCURRENCY
    return min(max(value, 1), MAX_PARALLEL_DOCUMENT_RETRIEVALS)


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


def _get_retrieval_model() -> str | None:
    context = _QUERY_LLM_CONTEXT.get()
    if context is not None:
        return context.retrieval_model
    config = ConfigLoader().load()
    return getattr(config, "retrieve_model", None) or getattr(config, "model", None)


def _get_answer_model() -> str | None:
    context = _QUERY_LLM_CONTEXT.get()
    if context is not None:
        return context.answer_model
    config = ConfigLoader().load()
    return getattr(config, "model", None) or getattr(config, "retrieve_model", None)


def _new_query_llm_context(
    db_path: str,
    cancellation_event: Event | None,
) -> _QueryLlmContext:
    settings = get_llm_runtime_settings(db_path)
    return _QueryLlmContext(
        db_path=db_path,
        request_id=uuid4().hex,
        retrieval_model=settings.retrieve_model or settings.model,
        answer_model=settings.model or settings.retrieve_model,
        api_key=settings.api_key,
        base_url=settings.base_url,
        deadline=monotonic() + _retrieval_request_timeout_seconds(),
        cancellation_event=cancellation_event,
    )


@contextmanager
def _query_llm_context_scope(context: _QueryLlmContext):
    token = _QUERY_LLM_CONTEXT.set(context)
    try:
        yield
    finally:
        _QUERY_LLM_CONTEXT.reset(token)


def _query_deadline_expired(context: _QueryLlmContext) -> bool:
    return monotonic() >= context.deadline


def _active_completion(
    prompt: str,
    *,
    model_role: Literal["retrieval", "answer"],
    stage: str,
    reasoning: Literal["disabled", "low", "default"],
    max_output_tokens: int | None,
) -> tuple[str | None, str | None, str | None]:
    context = _QUERY_LLM_CONTEXT.get()
    if context is None:
        return _pageindex_completion(
            prompt,
            model=_get_answer_model() if model_role == "answer" else _get_retrieval_model(),
        )

    capacity_acquired = False
    if model_role == "retrieval":
        capacity_acquired = _RETRIEVAL_LLM_CAPACITY.acquire(
            limit=_retrieval_llm_concurrency(),
            deadline=context.deadline,
            cancellation_signal=context.cancellation_event,
        )
        if not capacity_acquired:
            return None, "provider_error", None

    try:
        result = complete_retrieval_llm(
            model=(
                context.answer_model
                if model_role == "answer"
                else context.retrieval_model
            ),
            prompt=prompt,
            stage=stage,
            operation=model_role,
            reasoning=reasoning,
            max_output_tokens=max_output_tokens,
            timeout_seconds=(
                _answer_llm_timeout_seconds()
                if model_role == "answer"
                else _retrieval_llm_timeout_seconds()
            ),
            deadline=context.deadline,
            max_attempts=(
                _answer_llm_max_attempts()
                if model_role == "answer"
                else _retrieval_llm_max_attempts()
            ),
            cancellation_signal=context.cancellation_event,
            api_key=context.api_key,
            base_url=context.base_url,
            request_id=context.request_id,
            db_path=context.db_path,
        )
    finally:
        if capacity_acquired:
            _RETRIEVAL_LLM_CAPACITY.release()
    if result.content is None:
        return None, "provider_error", result.finish_reason
    return result.content, None, result.finish_reason


def _pageindex_completion(
    prompt: str,
    *,
    model: str | None,
) -> tuple[str | None, str | None, str | None]:
    from pageindex.utils import llm_completion

    try:
        completion_result = llm_completion(
            model=model,
            prompt=prompt,
            return_finish_reason=True,
        )
    except Exception:
        return None, "provider_error", None

    if isinstance(completion_result, tuple) and len(completion_result) == 2:
        raw, finish_reason = completion_result
    else:
        raw, finish_reason = completion_result, None
    if finish_reason == "error" or not isinstance(raw, str) or not raw.strip():
        return None, "provider_error", finish_reason
    return raw, None, finish_reason


def _retrieval_completion(
    prompt: str,
    *,
    stage: str = "retrieval",
    reasoning: Literal["disabled", "low"] = "disabled",
    max_output_tokens: int | None = None,
) -> tuple[str | None, str | None]:
    raw, error, _finish_reason = _active_completion(
        prompt,
        model_role="retrieval",
        stage=stage,
        reasoning=reasoning,
        max_output_tokens=max_output_tokens,
    )
    if _finish_reason == "max_output_reached":
        return None, "max_output_reached"
    return raw, error


def _candidate_completion(
    model,
    prompt,
    chat_history=None,
    return_finish_reason=False,
):
    del model, chat_history
    raw, error, finish_reason = _active_completion(
        prompt,
        model_role="retrieval",
        stage="candidate_document_selection",
        reasoning="disabled",
        max_output_tokens=CANDIDATE_SELECTION_MAX_TOKENS,
    )
    if error or raw is None:
        return ("", "error") if return_finish_reason else ""
    if return_finish_reason:
        return raw, finish_reason or "finished"
    return raw


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


_COMPLETE_LIST_QUERY_RE = re.compile(
    r"(?:\b(?:what\s+are|which|list|all|every|indicators?|dimensions?|"
    r"criteria|categories|taxonomy|overview)\b|"
    r"哪些|哪几|所有|全部|指标|维度|清单|分类|构成|组成|列出|分别|"
    r"(?:全部|所有)[^。！？]{0,12}规则|规则(?:是?什么|有哪些|包括(?:哪些|什么)?|如下))",
    re.IGNORECASE,
)
_OVERVIEW_NODE_RE = re.compile(
    r"(?:preface|overview|summary|abstract|introduction|contents|table\s+of\s+contents|"
    r"前言|概述|摘要|目录|总览|评估框架|总体说明)",
    re.IGNORECASE,
)


def _is_complete_list_query(query: str) -> bool:
    return isinstance(query, str) and bool(_COMPLETE_LIST_QUERY_RE.search(query))


def _overview_pages_for_list_query(
    query: str,
    document: dict[str, Any],
) -> list[int]:
    """Return a small structural overview window for complete-list questions.

    PageIndex's model normally selects the overview node itself.  Some tree
    summaries put the first half of a list in that node while the model chooses
    only a later detail node.  The deterministic augmentation keeps the model's
    selected pages and adds only the bounded overview prefix; it does not scan
    page text or replace tree navigation.
    """
    if not _is_complete_list_query(query):
        return []

    available = set(_available_page_numbers(document))
    if not available:
        return []

    overview_pages: list[int] = []
    for node in _iter_structure_nodes(document.get("structure", [])):
        node_id = str(node.get("node_id") or "").strip()
        title = node.get("title") if isinstance(node.get("title"), str) else ""
        summary = node.get("summary") if isinstance(node.get("summary"), str) else ""
        is_overview = node_id == "0000" or bool(
            _OVERVIEW_NODE_RE.search(f"{title} {summary}")
        )
        if not is_overview:
            continue
        start = node.get("start_index")
        end = node.get("end_index", start)
        if not _is_page_number(start) or not _is_page_number(end) or end < start:
            continue

        # A root node can span a very large document.  Only a short prefix is
        # an overview candidate; the model-selected detail pages remain.
        end = min(end, start + MAX_LIST_OVERVIEW_PAGES - 1)
        overview_pages.extend(page for page in range(start, end + 1) if page in available)
        if len(set(overview_pages)) >= MAX_LIST_OVERVIEW_PAGES:
            break

    return sorted(set(overview_pages))[:MAX_LIST_OVERVIEW_PAGES]


def _augment_list_page_selection(
    query: str,
    document: dict[str, Any],
    selected_pages: list[int],
) -> list[int]:
    overview_pages = _overview_pages_for_list_query(query, document)
    if not overview_pages:
        return selected_pages

    selected = sorted(set(selected_pages))
    merged = sorted(set(selected).union(overview_pages))
    if len(merged) <= MAX_TREE_SEARCH_PAGES_PER_ROUND:
        return merged

    # Keep the overview prefix and fill the remaining first-round budget with
    # model-selected detail pages. Later tree-assessment rounds can add pages
    # that were intentionally left outside this bounded initial window.
    retained = set(overview_pages)
    for page in selected:
        if len(retained) >= MAX_TREE_SEARCH_PAGES_PER_ROUND:
            break
        retained.add(page)
    return sorted(retained)


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
) -> str:
    from pageindex.retrieve import get_document_structure
    from pageindex.utils import extract_json

    document_map = _build_document_map(document)
    fallback = _default_page_window(document)
    try:
        structure_json = get_document_structure(document_map, document["id"])
    except Exception:
        return _PageWindow(fallback, "page_structure_failed")
    prompt = f"""
You are performing PageIndex tree search over a document.
Find all distinct, specific tree nodes likely to contain relevant evidence. Favor recall across
sections, but exclude nodes with no plausible relevance. The same evidence set will be used for
raw Evidence results and Answer generation.
Prefer leaf nodes or narrow sections. Do not select a broad parent when a specific child is enough.
For questions asking for a list, all items, dimensions, indicators, criteria, or an overview,
include overview, preface, summary, or table nodes when their summaries enumerate requested items.
A generic node title is not a reason to skip it. Select every node needed to cover the complete list.

Question: {query}
Structure:
{structure_json}

Return JSON only:
{{"node_list": ["0007"], "pages": "3-5"}}
Use node_list when node IDs are available. Also return the corresponding physical pages.
"""
    raw, completion_error = _retrieval_completion(
        prompt,
        stage="page_selection",
        max_output_tokens=PAGE_SELECTION_MAX_TOKENS,
    )
    if completion_error:
        return _PageWindow(
            fallback,
            (
                "page_selection_truncated"
                if completion_error == "max_output_reached"
                else "page_selection_provider_error"
            ),
        )
    try:
        parsed = extract_json(raw)
    except Exception:
        return _PageWindow(fallback, "page_selection_malformed")
    if not isinstance(parsed, dict):
        return _PageWindow(fallback, "page_selection_malformed")

    selected_pages = _page_selection_from_payload(parsed, document)
    if selected_pages:
        selected_pages = _augment_list_page_selection(
            query,
            document,
            selected_pages,
        )
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
    if not isinstance(parsed, list):
        return []

    page_numbers = [
        item["page"]
        for item in parsed
        if isinstance(item, dict) and _is_page_number(item.get("page"))
    ]
    page_blocks = _load_page_blocks(document, page_numbers)
    if not page_blocks:
        return parsed
    return [
        {
            **item,
            **page_blocks.get(item.get("page"), {}),
        }
        if isinstance(item, dict)
        else item
        for item in parsed
    ]


def _load_page_blocks(
    document: dict[str, Any],
    page_numbers: list[int],
) -> dict[int, dict[str, Any]]:
    db_path = document.get("_db_path")
    index_id = document.get("_document_index_id")
    unique_pages = sorted(set(page_numbers))
    if not isinstance(db_path, str) or not isinstance(index_id, str) or not unique_pages:
        return {}

    placeholders = ",".join("?" for _ in unique_pages)
    try:
        with open_db(db_path) as conn:
            rows = conn.execute(
                f"""
                SELECT page_number, layout_status, blocks_json, diagnostics_json
                  FROM document_page_blocks
                 WHERE document_index_id = ?
                   AND page_number IN ({placeholders})
                """,
                [index_id, *unique_pages],
            ).fetchall()
    except sqlite3.OperationalError:
        return {}

    result: dict[int, dict[str, Any]] = {}
    for row in rows:
        blocks = [
            block
            for block in _parse_json_list(row["blocks_json"])
            if isinstance(block, dict) and block.get("type") == "table"
        ]
        try:
            diagnostics = json.loads(row["diagnostics_json"] or "{}")
        except (json.JSONDecodeError, TypeError):
            diagnostics = {}
        if row["layout_status"] == "no_table":
            continue
        result[row["page_number"]] = {
            "layoutStatus": row["layout_status"],
            "blocks": blocks,
            "layoutDiagnostics": diagnostics if isinstance(diagnostics, dict) else {},
        }
    return result


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
) -> _EvidenceAssessment:
    from pageindex.utils import extract_json, remove_fields

    if set(_available_page_numbers(document)).issubset(inspected_pages):
        return _EvidenceAssessment(True, None)

    structure = remove_fields(document.get("structure", []), fields=["text"])
    prompt = f"""
You are continuing a bounded PageIndex tree search.
Decide whether the collected evidence directly covers every material part of the question. Prefer
recall: continue when another distinct section is likely to contain relevant evidence. Do not answer
the question; only decide whether more document pages should be inspected.

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
  "next_node_list": [],
  "next_pages": ""
}}
"""
    reasoning = _TREE_ASSESSMENT_REASONING.get()
    raw, completion_error = _retrieval_completion(
        prompt,
        stage=(
            "tree_assessment_escalation"
            if reasoning == "low"
            else "tree_assessment"
        ),
        reasoning="low" if reasoning == "low" else "disabled",
        max_output_tokens=(
            TREE_ASSESSMENT_ESCALATION_MAX_TOKENS
            if reasoning == "low"
            else EVIDENCE_ASSESSMENT_MAX_TOKENS
        ),
    )
    if completion_error == "max_output_reached" and reasoning == "low":
        raw, completion_error = _retrieval_completion(
            prompt,
            stage="tree_assessment_fallback",
            reasoning="disabled",
            max_output_tokens=EVIDENCE_ASSESSMENT_MAX_TOKENS,
        )
    if completion_error:
        return _EvidenceAssessment(
            True,
            None,
            (
                "tree_assessment_truncated"
                if completion_error == "max_output_reached"
                else "tree_assessment_provider_error"
            ),
        )
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
) -> Iterable[dict[str, Any]]:
    degraded_reasons: list[str] = []
    fallback_pages = _default_page_window(document)
    selected = choose_page_window(query, document)
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
            reasoning_token = _TREE_ASSESSMENT_REASONING.set(
                _tree_assessment_reasoning_mode(query, round_number)
            )
            try:
                assessment = _assess_evidence_and_choose_next_pages(
                    query,
                    document,
                    evidence,
                    inspected_pages,
                )
            finally:
                _TREE_ASSESSMENT_REASONING.reset(reasoning_token)
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
    answer, _completion_error, _finish_reason = _active_completion(
        prompt,
        model_role="answer",
        stage="answer_generation",
        reasoning=_answer_reasoning_mode(query, context_blocks),
        max_output_tokens=_answer_max_output_tokens(),
    )
    if _finish_reason == "max_output_reached":
        logger.warning("Rejected truncated answer generation output")
        return ""
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
    pages: str,
    evidence: list[dict[str, Any]],
) -> dict[str, Any]:
    focus_page, excerpt = _select_citation_anchor(query, evidence)
    prompt_evidence = [
        {"page": item.get("page"), "content": item.get("content", "")}
        for item in evidence
        if isinstance(item, dict) and isinstance(item.get("content"), str)
    ]
    context_block = {
        "project": document["project_name"],
        "source": document.get("source_display_name"),
        "sourceKind": document.get("source_kind"),
        "document": document["file_name"],
        "sourceRelativePath": document.get("source_relative_path"),
        "projectRelativePath": document.get("project_relative_path"),
        "pages": pages,
        "evidence": prompt_evidence,
    }
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
    page_blocks = [
        {
            "page": item["page"],
            "layoutStatus": item["layoutStatus"],
            "blocks": item.get("blocks", []),
            "diagnostics": item.get("layoutDiagnostics", {}),
        }
        for item in evidence
        if isinstance(item, dict)
        and _is_page_number(item.get("page"))
        and isinstance(item.get("layoutStatus"), str)
    ]
    if page_blocks:
        evidence_block["pageBlocks"] = page_blocks
    if document.get("document_url"):
        evidence_block["documentUrl"] = document["document_url"]
    if document.get("source_display_name"):
        evidence_block["sourceDisplayName"] = document["source_display_name"]
        evidence_block["sourceKind"] = document.get("source_kind")
    return {
        "document": document,
        "contextBlock": context_block,
        "pageEvidence": evidence,
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


def _parse_evidence_coverage(payload: Any) -> _EvidenceCoverageResult | None:
    if not isinstance(payload, dict):
        return None
    coverage = payload.get("coverage")
    confidence = payload.get("confidence")
    unresolved = payload.get("unresolved")
    if coverage not in {"complete", "incomplete", "unknown"}:
        return None
    if confidence not in {"high", "medium", "low"}:
        return None
    if not isinstance(unresolved, list) or any(
        not isinstance(item, str) for item in unresolved
    ):
        return None
    normalized_unresolved = tuple(
        dict.fromkeys(item.strip() for item in unresolved if item.strip())
    )
    if coverage == "complete" and normalized_unresolved:
        return None
    return _EvidenceCoverageResult(
        coverage=coverage,
        confidence=confidence,
        unresolved=normalized_unresolved,
    )


def _assess_evidence_coverage(
    query: str,
    document_results: list[dict[str, Any]],
    remaining_documents: list[dict[str, Any]],
) -> _EvidenceCoverageResult:
    if not document_results:
        return _EvidenceCoverageResult(
            coverage="incomplete",
            confidence="high",
            unresolved=("No directly supporting page evidence has been collected.",),
        )

    current_evidence = _compact_validation_candidates(query, document_results)
    remaining_candidates = [
        {
            "document_name": document.get("file_name", ""),
            "project_name": document.get("project_name", ""),
            "project_relative_path": document.get("project_relative_path", ""),
            "source_relative_path": document.get("source_relative_path", ""),
            "document_description": document.get("doc_description", ""),
        }
        for document in remaining_documents
    ]
    prompt = f"""
You are deciding whether the shared EvidenceSet has complete evidence coverage or should inspect more candidate documents.

Mark coverage as complete only when the collected page text directly covers every material part,
constraint, comparison, list item, time period, and requested entity in the question. Also require
the remaining candidate summaries to show no plausible missing source. Be conservative for lists,
comparisons, multi-document questions, and questions asking for all or every item. Do not infer facts
that are absent from the collected text. Use incomplete when a specific part remains uncovered. Use
unknown when the available text or summaries do not support a reliable decision.

Question:
{query}

Collected page evidence:
{json.dumps(current_evidence, ensure_ascii=False)}

Not-yet-inspected candidate summaries:
{json.dumps(remaining_candidates, ensure_ascii=False)}

Return JSON only:
{{"coverage":"complete","confidence":"high","unresolved":[]}}
or
{{"coverage":"incomplete","confidence":"high","unresolved":["missing fact"]}}
"""

    from pageindex.utils import extract_json

    raw, completion_error = _retrieval_completion(
        prompt,
        stage="evidence_coverage",
        max_output_tokens=EVIDENCE_COVERAGE_MAX_TOKENS,
    )
    if completion_error or not raw:
        return _EvidenceCoverageResult(
            coverage="unknown",
            confidence="low",
            degraded_reason="evidence_coverage_failed",
        )
    try:
        parsed = extract_json(raw)
        coverage = _parse_evidence_coverage(parsed)
    except Exception:
        coverage = None
    if coverage is None:
        return _EvidenceCoverageResult(
            coverage="unknown",
            confidence="low",
            degraded_reason="evidence_coverage_failed",
        )
    return coverage


def _coverage_is_complete(result: _EvidenceCoverageResult | None) -> bool:
    return bool(
        result is not None
        and result.coverage == "complete"
        and result.confidence == "high"
        and not result.unresolved
        and result.degraded_reason is None
    )


def _parse_evidence_validation_matches(
    payload: Any,
    document_results: list[dict[str, Any]],
) -> dict[int, set[int]] | None:
    if not isinstance(payload, dict) or not isinstance(payload.get("matches"), list):
        return None

    raw_matches = payload["matches"]
    if not raw_matches:
        return {}

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


def _expand_evidence_supporting_pages(
    query: str,
    result: dict[str, Any],
    supporting_pages: set[int],
) -> set[int]:
    """Keep bounded table/list continuations that a page validator can omit.

    PageIndex returns physical page windows, while PDF/XLSX extraction often loses the grid
    relationship between a heading and its continuation rows. For complete-list and rule-set
    requests, a validated page makes the contiguous selected window around it relevant by
    construction. This restores that window without broadening to a separate, non-contiguous page
    selection.
    """
    if not supporting_pages or not _is_complete_list_query(query):
        return supporting_pages
    context_block = result.get("contextBlock", {})
    selected_pages = _parse_page_window(context_block.get("pages", ""))
    if not selected_pages:
        return supporting_pages
    selected_set = set(selected_pages)

    evidence_by_page = {
        item.get("page"): item.get("content")
        for item in context_block.get("evidence", [])
        if isinstance(item, dict)
        and _is_page_number(item.get("page"))
        and isinstance(item.get("content"), str)
    }

    def looks_like_continuation(content: object) -> bool:
        if not isinstance(content, str) or not content.strip():
            return False
        prefix = _normalize_whitespace(content[:600])
        # Section headings and explanatory prose are not table/list continuations,
        # even when they happen to be adjacent to a validated page.
        if re.match(
            r"^(?:第?\s*\d+\s*页[^。！？\n]*\s*)?"
            r"(?:[^。！？\n:：]{0,24})?"
            r"(?:目录|前言|概述|说明|评估细则|定义|规则|备注|注释)\s*[:：]",
            prefix,
            re.IGNORECASE,
        ):
            return False
        # Extracted tables often lose their row markers at a page boundary. Keep
        # explicit continuation wording as a bounded signal, while still relying
        # on the already selected physical page window.
        if re.search(r"(?:表格连续行|续页|续表|接上|连续(?:行|指标|项目))", prefix):
            return True
        if re.match(r"^表格(?:注释|备注)\s*[:：。]", prefix):
            return True
        return bool(
            re.search(
                r"(?:^|\s)(?:\d{1,3}\s*[.)、:]|[①②③④⑤⑥⑦⑧⑨⑩]|[-•|])",
                prefix,
            )
        )

    expanded = set(supporting_pages)

    # PDF/XLSX extraction can make the middle page of a continued table look
    # less relevant than the pages on either side. Fill only gaps bounded by
    # two validated pages inside the same model-selected contiguous run. This
    # restores lost table rows without extending into trailing detail pages.
    selected_runs: list[list[int]] = []
    for page in sorted(selected_set):
        if not selected_runs or page != selected_runs[-1][-1] + 1:
            selected_runs.append([page])
        else:
            selected_runs[-1].append(page)
    for run in selected_runs:
        run_support = sorted(page for page in run if page in supporting_pages)
        if len(run_support) >= 2:
            expanded.update(range(run_support[0], run_support[-1] + 1))

    # If a single validated page is followed by an explicitly marked
    # continuation, retain that next page as well. This handles lists whose
    # validator found only the heading page without broadening the selection.
    for page in sorted(selected_set):
        if page in expanded or page - 1 not in expanded:
            continue
        if looks_like_continuation(evidence_by_page.get(page)):
            expanded.add(page)
    return expanded


def _validate_retrieved_evidence(
    query: str,
    document_results: list[dict[str, Any]],
) -> _EvidenceValidationResult:
    supported_results: list[dict[str, Any]] = []
    deterministically_rejected_count = 0
    for result in document_results:
        page_texts = (
            item.get("content")
            for item in result.get("contextBlock", {}).get("evidence", [])
            if isinstance(item, dict)
        )
        if document_supports_query_dealer_tier(
            query,
            result.get("document", {}),
            page_texts,
        ):
            supported_results.append(result)
        else:
            deterministically_rejected_count += 1

    if deterministically_rejected_count:
        logger.info(
            "Rejected retrieved evidence with conflicting dealer tier count=%d",
            deterministically_rejected_count,
        )
    document_results = supported_results
    validation_indexes = [
        index
        for index, result in enumerate(document_results)
        if result.get("document", {}).get(EVIDENCE_VALIDATION_REASON_KEY)
    ]
    if not validation_indexes:
        return _EvidenceValidationResult(
            tuple(document_results),
            "matched" if document_results else "no_match",
            attempted_count=deterministically_rejected_count,
        )

    validation_results = [document_results[index] for index in validation_indexes]
    candidates = _compact_validation_candidates(query, validation_results)
    prompt = f"""
You are validating page evidence collected by the retrieval candidate stage.
Keep a candidate only when its page text directly supports a requested fact or material part of the
question and all applicable qualifiers, such as year, version, product level, audience, or entity.
A neighboring topic or a different year's threshold is not safe evidence. Preserve directly
supporting partial evidence; overall question completeness is assessed separately after validation.

Question: {query}
Candidate page text:
{json.dumps(candidates, ensure_ascii=False)}

Evaluate the candidate pages together, not each page in isolation. For a question asking for all
items in a list or table, supporting_pages must cover the complete list. If numbered rows continue
onto the next physical page, include that continuation page even when it does not repeat the heading
or qualifiers. Do not replace a list continuation page with a detailed explanation page merely
because the latter repeats more query keywords.

Exclude candidates that merely share keywords, discuss a neighboring topic, or do not contain
the requested fact. Never infer a fact that is absent from the page text. A page that mentions
the requested year only in an unrelated note does not support a year-specific answer; the fact
itself must be stated for that year. Never use a different year's value as evidence.
Return JSON only:
{{"matches":[{{"candidate_id":"D001","supporting_pages":[1,3]}}]}}
Return {{"matches":[]}} when none of the candidates are directly relevant evidence.
"""

    from pageindex.utils import extract_json

    try:
        raw, completion_error = _retrieval_completion(
            prompt,
            stage="evidence_validation",
            max_output_tokens=EVIDENCE_VALIDATION_MAX_TOKENS,
        )
        if completion_error:
            raise ValueError(completion_error)
        parsed = extract_json(raw)
        accepted_local_indexes = _parse_evidence_validation_matches(
            parsed,
            validation_results,
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
            "Retrieved evidence validation failed attempted=%d retained=%d",
            len(validation_indexes),
            len(retained),
        )
        return _EvidenceValidationResult(
            retained,
            "degraded",
            degraded_reason="evidence_validation_failed",
            attempted_count=(
                len(validation_indexes) + deterministically_rejected_count
            ),
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
        supporting_pages = _expand_evidence_supporting_pages(
            query,
            result,
            supporting_pages,
        )
        supporting_evidence = [
            item
            for item in result.get(
                "pageEvidence",
                result.get("contextBlock", {}).get("evidence", []),
            )
            if isinstance(item, dict)
            and item.get("page") in supporting_pages
            and isinstance(item.get("content"), str)
            and item["content"].strip()
        ]
        if not supporting_evidence:
            continue
        validated_document = dict(result["document"])
        validated_document.pop(EVIDENCE_VALIDATION_REASON_KEY, None)
        retained_results.append(
            _assemble_document_result(
                query,
                validated_document,
                _format_page_window(supporting_pages),
                supporting_evidence,
            )
        )
        accepted_count += 1

    logger.info(
        "Retrieved evidence validation completed attempted=%d accepted=%d",
        len(validation_indexes),
        accepted_count,
    )
    return _EvidenceValidationResult(
        tuple(retained_results),
        "matched" if retained_results else "no_match",
        attempted_count=len(validation_indexes) + deterministically_rejected_count,
        accepted_count=accepted_count,
    )


def _finalize_document_results(
    selected: list[dict[str, Any]],
    results: Iterable[dict[str, Any] | None],
    *,
    extra_degraded_reasons: Iterable[str] = (),
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
    degraded_reasons.extend(extra_degraded_reasons)
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
                   di.id AS document_index_id,
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
            "_db_path": db_path,
            "_document_index_id": row["document_index_id"],
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
    if isinstance(document_results, _DocumentResults):
        return None
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


def _request_deadline_result(
    mode: str,
    document_results: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if mode == "evidence" and document_results:
        return _build_answer_result(
            "",
            document_results,
            mode,
            status="degraded",
            degraded_reason="request_deadline_exceeded",
        )
    return _empty_retrieval_result(
        "Retrieval exceeded its request deadline before it could complete.",
        mode,
        status="degraded",
        degraded_reason="request_deadline_exceeded",
    )


def _validated_results_only(
    document_results: Iterable[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int]:
    retained: list[dict[str, Any]] = []
    pending_count = 0
    for result in document_results:
        if result.get("document", {}).get(EVIDENCE_VALIDATION_REASON_KEY):
            pending_count += 1
            continue
        retained.append(result)
    return retained, pending_count


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
        "citations": citations if mode != "evidence" else [],
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
) -> Iterable[dict[str, Any]]:
    summary = _document_summary(document)
    yield _progress_event("document_evidence_started", {"document": summary})
    try:
        for step in _document_tree_search_steps(query, document):
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
    cancellation_event: Event | None = None,
    *,
    query_context: _QueryLlmContext | None = None,
    document_concurrency: int | None = None,
) -> Generator[dict[str, Any], None, _DocumentResults]:
    if not selected:
        return _DocumentResults([], attempted_count=0)

    event_queue: Queue[tuple[int, object]] = Queue()
    done_marker = object()
    stop_event = Event()
    cancellation_signal = _CancellationSignal(stop_event, cancellation_event)
    document_results: list[dict[str, Any] | None] = [None] * len(selected)
    worker_query_context = (
        replace(query_context, cancellation_event=cancellation_signal)
        if query_context is not None
        else None
    )

    def process_document(index: int, document: dict[str, Any]) -> None:
        events = None
        try:
            if cancellation_signal.is_set() or (
                worker_query_context is not None
                and _query_deadline_expired(worker_query_context)
            ):
                return

            events = _build_document_evidence_events(query, document)
            while not cancellation_signal.is_set():
                if worker_query_context is not None:
                    if _query_deadline_expired(worker_query_context):
                        break
                    with _query_llm_context_scope(worker_query_context):
                        try:
                            event = next(events)
                        except StopIteration:
                            break
                else:
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
        request_concurrency = min(
            max(document_concurrency or MAX_PARALLEL_DOCUMENT_RETRIEVALS, 1),
            MAX_PARALLEL_DOCUMENT_RETRIEVALS,
        )
        initial_count = min(request_concurrency, len(selected))
        for _ in range(initial_count):
            submit_document(next_index)
            next_index += 1

        completed = 0
        while completed < len(selected):
            if cancellation_signal.is_set() or (
                query_context is not None and _query_deadline_expired(query_context)
            ):
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

    deadline_reasons = (
        ("request_deadline_exceeded",)
        if query_context is not None and _query_deadline_expired(query_context)
        else ()
    )
    return _finalize_document_results(
        selected,
        document_results,
        extra_degraded_reasons=deadline_reasons,
    )


def _build_progressive_evidence_events(
    query: str,
    selected: list[dict[str, Any]],
    cancellation_event: Event | None,
    *,
    query_context: _QueryLlmContext,
    document_concurrency: int,
) -> Generator[dict[str, Any], None, _EvidenceExpansionResult]:
    accumulated_results: list[dict[str, Any]] = []
    accumulated_reasons: list[str] = []
    attempted_documents: list[dict[str, Any]] = []
    coverage: _EvidenceCoverageResult | None = None
    coverage_failed = False
    next_index = 0
    wave_number = 0
    selection_reliable = _selection_status(selected)[0] != "degraded"

    while next_index < len(selected):
        if (
            cancellation_event is not None and cancellation_event.is_set()
        ) or _query_deadline_expired(query_context):
            break
        wave_number += 1
        wave_size = (
            min(DEFAULT_EVIDENCE_INITIAL_DOCUMENTS, document_concurrency)
            if wave_number == 1
            else document_concurrency
        )
        wave = selected[next_index : next_index + max(1, wave_size)]
        next_index += len(wave)
        attempted_documents.extend(wave)
        yield _progress_event(
            "evidence_wave_started",
            {
                "wave": wave_number,
                "documentCount": len(wave),
                "remainingDocumentCount": len(selected) - next_index,
            },
        )
        wave_results = yield from _build_selected_documents_evidence_events(
            query,
            wave,
            cancellation_event,
            query_context=query_context,
            document_concurrency=document_concurrency,
        )
        accumulated_results.extend(wave_results)
        accumulated_reasons.extend(wave_results.degraded_reasons)
        yield _progress_event(
            "evidence_wave_completed",
            {
                "wave": wave_number,
                "attemptedDocumentCount": len(wave),
                "evidenceDocumentCount": len(wave_results),
                "remainingDocumentCount": len(selected) - next_index,
            },
        )

        if (
            cancellation_event is not None and cancellation_event.is_set()
        ) or _query_deadline_expired(query_context):
            break

        pending_validation_count = sum(
            bool(result.get("document", {}).get(EVIDENCE_VALIDATION_REASON_KEY))
            for result in accumulated_results
        )
        if pending_validation_count:
            yield _progress_event(
                "evidence_validation_started",
                {
                    "wave": wave_number,
                    "documentCount": pending_validation_count,
                },
            )
            with _query_llm_context_scope(query_context):
                wave_validation = _validate_retrieved_evidence(
                    query,
                    accumulated_results,
                )
            accumulated_results = list(wave_validation.document_results)
            if wave_validation.degraded_reason:
                accumulated_reasons.append(wave_validation.degraded_reason)
            yield _progress_event(
                "evidence_validation_completed",
                {
                    "wave": wave_number,
                    "attemptedCount": wave_validation.attempted_count,
                    "acceptedCount": wave_validation.accepted_count,
                    "retrievalStatus": wave_validation.status,
                },
            )

        yield _progress_event(
            "evidence_coverage_started",
            {
                "wave": wave_number,
                "evidenceDocumentCount": len(accumulated_results),
                "remainingDocumentCount": len(selected) - next_index,
            },
        )
        with _query_llm_context_scope(query_context):
            coverage = _assess_evidence_coverage(
                query,
                accumulated_results,
                selected[next_index:],
            )
        coverage_failed = coverage_failed or bool(coverage.degraded_reason)
        yield _progress_event(
            "evidence_coverage_completed",
            {
                "wave": wave_number,
                "coverage": coverage.coverage,
                "confidence": coverage.confidence,
                "unresolved": list(coverage.unresolved),
                "remainingDocumentCount": len(selected) - next_index,
            },
        )
        if (
            selection_reliable
            and not accumulated_reasons
            and _coverage_is_complete(coverage)
        ):
            break

    return _EvidenceExpansionResult(
        document_results=_DocumentResults(
            accumulated_results,
            attempted_count=len(attempted_documents),
            degraded_reasons=accumulated_reasons,
        ),
        attempted_documents=tuple(attempted_documents),
        coverage=coverage,
        coverage_failed=coverage_failed,
    )


# Canonical orchestration shared by the synchronous and streaming adapters.
def _execute_retrieval_events(
    db_path: str,
    query: str,
    project_ids: list[str] | None = None,
    mode: str = "answer",
    cancellation_event: Event | None = None,
) -> Iterable[dict[str, Any]]:
    started_at = perf_counter()
    query_context = _new_query_llm_context(db_path, cancellation_event)
    yield _progress_event(
        "retrieval_started",
        {
            "query": query,
            "projectIds": project_ids or [],
            "mode": mode,
            "requestId": query_context.request_id,
        },
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
    selection_started_at = perf_counter()
    with _query_llm_context_scope(query_context):
        with candidate_completion_scope(_candidate_completion):
            selected = select_candidate_documents(
                query,
                docs,
                limit=retrieval_limit,
                model=query_context.retrieval_model,
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
            "elapsedMs": int((perf_counter() - selection_started_at) * 1000),
        },
    )
    if _query_deadline_expired(query_context):
        result = _request_deadline_result(mode)
        yield _progress_event(
            "retrieval_completed",
            {
                "documentCount": 0,
                "retrievalStatus": "degraded",
                "elapsedMs": int((perf_counter() - started_at) * 1000),
            },
        )
        yield _result_event(result)
        return
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
            {
                "documentCount": 0,
                "retrievalStatus": status,
                "elapsedMs": int((perf_counter() - started_at) * 1000),
            },
        )
        yield _result_event(result)
        return

    document_concurrency = _retrieval_document_concurrency()
    yield _progress_event(
        "evidence_started",
        {
            "documentCount": len(selected),
            "documentConcurrency": document_concurrency,
            "initialDocumentCount": min(
                DEFAULT_EVIDENCE_INITIAL_DOCUMENTS,
                document_concurrency,
                len(selected),
            ),
        },
    )
    evidence_expansion = yield from _build_progressive_evidence_events(
        query,
        selected,
        cancellation_event,
        query_context=query_context,
        document_concurrency=document_concurrency,
    )
    document_results = evidence_expansion.document_results
    attempted_documents = list(evidence_expansion.attempted_documents)
    if cancellation_event is not None and cancellation_event.is_set():
        return
    collection_degraded_reason = _evidence_collection_degraded_reason(
        attempted_documents,
        document_results,
    )
    if _query_deadline_expired(query_context):
        validated_results, pending_validation_count = _validated_results_only(
            document_results
        )
        if pending_validation_count:
            logger.warning(
                "Discarding %d unvalidated evidence documents at request deadline",
                pending_validation_count,
            )
        result = _request_deadline_result(mode, validated_results)
        yield _progress_event(
            "retrieval_completed",
            {
                "documentCount": len(result["selectedDocuments"]),
                "retrievalStatus": "degraded",
                "elapsedMs": int((perf_counter() - started_at) * 1000),
            },
        )
        yield _result_event(result)
        return

    validation_candidate_count = sum(
        bool(result.get("document", {}).get(EVIDENCE_VALIDATION_REASON_KEY))
        for result in document_results
    )
    if validation_candidate_count:
        yield _progress_event(
            "evidence_validation_started",
            {"documentCount": validation_candidate_count},
        )
    with _query_llm_context_scope(query_context):
        validation = _validate_retrieved_evidence(query, document_results)
    if cancellation_event is not None and cancellation_event.is_set():
        return
    document_results = list(validation.document_results)

    coverage = evidence_expansion.coverage
    coverage_failed = evidence_expansion.coverage_failed
    coverage_degraded_reason: str | None = None
    if document_results and (coverage is None or validation_candidate_count):
        yield _progress_event(
            "evidence_coverage_started",
            {
                "wave": "final",
                "evidenceDocumentCount": len(document_results),
                "remainingDocumentCount": 0,
            },
        )
        with _query_llm_context_scope(query_context):
            coverage = _assess_evidence_coverage(query, document_results, [])
        coverage_failed = coverage_failed or bool(coverage.degraded_reason)
        yield _progress_event(
            "evidence_coverage_completed",
            {
                "wave": "final",
                "coverage": coverage.coverage,
                "confidence": coverage.confidence,
                "unresolved": list(coverage.unresolved),
                "remainingDocumentCount": 0,
            },
        )
    if document_results:
        if coverage_failed or coverage is None or coverage.degraded_reason:
            coverage_degraded_reason = "evidence_coverage_failed"
        elif not _coverage_is_complete(coverage):
            coverage_degraded_reason = "evidence_expansion_limit_reached"

    status, degraded_reason = _combine_retrieval_status(
        selected,
        validation,
        collection_degraded_reason,
    )
    if coverage_degraded_reason and status != "degraded":
        status = "degraded"
        degraded_reason = coverage_degraded_reason
    if validation_candidate_count:
        yield _progress_event(
            "evidence_validation_completed",
            {
                "attemptedCount": validation.attempted_count,
                "acceptedCount": validation.accepted_count,
                "retrievalStatus": status,
            },
        )

    if _query_deadline_expired(query_context):
        result = _request_deadline_result(mode, document_results)
        yield _progress_event(
            "retrieval_completed",
            {
                "documentCount": len(result["selectedDocuments"]),
                "retrievalStatus": "degraded",
                "elapsedMs": int((perf_counter() - started_at) * 1000),
            },
        )
        yield _result_event(result)
        return

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
            {
                "documentCount": 0,
                "retrievalStatus": status,
                "elapsedMs": int((perf_counter() - started_at) * 1000),
            },
        )
        yield _result_event(result)
        return

    if mode != "evidence":
        yield _progress_event(
            "answer_generation_started",
            {"evidenceDocumentCount": len(document_results)},
        )
    with _query_llm_context_scope(query_context):
        result = _build_answer_result(
            query,
            document_results,
            mode,
            status=status,
            degraded_reason=degraded_reason,
        )
    if cancellation_event is not None and cancellation_event.is_set():
        return
    if _query_deadline_expired(query_context):
        result = _request_deadline_result(mode, document_results)
        yield _progress_event(
            "retrieval_completed",
            {
                "documentCount": len(result["selectedDocuments"]),
                "retrievalStatus": "degraded",
                "elapsedMs": int((perf_counter() - started_at) * 1000),
            },
        )
        yield _result_event(result)
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
            "elapsedMs": int((perf_counter() - started_at) * 1000),
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
