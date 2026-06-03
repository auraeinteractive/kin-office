# Project: kin-office — Kin Office for Kin

## Goal

Run Kin Office editing directly in the browser with Euro-Office browser SDK assets and direct Kin filesystem integration. There is **no Docker runtime, Document Server, direct connector, Nextcloud, or OIDC**.

## Important operational rules

- Do not reintroduce Docker, `/ds/`, `/direct/`, Document Server, or the old Python connector unless the user explicitly asks for a rollback.
- Use `scripts/fetch-euro-office-browser-sdk.sh` and `scripts/build-euro-office-browser-packages.sh` to refresh Euro-Office browser runtime assets; do not hand-edit downloaded vendor files.
- Keep Kin file persistence in `office_app.js`: read via `GET /file/{volume}/…`, save via `write_binary` or chunked upload, blank templates via `POST /api/commands/kinoffice`.
- `deploy.sh` installs `kinoffice_*` apps and the `kinoffice` Kin command into the Kin build (not part of default Kin).
- Kin Office must run inside Kin. Do **not** start standalone static servers outside Kin.
- **Never hardcode hostnames** — use `window.location.origin`, `/etc/kin/config.ini` `[KinCore] hostname=`, `.config.ini`, or `X-Forwarded-*` headers.

## Architecture

```
Kin workspace (kinoffice_* apps)
        |
        +-- GET /file/{volume}/…           (open)
        +-- POST /api/file/write_binary    (save)
        +-- POST /api/commands/kinoffice   (blank templates)
        |
        +-- iframe --> kinoffice_common/browser_editor.html
                          |
                          +-- editor_bridge.js + Euro-Office DocsAPI (desktop mode)
                          +-- vendor/kin-office/packages/kin-office/7/{web-apps,sdkjs}
```

## Components

### Kin apps

- `repository/Applications/Office/kinoffice_docs/` (`Docs`)
- `repository/Applications/Office/kinoffice_sheets/` (`Sheets`)
- `repository/Applications/Office/kinoffice_slides/` (`Slides`)
- `repository/Applications/Office/kinoffice_common/office_app.js`
- `repository/Applications/Office/kinoffice_common/browser_editor.html`
- `repository/Applications/Office/kinoffice_common/editor_bridge.js`
- `repository/Applications/Office/kinoffice_common/vendor/kin-office/`

### Kin command (installed by kin-office package)

- `commands/kinoffice.cmd/` → `kinoffice` binary installed to `$KIN_BUILD_PATH/commands/kinoffice` (dev) or `/usr/lib/kin/commands/kinoffice` (packaged)
- `action=template type=docx|xlsx|pptx` — returns minimal OOXML bytes as base64 for new documents

Each app uses `manifest.json` → `main.js` → `kin.classes.Window` + `app.js` (see Kin `docs/how_to_write_kinapp.md`).

### Build scripts

- `scripts/fetch-euro-office-browser-sdk.sh` — pinned Euro-Office source snapshots
- `scripts/build-euro-office-browser-packages.sh` — web-apps + sdk-all-min.js bundles
- `scripts/build-kinoffice-cmd.sh` — template command binary
- `scripts/patch-euro-office-save-hooks.py` — save button → Kin-owned save path

## Kin file I/O

| Operation | API |
|-----------|-----|
| Open | `GET /file/{volume}/…` |
| Save (&lt; 16 KiB) | `POST /api/file/write_binary` |
| Save (≥ 16 KiB) | chunked `upload_*` |
| Blank template | `POST /api/commands/kinoffice` with `action=template&type=docx` |

Editor export uses Euro-Office `saveLogicDocumentToZip` in the browser (frontend only). After write, `office_app.js` readbacks the path and checks length + ZIP header.

## Commands

```bash
./scripts/fetch-euro-office-browser-sdk.sh
./scripts/build-euro-office-browser-packages.sh
./scripts/build-kinoffice-cmd.sh
./deploy.sh --to-kin
sudo ./deploy.sh --deploy-mode
./build-apps.sh
```

## Configuration

**Dev** — `.config.ini`:

```ini
KIN_BUILD_PATH=/path/to/kin/build
```

## Kin OS

Kin repo: `../kin/`. File format bindings use `kinoffice_docs`, `kinoffice_sheets`, `kinoffice_slides`.
