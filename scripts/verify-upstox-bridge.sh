#!/usr/bin/env bash
# ── Upstox Notifier → MCP Bridge Verification Script ──
# Verifies the notifier-backed Upstox bridge stack:
#   1. TypeScript compiles cleanly
#   2. Bridge-focused tests pass
#   3. Runtime build succeeds
#   4. Notifier token file exists and is readable
#   5. Notifier health responds
#   6. MCP bridge health responds and sees the token
#   7. Runtime health responds and broker path is healthy
#   8. Bridge has successful instrument + quote activity and no recent failures
#
# Usage: bash scripts/verify-upstox-bridge.sh

set -euo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
NODE_VERSION=$(node --version 2>/dev/null || echo "unknown")

pass()  { PASS=$((PASS + 1)); echo "  ✅ PASS: $1"; }
fail()  { FAIL=$((FAIL + 1)); echo "  ❌ FAIL: $1"; }

echo "═══════════════════════════════════════════"
echo "  Upstox Bridge Verification"
echo "═══════════════════════════════════════════"

# ── 1. TypeScript compilation ────────────────────────────────────────────
echo ""
echo "── Step 1: TypeScript compilation ──"
if npx tsc --noEmit 2>&1; then
  pass "TypeScript compiles with zero errors"
else
  fail "TypeScript compilation failed"
fi

# ── 2. Bridge-focused tests ──────────────────────────────────────────────
echo ""
echo "── Step 2: Bridge-focused tests ──"
if npx vitest run tests/upstox-token-store.test.ts tests/upstox-mcp-local.test.ts 2>&1; then
  pass "Bridge-focused tests pass"
else
  fail "Bridge-focused tests failed"
fi

# ── 3. Build output ──────────────────────────────────────────────────────
echo ""
echo "── Step 3: Build output ──"
if npx tsc --project tsconfig.json 2>&1; then
  if [ -f dist/main.js ] && [ -f dist/upstox/mcp-local-main.js ]; then
    pass "Build produces runtime and Upstox bridge output"
  else
    fail "Expected compiled bridge/runtime files missing from dist/"
  fi
else
  fail "Build failed"
fi

# ── 4. Token-file witness ────────────────────────────────────────────────
echo ""
echo "── Step 4: Token-file witness ──"
TOKEN_JSON=$(node --import tsx scripts/check-upstox-token.ts 2>/dev/null || true)
if printf '%s' "$TOKEN_JSON" | grep -q '"exists": true'; then
  pass "Notifier token file exists"
else
  fail "Notifier token file missing"
fi
if printf '%s' "$TOKEN_JSON" | grep -q '"messageType": "access_token"'; then
  pass "Notifier token file contains access_token payload"
else
  fail "Notifier token payload missing access_token witness"
fi
if printf '%s' "$TOKEN_JSON" | grep -q '"isExpired": false'; then
  pass "Notifier token file is unexpired"
else
  fail "Notifier token file is expired"
fi

# ── 5. Notifier health ───────────────────────────────────────────────────
echo ""
echo "── Step 5: Notifier health ──"
NOTIFIER_HEALTH=$(curl -sS http://127.0.0.1:8788/health || true)
if printf '%s' "$NOTIFIER_HEALTH" | grep -q '"status": "ok"'; then
  pass "Notifier health endpoint responds"
else
  fail "Notifier health endpoint failed"
fi
if printf '%s' "$NOTIFIER_HEALTH" | grep -q '"lastDelivery"'; then
  pass "Notifier exposes last-delivery metadata"
else
  fail "Notifier health missing last-delivery metadata"
fi

# ── 6. MCP bridge health ─────────────────────────────────────────────────
echo ""
echo "── Step 6: MCP bridge health ──"
BRIDGE_HEALTH=$(curl -sS http://127.0.0.1:8787/health || true)
if printf '%s' "$BRIDGE_HEALTH" | grep -q '"status": "ok"'; then
  pass "Bridge health endpoint responds"
else
  fail "Bridge health endpoint failed"
fi
if printf '%s' "$BRIDGE_HEALTH" | grep -q '"exists": true'; then
  pass "Bridge sees notifier token file"
else
  fail "Bridge does not see notifier token file"
fi
if printf '%s' "$BRIDGE_HEALTH" | grep -q '"isExpired": false'; then
  pass "Bridge sees live notifier token"
else
  fail "Bridge token is expired"
fi

# ── 7. Runtime broker health ─────────────────────────────────────────────
echo ""
echo "── Step 7: Runtime broker health ──"
RUNTIME_HEALTH=$(curl -sS http://127.0.0.1:3001/health || true)
if printf '%s' "$RUNTIME_HEALTH" | grep -q '"verdict": "healthy"'; then
  pass "Runtime health verdict is healthy"
else
  fail "Runtime health verdict is not healthy"
fi
if printf '%s' "$RUNTIME_HEALTH" | grep -q '"state": "connected"'; then
  pass "Broker stream is connected"
else
  fail "Broker stream is not connected"
fi
if printf '%s' "$RUNTIME_HEALTH" | grep -q '"isStale": false'; then
  pass "Broker health reports non-stale data"
else
  fail "Broker health still reports stale data"
fi

# ── 8. Bridge success witness ────────────────────────────────────────────
echo ""
echo "── Step 8: Bridge success witness ──"
if node --input-type=module <<'NODE'
const bridge = await fetch('http://127.0.0.1:8787/health').then(r => r.json());
const recentTools = (bridge.bridge.recentCalls || []).map((x) => x.tool);
const checks = {
  instrument_sync_recorded: Boolean(bridge.bridge.rest?.lastInstrumentFetchAt),
  quote_calls_recorded: recentTools.includes('get-full-market-quote'),
  last_failure_null: bridge.bridge.lastFailure === null,
};
let failed = false;
for (const [name, ok] of Object.entries(checks)) {
  if (ok) console.log(`  ✅ PASS: ${name}`);
  else { console.log(`  ❌ FAIL: ${name}`); failed = true; }
}
if (failed) process.exit(1);
NODE
then
  pass "Bridge success witness passed"
else
  fail "Bridge success witness failed"
fi

# ── Summary ──────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════"
echo "  Runtime: trader v0.1.0"
echo "  Stack:   Node $NODE_VERSION, TypeScript, MCP bridge"
echo "═══════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
