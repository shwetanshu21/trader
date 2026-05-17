#!/usr/bin/env bash
# ── CAX11 Witness Capture — one-command operator wrapper ──
#
# Usage:
#   bash scripts/capture-cax11-witness.sh
#   bash scripts/capture-cax11-witness.sh --label "pre-deploy-check"
#   bash scripts/capture-cax11-witness.sh --dry-run
#
# Runs the witness entrypoint against the locally-running CAX11 stack.
# Produces a timestamped artifact bundle under data/artifacts/deployment-witness/.
#
# Exit codes:
#   0  — All required evidence captured successfully
#   1  — One or more required subsystems are unreachable
#   2  — Fatal error during capture

set -euo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0

pass()  { PASS=$((PASS + 1)); echo "  ✅ $1"; }
fail()  { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }

DRY_RUN=false
LABEL=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --label=*) LABEL="${arg#--label=}" ;;
    --label) echo "Use --label=VALUE syntax"; exit 2 ;;
    --help|-h)
      echo "Usage: bash scripts/capture-cax11-witness.sh [--dry-run] [--label=TEXT]"
      echo ""
      echo "  --dry-run    Print what would be captured without writing artifacts"
      echo "  --label=TEXT  Human-readable label for the witness run"
      exit 0
      ;;
    *) echo "Unknown option: $arg"; exit 2 ;;
  esac
done

echo "═══════════════════════════════════════════"
echo "  CAX11 Deployment Witness Capture"
echo "═══════════════════════════════════════════"
echo ""

# ── Build the witness command ────────────────────────────────────────────
CMD="node --import tsx src/deployment/witness-main.ts"
if [ -n "$LABEL" ]; then
  CMD="$CMD --label \"${LABEL}\""
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
  pass "Witness capture completed successfully (exit code 0)"
elif [ "$WITNESS_EXIT" -eq 1 ]; then
  fail "Witness capture completed with missing evidence (exit code 1)"
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
