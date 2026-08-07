import asyncio
import json
import logging
from threading import Event
from typing import Any, Iterator

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from services.common.pageindex_runtime import llm_request_scope
from services.common.settings import DB_PATH
from services.retrieval_api.embedding_test import (
    EmbeddingTestInput,
    test_embedding_configuration,
)
from services.retrieval_api.llm_test import LlmTestInput, test_llm_configuration
from services.retrieval_api.query_engine import answer_question, answer_question_events
from services.retrieval_api.schemas import (
    EmbeddingTestRequest,
    EmbeddingTestResponse,
    LlmTestRequest,
    LlmTestResponse,
    QueryRequest,
    QueryResponse,
)

app = FastAPI()
_STREAM_END = object()
_STREAM_HEARTBEAT_SECONDS = 15.0


def _configure_retrieval_metrics_logging() -> None:
    metrics_logger = logging.getLogger("services.common.retrieval_llm")
    handlers = (
        logging.getLogger("uvicorn.error").handlers
        or logging.getLogger("uvicorn").handlers
    )
    if handlers:
        metrics_logger.handlers = list(handlers)
        metrics_logger.propagate = False


_configure_retrieval_metrics_logging()


def _next_stream_event(
    events: Iterator[dict[str, Any]],
    cancellation_event: Event,
) -> dict[str, Any] | object:
    with llm_request_scope(cancellation_event):
        try:
            return next(events)
        except StopIteration:
            return _STREAM_END


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/internal/retrieve/query")
def retrieve_query(request: QueryRequest) -> QueryResponse:
    result = answer_question(str(DB_PATH), request.query, request.projectIds, mode=request.mode)
    return QueryResponse.model_validate(result)


@app.post("/internal/retrieve/query/stream")
def retrieve_query_stream(request: QueryRequest) -> StreamingResponse:
    cancellation_event = Event()
    events = iter(
        answer_question_events(
            str(DB_PATH),
            request.query,
            request.projectIds,
            mode=request.mode,
            cancellation_event=cancellation_event,
        )
    )

    async def stream_events():
        next_task: asyncio.Task | None = None

        def close_events() -> None:
            close = getattr(events, "close", None)
            if callable(close):
                close()

        def consume_task_result(task: asyncio.Task) -> None:
            try:
                task.result()
            except BaseException:
                # The request may be cancelled while the worker is unwinding.
                pass

        def consume_task_result_and_close(task: asyncio.Task) -> None:
            consume_task_result(task)
            close_events()

        try:
            while True:
                next_task = asyncio.create_task(
                    asyncio.to_thread(
                        _next_stream_event,
                        events,
                        cancellation_event,
                    )
                )
                while True:
                    done, _pending = await asyncio.wait(
                        {next_task},
                        timeout=_STREAM_HEARTBEAT_SECONDS,
                    )
                    if done:
                        event = next_task.result()
                        next_task = None
                        break
                    yield ": keep-alive\n\n"
                if event is _STREAM_END:
                    break
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            cancellation_event.set()
            if next_task is not None:
                if next_task.done():
                    consume_task_result(next_task)
                    close_events()
                else:
                    next_task.add_done_callback(consume_task_result_and_close)
            else:
                close_events()

    return StreamingResponse(
        stream_events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/internal/llm/test")
def test_llm(request: LlmTestRequest) -> LlmTestResponse:
    result = test_llm_configuration(
        str(DB_PATH),
        LlmTestInput(
            api_key=request.apiKey,
            base_url=request.baseUrl,
            model=request.model,
        ),
    )
    return LlmTestResponse.model_validate(result)


@app.post("/internal/embedding/test")
def test_embedding(request: EmbeddingTestRequest) -> EmbeddingTestResponse:
    result = test_embedding_configuration(
        str(DB_PATH),
        EmbeddingTestInput(
            api_key=request.apiKey,
            base_url=request.baseUrl,
            model=request.model,
        ),
    )
    return EmbeddingTestResponse.model_validate(result)
