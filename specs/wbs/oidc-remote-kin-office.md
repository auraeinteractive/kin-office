# OIDC Configuration for Remote kin-office Server

**Project**: Enable kin-office to run on a standalone remote server, with OIDC authentication via the Kin server, and traffic routed through Kin's nginx.

---

## Overview
Two deb packages will be created/modified to support this setup:
1. **`kin-office-standalone.deb`** (installed on remote server) - Runs Docker containers (Nextcloud + OnlyOffice) + legacy nginx, configured to trust Kin server for OIDC.
2. **`kin-office.deb`** (installed on Kin server) - Modified to prompt for local/remote installation; if remote, writes nginx proxy to forward traffic to the standalone server.

---

## Part 1: `kin-office-standalone.deb` (Remote Server)

### Purpose
Runs the full kin-office stack (Nextcloud, OnlyOffice, legacy nginx) on a separate server, with OIDC configured to authenticate via the Kin server.

### Key OIDC Setup During Installation
The `postinst` script will prompt for the Kin server address (host:port, e.g., `kin-server:9219`). The `deploy-standalone.sh` script will configure Nextcloud as follows:

```bash
# Configure OIDC provider to point to Kin server
docker exec nextcloud php occ user_oidc:provider kin \
  --discoveryuri="https://<kin-server>:9219/.well-known/openid-configuration" \
  --clientid="kin-nextcloud" \
  --clientsecret="kin-nextcloud-secret"

# Set Nextcloud's public URL to match Kin nginx proxy
docker exec nextcloud php occ config:system:set overwritehost --value "<kin-server>:9219"
docker exec nextcloud php occ config:system:set overwritewebroot --value "/kin-office"
docker exec nextcloud php occ config:system:set overwrite.cli.url --value "https://<kin-server>:9219/kin-office"

# Configure OnlyOffice to use Kin-facing URL
docker exec nextcloud php occ config:app:set onlyoffice DocumentServerUrl \
  --value="https://<kin-server>:9219/kin-office/ds/"

# Trust proxy settings
docker exec nextcloud php occ config:system:set trusted_proxies 0 --value "<kin-server-ip>"
docker exec nextcloud php occ config:system:set overwriteprotocol --value "https"
docker exec nextcloud php occ config:system:set allow_local_remote_servers --type boolean --value true
```

### Package Contents
| Source File | Destination on Remote Server |
|-------------|-------------------------------|
| `docker-compose.yml` | `/opt/kin-office-standalone/` (DO NOT modify per AGENTS.md) |
| `nginx/conf.d/nextcloud.conf` | `/etc/nginx/sites-available/kin-office-standalone` |
| `nginx/certs/` | Self-signed certs for standalone nginx |
| `deploy-standalone.sh` | `/opt/kin-office-standalone/` (configures OIDC + OnlyOffice) |
| `kin-office-standalone.service` | `/lib/systemd/system/` (starts Docker + nginx) |

### Dependencies
- `docker.io (>= 20.10)` or `docker-ce (>= 20.10)`
- `nginx`
- No `kin` dependency (runs standalone)

---

## Part 2: Modified `kin-office.deb` (Kin Server)

### Debconf Prompts (added to `make-debian.sh`)
```
Template: kin-office/install_type
Type: select
Choices: local, remote
Description: Will kin-office run on this server or remote?
 Local: kin-office runs on this Kin server (Docker containers installed here)
 Remote: kin-office runs on another server (only nginx proxy configured)

Template: kin-office/remote_address
Type: string
Description: Remote kin-office server address (host:port):
 Example: 192.168.1.100:443 or office.example.com
```

### Behavior When "Remote" is Selected
- Skip Docker installation (change `Depends: docker.io` to `Recommends` in control file)
- Write nginx config proxying `/kin-office/` to `https://<remote-server>:443/`
- Add `proxy_ssl_verify off;` for self-signed certs from standalone server
- Still install `kin-bridge.js` and Kin apps locally

### New `deploy.sh` Flag: `--remote-mode`
Add to `deploy.sh`:
```bash
while [[ $# -gt 0 ]]; do
    case "$1" in
        --deploy-mode) DEPLOY_MODE=1; shift ;;
        --remote-mode) REMOTE_MODE=1; REMOTE_HOST="$2"; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ "${REMOTE_MODE}" -eq 1 ]]; then
    write_kin_nginx_module_remote "${REMOTE_HOST}"
    exit 0
fi
```

New function `write_kin_nginx_module_remote()`:
- Set `proxy_pass https://${REMOTE_HOST}/`
- Disable SSL verification for self-signed certs: `proxy_ssl_verify off;`
- Preserve `sub_filter` rewrites for `/kin-office/` prefix
- Serve `kin-bridge.js` locally (not proxied)

---

## Part 3: OIDC Flow for Remote Setup

### Step-by-Step Flow
1. **Browser** → `https://kin-server:9219/kin-office/` (Kin nginx)
2. **Kin nginx** → proxies to `https://standalone-server:443/` (legacy nginx on remote)
3. **Nextcloud** (on remote) redirects to `https://kin-server:9219/oidc/authorize` (Kin OIDC)
4. **Kin OIDC** validates existing session → redirects back to Nextcloud with auth code
5. **Redirect URI**: `https://kin-server:9219/kin-office/index.php/apps/user_oidc/code/kin`

### Critical Configuration Note
Nextcloud's `overwritehost` must be set to `kin-server:9219` (not the standalone server's hostname) so redirect URIs match the browser's view and OIDC validation succeeds.

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `specs/wbs/oidc-remote-kin-office.md` | **Create** | This plan document |
| `make-debian-standalone.sh` | **Create** | Build `kin-office-standalone.deb` |
| `deploy-standalone.sh` | **Create** | Configure OIDC + OnlyOffice for remote setup |
| `kin-office-standalone.service` | **Create** | Systemd service for standalone server |
| `make-debian.sh` | **Modify** | Add debconf templates, split postinst for local/remote |
| `deploy.sh` | **Modify** | Add `--remote-mode` flag + `write_kin_nginx_module_remote()` |
| `AGENTS.md` | **Update** | Document standalone setup + OIDC flow |

---

## User Installation Flow

### On Remote Server (standalone)
```bash
sudo dpkg -i kin-office-standalone.deb
# Prompt: "Enter Kin server address (host:port):" → kin-server:9219
# Automatically configures OIDC to trust Kin server, starts Docker containers + nginx
```

### On Kin Server
```bash
sudo dpkg -i kin-office.deb
# Prompt: "Will kin-office run on this server or remote?:" → remote
# Prompt: "Remote kin-office server address (host:port):" → 192.168.1.100:443
# Writes nginx proxy, skips Docker installation
```

---

## Compliance with AGENTS.md Rules
- **DO NOT modify `docker-compose.yml`** - Standalone server uses existing ports 8081/5003, no changes to compose file.
- **DO NOT modify `deploy.sh` core logic for local mode** - Only add new flags/functions, preserve existing behavior.
- **Keep `docker-compose.yml` and `.config.ini` in sync** - Standalone server has its own `.config.ini` for OIDC settings.
- **Recreate containers only, not volumes** - Service scripts use `docker compose rm -f <service>` + `docker compose up -d <service>`.
