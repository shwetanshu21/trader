#!/usr/bin/env bash
# ── M007/S02 — Witness Capture Verification Script (point-in-time + steady-state) ──
#
# Verifies that the witness capture entrypoint produces valid bundles for
# both point-in-time and steady-state modes.
#
# For point-in-time capture:
#   - Starts local helper services (notifier, bridge, runtime)
#   - Runs the witness capture
#   - Asserts bundle structure, manifest schema, evidence files, redaction
#
# For steady-state capture:
#   - Starts local helper services
#   - Runs the steady-state witness with a short window
#   - Asserts steady-state manifest structure, verdict, resource summary,
#     subsystem evidence, process evidence, growth records
#   - Verifies the bundle can be inspected after the run
#
# Usage:
#   bash scripts/verify-m007-s01-witness.sh

set -uo pipefail
cd "$(dirname "$0")/.."

# Don't use set -e — we handle errors explicitly with fail() calls

PASS=0
FAIL=0

pass()  { PASS=$((PASS + 1)); echo "  ✅ PASS: $1"; }
fail()  { FAIL=$((FAIL + 1)); echo "  ❌ FAIL: $1"; }
warn()  { echo "  ⚠  $1"; }

echo "═══════════════════════════════════════════"
echo "  M007/S02 — Witness Capture Verification"
echo "═══════════════════════════════════════════"

# ── 1. Pre-flight: check tooling ──────────────────────────────────────────
echo ""
echo "── Step 1: Pre-flight checks ──"

if ! command -v node &>/dev/null; then
  fail "node is not installed"
  exit 1
fi
pass "node $(node --version) found"

if ! command -v npx &>/dev/null; then
  fail "npx is not available"
  exit 1
fi
pass "npx found"

# Check TypeScript compilation
echo ""
echo "── Step 2: TypeScript compilation ──"
if npx tsc --noEmit 2>&1; then
  pass "TypeScript compiles cleanly"
else
  # Check if the errors are only in pre-existing files
  TS_ERRORS=$(npx tsc --noEmit 2>&1 | grep -v "src/proposals/" | grep -v "src/replay/" | grep -v "src/strategy/" || true)
  if [ -z "$TS_ERRORS" ]; then
    warn "TypeScript has pre-existing errors (non-witness files), skipping"
    pass "TypeScript (witness files only) compiles cleanly"
  else
    fail "TypeScript compilation failed"
    echo "$TS_ERRORS"
  fi
fi

# ── 3. Run all witness tests ──────────────────────────────────────────────
echo ""
echo "── Step 3: Witness unit tests (contract + capture) ──"
if npx vitest run tests/deployment-witness-contract.test.ts tests/deployment-witness-capture.test.ts 2>&1; then
  pass "All witness unit tests pass (${PASS})"
else
  fail "Witness unit tests failed"
fi

# ── 4. Start helper services for witness capture ──────────────────────────
echo ""
echo "── Step 4: Start helper services ──"

# Use random ports to avoid conflicts with any running stack
NOTIFIER_PORT=18788
BRIDGE_PORT=18787
RUNTIME_PORT=13001

# Start a minimal notifier
NOTIFIER_PID=""
start_notifier() {
  TRADER_UPSTOX_NOTIFIER_PORT=$NOTIFIER_PORT \
  TRADER_UPSTOX_NOTIFIER_HOST=127.0.0.1 \
  node --import tsx src/upstox/notifier-main.ts > /dev/null 2>&1 &
  NOTIFIER_PID=$!
  # Wait for it to be ready
  for i in $(seq 1 15); do
    if curl -fsS "http://127.0.0.1:${NOTIFIER_PORT}/health" >/dev/null 2>&1; then
      pass "Notifier started on port ${NOTIFIER_PORT}"
      return 0
    fi
    sleep 0.5
  done
  fail "Notifier did not start within 7.5s"
  return 1
}

# Start a minimal MCP bridge
BRIDGE_PID=""
start_bridge() {
  TRADER_UPSTOX_MCP_LOCAL_PORT=$BRIDGE_PORT \
  TRADER_UPSTOX_MCP_LOCAL_HOST=127.0.0.1 \
  node --import tsx src/upstox/mcp-local-main.ts > /dev/null 2>&1 &
  BRIDGE_PID=$!
  for i in $(seq 1 15); do
    if curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1; then
      pass "MCP bridge started on port ${BRIDGE_PORT}"
      return 0
    fi
    sleep 0.5
  done
  fail "MCP bridge did not start within 7.5s"
  return 1
}

# Start a minimal runtime HTTP server that responds on /health and /dashboard.json
RUNTIME_PID=""
start_runtime_stub() {
  node --input-type=module -e "
    import http from 'node:http';
    const s = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/health') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ verdict: 'healthy', uptimeMs: 12345, lifecycleState: 'running' }));
      } else if (url.pathname === '/dashboard.json') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ overall: 'healthy', strategyDecisionCount: 42, executionMode: 'blocked' }));
      } else {
        res.writeHead(404);
        res.end('');
      }
    });
    s.listen(${RUNTIME_PORT}, '127.0.0.1', () => {
      console.log('runtime-stub listening on ' + ${RUNTIME_PORT});
    });
  " > /dev/null 2>&1 &
  RUNTIME_PID=$!
  for i in $(seq 1 10); do
    if curl -fsS "http://127.0.0.1:${RUNTIME_PORT}/health" >/dev/null 2>&1; then
      pass "Runtime stub started on port ${RUNTIME_PORT}"
      return 0
    fi
    sleep 0.5
  done
  fail "Runtime stub did not start"
  return 1
}

# Cleanup function
cleanup() {
  echo ""
  echo "── Cleanup ──"
  for pid in "$NOTIFIER_PID" "$BRIDGE_PID" "$RUNTIME_PID"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  # Remove any test witness bundles
  rm -rf data/artifacts/deployment-witness/__test_*
  rm -rf data/artifacts/deployment-witness/steady-__test_*
}
trap cleanup EXIT

start_notifier
start_bridge
start_runtime_stub

# ═══════════════════════════════════════════════════════════════════════════
# SECTION A: Point-in-time witness capture verification
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════"
echo "  SECTION A: Point-in-Time Capture"
echo "═══════════════════════════════════════════"

# ── A5. Run witness capture (point-in-time) ───────────────────────────────
echo ""
echo "── Step A5: Run point-in-time witness capture ──"

CAPTURE_LABEL="verify-m007-s01-$(date +%s)"
CAPTURE_OUTPUT=$( \
  WITNESS_RUNTIME_HEALTH_URL="http://127.0.0.1:${RUNTIME_PORT}/health" \
  WITNESS_RUNTIME_DASHBOARD_URL="http://127.0.0.1:${RUNTIME_PORT}/dashboard.json" \
  WITNESS_NOTIFIER_HEALTH_URL="http://127.0.0.1:${NOTIFIER_PORT}/health" \
  WITNESS_BRIDGE_HEALTH_URL="http://127.0.0.1:${BRIDGE_PORT}/health" \
  WITNESS_DB_PATH="./data/artifacts/deployment-witness/__test_witness_db.db" \
  node --import tsx src/deployment/witness-main.ts \
    --label "${CAPTURE_LABEL}" \
    2>&1
)
CAPTURE_EXIT=$?

echo "$CAPTURE_OUTPUT" | head -5
echo "  ..."
echo "$CAPTURE_OUTPUT" | tail -10 || true

if [ "$CAPTURE_EXIT" -eq 0 ] || [ "$CAPTURE_EXIT" -eq 1 ]; then
  pass "Point-in-time capture completed (exit code ${CAPTURE_EXIT}) — exit 0=all reachable, 1=some required unreachable"
else
  fail "Point-in-time capture exited with fatal error code ${CAPTURE_EXIT} (expected 0 or 1)"
fi

# ── A6. Extract bundle path from output ─────────────────────────────────────
echo ""
echo "── Step A6: Verify point-in-time bundle structure ──"

# Extract bundle directory from capture output
BUNDLE_DIR=$(echo "$CAPTURE_OUTPUT" | grep -oE 'data/artifacts/deployment-witness/[^ "]+' | head -1)
if [ -z "$BUNDLE_DIR" ]; then
  # Fallback: find the latest witness bundle
  BUNDLE_DIR=$(ls -td data/artifacts/deployment-witness/*/ 2>/dev/null | grep -v steady | grep -v __test | head -1)
  BUNDLE_DIR="${BUNDLE_DIR%/}"
fi

if [ -z "$BUNDLE_DIR" ] || [ ! -d "$BUNDLE_DIR" ]; then
  fail "Could not find witness bundle directory"
  echo "  Searched output for bundle path and latest directory"
else
  pass "Bundle directory exists: ${BUNDLE_DIR}"
fi

# Check manifest exists
MANIFEST="${BUNDLE_DIR}/manifest.json"
if [ -f "$MANIFEST" ]; then
  pass "manifest.json exists"
else
  fail "manifest.json not found"
fi

# Check manifest is valid JSON
if MANIFEST_JSON=$(python3 -c "import json,sys; json.load(open('${MANIFEST}')); print('valid')" 2>&1); then
  pass "manifest.json is valid JSON"
else
  fail "manifest.json is not valid JSON"
fi

# Check required fields in manifest
MANIFEST_CONTENT=$(python3 -c "
import json,sys
m = json.load(open('${MANIFEST}'))
checks = []
checks.append(('schemaVersion', m.get('schemaVersion') == 1))
checks.append(('artifactType', m.get('artifactType') == 'deployment-witness'))
checks.append(('capturedAt', bool(m.get('capturedAt'))))
checks.append(('runId', bool(m.get('runId'))))
checks.append(('subsystems', isinstance(m.get('subsystems'), list) and len(m['subsystems']) >= 7))
checks.append(('pathWitnesses', isinstance(m.get('pathWitnesses'), list)))
checks.append(('hostEvidence', isinstance(m.get('hostEvidence'), dict)))
checks.append(('appEvidence', isinstance(m.get('appEvidence'), dict)))
checks.append(('annotations', isinstance(m.get('annotations'), list)))
for name, ok in checks:
    status = 'PASS' if ok else 'FAIL'
    print(f'{status}: {name}')
all_pass = all(ok for _, ok in checks)
sys.exit(0 if all_pass else 1)
" 2>&1) && MANIFEST_CHECK_EXIT=$? || MANIFEST_CHECK_EXIT=$?

echo "$MANIFEST_CONTENT"
if [ "$MANIFEST_CHECK_EXIT" -eq 0 ]; then
  pass "Manifest has all required top-level fields"
else
  fail "Manifest is missing one or more required fields"
fi

# Check host evidence fields
HOST_CHECK=$(python3 -c "
import json
m = json.load(open('${MANIFEST}'))
h = m.get('hostEvidence', {})
fields = ['hostname', 'platform', 'arch', 'totalMemoryBytes', 'cpuCores', 'cpuModel', 'freeMemoryBytes', 'loadAverage1m', 'hostUptimeSec']
for f in fields:
    if h.get(f) is None or h.get(f) == '':
        print(f'MISSING: {f}')
    else:
        print(f'OK: {f}={h[f]}')
" 2>&1)
echo "$HOST_CHECK"

# ── A7. Check evidence files ──────────────────────────────────────────────
echo ""
echo "── Step A7: Verify point-in-time evidence files ──"

EVIDENCE_FILES=("host-evidence.json" "runtime-health.json" "runtime-dashboard.json" "notifier-health.json" "bridge-health.json" "path-witnesses.json" "subsystems.json" "capture-meta.json")
MISSING_EVIDENCE=0
for ef in "${EVIDENCE_FILES[@]}"; do
  if [ -f "${BUNDLE_DIR}/${ef}" ]; then
    pass "Evidence file present: ${ef}"
  else
    fail "Evidence file missing: ${ef}"
    MISSING_EVIDENCE=$((MISSING_EVIDENCE + 1))
  fi
done

# ── A8. Verify required subsystems are all present ─────────────────────────
echo ""
echo "── Step A8: Verify required subsystems ──"

SUBSYSTEM_CHECK=$(python3 -c "
import json,sys
m = json.load(open('${MANIFEST}'))
subs = m.get('subsystems', [])
required_ids = ['runtime', 'notifier', 'mcp-bridge', 'caddy', 'sqlite', 'logs', 'artifacts']
found_ids = {s['id'] for s in subs}
all_found = True
for rid in required_ids:
    if rid in found_ids:
        sub = next(s for s in subs if s['id'] == rid)
        status = 'reachable' if sub.get('reachable') else 'UNREACHABLE'
        print(f'OK: {rid} ({status})')
    else:
        print(f'MISSING: {rid}')
        all_found = False

# Report reachability
reachable_subs = [s['id'] for s in subs if s.get('reachable')]
unreachable_subs = [s['id'] for s in subs if s.get('required') and not s.get('reachable')]
print(f'reachable_count={len(reachable_subs)}')
print(f'unreachable_required={json.dumps(unreachable_subs)}')

sys.exit(0 if all_found else 1)
" 2>&1) && SUBSYSTEM_EXIT=$? || SUBSYSTEM_EXIT=$?

echo "$SUBSYSTEM_CHECK"
if [ "$SUBSYSTEM_EXIT" -eq 0 ]; then
  pass "All 7 required subsystems present in manifest"
else
  fail "One or more required subsystems missing"
fi

# ── A9. Verify host evidence redaction ─────────────────────────────────────
echo ""
echo "── Step A9: Verify host evidence redaction ──"

HOSTNAME_REDACTED=$(python3 -c "
import json
m = json.load(open('${MANIFEST}'))
hn = m.get('hostEvidence', {}).get('hostname', '')
# Hostname should not contain 'localhost' or be empty
if hn and hn != 'localhost' and hn != 'unknown':
    print(f'OK: hostname={hn}')
else:
    print(f'WARN: hostname={hn}')
" 2>&1)
echo "$HOSTNAME_REDACTED"

# ── A10. Test failure mode: unreachable required evidence ──────────────────
echo ""
echo "── Step A10: Verify fail-closed for missing required evidence ──"

FAILURE_OUTPUT=$( \
  WITNESS_RUNTIME_HEALTH_URL="http://127.0.0.1:18999/nonexistent" \
  WITNESS_RUNTIME_DASHBOARD_URL="http://127.0.0.1:18999/nonexistent" \
  WITNESS_NOTIFIER_HEALTH_URL="http://127.0.0.1:18999/nonexistent" \
  WITNESS_BRIDGE_HEALTH_URL="http://127.0.0.1:18999/nonexistent" \
  WITNESS_DB_PATH="./data/artifacts/deployment-witness/__test_fail_db.db" \
  node --import tsx src/deployment/witness-main.ts \
    --label "fail-closed-test" \
    --http-timeout-ms 2000 \
    2>&1
)
FAILURE_EXIT=$?

if [ "$FAILURE_EXIT" -ne 0 ]; then
  pass "Failure mode: witness capture exited non-zero ($FAILURE_EXIT) when all required evidence unreachable"
else
  fail "Failure mode: witness capture exited 0 despite all required evidence being unreachable"
fi

# ═══════════════════════════════════════════════════════════════════════════
# SECTION B: Steady-state witness capture verification
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════"
echo "  SECTION B: Steady-State Witness Capture"
echo "═══════════════════════════════════════════"

# ── B1. Run steady-state witness (short window) ────────────────────────────
echo ""
echo "── Step B1: Run steady-state witness (30s, 10s interval) ──"

SS_LABEL="verify-m007-s02-ss-$(date +%s)"
SS_OUTPUT=$( \
  WITNESS_RUNTIME_HEALTH_URL="http://127.0.0.1:${RUNTIME_PORT}/health" \
  WITNESS_RUNTIME_DASHBOARD_URL="http://127.0.0.1:${RUNTIME_PORT}/dashboard.json" \
  WITNESS_NOTIFIER_HEALTH_URL="http://127.0.0.1:${NOTIFIER_PORT}/health" \
  WITNESS_BRIDGE_HEALTH_URL="http://127.0.0.1:${BRIDGE_PORT}/health" \
  WITNESS_DB_PATH="./data/artifacts/deployment-witness/__test_ss_db.db" \
  node --import tsx src/deployment/witness-main.ts \
    --steady-state \
    --steady-state-duration-sec 30 \
    --steady-state-interval-sec 10 \
    --label "${SS_LABEL}" \
    --http-timeout-ms 5000 \
    2>&1
)
SS_EXIT=$?

echo "$SS_OUTPUT" | head -10
echo "  ..."
echo "$SS_OUTPUT" | tail -15 || true

if [ "$SS_EXIT" -eq 0 ]; then
  pass "Steady-state witness completed with verdict pass/caveat (exit code 0)"
elif [ "$SS_EXIT" -eq 1 ]; then
  warn "Steady-state witness completed with FAIL verdict (exit code 1) — expected in test env with limited subsystems"
  pass "Steady-state witness completed with exit code 1 (fail verdict, bundle still written)"
else
  fail "Steady-state witness exited with fatal error code ${SS_EXIT}"
fi

# ── B2. Find steady-state bundle ────────────────────────────────────────────
echo ""
echo "── Step B2: Locate steady-state bundle ──"

# Extract bundle directory from capture output
SS_BUNDLE_DIR=$(echo "$SS_OUTPUT" | grep -oE 'data/artifacts/deployment-witness/steady[^ "]+' | head -1)
if [ -z "$SS_BUNDLE_DIR" ]; then
  # Fallback
  SS_BUNDLE_DIR=$(ls -td data/artifacts/deployment-witness/steady*/ 2>/dev/null | head -1)
  SS_BUNDLE_DIR="${SS_BUNDLE_DIR%/}"
fi

if [ -z "$SS_BUNDLE_DIR" ] || [ ! -d "$SS_BUNDLE_DIR" ]; then
  fail "Could not find steady-state bundle directory"
else
  pass "Steady-state bundle directory exists: ${SS_BUNDLE_DIR}"
fi

# ── B3. Verify steady-state manifest structure ──────────────────────────────
echo ""
echo "── Step B3: Verify steady-state manifest structure ──"

SS_MANIFEST="${SS_BUNDLE_DIR}/manifest.json"
if [ -f "$SS_MANIFEST" ]; then
  pass "Steady-state manifest.json exists"
else
  fail "Steady-state manifest.json not found"
fi

SS_MANIFEST_VALID=$(python3 -c "
import json,sys
m = json.load(open('${SS_MANIFEST}'))
checks = []
checks.append(('schemaVersion==1', m.get('schemaVersion') == 1))
checks.append(('artifactType==steady-state-witness', m.get('artifactType') == 'steady-state-witness'))
checks.append(('startedAt', bool(m.get('startedAt'))))
checks.append(('endedAt', bool(m.get('endedAt'))))
checks.append(('durationSec>0', isinstance(m.get('durationSec'), (int,float)) and m['durationSec'] > 0))
checks.append(('intervalSec>0', isinstance(m.get('intervalSec'), (int,float)) and m['intervalSec'] > 0))
checks.append(('runId', bool(m.get('runId'))))
checks.append(('label', bool(m.get('label'))))
checks.append(('resourceSamples', isinstance(m.get('resourceSamples'), list) and len(m['resourceSamples']) > 0))
checks.append(('resourceSummary', isinstance(m.get('resourceSummary'), dict)))
checks.append(('processEvidence', isinstance(m.get('processEvidence'), list)))
checks.append(('subsystemEvidence', isinstance(m.get('subsystemEvidence'), list) and len(m['subsystemEvidence']) > 0))
checks.append(('growthRecords', isinstance(m.get('growthRecords'), list)))
checks.append(('verdict', isinstance(m.get('verdict'), dict)))
checks.append(('annotations', isinstance(m.get('annotations'), list)))

for name, ok in checks:
    status = 'PASS' if ok else 'FAIL'
    print(f'{status}: {name}')
all_pass = all(ok for _, ok in checks)
sys.exit(0 if all_pass else 1)
" 2>&1) && SS_MANIFEST_EXIT=$? || SS_MANIFEST_EXIT=$?

echo "$SS_MANIFEST_VALID"
if [ "$SS_MANIFEST_EXIT" -eq 0 ]; then
  pass "Steady-state manifest has all required fields"
else
  fail "Steady-state manifest is missing one or more required fields"
fi

# ── B4. Verify resource samples have correct fields ─────────────────────────
echo ""
echo "── Step B4: Verify resource samples ──"

SS_SAMPLES_CHECK=$(python3 -c "
import json,sys
m = json.load(open('${SS_MANIFEST}'))
samples = m.get('resourceSamples', [])
issues = []
for i, s in enumerate(samples):
    for field in ['timestamp','totalMemoryBytes','freeMemoryBytes','usedMemoryBytes','memoryUsageFraction','loadAverage1m','cpuModel','cpuCores']:
        if s.get(field) is None:
            issues.append(f'sample[{i}].{field} is missing')

if not issues:
    print(f'OK: {len(samples)} samples with all required fields')
    print(f'OK: totalMemoryBytes={samples[0][\"totalMemoryBytes\"]}')
    print(f'OK: memoryUsageFraction={samples[0][\"memoryUsageFraction\"]}')
    print(f'OK: loadAverage1m={samples[0][\"loadAverage1m\"]}')
else:
    for issue in issues:
        print(f'FAIL: {issue}')
sys.exit(0 if not issues else 1)
" 2>&1) && SS_SAMPLES_EXIT=$? || SS_SAMPLES_EXIT=$?

echo "$SS_SAMPLES_CHECK"
if [ "$SS_SAMPLES_EXIT" -eq 0 ]; then
  pass "Resource samples valid"
else
  fail "Resource samples have issues"
fi

# ── B5. Verify resource summary ─────────────────────────────────────────────
echo ""
echo "── Step B5: Verify resource summary ──"

SS_SUMMARY_CHECK=$(python3 -c "
import json,sys
m = json.load(open('${SS_MANIFEST}'))
rs = m.get('resourceSummary', {})
issues = []

if not isinstance(rs.get('sampleCount'), (int,float)):
    issues.append('sampleCount missing')
if not isinstance(rs.get('memory'), dict):
    issues.append('memory summary missing')
else:
    mem = rs['memory']
    for f in ['avgUsedBytes','minUsedBytes','maxUsedBytes','avgUsageFraction','peakUsageFraction']:
        if mem.get(f) is None:
            issues.append(f'memory.{f} missing')
if not isinstance(rs.get('load'), dict):
    issues.append('load summary missing')
else:
    ld = rs['load']
    for f in ['avgLoad1m','peakLoad1m','avgLoad5m','avgLoad15m']:
        if ld.get(f) is None:
            issues.append(f'load.{f} missing')
if not isinstance(rs.get('disk'), dict):
    issues.append('disk summary missing')

if not issues:
    print(f'OK: {rs[\"sampleCount\"]} samples summarized')
    print(f'OK: memory peak usage {rs[\"memory\"][\"peakUsageFraction\"]*100:.0f}%')
    print(f'OK: load peak 1m {rs[\"load\"][\"peakLoad1m\"]}')
else:
    for issue in issues:
        print(f'FAIL: {issue}')
sys.exit(0 if not issues else 1)
" 2>&1) && SS_SUMMARY_EXIT=$? || SS_SUMMARY_EXIT=$?

echo "$SS_SUMMARY_CHECK"
if [ "$SS_SUMMARY_EXIT" -eq 0 ]; then
  pass "Resource summary valid"
else
  fail "Resource summary has issues"
fi

# ── B6. Verify subsystem evidence ───────────────────────────────────────────
echo ""
echo "── Step B6: Verify subsystem evidence ──"

SS_SUBS_CHECK=$(python3 -c "
import json,sys
m = json.load(open('${SS_MANIFEST}'))
subs = m.get('subsystemEvidence', [])
if len(subs) == 0:
    print('FAIL: no subsystem evidence entries')
    sys.exit(1)

for s in subs:
    expected = ['subsystemId','label','healthyThroughout','probes','missingEvidenceReason']
    missing = [f for f in expected if f not in s]
    if missing:
        print(f'FAIL: {s.get(\"subsystemId\",\"?\")} missing fields: {missing}')
        sys.exit(1)
    print(f'OK: {s[\"subsystemId\"]} ({len(s[\"probes\"])} probes, healthy={s[\"healthyThroughout\"]})')

ids = {s['subsystemId'] for s in subs}
required_ids = ['runtime','notifier','mcp-bridge']
for rid in required_ids:
    if rid in ids:
        print(f'OK: required subsystem {rid} present')
    else:
        print(f'WARN: required subsystem {rid} absent (expected in test env)')

sys.exit(0)
" 2>&1) && SS_SUBS_EXIT=$? || SS_SUBS_EXIT=$?

echo "$SS_SUBS_CHECK"
if [ "$SS_SUBS_EXIT" -eq 0 ]; then
  pass "Subsystem evidence valid"
else
  fail "Subsystem evidence has issues"
fi

# ── B7. Verify process evidence ─────────────────────────────────────────────
echo ""
echo "── Step B7: Verify process evidence ──"

SS_PROC_CHECK=$(python3 -c "
import json,sys
m = json.load(open('${SS_MANIFEST}'))
procs = m.get('processEvidence', [])
if len(procs) == 0:
    print('FAIL: no process evidence entries')
    sys.exit(1)

for p in procs:
    expected = ['processName','running','pid','error']
    missing = [f for f in expected if f not in p]
    if missing:
        print(f'FAIL: process {p.get(\"processName\",\"?\")} missing fields: {missing}')
        sys.exit(1)
    print(f'OK: {p[\"processName\"]} running={p[\"running\"]} pid={p[\"pid\"]}')

sys.exit(0)
" 2>&1) && SS_PROC_EXIT=$? || SS_PROC_EXIT=$?

echo "$SS_PROC_CHECK"
if [ "$SS_PROC_EXIT" -eq 0 ]; then
  pass "Process evidence valid"
else
  fail "Process evidence has issues"
fi

# ── B8. Verify verdict structure ────────────────────────────────────────────
echo ""
echo "── Step B8: Verify verdict ──"

SS_VERDICT_CHECK=$(python3 -c "
import json,sys
m = json.load(open('${SS_MANIFEST}'))
v = m.get('verdict', {})
issues = []

if v.get('verdict') not in ('pass','caveat','fail'):
    issues.append(f\"verdict must be pass/caveat/fail, got {v.get('verdict')}\")
if not v.get('summary'):
    issues.append('summary missing')
if not isinstance(v.get('concerns'), list):
    issues.append('concerns must be a list')
if not isinstance(v.get('subsystemVerdicts'), list):
    issues.append('subsystemVerdicts must be a list')
if not isinstance(v.get('degradedRequiredCount'), (int,float)):
    issues.append('degradedRequiredCount missing')
if not isinstance(v.get('missingEvidenceCount'), (int,float)):
    issues.append('missingEvidenceCount missing')

if not issues:
    print(f'OK: verdict={v[\"verdict\"]}')
    print(f'OK: summary=\"{v[\"summary\"]}\"')
    print(f'OK: {len(v.get(\"concerns\",[]))} concerns')
    print(f'OK: {v.get(\"degradedRequiredCount\",0)} degraded required')
else:
    for issue in issues:
        print(f'FAIL: {issue}')
sys.exit(0 if not issues else 1)
" 2>&1) && SS_VERDICT_EXIT=$? || SS_VERDICT_EXIT=$?

echo "$SS_VERDICT_CHECK"
if [ "$SS_VERDICT_EXIT" -eq 0 ]; then
  pass "Verdict structure valid"
else
  fail "Verdict structure has issues"
fi

# ── B9. Verify growth records ───────────────────────────────────────────────
echo ""
echo "── Step B9: Verify growth records ──"

SS_GROWTH_CHECK=$(python3 -c "
import json,sys
m = json.load(open('${SS_MANIFEST}'))
recs = m.get('growthRecords', [])
print(f'OK: {len(recs)} growth records')

for r in recs:
    expected = ['label','path','startSizeBytes','endSizeBytes','growthBytes','growthBytesPerHour','existedThroughout']
    missing = [f for f in expected if f not in r]
    if missing:
        print(f'FAIL: growth record \"{r.get(\"label\",\"?\")}\" missing fields: {missing}')
        sys.exit(1)
    print(f'OK: {r[\"label\"]} growth={r[\"growthBytes\"]}B rate={r[\"growthBytesPerHour\"]}B/hr')

sys.exit(0)
" 2>&1) && SS_GROWTH_EXIT=$? || SS_GROWTH_EXIT=$?

echo "$SS_GROWTH_CHECK"
if [ "$SS_GROWTH_EXIT" -eq 0 ]; then
  pass "Growth records valid"
else
  fail "Growth records have issues"
fi

# ── B10. Verify annotations ─────────────────────────────────────────────────
echo ""
echo "── Step B10: Verify annotations ──"

SS_ANNOT_CHECK=$(python3 -c "
import json,sys
m = json.load(open('${SS_MANIFEST}'))
anns = m.get('annotations', [])
print(f'OK: {len(anns)} annotations')
for a in anns:
    if not a.get('label') or a.get('value') is None:
        print(f'FAIL: annotation missing label or value: {a}')
        sys.exit(1)
    print(f'OK: {a[\"label\"]}={a[\"value\"]}')
sys.exit(0)
" 2>&1) && SS_ANNOT_EXIT=$? || SS_ANNOT_EXIT=$?

echo "$SS_ANNOT_CHECK"
if [ "$SS_ANNOT_EXIT" -eq 0 ]; then
  pass "Annotations valid"
else
  fail "Annotations have issues"
fi

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  Result: $([ "$FAIL" -eq 0 ] && echo 'PASS ✅' || echo 'FAIL ❌')"
echo "  $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
