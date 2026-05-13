from __future__ import annotations

import json
import sqlite3

from services.common.sqlite_store import open_db


INDEX_WORKER_CONCURRENCY_KEY = "indexWorkerConcurrency"
RETRIEVAL_DOCUMENT_LIMIT_KEY = "retrievalDocumentLimit"


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
