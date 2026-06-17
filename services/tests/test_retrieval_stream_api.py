import json

from fastapi.testclient import TestClient

from services.retrieval_api import app as retrieval_app


def test_retrieve_query_stream_returns_sse_progress_and_result(monkeypatch):
    def fake_answer_question_events(db_path, query, project_ids=None, mode="answer"):
        yield {
            "type": "progress",
            "stage": "retrieval_started",
            "data": {"query": query, "projectIds": project_ids, "mode": mode},
        }
        yield {
            "type": "result",
            "data": {
                "answer": "streamed answer",
                "citations": [],
                "selectedDocuments": [],
                "evidence": [],
            },
        }

    monkeypatch.setattr(
        retrieval_app,
        "answer_question_events",
        fake_answer_question_events,
    )

    client = TestClient(retrieval_app.app)
    response = client.post(
        "/internal/retrieve/query/stream",
        json={"query": "What changed?", "projectIds": ["proj_1"], "mode": "answer"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    chunks = [
        json.loads(chunk.removeprefix("data: "))
        for chunk in response.text.strip().split("\n\n")
    ]
    assert chunks == [
        {
            "type": "progress",
            "stage": "retrieval_started",
            "data": {
                "query": "What changed?",
                "projectIds": ["proj_1"],
                "mode": "answer",
            },
        },
        {
            "type": "result",
            "data": {
                "answer": "streamed answer",
                "citations": [],
                "selectedDocuments": [],
                "evidence": [],
            },
        },
    ]
