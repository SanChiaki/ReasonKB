from __future__ import annotations

from ast import literal_eval
from collections import Counter
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import json
import logging
import re
from typing import Any, Iterable, Literal


_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_CJK_SEQUENCE_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+")
_LATIN_RE = re.compile(r"[a-z0-9]+")
_HARD_NUMBER_RE = re.compile(r"(?<![a-z0-9])\d+(?:\.\d+)?(?![a-z0-9])", re.I)
_HARD_ACRONYM_RE = re.compile(r"(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,}(?![A-Za-z0-9])")
_HARD_CODE_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]{1,}(?![A-Za-z0-9])"
)
_DEALER_TIER_MARKERS = (
    ("钻石", "diamond"),
    ("铂金", "platinum"),
    ("白金", "platinum"),
    ("黄金", "gold"),
    ("金牌", "gold"),
    ("银牌", "silver"),
    ("铜牌", "bronze"),
    ("金", "gold"),
    ("银", "silver"),
    ("铜", "bronze"),
)
_DEALER_TIER_TERM_PATTERN = "(?:" + "|".join(
    re.escape(marker) for marker, _canonical in _DEALER_TIER_MARKERS
) + ")"
_DEALER_TIER_RE = re.compile(
    rf"({_DEALER_TIER_TERM_PATTERN}"
    rf"(?:[/、或和与及]{_DEALER_TIER_TERM_PATTERN})*)经销商"
)
_NEGATED_DEALER_TIER_RE = re.compile(
    r"(?:(?:非|不是|并非|除|排除|不含|不包括)[^，。；;！？!?]{0,20}经销商"
    r"|经销商(?:以外|之外|除外))"
)
_RELATIVE_DEALER_TIER_RE = re.compile(
    rf"(?:{_DEALER_TIER_TERM_PATTERN}(?:经销商)?(?:及)?(?:以上|以下)"
    rf"|(?:不低于|不高于|高于|低于|至少|至多){_DEALER_TIER_TERM_PATTERN}(?:经销商)?)"
)
DEFAULT_PREFILTER_LIMIT = 50
STRUCTURE_SEARCH_TEXT_LIMIT = 30000
FALLBACK_PAGE_SEARCH_TEXT_LIMIT = 200000
MIN_STRONG_PREFILTER_SCORE = 3
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
    *,
    include_page_text: bool = True,
) -> list[dict]:
    if limit <= 0:
        return []
    if _query_has_semantic_dealer_tier_constraint(query):
        return []

    query_terms = _fallback_query_terms(query)
    if len(query_terms) < MIN_FALLBACK_QUERY_TERMS:
        return []
    hard_term_groups = _hard_fallback_term_groups(query)
    selected: list[dict] = []
    for _score, _strong_score, _file_name, doc in _rank_documents_by_keyword(query, docs):
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
    yield _structure_search_text(doc.get("structure", []))
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


def _dealer_tier_marker(term: str) -> str | None:
    return next(
        (
            f"tier:{canonical}"
            for marker, canonical in _DEALER_TIER_MARKERS
            if term.endswith(marker)
        ),
        None,
    )


def _iter_dealer_tier_markers(text: str):
    for match in _DEALER_TIER_RE.finditer(text):
        for term in re.split(r"[/、或和与及]", match.group(1)):
            marker = _dealer_tier_marker(term)
            if marker:
                yield marker


def _query_dealer_tier_markers(query: str) -> frozenset[str]:
    if _query_has_semantic_dealer_tier_constraint(query):
        return frozenset()
    return frozenset(_iter_dealer_tier_markers(query))


def _query_has_negated_dealer_tier(query: str) -> bool:
    return bool(_NEGATED_DEALER_TIER_RE.search(query))


def _query_has_semantic_dealer_tier_constraint(query: str) -> bool:
    return _query_has_negated_dealer_tier(query) or bool(
        _RELATIVE_DEALER_TIER_RE.search(query)
    )


def _document_has_dealer_tier(
    document: dict,
    query_tiers: frozenset[str],
    *,
    include_page_text: bool,
) -> bool:
    return any(
        query_tiers.intersection(_iter_dealer_tier_markers(search_text))
        for search_text in _iter_hard_search_texts(
            document,
            include_page_text=include_page_text,
        )
    )


def _document_dealer_tiers(
    document: dict,
    *,
    include_page_text: bool,
) -> frozenset[str]:
    return frozenset(
        marker
        for search_text in _iter_hard_search_texts(
            document,
            include_page_text=include_page_text,
        )
        for marker in _iter_dealer_tier_markers(search_text)
    )


def document_supports_query_dealer_tier(
    query: str,
    document: dict,
    page_texts: Iterable[str] = (),
) -> bool:
    query_tiers = _query_dealer_tier_markers(query)
    if not query_tiers:
        return True

    metadata_tiers = _document_dealer_tiers(
        document,
        include_page_text=False,
    )
    page_tiers = {
        marker
        for text in page_texts
        if isinstance(text, str)
        for marker in _iter_dealer_tier_markers(text)
    }
    if query_tiers.intersection(page_tiers):
        return True
    if page_tiers:
        return False
    if query_tiers.intersection(metadata_tiers):
        return True
    return not metadata_tiers


def _documents_matching_dealer_tier(query: str, documents: list[dict]) -> list[dict]:
    query_tiers = _query_dealer_tier_markers(query)
    if not query_tiers:
        return documents

    metadata_matches = [
        document
        for document in documents
        if _document_has_dealer_tier(
            document,
            query_tiers,
            include_page_text=False,
        )
    ]
    metadata_match_ids = {id(document) for document in metadata_matches}
    return [
        document
        for document in documents
        if id(document) in metadata_match_ids
        or _document_has_dealer_tier(
            document,
            query_tiers,
            include_page_text=True,
        )
    ]


def _hard_fallback_term_groups(query: str) -> tuple[frozenset[str], ...]:
    groups: list[frozenset[str]] = [
        frozenset({match.group(0).lower()}) for match in _HARD_NUMBER_RE.finditer(query)
    ]
    groups.extend(
        frozenset({match.group(0).lower()}) for match in _HARD_ACRONYM_RE.finditer(query)
    )
    for match in _DEALER_TIER_RE.finditer(query):
        alternatives = {
            marker
            for term in re.split(r"[/、或和与及]", match.group(1))
            if term
            for marker in [_dealer_tier_marker(term)]
            if marker
        }
        if alternatives:
            groups.append(frozenset(alternatives))
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
    if term.startswith("tier:"):
        return any(marker == term for marker in _iter_dealer_tier_markers(text))
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
        _structure_search_text(doc.get("structure", [])),
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
    ranked = _rank_documents_by_keyword(query, docs)
    positives = [
        doc
        for score, strong_score, _file_name, doc in ranked
        if _passes_prefilter(query, score, strong_score)
    ]
    positive_object_ids = {id(doc) for doc in positives}
    weak_matches = [
        doc
        for score, _strong_score, _file_name, doc in ranked
        if score > 0 and id(doc) not in positive_object_ids
    ]
    unmatched = [
        doc
        for score, _strong_score, _file_name, doc in ranked
        if score <= 0
    ]
    return [*positives, *weak_matches, *unmatched]


def prefilter_candidate_documents(
    query: str,
    docs: list[dict],
    *,
    limit: int = DEFAULT_PREFILTER_LIMIT,
) -> list[dict]:
    if limit <= 0 or not docs:
        return []
    return _ordered_candidate_documents(query, docs)[:limit]


def _candidate_document_batches(query: str, docs: list[dict]) -> list[list[dict]]:
    ordered = _ordered_candidate_documents(query, docs)
    return [
        ordered[index : index + DEFAULT_PREFILTER_LIMIT]
        for index in range(0, len(ordered), DEFAULT_PREFILTER_LIMIT)
    ]


def _candidate_alias(index: int) -> str:
    return f"D{index + 1:03d}"


def _selection_prompt(query: str, docs: list[dict]) -> str:
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
Prefer recall while staying within the candidate limit: include every document that may plausibly
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

    prompt = _selection_prompt(query, docs)
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
    batches: list[list[dict]],
    *,
    limit: int,
    model: str | None,
) -> tuple[_LlmSelection, int]:
    outcomes: list[_LlmSelectionOutcome] = []
    selected_documents: list[dict] = []
    attempted_batches = 0
    for batch in batches:
        selection = _llm_select_documents(
            query,
            batch,
            limit=limit,
            model=model,
        )
        attempted_batches += 1
        outcomes.append(selection.outcome)
        selected_documents.extend(selection.documents)
        if selection.outcome == "provider_error":
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
    tier_constrained_docs = _documents_matching_dealer_tier(query, docs)
    if not tier_constrained_docs:
        logger.info(
            "Candidate document selection strategy=hard_constraint_no_match "
            "model_outcome=not_run documents=%d",
            len(docs),
        )
        return CandidateDocuments(
            [],
            model_outcome="not_run",
            strategy="hard_constraint_no_match",
        )
    docs = tier_constrained_docs

    candidate_batches = _candidate_document_batches(query, docs)
    llm_candidates = candidate_batches[0]
    is_batched = len(candidate_batches) > 1
    llm_selection, attempted_batches = _llm_select_document_batches(
        query,
        candidate_batches,
        limit=limit,
        model=model,
    )
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
            strong_deterministic = _strong_keyword_select_documents(
                query,
                llm_candidates,
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
        strong_deterministic = _strong_keyword_select_documents(
            query,
            llm_candidates,
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
        strong_deterministic = _strong_keyword_select_documents(
            query,
            llm_candidates,
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
        len(llm_candidates),
        attempted_batches,
        len(strong_deterministic),
        len(selected),
    )

    return CandidateDocuments(
        selected,
        model_outcome=llm_selection.outcome,
        strategy=strategy,
    )
