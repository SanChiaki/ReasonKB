from services.retrieval_api.select_documents import (
    EVIDENCE_VALIDATION_REASON_KEY,
    keyword_score,
    prefilter_candidate_documents,
    select_candidate_documents,
)


def test_keyword_score_prefers_matching_description():
    query = "cash flow risk"
    doc = {
        "id": "doc_1",
        "project_id": "proj_1",
        "file_name": "alpha.pdf",
        "doc_description": "Cash flow risk factors and debt covenants",
    }

    assert keyword_score(query, doc) > 0


def test_keyword_score_matches_project_relative_path():
    doc = {
        "id": "doc_1",
        "project_id": "proj_1",
        "file_name": "report.pdf",
        "project_name": "Alpha",
        "project_relative_path": "delivery/acceptance/report.pdf",
        "source_relative_path": "Alpha/delivery/acceptance/report.pdf",
        "doc_description": "Network delivery evidence.",
    }

    assert keyword_score("acceptance handover", doc) > 0


def test_keyword_score_matches_pageindex_structure_title():
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

    assert keyword_score("生成终验报告", doc) > 0


def test_prefilter_candidate_documents_removes_unrelated_documents_before_llm():
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

    selected = prefilter_candidate_documents("生成终验交付报告", docs, limit=10)

    assert [doc["id"] for doc in selected] == ["doc_handover", "doc_quality"]


def test_prefilter_does_not_match_latin_query_expansions_inside_other_words():
    docs = [
        {
            "id": "doc_design",
            "project_id": "proj_1",
            "project_name": "office-test",
            "file_name": "detailed-design-report.pdf",
            "project_relative_path": "design/detailed-design-report.pdf",
            "source_relative_path": "office-test/design/detailed-design-report.pdf",
            "doc_description": "Architecture design report and implementation notes.",
        },
        {
            "id": "doc_annual",
            "project_id": "proj_1",
            "project_name": "office-test",
            "file_name": "annual-report.pdf",
            "project_relative_path": "annual-report.pdf",
            "source_relative_path": "office-test/annual-report.pdf",
            "doc_description": "Annual business report and market discussion.",
            "structure": [{"title": "Delivery of shareholder documents"}],
        },
        {
            "id": "doc_handover",
            "project_id": "proj_2",
            "project_name": "Alpha",
            "file_name": "final-acceptance-handover.pdf",
            "project_relative_path": "delivery/final-acceptance-handover.pdf",
            "source_relative_path": "Alpha/delivery/final-acceptance-handover.pdf",
            "doc_description": "Final acceptance handover report and sign-off checklist.",
        },
    ]

    selected = prefilter_candidate_documents("生成终验交付报告", docs, limit=10)

    assert [doc["id"] for doc in selected] == ["doc_handover"]


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
        assert "finance-0.pdf" not in prompt
        assert "finance-59.pdf" not in prompt
        return '{"thinking":"acceptance handover matches","answer":["doc_acceptance"]}'

    monkeypatch.setattr("pageindex.utils.llm_completion", fake_llm_completion)

    selected = select_candidate_documents(
        "生成终验交付报告",
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
