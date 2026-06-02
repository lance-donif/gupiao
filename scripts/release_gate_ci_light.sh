#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "[release_gate_ci_light] running backend static gates (TypeScript)"

pnpm --dir backend typecheck
pnpm --dir backend lint
pnpm --dir backend test

echo "[release_gate_ci_light] ok"
