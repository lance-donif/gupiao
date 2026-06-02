#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$ROOT_DIR/data}"
PID_DIR="$DATA_DIR/pids"
LOG_DIR="$DATA_DIR/logs"
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-5173}"
API_RELOAD="${API_RELOAD:-1}"

BACKEND_DIR="$ROOT_DIR/backend"
WEB_DIR="$ROOT_DIR/web"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE_FILE="$ROOT_DIR/.env.example"

BACKEND_HTTP_PID_FILE="$PID_DIR/backend_http.pid"
WEB_PID_FILE="$PID_DIR/web.pid"

mkdir -p "$PID_DIR" "$LOG_DIR"

log() {
  printf '[dev_up] %s\n' "$*"
}

fail() {
  printf '[dev_up] ERROR: %s\n' "$*" >&2
  exit 1
}

is_pid_alive() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

command_of_pid() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null || true
}

find_listen_pid() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true
}

is_pid_file_running() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    return 1
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  is_pid_alive "$pid"
}

ensure_tooling() {
  command -v docker >/dev/null 2>&1 || fail "docker not found"
  command -v pnpm >/dev/null 2>&1 || fail "pnpm not found"
  command -v npm >/dev/null 2>&1 || fail "npm not found"
  command -v lsof >/dev/null 2>&1 || fail "lsof not found"
  command -v curl >/dev/null 2>&1 || fail "curl not found"
}

ensure_compose_services_running() {
  local declared
  declared="$(cd "$ROOT_DIR" && docker compose config --services)"
  if [[ -z "$declared" ]]; then
    fail "docker compose declares no services"
  fi
  while read -r svc; do
    [[ -z "$svc" ]] && continue
    if ! (cd "$ROOT_DIR" && docker compose ps --services --status running | grep -qx "$svc"); then
      (cd "$ROOT_DIR" && docker compose logs "$svc" --tail=200 || true)
      fail "${svc} is not running after docker compose up -d"
    fi
  done <<< "$declared"
}

check_port_conflict() {
  local port="$1"
  local expected_substring="$2"
  local service_name="$3"
  local pid
  pid="$(find_listen_pid "$port")"
  if [[ -z "$pid" ]]; then
    return 0
  fi
  local cmd
  cmd="$(command_of_pid "$pid")"
  if [[ "$cmd" == *"$expected_substring"* ]]; then
    RUNNING_ALREADY=1
    return 0
  fi
  fail "port ${port} is occupied by non-project ${service_name} process pid=${pid}: ${cmd}"
}

wait_for_http() {
  local url="$1"
  local timeout_secs="$2"
  for _ in $(seq 1 "$timeout_secs"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

verify_http_keepalive() {
  local url="$1"
  local duration_secs="$2"
  local service_name="$3"
  local pid_file="$4"
  for _ in $(seq 1 "$duration_secs"); do
    if [[ -n "$pid_file" && -f "$pid_file" ]]; then
      local pid
      pid="$(cat "$pid_file" 2>/dev/null || true)"
      if ! is_pid_alive "$pid"; then
        fail "${service_name} process exited during keepalive window, check logs"
      fi
    fi
    if ! curl -fsS "$url" >/dev/null 2>&1; then
      fail "${service_name} failed keepalive probe during startup window, check logs"
    fi
    sleep 1
  done
}

start_backend_http() {
  log "starting backend http shell"
  (
    cd "$BACKEND_DIR"
    # NOTE: backend/src/http/server.ts defaults to PORT=8787. web/ currently proxies /api to :8000.
    # Keep local dev aligned by pinning PORT/HOST here.
    nohup env HOST=127.0.0.1 PORT="$API_PORT" pnpm dev:http \
      >>"$LOG_DIR/backend_http.log" 2>&1 &
    echo "$!" > "$BACKEND_HTTP_PID_FILE"
  )
}

start_web() {
  log "starting web (vite)"
  (
    cd "$WEB_DIR"
    nohup npm run dev -- --host 127.0.0.1 --port "$WEB_PORT" \
      >>"$LOG_DIR/web.log" 2>&1 &
    echo "$!" > "$WEB_PID_FILE"
  )
}

ensure_tooling

if [[ ! -f "$ENV_FILE" ]]; then
  [[ -f "$ENV_EXAMPLE_FILE" ]] || fail ".env.example not found"
  cp "$ENV_EXAMPLE_FILE" "$ENV_FILE"
  log "created .env from .env.example"
fi

RUNNING_ALREADY=0
if is_pid_file_running "$BACKEND_HTTP_PID_FILE" || is_pid_file_running "$WEB_PID_FILE"; then
  RUNNING_ALREADY=1
fi

check_port_conflict "$API_PORT" "src/http/server.ts" "backend-http"
check_port_conflict "$WEB_PORT" "vite" "web"

if [[ "$RUNNING_ALREADY" -eq 1 ]]; then
  log "existing services detected, restarting"
  "$ROOT_DIR/scripts/dev_down.sh"
fi

log "starting docker dependencies"
(
  cd "$ROOT_DIR"
  docker compose up -d --remove-orphans
)

ensure_compose_services_running

if [[ ! -d "$BACKEND_DIR/node_modules" ]]; then
  log "installing backend dependencies"
  pnpm --dir "$BACKEND_DIR" install
fi

if [[ ! -d "$WEB_DIR/node_modules" ]]; then
  log "installing node dependencies"
  npm --prefix "$WEB_DIR" install
fi

start_backend_http
if ! wait_for_http "http://127.0.0.1:${API_PORT}/health" 60; then
  fail "backend http shell failed to become healthy, check $LOG_DIR/backend_http.log"
fi
verify_http_keepalive "http://127.0.0.1:${API_PORT}/health" 30 "backend-http" "$BACKEND_HTTP_PID_FILE"

start_web
if ! wait_for_http "http://127.0.0.1:${WEB_PORT}" 60; then
  fail "web failed to become ready, check $LOG_DIR/web.log"
fi
verify_http_keepalive "http://127.0.0.1:${WEB_PORT}" 30 "web" "$WEB_PID_FILE"

log "all services are running"
log "web: http://127.0.0.1:${WEB_PORT}"
log "backend http shell: http://127.0.0.1:${API_PORT}"
log "backend health: http://127.0.0.1:${API_PORT}/health"
log "logs: $LOG_DIR/backend_http.log $LOG_DIR/web.log"
