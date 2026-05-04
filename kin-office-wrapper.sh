#!/bin/bash
# Wrapper script for kin-office service.
# Handles docker compose with proper error handling and preserves Nextcloud config.

set -euo pipefail

KIN_OFFICE_DIR="/opt/kin/modules/kin-office"
COMPOSE_FILE="$KIN_OFFICE_DIR/docker-compose.yml"
COMPOSE_DIRECT_FILE="$KIN_OFFICE_DIR/docker-compose.direct.yml"
STATE_DIR="/var/lib/kin-office"
NEXTCLOUD_CONFIG_BACKUP="$STATE_DIR/nextcloud-config"
ACTION="${1:-start}"

cd "$KIN_OFFICE_DIR" || { echo "ERROR: Cannot cd to $KIN_OFFICE_DIR"; exit 1; }

# Read hostname from /etc/kin/config.ini for deploy mode
KIN_CONFIG_FILE="/etc/kin/config.ini"
if [[ -f "$KIN_CONFIG_FILE" ]]; then
    KIN_OIDC_HOST=$(grep -E "^\s*hostname\s*=" "$KIN_CONFIG_FILE" 2>/dev/null | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    if [[ -n "$KIN_OIDC_HOST" ]]; then
        echo "Using hostname from $KIN_CONFIG_FILE: $KIN_OIDC_HOST"
        export KIN_OIDC_HOST
    fi
fi
export KIN_OFFICE_PREFIX="${KIN_OFFICE_PREFIX:-/kin-office}"

# Use docker compose v2 (plugin) - the official/recommended way
if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: 'docker compose' (v2) not found. Install docker compose plugin."
    exit 1
fi
DOCKER_COMPOSE="docker compose"
echo "Using: $DOCKER_COMPOSE"
COMPOSE_ARGS=(-f "$COMPOSE_FILE")
if [[ -f "$COMPOSE_DIRECT_FILE" ]]; then
    COMPOSE_ARGS+=(-f "$COMPOSE_DIRECT_FILE")
fi

backup_nextcloud_config() {
    if ! docker container inspect nextcloud >/dev/null 2>&1; then
        return 0
    fi

    mkdir -p "$NEXTCLOUD_CONFIG_BACKUP"
    chmod 700 "$STATE_DIR" "$NEXTCLOUD_CONFIG_BACKUP"
    if docker cp nextcloud:/var/www/html/config/. "$NEXTCLOUD_CONFIG_BACKUP/" 2>/dev/null &&
       [[ -f "$NEXTCLOUD_CONFIG_BACKUP/config.php" ]]; then
        chmod -R go-rwx "$STATE_DIR"
        echo "Backed up Nextcloud config to $NEXTCLOUD_CONFIG_BACKUP"
    fi
}

restore_nextcloud_config() {
    if [[ ! -f "$NEXTCLOUD_CONFIG_BACKUP/config.php" ]]; then
        return 0
    fi
    if ! docker container inspect nextcloud >/dev/null 2>&1; then
        return 0
    fi
    if docker exec nextcloud test -f /var/www/html/config/config.php >/dev/null 2>&1; then
        return 0
    fi

    echo "Restoring Nextcloud config from $NEXTCLOUD_CONFIG_BACKUP"
    docker exec nextcloud mkdir -p /var/www/html/config >/dev/null 2>&1 || true
    docker cp "$NEXTCLOUD_CONFIG_BACKUP/." nextcloud:/var/www/html/config/
    docker exec nextcloud chown -R www-data:www-data /var/www/html/config >/dev/null 2>&1 || true
}

start_containers() {
    local services=(nextcloud onlyoffice)
    if [[ -f "$COMPOSE_DIRECT_FILE" ]]; then
        services+=(onlyoffice-direct)
    fi

    echo "Starting kin-office containers..."
    $DOCKER_COMPOSE "${COMPOSE_ARGS[@]}" up -d --build --wait --timeout 180 "${services[@]}"
}

case "$ACTION" in
    start)
        ;;
    stop)
        echo "Stopping kin-office containers..."
        $DOCKER_COMPOSE "${COMPOSE_ARGS[@]}" stop
        exit 0
        ;;
    *)
        echo "ERROR: unknown action: $ACTION" >&2
        exit 1
        ;;
esac

backup_nextcloud_config
start_containers
restore_nextcloud_config

# deploy.sh --deploy-mode applies runtime config after containers are running.
if [[ -f "deploy.sh" ]]; then
    echo "Running deploy.sh --deploy-mode..."
    bash deploy.sh --deploy-mode
else
    echo "deploy.sh not found; skipping runtime configuration"
fi

echo "kin-office started successfully"
