from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_root_layout_keeps_product_boundary_small():
    allowed_entries = {
        ".dockerignore",
        ".gitignore",
        ".gitattributes",
        ".reasonkb",
        ".venv",
        "AGENTS.md",
        "Dockerfile",
        "README.md",
        "docker",
        "docs",
        "LICENSE",
        "patches",
        "services",
        "vendor",
        "web",
    }

    root_entries = {
        path.name
        for path in ROOT.iterdir()
        if path.name != ".git" and not path.name.startswith(".pytest_cache")
    }

    assert root_entries <= allowed_entries


def test_pageindex_upstream_code_lives_under_vendor_tree():
    assert (ROOT / "vendor" / "pageindex" / "pageindex" / "__init__.py").is_file()
    assert not (ROOT / "pageindex").exists()


def test_vendor_tree_records_upstream_source():
    readme = ROOT / "vendor" / "pageindex" / "README.md"
    assert readme.is_file()
    assert "PageIndex" in readme.read_text(encoding="utf-8")


def test_pageindex_patch_boundary_is_explicit():
    patch_index = ROOT / "patches" / "pageindex" / "README.md"
    assert patch_index.is_file()
    assert "services/common/pageindex_runtime.py" in patch_index.read_text(encoding="utf-8")
