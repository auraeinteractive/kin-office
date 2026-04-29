#!/bin/bash
# Wrapper script for kin-office service
# Handles docker compose with proper error handling

set -e

KIN_OFFICE_DIR="/opt/kin/modules/kin-office"
COMPOSE_FILE="$KIN_OFFICE_DIR/docker-compose.yml"

cd "$KIN_OFFICE_DIR" || { echo "ERROR: Cannot cd to $KIN_OFFICE_DIR"; exit 1; }

# Use docker compose v2 (Go plugin) - works reliably
# docker-compose v1 (Python) has distutils issues on newer Ubuntu
if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: 'docker compose' (v2) not found. Install docker.io >= 20.10"
    exit 1
fi
DOCKER_COMPOSE="docker compose"

# Run deploy mode first
if [[ -f "deploy.sh" ]]; then
    echo "Running deploy.sh --deploy-mode..."
    bash deploy.sh --deploy-mode 2>/dev/null || true
fi

# Start docker containers
echo "Starting kin-office containers using: $DOCKER_COMPOSE"
$DOCKER_COMPOSE -f "$COMPOSE_FILE" up -d --wait --timeout 180

echo "kin-office started successfully"
