from __future__ import annotations

import argparse
import time
from pathlib import Path


def write_worker_heartbeat(path: str | Path) -> None:
    heartbeat = Path(path)
    heartbeat.parent.mkdir(parents=True, exist_ok=True)
    heartbeat.touch()


def worker_heartbeat_is_fresh(
    path: str | Path,
    maximum_age_seconds: float,
    now: float | None = None,
) -> bool:
    try:
        modified_at = Path(path).stat().st_mtime
    except FileNotFoundError:
        return False
    return (now if now is not None else time.time()) - modified_at <= maximum_age_seconds


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("maximum_age_seconds", type=float)
    args = parser.parse_args()
    return 0 if worker_heartbeat_is_fresh(args.path, args.maximum_age_seconds) else 1


if __name__ == "__main__":
    raise SystemExit(main())
