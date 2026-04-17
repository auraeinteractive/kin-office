#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${ROOT}/.config.ini"

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

export KIN_OIDC_HOST
KIN_OIDC_HOST="$(require_key KIN_OIDC_HOST)"

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

cd "${ROOT}"
docker compose up -d --wait --timeout 180

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
  --clientid="kin-nextcloud" \
  --clientsecret="${KIN_OIDC_CLIENT_SECRET}" \
  --unique-uid=0 \
  --mapping-display-name="preferred_username" 2>/dev/null || true

echo "deploy.sh: OIDC configuration complete."
