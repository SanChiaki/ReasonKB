from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
VENDOR_PAGEINDEX_ROOT = REPO_ROOT / "vendor" / "pageindex"


def ensure_pageindex_vendor_path() -> None:
    vendor_path = str(VENDOR_PAGEINDEX_ROOT)
    if vendor_path not in sys.path:
        sys.path.insert(0, vendor_path)

