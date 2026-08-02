from typing import Any, NotRequired, TypedDict


class IndexedPage(TypedDict):
    page: int
    content: str


class IndexedDocumentPayload(TypedDict):
    doc_name: str
    doc_description: str
    structure: list[dict]
    pages: list[IndexedPage]
    page_count: int
    evidence_kind: NotRequired[str]
    visual_assets: NotRequired[list[dict[str, Any]]]
    source_metadata: NotRequired[dict[str, Any]]
    page_blocks: NotRequired[list[dict[str, Any]]]
    index_version: NotRequired[str]
