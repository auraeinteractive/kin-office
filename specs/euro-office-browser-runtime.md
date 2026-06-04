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

The adapter creates a `DocsAPI.DocEditor` instance and passes document metadata through the inner editor iframe. Real OOXML document bytes are opened locally with `editor.openDocument({ buffer })`.

For existing files:

```text
OOXML bytes -> x2t.wasm -> DOCY/XLSY/PPTY internal bin -> editor.openDocument()
```

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

The adapter must not pass raw serializer bytes to `x2t` without the expected internal envelope. `browser_editor_adapter.js` wraps raw serializer output with the correct prefix/version when needed.

Current default versions:

```text
docx -> DOCY v5
xlsx -> XLSY v2
pptx -> PPTY v10
```

Prefer extracting the version from the source/template payload when possible.

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
window.__fonts_files
window.__fonts_infos
```

Each family entry has:

```text
[name, indexR, faceIndexR, indexI, faceIndexI, indexB, faceIndexB, indexBI, faceIndexBI]
```

Important loader behavior found in source:

- `sdkjs/common/Drawings/Externals.js` loads `basePath + font.Id`.
- Before passing a font stream to FreeType, it XOR-decodes the first 32 bytes with Euro-Office's ODTTF key.
- Therefore generated browser font files must be ODTTF-obfuscated on disk.

Current generator behavior:

- Local TTF/OTF fonts are preferred over WOFF/WOFF2.
- Generated files use IDs like `odttf10-000001`.
- The first 32 bytes are XOR-obfuscated before writing.
- Latin aliases such as `Arial`, `Calibri`, and `Segoe UI` map to Liberation/Noto fonts.
- CJK aliases such as `等线`, `DengXian`, `Microsoft YaHei`, `SimSun`, `NSimSun`, `黑体`, and `宋体` map to `DroidSansFallbackFull.ttf`.

Current known issue:

- User-visible editor text can still appear as square/tofu boxes.
- The right debugging layer is `AscFonts`, loaded font files, decoded font stream headers, and actual glyph coverage/face selection.
- Do not attempt to fix this with CSS `font-family` rules; those affect HTML chrome, not Euro-Office document canvas rendering.

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
