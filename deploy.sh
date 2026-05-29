#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${ROOT}/.config.ini"
DEPLOY_MODE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy-mode)
      DEPLOY_MODE=1
      shift
      ;;
    --restart)
      echo "deploy.sh: browser-only kin-office has no containers to restart"
      exit 0
      ;;
    --help|-h)
      cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --deploy-mode   Production: install apps into /usr/lib/kin/repository/Applications
  --restart       No-op kept for compatibility
  --help          Show this help

Environment:
  KIN_BUILD_PATH  Dev Kin build directory. Also read from ${CONFIG_FILE}.
EOF
      exit 0
      ;;
    *)
      echo "deploy.sh: unknown option: $1" >&2
      exit 1
      ;;
  esac
done

optional_key() {
  local key="$1"
  grep -E "^${key}=" "${CONFIG_FILE}" 2>/dev/null | head -n1 | cut -d= -f2- || true
}

resolve_kin_build_path() {
  local configured
  configured="${KIN_BUILD_PATH:-$(optional_key KIN_BUILD_PATH)}"
  if [[ -z "${configured}" ]]; then
    configured="${ROOT}/../kin/build"
  fi
  (cd "${configured}" 2>/dev/null && pwd) || return 1
}

install_apps() {
  local target_root="$1"
  local target_apps="${target_root%/}/Applications"
  if [[ "$(basename "${target_root}")" == "Applications" ]]; then
    target_apps="${target_root}"
  fi
  local office_src="${ROOT}/repository/Applications/Office"
  local office_dest="${target_apps}/Office"
  if [[ ! -d "${office_src}" ]]; then
    echo "deploy.sh: ERROR: Kin Office apps not found at ${office_src}" >&2
    exit 1
  fi
  mkdir -p "${office_dest}"
  rsync -a --delete "${office_src}/" "${office_dest}/"
  echo "deploy.sh: installed Kin Office apps to ${office_dest}"
}

reload_dev_nginx() {
  local kin_build_path="$1"
  local kin_root kin_nginx_dir kin_nginx_conf
  kin_root="$(cd "${kin_build_path}/.." && pwd)"
  kin_nginx_dir="${kin_root}/nginx"
  kin_nginx_conf="${kin_nginx_dir}/nginx.conf"

  if command -v nginx >/dev/null 2>&1 && [[ -f "${kin_nginx_conf}" ]]; then
    if nginx -t -p "${kin_nginx_dir}" -c "${kin_nginx_conf}" >/dev/null; then
      if [[ -f "${kin_nginx_dir}/logs/nginx.pid" ]]; then
        local nginx_pid
        nginx_pid="$(sed -n '1p' "${kin_nginx_dir}/logs/nginx.pid" 2>/dev/null || true)"
        if [[ -n "${nginx_pid}" ]] && kill -0 "${nginx_pid}" 2>/dev/null; then
          nginx -s reload -p "${kin_nginx_dir}" -c "${kin_nginx_conf}" >/dev/null
          echo "deploy.sh: reloaded Kin nginx"
        fi
      fi
    else
      echo "deploy.sh: WARNING: Kin nginx config test failed" >&2
    fi
  fi
}

cd "${ROOT}"

if [[ "${DEPLOY_MODE}" -eq 1 ]]; then
  install_apps "/usr/lib/kin/repository"
  echo "deploy.sh: browser-only kin-office installed; no Docker, /ds/, or /direct/ endpoints are used"
  exit 0
fi

if [[ ! -f "${CONFIG_FILE}" && -z "${KIN_BUILD_PATH:-}" ]]; then
  echo "deploy.sh: ${CONFIG_FILE} not found — create it with KIN_BUILD_PATH (see .env.example)" >&2
  exit 1
fi

if ! KIN_BUILD_PATH="$(resolve_kin_build_path)"; then
  echo "deploy.sh: ERROR: could not resolve KIN_BUILD_PATH" >&2
  exit 1
fi
export KIN_BUILD_PATH

install_apps "${KIN_BUILD_PATH}/repository"
reload_dev_nginx "${KIN_BUILD_PATH}"
echo "deploy.sh: browser-only kin-office installed from ${ROOT}"
