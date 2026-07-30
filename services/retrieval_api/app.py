import asyncio
import json
from threading import Event
from typing import Any, Iterator

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from services.common.pageindex_runtime import llm_request_scope
from services.common.settings import DB_PATH
from services.retrieval_api.llm_test import LlmTestInput, test_llm_configuration
from services.retrieval_api.query_engine import answer_question, answer_question_events
from services.retrieval_api.schemas import (
    LlmTestRequest,
    LlmTestResponse,
    QueryRequest,
    QueryResponse,
)

app = FastAPI()
_STREAM_END = object()


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
        try:
            while True:
                event = await asyncio.to_thread(
                    _next_stream_event,
                    events,
                    cancellation_event,
                )
                if event is _STREAM_END:
                    break
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            cancellation_event.set()
            close = getattr(events, "close", None)
            if callable(close):
                try:
                    close()
                except ValueError:
                    # A cancelled to_thread call may still be unwinding next(events).
                    pass

    return StreamingResponse(stream_events(), media_type="text/event-stream")


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
