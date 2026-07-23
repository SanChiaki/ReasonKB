from __future__ import annotations

import json
import mimetypes
import os
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Callable, Iterator

from services.common.source_formats import media_type_for_name
from services.source_worker.models import (
    EMPTY_EXCLUSION_PLAN,
    CollectionDescriptor,
    ExclusionPlan,
    SourceAccessDenied,
    SourceItemMetadata,
)

PAGE_SIZE = 100
COPY_CHUNK_SIZE = 1024 * 1024


class SeeyonError(RuntimeError):
    pass


class SeeyonHttpError(SeeyonError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class SeeyonTokenCache:
    """Process-local token cache with one authenticator in flight per source revision."""

    def __init__(self, *, tokens=None, in_flight=None, guard=None) -> None:
        self._guard = guard or threading.Lock()
        self._tokens = tokens if tokens is not None else {}
        self._in_flight = in_flight if in_flight is not None else {}

    def get_or_authenticate(self, key: str, authenticate: Callable[[], str]) -> str:
        owner = f"{os.getpid()}:{threading.get_ident()}:{time.time_ns()}"
        while True:
            should_authenticate = False
            now = time.time()
            with self._guard:
                cached = self._tokens.get(key)
                if cached:
                    return cached
                lease = self._in_flight.get(key)
                if not lease or float(lease[1]) <= now:
                    self._in_flight[key] = (owner, now + 90)
                    should_authenticate = True
            if not should_authenticate:
                time.sleep(0.02)
                continue
            try:
                token = authenticate()
            except BaseException:
                with self._guard:
                    lease = self._in_flight.get(key)
                    if lease and lease[0] == owner:
                        self._in_flight.pop(key, None)
                raise
            with self._guard:
                lease = self._in_flight.get(key)
                if lease and lease[0] == owner:
                    self._tokens[key] = token
                    self._in_flight.pop(key, None)
                    return token

    def invalidate(self, key: str, expected_token: str | None = None) -> None:
        with self._guard:
            if expected_token is None or self._tokens.get(key) == expected_token:
                self._tokens.pop(key, None)


PROCESS_TOKEN_CACHE = SeeyonTokenCache()


def configure_process_token_cache(cache: SeeyonTokenCache) -> None:
    global PROCESS_TOKEN_CACHE
    PROCESS_TOKEN_CACHE = cache


class SeeyonConnector:
    kind = "seeyon"

    def __init__(
        self,
        endpoint: str,
        login_name: str,
        username: str,
        password: str,
        *,
        timeout: float = 30.0,
        opener=None,
        token_cache: SeeyonTokenCache | None = None,
        token_cache_key: str | None = None,
    ):
        self.base_url = self._normalize_endpoint(endpoint)
        self.login_name = login_name
        self.username = username
        self.password = password
        self.timeout = timeout
        self._token: str | None = None
        self._token_cache = token_cache or PROCESS_TOKEN_CACHE
        self._token_cache_key = token_cache_key or f"connector:{id(self)}"
        if opener is None:
            context = ssl.create_default_context()
            opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context))
        self.opener = opener

    @staticmethod
    def _normalize_endpoint(endpoint: str) -> str:
        value = endpoint.strip().rstrip("/")
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise SeeyonError("Seeyon endpoint must include HTTP or HTTPS and a host")
        if not parsed.path.rstrip("/").endswith("/seeyon"):
            value += "/seeyon"
        return value

    def validate(self) -> None:
        self._token_value()

    def discover_collections(self) -> Iterator[CollectionDescriptor]:
        if False:
            yield CollectionDescriptor("", "", "")

    def validate_collection(self, collection: CollectionDescriptor) -> None:
        if not collection.root_external_id:
            raise SeeyonError("Seeyon Collection Registration is missing rootArchiveId")
        try:
            self._list_page(collection.root_external_id, 1, 1)
        except SeeyonHttpError as error:
            if error.status == 403:
                raise SourceAccessDenied(
                    "collection",
                    collection.root_external_id,
                    "Seeyon collection root access denied",
                ) from error
            raise

    def scan_collection(
        self,
        collection: CollectionDescriptor,
        exclusions: ExclusionPlan = EMPTY_EXCLUSION_PLAN,
    ) -> Iterator[SourceItemMetadata]:
        if not collection.root_external_id:
            raise SeeyonError("Seeyon Collection Registration is missing rootArchiveId")
        yield from self._walk_archive(
            collection.root_external_id,
            None,
            PurePosixPath(),
            is_collection_root=True,
            exclusions=exclusions,
        )

    def _walk_archive(
        self,
        archive_id: str,
        parent_external_id: str | None,
        relative_root: PurePosixPath,
        *,
        is_collection_root: bool = False,
        exclusions: ExclusionPlan = EMPTY_EXCLUSION_PLAN,
    ) -> Iterator[SourceItemMetadata]:
        page_number = 1
        while True:
            try:
                response = self._list_page(archive_id, page_number, PAGE_SIZE)
            except SeeyonHttpError as error:
                if error.status == 403:
                    scope = "collection" if is_collection_root else "subtree"
                    raise SourceAccessDenied(
                        scope,
                        archive_id,
                        f"Seeyon {scope} access denied",
                    ) from error
                raise
            data = response.get("data")
            if not isinstance(data, list):
                raise SeeyonError("Seeyon document list response has no data array")
            for raw in data:
                if not isinstance(raw, dict):
                    raise SeeyonError("Seeyon document list contains a non-object item")
                item_id = self._opaque_id(raw.get("fr_id"), "fr_id")
                name = str(raw.get("fr_name") or raw.get("file_name") or item_id)
                relative_path = relative_root / name
                if raw.get("is_folder") is True:
                    yield SourceItemMetadata(
                        external_id=item_id,
                        parent_external_id=parent_external_id,
                        item_type="folder",
                        name=name,
                        relative_path=relative_path.as_posix(),
                        metadata={"frType": raw.get("fr_type")},
                    )
                    if exclusions.excludes(item_id, "folder"):
                        continue
                    yield from self._walk_archive(
                        item_id,
                        item_id,
                        relative_path,
                        exclusions=exclusions,
                    )
                    continue
                size = self._integer(raw.get("fr_size"), "fr_size")
                if raw.get("file_id") is None:
                    yield SourceItemMetadata(
                        external_id=item_id,
                        parent_external_id=parent_external_id,
                        item_type="document",
                        name=name,
                        relative_path=relative_path.as_posix(),
                        mime_type=mimetypes.guess_type(name)[0] or "application/octet-stream",
                        size_bytes=size,
                        source_revision=f"seeyon:no-file-id:{size}",
                        fetch_locator=None,
                        media_type="unsupported",
                        metadata={
                            "skipCode": "seeyon_missing_file_id",
                            "unsupportedReason": "Seeyon item has no file_id and was not imported.",
                            "frCreateTime": raw.get("fr_create_time"),
                            "frType": raw.get("fr_type"),
                        },
                    )
                    continue
                file_id = self._opaque_id(raw.get("file_id"), "file_id")
                file_name = str(raw.get("file_name") or name)
                yield SourceItemMetadata(
                    external_id=item_id,
                    parent_external_id=parent_external_id,
                    item_type="document",
                    name=file_name,
                    relative_path=(relative_root / file_name).as_posix(),
                    mime_type=mimetypes.guess_type(file_name)[0] or "application/octet-stream",
                    size_bytes=size,
                    source_revision=f"seeyon:{file_id}:{size}",
                    fetch_locator=file_id,
                    media_type=media_type_for_name(file_name),
                    metadata={
                        "fileId": file_id,
                        "frCreateTime": raw.get("fr_create_time"),
                        "frType": raw.get("fr_type"),
                    },
                )
            pages = self._integer(response.get("pages", 1), "pages")
            if page_number >= pages:
                break
            page_number += 1

    def fetch_item(
        self,
        item: SourceItemMetadata,
        destination: Path,
        expected_revision: str,
        maximum_bytes: int,
    ) -> None:
        if item.source_revision != expected_revision or not item.fetch_locator:
            raise SeeyonError("Seeyon Source Revision changed before fetch")
        token = self._token_value()
        request = self._request(
            "GET",
            f"/rest/attachment/file/{urllib.parse.quote(item.fetch_locator, safe='')}",
            token=token,
            query={"fileName": item.name},
            accept="*/*",
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            response = self._open(request)
        except SeeyonHttpError as error:
            if error.status == 403:
                raise SourceAccessDenied(
                    "item",
                    item.external_id,
                    "Seeyon source item access denied",
                ) from error
            if error.status != 401:
                raise
            self._invalidate_token(token)
            retry_token = self._token_value()
            request = self._request(
                "GET",
                f"/rest/attachment/file/{urllib.parse.quote(item.fetch_locator, safe='')}",
                token=retry_token,
                query={"fileName": item.name},
                accept="*/*",
            )
            try:
                response = self._open(request)
            except SeeyonHttpError as retry_error:
                if retry_error.status == 403:
                    raise SourceAccessDenied(
                        "item",
                        item.external_id,
                        "Seeyon source item access denied",
                    ) from retry_error
                raise
        with response:
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > maximum_bytes:
                raise SeeyonError("Seeyon document exceeds the configured size limit")
            copied = self._copy(response, destination, maximum_bytes)
        if item.size_bytes is not None and copied != item.size_bytes:
            destination.unlink(missing_ok=True)
            raise SeeyonError("Downloaded Seeyon document size does not match fr_size")

    def _list_page(self, archive_id: str, page_number: int, page_size: int) -> dict[str, object]:
        response = self._business_json(
            "POST",
            "/rest/docs/search",
            {
                "archiveID": archive_id,
                "searchType": "",
                "propertyName": "",
                "simple": "",
                "value1": "",
                "pageNo": str(page_number),
                "pageSize": str(page_size),
            },
        )
        if not isinstance(response, dict):
            raise SeeyonError("Seeyon document list endpoint returned non-object JSON")
        return response

    def _authenticate(self) -> str:
        try:
            response = self._json_request(
                "POST",
                "/rest/token",
                payload={
                    "userName": self.username,
                    "password": self.password,
                    "loginName": self.login_name,
                },
            )
        except SeeyonHttpError as error:
            if error.status == 403:
                raise SourceAccessDenied(
                    "source", message="Seeyon source authentication access denied"
                ) from error
            raise
        if not isinstance(response, dict):
            raise SeeyonError("Seeyon token endpoint returned non-object JSON")
        token = response.get("id")
        if not isinstance(token, str) or not token or token == "-1":
            raise SeeyonError("Seeyon token acquisition failed")
        binding = response.get("bindingUser")
        if binding is None:
            raise SeeyonError("Seeyon token is not bound to an OA user")
        if isinstance(binding, dict):
            bound_login = binding.get("loginName")
            if bound_login and str(bound_login) != self.login_name:
                raise SeeyonError("Seeyon token is bound to an unexpected OA user")
        return token

    def _token_value(self) -> str:
        if self._token:
            return self._token
        self._token = self._token_cache.get_or_authenticate(
            self._token_cache_key,
            self._authenticate,
        )
        return self._token

    def _invalidate_token(self, expected_token: str) -> None:
        self._token = None
        self._token_cache.invalidate(self._token_cache_key, expected_token)

    def _business_json(self, method: str, path: str, payload: dict[str, object]):
        token = self._token_value()
        try:
            return self._json_request(
                method, path, token=token, payload=payload
            )
        except SeeyonHttpError as error:
            if error.status != 401:
                raise
            self._invalidate_token(token)
            return self._json_request(
                method, path, token=self._token_value(), payload=payload
            )

    def _json_request(
        self,
        method: str,
        path: str,
        *,
        token: str | None = None,
        payload: dict[str, object] | None = None,
    ):
        request = self._request(method, path, token=token, payload=payload)
        with self._open(request) as response:
            body = response.read()
            charset = response.headers.get_content_charset() or "utf-8"
        try:
            return json.loads(body.decode(charset, errors="replace"))
        except json.JSONDecodeError as error:
            raise SeeyonError("Seeyon endpoint returned invalid JSON") from error

    def _request(
        self,
        method: str,
        path: str,
        *,
        token: str | None = None,
        query: dict[str, str] | None = None,
        payload: dict[str, object] | None = None,
        accept: str = "application/json",
    ) -> urllib.request.Request:
        headers = {"Accept": accept, "User-Agent": "ReasonKB/1.0"}
        if token:
            headers["token"] = token
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = None
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json;charset=UTF-8"
        return urllib.request.Request(url, data=data, headers=headers, method=method)

    def _open(self, request: urllib.request.Request):
        try:
            return self.opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            raise SeeyonHttpError(error.code, f"Seeyon request failed with HTTP {error.code}") from error
        except urllib.error.URLError as error:
            raise SeeyonError(f"Seeyon connection failed: {error.reason}") from error
        except TimeoutError as error:
            raise SeeyonError("Seeyon connection timed out") from error

    @staticmethod
    def _copy(source: BinaryIO, destination: Path, maximum_bytes: int) -> int:
        copied = 0
        try:
            with destination.open("wb") as target:
                while chunk := source.read(COPY_CHUNK_SIZE):
                    copied += len(chunk)
                    if copied > maximum_bytes:
                        raise SeeyonError("Seeyon document exceeded the size limit during download")
                    target.write(chunk)
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        return copied

    @staticmethod
    def _opaque_id(value: object, field: str) -> str:
        if isinstance(value, bool) or value is None:
            raise SeeyonError(f"Seeyon item has invalid {field}")
        result = str(value)
        if not result or not result.lstrip("-").isdigit():
            raise SeeyonError(f"Seeyon item has invalid {field}")
        return result

    @staticmethod
    def _integer(value: object, field: str) -> int:
        if isinstance(value, bool):
            raise SeeyonError(f"Seeyon response has invalid {field}")
        try:
            result = int(value)  # type: ignore[arg-type]
        except (TypeError, ValueError) as error:
            raise SeeyonError(f"Seeyon response has invalid {field}") from error
        if result < 0:
            raise SeeyonError(f"Seeyon response has invalid {field}")
        return result
