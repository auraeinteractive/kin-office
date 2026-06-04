#!/usr/bin/env python3
"""Generate fallback Euro-Office font thumbnail alpha-mask binaries.

Euro-Office web-apps request sdkjs/common/Images/fonts_thumbnail*.png.bin in
browser mode. The browser SDK package currently lacks those files, which makes
the font combobox load a 404 response as a binary sprite. These fallback
sprites are transparent masks with enough rows for the runtime font list; they
keep the combobox loader on a valid code path while the actual document font
engine is debugged separately.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
IMAGES_DIR = (
    ROOT
    / "repository/Applications/Office/kinoffice_common/vendor/kin-office"
    / "packages/kin-office/7/sdkjs/common/Images"
)

FONT_COUNT = 2048
BASE_WIDTH = 300
BASE_HEIGHT = 28
RATIOS = [
    ("", 1.0),
    ("@1.25x", 1.25),
    ("@1.5x", 1.5),
    ("@1.75x", 1.75),
    ("@2x", 2.0),
]
POSTFIXES = ["", "_ea"]


def write_u32be(out: bytearray, value: int) -> None:
    out.extend(
        [
            (value >> 24) & 0xFF,
            (value >> 16) & 0xFF,
            (value >> 8) & 0xFF,
            value & 0xFF,
        ]
    )


def transparent_rle(pixel_count: int) -> bytearray:
    out = bytearray()
    remaining = pixel_count
    while remaining:
        run = min(255, remaining)
        out.extend([0, run])
        remaining -= run
    return out


def build_sprite(width: int, height_one: int, count: int) -> bytes:
    out = bytearray()
    write_u32be(out, width)
    write_u32be(out, height_one)
    write_u32be(out, count)
    row = transparent_rle(width * height_one)
    for _ in range(count):
        out.extend(row)
    return bytes(out)


def main() -> None:
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    for postfix in POSTFIXES:
        for suffix, ratio in RATIOS:
            width = round(BASE_WIDTH * ratio)
            height = round(BASE_HEIGHT * ratio)
            target = IMAGES_DIR / f"fonts_thumbnail{postfix}{suffix}.png.bin"
            target.write_bytes(build_sprite(width, height, FONT_COUNT))
            print(f"wrote {target.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
