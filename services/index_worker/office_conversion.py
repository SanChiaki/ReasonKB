from __future__ import annotations

import hashlib
import mimetypes
import time
import urllib.error
import urllib.request
from pathlib import Path

from services.common.settings import (
    CONVERTED_ROOT,
    GOTENBERG_URL,
    OFFICE_CONVERSION_TIMEOUT_SECONDS,
)

CONVERSION_ATTEMPTS = 3
CONVERSION_RETRY_DELAY_SECONDS = 2


class OfficeConversionError(RuntimeError):
    pass


def convert_office_to_pdf(file_path: str, document: dict) -> str:
    source_path = Path(file_path)
    if not source_path.exists():
        raise OfficeConversionError(f"Office source file does not exist: {file_path}")

    output_path = _output_pdf_path(source_path, document)
    if output_path.exists() and output_path.stat().st_size > 0:
        return str(output_path)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    pdf_bytes = _request_gotenberg_conversion_with_retries(source_path)
    if not pdf_bytes.startswith(b"%PDF-"):
        raise OfficeConversionError("Gotenberg returned a non-PDF response for Office conversion.")
    output_path.write_bytes(pdf_bytes)
    return str(output_path)


def _output_pdf_path(source_path: Path, document: dict) -> Path:
    document_id = document.get("document_id") or document.get("id") or source_path.stem
    content_hash = document.get("content_hash")
    if isinstance(content_hash, str) and content_hash:
        suffix = content_hash.split(":", 1)[-1][:16]
    else:
        digest = hashlib.sha256(str(source_path).encode("utf-8")).hexdigest()
        suffix = digest[:16]
    return Path(CONVERTED_ROOT) / f"{document_id}-{suffix}.pdf"


def _request_gotenberg_conversion(source_path: Path) -> bytes:
    boundary = "----ReasonKBOfficeBoundary"
    mime_type = mimetypes.guess_type(source_path.name)[0] or "application/octet-stream"
    body = b"".join(
        [
            f"--{boundary}\r\n".encode("utf-8"),
            (
                'Content-Disposition: form-data; name="files"; '
                f'filename="{source_path.name}"\r\n'
            ).encode("utf-8"),
            f"Content-Type: {mime_type}\r\n\r\n".encode("utf-8"),
            source_path.read_bytes(),
            b"\r\n",
            f"--{boundary}--\r\n".encode("utf-8"),
        ]
    )
    endpoint = f"{GOTENBERG_URL.rstrip('/')}/forms/libreoffice/convert"
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(
            request,
            timeout=OFFICE_CONVERSION_TIMEOUT_SECONDS,
        ) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise OfficeConversionError(
            f"Gotenberg Office conversion failed with HTTP {exc.code}: {details[:500]}"
        ) from exc
    except urllib.error.URLError as exc:
        raise OfficeConversionError(f"Gotenberg Office conversion failed: {exc.reason}") from exc
    except TimeoutError as exc:
        raise OfficeConversionError("Gotenberg Office conversion timed out.") from exc


def _request_gotenberg_conversion_with_retries(source_path: Path) -> bytes:
    last_error: OfficeConversionError | None = None
    for attempt in range(1, CONVERSION_ATTEMPTS + 1):
        try:
            return _request_gotenberg_conversion(source_path)
        except OfficeConversionError as exc:
            last_error = exc
            if attempt == CONVERSION_ATTEMPTS:
                break
            time.sleep(CONVERSION_RETRY_DELAY_SECONDS)
    assert last_error is not None
    raise last_error
