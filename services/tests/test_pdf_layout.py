from pathlib import Path

import pymupdf

from services.index_worker.pdf_layout import extract_pdf_layout


def _write_merged_table_pdf(path: Path) -> None:
    document = pymupdf.open()
    page = document.new_page(width=400, height=260)
    page.insert_text((50, 30), "Partner policy thresholds", fontsize=9)

    # Three columns by four rows. The first header spans two columns and
    # the value 3000 spans the final two product rows.
    for x in (50, 350):
        page.draw_line((x, 50), (x, 170))
    page.draw_line((250, 50), (250, 170))
    page.draw_line((150, 80), (150, 170))
    for y in (50, 80, 110, 170):
        page.draw_line((50, y), (350, y))
    page.draw_line((50, 140), (150, 140))
    page.draw_line((250, 140), (350, 140))

    cells = (
        (60, 68, "Tier"),
        (265, 68, "Certified"),
        (60, 98, "Product"),
        (165, 98, "Total"),
        (265, 98, "Single"),
        (60, 128, "Network & Security"),
        (165, 128, "3000"),
        (265, 128, "1500"),
        (60, 158, "Storage"),
        (265, 158, "500"),
    )
    for x, y, text in cells:
        page.insert_text((x, y), text, fontsize=8)
    page.insert_text((50, 200), "Values are annual totals.", fontsize=9)
    document.save(path)
    document.close()


def test_extract_pdf_layout_projects_merged_table_as_structural_html(tmp_path):
    pdf_path = tmp_path / "merged-table.pdf"
    _write_merged_table_pdf(pdf_path)

    result = extract_pdf_layout(str(pdf_path))

    assert result["extractor"] == "pymupdf"
    page = result["pages"][0]
    assert page["layout_status"] == "structured"
    assert page["diagnostics"] == {"tableCount": 1, "warnings": []}
    tables = [block for block in page["blocks"] if block["type"] == "table"]
    assert len(tables) == 1
    table = tables[0]
    assert (table["rowCount"], table["columnCount"], table["headerRowCount"]) == (
        4,
        3,
        2,
    )
    assert next(cell for cell in table["cells"] if cell["text"] == "Tier")[
        "columnSpan"
    ] == 2
    total_cell = next(cell for cell in table["cells"] if cell["text"] == "3000")
    assert total_cell["rowSpan"] == 2
    assert total_cell["columnSpan"] == 1
    assert '<th colspan="2">Tier</th>' in table["html"]
    assert '<td rowspan="2">3000</td>' in table["html"]
    assert "Network &amp; Security" in table["html"]
    assert page["content"].count("3000") == 1
    assert page["content"].count("<table") == 1
    assert "Partner policy thresholds" in page["content"]
    assert "Values are annual totals." in page["content"]


def test_extract_pdf_layout_classifies_plain_text_page_without_table(tmp_path):
    pdf_path = tmp_path / "plain.pdf"
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((72, 72), "No table is present.")
    document.save(pdf_path)
    document.close()

    result = extract_pdf_layout(str(pdf_path))

    page = result["pages"][0]
    assert page["layout_status"] == "no_table"
    assert page["content"] == "No table is present."
    assert [block["type"] for block in page["blocks"]] == ["text"]
