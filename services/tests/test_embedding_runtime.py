import httpx

from services.common.embedding_runtime import OpenAIEmbeddingAdapter


def test_openai_embedding_adapter_batches_and_normalizes_model_name():
    requests = []

    def handler(request: httpx.Request):
        payload = __import__("json").loads(request.content)
        requests.append(payload)
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": index, "embedding": [float(index + 1), 1.0]}
                    for index, _text in enumerate(payload["input"])
                ],
                "usage": {"prompt_tokens": len(payload["input"])},
            },
        )

    adapter = OpenAIEmbeddingAdapter(
        api_key="secret",
        base_url="https://embedding.example.test/v1",
        model="openai/text-embedding-3-small",
        batch_size=2,
        transport=httpx.MockTransport(handler),
    )

    result = adapter.embed(["one", "two", "three"])

    assert result.dimension == 2
    assert len(result.vectors) == 3
    assert result.prompt_tokens == 3
    assert [request["model"] for request in requests] == [
        "text-embedding-3-small",
        "text-embedding-3-small",
    ]
    assert [len(request["input"]) for request in requests] == [2, 1]


def test_openai_embedding_adapter_retries_transient_provider_failure():
    attempts = 0

    def handler(_request: httpx.Request):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(503, json={"error": {"message": "busy"}})
        return httpx.Response(
            200,
            json={"data": [{"index": 0, "embedding": [1.0, 0.0]}]},
        )

    adapter = OpenAIEmbeddingAdapter(
        api_key="secret",
        base_url="https://embedding.example.test/v1",
        model="text-embedding-v4",
        transport=httpx.MockTransport(handler),
        sleep_fn=lambda _seconds: None,
    )

    result = adapter.embed(["query"])

    assert attempts == 2
    assert result.vectors == ((1.0, 0.0),)
