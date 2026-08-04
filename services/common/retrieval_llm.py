from __future__ import annotations

from dataclasses import dataclass
import json
import logging
import math
import time
from time import monotonic, perf_counter
from typing import Any, Literal

import litellm

from services.common.llm_environment import configure_litellm_environment
from services.common.llm_reasoning import ReasoningMode, reasoning_options_for_model
from services.common.llm_errors import classify_llm_error, exception_status_code
from services.common.llm_observability import record_llm_event


logger = logging.getLogger(__name__)
# Uvicorn configures its own loggers but leaves application loggers at the
# root WARNING level. Retrieval metrics are an operational contract, so keep
# this module at INFO while failures continue to use WARNING.
logger.setLevel(logging.INFO)

_TRANSIENT_STATUS_CODES = frozenset({408, 409, 425, 429, 500, 502, 503, 504})
_TRANSIENT_EXCEPTION_NAMES = frozenset(
    {
        "APIConnectionError",
        "APITimeoutError",
        "InternalServerError",
        "RateLimitError",
        "ServiceUnavailableError",
        "Timeout",
    }
)
_PERMANENT_EXCEPTION_NAMES = frozenset(
    {
        "AuthenticationError",
        "BadRequestError",
        "ContextWindowExceededError",
        "NotFoundError",
        "PermissionDeniedError",
        "UnprocessableEntityError",
    }
)
_RETRY_POLL_SECONDS = 0.05
_ANTHROPIC_LOW_REASONING_BUDGET_TOKENS = 1024


@dataclass(frozen=True)
class CompletionResult:
    content: str | None
    finish_reason: str | None = None
    error_type: str | None = None
    status_code: int | None = None
    attempts: int = 0


def complete(
    *,
    model: str | None,
    prompt: str,
    stage: str,
    operation: Literal["retrieval", "answer"] = "retrieval",
    reasoning: ReasoningMode,
    timeout_seconds: float,
    deadline: float,
    max_output_tokens: int | None = None,
    max_attempts: int = 2,
    cancellation_signal: Any = None,
    api_key: str | None = None,
    base_url: str | None = None,
    request_id: str | None = None,
    db_path: str | None = None,
) -> CompletionResult:
    normalized_model = model.removeprefix("litellm/") if model else model
    attempts = max(1, min(int(max_attempts), 2))

    if _cancelled(cancellation_signal):
        return CompletionResult(None, error_type="RequestCancelled")
    if _remaining_seconds(deadline) == 0:
        return CompletionResult(None, error_type="RequestDeadlineExceeded")

    reasoning_options, reasoning_control = _reasoning_options(
        normalized_model,
        reasoning,
    )
    messages = [{"role": "user", "content": prompt}]

    for attempt in range(1, attempts + 1):
        if _cancelled(cancellation_signal):
            return CompletionResult(
                None,
                error_type="RequestCancelled",
                attempts=attempt - 1,
            )
        remaining = _remaining_seconds(deadline)
        if remaining == 0:
            return CompletionResult(
                None,
                error_type="RequestDeadlineExceeded",
                attempts=attempt - 1,
            )

        if not api_key and not base_url:
            configure_litellm_environment()
            remaining = _remaining_seconds(deadline)
            if remaining == 0:
                return CompletionResult(
                    None,
                    error_type="RequestDeadlineExceeded",
                    attempts=attempt - 1,
                )

        call_timeout = min(_positive_timeout(timeout_seconds), remaining)
        options: dict[str, Any] = {
            "model": normalized_model,
            "messages": messages,
            "temperature": 0,
            "timeout": call_timeout,
            "max_retries": 0,
            **reasoning_options,
        }
        if reasoning_control == "anthropic_low":
            # Anthropic rejects temperature with thinking enabled. Its max_tokens
            # also includes the reasoning budget, unlike the visible-output limit
            # used by callers of this helper.
            options.pop("temperature", None)
        if max_output_tokens is not None:
            visible_output_tokens = max(1, int(max_output_tokens))
            options["max_tokens"] = visible_output_tokens + (
                _ANTHROPIC_LOW_REASONING_BUDGET_TOKENS
                if reasoning_control == "anthropic_low"
                else 0
            )
        if api_key:
            options["api_key"] = api_key
        if base_url:
            options["base_url"] = base_url

        started_at = perf_counter()
        try:
            response = litellm.completion(**options)
            elapsed_ms = int((perf_counter() - started_at) * 1000)
            choice = response.choices[0]
            content = getattr(getattr(choice, "message", None), "content", None)
            finish_reason = getattr(choice, "finish_reason", None)
            normalized_finish_reason = (
                "max_output_reached" if finish_reason == "length" else finish_reason
            )
            response_status = (
                "cancelled"
                if _cancelled(cancellation_signal)
                else "deadline_exceeded"
                if _remaining_seconds(deadline) == 0
                else "ok"
            )
            _log_success(
                response,
                model=normalized_model,
                stage=stage,
                request_id=request_id,
                attempt=attempt,
                elapsed_ms=elapsed_ms,
                finish_reason=normalized_finish_reason,
                reasoning_control=reasoning_control,
                status=response_status,
            )
            content_is_valid = isinstance(content, str) and bool(content.strip())
            if response_status == "ok" and content_is_valid:
                record_llm_event(
                    db_path,
                    operation=operation,
                    stage=stage,
                    model=normalized_model,
                    base_url=base_url,
                    request_id=request_id,
                    outcome="success",
                    elapsed_ms=elapsed_ms,
                    attempt=attempt,
                    response=response,
                )
            else:
                error_class = (
                    classify_llm_error(error_type="RequestCancelled")
                    if response_status == "cancelled"
                    else classify_llm_error(error_type="RequestDeadlineExceeded")
                    if response_status == "deadline_exceeded"
                    else "provider_error"
                )
                record_llm_event(
                    db_path,
                    operation=operation,
                    stage=stage,
                    model=normalized_model,
                    base_url=base_url,
                    request_id=request_id,
                    outcome="failure",
                    elapsed_ms=elapsed_ms,
                    attempt=attempt,
                    response=response,
                    error_class=error_class,
                )
            if response_status == "cancelled":
                return CompletionResult(
                    None,
                    error_type="RequestCancelled",
                    attempts=attempt,
                )
            if response_status == "deadline_exceeded":
                return CompletionResult(
                    None,
                    error_type="RequestDeadlineExceeded",
                    attempts=attempt,
                )
            if not isinstance(content, str) or not content.strip():
                return CompletionResult(
                    None,
                    finish_reason=normalized_finish_reason,
                    error_type="EmptyProviderResponse",
                    attempts=attempt,
                )
            return CompletionResult(
                content,
                finish_reason=normalized_finish_reason,
                attempts=attempt,
            )
        except Exception as exc:
            elapsed_ms = int((perf_counter() - started_at) * 1000)
            status_code = _exception_status_code(exc)
            retryable = _is_transient_error(exc, status_code)
            _log_failure(
                exc,
                model=normalized_model,
                stage=stage,
                request_id=request_id,
                attempt=attempt,
                max_attempts=attempts,
                elapsed_ms=elapsed_ms,
                status_code=status_code,
                retryable=retryable,
                reasoning_control=reasoning_control,
            )
            record_llm_event(
                db_path,
                operation=operation,
                stage=stage,
                model=normalized_model,
                base_url=base_url,
                request_id=request_id,
                outcome="failure",
                elapsed_ms=elapsed_ms,
                attempt=attempt,
                retryable=retryable,
                exception=exc,
                status_code=status_code,
            )
            if (
                not retryable
                or attempt >= attempts
                or not _wait_before_retry(cancellation_signal, deadline)
            ):
                return CompletionResult(
                    None,
                    error_type=type(exc).__name__,
                    status_code=status_code,
                    attempts=attempt,
                )

    return CompletionResult(None, error_type="ProviderError", attempts=attempts)


def _positive_timeout(value: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0.001
    if not math.isfinite(parsed) or parsed <= 0:
        return 0.001
    return parsed


def _remaining_seconds(deadline: float) -> float:
    return max(0.0, deadline - monotonic())


def _cancelled(signal: Any) -> bool:
    is_set = getattr(signal, "is_set", None)
    return bool(callable(is_set) and is_set())


def _wait_before_retry(
    cancellation_signal: Any,
    deadline: float,
    delay_seconds: float = 0.25,
) -> bool:
    retry_at = monotonic() + max(delay_seconds, 0.0)
    while monotonic() < retry_at:
        if _cancelled(cancellation_signal) or _remaining_seconds(deadline) == 0:
            return False
        time.sleep(
            min(
                _RETRY_POLL_SECONDS,
                retry_at - monotonic(),
                _remaining_seconds(deadline),
            )
        )
    return not _cancelled(cancellation_signal) and _remaining_seconds(deadline) > 0


def _reasoning_options(
    model: str | None,
    reasoning: ReasoningMode,
) -> tuple[dict[str, Any], str]:
    options, control = reasoning_options_for_model(model, reasoning)
    if control == "deepseek_low_fallback_disabled":
        # DeepSeek-compatible endpoints do not provide a portable,
        # independently enforceable reasoning-token budget.
        logger.warning(
            "retrieval_llm_low_reasoning_unavailable %s",
            json.dumps(
                {"model": model, "fallbackReasoning": "disabled"},
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            ),
        )
    elif control == "unsupported":
        logger.warning(
            "retrieval_llm_reasoning_control_unsupported %s",
            json.dumps(
                {"model": model, "requestedReasoning": reasoning},
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            ),
        )
    return options, control


def _exception_status_code(exc: Exception) -> int | None:
    status_code = getattr(exc, "status_code", None)
    if not isinstance(status_code, int):
        status_code = getattr(getattr(exc, "response", None), "status_code", None)
    return status_code if isinstance(status_code, int) else None


def _is_transient_error(exc: Exception, status_code: int | None) -> bool:
    exception_names = {cls.__name__ for cls in type(exc).__mro__}
    if exception_names & _PERMANENT_EXCEPTION_NAMES:
        return False
    if status_code in _TRANSIENT_STATUS_CODES:
        return True
    if isinstance(exc, (TimeoutError, ConnectionError)):
        return True
    return bool(exception_names & _TRANSIENT_EXCEPTION_NAMES)


def _usage_value(value: Any, key: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _log_success(
    response: Any,
    *,
    model: str | None,
    stage: str,
    request_id: str | None,
    attempt: int,
    elapsed_ms: int,
    finish_reason: str | None,
    reasoning_control: str,
    status: str = "ok",
) -> None:
    usage = getattr(response, "usage", None)
    details = _usage_value(usage, "completion_tokens_details")
    logger.info(
        "retrieval_llm_call %s",
        json.dumps(
            {
                "attempt": attempt,
                "completionTokens": _usage_value(usage, "completion_tokens"),
                "elapsedMs": elapsed_ms,
                "finishReason": finish_reason,
                "model": model,
                "promptTokens": _usage_value(usage, "prompt_tokens"),
                "reasoningControl": reasoning_control,
                "reasoningTokens": _usage_value(details, "reasoning_tokens"),
                "requestId": request_id,
                "stage": stage,
                "status": status,
            },
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ),
    )


def _log_failure(
    exc: Exception,
    *,
    model: str | None,
    stage: str,
    request_id: str | None,
    attempt: int,
    max_attempts: int,
    elapsed_ms: int,
    status_code: int | None,
    retryable: bool,
    reasoning_control: str,
) -> None:
    logger.warning(
        "retrieval_llm_call %s",
        json.dumps(
            {
                "attempt": attempt,
                "elapsedMs": elapsed_ms,
                "exceptionType": type(exc).__name__,
                "maxAttempts": max_attempts,
                "model": model,
                "reasoningControl": reasoning_control,
                "requestId": request_id,
                "retryable": retryable,
                "stage": stage,
                "status": "error",
                "statusCode": status_code,
            },
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ),
    )
