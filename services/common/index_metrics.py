from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from time import perf_counter
from typing import Iterator


_CURRENT_METRICS: ContextVar[IndexRunMetrics | None] = ContextVar(
    "index_run_metrics",
    default=None,
)


@dataclass
class IndexRunMetrics:
    text_extraction_ms: int = 0
    pageindex_ms: int = 0
    vision_extraction_ms: int = 0
    persist_ms: int = 0
    llm_call_count: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    reasoning_tokens: int = 0
    total_tokens: int = 0
    _all_provider_usage: bool = True
    _models: dict[str, int] = field(default_factory=dict)

    @contextmanager
    def timer(self, field_name: str) -> Iterator[None]:
        started_at = perf_counter()
        try:
            yield
        finally:
            elapsed_ms = int((perf_counter() - started_at) * 1000)
            current = getattr(self, field_name)
            setattr(self, field_name, current + elapsed_ms)

    def record_llm_call(
        self,
        *,
        model: str | None,
        prompt_tokens: int,
        completion_tokens: int,
        elapsed_ms: int,
        token_source: str,
        reasoning_tokens: int = 0,
    ) -> None:
        del elapsed_ms
        model_name = model or "unknown"
        self.llm_call_count += 1
        self.prompt_tokens += max(prompt_tokens, 0)
        self.completion_tokens += max(completion_tokens, 0)
        self.reasoning_tokens += max(reasoning_tokens, 0)
        self.total_tokens += max(prompt_tokens + completion_tokens, 0)
        self._models[model_name] = self._models.get(model_name, 0) + 1
        if token_source != "provider_usage":
            self._all_provider_usage = False

    def snapshot(self) -> dict:
        return {
            "text_extraction_ms": self.text_extraction_ms,
            "pageindex_ms": self.pageindex_ms,
            "vision_extraction_ms": self.vision_extraction_ms,
            "persist_ms": self.persist_ms,
            "llm_call_count": self.llm_call_count,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "reasoning_tokens": self.reasoning_tokens,
            "total_tokens": self.total_tokens,
            "token_source": "provider_usage"
            if self._all_provider_usage and self.llm_call_count > 0
            else "estimated",
            "models": dict(self._models),
        }


@contextmanager
def index_run_metrics() -> Iterator[IndexRunMetrics]:
    metrics = IndexRunMetrics()
    token = _CURRENT_METRICS.set(metrics)
    try:
        yield metrics
    finally:
        _CURRENT_METRICS.reset(token)


def current_index_metrics() -> IndexRunMetrics | None:
    return _CURRENT_METRICS.get()
