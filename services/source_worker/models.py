from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Literal, Protocol


AccessDeniedScope = Literal["source", "collection", "subtree", "item"]


class SourceAccessDenied(RuntimeError):
    def __init__(
        self,
        scope: AccessDeniedScope,
        external_id: str | None = None,
        message: str | None = None,
    ) -> None:
        super().__init__(message or f"Source {scope} access denied")
        self.scope = scope
        self.external_id = external_id


@dataclass(frozen=True)
class CollectionDescriptor:
    identity_key: str
    external_id: str
    display_name: str
    root_external_id: str | None = None


@dataclass(frozen=True)
class SourceItemMetadata:
    external_id: str
    parent_external_id: str | None
    item_type: str
    name: str
    relative_path: str
    mime_type: str | None = None
    size_bytes: int | None = None
    source_revision: str | None = None
    fetch_locator: str | None = None
    media_type: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class ExclusionPlan:
    """Immutable source-native identities excluded from one collection scan."""

    collection_excluded: bool = False
    folder_external_ids: frozenset[str] = frozenset()
    document_external_ids: frozenset[str] = frozenset()

    def excludes(self, external_id: str, item_type: str) -> bool:
        if item_type == "folder":
            return external_id in self.folder_external_ids
        if item_type == "document":
            return external_id in self.document_external_ids
        return False


EMPTY_EXCLUSION_PLAN = ExclusionPlan()


class CorpusConnector(Protocol):
    kind: str

    def validate(self) -> None:
        ...

    def discover_collections(self) -> Iterator[CollectionDescriptor]:
        ...

    def scan_collection(
        self,
        collection: CollectionDescriptor,
        exclusions: ExclusionPlan = EMPTY_EXCLUSION_PLAN,
    ) -> Iterator[SourceItemMetadata]:
        ...

    def fetch_item(
        self,
        item: SourceItemMetadata,
        destination: Path,
        expected_revision: str,
        maximum_bytes: int,
    ) -> None:
        ...
