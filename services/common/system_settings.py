from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from services.common.sqlite_store import open_db


INDEX_WORKER_CONCURRENCY_KEY = "indexWorkerConcurrency"
RETRIEVAL_DOCUMENT_LIMIT_KEY = "retrievalDocumentLimit"
LLM_API_KEY_KEY = "llmApiKey"
LLM_BASE_URL_KEY = "llmBaseUrl"
LLM_MODEL_KEY = "llmModel"
LLM_RETRIEVAL_MODEL_KEY = "llmRetrievalModel"
EMBEDDING_API_KEY_KEY = "embeddingApiKey"
EMBEDDING_BASE_URL_KEY = "embeddingBaseUrl"
EMBEDDING_MODEL_KEY = "embeddingModel"


@dataclass(frozen=True)
class LlmRuntimeSettings:
    api_key: str
    base_url: str
    model: str
    retrieve_model: str

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.base_url and self.model)


@dataclass(frozen=True)
class EmbeddingRuntimeSettings:
    api_key: str
    base_url: str
    model: str
    api_key_inherited: bool
    base_url_inherited: bool

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.base_url and self.model)


def get_index_worker_concurrency(db_path: str, default: int) -> int:
    return _get_int_setting(
        db_path,
        INDEX_WORKER_CONCURRENCY_KEY,
        default=default,
        minimum=1,
        maximum=16,
    )


def get_retrieval_document_limit(db_path: str, default: int) -> int:
    return _get_int_setting(
        db_path,
        RETRIEVAL_DOCUMENT_LIMIT_KEY,
        default=default,
        minimum=1,
        maximum=50,
    )


def get_llm_runtime_settings(db_path: str) -> LlmRuntimeSettings:
    model = os.getenv("PAGEINDEX_LLM_MODEL", "openai/deepseek-v4-flash")
    retrieve_model = os.getenv("PAGEINDEX_LLM_RETRIEVAL_MODEL", model)
    defaults = {
        LLM_API_KEY_KEY: os.getenv("PAGEINDEX_LLM_API_KEY", ""),
        LLM_BASE_URL_KEY: os.getenv("PAGEINDEX_LLM_BASE_URL", ""),
        LLM_MODEL_KEY: model,
        LLM_RETRIEVAL_MODEL_KEY: retrieve_model,
    }
    saved = _get_string_settings(db_path, defaults.keys())
    resolved = {key: saved.get(key) or value for key, value in defaults.items()}
    resolved[LLM_RETRIEVAL_MODEL_KEY] = (
        resolved[LLM_RETRIEVAL_MODEL_KEY] or resolved[LLM_MODEL_KEY]
    )
    return LlmRuntimeSettings(
        api_key=resolved[LLM_API_KEY_KEY],
        base_url=resolved[LLM_BASE_URL_KEY],
        model=resolved[LLM_MODEL_KEY],
        retrieve_model=resolved[LLM_RETRIEVAL_MODEL_KEY],
    )


def get_embedding_runtime_settings(db_path: str) -> EmbeddingRuntimeSettings:
    llm_settings = get_llm_runtime_settings(db_path)
    explicit_defaults = {
        EMBEDDING_API_KEY_KEY: os.getenv(
            "REASONKB_EMBEDDING_API_KEY",
            os.getenv("EMBEDDING_API_KEY", ""),
        ),
        EMBEDDING_BASE_URL_KEY: os.getenv(
            "REASONKB_EMBEDDING_BASE_URL",
            os.getenv("EMBEDDING_BASE_URL", ""),
        ),
        EMBEDDING_MODEL_KEY: os.getenv(
            "REASONKB_EMBEDDING_MODEL",
            os.getenv("EMBEDDING_MODEL", ""),
        ),
    }
    saved = _get_string_settings(db_path, explicit_defaults.keys())
    explicit = {
        key: saved.get(key, default)
        for key, default in explicit_defaults.items()
    }
    api_key = explicit[EMBEDDING_API_KEY_KEY] or llm_settings.api_key
    base_url = explicit[EMBEDDING_BASE_URL_KEY] or llm_settings.base_url
    return EmbeddingRuntimeSettings(
        api_key=api_key,
        base_url=base_url,
        model=explicit[EMBEDDING_MODEL_KEY],
        api_key_inherited=not bool(explicit[EMBEDDING_API_KEY_KEY]),
        base_url_inherited=not bool(explicit[EMBEDDING_BASE_URL_KEY]),
    )


def _get_int_setting(
    db_path: str,
    key: str,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    try:
        with open_db(db_path) as conn:
            row = conn.execute(
                "SELECT value_json FROM system_settings WHERE key = ?",
                (key,),
            ).fetchone()
    except sqlite3.OperationalError:
        return min(max(default, minimum), maximum)
    if row is None:
        return min(max(default, minimum), maximum)
    try:
        value = int(json.loads(row["value_json"]))
    except (TypeError, ValueError, json.JSONDecodeError):
        return min(max(default, minimum), maximum)
    return min(max(value, minimum), maximum)


def _get_string_settings(db_path: str, keys) -> dict[str, str]:
    key_list = list(keys)
    placeholders = ",".join("?" for _ in key_list)
    try:
        if not Path(db_path).exists():
            return {}
        with open_db(db_path) as conn:
            rows = conn.execute(
                f"SELECT key, value_json FROM system_settings WHERE key IN ({placeholders})",
                key_list,
            ).fetchall()
    except sqlite3.OperationalError:
        return {}

    values: dict[str, str] = {}
    for row in rows:
        try:
            value = json.loads(row["value_json"])
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(value, str):
            values[row["key"]] = value.strip()
    return values
