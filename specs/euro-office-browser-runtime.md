# Euro-Office Browser Runtime

This spec records the Euro-Office behavior learned during Kin Office integration. It fills gaps left by upstream documentation and explains the local constraints that future agents must preserve.

## Runtime Shape

Euro-Office provides a web editor runtime under:

```text
repository/Applications/Office/kinoffice_common/vendor/kin-office/packages/kin-office/7/
```

The important runtime subtrees are:

```text
web-apps/apps/api/documents/api.js
web-apps/apps/documenteditor/
web-apps/apps/spreadsheeteditor/
web-apps/apps/presentationeditor/
sdkjs/word/sdk-all-min.js
sdkjs/cell/sdk-all-min.js
sdkjs/slide/sdk-all-min.js
sdkjs/common/AllFonts.js
sdkjs/common/zlib/
wasm/x2t/x2t.js
fonts/
```

Kin Office loads Euro-Office through `DocsAPI.DocEditor` from `web-apps/apps/api/documents/api.js`. It currently runs with `type: "desktop"` because that mode exposes the browser editor shell that has worked best for local binary open/save, but Kin strips or patches native-only assumptions.

## Build and Patch Flow

Refresh vendor assets only through scripts:

```bash
./scripts/fetch-euro-office-browser-sdk.sh
./scripts/build-euro-office-browser-packages.sh
python3 scripts/generate-kinoffice-allfonts.py
python3 scripts/patch-euro-office-save-hooks.py repository/Applications/Office/kinoffice_common/vendor/kin-office/packages/kin-office/7/web-apps
```

Important generated/patch behavior:

- `scripts/build-euro-office-browser-packages.sh` builds the browser package/runtime assets.
- `scripts/generate-kinoffice-allfonts.py` writes `sdkjs/common/AllFonts.js` and files in `fonts/`.
- `scripts/patch-euro-office-save-hooks.py` installs repeatable Kin patches into built `web-apps` assets.
- Vendor files under `vendor/kin-office/` are generated/downloaded artifacts. Do not hand-edit them when a script can express the change.

## Loading Model

`browser_editor.html` loads:

```text
empty_bin.js
browser_editor_adapter.js
```

`browser_editor_adapter.js` loads:

```text
web-apps/apps/api/documents/api.js
wasm/x2t/x2t.js
```

The adapter creates a `DocsAPI.DocEditor` instance and passes document metadata through the inner editor iframe. Real OOXML document bytes are converted locally with browser `x2t.wasm` and opened with `editor.openDocument({ buffer })`. Do not bypass this with direct `main.api.onEndLoadFile(...)` calls; the supported `DocEditor.openDocument()` path posts `openDocumentFromBinary` to the inner editor and lets Euro-Office call `asc_openDocumentFromBytes(...)`.

For existing files:

```text
OOXML bytes -> x2t.wasm -> DOCY/XLSY/PPTY internal bin -> editor.openDocument()
```

The open conversion must pass explicit x2t format IDs because the output path uses a generic `.bin` extension:

```text
docx input -> m_nFormatFrom 0x0041, m_nFormatTo 0x2001
xlsx input -> m_nFormatFrom 0x0101, m_nFormatTo 0x2002
pptx input -> m_nFormatFrom 0x0081, m_nFormatTo 0x2003
```

`m_bIsNoBase64` is `true` for browser conversion. In this mode x2t may return an already-valid internal stream such as `DOCY;v10;0;<raw bytes>` instead of old base64 payload text. The adapter must preserve any payload that already starts with `DOCY;`, `XLSY;`, or `PPTY;`, whether it is a JavaScript string or a `Uint8Array`. Wrapping an already-valid internal stream inside another `DOCY/XLSY/PPTY` envelope makes Euro-Office open a blank/default model.

For blank files:

```text
empty_bin.js or kinoffice template bytes -> internal bin/template payload -> editor.openDocument()
```

For save/export:

```text
editor state -> native serializer -> internal bin envelope -> x2t.wasm -> OOXML bytes
```

## Internal Bin Formats

Euro-Office uses internal text/binary envelopes:

```text
DOCY;v...;
XLSY;v...;
PPTY;v...;
```

The adapter must not pass raw serializer bytes to `x2t` without the expected internal envelope. `browser_editor_adapter.js` wraps raw serializer output with the correct prefix/version when needed, but it must not wrap payloads that already have a `DOCY/XLSY/PPTY` signature.

Current default versions:

```text
docx -> DOCY v5
xlsx -> XLSY v2
pptx -> PPTY v10
```

Prefer extracting the version from the source/template payload when possible. Existing blank templates currently provide older base64-style envelopes, while x2t no-base64 conversion can produce v10 raw-binary envelopes.

## Save APIs

Useful source-level/runtime save APIs:

- `baseEditorsApi.prototype.getFileAsFromChanges()`
- `asc_nativeGetFile3()`
- `asc_nativeGetFileData()`

`browser_editor_adapter.js` tries them in this order:

1. `api.getFileAsFromChanges()`
2. `api.asc_nativeGetFile3()`
3. `api.asc_nativeGetFileData()` with a temporary `native.Save_End` capture

Do not use upstream `asc_Save()` or `downloadAs()` for Kin persistence. Those enter upstream server/collaboration save machinery. Kin save hooks intercept save requests and call Kin-owned export/write logic.

For export, `browser_editor_adapter.js` serializes the current editor state through the source-level/native APIs above, preserves or creates a valid internal `DOCY/XLSY/PPTY` payload, and runs x2t back to DOCX/XLSX/PPTX. Kin then validates the returned bytes as a ZIP before writing them to the Kin filesystem.

## Required Web-App Patches

`scripts/patch-euro-office-save-hooks.py` currently handles:

- Save button and keyboard save calls route to `window.KinOfficeDirectSave`.
- Important serializer methods are exposed through bracket notation so minification/property access does not hide them.
- Source-loader paths are replaced with packaged `sdk-all-min.js`.
- Runtime dependencies such as zlib/polyfill/xregexp are inserted where needed.
- Native desktop marker `window.IS_NATIVE_EDITOR` is removed.
- OOXML addon flags are enabled and forms are disabled.
- Euro-Office service worker registration is disabled.
- Product text is changed to `Kin Office`.
- Font preview thumbnails are disabled/guarded to avoid huge canvas allocation failures.
- RequireJS `urlArgs` gets the current Kin Office cache id.

When bumping cache IDs, update both app wrapper files and `KIN_OFFICE_BUILD_ID` in the patch script, then rerun the patch script.

## Fonts

Euro-Office document/canvas rendering does not use browser HTML fonts. The canvas engine uses `AscFonts`, `AllFonts.js`, and files from `fonts/`.

`AllFonts.js` defines:

```text
window.g_fonts_selection_bin
window.__fonts_files
window.__fonts_infos
```

Each family entry has:

```text
[name, indexR, faceIndexR, indexI, faceIndexI, indexB, faceIndexB, indexBI, faceIndexBI]
```

Important loader behavior found in source:

- `sdkjs/common/libfont/map.js` uses `window.g_fonts_selection_bin` to build the selectable font list used by `AscFonts.g_fontApplication.GetFontFileWeb()`.
- If `g_fonts_selection_bin` is empty, the packaged `__fonts_infos` catalog can still exist, but the picker may resolve document font names through a nearly empty selection list and fall back to special font `ASCW3`.
- `ASCW3` is not a normal Latin document font. If normal text resolves to it, copied text can remain correct while canvas glyphs render as boxes/symbols.
- `sdkjs/common/Drawings/Externals.js` loads `basePath + font.Id`.
- Before passing a font stream to FreeType, it XOR-decodes the first 32 bytes with Euro-Office's ODTTF key.
- Therefore generated browser font files must be ODTTF-obfuscated on disk.

Current generator behavior:

- Local TTF/OTF fonts are preferred over WOFF/WOFF2.
- Generated files use IDs like `odttf10-000001`.
- The first 32 bytes are XOR-obfuscated before writing.
- Latin aliases such as `Arial`, `Calibri`, and `Segoe UI` map to Liberation/Noto fonts.
- CJK aliases such as `等线`, `DengXian`, `Microsoft YaHei`, `SimSun`, `NSimSun`, `黑体`, and `宋体` map to the Simplified Chinese face in `NotoSansCJK-*.ttc`.
- Current generator writes a minimal Euro-Office v2 `g_fonts_selection_bin` from the same packaged `__fonts_infos` list. This is required because the native picker searches the selection bin first; with an empty bin, `Arial`, `Times New Roman`, and other normal names resolved to the special `ASCW3` font. **Resolved in `20260606-cache22`** — see `specs/problems/font-problem.md`.
- The font combobox UI normally paints each font name from `fonts_thumbnail*.png.bin` sprite rows. Kin ships transparent fallback sprites and sets `imgidx:-1`, so cache24 embeds plain-text font names in the combobox menu template instead of relying on lazy sprite tiles.

Failed font-catalog attempt:

- `DroidSansFallbackFull.ttf` has CJK coverage but lacks normal Latin A-Z/a-z glyph coverage. When Euro-Office selected the East Asian `等线` default, English text rendered as tofu boxes.
- `20260604-cache11` switched CJK aliases to `NotoSansCJK-*.ttc` face index 2, which includes Latin and CJK glyphs.
- User testing reported no visible change after deploy. Do not repeat this as the main fix unless new diagnostics prove the runtime is actually loading the wrong CJK alias.
- The working hypothesis must move away from "the CJK fallback file lacks Latin glyphs" and toward document/template loading, x2t conversion, font streams actually reaching the renderer, or text/glyph encoding inside the internal bin.
- The right debugging layer remains `AscFonts`, loaded font files, decoded font stream headers, and actual glyph coverage/face selection.
- Do not attempt to fix this with CSS `font-family` rules; those affect HTML chrome, not Euro-Office document canvas rendering.

Failed debug-default attempt:

- `20260604-cache12` makes Docs open `kinoffice_common/debug/test.docx` as the default document instead of the blank internal-bin template.
- `assets/test.docx` is an external DOCX containing readable Arial text ("Hello world!" and "How are you doing?").
- User testing still showed `Document.docx`, a blank page, Chinese default font, and tofu boxes. That means the debug DOCX did not actually become the opened session.

Current debug path:

- `20260604-cache13` removes the bottom-left build overlay and sends those messages to `console.log` only.
- Docs forces the debug default even if Kin passes a `path` or `kin_open_path` query parameter.
- Console logs now record the launch query, forced-debug decision, fetched debug DOCX URL and byte count, posted open payload, and adapter `createInstance` options.
- User testing after `cache13` still showed the same visual issue, but the console proved the debug path had not run: the outer Docs app bootstrapped `office_app.js?kinOfficeBuild=20260604-cache11` and opened `Document.docx` with `isNew=true` and `bytes=0`. Only the inner adapter had reached `cache13`.
- `20260604-cache14` moves Docs to a new wrapper entry file, `app_debug_20260604_cache14.js`, and logs `kinoffice_docs launcher` before creating the Kin window. This is meant to bypass a stale browser/Kin module cache for `kinoffice_docs/app.js`.
- After the next test, the user clarified the visible boxes were typed into the blank document; `test.docx` was still not loaded. The console still showed `kin_repo_entry=app.js` and no `kinoffice_docs launcher` log, which means the already-running Kin workspace was still using stale app metadata for `kinoffice_docs`.
- The Docs manifest now points directly to `app_debug_20260604_cache14.js` as version `21`. A running Kin workspace may need to reload its application metadata before this takes effect.
- Direct manifest entries are loaded as classic scripts, not module scripts. The first direct-entry attempt failed with `Cannot use import statement outside a module`; `app_debug_20260604_cache14.js` and the fallback `app.js` now use dynamic `import()` from a classic-script wrapper.
- If `Debug Arial Test.docx` renders correctly, debug the blank/template/internal-bin path. If it still renders as boxes, debug x2t conversion, internal document text encoding, or Euro-Office canvas/font loading for a known Arial DOCX.

Font thumbnail sprite 404:

- The console also showed `GET .../sdkjs/common/Images/fonts_thumbnail.png.bin 404`.
- That file family was missing from the packaged browser runtime. `scripts/generate-kinoffice-font-thumbnail-bins.py` now creates transparent fallback alpha-mask sprites for `fonts_thumbnail*.png.bin` and `fonts_thumbnail_ea*.png.bin`.
- The fallback sprites only prevent the font combobox from loading a 404 response as binary sprite data. They are not expected to fix document canvas text by themselves.

Inner editor cache bust:

- Once `Debug Arial Test.docx` loaded, the canvas still rendered boxes. The console stack showed inner editor resources such as `sdk-all-min.js?kinOfficeBuild=20260604-cache11` even while the outer wrapper was cache14.
- Euro-Office `apps/api/documents/api.js` hardcoded the editor iframe query as `?_dc=0`; `scripts/patch-euro-office-save-hooks.py` now rewrites that to the current Kin Office cache id.
- `20260604-cache15` also moves the Docs manifest to `app_debug_20260604_cache15.js` so the manifest entry filename itself is cache-busted.
- User testing after `cache15` showed progress: `Debug Arial Test.docx` loaded with the expected title and Arial toolbar state, but document text was still tofu. The console still showed stack frames from `sdk-all-min.js?kinOfficeBuild=20260604-cache11`.
- `20260604-cache16` treats that as a Euro-Office browser-cache/service-worker problem rather than another font-catalog problem. `browser_editor_adapter.js` unregisters Euro-Office service workers scoped under the packaged vendor path and deletes `document_editor_static_*` / `document_editor_dynamic_*` Cache Storage entries before loading `DocsAPI`.
- If cache16 logs show current `sdk-all-min.js?kinOfficeBuild=20260604-cache16` and text is still tofu, stop pursuing outer app/cache busting and instrument the real inner editor `AscFonts` path instead.

Useful diagnostics already installed in `browser_editor_adapter.js`:

```text
[KinOfficeBrowser <build>] font registry
[KinOfficeBrowser <build>] font load request
[KinOfficeBrowser <build>] font load complete
```

Expected decoded TTF header starts with:

```text
00 01 00 00
```

## Avoided Paths

These approaches were tried or planned but are not the current architecture:

- Running the full unminified source-loader runtime directly as the product path.
- Building a Document Server-compatible `/ds/` or `/direct/` service.
- Replacing Kin-owned persistence with Euro-Office server save callbacks.
- Treating browser cache as the root cause of every blank/open problem.

The unminified source remains useful for understanding minified runtime behavior, but the runtime path should stay on packaged browser assets plus scripted patches.
