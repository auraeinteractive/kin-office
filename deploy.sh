#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${ROOT}/.config.ini"
KIN_OFFICE_PREFIX="${KIN_OFFICE_PREFIX:-/kin-office}"
DEPLOY_MODE=0
RESTART_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy-mode)
      DEPLOY_MODE=1
      shift
      ;;
    --restart)
      RESTART_MODE=true
      shift
      ;;
    --help|-h)
      cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --deploy-mode   Production: read hostname from /etc/kin/config.ini, write system nginx module
  --restart       Restart containers only
  --help          Show this help

Environment:
  KIN_OFFICE_PREFIX (default /kin-office)
  KIN_OFFICE_SKIP_COMPOSE_UP=1  Skip docker compose up (wrapper already started containers)
  Dev config: ${CONFIG_FILE} — optional KIN_BUILD_PATH, KIN_PUBLIC_HOST
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

normalize_prefix() {
  local prefix="$1"
  prefix="/${prefix#/}"
  prefix="${prefix%/}"
  if [[ "${prefix}" == "/" ]]; then
    echo ""
  else
    echo "${prefix}"
  fi
}

resolve_kin_build_path() {
  local configured
  configured="${KIN_BUILD_PATH:-$(optional_key KIN_BUILD_PATH)}"
  if [[ -z "${configured}" ]]; then
    configured="${ROOT}/../kin/build"
  fi
  (cd "${configured}" 2>/dev/null && pwd) || return 1
}

wait_for_onlyoffice_api() {
  local url="${1:-http://127.0.0.1:5003/web-apps/apps/api/documents/api.js}"
  local timeout_seconds="${2:-240}"
  local start now
  start="$(date +%s)"

  echo "deploy.sh: Waiting for OnlyOffice API at ${url}..."
  while true; do
    if command -v python3 >/dev/null 2>&1; then
      if python3 - "${url}" <<'PY' >/dev/null 2>&1
import sys
import urllib.request

url = sys.argv[1]
request = urllib.request.Request(url, headers={"User-Agent": "kin-office-deploy/1.0"})
with urllib.request.urlopen(request, timeout=5) as response:
    body = response.read(8192)
    if response.status < 500 and b"DocsAPI" in body:
        sys.exit(0)
sys.exit(1)
PY
      then
        echo "deploy.sh: OnlyOffice API is ready"
        return 0
      fi
    elif command -v curl >/dev/null 2>&1; then
      if curl -fsS --max-time 5 "${url}" 2>/dev/null | grep -q "DocsAPI"; then
        echo "deploy.sh: OnlyOffice API is ready"
        return 0
      fi
    else
      return 0
    fi

    now="$(date +%s)"
    if (( now - start >= timeout_seconds )); then
      echo "deploy.sh: ERROR: OnlyOffice API did not become ready within ${timeout_seconds}s (${url})" >&2
      return 1
    fi
    sleep 3
  done
}

wait_for_direct_connector() {
  local url="${1:-http://127.0.0.1:8000/direct/health}"
  local timeout_seconds="${2:-120}"
  local start now
  start="$(date +%s)"

  echo "deploy.sh: Waiting for direct connector at ${url}..."
  while true; do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS --max-time 5 "${url}" 2>/dev/null | grep -q '"success"'; then
        echo "deploy.sh: Direct connector is ready"
        return 0
      fi
    elif command -v python3 >/dev/null 2>&1; then
      if python3 - "${url}" <<'PY' >/dev/null 2>&1
import sys, json, urllib.request
url = sys.argv[1]
with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "kin-office-deploy/1.0"}), timeout=5) as r:
    j = json.loads(r.read().decode())
    sys.exit(0 if j.get("response") == "success" else 1)
PY
      then
        echo "deploy.sh: Direct connector is ready"
        return 0
      fi
    fi

    now="$(date +%s)"
    if (( now - start >= timeout_seconds )); then
      echo "deploy.sh: ERROR: direct connector did not become ready within ${timeout_seconds}s" >&2
      return 1
    fi
    sleep 2
  done
}

configure_onlyoffice_documentserver() {
  docker exec onlyoffice python3 -c "
import json
p = '/etc/onlyoffice/documentserver/local.json'
with open(p) as f: c = json.load(f)
rd = c.setdefault('services',{}).setdefault('CoAuthoring',{}).get('requestDefaults',{})
safe_urls = list(rd.get('safeUrls', []))
for u in ('http://onlyoffice-direct:8000/', 'http://onlyoffice/', 'http://onlyofficedocs/'):
    if u not in safe_urls:
        safe_urls.append(u)
c['services']['CoAuthoring']['requestDefaults'] = dict(rd, rejectUnauthorized=False, safeUrls=safe_urls)
with open(p,'w') as f: json.dump(c,f,indent=2)
print('Updated Document Server local.json (safeUrls + rejectUnauthorized=false)')
" 2>/dev/null || echo "deploy.sh: WARNING: could not patch onlyoffice local.json" >&2
  docker exec onlyoffice supervisorctl restart ds:docservice ds:converter 2>/dev/null || true
}

docker_compose_up() {
  cd "${ROOT}"
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE=(docker-compose)
  else
    echo "deploy.sh: ERROR: docker compose not found" >&2
    exit 1
  fi

  if [[ "${KIN_OFFICE_SKIP_COMPOSE_UP:-}" == "1" ]]; then
    echo "deploy.sh: KIN_OFFICE_SKIP_COMPOSE_UP=1 — skipping docker compose up"
    return 0
  fi

  if [[ "${DOCKER_COMPOSE[0]}" == "docker" && "${DOCKER_COMPOSE[1]}" == "compose" ]]; then
    "${DOCKER_COMPOSE[@]}" -f docker-compose.yml up -d --build --wait --timeout 180 onlyoffice onlyoffice-direct
  else
    "${DOCKER_COMPOSE[@]}" -f docker-compose.yml up -d --build onlyoffice onlyoffice-direct
  fi
}

write_nginx_locations() {
  local prefix="$1"
  local use_snippets="${2:-1}"
  cat <<EOF
# Generated by kin-office/deploy.sh. Do not edit by hand.

location = ${prefix} {
    return 204;
}

location ^~ ${prefix}/ds/ {
    if (\$uri ~ document_editor_service_worker\\.js) {
        add_header Cache-Control "no-cache" always;
        return 404;
    }
    proxy_pass http://127.0.0.1:5003/;
EOF
  if [[ "${use_snippets}" == "1" ]]; then
    cat <<EOF
    include snippets/proxy-common.conf;
    include snippets/proxy-websocket.conf;
EOF
  else
    cat <<'EOF'
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Port $server_port;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_buffering off;
EOF
  fi
  cat <<EOF
    proxy_set_header X-Forwarded-Prefix ${prefix}/ds;
    proxy_set_header Accept-Encoding "";
    sub_filter_once off;
    sub_filter '</head>' '<script>document.addEventListener("keydown",function(e){try{window.parent.postMessage({type:"kinEditorKeydown",key:e.key||"",ctrlKey:!!e.ctrlKey,metaKey:!!e.metaKey,shiftKey:!!e.shiftKey,altKey:!!e.altKey},"*")}catch(_e){}});try{if(navigator.serviceWorker){navigator.serviceWorker.register=function(){return Promise.reject(new Error("kin-office: service worker disabled"))};navigator.serviceWorker.getRegistrations().then(function(r){r.forEach(function(s){s.unregister()})}).catch(function(){})}}catch(_e){}</script></head>';
}

location ^~ ${prefix}/direct/ {
    proxy_pass http://127.0.0.1:8000/direct/;
EOF
  if [[ "${use_snippets}" == "1" ]]; then
    cat <<EOF
    include snippets/proxy-common.conf;
    include snippets/proxy-websocket.conf;
EOF
  else
    cat <<'EOF'
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Port $server_port;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_buffering off;
EOF
  fi
  cat <<EOF
    proxy_set_header X-Forwarded-Prefix ${prefix};
    proxy_set_header Accept-Encoding "";

    proxy_hide_header X-Frame-Options;
    add_header X-Frame-Options "ALLOWALL" always;
    proxy_hide_header Content-Security-Policy;
    add_header Content-Security-Policy "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors *;" always;
}
EOF
}

write_kin_nginx_module() {
  local kin_build_path="$1"
  local prefix="$2"
  local module_dir="${kin_build_path}/nginx/server.d"
  local module_file="${module_dir}/kin-office.conf"
  local kin_root kin_nginx_dir kin_nginx_conf

  kin_root="$(cd "${kin_build_path}/.." && pwd)"
  kin_nginx_dir="${kin_root}/nginx"
  kin_nginx_conf="${kin_nginx_dir}/nginx.conf"

  mkdir -p "${module_dir}"
  write_nginx_locations "${prefix}" 1 > "${module_file}"
  echo "deploy.sh: wrote Kin nginx module ${module_file}"

  if command -v nginx >/dev/null 2>&1 && [[ -f "${kin_nginx_conf}" ]]; then
    if nginx -t -p "${kin_nginx_dir}" -c "${kin_nginx_conf}" >/dev/null; then
      if [[ -f "${kin_nginx_dir}/logs/nginx.pid" ]]; then
        local nginx_pid
        nginx_pid="$(cat "${kin_nginx_dir}/logs/nginx.pid" 2>/dev/null || true)"
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

write_system_nginx_module() {
  local prefix="$1"
  local module_dir="/etc/nginx/kin-modules"
  local module_file="${module_dir}/kin-office.conf"
  local site_file="/etc/nginx/sites-available/kin"
  local include_line="    include /etc/nginx/kin-modules/*.conf;"

  mkdir -p "${module_dir}"
  write_nginx_locations "${prefix}" 0 > "${module_file}"
  echo "deploy.sh: wrote system nginx module ${module_file}"

  if [[ -f "${site_file}" ]] && ! grep -Fq "${include_line}" "${site_file}"; then
    if grep -Eq '^[[:space:]]*client_max_body_size[[:space:]]+' "${site_file}"; then
      sed -i "\|^[[:space:]]*client_max_body_size[[:space:]]|a\\${include_line}" "${site_file}"
    elif grep -Eq '^[[:space:]]*ssl_certificate_key[[:space:]]+' "${site_file}"; then
      sed -i "\|^[[:space:]]*ssl_certificate_key[[:space:]]|a\\${include_line}" "${site_file}"
    fi
  fi

  if command -v nginx >/dev/null 2>&1; then
    if nginx -t 2>/dev/null; then
      nginx -s reload 2>/dev/null || true
      echo "deploy.sh: reloaded system nginx"
    fi
  fi
}

resolve_public_host() {
  if [[ "${DEPLOY_MODE}" -eq 1 ]]; then
    local kin_config="/etc/kin/config.ini"
    if [[ ! -f "${kin_config}" ]]; then
      echo "deploy.sh: ERROR: deploy mode requires ${kin_config}" >&2
      exit 1
    fi
    KIN_PUBLIC_HOST="$(grep -E "^\s*hostname\s*=" "${kin_config}" 2>/dev/null | head -1 | sed 's/.*=\s*//' | tr -d ' ')"
    if [[ -z "${KIN_PUBLIC_HOST}" ]]; then
      echo "deploy.sh: ERROR: [KinCore] hostname= not set in ${kin_config}" >&2
      exit 1
    fi
    KIN_PUBLIC_BASE_URL="https://${KIN_PUBLIC_HOST}"
    return 0
  fi

  if [[ -f "${CONFIG_FILE}" ]]; then
    KIN_PUBLIC_HOST="$(optional_key KIN_PUBLIC_HOST)"
    if [[ -z "${KIN_PUBLIC_HOST}" ]]; then
      KIN_PUBLIC_HOST="$(optional_key KIN_OIDC_HOST)"
    fi
  fi
  if [[ -z "${KIN_PUBLIC_HOST:-}" ]]; then
    KIN_PUBLIC_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  if [[ -z "${KIN_PUBLIC_HOST}" ]]; then
    echo "deploy.sh: ERROR: set KIN_PUBLIC_HOST in ${CONFIG_FILE} or use --deploy-mode" >&2
    exit 1
  fi
  KIN_PUBLIC_BASE_URL="https://${KIN_PUBLIC_HOST}:9219"
}

KIN_OFFICE_PREFIX="$(normalize_prefix "${KIN_OFFICE_PREFIX}")"
if [[ -z "${KIN_OFFICE_PREFIX}" ]]; then
  echo "deploy.sh: ERROR: KIN_OFFICE_PREFIX must not be /" >&2
  exit 1
fi
export KIN_OFFICE_PREFIX

resolve_public_host
export KIN_PUBLIC_BASE_URL
KIN_OFFICE_PUBLIC_URL="${KIN_PUBLIC_BASE_URL}${KIN_OFFICE_PREFIX}"
export KIN_OFFICE_PUBLIC_URL

cd "${ROOT}"

if [[ "${RESTART_MODE}" == true ]]; then
  docker compose restart onlyoffice onlyoffice-direct 2>/dev/null || docker-compose restart onlyoffice onlyoffice-direct
  exit 0
fi

docker_compose_up
configure_onlyoffice_documentserver
wait_for_onlyoffice_api
wait_for_direct_connector

if [[ "${DEPLOY_MODE}" -eq 1 ]]; then
  write_system_nginx_module "${KIN_OFFICE_PREFIX}"
  echo "deploy.sh: OnlyOffice Document Server: ${KIN_OFFICE_PUBLIC_URL}/ds/"
  echo "deploy.sh: Direct connector: ${KIN_OFFICE_PUBLIC_URL}/direct/"
  exit 0
fi

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "deploy.sh: ${CONFIG_FILE} not found — create it with KIN_BUILD_PATH (see .env.example)" >&2
  exit 1
fi

if ! KIN_BUILD_PATH="$(resolve_kin_build_path)"; then
  echo "deploy.sh: ERROR: could not resolve KIN_BUILD_PATH" >&2
  exit 1
fi
export KIN_BUILD_PATH

write_kin_nginx_module "${KIN_BUILD_PATH}" "${KIN_OFFICE_PREFIX}"

echo "deploy.sh: OnlyOffice Document Server: ${KIN_OFFICE_PUBLIC_URL}/ds/"
echo "deploy.sh: Direct connector: ${KIN_OFFICE_PUBLIC_URL}/direct/"
