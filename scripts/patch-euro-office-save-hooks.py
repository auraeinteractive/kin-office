#!/usr/bin/env python3
"""Install Kin Office save hooks into Euro-Office web-apps source or built assets."""

from pathlib import Path
import re
import sys


SAVE_HOOK = "(window.KinOfficeDirectSave && window.KinOfficeDirectSave())"
UPSTREAM_PRODUCT_TOKEN = "ONLY" + "OFFICE"
SKIP_URL_LOAD_DOCUMENT = (
    "if (!this.appOptions.canSaveDocumentToBinary || (this.document && this.document.url)) "
    "{ this.api.asc_LoadDocument(); }"
)
LOAD_DOCUMENT_RE = re.compile(r"this\.api\.asc_LoadDocument\(\);?")

FONT_COMBO_TEMPLATE_OLD = 'style="height:<%=scope.getListItemHeight()%>px;"></a>'
FONT_COMBO_TEMPLATE_NEW = (
    'style="height:<%=scope.getListItemHeight()%>px;">'
    '<span class="font-item-label" style="display:inline-block;padding:0 8px;line-height:28px;">'
    "<%= item.name %></span></a>"
)
FONT_COMBO_TILE_LABEL_N = (
    's=Math.floor(i.store.at(n).get("imgidx")/r);'
    'if(s<0){var p=$(d[n]).get(0);if(p&&!p.querySelector(".font-item-label")){'
    'var m=document.createElement("span");m.className="font-item-label";'
    'm.textContent=i.store.at(n).get("name")||"";'
    'm.style.cssText="display:inline-block;padding:0 8px;line-height:28px;position:relative;z-index:1;";'
    'p.appendChild(m)}continue;}'
    "var m=i.spriteThumbs.getImage(s);i.tiles[n]=m,$(d[n]).get(0).appendChild(m)"
)
FONT_COMBO_TILE_LABEL_O = (
    's=Math.floor(i.store.at(o).get("imgidx")/r);'
    'if(s<0){var p=$(d[o]).get(0);if(p&&!p.querySelector(".font-item-label")){'
    'var m=document.createElement("span");m.className="font-item-label";'
    'm.textContent=i.store.at(o).get("name")||"";'
    'm.style.cssText="display:inline-block;padding:0 8px;line-height:28px;position:relative;z-index:1;";'
    'p.appendChild(m)}continue;}'
    "var m=i.spriteThumbs.getImage(s);i.tiles[o]=m,$(d[o]).get(0).appendChild(m)"
)
FONT_COMBO_TILE_SKIP_N = (
    's=Math.floor(i.store.at(n).get("imgidx")/r);if(s<0)continue;'
    "var m=i.spriteThumbs.getImage(s);i.tiles[n]=m,$(d[n]).get(0).appendChild(m)"
)
FONT_COMBO_TILE_SKIP_O = (
    's=Math.floor(i.store.at(o).get("imgidx")/r);if(s<0)continue;'
    "var m=i.spriteThumbs.getImage(s);i.tiles[o]=m,$(d[o]).get(0).appendChild(m)"
)
DOCS_FONT_COMBO_RECENT_OLD = (
    'cmbFontName=new Common.UI.ComboBoxFonts({cls:"input-group-nr",menuCls:"scrollable-menu",'
    'menuStyle:"min-width: 325px;",lock:'
)
DOCS_FONT_COMBO_RECENT_NEW = (
    'cmbFontName=new Common.UI.ComboBoxFonts({cls:"input-group-nr",menuCls:"scrollable-menu",'
    'menuStyle:"min-width: 325px;",recent:0,lock:'
)


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
    FONT_COMBO_TEMPLATE_OLD: FONT_COMBO_TEMPLATE_NEW,
    FONT_COMBO_TILE_SKIP_N: FONT_COMBO_TILE_LABEL_N,
    FONT_COMBO_TILE_SKIP_O: FONT_COMBO_TILE_LABEL_O,
    's=Math.floor(i.store.at(n).get("imgidx")/r);if(s<0)continue;var m=i.spriteThumbs.getImage(s);i.tiles[n]=m,$(d[n]).get(0).appendChild(m)':
        FONT_COMBO_TILE_LABEL_N,
    's=Math.floor(i.store.at(n).get("imgidx")/r);var m=i.spriteThumbs.getImage(s);i.tiles[n]=m,$(d[n]).get(0).appendChild(m)':
        FONT_COMBO_TILE_LABEL_N,
    's=Math.floor(i.store.at(o).get("imgidx")/r);if(s<0)continue;var m=i.spriteThumbs.getImage(s);i.tiles[o]=m,$(d[o]).get(0).appendChild(m)':
        FONT_COMBO_TILE_LABEL_O,
    's=Math.floor(i.store.at(o).get("imgidx")/r);var m=i.spriteThumbs.getImage(s);i.tiles[o]=m,$(d[o]).get(0).appendChild(m)':
        FONT_COMBO_TILE_LABEL_O,
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
KIN_FONT_FIX_SCRIPT = r"""\
<script>
+function kinOfficeFontFix(){
    function fontPath() {
        try {
            var marker = "/web-apps/apps/";
            var href = window.location.href;
            var idx = href.indexOf(marker);
            if (idx !== -1) return href.slice(0, idx) + "/fonts/";
            return new URL("../../../../fonts/", href).href;
        } catch (_error) {
            return "../../../../fonts/";
        }
    }
    function fontInfos(fonts) {
        return fonts && (fonts.g_font_infos || fonts.i4a) || null;
    }
    function fontNameMap(fonts) {
        return fonts && (fonts.g_map_font_index || fonts.y0b) || null;
    }
    function fontApplication(fonts) {
        return fonts && (fonts.g_fontApplication || fonts.CQ) || null;
    }
    function installKinFontPicker(fonts) {
        var app = fontApplication(fonts);
        var map = fontNameMap(fonts);
        var infos = fontInfos(fonts);
        if (!app || !map || app._kinFontPickerInstalled) return;
        app._kinFontPickerInstalled = true;
        function has(name) {
            return name !== undefined && name !== null && map[String(name)] !== undefined;
        }
        function hasCjk(value) {
            var text = String(value || "");
            for (var i = 0; i < text.length; i += 1) {
                var code = text.charCodeAt(i);
                if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) return true;
            }
            return false;
        }
        function resolve(name) {
            var requested = String(name || "").replace(/^[\s'"]+|[\s'"]+$/g, "");
            if (has(requested)) return requested;
            var lower = requested.toLowerCase();
            if (lower === "serif") return has("Times New Roman") ? "Times New Roman" : "Noto Serif";
            if (lower === "monospace") return has("Courier New") ? "Courier New" : "Liberation Mono";
            if (lower === "sans-serif" || !requested) return has("Arial") ? "Arial" : "Liberation Sans";
            if (hasCjk(requested)) return has("Noto Sans CJK SC") ? "Noto Sans CJK SC" : "DengXian";
            return has("Arial") ? "Arial" : (has("Liberation Sans") ? "Liberation Sans" : Object.keys(map)[0]);
        }
        function pick(name, style) {
            var resolved = resolve(name);
            return {m_wsFontName: resolved, m_lStyle: style || 0};
        }
        function pickMinified(name, style) {
            var resolved = resolve(name);
            return {uda: resolved, m_wsFontName: resolved, dL: String(name || "")};
        }
        if (fonts.g_fontApplication) {
            app.GetFontFileWeb = pick;
            app.GetFontFile = pick;
            app.GetFontInfoName = function(name, objDst) {
                var resolved = resolve(name);
                if (objDst !== undefined) {
                    objDst.Name = resolved;
                    objDst.Replace = app.CheckReplaceGlyphsMap ? app.CheckReplaceGlyphsMap(name, objDst) : null;
                }
                return resolved;
            };
            app.GetFontInfoWithoutEmbed = function(name, lStyle, objDst) {
                var resolved = resolve(name);
                if (objDst !== undefined) {
                    objDst.Name = resolved;
                    objDst.Replace = app.CheckReplaceGlyphsMap ? app.CheckReplaceGlyphsMap(name, objDst) : null;
                }
                return infos[map[resolved]];
            };
            app.GetFontInfo = app.GetFontInfoWithoutEmbed;
            app.LoadFontWithoutEmbed = function(name, fontLoader, fontManager, size, style, horDpi, verDpi, transform, objDst) {
                var info = app.GetFontInfoWithoutEmbed(name, style, objDst);
                return info.LoadFont(window.AscCommon.g_font_loader, fontManager, size, style, horDpi, verDpi, transform);
            };
            app.LoadFont = app.LoadFontWithoutEmbed;
        } else {
            if (app.v1d) app.v1d = {};
            app.Yed = pickMinified;
            app.mEc = function(name) {
                return resolve(name);
            };
            app.bC = app.Wof = app.sah = function(name, style, objDst) {
                var selected = pickMinified(name, style);
                if (objDst !== undefined) {
                    objDst.ya = selected.uda;
                    objDst.SS = app.sgf ? app.sgf(name, objDst) : null;
                }
                return infos[map[selected.uda]];
            };
        }
    }
    function install() {
        var fonts = window.AscFonts;
        var infos = fontInfos(fonts);
        var app = fontApplication(fonts);
        var map = fontNameMap(fonts);
        var loader = window.AscCommon && window.AscCommon.g_font_loader;
        if (loader && !loader._kinFontPathForced) {
            loader._kinFontPathForced = true;
            loader.fontFilesPath = fontPath();
        }
        if (!fonts || !infos || !map || !app) return false;
        installKinFontPicker(fonts);
        return true;
    }
    function ensureFontDropdownLabels() {
        try {
            if (!/\/documenteditor\//.test(String(window.location.href || ""))) return;
            var app = window.DE;
            if (!app || typeof app.getController !== "function") return;
            var toolbarCtrl = app.getController("Toolbar");
            var combo = toolbarCtrl && toolbarCtrl.toolbar && toolbarCtrl.toolbar.cmbFontName;
            if (!combo || !combo.store || !combo.el) return;
            var $ = window.$ || window.jQuery;
            if (!$) return;
            $(combo.el).find("a.font-item").each(function(index, anchor) {
                if (anchor.querySelector(".font-item-label")) return;
                var li = anchor.closest("li");
                var record = li && li.id ? combo.store.get(li.id) : combo.store.at(index);
                var name = record && record.get ? record.get("name") : "";
                if (!name) return;
                var span = document.createElement("span");
                span.className = "font-item-label";
                span.textContent = name;
                span.style.cssText = "display:inline-block;padding:0 8px;line-height:28px;position:relative;z-index:1;";
                anchor.appendChild(span);
            });
        } catch (_error) {}
    }
    function installFontDropdownLabels() {
        try {
            if (!/\/documenteditor\//.test(String(window.location.href || ""))) return;
            if (window._kinFontDropdownLabelsInstalled) return;
            var app = window.DE;
            if (!app || typeof app.getController !== "function") return;
            var toolbarCtrl = app.getController("Toolbar");
            var combo = toolbarCtrl && toolbarCtrl.toolbar && toolbarCtrl.toolbar.cmbFontName;
            if (!combo) return;
            window._kinFontDropdownLabelsInstalled = true;
            combo.on("show:after", ensureFontDropdownLabels);
            if (window.Common && Common.NotificationCenter) {
                Common.NotificationCenter.on("fonts:load", function() {
                    window.setTimeout(ensureFontDropdownLabels, 0);
                });
            }
            ensureFontDropdownLabels();
        } catch (_error) {}
    }
    var attempts = 0;
    var timer = window.setInterval(function() {
        attempts += 1;
        var installed = install();
        installFontDropdownLabels();
        ensureFontDropdownLabels();
        if (attempts >= 150 || (installed && window.AscCommon && window.AscCommon.g_font_loader)) {
            window.clearInterval(timer);
            install();
            installFontDropdownLabels();
            ensureFontDropdownLabels();
        }
    }, 100);
}();
</script>"""


def is_editor_main_html(path: Path | None) -> bool:
    if not path:
        return False
    path_text = str(path).replace("\\", "/")
    if not any(f"/{editor}/main/" in path_text for editor in ("documenteditor", "spreadsheeteditor", "presentationeditor")):
        return False
    return path.name.startswith("index") and path.suffix == ".html"


def normalize_save_hooks(text: str) -> str:
    updated = text
    while True:
        previous = updated
        updated = re.sub(
            r"(window\.KinOfficeDirectSave&&window\.KinOfficeDirectSave\(\)\|\|)\s*"
            r"\(window\.KinOfficeDirectSave\s*&&\s*window\.KinOfficeDirectSave\(\)\)\s*\|\|\s*",
            r"\1",
            updated,
        )
        updated = re.sub(
            r"(\(window\.KinOfficeDirectSave\s*&&\s*window\.KinOfficeDirectSave\(\)\)\s*\|\|)\s*"
            r"\(window\.KinOfficeDirectSave\s*&&\s*window\.KinOfficeDirectSave\(\)\)\s*\|\|\s*",
            r"\1",
            updated,
        )
        if updated == previous:
            return updated


def patch_html_runtime_deps(text: str, path: Path | None = None) -> str:
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
    updated = re.sub(
        r"<script>\n\+function kinOfficeFont(?:Debug|Fix)\(\)\{.*?\}\(\);\n</script>",
        lambda _match: KIN_FONT_FIX_SCRIPT,
        updated,
        flags=re.S,
    )
    if "kinOfficeFontFix" not in updated and "window.parentOrigin = params[\"parentOrigin\"];" in updated:
        updated = updated.replace(
            "            window.parentOrigin = params[\"parentOrigin\"];\n        </script>",
            "            window.parentOrigin = params[\"parentOrigin\"];\n        </script>\n       " + KIN_FONT_FIX_SCRIPT,
        )
    if "kinOfficeFontFix" not in updated and path and is_editor_main_html(path) and "</head>" in updated:
        updated = updated.replace("</head>", KIN_FONT_FIX_SCRIPT + "\n</head>", 1)
    updated = re.sub(r"\?kinOfficeBuild=[^\"'&\s]+", "", updated)
    updated = updated.replace(
        '+function registerServiceWorker(){if("serviceWorker"in navigator',
        '+function registerServiceWorker(){return;if("serviceWorker"in navigator',
    )
    return updated


def patch_skip_url_load_document(text: str, path: Path) -> str:
    path_text = str(path)
    if "/app/controller/Main.js" not in path_text:
        return text
    if "canSaveDocumentToBinary || (this.document && this.document.url)" in text:
        return text
    return LOAD_DOCUMENT_RE.sub(SKIP_URL_LOAD_DOCUMENT, text)


BUILT_MAIN_APP_JS_REPLACEMENTS = {
    "if(this._isDocReady||this._isPermissionsInited)this.api.asc_LoadDocument();else{":
        "if(this._isDocReady||this._isPermissionsInited){if(!this.appOptions.canSaveDocumentToBinary||this.document&&this.document.url)this.api.asc_LoadDocument();return}else{",
    "if(this._isDocReady||this._isPermissionsInited)return void this.api.asc_LoadDocument();":
        "if(this._isDocReady||this._isPermissionsInited){if(!this.appOptions.canSaveDocumentToBinary||this.document&&this.document.url)this.api.asc_LoadDocument();return}",
    ",this.api.asc_LoadDocument()}},loadCoAuthSettings:function(){":
        ",(!this.appOptions.canSaveDocumentToBinary||this.document&&this.document.url)&&this.api.asc_LoadDocument()}},loadCoAuthSettings:function(){",
    ",this.api.asc_LoadDocument()},loadCoAuthSettings:function(){":
        ",(!this.appOptions.canSaveDocumentToBinary||this.document&&this.document.url)&&this.api.asc_LoadDocument()},loadCoAuthSettings:function(){",
    "),this.api.asc_LoadDocument()},loadCoAuthSettings:function(){":
        ",(!this.appOptions.canSaveDocumentToBinary||this.document&&this.document.url)&&this.api.asc_LoadDocument()},loadCoAuthSettings:function(){",
    ",this.api.asc_LoadDocument())},loadCoAuthSettings:function(){":
        ",(!this.appOptions.canSaveDocumentToBinary||this.document&&this.document.url)&&this.api.asc_LoadDocument())},loadCoAuthSettings:function(){",
}


def patch_built_main_app_js(text: str, path: Path) -> str:
    path_text = str(path).replace("\\", "/")
    if "/packages/kin-office/7/web-apps/apps/" not in path_text:
        return text
    if not path_text.endswith("/main/app.js"):
        return text
    updated = text
    for old, new in BUILT_MAIN_APP_JS_REPLACEMENTS.items():
        updated = updated.replace(old, new)
    return updated


def patch_file(path: Path) -> int:
    text = path.read_text(encoding="utf-8")
    original = text
    text = re.sub(r"(../../sdkjs/(?:word|cell|slide)/sdk-all)(?:-min)+", r"\1-min", text)
    text = re.sub(r"(../../../../sdkjs/(?:word|cell|slide)/sdk-all)(?:-min)+(\.js)", r"\1-min\2", text)
    for old, new in REPLACEMENTS.items():
        text = text.replace(old, new)
    text = normalize_save_hooks(text)
    text = patch_skip_url_load_document(text, path)
    text = patch_built_main_app_js(text, path)
    if path.suffix == ".html":
        text = patch_html_runtime_deps(text, path)
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
    text = text.replace(FONT_COMBO_TEMPLATE_OLD, FONT_COMBO_TEMPLATE_NEW)
    text = text.replace(FONT_COMBO_TILE_SKIP_N, FONT_COMBO_TILE_LABEL_N)
    text = text.replace(FONT_COMBO_TILE_SKIP_O, FONT_COMBO_TILE_LABEL_O)
    if "documenteditor" in path.parts:
        text = text.replace(DOCS_FONT_COMBO_RECENT_OLD, DOCS_FONT_COMBO_RECENT_NEW)
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
