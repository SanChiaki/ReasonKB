import os
import time

import pytest

from services.common.source_credentials import validate_master_key_file
from services.common.worker_health import (
    worker_heartbeat_is_fresh,
    write_worker_heartbeat,
)


def test_master_key_startup_check_rejects_group_or_world_access(tmp_path):
    key_path = tmp_path / "master.key"
    key_path.write_bytes(os.urandom(32))
    key_path.chmod(0o644)

    with pytest.raises(PermissionError, match="group or other access"):
        validate_master_key_file(key_path)

    key_path.chmod(0o600)
    assert validate_master_key_file(key_path) == key_path.read_bytes()


def test_worker_heartbeat_reports_missing_stale_and_fresh_files(tmp_path):
    heartbeat = tmp_path / "worker.heartbeat"
    assert not worker_heartbeat_is_fresh(heartbeat, 120, now=time.time())

    write_worker_heartbeat(heartbeat)
    modified_at = heartbeat.stat().st_mtime

    assert worker_heartbeat_is_fresh(heartbeat, 120, now=modified_at + 119)
    assert not worker_heartbeat_is_fresh(heartbeat, 120, now=modified_at + 121)
