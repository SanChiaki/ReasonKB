#!/usr/bin/env python3
"""Report which maintained diagrams may be affected by a code change."""

from __future__ import annotations

import argparse
import fnmatch
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIAGRAMS = {
    "reasonkb-system-atlas": (
        "docker/compose*.yml",
        "docker/entrypoints/**",
        "services/source_worker/**",
        "services/index_worker/**",
        "services/common/settings.py",
        "web/app/api/**",
        "tools/reasonkb-*.mjs",
        "services/retrieval_api/app.py",
        "services/retrieval_api/query_engine.py",
        "services/retrieval_api/schemas.py",
        "services/retrieval_api/select_documents.py",
        "services/common/document_search.py",
        "services/common/semantic_index.py",
        "web/lib/retrieval-client.ts",
        "web/app/api/agent/query/route.ts",
        "web/app/api/agent/evidence/route.ts",
    ),
}


def affected_diagrams(paths: list[str]) -> dict[str, list[str]]:
    affected: dict[str, list[str]] = {}
    for diagram, patterns in DIAGRAMS.items():
        matches = sorted(
            path for path in paths if any(fnmatch.fnmatch(path, pattern) for pattern in patterns)
        )
        if matches:
            affected[diagram] = matches
    return affected


def git_changed_paths(base: str) -> list[str]:
    merge_base = subprocess.check_output(
        ["git", "merge-base", base, "HEAD"], cwd=ROOT, text=True
    ).strip()
    commands = (
        ["git", "diff", "--name-only", f"{merge_base}...HEAD"],
        ["git", "diff", "--name-only"],
        ["git", "diff", "--name-only", "--cached"],
    )
    paths: set[str] = set()
    for command in commands:
        output = subprocess.check_output(command, cwd=ROOT, text=True)
        paths.update(line.strip() for line in output.splitlines() if line.strip())
    return sorted(paths)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="origin/main")
    parser.add_argument("--paths", nargs="*", help="classify explicit paths instead of git diff")
    args = parser.parse_args()
    paths = args.paths if args.paths is not None else git_changed_paths(args.base)
    affected = affected_diagrams(paths)
    if not affected:
        print("Diagram impact: none detected.")
        return 0
    print("Diagram impact review required:")
    for diagram, matches in affected.items():
        print(f"- {diagram}: {', '.join(matches)}")
    print("Agent decision: update the diagram, or explain why behavior/topology is unchanged.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
