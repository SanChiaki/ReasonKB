import sqlite3
from time import monotonic
from types import SimpleNamespace

from services.common.llm_observability import record_llm_event
from services.common.index_metrics import index_run_metrics
from services.common.pageindex_runtime import configure_pageindex_runtime
from services.common import retrieval_llm

configure_pageindex_runtime()
from pageindex import utils


CREATE_EVENTS = """
CREATE TABLE llm_provider_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  request_id TEXT,
  operation TEXT NOT NULL,
  stage TEXT NOT NULL,
  model TEXT,
  provider_host TEXT,
  outcome TEXT NOT NULL,
  error_class TEXT,
  status_code INTEGER,
  exception_type TEXT,
  elapsed_ms INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  retryable INTEGER NOT NULL,
  provider_request_id TEXT,
  retry_after TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  reasoning_tokens INTEGER
)
"""


def _db(path):
    conn = sqlite3.connect(path)
    conn.execute(CREATE_EVENTS)
    conn.commit()
    conn.close()


def test_records_success_usage_without_prompt_or_response(tmp_path):
    db_path = str(tmp_path / "events.db")
    _db(db_path)
    response = SimpleNamespace(
        usage=SimpleNamespace(
            prompt_tokens=12,
            completion_tokens=8,
            completion_tokens_details=SimpleNamespace(reasoning_tokens=3),
        )
    )

    record_llm_event(
        db_path,
        operation="retrieval",
        stage="candidate_document_selection",
        model="openai/deepseek-v4-flash",
        base_url="https://api.deepseek.com/v1",
        request_id="request-1",
        outcome="success",
        elapsed_ms=2450,
        response=response,
    )

    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT request_id, operation, provider_host, outcome, prompt_tokens, completion_tokens, reasoning_tokens FROM llm_provider_events"
    ).fetchone()
    columns = [row[0], row[1], row[2], row[3], row[4], row[5], row[6]]
    assert columns == [
        "request-1",
        "retrieval",
        "api.deepseek.com",
        "success",
        12,
        8,
        3,
    ]
    conn.close()


def test_records_safe_failure_metadata_and_classification(tmp_path):
    db_path = str(tmp_path / "events.db")
    _db(db_path)
    response = SimpleNamespace(
        headers={"x-request-id": "deepseek-request-1", "authorization": "secret"}
    )
    error = RuntimeError("provider body must not be persisted")
    error.status_code = 503
    error.response = response

    record_llm_event(
        db_path,
        operation="index",
        stage="pageindex",
        model="openai/deepseek-v4-flash",
        base_url="https://api.deepseek.com/v1",
        request_id="run-1",
        outcome="failure",
        elapsed_ms=300000,
        attempt=2,
        retryable=True,
        exception=error,
    )

    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT error_class, status_code, exception_type, attempt, retryable, provider_request_id, retry_after FROM llm_provider_events"
    ).fetchone()
    assert row == ("provider_unavailable", 503, "RuntimeError", 2, 1, "deepseek-request-1", None)
    conn.close()


def test_retrieval_completion_records_provider_failure(tmp_path, monkeypatch):
    db_path = str(tmp_path / "events.db")
    _db(db_path)

    class ProviderError(Exception):
        status_code = 503

    monkeypatch.setattr(
        retrieval_llm.litellm,
        "completion",
        lambda **_kwargs: (_ for _ in ()).throw(ProviderError("temporary outage")),
    )

    result = retrieval_llm.complete(
        model="openai/deepseek-v4-flash",
        prompt="select candidates",
        stage="candidate_document_selection",
        reasoning="disabled",
        timeout_seconds=1,
        deadline=monotonic() + 2,
        max_attempts=1,
        api_key="test-key",
        base_url="https://api.deepseek.com/v1",
        request_id="request-failure",
        db_path=db_path,
    )

    assert result.content is None
    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT operation, outcome, error_class, status_code, request_id FROM llm_provider_events"
    ).fetchone()
    assert row == ("retrieval", "failure", "provider_unavailable", 503, "request-failure")
    conn.close()


def test_pageindex_completion_records_index_success(tmp_path, monkeypatch):
    db_path = str(tmp_path / "events.db")
    _db(db_path)
    monkeypatch.setattr(
        "litellm.completion",
        lambda **_kwargs: SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="{}"),
                    finish_reason="stop",
                )
            ],
            usage=SimpleNamespace(prompt_tokens=5, completion_tokens=2),
        ),
    )

    with index_run_metrics(
        db_path=db_path,
        request_id="run-index",
        provider_base_url="https://api.deepseek.com/v1",
    ):
        assert utils.llm_completion(model="openai/deepseek-v4-flash", prompt="index") == "{}"

    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT operation, outcome, model, request_id, provider_host, prompt_tokens, completion_tokens FROM llm_provider_events"
    ).fetchone()
    assert row == (
        "index",
        "success",
        "openai/deepseek-v4-flash",
        "run-index",
        "api.deepseek.com",
        5,
        2,
    )
    conn.close()


def test_empty_retrieval_response_is_recorded_as_provider_failure(tmp_path, monkeypatch):
    db_path = str(tmp_path / "events.db")
    _db(db_path)
    monkeypatch.setattr(
        retrieval_llm.litellm,
        "completion",
        lambda **_kwargs: SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content=" "),
                    finish_reason="stop",
                )
            ],
            usage=SimpleNamespace(prompt_tokens=4, completion_tokens=0),
        ),
    )

    result = retrieval_llm.complete(
        model="openai/deepseek-v4-flash",
        prompt="select candidates",
        stage="candidate_document_selection",
        reasoning="disabled",
        timeout_seconds=1,
        deadline=monotonic() + 2,
        max_attempts=1,
        api_key="test-key",
        base_url="https://api.deepseek.com/v1",
        request_id="request-empty",
        db_path=db_path,
    )

    assert result.error_type == "EmptyProviderResponse"
    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT outcome, error_class, request_id FROM llm_provider_events"
    ).fetchone()
    assert row == ("failure", "provider_error", "request-empty")
    conn.close()


def test_observability_metadata_failure_never_escapes(tmp_path, caplog):
    db_path = str(tmp_path / "events.db")
    _db(db_path)

    class BrokenHeaders:
        def items(self):
            raise RuntimeError("malformed headers")

    error = RuntimeError("provider error")
    error.response = SimpleNamespace(headers=BrokenHeaders())

    record_llm_event(
        db_path,
        operation="retrieval",
        stage="page_selection",
        model="model-a",
        base_url="https://api.deepseek.com/v1",
        request_id="request-broken-metadata",
        outcome="failure",
        elapsed_ms=1,
        exception=error,
    )

    assert "Unable to persist LLM observability event" in caplog.text
