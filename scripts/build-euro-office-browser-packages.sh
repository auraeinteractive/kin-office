#!/usr/bin/env bash
# Build Euro-Office browser runtime packages from pinned source snapshots.
# Frontend only — no Docker, no Document Server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="${ROOT}/repository/Applications/Office/kinoffice_common/vendor/kin-office"
SOURCE_WEBAPPS="${VENDOR}/source/web-apps"
SOURCE_SDKJS="${VENDOR}/source/sdkjs"
PKG7="${VENDOR}/packages/kin-office/7"
WEBAPPS_BUILD="${SOURCE_WEBAPPS}/build"
WEBAPPS_DEPLOY="${SOURCE_WEBAPPS}/deploy"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "build-euro-office-browser-packages.sh: missing command: $1" >&2
    exit 1
  fi
}

require_command npm
require_command npx
require_command python3

if [[ ! -d "${SOURCE_WEBAPPS}" || ! -d "${SOURCE_SDKJS}" ]]; then
  echo "build-euro-office-browser-packages.sh: run ./scripts/fetch-euro-office-browser-sdk.sh first" >&2
  exit 1
fi

echo "Building web-apps (Euro-Office browser UI + DocsAPI)..."
(
  cd "${WEBAPPS_BUILD}"
  if [[ -f package-lock.json ]]; then
    npm ci || npm install
  else
    npm install
  fi
  export BUILD_ROOT="${WEBAPPS_DEPLOY}"
  export THEME="${THEME:-euro-office}"
  npx grunt --skip-imagemin --skip-babel --no-color
)

if [[ ! -f "${WEBAPPS_DEPLOY}/web-apps/apps/api/documents/api.js" ]]; then
  echo "build-euro-office-browser-packages.sh: api.js missing after web-apps build" >&2
  exit 1
fi

echo "Installing web-apps into ${PKG7}/web-apps ..."
mkdir -p "${PKG7}"
rsync -a --delete "${WEBAPPS_DEPLOY}/web-apps/" "${PKG7}/web-apps/"

echo "Building sdk-all-min.js bundles..."
"${ROOT}/scripts/build-euro-office-sdk-bundles.sh"

python3 "${ROOT}/scripts/patch-euro-office-save-hooks.py" "${PKG7}/web-apps"

mkdir -p \
  "${PKG7}/web-apps/vendor/xregexp" \
  "${PKG7}/sdkjs/common/Images/cursors"
cp -f "${SOURCE_SDKJS}/common/Images/cursors/svg.json" \
  "${PKG7}/sdkjs/common/Images/cursors/svg.json"
cp -f "${SOURCE_SDKJS}/vendor/xregexp-all-min.js" \
  "${PKG7}/web-apps/vendor/xregexp/xregexp-all-min.js"

echo "Installing Kin Office font catalog (AllFonts.js + web fonts)..."
python3 "${ROOT}/scripts/generate-kinoffice-allfonts.py"

if [[ ! -f "${PKG7}/sdkjs/common/AllFonts.js" ]]; then
  echo "build-euro-office-browser-packages.sh: AllFonts.js missing after generate-kinoffice-allfonts.py" >&2
  exit 1
fi

cp -f "${SOURCE_SDKJS}/common/serviceworker/document_editor_service_worker.js" \
  "${PKG7}/document_editor_service_worker.js"

echo "Browser packages ready under ${PKG7}"
