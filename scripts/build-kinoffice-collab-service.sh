#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="${ROOT}/services/kinoffice-collab"

make -C "${SERVICE_DIR}" clean all

echo "Built ${SERVICE_DIR}/kinoffice-collab.service"
