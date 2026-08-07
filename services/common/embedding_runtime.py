from __future__ import annotations

from dataclasses import dataclass
import math
import os
from time import perf_counter, sleep
from typing import Any, Callable

import httpx

from services.common.system_settings import get_embedding_runtime_settings


DEFAULT_BATCH_SIZE = 8
DEFAULT_TIMEOUT_SECONDS = 60.0
MAX_ATTEMPTS = 3


class EmbeddingProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class EmbeddingBatch:
    vectors: tuple[tuple[float, ...], ...]
    dimension: int
    prompt_tokens: int
    elapsed_ms: int


class OpenAIEmbeddingAdapter:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        batch_size: int = DEFAULT_BATCH_SIZE,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        transport: httpx.BaseTransport | None = None,
        sleep_fn: Callable[[float], None] = sleep,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = _provider_model_name(model)
        self.batch_size = max(1, batch_size)
        self.sleep_fn = sleep_fn
        self.client = httpx.Client(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout_seconds,
            transport=transport,
        )

    def close(self) -> None:
        self.client.close()

    @classmethod
    def from_runtime_settings(
        cls,
        db_path: str,
        *,
        model: str | None = None,
        base_url: str | None = None,
    ) -> OpenAIEmbeddingAdapter:
        settings = get_embedding_runtime_settings(db_path)
        resolved_model = (model or settings.model).strip()
        resolved_base_url = (base_url or settings.base_url).strip()
        if not settings.api_key or not resolved_base_url or not resolved_model:
            raise EmbeddingProviderError("Embedding model is not configured")
        return cls(
            api_key=settings.api_key,
            base_url=resolved_base_url,
            model=resolved_model,
        )

    def embed(self, texts: list[str] | tuple[str, ...]) -> EmbeddingBatch:
        normalized = [str(text).strip() for text in texts]
        if not normalized or any(not text for text in normalized):
            raise ValueError("Embedding inputs must be non-empty strings")

        started_at = perf_counter()
        vectors: list[tuple[float, ...]] = []
        prompt_tokens = 0
        dimension: int | None = None
        for offset in range(0, len(normalized), self.batch_size):
            batch = normalized[offset : offset + self.batch_size]
            payload = self._request_batch(batch)
            raw_items = payload.get("data")
            if not isinstance(raw_items, list):
                raise EmbeddingProviderError("Embedding response did not contain data")
            ordered = sorted(
                raw_items,
                key=lambda item: item.get("index", 0) if isinstance(item, dict) else 0,
            )
            if len(ordered) != len(batch):
                raise EmbeddingProviderError(
                    f"Embedding provider returned {len(ordered)} vectors for {len(batch)} inputs"
                )
            for item in ordered:
                vector = _validate_vector(item.get("embedding") if isinstance(item, dict) else None)
                if dimension is None:
                    dimension = len(vector)
                elif len(vector) != dimension:
                    raise EmbeddingProviderError(
                        "Embedding provider returned inconsistent vector dimensions"
                    )
                vectors.append(vector)
            usage = payload.get("usage")
            if isinstance(usage, dict):
                prompt_tokens += _usage_tokens(usage)

        return EmbeddingBatch(
            vectors=tuple(vectors),
            dimension=dimension or 0,
            prompt_tokens=prompt_tokens,
            elapsed_ms=int((perf_counter() - started_at) * 1000),
        )

    def _request_batch(self, batch: list[str]) -> dict[str, Any]:
        last_error: Exception | None = None
        response: httpx.Response | None = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                response = self.client.post(
                    "/embeddings",
                    json={
                        "model": self.model,
                        "input": batch,
                        "encoding_format": "float",
                    },
                )
                if response.status_code != 429 and response.status_code < 500:
                    break
            except httpx.TransportError as exc:
                last_error = exc
            if attempt < MAX_ATTEMPTS:
                self.sleep_fn(0.5 * attempt)

        if response is None:
            raise EmbeddingProviderError(
                f"Embedding provider connection failed: {type(last_error).__name__}"
            ) from last_error
        if response.is_error:
            raise EmbeddingProviderError(
                f"Embedding provider returned HTTP {response.status_code}: "
                f"{_provider_error_message(response)}"
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise EmbeddingProviderError("Embedding provider returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise EmbeddingProviderError("Embedding provider returned an invalid payload")
        return payload


def _provider_model_name(model: str) -> str:
    normalized = model.strip().removeprefix("litellm/")
    return normalized.removeprefix("openai/")


def _validate_vector(value: Any) -> tuple[float, ...]:
    if not isinstance(value, list) or not value:
        raise EmbeddingProviderError("Embedding response contained an empty vector")
    vector: list[float] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise EmbeddingProviderError("Embedding response contained a non-numeric value")
        number = float(item)
        if not math.isfinite(number):
            raise EmbeddingProviderError("Embedding response contained a non-finite value")
        vector.append(number)
    return tuple(vector)


def _usage_tokens(usage: dict[str, Any]) -> int:
    for key in ("prompt_tokens", "total_tokens"):
        value = usage.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            return max(0, value)
    return 0


def _provider_error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return response.text[:500]
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"][:500]
    return response.text[:500]
