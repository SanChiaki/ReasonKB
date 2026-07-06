from __future__ import annotations

import mimetypes
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from services.directory_watcher.sync import IGNORED_NAMES, SUPPORTED_MEDIA_BY_EXTENSION
from services.remote_corpus.models import RemoteCorpusFile, SmbConfig
from services.remote_corpus.smb_paths import build_smb_source_root, build_smb_url

CHUNK_SIZE = 1024 * 1024


class SmbCorpusSource:
    def __init__(self, config: SmbConfig, *, smbclient_module: Any | None = None):
        self.config = config
        self._smbclient = smbclient_module
        self._registered = False

    @property
    def smbclient(self) -> Any:
        if self._smbclient is None:
            import smbclient

            self._smbclient = smbclient
        return self._smbclient

    def list_files(self) -> list[RemoteCorpusFile]:
        self._ensure_session()
        root = self._root_url()
        files: list[RemoteCorpusFile] = []
        self._walk(root, "", files)
        return files

    def fetch_file(self, source_relative_path: str, destination: Path) -> None:
        self._ensure_session()
        remote_path = build_smb_url(
            self.config.host,
            self.config.share,
            self._join_paths(self.config.base_path, source_relative_path),
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        with self.smbclient.open_file(remote_path, mode="rb") as source:
            with destination.open("wb") as target:
                while chunk := source.read(CHUNK_SIZE):
                    target.write(chunk)
                    if len(chunk) < CHUNK_SIZE:
                        break

    def _ensure_session(self) -> None:
        if self._registered:
            return
        username = self._read_secret(self.config.username_file)
        password = self._read_secret(self.config.password_file)
        if username and self.config.domain:
            username = f"{self.config.domain}\\{username}"
        self.smbclient.register_session(
            self.config.host,
            username=username,
            password=password,
            port=self.config.port,
            auth_protocol=self.config.auth_protocol,
        )
        self._registered = True

    def _walk(self, remote_path: str, relative_path: str, files: list[RemoteCorpusFile]) -> None:
        for entry in self.smbclient.scandir(remote_path):
            name = entry.name
            if self._is_ignored_name(name):
                continue
            child_relative_path = self._join_paths(relative_path, name)
            if entry.is_dir():
                self._walk(entry.path, child_relative_path, files)
                continue
            if entry.is_file():
                file = self._classify_file(entry, child_relative_path)
                if file is not None:
                    files.append(file)

    def _classify_file(self, entry: Any, source_relative_path: str) -> RemoteCorpusFile | None:
        relative = PurePosixPath(source_relative_path)
        if len(relative.parts) < 2:
            return None
        media_type = SUPPORTED_MEDIA_BY_EXTENSION.get(relative.suffix.lower(), "unsupported")
        if media_type == "unsupported":
            return None
        stat = entry.stat()
        return RemoteCorpusFile(
            locator=entry.path,
            project_name=relative.parts[0],
            source_root=build_smb_source_root(
                self.config.host,
                self.config.share,
                self.config.base_path,
            ),
            source_relative_path=relative.as_posix(),
            project_relative_path=PurePosixPath(*relative.parts[1:]).as_posix(),
            file_name=relative.name,
            media_type=media_type,
            mime_type=mimetypes.guess_type(relative.name)[0] or "application/octet-stream",
            size=stat.st_size,
            mtime=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        )

    def _root_url(self) -> str:
        return build_smb_url(self.config.host, self.config.share, self.config.base_path)

    @staticmethod
    def _read_secret(path: Path | None) -> str | None:
        if path is None:
            return None
        return path.read_text(encoding="utf-8").strip()

    @staticmethod
    def _join_paths(*parts: str) -> str:
        clean_parts: list[str] = []
        for part in parts:
            clean_parts.extend(segment for segment in part.replace("\\", "/").split("/") if segment)
        return "/".join(clean_parts)

    @staticmethod
    def _is_ignored_name(name: str) -> bool:
        return name.startswith(".") or name in IGNORED_NAMES
