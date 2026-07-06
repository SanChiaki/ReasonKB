from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SmbConfig:
    host: str
    share: str
    base_path: str = ""
    username_file: Path | None = None
    password_file: Path | None = None
    domain: str = ""
    port: int = 445
    auth_protocol: str = "ntlm"


@dataclass(frozen=True)
class RemoteCorpusFile:
    locator: str
    project_name: str
    source_root: str
    source_relative_path: str
    project_relative_path: str
    file_name: str
    media_type: str
    mime_type: str
    size: int
    mtime: str
