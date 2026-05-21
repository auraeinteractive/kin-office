#!/bin/bash
# Wrapper script for kin-office service (OnlyOffice Document Server + direct connector).

set -euo pipefail

KIN_OFFICE_DIR="/opt/kin/modules/kin-office"
COMPOSE_FILE="$KIN_OFFICE_DIR/docker-compose.yml"
ACTION="${1:-start}"

cd "$KIN_OFFICE_DIR" || { echo "ERROR: Cannot cd to $KIN_OFFICE_DIR"; exit 1; }

export KIN_OFFICE_PREFIX="${KIN_OFFICE_PREFIX:-/kin-office}"

if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE=(docker-compose)
else
    echo "ERROR: Neither 'docker compose' (v2 plugin) nor 'docker-compose' found." >&2
    exit 1
fi
echo "Using: ${DOCKER_COMPOSE[*]}"
COMPOSE_ARGS=(-f "$COMPOSE_FILE")

start_containers() {
    local services=(onlyoffice onlyoffice-direct)

    echo "Starting kin-office containers (first start may pull large images; see journalctl -u kin-office -f)..."
    if [[ "${DOCKER_COMPOSE[0]}" == "docker" && "${DOCKER_COMPOSE[1]}" == "compose" ]]; then
        "${DOCKER_COMPOSE[@]}" "${COMPOSE_ARGS[@]}" up -d --build --wait --timeout 180 "${services[@]}"
    else
        echo "WARNING: using docker-compose without --wait; containers may still be starting."
        "${DOCKER_COMPOSE[@]}" "${COMPOSE_ARGS[@]}" up -d --build "${services[@]}"
    fi
}

case "$ACTION" in
    start)
        ;;
    stop)
        echo "Stopping kin-office containers..."
        "${DOCKER_COMPOSE[@]}" "${COMPOSE_ARGS[@]}" stop
        exit 0
        ;;
    *)
        echo "ERROR: unknown action: $ACTION" >&2
        exit 1
        ;;
esac

start_containers

if [[ -f "deploy.sh" ]]; then
    echo "Running deploy.sh --deploy-mode..."
    export KIN_OFFICE_SKIP_COMPOSE_UP=1
    bash deploy.sh --deploy-mode
else
    echo "deploy.sh not found; skipping runtime configuration"
fi

echo "kin-office started successfully"
