#!/usr/bin/env bash
# ── Upstox stack bootstrap ──
# Starts the local notifier, notifier-backed MCP bridge, loca.lt tunnel,
# and optionally the trader runtime once a notifier token exists.
#
# Usage:
#   bash scripts/start-upstox-stack.sh
#   bash scripts/start-upstox-stack.sh --request-token --await-token --start-runtime
#   LT_SUBDOMAIN=trusted-subdomain bash scripts/start-upstox-stack.sh --request-token

set -euo pipefail
cd "$(dirname "$0")/.."

ROOT_DIR=$(pwd)
STATE_DIR="$ROOT_DIR/tmp/upstox/runtime"
LOG_DIR="$ROOT_DIR/tmp/upstox/logs"
mkdir -p "$STATE_DIR" "$LOG_DIR"

NOTIFIER_PORT="${TRADER_UPSTOX_NOTIFIER_PORT:-8788}"
BRIDGE_PORT="${TRADER_UPSTOX_MCP_LOCAL_PORT:-8787}"
RUNTIME_PORT="${TRADER_PORT:-3001}"
TOKEN_PATH="${TRADER_UPSTOX_TOKEN_PATH:-./tmp/upstox/notifier/latest-token.json}"
TOKEN_ABS_PATH="$(python3 - <<'PY'
import os
print(os.path.abspath(os.environ.get('TRADER_UPSTOX_TOKEN_PATH', './tmp/upstox/notifier/latest-token.json')))
PY
)"
LT_HOST="${LT_HOST:-https://loca.lt}"
LT_SUBDOMAIN="${LT_SUBDOMAIN:-}"
WAIT_TIMEOUT_SECONDS="${WAIT_TIMEOUT_SECONDS:-600}"

REQUEST_TOKEN=false
AWAIT_TOKEN=false
START_RUNTIME=false

for arg in "$@"; do
  case "$arg" in
    --request-token) REQUEST_TOKEN=true ;;
    --await-token) AWAIT_TOKEN=true ;;
    --start-runtime) START_RUNTIME=true ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

pass() { echo "  ✅ $1"; }
info() { echo "  • $1"; }
warn() { echo "  ⚠ $1"; }
fail() { echo "  ❌ $1" >&2; exit 1; }

pid_file_for() {
  case "$1" in
    notifier) echo "$STATE_DIR/notifier.pid" ;;
    bridge) echo "$STATE_DIR/bridge.pid" ;;
    tunnel) echo "$STATE_DIR/tunnel.pid" ;;
    runtime) echo "$STATE_DIR/runtime.pid" ;;
    *) return 1 ;;
  esac
}

log_file_for() {
  case "$1" in
    notifier) echo "$LOG_DIR/notifier.log" ;;
    bridge) echo "$LOG_DIR/bridge.log" ;;
    tunnel) echo "$LOG_DIR/tunnel.log" ;;
    runtime) echo "$LOG_DIR/runtime.log" ;;
    *) return 1 ;;
  esac
}

is_pid_running() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local stat
  stat="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$stat" ] && [[ "$stat" != Z* ]]
}

cleanup_stale_pid() {
  local pid_file="$1"
  [ -f "$pid_file" ] || return 0
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if ! is_pid_running "$pid"; then
    rm -f "$pid_file"
  fi
}

require_running() {
  local name="$1"
  local pid_file log_file pid
  pid_file="$(pid_file_for "$name")"
  log_file="$(log_file_for "$name")"
  cleanup_stale_pid "$pid_file"
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if ! is_pid_running "$pid"; then
    echo "  ⚠ $name is not running" >&2
    if [ -f "$log_file" ]; then
      echo "  ⚠ recent $name log tail:" >&2
      tail -n 20 "$log_file" >&2 || true
    fi
    return 1
  fi
  return 0
}

start_bg() {
  local name="$1"
  local command="$2"
  local pid_file log_file
  pid_file="$(pid_file_for "$name")"
  log_file="$(log_file_for "$name")"

  cleanup_stale_pid "$pid_file"
  if [ -f "$pid_file" ]; then
    local pid
    pid="$(cat "$pid_file")"
    if is_pid_running "$pid"; then
      pass "$name already running (pid $pid)"
      return 0
    fi
    rm -f "$pid_file"
  fi

  : > "$log_file"
  info "starting $name"
  nohup bash -lc "exec $command" >>"$log_file" 2>&1 &
  local pid=$!
  echo "$pid" > "$pid_file"

  local deadline=$((SECONDS + 5))
  while [ $SECONDS -lt $deadline ]; do
    if is_pid_running "$pid"; then
      sleep 1
      continue
    fi
    rm -f "$pid_file"
    fail "$name failed to stay running; inspect $log_file"
  done

  pass "$name started (pid $pid)"
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local deadline=$((SECONDS + 30))
  while [ $SECONDS -lt $deadline ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      pass "$label is responding at $url"
      return 0
    fi
    sleep 1
  done
  fail "$label did not become ready at $url"
}

wait_for_tunnel_url() {
  local log_file="$1"
  local deadline=$((SECONDS + 45))
  while [ $SECONDS -lt $deadline ]; do
    require_running tunnel || return 1
    if [ -f "$log_file" ]; then
      local line
      line="$(python3 - "$log_file" <<'PY'
import re, sys, pathlib
text = pathlib.Path(sys.argv[1]).read_text(errors='ignore')
matches = re.findall(r'your url is:\s*(https://\S+)', text)
print(matches[-1] if matches else '')
PY
)"
      if [ -n "$line" ]; then
        printf '%s' "$line"
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

request_token() {
  info "requesting fresh Upstox token"
  node --import tsx scripts/request-upstox-access-token.ts
  pass "Upstox token request sent"
}

wait_for_token_file() {
  local deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
  info "waiting for notifier token delivery (timeout ${WAIT_TIMEOUT_SECONDS}s)"
  while [ $SECONDS -lt $deadline ]; do
    if node --import tsx scripts/check-upstox-token.ts 2>/dev/null | grep -q '"exists": true' \
      && node --import tsx scripts/check-upstox-token.ts 2>/dev/null | grep -q '"isExpired": false'; then
      pass "notifier token file is present and unexpired"
      return 0
    fi
    sleep 2
  done
  fail "token file did not arrive within ${WAIT_TIMEOUT_SECONDS}s"
}

echo "═══════════════════════════════════════════"
echo "  Upstox stack bootstrap"
echo "═══════════════════════════════════════════"

start_bg notifier "node --import tsx src/upstox/notifier-main.ts"
wait_for_http "http://127.0.0.1:${NOTIFIER_PORT}/health" "notifier"

start_bg bridge "node --import tsx src/upstox/mcp-local-main.ts"
wait_for_http "http://127.0.0.1:${BRIDGE_PORT}/health" "mcp bridge"

TUNNEL_CMD="npx localtunnel --port ${NOTIFIER_PORT} --local-host 127.0.0.1 --host ${LT_HOST} --print-requests"
if [ -n "$LT_SUBDOMAIN" ]; then
  TUNNEL_CMD+=" --subdomain ${LT_SUBDOMAIN}"
fi
start_bg tunnel "$TUNNEL_CMD"
TUNNEL_LOG="$(log_file_for tunnel)"
TUNNEL_URL="$(wait_for_tunnel_url "$TUNNEL_LOG" || true)"
require_running notifier || fail "notifier died after startup"
require_running bridge || fail "bridge died after startup"
require_running tunnel || fail "tunnel died after startup"
if [ -n "$TUNNEL_URL" ]; then
  pass "notifier tunnel URL: ${TUNNEL_URL}/upstox/notifier"
else
  warn "could not parse tunnel URL yet; inspect $TUNNEL_LOG"
fi

if $REQUEST_TOKEN; then
  request_token
fi

if $AWAIT_TOKEN; then
  wait_for_token_file
fi

if $START_RUNTIME; then
  if ! node --import tsx scripts/check-upstox-token.ts 2>/dev/null | grep -q '"exists": true'; then
    fail "runtime start requested, but notifier token file is missing at $TOKEN_ABS_PATH"
  fi
  if ! node --import tsx scripts/check-upstox-token.ts 2>/dev/null | grep -q '"isExpired": false'; then
    fail "runtime start requested, but notifier token file is expired at $TOKEN_ABS_PATH"
  fi
  start_bg runtime "node --env-file=.env --import tsx src/main.ts"
  wait_for_http "http://127.0.0.1:${RUNTIME_PORT}/health" "runtime"
  pass "runtime started with live broker token"
fi

echo ""
echo "Next steps:"
if [ -n "$TUNNEL_URL" ]; then
  echo "  1. Set Upstox notifier URL to: ${TUNNEL_URL}/upstox/notifier"
else
  echo "  1. Inspect tunnel log: $TUNNEL_LOG"
fi
echo "  2. Run with --request-token to trigger a fresh token request"
echo "  3. Approve the request in Upstox / WhatsApp"
echo "  4. Re-run with --await-token --start-runtime to bring the runtime up"
echo ""
echo "Logs:"
echo "  notifier: $(log_file_for notifier)"
echo "  bridge:   $(log_file_for bridge)"
echo "  tunnel:   $(log_file_for tunnel)"
echo "  runtime:  $(log_file_for runtime)"
echo ""
echo "Token path: $TOKEN_ABS_PATH"
