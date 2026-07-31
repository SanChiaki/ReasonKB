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
