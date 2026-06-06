# Kin Office Font Rendering Bug

**Status:** Resolved

**Date opened:** 2026-06-04  
**Date resolved:** 2026-06-06  
**Build id:** `20260606-cache25`

**Why canvas rendering was fixed (cache22):** Euro-Office's native font picker does not search `__fonts_infos` directly. It first parses `window.g_fonts_selection_bin` into selectable font records. Kin Office's generated `AllFonts.js` left that bin empty, so ordinary names like `Arial` and `Times New Roman` fell through to the bundled symbol font `ASCW3`. That kept document text correct when copied (Unicode was fine) but made the canvas render digit/box glyphs. The durable fix is in `scripts/generate-kinoffice-allfonts.py`: it now emits a valid Euro-Office v2 `g_fonts_selection_bin` with one selectable record per packaged family/alias, each pointing at the matching `odttf10-*` file. After regenerating `AllFonts.js` and deploying cache22, the picker resolves `Arial => Arial` and canvas text renders normally.

**Why font dropdown labels were broken in Docs only (cache25):** Euro-Office's `ComboBoxFonts` renders dropdown names as canvas sprite rows from `fonts_thumbnail*.png.bin`, not plain text. Kin disables those thumbnails (`imgidx:-1`) and ships transparent fallback sprites, so each `<a class="font-item">` is visually empty unless a text label is added. The vendor patch in `main/app.js` is identical for Docs, Sheets, and Slides, but Docs still showed blank rows because:

1. **Docs toolbar uses `recent: 5` by default.** That enables the "recent fonts" code path, which calls `flushVisibleFontsTiles()` and `updateVisibleFontsTiles()` every time the menu opens. With `imgidx:-1`, no sprite is drawn and nothing else filled the row. Sheets' formula-bar font picker uses `recent: 0`, which skips that refresh path — which is why Sheets/Slides looked fine while Docs did not.
2. **`kinoffice_docs/main.js` pointed at a stale debug entry (`cache22`)** while the manifest had moved forward, so Docs sessions could lag behind Sheets/Slides during iterative testing.

**Font dropdown label fix (cache25):**

- Embed each font `name` in the combobox HTML template (`<span class="font-item-label">`) via `FONT_COMBO_TEMPLATE_*` in `scripts/patch-euro-office-save-hooks.py`.
- When `imgidx < 0`, inject a text `<span class="font-item-label">` at tile-render time instead of skipping silently (`FONT_COMBO_TILE_LABEL_*`).
- Set Docs toolbar `cmbFontName` to `recent: 0` (same as Sheets formula bar).
- Inject a Docs-only inner-iframe hook in `documenteditor/main/index.html` that fills labels on `fonts:load` and `show:after`.
- Add a parent-side docx hook in `browser_editor_adapter.js` as a belt-and-suspenders fallback.
- Align `kinoffice_docs/main.js` with manifest entry `app_debug_20260606_cache25.js`.

---

## Symptom (user-reported)

When opening a new document in the Kin Office Docs app and typing ASCII text, glyphs render as the wrong shapes. Specifically:

- Typing `Hello` renders as `00000`
- Typing `!` renders as `←` (U+2190 LEFTWARDS ARROW)
- Space characters render as space (preserved)
- Run-level styling (color, size) is preserved
- The actual text content is correct — copying and pasting the "00000" yields `Hello`

The font dropdown UI was also broken in Docs: the list of font names appeared blank (empty `<a class="font-item">` rows), while Sheets and Slides showed names correctly. Style/gallery previews rendered the same box glyphs as the document canvas before the canvas fix.

Important current clue: copying the visible box text from the document and pasting it elsewhere yields the correct Unicode text:

```text
Hello world!

How are you doing?
```

That means the DOCX/open/x2t text content is intelligible. The failure is in Euro-Office's canvas font selection/rendering path, not in the document text payload.

Canvas rendering affected Docs (and would affect Sheets/Slides the same way). Font dropdown label display was Docs-only after cache22; resolved in cache25.

---

## Architecture context

The Docs app loads the Euro-Office browser SDK at runtime:

- `kinoffice_docs/app.js` imports `kinoffice_common/office_app.js`
- `office_app.js` creates an `<iframe id="iframe">` and loads `kinoffice_common/browser_editor.html` into it
- `browser_editor.html` loads `browser_editor_adapter.js` (`window.KinOfficeBrowser`)
- `browser_editor_adapter.js` loads `vendor/kin-office/packages/kin-office/7/web-apps/apps/api/documents/api.js` (relative URL) via a `<script>` tag with cache buster
- `api.js` instantiates `DocsAPI.DocEditor`, which creates a second nested iframe (`<iframe name="frameEditor">`) at `apps/documenteditor/embed/index.html` (resolved relative to the api.js URL)
- The nested iframe loads `AllFonts.js` (catalog) and `sdkjs/word/sdk-all-min.js` (minified SDK)
- When the editor needs a glyph, the SDK XHRs `fontFilesPath + fontId` (e.g. `../../../../fonts/odttf10-000003`) from the iframe's base
- The response is XOR-decoded using `_ODTTF_KEY = [0xA0, 0x66, 0xD6, 0x20, 0x14, 0x96, 0x47, 0xFA, 0x95, 0x69, 0xB8, 0x50, 0xB0, 0x41, 0x49, 0x48]`
- The decoded buffer is handed to the WASM font engine (`window.AscFonts`)

---

## Files involved (verified)

| Path | Purpose |
| --- | --- |
| `repository/Applications/Office/kinoffice_common/browser_editor_adapter.js` | Browser adapter. Has `installFontDiagnostics()` that wraps `CFontFileLoader.LoadFontAsync` and logs every font load request/complete. Currently logs only the parent window's `window.AscFonts`, which is undefined — the SDK runs in the nested iframe, not the parent. Diagnostics are effectively no-ops as written. |
| `repository/Applications/Office/kinoffice_common/office_app.js` | Bootstraps the iframe shell. |
| `repository/Applications/Office/kinoffice_common/browser_editor.html` | Iframe shell. Loads `browser_editor_adapter.js`. |
| `repository/Applications/Office/kinoffice_common/vendor/kin-office/packages/kin-office/7/sdkjs/common/AllFonts.js` | Generated catalog (`window.__fonts_files`, `window.__fonts_infos`). Regenerated by `scripts/generate-kinoffice-allfonts.py`. |
| `repository/Applications/Office/kinoffice_common/vendor/kin-office/packages/kin-office/7/sdkjs/word/sdk-all-min.js` | Minified word SDK. |
| `repository/Applications/Office/kinoffice_common/vendor/kin-office/packages/kin-office/7/web-apps/apps/api/documents/api.js` | DocEditor host. |
| `repository/Applications/Office/kinoffice_common/vendor/kin-office/packages/kin-office/7/web-apps/apps/documenteditor/embed/index.html` | Iframe HTML loaded by DocEditor. |
| `repository/Applications/Office/kinoffice_common/vendor/kin-office/packages/kin-office/7/fonts/odttf10-000001..000022` | XOR-encoded font files served to the SDK. |
| `repository/Applications/Office/kinoffice_common/vendor/kin-office/source/sdkjs/common/Drawings/Externals.js` | Reference (unminified) — `CFontFileLoader`, `CFontInfo`, `XOR` decode, `checkAllFonts`. |
| `repository/Applications/Office/kinoffice_common/vendor/kin-office/source/sdkjs/common/libfont/map.js` | Reference — `LoadFontWithoutEmbed`, `GetFontFileWeb`, font picker with `window.onLogPickFont("FontPicker: …")` at line 2933-2934. |
| `repository/Applications/Office/kinoffice_common/vendor/kin-office/source/sdkjs/common/libfont/character.js` | Reference — `FontPickerByCharacter` at line 1080-1101; `window.onLogPickFont("FontBySymbol: …")` at line 154-155. |
| `repository/Applications/Office/kinoffice_common/vendor/kin-office/source/sdkjs/common/GlobalLoaders.js` | Reference — `this.fontFilesPath = "../../../../fonts/"` at line 43 (relative to the iframe). |
| `scripts/generate-kinoffice-allfonts.py` | Generator for `AllFonts.js` and the `odttf10-*` font files. Writes to `repository/Applications/Office/kinoffice_common/vendor/kin-office/packages/kin-office/7/fonts/`. |
| `scripts/patch-euro-office-save-hooks.py` | Vendor web-app patcher. Injects repeatable inner-iframe font diagnostics and the current packaged-font picker bypass. |
| `deploy.sh` | Deploys `kinoffice_*` apps to `${KIN_BUILD_PATH}/repository/Applications/Office/` (no `--delete`, no nginx reload). |

---

## What was tried

### 1. Catalog completeness check (defensive)

- Verified `AllFonts.js` has 22 entries in `__fonts_files` (odttf10-000001..000022) and 63 entries in `__fonts_infos` (was 53 before this work; added 10 Office default aliases).
- Verified CJK entries use `face_index: 2` and Latin entries use `face_index: 0` (matches Noto CJK TTC face 2 = SC; Liberation Sans TTF face 0).
- Verified XOR key round-trips: first 16 bytes of `odttf10-000001` decode to `ttcf` + version + 10 faces + TTC header offset 0x34.
- Verified `odttf10-000003` (Liberation Sans Regular) name table; cmap mapping:
  - `H` (0x48) → gid 0x002B
  - `!` (0x21) → gid 0x0004
  - ` ` (0x20) → gid 0x0003
  - `0` (0x30) → gid 0x0013
  - `←` (0x2190) → gid 0x0844
- Decoded the empty `.docx` from `empty_bin.js` (DOCY;v5;7372;... envelope). UTF-16 string extraction shows:
  - **Default font = "DengXian Light"** at @2212, @2388
  - "Yu Gothic Light" at @2308 (NOT in catalog)
  - "DengXian" at @3691, @3839
  - "Arial" at @2240
  - zh-CN default (script tags include `Hans`)

**Conclusion of catalog check:** the docx's defaults (`DengXian Light`, `Arial`) are already in the catalog. The catalog is unlikely to be the root cause of the symptom.

**Action taken:** added `Calibri Light`, `Aptos`, `Aptos Display`, `Aptos Mono`, `Aptos Serif`, `Carlito`, `Segoe UI Light`, `Segoe UI Semibold`, `Verdana Pro` to the Liberation Sans alias list in `scripts/generate-kinoffice-allfonts.py` and regenerated `AllFonts.js` (63 families, was 53). Deployed via `./deploy.sh --to-kin`. **User reports the symptom persists after the change.**

### 2. Font file HTTP availability (verified)

```
$ curl -sk 'https://localhost:9219/repository/Applications/Office/kinoffice_common/vendor/kin-office/packages/kin-office/7/fonts/odttf10-000003'
Size: 410820
First 16 bytes (hex): a0 67 d6 20 14 85 46 fa 95 6d b8 60 f6 07 1d 05
Decoded first 16 bytes (hex): 00 01 00 00 00 13 01 00 00 04 00 30 46 46 54 4d
Decoded magic (ascii): 00 01 00 00  (TTF)
```

**Conclusion:** the file is reachable, correct size, correct XOR encoding, correct TTF magic. The HTTP path resolves correctly.

```
$ curl -sk 'https://localhost:9219/repository/Applications/Office/kinoffice_common/vendor/kin-office/packages/kin-office/7/web-apps/apps/documenteditor/embed/../../../../fonts/odttf10-000003'
Size: 410820  (same file)
```

The iframe-relative path `../../../../fonts/odttf10-000003` from the nested iframe at `apps/documenteditor/embed/index.html` resolves correctly to the `7/fonts/` directory.

### 3. nginx/URL routing observed

- The user's nginx (port 9219, TLS) proxies to Kin HTTP on `127.0.0.1:9119`.
- `https://localhost:9219/repository/kinoffice_common/...` and `https://localhost:9219/repository/Applications/Office/kinoffice_common/...` BOTH return 302 → versioned URL → 200 with the same content (md5 verified identical).
- The Kin server has both URL forms; nginx does no path rewriting.
- This means SDK-relative paths starting at `apps/`, `sdkjs/`, `fonts/`, etc. (under `kinoffice_common/`) all resolve correctly relative to the iframe.

### 4. User-provided data point

The user fetched `https://localhost:9219/repository/kinoffice_common/vendor/kin-office/packages/kin-office/7/sdkjs/common/Images/fonts_thumbnail.png.bin` and reported the file is 136KB but contains only a few characters in the first 8 bytes (`000,000[]` where `[]` is a square character) followed by all zeros. The file on disk is NOT all zeros (first 100 bytes contain 48 non-zero bytes; first 16 are `00 00 01 2c 00 00 00 1c 00 00 08 00 00 ff 00 ff` which is a different format than the user observed). This file is the font dropdown thumbnail and is not on the critical path for glyph rendering, but the discrepancy (server response vs disk content) may indicate the user is seeing a cached/stale response, or the server returns a different file for that specific URL. **Not yet root-caused.**

### 5. Installed diagnostics (deployed but not yet captured by user)

`browser_editor_adapter.js:136-174` has `installFontDiagnostics()`:

```js
function installFontDiagnostics() {
    var fonts = window.AscFonts;  // ← runs in PARENT window, but SDK is in IFRAME
    if (!fonts || fonts._kinFontDiagnosticsInstalled) return;
    fonts._kinFontDiagnosticsInstalled = true;
    debugLog('font registry', {
        files: fonts.g_font_files && fonts.g_font_files.length,
        infos: fonts.g_font_infos && fonts.g_font_infos.length,
        arial: describeFontInfo('Arial'),
        dengxian: describeFontInfo('等线'),
        calibri: describeFontInfo('Calibri')
    });
    if (!fonts.g_font_files) return;
    fonts.g_font_files.forEach(function(file, index) {
        if (!file || file._kinFontDiagnosticsWrapped || typeof file.LoadFontAsync !== 'function') return;
        file._kinFontDiagnosticsWrapped = true;
        var originalLoadFontAsync = file.LoadFontAsync;
        file.LoadFontAsync = function(basePath, callback) {
            debugLog('font load request', {
                index: index, id: file.Id, basePath: basePath,
                status: file.Status, streamIndex: file.stream_index
            });
            return originalLoadFontAsync.call(file, basePath, function() {
                var stream = fonts.g_fonts_streams && fonts.g_fonts_streams[file.stream_index];
                debugLog('font load complete', {
                    index: index, id: file.Id, status: file.Status,
                    streamIndex: file.stream_index, size: stream && stream.size,
                    header: streamHeader(stream)
                });
                if (callback) callback();
            });
        };
    });
}
```

**Critical flaw:** `window.AscFonts` is not in the parent window; the SDK runs in the nested iframe. The diagnostics as written are no-ops and would not capture anything in the parent console. Need to either inject this hook into the nested iframe, or hook the iframe's `XMLHttpRequest.prototype` from the parent.

### 6. Runtime iframe diagnostics (`20260606-cache17` / `20260606-cache18`)

`20260606-cache17` addresses the critical flaw above. It does not try another blind font catalog rewrite.

Important correction after first `cache17` deploy:

- The initial patch script was not idempotent for SDK bundle paths. It replaced strings like `../../sdkjs/slide/sdk-all` with `../../sdkjs/slide/sdk-all-min`, but an already-patched `sdk-all-min` still starts with `sdk-all`.
- Re-running the patcher produced bad URLs such as `sdk-all-min-min-min.js`, causing 404s and preventing the editor runtime from loading normally.
- The patcher now collapses repeated `-min` suffixes back to exactly one and no longer performs the broad `../../sdkjs/*/sdk-all` replacement.
- If a future test shows `sdk-all-min-min*.js`, fix the patcher/idempotency first; do not debug fonts while the SDK bundle is 404ing.

Changes:

- `scripts/patch-euro-office-save-hooks.py` injects a `kinOfficeFontDebug` script into editor iframe HTML files that contain `window.parentOrigin`.
- The injected script runs inside the nested `frameEditor` window before the SDK loads.
- It wraps `XMLHttpRequest` and logs watched requests for `AllFonts`, `odttf*`, `fonts/`, and `fonts_thumbnail*`.
- It installs `window.onLogPickFont` so vendor `FontPicker` and `FontBySymbol` decisions are visible.
- It waits until `window.AscFonts.g_font_files` and `window.AscFonts.g_font_infos` exist, then wraps each `CFontFileLoader.LoadFontAsync`.
- It logs `font load request` and `font load complete`, including stream size and decoded header bytes.
- It forces `AscCommon.g_font_loader.fontFilesPath` to an absolute same-origin `/fonts/` URL derived from the iframe URL. This should be equivalent to the normal relative path, but removes base-URL ambiguity from the next test.
- `browser_editor_adapter.js` relays these messages as `[KinOfficeBrowser 20260606-cache17] inner font debug ...`.
- The same injected script now also installs a temporary packaged-font picker bypass. This is a targeted test for the empty-selection-bin / `ASCW3` theory below.

Expected useful console lines:

```text
[KinOfficeBrowser 20260606-cache17] inner font debug xhr start ...
[KinOfficeBrowser 20260606-cache17] inner font debug xhr load {status: 200, size: ...}
[KinOfficeBrowser 20260606-cache17] inner font debug font path forced ...
[KinOfficeBrowser 20260606-cache17] inner font debug font registry ...
[KinOfficeBrowser 20260606-cache17] inner font debug font load request ...
[KinOfficeBrowser 20260606-cache17] inner font debug font load complete {header: "00 01 00 00 ..." | "74 74 63 66 ..."}
[KinOfficeBrowser 20260606-cache17] inner font debug pick font ...
[KinOfficeBrowser 20260606-cache17] inner font debug packaged font picker installed ...
[KinOfficeBrowser 20260606-cache17] inner font debug pick packaged font {requested: "Arial", resolved: "Arial", ...}
```

Interpretation:

- If `odttf*` XHRs are missing or have non-200 status/incorrect size, fix runtime URL/cache/service-worker behavior.
- If XHRs are 200 but `font load complete` headers are not TTF/TTC/OTF magic after decode, fix the generated font encoding or server response.
- If font streams decode correctly but picker chooses an unexpected family/face, fix alias/face selection.
- If font streams and picker choices are correct yet `Hello!` still renders as `00000←`, the bug is below the loader, likely in WASM font registration/charmap selection.

### 7. Empty `g_fonts_selection_bin` / `ASCW3` theory

This is the current best explanation for the exact symptom.

`scripts/generate-kinoffice-allfonts.py` intentionally writes a generated `AllFonts.js` catalog with real `window.__fonts_files` and `window.__fonts_infos`, but leaves the Euro-Office selection binary empty:

```js
((window.g_fonts_selection_bin = window.g_fonts_selection_bin || ''),
```

In upstream `sdkjs/common/libfont/map.js`, `CFontSelectList.Init()` only parses real selectable font entries when `window.g_fonts_selection_bin != ""`. If the binary is empty, it still appends special font entries, including `ASCW3`. Later `CApplicationFonts.Init()` asks the selection list to resolve `Arial`; when `Arial` is absent from the selection list, the default can become `ASCW3`.

`ASCW3` is a vendor special/symbol font, not a normal Latin document font. If normal text is resolved to `ASCW3`, the document can still contain correct Unicode text while the canvas draws box-like glyphs and symbol arrows. That matches the user report: `Hello world!` copies correctly, but renders visually as boxes and `!` can appear as an arrow-like symbol.

Action taken in `20260606-cache17`:

- `scripts/patch-euro-office-save-hooks.py` now injects a packaged-font picker bypass into the document editor iframe.
- The bypass overrides `AscFonts.g_fontApplication.GetFontFileWeb`, `GetFontFile`, `GetFontInfoName`, `GetFontInfoWithoutEmbed`, and load methods after `AscFonts` initializes.
- It resolves requested family names directly against `AscFonts.g_map_font_index`.
- Known generic families resolve to real packaged fonts (`sans-serif` -> `Arial`, `serif` -> `Times New Roman`, `monospace` -> `Courier New` when present).
- Unknown Latin requests fall back to packaged `Arial`/`Liberation Sans`, not `ASCW3`.
- CJK-looking names can still resolve to packaged CJK aliases, but Chinese is not the default fallback for Latin text.
- It logs `packaged font picker installed` and `pick packaged font` so the next run can prove whether `Arial` is now being selected.

This is still a runtime debug bypass, not the final elegant fix. If it works, the durable fix should be either generating a valid `g_fonts_selection_bin` or keeping an explicit Kin font-selection adapter that matches Euro-Office expectations.

Cache17 result:

- User confirmed the debug DOCX loads and copies as correct English text, but still renders as boxes.
- Console showed the app and inner editor were on `20260606-cache17`.
- Console did **not** show any `KinOfficeFont`, `inner font debug`, `packaged font picker installed`, or `pick packaged font` lines.
- Therefore the cache17 injected iframe font script either did not execute in the served frame, did not reach the adapter, or was not captured in the pasted console. Do not assume the packaged picker was actually tested by that screenshot.

Cache18 change:

- `browser_editor_adapter.js` now also performs a parent-side same-origin probe against `iframe[name="frameEditor"].contentWindow`.
- It logs `parent font probe:*` lines from the adapter itself, sets the inner `onLogPickFont`, forces `fontFilesPath`, wraps font loads, and installs the same packaged-font picker directly on `inner.AscFonts.g_fontApplication`.
- This does not rely on the injected HTML script posting messages back.
- Added empty `plugins.json` at the package root to silence the optional plugin loader 404. That 404 is not considered the font root cause.

Cache18 result:

- The parent-side probe ran and confirmed the key failure:

```text
FontPicker: Arial => ASCW3
FontPicker: Times New Roman => ASCW3
FontPicker: Courier New => ASCW3
```

- The probe also showed `hasAscFonts: true` but `hasFontFiles: false`, so the packaged picker could not install through `g_font_files`/`g_font_infos`.
- Browser stack frames still showed `sdk-all-min.js?kinOfficeBuild=20260606-cache17` while the outer and iframe HTML were cache18.
- Root cause for that stale SDK path: `documenteditor/embed/index.html` directly loaded `AllFonts.js`, `sdk-all-min.js`, and `embed/app-all.js` without the Kin cache query. RequireJS had cache18, but those direct scripts did not.

Cache19 change:

- `scripts/patch-euro-office-save-hooks.py` now cache-busts the direct `AllFonts.js`, direct `sdk-all-min.js`, and dynamic `embed/app-all.js` script loads in editor embed HTML.
- If cache19 still logs `FontPicker: Arial => ASCW3`, the next target is generating `g_fonts_selection_bin` or bypassing the picker earlier than document open.

Cache19 result:

- Direct scripts are now cache-busted, but the editor still logs `FontPicker: Arial => ASCW3`.
- The parent probe still could not install the packaged picker because the runtime is minified and does not expose the source names `g_font_files`, `g_font_infos`, `g_map_font_index`, or `g_fontApplication`.
- Static SDK inspection shows the equivalent minified symbols:
  - `AscFonts.Snc` = packaged font files
  - `AscFonts.i4a` = packaged font infos
  - `AscFonts.y0b` = font-name-to-index map
  - `AscFonts.CQ` = font application/picker
- Cache20 added support for those minified symbols and overrode minified picker methods (`Yed`, `bC`/`Wof`/`sah`, `mEc`, `vE`) when source symbols were absent.

Cache20 result:

- The parent probe proved the minified registry was reachable and the runtime picker bypass could resolve `Times New Roman` to `Times New Roman`.
- The build then produced an editor warning dialog:

```text
An error occurred during the work with the document.
Use the 'Download as' option to save the file backup copy to a drive.
```

- Console showed:

```text
Uncaught TypeError: this.mGb.FPb is not a function
at b.vE (sdk-all.js:5658:30)
at app.vE (browser_editor_adapter.js?...:402:29)
```

- Conclusion: overriding minified `app.vE` was wrong and corrupted an internal call path. Do not retry this as the main fix.
- Cache21 removes the `app.vE` override. The remaining parent-side probe is diagnostic only; the primary fix moved earlier into generated `AllFonts.js`.

Cache21 change:

- `scripts/generate-kinoffice-allfonts.py` now generates a non-empty Euro-Office v2 `g_fonts_selection_bin`.
- The generated bin contains one selectable record per packaged family/alias (`Arial`, `Calibri`, `Times New Roman`, `Courier New`, etc.) plus file-id records for style files.
- Selection records use the display family as `m_wsFontName` and the packaged `odttf10-*` file id as `m_wsFontPath`.
- This is meant to let `CFontSelectList.Init()` populate the native selection list before `CApplicationFonts.Init()` asks for Arial.
- Expected proof in console after deploy: `FontPicker: Arial => Arial` (or another packaged Latin alias), not `FontPicker: Arial => ASCW3`.

---

## Current state

- **Canvas rendering resolved in `20260606-cache22`.** Typed ASCII, imported DOCX text, font selection, and style previews render with packaged fonts instead of `ASCW3` symbol glyphs.
- **Font dropdown labels resolved in `20260606-cache25`.** Docs dropdown rows show font names (e.g. Arial, Times New Roman). Verified by user after deploy.
- `AllFonts.js` includes a non-empty `g_fonts_selection_bin` generated alongside `__fonts_files` and `__fonts_infos`.
- Font dropdown labels use three layers in `scripts/patch-euro-office-save-hooks.py`: HTML template text, runtime tile label injection when sprites are disabled, and Docs-only iframe/parent hooks.
- Inner-iframe font diagnostics remain in `scripts/patch-euro-office-save-hooks.py` and `browser_editor_adapter.js` for future debugging; they are not required for correct rendering once the selection bin is populated.

---

## Resolved hypotheses

1. **Empty `g_fonts_selection_bin` made the font picker resolve real names to `ASCW3`.** Confirmed. Fixed by generating a valid selection bin in `scripts/generate-kinoffice-allfonts.py` (cache22).
2. **Docs font dropdown labels blank despite identical vendor patches.** Confirmed. Caused by Docs `recent: 5` menu refresh with disabled sprite thumbnails; fixed in cache25 (see above).

## Hypotheses not implicated in the final fix

- XHR failures, WASM buffer bugs, XOR decode mismatch, and service worker interference were investigated but were not the root cause of the reported symptoms once the selection bin and dropdown label paths were fixed.

---

## Known unknowns

- The actual iframe base URL the SDK is using for font XHRs at runtime (the relative path `../../../../fonts/` is correct for the standard layout, but if the iframe base differs, the XHR resolves elsewhere).
- Whether the WASM engine is logging anything to the console (the engine has no obvious error path that would surface to the user).
- Whether the service worker is intercepting the requests.
- Whether the user's browser has any extensions (ad blockers, privacy tools) that might be blocking requests to `odttf10-*`.
- Whether the issue is specific to the WASM engine path (`AscFonts`) or a different code path.
- Whether the font files have been deployed with the latest changes (the deploy script does not delete, so old `000001`-named files coexist with new `odttf10-000001`-named files; both are valid TTF but only the `odttf10-` ones are referenced by `AllFonts.js`).

---

## Files in the directory that may need attention

- `repository/Applications/Office/kinoffice_common/vendor/kin-office/packages/kin-office/7/fonts/` contains:
  - `odttf10-000001`..`odttf10-000022` (current, XOR-encoded v10, what AllFonts.js references)
  - `odttf9-000001`..`odttf9-000020` (older v9 encoding)
  - `raw8-000001`..`raw8-000020` (no encoding)
  - `ttf7-000001`..`ttf7-000020` (older v7)
  - `000001`..`000048` (legacy unprefixed names; some are 0-byte stubs at 33-40KB)

The deploy script does not delete legacy files. The browser XHR for `odttf10-000001` should hit the correct v10 file.

---

## Glossary

- **AllFonts.js** — generated catalog. Lists which font names are available, which odttf10 file backs each, and which face index to use.
- **CFontFileLoader** — per-file loader. `LoadFontAsync(basePath, cb)` does `XHR(basePath + fileId)`, XOR-decodes the first 32 bytes, and stores the buffer in `g_fonts_streams[stream_index]`.
- **CFontInfo** — per-family record. Holds `indexR/I/B/BI` (file indexes) and `faceIndexR/I/B/BI`. `LoadFont()` calls into the WASM engine to register the font with the engine.
- **g_fontApplication** — `window.AscFonts.g_fontApplication`. The font manager (map.js:3096). Has `LoadFont(name, ...)`, `GetFontFileWeb(name, style)`, etc.
- **g_font_loader** — `AscCommon.g_font_loader` (GlobalLoaders). The file loader registry. `fontFilesPath` is the relative base path used for XHR.
- **g_font_files** — `window.__fonts_files` is assigned to `AscFonts.g_font_files` (line 720 of source Externals.js). Array of `CFontFileLoader` instances.
- **g_font_infos** — `window.__fonts_infos` is iterated at line 622-650 of source Externals.js to build `g_map_font_index` and `g_font_infos`.
- **odttf10-** — filename prefix used by the current generator. "odttf" = obfuscated TTF; "10" = XOR key version.
- **WASM engine** — `sdkjs/common/libfont/engine/fonts.wasm` (and `fonts.js`, `fonts_ie.js`, `fonts_native.js`). The actual glyph rasterizer. Receives buffers from `g_fonts_streams` and renders glyphs.
- **window.onLogPickFont** — vendor-provided hook fired by the font picker (`map.js:2933`, `character.js:154`). Receives a string like `"FontPicker: <requested> => <picked>"`. Not used in the current build.
- **window.__all_fonts_js_version__** — set by `AllFonts.js` (currently `2`).
