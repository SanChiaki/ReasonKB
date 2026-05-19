from __future__ import annotations

import os

from services.common.settings import DB_PATH
from services.common.system_settings import get_llm_runtime_settings


def configure_litellm_environment() -> None:
    db_path = os.getenv("APP_DB_PATH", str(DB_PATH))
    runtime_settings = get_llm_runtime_settings(db_path)
    api_key = runtime_settings.api_key
    base_url = runtime_settings.base_url

    if api_key:
        os.environ["OPENAI_API_KEY"] = api_key
    if base_url:
        os.environ["OPENAI_BASE_URL"] = base_url
        os.environ["OPENAI_API_BASE"] = base_url
