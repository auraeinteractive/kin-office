#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${ROOT}/.config.ini"

# Resolve Kin config path (same logic as kincore_config_ini.h)
resolve_kin_config() {
    local cfg
    if [[ -n "${KIN_CONFIG_FILE:-}" ]]; then
        cfg="${KIN_CONFIG_FILE}"
    elif [[ -n "${HOME:-}" ]] && [[ -f "${HOME}/.local/share/kinwmgl/config.ini" ]]; then
        cfg="${HOME}/.local/share/kinwmgl/config.ini"
    elif [[ -n "${XDG_DATA_HOME:-}" ]] && [[ -f "${XDG_DATA_HOME}/kinwmgl/config.ini" ]]; then
        cfg="${XDG_DATA_HOME}/kinwmgl/config.ini"
    fi
    
    if [[ -n "${cfg:-}" ]] && [[ -f "${cfg}" ]]; then
        echo "${cfg}"
        return 0
    fi
    return 1
}

# Read OIDC config from Kin config file
read_kin_oidc_config() {
    local config_file="$1"
    local issuer client_id client_secret
    
    issuer=$(grep -E "^\s*issuer\s*=" "${config_file}" 2>/dev/null | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    client_id=$(grep -E "^\s*client_id\s*=" "${config_file}" 2>/dev/null | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    client_secret=$(grep -E "^\s*client_secret\s*=" "${config_file}" 2>/dev/null | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    
    if [[ -n "${issuer}" ]]; then
        echo "${issuer}|${client_id}|${client_secret}"
        return 0
    fi
    return 1
}

require_key() {
  local key="$1"
  local value
  value="$(grep -E "^${key}=" "${CONFIG_FILE}" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
  if [[ -z "${value}" ]]; then
    echo "deploy.sh: missing ${key} in ${CONFIG_FILE}" >&2
    exit 1
  fi
  echo "${value}"
}

optional_key() {
  local key="$1"
  local value
  value="$(grep -E "^${key}=" "${CONFIG_FILE}" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
  if [[ -z "${value}" ]]; then
    echo ""
  else
    echo "${value}"
  fi
}

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "deploy.sh: ${CONFIG_FILE} not found." >&2
  echo "deploy.sh: create it (see .env.example for hints) and set at least:" >&2
  echo "  KIN_OIDC_HOST" >&2
  exit 1
fi

# Try to read OIDC config from Kin config file (for the issuer)
KIN_CONFIG_PATH=""
KIN_OIDC_CONFIG=""
if KIN_CONFIG_PATH=$(resolve_kin_config 2>/dev/null); then
    if KIN_OIDC_CONFIG=$(read_kin_oidc_config "${KIN_CONFIG_PATH}" 2>/dev/null); then
        echo "deploy.sh: Found OIDC config in ${KIN_CONFIG_PATH}"
    fi
fi

export KIN_OIDC_HOST

# Use KIN_OIDC_HOST from kin-office config, but warn if it differs from Kin config
KIN_OIDC_HOST_FILE="$(optional_key KIN_OIDC_HOST)"
if [[ -z "${KIN_OIDC_HOST_FILE}" ]] && [[ -n "${KIN_OIDC_CONFIG}" ]]; then
    # No KIN_OIDC_HOST in kin-office config, extract issuer from Kin config
    IFS='|' read -r cfg_issuer cfg_client_id cfg_client_secret <<< "${KIN_OIDC_CONFIG}"
    # Extract hostname from issuer URL (remove https:// prefix and trailing port/path)
    KIN_OIDC_HOST="$(echo "${cfg_issuer}" | sed -E 's|https://||' | sed -E 's|:9219.*||')"
    echo "deploy.sh: Using KIN_OIDC_HOST from Kin config: ${KIN_OIDC_HOST}"
else
    KIN_OIDC_HOST="${KIN_OIDC_HOST_FILE}"
fi

if [[ -z "${KIN_OIDC_HOST}" ]]; then
  # Auto-detect primary IP address
  KIN_OIDC_HOST=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [[ -z "${KIN_OIDC_HOST}" ]]; then
    echo "deploy.sh: ERROR: Could not auto-detect IP address" >&2
    exit 1
  fi
  echo "deploy.sh: Using auto-detected IP: ${KIN_OIDC_HOST}"
fi

export NEXTCLOUD_ADMIN_USER
NEXTCLOUD_ADMIN_USER="$(optional_key NEXTCLOUD_ADMIN_USER)"
if [[ -z "${NEXTCLOUD_ADMIN_USER}" ]]; then
  NEXTCLOUD_ADMIN_USER="$(whoami)"
fi

export NEXTCLOUD_ADMIN_PASSWORD
NEXTCLOUD_ADMIN_PASSWORD="$(optional_key NEXTCLOUD_ADMIN_PASSWORD)"
if [[ -z "${NEXTCLOUD_ADMIN_PASSWORD}" ]]; then
  NEXTCLOUD_ADMIN_PASSWORD="kin-nextcloud-admin"
fi

export KIN_OIDC_DISCOVERY_URI="https://${KIN_OIDC_HOST}:9219/.well-known/openid-configuration"

# Get client_id and client_secret from Kin config, or use defaults
KIN_OIDC_CLIENT_ID="kin-nextcloud"
KIN_OIDC_CLIENT_SECRET="kin-nextcloud-secret"
if [[ -n "${KIN_OIDC_CONFIG}" ]]; then
    IFS='|' read -r cfg_issuer cfg_client_id cfg_client_secret <<< "${KIN_OIDC_CONFIG}"
    if [[ -n "${cfg_client_id}" ]]; then
        KIN_OIDC_CLIENT_ID="${cfg_client_id}"
    fi
    if [[ -n "${cfg_client_secret}" ]]; then
        KIN_OIDC_CLIENT_SECRET="${cfg_client_secret}"
    fi
fi

cd "${ROOT}"
docker compose up -d --wait --timeout 180

# Enable .htaccess processing (AllowOverride) for Nextcloud routing
echo "deploy.sh: Enabling .htaccess processing..."
docker exec nextcloud sed -i 's/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf 2>/dev/null || true
docker exec nextcloud apache2ctl graceful 2>/dev/null || true

# === Prompt for Kin Nextcloud Admin User ===

export KIN_NEXTCLOUD_ADMIN_USER
KIN_NEXTCLOUD_ADMIN_USER="$(optional_key KIN_NEXTCLOUD_ADMIN_USER)"
if [[ -z "${KIN_NEXTCLOUD_ADMIN_USER}" ]]; then
  echo ""
  echo "Which Kin user should be Nextcloud admin?"
  echo "Enter the username (e.g. hogne):"
  read -r KIN_NEXTCLOUD_ADMIN_USER
  if [[ -z "${KIN_NEXTCLOUD_ADMIN_USER}" ]]; then
    echo "deploy.sh: ERROR: No Kin admin user specified" >&2
    exit 1
  fi
  echo "KIN_NEXTCLOUD_ADMIN_USER=${KIN_NEXTCLOUD_ADMIN_USER}" >> "${CONFIG_FILE}"
  echo "deploy.sh: Added KIN_NEXTCLOUD_ADMIN_USER to ${CONFIG_FILE}"
else
  echo "deploy.sh: Using configured Kin admin user: ${KIN_NEXTCLOUD_ADMIN_USER}"
fi

# === OIDC Configuration for Nextcloud ===

KIN_OIDC_CLIENT_SECRET="${KIN_OIDC_CLIENT_SECRET:-kin-nextcloud-secret}"

echo "deploy.sh: Configuring Nextcloud OIDC with Kin at ${KIN_OIDC_HOST}:9219..."

# 1. Proxy trust settings
# Nextcloud expects the reverse proxy *IP* (CIDR or single address), not a Docker DNS name. Without this,
# X-Forwarded-Proto/Host and generated URLs for OnlyOffice can be wrong.
echo "deploy.sh: Setting proxy trust..."
NGINX_PROXY_IP=""
if NGINX_PROXY_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' nginx_nextcloud_proxy 2>/dev/null) && [ -n "${NGINX_PROXY_IP}" ]; then
  docker exec --user www-data nextcloud php occ config:system:set trusted_proxies 0 --value "${NGINX_PROXY_IP}" 2>/dev/null || true
  echo "deploy.sh: trusted_proxies[0]=${NGINX_PROXY_IP} (nginx_nextcloud_proxy)"
else
  echo "deploy.sh: WARNING: could not read nginx_nextcloud_proxy IP; trusted_proxies not updated" >&2
fi
docker exec --user www-data nextcloud php occ config:system:set overwriteprotocol --value "https" 2>/dev/null || true

# trusted_domains: docker-compose NEXTCLOUD_TRUSTED_DOMAINS only runs on *first* install; it does
# not update existing volumes. Browsers use Host like "<ip>:5002", which must be trusted. LAN/dev
# wildcard matches specs/wbs/02-oidc-for-nextcloud.md.
echo "deploy.sh: Setting trusted domains (LAN/dev)..."
docker exec --user www-data nextcloud php occ config:system:set trusted_domains 0 --value="*" 2>/dev/null || true

# 2. LAN remote servers (dev mode)
echo "deploy.sh: Allowing local remote servers..."
docker exec --user www-data nextcloud php occ config:system:set allow_local_remote_servers --type boolean --value true 2>/dev/null || true

# 3. user_oidc settings
echo "deploy.sh: Configuring user_oidc settings..."
docker exec --user www-data nextcloud php occ config:system:set user_oidc httpclient.allowselfsigned --type boolean --value true 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:system:set user_oidc prompt --type string --value none 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:app:set --type=string --value=0 user_oidc allow_multiple_user_backends 2>/dev/null || true

# 4. Install/enable user_oidc (idempotent)
echo "deploy.sh: Installing/enabling user_oidc app..."
docker exec --user www-data nextcloud php occ app:install user_oidc 2>/dev/null || true
docker exec --user www-data nextcloud php occ app:enable user_oidc 2>/dev/null || true

# 5. Configure OIDC provider (delete first if exists, then create)
echo "deploy.sh: Configuring OIDC provider..."
docker exec --user www-data nextcloud php occ user_oidc:provider kin --delete 2>/dev/null || true
docker exec --user www-data nextcloud php occ user_oidc:provider kin \
  --discoveryuri="https://${KIN_OIDC_HOST}:9219/.well-known/openid-configuration" \
  --clientid="${KIN_OIDC_CLIENT_ID}" \
  --clientsecret="${KIN_OIDC_CLIENT_SECRET}" \
  --unique-uid=0 \
  --mapping-display-name="preferred_username" 2>/dev/null || true

# 6. Add Kin admin user to Nextcloud admin group
echo "deploy.sh: Adding ${KIN_NEXTCLOUD_ADMIN_USER} to Nextcloud admin group..."
docker exec --user www-data nextcloud php occ group:adduser admin "${KIN_NEXTCLOUD_ADMIN_USER}" 2>/dev/null || true
# Verify user is in admin group
USER_GROUPS=$(docker exec --user www-data nextcloud php occ user:info "${KIN_NEXTCLOUD_ADMIN_USER}" 2>/dev/null | grep -A10 "groups:" || true)
if echo "${USER_GROUPS}" | grep -q "admin"; then
  echo "deploy.sh: ${KIN_NEXTCLOUD_ADMIN_USER} is in admin group"
else
  echo "deploy.sh: WARNING: ${KIN_NEXTCLOUD_ADMIN_USER} may not be in admin group yet (user might not exist until first OIDC login)"
fi

# 7. Install and configure OnlyOffice
echo "deploy.sh: Installing OnlyOffice app..."
docker exec --user www-data nextcloud php occ app:install onlyoffice 2>/dev/null || true
docker exec --user www-data nextcloud php occ app:enable onlyoffice 2>/dev/null || true

# Configure OnlyOffice to use nginx proxy (HTTPS)
ONLYOFFICE_URL="https://${KIN_OIDC_HOST}:5002/ds/"
echo "deploy.sh: Configuring OnlyOffice DocumentServerUrl to ${ONLYOFFICE_URL}..."
docker exec --user www-data nextcloud php occ config:app:set onlyoffice DocumentServerUrl --value="${ONLYOFFICE_URL}" 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:app:set onlyoffice DocumentServerInternalUrl --value="http://onlyofficedocs/" 2>/dev/null || true
# Document Server must load/save files and hit callbacks: use internal HTTP to the nextcloud *service* so
# the DS container does not depend on self-signed https://<lan>:5002. verify_peer_off helps PHP→DS HTTPS.
echo "deploy.sh: OnlyOffice StorageUrl (DS→Nextcloud) and verify_peer_off (dev/TLS)..."
docker exec --user www-data nextcloud php occ config:app:set onlyoffice StorageUrl --value="http://nextcloud/" 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:app:set onlyoffice verify_peer_off --value="true" 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:app:delete onlyoffice settings_error 2>/dev/null || true

# DS container: accept self-signed certs when downloading files from Nextcloud via nginx
echo "deploy.sh: Configuring Document Server to accept self-signed certificates..."
docker exec onlyoffice python3 -c "
import json, sys
p = '/etc/onlyoffice/documentserver/local.json'
with open(p) as f: c = json.load(f)
rd = c.setdefault('services',{}).setdefault('CoAuthoring',{}).get('requestDefaults',{})
if rd.get('rejectUnauthorized') is not False:
    c['services']['CoAuthoring']['requestDefaults'] = dict(rd, rejectUnauthorized=False)
    with open(p,'w') as f: json.dump(c,f,indent=2)
    print('  Updated local.json (rejectUnauthorized=false)')
else:
    print('  local.json already has rejectUnauthorized=false')
" 2>/dev/null || true
docker exec onlyoffice supervisorctl restart ds:docservice ds:converter 2>/dev/null || true

echo "deploy.sh: OIDC configuration complete."
echo ""
echo "OnlyOffice Document Server is configured at ${ONLYOFFICE_URL}"
