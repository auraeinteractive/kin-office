#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${ROOT}/.config.ini"
DEPLOY_MODE=0
INSTALL_TO_KIN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy-mode)
      DEPLOY_MODE=1
      shift
      ;;
    --to-kin)
      INSTALL_TO_KIN=1
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
  --to-kin        Dev only: copy kinoffice_* into KIN_BUILD_PATH (never deletes Kin files)
  --restart       No-op kept for compatibility
  --help          Show this help

By default this script does not write to your Kin build tree.
Use --to-kin when you explicitly want to refresh Kin Office apps in Kin.

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

KINOFFICE_APP_DIRS=(kinoffice_common kinoffice_docs kinoffice_sheets kinoffice_slides)

KINOFFICE_COMMON_RUNTIME_EXCLUDE=(--exclude 'vendor/kin-office/source/')

install_kinoffice_common() {
  local src="$1"
  local dest="$2"
  mkdir -p "${dest}"
  rsync -a "${KINOFFICE_COMMON_RUNTIME_EXCLUDE[@]}" "${src}/" "${dest}/"
  # Drop legacy full-tree deploys: source is for grunt/npm builds, not Kin runtime.
  if [[ -d "${dest}/vendor/kin-office/source" ]]; then
    rm -rf "${dest}/vendor/kin-office/source"
    echo "deploy.sh: removed stale vendor/kin-office/source from Kin build"
  fi
  write_kinoffice_release_stamp "${dest}"
}

write_kinoffice_release_stamp() {
  local common_dir="$1"
  local release
  release="$(date -u +%Y%m%d%H%M%S)"
  printf '{"release":"%s"}\n' "${release}" > "${common_dir}/release.json"
  echo "deploy.sh: stamped ${common_dir}/release.json (${release})"
}

remove_stale_kinoffice_debug_entries() {
  local app_dir="$1"
  local removed=0
  local stale
  shopt -s nullglob
  for stale in "${app_dir}"/app_debug_*.js; do
    rm -f "${stale}"
    removed=$((removed + 1))
    echo "deploy.sh: removed stale debug entry ${stale}"
  done
  if [[ -f "${app_dir}/app.mjs" ]]; then
    rm -f "${app_dir}/app.mjs"
    removed=$((removed + 1))
    echo "deploy.sh: removed app.mjs (entry is boot.js) from ${app_dir}"
  fi
  shopt -u nullglob
  if [[ "${removed}" -gt 0 ]]; then
    echo "deploy.sh: removed ${removed} stale kinoffice app entry file(s) from ${app_dir}"
  fi
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
  local app
  for app in "${KINOFFICE_APP_DIRS[@]}"; do
    if [[ ! -d "${office_src}/${app}" ]]; then
      echo "deploy.sh: ERROR: missing Kin Office app dir: ${office_src}/${app}" >&2
      exit 1
    fi
    if [[ "${app}" == kinoffice_common ]]; then
      install_kinoffice_common "${office_src}/${app}" "${office_dest}/${app}"
      echo "deploy.sh: copied ${office_dest}/${app} (runtime only; Euro-Office source/ excluded)"
    else
      rsync -a "${office_src}/${app}/" "${office_dest}/${app}/"
      remove_stale_kinoffice_debug_entries "${office_dest}/${app}"
      echo "deploy.sh: copied ${office_dest}/${app}"
    fi
  done
  echo "deploy.sh: kinoffice_* only — no --delete, no other Kin paths touched"
}

install_kinoffice_cmd() {
  local commands_dir="$1"
  local cmd_src="${ROOT}/commands/kinoffice.cmd/kinoffice"
  if [[ ! -x "${cmd_src}" ]]; then
    echo "deploy.sh: building kinoffice command..."
    "${ROOT}/scripts/build-kinoffice-cmd.sh"
  fi
  if [[ ! -x "${cmd_src}" ]]; then
    echo "deploy.sh: ERROR: kinoffice command not built at ${cmd_src}" >&2
    exit 1
  fi
  mkdir -p "${commands_dir}"
  install -m 755 "${cmd_src}" "${commands_dir}/kinoffice"
  echo "deploy.sh: installed ${commands_dir}/kinoffice"
}

cd "${ROOT}"

if [[ "${DEPLOY_MODE}" -eq 1 ]]; then
  install_apps "/usr/lib/kin/repository"
  install_kinoffice_cmd "/usr/lib/kin/commands"
  echo "deploy.sh: browser-only kin-office installed; no Docker, /ds/, or /direct/ endpoints are used"
  exit 0
fi

if [[ "${INSTALL_TO_KIN}" -ne 1 ]]; then
  cat <<EOF
deploy.sh: nothing installed (Kin build was not modified).
To copy kinoffice_* into your Kin build, run:

  ./deploy.sh --to-kin

Production install:

  sudo ./deploy.sh --deploy-mode
EOF
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
install_kinoffice_cmd "${KIN_BUILD_PATH}/commands"
echo "deploy.sh: Kin Office copied from ${ROOT} (Kin nginx not reloaded)"
echo "deploy.sh: verify read path — curl -skL 'https://127.0.0.1:9219/repository/kinoffice_common/office_app.js' | rg '/api/file/raw'"
