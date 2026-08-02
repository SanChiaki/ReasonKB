from __future__ import annotations

from html import escape
import re
from typing import Any, Literal, TypedDict

import pymupdf


LayoutStatus = Literal["no_table", "structured", "ambiguous", "visual_only"]


class PdfLayoutPage(TypedDict):
    page: int
    content: str
    layout_status: LayoutStatus
    blocks: list["LayoutBlock"]
    diagnostics: dict[str, Any]


class PdfLayoutDocument(TypedDict):
    pages: list[PdfLayoutPage]
    extractor: str
    extractor_version: str


class TextBlockV1(TypedDict):
    type: Literal["text"]
    bbox: list[float]
    text: str


class ImageBlockV1(TypedDict):
    type: Literal["image"]
    bbox: list[float]


class TableCellV1(TypedDict):
    row: int
    column: int
    rowSpan: int
    columnSpan: int
    text: str
    bbox: list[float]


class TableBlockV1(TypedDict):
    type: Literal["table"]
    schemaVersion: Literal["TableBlockV1"]
    tableId: str
    bbox: list[float]
    rowCount: int
    columnCount: int
    headerRowCount: int
    cells: list[TableCellV1]
    html: str


LayoutBlock = TextBlockV1 | ImageBlockV1 | TableBlockV1


_AXIS_TOLERANCE = 1.5


def extract_pdf_layout(path: str) -> PdfLayoutDocument:
    """Extract page text and objective table structure behind one interface.

    A page is projected to HTML only when every detected table forms a complete,
    non-overlapping grid. Ambiguous pages retain ordinary page text so callers
    can safely fall back to the legacy extraction path.
    """

    pages: list[PdfLayoutPage] = []
    with pymupdf.open(path) as document:
        for page_number, page in enumerate(document, start=1):
            pages.append(_extract_page(page, page_number))
    return {
        "pages": pages,
        "extractor": "pymupdf",
        "extractor_version": pymupdf.__version__,
    }


def _extract_page(page: Any, page_number: int) -> PdfLayoutPage:
    page_dict = page.get_text("dict", sort=True)
    full_text_blocks, image_blocks = _page_blocks(page_dict, ())
    plain_content = _join_projected_blocks(full_text_blocks)
    diagnostics: dict[str, Any] = {
        "tableCount": 0,
        "warnings": [],
    }

    try:
        detected_tables = list(page.find_tables().tables)
    except Exception as exc:
        diagnostics["warnings"] = [
            {
                "code": "table_detection_failed",
                "exceptionType": type(exc).__name__,
                "message": str(exc),
            }
        ]
        return {
            "page": page_number,
            "content": plain_content,
            "layout_status": "ambiguous",
            "blocks": [*full_text_blocks, *image_blocks],
            "diagnostics": diagnostics,
        }

    diagnostics["tableCount"] = len(detected_tables)
    if not detected_tables:
        status: LayoutStatus = (
            "visual_only" if not plain_content.strip() and image_blocks else "no_table"
        )
        return {
            "page": page_number,
            "content": plain_content,
            "layout_status": status,
            "blocks": [*full_text_blocks, *image_blocks],
            "diagnostics": diagnostics,
        }

    table_blocks: list[TableBlockV1] = []
    warnings: list[dict[str, str]] = []
    for table_number, table in enumerate(detected_tables, start=1):
        try:
            table_blocks.append(
                _table_block(table, page_number=page_number, table_number=table_number)
            )
        except Exception as exc:
            warnings.append(
                {
                    "code": "table_grid_ambiguous",
                    "tableId": f"p{page_number}-t{table_number}",
                    "exceptionType": type(exc).__name__,
                    "message": str(exc),
                }
            )

    if warnings or len(table_blocks) != len(detected_tables):
        diagnostics["warnings"] = warnings
        return {
            "page": page_number,
            "content": plain_content,
            "layout_status": "ambiguous",
            "blocks": [*full_text_blocks, *image_blocks],
            "diagnostics": diagnostics,
        }

    table_bboxes = [block["bbox"] for block in table_blocks]
    text_blocks, image_blocks = _page_blocks(page_dict, table_bboxes)
    blocks = sorted(
        [*text_blocks, *table_blocks, *image_blocks],
        key=lambda block: (block["bbox"][1], block["bbox"][0], block["type"]),
    )
    return {
        "page": page_number,
        "content": _join_projected_blocks(blocks),
        "layout_status": "structured",
        "blocks": blocks,
        "diagnostics": diagnostics,
    }


def _page_blocks(
    page_dict: dict[str, Any],
    excluded_bboxes: tuple[list[float], ...] | list[list[float]],
) -> tuple[list[TextBlockV1], list[ImageBlockV1]]:
    text_blocks: list[TextBlockV1] = []
    image_blocks: list[ImageBlockV1] = []
    for raw_block in page_dict.get("blocks", []):
        block_type = raw_block.get("type")
        if block_type == 1:
            image_blocks.append(
                {
                    "type": "image",
                    "bbox": _bbox(raw_block.get("bbox")),
                }
            )
            continue
        if block_type != 0:
            continue

        segments: list[tuple[int, list[str], list[list[float]]]] = []
        for line in raw_block.get("lines", []):
            span_texts: list[str] = []
            line_bboxes: list[list[float]] = []
            for span in line.get("spans", []):
                span_bbox = _bbox(span.get("bbox"))
                if any(_center_inside(span_bbox, excluded) for excluded in excluded_bboxes):
                    continue
                text = span.get("text")
                if isinstance(text, str) and text:
                    span_texts.append(text)
                    line_bboxes.append(span_bbox)
            line_text = "".join(span_texts).strip()
            if not line_text:
                continue
            line_bbox = _union_bbox(line_bboxes)
            vertical_segment = sum(
                excluded[3] <= (line_bbox[1] + line_bbox[3]) / 2
                for excluded in excluded_bboxes
            )
            if segments and segments[-1][0] == vertical_segment:
                segments[-1][1].append(line_text)
                segments[-1][2].extend(line_bboxes)
            else:
                segments.append((vertical_segment, [line_text], list(line_bboxes)))
        for _, line_texts, kept_bboxes in segments:
            text_blocks.append(
                {
                    "type": "text",
                    "bbox": _union_bbox(kept_bboxes),
                    "text": "\n".join(line_texts),
                }
            )
    return text_blocks, image_blocks


def _table_block(table: Any, *, page_number: int, table_number: int) -> TableBlockV1:
    row_count = int(table.row_count)
    column_count = int(table.col_count)
    if row_count < 2 or column_count < 2:
        raise ValueError("detected table must have at least two rows and two columns")
    if len(table.rows) != row_count:
        raise ValueError("table row metadata does not match row_count")

    table_bbox = _bbox(table.bbox)
    x_boundaries = _grid_boundaries(
        [table_bbox[0], table_bbox[2]],
        (
            coordinate
            for row in table.rows
            for cell in row.cells
            if cell is not None
            for coordinate in (cell[0], cell[2])
        ),
        column_count + 1,
    )
    y_boundaries = _grid_boundaries(
        [table_bbox[1], table_bbox[3]],
        (
            coordinate
            for row in table.rows
            for cell in row.cells
            if cell is not None
            for coordinate in (cell[1], cell[3])
        ),
        row_count + 1,
    )
    extracted = table.extract()
    if len(extracted) != row_count or any(len(row) != column_count for row in extracted):
        raise ValueError("table text matrix does not match detected grid")

    occupied = [[False] * column_count for _ in range(row_count)]
    cells: list[TableCellV1] = []
    for row_index, row in enumerate(table.rows):
        if len(row.cells) != column_count:
            raise ValueError("table cell matrix does not match column_count")
        for column_index, raw_cell_bbox in enumerate(row.cells):
            if raw_cell_bbox is None:
                continue
            cell_bbox = _bbox(raw_cell_bbox)
            if not _near(cell_bbox[0], x_boundaries[column_index]):
                raise ValueError("cell left edge does not align with its grid column")
            if not _near(cell_bbox[1], y_boundaries[row_index]):
                raise ValueError("cell top edge does not align with its grid row")
            end_column = _boundary_index(x_boundaries, cell_bbox[2])
            end_row = _boundary_index(y_boundaries, cell_bbox[3])
            column_span = end_column - column_index
            row_span = end_row - row_index
            if column_span < 1 or row_span < 1:
                raise ValueError("cell bbox produces an invalid span")
            if end_column > column_count or end_row > row_count:
                raise ValueError("cell span exceeds the detected grid")
            for covered_row in range(row_index, end_row):
                for covered_column in range(column_index, end_column):
                    if occupied[covered_row][covered_column]:
                        raise ValueError("detected cell spans overlap")
                    occupied[covered_row][covered_column] = True

            value = extracted[row_index][column_index]
            cells.append(
                {
                    "row": row_index,
                    "column": column_index,
                    "rowSpan": row_span,
                    "columnSpan": column_span,
                    "text": value.strip() if isinstance(value, str) else "",
                    "bbox": cell_bbox,
                }
            )

    if not cells or not all(all(row) for row in occupied):
        raise ValueError("detected table grid contains uncovered cells")
    if sum(bool(cell["text"]) for cell in cells) / len(cells) < 0.2:
        raise ValueError("detected table contains too little cell text")

    header_row_count = _header_row_count(table, y_boundaries)
    table_id = f"p{page_number}-t{table_number}"
    block: TableBlockV1 = {
        "type": "table",
        "schemaVersion": "TableBlockV1",
        "tableId": table_id,
        "bbox": table_bbox,
        "rowCount": row_count,
        "columnCount": column_count,
        "headerRowCount": header_row_count,
        "cells": cells,
        "html": "",
    }
    block["html"] = _table_html(block)
    return block


def _header_row_count(table: Any, y_boundaries: list[float]) -> int:
    header = getattr(table, "header", None)
    inferred = _nested_header_row_count(table)
    if header is None or bool(getattr(header, "external", False)):
        return inferred
    header_bbox = getattr(header, "bbox", None)
    if header_bbox is None:
        return inferred
    try:
        end_row = _boundary_index(y_boundaries, float(header_bbox[3]))
    except (TypeError, ValueError, IndexError):
        return inferred
    return max(inferred, min(max(end_row, 1), len(y_boundaries) - 1))


def _nested_header_row_count(table: Any) -> int:
    if int(table.row_count) < 2:
        return 1
    first_row = table.rows[0].cells
    second_row = table.rows[1].cells
    for cell in first_row:
        if cell is None:
            continue
        covered_columns = sum(
            1
            for candidate in second_row
            if candidate is not None
            and candidate[0] >= cell[0] - _AXIS_TOLERANCE
            and candidate[2] <= cell[2] + _AXIS_TOLERANCE
        )
        if covered_columns > 1:
            return 2
    return 1


def _table_html(block: TableBlockV1) -> str:
    cells_by_row: dict[int, list[TableCellV1]] = {}
    for cell in block["cells"]:
        cells_by_row.setdefault(cell["row"], []).append(cell)

    rows: list[str] = []
    for row_index in range(block["rowCount"]):
        cell_html: list[str] = []
        for cell in sorted(cells_by_row.get(row_index, []), key=lambda item: item["column"]):
            tag = "th" if row_index < block["headerRowCount"] or cell["column"] == 0 else "td"
            attributes = []
            if cell["rowSpan"] > 1:
                attributes.append(f' rowspan="{cell["rowSpan"]}"')
            if cell["columnSpan"] > 1:
                attributes.append(f' colspan="{cell["columnSpan"]}"')
            text = escape(_compact_cell_text(cell["text"]))
            cell_html.append(f"<{tag}{''.join(attributes)}>{text}</{tag}>")
        rows.append(f"<tr>{''.join(cell_html)}</tr>")
    return f'<table data-table-id="{escape(block["tableId"])}">{"".join(rows)}</table>'


def _join_projected_blocks(blocks: list[LayoutBlock]) -> str:
    parts: list[str] = []
    for block in blocks:
        if block["type"] == "text" and block.get("text"):
            parts.append(block["text"])
        elif block["type"] == "table" and block.get("html"):
            parts.append(block["html"])
    return "\n\n".join(parts)


def _grid_boundaries(
    outer: list[float],
    coordinates: Any,
    expected_count: int,
) -> list[float]:
    values = [*outer, *(float(value) for value in coordinates)]
    values.sort()
    clusters: list[list[float]] = []
    for value in values:
        if not clusters or abs(value - clusters[-1][-1]) > _AXIS_TOLERANCE:
            clusters.append([value])
        else:
            clusters[-1].append(value)
    boundaries = [sum(cluster) / len(cluster) for cluster in clusters]
    if len(boundaries) != expected_count:
        raise ValueError(
            f"detected grid has {len(boundaries)} boundaries; expected {expected_count}"
        )
    return boundaries


def _boundary_index(boundaries: list[float], value: float) -> int:
    nearest = min(range(len(boundaries)), key=lambda index: abs(boundaries[index] - value))
    if not _near(boundaries[nearest], value):
        raise ValueError("cell edge does not align with the detected grid")
    return nearest


def _near(left: float, right: float) -> bool:
    return abs(left - right) <= _AXIS_TOLERANCE


def _bbox(value: Any) -> list[float]:
    if value is None or len(value) != 4:
        raise ValueError("invalid bbox")
    result = [round(float(coordinate), 3) for coordinate in value]
    if result[2] < result[0] or result[3] < result[1]:
        raise ValueError("inverted bbox")
    return result


def _union_bbox(bboxes: list[list[float]]) -> list[float]:
    if not bboxes:
        raise ValueError("cannot combine an empty bbox list")
    return [
        min(item[0] for item in bboxes),
        min(item[1] for item in bboxes),
        max(item[2] for item in bboxes),
        max(item[3] for item in bboxes),
    ]


def _center_inside(inner: list[float], outer: list[float]) -> bool:
    x = (inner[0] + inner[2]) / 2
    y = (inner[1] + inner[3]) / 2
    return outer[0] <= x <= outer[2] and outer[1] <= y <= outer[3]


def _compact_cell_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()
