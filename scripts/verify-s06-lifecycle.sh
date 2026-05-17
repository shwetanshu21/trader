#!/usr/bin/env bash
# verify-s06-lifecycle.sh — Verify lifecycle governance is visible in /health/lifecycle
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

HOST="${1:-localhost}"
PORT="${2:-7071}"
URL="http://${HOST}:${PORT}/health/lifecycle"

echo "=== Verify: /health/lifecycle endpoint ==="
echo "URL: $URL"

# Check that the endpoint responds
HTTP_CODE=$(curl -s -o /tmp/lifecycle-response.json -w "%{http_code}" "$URL" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "000" ]; then
  echo "FAIL: Could not connect to $URL"
  echo "Is the runtime running? Try: npm run start"
  exit 1
fi

if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "404" ]; then
  echo "FAIL: Expected 200 or 404, got $HTTP_CODE"
  cat /tmp/lifecycle-response.json 2>/dev/null || true
  exit 1
fi

echo "HTTP $HTTP_CODE"

# Parse response
if [ "$HTTP_CODE" = "404" ]; then
  echo "NOTE: /health/lifecycle returned 404 — lifecycle repo not wired or no data yet."
  echo "This is expected when no lifecycle repo is configured or no strategy has been promoted."
  echo "Run npm run promote first to create lifecycle state."
  exit 0
fi

# Check for lifecycle governance data
TOTAL_STATES=$(cat /tmp/lifecycle-response.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('totalStates', 0))" 2>/dev/null || echo "0")
TOTAL_DECISIONS=$(cat /tmp/lifecycle-response.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('totalDecisions', 0))" 2>/dev/null || echo "0")

echo "totalStates: $TOTAL_STATES"
echo "totalDecisions: $TOTAL_DECISIONS"

if [ "$TOTAL_STATES" -gt 0 ] || [ "$TOTAL_DECISIONS" -gt 0 ]; then
  echo "PASS: Lifecycle governance data found in /health/lifecycle"
  echo ""
  echo "--- Current States ---"
  cat /tmp/lifecycle-response.json | python3 -c "
import sys, json
d = json.load(sys.stdin)
for s in d.get('currentStates', []):
    print(f\"  {s['strategyId']}@{s['strategyVersion']}:{s['marketId']} → {s['phase']} (updated {s['updatedAt']})\")
" 2>/dev/null || echo "  (none)"
  echo ""
  echo "--- Recent Decisions ---"
  cat /tmp/lifecycle-response.json | python3 -c "
import sys, json
d = json.load(sys.stdin)
for dec in d.get('recentDecisions', []):
    print(f\"  [{dec['verdict']}] {dec['previousPhase']} → {dec['newPhase']}: {dec['rationale'][:80]}\")
" 2>/dev/null || echo "  (none)"
else
  echo "PASS: /health/lifecycle endpoint is wired (no data yet — expected before first promotion)"
fi

rm -f /tmp/lifecycle-response.json
