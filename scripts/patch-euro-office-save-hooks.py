#!/usr/bin/env python3
"""Install Kin Office save hooks into Euro-Office web-apps source or built assets."""

from pathlib import Path
import sys


SAVE_HOOK = "(window.KinOfficeDirectSave && window.KinOfficeDirectSave())"
UPSTREAM_PRODUCT_TOKEN = "ONLY" + "OFFICE"
KIN_OFFICE_BUILD_ID = "20260603-cache10"


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
IS_NATIVE_EDITOR_SCRIPT = '<script>window.IS_NATIVE_EDITOR=true;</script>'
OOXML_ADDON_SCRIPT = """\
        window.KinOfficeNoCoAuthoring = true;
        window.compareVersions = true;
        window.Asc = window.Asc || {};
        window.Asc.Addons = window.Asc.Addons || {};
        window.Asc.Addons.ooxml = true;
        window.Asc.Addons.forms = false;"""
SDK_RUNTIME_SCRIPTS = """\
    <script src="../../../../sdkjs/vendor/polyfill.js"></script>
    <script src="../../../vendor/xregexp/xregexp-all-min.js"></script>"""
REQUIREJS_SCRIPT = '<script src="../../../vendor/requirejs/require.js"></script>'


def patch_html_runtime_deps(text: str) -> str:
    updated = text
    # Kin runs in a browser iframe, not the native desktop shell.
    updated = updated.replace(IS_NATIVE_EDITOR_SCRIPT + "\n", "")
    updated = updated.replace(IS_NATIVE_EDITOR_SCRIPT, "")
    if "window.KinOfficeNoCoAuthoring = true;" not in updated:
        marker = "        window.Asc = window.Asc || {};"
        if marker in updated:
            updated = updated.replace(marker, "        window.KinOfficeNoCoAuthoring = true;\n" + marker)
    if "window.compareVersions = true;" not in updated:
        marker = "        window.Asc = window.Asc || {};"
        if marker in updated:
            updated = updated.replace(marker, "        window.compareVersions = true;\n" + marker)
    if "window.Asc.Addons.forms = false;" not in updated:
        marker = "        window.Asc.Addons.ooxml = true;"
        if marker in updated:
            updated = updated.replace(marker, marker + "\n        window.Asc.Addons.forms = false;")
    if "window.Asc.Addons.ooxml = true;" not in updated:
        if "        window.isPDFForm = isForm;" in updated:
            updated = updated.replace(
                "        window.isPDFForm = isForm;",
                "        window.isPDFForm = isForm;\n" + OOXML_ADDON_SCRIPT,
            )
        elif "        window.uitype = \"cell\";" in updated:
            updated = updated.replace(
                "        window.uitype = \"cell\";",
                "        window.uitype = \"cell\";\n" + OOXML_ADDON_SCRIPT,
            )
        elif "        window.uitype = 'slide';" in updated:
            updated = updated.replace(
                "        window.uitype = 'slide';",
                "        window.uitype = 'slide';\n" + OOXML_ADDON_SCRIPT,
            )
    if ZLIB_SCRIPT in updated and "xregexp-all-min.js" not in updated:
        updated = updated.replace(
            ZLIB_SCRIPT,
            ZLIB_SCRIPT + "\n" + SDK_RUNTIME_SCRIPTS,
        )
    # Kin embeds the editor in an iframe — no service worker (avoids SSL scope issues).
    updated = updated.replace(
        '+function registerServiceWorker(){if("serviceWorker"in navigator',
        '+function registerServiceWorker(){return;if("serviceWorker"in navigator',
    )
    return updated


def patch_file(path: Path) -> int:
    text = path.read_text(encoding="utf-8")
    original = text
    for old, new in REPLACEMENTS.items():
        text = text.replace(old, new)
    if path.suffix == ".html":
        text = patch_html_runtime_deps(text)
    if "require.config({baseUrl:\"../../\",paths:" in text:
        text = text.replace(
            "require.config({baseUrl:\"../../\",paths:",
            f"require.config({{baseUrl:\"../../\",urlArgs:\"kinOfficeBuild={KIN_OFFICE_BUILD_ID}\",paths:",
        )
    previous_url_args = [
        "urlArgs:\"kinOfficeBuild=20260603-cache5\",",
        "urlArgs:\"kinOfficeBuild=20260603-cache6\",",
        "urlArgs:\"kinOfficeBuild=20260603-cache7\",",
        "urlArgs:\"kinOfficeBuild=20260603-cache8\",",
        "urlArgs:\"kinOfficeBuild=20260603-cache9\",",
    ]
    for previous in previous_url_args:
        text = text.replace(previous, f"urlArgs:\"kinOfficeBuild={KIN_OFFICE_BUILD_ID}\",")
    for editor, sdk_alias in EDITOR_SDK_ALIASES.items():
        if editor in path.parts:
            text = text.replace("../../sdkjs/source-loader/loaded", sdk_alias)
    text = text.replace(f"'{UPSTREAM_PRODUCT_TOKEN}'", "'Kin Office'")
    text = text.replace(f'"{UPSTREAM_PRODUCT_TOKEN}"', '"Kin Office"')
    text = text.replace(
        "c.toolbarNoTabs || ('desktop' !== e.editorConfig.targetApp && (c.loaderName || c.loaderLogo))",
        "c.toolbarNoTabs || ('desktop' !== e.editorConfig.targetApp && c.loaderLogo)",
    )
    text = text.replace(
        "imgidx      : font.asc_getFontThumbnail(),",
        "imgidx      : -1,",
    )
    text = text.replace(
        "imgidx:t.asc_getFontThumbnail()",
        "imgidx:-1",
    )
    text = text.replace(
        's=Math.floor(i.store.at(n).get("imgidx")/r);var m=i.spriteThumbs.getImage(s);i.tiles[n]=m,$(d[n]).get(0).appendChild(m)',
        's=Math.floor(i.store.at(n).get("imgidx")/r);if(s<0)continue;var m=i.spriteThumbs.getImage(s);i.tiles[n]=m,$(d[n]).get(0).appendChild(m)',
    )
    text = text.replace(
        's=Math.floor(i.store.at(o).get("imgidx")/r);var m=i.spriteThumbs.getImage(s);i.tiles[o]=m,$(d[o]).get(0).appendChild(m)',
        's=Math.floor(i.store.at(o).get("imgidx")/r);if(s<0)continue;var m=i.spriteThumbs.getImage(s);i.tiles[o]=m,$(d[o]).get(0).appendChild(m)',
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
        if not path.is_file():
            continue
        if any(part in {"node_modules", ".git"} for part in path.parts):
            continue
        try:
            patched += patch_file(path)
        except UnicodeDecodeError:
            continue

    if patched == 0:
        print("Kin Office save hook patch: no save handlers needed changes")
        return 0

    print(f"Kin Office save hook patch: patched {patched} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
