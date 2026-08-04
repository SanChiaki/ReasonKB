from __future__ import annotations

from datetime import datetime, timezone
import logging
import sqlite3
from typing import Any, Literal
from uuid import uuid4

from services.common.llm_errors import (
    LlmErrorClass,
    classify_llm_error,
    exception_status_code,
    provider_host,
    response_metadata,
)


logger = logging.getLogger(__name__)
LlmOperation = Literal["index", "retrieval", "answer", "health_test"]
LlmOutcome = Literal["success", "failure"]
_MAX_EVENTS = 1000


def record_llm_event(
    db_path: str | None,
    *,
    operation: LlmOperation,
    stage: str,
    model: str | None,
    base_url: str | None,
    request_id: str | None,
    outcome: LlmOutcome,
    elapsed_ms: int,
    attempt: int = 1,
    retryable: bool = False,
    response: Any = None,
    exception: BaseException | None = None,
    status_code: int | None = None,
    error_class: LlmErrorClass | None = None,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    reasoning_tokens: int | None = None,
) -> None:
    if not db_path:
        return
    try:
        if exception is not None:
            status_code = (
                status_code
                if status_code is not None
                else exception_status_code(exception)
            )
            error_class = error_class or classify_llm_error(
                exception,
                status_code=status_code,
            )
            metadata = response_metadata(exception)
        else:
            metadata = {"providerRequestId": None, "retryAfter": None}

        if response is not None:
            usage = getattr(response, "usage", None)
            prompt_tokens = _usage_value(usage, "prompt_tokens")
            completion_tokens = _usage_value(usage, "completion_tokens")
            details = _usage_value(usage, "completion_tokens_details")
            reasoning_tokens = _usage_value(details, "reasoning_tokens")
            if reasoning_tokens is None:
                reasoning_tokens = _usage_value(usage, "reasoning_tokens")

        values = (
            f"llm_evt_{uuid4().hex}",
            datetime.now(timezone.utc).isoformat(),
            request_id,
            operation,
            stage,
            model,
            provider_host(base_url),
            outcome,
            error_class,
            status_code,
            type(exception).__name__ if exception is not None else None,
            max(0, int(elapsed_ms)),
            max(1, int(attempt)),
            1 if retryable else 0,
            metadata["providerRequestId"],
            metadata["retryAfter"],
            _int_or_none(prompt_tokens),
            _int_or_none(completion_tokens),
            _int_or_none(reasoning_tokens),
        )
        _write_event(db_path, values)
    except Exception as exc:
        # Event storage is best-effort and uses a short busy timeout so it
        # cannot materially extend a retrieval or indexing request.
        logger.warning("Unable to persist LLM observability event: %s", exc)


def _write_event(db_path: str, values: tuple[Any, ...]) -> None:
    conn = sqlite3.connect(db_path, timeout=0.1)
    try:
        conn.execute("PRAGMA busy_timeout = 100")
        conn.execute(
            """
            INSERT INTO llm_provider_events (
              id, occurred_at, request_id, operation, stage, model,
              provider_host, outcome, error_class, status_code,
              exception_type, elapsed_ms, attempt, retryable,
              provider_request_id, retry_after, prompt_tokens,
              completion_tokens, reasoning_tokens
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            values,
        )
        conn.execute(
            """
            DELETE FROM llm_provider_events
             WHERE id NOT IN (
               SELECT id FROM llm_provider_events
                ORDER BY occurred_at DESC
                LIMIT ?
             )
            """,
            (_MAX_EVENTS,),
        )
        conn.commit()
    finally:
        conn.close()


def _usage_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return None
