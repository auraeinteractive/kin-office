#!/bin/bash
# Wrapper script for kin-office service
# Handles docker compose with proper error handling

set -e

KIN_OFFICE_DIR="/opt/kin/modules/kin-office"
COMPOSE_FILE="$KIN_OFFICE_DIR/docker-compose.yml"

cd "$KIN_OFFICE_DIR" || { echo "ERROR: Cannot cd to $KIN_OFFICE_DIR"; exit 1; }

# Detect docker compose command (prefer v1 standalone with distutils)
if command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
elif docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
else
    echo "ERROR: Neither 'docker-compose' nor 'docker compose' found"
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
