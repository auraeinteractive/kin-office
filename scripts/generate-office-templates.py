#!/usr/bin/env python3
"""Generate minimal OOXML template bytes for kinoffice.cmd."""
from __future__ import annotations

import base64
import io
import zipfile
from pathlib import Path


def minimal_docx() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>",
        )
        zf.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="word/document.xml"/>'
            "</Relationships>",
        )
        zf.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body><w:p><w:r><w:t></w:t></w:r></w:p></w:body></w:document>",
        )
    return buf.getvalue()


def minimal_xlsx() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            "</Types>",
        )
        zf.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="xl/workbook.xml"/>'
            "</Relationships>",
        )
        zf.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        )
        zf.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            'Target="worksheets/sheet1.xml"/>'
            "</Relationships>",
        )
        zf.writestr(
            "xl/worksheets/sheet1.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            "<sheetData/></worksheet>",
        )
    return buf.getvalue()


def minimal_pptx() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/ppt/presentation.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
            '<Override PartName="/ppt/slides/slide1.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
            "</Types>",
        )
        zf.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="ppt/presentation.xml"/>'
            "</Relationships>",
        )
        zf.writestr(
            "ppt/presentation.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
        )
        zf.writestr(
            "ppt/_rels/presentation.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
            'Target="slides/slide1.xml"/>'
            "</Relationships>",
        )
        zf.writestr(
            "ppt/slides/slide1.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
            "<p:cSld><p:spTree/></p:cSld></p:sld>",
        )
    return buf.getvalue()


def emit_templates_c(out_path: Path) -> None:
    templates = {
        "docx": minimal_docx(),
        "xlsx": minimal_xlsx(),
        "pptx": minimal_pptx(),
    }
    lines = [
        "/* Generated by scripts/generate-office-templates.py — do not edit. */",
        '#include "templates.h"',
        "",
    ]
    for ext, raw in templates.items():
        b64 = base64.b64encode(raw).decode("ascii")
        lines.append(f'static const char KINOFFICE_TEMPLATE_{ext.upper()}_B64[] = "{b64}";')
        lines.append(f"static const size_t KINOFFICE_TEMPLATE_{ext.upper()}_LEN = {len(raw)};")
        lines.append("")
    lines.append("const kinoffice_template_t KINOFFICE_TEMPLATES[] = {")
    for ext in templates:
        lines.append(
            f'    {{ "{ext}", KINOFFICE_TEMPLATE_{ext.upper()}_B64, KINOFFICE_TEMPLATE_{ext.upper()}_LEN }},'
        )
    lines.append("    { NULL, NULL, 0 }")
    lines.append("};")
    lines.append("")
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    out = root / "commands" / "kinoffice.cmd" / "templates.c"
    out.parent.mkdir(parents=True, exist_ok=True)
    emit_templates_c(out)
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
