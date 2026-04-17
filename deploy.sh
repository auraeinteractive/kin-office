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
echo "deploy.sh: Setting proxy trust..."
docker exec --user www-data nextcloud php occ config:system:set trusted_proxies 0 --value "nginx_nextcloud_proxy" 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:system:set overwriteprotocol --value "https" 2>/dev/null || true

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

echo "deploy.sh: OIDC configuration complete."
echo ""
echo "IMPORTANT: Install OnlyOffice from the Nextcloud App Store (/settings/apps) and configure it there."
