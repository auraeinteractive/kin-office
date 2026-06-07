#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${ROOT}/.config.ini"

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

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

if ! KIN_BUILD_PATH="$(resolve_kin_build_path)"; then
  fail "could not resolve KIN_BUILD_PATH"
fi

COMMON_DIR="${KIN_BUILD_PATH}/repository/Applications/Office/kinoffice_common"
CONFIG_JSON="${COMMON_DIR}/collab_config.json"
ADAPTER_JS="${COMMON_DIR}/browser_editor_adapter.js"
SERVICE_BIN="${KIN_BUILD_PATH}/services/kinoffice-collab.service"
COMMAND_BIN="${KIN_BUILD_PATH}/commands/kinoffice"

[[ -d "${COMMON_DIR}" ]] || fail "deployed kinoffice_common not found at ${COMMON_DIR}"
[[ -f "${CONFIG_JSON}" ]] || fail "collab_config.json not found at ${CONFIG_JSON}"
[[ -f "${ADAPTER_JS}" ]] || fail "browser_editor_adapter.js not found at ${ADAPTER_JS}"

if grep -q '"enabled"[[:space:]]*:[[:space:]]*true' "${CONFIG_JSON}"; then
  pass "deployed collab_config.json has enabled:true"
else
  echo "collab_config.json:"
  sed -n '1,5p' "${CONFIG_JSON}" || true
  fail "collaboration is disabled in the deployed Kin build; run ./deploy.sh --to-kin from this collaboration branch"
fi

grep -q 'KinOfficeCollabTrace' "${ADAPTER_JS}" || fail "deployed adapter does not contain collaboration trace instrumentation"
pass "deployed adapter contains KinOfficeCollabTrace instrumentation"

[[ -x "${SERVICE_BIN}" ]] || fail "kinoffice-collab.service is not installed/executable at ${SERVICE_BIN}"
pass "kinoffice-collab.service is installed"
[[ -x "${COMMAND_BIN}" ]] || fail "kinoffice command is not installed/executable at ${COMMAND_BIN}"
pass "kinoffice command is installed"

PORT="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${CONFIG_JSON}" | head -n1)"
PORT="${PORT:-19129}"
HOST="$(sed -n 's/.*"host"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${CONFIG_JSON}" | head -n1)"
HOST="${HOST:-127.0.0.1}"

if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | awk -v host="${HOST}" -v port=":${PORT}" '$4 ~ port"$" { found=1 } END { exit found ? 0 : 1 }'; then
    pass "a TCP listener is present on ${HOST}:${PORT}"
  else
    fail "no TCP listener found on ${HOST}:${PORT}; deploy should have started kinoffice-collab.service"
  fi
else
  echo "WARN: ss not available; could not verify listener on ${HOST}:${PORT}"
fi

DOC_ID="kin-office-preflight"
CLIENT_ID="kin-office-preflight-$$"
JOIN_RESP="$("${COMMAND_BIN}" action=collab_join username=preflight sessionid=preflight clientId="${CLIENT_ID}" documentId="${DOC_ID}" path=Work:Preflight.docx type=docx)"
if [[ "${JOIN_RESP}" == *'"response":"success"'* && "${JOIN_RESP}" == *'"connectState"'* ]]; then
  pass "command bridge collab_join reached kinoffice-collab.service"
else
  echo "collab_join response: ${JOIN_RESP}"
  fail "command bridge join did not return success/connectState"
fi

SEND_RESP="$("${COMMAND_BIN}" action=collab_send username=preflight sessionid=preflight clientId="${CLIENT_ID}" message='{"type":"auth"}')"
if [[ "${SEND_RESP}" == *'"response":"success"'* && "${SEND_RESP}" == *'"type":"auth"'* ]]; then
  pass "command bridge collab_send delivered Euro-Office auth and returned auth response"
else
  echo "collab_send response: ${SEND_RESP}"
  fail "command bridge send did not return the expected auth response"
fi

POLL_RESP="$("${COMMAND_BIN}" action=collab_poll username=preflight sessionid=preflight clientId="${CLIENT_ID}")"
if [[ "${POLL_RESP}" == *'"response":"success"'* ]]; then
  pass "command bridge collab_poll returned success"
else
  echo "collab_poll response: ${POLL_RESP}"
  fail "command bridge poll did not return success"
fi

LEAVE_RESP="$("${COMMAND_BIN}" action=collab_leave username=preflight sessionid=preflight clientId="${CLIENT_ID}")"
if [[ "${LEAVE_RESP}" == *'"response":"success"'* ]]; then
  pass "command bridge collab_leave returned success"
else
  echo "collab_leave response: ${LEAVE_RESP}"
  fail "command bridge leave did not return success"
fi

cat <<EOF
Expected first browser trace after opening an existing DOCX:
  [KinOfficeBrowser] Collaboration config { enabled: true, ... }
  [KinOfficeBrowser] Collaboration session response ...
  [KinOfficeBrowser] Collaboration session ready ... bridge: /api/commands/kinoffice
  [KinOfficeBrowser] Collaboration CoAuthoringApi found ...
  [KinOfficeBrowser] Collaboration command bridge joined ...

If the first line says enabled:false, this preflight is not being run against the Kin build serving the browser.
EOF
