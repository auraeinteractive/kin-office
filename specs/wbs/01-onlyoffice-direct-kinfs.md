# WBS: OnlyOffice Direct + KinFS

## Goal

Edit `docx` / `xlsx` / `pptx` on Kin paths (`Home:`, `Mountlist:` volumes) with fast open, save, and autosave. No Nextcloud, OIDC, or WebDAV bridge.

## Architecture

- Kin apps: `repository/Applications/Office/kinonlyoffice_*` + `kinonlyoffice_common/office_app.js`
- Connector: `direct-connector/server.py`
- Proxy: `deploy.sh` writes `/kin-office/ds/` and `/kin-office/direct/` only

## Kin persistence (reference)

| Step | Where |
|------|--------|
| DS callback stores bytes | `direct-connector` in-memory session |
| App pulls bytes | `GET /direct/api/session/{id}/content` |
| App writes Kin path | `POST /api/file/write_binary` (&lt; 16 KiB) or upload API (≥ 16 KiB) |
| Session hint on disk | `POST /api/file/write` → `path.info` |

Details: [architecture.md](../architecture.md).

## Tasks

### Phase 1 — Runtime

- [x] Single `docker-compose.yml`: `onlyoffice` + `onlyoffice-direct`
- [x] Slim `deploy.sh`: health checks, nginx module, DS `local.json` safeUrls
- [x] `kin-office-wrapper.sh`: start two services, run `deploy.sh --deploy-mode`

### Phase 2 — Kin apps

- [x] Direct iframe editor only (no Nextcloud login iframe)
- [x] File → Open / Save / Save As via Kin file dialog (`Mountlist:`)
- [x] `.info` sidecar: `path.docx.info` with `kinOnlyOffice.sessionId`
- [x] Autosave: `documentStateChange` + adaptive poll (500ms when `savePending`, 4s idle)

### Phase 3 — Safety

- [x] `validateOfficeBytes`: refuse blank template overwrite of real files
- [x] Direct save via `POST /api/file/write_binary` (no `.kinpart` + `move`)
- [x] Large files via chunked `upload_*` API (≥ 16 KiB)
- [x] Post-write readback length check on target path
- [x] User-visible Save failed dialog when callback/version does not advance

## Acceptance tests

1. New document: Documents app opens blank editor without login.
2. Open `Home:…/file.docx`: content matches; `.info` written.
3. Autosave: edit with path set; file on disk updates within a few seconds (mtime/size).
4. Save / Save As: manual menu writes correct bytes; reopen shows edits.
5. `curl -fsS http://127.0.0.1:8000/direct/health` and DS `api.js` on `:5003`.
6. Packaged: `systemctl restart kin-office` — no `nextcloud` container.

## Related files

- `repository/Applications/Office/kinonlyoffice_common/office_app.js`
- `direct-connector/server.py`, `editor.html`
- `deploy.sh`, `docker-compose.yml`
