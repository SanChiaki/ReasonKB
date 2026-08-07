from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from services.common.embedding_runtime import OpenAIEmbeddingAdapter
from services.common.llm_observability import record_llm_event
from services.common.system_settings import get_embedding_runtime_settings


@dataclass(frozen=True)
class EmbeddingTestInput:
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None


def _clean(value: str | None) -> str:
    return value.strip() if isinstance(value, str) else ""


def test_embedding_configuration(
    db_path: str,
    request: EmbeddingTestInput,
) -> dict[str, Any]:
    runtime_settings = get_embedding_runtime_settings(db_path)
    api_key = _clean(request.api_key) or runtime_settings.api_key
    base_url = _clean(request.base_url) or runtime_settings.base_url
    model = _clean(request.model) or runtime_settings.model
    missing = [
        label
        for label, value in (
            ("API key", api_key),
            ("Base URL", base_url),
            ("Model", model),
        )
        if not value
    ]
    if missing:
        details = f"Missing {', '.join(missing)}."
        return {
            "success": False,
            "model": model,
            "dimension": 0,
            "promptTokens": 0,
            "elapsedMs": 0,
            "errorType": "configuration",
            "message": details,
            "details": details,
        }

    adapter = OpenAIEmbeddingAdapter(
        api_key=api_key,
        base_url=base_url,
        model=model,
        timeout_seconds=20,
    )
    try:
        batch = adapter.embed(["ReasonKB embedding connection test"])
        record_llm_event(
            db_path,
            operation="health_test",
            stage="embedding_connectivity",
            model=model,
            base_url=base_url,
            request_id=None,
            outcome="success",
            elapsed_ms=batch.elapsed_ms,
            prompt_tokens=batch.prompt_tokens,
        )
        return {
            "success": True,
            "model": model,
            "dimension": batch.dimension,
            "promptTokens": batch.prompt_tokens,
            "elapsedMs": batch.elapsed_ms,
            "errorType": None,
            "message": "Embedding model test succeeded.",
            "details": "",
        }
    except Exception as exc:
        details = str(exc)
        record_llm_event(
            db_path,
            operation="health_test",
            stage="embedding_connectivity",
            model=model,
            base_url=base_url,
            request_id=None,
            outcome="failure",
            elapsed_ms=0,
            exception=exc,
        )
        lowered = details.lower()
        if "401" in details or "403" in details or "api key" in lowered:
            error_type = "authentication"
        elif "timeout" in lowered or "timed out" in lowered:
            error_type = "timeout"
        elif "connection" in lowered:
            error_type = "connection"
        elif "model" in lowered and ("not found" in lowered or "does not exist" in lowered):
            error_type = "model"
        else:
            error_type = "provider"
        return {
            "success": False,
            "model": model,
            "dimension": 0,
            "promptTokens": 0,
            "elapsedMs": 0,
            "errorType": error_type,
            "message": "Embedding model test failed.",
            "details": details[:1000],
        }
    finally:
        adapter.close()
