# SMB Remote Corpus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an unprivileged SMB corpus source that scans remote metadata with `mtime + size`, queues index jobs for changes, and downloads only the target file during indexing.

**Architecture:** Keep the existing local-directory corpus path unchanged. Add a focused SMB corpus source module with `list_files()` and `fetch_file()` behavior, route `REASONKB_CORPUS_SOURCE=smb` through a new SMB sync path, and adapt the index worker to materialize SMB files into a temporary local cache before invoking the existing payload builders.

**Tech Stack:** Python 3, FastAPI worker modules, SQLite schema/migrations, `smbprotocol==1.16.1`, Docker Compose, POSIX `sh` installer tests.

---

## File Map

- Modify `services/requirements.txt`: add `smbprotocol==1.16.1`.
- Modify `services/common/settings.py`: add corpus source, SMB credential file paths, SMB connection config, and remote cache root.
- Modify `web/lib/db/schema.sql`: add the SMB active-document unique index.
- Create `services/remote_corpus/__init__.py`: package marker.
- Create `services/remote_corpus/models.py`: `RemoteCorpusFile` and `SmbConfig` dataclasses.
- Create `services/remote_corpus/smb_paths.py`: parse UNC/slash SMB paths, build canonical source roots and SMB URLs, sanitize cache file names.
- Create `services/remote_corpus/smb_source.py`: lazy `smbclient` adapter for listing metadata and fetching one file.
- Modify `services/directory_watcher/sync.py`: generalize document upsert/delete helpers so both local and SMB metadata can use them.
- Create `services/directory_watcher/smb_sync.py`: run one SMB metadata sync and return the existing summary shape.
- Modify `services/directory_watcher/worker.py`: switch between local and SMB sync based on `CORPUS_SOURCE`.
- Create `services/index_worker/remote_fetch.py`: context manager that gives the indexer a local path for local or SMB documents.
- Modify `services/index_worker/index_document.py`: use `remote_fetch` before payload building and persist the real SMB content hash after successful download.
- Modify `docker/compose.yml` and `docker/compose.release.yml`: pass SMB env vars and mount secrets read-only into `directory-watcher` and `index-worker`.
- Modify `docker/install.sh`: support local vs SMB corpus configuration, parse SMB paths, write secret files, and hide passwords.
- Modify `services/tests/test_directory_sync.py`: cover generalized local sync remains unchanged.
- Create `services/tests/test_smb_paths.py`: parse/format/sanitize coverage.
- Create `services/tests/test_smb_source.py`: fake `smbclient` adapter coverage without a live SMB server.
- Create `services/tests/test_smb_sync.py`: database sync behavior from metadata only.
- Modify `services/tests/test_index_document.py`: SMB fetch and download-failure coverage.
- Modify `services/tests/test_docker_release_packaging.py`: compose and installer SMB coverage.
- Modify `README.md` and `docs/deployment.md`: document SMB env/secret install flow and the Settings UI follow-up.

## Task 1: Configuration, Dependency, And Schema

**Files:**
- Modify: `services/requirements.txt`
- Modify: `services/common/settings.py`
- Modify: `web/lib/db/schema.sql`
- Test: `services/tests/test_smb_paths.py`

- [ ] **Step 1: Write failing settings/schema tests**

Create `services/tests/test_smb_paths.py` with the settings assertions first; path parsing tests are expanded in Task 2.

```python
from pathlib import Path
import sqlite3

from services.common import settings


def test_smb_settings_defaults_to_local_source(monkeypatch):
    monkeypatch.delenv("REASONKB_CORPUS_SOURCE", raising=False)
    assert settings.corpus_source_from_env({}) == "local"


def test_smb_settings_reads_source_and_cache_root(monkeypatch, tmp_path):
    env = {
        "REASONKB_CORPUS_SOURCE": "smb",
        "REASONKB_REMOTE_CACHE_ROOT": str(tmp_path / "cache"),
    }

    assert settings.corpus_source_from_env(env) == "smb"
    assert settings.remote_cache_root_from_env(env) == tmp_path / "cache"


def test_schema_has_active_smb_document_unique_index(tmp_path):
    repo_root = Path(__file__).resolve().parents[2]
    schema_sql = (repo_root / "web" / "lib" / "db" / "schema.sql").read_text(encoding="utf-8")
    db_path = tmp_path / "app.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(schema_sql)

    indexes = conn.execute("PRAGMA index_list(documents)").fetchall()
    conn.close()

    index_names = {row[1] for row in indexes}
    assert "idx_documents_smb_source_relative_path" in index_names
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
python -m pytest services/tests/test_smb_paths.py -q
```

Expected: FAIL because `corpus_source_from_env`, `remote_cache_root_from_env`, and the SMB index do not exist.

- [ ] **Step 3: Add dependency**

Append this exact line to `services/requirements.txt`:

```text
smbprotocol==1.16.1
```

`smbprotocol` 1.16.1 is the current PyPI/GitHub release checked during planning; pinning avoids accidental behavior changes while implementing.

- [ ] **Step 4: Add settings helpers and constants**

Modify `services/common/settings.py` to include:

```python
def corpus_source_from_env(env: dict[str, str] | None = None) -> str:
    values = env if env is not None else os.environ
    source = values.get("REASONKB_CORPUS_SOURCE", "local").strip().lower()
    return source or "local"


def remote_cache_root_from_env(env: dict[str, str] | None = None) -> Path:
    values = env if env is not None else os.environ
    return Path(values.get("REASONKB_REMOTE_CACHE_ROOT", VAR_ROOT / "remote-cache"))


CORPUS_SOURCE = corpus_source_from_env()
REMOTE_CACHE_ROOT = remote_cache_root_from_env()
SMB_HOST = os.getenv("REASONKB_SMB_HOST", "")
SMB_SHARE = os.getenv("REASONKB_SMB_SHARE", "")
SMB_BASE_PATH = os.getenv("REASONKB_SMB_BASE_PATH", "")
SMB_USERNAME_FILE = os.getenv("REASONKB_SMB_USERNAME_FILE", "")
SMB_PASSWORD_FILE = os.getenv("REASONKB_SMB_PASSWORD_FILE", "")
SMB_DOMAIN = os.getenv("REASONKB_SMB_DOMAIN", "")
SMB_PORT = int(os.getenv("REASONKB_SMB_PORT", "445"))
SMB_AUTH_PROTOCOL = os.getenv("REASONKB_SMB_AUTH_PROTOCOL", "ntlm")
```

- [ ] **Step 5: Add SMB schema index**

Append this index after the existing `idx_documents_source_relative_path` in `web/lib/db/schema.sql`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_smb_source_relative_path
  ON documents(source_root, source_relative_path)
  WHERE source_kind = 'smb' AND deleted_at IS NULL;
```

- [ ] **Step 6: Run test to verify it passes**

Run:

```bash
python -m pytest services/tests/test_smb_paths.py -q
```

Expected: PASS.

- [ ] **Step 7: Run local sync regression**

Run:

```bash
python -m pytest services/tests/test_directory_sync.py -q
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add services/requirements.txt services/common/settings.py web/lib/db/schema.sql services/tests/test_smb_paths.py
git commit -m "feat: add smb corpus configuration"
```

## Task 2: SMB Path Parsing And Client Adapter

**Files:**
- Create: `services/remote_corpus/__init__.py`
- Create: `services/remote_corpus/models.py`
- Create: `services/remote_corpus/smb_paths.py`
- Create: `services/remote_corpus/smb_source.py`
- Test: `services/tests/test_smb_paths.py`
- Test: `services/tests/test_smb_source.py`

- [ ] **Step 1: Expand failing SMB path tests**

Add these tests to `services/tests/test_smb_paths.py`:

```python
from services.remote_corpus.smb_paths import (
    build_smb_source_root,
    build_smb_url,
    parse_smb_share_path,
    safe_cache_file_name,
)


def test_parse_windows_unc_smb_share_path():
    parsed = parse_smb_share_path(r"\\fileserver\Projects\Division A")
    assert parsed.host == "fileserver"
    assert parsed.share == "Projects"
    assert parsed.base_path == "Division A"


def test_parse_slash_style_smb_share_path():
    parsed = parse_smb_share_path("//fileserver/Projects/Division A/Reports")
    assert parsed.host == "fileserver"
    assert parsed.share == "Projects"
    assert parsed.base_path == "Division A/Reports"


def test_build_smb_source_root_and_url_escape_backslashes():
    assert build_smb_source_root("fileserver", "Projects", "Division A") == (
        "smb://fileserver/Projects/Division%20A"
    )
    assert build_smb_url("fileserver", "Projects", "Division A/Project/report.md") == (
        "//fileserver/Projects/Division A/Project/report.md"
    )


def test_safe_cache_file_name_preserves_extension():
    assert safe_cache_file_name("Project A/final report.v1.pdf") == "final_report.v1.pdf"
    assert safe_cache_file_name("Project A/.hidden") == "downloaded-file"
```

- [ ] **Step 2: Add failing SMB source tests with fake client**

Create `services/tests/test_smb_source.py`:

```python
from datetime import datetime, timezone
from pathlib import Path

from services.remote_corpus.models import SmbConfig
from services.remote_corpus.smb_source import SmbCorpusSource


class FakeDirEntry:
    def __init__(self, path, *, is_dir=False, size=0, mtime=None):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self._is_dir = is_dir
        self._size = size
        self._mtime = mtime or datetime(2026, 7, 6, tzinfo=timezone.utc)

    def is_dir(self):
        return self._is_dir

    def is_file(self):
        return not self._is_dir

    def stat(self):
        class Stat:
            st_size = self._size
            st_mtime = self._mtime.timestamp()

        return Stat()


class FakeSmbClient:
    def __init__(self):
        self.registered = []
        self.downloads = []
        self.tree = {
            "//server/share/base": [
                FakeDirEntry("//server/share/base/ProjectA", is_dir=True),
            ],
            "//server/share/base/ProjectA": [
                FakeDirEntry("//server/share/base/ProjectA/report.md", size=12),
                FakeDirEntry("//server/share/base/ProjectA/.hidden", size=1),
            ],
        }

    def register_session(self, server, username=None, password=None, port=445, auth_protocol="ntlm", **kwargs):
        self.registered.append((server, username, password, port, auth_protocol))

    def scandir(self, path):
        return self.tree[path]

    def open_file(self, path, mode="rb"):
        class Handle:
            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, exc_type, exc, tb):
                return None

            def read(self_inner, size=-1):
                return b"hello"

        self.downloads.append((path, mode))
        return Handle()


def test_smb_source_lists_supported_files_without_downloading(tmp_path):
    username_file = tmp_path / "username"
    password_file = tmp_path / "password"
    username_file.write_text("alice", encoding="utf-8")
    password_file.write_text("secret", encoding="utf-8")
    fake_client = FakeSmbClient()
    source = SmbCorpusSource(
        SmbConfig(
            host="server",
            share="share",
            base_path="base",
            username_file=username_file,
            password_file=password_file,
            domain="DOMAIN",
        ),
        smbclient_module=fake_client,
    )

    files = source.list_files()

    assert [file.source_relative_path for file in files] == ["ProjectA/report.md"]
    assert files[0].project_name == "ProjectA"
    assert files[0].project_relative_path == "report.md"
    assert files[0].media_type == "markdown"
    assert fake_client.downloads == []
    assert fake_client.registered == [("server", "DOMAIN\\alice", "secret", 445, "ntlm")]


def test_smb_source_fetches_single_file(tmp_path):
    username_file = tmp_path / "username"
    password_file = tmp_path / "password"
    username_file.write_text("alice", encoding="utf-8")
    password_file.write_text("secret", encoding="utf-8")
    fake_client = FakeSmbClient()
    source = SmbCorpusSource(
        SmbConfig(
            host="server",
            share="share",
            base_path="base",
            username_file=username_file,
            password_file=password_file,
        ),
        smbclient_module=fake_client,
    )
    destination = tmp_path / "report.md"

    source.fetch_file("ProjectA/report.md", destination)

    assert destination.read_bytes() == b"hello"
    assert fake_client.downloads == [("//server/share/base/ProjectA/report.md", "rb")]
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
python -m pytest services/tests/test_smb_paths.py services/tests/test_smb_source.py -q
```

Expected: FAIL because `services.remote_corpus` modules do not exist.

- [ ] **Step 4: Implement models**

Create `services/remote_corpus/__init__.py` as an empty file.

Create `services/remote_corpus/models.py`:

```python
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
```

- [ ] **Step 5: Implement SMB path helpers**

Create `services/remote_corpus/smb_paths.py`:

```python
from dataclasses import dataclass
from pathlib import PurePosixPath
from urllib.parse import quote
import re


@dataclass(frozen=True)
class ParsedSmbPath:
    host: str
    share: str
    base_path: str


def parse_smb_share_path(value: str) -> ParsedSmbPath:
    raw = value.strip()
    if raw.startswith("\\\\"):
        raw = raw.replace("\\", "/")
    if not raw.startswith("//"):
        raise ValueError("SMB path must start with \\\\server\\share or //server/share")
    parts = [part for part in raw[2:].split("/") if part]
    if len(parts) < 2:
        raise ValueError("SMB path must include a server and share name")
    return ParsedSmbPath(host=parts[0], share=parts[1], base_path="/".join(parts[2:]))


def _join_posix(*parts: str) -> str:
    clean = [part.strip("/") for part in parts if part and part.strip("/")]
    return "/".join(clean)


def build_smb_url(host: str, share: str, path: str = "") -> str:
    suffix = _join_posix(path)
    return f"//{host}/{share}" + (f"/{suffix}" if suffix else "")


def build_smb_source_root(host: str, share: str, base_path: str = "") -> str:
    suffix = "/".join(quote(part) for part in _join_posix(base_path).split("/") if part)
    return f"smb://{host}/{share}" + (f"/{suffix}" if suffix else "")


def join_remote_path(base_path: str, relative_path: str) -> str:
    return _join_posix(base_path, relative_path)


def safe_cache_file_name(relative_path: str) -> str:
    name = PurePosixPath(relative_path).name
    if not name or name.startswith("."):
        return "downloaded-file"
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name)
```

- [ ] **Step 6: Implement SMB source adapter**

Create `services/remote_corpus/smb_source.py`:

```python
from datetime import datetime, timezone
from pathlib import Path
import mimetypes

from services.directory_watcher.sync import IGNORED_NAMES, SUPPORTED_MEDIA_BY_EXTENSION
from services.remote_corpus.models import RemoteCorpusFile, SmbConfig
from services.remote_corpus.smb_paths import build_smb_source_root, build_smb_url, join_remote_path


class SmbCorpusSource:
    def __init__(self, config: SmbConfig, smbclient_module=None):
        self.config = config
        if smbclient_module is None:
            import smbclient as smbclient_module
        self._client = smbclient_module
        self._registered = False

    def list_files(self) -> list[RemoteCorpusFile]:
        self._ensure_session()
        root_url = build_smb_url(self.config.host, self.config.share, self.config.base_path)
        source_root = build_smb_source_root(self.config.host, self.config.share, self.config.base_path)
        return list(self._walk(root_url, "", source_root))

    def fetch_file(self, source_relative_path: str, destination: Path) -> Path:
        self._ensure_session()
        remote_path = join_remote_path(self.config.base_path, source_relative_path)
        remote_url = build_smb_url(self.config.host, self.config.share, remote_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with self._client.open_file(remote_url, mode="rb") as remote, destination.open("wb") as local:
            for chunk in iter(lambda: remote.read(1024 * 1024), b""):
                if not chunk:
                    break
                local.write(chunk)
        return destination

    def _walk(self, remote_dir: str, relative_dir: str, source_root: str):
        for entry in sorted(self._client.scandir(remote_dir), key=lambda item: item.name):
            if entry.name in IGNORED_NAMES or entry.name.startswith("."):
                continue
            relative_path = f"{relative_dir}/{entry.name}" if relative_dir else entry.name
            if entry.is_dir():
                yield from self._walk(entry.path, relative_path, source_root)
                continue
            if not entry.is_file():
                continue
            parts = relative_path.split("/")
            if len(parts) < 2:
                continue
            media_type = SUPPORTED_MEDIA_BY_EXTENSION.get(Path(entry.name).suffix.lower(), "unsupported")
            stat = entry.stat()
            yield RemoteCorpusFile(
                locator=f"{source_root}/{relative_path}",
                project_name=parts[0],
                source_root=source_root,
                source_relative_path=relative_path,
                project_relative_path="/".join(parts[1:]),
                file_name=entry.name,
                media_type=media_type,
                mime_type=mimetypes.guess_type(entry.name)[0] or "application/octet-stream",
                size=stat.st_size,
                mtime=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
            )

    def _ensure_session(self) -> None:
        if self._registered:
            return
        username = _read_secret(self.config.username_file)
        password = _read_secret(self.config.password_file)
        if self.config.domain and username:
            username = f"{self.config.domain}\\{username}"
        self._client.register_session(
            self.config.host,
            username=username or None,
            password=password or None,
            port=self.config.port,
            auth_protocol=self.config.auth_protocol,
        )
        self._registered = True


def _read_secret(path: Path | None) -> str:
    if path is None:
        return ""
    return path.read_text(encoding="utf-8").strip()
```

- [ ] **Step 7: Run adapter tests**

Run:

```bash
python -m pytest services/tests/test_smb_paths.py services/tests/test_smb_source.py -q
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add services/remote_corpus services/tests/test_smb_paths.py services/tests/test_smb_source.py
git commit -m "feat: add smb remote corpus adapter"
```

## Task 3: SMB Metadata Sync Without Downloading Content

**Files:**
- Modify: `services/directory_watcher/sync.py`
- Create: `services/directory_watcher/smb_sync.py`
- Modify: `services/directory_watcher/worker.py`
- Test: `services/tests/test_directory_sync.py`
- Test: `services/tests/test_smb_sync.py`

- [ ] **Step 1: Add local sync regression for source filters**

Add to `services/tests/test_directory_sync.py`:

```python
def test_local_sync_does_not_delete_smb_documents_when_local_scan_succeeds(tmp_path):
    db_path = _create_db(tmp_path)
    root = tmp_path / "projects"
    (root / "ProjectA").mkdir(parents=True)
    (root / "ProjectA" / "local.md").write_text("local", encoding="utf-8")

    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ("proj_smb", "user_demo", "Remote", "2026-07-06T00:00:00Z", "2026-07-06T00:00:00Z"),
    )
    conn.execute(
        """INSERT INTO documents
           (id, project_id, owner_user_id, file_name, storage_path, mime_type, file_size,
            source_kind, source_root, source_relative_path, project_relative_path,
            content_hash, source_mtime, source_size, media_type, import_status,
            status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            "doc_smb",
            "proj_smb",
            "user_demo",
            "remote.md",
            "smb://server/share/Remote/remote.md",
            "text/markdown",
            6,
            "smb",
            "smb://server/share",
            "Remote/remote.md",
            "remote.md",
            "smb-meta:old",
            "2026-07-06T00:00:00+00:00",
            6,
            "markdown",
            "imported",
            "ready",
            "2026-07-06T00:00:00Z",
            "2026-07-06T00:00:00Z",
        ),
    )
    conn.commit()
    conn.close()

    sync_once(str(db_path), root)

    conn = sqlite3.connect(db_path)
    smb_status = conn.execute("SELECT status, deleted_at FROM documents WHERE id = 'doc_smb'").fetchone()
    conn.close()
    assert smb_status == ("ready", None)
```

- [ ] **Step 2: Write failing SMB metadata sync tests**

Create `services/tests/test_smb_sync.py`:

```python
import sqlite3
from pathlib import Path

import pytest

from services.directory_watcher.smb_sync import sync_smb_once
from services.remote_corpus.models import RemoteCorpusFile


def _schema_sql() -> str:
    repo_root = Path(__file__).resolve().parents[2]
    return (repo_root / "web" / "lib" / "db" / "schema.sql").read_text(encoding="utf-8")


def _create_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "app.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_schema_sql())
    conn.close()
    return db_path


class FakeRemoteSource:
    def __init__(self, files=None, exc=None):
        self.files = files or []
        self.exc = exc
        self.fetch_count = 0

    def list_files(self):
        if self.exc:
            raise self.exc
        return self.files

    def fetch_file(self, source_relative_path, destination):
        self.fetch_count += 1
        raise AssertionError("metadata sync must not download file contents")


def remote_file(path, *, size=10, mtime="2026-07-06T00:00:00+00:00"):
    file_name = path.rsplit("/", 1)[-1]
    project, rest = path.split("/", 1)
    return RemoteCorpusFile(
        locator=f"smb://server/share/{path}",
        project_name=project,
        source_root="smb://server/share",
        source_relative_path=path,
        project_relative_path=rest,
        file_name=file_name,
        media_type="markdown",
        mime_type="text/markdown",
        size=size,
        mtime=mtime,
    )


def test_sync_smb_once_creates_documents_from_metadata_without_download(tmp_path):
    db_path = _create_db(tmp_path)
    source = FakeRemoteSource([remote_file("ProjectA/report.md", size=12)])

    summary = sync_smb_once(str(db_path), source)

    conn = sqlite3.connect(db_path)
    document = conn.execute(
        """SELECT file_name, storage_path, source_kind, source_root,
                  source_relative_path, project_relative_path, content_hash,
                  source_mtime, source_size, media_type, status
             FROM documents"""
    ).fetchone()
    jobs = conn.execute("SELECT COUNT(*) FROM jobs WHERE status = 'queued'").fetchone()[0]
    conn.close()

    assert summary == {"created": 1, "updated": 0, "unchanged": 0, "deleted": 0, "skipped": 0}
    assert document[0:6] == (
        "report.md",
        "smb://server/share/ProjectA/report.md",
        "smb",
        "smb://server/share",
        "ProjectA/report.md",
        "report.md",
    )
    assert document[6].startswith("smb-meta:")
    assert document[7:11] == ("2026-07-06T00:00:00+00:00", 12, "markdown", "uploaded")
    assert jobs == 1
    assert source.fetch_count == 0


def test_sync_smb_once_uses_mtime_and_size_for_change_detection(tmp_path):
    db_path = _create_db(tmp_path)
    sync_smb_once(str(db_path), FakeRemoteSource([remote_file("ProjectA/report.md", size=12)]))
    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE jobs SET status = 'completed'")
    original_hash = conn.execute("SELECT content_hash FROM documents").fetchone()[0]
    conn.commit()
    conn.close()

    summary = sync_smb_once(
        str(db_path),
        FakeRemoteSource([remote_file("ProjectA/report.md", size=13, mtime="2026-07-06T00:01:00+00:00")]),
    )

    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT content_hash, source_size, status FROM documents").fetchone()
    queued = conn.execute("SELECT COUNT(*) FROM jobs WHERE status = 'queued'").fetchone()[0]
    conn.close()

    assert summary["updated"] == 1
    assert row[0] != original_hash
    assert row[1:] == (13, "uploaded")
    assert queued == 1


def test_failed_smb_scan_does_not_delete_existing_documents(tmp_path):
    db_path = _create_db(tmp_path)
    sync_smb_once(str(db_path), FakeRemoteSource([remote_file("ProjectA/report.md")]))

    with pytest.raises(ConnectionError):
        sync_smb_once(str(db_path), FakeRemoteSource(exc=ConnectionError("server unreachable")))

    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT status, deleted_at FROM documents").fetchone()
    conn.close()
    assert row == ("uploaded", None)
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
python -m pytest services/tests/test_directory_sync.py::test_local_sync_does_not_delete_smb_documents_when_local_scan_succeeds services/tests/test_smb_sync.py -q
```

Expected: FAIL because `smb_sync` does not exist and local sync still marks all non-seen directory-like paths too broadly.

- [ ] **Step 4: Generalize source file model in local sync**

Modify `services/directory_watcher/sync.py`:

- Add fields to `SourceFile`:

```python
    source_kind: str = "directory"
    source_root: str = ""
    storage_path: str = ""
```

- In `classify_source_file`, set `source_root=str(root)` and `storage_path=str(file_path)`.
- In `_upsert_source_file`, replace hard-coded `"directory"` with `source_file.source_kind`, `str(root)` with `source_file.source_root or str(root)`, and `str(source_file.path)` with `source_file.storage_path or str(source_file.path)`.
- Change the existing lookup to:

```sql
SELECT id, content_hash, source_mtime, source_size, media_type, import_status
  FROM documents
 WHERE source_kind = ?
   AND source_root = ?
   AND source_relative_path = ?
 LIMIT 1
```

- Pass `(source_file.source_kind, source_file.source_root or str(root), source_file.source_relative_path)`.
- Change `_mark_missing_deleted` to accept `source_kind` and `source_root`, and filter by both.
- Change `_mark_missing_projects_deleted` to accept `source_kind`, and filter documents by that source kind.
- In `sync_once`, pass `source_kind="directory"` and `source_root=str(root)`.

- [ ] **Step 5: Add metadata fingerprint helper**

In `services/directory_watcher/sync.py`, add:

```python
def metadata_fingerprint(source_root: str, source_relative_path: str, mtime: str, size: int) -> str:
    digest = hashlib.sha256()
    digest.update(source_root.encode("utf-8"))
    digest.update(b"\0")
    digest.update(source_relative_path.encode("utf-8"))
    digest.update(b"\0")
    digest.update(mtime.encode("utf-8"))
    digest.update(b"\0")
    digest.update(str(size).encode("ascii"))
    return f"smb-meta:{digest.hexdigest()}"
```

- [ ] **Step 6: Implement SMB sync**

Create `services/directory_watcher/smb_sync.py`:

```python
from pathlib import Path

from services.common.sqlite_store import open_db
from services.directory_watcher.sync import (
    SourceFile,
    _mark_missing_deleted,
    _mark_missing_projects_deleted,
    _upsert_source_file,
    metadata_fingerprint,
)


def sync_smb_once(db_path: str, remote_source) -> dict[str, int]:
    source_files = [_to_source_file(file) for file in remote_source.list_files()]
    seen_paths = {file.source_relative_path for file in source_files}
    seen_project_names = {file.project_name for file in source_files}
    source_root = source_files[0].source_root if source_files else getattr(remote_source, "source_root", "")
    summary = {"created": 0, "updated": 0, "unchanged": 0, "deleted": 0, "skipped": 0}

    with open_db(db_path) as conn:
        for source_file in source_files:
            outcome = _upsert_source_file(conn, Path("/remote/smb"), source_file, _now_iso())
            summary[outcome] += 1
        summary["deleted"] = _mark_missing_deleted(conn, seen_paths, _now_iso(), source_kind="smb", source_root=source_root)
        _mark_missing_projects_deleted(conn, seen_project_names, _now_iso(), source_kind="smb")
    return summary


def _to_source_file(remote_file) -> SourceFile:
    return SourceFile(
        path=Path(remote_file.file_name),
        project_name=remote_file.project_name,
        source_relative_path=remote_file.source_relative_path,
        project_relative_path=remote_file.project_relative_path,
        media_type=remote_file.media_type,
        mime_type=remote_file.mime_type,
        size=remote_file.size,
        mtime=remote_file.mtime,
        content_hash=metadata_fingerprint(
            remote_file.source_root,
            remote_file.source_relative_path,
            remote_file.mtime,
            remote_file.size,
        ),
        source_kind="smb",
        source_root=remote_file.source_root,
        storage_path=remote_file.locator,
    )


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
```

If duplicate timestamps inside one sync matter in tests, compute `now = _now_iso()` once at the top and pass it to all helpers.

- [ ] **Step 7: Route worker by corpus source**

Modify `services/directory_watcher/worker.py`:

```python
from pathlib import Path
import time

from services.common.settings import (
    CORPUS_SOURCE,
    DB_PATH,
    DIRECTORY_SCAN_INTERVAL_SECONDS,
    PROJECTS_ROOT,
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


def _sync_current_source() -> None:
    if CORPUS_SOURCE == "smb":
        source = SmbCorpusSource(
            SmbConfig(
                host=SMB_HOST,
                share=SMB_SHARE,
                base_path=SMB_BASE_PATH,
                username_file=Path(SMB_USERNAME_FILE) if SMB_USERNAME_FILE else None,
                password_file=Path(SMB_PASSWORD_FILE) if SMB_PASSWORD_FILE else None,
                domain=SMB_DOMAIN,
                port=SMB_PORT,
                auth_protocol=SMB_AUTH_PROTOCOL,
            )
        )
        sync_smb_once(str(DB_PATH), source)
        return
    sync_once(str(DB_PATH), PROJECTS_ROOT)


def run_forever(poll_seconds: float = DIRECTORY_SCAN_INTERVAL_SECONDS):
    while True:
        _sync_current_source()
        time.sleep(poll_seconds)
```

- [ ] **Step 8: Run sync tests**

Run:

```bash
python -m pytest services/tests/test_directory_sync.py services/tests/test_smb_sync.py -q
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add services/directory_watcher services/tests/test_directory_sync.py services/tests/test_smb_sync.py
git commit -m "feat: sync smb corpus metadata"
```

## Task 4: Index-Time SMB File Fetch

**Files:**
- Create: `services/index_worker/remote_fetch.py`
- Modify: `services/index_worker/index_document.py`
- Test: `services/tests/test_index_document.py`

- [ ] **Step 1: Add failing index-time fetch tests**

Add to `services/tests/test_index_document.py`:

```python
def test_process_document_job_fetches_smb_file_before_indexing(tmp_path, monkeypatch):
    db_path = _seed_single_document_job_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE documents
           SET file_name = ?, storage_path = ?, source_kind = ?, source_root = ?,
               source_relative_path = ?, project_relative_path = ?, media_type = ?,
               content_hash = ?, source_mtime = ?, source_size = ?
         WHERE id = 'doc_1'
        """,
        (
            "remote.md",
            "smb://server/share/Alpha/remote.md",
            "smb",
            "smb://server/share",
            "Alpha/remote.md",
            "remote.md",
            "markdown",
            "smb-meta:old",
            "2026-07-06T00:00:00+00:00",
            11,
        ),
    )
    conn.commit()
    conn.close()

    fetched_paths = []

    def fake_fetch(document, destination):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("# Remote", encoding="utf-8")
        fetched_paths.append(destination)
        return "sha256:realhash"

    monkeypatch.setattr("services.index_worker.remote_fetch.fetch_smb_document", fake_fetch)
    monkeypatch.setattr(
        "services.index_worker.index_document.build_pageindex_payload",
        lambda file_path, document=None: {
            "doc_name": Path(file_path).name,
            "doc_description": document["content_hash"],
            "structure": [{"title": "Remote"}],
            "pages": [{"page": 1, "content": Path(file_path).read_text(encoding="utf-8")}],
            "page_count": 1,
            "evidence_kind": "markdown_text",
            "visual_assets": [],
            "source_metadata": {"contentHash": document["content_hash"]},
        },
    )

    process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    document_hash = conn.execute("SELECT content_hash FROM documents WHERE id = 'doc_1'").fetchone()[0]
    description = conn.execute("SELECT doc_description FROM document_indexes WHERE document_id = 'doc_1'").fetchone()[0]
    conn.close()

    assert fetched_paths
    assert document_hash == "sha256:realhash"
    assert description == "sha256:realhash"


def test_process_document_job_fails_smb_download_without_leaking_password(tmp_path, monkeypatch):
    db_path = _seed_single_document_job_db(tmp_path)
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        UPDATE documents
           SET storage_path = ?, source_kind = ?, source_root = ?,
               source_relative_path = ?, media_type = ?
         WHERE id = 'doc_1'
        """,
        ("smb://server/share/Alpha/remote.md", "smb", "smb://server/share", "Alpha/remote.md", "markdown"),
    )
    conn.commit()
    conn.close()

    def fake_fetch(document, destination):
        raise RuntimeError("SMB download failed for Alpha/remote.md")

    monkeypatch.setattr("services.index_worker.remote_fetch.fetch_smb_document", fake_fetch)

    with pytest.raises(RuntimeError, match="SMB download failed"):
        process_document_job(str(db_path), "job_1")

    conn = sqlite3.connect(db_path)
    run_error = conn.execute("SELECT error_message FROM document_index_runs WHERE document_id = 'doc_1'").fetchone()[0]
    conn.close()
    assert "Alpha/remote.md" in run_error
    assert "password" not in run_error.lower()
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
python -m pytest services/tests/test_index_document.py::test_process_document_job_fetches_smb_file_before_indexing services/tests/test_index_document.py::test_process_document_job_fails_smb_download_without_leaking_password -q
```

Expected: FAIL because `remote_fetch` does not exist and `process_document_job` passes SMB locator strings directly to payload builders.

- [ ] **Step 3: Implement remote fetch context**

Create `services/index_worker/remote_fetch.py`:

```python
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
import hashlib
import shutil

from services.common.settings import (
    REMOTE_CACHE_ROOT,
    SMB_AUTH_PROTOCOL,
    SMB_BASE_PATH,
    SMB_DOMAIN,
    SMB_HOST,
    SMB_PASSWORD_FILE,
    SMB_PORT,
    SMB_SHARE,
    SMB_USERNAME_FILE,
)
from services.remote_corpus.models import SmbConfig
from services.remote_corpus.smb_paths import safe_cache_file_name
from services.remote_corpus.smb_source import SmbCorpusSource


@dataclass(frozen=True)
class PreparedIndexFile:
    local_path: Path
    content_hash: str | None = None


@contextmanager
def prepared_index_file(document: dict):
    if document.get("source_kind") != "smb":
        yield PreparedIndexFile(Path(document["storage_path"]))
        return

    destination = (
        REMOTE_CACHE_ROOT
        / document["document_id"]
        / safe_cache_file_name(document.get("source_relative_path") or document.get("file_name") or "downloaded-file")
    )
    content_hash = fetch_smb_document(document, destination)
    try:
        yield PreparedIndexFile(destination, content_hash)
    finally:
        shutil.rmtree(destination.parent, ignore_errors=True)


def fetch_smb_document(document: dict, destination: Path) -> str:
    source = SmbCorpusSource(
        SmbConfig(
            host=SMB_HOST,
            share=SMB_SHARE,
            base_path=SMB_BASE_PATH,
            username_file=Path(SMB_USERNAME_FILE) if SMB_USERNAME_FILE else None,
            password_file=Path(SMB_PASSWORD_FILE) if SMB_PASSWORD_FILE else None,
            domain=SMB_DOMAIN,
            port=SMB_PORT,
            auth_protocol=SMB_AUTH_PROTOCOL,
        )
    )
    source.fetch_file(document["source_relative_path"], destination)
    return _sha256_file(destination)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"
```

- [ ] **Step 4: Use prepared file in index worker**

Modify `services/index_worker/index_document.py`:

- Import:

```python
from services.index_worker.remote_fetch import prepared_index_file
```

- Replace:

```python
payload = _invoke_payload_builder(document)
```

with:

```python
with prepared_index_file(document) as prepared_file:
    document_for_payload = {
        **document,
        "storage_path": str(prepared_file.local_path),
    }
    if prepared_file.content_hash:
        document_for_payload["content_hash"] = prepared_file.content_hash
    payload = _invoke_payload_builder(document_for_payload)
    if prepared_file.content_hash:
        document["content_hash"] = prepared_file.content_hash
```

- In `_persist_completed_document`, add `content_hash = ?` when `document.get("content_hash")` is present. Use this value in the `UPDATE documents` statement:

```python
content_hash = document.get("content_hash")
...
UPDATE documents
   SET status = ?, page_count = ?, error_message = NULL,
       import_status = ?,
       content_hash = COALESCE(?, content_hash),
       last_index_duration_ms = ?,
...
```

and pass `content_hash` before `duration_ms`.

- [ ] **Step 5: Run index tests**

Run:

```bash
python -m pytest services/tests/test_index_document.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/index_worker/remote_fetch.py services/index_worker/index_document.py services/tests/test_index_document.py
git commit -m "feat: fetch smb documents during indexing"
```

## Task 5: Docker Compose And Installer SMB Configuration

**Files:**
- Modify: `docker/compose.yml`
- Modify: `docker/compose.release.yml`
- Modify: `docker/install.sh`
- Modify: `services/tests/test_docker_release_packaging.py`

- [ ] **Step 1: Add failing compose tests**

Add to `services/tests/test_docker_release_packaging.py`:

```python
def test_release_compose_mounts_smb_secrets_for_remote_corpus_workers():
    compose = yaml.safe_load((ROOT / "docker" / "compose.release.yml").read_text())

    for service_name in ("directory-watcher", "index-worker"):
        service = compose["services"][service_name]
        assert "${REASONKB_SECRETS_ROOT:-./secrets}:/app/secrets:ro" in service["volumes"]
        assert service["environment"]["REASONKB_CORPUS_SOURCE"] == "${REASONKB_CORPUS_SOURCE:-local}"
        assert service["environment"]["REASONKB_SMB_USERNAME_FILE"] == "${REASONKB_SMB_USERNAME_FILE:-/app/secrets/smb_username}"
        assert service["environment"]["REASONKB_SMB_PASSWORD_FILE"] == "${REASONKB_SMB_PASSWORD_FILE:-/app/secrets/smb_password}"
        assert "SYS_ADMIN" not in service.get("cap_add", [])
```

- [ ] **Step 2: Add failing installer SMB tests**

Add to `services/tests/test_docker_release_packaging.py`:

```python
def test_install_script_interactive_smb_flow_writes_env_and_secret_files(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    reasonkb_home = tmp_path / "home"
    prompt_input = tmp_path / "prompt-input.txt"
    prompt_output = tmp_path / "prompt-output.txt"
    prompt_input.write_text(
        "\n".join(
            [
                "smb",
                r"\\fileserver\Projects\Division A",
                "alice",
                "super-secret",
                "DOMAIN",
                "",
                "",
                "",
                "",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    _write_executable(fake_bin / "curl", """
    #!/usr/bin/env sh
    set -eu
    output=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then
        shift
        output="$1"
        break
      fi
      shift
    done
    cp "$REASONKB_FAKE_COMPOSE_SOURCE" "$output"
    """)
    _write_executable(fake_bin / "docker", """
    #!/usr/bin/env sh
    set -eu
    if [ "$1" = "compose" ] && [ "${2:-}" = "version" ]; then
      exit 0
    fi
    if [ "$1" = "compose" ]; then
      exit 0
    fi
    exit 1
    """)

    env = {
        **os.environ,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "REASONKB_HOME": str(reasonkb_home),
        "REASONKB_COMPOSE_URL": "https://example.invalid/compose.yml",
        "REASONKB_FAKE_COMPOSE_SOURCE": str(ROOT / "docker" / "compose.release.yml"),
        "REASONKB_INTERACTIVE": "1",
        "REASONKB_INSTALL_INPUT": str(prompt_input),
        "REASONKB_INSTALL_OUTPUT": str(prompt_output),
    }

    result = subprocess.run(
        [_sh_executable(), str(ROOT / "docker" / "install.sh")],
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    configured = {
        key: value
        for line in (reasonkb_home / ".env").read_text(encoding="utf-8").splitlines()
        if "=" in line and not line.startswith("#")
        for key, value in [line.split("=", 1)]
    }
    assert configured["REASONKB_CORPUS_SOURCE"] == "smb"
    assert configured["REASONKB_SMB_HOST"] == "fileserver"
    assert configured["REASONKB_SMB_SHARE"] == "Projects"
    assert configured["REASONKB_SMB_BASE_PATH"] == "Division A"
    assert configured["REASONKB_SMB_DOMAIN"] == "DOMAIN"
    assert configured["REASONKB_SMB_USERNAME_FILE"] == "./secrets/smb_username"
    assert configured["REASONKB_SMB_PASSWORD_FILE"] == "./secrets/smb_password"
    assert (reasonkb_home / "secrets" / "smb_username").read_text(encoding="utf-8") == "alice\n"
    assert (reasonkb_home / "secrets" / "smb_password").read_text(encoding="utf-8") == "super-secret\n"
    assert "super-secret" not in result.stdout
    assert "super-secret" not in prompt_output.read_text(encoding="utf-8")
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
python -m pytest services/tests/test_docker_release_packaging.py::test_release_compose_mounts_smb_secrets_for_remote_corpus_workers services/tests/test_docker_release_packaging.py::test_install_script_interactive_smb_flow_writes_env_and_secret_files -q
```

Expected: FAIL because compose and installer do not contain SMB support.

- [ ] **Step 4: Update compose files**

In both `docker/compose.yml` and `docker/compose.release.yml`, add these environment keys to `directory-watcher` and `index-worker`:

```yaml
      REASONKB_CORPUS_SOURCE: ${REASONKB_CORPUS_SOURCE:-local}
      REASONKB_SMB_HOST: ${REASONKB_SMB_HOST:-}
      REASONKB_SMB_SHARE: ${REASONKB_SMB_SHARE:-}
      REASONKB_SMB_BASE_PATH: ${REASONKB_SMB_BASE_PATH:-}
      REASONKB_SMB_USERNAME_FILE: ${REASONKB_SMB_USERNAME_FILE:-/app/secrets/smb_username}
      REASONKB_SMB_PASSWORD_FILE: ${REASONKB_SMB_PASSWORD_FILE:-/app/secrets/smb_password}
      REASONKB_SMB_DOMAIN: ${REASONKB_SMB_DOMAIN:-}
      REASONKB_SMB_PORT: ${REASONKB_SMB_PORT:-445}
      REASONKB_SMB_AUTH_PROTOCOL: ${REASONKB_SMB_AUTH_PROTOCOL:-ntlm}
      REASONKB_REMOTE_CACHE_ROOT: ${REASONKB_REMOTE_CACHE_ROOT:-/app/var/remote-cache}
```

Add this volume to `directory-watcher` and `index-worker`:

```yaml
      - ${REASONKB_SECRETS_ROOT:-./secrets}:/app/secrets:ro
```

Do not add `cap_add` or privileged settings.

- [ ] **Step 5: Add installer helpers**

Modify `docker/install.sh` with these helpers near the existing prompt helpers:

```sh
prompt_choice() {
  label="$1"
  default_value="$2"
  PROMPT_VALUE="$default_value"
  if [ "$INSTALL_INTERACTIVE" != "1" ]; then
    return 0
  fi
  prompt_write "$label [$default_value]: "
  read_prompt_line
  if [ -n "$PROMPT_REPLY" ]; then
    PROMPT_VALUE="$PROMPT_REPLY"
  fi
}

parse_smb_path() {
  value="$1"
  normalized="$(printf '%s' "$value" | sed 's#\\#/#g')"
  case "$normalized" in
    //*) ;;
    *) echo "SMB 路径必须形如 \\\\server\\share 或 //server/share。" >&2; return 1 ;;
  esac
  stripped="${normalized#//}"
  SMB_HOST_PARSED="$(printf '%s' "$stripped" | cut -d / -f 1)"
  SMB_SHARE_PARSED="$(printf '%s' "$stripped" | cut -d / -f 2)"
  SMB_BASE_PATH_PARSED="$(printf '%s' "$stripped" | cut -s -d / -f 3-)"
  if [ -z "$SMB_HOST_PARSED" ] || [ -z "$SMB_SHARE_PARSED" ]; then
    echo "SMB 路径必须包含服务器和共享名。" >&2
    return 1
  fi
}

write_secret_file() {
  path="$1"
  value="$2"
  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$value" > "$path"
  chmod 600 "$path" 2>/dev/null || true
}
```

- [ ] **Step 6: Implement installer corpus source selection**

Replace the direct `configure_paths` call with a new `configure_corpus_source`:

```sh
configure_smb_corpus() {
  smb_path_value="$(current_env_or_file_value REASONKB_SMB_PATH "")"
  username_value=""
  password_value=""
  domain_value="$(current_env_or_file_value REASONKB_SMB_DOMAIN "")"

  if [ "$INSTALL_INTERACTIVE" = "1" ]; then
    prompt_value "SMB 共享路径（\\\\server\\share 或 //server/share）" "$smb_path_value"
    smb_path_value="$PROMPT_VALUE"
    prompt_value "SMB 用户名" "$username_value"
    username_value="$PROMPT_VALUE"
    prompt_secret "SMB 密码" "$password_value"
    password_value="$PROMPT_VALUE"
    prompt_value "SMB 域（可选）" "$domain_value"
    domain_value="$PROMPT_VALUE"
  fi

  if [ -z "$smb_path_value" ]; then
    smb_path_value="//${REASONKB_SMB_HOST}/${REASONKB_SMB_SHARE}"
    if [ -n "${REASONKB_SMB_BASE_PATH:-}" ]; then
      smb_path_value="$smb_path_value/$REASONKB_SMB_BASE_PATH"
    fi
  fi

  parse_smb_path "$smb_path_value"
  set_env_file_value REASONKB_CORPUS_SOURCE "smb"
  set_env_file_value REASONKB_SMB_HOST "$SMB_HOST_PARSED"
  set_env_file_value REASONKB_SMB_SHARE "$SMB_SHARE_PARSED"
  set_env_file_value REASONKB_SMB_BASE_PATH "$SMB_BASE_PATH_PARSED"
  set_env_file_value REASONKB_SMB_DOMAIN "$domain_value"
  set_env_file_value REASONKB_SMB_USERNAME_FILE "./secrets/smb_username"
  set_env_file_value REASONKB_SMB_PASSWORD_FILE "./secrets/smb_password"
  set_env_file_value REASONKB_SECRETS_ROOT "./secrets"

  if [ -n "$username_value" ]; then
    write_secret_file "$REASONKB_HOME/secrets/smb_username" "$username_value"
  fi
  if [ -n "$password_value" ]; then
    write_secret_file "$REASONKB_HOME/secrets/smb_password" "$password_value"
  fi
}

configure_corpus_source() {
  source_value="$(current_env_or_file_value REASONKB_CORPUS_SOURCE "local")"
  if [ "$INSTALL_INTERACTIVE" = "1" ]; then
    prompt_choice "项目语料来源：local 或 smb" "$source_value"
    source_value="$PROMPT_VALUE"
  fi

  case "$source_value" in
    smb|SMB)
      configure_smb_corpus
      ;;
    local|LOCAL|"")
      set_env_file_value REASONKB_CORPUS_SOURCE "local"
      configure_paths
      ;;
    *)
      echo "不支持的项目语料来源：$source_value" >&2
      exit 1
      ;;
  esac
}
```

Then call:

```sh
configure_corpus_source
configure_llm_defaults
```

instead of:

```sh
configure_paths
configure_llm_defaults
```

- [ ] **Step 7: Update installer summary**

At the end of `docker/install.sh`, compute and print the corpus summary without secrets:

```sh
if [ "$(current_env_or_file_value REASONKB_CORPUS_SOURCE local)" = "smb" ]; then
  corpus_summary="//$(current_env_or_file_value REASONKB_SMB_HOST "")/$(current_env_or_file_value REASONKB_SMB_SHARE "")"
  smb_base_summary="$(current_env_or_file_value REASONKB_SMB_BASE_PATH "")"
  if [ -n "$smb_base_summary" ]; then
    corpus_summary="$corpus_summary/$smb_base_summary"
  fi
  corpus_line="项目语料来源：SMB $corpus_summary"
else
  corpus_line="项目语料目录：${REASONKB_PROJECTS_ROOT:-"$REASONKB_HOME/projects"}"
fi

cat <<EOF
ReasonKB 正在启动。

Web 界面：http://localhost:${WEB_PORT:-43170}
$corpus_line
运行数据目录：$REASONKB_HOME/var
EOF
```

- [ ] **Step 8: Run compose and installer tests**

Run:

```bash
python -m pytest services/tests/test_docker_release_packaging.py -q
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add docker/compose.yml docker/compose.release.yml docker/install.sh services/tests/test_docker_release_packaging.py
git commit -m "feat: configure smb corpus in docker installer"
```

## Task 6: Documentation, Full Verification, And Cleanup

**Files:**
- Modify: `README.md`
- Modify: `docs/deployment.md`
- Test: all relevant service tests

- [ ] **Step 1: Update README configuration section**

Add a short SMB section under `## Configuration` in `README.md`:

```markdown
### SMB Project Corpus

ReasonKB can use a Windows/SMB share as the project corpus without mounting it in the container. Set `REASONKB_CORPUS_SOURCE=smb` and provide SMB host/share settings plus read-only secret files for the username and password. The directory watcher scans remote metadata only; the index worker downloads a single file when that document is indexed.

First-level folders inside the SMB root are still treated as projects.
```

- [ ] **Step 2: Update deployment guide**

In `docs/deployment.md`, add a Windows Server SMB subsection near the project corpus section:

```markdown
### 使用 SMB 共享作为项目语料

如果项目文件在需要用户名和密码访问的 Windows/SMB 共享中，安装向导可以把 ReasonKB 配置为 SMB 语料源。该模式不在容器内执行 `mount.cifs`，不需要 `SYS_ADMIN` 权限，也不会把整个共享目录同步到本地。目录监听器只读取远程文件的路径、大小和修改时间；索引某个文档时才下载该文件到临时缓存。

运行安装脚本时选择 `smb`，输入 `\\server\share`、用户名、密码和可选域。安装脚本会把用户名和密码写入 `~/.reasonkb/secrets/`，并把 `.env` 配置为 `REASONKB_CORPUS_SOURCE=smb`。

设置页管理 SMB 凭据属于后续任务。第一版如需更换账号密码，请更新 `~/.reasonkb/secrets/smb_username` 和 `~/.reasonkb/secrets/smb_password` 后重建容器。
```

- [ ] **Step 3: Run focused Python tests**

Run:

```bash
python -m pytest services/tests/test_smb_paths.py services/tests/test_smb_source.py services/tests/test_smb_sync.py services/tests/test_directory_sync.py services/tests/test_index_document.py services/tests/test_docker_release_packaging.py -q
```

Expected: PASS.

- [ ] **Step 4: Run web tests affected by schema/settings**

Run:

```bash
pnpm -C web test
```

Expected: PASS.

- [ ] **Step 5: Run install script smoke test manually**

Run with fake input:

```bash
tmpdir="$(mktemp -d)"
printf 'smb\n\\\\fileserver\\Projects\nalice\nsecret\nDOMAIN\n\n\n\n\n' > "$tmpdir/input.txt"
REASONKB_HOME="$tmpdir/home" \
REASONKB_INTERACTIVE=1 \
REASONKB_INSTALL_INPUT="$tmpdir/input.txt" \
REASONKB_INSTALL_OUTPUT="$tmpdir/prompts.txt" \
REASONKB_COMPOSE_URL="file://$(pwd)/docker/compose.release.yml" \
sh docker/install.sh
```

Expected: command reaches Docker if Docker is installed; if `file://` is not supported by the local `curl`, the automated tests already cover the installer. Confirm no password is printed in stdout or prompt log.

- [ ] **Step 6: Check git status**

Run:

```bash
git status --short
git log --oneline --decorate -6
```

Expected: clean working tree after commits, with one commit per task.

- [ ] **Step 7: Commit docs**

```bash
git add README.md docs/deployment.md
git commit -m "docs: describe smb remote corpus setup"
```

## Self-Review

- Spec coverage:
  - SMB without `SYS_ADMIN`: Tasks 2, 3, 4, and 5 avoid mount/CIFS capabilities.
  - Metadata-only scan with `mtime + size`: Task 3 implements and tests metadata fingerprint updates without downloads.
  - Index-time single-file fetch: Task 4 implements `prepared_index_file`.
  - `install.sh` support: Task 5 adds interactive SMB flow and tests secret creation.
  - Settings UI credential management as legacy: Task 6 documents it as follow-up.
- Placeholder scan:
  - No unresolved marker text or unspecified "handle errors" steps remain.
  - Each code-changing step includes exact files and code snippets.
- Type consistency:
  - `RemoteCorpusFile`, `SmbConfig`, `SmbCorpusSource`, `sync_smb_once`, and `prepared_index_file` names are introduced before use.
  - `source_kind=smb`, `source_root`, `source_relative_path`, and `storage_path` meanings match the design spec.
