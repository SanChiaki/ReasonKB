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
        self.scans = []
        self.stats = []
        self.entries = {}
        self.tree = {
            "//server/share/base": [
                FakeDirEntry("//server/share/base/ProjectA", is_dir=True),
            ],
            "//server/share/base/ProjectA": [
                FakeDirEntry("//server/share/base/ProjectA/report.md", size=12),
                FakeDirEntry("//server/share/base/ProjectA/archive.zip", size=5),
                FakeDirEntry("//server/share/base/ProjectA/.hidden", size=1),
            ],
        }
        for entries in self.tree.values():
            for entry in entries:
                self.entries[entry.path] = entry

    def register_session(self, server, username=None, password=None, port=445, auth_protocol="ntlm", **kwargs):
        self.registered.append((server, username, password, port, auth_protocol))

    def scandir(self, path, port=445):
        self.scans.append((path, port))
        return self.tree[path]

    def open_file(self, path, mode="rb", port=445):
        class Handle:
            def __init__(self_inner):
                self_inner.chunks = [b"hello", b""]

            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, exc_type, exc, tb):
                return None

            def read(self_inner, size=-1):
                return self_inner.chunks.pop(0)

        self.downloads.append((path, mode, port))
        return Handle()

    def stat(self, path, port=445):
        self.stats.append((path, port))
        return self.entries[path].stat()


class FakeShortReadSmbClient(FakeSmbClient):
    def open_file(self, path, mode="rb", port=445):
        class Handle:
            def __init__(self_inner):
                self_inner.chunks = [b"he", b"llo", b""]

            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, exc_type, exc, tb):
                return None

            def read(self_inner, size=-1):
                return self_inner.chunks.pop(0)

        self.downloads.append((path, mode, port))
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

    assert [file.source_relative_path for file in files] == ["ProjectA/report.md", "ProjectA/archive.zip"]
    assert files[0].project_name == "ProjectA"
    assert files[0].project_relative_path == "report.md"
    assert files[0].media_type == "markdown"
    assert files[1].media_type == "unsupported"
    assert fake_client.downloads == []
    assert fake_client.registered == [("server", "DOMAIN\\alice", "secret", 445, "ntlm")]


def test_smb_source_uses_configured_port_for_scan_and_fetch(tmp_path):
    fake_client = FakeSmbClient()
    source = SmbCorpusSource(
        SmbConfig(host="server", share="share", base_path="base", port=1445),
        smbclient_module=fake_client,
    )

    source.list_files()
    destination = tmp_path / "report.md"
    source.fetch_file("ProjectA/report.md", destination)

    assert fake_client.registered == [("server", None, None, 1445, "ntlm")]
    assert fake_client.scans == [
        ("//server/share/base", 1445),
        ("//server/share/base/ProjectA", 1445),
    ]
    assert fake_client.stats == [
        ("//server/share/base/ProjectA/report.md", 1445),
        ("//server/share/base/ProjectA/archive.zip", 1445),
    ]
    assert fake_client.downloads == [("//server/share/base/ProjectA/report.md", "rb", 1445)]


def test_smb_source_ignores_root_level_unsupported_files(tmp_path):
    fake_client = FakeSmbClient()
    fake_client.tree["//server/share/base"].append(FakeDirEntry("//server/share/base/archive.zip", size=5))
    source = SmbCorpusSource(
        SmbConfig(host="server", share="share", base_path="base"),
        smbclient_module=fake_client,
    )

    files = source.list_files()

    assert "archive.zip" not in [file.source_relative_path for file in files]


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
    assert fake_client.downloads == [("//server/share/base/ProjectA/report.md", "rb", 445)]


def test_smb_source_fetches_until_empty_read_after_short_chunks(tmp_path):
    username_file = tmp_path / "username"
    password_file = tmp_path / "password"
    username_file.write_text("alice", encoding="utf-8")
    password_file.write_text("secret", encoding="utf-8")
    fake_client = FakeShortReadSmbClient()
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
    assert fake_client.downloads == [("//server/share/base/ProjectA/report.md", "rb", 445)]
