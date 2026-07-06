from dataclasses import dataclass
from pathlib import PurePosixPath
import re
from urllib.parse import quote

_UNSAFE_FILE_NAME_CHARS = re.compile(r"[^A-Za-z0-9._-]")


@dataclass(frozen=True)
class SmbSharePath:
    host: str
    share: str
    base_path: str = ""


def _normalize_path_parts(path: str) -> list[str]:
    normalized = path.strip().replace("\\", "/")
    while normalized.startswith("/"):
        normalized = normalized[1:]
    return [part for part in normalized.split("/") if part]


def parse_smb_share_path(path: str) -> SmbSharePath:
    parts = _normalize_path_parts(path)
    if len(parts) < 2:
        raise ValueError("SMB path must include a host and share")
    return SmbSharePath(
        host=parts[0],
        share=parts[1],
        base_path="/".join(parts[2:]),
    )


def build_smb_source_root(host: str, share: str, base_path: str = "") -> str:
    root = f"smb://{host}/{quote(share, safe='')}"
    parts = _normalize_path_parts(base_path)
    if parts:
        root += "/" + "/".join(quote(part, safe="") for part in parts)
    return root


def build_smb_url(host: str, share: str, path: str = "") -> str:
    url = f"//{host}/{share}"
    parts = _normalize_path_parts(path)
    if parts:
        url += "/" + "/".join(parts)
    return url


def safe_cache_file_name(source_relative_path: str) -> str:
    name = PurePosixPath(source_relative_path.replace("\\", "/")).name
    if not name or name.startswith("."):
        return "downloaded-file"
    return _UNSAFE_FILE_NAME_CHARS.sub("_", name)
