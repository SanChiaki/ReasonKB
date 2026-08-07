from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from services.common.embedding_runtime import EmbeddingBatch
from services.common.semantic_index import (
    advance_semantic_backfill,
    semantic_index_status,
    semantic_search_documents,
)


def _seed_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "app.db"
    schema_path = Path(__file__).resolve().parents[2] / "web/lib/db/schema.sql"
    connection = sqlite3.connect(db_path)
    connection.executescript(schema_path.read_text(encoding="utf-8"))
    now = "2026-08-07T00:00:00Z"
    connection.execute(
        "INSERT INTO projects(id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ("proj_1", "user_demo", "Policies", now, now),
    )
    connection.execute(
        """
        INSERT INTO documents(
          id, project_id, owner_user_id, file_name, storage_path, mime_type,
          file_size, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
        """,
        (
            "doc_1",
            "proj_1",
            "user_demo",
            "钻石经销商政策.pdf",
            "/tmp/policy.pdf",
            "application/pdf",
            100,
            now,
            now,
        ),
    )
    connection.execute(
        """
        INSERT INTO document_indexes(
          id, document_id, doc_name, doc_description, structure_json,
          pages_json, index_version, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "idx_1",
            "doc_1",
            "钻石经销商政策.pdf",
            "Diamond reseller qualification and upgrade policy.",
            json.dumps(
                [
                    {
                        "node_id": "0001",
                        "title": "升级认证",
                        "summary": "银牌达到钻石标准后申请升级。",
                        "start_index": 2,
                        "end_index": 2,
                    }
                ]
            ),
            json.dumps([{"page": 2, "content": "upgrade"}]),
            "v1",
            now,
        ),
    )
    connection.executemany(
        "INSERT INTO system_settings(key, value_json, updated_at) VALUES (?, ?, ?)",
        [
            ("embeddingApiKey", '"test-key"', now),
            ("embeddingBaseUrl", '"https://embedding.example.test/v1"', now),
            ("embeddingModel", '"model-a"', now),
        ],
    )
    connection.commit()
    connection.close()
    return db_path


class FakeAdapter:
    calls = []

    def __init__(self, *, model, **_kwargs):
        self.model = model

    def embed(self, texts):
        self.calls.append((self.model, tuple(texts)))
        vectors = []
        for text in texts:
            if "connection test" in text:
                vectors.append((1.0, 0.0, 0.0))
            elif "升级" in text or "upgrade" in text.lower():
                vectors.append((0.0, 1.0, 0.0))
            else:
                vectors.append((0.0, 0.0, 1.0))
        return EmbeddingBatch(tuple(vectors), 3, len(texts), 1)


def test_semantic_generation_backfills_then_activates_atomically(tmp_path):
    FakeAdapter.calls = []
    db_path = _seed_db(tmp_path)

    first = advance_semantic_backfill(str(db_path), adapter_factory=FakeAdapter)
    second = advance_semantic_backfill(str(db_path), adapter_factory=FakeAdapter)

    assert first.status == "backfilling"
    assert first.indexed_documents == 1
    assert second.status == "ready"
    assert second.coverage == 1.0
    connection = sqlite3.connect(db_path)
    generation = connection.execute(
        "SELECT status, is_active, dimension FROM semantic_index_generations"
    ).fetchone()
    profile_kinds = connection.execute(
        "SELECT profile_kind, COUNT(*) FROM semantic_embeddings GROUP BY profile_kind ORDER BY profile_kind"
    ).fetchall()
    connection.close()
    assert generation == ("ready", 1, 3)
    assert profile_kinds == [("document", 1), ("node", 1)]

    search = semantic_search_documents(
        str(db_path),
        "如何升级？",
        ["doc_1"],
        adapter_factory=FakeAdapter,
    )
    assert search.status == "ready"
    assert search.document_scores[0][0] == "doc_1"
    assert search.seed_node_ids == {"doc_1": ("0001",)}


def test_semantic_search_does_not_create_a_missing_database(tmp_path):
    db_path = tmp_path / "missing.db"

    search = semantic_search_documents(str(db_path), "upgrade", ["doc_1"])

    assert search.status == "unavailable"
    assert not db_path.exists()


def test_incomplete_authorized_scope_falls_back_before_query_embedding(tmp_path):
    FakeAdapter.calls = []
    db_path = _seed_db(tmp_path)
    advance_semantic_backfill(str(db_path), adapter_factory=FakeAdapter)
    advance_semantic_backfill(str(db_path), adapter_factory=FakeAdapter)
    calls_after_activation = len(FakeAdapter.calls)
    now = "2026-08-08T00:00:00Z"
    connection = sqlite3.connect(db_path)
    connection.execute(
        """
        INSERT INTO documents(
          id, project_id, owner_user_id, file_name, storage_path, mime_type,
          file_size, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
        """,
        (
            "doc_2",
            "proj_1",
            "user_demo",
            "新增跨语言政策.pdf",
            "/tmp/new-policy.pdf",
            "application/pdf",
            100,
            now,
            now,
        ),
    )
    connection.execute(
        """
        INSERT INTO document_indexes(
          id, document_id, doc_name, doc_description, structure_json,
          pages_json, index_version, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "idx_2",
            "doc_2",
            "新增跨语言政策.pdf",
            "New cross-language policy.",
            "[]",
            "[]",
            "v1",
            now,
        ),
    )
    connection.commit()
    connection.close()

    search = semantic_search_documents(
        str(db_path),
        "new policy",
        ["doc_1", "doc_2"],
        adapter_factory=FakeAdapter,
    )

    assert search.status == "incomplete"
    assert search.document_scores == ()
    assert len(FakeAdapter.calls) == calls_after_activation


def test_retired_generation_is_not_reported_as_current_status(tmp_path):
    db_path = _seed_db(tmp_path)
    connection = sqlite3.connect(db_path)
    connection.execute(
        """
        INSERT INTO semantic_index_generations(
          id, model, base_url, profile_version, status, is_active,
          indexed_document_count, total_document_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'retired', 0, 1, 1, ?, ?)
        """,
        (
            "semgen_retired",
            "model-a",
            "https://embedding.example.test/v1",
            "document-node-v1",
            "2026-08-08T00:00:00Z",
            "2026-08-08T00:00:00Z",
        ),
    )
    connection.commit()
    connection.close()

    status = semantic_index_status(str(db_path))

    assert status.status == "validating"
    assert status.active_model is None


def test_changed_model_builds_in_shadow_before_switching(tmp_path):
    db_path = _seed_db(tmp_path)
    advance_semantic_backfill(str(db_path), adapter_factory=FakeAdapter)
    advance_semantic_backfill(str(db_path), adapter_factory=FakeAdapter)
    connection = sqlite3.connect(db_path)
    connection.execute(
        "UPDATE system_settings SET value_json = '\"model-b\"' WHERE key = 'embeddingModel'"
    )
    connection.commit()
    connection.close()

    building = advance_semantic_backfill(str(db_path), adapter_factory=FakeAdapter)

    assert building.status == "backfilling"
    assert building.active_model == "model-a"
    connection = sqlite3.connect(db_path)
    active_model = connection.execute(
        "SELECT model FROM semantic_index_generations WHERE is_active = 1"
    ).fetchone()[0]
    connection.close()
    assert active_model == "model-a"

    ready = advance_semantic_backfill(str(db_path), adapter_factory=FakeAdapter)
    assert ready.status == "ready"
    assert semantic_index_status(str(db_path)).active_model == "model-b"


def test_ready_generation_is_read_only_when_no_documents_are_missing(tmp_path):
    db_path = _seed_db(tmp_path)
    advance_semantic_backfill(str(db_path), adapter_factory=FakeAdapter)
    advance_semantic_backfill(str(db_path), adapter_factory=FakeAdapter)
    connection = sqlite3.connect(db_path)
    before = connection.execute(
        "SELECT updated_at, activated_at FROM semantic_index_generations"
    ).fetchone()
    connection.close()

    status = advance_semantic_backfill(str(db_path), adapter_factory=FakeAdapter)

    connection = sqlite3.connect(db_path)
    after = connection.execute(
        "SELECT updated_at, activated_at FROM semantic_index_generations"
    ).fetchone()
    connection.close()
    assert status.status == "ready"
    assert after == before


def test_concurrent_backfill_uses_one_generation_and_one_provider_batch(tmp_path):
    FakeAdapter.calls = []
    db_path = _seed_db(tmp_path)

    with ThreadPoolExecutor(max_workers=2) as executor:
        statuses = list(
            executor.map(
                lambda _index: advance_semantic_backfill(
                    str(db_path), adapter_factory=FakeAdapter
                ),
                range(2),
            )
        )

    connection = sqlite3.connect(db_path)
    generation_count = connection.execute(
        "SELECT COUNT(*) FROM semantic_index_generations"
    ).fetchone()[0]
    document_profile_count = connection.execute(
        "SELECT COUNT(*) FROM semantic_embeddings WHERE profile_kind = 'document'"
    ).fetchone()[0]
    connection.close()
    assert generation_count == 1
    assert document_profile_count == 1
    assert len(FakeAdapter.calls) == 2
    assert {status.status for status in statuses} <= {
        "validating",
        "backfilling",
        "ready",
    }
