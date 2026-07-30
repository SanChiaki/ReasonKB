from __future__ import annotations

from ast import literal_eval
from collections import Counter
from dataclasses import dataclass
import json
import logging
import re
from typing import Any, Literal


_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_CJK_SEQUENCE_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+")
_LATIN_RE = re.compile(r"[a-z0-9]+")
DEFAULT_PREFILTER_LIMIT = 50
STRUCTURE_SEARCH_TEXT_LIMIT = 30000
MIN_STRONG_PREFILTER_SCORE = 3
ANSWER_FALLBACK_LIMIT = 2
EVIDENCE_FALLBACK_LIMIT = 3
SELECTION_MODES = frozenset({"answer", "evidence"})
EVIDENCE_VALIDATION_REASON_KEY = "_reasonkb_evidence_validation_reason"
MIN_FALLBACK_QUERY_TERMS = 2
MIN_FALLBACK_SUMMARY_COVERAGE = 0.5
MIN_FALLBACK_TOTAL_COVERAGE = 0.75
logger = logging.getLogger(__name__)

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

_QUERY_EXPANSIONS = {
    "终验": ["final", "acceptance", "handover", "sign", "off"],
    "验收": ["acceptance", "sign", "off"],
    "交付": ["delivery", "handover", "deliverable"],
    "报告": ["report"],
    "质检": ["quality", "inspection"],
    "检查": ["check", "inspection"],
    "进展": ["progress", "status"],
    "覆盖": ["coverage"],
}
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


def _expanded_query_tokens(text: str) -> list[str]:
    tokens = _tokenize_query(text)
    lowered = text.lower()
    for trigger, expansions in _QUERY_EXPANSIONS.items():
        if trigger in text or trigger in lowered:
            tokens.extend(expansions)
    return tokens


def _structure_search_text(structure: Any, limit: int = STRUCTURE_SEARCH_TEXT_LIMIT) -> str:
    parts: list[str] = []
    total = 0
    stack = [structure]
    while stack and total < limit:
        item = stack.pop()
        if isinstance(item, list):
            stack.extend(reversed(item))
            continue
        if not isinstance(item, dict):
            continue
        for key in ("title", "summary", "prefix_summary"):
            value = item.get(key)
            if not isinstance(value, str) or not value:
                continue
            remaining = limit - total
            if remaining <= 0:
                break
            parts.append(value[:remaining])
            total += min(len(value), remaining)
        children = item.get("nodes")
        if children:
            stack.append(children)
    return " ".join(parts)


def _weighted_token_score(tokens: Counter[str], text: str, weight: int) -> int:
    if not text:
        return 0
    haystack = text.lower()
    latin_terms: set[str] | None = None
    score = 0
    for token, count in tokens.items():
        if _LATIN_RE.fullmatch(token):
            if latin_terms is None:
                latin_terms = set(_LATIN_RE.findall(haystack))
            matched = token in latin_terms
        else:
            matched = token in haystack
        if matched:
            score += count * weight
    return score


def _is_strong_token(token: str) -> bool:
    if token in _GENERIC_TOKENS:
        return False
    if _LATIN_RE.fullmatch(token):
        return len(token) >= 2
    return len(token) >= 2


def _keyword_score_parts(query: str, doc: dict) -> tuple[int, int]:
    tokens = Counter(_expanded_query_tokens(query))
    strong_tokens = Counter(
        token for token in tokens.elements() if _is_strong_token(token)
    )
    metadata = " ".join(
        str(doc.get(key) or "")
        for key in (
            "project_name",
            "file_name",
            "project_relative_path",
            "source_relative_path",
        )
    )
    description = str(doc.get("doc_description") or "")
    structure_text = _structure_search_text(doc.get("structure", []))
    weighted_fields = [
        (metadata, 6),
        (description, 3),
        (structure_text, 2),
    ]
    score = sum(
        _weighted_token_score(tokens, text, weight=weight)
        for text, weight in weighted_fields
    )
    strong_score = sum(
        _weighted_token_score(strong_tokens, text, weight=weight)
        for text, weight in weighted_fields
    )
    return score, strong_score


def keyword_score(query: str, doc: dict) -> int:
    score, _strong_score = _keyword_score_parts(query, doc)
    return score


def _has_strong_query_signal(query: str) -> bool:
    return any(_is_strong_token(token) for token in _expanded_query_tokens(query))


def _passes_prefilter(query: str, score: int, strong_score: int) -> bool:
    if score <= 0:
        return False
    if not _has_strong_query_signal(query):
        return True
    return strong_score >= MIN_STRONG_PREFILTER_SCORE


def _rank_documents_by_keyword(
    query: str,
    docs: list[dict],
) -> list[tuple[int, int, str, dict]]:
    ranked = [
        (
            score,
            strong_score,
            str(doc.get("file_name") or ""),
            doc,
        )
        for doc in docs
        for score, strong_score in [_keyword_score_parts(query, doc)]
    ]
    return sorted(ranked, key=lambda item: (item[0], item[1], item[2]), reverse=True)


def _keyword_select_documents(query: str, docs: list[dict], limit: int) -> list[dict]:
    ranked = _rank_documents_by_keyword(query, docs)
    positives = [
        doc
        for score, strong_score, _file_name, doc in ranked
        if _passes_prefilter(query, score, strong_score)
    ]
    if positives:
        return positives[:limit]

    return [
        doc
        for score, _strong_score, _file_name, doc in ranked
        if score > 0
    ][:limit]


def _strong_keyword_select_documents(
    query: str,
    docs: list[dict],
    limit: int,
) -> list[dict]:
    if limit <= 0:
        return []

    query_terms = _fallback_query_terms(query)
    if len(query_terms) < MIN_FALLBACK_QUERY_TERMS:
        return []
    return [
        doc
        for _score, _strong_score, _file_name, doc in _rank_documents_by_keyword(query, docs)
        if _passes_strong_fallback_coverage(query_terms, doc)
    ][:limit]


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


def _passes_strong_fallback_coverage(terms: set[str], doc: dict) -> bool:
    summary_text = " ".join(
        str(doc.get(key) or "")
        for key in (
            "project_name",
            "file_name",
            "project_relative_path",
            "source_relative_path",
            "doc_description",
        )
    )
    summary_matches = _matched_fallback_terms(terms, summary_text)
    structure_matches = _matched_fallback_terms(
        terms,
        _structure_search_text(doc.get("structure", [])),
    )
    total_terms = len(terms)
    total_matches = summary_matches | structure_matches
    return (
        len(total_matches) >= MIN_FALLBACK_QUERY_TERMS
        and len(summary_matches) / total_terms >= MIN_FALLBACK_SUMMARY_COVERAGE
        and len(total_matches) / total_terms >= MIN_FALLBACK_TOTAL_COVERAGE
    )


def prefilter_candidate_documents(
    query: str,
    docs: list[dict],
    *,
    limit: int = DEFAULT_PREFILTER_LIMIT,
) -> list[dict]:
    if limit <= 0 or not docs:
        return []
    ranked = _rank_documents_by_keyword(query, docs)
    positives = [
        doc
        for score, strong_score, _file_name, doc in ranked
        if _passes_prefilter(query, score, strong_score)
    ]
    if positives:
        return positives[:limit]

    weak_matches = [
        doc
        for score, _strong_score, _file_name, doc in ranked
        if score > 0
    ]
    if weak_matches:
        return weak_matches[:limit]

    return [doc for _score, _strong_score, _file_name, doc in ranked[:limit]]


def _candidate_alias(index: int) -> str:
    return f"D{index + 1:03d}"


def _selection_prompt(query: str, docs: list[dict], mode: str) -> str:
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
    selection_goal = (
        "Prefer recall: include every document that may plausibly provide relevant evidence."
        if mode == "evidence"
        else (
            "Prefer precision: choose the smallest document set likely to contain enough "
            "information for an accurate answer."
        )
    )
    return f"""
You are selecting candidate documents before PageIndex tree retrieval.

Choose the candidate IDs that are most likely to contain information needed for the query.
Use the project name, relative paths, file name, and one-sentence document description.
The query and the document descriptions may be written in different languages.
{selection_goal}

Query:
{query}

Candidate Documents:
{json.dumps(candidates, ensure_ascii=False)}

Return valid JSON only:
{{"thinking":"brief reason","answer":["D001","D002"]}}
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
    mode: str,
) -> _LlmSelection:
    from pageindex.utils import llm_completion

    prompt = _selection_prompt(query, docs, mode)
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

    parsed_selection = _extract_selected_doc_ids(raw)
    if parsed_selection is None:
        return _LlmSelection((), "malformed")
    selected_identifiers = parsed_selection.identifiers
    if not selected_identifiers:
        if parsed_selection.invalid_item_count:
            return _LlmSelection((), "malformed")
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
    outcome: _LlmSelectionOutcome = "partial" if invalid_id_count else "selected"
    return _LlmSelection(tuple(selected_docs), outcome)


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
    mode: str = "answer",
) -> CandidateDocuments:
    if limit <= 0 or not docs:
        return CandidateDocuments(
            [],
            model_outcome="not_run",
            strategy="empty_scope",
        )
    if mode not in SELECTION_MODES:
        raise ValueError(f"unsupported document selection mode: {mode}")

    llm_candidates = prefilter_candidate_documents(
        query,
        docs,
        limit=DEFAULT_PREFILTER_LIMIT,
    )

    strong_deterministic = _strong_keyword_select_documents(
        query,
        llm_candidates,
        limit,
    )
    llm_selection = _llm_select_documents(
        query,
        llm_candidates,
        limit=limit,
        model=model,
        mode=mode,
    )

    if llm_selection.documents:
        model_documents = list(llm_selection.documents)
        if limit == 1:
            selected = _merge_documents(model_documents, limit=limit)
            strategy = "model_only_single_slot"
        else:
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
        fallback_limit = min(
            limit,
            EVIDENCE_FALLBACK_LIMIT if mode == "evidence" else ANSWER_FALLBACK_LIMIT,
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
        "Candidate document selection strategy=%s mode=%s model_outcome=%s "
        "prefiltered=%d deterministic=%d selected=%d",
        strategy,
        mode,
        llm_selection.outcome,
        len(llm_candidates),
        len(strong_deterministic),
        len(selected),
    )

    return CandidateDocuments(
        selected,
        model_outcome=llm_selection.outcome,
        strategy=strategy,
    )
