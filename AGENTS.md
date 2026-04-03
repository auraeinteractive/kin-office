# Project: Nextcloud - Self-Hosted Nextcloud with Kin Integration

## Goal
Set up Nextcloud to run in Docker with an Nginx reverse proxy accessible at `https://localhost:5002` using a self-signed certificate, with integration into Kin OS.

## Architecture
```
Kin Workspace (Browser)
    |
    v
kinnextcloud app (iframe) -- postMessage --> kin-bridge.js (injected)
    |                                               |
    v                                               v
Nginx (Reverse Proxy) --- :5002 <---------------- Nextcloud
```

## Components

### Docker Setup
- `docker-compose.yml` - Nextcloud + Nginx services
- `nginx/conf.d/nextcloud.conf` - Nginx config with header overrides for iframe embedding
- `nginx/certs/` - Self-signed SSL certificate
- `nginx/kin-bridge.js` - JavaScript bridge injected into Nextcloud pages

### kinnextcloud App
- `repository/Applications/Internet/kinnextcloud/`
- Communicates with Nextcloud via postMessage bridge
- Toolbar for login/logout/refresh controls

## kin-bridge.js API

The bridge listens for postMessage commands from the parent:

| Message Type | Payload | Description |
|-------------|---------|-------------|
| `kinBridgeHandshake` | - | Get bridge status |
| `kinBridgeLogin` | `{username, password}` | Login to Nextcloud |
| `kinBridgeLogout` | - | Logout |
| `kinBridgeGetStatus` | - | Get current status |
| `kinBridgeNavigate` | `{path}` | Navigate to URL |
| `kinBridgeWebDAV` | `{method, path, body, requestId}` | WebDAV request |
| `kinBridgeOCS` | `{method, endpoint, data, requestId}` | OCS API request (v2) |

The bridge responds with:
- `kinBridgeReady` - Bridge initialized
- `kinBridgeHandshakeResponse` - Handshake result
- `kinBridgeStatus` / `kinBridgeStatusChange` - Status updates
- `kinBridgeWebDAVResponse` / `kinBridgeOCSResponse` - API responses
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
```

## Configuration

Nextcloud credentials (set in `docker-compose.yml`):
- Username: `admin`
- Password: `admin123`

Nextcloud CSRF protection must be disabled for auto-login to work:
```bash
docker exec --user www-data nextcloud php occ config:system:set csrf.disabled --value true --type boolean
```

Nextcloud must trust the proxy:
```bash
docker exec --user www-data nextcloud php occ config:system:set trusted_proxies 0 --value "nginx_nextcloud_proxy"
docker exec --user www-data nextcloud php occ config:system:set overwriteprotocol --value "https"
```

## Files

- `docker-compose.yml` - Service definitions
- `nginx/conf.d/nextcloud.conf` - Nginx reverse proxy config
- `nginx/certs/localhost.crt` - SSL certificate
- `nginx/certs/localhost.key` - SSL private key
- `nginx/kin-bridge.js` - Nextcloud postMessage bridge
- `repository/Applications/Internet/kinnextcloud/` - Kin app source
- `build-apps.sh` - Build/install script
- `.config.ini` - Kin build path (gitignored)

## Integration Notes

- Nginx overrides `X-Frame-Options` to `ALLOWALL` for iframe embedding
- CSP is relaxed to allow inline scripts and iframe embedding
- kin-bridge.js is served at `/kin-bridge.js` and injected into Nextcloud pages
- Since Nextcloud is same-origin (proxied), the kinnextcloud app can access iframe content
- Nextcloud uses OCS API v2 (`/ocs/v2.php/`) unlike OwnCloud's v1
- After successful login, Nextcloud redirects to `/index.php/apps/dashboard/` (not files)

## Differences from kinoffice (OwnCloud)

| Aspect | kinoffice (OwnCloud) | nextcloud |
|--------|---------------------|-----------|
| Docker image | `owncloud:latest` | `nextcloud:latest` |
| Port | 5001 | 5002 |
| Direct port | 8080 | 8081 |
| Env vars | `OWNCLOUD_ADMIN_USERNAME` | `NEXTCLOUD_ADMIN_USER` |
| Post-login redirect | `/index.php/apps/files/` | `/index.php/apps/dashboard/` |
| OCS API | `/ocs/v1.php/` | `/ocs/v2.php/` |
| Container names | `owncloud`, `nginx_proxy` | `nextcloud`, `nginx_nextcloud_proxy` |
