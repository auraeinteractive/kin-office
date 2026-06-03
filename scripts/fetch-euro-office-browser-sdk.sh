#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="${ROOT}/repository/Applications/Office/kinoffice_common/vendor/kin-office"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kin-office-sdk.XXXXXX")"
BUILD_PACKAGES="${BUILD_PACKAGES:-1}"

EURO_OFFICE_SDKJS_REPO="${EURO_OFFICE_SDKJS_REPO:-https://github.com/Euro-Office/sdkjs.git}"
EURO_OFFICE_SDKJS_REF="${EURO_OFFICE_SDKJS_REF:-bf4a2db383f2dc9712c328e8704d3c58abb6a93e}"
EURO_OFFICE_WEB_APPS_REPO="${EURO_OFFICE_WEB_APPS_REPO:-https://github.com/Euro-Office/web-apps.git}"
EURO_OFFICE_WEB_APPS_REF="${EURO_OFFICE_WEB_APPS_REF:-7cc3e23c2a881b7b3fe58e270f91b6926ec50e92}"
EURO_OFFICE_CORE_REPO="${EURO_OFFICE_CORE_REPO:-https://github.com/Euro-Office/core.git}"
EURO_OFFICE_CORE_REF="${EURO_OFFICE_CORE_REF:-ab710975ac3e5b7f5ea4eea53207ec58e5c869ed}"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "fetch-euro-office-browser-sdk.sh: missing command: $1" >&2
    exit 1
  fi
}

require_command git
require_command rsync
require_command python3

fetch_repo() {
  local repo="$1"
  local ref="$2"
  local dir="$3"
  git clone --depth 1 "${repo}" "${dir}" >/dev/null
  git -C "${dir}" fetch --depth 1 origin "${ref}" >/dev/null
  git -C "${dir}" checkout --detach "${ref}" >/dev/null
}

echo "Fetching Euro-Office source snapshots..."
fetch_repo "${EURO_OFFICE_SDKJS_REPO}" "${EURO_OFFICE_SDKJS_REF}" "${TMP_DIR}/sdkjs"
fetch_repo "${EURO_OFFICE_WEB_APPS_REPO}" "${EURO_OFFICE_WEB_APPS_REF}" "${TMP_DIR}/web-apps"
fetch_repo "${EURO_OFFICE_CORE_REPO}" "${EURO_OFFICE_CORE_REF}" "${TMP_DIR}/core"

rm -rf "${VENDOR_DIR}"
mkdir -p "${VENDOR_DIR}"

mkdir -p "${VENDOR_DIR}/source"
rsync -a --delete "${TMP_DIR}/sdkjs/" "${VENDOR_DIR}/source/sdkjs/"
rsync -a --delete "${TMP_DIR}/web-apps/" "${VENDOR_DIR}/source/web-apps/"
rsync -a --delete "${TMP_DIR}/core/" "${VENDOR_DIR}/source/core/"
python3 "${ROOT}/scripts/patch-euro-office-save-hooks.py" "${VENDOR_DIR}/source/web-apps"

cat >"${VENDOR_DIR}/manifest.json" <<EOF
{
  "generatedBy": "scripts/fetch-euro-office-browser-sdk.sh",
  "sdkjsRepo": "${EURO_OFFICE_SDKJS_REPO}",
  "sdkjsRef": "${EURO_OFFICE_SDKJS_REF}",
  "webAppsRepo": "${EURO_OFFICE_WEB_APPS_REPO}",
  "webAppsRef": "${EURO_OFFICE_WEB_APPS_REF}",
  "coreRepo": "${EURO_OFFICE_CORE_REPO}",
  "coreRef": "${EURO_OFFICE_CORE_REF}",
  "notes": [
    "Euro-Office source snapshots are pinned from upstream repos.",
    "Browser runtime is built locally with scripts/build-euro-office-browser-packages.sh.",
    "Frontend only: no Docker, no Document Server."
  ]
}
EOF

echo "Wrote ${VENDOR_DIR}/source"

if [[ "${BUILD_PACKAGES}" == "1" ]]; then
  "${ROOT}/scripts/build-euro-office-browser-packages.sh"
fi

echo "Done."
