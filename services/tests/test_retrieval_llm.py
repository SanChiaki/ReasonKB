from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Event, Thread
from time import monotonic
from types import SimpleNamespace

from services.common import retrieval_llm


def _response(content: str = "answer"):
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content=content),
                finish_reason="stop",
            )
        ],
        usage=SimpleNamespace(
            prompt_tokens=40,
            completion_tokens=9,
            completion_tokens_details=SimpleNamespace(reasoning_tokens=0),
        ),
    )


def test_retrieval_completion_disables_deepseek_thinking_and_inner_retries(
    monkeypatch,
    caplog,
):
    captured = {}
    caplog.set_level("INFO", logger=retrieval_llm.__name__)

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return _response('{"answer":["D001"]}')

    monkeypatch.setattr(retrieval_llm.litellm, "completion", fake_completion)

    result = retrieval_llm.complete(
        model="openai/deepseek-chat",
        prompt="select candidates",
        stage="candidate_document_selection",
        reasoning="disabled",
        max_output_tokens=192,
        timeout_seconds=20,
        deadline=monotonic() + 30,
        max_attempts=2,
        api_key="secret-key",
        request_id="request-123",
    )

    assert result.content == '{"answer":["D001"]}'
    assert captured["extra_body"] == {"thinking": {"type": "disabled"}}
    assert captured["max_tokens"] == 192
    assert captured["max_retries"] == 0
    assert 0 < captured["timeout"] <= 20
    log_record = next(
        record
        for record in caplog.records
        if record.message.startswith("retrieval_llm_call ")
    )
    log_payload = json.loads(log_record.message.split(" ", 1)[1])
    assert log_payload == {
        "attempt": 1,
        "completionTokens": 9,
        "elapsedMs": log_payload["elapsedMs"],
        "finishReason": "stop",
        "model": "openai/deepseek-chat",
        "promptTokens": 40,
        "reasoningControl": "deepseek_disabled",
        "reasoningTokens": 0,
        "requestId": "request-123",
        "stage": "candidate_document_selection",
        "status": "ok",
    }
    assert "select candidates" not in caplog.text
    assert "secret-key" not in caplog.text


def test_deepseek_disabled_thinking_reaches_provider_wire_payload():
    requests: list[dict] = []

    class ProviderHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            content_length = int(self.headers.get("Content-Length", "0"))
            requests.append(json.loads(self.rfile.read(content_length)))
            payload = json.dumps(
                {
                    "id": "completion_1",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "deepseek-chat",
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": '{"answer":["D001"]}',
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 5,
                        "total_tokens": 15,
                    },
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format, *_args):
            return

    provider = ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
    provider_thread = Thread(target=provider.serve_forever, daemon=True)
    provider_thread.start()
    try:
        result = retrieval_llm.complete(
            model="openai/deepseek-chat",
            prompt="select candidates",
            stage="candidate_document_selection",
            reasoning="disabled",
            max_output_tokens=192,
            timeout_seconds=5,
            deadline=monotonic() + 10,
            max_attempts=2,
            api_key="test-key",
            base_url=f"http://127.0.0.1:{provider.server_port}/v1",
        )
    finally:
        provider.shutdown()
        provider.server_close()
        provider_thread.join(timeout=2)

    assert result.content == '{"answer":["D001"]}'
    assert len(requests) == 1
    assert requests[0]["thinking"] == {"type": "disabled"}
    assert requests[0]["max_tokens"] == 192


def test_deepseek_low_reasoning_falls_back_to_disabled_on_provider_wire():
    requests: list[dict] = []

    class ProviderHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            content_length = int(self.headers.get("Content-Length", "0"))
            requests.append(json.loads(self.rfile.read(content_length)))
            payload = json.dumps(
                {
                    "id": "completion_1",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "deepseek-chat",
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": '{"sufficient":true}',
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 5,
                        "total_tokens": 15,
                    },
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format, *_args):
            return

    provider = ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
    provider_thread = Thread(target=provider.serve_forever, daemon=True)
    provider_thread.start()
    try:
        result = retrieval_llm.complete(
            model="openai/deepseek-chat",
            prompt="assess evidence",
            stage="tree_assessment_escalation",
            reasoning="low",
            max_output_tokens=1024,
            timeout_seconds=5,
            deadline=monotonic() + 10,
            max_attempts=1,
            api_key="test-key",
            base_url=f"http://127.0.0.1:{provider.server_port}/v1",
        )
    finally:
        provider.shutdown()
        provider.server_close()
        provider_thread.join(timeout=2)

    assert result.content == '{"sufficient":true}'
    assert len(requests) == 1
    assert requests[0]["thinking"] == {"type": "disabled"}
    assert "reasoning_effort" not in requests[0]
    assert requests[0]["max_tokens"] == 1024


def test_deepseek_low_reasoning_does_not_enable_unbounded_hidden_tokens(
    monkeypatch,
    caplog,
):
    captured = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return _response('{"sufficient":true}')

    monkeypatch.setattr(retrieval_llm.litellm, "completion", fake_completion)

    result = retrieval_llm.complete(
        model="openai/deepseek-chat",
        prompt="assess evidence",
        stage="tree_assessment_escalation",
        reasoning="low",
        max_output_tokens=384,
        timeout_seconds=20,
        deadline=monotonic() + 30,
    )

    assert result.content == '{"sufficient":true}'
    assert captured["extra_body"] == {"thinking": {"type": "disabled"}}
    assert "reasoning_effort" not in captured
    assert captured["max_tokens"] == 384
    assert "retrieval_llm_low_reasoning_unavailable" in caplog.text


def test_anthropic_low_reasoning_reserves_budget_and_omits_temperature(
    monkeypatch,
):
    captured = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return _response('{"sufficient":true}')

    monkeypatch.setattr(retrieval_llm.litellm, "completion", fake_completion)

    result = retrieval_llm.complete(
        model="anthropic/claude-sonnet-4-5",
        prompt="assess evidence",
        stage="tree_assessment_escalation",
        reasoning="low",
        max_output_tokens=512,
        timeout_seconds=20,
        deadline=monotonic() + 30,
        max_attempts=1,
    )

    assert result.content == '{"sufficient":true}'
    assert captured["reasoning_effort"] == "low"
    assert captured["max_tokens"] == 1536
    assert "thinking" not in captured
    assert "temperature" not in captured


def test_retrieval_completion_retries_one_transient_failure(monkeypatch):
    provider_calls = 0

    def flaky_completion(**_kwargs):
        nonlocal provider_calls
        provider_calls += 1
        if provider_calls == 1:
            raise TimeoutError("provider timed out")
        return _response()

    monkeypatch.setattr(retrieval_llm.litellm, "completion", flaky_completion)
    monkeypatch.setattr(retrieval_llm, "_wait_before_retry", lambda *_args: True)

    result = retrieval_llm.complete(
        model="gpt-test",
        prompt="question",
        stage="page_selection",
        reasoning="disabled",
        timeout_seconds=20,
        deadline=monotonic() + 30,
        max_attempts=2,
    )

    assert result.content == "answer"
    assert result.attempts == 2
    assert provider_calls == 2


def test_retrieval_completion_does_not_retry_non_transient_failure(monkeypatch):
    provider_calls = 0

    class AuthenticationError(Exception):
        status_code = 500

    def rejected_completion(**_kwargs):
        nonlocal provider_calls
        provider_calls += 1
        raise AuthenticationError("invalid credential")

    monkeypatch.setattr(retrieval_llm.litellm, "completion", rejected_completion)

    result = retrieval_llm.complete(
        model="gpt-test",
        prompt="question",
        stage="page_selection",
        reasoning="disabled",
        timeout_seconds=20,
        deadline=monotonic() + 30,
        max_attempts=2,
    )

    assert result.content is None
    assert result.error_type == "AuthenticationError"
    assert result.status_code == 500
    assert result.attempts == 1
    assert provider_calls == 1


def test_retrieval_completion_does_not_start_after_request_deadline(monkeypatch):
    provider = monkeypatch.setattr(
        retrieval_llm.litellm,
        "completion",
        lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("expired requests must not reach the provider")
        ),
    )

    result = retrieval_llm.complete(
        model="gpt-test",
        prompt="question",
        stage="page_selection",
        reasoning="disabled",
        timeout_seconds=20,
        deadline=monotonic() - 1,
    )

    assert provider is None
    assert result.content is None
    assert result.error_type == "RequestDeadlineExceeded"
    assert result.attempts == 0


def test_late_provider_response_keeps_usage_metrics_but_is_not_accepted(
    monkeypatch,
    caplog,
):
    remaining = iter((10.0, 10.0, 0.0))
    monkeypatch.setattr(
        retrieval_llm,
        "_remaining_seconds",
        lambda _deadline: next(remaining),
    )
    monkeypatch.setattr(
        retrieval_llm.litellm,
        "completion",
        lambda **_kwargs: _response("late answer"),
    )
    caplog.set_level("INFO", logger=retrieval_llm.__name__)

    result = retrieval_llm.complete(
        model="openai/deepseek-chat",
        prompt="question",
        stage="page_selection",
        reasoning="disabled",
        timeout_seconds=20,
        deadline=monotonic() + 30,
        api_key="test-key",
    )

    assert result.content is None
    assert result.error_type == "RequestDeadlineExceeded"
    log_record = next(
        record
        for record in caplog.records
        if record.message.startswith("retrieval_llm_call ")
    )
    log_payload = json.loads(log_record.message.split(" ", 1)[1])
    assert log_payload["status"] == "deadline_exceeded"
    assert log_payload["promptTokens"] == 40
    assert log_payload["completionTokens"] == 9
    assert log_payload["reasoningTokens"] == 0


def test_cancelled_provider_response_is_discarded_without_retry(monkeypatch):
    cancellation = Event()
    provider_calls = 0

    def late_completion(**_kwargs):
        nonlocal provider_calls
        provider_calls += 1
        cancellation.set()
        return _response("stale answer")

    monkeypatch.setattr(retrieval_llm.litellm, "completion", late_completion)

    result = retrieval_llm.complete(
        model="openai/deepseek-chat",
        prompt="question",
        stage="page_selection",
        reasoning="disabled",
        timeout_seconds=20,
        deadline=monotonic() + 30,
        max_attempts=2,
        cancellation_signal=cancellation,
        api_key="test-key",
    )

    assert result.content is None
    assert result.error_type == "RequestCancelled"
    assert result.attempts == 1
    assert provider_calls == 1
