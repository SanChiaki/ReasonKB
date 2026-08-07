from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from services.common.embedding_runtime import EmbeddingBatch
from services.retrieval_api.app import app


class FakeAdapter:
    closed = False

    def __init__(self, **_kwargs):
        type(self).closed = False

    def embed(self, texts):
        assert texts == ["ReasonKB embedding connection test"]
        return EmbeddingBatch(((1.0, 0.0, 0.0),), 3, 4, 12)

    def close(self):
        type(self).closed = True


def test_embedding_connection_endpoint(monkeypatch):
    monkeypatch.setattr(
        "services.retrieval_api.embedding_test.get_embedding_runtime_settings",
        lambda _db_path: type(
            "Settings",
            (),
            {
                "api_key": "saved-key",
                "base_url": "https://embedding.example.test/v1",
                "model": "saved-model",
            },
        )(),
    )
    with patch(
        "services.retrieval_api.embedding_test.OpenAIEmbeddingAdapter",
        FakeAdapter,
    ):
        response = TestClient(app).post(
            "/internal/embedding/test",
            json={"model": "candidate-model"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "model": "candidate-model",
        "dimension": 3,
        "promptTokens": 4,
        "elapsedMs": 12,
        "errorType": None,
        "message": "Embedding model test succeeded.",
        "details": "",
    }
    assert FakeAdapter.closed is True
