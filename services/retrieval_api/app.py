import json

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

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


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/internal/retrieve/query")
def retrieve_query(request: QueryRequest) -> QueryResponse:
    result = answer_question(str(DB_PATH), request.query, request.projectIds, mode=request.mode)
    return QueryResponse.model_validate(result)


@app.post("/internal/retrieve/query/stream")
def retrieve_query_stream(request: QueryRequest) -> StreamingResponse:
    def stream_events():
        for event in answer_question_events(
            str(DB_PATH),
            request.query,
            request.projectIds,
            mode=request.mode,
        ):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

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
