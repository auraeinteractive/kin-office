# Project: Nextcloud - Self-Hosted Nextcloud with Kin Integration

## Goal
Set up Nextcloud to run in Docker and expose it through Kin's nginx reverse proxy at `https://<host>:9219/kin-office/`, with integration into Kin OS.

## Important Operational Rules

- **NEVER delete existing config or volumes** unless strictly asking and getting authority from the user!
- Always assume existing data is precious and should be preserved
- When in doubt, ask before making destructive changes
- **DO NOT modify docker-compose.yml** - The onlyoffice container is required for the DocumentServer that the Nextcloud OnlyOffice app connects to
- **deploy.sh** - Keep changes focused on bootstrap (compose, OIDC, nginx snippets). Do not replace the OnlyOffice **container** with app-store hacks; the Document Server still comes from Docker. Prefer small, reviewed edits over drive-by refactors.
- **OnlyOffice app** - The Nextcloud app itself is installed from Nextcloud's App Store (`/settings/apps`), not via docker or deploy.sh
- **Keep docker-compose.yml and .config.ini in sync** - Changing NEXTCLOUD_ADMIN_PASSWORD in one requires changing in both, or Nextcloud will be stuck in retry loop on restart
- **Recreate containers only, not volumes** - Use `docker compose rm -f <service>` followed by `docker compose up -d <service>`, never `docker compose down -v`
- **After container changes, reload Kin nginx** - `deploy.sh` writes `../kin/build/nginx/server.d/kin-office.conf` and reloads Kin nginx when it is running
- **When Nextcloud shows "Login is invalid because files already exist"** - The admin password in docker-compose.yml doesn't match existing data; either use the original password or accept that data may need re-setup
- **kinnextcloud app (admin)** - Requires a fresh browser session (incognito/private window) to login as admin, because OIDC remembers the user session
- **Never hardcode hostnames** - Do not embed production or customer FQDNs in source, nginx, or app code. Use `window.location.origin`, `[KinCore] hostname=` from `/etc/kin/config.ini`, `.config.ini` overrides, or deploy-time env vars (`KIN_OIDC_HOST`, `KIN_PUBLIC_BASE_URL`, proxy `X-Forwarded-*` headers).
- **ONLYOFFICE service worker** - Do not use `^~` on `${prefix}/ds/` in nginx: it prevents the regex location that serves `nginx/onlyoffice-noop-sw.js` instead of Document Server’s broken `document_editor_service_worker.js`. After deploy, users may need to unregister old workers once (browser Application → Service Workers).

## Technical Decisions

- **Shadow DOM** - Kin apps use Shadow DOM (not light DOM) to encapsulate styles and enable proper web component development
- No `prototype/` folder - all code goes directly into `repository/Applications/`

## Architecture
```
Kin Workspace (Browser)
    |
    v
kinnextcloud app (iframe) -- postMessage --> kin-bridge.js (injected)
    |                                               |
    v                                               v
Kin nginx (:9219/kin-office) <------------------- Nextcloud
         |
         +-- /kin-office/ds/ ----> OnlyOffice
```

## Components

### Docker Setup
- `docker-compose.yml` - Nextcloud + legacy Nginx + OnlyOffice services; deploy starts Nextcloud and OnlyOffice for Kin nginx integration
- `nginx/conf.d/nextcloud.conf` - Legacy standalone Nginx config with header overrides for iframe embedding
- `nginx/certs/` - Legacy standalone Nginx self-signed certificate
- `nginx/kin-bridge.js` - JavaScript bridge injected into Nextcloud pages

### Kin Apps
- Each app uses **`manifest.json` `entry`: `main.js`**, which opens the UI via **`kin.classes.Window`** and a view script (**`app.js`**) under **`/application.html`** (see main Kin repo `docs/how_to_write_kinapp.md`). Do not use per-package **`index.html`** as the primary entry.
- `repository/Applications/Internet/kinnextcloud/` - main Nextcloud browser app
- `repository/Applications/Office/kinonlyoffice_documents/` - launcher for new text documents
- `repository/Applications/Office/kinonlyoffice_spreadsheets/` - launcher for new spreadsheets
- `repository/Applications/Office/kinonlyoffice_presentations/` - launcher for new presentations
- `repository/Applications/Office/kinonlyoffice_common/` - shared launcher logic for OnlyOffice apps
- All apps communicate with Nextcloud via postMessage bridge
- **Kin workspace:** After `build-apps.sh` rsync, the `kinonlyoffice_*` package ids must stay distinct in the Kin app catalog. The main Kin repo should **not** map them to `remote_onlyoffice` in `clients/workspace/scripts/base.js` (`normalizeRepoPackageId`); that legacy remap would send the app menu to the wrong package even though these launchers are installed.

## kin-bridge.js API

The bridge listens for postMessage commands from the parent:

| Message Type | Payload | Description |
|-------------|---------|-------------|
| `kinBridgeHandshake` | - | Get bridge status |
| `kinBridgeLogin` | `{username, password}` | Login to Nextcloud |
| `kinBridgeLogout` | - | Logout |
| `kinBridgeGetStatus` | - | Get current status |
| `kinBridgeNavigate` | `{path}` | Navigate to URL |
| `kinBridgeWebDAV` | `{method, path, body, headers, responseType, requestId}` | WebDAV request |
| `kinBridgeOCS` | `{method, endpoint, data, requestId}` | OCS API request (v2) |
| `kinBridgeGetOnlyOfficeContext` | `{requestId}` | Get current OnlyOffice editor context |
| `kinBridgeOnlyOfficeSaveAs` | `{saveData, requestId}` | Trigger Nextcloud OnlyOffice Save As |

The bridge responds with:
- `kinBridgeReady` - Bridge initialized
- `kinBridgeHandshakeResponse` - Handshake result
- `kinBridgeStatus` / `kinBridgeStatusChange` - Status updates
- `kinBridgeWebDAVResponse` / `kinBridgeOCSResponse` - API responses
- `kinBridgeOnlyOfficeContext` - OnlyOffice file context (`fileId`, `filePath`, `inframe`)
- `kinBridgeOnlyOfficeSaveAsResult` - Save As command accepted/rejected
- `kinBridgeOnlyOfficeRequestSaveAs` - Forwarded editor Save As request to parent app
- `kinBridgeOnlyOfficeEvent` - Forwarded editor events (`editorRequest*`)
- `kinBridgeError` - Error messages

## Commands

```bash
# Start/stop services
docker compose up -d
docker compose down

# Rebuild after config changes
docker compose up -d --build

# Build and install kinnextcloud app to Kin
./build-apps.sh

# Build .deb package (installs to /opt/kin/modules/kin-office/)
./make-debian.sh

# Manage service (after installing .deb)
sudo systemctl start|stop|restart|reload kin-office
sudo service kin-office start|stop|restart|reload

# Deploy mode: read hostname from /etc/kin/config.ini, use port 443
./deploy.sh --deploy-mode
```

## Configuration

All configuration is handled automatically by `deploy.sh`. On first run, it:

1. Starts Nextcloud and OnlyOffice containers
2. Prompts for which Kin user should be Nextcloud admin
3. Configures OIDC with Kin as the identity provider
4. Adds the Kin admin user to Nextcloud's admin group
5. Writes the Kin nginx module and sets up proxy trust and HTTPS handling

For manual overrides, the following can be set in `.config.ini`:

**Deploy mode** (`--deploy-mode`): Reads hostname from `/etc/kin/config.ini` `[KinCore] hostname=`, uses port 443 (HTTPS). Designed for production .deb installs where Kin runs behind Nginx on standard HTTPS port. The `kin-office.service` systemd service runs deploy mode automatically on start/reload.

**Kin-side preflight (packaged stack):** Before debugging kin-office scripts, confirm Kin nginx and `[OIDC] issuer` match what the Nextcloud container can reach. Use the checklist in the Kin repo: [`docs/deployment.md` — *Kin + kin-office preflight (packaged stack)*](../kin/docs/deployment.md#kin--kin-office-preflight-packaged-stack). If discovery never returns JSON from inside `nextcloud`, fix Kin (443 `location /`, `kin-modules` include, `systemctl restart kin`) first — kin-office cannot invent a reachable IdP.

**Strict OIDC:** Set `KIN_OFFICE_STRICT_OIDC=1` (environment) so `deploy.sh` exits non-zero when `occ user_oidc:provider` fails after discovery probes.

```ini
KIN_BUILD_PATH=/home/hogne/Projects/Aurae/kin/build
KIN_OIDC_HOST=10.193.161.60
KIN_NEXTCLOUD_ADMIN_USER=hogne
NEXTCLOUD_ADMIN_PASSWORD=admin
```

**Important:** The `KIN_NEXTCLOUD_ADMIN_USER` is the Kin username that will get Nextcloud admin privileges. This user must first log in via OIDC (use a user app like mail or onlyoffice) before they can be added to the admin group.

If not specified:
- `KIN_OIDC_HOST` auto-detects the primary IP via `hostname -I`
- `KIN_NEXTCLOUD_ADMIN_USER` prompts interactively
- `NEXTCLOUD_ADMIN_PASSWORD` defaults to `admin`

## Kin OS

If you need access to the Kin Meta OS itself, it can be found in ../kin/
Access the kin repository in read only unless otherwise asked by the user.

## Files

- `docker-compose.yml` - Service definitions
- `nginx/conf.d/nextcloud.conf` - Legacy standalone Nginx reverse proxy config
- `nginx/certs/localhost.crt` - SSL certificate
- `nginx/certs/localhost.key` - SSL private key
- `nginx/kin-bridge.js` - Nextcloud postMessage bridge
- `repository/Applications/Internet/kinnextcloud/` - main Kin app source
- `repository/Applications/Office/kinonlyoffice_documents/` - Office Documents app source
- `repository/Applications/Office/kinonlyoffice_spreadsheets/` - Office Spreadsheets app source
- `repository/Applications/Office/kinonlyoffice_presentations/` - Office Presentations app source
- `build-apps.sh` - Build/install script
- `.config.ini` - Kin build path (gitignored)

## Integration Notes

- Kin nginx overrides `X-Frame-Options` to `ALLOWALL` for iframe embedding
- CSP is relaxed to allow inline scripts and iframe embedding
- kin-bridge.js is served at `/kin-office/kin-bridge.js` and injected into Nextcloud pages
- Kin nginx uses `server_name _` and forwards `$http_host` so requests work for LAN hostnames/IPs
- OnlyOffice is proxied as same-origin `https://<host>:9219/kin-office/ds/`
- Kin apps default to `window.location.origin + "/kin-office"` (no hardcoded `localhost`)
- Optional override is supported with query param `nextcloud_host=<host>`
- Optional storage volume override is supported with query param `kin_nextcloud_volume=<VolumeName>` (default `Nextcloud:`)
- Optional file open override is supported with query param `kin_open_path=<KinPath>`
- Optional assign target override is supported with query param `kin_nextcloud_assign_target=<KinPath>` (default `Home:.Mounts/nextcloud`)
- File dialogs default to `Mountlist:` so users can choose `Home:`, `System:`, or assigned volumes
- Since Nextcloud is same-origin through Kin nginx, the kinnextcloud app can access iframe content
- Nextcloud uses OCS API v2 (`/ocs/v2.php/`) unlike OwnCloud's v1
- After successful login, Nextcloud redirects to `/index.php/apps/dashboard/` (not files)
- Office launchers expose Storage menu actions to connect/status/disconnect the `Nextcloud:` assign
- Storage connect/disconnect requests workspace directory refresh so desktop/file windows update mount visibility
- Office launchers can import `Home:`/`System:` files into Nextcloud for editing and can Save/Save As back to Kin paths

### Recommended storage integration (assign + external WebDAV mount)

Use Kin `assign` with a host-side WebDAV mount so Kin dialogs can open/save via `Nextcloud:`.

1. Mount the user's Nextcloud WebDAV into the user's `Home:` backing tree (for example under `Home:.Mounts/nextcloud`).
2. In KinDOS, create a user assign:

```bash
assign Nextcloud: Home:.Mounts/nextcloud
```

3. Open `Mountlist:` in Kin file dialogs and verify `Nextcloud:` appears.
4. OnlyOffice launcher menus (`Open`, `Save`, `Save As`) then work against `Nextcloud:` paths.

### OIDC / discovery troubleshooting

- **“Could not reach the OpenID Connect provider”** (or `user_oidc` login routes returning **404**) usually means Nextcloud **inside Docker** cannot HTTP-fetch discovery — not that the browser cannot open `/kin-office/`. Treat it as a **Kin reachability** problem first (see preflight link above), then `docker-compose.kin-deploy-host.yml` / `write-compose-host-overlay.sh` and `deploy.sh` logs.
- **LAN / dev (`./deploy.sh` without `--deploy-mode`)** uses the same discovery **probes** as deploy mode after containers are up. With a DNS-like `KIN_OIDC_HOST`, deploy may generate `docker-compose.kin-deploy-host.yml` so the hostname resolves to `host-gateway`.

### LAN troubleshooting

- If the app opens but browser shows host unreachable, verify the hostname resolves to the server LAN IP.
- Self-signed cert host verification can block access when hostname/IP does not match the cert.

## Differences from kinoffice (OwnCloud)

| Aspect | kinoffice (OwnCloud) | nextcloud |
|--------|---------------------|-----------|
| Docker image | `owncloud:latest` | `nextcloud:latest` |
| Legacy standalone port | 5001 | 5002 |
| Direct port | 8080 | 8081 |
| Env vars | `OWNCLOUD_ADMIN_USERNAME` | `NEXTCLOUD_ADMIN_USER` |
| Post-login redirect | `/index.php/apps/files/` | `/index.php/apps/dashboard/` |
| OCS API | `/ocs/v1.php/` | `/ocs/v2.php/` |
| Container names | `owncloud`, `nginx_proxy` | `nextcloud`, `nginx_nextcloud_proxy` |
