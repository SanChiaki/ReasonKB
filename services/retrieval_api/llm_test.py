from __future__ import annotations

from dataclasses import dataclass
from time import perf_counter
from typing import Any

import litellm

from services.common.llm_errors import classify_llm_error, exception_status_code
from services.common.llm_observability import record_llm_event
from services.common.system_settings import get_llm_runtime_settings


@dataclass(frozen=True)
class LlmTestInput:
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None


def _clean(value: str | None) -> str:
    return value.strip() if isinstance(value, str) else ""


def _error_type(message: str) -> str:
    lowered = message.lower()
    if "auth" in lowered or "api key" in lowered or "unauthorized" in lowered:
        return "authentication"
    if "timeout" in lowered or "timed out" in lowered:
        return "timeout"
    if "model" in lowered and ("not found" in lowered or "does not exist" in lowered):
        return "model"
    if "base url" in lowered or "api_base" in lowered or "connection" in lowered:
        return "connection"
    return "provider"


def _public_message(error_type: str) -> str:
    if error_type == "authentication":
        return "Authentication failed. Check the API key."
    if error_type == "timeout":
        return "Model test timed out. Check the base URL and provider status."
    if error_type == "model":
        return "Model was not found. Check the model name."
    if error_type == "connection":
        return "Could not connect to the model endpoint. Check the Base URL."
    return "Model test failed. Check the provider response."


def test_llm_configuration(db_path: str, request: LlmTestInput) -> dict[str, Any]:
    runtime_settings = get_llm_runtime_settings(db_path)
    api_key = _clean(request.api_key) or runtime_settings.api_key
    base_url = _clean(request.base_url) or runtime_settings.base_url
    model = _clean(request.model) or runtime_settings.model

    missing = []
    if not api_key:
        missing.append("API key")
    if not base_url:
        missing.append("Base URL")
    if not model:
        missing.append("Model")
    if missing:
        details = f"Missing {', '.join(missing)}."
        return {
            "success": False,
            "model": model,
            "elapsedMs": 0,
            "output": "",
            "errorType": "configuration",
            "message": details,
            "details": details,
        }

    started_at = perf_counter()
    try:
        response = litellm.completion(
            model=model,
            api_key=api_key,
            api_base=base_url,
            messages=[
                {
                    "role": "user",
                    "content": "Reply with OK only. This is a ReasonKB model connection test.",
                }
            ],
            temperature=0,
            timeout=20,
            max_retries=0,
        )
        output = (response.choices[0].message.content or "").strip()
        elapsed_ms = int((perf_counter() - started_at) * 1000)
        record_llm_event(
            db_path,
            operation="health_test",
            stage="connectivity_test",
            model=model,
            base_url=base_url,
            request_id=None,
            outcome="success",
            elapsed_ms=elapsed_ms,
            response=response,
        )
        return {
            "success": True,
            "model": model,
            "elapsedMs": elapsed_ms,
            "output": output[:500],
            "errorType": None,
            "message": "Model test succeeded.",
            "details": "",
        }
    except Exception as exc:
        elapsed_ms = int((perf_counter() - started_at) * 1000)
        status_code = exception_status_code(exc)
        error_class = classify_llm_error(exc, status_code=status_code)
        record_llm_event(
            db_path,
            operation="health_test",
            stage="connectivity_test",
            model=model,
            base_url=base_url,
            request_id=None,
            outcome="failure",
            elapsed_ms=elapsed_ms,
            retryable=error_class
            in {"timeout", "connection_error", "provider_unavailable", "rate_limited"},
            exception=exc,
            status_code=status_code,
        )
        details = str(exc)
        error_type = _error_type(details)
        return {
            "success": False,
            "model": model,
            "elapsedMs": elapsed_ms,
            "output": "",
            "errorType": error_type,
            "message": _public_message(error_type),
            "details": details[:1000],
        }
