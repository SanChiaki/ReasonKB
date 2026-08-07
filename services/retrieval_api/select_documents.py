from __future__ import annotations

from ast import literal_eval
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import json
import logging
import re
from typing import Any, Literal

from services.common.document_search import rank_documents_by_bm25, structure_search_text


_CJK_SEQUENCE_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+")
_LATIN_RE = re.compile(r"[a-z0-9]+")
_HARD_NUMBER_RE = re.compile(r"(?<![a-z0-9])\d+(?:\.\d+)?(?![a-z0-9])", re.I)
_HARD_ACRONYM_RE = re.compile(r"(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,}(?![A-Za-z0-9])")
_HARD_CODE_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]{1,}(?![A-Za-z0-9])"
)
DEFAULT_PREFILTER_LIMIT = 50
MAX_ADAPTIVE_PREFILTER_BATCHES = 3
ADAPTIVE_BOUNDARY_SCORE_RATIO = 0.85
FALLBACK_PAGE_SEARCH_TEXT_LIMIT = 200000
CANDIDATE_FALLBACK_LIMIT = 3
EVIDENCE_VALIDATION_REASON_KEY = "_reasonkb_evidence_validation_reason"
MIN_FALLBACK_QUERY_TERMS = 2
MIN_FALLBACK_SUMMARY_COVERAGE = 0.5
MIN_FALLBACK_TOTAL_COVERAGE = 0.75
logger = logging.getLogger(__name__)
_CANDIDATE_COMPLETION: ContextVar[Any] = ContextVar(
    "reasonkb_candidate_completion",
    default=None,
)

_LlmSelectionOutcome = Literal[
    "selected",
    "partial",
    "explicit_empty",
    "invalid_ids",
    "malformed",
    "provider_error",
]


@dataclass(frozen=True)
class _LlmSelection:
    documents: tuple[dict, ...]
    outcome: _LlmSelectionOutcome


@dataclass(frozen=True)
class _ParsedSelection:
    identifiers: tuple[str, ...]
    invalid_item_count: int = 0


@dataclass(frozen=True)
class _CandidateDocumentBatch:
    documents: tuple[dict, ...]
    top_score: float
    boundary_score: float
    has_match: bool


class CandidateDocuments(list[dict]):
    """Selected documents plus routing metadata used by the retrieval stage."""

    def __init__(
        self,
        documents: list[dict],
        *,
        model_outcome: str,
        strategy: str,
    ) -> None:
        super().__init__(documents)
        self.model_outcome = model_outcome
        self.strategy = strategy


@contextmanager
def candidate_completion_scope(completion):
    token = _CANDIDATE_COMPLETION.set(completion)
    try:
        yield
    finally:
        _CANDIDATE_COMPLETION.reset(token)

_GENERIC_TOKENS = {
    "生成",
    "报告",
    "文档",
    "项目",
    "资料",
    "内容",
    "report",
    "document",
    "project",
}
_FALLBACK_QUESTION_PHRASES = (
    "有哪些",
    "是什么",
    "是多少",
    "有多少",
    "怎么做",
    "怎么样",
)
_FALLBACK_CJK_STOP_TERMS = {
    "哪些",
    "什么",
    "多少",
    "如何",
    "怎么",
    "是否",
    "相关",
    "内容",
    "数据",
    "信息",
    "查询",
}
def _strong_fallback_select_documents(
    query: str,
    docs: list[dict],
    limit: int,
    *,
    include_page_text: bool = True,
) -> list[dict]:
    if limit <= 0:
        return []
    query_terms = _fallback_query_terms(query)
    if len(query_terms) < MIN_FALLBACK_QUERY_TERMS:
        return []
    hard_term_groups = _hard_fallback_term_groups(query)
    selected: list[dict] = []
    for ranked_document in rank_documents_by_bm25(query, docs):
        doc = ranked_document.document
        if not _passes_hard_fallback_constraints(
            hard_term_groups,
            doc,
            include_page_text=include_page_text,
        ) or not _passes_strong_fallback_coverage(
            query_terms,
            doc,
            include_page_text=include_page_text,
        ):
            continue
        selected.append(doc)
        if len(selected) >= limit:
            break
    return selected


def _fallback_query_terms(query: str) -> set[str]:
    cleaned = query.lower()
    for phrase in _FALLBACK_QUESTION_PHRASES:
        cleaned = cleaned.replace(phrase, " ")

    latin_terms = {
        token
        for token in _LATIN_RE.findall(cleaned)
        if len(token) >= 2 and token not in _GENERIC_TOKENS
    }
    cjk_terms: set[str] = set()
    for sequence in _CJK_SEQUENCE_RE.findall(cleaned):
        segments = re.split(r"[的和与及或]", sequence)
        for segment in segments:
            cjk_terms.update(
                segment[index : index + 2]
                for index in range(len(segment) - 1)
                if segment[index : index + 2] not in _FALLBACK_CJK_STOP_TERMS
            )
    return latin_terms | cjk_terms


def _matched_fallback_terms(terms: set[str], text: str) -> set[str]:
    if not text:
        return set()
    lowered = text.lower()
    latin_terms = set(_LATIN_RE.findall(lowered))
    return {
        term
        for term in terms
        if (
            term in latin_terms
            if _LATIN_RE.fullmatch(term)
            else term in lowered
        )
    }


def _fallback_summary_text(doc: dict) -> str:
    return " ".join(
        str(doc.get(key) or "")
        for key in (
            "project_name",
            "file_name",
            "project_relative_path",
            "source_relative_path",
            "doc_description",
        )
    )


def _iter_hard_search_texts(doc: dict, *, include_page_text: bool):
    yield _fallback_summary_text(doc)
    yield structure_search_text(doc.get("structure", []))
    if not include_page_text:
        return
    pages = doc.get("pages", [])
    if not isinstance(pages, list):
        return
    for page in pages:
        if not isinstance(page, dict):
            continue
        content = page.get("content")
        if isinstance(content, str) and content:
            yield content


def _pages_search_text(
    pages: Any,
    limit: int = FALLBACK_PAGE_SEARCH_TEXT_LIMIT,
) -> str:
    if not isinstance(pages, list) or limit <= 0:
        return ""
    parts: list[str] = []
    remaining = limit
    for page in pages:
        if not isinstance(page, dict):
            continue
        content = page.get("content")
        if not isinstance(content, str) or not content:
            continue
        parts.append(content[:remaining])
        remaining -= min(len(content), remaining)
        if remaining <= 0:
            break
    return " ".join(parts)


def _hard_fallback_term_groups(query: str) -> tuple[frozenset[str], ...]:
    groups: list[frozenset[str]] = [
        frozenset({match.group(0).lower()}) for match in _HARD_NUMBER_RE.finditer(query)
    ]
    groups.extend(
        frozenset({match.group(0).lower()}) for match in _HARD_ACRONYM_RE.finditer(query)
    )
    return tuple(dict.fromkeys(groups))


def _passes_hard_fallback_constraints(
    groups: tuple[frozenset[str], ...],
    doc: dict,
    *,
    include_page_text: bool,
) -> bool:
    if not groups:
        return True
    remaining = set(groups)
    for search_text in _iter_hard_search_texts(
        doc,
        include_page_text=include_page_text,
    ):
        remaining = {
            group
            for group in remaining
            if not any(_hard_term_matches(term, search_text) for term in group)
        }
        if not remaining:
            return True
    return False


def _hard_term_matches(term: str, text: str) -> bool:
    if _HARD_NUMBER_RE.fullmatch(term):
        return any(
            match.group(0).lower() == term for match in _HARD_NUMBER_RE.finditer(text)
        )
    if _HARD_CODE_TOKEN_RE.fullmatch(term):
        return any(
            match.group(0).lower() == term
            for match in _HARD_CODE_TOKEN_RE.finditer(text)
        )
    return term in text.lower()


def _passes_strong_fallback_coverage(
    terms: set[str],
    doc: dict,
    *,
    include_page_text: bool,
) -> bool:
    summary_text = _fallback_summary_text(doc)
    summary_matches = _matched_fallback_terms(terms, summary_text)
    structure_matches = _matched_fallback_terms(
        terms,
        structure_search_text(doc.get("structure", [])),
    )
    total_terms = len(terms)
    if len(summary_matches) / total_terms < MIN_FALLBACK_SUMMARY_COVERAGE:
        return False
    total_matches = summary_matches | structure_matches
    if (
        len(total_matches) >= MIN_FALLBACK_QUERY_TERMS
        and len(total_matches) / total_terms >= MIN_FALLBACK_TOTAL_COVERAGE
    ):
        return True
    if not include_page_text:
        return False
    page_matches = _matched_fallback_terms(
        terms,
        _pages_search_text(doc.get("pages", [])),
    )
    total_matches |= page_matches
    return len(total_matches) >= MIN_FALLBACK_QUERY_TERMS and (
        len(total_matches) / total_terms >= MIN_FALLBACK_TOTAL_COVERAGE
    )


def _ordered_candidate_documents(query: str, docs: list[dict]) -> list[dict]:
    return [item.document for item in rank_documents_by_bm25(query, docs)]


def prefilter_candidate_documents(
    query: str,
    docs: list[dict],
    *,
    limit: int = DEFAULT_PREFILTER_LIMIT,
) -> list[dict]:
    if limit <= 0 or not docs:
        return []
    return _ordered_candidate_documents(query, docs)[:limit]


def _candidate_document_batches(
    query: str,
    docs: list[dict],
) -> list[_CandidateDocumentBatch]:
    ranked = rank_documents_by_bm25(query, docs)
    batches: list[_CandidateDocumentBatch] = []
    for index in range(0, len(ranked), DEFAULT_PREFILTER_LIMIT):
        batch = ranked[index : index + DEFAULT_PREFILTER_LIMIT]
        matched_scores = [item.score for item in batch if item.matched]
        batches.append(
            _CandidateDocumentBatch(
                documents=tuple(item.document for item in batch),
                top_score=matched_scores[0] if matched_scores else 0.0,
                boundary_score=matched_scores[-1] if matched_scores else 0.0,
                has_match=bool(matched_scores),
            )
        )
    return batches


def _candidate_alias(index: int) -> str:
    return f"D{index + 1:03d}"


def _selection_prompt(query: str, docs: list[dict], *, limit: int) -> str:
    candidates = [
        {
            "candidate_id": _candidate_alias(index),
            "project_name": doc.get("project_name", ""),
            "doc_name": doc.get("file_name", ""),
            "project_relative_path": doc.get("project_relative_path", ""),
            "source_relative_path": doc.get("source_relative_path", ""),
            "doc_description": doc.get("doc_description", ""),
        }
        for index, doc in enumerate(docs)
    ]
    return f"""
You are selecting candidate documents before PageIndex tree retrieval.

Choose the candidate IDs that are most likely to contain information needed for the query.
Use the project name, relative paths, file name, and one-sentence document description.
The query and the document descriptions may be written in different languages.
Select at most {limit} candidates. Prefer recall while staying within that limit: include every document that may plausibly
provide direct evidence for a material part, qualifier, comparison, entity, or time period in the
query. The same selected evidence set will be used for raw Evidence results and Answer generation.

Query:
{query}

Candidate Documents:
{json.dumps(candidates, ensure_ascii=False)}

Return valid JSON only:
{{"answer":["D001","D002"]}}
"""


def _strip_code_fence(raw: str) -> str:
    text = raw.strip()
    if text.startswith("```json"):
        text = text[7:]
    elif text.startswith("```"):
        text = text[3:]
    if text.endswith("```"):
        text = text[:-3]
    return text.strip()


def _extract_selected_doc_ids(raw: str) -> _ParsedSelection | None:
    from pageindex.utils import extract_json

    try:
        parsed: Any = extract_json(raw)
    except Exception:
        parsed = None
    if not parsed:
        try:
            parsed = literal_eval(_strip_code_fence(raw))
        except (SyntaxError, ValueError):
            return None

    answer: Any = parsed
    if isinstance(parsed, dict):
        if "answer" in parsed:
            answer = parsed["answer"]
        elif "doc_ids" in parsed:
            answer = parsed["doc_ids"]
        else:
            return None

    if isinstance(answer, str):
        try:
            answer = literal_eval(answer)
        except (SyntaxError, ValueError):
            return None

    if not isinstance(answer, list):
        return None

    selected_doc_ids: list[str] = []
    invalid_item_count = 0
    for item in answer:
        if not isinstance(item, str):
            invalid_item_count += 1
            continue
        doc_id = item.strip()
        if doc_id:
            selected_doc_ids.append(doc_id)
        else:
            invalid_item_count += 1
    return _ParsedSelection(tuple(selected_doc_ids), invalid_item_count)


def _llm_select_documents(
    query: str,
    docs: list[dict],
    *,
    limit: int,
    model: str | None,
) -> _LlmSelection:
    llm_completion = _CANDIDATE_COMPLETION.get()
    if llm_completion is None:
        from pageindex.utils import llm_completion

    prompt = _selection_prompt(query, docs, limit=limit)
    try:
        completion_result = llm_completion(
            model=model,
            prompt=prompt,
            return_finish_reason=True,
        )
    except Exception:
        return _LlmSelection((), "provider_error")

    if isinstance(completion_result, tuple) and len(completion_result) == 2:
        raw, finish_reason = completion_result
    else:
        raw, finish_reason = completion_result, None
    if finish_reason == "error" or not isinstance(raw, str) or not raw.strip():
        return _LlmSelection((), "provider_error")
    output_truncated = finish_reason == "max_output_reached"

    parsed_selection = _extract_selected_doc_ids(raw)
    if parsed_selection is None:
        return _LlmSelection((), "malformed")
    selected_identifiers = parsed_selection.identifiers
    if not selected_identifiers:
        if parsed_selection.invalid_item_count:
            return _LlmSelection((), "malformed")
        if output_truncated:
            return _LlmSelection((), "partial")
        return _LlmSelection((), "explicit_empty")

    docs_by_identifier: dict[str, dict] = {}
    for index, doc in enumerate(docs):
        doc_id = str(doc.get("id") or "").strip()
        if not doc_id:
            continue
        docs_by_identifier[doc_id] = doc
        docs_by_identifier[_candidate_alias(index)] = doc

    selected_docs: list[dict] = []
    seen_doc_ids: set[str] = set()
    invalid_id_count = parsed_selection.invalid_item_count
    for identifier in selected_identifiers:
        document = docs_by_identifier.get(identifier)
        if not document:
            invalid_id_count += 1
            continue
        doc_id = str(document.get("id") or "")
        if doc_id in seen_doc_ids:
            continue
        selected_docs.append(document)
        seen_doc_ids.add(doc_id)
        if len(selected_docs) >= limit:
            break
    if not selected_docs:
        return _LlmSelection((), "invalid_ids")
    outcome: _LlmSelectionOutcome = (
        "partial" if invalid_id_count or output_truncated else "selected"
    )
    return _LlmSelection(tuple(selected_docs), outcome)


_TECHNICAL_SELECTION_OUTCOMES = frozenset(
    {"provider_error", "malformed", "invalid_ids", "partial"}
)


def _empty_batch_outcome(outcomes: list[_LlmSelectionOutcome]) -> _LlmSelectionOutcome:
    for outcome in ("provider_error", "partial", "malformed", "invalid_ids"):
        if outcome in outcomes:
            return outcome
    return "explicit_empty"


def _deduplicate_documents(documents: list[dict]) -> list[dict]:
    deduplicated: list[dict] = []
    seen_doc_ids: set[str] = set()
    for document in documents:
        doc_id = str(document.get("id") or "").strip()
        if not doc_id or doc_id in seen_doc_ids:
            continue
        deduplicated.append(document)
        seen_doc_ids.add(doc_id)
    return deduplicated


def _rerank_batch_selections(
    query: str,
    documents: list[dict],
    *,
    limit: int,
    model: str | None,
    partial: bool,
) -> _LlmSelection:
    current = _deduplicate_documents(documents)
    while len(current) > DEFAULT_PREFILTER_LIMIT:
        reduced: list[dict] = []
        round_partial = partial
        for index in range(0, len(current), DEFAULT_PREFILTER_LIMIT):
            batch = current[index : index + DEFAULT_PREFILTER_LIMIT]
            selection = _llm_select_documents(
                query,
                batch,
                limit=limit,
                model=model,
            )
            if selection.documents:
                reduced.extend(selection.documents)
            elif selection.outcome in _TECHNICAL_SELECTION_OUTCOMES:
                reduced.extend(batch[:limit])
            round_partial = round_partial or (
                selection.outcome in _TECHNICAL_SELECTION_OUTCOMES
            )
        reduced = _deduplicate_documents(reduced)
        if not reduced or len(reduced) >= len(current):
            return _LlmSelection(tuple(current[:limit]), "partial")
        current = reduced
        partial = round_partial

    if len(current) <= limit:
        return _LlmSelection(tuple(current), "partial" if partial else "selected")

    selection = _llm_select_documents(
        query,
        current,
        limit=limit,
        model=model,
    )
    if not selection.documents:
        return _LlmSelection(tuple(current[:limit]), "partial")
    outcome: _LlmSelectionOutcome = (
        "partial"
        if partial or selection.outcome in _TECHNICAL_SELECTION_OUTCOMES
        else "selected"
    )
    return _LlmSelection(selection.documents, outcome)


def _llm_select_document_batches(
    query: str,
    batches: list[_CandidateDocumentBatch],
    *,
    limit: int,
    model: str | None,
) -> tuple[_LlmSelection, int]:
    outcomes: list[_LlmSelectionOutcome] = []
    selected_documents: list[dict] = []
    attempted_batches = 0
    previous_batch: _CandidateDocumentBatch | None = None
    for batch_index, batch in enumerate(batches[:MAX_ADAPTIVE_PREFILTER_BATCHES]):
        if batch_index > 0 and not _should_expand_candidate_search(
            previous_batch,
            batch,
            selected_count=len(_deduplicate_documents(selected_documents)),
            limit=limit,
        ):
            break
        selection = _llm_select_documents(
            query,
            list(batch.documents),
            limit=limit,
            model=model,
        )
        attempted_batches += 1
        outcomes.append(selection.outcome)
        selected_documents.extend(selection.documents)
        previous_batch = batch
        if selection.outcome in _TECHNICAL_SELECTION_OUTCOMES:
            break

    if not selected_documents:
        return _LlmSelection((), _empty_batch_outcome(outcomes)), attempted_batches

    partial = any(
        outcome in _TECHNICAL_SELECTION_OUTCOMES for outcome in outcomes
    )
    return (
        _rerank_batch_selections(
            query,
            selected_documents,
            limit=limit,
            model=model,
            partial=partial,
        ),
        attempted_batches,
    )


def _should_expand_candidate_search(
    previous_batch: _CandidateDocumentBatch | None,
    next_batch: _CandidateDocumentBatch,
    *,
    selected_count: int,
    limit: int,
) -> bool:
    if previous_batch is None or not next_batch.has_match:
        return False
    if selected_count < limit:
        return True
    if previous_batch.boundary_score <= 0:
        return False
    return (
        next_batch.top_score
        >= previous_batch.boundary_score * ADAPTIVE_BOUNDARY_SCORE_RATIO
    )


def _merge_documents(*groups: list[dict], limit: int) -> list[dict]:
    selected: list[dict] = []
    seen_doc_ids: set[str] = set()
    for group in groups:
        for document in group:
            doc_id = str(document.get("id") or "").strip()
            if not doc_id or doc_id in seen_doc_ids:
                continue
            selected.append(dict(document))
            seen_doc_ids.add(doc_id)
            if len(selected) >= limit:
                return selected
    return selected


def select_candidate_documents(
    query: str,
    docs: list[dict],
    limit: int = 8,
    model: str | None = None,
    mode: str | None = None,
) -> CandidateDocuments:
    # Kept temporarily for direct callers that still pass the former output mode.
    # Retrieval semantics are intentionally mode-independent.
    del mode
    if limit <= 0 or not docs:
        return CandidateDocuments(
            [],
            model_outcome="not_run",
            strategy="empty_scope",
        )
    candidate_batches = _candidate_document_batches(query, docs)
    llm_selection, attempted_batches = _llm_select_document_batches(
        query,
        candidate_batches,
        limit=limit,
        model=model,
    )
    attempted_candidates = [
        document
        for batch in candidate_batches[:attempted_batches]
        for document in batch.documents
    ]
    is_batched = attempted_batches > 1
    strong_deterministic: list[dict] = []

    if llm_selection.documents:
        model_documents = list(llm_selection.documents)
        if limit == 1 or len(model_documents) >= limit:
            selected = _merge_documents(model_documents, limit=limit)
            strategy = (
                "batched_model_selection"
                if is_batched
                else "model_only_single_slot"
                if limit == 1
                else "model_only_full_budget"
            )
        elif is_batched:
            selected = _merge_documents(model_documents, limit=limit)
            strategy = "batched_model_selection"
        else:
            strong_deterministic = _strong_fallback_select_documents(
                query,
                attempted_candidates,
                1,
                include_page_text=False,
            )
            selected = _merge_documents(
                strong_deterministic[:1],
                model_documents,
                limit=limit,
            )
            strategy = "protected_strong_anchor_and_model"
        model_document_ids = {
            str(document.get("id") or "") for document in model_documents
        }
        for document in selected:
            if str(document.get("id") or "") not in model_document_ids:
                document[EVIDENCE_VALIDATION_REASON_KEY] = "deterministic_anchor"
            else:
                document[EVIDENCE_VALIDATION_REASON_KEY] = "model_selection"
    elif llm_selection.outcome == "explicit_empty":
        strong_deterministic = _strong_fallback_select_documents(
            query,
            attempted_candidates,
            1,
            include_page_text=True,
        )
        selected = [
            {
                **document,
                EVIDENCE_VALIDATION_REASON_KEY: "explicit_empty_probe",
            }
            for document in strong_deterministic[:1]
        ]
        strategy = (
            "explicit_empty_strong_probe"
            if selected
            else "explicit_empty_no_strong_match"
        )
    else:
        fallback_limit = min(limit, CANDIDATE_FALLBACK_LIMIT)
        strong_deterministic = _strong_fallback_select_documents(
            query,
            attempted_candidates,
            fallback_limit,
            include_page_text=True,
        )
        selected = [
            {
                **document,
                EVIDENCE_VALIDATION_REASON_KEY: "technical_fallback",
            }
            for document in strong_deterministic[:fallback_limit]
        ]
        strategy = (
            "technical_failure_strong_fallback"
            if selected
            else "technical_failure_no_strong_match"
        )

    log_selection = (
        logger.info if llm_selection.outcome == "selected" else logger.warning
    )
    log_selection(
        "Candidate document selection strategy=%s model_outcome=%s "
        "prefiltered=%d batches=%d deterministic=%d selected=%d",
        strategy,
        llm_selection.outcome,
        len(attempted_candidates),
        attempted_batches,
        len(strong_deterministic),
        len(selected),
    )

    return CandidateDocuments(
        selected,
        model_outcome=llm_selection.outcome,
        strategy=strategy,
    )
