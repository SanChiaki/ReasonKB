import sqlite3
from types import SimpleNamespace

from fastapi.testclient import TestClient

from services.retrieval_api import app as retrieval_app


def _seed_settings_db(tmp_path, rows):
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
        rows,
    )
    conn.commit()
    conn.close()
    return db_path


def test_llm_test_uses_saved_api_key_when_request_key_is_blank(
    tmp_path,
    monkeypatch,
):
    db_path = _seed_settings_db(
        tmp_path,
        [
            ("llmApiKey", '"saved-key"', "2026-06-16T00:00:00Z"),
            ("llmBaseUrl", '"https://saved.example.test/v1"', "2026-06-16T00:00:00Z"),
            ("llmModel", '"openai/saved-model"', "2026-06-16T00:00:00Z"),
        ],
    )
    monkeypatch.setattr(retrieval_app, "DB_PATH", db_path)

    seen_kwargs = {}
    observed_events = []

    def fake_completion(**kwargs):
        seen_kwargs.update(kwargs)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="OK"),
                    finish_reason="stop",
                )
            ],
        )

    monkeypatch.setattr("litellm.completion", fake_completion)
    monkeypatch.setattr(
        "services.retrieval_api.llm_test.record_llm_event",
        lambda *args, **kwargs: observed_events.append((args, kwargs)),
    )

    client = TestClient(retrieval_app.app)
    response = client.post(
        "/internal/llm/test",
        json={
            "apiKey": "",
            "baseUrl": "https://current.example.test/v1",
            "model": "openai/current-model",
        },
    )

    assert response.status_code == 200
    assert response.json()["success"] is True
    assert response.json()["output"] == "OK"
    assert seen_kwargs["api_key"] == "saved-key"
    assert seen_kwargs["api_base"] == "https://current.example.test/v1"
    assert seen_kwargs["model"] == "openai/current-model"
    assert seen_kwargs["max_retries"] == 0
    event = observed_events[0][1]
    assert event["operation"] == "health_test"
    assert event["outcome"] == "success"
    assert event["base_url"] == "https://current.example.test/v1"


def test_llm_test_reports_missing_saved_api_key(tmp_path, monkeypatch):
    db_path = _seed_settings_db(
        tmp_path,
        [
            ("llmBaseUrl", '"https://saved.example.test/v1"', "2026-06-16T00:00:00Z"),
            ("llmModel", '"openai/saved-model"', "2026-06-16T00:00:00Z"),
        ],
    )
    monkeypatch.setattr(retrieval_app, "DB_PATH", db_path)

    client = TestClient(retrieval_app.app)
    response = client.post(
        "/internal/llm/test",
        json={
            "apiKey": "",
            "baseUrl": "https://current.example.test/v1",
            "model": "openai/current-model",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "success": False,
        "model": "openai/current-model",
        "elapsedMs": 0,
        "output": "",
        "errorType": "configuration",
        "message": "Missing API key.",
        "details": "Missing API key.",
    }


def test_llm_test_records_provider_failure(tmp_path, monkeypatch):
    db_path = _seed_settings_db(
        tmp_path,
        [
            ("llmApiKey", '"saved-key"', "2026-06-16T00:00:00Z"),
            ("llmBaseUrl", '"https://api.deepseek.com/v1"', "2026-06-16T00:00:00Z"),
            ("llmModel", '"openai/deepseek-v4-flash"', "2026-06-16T00:00:00Z"),
        ],
    )
    monkeypatch.setattr(retrieval_app, "DB_PATH", db_path)
    observed_events = []

    class ProviderError(Exception):
        status_code = 503

    def fail_completion(**_kwargs):
        raise ProviderError("service unavailable")

    monkeypatch.setattr("litellm.completion", fail_completion)
    monkeypatch.setattr(
        "services.retrieval_api.llm_test.record_llm_event",
        lambda *args, **kwargs: observed_events.append((args, kwargs)),
    )

    client = TestClient(retrieval_app.app)
    response = client.post(
        "/internal/llm/test",
        json={"apiKey": "", "baseUrl": "", "model": ""},
    )

    assert response.status_code == 200
    assert response.json()["success"] is False
    event = observed_events[0][1]
    assert event["operation"] == "health_test"
    assert event["outcome"] == "failure"
    assert event["status_code"] == 503
    assert event["retryable"] is True
