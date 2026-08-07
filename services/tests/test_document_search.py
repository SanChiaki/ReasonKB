import sqlite3
from pathlib import Path

from services.common.document_search import rank_documents_by_bm25, replace_document_search_index


def test_persistent_bm25f_prefers_metadata_and_respects_loaded_scope(tmp_path):
    db_path = tmp_path / "app.db"
    connection = sqlite3.connect(db_path)
    schema_path = (
        Path(__file__).resolve().parents[2]
        / "web"
        / "lib"
        / "db"
        / "schema.sql"
    )
    connection.executescript(schema_path.read_text(encoding="utf-8"))
    replace_document_search_index(
        connection,
        document_id="doc_metadata",
        file_name="revenue-policy.pdf",
        project_name="Finance",
        project_relative_path="revenue-policy.pdf",
        source_relative_path="Finance/revenue-policy.pdf",
        description="Policy thresholds.",
        structure=[],
    )
    replace_document_search_index(
        connection,
        document_id="doc_structure",
        file_name="appendix.pdf",
        project_name="Finance",
        project_relative_path="appendix.pdf",
        source_relative_path="Finance/appendix.pdf",
        description="Policy thresholds.",
        structure=[{"title": "Revenue"}],
    )
    replace_document_search_index(
        connection,
        document_id="doc_outside_scope",
        file_name="revenue-master.pdf",
        project_name="Other",
        project_relative_path="revenue-master.pdf",
        source_relative_path="Other/revenue-master.pdf",
        description="Revenue revenue revenue.",
        structure=[],
    )
    connection.commit()
    connection.close()

    documents = [
        {
            "id": "doc_structure",
            "file_name": "appendix.pdf",
            "_db_path": str(db_path),
        },
        {
            "id": "doc_metadata",
            "file_name": "revenue-policy.pdf",
            "_db_path": str(db_path),
        },
    ]

    ranked = rank_documents_by_bm25("revenue", documents)

    assert [item.document["id"] for item in ranked] == [
        "doc_metadata",
        "doc_structure",
    ]
    assert all(item.matched for item in ranked)
    assert "doc_outside_scope" not in {
        item.document["id"] for item in ranked
    }
