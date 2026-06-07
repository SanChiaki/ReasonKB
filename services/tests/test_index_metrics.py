import os
import sqlite3
from types import SimpleNamespace

from services.common.index_metrics import index_run_metrics
from services.common.pageindex_runtime import configure_pageindex_runtime

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
