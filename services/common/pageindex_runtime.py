from __future__ import annotations

from functools import wraps
import importlib
import logging
from pathlib import Path
import time
from time import perf_counter
from typing import Any, Callable

from pageindex.env import configure_litellm_environment
from services.common.index_metrics import current_index_metrics


_CONFIGURED = False


def configure_pageindex_runtime() -> None:
    global _CONFIGURED
    configure_litellm_environment()
    if _CONFIGURED:
        return

    client_module = importlib.import_module("pageindex.client")
    page_index_module = importlib.import_module("pageindex.page_index")
    page_index_md_module = importlib.import_module("pageindex.page_index_md")
    utils_module = importlib.import_module("pageindex.utils")

    _patch_llm_metrics(utils_module, page_index_module, page_index_md_module)
    _patch_config_loader(utils_module)
    _patch_pageindex_client(client_module)
    _patch_toc_fallback(page_index_module)
    _CONFIGURED = True


def _patch_pageindex_client(client_module) -> None:
    original_init = client_module.PageIndexClient.__init__
    if getattr(original_init, "_reasonkb_patched", False):
        return

    @wraps(original_init)
    def patched_init(self, api_key=None, *args, **kwargs):
        if api_key:
            import os

            os.environ["PAGEINDEX_LLM_API_KEY"] = api_key
        configure_litellm_environment()
        return original_init(self, None, *args, **kwargs)

    patched_init._reasonkb_patched = True
    client_module.PageIndexClient.__init__ = patched_init


def _patch_config_loader(utils_module) -> None:
    config_path = Path(__file__).with_name("pageindex_config.yaml")
    original_init = utils_module.ConfigLoader.__init__
    if getattr(original_init, "_reasonkb_patched", False):
        return

    @wraps(original_init)
    def patched_init(self, default_path=None):
        return original_init(self, default_path or config_path)

    patched_init._reasonkb_patched = True
    utils_module.ConfigLoader.__init__ = patched_init


def _patch_toc_fallback(page_index_module) -> None:
    original_detector = page_index_module.toc_detector_single_page
    if not getattr(original_detector, "_reasonkb_patched", False):

        @wraps(original_detector)
        def patched_toc_detector_single_page(content, model=None):
            try:
                result = original_detector(content, model=model)
            except Exception:
                return "no"
            if isinstance(result, str) and result.strip().lower() == "yes":
                return "yes"
            return "no"

        patched_toc_detector_single_page._reasonkb_patched = True
        page_index_module.toc_detector_single_page = patched_toc_detector_single_page

    if not hasattr(page_index_module, "fallback_page_toc"):

        def fallback_page_toc(page_list, start_index=1):
            return [
                {"title": f"Page {page_index}", "physical_index": page_index}
                for page_index in range(start_index, start_index + len(page_list))
            ]

        page_index_module.fallback_page_toc = fallback_page_toc

    original_meta_processor = page_index_module.meta_processor
    if getattr(original_meta_processor, "_reasonkb_patched", False):
        return

    @wraps(original_meta_processor)
    async def patched_meta_processor(*args, **kwargs):
        result = None
        try:
            result = await original_meta_processor(*args, **kwargs)
        except Exception as exc:
            if str(exc) != "Processing failed":
                raise
        page_list = args[0] if args else kwargs.get("page_list")
        start_index = kwargs.get("start_index", 1)
        if _toc_result_is_usable(result):
            return result
        if page_list is None:
            return result
        return page_index_module.fallback_page_toc(page_list, start_index=start_index)

    patched_meta_processor._reasonkb_patched = True
    page_index_module.meta_processor = patched_meta_processor


def _toc_result_is_usable(result: Any) -> bool:
    if not isinstance(result, list) or not result:
        return False
    return any(isinstance(item, dict) and item.get("physical_index") is not None for item in result)


def _patch_llm_metrics(utils_module, *consumer_modules) -> None:
    if not getattr(utils_module.llm_completion, "_reasonkb_patched", False):
        utils_module.llm_completion = _wrap_sync_completion(utils_module, utils_module.llm_completion)
    if not getattr(utils_module.llm_acompletion, "_reasonkb_patched", False):
        utils_module.llm_acompletion = _wrap_async_completion(utils_module, utils_module.llm_acompletion)
    for module in consumer_modules:
        if hasattr(module, "llm_completion"):
            module.llm_completion = utils_module.llm_completion
        if hasattr(module, "llm_acompletion"):
            module.llm_acompletion = utils_module.llm_acompletion
        if hasattr(module, "count_tokens"):
            module.count_tokens = utils_module.count_tokens


def _wrap_sync_completion(utils_module, original: Callable[..., Any]) -> Callable[..., Any]:
    del original

    def wrapped(model, prompt, chat_history=None, return_finish_reason=False):
        normalized_model = model.removeprefix("litellm/") if model else model
        max_retries = 10
        messages = (
            list(chat_history) + [{"role": "user", "content": prompt}]
            if chat_history
            else [{"role": "user", "content": prompt}]
        )
        for attempt in range(max_retries):
            try:
                started_at = perf_counter()
                response = utils_module.litellm.completion(
                    model=normalized_model,
                    messages=messages,
                    temperature=0,
                )
                content = response.choices[0].message.content
                _record_llm_metrics(
                    utils_module,
                    model=normalized_model,
                    messages=messages,
                    content=content,
                    response=response,
                    elapsed_ms=int((perf_counter() - started_at) * 1000),
                )
                if return_finish_reason:
                    finish_reason = (
                        "max_output_reached"
                        if response.choices[0].finish_reason == "length"
                        else "finished"
                    )
                    return content, finish_reason
                return content
            except Exception as exc:
                print("************* Retrying *************")
                logging.error(f"Error: {exc}")
                if attempt < max_retries - 1:
                    time.sleep(1)
                else:
                    logging.error("Max retries reached for prompt: " + prompt)
                    if return_finish_reason:
                        return "", "error"
                    return ""

    wrapped._reasonkb_patched = True
    return wrapped


def _wrap_async_completion(utils_module, original: Callable[..., Any]) -> Callable[..., Any]:
    del original

    async def wrapped(model, prompt):
        import asyncio

        normalized_model = model.removeprefix("litellm/") if model else model
        max_retries = 10
        messages = [{"role": "user", "content": prompt}]
        for attempt in range(max_retries):
            try:
                started_at = perf_counter()
                response = await utils_module.litellm.acompletion(
                    model=normalized_model,
                    messages=messages,
                    temperature=0,
                )
                content = response.choices[0].message.content
                _record_llm_metrics(
                    utils_module,
                    model=normalized_model,
                    messages=messages,
                    content=content,
                    response=response,
                    elapsed_ms=int((perf_counter() - started_at) * 1000),
                )
                return content
            except Exception as exc:
                print("************* Retrying *************")
                logging.error(f"Error: {exc}")
                if attempt < max_retries - 1:
                    await asyncio.sleep(1)
                else:
                    logging.error("Max retries reached for prompt: " + prompt)
                    return ""

    wrapped._reasonkb_patched = True
    return wrapped


def _record_llm_metrics(
    utils_module,
    *,
    model: str | None,
    messages: list[dict[str, Any]],
    content: str,
    response: Any,
    elapsed_ms: int,
) -> None:
    metrics = current_index_metrics()
    if metrics is None:
        return

    usage = getattr(response, "usage", None)
    prompt_tokens = _usage_value(usage, "prompt_tokens")
    completion_tokens = _usage_value(usage, "completion_tokens")
    token_source = "provider_usage"
    if prompt_tokens is None or completion_tokens is None:
        token_source = "estimated"
        prompt_tokens = utils_module.count_tokens(_message_text(messages), model=model)
        completion_tokens = utils_module.count_tokens(content or "", model=model)

    metrics.record_llm_call(
        model=model,
        prompt_tokens=int(prompt_tokens or 0),
        completion_tokens=int(completion_tokens or 0),
        elapsed_ms=elapsed_ms,
        token_source=token_source,
    )


def _message_text(messages: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for message in messages:
        content = message.get("content", "") if isinstance(message, dict) else ""
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    parts.append(item["text"])
    return "\n".join(parts)


def _usage_value(usage: Any, key: str) -> int | None:
    if usage is None:
        return None
    if isinstance(usage, dict):
        return usage.get(key)
    return getattr(usage, key, None)
