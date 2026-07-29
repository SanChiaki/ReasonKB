from __future__ import annotations

from functools import wraps
import importlib
import logging
import os
from pathlib import Path
import time
from time import perf_counter
from typing import Any, Callable

from services.common.index_metrics import current_index_metrics
from services.common.llm_environment import configure_litellm_environment
from services.common.pageindex_vendor import ensure_pageindex_vendor_path
from services.common.settings import DB_PATH
from services.common.system_settings import get_llm_runtime_settings


_CONFIGURED = False


def configure_pageindex_runtime() -> None:
    global _CONFIGURED
    ensure_pageindex_vendor_path()
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
    if not getattr(original_init, "_reasonkb_patched", False):

        @wraps(original_init)
        def patched_init(self, default_path=None):
            return original_init(self, default_path or config_path)

        patched_init._reasonkb_patched = True
        utils_module.ConfigLoader.__init__ = patched_init

    original_load = utils_module.ConfigLoader.load
    if getattr(original_load, "_reasonkb_patched", False):
        return

    @wraps(original_load)
    def patched_load(self, user_opt=None):
        db_path = os.getenv("APP_DB_PATH", str(DB_PATH))
        runtime_settings = get_llm_runtime_settings(db_path)
        merged_user_opt = _merge_runtime_llm_options(
            user_opt,
            model=runtime_settings.model,
            retrieve_model=runtime_settings.retrieve_model,
        )
        return original_load(self, merged_user_opt)

    patched_load._reasonkb_patched = True
    utils_module.ConfigLoader.load = patched_load


def _merge_runtime_llm_options(user_opt, *, model: str, retrieve_model: str):
    overrides = {}
    if user_opt is None:
        user_dict = {}
    elif isinstance(user_opt, dict):
        user_dict = dict(user_opt)
    else:
        user_dict = dict(vars(user_opt))

    if model and "model" not in user_dict:
        overrides["model"] = model
    if retrieve_model and "retrieve_model" not in user_dict:
        overrides["retrieve_model"] = retrieve_model
    return {**overrides, **user_dict}


def _patch_toc_fallback(page_index_module) -> None:
    _patch_toc_completion_checks(page_index_module)
    _patch_toc_processors(page_index_module)

    original_detect_page_index = page_index_module.detect_page_index
    if not getattr(original_detect_page_index, "_reasonkb_patched", False):

        @wraps(original_detect_page_index)
        def patched_detect_page_index(toc_content, model=None):
            max_attempts = 3
            for attempt in range(1, max_attempts + 1):
                try:
                    result = original_detect_page_index(toc_content, model=model)
                except Exception as exc:
                    logging.warning(
                        "PageIndex TOC page-number detection failed on attempt %s/%s: %s",
                        attempt,
                        max_attempts,
                        exc,
                    )
                    continue
                normalized = str(result).strip().lower()
                if normalized in {"yes", "no"}:
                    return normalized
                logging.warning(
                    "PageIndex TOC page-number detection returned invalid value on attempt %s/%s: %r",
                    attempt,
                    max_attempts,
                    result,
                )
            return "no"

        patched_detect_page_index._reasonkb_patched = True
        page_index_module.detect_page_index = patched_detect_page_index

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


def _patch_toc_completion_checks(page_index_module) -> None:
    for function_name in (
        "check_if_toc_extraction_is_complete",
        "check_if_toc_transformation_is_complete",
    ):
        original_check = getattr(page_index_module, function_name)
        if getattr(original_check, "_reasonkb_patched", False):
            continue

        @wraps(original_check)
        def patched_check(
            content,
            toc,
            model=None,
            _original=original_check,
            _name=function_name,
        ):
            max_attempts = 3
            for attempt in range(1, max_attempts + 1):
                try:
                    result = _original(content, toc, model=model)
                except (KeyError, TypeError, ValueError) as exc:
                    logging.warning(
                        "PageIndex %s returned an invalid completion status on attempt %s/%s: %s",
                        _name,
                        attempt,
                        max_attempts,
                        exc,
                    )
                    continue
                normalized = str(result).strip().lower()
                if normalized in {"yes", "no"}:
                    return normalized
                logging.warning(
                    "PageIndex %s returned an unsupported completion status on attempt %s/%s: %r",
                    _name,
                    attempt,
                    max_attempts,
                    result,
                )
            return "no"

        patched_check._reasonkb_patched = True
        setattr(page_index_module, function_name, patched_check)


def _patch_toc_processors(page_index_module) -> None:
    original_with_page_numbers = page_index_module.process_toc_with_page_numbers
    if not getattr(original_with_page_numbers, "_reasonkb_patched", False):

        @wraps(original_with_page_numbers)
        def patched_with_page_numbers(
            toc_content,
            toc_page_list,
            page_list,
            toc_check_page_num=None,
            model=None,
            logger=None,
        ):
            try:
                return original_with_page_numbers(
                    toc_content,
                    toc_page_list,
                    page_list,
                    toc_check_page_num=toc_check_page_num,
                    model=model,
                    logger=logger,
                )
            except Exception as exc:
                logging.warning(
                    "PageIndex TOC processing failed; falling back to document body: %s",
                    exc,
                )
                return page_index_module.process_no_toc(
                    page_list,
                    start_index=1,
                    model=model,
                    logger=logger,
                )

        patched_with_page_numbers._reasonkb_patched = True
        page_index_module.process_toc_with_page_numbers = patched_with_page_numbers

    original_without_page_numbers = page_index_module.process_toc_no_page_numbers
    if getattr(original_without_page_numbers, "_reasonkb_patched", False):
        return

    @wraps(original_without_page_numbers)
    def patched_without_page_numbers(
        toc_content,
        toc_page_list,
        page_list,
        start_index=1,
        model=None,
        logger=None,
    ):
        try:
            return original_without_page_numbers(
                toc_content,
                toc_page_list,
                page_list,
                start_index=start_index,
                model=model,
                logger=logger,
            )
        except Exception as exc:
            logging.warning(
                "PageIndex TOC processing failed; falling back to document body: %s",
                exc,
            )
            return page_index_module.process_no_toc(
                page_list,
                start_index=start_index,
                model=model,
                logger=logger,
            )

    patched_without_page_numbers._reasonkb_patched = True
    page_index_module.process_toc_no_page_numbers = patched_without_page_numbers


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
                configure_litellm_environment()
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
                content = _normalize_toc_continuation(prompt, content)
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


def _normalize_toc_continuation(prompt: str, content: str | None) -> str | None:
    marker = "continue the table of contents json structure"
    if marker not in prompt.lower() or not isinstance(content, str) or not content.strip():
        return content

    normalized = content.strip()
    if normalized.startswith("```json"):
        return normalized
    if normalized.startswith("```"):
        first_line_end = normalized.find("\n")
        if first_line_end >= 0:
            normalized = normalized[first_line_end + 1 :]
        if normalized.endswith("```"):
            normalized = normalized[:-3].rstrip()
    return f"```json\n{normalized}\n```"


def _wrap_async_completion(utils_module, original: Callable[..., Any]) -> Callable[..., Any]:
    del original

    async def wrapped(model, prompt):
        import asyncio

        normalized_model = model.removeprefix("litellm/") if model else model
        max_retries = 10
        messages = [{"role": "user", "content": prompt}]
        for attempt in range(max_retries):
            try:
                configure_litellm_environment()
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
