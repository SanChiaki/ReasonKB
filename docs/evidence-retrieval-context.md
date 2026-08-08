# ReasonKB Evidence Retrieval

ReasonKB retrieves private knowledge for agents and reports what the retrieved source material can and cannot support.

## Language

**EvidenceSet**:
The grounded evidence collected for one original query, together with its coverage assessment.
_Avoid_: Search result, answer context

**EvidenceUnit**:
A source-backed, independently citable piece of an EvidenceSet with precise document and page provenance.
_Avoid_: Snippet, chunk

**Provisional Evidence**:
Retrieved source material that may participate in later cross-document grounding but is not eligible for return to a caller yet.
_Avoid_: Rejected evidence, failed evidence

**CoverageAspect**:
A material part or qualifier of the original query used to describe which needs are supported and which remain unresolved.
_Avoid_: Subquestion, generated query

**Coverage Status**:
Whether an EvidenceSet supports all, some, none, or an unknown portion of the original query.
_Avoid_: Retrieval status, confidence

**Retrieval Status**:
Whether retrieval produced grounded evidence, produced no match, or was technically degraded.
_Avoid_: Coverage status, answer status
