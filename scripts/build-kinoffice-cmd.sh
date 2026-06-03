#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CMD_DIR="${ROOT}/commands/kinoffice.cmd"

python3 "${ROOT}/scripts/generate-office-templates.py"
make -C "${CMD_DIR}" clean all

echo "Built ${CMD_DIR}/kinoffice"
