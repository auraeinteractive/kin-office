#!/bin/bash
# Wrapper script for kin-office service
# Handles docker compose with proper error handling

set -e

KIN_OFFICE_DIR="/opt/kin/modules/kin-office"
COMPOSE_FILE="$KIN_OFFICE_DIR/docker-compose.yml"

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

# Use docker compose v2 (plugin) - the official/recommended way
if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: 'docker compose' (v2) not found. Install docker compose plugin."
    exit 1
fi
DOCKER_COMPOSE="docker compose"
echo "Using: $DOCKER_COMPOSE"

# Run deploy mode first
if [[ -f "deploy.sh" ]]; then
    echo "Running deploy.sh --deploy-mode..."
    bash deploy.sh --deploy-mode 2>/dev/null || true
fi

# Pull images first (shows download progress; first run downloads ~5GB)
echo "Checking/pulling container images (first run may take several minutes)..."
$DOCKER_COMPOSE -f "$COMPOSE_FILE" pull 2>&1

# Start docker containers
echo "Starting kin-office containers..."
$DOCKER_COMPOSE -f "$COMPOSE_FILE" up -d --wait --timeout 180

echo "kin-office started successfully"
