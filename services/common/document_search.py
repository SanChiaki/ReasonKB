from __future__ import annotations

from dataclasses import dataclass
import logging
import re
import sqlite3
from typing import Any

_CJK_SEQUENCE_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+")
_LATIN_RE = re.compile(r"[a-z0-9]+")
STRUCTURE_SEARCH_TEXT_LIMIT = 30000
MAX_QUERY_TOKENS = 128
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RankedSearchDocument:
    document: dict[str, Any]
    score: float
    matched: bool


def analysis_tokens(text: str) -> list[str]:
    tokens = _LATIN_RE.findall(text.lower())
    for sequence in _CJK_SEQUENCE_RE.findall(text):
        if len(sequence) == 1:
            tokens.append(sequence)
            continue
        tokens.extend(sequence)
        tokens.extend(
            sequence[index : index + 2] for index in range(len(sequence) - 1)
        )
    return tokens


def structure_search_text(
    structure: Any,
    limit: int = STRUCTURE_SEARCH_TEXT_LIMIT,
) -> str:
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


def replace_document_search_index(
    conn: sqlite3.Connection,
    *,
    document_id: str,
    file_name: str,
    project_name: str,
    project_relative_path: str | None,
    source_relative_path: str | None,
    description: str,
    structure: Any,
) -> None:
    metadata = " ".join(
        value
        for value in (
            project_name,
            file_name,
            project_relative_path or "",
            source_relative_path or "",
        )
        if value
    )
    conn.execute("DELETE FROM document_search WHERE document_id = ?", (document_id,))
    conn.execute(
        """
        INSERT INTO document_search(
            document_id,
            file_name,
            metadata_text,
            description,
            structure_search_text
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            document_id,
            file_name,
            " ".join(analysis_tokens(metadata)),
            " ".join(analysis_tokens(description)),
            " ".join(analysis_tokens(structure_search_text(structure))),
        ),
    )


def rank_documents_by_bm25(
    query: str,
    documents: list[dict[str, Any]],
) -> list[RankedSearchDocument]:
    if not documents:
        return []
    tokens = list(
        dict.fromkeys(token for token in analysis_tokens(query) if token)
    )[:MAX_QUERY_TOKENS]
    if not tokens:
        return [
            RankedSearchDocument(document, 0.0, False)
            for document in _stable_unmatched_documents(documents)
        ]

    db_path = str(documents[0].get("_db_path") or "").strip()
    if db_path:
        try:
            matches = _persistent_matches(db_path, tokens)
        except sqlite3.OperationalError as exc:
            logger.warning(
                "Persistent document search unavailable; using transient FTS5: %s",
                exc,
            )
            matches = _transient_matches(documents, tokens)
    else:
        matches = _transient_matches(documents, tokens)

    documents_by_id = {
        str(document.get("id") or ""): document
        for document in documents
        if document.get("id")
    }
    ranked: list[RankedSearchDocument] = []
    matched_ids: set[str] = set()
    for document_id, score in matches:
        document = documents_by_id.get(document_id)
        if document is None or document_id in matched_ids:
            continue
        ranked.append(RankedSearchDocument(document, score, True))
        matched_ids.add(document_id)

    ranked.extend(
        RankedSearchDocument(document, 0.0, False)
        for document in _stable_unmatched_documents(documents)
        if str(document.get("id") or "") not in matched_ids
    )
    return ranked


def _persistent_matches(
    db_path: str,
    tokens: list[str],
) -> list[tuple[str, float]]:
    connection = sqlite3.connect(db_path, timeout=5.0)
    try:
        connection.execute("PRAGMA busy_timeout = 5000")
        return _query_matches(connection, tokens)
    finally:
        connection.close()


def _transient_matches(
    documents: list[dict[str, Any]],
    tokens: list[str],
) -> list[tuple[str, float]]:
    connection = sqlite3.connect(":memory:")
    try:
        _create_search_table(connection)
        for document in documents:
            document_id = str(document.get("id") or "").strip()
            if not document_id:
                continue
            replace_document_search_index(
                connection,
                document_id=document_id,
                file_name=str(document.get("file_name") or ""),
                project_name=str(document.get("project_name") or ""),
                project_relative_path=document.get("project_relative_path"),
                source_relative_path=document.get("source_relative_path"),
                description=str(document.get("doc_description") or ""),
                structure=document.get("structure", []),
            )
        return _query_matches(connection, tokens)
    finally:
        connection.close()


def _create_search_table(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE VIRTUAL TABLE document_search USING fts5(
            document_id UNINDEXED,
            file_name UNINDEXED,
            metadata_text,
            description,
            structure_search_text,
            tokenize = 'unicode61 remove_diacritics 2'
        )
        """
    )


def _query_matches(
    connection: sqlite3.Connection,
    tokens: list[str],
) -> list[tuple[str, float]]:
    expression = " OR ".join(
        f'"{token.replace(chr(34), chr(34) * 2)}"' for token in tokens
    )
    rows = connection.execute(
        """
        SELECT document_id,
               bm25(document_search, 0.0, 0.0, 6.0, 3.0, 2.0) AS fts_rank
          FROM document_search
         WHERE document_search MATCH ?
         ORDER BY fts_rank ASC, file_name DESC
        """,
        (expression,),
    ).fetchall()
    return [(str(row[0]), -float(row[1])) for row in rows]


def _stable_unmatched_documents(
    documents: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    return sorted(
        documents,
        key=lambda document: (
            str(document.get("file_name") or ""),
            str(document.get("id") or ""),
        ),
        reverse=True,
    )
