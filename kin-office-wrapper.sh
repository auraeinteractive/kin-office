#!/bin/bash
# Wrapper script for kin-office service
# Handles docker-compose with proper error handling

set -e

KIN_OFFICE_DIR="/opt/kin/modules/kin-office"

cd "$KIN_OFFICE_DIR" || { echo "ERROR: Cannot cd to $KIN_OFFICE_DIR"; exit 1; }

# Run deploy mode first
if [[ -f "deploy.sh" ]]; then
    echo "Running deploy.sh --deploy-mode..."
    bash deploy.sh --deploy-mode 2>/dev/null || true
fi

# Start docker containers
echo "Starting kin-office containers..."
/usr/bin/docker-compose -f "$KIN_OFFICE_DIR/docker-compose.yml" up -d --wait --timeout 180

echo "kin-office started successfully"
