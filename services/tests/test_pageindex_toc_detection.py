import importlib

from services.common.pageindex_runtime import configure_pageindex_runtime

configure_pageindex_runtime()

page_index = importlib.import_module("pageindex.page_index")


def test_toc_detector_treats_unparseable_llm_response_as_no_toc(monkeypatch):
    monkeypatch.setattr(page_index, "llm_completion", lambda **kwargs: "not json")

    assert page_index.toc_detector_single_page("plain page text", model="test-model") == "no"


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
