from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_pageindex_upstream_code_lives_under_vendor_tree():
    assert (ROOT / "vendor" / "pageindex" / "pageindex" / "__init__.py").is_file()
    assert not (ROOT / "pageindex" / "page_index.py").exists()
    assert not (ROOT / "pageindex" / "utils.py").exists()
    assert (ROOT / "pageindex" / "__init__.py").is_file()


def test_vendor_tree_records_upstream_source():
    readme = ROOT / "vendor" / "pageindex" / "README.md"
    assert readme.is_file()
    assert "PageIndex" in readme.read_text(encoding="utf-8")
