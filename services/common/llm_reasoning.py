from __future__ import annotations

from typing import Any, Literal


ReasoningMode = Literal["disabled", "low", "default"]


def reasoning_options_for_model(
    model: str | None,
    reasoning: ReasoningMode,
) -> tuple[dict[str, Any], str]:
    if reasoning == "default":
        return {}, "provider_default"

    lowered = (model or "").lower()
    if "deepseek" in lowered:
        if reasoning == "low":
            return {
                "extra_body": {"thinking": {"type": "disabled"}}
            }, "deepseek_low_fallback_disabled"
        return {
            "extra_body": {"thinking": {"type": "disabled"}}
        }, "deepseek_disabled"

    if "qwen" in lowered:
        options: dict[str, Any] = {
            "extra_body": {"enable_thinking": reasoning == "low"}
        }
        if reasoning == "low":
            options["reasoning_effort"] = "low"
        return options, f"qwen_{reasoning}"

    if lowered.startswith("anthropic/"):
        if reasoning == "low":
            return {"reasoning_effort": "low"}, "anthropic_low"
        return {}, "anthropic_default_off"

    if reasoning == "low":
        return {"reasoning_effort": "low"}, "reasoning_effort_low"
    if any(name in lowered for name in ("gpt-5", "/o1", "/o3", "/o4")):
        return {"reasoning_effort": "none"}, "reasoning_effort_none"
    return {}, "unsupported"
