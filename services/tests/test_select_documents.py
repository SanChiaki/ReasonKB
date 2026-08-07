import json

import pytest

from services.common.document_search import RankedSearchDocument
from services.common.pageindex_runtime import configure_pageindex_runtime

configure_pageindex_runtime()

from services.retrieval_api import select_documents as select_documents_module
from services.retrieval_api.select_documents import (
    EVIDENCE_VALIDATION_REASON_KEY,
    prefilter_candidate_documents,
    select_candidate_documents,
)


def _candidate_id_for_name(prompt: str, document_name: str) -> str:
    candidate_payload = prompt.split("Candidate Documents:\n", 1)[1].split(
        "\n\nReturn valid JSON only:",
        1,
    )[0]
    candidates = json.loads(candidate_payload)
    return next(
        candidate["candidate_id"]
        for candidate in candidates
        if candidate["doc_name"] == document_name
    )


def test_bm25_prefilter_prefers_matching_description():
    query = "cash flow risk"
    doc = {
        "id": "doc_1",
        "project_id": "proj_1",
        "file_name": "alpha.pdf",
        "doc_description": "Cash flow risk factors and debt covenants",
    }

    noise = {**doc, "id": "doc_2", "doc_description": "Employee directory"}
    assert prefilter_candidate_documents(query, [noise, doc], limit=1) == [doc]


def test_bm25_prefilter_matches_project_relative_path():
    doc = {
        "id": "doc_1",
        "project_id": "proj_1",
        "file_name": "report.pdf",
        "project_name": "Alpha",
        "project_relative_path": "delivery/acceptance/report.pdf",
        "source_relative_path": "Alpha/delivery/acceptance/report.pdf",
        "doc_description": "Network delivery evidence.",
    }

    noise = {**doc, "id": "doc_2", "project_relative_path": "finance/report.pdf"}
    assert prefilter_candidate_documents("acceptance handover", [noise, doc], limit=1) == [doc]


def test_bm25_prefilter_matches_pageindex_structure_title():
    doc = {
        "id": "doc_1",
        "project_id": "proj_1",
        "file_name": "report.pdf",
        "doc_description": "Network delivery evidence.",
        "structure": [
            {
                "title": "终验交付报告",
                "summary": "包含割接结果、质检结论和遗留事项。",
            }
        ],
    }

    noise = {**doc, "id": "doc_2", "structure": [{"title": "项目启动"}]}
    assert prefilter_candidate_documents("生成终验报告", [noise, doc], limit=1) == [doc]


def test_prefilter_prioritizes_matches_and_caps_candidate_budget():
    docs = [
        {
            "id": f"doc_noise_{index}",
            "project_id": "proj_1",
            "file_name": f"finance-{index}.pdf",
            "project_name": "Finance",
            "project_relative_path": f"finance/{index}.pdf",
            "source_relative_path": f"Finance/finance/{index}.pdf",
            "doc_description": "Quarterly financial statements and market discussion.",
        }
        for index in range(60)
    ]
    docs.extend(
        [
            {
                "id": "doc_handover",
                "project_id": "proj_2",
                "file_name": "handover-report.pdf",
                "project_name": "Alpha",
                "project_relative_path": "delivery/handover-report.pdf",
                "source_relative_path": "Alpha/delivery/handover-report.pdf",
                "doc_description": "Final acceptance handover report and sign-off checklist.",
            },
            {
                "id": "doc_quality",
                "project_id": "proj_2",
                "file_name": "quality-check.pdf",
                "project_name": "Alpha",
                "project_relative_path": "delivery/quality-check.pdf",
                "source_relative_path": "Alpha/delivery/quality-check.pdf",
                "doc_description": "Quality inspection evidence for final delivery.",
            },
        ]
    )

    selected = prefilter_candidate_documents(
        "final acceptance handover quality inspection",
        docs,
        limit=10,
    )

    assert {doc["id"] for doc in selected[:2]} == {"doc_handover", "doc_quality"}
    assert len(selected) == 10


def test_prefilter_uses_remaining_budget_for_cross_language_exploration():
    docs = [
        {
            "id": "doc_directory",
            "project_id": "proj_1",
            "file_name": "customer-directory.pdf",
            "doc_description": "Customer contact directory.",
        },
        {
            "id": "doc_churn",
            "project_id": "proj_1",
            "file_name": "客户流失预测与挽留方案.pdf",
            "doc_description": "客户流失预测、原因分析和挽留措施。",
        },
    ]

    selected = prefilter_candidate_documents("customer churn", docs, limit=2)

    assert [doc["id"] for doc in selected] == ["doc_directory", "doc_churn"]


def test_answer_selection_continues_after_explicit_empty_batch(monkeypatch):
    docs = [
        {
            "id": f"doc_directory_{index}",
            "project_id": "proj_1",
            "file_name": f"customer-directory-{index:02d}.pdf",
            "doc_description": "Customer contact directory.",
        }
        for index in range(60)
    ]
    docs.append(
        {
            "id": "doc_churn",
            "project_id": "proj_1",
            "file_name": "客户流失预测与挽留方案.pdf",
            "doc_description": "客户流失预测、原因分析和挽留措施。",
        }
    )

    prompts: list[str] = []

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        prompts.append(prompt)
        if "客户流失预测与挽留方案.pdf" in prompt:
            candidate_id = _candidate_id_for_name(prompt, "客户流失预测与挽留方案.pdf")
            return json.dumps({"thinking": "cross-language match", "answer": [candidate_id]})
        return '{"thinking":"no churn evidence","answer":[]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)

    selected = select_candidate_documents(
        "customer churn",
        docs,
        limit=3,
        mode="answer",
    )

    assert [doc["id"] for doc in selected] == ["doc_churn"]
    assert selected.strategy == "batched_model_selection"
    assert len(prompts) == 2


def test_answer_selection_stops_expansion_after_malformed_batch(monkeypatch):
    docs = [
        {
            "id": f"doc_noise_{index}",
            "project_id": "proj_1",
            "file_name": f"customer-directory-{index:02d}.pdf",
            "doc_description": "Customer contact directory.",
        }
        for index in range(60)
    ]
    docs.append(
        {
            "id": "doc_churn",
            "project_id": "proj_1",
            "file_name": "客户流失预测与挽留方案.pdf",
            "doc_description": "客户流失预测、原因分析和挽留措施。",
        }
    )
    prompts: list[str] = []

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        prompts.append(prompt)
        if "客户流失预测与挽留方案.pdf" in prompt:
            candidate_id = _candidate_id_for_name(prompt, "客户流失预测与挽留方案.pdf")
            return json.dumps({"answer": [candidate_id]})
        return "not-json"

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)

    selected = select_candidate_documents(
        "customer churn",
        docs,
        limit=3,
        mode="answer",
    )

    assert selected == []
    assert selected.model_outcome == "malformed"
    assert len(prompts) == 1


def test_provider_failure_stops_candidate_batch_cascade(monkeypatch):
    docs = [
        {
            "id": f"doc_{index}",
            "project_id": "proj_1",
            "file_name": f"document-{index:02d}.pdf",
            "doc_description": "Unrelated material.",
        }
        for index in range(60)
    ]
    prompts: list[str] = []

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        prompts.append(prompt)
        return "", "error"

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)

    selected = select_candidate_documents(
        "customer churn",
        docs,
        limit=3,
        mode="answer",
    )

    assert selected == []
    assert selected.model_outcome == "provider_error"
    assert len(prompts) == 1


def test_full_top_50_stops_when_next_bm25_batch_has_a_clear_score_drop(monkeypatch):
    docs = [
        {
            "id": f"doc_{index}",
            "project_id": "proj_1",
            "file_name": f"policy-{index:03d}.pdf",
            "doc_description": "Policy evidence.",
        }
        for index in range(60)
    ]
    monkeypatch.setattr(
        select_documents_module,
        "rank_documents_by_bm25",
        lambda query, documents: [
            RankedSearchDocument(document, 10.0 if index < 50 else 1.0, True)
            for index, document in enumerate(documents)
        ],
    )
    prompts: list[str] = []

    def select_full_budget(model, prompt, chat_history=None, return_finish_reason=False):
        prompts.append(prompt)
        return '{"answer":["D001","D002","D003"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", select_full_budget)

    selected = select_candidate_documents("policy", docs, limit=3)

    assert [document["id"] for document in selected] == ["doc_0", "doc_1", "doc_2"]
    assert len(prompts) == 1
    assert selected.strategy == "model_only_full_budget"


def test_underfilled_top_50_expands_even_after_a_bm25_score_drop(monkeypatch):
    docs = [
        {
            "id": f"doc_{index}",
            "project_id": "proj_1",
            "file_name": f"policy-{index:03d}.pdf",
            "doc_description": "Policy evidence.",
        }
        for index in range(60)
    ]
    monkeypatch.setattr(
        select_documents_module,
        "rank_documents_by_bm25",
        lambda query, documents: [
            RankedSearchDocument(document, 10.0 if index < 50 else 1.0, True)
            for index, document in enumerate(documents)
        ],
    )
    prompts: list[str] = []

    def select_one(model, prompt, chat_history=None, return_finish_reason=False):
        prompts.append(prompt)
        return '{"answer":["D001"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", select_one)

    selected = select_candidate_documents("policy", docs, limit=3)

    assert [document["id"] for document in selected] == ["doc_0", "doc_50"]
    assert len(prompts) == 2
    assert selected.strategy == "batched_model_selection"


@pytest.mark.parametrize("mode", ["answer", "evidence"])
def test_shared_selection_searches_every_candidate_batch(monkeypatch, mode):
    docs = [
        {
            "id": f"doc_directory_{index}",
            "project_id": "proj_1",
            "file_name": f"2026-customer-directory-{index:02d}.pdf",
            "doc_description": "2026 customer contact directory.",
        }
        for index in range(60)
    ]
    docs.append(
        {
            "id": "doc_churn",
            "project_id": "proj_1",
            "file_name": "2026客户流失预测与挽留方案.pdf",
            "doc_description": "2026年客户流失预测、原因分析和挽留措施。",
        }
    )

    prompts: list[str] = []

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        prompts.append(prompt)
        if "2026客户流失预测与挽留方案.pdf" in prompt:
            candidate_id = _candidate_id_for_name(
                prompt,
                "2026客户流失预测与挽留方案.pdf",
            )
            return json.dumps({"thinking": "cross-language match", "answer": [candidate_id]})
        return '{"thinking":"possible directory context","answer":["D001"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)

    selected = select_candidate_documents(
        "2026 customer churn",
        docs,
        limit=3,
        mode=mode,
    )

    assert len(selected) == 2
    assert any(doc["id"] == "doc_churn" for doc in selected)
    assert selected.strategy == "batched_model_selection"
    assert len(prompts) == 2


@pytest.mark.parametrize("mode", ["answer", "evidence"])
def test_shared_selection_keeps_the_third_candidate_batch_reachable(monkeypatch, mode):
    docs = [
        {
            "id": f"doc_{index}",
            "project_id": "proj_1",
            "file_name": f"topic-{index:03d}.pdf",
            "doc_description": "Topic background.",
        }
        for index in range(100)
    ]
    docs.append(
        {
            "id": "doc_late",
            "project_id": "proj_1",
            "file_name": "zzz-late-evidence.pdf",
            "doc_description": "The direct topic evidence.",
        }
    )
    prompts: list[str] = []

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        prompts.append(prompt)
        if "zzz-late-evidence.pdf" in prompt:
            candidate_id = _candidate_id_for_name(prompt, "zzz-late-evidence.pdf")
            return json.dumps({"answer": [candidate_id]})
        return '{"answer":["D001"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)

    selected = select_candidate_documents(
        "topic evidence",
        docs,
        limit=2,
        mode=mode,
    )

    assert [document["id"] for document in selected] == ["doc_late"]
    assert len(prompts) == 4


@pytest.mark.parametrize("mode", ["answer", "evidence"])
def test_shared_selection_reranks_batch_results_over_limit(monkeypatch, mode):
    docs = [
        {
            "id": f"doc_{index}",
            "project_id": "proj_1",
            "file_name": f"topic-{index:02d}.pdf",
            "doc_description": "Topic evidence.",
        }
        for index in range(60)
    ]
    prompts: list[str] = []

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        prompts.append(prompt)
        if len(prompts) == 3:
            assert prompt.count('"candidate_id"') == 4
        return '{"answer":["D001","D002"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)

    selected = select_candidate_documents(
        "topic",
        docs,
        limit=2,
        mode=mode,
    )

    assert len(selected) == 2
    assert selected.strategy == "batched_model_selection"
    assert len(prompts) == 3


def test_select_candidate_documents_limits_results():
    docs = [
        {
            "id": f"doc_{index}",
            "project_id": "proj_1",
            "file_name": f"doc-{index}.pdf",
            "doc_description": "cash flow risk" if index < 3 else "unrelated",
        }
        for index in range(10)
    ]

    selected = select_candidate_documents("cash flow risk", docs, limit=2)
    assert len(selected) == 2


def test_select_candidate_documents_uses_llm_description_selection(monkeypatch):
    docs = [
        {
            "id": "doc_scope",
            "project_id": "proj_1",
            "project_name": "Alpha",
            "file_name": "project-scope.pdf",
            "project_relative_path": "planning/project-scope.pdf",
            "source_relative_path": "Alpha/planning/project-scope.pdf",
            "doc_description": "Project scope, milestones, and staffing plan.",
        },
        {
            "id": "doc_acceptance",
            "project_id": "proj_1",
            "project_name": "Alpha",
            "file_name": "acceptance-criteria.pdf",
            "project_relative_path": "delivery/acceptance-criteria.pdf",
            "source_relative_path": "Alpha/delivery/acceptance-criteria.pdf",
            "doc_description": "Acceptance criteria, completion checklist, and review standards.",
        },
    ]

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        assert model == "gpt-retrieval"
        assert "这个项目的验收标准是什么？" in prompt
        assert "acceptance-criteria.pdf" in prompt
        assert "delivery/acceptance-criteria.pdf" in prompt
        assert "Alpha/delivery/acceptance-criteria.pdf" in prompt
        return '{"thinking":"doc_acceptance matches acceptance criteria","answer":["doc_acceptance"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)

    selected = select_candidate_documents(
        "这个项目的验收标准是什么？",
        docs,
        limit=2,
        model="gpt-retrieval",
    )

    assert [doc["id"] for doc in selected] == ["doc_acceptance"]


def test_select_candidate_documents_sends_prefiltered_candidates_to_llm(monkeypatch):
    docs = [
        {
            "id": f"doc_noise_{index}",
            "project_id": "proj_1",
            "project_name": "Finance",
            "file_name": f"finance-{index}.pdf",
            "project_relative_path": f"finance/{index}.pdf",
            "source_relative_path": f"Finance/finance/{index}.pdf",
            "doc_description": "Quarterly financial statements and market discussion.",
        }
        for index in range(60)
    ]
    docs.append(
        {
            "id": "doc_acceptance",
            "project_id": "proj_2",
            "project_name": "Alpha",
            "file_name": "final-acceptance-handover.pdf",
            "project_relative_path": "delivery/final-acceptance-handover.pdf",
            "source_relative_path": "Alpha/delivery/final-acceptance-handover.pdf",
            "doc_description": "Final acceptance handover report and delivery checklist.",
        }
    )

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        assert "final-acceptance-handover.pdf" in prompt
        assert prompt.count('"candidate_id"') == 50
        return '{"thinking":"acceptance handover matches","answer":["doc_acceptance"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)

    selected = select_candidate_documents(
        "final acceptance handover report",
        docs,
        limit=5,
        model="gpt-retrieval",
    )

    assert [doc["id"] for doc in selected] == ["doc_acceptance"]


def test_select_candidate_documents_falls_back_to_keywords_when_llm_response_is_invalid(
    monkeypatch,
):
    docs = [
        {
            "id": "doc_1",
            "project_id": "proj_1",
            "file_name": "cash-flow.pdf",
            "doc_description": "Cash flow risk factors and debt covenants",
        },
        {
            "id": "doc_2",
            "project_id": "proj_1",
            "file_name": "staffing.pdf",
            "doc_description": "Team roster and roles",
        },
    ]

    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: "not-json",
    )

    selected = select_candidate_documents(
        "cash flow risk",
        docs,
        limit=2,
        model="gpt-retrieval",
    )

    assert [doc["id"] for doc in selected] == ["doc_1"]


def test_select_candidate_documents_does_not_fall_back_to_weak_matches_when_llm_fails(
    monkeypatch,
):
    docs = [
        {
            "id": "doc_annual",
            "project_id": "proj_1",
            "project_name": "office-test",
            "file_name": "annual-report.pdf",
            "doc_description": "Annual business report and market discussion.",
        }
    ]

    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: "not-json",
    )

    selected = select_candidate_documents(
        "生成终验交付报告",
        docs,
        limit=2,
        model="gpt-retrieval",
    )

    assert selected == []
    assert selected.model_outcome == "malformed"
    assert selected.strategy == "technical_failure_no_strong_match"


def _policy_candidate_documents():
    return [
        {
            "id": "doc_gold",
            "project_id": "proj_1",
            "file_name": "附件3：中国政企钻石经销商伙伴成长指数评估标准.xlsx",
            "doc_description": "钻石经销商PGI评估指标和评分规则。",
        },
        {
            "id": "doc_support",
            "project_id": "proj_1",
            "file_name": "中国政企伙伴发展政策—钻石经销商.pdf",
            "doc_description": "钻石经销商认证、业绩门槛和激励权益。",
        },
        {
            "id": "doc_related",
            "project_id": "proj_1",
            "file_name": "钻石经销商服务能力评估指引.pdf",
            "doc_description": "钻石经销商服务能力评估指标。",
        },
    ]


def test_select_candidate_documents_falls_back_when_llm_explicitly_selects_nothing(
    monkeypatch,
):
    docs = _policy_candidate_documents()
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"thinking":"no match","answer":[]}'
        ),
    )

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=3,
        mode="answer",
    )

    assert [doc["id"] for doc in selected] == ["doc_gold"]
    assert selected[0]["_reasonkb_evidence_validation_reason"] == "explicit_empty_probe"
    assert selected.model_outcome == "explicit_empty"
    assert selected.strategy == "explicit_empty_strong_probe"


def test_select_candidate_documents_falls_back_when_all_llm_ids_are_unknown(
    monkeypatch,
):
    docs = _policy_candidate_documents()
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"thinking":"wrong identifiers","answer":["missing_1","missing_2"]}'
        ),
    )

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=3,
        mode="answer",
    )

    assert selected
    assert selected[0]["id"] == "doc_gold"


def test_select_candidate_documents_salvages_valid_ids_and_protects_keyword_anchor(
    monkeypatch,
):
    docs = _policy_candidate_documents()
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"thinking":"one useful document","answer":["doc_support","missing"]}'
        ),
    )

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=3,
        mode="answer",
    )

    assert [doc["id"] for doc in selected] == ["doc_gold", "doc_support"]


def test_evidence_selection_keeps_anchor_without_filling_the_document_budget(
    monkeypatch,
):
    docs = _policy_candidate_documents()
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"thinking":"supporting policy","answer":["doc_support"]}'
        ),
    )

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=3,
        mode="evidence",
    )

    assert [doc["id"] for doc in selected] == ["doc_gold", "doc_support"]


def test_single_document_budget_keeps_the_model_choice_instead_of_the_anchor(
    monkeypatch,
):
    docs = _policy_candidate_documents()
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"thinking":"supporting policy","answer":["doc_support"]}'
        ),
    )

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=1,
        mode="answer",
    )

    assert [doc["id"] for doc in selected] == ["doc_support"]
    assert selected.strategy == "model_only_single_slot"
    assert selected[0][EVIDENCE_VALIDATION_REASON_KEY] == "model_selection"


def test_evidence_selection_uses_bounded_fallback_when_llm_selects_nothing(
    monkeypatch,
):
    docs = _policy_candidate_documents()
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"thinking":"no match","answer":[]}'
        ),
    )

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=5,
        mode="evidence",
    )

    assert [doc["id"] for doc in selected] == ["doc_gold"]
    assert selected[0]["_reasonkb_evidence_validation_reason"] == "explicit_empty_probe"


def test_select_candidate_documents_accepts_short_candidate_aliases(monkeypatch):
    docs = _policy_candidate_documents()

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        assert "D001" in prompt
        return '{"thinking":"first candidate","answer":["D001"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=3,
        mode="answer",
    )

    assert [doc["id"] for doc in selected] == ["doc_gold"]


def test_candidate_selection_prompt_does_not_request_free_text_thinking(monkeypatch):
    docs = _policy_candidate_documents()

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        assert '"thinking"' not in prompt
        assert '"answer"' in prompt
        return '{"answer":["D001"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)

    selected = select_candidate_documents("钻石经销商的PGI评估指标有哪些？", docs)

    assert [doc["id"] for doc in selected] == ["doc_gold"]


def test_select_candidate_documents_falls_back_when_provider_fails(monkeypatch):
    docs = _policy_candidate_documents()

    def failing_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        raise TimeoutError("provider timeout")

    monkeypatch.setattr("pageindex.utils.llm_completion", failing_llm_completion)

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=3,
        mode="answer",
    )

    assert selected
    assert selected[0]["id"] == "doc_gold"
    assert all(
        doc["_reasonkb_evidence_validation_reason"] == "technical_fallback"
        for doc in selected
    )
    assert selected.model_outcome == "provider_error"
    assert selected.strategy == "technical_failure_strong_fallback"


def test_select_candidate_documents_recognizes_wrapped_provider_error(monkeypatch):
    docs = _policy_candidate_documents()
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: ("", "error"),
    )

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=3,
        mode="answer",
    )

    assert selected.model_outcome == "provider_error"
    assert selected.strategy == "technical_failure_strong_fallback"
    assert selected[0]["id"] == "doc_gold"


def test_select_candidate_documents_does_not_treat_invalid_items_as_explicit_empty(
    monkeypatch,
):
    docs = _policy_candidate_documents()
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"answer":[42,""]}'
        ),
    )

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=3,
        mode="answer",
    )

    assert selected.model_outcome == "malformed"
    assert selected.strategy == "technical_failure_strong_fallback"


def test_select_candidate_documents_marks_mixed_valid_and_invalid_items_partial(
    monkeypatch,
):
    docs = _policy_candidate_documents()
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"answer":["D001",42,"missing"]}'
        ),
    )

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=3,
        mode="answer",
    )

    assert [doc["id"] for doc in selected] == ["doc_gold"]
    assert selected.model_outcome == "partial"


def test_select_candidate_documents_marks_truncated_valid_output_partial(monkeypatch):
    docs = _policy_candidate_documents()
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"answer":["D001"]}',
            "max_output_reached",
        ),
    )

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=3,
        mode="evidence",
    )

    assert [doc["id"] for doc in selected] == ["doc_gold"]
    assert selected.model_outcome == "partial"


def test_model_full_budget_is_not_displaced_by_deterministic_anchor(monkeypatch):
    docs = _policy_candidate_documents()
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"answer":["doc_support","doc_related"]}'
        ),
    )

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=2,
        mode="evidence",
    )

    assert [doc["id"] for doc in selected] == ["doc_support", "doc_related"]
    assert selected.strategy == "model_only_full_budget"
    assert all(
        doc[EVIDENCE_VALIDATION_REASON_KEY] == "model_selection" for doc in selected
    )


def test_strong_anchor_runs_after_model_selection_without_page_scan(monkeypatch):
    docs = _policy_candidate_documents()
    events: list[tuple[str, object]] = []
    original = select_documents_module._strong_fallback_select_documents

    def tracking_strong_selection(query, candidates, limit, *, include_page_text=True):
        events.append(("strong", include_page_text))
        return original(
            query,
            candidates,
            limit,
            include_page_text=include_page_text,
        )

    def fake_llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
        events.append(("model", None))
        return '{"answer":["doc_support"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)
    monkeypatch.setattr(
        "services.retrieval_api.select_documents._strong_fallback_select_documents",
        tracking_strong_selection,
    )

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=3,
        mode="answer",
    )

    assert selected
    assert events == [("model", None), ("strong", False)]


def test_candidate_selection_does_not_apply_domain_specific_tier_filters(monkeypatch):
    docs = [
        {
            "id": "doc_silver",
            "project_id": "proj_1",
            "file_name": "银牌经销商发展政策.pdf",
            "doc_description": "银牌经销商的认证要求。",
        },
        {
            "id": "doc_diamond",
            "project_id": "proj_1",
            "file_name": "钻石经销商发展政策.pdf",
            "doc_description": "钻石经销商的认证要求。",
        },
    ]
    prompts = []

    def select_target(model, prompt, chat_history=None, return_finish_reason=False):
        del model, chat_history, return_finish_reason
        prompts.append(prompt)
        assert "银牌经销商发展政策.pdf" in prompt
        assert "钻石经销商发展政策.pdf" in prompt
        return '{"answer":["doc_diamond"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", select_target)

    for query in (
        "我现在是银牌经销商，怎么提升到钻石的",
        "我现在是银牌经销商，怎么提升到钻石",
        "我现在是银牌经销商，怎么提升到钻石经销商",
    ):
        selected = select_candidate_documents(query, docs, limit=3, mode="evidence")
        assert "doc_diamond" in {document["id"] for document in selected}

    assert len(prompts) == 3


def test_model_selection_receives_the_full_candidate_scope(monkeypatch):
    docs = [
        *_policy_candidate_documents(),
        {
            "id": "doc_platinum",
            "project_id": "proj_1",
            "file_name": "铂金经销商PGI评估标准.xlsx",
            "doc_description": "铂金经销商PGI评估指标和评分规则。",
        },
    ]

    def select_platinum(model, prompt, chat_history=None, return_finish_reason=False):
        del model, chat_history, return_finish_reason
        assert "钻石经销商" in prompt
        return '{"answer":["doc_platinum"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", select_platinum)

    selected = select_candidate_documents(
        "铂金经销商的PGI评估指标有哪些？",
        docs,
        limit=3,
        mode="answer",
    )

    assert [doc["id"] for doc in selected] == ["doc_platinum"]
    assert selected.model_outcome == "selected"


def test_model_selection_receives_candidates_with_page_only_keyword_support(monkeypatch):
    docs = [
        {
            "id": "doc_named",
            "project_id": "proj_1",
            "file_name": "钻石经销商PGI评估标准.xlsx",
            "doc_description": "钻石经销商PGI评估指标。",
        },
        {
            "id": "doc_page_only",
            "project_id": "proj_1",
            "file_name": "合作伙伴补充规则.pdf",
            "doc_description": "合作伙伴补充规则。",
            "pages": [
                {"page": 1, "content": "本页规定钻石经销商PGI补充评估指标。"}
            ],
        },
    ]

    def select_both(model, prompt, chat_history=None, return_finish_reason=False):
        del model, chat_history, return_finish_reason
        assert "钻石经销商PGI评估标准.xlsx" in prompt
        assert "合作伙伴补充规则.pdf" in prompt
        return '{"answer":["doc_named","doc_page_only"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", select_both)

    selected = select_candidate_documents(
        "钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=2,
        mode="evidence",
    )

    assert [doc["id"] for doc in selected] == ["doc_named", "doc_page_only"]


def test_domain_negation_is_left_to_model_and_evidence_validation(monkeypatch):
    docs = [
        {
            "id": "doc_diamond",
            "project_id": "proj_1",
            "file_name": "钻石经销商权益.pdf",
            "doc_description": "钻石经销商激励和权益。",
        },
        {
            "id": "doc_gold",
            "project_id": "proj_1",
            "file_name": "金牌经销商权益.pdf",
            "doc_description": "金牌经销商激励和权益。",
        },
    ]

    def select_gold(model, prompt, chat_history=None, return_finish_reason=False):
        del model, chat_history, return_finish_reason
        assert "钻石经销商权益.pdf" in prompt
        assert "金牌经销商权益.pdf" in prompt
        return '{"answer":["doc_gold"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", select_gold)

    for query in (
        "非钻石经销商有哪些权益？",
        "除钻石经销商外，其他经销商有哪些权益？",
    ):
        selected = select_candidate_documents(query, docs, limit=2, mode="answer")
        assert "doc_gold" in {doc["id"] for doc in selected}


def test_model_can_select_multiple_documents_for_comparison(monkeypatch):
    docs = [
        {
            "id": "doc_diamond",
            "project_id": "proj_1",
            "file_name": "钻石经销商权益.pdf",
            "doc_description": "钻石经销商激励和权益。",
        },
        {
            "id": "doc_gold",
            "project_id": "proj_1",
            "file_name": "金牌经销商权益.pdf",
            "doc_description": "金牌经销商激励和权益。",
        },
    ]

    def select_both(model, prompt, chat_history=None, return_finish_reason=False):
        del model, chat_history, return_finish_reason
        assert "钻石经销商权益.pdf" in prompt
        assert "金牌经销商权益.pdf" in prompt
        return '{"answer":["doc_diamond","doc_gold"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", select_both)

    selected = select_candidate_documents(
        "钻石经销商与金牌经销商的权益有什么差异？",
        docs,
        limit=2,
        mode="answer",
    )

    assert [doc["id"] for doc in selected] == ["doc_diamond", "doc_gold"]


def test_range_semantics_are_left_to_model_selection(monkeypatch):
    docs = [
        {
            "id": "doc_diamond",
            "project_id": "proj_1",
            "file_name": "钻石经销商权益.pdf",
            "doc_description": "钻石经销商激励和权益。",
        },
        {
            "id": "doc_gold",
            "project_id": "proj_1",
            "file_name": "金牌经销商权益.pdf",
            "doc_description": "金牌经销商激励和权益。",
        },
    ]

    def select_both(model, prompt, chat_history=None, return_finish_reason=False):
        del model, chat_history, return_finish_reason
        assert "钻石经销商权益.pdf" in prompt
        assert "金牌经销商权益.pdf" in prompt
        return '{"answer":["doc_diamond","doc_gold"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", select_both)

    selected = select_candidate_documents(
        "金牌经销商及以上级别有哪些权益？",
        docs,
        limit=2,
        mode="answer",
    )

    assert [doc["id"] for doc in selected] == ["doc_diamond", "doc_gold"]


def test_explicit_empty_does_not_probe_unrepresented_uppercase_code(monkeypatch):
    docs = _policy_candidate_documents()
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"thinking":"no match","answer":[]}'
        ),
    )

    selected = select_candidate_documents(
        "钻石经销商的XYZ评估指标有哪些？",
        docs,
        limit=3,
        mode="answer",
    )

    assert selected == []
    assert selected.model_outcome == "explicit_empty"
    assert selected.strategy == "explicit_empty_no_strong_match"


def test_explicit_empty_rejects_longer_uppercase_code(monkeypatch):
    docs = [
        {
            "id": "doc_xyz2",
            "project_id": "proj_1",
            "file_name": "钻石经销商XYZ2评估标准.pdf",
            "doc_description": "钻石经销商XYZ2评估指标和评分规则。",
        }
    ]
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"thinking":"no match","answer":[]}'
        ),
    )

    selected = select_candidate_documents(
        "钻石经销商的XYZ评估指标有哪些？",
        docs,
        limit=3,
        mode="answer",
    )

    assert selected == []
    assert selected.strategy == "explicit_empty_no_strong_match"


def test_provider_failure_does_not_treat_all_dealers_as_a_tier(monkeypatch):
    docs = [
        {
            "id": "doc_capability",
            "project_id": "proj_1",
            "file_name": "经销商专业化能力标准.pdf",
            "doc_description": "经销商专业化能力标准和认证要求。",
        }
    ]
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: ("", "error"),
    )

    selected = select_candidate_documents(
        "所有经销商的专业化能力标准？",
        docs,
        limit=3,
        mode="answer",
    )

    assert [doc["id"] for doc in selected] == ["doc_capability"]
    assert selected.strategy == "technical_failure_strong_fallback"


def test_provider_failure_can_retain_multiple_lexical_matches(monkeypatch):
    docs = [
        {
            "id": "doc_gold",
            "project_id": "proj_1",
            "file_name": "金牌经销商激励权益.pdf",
            "doc_description": "金牌经销商激励和权益政策。",
        },
        {
            "id": "doc_silver",
            "project_id": "proj_1",
            "file_name": "银牌经销商激励权益.pdf",
            "doc_description": "银牌经销商激励和权益政策。",
        },
    ]
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: ("", "error"),
    )

    selected = select_candidate_documents(
        "金和银经销商有哪些激励和权益？",
        docs,
        limit=2,
        mode="answer",
    )

    assert {doc["id"] for doc in selected} == {"doc_gold", "doc_silver"}


def test_provider_failure_can_verify_numeric_constraint_in_page_text(monkeypatch):
    docs = [
        {
            "id": "doc_rewards",
            "project_id": "proj_1",
            "file_name": "经销商权益说明.pdf",
            "doc_description": "经销商达到业绩门槛后可获得权益。",
            "pages": [{"page": 1, "content": "业绩达到30万元时，可获得专项权益。"}],
        }
    ]
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: ("", "error"),
    )

    selected = select_candidate_documents(
        "经销商达到30万元时有哪些权益？",
        docs,
        limit=3,
        mode="answer",
    )

    assert [doc["id"] for doc in selected] == ["doc_rewards"]
    assert selected.strategy == "technical_failure_strong_fallback"


def test_provider_failure_rejects_longer_numeric_value(monkeypatch):
    docs = [
        {
            "id": "doc_rewards_130",
            "project_id": "proj_1",
            "file_name": "经销商权益说明.pdf",
            "doc_description": "经销商达到业绩门槛后可获得权益。",
            "pages": [{"page": 1, "content": "业绩达到130万元时，可获得专项权益。"}],
        }
    ]
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: ("", "error"),
    )

    selected = select_candidate_documents(
        "经销商达到30万元时有哪些权益？",
        docs,
        limit=3,
        mode="answer",
    )

    assert selected == []
    assert selected.strategy == "technical_failure_no_strong_match"


def test_provider_failure_scans_late_pages_for_exact_constraints(monkeypatch):
    docs = [
        {
            "id": "doc_rewards_late",
            "project_id": "proj_1",
            "file_name": "经销商权益说明.pdf",
            "doc_description": "经销商达到业绩门槛后可获得权益。",
            "structure": [{"title": "经销商达到万元门槛时的专项权益"}],
            "pages": [
                {"page": 1, "content": "x" * 200001},
                {"page": 2, "content": "业绩达到30万元时，可获得专项权益。"},
            ],
        }
    ]
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: ("", "error"),
    )

    selected = select_candidate_documents(
        "经销商达到30万元时有哪些权益？",
        docs,
        limit=3,
        mode="answer",
    )

    assert [doc["id"] for doc in selected] == ["doc_rewards_late"]
    assert selected.strategy == "technical_failure_strong_fallback"


def test_provider_failure_does_not_probe_unrepresented_year(monkeypatch):
    docs = _policy_candidate_documents()
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: ("", "error"),
    )

    selected = select_candidate_documents(
        "2027年钻石经销商的PGI评估指标有哪些？",
        docs,
        limit=3,
        mode="answer",
    )

    assert selected == []
    assert selected.model_outcome == "provider_error"
    assert selected.strategy == "technical_failure_no_strong_match"


def test_explicit_empty_can_probe_slash_separated_query_terms(monkeypatch):
    docs = [
        {
            "id": "doc_gold_silver",
            "project_id": "proj_1",
            "file_name": "金牌、银牌经销商PGI评估标准.xlsx",
            "doc_description": "金牌、银牌经销商PGI评估指标和评分规则。",
        },
        {
            "id": "doc_diamond",
            "project_id": "proj_1",
            "file_name": "钻石经销商PGI评估标准.xlsx",
            "doc_description": "钻石经销商PGI评估指标和评分规则。",
        },
    ]
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"thinking":"no match","answer":[]}'
        ),
    )

    selected = select_candidate_documents(
        "金/银经销商PGI评估指标有哪些？",
        docs,
        limit=3,
        mode="answer",
    )

    assert [doc["id"] for doc in selected] == ["doc_gold_silver"]
    assert selected.strategy == "explicit_empty_strong_probe"


def test_explicit_empty_selection_stays_empty_without_deterministic_signal(monkeypatch):
    docs = [
        {
            "id": "doc_unrelated",
            "project_id": "proj_1",
            "file_name": "员工通讯录.pdf",
            "doc_description": "员工姓名和联系方式。",
        }
    ]
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"thinking":"unrelated","answer":[]}'
        ),
    )

    selected = select_candidate_documents(
        "quantum telemetry anomaly",
        docs,
        limit=3,
        mode="answer",
    )

    assert selected == []
    assert selected.model_outcome == "explicit_empty"
    assert selected.strategy == "explicit_empty_no_strong_match"


def test_explicit_empty_selection_rejects_weak_generic_overlap(monkeypatch):
    docs = [
        {
            "id": "doc_annual",
            "project_id": "proj_1",
            "file_name": "annual-report.pdf",
            "doc_description": "Annual business report and market discussion.",
        }
    ]
    monkeypatch.setattr(
        "pageindex.utils.llm_completion",
        lambda model, prompt, chat_history=None, return_finish_reason=False: (
            '{"thinking":"no direct support","answer":[]}'
        ),
    )

    selected = select_candidate_documents(
        "生成终验交付报告",
        docs,
        limit=3,
        mode="answer",
    )

    assert selected == []
    assert selected.model_outcome == "explicit_empty"
    assert selected.strategy == "explicit_empty_no_strong_match"
