import os

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
