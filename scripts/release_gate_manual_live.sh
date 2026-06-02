#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Legacy note:
# The old implementation was `python3 server/scripts/release_gate_manual_live.py` (FastAPI/Celery).
# server/ is retired as the "current backend". This script now gates the TypeScript backend HTTP shell surface.

API_PORT="${API_PORT:-8000}"
MAX_WAIT_SECS="${MAX_WAIT_SECS:-120}"
POLL_INTERVAL_SECS="${POLL_INTERVAL_SECS:-2}"
GATE_BASE_URL="${GATE_BASE_URL:-http://127.0.0.1:${API_PORT}}"

echo "[release_gate_manual_live] base_url=${GATE_BASE_URL}"

echo "[release_gate_manual_live] running CI light gates first"
"$REPO_ROOT/scripts/release_gate_ci_light.sh"

echo "[release_gate_manual_live] probing /health"
deadline="$(( $(date +%s) + MAX_WAIT_SECS ))"
while true; do
  if curl -fsS "${GATE_BASE_URL}/health" >/dev/null 2>&1; then
    echo "[release_gate_manual_live] ok: ${GATE_BASE_URL}/health"
    exit 0
  fi
  if [[ "$(date +%s)" -ge "$deadline" ]]; then
    echo "[release_gate_manual_live] ERROR: timed out waiting for health: ${GATE_BASE_URL}/health" >&2
    echo "[release_gate_manual_live] HINT: start local dev with: scripts/dev_up.sh (it pins backend PORT to 8000 for web proxy compatibility)" >&2
    exit 1
  fi
  sleep "$POLL_INTERVAL_SECS"
done
