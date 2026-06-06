# Kin Office Architecture

This spec describes how Kin Office works inside Kin for Docs, Sheets, and Slides.

## Goal

Kin Office opens and saves Office documents directly in the browser, inside Kin:

```text
DOCX -> Docs
XLSX -> Sheets
PPTX -> Slides
```

There is no Docker runtime, Document Server, direct connector, Nextcloud, OIDC, or standalone static server. Kin Office is a set of Kin apps plus shared browser runtime assets.

## Component Map

```text
repository/Applications/Office/
  kinoffice_docs/
    manifest.json
    main.js
    app.js
  kinoffice_sheets/
    manifest.json
    main.js
    app.js
  kinoffice_slides/
    manifest.json
    main.js
    app.js
  kinoffice_common/
    office_app.js
    browser_editor.html
    browser_editor_adapter.js
    kinoffice-shell.css
    vendor/kin-office/

commands/kinoffice.cmd/
  main.c
  templates.c
  templates.h
```

Each app uses the Kin app pattern:

```text
manifest.json -> main.js -> kin.classes.Window -> app.js
```

The app-specific `app.js` files are thin wrappers that call `bootstrapKinOfficeApp()` from `kinoffice_common/office_app.js` with the right defaults:

```text
Docs   -> Document.docx -> docx
Sheets -> Spreadsheet.xlsx -> xlsx
Slides -> Presentation.pptx -> pptx
```

## Runtime Architecture

```text
Kin workspace
  |
  +-- kinoffice_docs / kinoffice_sheets / kinoffice_slides
        |
        +-- office_app.js
              |
              +-- POST /api/file/raw                        open existing file (Kin path)
              +-- POST /api/commands/kinoffice           blank templates
              +-- POST /api/file/write_binary            small saves
              +-- POST /api/file/upload_*                large saves
              |
              +-- iframe: browser_editor.html
                    |
                    +-- browser_editor_adapter.js
                    +-- Euro-Office DocsAPI.DocEditor
                    +-- x2t.wasm
                    +-- sdkjs/{word,cell,slide}/sdk-all-min.js
```

All URL construction must use Kin-relative paths and `window.location.origin`. Do not hardcode hostnames.

## Opening Existing Files

`office_app.js` owns file reads:

1. Parse Kin paths like `Home:Documents/File.docx`.
2. Read bytes from `POST /api/file/raw` with JSON `{ "path": "Home:Documents/File.docx" }`.
3. Validate the result is an OOXML ZIP by checking the local-file header.
4. Send bytes to `browser_editor.html` through `postMessage`.
5. `browser_editor_adapter.js` converts OOXML to Euro-Office internal bin through browser `x2t.wasm`.
6. The adapter opens the document with `editor.openDocument({ buffer })`.

Important open-path details:

- `office_app.js` never gives Euro-Office a remote document URL for local Kin files.
- The adapter posts local document metadata first, waits for inner editor permissions to initialize, sets `api.ServerIdWaitComplete = true`, and then calls `editor.openDocument({ buffer })`.
- `editor.openDocument({ buffer })` is the supported binary open route. It posts `openDocumentFromBinary` to the inner editor, which calls `asc_openDocumentFromBytes(...)`.
- Do not call `main.api.onEndLoadFile(...)` directly for normal opens. That bypasses the expected gateway path and can leave the editor stuck at `Loading document`.
- x2t open conversion uses explicit `m_nFormatFrom` and `m_nFormatTo` values for DOCX/XLSX/PPTX to internal canvas formats; do not rely on `.bin` extension inference.
- x2t no-base64 output can already be a valid `DOCY/XLSY/PPTY` byte stream. The adapter must preserve signed internal payloads and only wrap raw serializer bytes.

The editor iframe is expected to reply with:

```text
shellReady
ready
documentStateChange
error
```

Open currently times out after 30 seconds if the editor never becomes ready.

## Opening Blank Documents

`kinoffice.cmd` supports:

```text
action=template type=docx|xlsx|pptx
```

`office_app.js` calls:

```text
POST /api/commands/kinoffice
```

and receives base64 template bytes. The command also contains placeholders for `open`, `savefile`, and `downloadas`, but current Kin Office persistence does not rely on those actions for normal editing.

## Saving

Kin owns persistence. Euro-Office is used for editing and serialization, not as a server.

Save flow:

1. User triggers Save, Save As, `Ctrl+S`, or editor save UI.
2. Patched Euro-Office UI calls `window.KinOfficeDirectSave()` or adapter override of `api.asc_Save()`.
3. `browser_editor.html` posts `saveRequested`.
4. `office_app.js` requests `export` from the iframe.
5. `browser_editor_adapter.js` serializes the current editor state with source-level/native Euro-Office APIs.
6. The adapter converts internal bin back to DOCX/XLSX/PPTX with `x2t.wasm`.
7. `office_app.js` validates ZIP bytes.
8. Small files use `POST /api/file/write_binary`.
9. Larger files use `upload_begin`, `upload_chunk`, and `upload_finish`.
10. `office_app.js` reads the saved path back and checks length to verify the write.
11. Directory views are refreshed.

Current write threshold:

```text
16 KiB
```

Files at or above that threshold use chunked upload.

Save/export details:

- Patched Euro-Office UI routes toolbar save and keyboard save to `window.KinOfficeDirectSave`; the adapter also overrides `api.asc_Save()` as a fallback.
- The adapter tries `api.getFileAsFromChanges()`, then `api.asc_nativeGetFile3()`, then `api.asc_nativeGetFileData()` with a temporary `native.Save_End` capture.
- Native serializers may return either a complete `DOCY/XLSY/PPTY` payload or raw data plus a header. Complete internal payloads are passed through unchanged; raw data is wrapped with the correct header before x2t export.
- Upstream `downloadAs()` and server callbacks are not used for Kin persistence.
- `office_app.js` treats save as successful only after writing bytes to Kin and reading the saved path back to verify length.

## App-Specific Notes

### Docs

- Uses Euro-Office document editor.
- `documentType` is `word`.
- Default file is `Document.docx`.
- Internal bin prefix is `DOCY`.

### Sheets

- Uses Euro-Office spreadsheet editor.
- `documentType` is `cell`.
- Default file is `Spreadsheet.xlsx`.
- Internal bin prefix is `XLSY`.

### Slides

- Uses Euro-Office presentation editor.
- `documentType` is `slide`.
- Default file is `Presentation.pptx`.
- Internal bin prefix is `PPTY`.

Slides are especially useful for font debugging because upstream default placeholders may request CJK font aliases.

## Kin APIs Used

| Operation | API |
| --- | --- |
| Open existing file | `POST /api/file/raw` with `{ "path": "Volume:..." }` |
| Blank template | `POST /api/commands/kinoffice` |
| Save small file | `POST /api/file/write_binary` |
| Save large file | `POST /api/file/upload_begin` |
| Save large file chunks | `POST /api/file/upload_chunk` |
| Finish large save | `POST /api/file/upload_finish` |
| Abort failed upload | `POST /api/file/upload_abort` |

All requests use same-origin credentials.

## Deployment

Development deploy:

```bash
./deploy.sh --to-kin
```

Package/deploy-mode install:

```bash
sudo ./deploy.sh --deploy-mode
```

`deploy.sh --to-kin` copies only:

```text
kinoffice_common
kinoffice_docs
kinoffice_sheets
kinoffice_slides
commands/kinoffice
```

It does not delete unrelated Kin paths and does not reload Kin nginx.

## Verification Checklist

After runtime or save changes:

```bash
node --check repository/Applications/Office/kinoffice_common/browser_editor_adapter.js
node --check repository/Applications/Office/kinoffice_common/office_app.js
node --check repository/Applications/Office/kinoffice_docs/app.js
node --check repository/Applications/Office/kinoffice_sheets/app.js
node --check repository/Applications/Office/kinoffice_slides/app.js
python3 -m py_compile scripts/generate-kinoffice-allfonts.py scripts/patch-euro-office-save-hooks.py
./deploy.sh --to-kin
```

Manual test order:

1. Open Docs blank document.
2. Type text, Save As, reopen.
3. Edit reopened document, Save, reopen.
4. Repeat for Sheets.
5. Repeat for Slides.
6. Watch console for `KinOfficeBrowser`, `KinOfficeEditorShell`, and `kinoffice_*` logs.
7. Confirm there are no requests to `/ds/`, `/direct/`, Document Server, Nextcloud, or any hardcoded hostname.

## Known Issues and Work Items

The `20260604-cache11` font-catalog attempt did not fix the visible issue. It mapped CJK aliases such as `等线` to the Simplified Chinese face in `NotoSansCJK-*.ttc` because the earlier `DroidSansFallbackFull.ttf` mapping had CJK coverage but no normal Latin alphabet coverage. User testing reported no change after deployment, so do not repeat this as the primary fix without new evidence.

`20260604-cache12` tried to change the debug strategy by making Docs open `kinoffice_common/debug/test.docx` as its default document. User testing still showed `Document.docx`, a blank page, Chinese default font, and tofu boxes, so the debug DOCX did not actually become the opened session.

`20260604-cache13` removes the bottom-left build overlay, routes those messages to `console.log`, and forces the Docs debug default even when Kin passes a `path` or `kin_open_path` query parameter. Console logs should show launch query data, debug DOCX fetch URL/status/byte count, posted open payload, and adapter `createInstance` options.

User testing after `cache13` still showed the same visual result, but the console changed the diagnosis: the outer Docs app was still `office_app.js?kinOfficeBuild=20260604-cache11`, opened `Document.docx`, and posted `isNew=true` with `bytes=0`. The debug DOCX had still not actually entered the session.

`20260604-cache14` changes the Docs launcher to open a fresh wrapper filename, `app_debug_20260604_cache14.js`, and logs `kinoffice_docs launcher` with the requested entry and query. This is specifically to bypass stale caching of `kinoffice_docs/app.js`.

After the next test, the user clarified the visible boxes were typed into the still-blank document; `test.docx` had not rendered. The console still showed `kin_repo_entry=app.js` and no `kinoffice_docs launcher` log, so the running Kin workspace was still using stale `kinoffice_docs` app metadata. The Docs manifest is now version `21` and points directly at `app_debug_20260604_cache14.js`; reload Kin workspace/app metadata before interpreting another visual test.

Kin loads direct manifest entries as classic scripts. The first `app_debug_20260604_cache14.js` direct-entry attempt failed with `Cannot use import statement outside a module`; the debug wrapper and fallback `app.js` now use dynamic `import()` to load `office_app.js`.

The same console run showed `sdkjs/common/Images/fonts_thumbnail.png.bin` returning 404. `scripts/generate-kinoffice-font-thumbnail-bins.py` generates transparent fallback sprite binaries so the font combobox no longer parses a 404 body as sprite data. This is a font-preview/runtime-validity fix, not proof that document canvas text is fixed.

After the debug DOCX loaded successfully, boxes remained. The console still showed inner editor stack frames from `sdk-all-min.js?kinOfficeBuild=20260604-cache11`; Euro-Office `api.js` hardcoded the inner iframe query as `?_dc=0`. `20260604-cache15` patches that API-generated iframe query to `?_dc=<cache id>` and moves the manifest to a cache15-named debug wrapper.

User testing after `cache15` proved the test DOCX path had finally taken effect: the title became `Debug Arial Test.docx`, the toolbar showed Arial, and the known document content appeared, but still as boxes. The same console run still referenced cache11 `sdk-all-min.js`, so `20260604-cache16` now purges Euro-Office service-worker registrations and Cache Storage entries named `document_editor_static_*` / `document_editor_dynamic_*` before loading the API. This is a cache/runtime diagnosis, not another attempt to fix `AllFonts.js`.

If `cache16` still renders boxes after the console shows current cache16 inner editor scripts, the next debugging layer is the actual inner editor font engine: `AscFonts`, loaded font streams, decoded headers, and selected face indexes.

The debug file comes from `assets/test.docx`, uses Arial, and contains readable English text. The result should split the problem:

- If `test.docx` renders correctly, focus on blank templates and internal-bin defaults.
- If `test.docx` still renders as boxes, focus on x2t conversion, text encoding in the internal document, or whether Euro-Office canvas is actually receiving usable font streams.

Useful future debugging checks:

- Confirm `AscFonts.g_map_font_index` maps requested family names to the expected font indexes.
- Confirm every loaded font file decodes to a valid TTF/OTF/TTC stream after Euro-Office's XOR decode.
- Confirm the engine is selecting the expected family/face for placeholder/document text.
- Ensure English blank templates are actually English if user-visible default placeholders should not be Chinese.

Do not try to solve document canvas tofu by editing CSS; it is a Euro-Office font-engine issue.
