import importlib
from types import SimpleNamespace

from services.common.pageindex_runtime import configure_pageindex_runtime

configure_pageindex_runtime()

page_index = importlib.import_module("pageindex.page_index")


def test_toc_detector_treats_unparseable_llm_response_as_no_toc(monkeypatch):
    monkeypatch.setattr(page_index, "llm_completion", lambda **kwargs: "not json")

    assert page_index.toc_detector_single_page("plain page text", model="test-model") == "no"


def test_detect_page_index_retries_until_model_returns_required_key(monkeypatch):
    responses = iter(
        [
            '{"thinking": "missing required key"}',
            '{"thinking": "has page numbers", "page_index_given_in_toc": "yes"}',
        ]
    )
    calls = []

    def fake_llm_completion(**kwargs):
        calls.append(kwargs)
        return next(responses)

    monkeypatch.setattr(page_index, "llm_completion", fake_llm_completion)

    assert page_index.detect_page_index("1. Overview ........ 3", model="test-model") == "yes"
    assert len(calls) == 2


def test_detect_page_index_falls_back_to_no_after_retry_exhaustion(monkeypatch):
    calls = []

    def fake_llm_completion(**kwargs):
        calls.append(kwargs)
        return '{"thinking": "still missing required key"}'

    monkeypatch.setattr(page_index, "llm_completion", fake_llm_completion)

    assert page_index.detect_page_index("目录 without reliable page numbers", model="test-model") == "no"
    assert len(calls) == 3


def test_toc_completion_check_retries_missing_completed_key(monkeypatch):
    responses = iter(
        [
            '{"thinking": "missing required key"}',
            '{"thinking": "complete", "completed": "yes"}',
        ]
    )
    calls = []

    def fake_llm_completion(**kwargs):
        calls.append(kwargs)
        return next(responses)

    monkeypatch.setattr(page_index, "llm_completion", fake_llm_completion)

    result = page_index.check_if_toc_transformation_is_complete(
        "raw toc",
        "clean toc",
        model="test-model",
    )

    assert result == "yes"
    assert len(calls) == 2


def test_toc_transformer_accepts_unfenced_json_continuation(monkeypatch):
    initial_response = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content='{"table_of_contents": ['),
                finish_reason="length",
            )
        ]
    )
    continuation_response = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    content='{"structure":"1","title":"Overview","page":1}]}'
                ),
                finish_reason="stop",
            )
        ]
    )
    call_count = 0

    def fake_completion(**kwargs):
        nonlocal call_count
        call_count += 1
        return initial_response if call_count == 1 else continuation_response

    monkeypatch.setattr(page_index.litellm, "completion", fake_completion)
    monkeypatch.setattr(
        page_index,
        "check_if_toc_transformation_is_complete",
        lambda content, toc, model=None: "yes" if '"title":"Overview"' in toc else "no",
    )

    assert page_index.toc_transformer("Overview .... 1", model="test-model") == [
        {"structure": "1", "title": "Overview", "page": 1}
    ]


class _Logger:
    def info(self, *args, **kwargs):
        pass


def test_toc_page_offset_failure_falls_back_to_no_toc(monkeypatch):
    fallback = [{"title": "Page 1", "physical_index": 1}]
    monkeypatch.setattr(
        page_index,
        "toc_transformer",
        lambda toc_content, model=None: [
            {"structure": "1", "title": "Overview", "page": 1}
        ],
    )
    monkeypatch.setattr(page_index, "toc_index_extractor", lambda *args, **kwargs: [])
    monkeypatch.setattr(page_index, "process_no_toc", lambda *args, **kwargs: fallback)

    result = page_index.process_toc_with_page_numbers(
        "Overview .... 1",
        [0],
        [("Overview", 1)],
        toc_check_page_num=1,
        model="test-model",
        logger=_Logger(),
    )

    assert result == fallback


def test_toc_transformation_exhaustion_falls_back_to_no_toc(monkeypatch):
    fallback = [{"title": "Page 1", "physical_index": 1}]

    def fail_transformer(toc_content, model=None):
        raise Exception("Failed to complete toc transformation after maximum retries")

    monkeypatch.setattr(page_index, "toc_transformer", fail_transformer)
    monkeypatch.setattr(page_index, "process_no_toc", lambda *args, **kwargs: fallback)

    result = page_index.process_toc_with_page_numbers(
        "Overview .... 1",
        [0],
        [("Overview", 1)],
        toc_check_page_num=1,
        model="test-model",
        logger=_Logger(),
    )

    assert result == fallback


def test_toc_without_page_numbers_failure_falls_back_to_no_toc(monkeypatch):
    fallback = [{"title": "Page 3", "physical_index": 3}]

    def fail_transformer(toc_content, model=None):
        raise KeyError("table_of_contents")

    def fake_process_no_toc(page_list, start_index=1, model=None, logger=None):
        assert start_index == 3
        return fallback

    monkeypatch.setattr(page_index, "toc_transformer", fail_transformer)
    monkeypatch.setattr(page_index, "process_no_toc", fake_process_no_toc)

    result = page_index.process_toc_no_page_numbers(
        "Overview",
        [0],
        [("Overview", 1)],
        start_index=3,
        model="test-model",
        logger=_Logger(),
    )

    assert result == fallback


def test_meta_processor_falls_back_to_page_nodes_when_no_toc_verification_fails(monkeypatch):
    page_list = [("alpha", 1), ("beta", 1)]
    opt = page_index.config(model="test-model")

    class Logger:
        def info(self, *args, **kwargs):
            pass

    def fake_process_no_toc(page_list, start_index=1, model=None, logger=None):
        return [{"title": "Unverifiable", "physical_index": None}]

    async def fake_verify_toc(page_list, list_result, start_index=1, N=None, model=None):
        return 0, []

    monkeypatch.setattr(page_index, "process_no_toc", fake_process_no_toc)
    monkeypatch.setattr(page_index, "verify_toc", fake_verify_toc)

    result = page_index.asyncio.run(
        page_index.meta_processor(
            page_list,
            mode="process_no_toc",
            start_index=1,
            opt=opt,
            logger=Logger(),
        )
    )

    assert result == [
        {"title": "Page 1", "physical_index": 1},
        {"title": "Page 2", "physical_index": 2},
    ]
