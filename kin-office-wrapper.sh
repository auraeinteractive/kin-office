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

# Use absolute path for docker-compose (v1 Python or v2 compatibility)
# On this system, /usr/bin/docker-compose works (may be v1 or v2)
DOCKER_COMPOSE="/usr/bin/docker-compose"
if ! $DOCKER_COMPOSE version >/dev/null 2>&1; then
    echo "ERROR: 'docker-compose' not found at $DOCKER_COMPOSE"
    exit 1
fi

# Run deploy mode first
if [[ -f "deploy.sh" ]]; then
    echo "Running deploy.sh --deploy-mode..."
    bash deploy.sh --deploy-mode 2>/dev/null || true
fi

# Start docker containers
echo "Starting kin-office containers using: $DOCKER_COMPOSE"
$DOCKER_COMPOSE -f "$COMPOSE_FILE" up -d --wait --timeout 180

echo "kin-office started successfully"
