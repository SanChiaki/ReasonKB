from types import SimpleNamespace

from services.common.llm_errors import (
    classify_llm_error,
    provider_host,
    response_metadata,
)


def test_classifies_deepseek_service_unavailable_response():
    error = type("ServiceUnavailableError", (Exception,), {"status_code": 503})()

    assert classify_llm_error(error) == "provider_unavailable"


def test_classifies_timeout_and_connection_errors():
    assert classify_llm_error(TimeoutError()) == "timeout"
    assert classify_llm_error(ConnectionError()) == "connection_error"
    assert classify_llm_error(error_type="RequestDeadlineExceeded") == "deadline_exceeded"


def test_extracts_only_safe_provider_metadata():
    response = SimpleNamespace(
        headers={
            "x-request-id": "provider-123",
            "retry-after": "2",
            "authorization": "Bearer secret",
        }
    )

    assert provider_host("https://api.deepseek.com/v1") == "api.deepseek.com"
    assert response_metadata(SimpleNamespace(response=response)) == {
        "providerRequestId": "provider-123",
        "retryAfter": "2",
    }
