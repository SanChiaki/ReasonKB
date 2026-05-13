import sqlite3
from pathlib import Path

from services.common.system_settings import (
    get_index_worker_concurrency,
    get_retrieval_document_limit,
)


def _schema_sql() -> str:
    repo_root = Path(__file__).resolve().parents[2]
    schema_path = repo_root / "web" / "lib" / "db" / "schema.sql"
    return schema_path.read_text(encoding="utf-8")


def _seed_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "app.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_schema_sql())
    conn.close()
    return db_path


def test_get_index_worker_concurrency_uses_default_when_setting_is_missing(tmp_path):
    db_path = _seed_db(tmp_path)

    assert get_index_worker_concurrency(str(db_path), default=3) == 3


def test_get_index_worker_concurrency_reads_saved_runtime_setting(tmp_path):
    db_path = _seed_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO system_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        """,
        ("indexWorkerConcurrency", "4", "2026-05-13T00:00:00Z"),
    )
    conn.commit()
    conn.close()

    assert get_index_worker_concurrency(str(db_path), default=1) == 4


def test_get_index_worker_concurrency_clamps_invalid_saved_value(tmp_path):
    db_path = _seed_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO system_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        """,
        ("indexWorkerConcurrency", "0", "2026-05-13T00:00:00Z"),
    )
    conn.commit()
    conn.close()

    assert get_index_worker_concurrency(str(db_path), default=2) == 1


def test_get_index_worker_concurrency_uses_default_when_table_is_missing(tmp_path):
    db_path = tmp_path / "legacy.db"
    sqlite3.connect(db_path).close()

    assert get_index_worker_concurrency(str(db_path), default=5) == 5


def test_get_retrieval_document_limit_uses_default_when_setting_is_missing(tmp_path):
    db_path = _seed_db(tmp_path)

    assert get_retrieval_document_limit(str(db_path), default=5) == 5


def test_get_retrieval_document_limit_reads_saved_runtime_setting(tmp_path):
    db_path = _seed_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO system_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        """,
        ("retrievalDocumentLimit", "12", "2026-05-13T00:00:00Z"),
    )
    conn.commit()
    conn.close()

    assert get_retrieval_document_limit(str(db_path), default=5) == 12


def test_get_retrieval_document_limit_clamps_invalid_saved_value(tmp_path):
    db_path = _seed_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO system_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        """,
        ("retrievalDocumentLimit", "99", "2026-05-13T00:00:00Z"),
    )
    conn.commit()
    conn.close()

    assert get_retrieval_document_limit(str(db_path), default=5) == 50


def test_get_retrieval_document_limit_uses_default_when_table_is_missing(tmp_path):
    db_path = tmp_path / "legacy.db"
    sqlite3.connect(db_path).close()

    assert get_retrieval_document_limit(str(db_path), default=8) == 8
