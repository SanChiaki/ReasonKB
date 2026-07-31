import asyncio
import json
import logging
import threading

from fastapi.testclient import TestClient
import pytest

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

    def fake_answer_question_events(
        db_path,
        query,
        project_ids=None,
        mode="answer",
        cancellation_event=None,
    ):
        del cancellation_event
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
    assert response.headers["x-accel-buffering"] == "no"
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


def test_retrieve_query_stream_emits_heartbeat_while_next_event_is_blocked(
    monkeypatch,
):
    release_worker = threading.Event()

    def fake_answer_question_events(
        db_path,
        query,
        project_ids=None,
        mode="answer",
        cancellation_event=None,
    ):
        del db_path, query, project_ids, mode, cancellation_event
        yield {"type": "progress", "stage": "retrieval_started", "data": {}}
        release_worker.wait(timeout=1)
        yield {
            "type": "result",
            "data": {
                "answer": "answer",
                "citations": [],
                "selectedDocuments": [],
                "evidence": [],
            },
        }

    monkeypatch.setattr(retrieval_app, "_STREAM_HEARTBEAT_SECONDS", 0.01)
    monkeypatch.setattr(
        retrieval_app,
        "answer_question_events",
        fake_answer_question_events,
    )

    async def read_heartbeat() -> None:
        response = retrieval_app.retrieve_query_stream(
            retrieval_app.QueryRequest(query="What changed?", mode="answer")
        )
        iterator = response.body_iterator
        assert "retrieval_started" in await anext(iterator)
        heartbeat = await asyncio.wait_for(anext(iterator), timeout=0.2)
        assert heartbeat == ": keep-alive\n\n"
        release_worker.set()
        assert '"type": "result"' in await asyncio.wait_for(
            anext(iterator),
            timeout=0.2,
        )
        await iterator.aclose()

    try:
        asyncio.run(read_heartbeat())
    finally:
        release_worker.set()


def test_retrieve_query_stream_consumes_completed_task_failure_on_cancellation(
    monkeypatch,
):
    class CompletedFailingTask:
        result_calls = 0

        def done(self):
            return True

        def result(self):
            self.result_calls += 1
            raise RuntimeError("worker failed during cancellation")

        def add_done_callback(self, _callback):
            raise AssertionError("a completed task must be consumed immediately")

    completed_task = CompletedFailingTask()

    def fake_create_task(coroutine):
        coroutine.close()
        return completed_task

    async def cancel_after_task_completion(_tasks, timeout):
        del timeout
        raise asyncio.CancelledError

    monkeypatch.setattr(retrieval_app.asyncio, "create_task", fake_create_task)
    monkeypatch.setattr(retrieval_app.asyncio, "wait", cancel_after_task_completion)

    async def cancel_stream() -> None:
        response = retrieval_app.retrieve_query_stream(
            retrieval_app.QueryRequest(query="What changed?", mode="answer")
        )
        with pytest.raises(asyncio.CancelledError):
            await anext(response.body_iterator)

    asyncio.run(cancel_stream())
    assert completed_task.result_calls == 1


def test_retrieve_query_stream_cancels_sync_generator_without_waiting(monkeypatch):
    worker_blocked = threading.Event()
    worker_finished = threading.Event()
    release_worker = threading.Event()
    captured_cancellation_event: list[threading.Event] = []

    def fake_answer_question_events(
        db_path,
        query,
        project_ids=None,
        mode="answer",
        cancellation_event=None,
    ):
        del db_path, query, project_ids, mode
        assert cancellation_event is not None
        captured_cancellation_event.append(cancellation_event)
        yield {"type": "progress", "stage": "retrieval_started", "data": {}}
        worker_blocked.set()
        release_worker.wait(timeout=2)
        worker_finished.set()
        yield {"type": "progress", "stage": "should_not_arrive", "data": {}}

    monkeypatch.setattr(
        retrieval_app,
        "answer_question_events",
        fake_answer_question_events,
    )

    async def cancel_stream() -> None:
        response = retrieval_app.retrieve_query_stream(
            retrieval_app.QueryRequest(query="What changed?", mode="answer")
        )
        iterator = response.body_iterator
        first_chunk = await anext(iterator)
        assert "retrieval_started" in first_chunk

        blocked_read = asyncio.create_task(anext(iterator))
        assert await asyncio.to_thread(worker_blocked.wait, 1)
        blocked_read.cancel()
        try:
            await blocked_read
        except asyncio.CancelledError:
            pass

        assert captured_cancellation_event[0].is_set()
        release_worker.set()
        assert await asyncio.to_thread(worker_finished.wait, 1)

    asyncio.run(cancel_stream())


def test_retrieve_query_stream_closes_generator_after_blocked_worker_unwinds(monkeypatch):
    worker_blocked = threading.Event()
    release_worker = threading.Event()
    generator_closed = threading.Event()
    retained_generators = []

    def fake_answer_question_events(
        db_path,
        query,
        project_ids=None,
        mode="answer",
        cancellation_event=None,
    ):
        del db_path, query, project_ids, mode, cancellation_event

        def generate():
            try:
                yield {"type": "progress", "stage": "retrieval_started", "data": {}}
                worker_blocked.set()
                release_worker.wait(timeout=2)
                yield {"type": "progress", "stage": "should_not_arrive", "data": {}}
            finally:
                generator_closed.set()

        generator = generate()
        retained_generators.append(generator)
        return generator

    monkeypatch.setattr(
        retrieval_app,
        "answer_question_events",
        fake_answer_question_events,
    )

    async def cancel_stream() -> None:
        response = retrieval_app.retrieve_query_stream(
            retrieval_app.QueryRequest(query="What changed?", mode="answer")
        )
        iterator = response.body_iterator
        assert "retrieval_started" in await anext(iterator)

        blocked_read = asyncio.create_task(anext(iterator))
        assert await asyncio.to_thread(worker_blocked.wait, 1)
        blocked_read.cancel()
        with pytest.raises(asyncio.CancelledError):
            await blocked_read

        release_worker.set()
        assert await asyncio.to_thread(generator_closed.wait, 1)

    try:
        asyncio.run(cancel_stream())
    finally:
        release_worker.set()


@pytest.mark.parametrize("llm_stage", ["document_selection", "answer_generation"])
def test_retrieve_query_stream_cancellation_stops_llm_retries(monkeypatch, llm_stage):
    from pageindex import utils

    provider_started = threading.Event()
    release_provider = threading.Event()
    generator_finished = threading.Event()
    provider_calls = 0

    def blocking_failure(**_kwargs):
        nonlocal provider_calls
        provider_calls += 1
        provider_started.set()
        release_provider.wait(timeout=2)
        raise TimeoutError("provider timed out")

    def fake_answer_question_events(
        db_path,
        query,
        project_ids=None,
        mode="answer",
        cancellation_event=None,
    ):
        del db_path, query, project_ids, mode, cancellation_event
        yield {"type": "progress", "stage": "retrieval_started", "data": {}}
        if llm_stage == "answer_generation":
            yield {"type": "progress", "stage": "documents_selected", "data": {}}
        utils.llm_completion(model="gpt-test", prompt="question")
        generator_finished.set()
        yield {"type": "progress", "stage": "should_not_arrive", "data": {}}

    monkeypatch.setattr("litellm.completion", blocking_failure)
    monkeypatch.setattr(
        retrieval_app,
        "answer_question_events",
        fake_answer_question_events,
    )

    async def cancel_during_llm_call() -> None:
        response = retrieval_app.retrieve_query_stream(
            retrieval_app.QueryRequest(query="What changed?", mode="answer")
        )
        iterator = response.body_iterator
        assert "retrieval_started" in await anext(iterator)
        if llm_stage == "answer_generation":
            assert "documents_selected" in await anext(iterator)

        blocked_read = asyncio.create_task(anext(iterator))
        assert await asyncio.to_thread(provider_started.wait, 1)
        blocked_read.cancel()
        try:
            await blocked_read
        except asyncio.CancelledError:
            pass
        release_provider.set()
        assert await asyncio.to_thread(generator_finished.wait, 1)

    asyncio.run(cancel_during_llm_call())
    assert provider_calls == 1


def test_retrieval_metrics_logger_uses_uvicorn_handler(monkeypatch):
    metrics_logger = logging.getLogger("services.common.retrieval_llm")
    uvicorn_logger = logging.getLogger("uvicorn.error")
    handler = logging.NullHandler()
    monkeypatch.setattr(metrics_logger, "handlers", [])
    monkeypatch.setattr(metrics_logger, "propagate", True)
    monkeypatch.setattr(uvicorn_logger, "handlers", [handler])

    retrieval_app._configure_retrieval_metrics_logging()

    assert metrics_logger.handlers == [handler]
    assert metrics_logger.propagate is False
