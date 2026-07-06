import time
from pathlib import Path

from services.common.settings import (
    DB_PATH,
    DIRECTORY_SCAN_INTERVAL_SECONDS,
    PROJECTS_ROOT,
    CORPUS_SOURCE,
    SMB_AUTH_PROTOCOL,
    SMB_BASE_PATH,
    SMB_DOMAIN,
    SMB_HOST,
    SMB_PASSWORD_FILE,
    SMB_PORT,
    SMB_SHARE,
    SMB_USERNAME_FILE,
)
from services.directory_watcher.smb_sync import sync_smb_once
from services.directory_watcher.sync import sync_once
from services.remote_corpus.models import SmbConfig
from services.remote_corpus.smb_source import SmbCorpusSource


def _optional_secret_path(path: str) -> Path | None:
    return Path(path) if path else None


def sync_configured_source() -> dict[str, int]:
    if CORPUS_SOURCE == "smb":
        source = SmbCorpusSource(
            SmbConfig(
                host=SMB_HOST,
                share=SMB_SHARE,
                base_path=SMB_BASE_PATH,
                username_file=_optional_secret_path(SMB_USERNAME_FILE),
                password_file=_optional_secret_path(SMB_PASSWORD_FILE),
                domain=SMB_DOMAIN,
                port=SMB_PORT,
                auth_protocol=SMB_AUTH_PROTOCOL,
            )
        )
        return sync_smb_once(str(DB_PATH), source)
    return sync_once(str(DB_PATH), PROJECTS_ROOT)


def run_forever(poll_seconds: float = DIRECTORY_SCAN_INTERVAL_SECONDS):
    while True:
        sync_configured_source()
        time.sleep(poll_seconds)


if __name__ == "__main__":
    run_forever()
