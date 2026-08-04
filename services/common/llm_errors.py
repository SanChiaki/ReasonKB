from __future__ import annotations

from typing import Any, Literal
from urllib.parse import urlsplit


LlmErrorClass = Literal[
    "authentication_failed",
    "connection_error",
    "deadline_exceeded",
    "invalid_request",
    "model_not_found",
    "provider_error",
    "provider_unavailable",
    "rate_limited",
    "timeout",
    "cancelled",
]


_AUTHENTICATION_NAMES = frozenset({"AuthenticationError", "PermissionDeniedError"})
_CONNECTION_NAMES = frozenset({"APIConnectionError", "ConnectError", "ConnectionError"})
_TIMEOUT_NAMES = frozenset({"APITimeoutError", "Timeout", "ReadTimeout", "TimeoutError"})
_UNAVAILABLE_NAMES = frozenset(
    {
        "BadGatewayError",
        "InternalServerError",
        "ServiceUnavailableError",
    }
)
_RATE_LIMIT_NAMES = frozenset({"RateLimitError"})


def exception_status_code(exc: BaseException | None) -> int | None:
    if exc is None:
        return None
    status_code = getattr(exc, "status_code", None)
    if not isinstance(status_code, int):
        status_code = getattr(getattr(exc, "response", None), "status_code", None)
    return status_code if isinstance(status_code, int) else None


def classify_llm_error(
    exc: BaseException | None = None,
    *,
    status_code: int | None = None,
    error_type: str | None = None,
) -> LlmErrorClass:
    code = status_code if status_code is not None else exception_status_code(exc)
    names = {cls.__name__ for cls in type(exc).__mro__} if exc is not None else set()
    normalized_error_type = (error_type or "").strip()

    if normalized_error_type == "RequestCancelled":
        return "cancelled"
    if normalized_error_type == "RequestDeadlineExceeded":
        return "deadline_exceeded"
    if code in {401, 403} or names & _AUTHENTICATION_NAMES:
        return "authentication_failed"
    if code == 404:
        return "model_not_found"
    if code == 429 or names & _RATE_LIMIT_NAMES:
        return "rate_limited"
    if code in {408, 504} or names & _TIMEOUT_NAMES:
        return "timeout"
    if code in {400, 413, 422}:
        return "invalid_request"
    if code in {500, 502, 503} or names & _UNAVAILABLE_NAMES:
        return "provider_unavailable"
    if names & _CONNECTION_NAMES:
        return "connection_error"
    return "provider_error"


def provider_host(base_url: str | None) -> str | None:
    if not isinstance(base_url, str) or not base_url.strip():
        return None
    try:
        hostname = urlsplit(base_url.strip()).hostname
    except ValueError:
        return None
    return hostname.lower() if hostname else None


def response_metadata(exc: BaseException | None) -> dict[str, str | None]:
    response: Any = getattr(exc, "response", None) if exc else None
    headers = getattr(response, "headers", None)
    if headers is None:
        headers = getattr(exc, "headers", None) if exc else None
    if not headers:
        return {"providerRequestId": None, "retryAfter": None}
    normalized = {str(key).lower(): str(value) for key, value in headers.items()}
    return {
        "providerRequestId": (
            normalized.get("x-request-id")
            or normalized.get("x-deepseek-request-id")
            or normalized.get("request-id")
        ),
        "retryAfter": normalized.get("retry-after"),
    }


def public_error_message(error_class: LlmErrorClass) -> str:
    return {
        "authentication_failed": "Model API authentication failed.",
        "connection_error": "Could not connect to the model API.",
        "deadline_exceeded": "The retrieval request exceeded its deadline.",
        "invalid_request": "The model API rejected the request.",
        "model_not_found": "The configured model was not found.",
        "provider_error": "The model provider returned an error.",
        "provider_unavailable": "The model provider is temporarily unavailable.",
        "rate_limited": "The model API rate limit was reached.",
        "timeout": "The model API request timed out.",
        "cancelled": "The model API request was cancelled.",
    }[error_class]
