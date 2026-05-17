#!/usr/bin/env bash
# ── CAX11 Witness Capture — one-command operator wrapper ──
#
# Usage:
#   bash scripts/capture-cax11-witness.sh
#   bash scripts/capture-cax11-witness.sh --label "pre-deploy-check"
#   bash scripts/capture-cax11-witness.sh --dry-run
#   bash scripts/capture-cax11-witness.sh --steady-state
#   bash scripts/capture-cax11-witness.sh --steady-state --duration-sec 300 --interval-sec 15
#
# Runs the witness entrypoint against the locally-running CAX11 stack.
# Produces a timestamped artifact bundle under data/artifacts/deployment-witness/.
#
# Exit codes:
#   0  — All required evidence captured successfully (pass/caveat verdict for steady-state)
#   1  — One or more required subsystems are unreachable (or fail verdict for steady-state)
#   2  — Fatal error during capture

set -euo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0

pass()  { PASS=$((PASS + 1)); echo "  ✅ $1"; }
fail()  { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }

DRY_RUN=false
LABEL=""
STEADY_STATE=false
STEADY_DURATION=""
STEADY_INTERVAL=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --steady-state) STEADY_STATE=true ;;
    --duration-sec=*) STEADY_DURATION="${arg#--duration-sec=}" ;;
    --interval-sec=*) STEADY_INTERVAL="${arg#--interval-sec=}" ;;
    --duration-sec) echo "Use --duration-sec=VALUE syntax"; exit 2 ;;
    --interval-sec) echo "Use --interval-sec=VALUE syntax"; exit 2 ;;
    --label=*) LABEL="${arg#--label=}" ;;
    --label) echo "Use --label=VALUE syntax"; exit 2 ;;
    --help|-h)
      echo "Usage: bash scripts/capture-cax11-witness.sh [options]"
      echo ""
      echo "Point-in-time witness (default):"
      echo "  Captures a snapshot of all subsystems at a single moment."
      echo ""
      echo "Steady-state witness (--steady-state):"
      echo "  Observes the deployed stack over a bounded window, collecting"
      echo "  time-series host/process/HTTP/disk evidence and producing a"
      echo "  pass/caveat/fail verdict."
      echo ""
      echo "Options:"
      echo "  --dry-run              Print what would be captured without writing artifacts"
      echo "  --label=TEXT           Human-readable label for the witness run"
      echo "  --steady-state         Run steady-state witness instead of point-in-time capture"
      echo "  --duration-sec=SECS    Steady-state window in seconds (default: 120)"
      echo "  --interval-sec=SECS    Sampling interval in seconds (default: 30)"
      exit 0
      ;;
    *) echo "Unknown option: $arg"; exit 2 ;;
  esac
done

echo "═══════════════════════════════════════════"
if $STEADY_STATE; then
  echo "  CAX11 Steady-State Witness Capture"
  echo "  Duration: ${STEADY_DURATION:-120}s  Interval: ${STEADY_INTERVAL:-30}s"
else
  echo "  CAX11 Deployment Witness Capture"
fi
echo "═══════════════════════════════════════════"
echo ""

# ── Build the witness command ────────────────────────────────────────────
CMD="node --import tsx src/deployment/witness-main.ts"
if [ -n "$LABEL" ]; then
  CMD="$CMD --label \"${LABEL}\""
fi

if $STEADY_STATE; then
  CMD="$CMD --steady-state"
  if [ -n "$STEADY_DURATION" ]; then
    CMD="$CMD --steady-state-duration-sec \"${STEADY_DURATION}\""
  fi
  if [ -n "$STEADY_INTERVAL" ]; then
    CMD="$CMD --steady-state-interval-sec \"${STEADY_INTERVAL}\""
  fi
fi

# Respect environment overrides
if [ -n "${WITNESS_RUNTIME_HEALTH_URL:-}" ]; then
  CMD="$CMD --runtime-health-url \"${WITNESS_RUNTIME_HEALTH_URL}\""
fi
if [ -n "${WITNESS_RUNTIME_DASHBOARD_URL:-}" ]; then
  CMD="$CMD --runtime-dashboard-url \"${WITNESS_RUNTIME_DASHBOARD_URL}\""
fi
if [ -n "${WITNESS_NOTIFIER_HEALTH_URL:-}" ]; then
  CMD="$CMD --notifier-health-url \"${WITNESS_NOTIFIER_HEALTH_URL}\""
fi
if [ -n "${WITNESS_BRIDGE_HEALTH_URL:-}" ]; then
  CMD="$CMD --bridge-health-url \"${WITNESS_BRIDGE_HEALTH_URL}\""
fi
if [ -n "${WITNESS_DB_PATH:-}" ]; then
  CMD="$CMD --db-path \"${WITNESS_DB_PATH}\""
fi
if [ -n "${WITNESS_HTTP_TIMEOUT_MS:-}" ]; then
  CMD="$CMD --http-timeout-ms \"${WITNESS_HTTP_TIMEOUT_MS}\""
fi
if [ -n "${WITNESS_STEADY_STATE_DURATION_SEC:-}" ]; then
  CMD="$CMD --steady-state-duration-sec \"${WITNESS_STEADY_STATE_DURATION_SEC}\""
fi
if [ -n "${WITNESS_STEADY_STATE_INTERVAL_SEC:-}" ]; then
  CMD="$CMD --steady-state-interval-sec \"${WITNESS_STEADY_STATE_INTERVAL_SEC}\""
fi

if $DRY_RUN; then
  echo "  [DRY RUN] Would execute:"
  echo "    $CMD"
  echo ""
  echo "  [DRY RUN] No artifacts written."
  exit 0
fi

# ── Pre-flight checks ─────────────────────────────────────────────────────
echo "── Pre-flight checks ──"
if ! command -v node &>/dev/null; then
  fail "node is not installed"
  exit 2
fi
pass "node $(node --version) found"

if [ ! -f src/deployment/witness-main.ts ]; then
  fail "witness-main.ts not found"
  exit 2
fi
pass "witness entrypoint found"

if [ ! -f src/deployment/witness-capture.ts ]; then
  fail "witness-capture.ts not found"
  exit 2
fi
pass "witness capture module found"

echo ""

# ── Run witness capture ───────────────────────────────────────────────────
echo "── Running witness capture ──"
echo "  Command: $CMD"
echo ""

# Run with explicit error handling so we get clean exit code pass-through
set +e
WITNESS_OUTPUT=$(eval "$CMD" 2>&1)
WITNESS_EXIT=$?
set -e

echo "$WITNESS_OUTPUT"
echo ""

# ── Report ────────────────────────────────────────────────────────────────
if [ "$WITNESS_EXIT" -eq 0 ]; then
  if $STEADY_STATE; then
    pass "Steady-state witness completed — verdict: pass/caveat (exit code 0)"
  else
    pass "Witness capture completed successfully (exit code 0)"
  fi
elif [ "$WITNESS_EXIT" -eq 1 ]; then
  if $STEADY_STATE; then
    fail "Steady-state witness completed with FAIL verdict (exit code 1)"
  else
    fail "Witness capture completed with missing evidence (exit code 1)"
  fi
  echo ""
  echo "  🔍 Some required subsystems were unreachable. Review the output above."
  echo "     The bundle was still written for later analysis."
elif [ "$WITNESS_EXIT" -eq 2 ]; then
  fail "Witness capture failed with fatal error (exit code 2)"
fi

echo ""
echo "═══════════════════════════════════════════"
echo "  Result: $([ "$WITNESS_EXIT" -eq 0 ] && echo 'PASS ✅' || echo 'FAIL ❌')"
echo "  $PASS checks passed, $FAIL checks failed"
echo "═══════════════════════════════════════════"
exit "$WITNESS_EXIT"
