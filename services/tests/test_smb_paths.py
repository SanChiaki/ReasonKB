from pathlib import Path
import sqlite3

from services.common import settings


def test_smb_settings_defaults_to_local_source(monkeypatch):
    monkeypatch.delenv("REASONKB_CORPUS_SOURCE", raising=False)
    assert settings.corpus_source_from_env({}) == "local"


def test_smb_settings_reads_source_and_cache_root(monkeypatch, tmp_path):
    env = {
        "REASONKB_CORPUS_SOURCE": "smb",
        "REASONKB_REMOTE_CACHE_ROOT": str(tmp_path / "cache"),
    }

    assert settings.corpus_source_from_env(env) == "smb"
    assert settings.remote_cache_root_from_env(env) == tmp_path / "cache"


def test_schema_has_active_smb_document_unique_index(tmp_path):
    repo_root = Path(__file__).resolve().parents[2]
    schema_sql = (repo_root / "web" / "lib" / "db" / "schema.sql").read_text(encoding="utf-8")
    db_path = tmp_path / "app.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(schema_sql)

    indexes = conn.execute("PRAGMA index_list(documents)").fetchall()
    conn.close()

    index_names = {row[1] for row in indexes}
    assert "idx_documents_smb_source_relative_path" in index_names
