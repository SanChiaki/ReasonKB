import asyncio
import os
import sqlite3
import threading
import time
from types import SimpleNamespace

from services.common.index_metrics import index_run_metrics
from services.common import pageindex_runtime
from services.common.pageindex_runtime import (
    configure_pageindex_runtime,
    llm_request_scope,
)

configure_pageindex_runtime()

from pageindex import utils


def test_index_run_metrics_aggregates_llm_calls():
    with index_run_metrics() as metrics:
        metrics.record_llm_call(
            model="gpt-test",
            prompt_tokens=100,
            completion_tokens=25,
            elapsed_ms=30,
            token_source="provider_usage",
        )

    snapshot = metrics.snapshot()

    assert snapshot["llm_call_count"] == 1
    assert snapshot["prompt_tokens"] == 100
    assert snapshot["completion_tokens"] == 25
    assert snapshot["total_tokens"] == 125
    assert snapshot["token_source"] == "provider_usage"
    assert snapshot["models"] == {"gpt-test": 1}


def test_llm_completion_records_provider_usage(monkeypatch):
    def fake_completion(**_kwargs):
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="answer"),
                    finish_reason="stop",
                )
            ],
            usage=SimpleNamespace(prompt_tokens=12, completion_tokens=4, total_tokens=16),
        )

    monkeypatch.setattr("litellm.completion", fake_completion)

    with index_run_metrics() as metrics:
        assert utils.llm_completion(model="litellm/gpt-test", prompt="question") == "answer"

    snapshot = metrics.snapshot()
    assert snapshot["llm_call_count"] == 1
    assert snapshot["prompt_tokens"] == 12
    assert snapshot["completion_tokens"] == 4
    assert snapshot["total_tokens"] == 16
    assert snapshot["token_source"] == "provider_usage"
    assert snapshot["models"] == {"gpt-test": 1}


def test_llm_completion_uses_scoped_request_deadline(monkeypatch):
    captured = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="answer"),
                    finish_reason="stop",
                )
            ],
        )

    monkeypatch.setattr("litellm.completion", fake_completion)

    with llm_request_scope(timeout_seconds=17.5):
        assert utils.llm_completion(model="gpt-test", prompt="question") == "answer"

    assert 0 < captured["timeout"] <= 17.5
    assert captured["max_retries"] == 0


def test_llm_completion_preserves_indexing_timeout_contract_without_scope(monkeypatch):
    captured = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="answer"),
                    finish_reason="stop",
                )
            ],
        )

    monkeypatch.setattr("litellm.completion", fake_completion)

    assert utils.llm_completion(model="gpt-test", prompt="question") == "answer"
    assert "timeout" not in captured
    assert captured["max_retries"] == 0


def test_llm_completion_caps_pageindex_attempt_budget(monkeypatch):
    provider_calls = 0

    def failing_completion(**_kwargs):
        nonlocal provider_calls
        provider_calls += 1
        raise TimeoutError("provider timed out")

    monkeypatch.setenv("PAGEINDEX_LLM_MAX_ATTEMPTS", "99")
    monkeypatch.setattr("litellm.completion", failing_completion)
    monkeypatch.setattr(pageindex_runtime, "_wait_before_llm_retry", lambda *_args: True)

    assert utils.llm_completion(model="gpt-test", prompt="question") == ""
    assert provider_calls == 2


def test_llm_acompletion_uses_pageindex_attempt_budget(monkeypatch):
    provider_calls = 0

    async def failing_acompletion(**_kwargs):
        nonlocal provider_calls
        provider_calls += 1
        raise TimeoutError("provider timed out")

    monkeypatch.setenv("PAGEINDEX_LLM_MAX_ATTEMPTS", "1")
    monkeypatch.setattr("litellm.acompletion", failing_acompletion)

    async def run_completion():
        return await utils.llm_acompletion(model="gpt-test", prompt="question")

    assert asyncio.run(run_completion()) == ""
    assert provider_calls == 1


def test_llm_completion_does_not_retry_past_scoped_deadline(monkeypatch):
    provider_calls = 0

    def slow_failure(**_kwargs):
        nonlocal provider_calls
        provider_calls += 1
        time.sleep(0.02)
        raise TimeoutError("provider timed out")

    monkeypatch.setattr("litellm.completion", slow_failure)

    with llm_request_scope(timeout_seconds=0.01):
        result = utils.llm_completion(model="gpt-test", prompt="question")

    assert result == ""
    assert provider_calls == 1


def test_llm_completion_stops_retry_backoff_when_cancelled(monkeypatch):
    cancellation_event = threading.Event()
    backoff_started = threading.Event()
    finished = threading.Event()
    provider_calls = 0
    result: dict[str, str] = {}
    real_sleep = time.sleep

    def fake_completion(**_kwargs):
        nonlocal provider_calls
        provider_calls += 1
        raise TimeoutError("provider failed")

    def observed_sleep(seconds):
        backoff_started.set()
        real_sleep(seconds)

    monkeypatch.setattr("litellm.completion", fake_completion)
    monkeypatch.setattr(pageindex_runtime.time, "sleep", observed_sleep)

    def run_completion():
        with llm_request_scope(cancellation_event):
            result["value"] = utils.llm_completion(
                model="gpt-test",
                prompt="question",
            )
        finished.set()

    worker = threading.Thread(target=run_completion, daemon=True)
    worker.start()
    assert backoff_started.wait(timeout=0.5)

    cancellation_event.set()
    completed_during_backoff = finished.wait(timeout=0.25)
    worker.join(timeout=1.5)

    assert completed_during_backoff
    assert not worker.is_alive()
    assert result["value"] == ""
    assert provider_calls == 1


def test_llm_completion_rechecks_deadline_after_runtime_configuration(monkeypatch):
    provider_called = False

    def slow_runtime_configuration():
        time.sleep(0.02)

    def fake_completion(**_kwargs):
        nonlocal provider_called
        provider_called = True
        raise AssertionError("expired retrieval must not start a provider call")

    monkeypatch.setattr(
        pageindex_runtime,
        "configure_litellm_environment",
        slow_runtime_configuration,
    )
    monkeypatch.setattr("litellm.completion", fake_completion)

    with llm_request_scope(timeout_seconds=0.005):
        result = utils.llm_completion(model="gpt-test", prompt="question")

    assert result == ""
    assert provider_called is False


def test_llm_completion_rechecks_cancellation_after_runtime_configuration(monkeypatch):
    cancellation_event = threading.Event()
    provider_called = False

    def cancel_during_runtime_configuration():
        cancellation_event.set()

    def fake_completion(**_kwargs):
        nonlocal provider_called
        provider_called = True
        raise AssertionError("cancelled retrieval must not start a provider call")

    monkeypatch.setattr(
        pageindex_runtime,
        "configure_litellm_environment",
        cancel_during_runtime_configuration,
    )
    monkeypatch.setattr("litellm.completion", fake_completion)

    with llm_request_scope(cancellation_event):
        result = utils.llm_completion(model="gpt-test", prompt="question")

    assert result == ""
    assert provider_called is False


def test_llm_acompletion_uses_scoped_request_deadline(monkeypatch):
    captured = {}

    async def fake_acompletion(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="answer"))],
        )

    monkeypatch.setattr("litellm.acompletion", fake_acompletion)

    with llm_request_scope(timeout_seconds=17.5):
        result = asyncio.run(utils.llm_acompletion(model="gpt-test", prompt="question"))

    assert result == "answer"
    assert 0 < captured["timeout"] <= 17.5
    assert captured["max_retries"] == 0


def test_llm_acompletion_rechecks_deadline_after_runtime_configuration(monkeypatch):
    provider_called = False

    def slow_runtime_configuration():
        time.sleep(0.02)

    async def fake_acompletion(**_kwargs):
        nonlocal provider_called
        provider_called = True
        raise AssertionError("expired retrieval must not start a provider call")

    monkeypatch.setattr(
        pageindex_runtime,
        "configure_litellm_environment",
        slow_runtime_configuration,
    )
    monkeypatch.setattr("litellm.acompletion", fake_acompletion)

    async def run_expired_call():
        with llm_request_scope(timeout_seconds=0.005):
            return await utils.llm_acompletion(model="gpt-test", prompt="question")

    assert asyncio.run(run_expired_call()) == ""
    assert provider_called is False


def test_llm_acompletion_rechecks_cancellation_after_runtime_configuration(monkeypatch):
    cancellation_event = threading.Event()
    provider_called = False

    def cancel_during_runtime_configuration():
        cancellation_event.set()

    async def fake_acompletion(**_kwargs):
        nonlocal provider_called
        provider_called = True
        raise AssertionError("cancelled retrieval must not start a provider call")

    monkeypatch.setattr(
        pageindex_runtime,
        "configure_litellm_environment",
        cancel_during_runtime_configuration,
    )
    monkeypatch.setattr("litellm.acompletion", fake_acompletion)

    async def run_cancelled_call():
        with llm_request_scope(cancellation_event):
            return await utils.llm_acompletion(model="gpt-test", prompt="question")

    assert asyncio.run(run_cancelled_call()) == ""
    assert provider_called is False


def test_llm_acompletion_stops_retry_backoff_when_cancelled(monkeypatch):
    cancellation_event = threading.Event()
    provider_calls = 0
    real_asyncio_sleep = asyncio.sleep

    async def fake_acompletion(**_kwargs):
        nonlocal provider_calls
        provider_calls += 1
        raise TimeoutError("provider failed")

    async def run_completion():
        backoff_started = asyncio.Event()

        async def observed_sleep(seconds):
            backoff_started.set()
            await real_asyncio_sleep(seconds)

        monkeypatch.setattr(asyncio, "sleep", observed_sleep)

        async def call_provider():
            with llm_request_scope(cancellation_event):
                return await utils.llm_acompletion(
                    model="gpt-test",
                    prompt="question",
                )

        task = asyncio.create_task(call_provider())
        await asyncio.wait_for(backoff_started.wait(), timeout=0.5)
        cancellation_event.set()
        try:
            result = await asyncio.wait_for(task, timeout=0.25)
        except TimeoutError:
            return False, None
        return True, result

    monkeypatch.setattr("litellm.acompletion", fake_acompletion)

    completed_during_backoff, result = asyncio.run(run_completion())

    assert completed_during_backoff
    assert result == ""
    assert provider_calls == 1


def test_llm_completion_discards_response_when_cancelled_in_provider(monkeypatch):
    cancellation_event = threading.Event()
    provider_calls = 0

    def fake_completion(**_kwargs):
        nonlocal provider_calls
        provider_calls += 1
        cancellation_event.set()
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="stale answer"),
                    finish_reason="stop",
                )
            ],
        )

    monkeypatch.setattr("litellm.completion", fake_completion)

    with llm_request_scope(cancellation_event):
        result = utils.llm_completion(model="gpt-test", prompt="question")

    assert result == ""
    assert provider_calls == 1


def test_llm_request_scope_isolates_overlapping_async_tasks(monkeypatch):
    first_cancelled = threading.Event()
    second_cancelled = threading.Event()
    provider_prompts: list[str] = []

    async def fake_acompletion(**kwargs):
        provider_prompts.append(kwargs["messages"][-1]["content"])
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="answer"))],
        )

    monkeypatch.setattr("litellm.acompletion", fake_acompletion)

    async def run_overlapping_scopes():
        first_entered = asyncio.Event()
        let_first_continue = asyncio.Event()
        first_finished = asyncio.Event()

        async def first_task():
            with llm_request_scope(first_cancelled):
                first_entered.set()
                await let_first_continue.wait()
                result = await utils.llm_acompletion(
                    model="gpt-test",
                    prompt="first",
                )
                first_finished.set()
                return result

        async def second_task():
            await first_entered.wait()
            with llm_request_scope(second_cancelled):
                first_cancelled.set()
                let_first_continue.set()
                await first_finished.wait()
                return await utils.llm_acompletion(
                    model="gpt-test",
                    prompt="second",
                )

        results = await asyncio.gather(first_task(), second_task())
        after = await utils.llm_acompletion(model="gpt-test", prompt="after")
        return results, after

    results, after = asyncio.run(run_overlapping_scopes())

    assert results == ["", "answer"]
    assert after == "answer"
    assert provider_prompts == ["second", "after"]


def test_nested_llm_request_scope_preserves_outer_cancellation(monkeypatch):
    provider_called = False

    def fake_completion(**_kwargs):
        nonlocal provider_called
        provider_called = True
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="answer"),
                    finish_reason="stop",
                )
            ],
        )

    outer_event = threading.Event()
    inner_event = threading.Event()
    outer_event.set()
    monkeypatch.setattr("litellm.completion", fake_completion)

    with llm_request_scope(outer_event):
        with llm_request_scope(inner_event):
            result = utils.llm_completion(model="gpt-test", prompt="question")

    assert result == ""
    assert provider_called is False


def test_llm_completion_skips_provider_when_stream_is_cancelled(monkeypatch):
    provider_called = False

    def fake_completion(**_kwargs):
        nonlocal provider_called
        provider_called = True
        raise AssertionError("cancelled retrieval must not start another provider call")

    cancellation_event = threading.Event()
    cancellation_event.set()
    monkeypatch.setattr("litellm.completion", fake_completion)

    with llm_request_scope(cancellation_event):
        result = utils.llm_completion(model="gpt-test", prompt="question")

    assert result == ""
    assert provider_called is False


def test_llm_completion_estimates_tokens_when_usage_is_missing(monkeypatch):
    def fake_completion(**_kwargs):
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="estimated answer"),
                    finish_reason="stop",
                )
            ],
        )

    def fake_token_counter(model=None, text=""):
        return len(text.split())

    monkeypatch.setattr("litellm.completion", fake_completion)
    monkeypatch.setattr("litellm.token_counter", fake_token_counter)

    with index_run_metrics() as metrics:
        assert utils.llm_completion(model="gpt-test", prompt="one two three") == "estimated answer"

    snapshot = metrics.snapshot()
    assert snapshot["llm_call_count"] == 1
    assert snapshot["prompt_tokens"] == 3
    assert snapshot["completion_tokens"] == 2
    assert snapshot["total_tokens"] == 5
    assert snapshot["token_source"] == "estimated"
    assert snapshot["models"] == {"gpt-test": 1}


def test_llm_completion_refreshes_runtime_settings_before_each_call(monkeypatch, tmp_path):
    db_path = tmp_path / "app.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE system_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """,
    )
    conn.executemany(
        "INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
        [
            ("llmApiKey", '"runtime-key"', "2026-05-19T00:00:00Z"),
            ("llmBaseUrl", '"https://runtime.example.test/v1"', "2026-05-19T00:00:00Z"),
        ],
    )
    conn.commit()
    conn.close()

    monkeypatch.setenv("APP_DB_PATH", str(db_path))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)

    def fake_completion(**_kwargs):
        assert os.environ["OPENAI_API_KEY"] == "runtime-key"
        assert os.environ["OPENAI_BASE_URL"] == "https://runtime.example.test/v1"
        assert os.environ["OPENAI_API_BASE"] == "https://runtime.example.test/v1"
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="runtime answer"),
                    finish_reason="stop",
                )
            ],
        )

    monkeypatch.setattr("litellm.completion", fake_completion)

    assert utils.llm_completion(model="gpt-test", prompt="question") == "runtime answer"
