from __future__ import annotations

import json
from pathlib import Path

from services.source_worker.connectors.local import LocalConnector
from services.source_worker.connectors.seeyon import SeeyonConnector
from services.source_worker.connectors.smb import SmbConnector
from services.source_worker.models import CorpusConnector


def build_connector(
    source: dict[str, object],
    local_access_root: str | Path,
    credentials: dict[str, object] | None = None,
) -> CorpusConnector:
    kind = str(source["kind"])
    scope = json.loads(str(source["scope_json"]))
    if kind == "local":
        return LocalConnector(str(scope["rootPath"]), local_access_root)
    if kind == "seeyon":
        config = json.loads(str(source["config_json"]))
        secrets = credentials or {}
        return SeeyonConnector(
            str(scope["endpoint"]),
            str(config["loginName"]),
            str(secrets["username"]),
            str(secrets["password"]),
            token_cache_key=(
                f"{source.get('source_id') or source.get('id')}:{source.get('config_revision')}"
            ),
        )
    if kind == "smb":
        config = json.loads(str(source["config_json"]))
        secrets = credentials or {}
        return SmbConnector(
            host=str(scope["host"]),
            share=str(scope["share"]),
            base_path=str(scope.get("basePath", "")),
            port=int(scope.get("port", 445)),
            auth_protocol=str(config.get("authProtocol", "ntlm")),
            username=str(secrets.get("username", "")),
            password=str(secrets.get("password", "")),
            domain=str(secrets.get("domain", "")),
        )
    raise NotImplementedError(f"Corpus connector is not implemented: {kind}")
