from __future__ import annotations

import base64
import mimetypes
from pathlib import Path
from time import perf_counter

import litellm

from services.common.index_metrics import current_index_metrics
from services.common.llm_environment import configure_litellm_environment
from services.common.settings import VISION_EXTRACTION_ENABLED, VISION_MODEL

configure_litellm_environment()


class VisionExtractionSkipped(RuntimeError):
    pass


def _extract_usage_value(usage, key: str) -> int | None:
    if usage is None:
        return None
    if isinstance(usage, dict):
        return usage.get(key)
    return getattr(usage, key, None)


def _record_vision_metrics(model: str, prompt: str, content: str, response, elapsed_ms: int) -> None:
    metrics = current_index_metrics()
    if metrics is None:
        return

    usage = getattr(response, "usage", None)
    prompt_tokens = _extract_usage_value(usage, "prompt_tokens")
    completion_tokens = _extract_usage_value(usage, "completion_tokens")
    token_source = "provider_usage"
    if prompt_tokens is None or completion_tokens is None:
        token_source = "estimated"
        prompt_tokens = litellm.token_counter(model=model, text=prompt)
        completion_tokens = litellm.token_counter(model=model, text=content or "")

    metrics.record_llm_call(
        model=model,
        prompt_tokens=int(prompt_tokens or 0),
        completion_tokens=int(completion_tokens or 0),
        elapsed_ms=elapsed_ms,
        token_source=token_source,
    )


def extract_image_evidence_text(image_path: str, *, project_name: str, project_relative_path: str) -> str:
    if not VISION_EXTRACTION_ENABLED or not VISION_MODEL:
        raise VisionExtractionSkipped(
            "Image indexing requires VISION_EXTRACTION_ENABLED=true and VISION_MODEL to be configured."
        )

    path = Path(image_path)
    mime_type = mimetypes.guess_type(path.name)[0] or "image/png"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    prompt = f"""
Extract searchable evidence from this project image.

Project: {project_name}
Project-relative path: {project_relative_path}

Return concise plain text with:
- caption
- visible text
- relevant tables, diagrams, screenshots, forms, or site-photo details
"""
    started_at = perf_counter()
    response = litellm.completion(
        model=VISION_MODEL.removeprefix("litellm/"),
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime_type};base64,{encoded}",
                        },
                    },
                ],
            }
        ],
        temperature=0,
    )
    content = response.choices[0].message.content or ""
    _record_vision_metrics(
        VISION_MODEL.removeprefix("litellm/"),
        prompt,
        content,
        response,
        int((perf_counter() - started_at) * 1000),
    )
    return content.strip()
