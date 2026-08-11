import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_root_layout_keeps_product_boundary_small():
    allowed_entries = {
        ".dockerignore",
        ".gitignore",
        ".gitattributes",
        ".python-version",
        ".reasonkb",
        ".venv",
        "AGENTS.md",
        "Dockerfile",
        "README.md",
        "docker",
        "docs",
        "LICENSE",
        "patches",
        "pyproject.toml",
        "scripts",
        "services",
        "tools",
        "vendor",
        "web",
        "uv.lock",
    }

    root_entries = {
        path.name
        for path in ROOT.iterdir()
        if path.name != ".git" and not path.name.startswith(".pytest_cache")
    }

    assert root_entries <= allowed_entries


def test_reasonkb_dependencies_have_one_locked_root_manifest():
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert pyproject["project"]["requires-python"] == ">=3.11,<3.14"
    assert pyproject["dependency-groups"]["dev"] == ["pytest>=8,<9"]
    assert pyproject["tool"]["uv"] == {
        "package": False,
        "required-version": "==0.12.1",
    }
    assert (ROOT / ".python-version").read_text(encoding="utf-8").strip() == "3.12"
    assert (ROOT / "uv.lock").is_file()
    assert not (ROOT / "services" / "requirements.txt").exists()
    assert (ROOT / "vendor" / "pageindex" / "requirements.txt").is_file()


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
