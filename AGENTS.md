# Project: kin-office — OnlyOffice Direct for Kin

## Goal

Run OnlyOffice Document Server in Docker and expose it through Kin nginx at `https://<host>/kin-office/`, with **direct Kin filesystem** integration (no Nextcloud, no OIDC).

## Important operational rules

- **NEVER delete existing Docker volumes** unless the user explicitly authorizes it.
- **DO NOT modify docker-compose.yml** to remove the `onlyoffice` service — it is the Document Server.
- **deploy.sh** — Bootstrap: compose up, nginx `/ds/` + `/direct/`, DS safeUrls. Keep edits focused.
- **Recreate containers only, not volumes** — `docker compose rm -f <service>` then `up -d`, never `docker compose down -v`.
- **After container changes, reload Kin nginx** when using dev Kin build (`deploy.sh` reloads automatically when Kin nginx is running).
- **Never hardcode hostnames** — use `window.location.origin`, `/etc/kin/config.ini` `[KinCore] hostname=`, `.config.ini`, or `X-Forwarded-*` headers.

## Architecture

```
Kin workspace (kinonlyoffice_* apps)
        |
        +-- /api/file/*  (read/write Kin paths)
        |
        +-- iframe --> /kin-office/direct/editor
                          |
                          v
                   direct-connector (sessions, callback)
                          |
                          v
                   OnlyOffice DS (/kin-office/ds/)
```

## Components

### Docker

- `docker-compose.yml` — `onlyoffice` + `onlyoffice-direct`
- `direct-connector/` — `server.py` (download/callback protocol), `editor.html`

### Kin apps

- `repository/Applications/Office/kinonlyoffice_documents/`
- `repository/Applications/Office/kinonlyoffice_spreadsheets/`
- `repository/Applications/Office/kinonlyoffice_presentations/`
- `repository/Applications/Office/kinonlyoffice_common/office_app.js`

Each app uses `manifest.json` → `main.js` → `kin.classes.Window` + `app.js` (see Kin `docs/how_to_write_kinapp.md`).

### Deploy

- `deploy.sh` — dev: `.config.ini` + Kin build nginx module; `--deploy-mode`: `/etc/kin/config.ini` + `/etc/nginx/kin-modules/`
- `kin-office-wrapper.sh` / `kin-office.service` — packaged start

## Direct connector API (summary)

| Endpoint | Purpose |
|----------|---------|
| `POST /direct/api/session` | Create/join session (optional `data_base64`, `path`) |
| `GET /direct/api/session/{id}/config` | Editor + DS config |
| `POST /direct/callback/{id}` | Document Server save callback |
| `GET /direct/download/{id}/…` | Document bytes for DS |

Kin apps persist to Kin after callback via `syncDirectAutosaveToKin` in `office_app.js`.

## Commands

```bash
docker compose up -d --build
./deploy.sh                    # dev: needs .config.ini KIN_BUILD_PATH
./deploy.sh --deploy-mode      # production paths
./build-apps.sh

sudo apt install ./dist/kin-office_*.deb
sudo systemctl restart kin-office
```

## Configuration

**Dev** — `.config.ini`:

```ini
KIN_BUILD_PATH=/path/to/kin/build
KIN_PUBLIC_HOST=10.0.0.1
```

**Packaged** — `[KinCore] hostname=` in `/etc/kin/config.ini`; `deploy.sh --deploy-mode` writes nginx module.

## Kin OS

Kin repo: `../kin/` (read-only unless asked).

## Specs

- [specs/README.md](specs/README.md)
- [specs/architecture.md](specs/architecture.md)
- [specs/wbs/01-onlyoffice-direct-kinfs.md](specs/wbs/01-onlyoffice-direct-kinfs.md)

## Legacy data

Older installs may still have a `nextcloud_data` Docker volume. Compose no longer references it; remove manually if desired: `docker volume rm <project>_nextcloud_data`.
