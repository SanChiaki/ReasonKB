from concurrent.futures import ThreadPoolExecutor
import io
import json
from email.message import Message
from pathlib import Path
import multiprocessing
import time
import urllib.error

import pytest

from services.source_worker.connectors.seeyon import (
    SeeyonConnector,
    SeeyonHttpError,
    SeeyonTokenCache,
)
from services.source_worker.models import CollectionDescriptor, SourceAccessDenied


class FakeResponse:
    def __init__(self, body: bytes, content_type: str = "application/json"):
        self.body = io.BytesIO(body)
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        self.headers["Content-Length"] = str(len(body))

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return None

    def read(self, size=-1):
        return self.body.read(size)


class FakeOpener:
    def __init__(self):
        self.requests = []
        self.token_count = 0

    def open(self, request, timeout=0):
        self.requests.append(request)
        if request.full_url.endswith("/rest/token"):
            self.token_count += 1
            return FakeResponse(
                json.dumps(
                    {
                        "id": f"token-{self.token_count}",
                        "bindingUser": {"loginName": "reader"},
                    }
                ).encode()
            )
        if request.full_url.endswith("/rest/docs/search"):
            payload = json.loads(request.data)
            if payload["archiveID"] == "1002":
                return FakeResponse(
                    json.dumps(
                        {
                            "total": 2,
                            "pages": 1,
                            "data": [
                                {
                                    "fr_id": "3833864781257523919",
                                    "fr_name": "Folder",
                                    "is_folder": True,
                                    "fr_type": 31,
                                    "fr_size": 0,
                                },
                                {
                                    "fr_id": "5594372999647937129",
                                    "fr_name": "root.xlsx",
                                    "file_name": "root.xlsx",
                                    "file_id": 6951434855901449788,
                                    "fr_size": 5,
                                    "is_folder": False,
                                    "fr_type": 21,
                                },
                            ],
                        }
                    ).encode()
                )
            return FakeResponse(
                json.dumps(
                    {
                        "total": 1,
                        "pages": 1,
                        "data": [
                            {
                                "fr_id": "6225837836336318809",
                                "fr_name": "nested.md",
                                "file_name": "nested.md",
                                "file_id": -1082062512454808173,
                                "fr_size": 6,
                                "is_folder": False,
                                "fr_type": 21,
                            }
                        ],
                    }
                ).encode()
            )
        if "/rest/attachment/file/" in request.full_url:
            return FakeResponse(b"hello", "application/octet-stream")
        raise AssertionError(request.full_url)


def connector(opener=None):
    return SeeyonConnector(
        "https://oa.example.test",
        "reader",
        "rest-user",
        "secret",
        opener=opener or FakeOpener(),
    )


def _shared_token_cache_worker(cache, start_event, authentication_count, results):
    start_event.wait()

    def authenticate():
        with authentication_count.get_lock():
            authentication_count.value += 1
        time.sleep(0.05)
        return "shared-token"

    results.put(cache.get_or_authenticate("src-1:revision-4", authenticate))


def test_recursively_maps_verified_seeyon_81sp2_fields_to_source_items():
    source = connector()
    collection = CollectionDescriptor(
        identity_key="seeyon:1001:1002",
        external_id="1001",
        root_external_id="1002",
        display_name="Documents",
    )

    items = list(source.scan_collection(collection))

    assert [(item.item_type, item.external_id, item.relative_path) for item in items] == [
        ("folder", "3833864781257523919", "Folder"),
        ("document", "6225837836336318809", "Folder/nested.md"),
        ("document", "5594372999647937129", "root.xlsx"),
    ]
    assert items[1].source_revision == "seeyon:-1082062512454808173:6"
    assert items[1].fetch_locator == "-1082062512454808173"
    assert items[2].source_revision == "seeyon:6951434855901449788:5"
    assert isinstance(items[2].external_id, str)


def test_downloads_the_current_file_id_and_checks_fr_size(tmp_path):
    source = connector()
    collection = CollectionDescriptor(
        identity_key="seeyon:1001:1002",
        external_id="1001",
        root_external_id="1002",
        display_name="Documents",
    )
    item = list(source.scan_collection(collection))[-1]
    destination = tmp_path / "root.xlsx"

    source.fetch_item(item, destination, item.source_revision or "", 100)

    assert destination.read_bytes() == b"hello"


def test_reauthenticates_once_after_a_business_request_401(monkeypatch):
    source = connector()
    attempts = 0
    original = source._json_request

    def request(*args, **kwargs):
        nonlocal attempts
        if args[1] == "/rest/docs/search":
            attempts += 1
            if attempts == 1:
                raise SeeyonHttpError(401, "expired")
        return original(*args, **kwargs)

    monkeypatch.setattr(source, "_json_request", request)
    collection = CollectionDescriptor(
        identity_key="seeyon:1001:1002",
        external_id="1001",
        root_external_id="1002",
        display_name="Documents",
    )

    source.validate_collection(collection)

    assert attempts == 2
    assert source.opener.token_count == 2


def test_concurrent_connectors_share_one_in_flight_token_request():
    class SlowTokenOpener(FakeOpener):
        def open(self, request, timeout=0):
            if request.full_url.endswith("/rest/token"):
                time.sleep(0.05)
            return super().open(request, timeout)

    opener = SlowTokenOpener()
    token_cache = SeeyonTokenCache()
    sources = [
        SeeyonConnector(
            "https://oa.example.test",
            "reader",
            "rest-user",
            "secret",
            opener=opener,
            token_cache=token_cache,
            token_cache_key="src-1:revision-4",
        )
        for _ in range(8)
    ]

    with ThreadPoolExecutor(max_workers=8) as executor:
        tokens = list(executor.map(lambda source: source._token_value(), sources))

    assert tokens == ["token-1"] * 8
    assert opener.token_count == 1


def test_index_processes_share_one_in_flight_token_request():
    context = multiprocessing.get_context("spawn")
    manager = context.Manager()
    try:
        cache = SeeyonTokenCache(
            tokens=manager.dict(),
            in_flight=manager.dict(),
            guard=manager.RLock(),
        )
        start_event = context.Event()
        authentication_count = context.Value("i", 0)
        results = context.Queue()
        processes = [
            context.Process(
                target=_shared_token_cache_worker,
                args=(cache, start_event, authentication_count, results),
            )
            for _ in range(4)
        ]
        for process in processes:
            process.start()
        start_event.set()
        for process in processes:
            process.join(10)

        assert [process.exitcode for process in processes] == [0, 0, 0, 0]
        assert [results.get(timeout=1) for _ in processes] == ["shared-token"] * 4
        assert authentication_count.value == 1
    finally:
        manager.shutdown()


def test_repeated_401_is_not_retried_more_than_once(monkeypatch):
    source = connector()
    attempts = 0
    original = source._json_request

    def request(*args, **kwargs):
        nonlocal attempts
        if args[1] == "/rest/docs/search":
            attempts += 1
            raise SeeyonHttpError(401, "expired")
        return original(*args, **kwargs)

    monkeypatch.setattr(source, "_json_request", request)
    collection = CollectionDescriptor(
        identity_key="seeyon:1001:1002",
        external_id="1001",
        root_external_id="1002",
        display_name="Documents",
    )

    with pytest.raises(SeeyonHttpError) as raised:
        source.validate_collection(collection)

    assert raised.value.status == 401
    assert attempts == 2
    assert source.opener.token_count == 2


def test_collection_403_is_classified_without_reauthentication(monkeypatch):
    source = connector()
    original = source._json_request

    def request(*args, **kwargs):
        if args[1] == "/rest/docs/search":
            raise SeeyonHttpError(403, "denied")
        return original(*args, **kwargs)

    monkeypatch.setattr(source, "_json_request", request)
    collection = CollectionDescriptor(
        identity_key="seeyon:1001:1002",
        external_id="1001",
        root_external_id="1002",
        display_name="Documents",
    )

    with pytest.raises(SourceAccessDenied) as raised:
        source.validate_collection(collection)

    assert raised.value.scope == "collection"
    assert raised.value.external_id == "1002"
    assert source.opener.token_count == 1


def test_document_403_is_classified_at_item_scope(tmp_path, monkeypatch):
    source = connector()
    collection = CollectionDescriptor(
        identity_key="seeyon:1001:1002",
        external_id="1001",
        root_external_id="1002",
        display_name="Documents",
    )
    item = list(source.scan_collection(collection))[-1]
    original_open = source._open

    def opened(request):
        if "/rest/attachment/file/" in request.full_url:
            raise SeeyonHttpError(403, "denied")
        return original_open(request)

    monkeypatch.setattr(source, "_open", opened)

    with pytest.raises(SourceAccessDenied) as raised:
        source.fetch_item(
            item,
            tmp_path / "root.xlsx",
            item.source_revision or "",
            100,
        )

    assert raised.value.scope == "item"
    assert raised.value.external_id == "5594372999647937129"
    assert source.opener.token_count == 1


def test_empty_seeyon_library_is_a_complete_empty_scan(monkeypatch):
    source = connector()
    original = source._json_request

    def request(*args, **kwargs):
        if args[1] == "/rest/docs/search":
            return {"total": 0, "pages": 1, "data": []}
        return original(*args, **kwargs)

    monkeypatch.setattr(source, "_json_request", request)
    collection = CollectionDescriptor(
        identity_key="seeyon:1001:1002",
        external_id="1001",
        root_external_id="1002",
        display_name="Empty",
    )

    assert list(source.scan_collection(collection)) == []


def test_nested_folder_403_is_classified_as_incomplete_subtree(monkeypatch):
    source = connector()
    original = source._json_request

    def request(*args, **kwargs):
        if args[1] == "/rest/docs/search":
            payload = kwargs.get("payload") or args[2]
            if payload["archiveID"] == "3833864781257523919":
                raise SeeyonHttpError(403, "denied")
        return original(*args, **kwargs)

    monkeypatch.setattr(source, "_json_request", request)
    collection = CollectionDescriptor(
        identity_key="seeyon:1001:1002",
        external_id="1001",
        root_external_id="1002",
        display_name="Documents",
    )

    with pytest.raises(SourceAccessDenied) as raised:
        list(source.scan_collection(collection))

    assert raised.value.scope == "subtree"
    assert raised.value.external_id == "3833864781257523919"


def test_seeyon_connector_uses_only_read_contract_endpoints(tmp_path):
    source = connector()
    collection = CollectionDescriptor(
        identity_key="seeyon:1001:1002",
        external_id="1001",
        root_external_id="1002",
        display_name="Documents",
    )
    item = list(source.scan_collection(collection))[-1]

    source.fetch_item(item, tmp_path / "root.xlsx", item.source_revision or "", 100)

    requests = source.opener.requests
    assert {(request.method, request.full_url.split("?", 1)[0].rsplit("/seeyon", 1)[-1]) for request in requests} <= {
        ("POST", "/rest/token"),
        ("POST", "/rest/docs/search"),
        ("GET", "/rest/attachment/file/6951434855901449788"),
    }
