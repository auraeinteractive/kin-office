#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${ROOT}/.config.ini"

show_help() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --help     Show this help message
  --restart  Restart containers (stop, then start)

Environment:
  Config is read from ${CONFIG_FILE}
  Required keys: KIN_OIDC_HOST, NEXTCLOUD_ADMIN_USER, NEXTCLOUD_ADMIN_PASSWORD
EOF
}

RESTART_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)
      show_help
      exit 0
      ;;
    --restart)
      RESTART_MODE=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      show_help >&2
      exit 1
      ;;
  esac
done

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
if [[ "${RESTART_MODE}" == true ]]; then
  docker compose restart
else
  docker compose up -d --wait --timeout 180
fi
