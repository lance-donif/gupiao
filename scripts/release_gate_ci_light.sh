#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "[release_gate_ci_light] running backend static gates (TypeScript)"

cd backend && bun run typecheck
cd backend && bun run lint
cd backend && bun run test

echo "[release_gate_ci_light] ok"
