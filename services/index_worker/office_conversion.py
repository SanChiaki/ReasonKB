from __future__ import annotations

import hashlib
import mimetypes
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from contextlib import contextmanager
from pathlib import Path
from xml.dom import minidom
from xml.dom.minidom import Element

from services.common.settings import (
    CONVERTED_ROOT,
    GOTENBERG_URL,
    OFFICE_CONVERSION_TIMEOUT_SECONDS,
)

CONVERSION_ATTEMPTS = 3
CONVERSION_RETRY_DELAY_SECONDS = 2
XLSX_CONVERSION_PROFILE = "xlsx-fit-width-v1"
XLSX_PAGE_MARGIN_INCHES = "0.1"

SPREADSHEETML_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
WORKSHEET_XML_PREFIX = "xl/worksheets/sheet"

WORKSHEET_CHILD_ORDER = (
    "sheetPr",
    "dimension",
    "sheetViews",
    "sheetFormatPr",
    "cols",
    "sheetData",
    "sheetCalcPr",
    "sheetProtection",
    "protectedRanges",
    "scenarios",
    "autoFilter",
    "sortState",
    "dataConsolidate",
    "customSheetViews",
    "mergeCells",
    "phoneticPr",
    "conditionalFormatting",
    "dataValidations",
    "hyperlinks",
    "printOptions",
    "pageMargins",
    "pageSetup",
    "headerFooter",
    "rowBreaks",
    "colBreaks",
    "customProperties",
    "cellWatches",
    "ignoredErrors",
    "smartTags",
    "drawing",
    "legacyDrawing",
    "legacyDrawingHF",
    "picture",
    "oleObjects",
    "controls",
    "webPublishItems",
    "tableParts",
    "extLst",
)


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
    with _source_for_conversion(source_path) as conversion_source:
        pdf_bytes = _request_gotenberg_conversion_with_retries(conversion_source)
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
    profile_suffix = (
        f"-{XLSX_CONVERSION_PROFILE}" if source_path.suffix.lower() == ".xlsx" else ""
    )
    return Path(CONVERTED_ROOT) / f"{document_id}-{suffix}{profile_suffix}.pdf"


@contextmanager
def _source_for_conversion(source_path: Path):
    if source_path.suffix.lower() != ".xlsx":
        yield source_path
        return

    with tempfile.TemporaryDirectory(prefix="reasonkb-xlsx-") as temporary_directory:
        staged_path = Path(temporary_directory) / source_path.name
        _write_xlsx_with_print_layout(source_path, staged_path)
        yield staged_path


def _write_xlsx_with_print_layout(source_path: Path, staged_path: Path) -> None:
    try:
        with zipfile.ZipFile(source_path, "r") as source_archive:
            with zipfile.ZipFile(staged_path, "w") as staged_archive:
                for entry in source_archive.infolist():
                    content = source_archive.read(entry.filename)
                    if _is_worksheet_xml(entry.filename):
                        content = _apply_worksheet_print_layout(content)
                    staged_archive.writestr(entry, content)
    except (OSError, zipfile.BadZipFile) as exc:
        raise OfficeConversionError(f"Could not prepare XLSX print layout: {exc}") from exc


def _is_worksheet_xml(archive_path: str) -> bool:
    if not archive_path.startswith(WORKSHEET_XML_PREFIX) or not archive_path.endswith(".xml"):
        return False
    sheet_number = archive_path[len(WORKSHEET_XML_PREFIX) : -len(".xml")]
    return sheet_number.isdigit()


def _apply_worksheet_print_layout(worksheet_xml: bytes) -> bytes:
    try:
        document = minidom.parseString(worksheet_xml)
    except Exception as exc:
        raise OfficeConversionError(f"Could not parse XLSX worksheet XML: {exc}") from exc

    worksheet = document.documentElement
    sheet_properties = _first_child(worksheet, "sheetPr")
    if sheet_properties is None:
        sheet_properties = document.createElementNS(SPREADSHEETML_NAMESPACE, "sheetPr")
        _insert_worksheet_child(worksheet, sheet_properties)

    page_setup_properties = _first_child(sheet_properties, "pageSetUpPr")
    if page_setup_properties is None:
        page_setup_properties = document.createElementNS(
            SPREADSHEETML_NAMESPACE,
            "pageSetUpPr",
        )
        sheet_properties.appendChild(page_setup_properties)
    page_setup_properties.setAttribute("fitToPage", "1")

    page_margins = _first_child(worksheet, "pageMargins")
    if page_margins is None:
        page_margins = document.createElementNS(SPREADSHEETML_NAMESPACE, "pageMargins")
        _insert_worksheet_child(worksheet, page_margins)
    for margin_name in ("left", "right", "top", "bottom"):
        page_margins.setAttribute(margin_name, XLSX_PAGE_MARGIN_INCHES)
    page_margins.setAttribute("header", "0")
    page_margins.setAttribute("footer", "0")

    page_setup = _first_child(worksheet, "pageSetup")
    if page_setup is None:
        page_setup = document.createElementNS(SPREADSHEETML_NAMESPACE, "pageSetup")
        _insert_worksheet_child(worksheet, page_setup)
    if page_setup.hasAttribute("scale"):
        page_setup.removeAttribute("scale")
    page_setup.setAttribute("orientation", "landscape")
    page_setup.setAttribute("fitToWidth", "1")
    page_setup.setAttribute("fitToHeight", "0")

    column_breaks = _first_child(worksheet, "colBreaks")
    if column_breaks is not None:
        worksheet.removeChild(column_breaks)

    return document.toxml(encoding="UTF-8", standalone=True)


def _first_child(parent: Element, local_name: str) -> Element | None:
    for child in parent.childNodes:
        if child.nodeType == child.ELEMENT_NODE and child.localName == local_name:
            return child
    return None


def _insert_worksheet_child(worksheet: Element, new_child: Element) -> None:
    order = {name: index for index, name in enumerate(WORKSHEET_CHILD_ORDER)}
    new_child_order = order[new_child.localName]
    for child in worksheet.childNodes:
        if child.nodeType != child.ELEMENT_NODE:
            continue
        child_order = order.get(child.localName, len(order))
        if child_order > new_child_order:
            worksheet.insertBefore(new_child, child)
            return
    worksheet.appendChild(new_child)


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
