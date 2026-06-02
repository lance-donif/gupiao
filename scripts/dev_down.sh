#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$ROOT_DIR/data}"
PID_DIR="$DATA_DIR/pids"
LOG_DIR="$DATA_DIR/logs"
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-5173}"

BACKEND_HTTP_PID_FILE="$PID_DIR/backend_http.pid"
WEB_PID_FILE="$PID_DIR/web.pid"

mkdir -p "$PID_DIR" "$LOG_DIR"

log() {
  printf '[dev_down] %s\n' "$*"
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

stop_pid_gracefully() {
  local pid="$1"
  local name="$2"
  if ! is_pid_alive "$pid"; then
    return 0
  fi
  log "stopping ${name} pid=${pid}"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! is_pid_alive "$pid"; then
      return 0
    fi
    sleep 0.5
  done
  if is_pid_alive "$pid"; then
    log "force killing ${name} pid=${pid}"
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

stop_from_pid_file() {
  local pid_file="$1"
  local service_name="$2"
  if [[ ! -f "$pid_file" ]]; then
    return 0
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "$pid" ]]; then
    stop_pid_gracefully "$pid" "$service_name"
  fi
  rm -f "$pid_file"
}

find_listen_pid() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true
}

stop_port_if_project_process() {
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
    stop_pid_gracefully "$pid" "$service_name"
  else
    log "port ${port} is occupied by non-project process pid=${pid}: ${cmd}"
  fi
}

stop_matching_processes() {
  local pattern="$1"
  local service_name="$2"
  local pids
  pids="$(pgrep -f "$pattern" || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi
  while read -r pid; do
    [[ -z "$pid" ]] && continue
    stop_pid_gracefully "$pid" "$service_name"
  done <<< "$pids"
}

stop_from_pid_file "$BACKEND_HTTP_PID_FILE" "backend-http"
stop_from_pid_file "$WEB_PID_FILE" "web"

# Fallback cleanup if pid files were stale/missing.
stop_port_if_project_process "$API_PORT" "src/http/server.ts" "backend-http"
stop_port_if_project_process "$WEB_PORT" "vite" "web"

log "stopping docker dependencies"
(
  cd "$ROOT_DIR"
  docker compose down --remove-orphans >/dev/null 2>&1 || true
)

api_left="$(find_listen_pid "$API_PORT")"
web_left="$(find_listen_pid "$WEB_PORT")"
if [[ -n "$api_left" ]]; then
  log "backend http port ${API_PORT} still occupied by pid=${api_left}: $(command_of_pid "$api_left")"
fi
if [[ -n "$web_left" ]]; then
  log "web port ${WEB_PORT} still occupied by pid=${web_left}: $(command_of_pid "$web_left")"
fi

if [[ -z "$api_left" && -z "$web_left" ]]; then
  log "all services stopped"
fi
