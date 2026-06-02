#!/bin/sh
set -eu

log() {
  echo "[web-startup] $*" >&2
}

startup_timeout="${SMOKE_CHECK_STARTUP_TIMEOUT_SECONDS:-60}"
startup_interval="${SMOKE_CHECK_STARTUP_INTERVAL_SECONDS:-2}"

nginx -g 'daemon off;' &
nginx_pid=$!

cleanup() {
  if kill -0 "$nginx_pid" 2>/dev/null; then
    kill -TERM "$nginx_pid" 2>/dev/null || true
    wait "$nginx_pid" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

started_at="$(date +%s)"

while true; do
  if ! kill -0 "$nginx_pid" 2>/dev/null; then
    wait "$nginx_pid"
    exit $?
  fi

  if /usr/local/bin/proxy-smoke-check.sh; then
    log "proxy smoke check passed"
    trap - INT TERM EXIT
    wait "$nginx_pid"
    exit $?
  fi

  now="$(date +%s)"
  if [ $((now - started_at)) -ge "$startup_timeout" ]; then
    log "proxy smoke check timed out after ${startup_timeout}s"
    exit 1
  fi

  sleep "$startup_interval"
done
