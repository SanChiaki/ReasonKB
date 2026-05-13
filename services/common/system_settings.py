from __future__ import annotations

import json
import sqlite3

from services.common.sqlite_store import open_db


INDEX_WORKER_CONCURRENCY_KEY = "indexWorkerConcurrency"


def get_index_worker_concurrency(db_path: str, default: int) -> int:
    try:
        with open_db(db_path) as conn:
            row = conn.execute(
                "SELECT value_json FROM system_settings WHERE key = ?",
                (INDEX_WORKER_CONCURRENCY_KEY,),
            ).fetchone()
    except sqlite3.OperationalError:
        return max(1, default)
    if row is None:
        return max(1, default)
    try:
        value = int(json.loads(row["value_json"]))
    except (TypeError, ValueError, json.JSONDecodeError):
        return max(1, default)
    return min(max(value, 1), 16)
