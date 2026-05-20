#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${ROOT}/.config.ini"
KIN_OFFICE_PREFIX="${KIN_OFFICE_PREFIX:-/kin-office}"
DEPLOY_MODE=0

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --deploy-mode)
            DEPLOY_MODE=1
            shift
            ;;
        *)
            echo "deploy.sh: unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# Resolve Kin config path (same logic as kincore_config_ini.h)
resolve_kin_config() {
    local cfg
    if [[ -n "${KIN_CONFIG_FILE:-}" ]]; then
        cfg="${KIN_CONFIG_FILE}"
    elif [[ -n "${HOME:-}" ]] && [[ -f "${HOME}/.local/share/kinwmgl/config.ini" ]]; then
        cfg="${HOME}/.local/share/kinwmgl/config.ini"
    elif [[ -n "${XDG_DATA_HOME:-}" ]] && [[ -f "${XDG_DATA_HOME}/kinwmgl/config.ini" ]]; then
        cfg="${XDG_DATA_HOME}/kinwmgl/config.ini"
    fi
    
    if [[ -n "${cfg:-}" ]] && [[ -f "${cfg}" ]]; then
        echo "${cfg}"
        return 0
    fi
    return 1
}

# Read OIDC config from Kin config file
read_kin_oidc_config() {
    local config_file="$1"
    local issuer client_id client_secret
    
    issuer=$(grep -E "^\s*issuer\s*=" "${config_file}" 2>/dev/null | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    client_id=$(grep -E "^\s*client_id\s*=" "${config_file}" 2>/dev/null | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    client_secret=$(grep -E "^\s*client_secret\s*=" "${config_file}" 2>/dev/null | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    
    if [[ -n "${issuer}" ]]; then
        echo "${issuer}|${client_id}|${client_secret}"
        return 0
    fi
    return 1
}

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
      echo "deploy.sh: WARNING: neither python3 nor curl found; cannot check OnlyOffice API readiness" >&2
      return 0
    fi

    now="$(date +%s)"
    if (( now - start >= timeout_seconds )); then
      echo "deploy.sh: ERROR: OnlyOffice API did not become ready within ${timeout_seconds}s (${url})" >&2
      echo "deploy.sh: ERROR: check 'docker logs onlyoffice' and that host port 5003 is reachable" >&2
      return 1
    fi
    sleep 3
  done
}

wait_for_nextcloud_occ() {
  local timeout_seconds="${1:-240}"
  local start now
  start="$(date +%s)"

  echo "deploy.sh: Waiting for Nextcloud occ to become available..."
  while true; do
    if docker exec nextcloud sh -c 'test -f /var/www/html/occ && test -f /var/www/html/console.php && test -f /var/www/html/lib/versioncheck.php' >/dev/null 2>&1 &&
       docker exec --user www-data nextcloud php occ status >/dev/null 2>&1; then
      echo "deploy.sh: Nextcloud occ is ready"
      return 0
    fi

    now="$(date +%s)"
    if (( now - start >= timeout_seconds )); then
      echo "deploy.sh: ERROR: Nextcloud occ did not become ready within ${timeout_seconds}s" >&2
      echo "deploy.sh: ERROR: check 'docker logs nextcloud' before reloading kin-office again" >&2
      return 1
    fi
    sleep 3
  done
}

ensure_nextcloud_installed() {
  local admin_user="${1:-admin}"
  local admin_password="${2:-admin}"

  if docker exec --user www-data nextcloud php occ config:system:get installed 2>/dev/null | grep -q '^true$'; then
    echo "deploy.sh: Nextcloud is already installed"
    return 0
  fi

  echo "deploy.sh: Installing Nextcloud non-interactively..."
  docker exec --user www-data nextcloud php occ maintenance:install \
    --database sqlite \
    --database-name nextcloud \
    --admin-user "${admin_user}" \
    --admin-pass "${admin_password}"
}

kin_oidc_host_looks_like_ipv4() {
  local h="${1:?}"
  [[ "${h}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]
}

maybe_write_compose_host_overlay() {
  local module_root="${1:?}"
  local host="${2:?}"
  local script="${module_root}/write-compose-host-overlay.sh"
  if [[ ! -f "${script}" ]]; then
    return 0
  fi
  if kin_oidc_host_looks_like_ipv4 "${host}"; then
    echo "deploy.sh: KIN_OIDC_HOST is an IPv4 literal; skipping write-compose-host-overlay (only DNS-like names are written to extra_hosts)."
    return 0
  fi
  if bash "${script}" "${module_root}" "${host}"; then
    echo "deploy.sh: wrote docker-compose.kin-deploy-host.yml (${host} → host-gateway for nextcloud)."
  fi
}

clear_nextcloud_bruteforce_state() {
  echo "deploy.sh: Clearing Nextcloud bruteforce counters (best-effort)..."
  local ip
  for ip in 127.0.0.1 ::1; do
    docker exec --user www-data nextcloud php occ security:bruteforce:reset "${ip}" 2>/dev/null || true
  done
  if ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' nextcloud 2>/dev/null)" && [[ -n "${ip}" ]]; then
    docker exec --user www-data nextcloud php occ security:bruteforce:reset "${ip}" 2>/dev/null || true
  fi
  if command -v hostname >/dev/null 2>&1; then
    for ip in $(hostname -I 2>/dev/null || true); do
      [[ -n "${ip}" ]] || continue
      docker exec --user www-data nextcloud php occ security:bruteforce:reset "${ip}" 2>/dev/null || true
    done
  fi
  if docker exec nextcloud sh -c 'command -v sqlite3 >/dev/null 2>&1 && test -f /var/www/html/data/nextcloud.db' >/dev/null 2>&1; then
    docker exec nextcloud sqlite3 /var/www/html/data/nextcloud.db "DELETE FROM oc_bruteforce_attempts;" 2>/dev/null || true
  fi
}

probe_oidc_discovery_from_nextcloud() {
  local uri="$1"
  docker exec nextcloud curl -fsSk --max-time 15 "${uri}" 2>/dev/null | \
    python3 -c 'import json,sys
try:
  j=json.load(sys.stdin)
except Exception:
  sys.exit(1)
sys.exit(0 if isinstance(j.get("issuer"),str) and j.get("issuer") else 1)' 2>/dev/null
}

# Pick the first discovery URL that returns JSON with issuer from inside nextcloud.
select_oidc_discovery_uri_deploy_mode() {
  local initial="${KIN_OIDC_DISCOVERY_URI:?}"
  local host="${KIN_OIDC_HOST:?}"
  local port="${KIN_OIDC_DISCOVERY_PORT:-9219}"
  local seen="|"
  local u

  for u in "${initial}" \
           "https://${host}/.well-known/openid-configuration" \
           "https://${host}:9219/.well-known/openid-configuration" \
           "https://host.docker.internal:9219/.well-known/openid-configuration" \
           "https://${host}:${port}/.well-known/openid-configuration" \
           "https://host.docker.internal:${port}/.well-known/openid-configuration"; do
    [[ -z "${u}" ]] && continue
    case "${seen}" in
      *"|${u}|"*) continue ;;
    esac
    seen+="${u}|"
    echo "deploy.sh: Probing OIDC discovery from nextcloud container: ${u}"
    if probe_oidc_discovery_from_nextcloud "${u}"; then
      export KIN_OIDC_DISCOVERY_URI="${u}"
      echo "deploy.sh: Using OIDC discovery URI: ${KIN_OIDC_DISCOVERY_URI}"
      return 0
    fi
  done

  echo "deploy.sh: WARNING: no discovery URL responded with valid OIDC JSON from nextcloud; leaving KIN_OIDC_DISCOVERY_URI=${initial}" >&2
  export KIN_OIDC_DISCOVERY_URI="${initial}"
  return 1
}

register_user_oidc_kin_strict() {
  local discovery_uri="${1:?}"
  echo "deploy.sh: Registering user_oidc provider 'kin' with discovery ${discovery_uri}..."
  docker exec --user www-data nextcloud php occ user_oidc:provider kin --delete 2>/dev/null || true
  if docker exec --user www-data nextcloud php occ user_oidc:provider kin \
      --discoveryuri="${discovery_uri}" \
      --clientid="${KIN_OIDC_CLIENT_ID}" \
      --clientsecret="${KIN_OIDC_CLIENT_SECRET}" \
      --unique-uid=0 \
      --mapping-display-name="preferred_username"; then
    echo "deploy.sh: user_oidc provider registered successfully."
    return 0
  fi
  echo "deploy.sh: ERROR: occ user_oidc:provider kin failed for discovery ${discovery_uri}" >&2
  if [[ "${KIN_OFFICE_STRICT_OIDC:-}" == "1" ]]; then
    exit 1
  fi
  return 1
}

write_kin_nginx_module() {
  local kin_build_path="$1"
  local prefix="$2"
  local module_dir="${kin_build_path}/nginx/server.d"
  local module_file="${module_dir}/kin-office.conf"
  local kin_root
  local kin_nginx_dir
  local kin_nginx_conf
  # In deploy mode, bridge.js is in /opt/kin/modules/kin-office/nginx/
  local bridge_js="${ROOT}/nginx/kin-bridge.js"
  local bridge_admin_js="${ROOT}/nginx/kin-bridge-admin.js"
  if [[ "${DEPLOY_MODE}" -eq 1 ]]; then
    bridge_js="/opt/kin/modules/kin-office/nginx/kin-bridge.js"
    bridge_admin_js="/opt/kin/modules/kin-office/nginx/kin-bridge-admin.js"
  fi

  kin_root="$(cd "${kin_build_path}/.." && pwd)"
  kin_nginx_dir="${kin_root}/nginx"
  kin_nginx_conf="${kin_nginx_dir}/nginx.conf"

  mkdir -p "${module_dir}"
  cat > "${module_file}" <<EOF
# Generated by kin-office/deploy.sh. Do not edit by hand.

location = ${prefix} {
    return 308 ${prefix}/;
}

location = ${prefix}/kin-bridge.js {
    alias ${bridge_js};
    default_type application/javascript;
    add_header Cache-Control "no-cache";
}

location = ${prefix}/kin-bridge-admin.js {
    alias ${bridge_admin_js};
    default_type application/javascript;
    add_header Cache-Control "no-cache";
}

location ^~ ${prefix}/ds/ {
    if (\$uri ~ document_editor_service_worker\\.js$) {
        default_type application/javascript;
        add_header Cache-Control "no-cache";
        return 200 'self.addEventListener("install",function(){self.skipWaiting()});self.addEventListener("activate",function(){self.clients.claim()});';
    }
    proxy_pass http://127.0.0.1:5003/;
    include snippets/proxy-common.conf;
    include snippets/proxy-websocket.conf;
    proxy_set_header X-Forwarded-Prefix ${prefix}/ds;
    proxy_set_header Accept-Encoding "";
    sub_filter_once off;
    sub_filter '</head>' '<script>document.addEventListener("keydown",function(e){try{window.parent.postMessage({type:"kinEditorKeydown",key:e.key||"",ctrlKey:!!e.ctrlKey,metaKey:!!e.metaKey,shiftKey:!!e.shiftKey,altKey:!!e.altKey},"*")}catch(_e){}});navigator.serviceWorker.getRegistrations().then(function(r){r.forEach(function(s){s.unregister()})}).catch(function(){})</script></head>';
}

location ^~ ${prefix}/direct/ {
    proxy_pass http://127.0.0.1:8000/direct/;
    include snippets/proxy-common.conf;
    include snippets/proxy-websocket.conf;
    proxy_set_header X-Forwarded-Prefix ${prefix};
    proxy_set_header Accept-Encoding "";
}

location ^~ ${prefix}/ {
    proxy_pass http://127.0.0.1:8081/;
    include snippets/proxy-common.conf;
    include snippets/proxy-websocket.conf;
    proxy_set_header X-Forwarded-Prefix ${prefix};
    proxy_set_header Accept-Encoding "";
    proxy_force_ranges on;
    proxy_cookie_path / ${prefix}/;
    proxy_cookie_flags ~ secure samesite=none;

    sub_filter_once off;
    sub_filter_types text/css application/javascript text/javascript application/json;
    sub_filter '</head>' '<script src="${prefix}/kin-bridge.js"></script></head>';
    sub_filter 'href="/core/' 'href="${prefix}/core/';
    sub_filter 'href="/apps/' 'href="${prefix}/apps/';
    sub_filter 'href="/dist/' 'href="${prefix}/dist/';
    sub_filter 'src="/core/' 'src="${prefix}/core/';
    sub_filter 'src="/apps/' 'src="${prefix}/apps/';
    sub_filter 'src="/dist/' 'src="${prefix}/dist/';
    sub_filter 'action="/index.php' 'action="${prefix}/index.php';
    sub_filter '"/core/' '"${prefix}/core/';
    sub_filter '"/apps/' '"${prefix}/apps/';
    sub_filter '"/dist/' '"${prefix}/dist/';
    sub_filter '"/ocs/' '"${prefix}/ocs/';
    sub_filter '"/index.php' '"${prefix}/index.php';
    sub_filter '"/remote.php' '"${prefix}/remote.php';
    sub_filter '"/public.php' '"${prefix}/public.php';
    sub_filter "'/core/" "'${prefix}/core/";
    sub_filter "'/apps/" "'${prefix}/apps/";
    sub_filter "'/dist/" "'${prefix}/dist/";
    sub_filter "'/ocs/" "'${prefix}/ocs/";
    sub_filter "'/index.php" "'${prefix}/index.php";
    sub_filter "'/remote.php" "'${prefix}/remote.php";
    sub_filter "'/public.php" "'${prefix}/public.php";
    sub_filter 'url(/core/' 'url(${prefix}/core/';
    sub_filter 'url(/apps/' 'url(${prefix}/apps/';
    sub_filter 'url(/dist/' 'url(${prefix}/dist/';
    sub_filter "url('/core/" "url('${prefix}/core/";
    sub_filter "url('/apps/" "url('${prefix}/apps/";
    sub_filter "url('/dist/" "url('${prefix}/dist/";
    sub_filter 'url("/core/' 'url("${prefix}/core/';
    sub_filter 'url("/apps/' 'url("${prefix}/apps/';
    sub_filter 'url("/dist/' 'url("${prefix}/dist/';

    proxy_hide_header X-Frame-Options;
    add_header X-Frame-Options "ALLOWALL" always;

    proxy_hide_header Content-Security-Policy;
    add_header Content-Security-Policy "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors *;" always;
}
EOF

  echo "deploy.sh: wrote Kin nginx module ${module_file}"

  if command -v nginx >/dev/null 2>&1 && [[ -f "${kin_nginx_conf}" ]]; then
    if nginx -t -p "${kin_nginx_dir}" -c "${kin_nginx_conf}" >/dev/null; then
      if [[ -f "${kin_nginx_dir}/logs/nginx.pid" ]]; then
        local nginx_pid
        nginx_pid="$(cat "${kin_nginx_dir}/logs/nginx.pid" 2>/dev/null || true)"
        if [[ -n "${nginx_pid}" ]] && kill -0 "${nginx_pid}" 2>/dev/null; then
          nginx -s reload -p "${kin_nginx_dir}" -c "${kin_nginx_conf}" >/dev/null
          echo "deploy.sh: reloaded Kin nginx"
        else
          echo "deploy.sh: Kin nginx is not running; module will load on next Kin deploy"
        fi
      else
        echo "deploy.sh: Kin nginx is not running; module will load on next Kin deploy"
      fi
    else
      echo "deploy.sh: WARNING: Kin nginx config test failed after writing ${module_file}" >&2
    fi
  fi
}

write_system_nginx_module() {
  local prefix="$1"
  local module_dir="/etc/nginx/kin-modules"
  local module_file="${module_dir}/kin-office.conf"
  local site_file="/etc/nginx/sites-available/kin"
  local include_line="    include /etc/nginx/kin-modules/*.conf;"
  local bridge_js="/opt/kin/modules/kin-office/nginx/kin-bridge.js"
  local bridge_admin_js="/opt/kin/modules/kin-office/nginx/kin-bridge-admin.js"

  mkdir -p "${module_dir}"
  cat > "${module_file}" <<EOF
# Generated by kin-office/deploy.sh --deploy-mode. Do not edit by hand.

location = ${prefix} {
    return 308 ${prefix}/;
}

location = ${prefix}/kin-bridge.js {
    alias ${bridge_js};
    default_type application/javascript;
    add_header Cache-Control "no-cache";
}

location = ${prefix}/kin-bridge-admin.js {
    alias ${bridge_admin_js};
    default_type application/javascript;
    add_header Cache-Control "no-cache";
}

location ^~ ${prefix}/ds/ {
    if (\$uri ~ document_editor_service_worker\\.js\$) {
        default_type application/javascript;
        add_header Cache-Control "no-cache";
        return 200 'self.addEventListener("install",function(){self.skipWaiting()});self.addEventListener("activate",function(){self.clients.claim()});';
    }
    proxy_pass http://127.0.0.1:5003/;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Port \$server_port;
    proxy_set_header X-Forwarded-Prefix ${prefix}/ds;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_buffering off;
    proxy_set_header Accept-Encoding "";
    sub_filter_once off;
    sub_filter '</head>' '<script>document.addEventListener("keydown",function(e){try{window.parent.postMessage({type:"kinEditorKeydown",key:e.key||"",ctrlKey:!!e.ctrlKey,metaKey:!!e.metaKey,shiftKey:!!e.shiftKey,altKey:!!e.altKey},"*")}catch(_e){}});navigator.serviceWorker.getRegistrations().then(function(r){r.forEach(function(s){s.unregister()})}).catch(function(){})</script></head>';
}

location ^~ ${prefix}/direct/ {
    proxy_pass http://127.0.0.1:8000/direct/;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Port \$server_port;
    proxy_set_header X-Forwarded-Prefix ${prefix};
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_buffering off;
    proxy_set_header Accept-Encoding "";
}

location ^~ ${prefix}/ {
    proxy_pass http://127.0.0.1:8081/;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Port \$server_port;
    proxy_set_header X-Forwarded-Prefix ${prefix};
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
    proxy_set_header Accept-Encoding "";
    proxy_force_ranges on;
    proxy_cookie_path / ${prefix}/;
    proxy_cookie_flags ~ secure samesite=none;

    sub_filter_once off;
    sub_filter_types text/css application/javascript text/javascript application/json;
    sub_filter '</head>' '<script src="${prefix}/kin-bridge.js"></script></head>';
    sub_filter 'href="/core/' 'href="${prefix}/core/';
    sub_filter 'href="/apps/' 'href="${prefix}/apps/';
    sub_filter 'href="/dist/' 'href="${prefix}/dist/';
    sub_filter 'src="/core/' 'src="${prefix}/core/';
    sub_filter 'src="/apps/' 'src="${prefix}/apps/';
    sub_filter 'src="/dist/' 'src="${prefix}/dist/';
    sub_filter 'action="/index.php' 'action="${prefix}/index.php';
    sub_filter '"/core/' '"${prefix}/core/';
    sub_filter '"/apps/' '"${prefix}/apps/';
    sub_filter '"/dist/' '"${prefix}/dist/';
    sub_filter '"/ocs/' '"${prefix}/ocs/';
    sub_filter '"/index.php' '"${prefix}/index.php';
    sub_filter '"/remote.php' '"${prefix}/remote.php';
    sub_filter '"/public.php' '"${prefix}/public.php';
    sub_filter "'/core/" "'${prefix}/core/";
    sub_filter "'/apps/" "'${prefix}/apps/";
    sub_filter "'/dist/" "'${prefix}/dist/";
    sub_filter "'/ocs/" "'${prefix}/ocs/";
    sub_filter "'/index.php" "'${prefix}/index.php";
    sub_filter "'/remote.php" "'${prefix}/remote.php";
    sub_filter "'/public.php" "'${prefix}/public.php";
    sub_filter 'url(/core/' 'url(${prefix}/core/';
    sub_filter 'url(/apps/' 'url(${prefix}/apps/';
    sub_filter 'url(/dist/' 'url(${prefix}/dist/';
    sub_filter "url('/core/" "url('${prefix}/core/";
    sub_filter "url('/apps/" "url('${prefix}/apps/";
    sub_filter "url('/dist/" "url('${prefix}/dist/";
    sub_filter 'url("/core/' 'url("${prefix}/core/';
    sub_filter 'url("/apps/' 'url("${prefix}/apps/';
    sub_filter 'url("/dist/' 'url("${prefix}/dist/';

    proxy_hide_header X-Frame-Options;
    add_header X-Frame-Options "ALLOWALL" always;

    proxy_hide_header Content-Security-Policy;
    add_header Content-Security-Policy "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors *;" always;
}
EOF

  if [[ -f "${site_file}" ]] && ! grep -Fq "${include_line}" "${site_file}"; then
    if grep -Eq '^[[:space:]]*client_max_body_size[[:space:]]+' "${site_file}"; then
      sed -i "\|^[[:space:]]*client_max_body_size[[:space:]]|a\\${include_line}" "${site_file}"
    elif grep -Eq '^[[:space:]]*ssl_certificate_key[[:space:]]+' "${site_file}"; then
      sed -i "\|^[[:space:]]*ssl_certificate_key[[:space:]]|a\\${include_line}" "${site_file}"
    else
      echo "deploy.sh: WARNING: could not insert nginx module include into ${site_file}" >&2
    fi
  fi

  echo "deploy.sh: wrote system nginx module ${module_file}"
  if command -v nginx >/dev/null 2>&1; then
    if nginx -t 2>/dev/null; then
      nginx -s reload 2>/dev/null || true
      echo "deploy.sh: reloaded system nginx"
    else
      echo "deploy.sh: WARNING: nginx config test failed after writing ${module_file}" >&2
    fi
  fi
}

write_kin_nginx_site() {
  local prefix="$1"
  local site_file="/etc/nginx/sites-available/kin-office"
  local bridge_js="${ROOT}/nginx/kin-bridge.js"
  local bridge_admin_js="${ROOT}/nginx/kin-bridge-admin.js"

  cat > "${site_file}" <<EOF
# Generated by kin-office/deploy.sh --deploy-mode. Do not edit by hand.

location = ${prefix} {
    return 308 ${prefix}/;
}

location = ${prefix}/kin-bridge.js {
    alias ${bridge_js};
    default_type application/javascript;
    add_header Cache-Control "no-cache";
}

location = ${prefix}/kin-bridge-admin.js {
    alias ${bridge_admin_js};
    default_type application/javascript;
    add_header Cache-Control "no-cache";
}

location ^~ ${prefix}/ds/ {
    if (\$uri ~ document_editor_service_worker\\.js\$) {
        default_type application/javascript;
        add_header Cache-Control "no-cache";
        return 200 'self.addEventListener("install",function(){self.skipWaiting()});self.addEventListener("activate",function(){self.clients.claim()});';
    }
    proxy_pass http://127.0.0.1:5003/;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Port \$server_port;
    proxy_set_header X-Forwarded-Prefix ${prefix}/ds;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_buffering off;
    proxy_set_header Accept-Encoding "";
    sub_filter_once off;
    sub_filter '</head>' '<script>document.addEventListener("keydown",function(e){try{window.parent.postMessage({type:"kinEditorKeydown",key:e.key||"",ctrlKey:!!e.ctrlKey,metaKey:!!e.metaKey,shiftKey:!!e.shiftKey,altKey:!!e.altKey},"*")}catch(_e){}});navigator.serviceWorker.getRegistrations().then(function(r){r.forEach(function(s){s.unregister()})}).catch(function(){})</script></head>';
}

location ^~ ${prefix}/direct/ {
    proxy_pass http://127.0.0.1:8000/direct/;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Port \$server_port;
    proxy_set_header X-Forwarded-Prefix ${prefix};
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_buffering off;
    proxy_set_header Accept-Encoding "";
}

location ^~ ${prefix}/ {
    proxy_pass http://127.0.0.1:8081/;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Port \$server_port;
    proxy_set_header X-Forwarded-Prefix ${prefix};
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
    proxy_set_header Accept-Encoding "";
    proxy_force_ranges on;
    proxy_cookie_path / ${prefix}/;
    proxy_cookie_flags ~ secure samesite=none;

    sub_filter_once off;
    sub_filter_types text/css application/javascript text/javascript application/json;
    sub_filter '</head>' '<script src="${prefix}/kin-bridge.js"></script></head>';
    sub_filter 'href="/core/' 'href="${prefix}/core/';
    sub_filter 'href="/apps/' 'href="${prefix}/apps/';
    sub_filter 'href="/dist/' 'href="${prefix}/dist/';
    sub_filter 'src="/core/' 'src="${prefix}/core/';
    sub_filter 'src="/apps/' 'src="${prefix}/apps/';
    sub_filter 'src="/dist/' 'src="${prefix}/dist/';
    sub_filter 'action="/index.php' 'action="${prefix}/index.php';
    sub_filter '"/core/' '"${prefix}/core/';
    sub_filter '"/apps/' '"${prefix}/apps/';
    sub_filter '"/dist/' '"${prefix}/dist/';
    sub_filter '"/ocs/' '"${prefix}/ocs/';
    sub_filter '"/index.php' '"${prefix}/index.php';
    sub_filter '"/remote.php' '"${prefix}/remote.php';
    sub_filter '"/public.php' '"${prefix}/public.php';
    sub_filter "'/core/" "'${prefix}/core/";
    sub_filter "'/apps/" "'${prefix}/apps/";
    sub_filter "'/dist/" "'${prefix}/dist/";
    sub_filter "'/ocs/" "'${prefix}/ocs/";
    sub_filter "'/index.php" "'${prefix}/index.php";
    sub_filter "'/remote.php" "'${prefix}/remote.php";
    sub_filter "'/public.php" "'${prefix}/public.php";
    sub_filter 'url(/core/' 'url(${prefix}/core/';
    sub_filter 'url(/apps/' 'url(${prefix}/apps/';
    sub_filter 'url(/dist/' 'url(${prefix}/dist/';
    sub_filter "url('/core/" "url('${prefix}/core/";
    sub_filter "url('/apps/" "url('${prefix}/apps/";
    sub_filter "url('/dist/" "url('${prefix}/dist/";
    sub_filter 'url("/core/' 'url("${prefix}/core/';
    sub_filter 'url("/apps/' 'url("${prefix}/apps/';
    sub_filter 'url("/dist/' 'url("${prefix}/dist/';

    proxy_hide_header X-Frame-Options;
    add_header X-Frame-Options "ALLOWALL" always;

    proxy_hide_header Content-Security-Policy;
    add_header Content-Security-Policy "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors *;" always;
}
EOF

  # Enable the site if sites-enabled exists
  if [[ -d "/etc/nginx/sites-enabled" ]]; then
    ln -sf "${site_file}" "/etc/nginx/sites-enabled/kin-office"
  fi

  echo "deploy.sh: wrote nginx site ${site_file}"

  # Test and reload system nginx
  if command -v nginx >/dev/null 2>&1; then
    if nginx -t 2>/dev/null; then
      nginx -s reload 2>/dev/null || true
      echo "deploy.sh: reloaded system nginx"
    else
      echo "deploy.sh: WARNING: nginx config test failed" >&2
    fi
  fi
}

# Deploy mode: read hostname from /etc/kin/config.ini, expect Kin on port 443
if [[ "${DEPLOY_MODE}" -eq 1 ]]; then
    KIN_CONFIG_FILE="/etc/kin/config.ini"
    if [[ ! -f "${KIN_CONFIG_FILE}" ]]; then
        echo "deploy.sh: ERROR: Deploy mode requires ${KIN_CONFIG_FILE}" >&2
        exit 1
    fi
    KIN_OIDC_HOST=$(grep -E "^\s*hostname\s*=" "${KIN_CONFIG_FILE}" 2>/dev/null | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    if [[ -z "${KIN_OIDC_HOST}" ]]; then
        echo "deploy.sh: ERROR: [KinCore] hostname= not set in ${KIN_CONFIG_FILE}" >&2
        exit 1
    fi
    echo "deploy.sh: Deploy mode: using hostname=${KIN_OIDC_HOST} (port 443)"
    KIN_OFFICE_PREFIX="$(normalize_prefix "${KIN_OFFICE_PREFIX}")"
    if [[ -z "${KIN_OFFICE_PREFIX}" ]]; then
        echo "deploy.sh: ERROR: KIN_OFFICE_PREFIX must not be /" >&2
        exit 1
    fi
    KIN_PUBLIC_BASE_URL="https://${KIN_OIDC_HOST}"
    KIN_OFFICE_PUBLIC_URL="${KIN_PUBLIC_BASE_URL}${KIN_OFFICE_PREFIX}"
    NEXTCLOUD_ADMIN_USER="${NEXTCLOUD_ADMIN_USER:-admin}"
    NEXTCLOUD_ADMIN_PASSWORD="${NEXTCLOUD_ADMIN_PASSWORD:-K1nNextcloud2024!}"
    KIN_OIDC_DISCOVERY_URI="${KIN_PUBLIC_BASE_URL}/.well-known/openid-configuration"
    KIN_OIDC_CLIENT_ID="kin-nextcloud"
    KIN_OIDC_CLIENT_SECRET="kin-nextcloud-secret"
    if KIN_OIDC_CONFIG=$(read_kin_oidc_config "${KIN_CONFIG_FILE}" 2>/dev/null); then
        IFS='|' read -r cfg_issuer cfg_client_id cfg_client_secret <<< "${KIN_OIDC_CONFIG}"
        if [[ -n "${cfg_issuer}" ]]; then
            KIN_OIDC_DISCOVERY_URI="${cfg_issuer%/}/.well-known/openid-configuration"
        fi
        if [[ -n "${cfg_client_id}" ]]; then
            KIN_OIDC_CLIENT_ID="${cfg_client_id}"
        fi
        if [[ -n "${cfg_client_secret}" ]]; then
            KIN_OIDC_CLIENT_SECRET="${cfg_client_secret}"
        fi
    fi
    export KIN_OIDC_HOST
    export KIN_OFFICE_PREFIX
    export KIN_PUBLIC_BASE_URL
    export KIN_OFFICE_PUBLIC_URL
    export NEXTCLOUD_ADMIN_USER
    export NEXTCLOUD_ADMIN_PASSWORD
    export KIN_OIDC_DISCOVERY_URI

    # Start Docker containers with network-callable hostname
    cd "${ROOT}"
    export KIN_OIDC_HOST
    maybe_write_compose_host_overlay "${ROOT}" "${KIN_OIDC_HOST}"

    if docker compose version >/dev/null 2>&1; then
        DOCKER_COMPOSE="docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then
        DOCKER_COMPOSE="docker-compose"
    else
        echo "deploy.sh: ERROR: docker compose not found" >&2
        exit 1
    fi

    compose_args=(-f docker-compose.yml)
    if [[ -f docker-compose.direct.yml ]]; then
        compose_args+=(-f docker-compose.direct.yml)
    fi
    if [[ -f docker-compose.kin-deploy-host.yml ]]; then
        compose_args+=(-f docker-compose.kin-deploy-host.yml)
    fi

    if [[ "${KIN_OFFICE_SKIP_COMPOSE_UP:-}" == "1" ]]; then
        echo "deploy.sh: KIN_OFFICE_SKIP_COMPOSE_UP=1 — skipping docker compose up (containers assumed running)."
    else
        if [[ -f docker-compose.direct.yml ]]; then
            $DOCKER_COMPOSE "${compose_args[@]}" up -d --build --wait --timeout 180 nextcloud onlyoffice onlyoffice-direct
        else
            $DOCKER_COMPOSE "${compose_args[@]}" up -d --wait --timeout 180 nextcloud onlyoffice
        fi
    fi

    wait_for_nextcloud_occ
    ensure_nextcloud_installed "${NEXTCLOUD_ADMIN_USER}" "${NEXTCLOUD_ADMIN_PASSWORD}"

    # Enable .htaccess processing and bake the subpath into Nextcloud's rewrite base.
    echo "deploy.sh: Enabling Nextcloud subpath routing for ${KIN_OFFICE_PREFIX}..."
    docker exec nextcloud sed -i 's/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:system:set htaccess.RewriteBase --value "${KIN_OFFICE_PREFIX}" 2>/dev/null || true
    docker exec --user www-data nextcloud php occ maintenance:update:htaccess 2>/dev/null || true
    docker exec nextcloud apache2ctl graceful 2>/dev/null || true

    # Configure Nextcloud with the network-callable hostname (port 443)
    echo "deploy.sh: Configuring Nextcloud for ${KIN_OIDC_HOST}..."
    docker exec --user www-data nextcloud php occ config:system:set trusted_proxies 0 --value "0.0.0.0/0" 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:system:set overwriteprotocol --value "https" 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:system:set overwritehost --value "${KIN_OIDC_HOST}" 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:system:set overwritewebroot --value "${KIN_OFFICE_PREFIX}" 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:system:set overwrite.cli.url --value "${KIN_OFFICE_PUBLIC_URL}" 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:system:set trusted_domains 0 --value="*" 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:system:set allow_local_remote_servers --type boolean --value true 2>/dev/null || true

    # Configure Kin OIDC login for deployed installs. This must happen after
    # Nextcloud is installed; otherwise occ app/provider commands are ignored.
    echo "deploy.sh: Installing/enabling user_oidc app..."
    docker exec --user www-data nextcloud php occ app:install user_oidc 2>/dev/null || true
    docker exec --user www-data nextcloud php occ app:enable user_oidc 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:system:set user_oidc httpclient.allowselfsigned --type boolean --value true 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:system:set user_oidc prompt --type string --value none 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:app:set --type=string --value=0 user_oidc allow_multiple_user_backends 2>/dev/null || true

    clear_nextcloud_bruteforce_state
    select_oidc_discovery_uri_deploy_mode || true
    clear_nextcloud_bruteforce_state
    register_user_oidc_kin_strict "${KIN_OIDC_DISCOVERY_URI}" || true
    if [[ -n "${KIN_NEXTCLOUD_ADMIN_USER:-}" ]]; then
        echo "deploy.sh: Adding ${KIN_NEXTCLOUD_ADMIN_USER} to Nextcloud admin group..."
        docker exec --user www-data nextcloud php occ group:adduser admin "${KIN_NEXTCLOUD_ADMIN_USER}" 2>/dev/null || true
    fi

    # Configure OnlyOffice for browser access through Kin nginx and internal container callbacks.
    echo "deploy.sh: Installing/enabling OnlyOffice app..."
    docker exec --user www-data nextcloud php occ app:install onlyoffice 2>/dev/null || true
    docker exec --user www-data nextcloud php occ app:enable onlyoffice 2>/dev/null || true
    ONLYOFFICE_URL="${KIN_OFFICE_PUBLIC_URL}/ds/"
    echo "deploy.sh: Configuring OnlyOffice DocumentServerUrl to ${ONLYOFFICE_URL}..."
    docker exec --user www-data nextcloud php occ config:app:set onlyoffice DocumentServerUrl --value="${ONLYOFFICE_URL}" 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:app:set onlyoffice DocumentServerInternalUrl --value="http://onlyofficedocs/" 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:app:set onlyoffice StorageUrl --value="http://nextcloud/" 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:app:set onlyoffice verify_peer_off --value="true" 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:app:delete onlyoffice jwt_secret 2>/dev/null || true
    docker exec --user www-data nextcloud php occ config:app:delete onlyoffice settings_error 2>/dev/null || true
    docker exec onlyoffice python3 -c "
import json
p = '/etc/onlyoffice/documentserver/local.json'
with open(p) as f: c = json.load(f)
rd = c.setdefault('services',{}).setdefault('CoAuthoring',{}).get('requestDefaults',{})
safe_urls = list(rd.get('safeUrls', []))
if 'http://onlyoffice-direct:8000/' not in safe_urls:
    safe_urls.append('http://onlyoffice-direct:8000/')
if rd.get('rejectUnauthorized') is not False or 'onlyoffice-direct:8000' not in str(rd.get('safeUrls', [])):
    c['services']['CoAuthoring']['requestDefaults'] = dict(rd, rejectUnauthorized=False, safeUrls=safe_urls)
    with open(p,'w') as f: json.dump(c,f,indent=2)
    print('  Updated local.json (rejectUnauthorized=false, safeUrls includes onlyoffice-direct)')
else:
    print('  local.json already has rejectUnauthorized=false')
" 2>/dev/null || true
    docker exec onlyoffice supervisorctl restart ds:docservice ds:converter 2>/dev/null || true
    wait_for_onlyoffice_api

    # Write nginx config into the system nginx site used by packaged Kin on port 443.
    write_system_nginx_module "${KIN_OFFICE_PREFIX}"
    
    echo "deploy.sh: Deploy mode: nginx config written for ${KIN_OFFICE_PUBLIC_URL}"
    echo "deploy.sh: Access Nextcloud at ${KIN_OFFICE_PUBLIC_URL}/"
    exit 0
fi

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "deploy.sh: ${CONFIG_FILE} not found." >&2
  echo "deploy.sh: create it (see .env.example for hints) and set at least:" >&2
  echo "  KIN_OIDC_HOST" >&2
  exit 1
fi

# Try to read OIDC config from Kin config file (for the issuer)
KIN_CONFIG_PATH=""
KIN_OIDC_CONFIG=""
if KIN_CONFIG_PATH=$(resolve_kin_config 2>/dev/null); then
    if KIN_OIDC_CONFIG=$(read_kin_oidc_config "${KIN_CONFIG_PATH}" 2>/dev/null); then
        echo "deploy.sh: Found OIDC config in ${KIN_CONFIG_PATH}"
    fi
fi

export KIN_OIDC_HOST

# Use KIN_OIDC_HOST from kin-office config, but warn if it differs from Kin config
KIN_OIDC_HOST_FILE="$(optional_key KIN_OIDC_HOST)"
if [[ -z "${KIN_OIDC_HOST_FILE}" ]] && [[ -n "${KIN_OIDC_CONFIG}" ]]; then
    # No KIN_OIDC_HOST in kin-office config, extract issuer from Kin config
    IFS='|' read -r cfg_issuer cfg_client_id cfg_client_secret <<< "${KIN_OIDC_CONFIG}"
    # Extract hostname from issuer URL (remove https:// prefix and trailing port/path)
    KIN_OIDC_HOST="$(echo "${cfg_issuer}" | sed -E 's|https://||' | sed -E 's|:9219.*||')"
    echo "deploy.sh: Using KIN_OIDC_HOST from Kin config: ${KIN_OIDC_HOST}"
else
    KIN_OIDC_HOST="${KIN_OIDC_HOST_FILE}"
fi

if [[ -z "${KIN_OIDC_HOST}" ]]; then
  # Auto-detect primary IP address
  KIN_OIDC_HOST=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [[ -z "${KIN_OIDC_HOST}" ]]; then
    echo "deploy.sh: ERROR: Could not auto-detect IP address" >&2
    exit 1
  fi
  echo "deploy.sh: Using auto-detected IP: ${KIN_OIDC_HOST}"
fi

KIN_OFFICE_PREFIX="$(normalize_prefix "${KIN_OFFICE_PREFIX}")"
if [[ -z "${KIN_OFFICE_PREFIX}" ]]; then
  echo "deploy.sh: ERROR: KIN_OFFICE_PREFIX must not be /" >&2
  exit 1
fi
export KIN_OFFICE_PREFIX

if ! KIN_BUILD_PATH="$(resolve_kin_build_path)"; then
  echo "deploy.sh: ERROR: could not resolve KIN_BUILD_PATH. Build Kin first or set KIN_BUILD_PATH in ${CONFIG_FILE}." >&2
  exit 1
fi
export KIN_BUILD_PATH

KIN_PUBLIC_BASE_URL="https://${KIN_OIDC_HOST}:9219"
KIN_OFFICE_PUBLIC_URL="${KIN_PUBLIC_BASE_URL}${KIN_OFFICE_PREFIX}"
write_kin_nginx_module "${KIN_BUILD_PATH}" "${KIN_OFFICE_PREFIX}"

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

# LAN dev: default discovery on Kin TLS :9219. Override with KIN_OIDC_DISCOVERY_PORT or Kin [OIDC] issuer.
if [[ -n "${KIN_OIDC_DISCOVERY_PORT:-}" ]]; then
    export KIN_OIDC_DISCOVERY_URI="https://${KIN_OIDC_HOST}:${KIN_OIDC_DISCOVERY_PORT}/.well-known/openid-configuration"
else
    export KIN_OIDC_DISCOVERY_URI="https://${KIN_OIDC_HOST}:9219/.well-known/openid-configuration"
fi

# Get client_id and client_secret from Kin config, or use defaults
KIN_OIDC_CLIENT_ID="kin-nextcloud"
KIN_OIDC_CLIENT_SECRET="kin-nextcloud-secret"
if [[ -n "${KIN_OIDC_CONFIG}" ]]; then
    IFS='|' read -r cfg_issuer cfg_client_id cfg_client_secret <<< "${KIN_OIDC_CONFIG}"
    if [[ -n "${cfg_issuer}" ]]; then
        export KIN_OIDC_DISCOVERY_URI="${cfg_issuer%/}/.well-known/openid-configuration"
    fi
    if [[ -n "${cfg_client_id}" ]]; then
        KIN_OIDC_CLIENT_ID="${cfg_client_id}"
    fi
    if [[ -n "${cfg_client_secret}" ]]; then
        KIN_OIDC_CLIENT_SECRET="${cfg_client_secret}"
    fi
fi

cd "${ROOT}"

if [[ "${RESTART_MODE}" == true ]]; then
    docker compose restart
    exit 0
fi

maybe_write_compose_host_overlay "${ROOT}" "${KIN_OIDC_HOST}"

if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
else
    echo "deploy.sh: ERROR: docker compose not found" >&2
    exit 1
fi

compose_args=(-f docker-compose.yml)
if [[ -f docker-compose.direct.yml ]]; then
  compose_args+=(-f docker-compose.direct.yml)
fi
if [[ -f docker-compose.kin-deploy-host.yml ]]; then
  compose_args+=(-f docker-compose.kin-deploy-host.yml)
fi

if [[ -f docker-compose.direct.yml ]]; then
  $DOCKER_COMPOSE "${compose_args[@]}" up -d --build --wait --timeout 180 nextcloud onlyoffice onlyoffice-direct
else
  $DOCKER_COMPOSE "${compose_args[@]}" up -d --build --wait --timeout 180 nextcloud onlyoffice
fi

wait_for_nextcloud_occ

echo "deploy.sh: Enabling .htaccess processing..."
docker exec nextcloud sed -i 's/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:system:set htaccess.RewriteBase --value "${KIN_OFFICE_PREFIX}" 2>/dev/null || true
docker exec --user www-data nextcloud php occ maintenance:update:htaccess 2>/dev/null || true
docker exec nextcloud apache2ctl graceful 2>/dev/null || true

export KIN_NEXTCLOUD_ADMIN_USER
KIN_NEXTCLOUD_ADMIN_USER="$(optional_key KIN_NEXTCLOUD_ADMIN_USER)"
if [[ -z "${KIN_NEXTCLOUD_ADMIN_USER}" ]]; then
  echo ""
  echo "Which Kin user should be Nextcloud admin?"
  echo "Enter the username (e.g. hogne):"
  read -r KIN_NEXTCLOUD_ADMIN_USER
  if [[ -z "${KIN_NEXTCLOUD_ADMIN_USER}" ]]; then
    echo "deploy.sh: ERROR: No Kin admin user specified" >&2
    exit 1
  fi
  echo "KIN_NEXTCLOUD_ADMIN_USER=${KIN_NEXTCLOUD_ADMIN_USER}" >> "${CONFIG_FILE}"
  echo "deploy.sh: Added KIN_NEXTCLOUD_ADMIN_USER to ${CONFIG_FILE}"
else
  echo "deploy.sh: Using configured Kin admin user: ${KIN_NEXTCLOUD_ADMIN_USER}"
fi

KIN_OIDC_CLIENT_SECRET="${KIN_OIDC_CLIENT_SECRET:-kin-nextcloud-secret}"

echo "deploy.sh: Configuring Nextcloud OIDC (Kin host ${KIN_OIDC_HOST}, discovery ${KIN_OIDC_DISCOVERY_URI})..."

echo "deploy.sh: Setting proxy trust..."
KIN_PROXY_IP=""
if KIN_PROXY_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' nextcloud 2>/dev/null) && [ -n "${KIN_PROXY_IP}" ]; then
  docker exec --user www-data nextcloud php occ config:system:set trusted_proxies 0 --value "${KIN_PROXY_IP}" 2>/dev/null || true
  echo "deploy.sh: trusted_proxies[0]=${KIN_PROXY_IP} (Kin host nginx)"
else
  docker exec --user www-data nextcloud php occ config:system:set trusted_proxies 0 --value "172.16.0.0/12" 2>/dev/null || true
  echo "deploy.sh: WARNING: could not read Docker gateway IP; trusted_proxies set to 172.16.0.0/12" >&2
fi
docker exec --user www-data nextcloud php occ config:system:set overwriteprotocol --value "https" 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:system:set overwritehost --value "${KIN_OIDC_HOST}:9219" 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:system:set overwritewebroot --value "${KIN_OFFICE_PREFIX}" 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:system:set overwrite.cli.url --value "${KIN_OFFICE_PUBLIC_URL}" 2>/dev/null || true

echo "deploy.sh: Setting trusted domains (LAN/dev)..."
docker exec --user www-data nextcloud php occ config:system:set trusted_domains 0 --value="*" 2>/dev/null || true

echo "deploy.sh: Allowing local remote servers..."
docker exec --user www-data nextcloud php occ config:system:set allow_local_remote_servers --type boolean --value true 2>/dev/null || true

echo "deploy.sh: Configuring user_oidc settings..."
docker exec --user www-data nextcloud php occ config:system:set user_oidc httpclient.allowselfsigned --type boolean --value true 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:system:set user_oidc prompt --type string --value none 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:app:set --type=string --value=0 user_oidc allow_multiple_user_backends 2>/dev/null || true

echo "deploy.sh: Installing/enabling user_oidc app..."
docker exec --user www-data nextcloud php occ app:install user_oidc 2>/dev/null || true
docker exec --user www-data nextcloud php occ app:enable user_oidc 2>/dev/null || true

clear_nextcloud_bruteforce_state
select_oidc_discovery_uri_deploy_mode || true
clear_nextcloud_bruteforce_state
register_user_oidc_kin_strict "${KIN_OIDC_DISCOVERY_URI}" || true

echo "deploy.sh: Adding ${KIN_NEXTCLOUD_ADMIN_USER} to Nextcloud admin group..."
docker exec --user www-data nextcloud php occ group:adduser admin "${KIN_NEXTCLOUD_ADMIN_USER}" 2>/dev/null || true
USER_GROUPS=$(docker exec --user www-data nextcloud php occ user:info "${KIN_NEXTCLOUD_ADMIN_USER}" 2>/dev/null | grep -A10 "groups:" || true)
if echo "${USER_GROUPS}" | grep -q "admin"; then
  echo "deploy.sh: ${KIN_NEXTCLOUD_ADMIN_USER} is in admin group"
else
  echo "deploy.sh: WARNING: ${KIN_NEXTCLOUD_ADMIN_USER} may not be in admin group yet (user might not exist until first OIDC login)"
fi

echo "deploy.sh: Installing OnlyOffice app..."
docker exec --user www-data nextcloud php occ app:install onlyoffice 2>/dev/null || true
docker exec --user www-data nextcloud php occ app:enable onlyoffice 2>/dev/null || true

ONLYOFFICE_URL="${KIN_OFFICE_PUBLIC_URL}/ds/"
echo "deploy.sh: Configuring OnlyOffice DocumentServerUrl to ${ONLYOFFICE_URL}..."
docker exec --user www-data nextcloud php occ config:app:set onlyoffice DocumentServerUrl --value="${ONLYOFFICE_URL}" 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:app:set onlyoffice DocumentServerInternalUrl --value="http://onlyofficedocs/" 2>/dev/null || true
echo "deploy.sh: OnlyOffice StorageUrl (DS→Nextcloud) and verify_peer_off (dev/TLS)..."
docker exec --user www-data nextcloud php occ config:app:set onlyoffice StorageUrl --value="http://nextcloud/" 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:app:set onlyoffice verify_peer_off --value="true" 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:app:delete onlyoffice jwt_secret 2>/dev/null || true
docker exec --user www-data nextcloud php occ config:app:delete onlyoffice settings_error 2>/dev/null || true

echo "deploy.sh: Configuring Document Server to accept self-signed certificates..."
docker exec onlyoffice python3 -c "
import json, sys
p = '/etc/onlyoffice/documentserver/local.json'
with open(p) as f: c = json.load(f)
rd = c.setdefault('services',{}).setdefault('CoAuthoring',{}).get('requestDefaults',{})
safe_urls = list(rd.get('safeUrls', []))
if 'http://onlyoffice-direct:8000/' not in safe_urls:
    safe_urls.append('http://onlyoffice-direct:8000/')
if rd.get('rejectUnauthorized') is not False or 'onlyoffice-direct:8000' not in str(rd.get('safeUrls', [])):
    c['services']['CoAuthoring']['requestDefaults'] = dict(rd, rejectUnauthorized=False, safeUrls=safe_urls)
    with open(p,'w') as f: json.dump(c,f,indent=2)
    print('  Updated local.json (rejectUnauthorized=false, safeUrls includes onlyoffice-direct)')
else:
    print('  local.json already has rejectUnauthorized=false')
" 2>/dev/null || true
docker exec onlyoffice supervisorctl restart ds:docservice ds:converter 2>/dev/null || true

write_kin_nginx_module "${KIN_BUILD_PATH}" "${KIN_OFFICE_PREFIX}"

echo "deploy.sh: OIDC configuration complete."
echo ""
echo "OnlyOffice Document Server is configured at ${ONLYOFFICE_URL}"
