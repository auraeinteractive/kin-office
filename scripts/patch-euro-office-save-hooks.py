#!/usr/bin/env python3
"""Install Kin Office save hooks into Euro-Office web-apps source or built assets."""

from pathlib import Path
import sys


SAVE_HOOK = "(window.KinOfficeDirectSave && window.KinOfficeDirectSave())"
UPSTREAM_PRODUCT_TOKEN = "ONLY" + "OFFICE"


REPLACEMENTS = {
    ": /file:save/.test(t) && g.getController('Main').api.asc_Save();":
        f": /file:save/.test(t) && ({SAVE_HOOK} || g.getController('Main').api.asc_Save());",
    "this.api.asc_Save();": f"{SAVE_HOOK} || this.api.asc_Save();",
    'window["asc_docs_api"].prototype.asc_nativeGetFile3 = function()':
        'window["asc_docs_api"].prototype["asc_nativeGetFile3"] = function()',
    "spreadsheet_api.prototype.asc_nativeGetFile3 = function()":
        'spreadsheet_api.prototype["asc_nativeGetFile3"] = function()',
    "baseEditorsApi.prototype.getFileAsFromChanges = function()":
        'baseEditorsApi.prototype["getFileAsFromChanges"] = function()',
    "../../../../sdkjs/source-loader/word.js": "../../../../sdkjs/word/sdk-all-min.js",
    "../../../../sdkjs/source-loader/cell.js": "../../../../sdkjs/cell/sdk-all-min.js",
    "../../../../sdkjs/source-loader/slide.js": "../../../../sdkjs/slide/sdk-all-min.js",
}

EDITOR_SDK_ALIASES = {
    "documenteditor": "../../sdkjs/word/sdk-all-min",
    "spreadsheeteditor": "../../sdkjs/cell/sdk-all-min",
    "presentationeditor": "../../sdkjs/slide/sdk-all-min",
}

ZLIB_SCRIPT = '<script src="../../../../sdkjs/common/zlib/engine/zlib.js"></script>'
SDK_RUNTIME_SCRIPTS = """\
    <script src="../../../../sdkjs/vendor/polyfill.js"></script>
    <script src="../../../vendor/xregexp/xregexp-all-min.js"></script>"""


def patch_html_runtime_deps(text: str) -> str:
    if ZLIB_SCRIPT not in text or "xregexp-all-min.js" in text:
        return text
    return text.replace(
        ZLIB_SCRIPT,
        ZLIB_SCRIPT + "\n" + SDK_RUNTIME_SCRIPTS,
    )


def patch_file(path: Path) -> int:
    text = path.read_text(encoding="utf-8")
    original = text
    for old, new in REPLACEMENTS.items():
        text = text.replace(old, new)
    if path.suffix == ".html":
        text = patch_html_runtime_deps(text)
    for editor, sdk_alias in EDITOR_SDK_ALIASES.items():
        if editor in path.parts:
            text = text.replace("../../sdkjs/source-loader/loaded", sdk_alias)
    text = text.replace(f"'{UPSTREAM_PRODUCT_TOKEN}'", "'Kin Office'")
    text = text.replace(f'"{UPSTREAM_PRODUCT_TOKEN}"', '"Kin Office"')
    text = text.replace(
        "c.toolbarNoTabs || ('desktop' !== e.editorConfig.targetApp && (c.loaderName || c.loaderLogo))",
        "c.toolbarNoTabs || ('desktop' !== e.editorConfig.targetApp && c.loaderLogo)",
    )
    while f"{SAVE_HOOK} || {SAVE_HOOK} ||" in text:
        text = text.replace(f"{SAVE_HOOK} || {SAVE_HOOK} ||", f"{SAVE_HOOK} ||")
    if text != original:
        path.write_text(text, encoding="utf-8")
        return 1
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-euro-office-save-hooks.py <web-apps-or-packages-root>", file=sys.stderr)
        return 2

    root = Path(sys.argv[1])
    if not root.exists():
        print(f"Kin Office save hook patch: path does not exist: {root}", file=sys.stderr)
        return 1

    patched = 0
    for path in list(root.rglob("*.js")) + list(root.rglob("*.html")):
        if any(part in {"node_modules", ".git"} for part in path.parts):
            continue
        patched += patch_file(path)

    if patched == 0:
        print("Kin Office save hook patch: no save handlers needed changes")
        return 0

    print(f"Kin Office save hook patch: patched {patched} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
