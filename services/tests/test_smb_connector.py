from datetime import datetime, timezone

from services.source_worker.connectors.smb import SmbConnector
from services.source_worker.models import CollectionDescriptor


class Entry:
    def __init__(self, path, *, directory=False, size=0, link=False):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self.directory = directory
        self.size = size
        self.link = link

    def is_dir(self):
        return self.directory

    def is_file(self):
        return not self.directory

    def is_symlink(self):
        return self.link

    def stat(self, follow_symlinks=False):
        class Stat:
            st_size = self.size
            st_mtime = datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()
            st_file_attributes = 0

        return Stat()


class FakeSmbClient:
    def __init__(self):
        self.registered = []
        self.tree = {
            "//server/share/base": [
                Entry("//server/share/base/ProjectA", directory=True),
                Entry("//server/share/base/linked", directory=True, link=True),
            ],
            "//server/share/base/ProjectA": [
                Entry("//server/share/base/ProjectA/folder", directory=True),
                Entry("//server/share/base/ProjectA/archive.zip", size=4),
            ],
            "//server/share/base/ProjectA/folder": [
                Entry("//server/share/base/ProjectA/folder/report.md", size=5),
            ],
        }

    def register_session(self, host, **kwargs):
        self.registered.append((host, kwargs))

    def scandir(self, path, port=445):
        return self.tree[path]

    def stat(self, path, port=445):
        for entries in self.tree.values():
            for entry in entries:
                if entry.path == path:
                    return entry.stat()
        raise FileNotFoundError(path)

    def open_file(self, path, mode="rb", port=445):
        class Handle:
            chunks = [b"hello", b""]

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return None

            def read(self, size=-1):
                return self.chunks.pop(0)

        return Handle()


def test_streams_smb_collections_and_items_without_following_links(tmp_path):
    client = FakeSmbClient()
    connector = SmbConnector(
        host="server",
        share="share",
        base_path="base",
        username="reader",
        password="secret",
        domain="DOMAIN",
        smbclient_module=client,
    )

    collections = list(connector.discover_collections())
    items = list(connector.scan_collection(collections[0]))

    assert [(item.item_type, item.external_id) for item in items] == [
        ("document", "ProjectA/archive.zip"),
        ("folder", "ProjectA/folder"),
        ("document", "ProjectA/folder/report.md"),
    ]
    assert items[0].media_type == "unsupported"
    assert items[2].source_revision.startswith("smb:")
    assert client.registered == [
        (
            "server",
            {
                "username": "DOMAIN\\reader",
                "password": "secret",
                "port": 445,
                "auth_protocol": "ntlm",
            },
        )
    ]


def test_fetches_the_expected_smb_revision_with_a_size_bound(tmp_path):
    client = FakeSmbClient()
    connector = SmbConnector(
        host="server",
        share="share",
        base_path="base",
        smbclient_module=client,
    )
    collection = CollectionDescriptor("path:ProjectA", "ProjectA", "ProjectA")
    item = list(connector.scan_collection(collection))[-1]
    destination = tmp_path / "report.md"

    connector.fetch_item(item, destination, item.source_revision or "", 10)

    assert destination.read_bytes() == b"hello"
