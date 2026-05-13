import json
import sqlite3
import threading
import time
from pathlib import Path
from types import SimpleNamespace

from services.retrieval_api import query_engine
from services.retrieval_api.query_engine import answer_question, build_citation
from services.retrieval_api.schemas import QueryRequest


def test_build_citation_includes_project_and_pages():
    citation = build_citation(
        project={"id": "proj_1", "name": "Alpha"},
        document={"id": "doc_1", "file_name": "alpha.pdf"},
        pages="4-5",
        focus_page=5,
        excerpt="Revenue increased after the migration completed.",
    )

    assert citation == {
        "projectId": "proj_1",
        "projectName": "Alpha",
        "documentId": "doc_1",
        "documentName": "alpha.pdf",
        "pages": "4-5",
        "focusPage": 5,
        "excerpt": "Revenue increased after the migration completed.",
    }


def _schema_sql() -> str:
    repo_root = Path(__file__).resolve().parents[2]
    schema_path = repo_root / "web" / "lib" / "db" / "schema.sql"
    return schema_path.read_text(encoding="utf-8")


def _seed_retrieval_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "app.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_schema_sql())
    conn.execute(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ("proj_1", "user_demo", "Alpha", "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z"),
    )
    conn.execute(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ("proj_2", "user_demo", "Beta", "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z"),
    )
    conn.commit()
    conn.close()
    return db_path


def _insert_ready_document(
    db_path: Path,
    document_id: str,
    file_name: str,
    doc_description: str,
    structure_json: str,
    pages_json: str,
    source_relative_path: str | None = None,
    project_relative_path: str | None = None,
    project_id: str = "proj_1",
    evidence_kind: str = "pdf_text",
    visual_assets_json: str = "[]",
):
    conn = sqlite3.connect(db_path)
    conn.execute(
        """INSERT INTO documents
           (id, project_id, owner_user_id, file_name, storage_path, mime_type,
            file_size, status, source_kind, source_relative_path,
            project_relative_path, media_type, import_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            document_id,
            project_id,
            "user_demo",
            file_name,
            f"/tmp/{file_name}",
            "application/pdf",
            128,
            "ready",
            "directory" if source_relative_path else "upload",
            source_relative_path,
            project_relative_path,
            "pdf",
            "imported",
            "2026-04-19T00:00:00Z",
            "2026-04-19T00:00:00Z",
        ),
    )
    conn.execute(
        """
        INSERT INTO document_indexes (
          id, document_id, doc_name, doc_description, structure_json,
          pages_json, evidence_kind, visual_assets_json, source_metadata_json,
          index_version, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            f"idx_{document_id}",
            document_id,
            file_name,
            doc_description,
            structure_json,
            pages_json,
            evidence_kind,
            visual_assets_json,
            json.dumps({"sourceRelativePath": source_relative_path}),
            "v1",
            "2026-04-19T00:00:00Z",
        ),
    )
    conn.commit()
    conn.close()


def test_query_request_allows_omitting_project_ids():
    request = QueryRequest(query="生成终验交付报告", mode="evidence")

    assert request.projectIds == []


def test_answer_question_searches_all_projects_when_project_ids_are_empty(
    tmp_path, monkeypatch
):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_alpha",
        file_name="alpha-handover.md",
        doc_description="final acceptance handover report",
        structure_json=json.dumps([{"title": "alpha handover"}]),
        pages_json=json.dumps([{"page": 1, "content": "alpha handover evidence"}]),
        project_id="proj_1",
        source_relative_path="Alpha/delivery/alpha-handover.md",
        project_relative_path="delivery/alpha-handover.md",
        evidence_kind="markdown_text",
    )
    _insert_ready_document(
        db_path,
        document_id="doc_beta",
        file_name="beta-handover.md",
        doc_description="final acceptance handover report",
        structure_json=json.dumps([{"title": "beta handover"}]),
        pages_json=json.dumps([{"page": 1, "content": "beta handover evidence"}]),
        project_id="proj_2",
        source_relative_path="Beta/delivery/beta-handover.md",
        project_relative_path="delivery/beta-handover.md",
        evidence_kind="markdown_text",
    )

    captured_docs: list[dict] = []

    def fake_select_candidate_documents(query, docs, limit=5, model=None):
        captured_docs.extend(docs)
        return docs

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        fake_select_candidate_documents,
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc: "1",
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._load_page_excerpt",
        lambda document, _pages: [
            {"page": 1, "content": f"{document['project_name']} handover evidence"}
        ],
    )

    result = answer_question(str(db_path), "final acceptance handover", [], mode="evidence")

    assert {doc["project_id"] for doc in captured_docs} == {"proj_1", "proj_2"}
    assert [item["projectName"] for item in result["evidence"]] == ["Alpha", "Beta"]
    assert result["selectedDocuments"] == [
        {"documentId": "doc_alpha", "sourceRelativePath": "Alpha/delivery/alpha-handover.md"},
        {"documentId": "doc_beta", "sourceRelativePath": "Beta/delivery/beta-handover.md"},
    ]


def test_answer_question_uses_configured_retrieval_document_limit(tmp_path, monkeypatch):
    db_path = _seed_retrieval_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO system_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        """,
        ("retrievalDocumentLimit", "3", "2026-05-13T00:00:00Z"),
    )
    conn.commit()
    conn.close()
    for index in range(4):
        _insert_ready_document(
            db_path,
            document_id=f"doc_{index}",
            file_name=f"doc-{index}.pdf",
            doc_description="handover evidence",
            structure_json=json.dumps([{"title": f"Doc {index}"}]),
            pages_json=json.dumps([{"page": 1, "content": f"evidence {index}"}]),
        )

    captured_limits: list[int] = []

    def fake_select_candidate_documents(query, docs, limit=5, model=None):
        captured_limits.append(limit)
        return docs[:1]

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        fake_select_candidate_documents,
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc: "1",
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._load_page_excerpt",
        lambda document, _pages: [
            {"page": 1, "content": f"evidence for {document['id']}"}
        ],
    )

    answer_question(str(db_path), "handover evidence", ["proj_1"], mode="evidence")

    assert captured_limits == [3]


def test_answer_question_falls_back_when_llm_pages_are_invalid(tmp_path, monkeypatch):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_1",
        file_name="alpha.pdf",
        doc_description="cash flow risk discussion",
        structure_json=json.dumps([{"title": "s1"}]),
        pages_json=json.dumps(
            [
                {"page": 1, "content": "cash flow details"},
                {"page": 2, "content": "risk details"},
            ]
        ),
    )

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc: "999-1000",
    )

    def fake_load_page_excerpt(_document, pages):
        if pages == "1-2":
            return [{"page": 1, "content": "fallback evidence"}]
        return []

    monkeypatch.setattr(
        "services.retrieval_api.query_engine._load_page_excerpt",
        fake_load_page_excerpt,
    )
    captured_context: dict = {}

    def fake_generate_answer(_query, context_blocks):
        captured_context["blocks"] = context_blocks
        return "answer from fallback"

    monkeypatch.setattr(
        "services.retrieval_api.query_engine._generate_answer",
        fake_generate_answer,
    )

    result = answer_question(str(db_path), "cash flow risk", ["proj_1"])

    assert result["answer"] == "answer from fallback"
    assert result["citations"][0]["pages"] == "1-2"
    assert result["citations"][0]["focusPage"] == 1
    assert result["citations"][0]["excerpt"] == "fallback evidence"
    assert captured_context["blocks"][0]["evidence"] == [
        {"page": 1, "content": "fallback evidence"}
    ]


def test_answer_question_skips_bad_index_rows_and_uses_good_documents(tmp_path, monkeypatch):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_good",
        file_name="good.pdf",
        doc_description="cash flow summary",
        structure_json=json.dumps([{"title": "good"}]),
        pages_json=json.dumps([{"page": 1, "content": "good evidence"}]),
    )
    _insert_ready_document(
        db_path,
        document_id="doc_bad",
        file_name="bad.pdf",
        doc_description="cash flow summary",
        structure_json="not-json",
        pages_json=json.dumps([{"page": 1, "content": "bad evidence"}]),
    )

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc: "1",
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._load_page_excerpt",
        lambda _document, _pages: [{"page": 1, "content": "good evidence"}],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._generate_answer",
        lambda _query, _blocks: "final answer",
    )

    result = answer_question(str(db_path), "cash flow", ["proj_1"])

    assert result["answer"] == "final answer"
    assert result["selectedDocuments"] == [{"documentId": "doc_good"}]
    assert result["citations"] == [
        {
            "projectId": "proj_1",
            "projectName": "Alpha",
            "documentId": "doc_good",
            "documentName": "good.pdf",
            "pages": "1",
            "focusPage": 1,
            "excerpt": "good evidence",
        }
    ]


def test_answer_question_falls_back_when_llm_pages_range_is_oversized(
    tmp_path, monkeypatch
):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_large",
        file_name="large.pdf",
        doc_description="cash flow deep dive",
        structure_json=json.dumps([{"title": "large"}]),
        pages_json=json.dumps(
            [
                {"page": page, "content": f"content-{page}"}
                for page in range(1, 1002)
            ]
        ),
    )

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc: "1-1001",
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._load_page_excerpt",
        lambda _document, pages: [{"page": 1, "content": f"evidence:{pages}"}],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._generate_answer",
        lambda _query, _blocks: "answer with fallback",
    )

    result = answer_question(str(db_path), "cash flow", ["proj_1"])

    assert result["answer"] == "answer with fallback"
    assert result["citations"][0]["pages"] == "1-2"


def test_retrieval_llm_uses_configured_model(monkeypatch):
    query_engine._get_retrieval_model.cache_clear()
    monkeypatch.setattr(
        "pageindex.utils.ConfigLoader.load",
        lambda self, user_opt=None: SimpleNamespace(
            model="gpt-base",
            retrieve_model="gpt-retrieval",
        ),
    )
    monkeypatch.setattr(
        "pageindex.retrieve.get_document_structure",
        lambda _document_map, _document_id: '{"nodes":[]}',
    )

    seen_models: list[str | None] = []

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        seen_models.append(model)
        if "Return JSON only" in prompt:
            return '{"pages": "2"}'
        return "final answer"

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)

    document = {
        "id": "doc_1",
        "file_name": "alpha.pdf",
        "doc_description": "Alpha",
        "structure": [{"title": "Intro"}],
        "pages": [
            {"page": 1, "content": "intro"},
            {"page": 2, "content": "details"},
        ],
    }

    pages = query_engine.choose_page_window("what is on page 2", document)
    answer = query_engine._generate_answer(
        "what is on page 2",
        [{"document": "alpha.pdf", "pages": "2", "evidence": [{"page": 2, "content": "details"}]}],
    )

    assert pages == "2"
    assert answer == "final answer"
    assert seen_models == ["gpt-retrieval", "gpt-retrieval"]


def test_select_citation_anchor_prefers_specific_paragraph_over_full_page_blob():
    focus_page, excerpt = query_engine._select_citation_anchor(
        "这个项目有哪些遗留事项？",
        [
            {
                "page": 1,
                "content": (
                    "# 终验报告                              "
                    "## KPI 验证结果                              "
                    "关键业务割接中断时间 12 分钟，办公无线漫游时延 92ms 至 136ms。                              "
                    "## 遗留事项与建议                              "
                    "- 食堂前厅与广场区域建议在装修和活动场景稳定后补做一次无线复测。                              "
                    "- 第三方系统的临时放通策略需纳入月度审查，避免再次累积例外规则。"
                ),
            }
        ],
    )

    assert focus_page == 1
    assert excerpt == "- 食堂前厅与广场区域建议在装修和活动场景稳定后补做一次无线复测。"


def test_answer_question_uses_description_selection_for_cross_language_query(
    tmp_path, monkeypatch
):
    query_engine._get_retrieval_model.cache_clear()
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_acceptance",
        file_name="acceptance.pdf",
        doc_description="Acceptance criteria, delivery checklist, and sign-off standards.",
        structure_json=json.dumps([{"title": "Acceptance"}]),
        pages_json=json.dumps([{"page": 1, "content": "All deliverables must pass review."}]),
    )
    _insert_ready_document(
        db_path,
        document_id="doc_schedule",
        file_name="schedule.pdf",
        doc_description="Timeline, milestones, and staffing plan.",
        structure_json=json.dumps([{"title": "Timeline"}]),
        pages_json=json.dumps([{"page": 1, "content": "Project starts in May."}]),
    )

    monkeypatch.setattr(
        "pageindex.utils.ConfigLoader.load",
        lambda self, user_opt=None: SimpleNamespace(
            model="gpt-base",
            retrieve_model="gpt-retrieval",
        ),
    )

    seen_models: list[str | None] = []

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        seen_models.append(model)
        assert "这个项目的验收标准是什么？" in prompt
        return '{"thinking":"doc_acceptance is the acceptance criteria document","answer":["doc_acceptance"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc: "1",
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._load_page_excerpt",
        lambda _document, _pages: [{"page": 1, "content": "All deliverables must pass review."}],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._generate_answer",
        lambda _query, _blocks: "验收标准包括交付物评审和签收。",
    )

    result = answer_question(str(db_path), "这个项目的验收标准是什么？", ["proj_1"])

    assert result["answer"] == "验收标准包括交付物评审和签收。"
    assert result["selectedDocuments"] == [{"documentId": "doc_acceptance"}]
    assert result["citations"] == [
        {
            "projectId": "proj_1",
            "projectName": "Alpha",
            "documentId": "doc_acceptance",
            "documentName": "acceptance.pdf",
            "pages": "1",
            "focusPage": 1,
            "excerpt": "All deliverables must pass review.",
        }
    ]
    assert seen_models == ["gpt-retrieval"]


def test_answer_question_evidence_mode_returns_path_and_content_metadata(
    tmp_path, monkeypatch
):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_acceptance",
        file_name="acceptance.pdf",
        doc_description="Acceptance criteria and handover evidence.",
        structure_json=json.dumps([{"title": "Acceptance"}]),
        pages_json=json.dumps([{"page": 1, "content": "Acceptance content"}]),
        source_relative_path="Alpha/delivery/acceptance.pdf",
        project_relative_path="delivery/acceptance.pdf",
        evidence_kind="pdf_text",
        visual_assets_json=json.dumps([{"path": "/data/projects/Alpha/site.png"}]),
    )

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        lambda _query, docs, limit=5, model=None: docs[:1],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc: "1",
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._load_page_excerpt",
        lambda _document, _pages: [{"page": 1, "content": "Acceptance content"}],
    )

    result = answer_question(
        str(db_path),
        "find acceptance evidence",
        ["proj_1"],
        mode="evidence",
    )

    assert result["answer"] == ""
    assert result["citations"] == []
    assert result["selectedDocuments"] == [
        {
            "documentId": "doc_acceptance",
            "sourceRelativePath": "Alpha/delivery/acceptance.pdf",
        }
    ]
    assert result["evidence"] == [
        {
            "projectId": "proj_1",
            "projectName": "Alpha",
            "documentId": "doc_acceptance",
            "documentName": "acceptance.pdf",
            "sourceRelativePath": "Alpha/delivery/acceptance.pdf",
            "projectRelativePath": "delivery/acceptance.pdf",
            "pages": "1",
            "evidenceKind": "pdf_text",
            "excerpt": "Acceptance content",
            "content": "Acceptance content",
            "visualAssets": [{"path": "/data/projects/Alpha/site.png"}],
        }
    ]


def test_answer_question_processes_selected_documents_concurrently_and_preserves_order(
    tmp_path,
    monkeypatch,
):
    db_path = _seed_retrieval_db(tmp_path)
    for index in range(3):
        _insert_ready_document(
            db_path,
            document_id=f"doc_{index}",
            file_name=f"doc-{index}.pdf",
            doc_description="handover evidence",
            structure_json=json.dumps([{"title": f"Doc {index}"}]),
            pages_json=json.dumps([{"page": 1, "content": f"evidence {index}"}]),
        )

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        lambda _query, docs, limit=5, model=None: docs[:3],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._load_page_excerpt",
        lambda document, _pages: [
            {"page": 1, "content": f"evidence for {document['id']}"}
        ],
    )

    lock = threading.Lock()
    active = 0
    max_active = 0

    def slow_choose_page_window(_query, _document):
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        try:
            time.sleep(0.05)
            return "1"
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        slow_choose_page_window,
    )

    result = answer_question(str(db_path), "handover evidence", ["proj_1"], mode="evidence")

    assert max_active > 1
    assert [item["documentId"] for item in result["evidence"]] == [
        "doc_0",
        "doc_1",
        "doc_2",
    ]
