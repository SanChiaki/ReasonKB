from pathlib import Path
import sqlite3

from services.common import settings
from services.remote_corpus.smb_paths import (
    build_smb_source_root,
    build_smb_url,
    parse_smb_share_path,
    safe_cache_file_name,
)


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


def test_parse_windows_unc_smb_share_path():
    parsed = parse_smb_share_path(r"\\fileserver\Projects\Division A")
    assert parsed.host == "fileserver"
    assert parsed.share == "Projects"
    assert parsed.base_path == "Division A"


def test_parse_slash_style_smb_share_path():
    parsed = parse_smb_share_path("//fileserver/Projects/Division A/Reports")
    assert parsed.host == "fileserver"
    assert parsed.share == "Projects"
    assert parsed.base_path == "Division A/Reports"


def test_build_smb_source_root_and_url_escape_backslashes():
    assert build_smb_source_root("fileserver", "Projects", "Division A") == (
        "smb://fileserver/Projects/Division%20A"
    )
    assert build_smb_url("fileserver", "Projects", "Division A/Project/report.md") == (
        "//fileserver/Projects/Division A/Project/report.md"
    )


def test_safe_cache_file_name_preserves_extension():
    assert safe_cache_file_name("Project A/final report.v1.pdf") == "final_report.v1.pdf"
    assert safe_cache_file_name("Project/report:final?.pdf") == "report_final_.pdf"
    assert safe_cache_file_name("Project A/.hidden") == "downloaded-file"
