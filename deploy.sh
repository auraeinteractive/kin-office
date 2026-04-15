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

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "deploy.sh: ${CONFIG_FILE} not found." >&2
  echo "deploy.sh: create it (see .env.example for hints) and set at least:" >&2
  echo "  KIN_OIDC_HOST, NEXTCLOUD_ADMIN_USER, NEXTCLOUD_ADMIN_PASSWORD" >&2
  exit 1
fi

export KIN_OIDC_HOST
KIN_OIDC_HOST="$(require_key KIN_OIDC_HOST)"

export NEXTCLOUD_ADMIN_USER
NEXTCLOUD_ADMIN_USER="$(require_key NEXTCLOUD_ADMIN_USER)"

export NEXTCLOUD_ADMIN_PASSWORD
NEXTCLOUD_ADMIN_PASSWORD="$(require_key NEXTCLOUD_ADMIN_PASSWORD)"

export KIN_OIDC_DISCOVERY_URI="https://${KIN_OIDC_HOST}:9219/.well-known/openid-configuration"

cd "${ROOT}"
docker compose up -d --wait --timeout 180
