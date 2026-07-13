import signal
import sys
import time
import os

from services.common.settings import (
    DB_PATH,
    LOCAL_SOURCE_ACCESS_ROOT,
    MASTER_KEY_PATH,
    SOURCE_WORKER_POLL_SECONDS,
)
from services.common.worker_health import write_worker_heartbeat
from services.source_worker.engine import SourceWorkerEngine
from services.source_worker.maintenance import SourceMaintenance


def run_forever(poll_seconds: float = SOURCE_WORKER_POLL_SECONDS) -> None:
    heartbeat_path = os.environ.get(
        "REASONKB_WORKER_HEARTBEAT_FILE", "/tmp/reasonkb-source-worker.heartbeat"
    )
    engine = SourceWorkerEngine(
        str(DB_PATH),
        LOCAL_SOURCE_ACCESS_ROOT,
        MASTER_KEY_PATH,
        progress_callback=lambda: write_worker_heartbeat(heartbeat_path),
    )
    maintenance = SourceMaintenance(str(DB_PATH))
    engine.recover_abandoned_work()
    next_maintenance_at = 0.0
    next_purge_check_at = 0.0
    while True:
        write_worker_heartbeat(heartbeat_path)
        try:
            summary = engine.run_once()
            if time.monotonic() >= next_purge_check_at:
                maintenance.run_due_purges()
                next_purge_check_at = time.monotonic() + 5
            if time.monotonic() >= next_maintenance_at:
                maintenance.run_once()
                next_maintenance_at = time.monotonic() + 60 * 60
        except Exception as error:
            print(f"source worker failed: {_safe_error(error)}", file=sys.stderr)
            time.sleep(poll_seconds)
            continue
        if not any(summary.values()):
            time.sleep(poll_seconds)


def _safe_error(error: Exception) -> str:
    message = str(error)
    if any(term in message.lower() for term in ("password", "secret", "credential", "token")):
        return f"{type(error).__name__}: details redacted"
    return f"{type(error).__name__}: {message}"


def _shutdown(signum, frame):
    raise SystemExit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)
    run_forever()
