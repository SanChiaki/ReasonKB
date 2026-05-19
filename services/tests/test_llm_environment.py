import os
import sqlite3

from services.common.llm_environment import configure_litellm_environment


def test_configure_litellm_environment_maps_pageindex_names(monkeypatch):
    monkeypatch.setenv("PAGEINDEX_LLM_API_KEY", "test-key")
    monkeypatch.setenv("PAGEINDEX_LLM_BASE_URL", "https://llm.example.test/v1")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)

    configure_litellm_environment()

    assert os.environ["OPENAI_API_KEY"] == "test-key"
    assert os.environ["OPENAI_BASE_URL"] == "https://llm.example.test/v1"
    assert os.environ["OPENAI_API_BASE"] == "https://llm.example.test/v1"


def test_configure_litellm_environment_prefers_runtime_settings(monkeypatch, tmp_path):
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
    monkeypatch.setenv("PAGEINDEX_LLM_API_KEY", "env-key")
    monkeypatch.setenv("PAGEINDEX_LLM_BASE_URL", "https://env.example.test/v1")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)

    configure_litellm_environment()

    assert os.environ["OPENAI_API_KEY"] == "runtime-key"
    assert os.environ["OPENAI_BASE_URL"] == "https://runtime.example.test/v1"
    assert os.environ["OPENAI_API_BASE"] == "https://runtime.example.test/v1"
