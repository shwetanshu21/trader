#!/usr/bin/env bash
# ── M009/S06 — Paper Proof Verification Script ──
#
# One-command local verification that the assembled RuntimeApp in Paper mode
# exposes operator-reviewable LLM-first strategy evidence, India research
# influence, class-specific safeguards, and truthful operator surfaces.
#
# This script:
#   1. Runs pre-flight checks (node, tsx, TypeScript compilation)
#   2. Runs the TypeScript paper-proof harness (start RuntimeApp, seed data,
#      drive ticks, assert operator surfaces, write artifact)
#   3. Reports pass/fail summarily
#
# Usage:
#   bash scripts/verify-m009-s06-paper-proof.sh
#
# Exit codes:
#   0  — All paper-proof assertions passed
#   1  — One or more assertions failed
#   2  — Fatal error (missing tooling, compilation failure, script crash)

set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0

pass()  { PASS=$((PASS + 1)); echo "  ✅ $1"; }
fail()  { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }
warn()  { echo "  ⚠  $1"; }

echo "═══════════════════════════════════════════"
echo "  M009/S06 — Paper Proof Verification"
echo "═══════════════════════════════════════════"

# ── Step 1: Pre-flight checks ─────────────────────────────────────────────
echo ""
echo "── Step 1: Pre-flight checks ──"

if ! command -v node &>/dev/null; then
  fail "node is not installed"
  exit 2
fi
pass "node $(node --version) found"

if ! command -v npx &>/dev/null; then
  fail "npx is not available"
  exit 2
fi
pass "npx found"

if [ ! -f src/deployment/verify-m009-s06-paper-proof.ts ]; then
  fail "verify-m009-s06-paper-proof.ts not found"
  exit 2
fi
pass "paper-proof harness found"

# ── Step 2: TypeScript compilation check ──────────────────────────────────
echo ""
echo "── Step 2: TypeScript compilation ──"

if npx tsc --noEmit 2>&1; then
  pass "TypeScript compiles cleanly"
else
  warn "TypeScript has pre-existing errors — proceeding if they are not in paper-proof files"
  # Check if the errors are exclusively in non-paper-proof files
  TS_ERRORS=$(npx tsc --noEmit 2>&1 | grep -v "verify-m009-s06-paper-proof" || true)
  if [ -z "$TS_ERRORS" ]; then
    pass "Paper-proof files compile cleanly (pre-existing errors elsewhere)"
  else
    fail "TypeScript compilation has errors in paper-proof or shared files"
    echo "$TS_ERRORS" | head -20
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# Step 3: Run the paper-proof harness
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "── Step 3: Run paper-proof harness ──"
echo ""

set +e
HARNESS_OUTPUT=$(node --import tsx src/deployment/verify-m009-s06-paper-proof.ts 2>&1)
HARNESS_EXIT=$?
set -e

echo "$HARNESS_OUTPUT"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Step 4: Report
# ═══════════════════════════════════════════════════════════════════════════

if [ "$HARNESS_EXIT" -eq 0 ]; then
  pass "Paper-proof harness completed successfully (exit 0)"
elif [ "$HARNESS_EXIT" -eq 1 ]; then
  fail "Paper-proof harness completed with assertion failures (exit 1)"
  echo ""
  echo "  🔍 One or more operator-surface assertions failed."
  echo "     Review the output above for ❌ FAIL lines."
  echo "     The harness artifact was still written for analysis."
else
  fail "Paper-proof harness exited with fatal error (exit ${HARNESS_EXIT})"
fi

echo ""
echo "═══════════════════════════════════════════"
echo "  Result: $([ "$FAIL" -eq 0 ] && echo 'PASS ✅' || echo 'FAIL ❌')"
echo "  $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════"

# ── Locate the latest artifact for reference ──────────────────────────────
if [ -d data/artifacts/paper-proof ]; then
  LATEST_ARTIFACT=$(ls -t data/artifacts/paper-proof/paper-proof-*.json 2>/dev/null | head -1)
  if [ -n "$LATEST_ARTIFACT" ]; then
    echo ""
    echo "Latest artifact: ${LATEST_ARTIFACT}"
  fi
fi

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
