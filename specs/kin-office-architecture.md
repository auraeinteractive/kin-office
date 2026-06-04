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
              +-- GET /file/{volume}/...                 open existing file
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
2. Read bytes from `GET /file/{volume}/...` with cache-busting query params.
3. Validate the result is an OOXML ZIP by checking the local-file header.
4. Send bytes to `browser_editor.html` through `postMessage`.
5. `browser_editor_adapter.js` converts OOXML to Euro-Office internal bin through browser `x2t.wasm`.
6. The adapter opens the document with `editor.openDocument({ buffer })`.

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
| Open existing file | `GET /file/{volume}/...` |
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

Fonts remain unresolved. The current cache10 implementation generates ODTTF-obfuscated local font files and maps CJK aliases to a CJK-capable TTF, but user testing still shows square/tofu glyphs in editor canvas text.

Likely next debugging areas:

- Confirm `AscFonts.g_map_font_index` maps requested family names to the expected font indexes.
- Confirm every loaded font file decodes to a valid TTF/OTF stream after Euro-Office's XOR decode.
- Confirm the engine is selecting the expected family/face for placeholder/document text.
- Consider switching CJK aliases from `DroidSansFallbackFull.ttf` to the correct face of `NotoSansCJK-Regular.ttc` if the engine handles TTC face indexes correctly.
- Ensure English blank templates are actually English if user-visible default placeholders should not be Chinese.

Do not try to solve document canvas tofu by editing CSS; it is a Euro-Office font-engine issue.
