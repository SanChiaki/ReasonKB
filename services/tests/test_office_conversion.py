import io
import zipfile
from pathlib import Path
from xml.etree import ElementTree

import pytest

from services.index_worker import office_conversion
from services.index_worker.office_conversion import OfficeConversionError, convert_office_to_pdf


SPREADSHEETML_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
XML_NAMESPACE = {"x": SPREADSHEETML_NAMESPACE}


class _FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        return False

    def read(self) -> bytes:
        return self._body


def test_convert_office_to_pdf_posts_file_to_gotenberg_and_writes_pdf(tmp_path, monkeypatch):
    source = tmp_path / "scope.docx"
    source.write_bytes(b"office body")
    converted_root = tmp_path / "converted"
    captured = {}

    monkeypatch.setattr(office_conversion, "CONVERTED_ROOT", converted_root)
    monkeypatch.setattr(office_conversion, "GOTENBERG_URL", "http://gotenberg:3000/")

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        captured["content_type"] = request.headers["Content-type"]
        captured["body"] = request.data
        return _FakeResponse(b"%PDF-1.7\nconverted")

    monkeypatch.setattr(office_conversion.urllib.request, "urlopen", fake_urlopen)

    result = convert_office_to_pdf(
        str(source),
        {"document_id": "doc_1", "content_hash": "sha256:abcdef1234567890"},
    )

    output = Path(result)
    assert output == converted_root / "doc_1-abcdef1234567890.pdf"
    assert output.read_bytes() == b"%PDF-1.7\nconverted"
    assert captured["url"] == "http://gotenberg:3000/forms/libreoffice/convert"
    assert captured["timeout"] == office_conversion.OFFICE_CONVERSION_TIMEOUT_SECONDS
    assert captured["content_type"].startswith("multipart/form-data; boundary=")
    assert b'name="files"; filename="scope.docx"' in captured["body"]
    assert b"office body" in captured["body"]


def test_convert_office_to_pdf_reuses_existing_pdf_without_calling_gotenberg(tmp_path, monkeypatch):
    source = tmp_path / "scope.docx"
    source.write_bytes(b"office body")
    converted_root = tmp_path / "converted"
    output = converted_root / "doc_1-abcdef1234567890.pdf"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"%PDF-1.7\ncached")

    monkeypatch.setattr(office_conversion, "CONVERTED_ROOT", converted_root)

    def fail_urlopen(_request, _timeout):
        raise AssertionError("Gotenberg should not be called for cached conversion")

    monkeypatch.setattr(office_conversion.urllib.request, "urlopen", fail_urlopen)

    result = convert_office_to_pdf(
        str(source),
        {"document_id": "doc_1", "content_hash": "sha256:abcdef1234567890"},
    )

    assert result == str(output)
    assert output.read_bytes() == b"%PDF-1.7\ncached"


def test_convert_office_to_pdf_rejects_non_pdf_gotenberg_response(tmp_path, monkeypatch):
    source = tmp_path / "scope.docx"
    source.write_bytes(b"office body")
    monkeypatch.setattr(office_conversion, "CONVERTED_ROOT", tmp_path / "converted")
    monkeypatch.setattr(
        office_conversion.urllib.request,
        "urlopen",
        lambda _request, timeout: _FakeResponse(b"not a pdf"),
    )

    with pytest.raises(OfficeConversionError, match="non-PDF"):
        convert_office_to_pdf(str(source), {"document_id": "doc_1"})


def test_convert_office_to_pdf_retries_transient_gotenberg_connection_errors(tmp_path, monkeypatch):
    source = tmp_path / "scope.docx"
    source.write_bytes(b"office body")
    calls = {"count": 0}

    monkeypatch.setattr(office_conversion, "CONVERTED_ROOT", tmp_path / "converted")
    monkeypatch.setattr(office_conversion.time, "sleep", lambda _seconds: None)

    def flaky_urlopen(_request, timeout):
        calls["count"] += 1
        if calls["count"] == 1:
            raise office_conversion.urllib.error.URLError("connection refused")
        return _FakeResponse(b"%PDF-1.7\nconverted")

    monkeypatch.setattr(office_conversion.urllib.request, "urlopen", flaky_urlopen)

    result = convert_office_to_pdf(str(source), {"document_id": "doc_1"})

    assert Path(result).read_bytes() == b"%PDF-1.7\nconverted"
    assert calls["count"] == 2


def test_convert_xlsx_to_pdf_applies_fit_width_layout_without_changing_source(
    tmp_path,
    monkeypatch,
):
    source = tmp_path / "wide.xlsx"
    original_bytes = _write_test_xlsx(source)
    converted_root = tmp_path / "converted"
    captured = {}

    monkeypatch.setattr(office_conversion, "CONVERTED_ROOT", converted_root)

    def fake_urlopen(request, timeout):
        captured["body"] = request.data
        return _FakeResponse(b"%PDF-1.7\nconverted")

    monkeypatch.setattr(office_conversion.urllib.request, "urlopen", fake_urlopen)

    result = convert_office_to_pdf(
        str(source),
        {"document_id": "doc_1", "content_hash": "sha256:abcdef1234567890"},
    )

    assert Path(result) == (
        converted_root / "doc_1-abcdef1234567890-xlsx-fit-width-v1.pdf"
    )
    assert source.read_bytes() == original_bytes
    uploaded_xlsx = _multipart_file_content(captured["body"])

    with zipfile.ZipFile(io.BytesIO(uploaded_xlsx)) as archive:
        assert archive.read("xl/workbook.xml") == b"unchanged workbook part"
        for worksheet_name in ("xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"):
            worksheet_xml = archive.read(worksheet_name)
            root = ElementTree.fromstring(worksheet_xml)
            page_setup_properties = root.find("x:sheetPr/x:pageSetUpPr", XML_NAMESPACE)
            page_margins = root.find("x:pageMargins", XML_NAMESPACE)
            page_setup = root.find("x:pageSetup", XML_NAMESPACE)

            assert page_setup_properties is not None
            assert page_setup_properties.attrib["fitToPage"] == "1"
            assert page_margins is not None
            assert page_margins.attrib == {
                "left": "0.1",
                "right": "0.1",
                "top": "0.1",
                "bottom": "0.1",
                "header": "0",
                "footer": "0",
            }
            assert page_setup is not None
            assert page_setup.attrib["orientation"] == "landscape"
            assert page_setup.attrib["fitToWidth"] == "1"
            assert page_setup.attrib["fitToHeight"] == "0"
            assert "scale" not in page_setup.attrib
            assert root.find("x:colBreaks", XML_NAMESPACE) is None

        assert b'xmlns:xr2="http://example.com/revision2"' in archive.read(
            "xl/worksheets/sheet2.xml"
        )


def test_convert_xlsx_to_pdf_updates_existing_print_elements_without_duplicates(
    tmp_path,
    monkeypatch,
):
    source = tmp_path / "wide.xlsx"
    _write_test_xlsx(source)
    captured = {}

    monkeypatch.setattr(office_conversion, "CONVERTED_ROOT", tmp_path / "converted")

    def fake_urlopen(request, timeout):
        captured["body"] = request.data
        return _FakeResponse(b"%PDF-1.7\nconverted")

    monkeypatch.setattr(office_conversion.urllib.request, "urlopen", fake_urlopen)

    convert_office_to_pdf(str(source), {"document_id": "doc_1"})
    uploaded_xlsx = _multipart_file_content(captured["body"])

    with zipfile.ZipFile(io.BytesIO(uploaded_xlsx)) as archive:
        root = ElementTree.fromstring(archive.read("xl/worksheets/sheet2.xml"))

    assert len(root.findall("x:sheetPr", XML_NAMESPACE)) == 1
    assert len(root.findall("x:sheetPr/x:pageSetUpPr", XML_NAMESPACE)) == 1
    assert len(root.findall("x:pageMargins", XML_NAMESPACE)) == 1
    assert len(root.findall("x:pageSetup", XML_NAMESPACE)) == 1


def test_convert_xlsx_retries_with_the_same_prepared_workbook(tmp_path, monkeypatch):
    source = tmp_path / "wide.xlsx"
    _write_test_xlsx(source)
    request_bodies = []

    monkeypatch.setattr(office_conversion, "CONVERTED_ROOT", tmp_path / "converted")
    monkeypatch.setattr(office_conversion.time, "sleep", lambda _seconds: None)

    def flaky_urlopen(request, timeout):
        request_bodies.append(request.data)
        if len(request_bodies) == 1:
            raise office_conversion.urllib.error.URLError("connection refused")
        return _FakeResponse(b"%PDF-1.7\nconverted")

    monkeypatch.setattr(office_conversion.urllib.request, "urlopen", flaky_urlopen)

    convert_office_to_pdf(str(source), {"document_id": "doc_1"})

    assert len(request_bodies) == 2
    assert request_bodies[0] == request_bodies[1]


def _write_test_xlsx(path: Path) -> bytes:
    empty_worksheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<worksheet xmlns="{SPREADSHEETML_NAMESPACE}">'
        '<dimension ref="A1:H2"/><sheetData/></worksheet>'
    )
    configured_worksheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<worksheet xmlns="{SPREADSHEETML_NAMESPACE}" '
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
        'xmlns:xr2="http://example.com/revision2" mc:Ignorable="xr2">'
        '<sheetPr><pageSetUpPr fitToPage="0"/></sheetPr>'
        '<dimension ref="A1:H2"/><sheetData/>'
        '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" '
        'header="0.3" footer="0.3"/>'
        '<pageSetup scale="75" orientation="portrait"/>'
        '<colBreaks count="1" manualBreakCount="1"><brk id="4" man="1"/></colBreaks>'
        '</worksheet>'
    )
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("xl/worksheets/sheet1.xml", empty_worksheet)
        archive.writestr("xl/worksheets/sheet2.xml", configured_worksheet)
        archive.writestr("xl/workbook.xml", b"unchanged workbook part")
    return path.read_bytes()


def _multipart_file_content(body: bytes) -> bytes:
    _, payload = body.split(b"\r\n\r\n", 1)
    content, _ = payload.rsplit(b"\r\n------ReasonKBOfficeBoundary--\r\n", 1)
    return content
