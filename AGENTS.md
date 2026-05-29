# Project: kin-office — Kin Office for Kin

## Goal

Run Kin Office editing directly in the browser with Euro-Office source-aligned web assets and direct Kin filesystem integration. There is **no Docker runtime, Document Server, direct connector, Nextcloud, or OIDC**.

## Important operational rules

- Do not reintroduce Docker, `/ds/`, `/direct/`, Document Server, or the old Python connector unless the user explicitly asks for a rollback.
- Use `scripts/fetch-euro-office-browser-sdk.sh` to refresh Euro-Office source snapshots and generated Kin Office browser assets; do not hand-edit downloaded vendor files.
- Keep Kin file persistence in `office_app.js`: read via `GET /file/{volume}/…`, save via `write_binary` or chunked upload, then read back to verify.
- `deploy.sh` installs Kin apps/static assets only. `make-debian.sh` packages apps/assets only and must not depend on Docker.
- Kin Office must run inside Kin. Do **not** start standalone static servers or browser-smoke-test `kinoffice_common` outside Kin; that cannot validate Kin APIs, file dialogs, app windows, save, autosave, or load behavior.
- **Never hardcode hostnames** — use `window.location.origin`, `/etc/kin/config.ini` `[KinCore] hostname=`, `.config.ini`, or `X-Forwarded-*` headers.

## Architecture

```
Kin workspace (kinoffice_* apps)
        |
        +-- /api/file/*  (read/write Kin paths)
        |
        +-- iframe --> kinoffice_common/browser_editor.html
                          |
                          +-- Euro-Office web-apps/sdkjs
                          +-- x2t assets
```

## Components

### Kin apps

- `repository/Applications/Office/kinoffice_docs/` (`Docs`)
- `repository/Applications/Office/kinoffice_sheets/` (`Sheets`)
- `repository/Applications/Office/kinoffice_slides/` (`Slides`)
- `repository/Applications/Office/kinoffice_common/office_app.js`
- `repository/Applications/Office/kinoffice_common/browser_editor.html`
- `repository/Applications/Office/kinoffice_common/browser_editor_adapter.js`
- `repository/Applications/Office/kinoffice_common/vendor/kin-office/`

Each app uses `manifest.json` → `main.js` → `kin.classes.Window` + `app.js` (see Kin `docs/how_to_write_kinapp.md`).

### Deploy

- `deploy.sh` — dev: `.config.ini` + Kin build path; `--deploy-mode`: installs to `/usr/lib/kin/repository/Applications`
- `make-debian.sh` — package apps, docs, scripts, and vendored browser assets
- `scripts/fetch-euro-office-browser-sdk.sh` — pinned Euro-Office source/artifact fetcher
- `scripts/patch-euro-office-save-hooks.py` — save handler patch applied before generated assets are used

## Kin file I/O (save path)

Editor state is not the same as written to `Home:`. Persistence is explicit: the Kin app requests an editor export, writes returned bytes to Kin, and verifies by reading the path back.

| Size | API | Payload |
|------|-----|---------|
| &lt; 16 KiB | `POST /api/file/write_binary` | `{ "path": "Home:…/file.docx", "data_base64": "…" }` |
| ≥ 16 KiB | `upload_begin` / `upload_chunk` / `upload_finish` | Raw bytes per chunk |

- **Open:** `GET /file/{volume}/…` (binary route from Kin path).
- **Editor:** iframe `browser_editor.html` receives bytes and returns exported bytes via `postMessage`.
- **Sidecar:** `POST /api/file/write` with text body for `Home:file.docx.info`.
- **Guards:** `validateOfficeBytes` (ZIP header, anti–blank-template); readback length check after write.

If saves appear lost: check browser console for export/write/readback errors, confirm File → Save As set a `Home:` path, and see [specs/architecture.md](specs/architecture.md).

## Commands

```bash
./scripts/fetch-euro-office-browser-sdk.sh
./deploy.sh                    # dev: needs .config.ini KIN_BUILD_PATH
sudo ./deploy.sh --deploy-mode # production paths
./build-apps.sh

sudo apt install ./dist/kin-office_*.deb
```

## Configuration

**Dev** — `.config.ini`:

```ini
KIN_BUILD_PATH=/path/to/kin/build
KIN_PUBLIC_HOST=10.0.0.1
```

**Packaged** — `deploy.sh --deploy-mode` copies apps into the runtime Kin repository. No service is installed.

## Kin OS

Kin repo: `../kin/` (read-only unless asked).

## Specs

- [specs/README.md](specs/README.md)
- [specs/architecture.md](specs/architecture.md)
- [specs/wbs/01-kinoffice-kinfs.md](specs/wbs/01-kinoffice-kinfs.md)

## Legacy data

Older installs may still have Docker volumes or a `kin-office.service` from previous Document Server builds. This branch no longer references them; remove manually only if desired.
