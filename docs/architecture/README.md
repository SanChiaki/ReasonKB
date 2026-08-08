# ReasonKB System Atlas

[System Atlas](reasonkb-system-atlas.html) is the maintained architecture and
retrieval view. It maps the current runtime topology, observable retrieval
events, decision gates, four retrieval outcomes, and the final `answer` and
`evidence` outputs.

The HTML file is the editable source of truth. After changing it, verify both
views, all four outcome controls, and desktop plus narrow layouts in a browser.

## Retrieval Outcomes

| Case | What happened | Condition to proceed or stop | Final result |
| --- | --- | --- | --- |
| No candidate documents | Ready documents were loaded, but routing returned no usable candidate. | Stop immediately after `documents_selected`. | `no_match`, or `degraded` when routing failed technically. |
| Candidate documents exist | Routing produced at least one candidate. This is an intermediate state, not evidence. | Hydrate the current indexes and start evidence waves. | Continue to document navigation and EvidenceSet assessment. |
| Candidates, no grounded evidence | Candidate pages were inspected, but no page survived grounding, or all candidates were exhausted. | Continue while candidates remain and the request deadline permits; otherwise stop. | Empty EvidenceSet with `no_match`; technical assessment failure is `degraded`. |
| Candidates and grounded evidence | At least one precise page range was accepted as supporting an aspect of the original query. | Stop when coverage is complete, candidates are exhausted, or retrieval degrades. | EvidenceSet with provenance and coverage; `answer` mode also synthesizes an answer and citations. |

Candidate relevance and evidence acceptance are deliberately separate. PageIndex
navigates document trees and pages. ReasonKB owns cross-document grounding,
coverage, provenance, and final retrieval status.

## Observable Event Sequence

The synchronous and SSE adapters share `_execute_retrieval_events()`. A normal
request emits these stages in order, with document and wave events repeated as
needed:

```text
retrieval_started
documents_loaded
document_selection_started
documents_selected
evidence_started
evidence_wave_started
document_evidence_started
document_pages_selected (one or more rounds)
document_evidence_pending_validation | document_evidence_skipped
evidence_wave_completed
evidence_set_assessment_started
evidence_set_assessment_completed
answer_generation_started/completed (answer mode only)
retrieval_completed
result
```

## Diagram Impact Protocol

Every agent completing a code change must run:

```sh
python3 scripts/check_diagram_impact.py --base origin/main
```

Exit code `0` means no maintained diagram path was affected. Exit code `2`
means the agent must inspect the reported changes and make one explicit decision:

1. Update `docs/architecture/reasonkb-system-atlas.html` and browser-test its
   architecture view, retrieval view, four outcomes, and responsive layout when
   topology, ownership, events, decisions, status semantics, or outputs changed.
2. Leave the atlas unchanged and state why the changed code does not alter the
   behavior represented by it.

The checker is intentionally a review trigger rather than an automatic semantic
editor. Path matching can identify likely impact; only an agent reviewing the
code can decide whether the diagram's meaning changed.

## Code Sources

The architecture view is grounded in `docker/compose.yml`, service entrypoints,
`README.md`, and the Web/Agent/MCP routes. The retrieval view is grounded in:

- `services/retrieval_api/app.py`
- `services/retrieval_api/query_engine.py`
- `services/retrieval_api/select_documents.py`
- `services/retrieval_api/schemas.py`
- `web/lib/retrieval-client.ts`
- `web/app/api/agent/query/route.ts`
- `web/app/api/agent/evidence/route.ts`
