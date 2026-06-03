#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_SDKJS="${ROOT}/repository/Applications/Office/kinoffice_common/vendor/kin-office/source/sdkjs"
BUILD_DIR="${SOURCE_SDKJS}/build"
DEPLOY_SDKJS="${SOURCE_SDKJS}/deploy/sdkjs"
RUNTIME_SDKJS="${ROOT}/repository/Applications/Office/kinoffice_common/vendor/kin-office/packages/kin-office/7/sdkjs"

MIN_BUNDLE_BYTES=100000

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "build-euro-office-sdk-bundles.sh: missing command: $1" >&2
    exit 1
  fi
}

require_command npm
require_command npx

if [[ ! -d "${SOURCE_SDKJS}" ]]; then
  echo "build-euro-office-sdk-bundles.sh: Euro-Office sdkjs source not found: ${SOURCE_SDKJS}" >&2
  echo "Run ./scripts/fetch-euro-office-browser-sdk.sh first." >&2
  exit 1
fi

echo "Building Euro-Office sdk-all-min.js bundles (browser)..."
(
  cd "${BUILD_DIR}"
  npm ci
  npx grunt --no-color
)

for editor in word cell slide; do
  src="${DEPLOY_SDKJS}/${editor}/sdk-all-min.js"
  if [[ ! -f "${src}" ]]; then
    echo "build-euro-office-sdk-bundles.sh: missing built bundle: ${src}" >&2
    exit 1
  fi
  size="$(wc -c < "${src}")"
  if [[ "${size}" -lt "${MIN_BUNDLE_BYTES}" ]]; then
    echo "build-euro-office-sdk-bundles.sh: bundle too small (${size} bytes): ${src}" >&2
    exit 1
  fi
  mkdir -p "${RUNTIME_SDKJS}/${editor}"
  cp -f "${src}" "${RUNTIME_SDKJS}/${editor}/sdk-all-min.js"
  cp -f "${DEPLOY_SDKJS}/${editor}/sdk-all.js" "${RUNTIME_SDKJS}/${editor}/sdk-all.js"
  echo "Installed ${editor} sdk-all-min.js (${size} bytes)"
done

if [[ ! -f "${DEPLOY_SDKJS}/vendor/polyfill.js" ]]; then
  echo "build-euro-office-sdk-bundles.sh: missing deploy polyfill: ${DEPLOY_SDKJS}/vendor/polyfill.js" >&2
  exit 1
fi
mkdir -p "${RUNTIME_SDKJS}/vendor"
cp -f "${DEPLOY_SDKJS}/vendor/polyfill.js" "${RUNTIME_SDKJS}/vendor/polyfill.js"

LIBFONT_DEPLOY="${DEPLOY_SDKJS}/common/libfont/engine"
LIBFONT_RUNTIME="${RUNTIME_SDKJS}/common/libfont/engine"
if [[ ! -d "${LIBFONT_DEPLOY}" ]]; then
  echo "build-euro-office-sdk-bundles.sh: missing libfont deploy dir: ${LIBFONT_DEPLOY}" >&2
  exit 1
fi

echo "Installing sdkjs/common runtime assets..."
COMMON_DEPLOY="${DEPLOY_SDKJS}/common"
COMMON_RUNTIME="${RUNTIME_SDKJS}/common"
if [[ ! -d "${COMMON_DEPLOY}" ]]; then
  echo "build-euro-office-sdk-bundles.sh: missing deploy common dir: ${COMMON_DEPLOY}" >&2
  exit 1
fi
ALLFONTS_BACKUP=""
if [[ -f "${COMMON_RUNTIME}/AllFonts.js" ]]; then
  ALLFONTS_BACKUP="$(mktemp)"
  cp -f "${COMMON_RUNTIME}/AllFonts.js" "${ALLFONTS_BACKUP}"
fi
mkdir -p "${COMMON_RUNTIME}"
rsync -a "${COMMON_DEPLOY}/" "${COMMON_RUNTIME}/"
if [[ -n "${ALLFONTS_BACKUP}" ]]; then
  cp -f "${ALLFONTS_BACKUP}" "${COMMON_RUNTIME}/AllFonts.js"
  rm -f "${ALLFONTS_BACKUP}"
fi
echo "Installed sdkjs/common ($(du -sh "${COMMON_RUNTIME}" | cut -f1))"

mkdir -p "${LIBFONT_RUNTIME}"
for libfont_file in fonts.js fonts.wasm fonts_ie.js fonts_native.js; do
  if [[ ! -f "${LIBFONT_RUNTIME}/${libfont_file}" ]]; then
    echo "build-euro-office-sdk-bundles.sh: missing libfont artifact after common sync: ${LIBFONT_RUNTIME}/${libfont_file}" >&2
    exit 1
  fi
  echo "Verified libfont/${libfont_file}"
done

rm -rf "${RUNTIME_SDKJS}/source-loader"

echo "Euro-Office SDK bundles installed under ${RUNTIME_SDKJS}"
