from __future__ import annotations

import os


def configure_litellm_environment() -> None:
    api_key = os.getenv("PAGEINDEX_LLM_API_KEY")
    base_url = os.getenv("PAGEINDEX_LLM_BASE_URL")

    if api_key:
        os.environ["OPENAI_API_KEY"] = api_key
    if base_url:
        os.environ["OPENAI_BASE_URL"] = base_url
        os.environ["OPENAI_API_BASE"] = base_url

