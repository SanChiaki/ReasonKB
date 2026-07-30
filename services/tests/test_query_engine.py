import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from services.retrieval_api import query_engine
from services.retrieval_api.query_engine import (
    _build_seeyon_document_url,
    answer_question,
    build_citation,
)
from services.retrieval_api.schemas import QueryRequest, QueryResponse
from services.retrieval_api.select_documents import (
    CandidateDocuments,
    EVIDENCE_VALIDATION_REASON_KEY,
)


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


def test_retrieval_llm_timeout_rejects_invalid_values_and_caps_large_values(monkeypatch):
    for value in ("invalid", "nan", "-1", "0"):
        monkeypatch.setenv("RETRIEVAL_LLM_REQUEST_TIMEOUT_SECONDS", value)
        assert (
            query_engine._retrieval_llm_timeout_seconds()
            == query_engine.DEFAULT_RETRIEVAL_LLM_TIMEOUT_SECONDS
        )

    monkeypatch.setenv("RETRIEVAL_LLM_REQUEST_TIMEOUT_SECONDS", "999")
    assert query_engine._retrieval_llm_timeout_seconds() == 600.0


def _fallback_document_result(*, validation_reason: str = "technical_fallback"):
    document = {
        "id": "doc_policy",
        "project_id": "proj_1",
        "project_name": "Alpha",
        "file_name": "policy.pdf",
        "source_relative_path": "policy.pdf",
        "project_relative_path": "policy.pdf",
        "evidence_kind": "pdf_text",
        "visual_assets": [],
        EVIDENCE_VALIDATION_REASON_KEY: validation_reason,
    }
    return query_engine._assemble_document_result(
        "钻石经销商的业绩门槛是多少？",
        document,
        "evidence",
        "1-2",
        [
            {"page": 1, "content": "经销商政策目录。"},
            {"page": 2, "content": "钻石经销商业绩门槛为年度收入 1000 万元。"},
        ],
    )


def test_fallback_evidence_validation_keeps_only_directly_supported_pages(monkeypatch):
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"matches":[{"candidate_id":"D001","supporting_pages":[2]}]}'
        ),
    )

    validation = query_engine._validate_retrieved_evidence(
        "钻石经销商的业绩门槛是多少？",
        [_fallback_document_result()],
        "evidence",
    )

    assert validation.status == "matched"
    assert validation.degraded_reason is None
    assert len(validation.document_results) == 1
    assert validation.document_results[0]["evidenceBlock"]["pages"] == "2"
    assert "1000 万元" in validation.document_results[0]["evidenceBlock"]["content"]
    assert "政策目录" not in validation.document_results[0]["evidenceBlock"]["content"]


def test_fallback_evidence_validation_returns_no_match_for_topical_but_unsupported_text(
    monkeypatch,
):
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"sufficient":false,"matches":[]}'
        ),
    )

    validation = query_engine._validate_retrieved_evidence(
        "铂金经销商的业绩门槛是多少？",
        [_fallback_document_result(validation_reason="explicit_empty_probe")],
        "answer",
    )

    assert validation.status == "no_match"
    assert validation.document_results == ()


def test_fallback_evidence_validation_fails_closed_when_validator_is_malformed(
    monkeypatch,
):
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: "not-json",
    )

    validation = query_engine._validate_retrieved_evidence(
        "钻石经销商的业绩门槛是多少？",
        [_fallback_document_result()],
        "evidence",
    )

    assert validation.status == "degraded"
    assert validation.degraded_reason == "evidence_validation_failed"
    assert validation.document_results == ()


def test_answer_validation_rejects_partial_evidence_when_not_sufficient(monkeypatch):
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"sufficient":false,"matches":['
            '{"candidate_id":"D001","supporting_pages":[2]}]}'
        ),
    )

    validation = query_engine._validate_retrieved_evidence(
        "钻石经销商的全部业绩门槛和能力要求是什么？",
        [_fallback_document_result()],
        "answer",
    )

    assert validation.status == "no_match"
    assert validation.document_results == ()


def test_evidence_validation_rejects_mixed_valid_and_unknown_candidates(monkeypatch):
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"matches":['
            '{"candidate_id":"D001","supporting_pages":[2]},'
            '{"candidate_id":"D999","supporting_pages":[1]}]}'
        ),
    )

    validation = query_engine._validate_retrieved_evidence(
        "钻石经销商的业绩门槛是多少？",
        [_fallback_document_result()],
        "evidence",
    )

    assert validation.status == "degraded"
    assert validation.degraded_reason == "evidence_validation_failed"
    assert validation.document_results == ()


def test_evidence_validation_rejects_boolean_pages(monkeypatch):
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"matches":[{"candidate_id":"D001","supporting_pages":[true]}]}'
        ),
    )
    validation = query_engine._validate_retrieved_evidence(
        "钻石经销商的业绩门槛是多少？",
        [_fallback_document_result()],
        "evidence",
    )

    assert validation.status == "degraded"
    assert validation.document_results == ()


def test_evidence_validation_rejects_empty_page_text(monkeypatch):
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"matches":[{"candidate_id":"D001","supporting_pages":[1]}]}'
        ),
    )
    document_result = _fallback_document_result()
    document_result["contextBlock"]["evidence"][0]["content"] = ""

    validation = query_engine._validate_retrieved_evidence(
        "钻石经销商的业绩门槛是多少？",
        [document_result],
        "evidence",
    )

    assert validation.status == "degraded"
    assert validation.document_results == ()


def test_validation_compaction_preserves_query_focused_tail_content():
    content = "目录内容" * 100 + "量子返点规则不存在"

    compact = query_engine._compact_validation_content("量子返点规则是什么", content, 120)

    assert len(compact) <= 120
    assert "量子返点规则不存在" in compact


def test_answer_generation_failure_is_reported_as_degraded(monkeypatch):
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._generate_answer",
        lambda _query, _blocks: "",
    )

    result = query_engine._build_answer_result(
        "钻石经销商的业绩门槛是多少？",
        [_fallback_document_result()],
        "answer",
    )

    assert result["retrievalStatus"] == "degraded"
    assert result["degradedReason"] == "answer_generation_failed"
    assert result["answer"] == "I could not generate an answer from the selected documents."


def test_build_seeyon_document_url_uses_fr_id_and_omits_endpoint_credentials():
    assert _build_seeyon_document_url(
        "https://oa.example.test/seeyon/?ignored=secret#fragment",
        "5194972540313029554",
    ) == (
        "https://oa.example.test/seeyon/doc.do?"
        "method=knowledgeBrowse&docResId=5194972540313029554&entranceType=5&"
        "docId=5194972540313029554"
    )
    assert _build_seeyon_document_url("https://oa.example.test", "fr id/1") == (
        "https://oa.example.test/seeyon/doc.do?"
        "method=knowledgeBrowse&docResId=fr+id%2F1&entranceType=5&docId=fr+id%2F1"
    )
    assert _build_seeyon_document_url("https://user:password@oa.example.test", "fr_1") is None
    assert _build_seeyon_document_url("file:///tmp/seeyon", "fr_1") is None
    assert _build_seeyon_document_url("https://oa.example.test", "") is None


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


def _seed_seeyon_source(db_path: Path) -> None:
    now = "2026-07-25T00:00:00Z"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """INSERT INTO corpus_sources
           (id, kind, display_name, state, scope_json, config_json,
            config_revision, selection_policy, schedule_mode,
            max_document_size_bytes, health_state, created_at, updated_at)
           VALUES ('src_seeyon', 'seeyon', 'Seeyon', 'active', ?, '{}', 1,
                   'explicit', 'scheduled', 104857600, 'normal', ?, ?)""",
        (json.dumps({"endpoint": "http://oa.example.test/seeyon/"}), now, now),
    )
    conn.execute(
        """INSERT INTO source_collections
           (id, source_id, identity_key, external_id, root_external_id,
            display_name, origin, registration_state, validation_state,
            lifecycle_state, selected, created_at, updated_at)
           VALUES ('collection_seeyon', 'src_seeyon', 'seeyon:lib:root',
                   'lib', 'root', 'Seeyon', 'manual', 'active', 'valid',
                   'active', 1, ?, ?)""",
        (now, now),
    )
    conn.commit()
    conn.close()


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


def test_query_response_keeps_backward_compatible_status_default():
    response = QueryResponse.model_validate(
        {
            "answer": "answer",
            "citations": [],
            "selectedDocuments": [],
            "evidence": [],
        }
    )

    assert response.retrievalStatus == "matched"
    assert response.model_dump() == {
        "answer": "answer",
        "citations": [],
        "selectedDocuments": [],
        "evidence": [],
        "retrievalStatus": "matched",
    }


def test_evidence_mode_never_returns_answer_text_when_no_documents_match(
    tmp_path,
    monkeypatch,
):
    db_path = _seed_retrieval_db(tmp_path)
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        lambda _query, _docs, limit=5, model=None, mode="answer": [],
    )

    result = answer_question(
        str(db_path),
        "find supporting evidence",
        mode="evidence",
    )
    events = list(
        query_engine.answer_question_events(
            str(db_path),
            "find supporting evidence",
            mode="evidence",
        )
    )

    assert result == {
        "answer": "",
        "citations": [],
        "selectedDocuments": [],
        "evidence": [],
        "retrievalStatus": "no_match",
    }
    assert events[-1]["data"] == result


def test_answer_mode_distinguishes_no_relevance_from_empty_ready_scope(
    tmp_path,
    monkeypatch,
):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_ready",
        file_name="ready.pdf",
        doc_description="A ready but unrelated document.",
        structure_json="[]",
        pages_json=json.dumps([{"page": 1, "content": "Unrelated content."}]),
    )
    seen_modes: list[str] = []

    def empty_selection(_query, _docs, limit=5, model=None, mode="answer"):
        seen_modes.append(mode)
        return []

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        empty_selection,
    )

    result = answer_question(
        str(db_path),
        "find an unrelated topic",
        mode="answer",
    )

    assert result["answer"] == "No relevant documents were found in the retrieval scope."
    assert result["selectedDocuments"] == []
    assert seen_modes == ["answer"]


def test_answer_question_reports_degraded_when_candidate_provider_fails_without_fallback(
    tmp_path,
    monkeypatch,
):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_unrelated",
        file_name="directory.pdf",
        doc_description="Employee directory",
        structure_json="[]",
        pages_json=json.dumps([{"page": 1, "content": "Employee contacts."}]),
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        lambda _query, _docs, limit=5, model=None, mode="answer": CandidateDocuments(
            [],
            model_outcome="provider_error",
            strategy="technical_failure_no_strong_match",
        ),
    )

    result = answer_question(str(db_path), "量子返点规则", mode="answer")

    assert result["retrievalStatus"] == "degraded"
    assert result["degradedReason"] == "candidate_selection_provider_error"
    assert result["selectedDocuments"] == []


def test_sync_and_stream_report_degraded_when_selected_evidence_collection_fails(
    tmp_path,
    monkeypatch,
):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_policy",
        file_name="policy.pdf",
        doc_description="Policy evidence.",
        structure_json="[]",
        pages_json=json.dumps([{"page": 1, "content": "Policy content."}]),
    )

    def selected_document(_query, docs, limit=5, model=None, mode="answer"):
        return CandidateDocuments(
            [
                {
                    **docs[0],
                    EVIDENCE_VALIDATION_REASON_KEY: "model_selection",
                }
            ],
            model_outcome="selected",
            strategy="model_only_single_slot",
        )

    failed_results = query_engine._DocumentResults(
        [],
        attempted_count=1,
        degraded_reasons=["evidence_collection_failed"],
    )

    def failed_stream(*_args, **_kwargs):
        if False:
            yield None
        return failed_results

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        selected_document,
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._build_selected_documents_evidence_events",
        failed_stream,
    )

    sync_result = answer_question(str(db_path), "What does the policy say?")
    stream_result = list(
        query_engine.answer_question_events(
            str(db_path),
            "What does the policy say?",
        )
    )[-1]["data"]

    for result in (sync_result, stream_result):
        assert result["retrievalStatus"] == "degraded"
        assert result["degradedReason"] == "evidence_collection_failed"
        assert result["selectedDocuments"] == []


def test_sync_and_stream_adapters_return_the_same_result(tmp_path, monkeypatch):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_policy",
        file_name="policy.pdf",
        doc_description="Handover policy evidence.",
        structure_json="[]",
        pages_json=json.dumps([{"page": 1, "content": "Handover requires approval."}]),
        source_relative_path="Alpha/policy.pdf",
    )
    monkeypatch.setattr(
        query_engine,
        "select_candidate_documents",
        lambda _query, docs, limit=5, model=None, mode="answer": docs[:1],
    )
    monkeypatch.setattr(
        query_engine,
        "choose_page_window",
        lambda _query, _document, _mode="answer": "1",
    )
    monkeypatch.setattr(
        query_engine,
        "_load_page_excerpt",
        lambda _document, _pages: [
            {"page": 1, "content": "Handover requires approval."}
        ],
    )
    monkeypatch.setattr(
        query_engine,
        "_generate_answer",
        lambda _query, _blocks: "Handover requires approval.",
    )

    for mode in ("answer", "evidence"):
        sync_result = answer_question(
            str(db_path),
            "What does handover require?",
            ["proj_1"],
            mode=mode,
        )
        stream_events = list(
            query_engine.answer_question_events(
                str(db_path),
                "What does handover require?",
                ["proj_1"],
                mode=mode,
            )
        )
        result_events = [
            event for event in stream_events if event.get("type") == "result"
        ]

        assert len(result_events) == 1
        assert result_events[0] == stream_events[-1]
        assert sync_result == result_events[0]["data"]


def test_sync_adapter_requires_exactly_one_result_event(monkeypatch):
    def missing_result(*_args, **_kwargs):
        yield query_engine._progress_event("retrieval_started")

    monkeypatch.setattr(query_engine, "_execute_retrieval_events", missing_result)
    with pytest.raises(RuntimeError, match="without a result event"):
        answer_question("unused.db", "handover evidence")

    def duplicate_results(*_args, **_kwargs):
        yield query_engine._result_event({"answer": "first"})
        yield query_engine._result_event({"answer": "second"})

    monkeypatch.setattr(query_engine, "_execute_retrieval_events", duplicate_results)
    with pytest.raises(RuntimeError, match="multiple result events"):
        answer_question("unused.db", "handover evidence")

    def malformed_result(*_args, **_kwargs):
        yield query_engine._result_event("not an object")

    monkeypatch.setattr(query_engine, "_execute_retrieval_events", malformed_result)
    with pytest.raises(RuntimeError, match="did not contain an object"):
        answer_question("unused.db", "handover evidence")

    def event_after_result(*_args, **_kwargs):
        yield query_engine._result_event({"answer": "finished"})
        yield query_engine._progress_event("unexpected_progress")

    monkeypatch.setattr(query_engine, "_execute_retrieval_events", event_after_result)
    with pytest.raises(RuntimeError, match="event after its result"):
        answer_question("unused.db", "handover evidence")


def test_answer_question_rejects_explicit_empty_probe_without_direct_support(
    tmp_path,
    monkeypatch,
):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_policy",
        file_name="经销商政策.pdf",
        doc_description="经销商等级和业绩政策。",
        structure_json="[]",
        pages_json=json.dumps([{"page": 1, "content": "仅包含钻石经销商政策。"}]),
    )

    def explicit_empty_probe(_query, docs, limit=5, model=None, mode="answer"):
        document = {
            **docs[0],
            EVIDENCE_VALIDATION_REASON_KEY: "explicit_empty_probe",
        }
        return CandidateDocuments(
            [document],
            model_outcome="explicit_empty",
            strategy="explicit_empty_strong_probe",
        )

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        explicit_empty_probe,
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _document, _mode="answer": "1",
    )
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"sufficient":false,"matches":[]}'
        ),
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._generate_answer",
        lambda _query, _blocks: (_ for _ in ()).throw(
            AssertionError("unsupported evidence must not reach answer generation")
        ),
    )

    result = answer_question(str(db_path), "铂金经销商的业绩门槛是多少？")

    assert result["retrievalStatus"] == "no_match"
    assert result["citations"] == []
    assert result["selectedDocuments"] == []


def test_stream_validates_technical_fallback_before_returning_evidence(
    tmp_path,
    monkeypatch,
):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_policy",
        file_name="钻石经销商政策.pdf",
        doc_description="钻石经销商的年度业绩门槛。",
        structure_json="[]",
        pages_json=json.dumps(
            [{"page": 1, "content": "钻石经销商年度业绩门槛为 1000 万元。"}]
        ),
    )

    def technical_fallback(_query, docs, limit=5, model=None, mode="answer"):
        document = {
            **docs[0],
            EVIDENCE_VALIDATION_REASON_KEY: "technical_fallback",
        }
        return CandidateDocuments(
            [document],
            model_outcome="provider_error",
            strategy="technical_failure_strong_fallback",
        )

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        technical_fallback,
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _document, _mode="answer": "1",
    )
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"matches":[{"candidate_id":"D001","supporting_pages":[1]}]}'
        ),
    )

    events = list(
        query_engine.answer_question_events(
            str(db_path),
            "钻石经销商的业绩门槛是多少？",
            mode="evidence",
        )
    )
    stages = [event.get("stage") for event in events if event["type"] == "progress"]
    result = events[-1]["data"]

    assert "document_evidence_pending_validation" in stages
    assert "document_evidence_loaded" not in stages
    assert "evidence_validation_started" in stages
    assert "evidence_validation_completed" in stages
    assert result["retrievalStatus"] == "degraded"
    assert result["degradedReason"] == "candidate_selection_provider_error"
    assert result["evidence"][0]["pages"] == "1"


def test_answer_question_includes_seeyon_document_url_in_citations_and_evidence(
    tmp_path, monkeypatch
):
    db_path = _seed_retrieval_db(tmp_path)
    _seed_seeyon_source(db_path)
    _insert_ready_document(
        db_path,
        document_id="doc_seeyon",
        file_name="龙田设备档案模板.xlsx",
        doc_description="Seeyon evidence",
        structure_json=json.dumps([{"title": "Evidence"}]),
        pages_json=json.dumps([{"page": 1, "content": "Seeyon content"}]),
        source_relative_path="龙田设备档案模板.xlsx",
        project_relative_path="龙田设备档案模板.xlsx",
    )
    conn = sqlite3.connect(db_path)
    conn.execute(
        """UPDATE documents
              SET source_kind = 'seeyon', source_id = 'src_seeyon',
                  source_collection_id = 'collection_seeyon',
                  source_item_external_id = '5194972540313029554'
            WHERE id = 'doc_seeyon'""",
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        lambda _query, docs, limit=5, model=None, mode="answer": docs[:1],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc, _mode="answer": "1",
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._load_page_excerpt",
        lambda _document, _pages: [{"page": 1, "content": "Seeyon content"}],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._generate_answer",
        lambda _query, _blocks: "Seeyon answer",
    )

    expected_url = (
        "http://oa.example.test/seeyon/doc.do?"
        "method=knowledgeBrowse&docResId=5194972540313029554&entranceType=5&"
        "docId=5194972540313029554"
    )
    answer_result = answer_question(str(db_path), "find the document")
    assert answer_result["citations"][0]["documentUrl"] == expected_url
    assert answer_result["selectedDocuments"] == [{"documentId": "doc_seeyon"}]

    evidence_result = answer_question(
        str(db_path), "find the document", mode="evidence"
    )
    assert evidence_result["evidence"][0]["documentUrl"] == expected_url
    assert evidence_result["selectedDocuments"] == [
        {
            "documentId": "doc_seeyon",
            "sourceRelativePath": "龙田设备档案模板.xlsx",
        }
    ]


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

    def fake_select_candidate_documents(query, docs, limit=5, model=None, mode="answer"):
        captured_docs.extend(docs)
        return docs

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        fake_select_candidate_documents,
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc, _mode="answer": "1",
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

    def fake_select_candidate_documents(query, docs, limit=5, model=None, mode="answer"):
        captured_limits.append(limit)
        return docs[:1]

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        fake_select_candidate_documents,
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc, _mode="answer": "1",
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
        "services.retrieval_api.query_engine.select_candidate_documents",
        lambda _query, docs, limit=5, model=None, mode="answer": docs[:1],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc, _mode="answer": "999-1000",
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
        "services.retrieval_api.query_engine.select_candidate_documents",
        lambda _query, docs, limit=5, model=None, mode="answer": docs[:1],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc, _mode="answer": "1",
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
        "services.retrieval_api.query_engine.select_candidate_documents",
        lambda _query, docs, limit=5, model=None, mode="answer": docs[:1],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc, _mode="answer": "1-1001",
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


def test_choose_page_window_maps_pageindex_node_list_to_physical_pages(monkeypatch):
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"thinking":"the appendix contains the total","node_list":["0002"]}'
        ),
    )
    document = {
        "id": "doc_1",
        "file_name": "annual-report.pdf",
        "doc_description": "Annual report",
        "structure": [
            {
                "node_id": "0001",
                "title": "Summary",
                "start_index": 1,
                "end_index": 2,
            },
            {
                "node_id": "0002",
                "title": "Appendix G",
                "start_index": 7,
                "end_index": 8,
            },
        ],
        "pages": [
            {"page": page, "content": f"content {page}"}
            for page in range(1, 9)
        ],
    }

    pages = query_engine.choose_page_window("What is the deferred asset total?", document)

    assert pages == "7-8"


def test_choose_page_window_marks_provider_fallback_as_degraded(monkeypatch):
    monkeypatch.setattr(
        "pageindex.retrieve.get_document_structure",
        lambda _document_map, _document_id: '{"nodes":[]}',
    )
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            ("", "error") if return_finish_reason else ""
        ),
    )
    document = {
        "id": "doc_1",
        "file_name": "policy.pdf",
        "structure": [],
        "pages": [
            {"page": 1, "content": "first"},
            {"page": 2, "content": "second"},
        ],
    }

    pages = query_engine.choose_page_window("What is the policy?", document)

    assert pages == "1-2"
    assert pages.degraded_reason == "page_selection_provider_error"


def test_tree_assessment_marks_malformed_output_as_degraded(monkeypatch):
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: "not-json",
    )
    document = {
        "id": "doc_1",
        "file_name": "policy.pdf",
        "structure": [{"node_id": "0001", "start_index": 1, "end_index": 1}],
        "pages": [
            {"page": 1, "content": "first"},
            {"page": 2, "content": "second"},
        ],
    }

    assessment = query_engine._assess_evidence_and_choose_next_pages(
        "What is the policy?",
        document,
        [{"page": 1, "content": "first"}],
        {1},
        "answer",
    )

    assert assessment.sufficient is True
    assert assessment.next_pages is None
    assert assessment.degraded_reason == "tree_assessment_malformed"


def test_tree_assessment_treats_explicit_empty_next_pages_as_normal_stop(monkeypatch):
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"sufficient":false,"next_node_list":[],"next_pages":""}'
        ),
    )
    document = {
        "id": "doc_1",
        "file_name": "policy.pdf",
        "structure": [{"node_id": "0001", "start_index": 1, "end_index": 1}],
        "pages": [
            {"page": 1, "content": "first"},
            {"page": 2, "content": "second"},
        ],
    }

    assessment = query_engine._assess_evidence_and_choose_next_pages(
        "What is the policy?",
        document,
        [{"page": 1, "content": "first"}],
        {1},
        "answer",
    )

    assert assessment.sufficient is True
    assert assessment.next_pages is None
    assert assessment.degraded_reason is None


def test_tree_assessment_marks_requested_invalid_page_as_degraded(monkeypatch):
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"sufficient":false,"next_pages":"999"}'
        ),
    )
    document = {
        "id": "doc_1",
        "file_name": "policy.pdf",
        "structure": [{"node_id": "0001", "start_index": 1, "end_index": 1}],
        "pages": [
            {"page": 1, "content": "first"},
            {"page": 2, "content": "second"},
        ],
    }

    assessment = query_engine._assess_evidence_and_choose_next_pages(
        "What is the policy?",
        document,
        [{"page": 1, "content": "first"}],
        {1},
        "answer",
    )

    assert assessment.degraded_reason == "tree_assessment_invalid_next_pages"


def test_query_mode_iterates_pageindex_tree_until_evidence_is_sufficient(
    tmp_path,
    monkeypatch,
):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_finance",
        file_name="annual-report.pdf",
        doc_description="Financial report with deferred asset disclosures.",
        structure_json=json.dumps(
            [
                {
                    "node_id": "0001",
                    "title": "Deferred assets discussion",
                    "start_index": 1,
                    "end_index": 1,
                },
                {
                    "node_id": "0002",
                    "title": "Appendix G statistical tables",
                    "start_index": 3,
                    "end_index": 3,
                },
            ]
        ),
        pages_json=json.dumps(
            [
                {"page": 1, "content": "Deferred assets increased during the year."},
                {"page": 2, "content": "Other financial discussion."},
                {"page": 3, "content": "Appendix G reports total deferred assets of 42 million."},
                {"page": 4, "content": "Glossary."},
            ]
        ),
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        lambda _query, docs, limit=5, model=None, mode="answer": docs[:1],
    )

    assessment_count = 0

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        nonlocal assessment_count
        if "performing PageIndex tree search" in prompt:
            return '{"thinking":"start with the discussion","node_list":["0001"]}'
        if "continuing a bounded PageIndex tree search" in prompt:
            assessment_count += 1
            if assessment_count == 1:
                return (
                    '{"sufficient":false,"thinking":"the total is in Appendix G",'
                    '"next_node_list":["0002"]}'
                )
            return '{"sufficient":true,"thinking":"the total is now available"}'
        if "Answer the user's question" in prompt:
            return "The total deferred assets were 42 million."
        raise AssertionError(f"unexpected prompt: {prompt}")

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)

    result = answer_question(
        str(db_path),
        "What was the total value of deferred assets?",
        ["proj_1"],
        mode="answer",
    )

    assert result["answer"] == "The total deferred assets were 42 million."
    assert result["citations"][0]["pages"] == "1,3"
    assert result["citations"][0]["focusPage"] == 3
    assert assessment_count == 2


def test_evidence_mode_uses_tree_search_but_does_not_generate_an_answer(
    tmp_path,
    monkeypatch,
):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_acceptance",
        file_name="acceptance.pdf",
        doc_description="Acceptance evidence and sign-off records.",
        structure_json=json.dumps(
            [
                {
                    "node_id": "0001",
                    "title": "Acceptance criteria",
                    "start_index": 1,
                    "end_index": 1,
                },
                {
                    "node_id": "0002",
                    "title": "Final sign-off",
                    "start_index": 3,
                    "end_index": 3,
                },
            ]
        ),
        pages_json=json.dumps(
            [
                {"page": 1, "content": "All acceptance checks must pass."},
                {"page": 2, "content": "Implementation notes."},
                {"page": 3, "content": "The customer signed the final acceptance record."},
            ]
        ),
        source_relative_path="Alpha/acceptance.pdf",
        project_relative_path="acceptance.pdf",
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        lambda _query, docs, limit=5, model=None, mode="answer": docs[:1],
    )

    initial_prompts: list[str] = []
    assessment_prompts: list[str] = []

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        if "performing PageIndex tree search" in prompt:
            initial_prompts.append(prompt)
            return '{"node_list":["0001"]}'
        if "continuing a bounded PageIndex tree search" in prompt:
            assessment_prompts.append(prompt)
            if len(assessment_prompts) == 1:
                return '{"sufficient":false,"next_node_list":["0002"]}'
            return '{"sufficient":true}'
        raise AssertionError("evidence mode must not generate an answer")

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)

    result = answer_question(
        str(db_path),
        "Find acceptance criteria and sign-off evidence",
        ["proj_1"],
        mode="evidence",
    )

    assert result["answer"] == ""
    assert result["citations"] == []
    assert result["evidence"][0]["pages"] == "1,3"
    assert result["evidence"][0]["content"] == (
        "All acceptance checks must pass.\n\n"
        "The customer signed the final acceptance record."
    )
    assert "Find all distinct, specific tree nodes" in initial_prompts[0]
    assert "Do not answer the question." in assessment_prompts[0]


def test_retrieval_llm_refreshes_runtime_settings_before_completion(monkeypatch, tmp_path):
    db_path = tmp_path / "app.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE system_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """,
    )
    conn.executemany(
        "INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
        [
            ("llmApiKey", '"runtime-key"', "2026-05-19T00:00:00Z"),
            ("llmBaseUrl", '"https://runtime.example.test/v1"', "2026-05-19T00:00:00Z"),
        ],
    )
    conn.commit()
    conn.close()

    query_engine._get_retrieval_model.cache_clear()
    monkeypatch.setenv("APP_DB_PATH", str(db_path))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    monkeypatch.setattr(
        "pageindex.utils.ConfigLoader.load",
        lambda self, user_opt=None: SimpleNamespace(
            model="gpt-base",
            retrieve_model="gpt-retrieval",
        ),
    )

    def fake_completion(**_kwargs):
        assert os.environ["OPENAI_API_KEY"] == "runtime-key"
        assert os.environ["OPENAI_BASE_URL"] == "https://runtime.example.test/v1"
        assert os.environ["OPENAI_API_BASE"] == "https://runtime.example.test/v1"
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="runtime answer"),
                    finish_reason="stop",
                )
            ],
        )

    monkeypatch.setattr("litellm.completion", fake_completion)

    answer = query_engine._generate_answer(
        "what changed?",
        [{"document": "settings.md", "pages": "1", "evidence": [{"page": 1, "content": "details"}]}],
    )

    assert answer == "runtime answer"


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
        if "validating page evidence" in prompt:
            return '{"sufficient":true,"matches":[{"candidate_id":"D001","supporting_pages":[1]}]}'
        return '{"thinking":"doc_acceptance is the acceptance criteria document","answer":["doc_acceptance"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc, _mode="answer": "1",
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
    assert seen_models == ["gpt-retrieval", "gpt-retrieval"]


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
        lambda _query, docs, limit=5, model=None, mode="answer": docs[:1],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc, _mode="answer": "1",
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
        lambda _query, docs, limit=5, model=None, mode="answer": docs[:3],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._load_page_excerpt",
        lambda document, _pages: [
            {"page": 1, "content": f"evidence for {document['id']}"}
        ],
    )

    lock = threading.Lock()
    workers_started = threading.Barrier(3)
    completion_order: list[str] = []
    active = 0
    max_active = 0

    def slow_choose_page_window(_query, document, _mode="answer"):
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        try:
            workers_started.wait(timeout=1)
            document_index = int(document["id"].split("_")[1])
            time.sleep((2 - document_index) * 0.03)
            with lock:
                completion_order.append(document["id"])
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
    assert completion_order == ["doc_2", "doc_1", "doc_0"]
    assert [item["documentId"] for item in result["evidence"]] == [
        "doc_0",
        "doc_1",
        "doc_2",
    ]


def test_answer_question_events_processes_documents_concurrently_and_preserves_order(
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
        lambda _query, docs, limit=5, model=None, mode="answer": docs[:3],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._load_page_excerpt",
        lambda document, _pages: [
            {"page": 1, "content": f"evidence for {document['id']}"}
        ],
    )

    lock = threading.Lock()
    workers_started = threading.Barrier(3)
    completion_order: list[str] = []
    active = 0
    max_active = 0

    def slow_choose_page_window(_query, document, _mode="answer"):
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        try:
            workers_started.wait(timeout=1)
            document_index = int(document["id"].split("_")[1])
            time.sleep((2 - document_index) * 0.03)
            with lock:
                completion_order.append(document["id"])
            return "1"
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        slow_choose_page_window,
    )

    events = list(
        query_engine.answer_question_events(
            str(db_path),
            "handover evidence",
            ["proj_1"],
            mode="evidence",
        )
    )

    assert max_active > 1
    assert completion_order == ["doc_2", "doc_1", "doc_0"]
    assert [item["documentId"] for item in events[-1]["data"]["evidence"]] == [
        "doc_0",
        "doc_1",
        "doc_2",
    ]


def test_answer_question_events_with_cancellation_event_completes_normally(
    tmp_path,
    monkeypatch,
):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_1",
        file_name="doc-1.pdf",
        doc_description="handover evidence",
        structure_json=json.dumps([{"title": "Handover"}]),
        pages_json=json.dumps([{"page": 1, "content": "handover evidence"}]),
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        lambda _query, docs, limit=5, model=None, mode="answer": docs[:1],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _document, _mode="answer": "1",
    )
    cancellation_event = threading.Event()

    events = list(
        query_engine.answer_question_events(
            str(db_path),
            "handover evidence",
            ["proj_1"],
            mode="evidence",
            cancellation_event=cancellation_event,
        )
    )

    assert events[-1]["type"] == "result"
    assert events[-1]["data"]["evidence"][0]["documentId"] == "doc_1"
    assert cancellation_event.is_set() is False


def test_stream_close_does_not_wait_for_in_flight_document_retrieval(monkeypatch):
    worker_blocked = threading.Event()
    worker_finished = threading.Event()
    release_worker = threading.Event()

    def slow_document_events(_query, document, _mode):
        yield query_engine._progress_event(
            "document_evidence_started",
            {"document": query_engine._document_summary(document)},
        )
        worker_blocked.set()
        release_worker.wait(timeout=2)
        worker_finished.set()
        yield {"type": "document_result", "data": {"document": document}}

    monkeypatch.setattr(
        query_engine,
        "_build_document_evidence_events",
        slow_document_events,
    )
    selected = [
        {
            "id": "doc_1",
            "file_name": "doc-1.pdf",
            "project_id": "proj_1",
            "project_name": "Project 1",
        }
    ]
    events = query_engine._build_selected_documents_evidence_events(
        "handover evidence",
        selected,
        "evidence",
    )

    assert next(events)["stage"] == "document_evidence_started"
    assert worker_blocked.wait(timeout=1)
    started_at = time.monotonic()
    events.close()
    close_duration = time.monotonic() - started_at
    release_worker.set()

    assert close_duration < 0.2
    assert worker_finished.wait(timeout=1)


def test_stream_coordinator_finishes_when_document_iterator_close_fails(monkeypatch):
    class CloseFailureIterator:
        def __next__(self):
            raise StopIteration

        def close(self):
            raise RuntimeError("close failed")

    monkeypatch.setattr(
        query_engine,
        "_build_document_evidence_events",
        lambda _query, _document, _mode: CloseFailureIterator(),
    )
    selected = [
        {
            "id": "doc_1",
            "file_name": "doc-1.pdf",
            "project_id": "proj_1",
            "project_name": "Project 1",
        }
    ]
    completed = threading.Event()

    def consume_events():
        list(
            query_engine._build_selected_documents_evidence_events(
                "handover evidence",
                selected,
                "evidence",
            )
        )
        completed.set()

    consumer = threading.Thread(target=consume_events, daemon=True)
    consumer.start()

    assert completed.wait(timeout=1)
    consumer.join(timeout=1)
    assert not consumer.is_alive()


def test_stream_reuses_process_document_executor(monkeypatch):
    def fail_per_request_executor(*_args, **_kwargs):
        raise AssertionError("stream requests must not create private thread pools")

    def document_events(_query, document, _mode):
        yield query_engine._progress_event(
            "document_evidence_started",
            {"document": query_engine._document_summary(document)},
        )
        yield {"type": "document_result", "data": {"document": document}}

    monkeypatch.setattr(query_engine, "ThreadPoolExecutor", fail_per_request_executor)
    monkeypatch.setattr(
        query_engine,
        "_build_document_evidence_events",
        document_events,
    )
    selected = [
        {
            "id": "doc_1",
            "file_name": "doc-1.pdf",
            "project_id": "proj_1",
            "project_name": "Project 1",
        }
    ]

    events = list(
        query_engine._build_selected_documents_evidence_events(
            "handover evidence",
            selected,
            "evidence",
        )
    )

    assert [event["stage"] for event in events] == ["document_evidence_started"]


def test_sync_and_stream_share_process_document_worker_limit(monkeypatch):
    state_changed = threading.Condition()
    release_workers = threading.Event()
    active = 0
    max_active = 0

    def block_document_worker():
        nonlocal active, max_active
        with state_changed:
            active += 1
            max_active = max(max_active, active)
            state_changed.notify_all()
        release_workers.wait(timeout=2)
        with state_changed:
            active -= 1
            state_changed.notify_all()

    def stream_document_events(_query, document, _mode):
        block_document_worker()
        yield {
            "type": "document_result",
            "data": {
                "document": document,
                "contextBlock": {"evidence": []},
                "citation": None,
                "evidenceBlock": {
                    "documentId": document["id"],
                    "documentName": document["file_name"],
                    "projectId": document["project_id"],
                    "projectName": document["project_name"],
                    "pages": "1",
                    "evidenceKind": "text",
                    "content": "handover evidence",
                    "visualAssets": [],
                },
            },
        }

    monkeypatch.setattr(
        query_engine,
        "_build_document_evidence_events",
        stream_document_events,
    )
    selected = [
        {
            "id": f"doc_{index}",
            "file_name": f"doc-{index}.pdf",
            "project_id": "proj_1",
            "project_name": "Project 1",
        }
        for index in range(query_engine.MAX_PARALLEL_DOCUMENT_RETRIEVALS)
    ]
    monkeypatch.setattr(
        query_engine,
        "_load_ready_documents",
        lambda _db_path, _project_ids=None: selected,
    )
    monkeypatch.setattr(
        query_engine,
        "get_retrieval_document_limit",
        lambda _db_path, default=5: len(selected),
    )
    monkeypatch.setattr(
        query_engine,
        "select_candidate_documents",
        lambda _query, docs, limit=5, model=None, mode="answer": docs,
    )
    sync_finished = threading.Event()
    stream_finished = threading.Event()

    def consume_sync():
        answer_question(
            "unused.db",
            "handover evidence",
            ["proj_1"],
            mode="evidence",
        )
        sync_finished.set()

    def consume_stream():
        list(
            query_engine.answer_question_events(
                "unused.db",
                "handover evidence",
                ["proj_1"],
                mode="evidence",
            )
        )
        stream_finished.set()

    sync_consumer = threading.Thread(target=consume_sync, daemon=True)
    stream_consumer = threading.Thread(target=consume_stream, daemon=True)
    sync_consumer.start()
    stream_consumer.start()
    try:
        with state_changed:
            assert state_changed.wait_for(
                lambda: active == query_engine.MAX_PARALLEL_DOCUMENT_RETRIEVALS,
                timeout=1,
            )
        worker_threads = [
            thread
            for thread in threading.enumerate()
            if thread.name.startswith("reasonkb-retrieval")
        ]
        assert len(worker_threads) == query_engine.MAX_PARALLEL_DOCUMENT_RETRIEVALS
        assert max_active == query_engine.MAX_PARALLEL_DOCUMENT_RETRIEVALS
    finally:
        release_workers.set()

    assert sync_finished.wait(timeout=1)
    assert stream_finished.wait(timeout=1)
    sync_consumer.join(timeout=1)
    stream_consumer.join(timeout=1)
    assert not sync_consumer.is_alive()
    assert not stream_consumer.is_alive()


def test_many_streams_keep_process_document_worker_count_bounded(monkeypatch):
    state_changed = threading.Condition()
    release_workers = threading.Event()
    active = 0
    max_active = 0
    worker_names: set[str] = set()

    def document_events(_query, document, _mode):
        nonlocal active, max_active
        with state_changed:
            active += 1
            max_active = max(max_active, active)
            worker_names.add(threading.current_thread().name)
            state_changed.notify_all()
        release_workers.wait(timeout=2)
        with state_changed:
            active -= 1
            state_changed.notify_all()
        yield {"type": "document_result", "data": {"document": document}}

    monkeypatch.setattr(
        query_engine,
        "_build_document_evidence_events",
        document_events,
    )
    request_count = 32
    finished = [threading.Event() for _ in range(request_count)]

    def consume_stream(index: int):
        document = {
            "id": f"doc_{index}",
            "file_name": f"doc-{index}.pdf",
            "project_id": "proj_1",
            "project_name": "Project 1",
        }
        list(
            query_engine._build_selected_documents_evidence_events(
                "handover evidence",
                [document],
                "evidence",
            )
        )
        finished[index].set()

    consumers = [
        threading.Thread(target=consume_stream, args=(index,), daemon=True)
        for index in range(request_count)
    ]
    for consumer in consumers:
        consumer.start()
    try:
        with state_changed:
            assert state_changed.wait_for(
                lambda: active == query_engine.MAX_PARALLEL_DOCUMENT_RETRIEVALS,
                timeout=1,
            )
        worker_threads = [
            thread
            for thread in threading.enumerate()
            if thread.name.startswith("reasonkb-retrieval")
        ]
        assert len(worker_threads) == query_engine.MAX_PARALLEL_DOCUMENT_RETRIEVALS
        assert max_active == query_engine.MAX_PARALLEL_DOCUMENT_RETRIEVALS
        assert len(worker_names) == query_engine.MAX_PARALLEL_DOCUMENT_RETRIEVALS
        assert all(name.startswith("reasonkb-retrieval") for name in worker_names)
    finally:
        release_workers.set()

    for item in finished:
        assert item.wait(timeout=2)
    for consumer in consumers:
        consumer.join(timeout=1)
        assert not consumer.is_alive()


def test_large_stream_does_not_queue_all_documents_ahead_of_small_stream(monkeypatch):
    starts_changed = threading.Condition()
    started_documents: list[str] = []
    initial_releases = [threading.Event() for _ in range(5)]
    small_submitted = threading.Event()
    real_executor = query_engine._DOCUMENT_RETRIEVAL_EXECUTOR

    class TrackingExecutor:
        def submit(self, fn, *args, **kwargs):
            document = args[1]
            if document["id"] == "small_0":
                small_submitted.set()
            return real_executor.submit(fn, *args, **kwargs)

    def document_events(_query, document, _mode):
        with starts_changed:
            started_documents.append(document["id"])
            starts_changed.notify_all()
        if document["id"].startswith("large_"):
            index = int(document["id"].split("_")[1])
            if index < len(initial_releases):
                initial_releases[index].wait(timeout=2)
        yield {"type": "document_result", "data": {"document": document}}

    monkeypatch.setattr(
        query_engine,
        "_DOCUMENT_RETRIEVAL_EXECUTOR",
        TrackingExecutor(),
    )
    monkeypatch.setattr(
        query_engine,
        "_build_document_evidence_events",
        document_events,
    )

    def documents(prefix: str, count: int):
        return [
            {
                "id": f"{prefix}_{index}",
                "file_name": f"{prefix}-{index}.pdf",
                "project_id": "proj_1",
                "project_name": "Project 1",
            }
            for index in range(count)
        ]

    large_finished = threading.Event()
    small_finished = threading.Event()

    def consume(prefix: str, selected, finished: threading.Event):
        list(
            query_engine._build_selected_documents_evidence_events(
                f"{prefix} evidence",
                selected,
                "evidence",
            )
        )
        finished.set()

    large_consumer = threading.Thread(
        target=consume,
        args=("large", documents("large", 7), large_finished),
        daemon=True,
    )
    small_consumer = threading.Thread(
        target=consume,
        args=("small", documents("small", 1), small_finished),
        daemon=True,
    )
    large_consumer.start()
    try:
        with starts_changed:
            assert starts_changed.wait_for(
                lambda: len(started_documents) == 5,
                timeout=1,
            )
        small_consumer.start()
        assert small_submitted.wait(timeout=1)

        initial_releases[0].set()
        with starts_changed:
            assert starts_changed.wait_for(
                lambda: "small_0" in started_documents,
                timeout=1,
            )
        if "large_5" in started_documents:
            assert started_documents.index("small_0") < started_documents.index("large_5")
    finally:
        for release in initial_releases:
            release.set()

    assert large_finished.wait(timeout=1)
    assert small_finished.wait(timeout=1)
    large_consumer.join(timeout=1)
    small_consumer.join(timeout=1)
    assert not large_consumer.is_alive()
    assert not small_consumer.is_alive()


def test_stream_cancellation_stops_coordinator_and_pending_documents(monkeypatch):
    worker_started = threading.Condition()
    worker_finished = threading.Condition()
    release_workers = threading.Event()
    started_documents: list[str] = []
    finished_documents: list[str] = []

    def blocking_document_events(_query, document, _mode):
        try:
            with worker_started:
                started_documents.append(document["id"])
                worker_started.notify_all()
            release_workers.wait(timeout=2)
            yield {"type": "document_result", "data": {"document": document}}
        finally:
            with worker_finished:
                finished_documents.append(document["id"])
                worker_finished.notify_all()

    monkeypatch.setattr(
        query_engine,
        "_build_document_evidence_events",
        blocking_document_events,
    )
    selected = [
        {
            "id": f"doc_{index}",
            "file_name": f"doc-{index}.pdf",
            "project_id": "proj_1",
            "project_name": "Project 1",
        }
        for index in range(30)
    ]
    cancellation_event = threading.Event()
    coordinator_finished = threading.Event()

    def consume_events():
        list(
            query_engine._build_selected_documents_evidence_events(
                "handover evidence",
                selected,
                "evidence",
                cancellation_event,
            )
        )
        coordinator_finished.set()

    consumer = threading.Thread(target=consume_events, daemon=True)
    consumer.start()
    with worker_started:
        assert worker_started.wait_for(
            lambda: len(started_documents) == query_engine.MAX_PARALLEL_DOCUMENT_RETRIEVALS,
            timeout=1,
        )

    cancellation_event.set()

    assert coordinator_finished.wait(timeout=0.5)
    assert len(started_documents) == query_engine.MAX_PARALLEL_DOCUMENT_RETRIEVALS
    release_workers.set()
    consumer.join(timeout=1)
    assert not consumer.is_alive()

    with worker_finished:
        assert worker_finished.wait_for(
            lambda: len(finished_documents)
            == query_engine.MAX_PARALLEL_DOCUMENT_RETRIEVALS,
            timeout=1,
        )

    recovery_finished = threading.Event()

    def consume_recovery_request():
        list(
            query_engine._build_selected_documents_evidence_events(
                "recovery evidence",
                selected[: query_engine.MAX_PARALLEL_DOCUMENT_RETRIEVALS],
                "evidence",
            )
        )
        recovery_finished.set()

    recovery_consumer = threading.Thread(
        target=consume_recovery_request,
        daemon=True,
    )
    recovery_consumer.start()
    assert recovery_finished.wait(timeout=0.5)
    recovery_consumer.join(timeout=1)
    assert not recovery_consumer.is_alive()
    assert len(started_documents) == 2 * query_engine.MAX_PARALLEL_DOCUMENT_RETRIEVALS
    assert len(finished_documents) == 2 * query_engine.MAX_PARALLEL_DOCUMENT_RETRIEVALS


def test_answer_question_events_reports_real_retrieval_progress(tmp_path, monkeypatch):
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
    )

    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        lambda _query, docs, limit=5, model=None, mode="answer": docs[:1],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _doc, _mode="answer": "1",
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._load_page_excerpt",
        lambda _document, _pages: [{"page": 1, "content": "Acceptance content"}],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._generate_answer",
        lambda _query, _blocks: "Acceptance answer.",
    )

    events = list(
        query_engine.answer_question_events(
            str(db_path),
            "What are the acceptance criteria?",
            ["proj_1"],
            mode="answer",
        )
    )

    progress_stages = [
        event["stage"] for event in events if event["type"] == "progress"
    ]
    assert progress_stages == [
        "retrieval_started",
        "documents_loaded",
        "document_selection_started",
        "documents_selected",
        "evidence_started",
        "document_evidence_started",
        "document_pages_selected",
        "document_evidence_loaded",
        "answer_generation_started",
        "answer_generation_completed",
        "retrieval_completed",
    ]
    selected_event = next(
        event for event in events if event.get("stage") == "documents_selected"
    )
    assert selected_event["data"]["documents"] == [
        {
            "documentId": "doc_acceptance",
            "documentName": "acceptance.pdf",
            "projectName": "Alpha",
            "sourceRelativePath": "Alpha/delivery/acceptance.pdf",
        }
    ]
    result_event = events[-1]
    assert result_event["type"] == "result"
    assert result_event["data"]["answer"] == "Acceptance answer."


def test_answer_question_events_reports_each_tree_search_round(tmp_path, monkeypatch):
    db_path = _seed_retrieval_db(tmp_path)
    _insert_ready_document(
        db_path,
        document_id="doc_iterative",
        file_name="iterative.pdf",
        doc_description="Evidence split across sections.",
        structure_json=json.dumps(
            [
                {
                    "node_id": "0001",
                    "title": "Initial discussion",
                    "start_index": 1,
                    "end_index": 1,
                },
                {
                    "node_id": "0002",
                    "title": "Supporting table",
                    "start_index": 3,
                    "end_index": 3,
                },
            ]
        ),
        pages_json=json.dumps(
            [
                {"page": 1, "content": "Initial evidence."},
                {"page": 2, "content": "Other material."},
                {"page": 3, "content": "Supporting evidence."},
            ]
        ),
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.select_candidate_documents",
        lambda _query, docs, limit=5, model=None, mode="answer": docs[:1],
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine.choose_page_window",
        lambda _query, _document, _mode="answer": "1",
    )

    assessment_count = 0

    def fake_assessment(_query, _document, _evidence, _inspected_pages, _mode):
        nonlocal assessment_count
        assessment_count += 1
        return (False, "3") if assessment_count == 1 else (True, None)

    monkeypatch.setattr(
        "services.retrieval_api.query_engine._assess_evidence_and_choose_next_pages",
        fake_assessment,
    )
    monkeypatch.setattr(
        "services.retrieval_api.query_engine._generate_answer",
        lambda _query, _blocks: "Combined answer.",
    )

    events = list(
        query_engine.answer_question_events(
            str(db_path),
            "Find all supporting evidence",
            ["proj_1"],
            mode="answer",
        )
    )

    page_events = [
        event
        for event in events
        if event.get("stage") == "document_pages_selected"
    ]
    assert [
        (event["data"]["pages"], event["data"]["round"])
        for event in page_events
    ] == [("1", 1), ("3", 2)]
    result = events[-1]["data"]
    assert result["answer"] == "Combined answer."
    assert result["citations"][0]["pages"] == "1,3"
