import json

from fastapi.testclient import TestClient

from services.retrieval_api import app as retrieval_app


def test_retrieve_query_only_serializes_document_url_when_present(monkeypatch):
    document_url = "https://oa.example.test/seeyon/doc.do?docId=doc_seeyon"

    def fake_answer_question(db_path, query, project_ids=None, mode="answer"):
        del db_path, query, project_ids, mode
        return {
            "answer": "answer",
            "citations": [
                {
                    "projectId": "proj_1",
                    "projectName": "Alpha",
                    "documentId": "doc_seeyon",
                    "documentName": "Seeyon.pdf",
                    "documentUrl": document_url,
                    "pages": "1",
                },
                {
                    "projectId": "proj_1",
                    "projectName": "Alpha",
                    "documentId": "doc_local",
                    "documentName": "Local.pdf",
                    "pages": "2",
                },
            ],
            "selectedDocuments": [
                {"documentId": "doc_seeyon"},
                {"documentId": "doc_local"},
            ],
            "evidence": [
                {
                    "projectId": "proj_1",
                    "projectName": "Alpha",
                    "documentId": "doc_seeyon",
                    "documentName": "Seeyon.pdf",
                    "documentUrl": document_url,
                    "pages": "1",
                    "evidenceKind": "pdf_text",
                    "content": "Seeyon evidence",
                },
                {
                    "projectId": "proj_1",
                    "projectName": "Alpha",
                    "documentId": "doc_local",
                    "documentName": "Local.pdf",
                    "pages": "2",
                    "evidenceKind": "pdf_text",
                    "content": "Local evidence",
                },
            ],
        }

    monkeypatch.setattr(retrieval_app, "answer_question", fake_answer_question)

    client = TestClient(retrieval_app.app)
    response = client.post(
        "/internal/retrieve/query",
        json={"query": "What changed?", "mode": "evidence"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["citations"][0]["documentUrl"] == document_url
    assert "documentUrl" not in payload["citations"][1]
    assert payload["selectedDocuments"] == [
        {"documentId": "doc_seeyon", "sourceRelativePath": None},
        {"documentId": "doc_local", "sourceRelativePath": None},
    ]
    assert payload["evidence"][0]["documentUrl"] == document_url
    assert "documentUrl" not in payload["evidence"][1]


def test_retrieve_query_stream_returns_sse_progress_and_result(monkeypatch):
    document_url = "https://oa.example.test/seeyon/doc.do?docId=doc_seeyon"

    def fake_answer_question_events(db_path, query, project_ids=None, mode="answer"):
        yield {
            "type": "progress",
            "stage": "retrieval_started",
            "data": {"query": query, "projectIds": project_ids, "mode": mode},
        }
        yield {
            "type": "progress",
            "stage": "documents_selected",
            "data": {
                "documentCount": 1,
                "documents": [
                    {
                        "documentId": "doc_seeyon",
                        "documentName": "Seeyon.pdf",
                        "documentUrl": document_url,
                    }
                ],
            },
        }
        yield {
            "type": "result",
            "data": {
                "answer": "streamed answer",
                "citations": [{"documentUrl": document_url}],
                "selectedDocuments": [],
                "evidence": [{"documentUrl": document_url}],
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
            "type": "progress",
            "stage": "documents_selected",
            "data": {
                "documentCount": 1,
                "documents": [
                    {
                        "documentId": "doc_seeyon",
                        "documentName": "Seeyon.pdf",
                        "documentUrl": document_url,
                    }
                ],
            },
        },
        {
            "type": "result",
            "data": {
                "answer": "streamed answer",
                "citations": [{"documentUrl": document_url}],
                "selectedDocuments": [],
                "evidence": [{"documentUrl": document_url}],
            },
        },
    ]
