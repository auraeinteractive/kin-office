# WBS: Kin Office + KinFS

## Goal

Edit `docx` / `xlsx` / `pptx` on Kin paths (`Home:`, `Mountlist:` volumes) with browser-local Kin Office assets. No Nextcloud, OIDC, WebDAV bridge, Docker, direct connector, or Document Server.

## Architecture

- Kin apps: `repository/Applications/Office/kinoffice_docs`, `kinoffice_sheets`, `kinoffice_slides`
- Kin file owner: `kinoffice_common/office_app.js`
- Editor shell: `kinoffice_common/browser_editor.html`
- Browser adapter: `kinoffice_common/browser_editor_adapter.js`
- Vendored assets: `kinoffice_common/vendor/kin-office/`

## Kin persistence (reference)

| Step | Where |
|------|--------|
| App reads bytes | `GET /file/{volume}/...` |
| App opens editor | `postMessage` to `browser_editor.html` |
| App exports bytes | `postMessage` export request from local editor |
| App writes Kin path | `POST /api/file/write_binary` (&lt; 16 KiB) or upload API (≥ 16 KiB) |
| Sidecar hint on disk | `POST /api/file/write` → `path.info` |

Details: [architecture.md](../architecture.md).

## Tasks

### Phase 1 — Runtime removal

- [x] Remove `docker-compose.yml`, `direct-connector`, systemd service, and wrapper runtime.
- [x] Make `deploy.sh` install Kin apps only.
- [x] Make Debian package depend on `kin`, not Docker.

### Phase 2 — Kin apps

- [x] Browser-local iframe editor only (no server editor iframe)
- [x] File → Open / Save / Save As via Kin file dialog (`Mountlist:`)
- [x] `.info` sidecar: `path.docx.info`
- [x] Explicit save: Ctrl+S / File → Save / editor save button request export and write to Kin

### Phase 3 — Safety

- [x] `validateOfficeBytes`: refuse blank template overwrite of real files
- [x] Direct Kin save via `POST /api/file/write_binary` (no `.kinpart` + `move`)
- [x] Large files via chunked `upload_*` API (≥ 16 KiB)
- [x] Post-write readback length check on target path
- [x] User-visible Save failed dialog when export/write/readback fails

## Acceptance tests

1. New document: Documents app opens blank editor without login.
2. Open `Home:…/file.docx`: content matches; `.info` written.
3. Edit with path set; Ctrl+S writes the file on disk (mtime/size).
4. Save / Save As: manual menu writes correct bytes; reopen shows edits.
5. Packaged: installing the `.deb` copies apps and does not install/start `kin-office.service`.
6. Static assets exist under `kinoffice_common/vendor/kin-office/`.

## Related files

- `repository/Applications/Office/kinoffice_common/office_app.js`
- `repository/Applications/Office/kinoffice_common/browser_editor.html`
- `repository/Applications/Office/kinoffice_common/browser_editor_adapter.js`
- `scripts/fetch-euro-office-browser-sdk.sh`
- `scripts/patch-euro-office-save-hooks.py`
- `deploy.sh`, `make-debian.sh`
