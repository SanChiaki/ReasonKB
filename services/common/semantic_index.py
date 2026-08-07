from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import struct
from time import perf_counter
from typing import Callable, Iterable
import uuid

from services.common.embedding_runtime import (
    EmbeddingProviderError,
    OpenAIEmbeddingAdapter,
)
from services.common.llm_observability import record_llm_event
from services.common.sqlite_store import open_db
from services.common.system_settings import get_embedding_runtime_settings


SEMANTIC_PROFILE_VERSION = "document-node-v1"
NODE_PROFILE_CHAR_LIMIT = 6000
SEMANTIC_RETRY_SECONDS = 60
SEMANTIC_SEED_NODE_LIMIT = 3
SEMANTIC_BACKFILL_LEASE_SECONDS = 300
SEMANTIC_NODE_DOCUMENT_LIMIT = 50
SQLITE_ID_BATCH_SIZE = 500


@dataclass(frozen=True)
class SemanticProfile:
    kind: str
    profile_id: str
    text: str
    node_id: str | None = None
    start_page: int | None = None
    end_page: int | None = None


@dataclass(frozen=True)
class SemanticIndexStatus:
    status: str
    model: str
    indexed_documents: int
    total_documents: int
    active_model: str | None = None
    error: str | None = None

    @property
    def coverage(self) -> float:
        if self.total_documents <= 0:
            return 1.0 if self.status == "ready" else 0.0
        return self.indexed_documents / self.total_documents


@dataclass(frozen=True)
class SemanticSearchResult:
    status: str
    document_scores: tuple[tuple[str, float], ...]
    seed_node_ids: dict[str, tuple[str, ...]]
    elapsed_ms: int
    generation_id: str | None = None
    model: str | None = None
    error: str | None = None


EmbeddingAdapterFactory = Callable[..., OpenAIEmbeddingAdapter]


def document_semantic_profiles(document: dict) -> list[SemanticProfile]:
    profile = "\n".join(
        [
            f"Project: {document.get('project_name', '')}",
            f"Document: {document.get('file_name', '')}",
            "Path: "
            + str(
                document.get("project_relative_path")
                or document.get("source_relative_path")
                or document.get("file_name")
                or ""
            ),
            f"Summary: {document.get('doc_description', '')}",
        ]
    ).strip()
    profiles = [SemanticProfile("document", "document", profile)]
    counter = 0

    def walk(items, ancestors: tuple[str, ...] = ()) -> None:
        nonlocal counter
        if isinstance(items, dict):
            items = [items]
        if not isinstance(items, list):
            return
        for item in items:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "").strip()
            path = (*ancestors, title) if title else ancestors
            summary = str(
                item.get("summary") or item.get("prefix_summary") or ""
            ).strip()
            node_id = str(item.get("node_id") or "").strip() or None
            start_page = _positive_int(item.get("start_index"))
            end_page = _positive_int(item.get("end_index")) or start_page
            if title or summary:
                counter += 1
                node_profile = "\n".join(
                    [
                        f"Document: {document.get('file_name', '')}",
                        f"Section: {' > '.join(part for part in path if part)}",
                        f"Summary: {summary}",
                    ]
                )[:NODE_PROFILE_CHAR_LIMIT]
                profiles.append(
                    SemanticProfile(
                        "node",
                        f"node:{node_id or counter}",
                        node_profile,
                        node_id=node_id,
                        start_page=start_page,
                        end_page=end_page,
                    )
                )
            walk(item.get("nodes"), path)

    walk(document.get("structure", []))
    return profiles


def advance_semantic_backfill(
    db_path: str,
    *,
    adapter_factory: EmbeddingAdapterFactory = OpenAIEmbeddingAdapter,
) -> SemanticIndexStatus:
    settings = get_embedding_runtime_settings(db_path)
    if not settings.configured:
        return semantic_index_status(db_path)

    generation = _get_or_create_desired_generation(
        db_path,
        model=settings.model,
        base_url=settings.base_url,
    )
    if generation["status"] == "degraded" and not _retry_is_due(
        generation["next_retry_at"]
    ):
        return semantic_index_status(db_path)
    if (
        generation["status"] == "ready"
        and generation["is_active"]
        and not _generation_has_missing_document(db_path, generation["id"])
    ):
        return semantic_index_status(db_path)

    lease_owner = str(uuid.uuid4())
    if not _claim_generation_lease(db_path, generation["id"], lease_owner):
        return semantic_index_status(db_path)

    try:
        adapter = adapter_factory(
            api_key=settings.api_key,
            base_url=settings.base_url,
            model=settings.model,
        )
        if generation["dimension"] is None:
            validation = adapter.embed(["ReasonKB semantic index connection test"])
            with open_db(db_path) as connection:
                connection.execute(
                    """
                    UPDATE semantic_index_generations
                       SET dimension = ?, status = 'backfilling', error_summary = NULL,
                           next_retry_at = NULL, updated_at = ?
                     WHERE id = ?
                    """,
                    (validation.dimension, _now(), generation["id"]),
                )
            generation = _generation_by_id(db_path, generation["id"])

        document = _next_missing_document(db_path, generation["id"])
        if document is None:
            current_settings = get_embedding_runtime_settings(db_path)
            if (
                current_settings.model == generation["model"]
                and current_settings.base_url.rstrip("/")
                == generation["base_url"].rstrip("/")
            ):
                _activate_generation(db_path, generation["id"])
            return semantic_index_status(db_path)

        profiles = document_semantic_profiles(document)
        batch = adapter.embed([profile.text for profile in profiles])
        if batch.dimension != generation["dimension"]:
            raise EmbeddingProviderError(
                "Embedding dimension changed while building a semantic generation"
            )
        _persist_document_profiles(
            db_path,
            generation_id=generation["id"],
            document=document,
            profiles=profiles,
            vectors=batch.vectors,
        )
        _refresh_generation_counts(db_path, generation["id"])
    except Exception as exc:
        _mark_generation_degraded(db_path, generation["id"], exc)
    finally:
        try:
            if "adapter" in locals() and callable(getattr(adapter, "close", None)):
                adapter.close()
        finally:
            _release_generation_lease(db_path, generation["id"], lease_owner)

    return semantic_index_status(db_path)


def semantic_index_status(db_path: str) -> SemanticIndexStatus:
    settings = get_embedding_runtime_settings(db_path)
    total_documents = _ready_document_count(db_path)
    if not settings.configured:
        return SemanticIndexStatus(
            status="unconfigured",
            model=settings.model,
            indexed_documents=0,
            total_documents=total_documents,
        )
    try:
        with open_db(db_path) as connection:
            desired = connection.execute(
                """
                SELECT * FROM semantic_index_generations
                 WHERE model = ? AND base_url = ? AND profile_version = ?
                   AND status != 'retired'
                 ORDER BY created_at DESC LIMIT 1
                """,
                (
                    settings.model,
                    settings.base_url.rstrip("/"),
                    SEMANTIC_PROFILE_VERSION,
                ),
            ).fetchone()
            active = connection.execute(
                """
                SELECT model FROM semantic_index_generations
                 WHERE is_active = 1 ORDER BY activated_at DESC LIMIT 1
                """
            ).fetchone()
    except sqlite3.OperationalError:
        desired = active = None

    if desired is None:
        return SemanticIndexStatus(
            status="validating",
            model=settings.model,
            indexed_documents=0,
            total_documents=total_documents,
            active_model=active["model"] if active else None,
        )
    return SemanticIndexStatus(
        status=desired["status"],
        model=settings.model,
        indexed_documents=int(desired["indexed_document_count"] or 0),
        total_documents=total_documents,
        active_model=active["model"] if active else None,
        error=desired["error_summary"],
    )


def semantic_search_documents(
    db_path: str,
    query: str,
    allowed_document_ids: Iterable[str],
    *,
    adapter_factory: EmbeddingAdapterFactory = OpenAIEmbeddingAdapter,
) -> SemanticSearchResult:
    started_at = perf_counter()
    allowed = {str(document_id) for document_id in allowed_document_ids if document_id}
    if not query.strip() or not allowed:
        return SemanticSearchResult("empty_scope", (), {}, 0)
    if not Path(db_path).is_file():
        return SemanticSearchResult("unavailable", (), {}, 0)

    settings = get_embedding_runtime_settings(db_path)
    if not settings.configured:
        return SemanticSearchResult("unconfigured", (), {}, 0)
    try:
        with open_db(db_path) as connection:
            generation = connection.execute(
                """
                SELECT * FROM semantic_index_generations
                 WHERE is_active = 1 ORDER BY activated_at DESC LIMIT 1
                """
            ).fetchone()
    except sqlite3.OperationalError:
        generation = None
    if generation is None:
        return SemanticSearchResult("not_ready", (), {}, 0)
    if generation["base_url"].rstrip("/") != settings.base_url.rstrip("/"):
        return SemanticSearchResult(
            "provider_changed",
            (),
            {},
            0,
            generation_id=generation["id"],
            model=generation["model"],
        )

    try:
        document_rows = _active_embedding_rows(
            db_path,
            generation["id"],
            allowed,
            profile_kind="document",
        )
        covered_document_ids = {row["document_id"] for row in document_rows}
        if covered_document_ids != allowed:
            return SemanticSearchResult(
                "incomplete",
                (),
                {},
                int((perf_counter() - started_at) * 1000),
                generation_id=generation["id"],
                model=generation["model"],
                error=f"Semantic coverage {len(covered_document_ids)}/{len(allowed)}",
            )
        adapter = adapter_factory(
            api_key=settings.api_key,
            base_url=generation["base_url"],
            model=generation["model"],
        )
        query_batch = adapter.embed([query])
        if query_batch.dimension != generation["dimension"]:
            raise EmbeddingProviderError("Query embedding dimension does not match the index")
        query_vector = query_batch.vectors[0]
        document_scores: list[tuple[str, float]] = []
        for row in document_rows:
            vector = unpack_vector(row["vector"], int(generation["dimension"]))
            score = cosine_similarity(query_vector, vector)
            document_scores.append((row["document_id"], score))
        document_scores.sort(key=lambda item: (-item[1], item[0]))

        seed_document_ids = {
            document_id
            for document_id, _score in document_scores[:SEMANTIC_NODE_DOCUMENT_LIMIT]
        }
        node_scores: dict[str, list[tuple[float, str]]] = {}
        for row in _active_embedding_rows(
            db_path,
            generation["id"],
            seed_document_ids,
            profile_kind="node",
        ):
            if row["node_id"]:
                vector = unpack_vector(row["vector"], int(generation["dimension"]))
                score = cosine_similarity(query_vector, vector)
                node_scores.setdefault(row["document_id"], []).append(
                    (score, row["node_id"])
                )
        seeds = {
            document_id: tuple(
                node_id
                for _, node_id in sorted(scores, key=lambda item: (-item[0], item[1]))[
                    :SEMANTIC_SEED_NODE_LIMIT
                ]
            )
            for document_id, scores in node_scores.items()
        }
        elapsed_ms = int((perf_counter() - started_at) * 1000)
        record_llm_event(
            db_path,
            operation="retrieval",
            stage="semantic_query",
            model=generation["model"],
            base_url=generation["base_url"],
            request_id=None,
            outcome="success",
            elapsed_ms=elapsed_ms,
            prompt_tokens=query_batch.prompt_tokens,
        )
        result = SemanticSearchResult(
            "ready",
            tuple(document_scores),
            seeds,
            elapsed_ms,
            generation_id=generation["id"],
            model=generation["model"],
        )
        if callable(getattr(adapter, "close", None)):
            adapter.close()
        return result
    except Exception as exc:
        elapsed_ms = int((perf_counter() - started_at) * 1000)
        record_llm_event(
            db_path,
            operation="retrieval",
            stage="semantic_query",
            model=generation["model"],
            base_url=generation["base_url"],
            request_id=None,
            outcome="failure",
            elapsed_ms=elapsed_ms,
            exception=exc,
        )
        if "adapter" in locals() and callable(getattr(adapter, "close", None)):
            adapter.close()
        return SemanticSearchResult(
            "provider_error",
            (),
            {},
            elapsed_ms,
            generation_id=generation["id"],
            model=generation["model"],
            error=f"{type(exc).__name__}: {str(exc)[:500]}",
        )


def pack_vector(vector: Iterable[float]) -> bytes:
    values = tuple(float(value) for value in vector)
    return struct.pack(f"<{len(values)}f", *values)


def unpack_vector(payload: bytes, dimension: int) -> tuple[float, ...]:
    if dimension <= 0 or len(payload) != dimension * 4:
        raise ValueError("Stored embedding has an invalid dimension")
    return struct.unpack(f"<{dimension}f", payload)


def cosine_similarity(left: Iterable[float], right: Iterable[float]) -> float:
    left_values = tuple(left)
    right_values = tuple(right)
    if len(left_values) != len(right_values):
        raise ValueError("Embedding dimensions do not match")
    dot = sum(a * b for a, b in zip(left_values, right_values))
    left_norm = math.sqrt(sum(value * value for value in left_values))
    right_norm = math.sqrt(sum(value * value for value in right_values))
    return dot / (left_norm * right_norm) if left_norm and right_norm else 0.0


def _get_or_create_desired_generation(db_path: str, *, model: str, base_url: str):
    normalized_base_url = base_url.rstrip("/")
    with open_db(db_path) as connection:
        generation = connection.execute(
            """
            SELECT * FROM semantic_index_generations
             WHERE model = ? AND base_url = ? AND profile_version = ?
               AND status != 'retired'
             ORDER BY created_at DESC LIMIT 1
            """,
            (model, normalized_base_url, SEMANTIC_PROFILE_VERSION),
        ).fetchone()
        if generation is not None:
            return generation
        generation_id = f"semgen_{uuid.uuid4()}"
        now = _now()
        connection.execute(
            """
            INSERT OR IGNORE INTO semantic_index_generations(
              id, model, base_url, profile_version, status, is_active,
              indexed_document_count, total_document_count, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'validating', 0, 0, 0, ?, ?)
            """,
            (
                generation_id,
                model,
                normalized_base_url,
                SEMANTIC_PROFILE_VERSION,
                now,
                now,
            ),
        )
        generation = connection.execute(
            """
            SELECT * FROM semantic_index_generations
             WHERE model = ? AND base_url = ? AND profile_version = ?
               AND status != 'retired'
             ORDER BY created_at DESC LIMIT 1
            """,
            (model, normalized_base_url, SEMANTIC_PROFILE_VERSION),
        ).fetchone()
    if generation is None:
        raise RuntimeError("Unable to create semantic index generation")
    return generation


def _generation_by_id(db_path: str, generation_id: str):
    with open_db(db_path) as connection:
        return connection.execute(
            "SELECT * FROM semantic_index_generations WHERE id = ?",
            (generation_id,),
        ).fetchone()


def _next_missing_document(db_path: str, generation_id: str) -> dict | None:
    with open_db(db_path) as connection:
        row = connection.execute(
            """
            SELECT d.id, d.file_name, d.project_relative_path,
                   d.source_relative_path, p.name AS project_name,
                   di.id AS document_index_id, di.doc_description,
                   di.structure_json
              FROM documents d
              JOIN projects p ON p.id = d.project_id
              JOIN document_indexes di
                ON di.document_id = d.id AND di.is_current = 1
             WHERE d.status = 'ready'
               AND d.deleted_at IS NULL
               AND d.lifecycle_state = 'active'
               AND d.retrieval_eligible = 1
               AND p.deleted_at IS NULL
               AND p.lifecycle_state = 'active'
               AND p.retrieval_eligible = 1
               AND NOT EXISTS (
                 SELECT 1 FROM semantic_embeddings se
                  WHERE se.generation_id = ?
                    AND se.document_id = d.id
                    AND se.document_index_id = di.id
                    AND se.profile_kind = 'document'
               )
             ORDER BY d.updated_at ASC, d.id ASC
             LIMIT 1
            """,
            (generation_id,),
        ).fetchone()
    if row is None:
        return None
    try:
        structure = json.loads(row["structure_json"])
    except (TypeError, json.JSONDecodeError):
        structure = []
    return {
        "id": row["id"],
        "file_name": row["file_name"],
        "project_name": row["project_name"],
        "project_relative_path": row["project_relative_path"],
        "source_relative_path": row["source_relative_path"],
        "document_index_id": row["document_index_id"],
        "doc_description": row["doc_description"],
        "structure": structure if isinstance(structure, list) else [],
    }


def _generation_has_missing_document(db_path: str, generation_id: str) -> bool:
    with open_db(db_path) as connection:
        row = connection.execute(
            """
            SELECT 1
              FROM documents d
              JOIN projects p ON p.id = d.project_id
              JOIN document_indexes di
                ON di.document_id = d.id AND di.is_current = 1
             WHERE d.status = 'ready'
               AND d.deleted_at IS NULL
               AND d.lifecycle_state = 'active'
               AND d.retrieval_eligible = 1
               AND p.deleted_at IS NULL
               AND p.lifecycle_state = 'active'
               AND p.retrieval_eligible = 1
               AND NOT EXISTS (
                 SELECT 1 FROM semantic_embeddings se
                  WHERE se.generation_id = ?
                    AND se.document_id = d.id
                    AND se.document_index_id = di.id
                    AND se.profile_kind = 'document'
               )
             LIMIT 1
            """,
            (generation_id,),
        ).fetchone()
    return row is not None


def _claim_generation_lease(
    db_path: str,
    generation_id: str,
    lease_owner: str,
) -> bool:
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=SEMANTIC_BACKFILL_LEASE_SECONDS)
    with open_db(db_path) as connection:
        result = connection.execute(
            """
            UPDATE semantic_index_generations
               SET lease_owner = ?, lease_expires_at = ?
             WHERE id = ?
               AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            """,
            (lease_owner, expires_at.isoformat(), generation_id, now.isoformat()),
        )
    return result.rowcount == 1


def _release_generation_lease(
    db_path: str,
    generation_id: str,
    lease_owner: str,
) -> None:
    with open_db(db_path) as connection:
        connection.execute(
            """
            UPDATE semantic_index_generations
               SET lease_owner = NULL, lease_expires_at = NULL
             WHERE id = ? AND lease_owner = ?
            """,
            (generation_id, lease_owner),
        )


def _persist_document_profiles(
    db_path: str,
    *,
    generation_id: str,
    document: dict,
    profiles: list[SemanticProfile],
    vectors: tuple[tuple[float, ...], ...],
) -> None:
    now = _now()
    with open_db(db_path) as connection:
        current = connection.execute(
            """
            SELECT 1 FROM document_indexes
             WHERE id = ? AND document_id = ? AND is_current = 1
            """,
            (document["document_index_id"], document["id"]),
        ).fetchone()
        if current is None:
            return
        connection.execute(
            "DELETE FROM semantic_embeddings WHERE generation_id = ? AND document_id = ?",
            (generation_id, document["id"]),
        )
        connection.executemany(
            """
            INSERT INTO semantic_embeddings(
              generation_id, document_id, document_index_id, profile_kind,
              profile_id, node_id, start_page, end_page, text_hash, vector,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    generation_id,
                    document["id"],
                    document["document_index_id"],
                    profile.kind,
                    profile.profile_id,
                    profile.node_id,
                    profile.start_page,
                    profile.end_page,
                    hashlib.sha256(profile.text.encode("utf-8")).hexdigest(),
                    pack_vector(vector),
                    now,
                )
                for profile, vector in zip(profiles, vectors)
            ],
        )


def _refresh_generation_counts(db_path: str, generation_id: str) -> None:
    with open_db(db_path) as connection:
        total = connection.execute(
            """
            SELECT COUNT(*)
              FROM documents d
              JOIN projects p ON p.id = d.project_id
              JOIN document_indexes di
                ON di.document_id = d.id AND di.is_current = 1
             WHERE d.status = 'ready' AND d.deleted_at IS NULL
               AND d.lifecycle_state = 'active' AND d.retrieval_eligible = 1
               AND p.deleted_at IS NULL AND p.lifecycle_state = 'active'
               AND p.retrieval_eligible = 1
            """
        ).fetchone()[0]
        indexed = connection.execute(
            """
            SELECT COUNT(DISTINCT se.document_id)
              FROM semantic_embeddings se
              JOIN document_indexes di ON di.id = se.document_index_id
             WHERE se.generation_id = ? AND se.profile_kind = 'document'
               AND di.is_current = 1
            """,
            (generation_id,),
        ).fetchone()[0]
        connection.execute(
            """
            UPDATE semantic_index_generations
               SET indexed_document_count = ?, total_document_count = ?,
                   status = 'backfilling', error_summary = NULL,
                   next_retry_at = NULL, updated_at = ?
             WHERE id = ?
            """,
            (indexed, total, _now(), generation_id),
        )


def _activate_generation(db_path: str, generation_id: str) -> None:
    _refresh_generation_counts(db_path, generation_id)
    now = _now()
    with open_db(db_path) as connection:
        connection.execute(
            """
            UPDATE semantic_index_generations
               SET is_active = 0,
                   status = CASE WHEN id = ? THEN status ELSE 'retired' END,
                   updated_at = ?
             WHERE is_active = 1 AND id != ?
            """,
            (generation_id, now, generation_id),
        )
        connection.execute(
            """
            UPDATE semantic_index_generations
               SET is_active = 1, status = 'ready', activated_at = ?,
                   error_summary = NULL, next_retry_at = NULL, updated_at = ?
             WHERE id = ?
            """,
            (now, now, generation_id),
        )


def _mark_generation_degraded(db_path: str, generation_id: str, exc: Exception) -> None:
    now = datetime.now(timezone.utc)
    with open_db(db_path) as connection:
        connection.execute(
            """
            UPDATE semantic_index_generations
               SET status = 'degraded', error_summary = ?, next_retry_at = ?,
                   updated_at = ?
             WHERE id = ?
            """,
            (
                f"{type(exc).__name__}: {str(exc)[:1000]}",
                (now + timedelta(seconds=SEMANTIC_RETRY_SECONDS)).isoformat(),
                now.isoformat(),
                generation_id,
            ),
        )


def _active_embedding_rows(
    db_path: str,
    generation_id: str,
    allowed_document_ids: set[str],
    *,
    profile_kind: str,
):
    if not allowed_document_ids:
        return []
    document_ids = sorted(allowed_document_ids)
    rows = []
    with open_db(db_path) as connection:
        for offset in range(0, len(document_ids), SQLITE_ID_BATCH_SIZE):
            batch = document_ids[offset : offset + SQLITE_ID_BATCH_SIZE]
            placeholders = ",".join("?" for _ in batch)
            rows.extend(
                connection.execute(
                    f"""
                    SELECT se.document_id, se.node_id, se.vector
                      FROM semantic_embeddings se
                      JOIN document_indexes di ON di.id = se.document_index_id
                     WHERE se.generation_id = ? AND se.profile_kind = ?
                       AND di.is_current = 1
                       AND se.document_id IN ({placeholders})
                    """,
                    (generation_id, profile_kind, *batch),
                ).fetchall()
            )
    return rows


def _ready_document_count(db_path: str) -> int:
    try:
        with open_db(db_path) as connection:
            return int(
                connection.execute(
                    """
                    SELECT COUNT(*) FROM documents d
                    JOIN projects p ON p.id = d.project_id
                    JOIN document_indexes di
                      ON di.document_id = d.id AND di.is_current = 1
                    WHERE d.status = 'ready' AND d.deleted_at IS NULL
                      AND d.lifecycle_state = 'active' AND d.retrieval_eligible = 1
                      AND p.deleted_at IS NULL AND p.lifecycle_state = 'active'
                      AND p.retrieval_eligible = 1
                    """
                ).fetchone()[0]
            )
    except sqlite3.OperationalError:
        return 0


def _retry_is_due(value: str | None) -> bool:
    if not value:
        return True
    try:
        retry_at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return True
    return retry_at <= datetime.now(timezone.utc)


def _positive_int(value) -> int | None:
    return value if type(value) is int and value > 0 else None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
