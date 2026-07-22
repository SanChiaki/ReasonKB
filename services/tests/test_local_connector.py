from pathlib import Path

import pytest

from services.source_worker.connectors.local import LocalConnector
from services.source_worker.models import ExclusionPlan


def test_discovers_top_level_and_root_collections(tmp_path):
    root = tmp_path / "sources"
    (root / "Engineering").mkdir(parents=True)
    (root / "Finance").mkdir()
    (root / "root-report.md").write_text("root", encoding="utf-8")
    (root / ".hidden").mkdir()

    connector = LocalConnector(root, tmp_path)

    assert [
        (collection.external_id, collection.display_name)
        for collection in connector.discover_collections()
    ] == [
        ("Engineering", "Engineering"),
        ("Finance", "Finance"),
        ("__root__", "Root Collection"),
    ]


def test_streams_folder_and_document_metadata_without_hashing_content(tmp_path):
    root = tmp_path / "sources"
    project = root / "Engineering"
    (project / "design").mkdir(parents=True)
    report = project / "design" / "report.md"
    report.write_text("architecture", encoding="utf-8")
    (project / "unsupported.bin").write_bytes(b"binary")

    connector = LocalConnector(root, tmp_path)
    collection = next(connector.discover_collections())
    items = list(connector.scan_collection(collection))

    assert [(item.item_type, item.external_id) for item in items] == [
        ("folder", "Engineering/design"),
        ("document", "Engineering/design/report.md"),
        ("document", "Engineering/unsupported.bin"),
    ]
    document = items[1]
    assert document.parent_external_id == "Engineering/design"
    assert document.relative_path == "design/report.md"
    assert document.source_revision.startswith("local:")
    assert "sha" not in document.source_revision
    assert items[2].media_type == "unsupported"


def test_does_not_follow_symbolic_links(tmp_path):
    root = tmp_path / "sources"
    project = root / "Engineering"
    outside = tmp_path / "outside"
    project.mkdir(parents=True)
    outside.mkdir()
    (outside / "secret.md").write_text("secret", encoding="utf-8")
    try:
        (project / "linked").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symbolic links are not available")

    connector = LocalConnector(root, tmp_path)
    collection = next(connector.discover_collections())

    assert list(connector.scan_collection(collection)) == []


def test_excluded_folder_is_observed_without_traversing_descendants(tmp_path):
    root = tmp_path / "sources"
    project = root / "Engineering"
    (project / "archive").mkdir(parents=True)
    (project / "archive" / "old.md").write_text("old", encoding="utf-8")
    (project / "current.md").write_text("current", encoding="utf-8")
    connector = LocalConnector(root, tmp_path)
    collection = next(connector.discover_collections())

    items = list(
        connector.scan_collection(
            collection,
            ExclusionPlan(folder_external_ids=frozenset({"Engineering/archive"})),
        )
    )

    assert [(item.item_type, item.external_id) for item in items] == [
        ("folder", "Engineering/archive"),
        ("document", "Engineering/current.md"),
    ]


def test_fetches_only_the_expected_revision_with_a_size_bound(tmp_path):
    root = tmp_path / "sources"
    project = root / "Engineering"
    project.mkdir(parents=True)
    report = project / "report.md"
    report.write_text("first", encoding="utf-8")
    connector = LocalConnector(root, tmp_path)
    collection = next(connector.discover_collections())
    item = next(connector.scan_collection(collection))
    destination = tmp_path / "download" / "report.md"

    connector.fetch_item(item, destination, item.source_revision or "", 100)
    assert destination.read_text(encoding="utf-8") == "first"

    report.write_text("a changed revision", encoding="utf-8")
    with pytest.raises(RuntimeError, match="revision changed"):
        connector.fetch_item(item, destination, item.source_revision or "", 100)

    changed = next(connector.scan_collection(collection))
    with pytest.raises(ValueError, match="size limit"):
        connector.fetch_item(changed, destination, changed.source_revision or "", 2)


def test_rejects_roots_outside_the_access_boundary(tmp_path):
    access_root = tmp_path / "allowed"
    outside = tmp_path / "outside"
    access_root.mkdir()
    outside.mkdir()

    with pytest.raises(ValueError, match="outside"):
        LocalConnector(outside, access_root).validate()
