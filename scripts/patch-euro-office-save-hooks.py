#!/usr/bin/env python3
"""Install Kin Office save hooks into Euro-Office web-apps source or built assets."""

from pathlib import Path
import re
import sys


SAVE_HOOK = "(window.KinOfficeDirectSave && window.KinOfficeDirectSave())"
UPSTREAM_PRODUCT_TOKEN = "ONLY" + "OFFICE"
KIN_OFFICE_BUILD_ID = "20260606-cache22"


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
KIN_FONT_DEBUG_SCRIPT = """\
<script>
+function kinOfficeFontDebug(){
    var build = "__KIN_OFFICE_BUILD_ID__";
    function send(topic, data) {
        try {
            var payload = {type: "kinOfficeFontDebug", build: build, topic: topic, data: data || {}};
            console.log("[KinOfficeFont " + build + "]", topic, data || {});
            window.parent && window.parent.postMessage(payload, "*");
        } catch (_error) {}
    }
    window.addEventListener("error", function(event) {
        send("inner error", {message: event.message, source: event.filename, line: event.lineno, column: event.colno});
    });
    window.addEventListener("unhandledrejection", function(event) {
        var reason = event.reason || {};
        send("inner rejection", {message: reason.message || String(reason)});
    });
    window.onLogPickFont = function(message) {
        send("pick font", {message: String(message || "")});
    };
    var OriginalXHR = window.XMLHttpRequest;
    if (OriginalXHR && OriginalXHR.prototype && !OriginalXHR.prototype._kinFontDebugWrapped) {
        OriginalXHR.prototype._kinFontDebugWrapped = true;
        var originalOpen = OriginalXHR.prototype.open;
        var originalSend = OriginalXHR.prototype.send;
        OriginalXHR.prototype.open = function(method, url) {
            this._kinFontDebugUrl = String(url || "");
            return originalOpen.apply(this, arguments);
        };
        OriginalXHR.prototype.send = function() {
            var xhr = this;
            var url = xhr._kinFontDebugUrl || "";
            var watch = /(?:odttf|AllFonts|fonts_thumbnail|fonts\\/)/.test(url);
            if (watch) {
                send("xhr start", {url: url});
                xhr.addEventListener("load", function() {
                    var size = 0;
                    try {
                        if (xhr.response && xhr.response.byteLength !== undefined) size = xhr.response.byteLength;
                        else if (xhr.responseText) size = xhr.responseText.length;
                    } catch (_error) {}
                    send("xhr load", {url: url, status: xhr.status, size: size});
                });
                xhr.addEventListener("error", function() {
                    send("xhr error", {url: url, status: xhr.status});
                });
            }
            return originalSend.apply(this, arguments);
        };
    }
    function streamHeader(stream) {
        var data = stream && stream.data;
        var size = stream && stream.size;
        if (!data || !size) return null;
        var bytes = [];
        var count = Math.min(8, size);
        for (var i = 0; i < count; i += 1) bytes.push(("0" + data[i].toString(16)).slice(-2));
        return bytes.join(" ");
    }
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
    function fontFiles(fonts) {
        return fonts && (fonts.g_font_files || fonts.Snc) || null;
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
    function fileId(file) {
        return file && (file.Id || file.uda || file.id || file.name);
    }
    function describeSelectionList(app) {
        var list = app && app.Rnc && app.Rnc.OS;
        if (!list) return null;
        return {
            count: list.length,
            first: list.slice(0, 8).map(function(item) {
                return item && {name: item.uda || item.m_wsFontName, path: item.XWa || item.m_wsFontPath};
            })
        };
    }
    function describeFont(fonts, name) {
        var map = fontNameMap(fonts);
        var infos = fontInfos(fonts);
        var index = map && map[name];
        var info = index !== undefined && infos ? infos[index] : null;
        if (!info) return null;
        return {
            name: info.Name || info.ya,
            indexR: info.indexR !== undefined ? info.indexR : info.N3,
            faceIndexR: info.faceIndexR !== undefined ? info.faceIndexR : info.Ldb,
            indexI: info.indexI !== undefined ? info.indexI : info.hda,
            faceIndexI: info.faceIndexI !== undefined ? info.faceIndexI : info.rnc,
            indexB: info.indexB !== undefined ? info.indexB : info.rP,
            faceIndexB: info.faceIndexB !== undefined ? info.faceIndexB : info.pnc
        };
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
            var requested = String(name || "").replace(/^[\\s'"]+|[\\s'"]+$/g, "");
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
            send("pick packaged font", {requested: String(name || ""), resolved: resolved, style: style || 0});
            return {m_wsFontName: resolved, m_lStyle: style || 0};
        }
        function pickMinified(name, style) {
            var resolved = resolve(name);
            send("pick packaged font", {requested: String(name || ""), resolved: resolved, style: style || 0, symbolMode: "minified"});
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
        send("packaged font picker installed", {
            arial: has("Arial"),
            cjk: has("Noto Sans CJK SC"),
            selectionBinBytes: window.g_fonts_selection_bin ? window.g_fonts_selection_bin.length : 0,
            symbolMode: fonts.g_fontApplication ? "source" : "minified",
            selectionList: describeSelectionList(app)
        });
    }
    function install() {
        var fonts = window.AscFonts;
        var files = fontFiles(fonts);
        var infos = fontInfos(fonts);
        var app = fontApplication(fonts);
        var map = fontNameMap(fonts);
        var loader = window.AscCommon && window.AscCommon.g_font_loader;
        if (loader && !loader._kinFontPathForced) {
            loader._kinFontPathForced = true;
            loader.fontFilesPath = fontPath();
            send("font path forced", {fontFilesPath: loader.fontFilesPath, href: window.location.href});
        }
        if (!fonts || !infos || !map || !app) return false;
        installKinFontPicker(fonts);
        if (fonts._kinInnerFontDiagnosticsInstalled) return true;
        fonts._kinInnerFontDiagnosticsInstalled = true;
        send("font registry", {
            allFontsVersion: window.__all_fonts_js_version__,
            selectionBinBytes: window.g_fonts_selection_bin ? window.g_fonts_selection_bin.length : 0,
            files: files && files.length,
            infos: infos && infos.length,
            symbolMode: {
                files: fonts.g_font_files ? "source" : "minified",
                infos: fonts.g_font_infos ? "source" : "minified",
                map: fonts.g_map_font_index ? "source" : "minified",
                app: fonts.g_fontApplication ? "source" : "minified"
            },
            selectionList: describeSelectionList(app),
            arial: describeFont(fonts, "Arial"),
            calibri: describeFont(fonts, "Calibri"),
            dengxian: describeFont(fonts, "DengXian"),
            dengxianLight: describeFont(fonts, "DengXian Light")
        });
        (files || []).forEach(function(file, index) {
            if (!file || file._kinFontDiagnosticsWrapped || typeof file.LoadFontAsync !== "function") return;
            file._kinFontDiagnosticsWrapped = true;
            var originalLoadFontAsync = file.LoadFontAsync;
            file.LoadFontAsync = function(basePath, callback) {
                send("font load request", {index: index, id: fileId(file), basePath: basePath, status: file.Status, streamIndex: file.stream_index});
                return originalLoadFontAsync.call(file, basePath, function() {
                    var stream = fonts.g_fonts_streams && fonts.g_fonts_streams[file.stream_index];
                    send("font load complete", {index: index, id: fileId(file), status: file.Status, streamIndex: file.stream_index, size: stream && stream.size, header: streamHeader(stream)});
                    if (callback) callback();
                });
            };
        });
        return true;
    }
    var attempts = 0;
    var timer = window.setInterval(function() {
        attempts += 1;
        var installed = install();
        if (attempts >= 150 || (installed && window.AscCommon && window.AscCommon.g_font_loader)) {
            window.clearInterval(timer);
            install();
            send("font debug ready", {attempts: attempts});
        }
    }, 100);
}();
</script>"""


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
    font_debug_script = KIN_FONT_DEBUG_SCRIPT.replace("__KIN_OFFICE_BUILD_ID__", KIN_OFFICE_BUILD_ID)
    updated = re.sub(
        r"<script>\n\+function kinOfficeFontDebug\(\)\{.*?\}\(\);\n</script>",
        lambda _match: font_debug_script,
        updated,
        flags=re.S,
    )
    updated = updated.replace(
        "        if (!fonts || fonts._kinInnerFontDiagnosticsInstalled) return !!fonts;",
        "        if (!fonts || !fonts.g_font_files || !fonts.g_font_infos) return false;\n"
        "        if (fonts._kinInnerFontDiagnosticsInstalled) return true;",
    )
    if "kinOfficeFontDebug" not in updated and "window.parentOrigin = params[\"parentOrigin\"];" in updated:
        updated = updated.replace(
            "            window.parentOrigin = params[\"parentOrigin\"];\n        </script>",
            "            window.parentOrigin = params[\"parentOrigin\"];\n        </script>\n       " + font_debug_script,
        )
    updated = re.sub(
        r'(<script type="text/javascript" src="../../../../sdkjs/common/AllFonts\.js)(?:\?kinOfficeBuild=[^"]*)?("></script>)',
        rf'\1?kinOfficeBuild={KIN_OFFICE_BUILD_ID}\2',
        updated,
    )
    updated = re.sub(
        r'(<script type="text/javascript" src="../../../../sdkjs/(?:word|cell|slide)/sdk-all-min\.js)(?:\?kinOfficeBuild=[^"]*)?("></script>)',
        rf'\1?kinOfficeBuild={KIN_OFFICE_BUILD_ID}\2',
        updated,
    )
    updated = re.sub(
        r'(script\.src = "../../../apps/[^"]+/embed/app-all\.js)(?:\?kinOfficeBuild=[^"]*)?(")',
        rf'\1?kinOfficeBuild={KIN_OFFICE_BUILD_ID}\2',
        updated,
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
    text = re.sub(r"(../../sdkjs/(?:word|cell|slide)/sdk-all)(?:-min)+", r"\1-min", text)
    text = re.sub(r"(../../../../sdkjs/(?:word|cell|slide)/sdk-all)(?:-min)+(\.js)", r"\1-min\2", text)
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
        "urlArgs:\"kinOfficeBuild=20260603-cache10\",",
        "urlArgs:\"kinOfficeBuild=20260604-cache11\",",
        "urlArgs:\"kinOfficeBuild=20260604-cache12\",",
        "urlArgs:\"kinOfficeBuild=20260604-cache13\",",
        "urlArgs:\"kinOfficeBuild=20260604-cache14\",",
        "urlArgs:\"kinOfficeBuild=20260604-cache15\",",
        "urlArgs:\"kinOfficeBuild=20260604-cache16\",",
        "urlArgs:\"kinOfficeBuild=20260606-cache17\",",
        "urlArgs:\"kinOfficeBuild=20260606-cache18\",",
        "urlArgs:\"kinOfficeBuild=20260606-cache19\",",
        "urlArgs:\"kinOfficeBuild=20260606-cache20\",",
        "urlArgs:\"kinOfficeBuild=20260606-cache21\",",
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
        'var params = "?_dc=0";',
        f'var params = "?_dc={KIN_OFFICE_BUILD_ID}";',
    )
    text = text.replace(
        'var params = "?_dc=20260604-cache14";',
        f'var params = "?_dc={KIN_OFFICE_BUILD_ID}";',
    )
    text = text.replace(
        'var params = "?_dc=20260604-cache15";',
        f'var params = "?_dc={KIN_OFFICE_BUILD_ID}";',
    )
    text = text.replace(
        'var params = "?_dc=20260604-cache16";',
        f'var params = "?_dc={KIN_OFFICE_BUILD_ID}";',
    )
    text = text.replace(
        'var params = "?_dc=20260606-cache17";',
        f'var params = "?_dc={KIN_OFFICE_BUILD_ID}";',
    )
    text = text.replace(
        'var params = "?_dc=20260606-cache18";',
        f'var params = "?_dc={KIN_OFFICE_BUILD_ID}";',
    )
    text = text.replace(
        'var params = "?_dc=20260606-cache19";',
        f'var params = "?_dc={KIN_OFFICE_BUILD_ID}";',
    )
    text = text.replace(
        'var params = "?_dc=20260606-cache20";',
        f'var params = "?_dc={KIN_OFFICE_BUILD_ID}";',
    )
    text = text.replace(
        'var params = "?_dc=20260606-cache21";',
        f'var params = "?_dc={KIN_OFFICE_BUILD_ID}";',
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
