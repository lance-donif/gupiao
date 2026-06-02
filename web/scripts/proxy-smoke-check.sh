#!/bin/sh
set -eu

log() {
  echo "[web-smoke-check] $*" >&2
}

base_url="${SMOKE_CHECK_BASE_URL:-http://127.0.0.1}"
group_id="${SMOKE_CHECK_GROUP_ID:-main}"
request_timeout="${SMOKE_CHECK_REQUEST_TIMEOUT_SECONDS:-5}"

fetch_json() {
  endpoint="$1"
  curl --silent --show-error --fail --max-time "$request_timeout" "$endpoint"
}

strategy_url="${base_url}/api/strategy/definitions?group_id=${group_id}"
snapshot_url="${base_url}/api/dashboard/snapshot?group_id=${group_id}"

strategy_payload="$(fetch_json "$strategy_url")" || {
  log "strategy definitions probe failed: $strategy_url"
  exit 1
}
printf '%s' "$strategy_payload" | grep -q '"items"' || {
  log "strategy definitions payload missing items"
  exit 1
}

snapshot_payload="$(fetch_json "$snapshot_url")" || {
  log "dashboard snapshot probe failed: $snapshot_url"
  exit 1
}
printf '%s' "$snapshot_payload" | grep -q '"available"' || {
  log "dashboard snapshot payload missing available"
  exit 1
}
printf '%s' "$snapshot_payload" | grep -q '"meta"' || {
  log "dashboard snapshot payload missing meta"
  exit 1
}
printf '%s' "$snapshot_payload" | grep -q '"recommendations"' || {
  log "dashboard snapshot payload missing recommendations"
  exit 1
}
