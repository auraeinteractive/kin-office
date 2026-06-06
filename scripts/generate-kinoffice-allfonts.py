#!/usr/bin/env python3
"""Generate Euro-Office AllFonts.js and browser font files for Kin Office.

Uses open-licensed Google Fonts (Apache/OFL). Produces the format expected by
sdkjs/common/Drawings/Externals.js: __fonts_files, __fonts_infos, version 2.
"""

from __future__ import annotations

import base64
import json
import re
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG7 = (
    ROOT
    / "repository/Applications/Office/kinoffice_common/vendor/kin-office/packages/kin-office/7"
)
FONTS_DIR = PKG7 / "fonts"
ALLFONTS_JS = PKG7 / "sdkjs/common/AllFonts.js"

CSS_USER_AGENT = "Mozilla/5.0 (Windows NT 6.1; WOW64; rv:35.0) Gecko/20100101 Firefox/35.0"

# The browser XHR font loader XOR-decodes the first 32 bytes before passing a
# stream to FreeType, so generated browser font files must be ODTTF-obfuscated
# on disk.
OBFUSCATE_BROWSER_FONTS = True

# Euro-Office XOR obfuscation for the first 32 bytes of ODTTF font files.
_ODTTF_KEY = bytes(
    [0xA0, 0x66, 0xD6, 0x20, 0x14, 0x96, 0x47, 0xFA, 0x95, 0x69, 0xB8, 0x50, 0xB0, 0x41, 0x49, 0x48]
)

# Local TrueType/OpenType fonts are preferred because the Euro-Office browser
# font engine can list WOFF files but does not reliably render glyphs from them.
LOCAL_FONT_FAMILIES = [
    {
        "name": "Noto Sans CJK SC",
        "paths": {
            "regular": "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "bold": "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
            "italic": "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "bold_italic": "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        },
        "face_indexes": {
            "regular": 2,
            "bold": 2,
            "italic": 2,
            "bold_italic": 2,
        },
        "aliases": [
            "Arial Unicode MS",
            "DengXian",
            "DengXian Light",
            "Microsoft YaHei",
            "Microsoft YaHei UI",
            "SimHei",
            "SimSun",
            "NSimSun",
            "Noto Sans CJK",
            "Noto Sans CJK SC",
            "Noto Sans SC",
            "PingFang SC",
            "等线",
            "黑体",
            "宋体",
        ],
    },
    {
        "name": "Liberation Sans",
        "paths": {
            "regular": "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            "bold": "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
            "italic": "/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf",
            "bold_italic": "/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf",
        },
        "aliases": [
            "Arimo",
            "Arial",
            "Arial MT",
            "Helvetica",
            "Helvetica Neue",
            "Calibri",
            "Calibri Light",
            "Aptos",
            "Aptos Display",
            "Aptos Mono",
            "Aptos Serif",
            "Carlito",
            "Segoe UI",
            "Segoe UI Light",
            "Segoe UI Semibold",
            "Verdana Pro",
        ],
    },
    {
        "name": "Liberation Serif",
        "paths": {
            "regular": "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
            "bold": "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
            "italic": "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf",
            "bold_italic": "/usr/share/fonts/truetype/liberation/LiberationSerif-BoldItalic.ttf",
        },
        "aliases": ["Tinos", "Times New Roman", "Times", "Georgia"],
    },
    {
        "name": "Liberation Mono",
        "paths": {
            "regular": "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
            "bold": "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
            "italic": "/usr/share/fonts/truetype/liberation/LiberationMono-Italic.ttf",
            "bold_italic": "/usr/share/fonts/truetype/liberation/LiberationMono-BoldItalic.ttf",
        },
        "aliases": ["Cousine", "Courier New", "Courier", "Consolas"],
    },
    {
        "name": "Noto Sans",
        "paths": {
            "regular": "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
            "bold": "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
            "italic": "/usr/share/fonts/truetype/noto/NotoSans-Italic.ttf",
            "bold_italic": "/usr/share/fonts/truetype/noto/NotoSans-BoldItalic.ttf",
        },
        "aliases": [
            "Roboto",
            "Open Sans",
            "Verdana",
            "Tahoma",
            "Trebuchet MS",
            "Lato",
            "Montserrat",
            "Noto Sans Display",
            "Source Sans 3",
            "Source Sans Pro",
        ],
    },
    {
        "name": "Noto Serif",
        "paths": {
            "regular": "/usr/share/fonts/truetype/noto/NotoSerif-Regular.ttf",
            "bold": "/usr/share/fonts/truetype/noto/NotoSerif-Bold.ttf",
            "italic": "/usr/share/fonts/truetype/noto/NotoSerif-Italic.ttf",
            "bold_italic": "/usr/share/fonts/truetype/noto/NotoSerif-BoldItalic.ttf",
        },
        "aliases": [
            "Cambria",
            "Palatino Linotype",
            "Merriweather",
            "Book Antiqua",
            "Garamond",
            "Playfair Display",
            "Didot",
            "Bodoni MT",
        ],
    },
]

# Google Font families for Kin Office. Used as a fallback when local TTF/OTF
# fonts are unavailable. css_spec is passed to fonts.googleapis.com/css2.
FONT_FAMILIES = [
    {
        "name": "Arimo",
        "css_spec": "Arimo:ital,wght@0,400;0,700;1,400;1,700",
        "aliases": [
            "Arial",
            "Arial MT",
            "Helvetica",
            "Helvetica Neue",
            "Calibri",
            "Segoe UI",
        ],
    },
    {
        "name": "Tinos",
        "css_spec": "Tinos:ital,wght@0,400;0,700;1,400;1,700",
        "aliases": ["Times New Roman", "Times", "Georgia"],
    },
    {
        "name": "Cousine",
        "css_spec": "Cousine:ital,wght@0,400;0,700;1,400;1,700",
        "aliases": ["Courier New", "Courier", "Consolas"],
    },
    {
        "name": "Roboto",
        "css_spec": "Roboto:ital,wght@0,400;0,700;1,400;1,700",
        "aliases": [],
    },
    {
        "name": "Open Sans",
        "css_spec": "Open+Sans:ital,wght@0,400;0,700;1,400;1,700",
        "aliases": ["Verdana", "Tahoma", "Trebuchet MS"],
    },
    {
        "name": "Lato",
        "css_spec": "Lato:ital,wght@0,400;0,700;1,400;1,700",
        "aliases": [],
    },
    {
        "name": "Montserrat",
        "css_spec": "Montserrat:ital,wght@0,400;0,700;1,400;1,700",
        "aliases": [],
    },
    {
        "name": "Noto Sans",
        "css_spec": "Noto+Sans:ital,wght@0,400;0,700;1,400;1,700",
        "aliases": ["Noto Sans Display"],
    },
    {
        "name": "Noto Serif",
        "css_spec": "Noto+Serif:ital,wght@0,400;0,700;1,400;1,700",
        "aliases": ["Cambria", "Palatino Linotype"],
    },
    {
        "name": "Merriweather",
        "css_spec": "Merriweather:ital,wght@0,400;0,700;1,400;1,700",
        "aliases": ["Book Antiqua", "Garamond"],
    },
    {
        "name": "Playfair Display",
        "css_spec": "Playfair+Display:ital,wght@0,400;0,700;1,400;1,700",
        "aliases": ["Didot", "Bodoni MT"],
    },
    {
        "name": "Source Sans 3",
        "css_spec": "Source+Sans+3:ital,wght@0,400;0,700;1,400;1,700",
        "aliases": ["Source Sans Pro", "Arial Unicode MS"],
    },
]


def download_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "kin-office-allfonts/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def local_variants(family: dict) -> dict[str, bytes] | None:
    paths = family.get("paths") or {}
    if not paths:
        return None
    required = ["regular", "bold", "italic", "bold_italic"]
    if any(not Path(paths.get(key, "")).is_file() for key in required):
        return None
    return {key: Path(paths[key]).read_bytes() for key in required}


def fetch_google_font_urls(css_spec: str) -> dict[str, str]:
    css_url = f"https://fonts.googleapis.com/css2?family={css_spec}&display=swap"
    req = urllib.request.Request(css_url, headers={"User-Agent": CSS_USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp:
        css = resp.read().decode("utf-8", errors="replace")

    blocks = re.findall(r"@font-face\s*\{([^}]+)\}", css, flags=re.S)
    if not blocks:
        raise RuntimeError(f"no @font-face blocks in CSS for {css_spec}")

    variants: dict[str, str] = {}
    for block in blocks:
        weight = re.search(r"font-weight:\s*(\d+)", block)
        style = re.search(r"font-style:\s*(\w+)", block)
        url = re.search(
            r"url\((https://fonts\.gstatic\.com/[^)]+\.(?:ttf|woff2?))\)", block
        )
        if not weight or not style or not url:
            continue
        key = f"{style.group(1)}_{weight.group(1)}"
        if key not in variants:
            variants[key] = url.group(1)

    mapping = {
        "regular": variants.get("normal_400"),
        "bold": variants.get("normal_700"),
        "italic": variants.get("italic_400"),
        "bold_italic": variants.get("italic_700"),
    }
    missing = [k for k, v in mapping.items() if not v]
    if missing:
        raise RuntimeError(f"missing variants {missing} for {css_spec}")
    return mapping


def obfuscate_font(data: bytearray) -> None:
    for i in range(min(32, len(data))):
        data[i] ^= _ODTTF_KEY[i % 16]


def font_id(index: int) -> str:
    return f"odttf10-{index + 1:06d}"


def js_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _pack_i32(value: int) -> bytes:
    return struct.pack("<i", value)


def _pack_u32(value: int) -> bytes:
    return struct.pack("<I", value & 0xFFFFFFFF)


def _pack_i16(value: int) -> bytes:
    return struct.pack("<h", value)


def _pack_u16(value: int) -> bytes:
    return struct.pack("<H", value & 0xFFFF)


def _pack_utf8(value: str) -> bytes:
    raw = value.encode("utf-8")
    return _pack_i32(len(raw)) + raw


def is_cjk_font_name(name: str) -> bool:
    cjk_tokens = [
        "CJK",
        "DengXian",
        "YaHei",
        "SimHei",
        "SimSun",
        "NSimSun",
        "PingFang",
        "Noto Sans SC",
        "等线",
        "黑体",
        "宋体",
    ]
    return any(token in name for token in cjk_tokens)


def build_font_selection_bin(font_files: list[str], font_infos: list[list]) -> str:
    """Build the Euro-Office v2 selectable-font binary as base64.

    The SDK's native picker does not search __fonts_infos directly. It first
    parses window.g_fonts_selection_bin into CFontSelect records; when this was
    empty, ordinary names like Arial resolved to the bundled ASCW3 symbol font.
    """
    records: list[bytes] = []
    seen_names: set[str] = set()
    seen_paths: set[str] = set()

    for info in font_infos:
        name = str(info[0])
        if name in seen_names:
            continue
        seen_names.add(name)

        regular_index = int(info[1])
        regular_face_index = int(info[2])
        font_path = font_files[regular_index]
        seen_paths.add(font_path)
        is_cjk = is_cjk_font_name(name)

        # Wide coverage keeps Euro-Office from choosing language/symbol
        # fallbacks before it reaches our packaged fonts. Exact name matching
        # remains the main selector.
        unicode_range1 = 0xFFFFFFFF
        unicode_range2 = 0xFFFFFFFF if is_cjk else 0x00000000
        unicode_range3 = 0x00000000
        unicode_range4 = 0x00000000
        code_page_range1 = 0xFFFFFFFF if is_cjk else 0x00000001
        code_page_range2 = 0x00000000
        fixed_pitch = 1 if any(token in name for token in ["Mono", "Courier", "Consolas", "Cousine"]) else 0
        panose = bytes([2, 11, 6, 4, 2, 2, 2, 2, 2, 4])

        payload = b"".join(
            [
                _pack_utf8(name),
                _pack_i32(0),  # additional names count
                _pack_utf8(font_path),
                _pack_i32(regular_face_index),
                _pack_i32(0),  # italic
                _pack_i32(0),  # bold
                _pack_i32(fixed_pitch),
                _pack_i32(len(panose)),
                panose,
                _pack_u32(unicode_range1),
                _pack_u32(unicode_range2),
                _pack_u32(unicode_range3),
                _pack_u32(unicode_range4),
                _pack_u32(code_page_range1),
                _pack_u32(code_page_range2),
                _pack_u16(400),
                _pack_u16(5),
                _pack_i16(0),
                _pack_i16(0),
                _pack_i16(500),
                _pack_i16(900),
                _pack_i16(-200),
                _pack_i16(0),
                _pack_i16(500),
                _pack_i16(700),
                _pack_u16(0),
            ]
        )
        records.append(_pack_i32(len(payload) + 4) + payload)

    # Language fallback checks index the selection list by loaded font file id,
    # not only by family name. Ensure every packaged regular file has a record.
    for index, font_path in enumerate(font_files):
        if font_path in seen_paths:
            continue
        payload = b"".join(
            [
                _pack_utf8(font_path),
                _pack_i32(0),
                _pack_utf8(font_path),
                _pack_i32(0),
                _pack_i32(0),
                _pack_i32(0),
                _pack_i32(0),
                _pack_i32(10),
                bytes([2, 11, 6, 4, 2, 2, 2, 2, 2, 4]),
                _pack_u32(0xFFFFFFFF),
                _pack_u32(0xFFFFFFFF),
                _pack_u32(0),
                _pack_u32(0),
                _pack_u32(0xFFFFFFFF),
                _pack_u32(0),
                _pack_u16(400),
                _pack_u16(5),
                _pack_i16(0),
                _pack_i16(0),
                _pack_i16(500),
                _pack_i16(900),
                _pack_i16(-200),
                _pack_i16(0),
                _pack_i16(500),
                _pack_i16(700),
                _pack_u16(0),
            ]
        )
        records.append(_pack_i32(len(payload) + 4) + payload)

    data = _pack_i32(len(records)) + b"".join(records)
    return base64.b64encode(data).decode("ascii")


def write_allfonts_js(font_files: list[str], font_infos: list[list]) -> None:
    selection_bin = build_font_selection_bin(font_files, font_infos)
    lines = [
        "/* Generated by scripts/generate-kinoffice-allfonts.py — do not edit by hand. */",
        "/* Open-licensed TTF/OTF fonts for Kin Office browser editing. */",
        f"((window.g_fonts_selection_bin = window.g_fonts_selection_bin || {js_string(selection_bin)}),",
        "  (window.__all_fonts_js_version__ = 2),",
        "  (window.__fonts_files = [",
    ]
    for i, fid in enumerate(font_files):
        suffix = "," if i < len(font_files) - 1 else ""
        lines.append(f"    {js_string(fid)}{suffix}")
    lines.append("  ]),")
    lines.append("  (window.__fonts_infos = [")
    for i, info in enumerate(font_infos):
        name = js_string(info[0])
        nums = ", ".join(str(x) for x in info[1:])
        suffix = "," if i < len(font_infos) - 1 else ""
        lines.append(f"    [{name}, {nums}]{suffix}")
    lines.append("  ]));")
    ALLFONTS_JS.parent.mkdir(parents=True, exist_ok=True)
    ALLFONTS_JS.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    FONTS_DIR.mkdir(parents=True, exist_ok=True)

    font_files: list[str] = []
    url_index: dict[str, int] = {}
    font_infos: list[list] = []

    def add_url(url: str) -> int:
        if url in url_index:
            return url_index[url]
        try:
            raw = bytearray(download_bytes(url))
        except urllib.error.HTTPError as exc:
            print(f"generate-kinoffice-allfonts.py: failed to download {url}: {exc}", file=sys.stderr)
            raise SystemExit(1) from exc
        except urllib.error.URLError as exc:
            print(f"generate-kinoffice-allfonts.py: network error for {url}: {exc}", file=sys.stderr)
            raise SystemExit(1) from exc

        if OBFUSCATE_BROWSER_FONTS:
            obfuscate_font(raw)
        idx = len(font_files)
        fid = font_id(idx)
        (FONTS_DIR / fid).write_bytes(raw)
        font_files.append(fid)
        url_index[url] = idx
        print(f"  {fid} <= {url} ({len(raw)} bytes)")
        return idx

    def add_font_bytes(label: str, data: bytes) -> int:
        if label in url_index:
            return url_index[label]
        raw = bytearray(data)
        if OBFUSCATE_BROWSER_FONTS:
            obfuscate_font(raw)
        idx = len(font_files)
        fid = font_id(idx)
        (FONTS_DIR / fid).write_bytes(raw)
        font_files.append(fid)
        url_index[label] = idx
        print(f"  {fid} <= {label} ({len(raw)} bytes)")
        return idx

    print(f"Generating fonts under {FONTS_DIR} ...")
    families = LOCAL_FONT_FAMILIES if all(local_variants(f) for f in LOCAL_FONT_FAMILIES) else FONT_FAMILIES
    for family in families:
        local = local_variants(family)
        if local:
            print(f"Using local TTF/OTF {family['name']} ...")
            reg = add_font_bytes(family["paths"]["regular"], local["regular"])
            bold = add_font_bytes(family["paths"]["bold"], local["bold"])
            ital = add_font_bytes(family["paths"]["italic"], local["italic"])
            bold_ital = add_font_bytes(family["paths"]["bold_italic"], local["bold_italic"])
        else:
            print(f"Fetching {family['name']} ...")
            try:
                variants = fetch_google_font_urls(family["css_spec"])
            except RuntimeError as exc:
                print(f"generate-kinoffice-allfonts.py: {exc}", file=sys.stderr)
                return 1

            reg = add_url(variants["regular"])
            bold = add_url(variants["bold"])
            ital = add_url(variants["italic"])
            bold_ital = add_url(variants["bold_italic"])

        face_indexes = family.get("face_indexes") or {}
        reg_face = int(face_indexes.get("regular", 0))
        bold_face = int(face_indexes.get("bold", 0))
        ital_face = int(face_indexes.get("italic", 0))
        bold_ital_face = int(face_indexes.get("bold_italic", 0))
        entry = [family["name"], reg, reg_face, ital, ital_face, bold, bold_face, bold_ital, bold_ital_face]
        font_infos.append(entry)
        for alias in family.get("aliases", []):
            font_infos.append([alias, reg, reg_face, ital, ital_face, bold, bold_face, bold_ital, bold_ital_face])

    write_allfonts_js(font_files, font_infos)
    print(f"Wrote {ALLFONTS_JS} ({len(font_files)} font files, {len(font_infos)} families)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
