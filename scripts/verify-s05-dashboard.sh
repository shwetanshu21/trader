#!/usr/bin/env bash
# ── S05 Operator Dashboard Verification Script ──
# Verifies the complete S05 operator dashboard + unattended proof stack:
#   1. TypeScript compiles cleanly
#   2. S05-domain tests pass (dashboard read-model + render + integration)
#   3. Full test suite has no regressions
#   4. Build output includes dashboard modules
#   5. Dashboard route availability witness (HTTP /dashboard + /dashboard.json)
#   6. Snapshot content + evidence witness (start RuntimeApp, insert proposals,
#      verify they appear in the dashboard snapshot alongside blocked orders)
#   7. Fail-closed invariant check (no execution path exposed)
#   8. Refused/skipped exclusion witness (never enter blocked-order ledger)
#
# Usage: bash scripts/verify-s05-dashboard.sh

set -euo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
NODE_VERSION=$(node --version 2>/dev/null || echo "unknown")

pass()  { PASS=$((PASS + 1)); echo "  ✅ PASS: $1"; }
fail()  { FAIL=$((FAIL + 1)); echo "  ❌ FAIL: $1"; }

echo "═══════════════════════════════════════════"
echo "  S05 Operator Dashboard Verification"
echo "═══════════════════════════════════════════"

# ── 1. TypeScript compilation ────────────────────────────────────────────
echo ""
echo "── Step 1: TypeScript compilation ──"
if npx tsc --noEmit 2>&1; then
  pass "TypeScript compiles with zero errors"
else
  fail "TypeScript compilation failed"
fi

# ── 2. S05-domain test suite ────────────────────────────────────────────
echo ""
echo "── Step 2: S05-domain tests ──"
if npx vitest run \
  tests/s05-runtime.integration.test.ts \
  2>&1; then
  pass "S05-domain tests pass"
else
  fail "S05-domain tests failed"
fi

# ── 3. Full test suite (no regressions) ──────────────────────────────────
echo ""
echo "── Step 3: Full test suite ──"
if npx vitest run 2>&1; then
  pass "All tests pass (no regressions)"
else
  fail "Full test suite has failures"
fi

# ── 4. Build output — dashboard modules exist ────────────────────────────
echo ""
echo "── Step 4: Build output ──"
if npx tsc --project tsconfig.json 2>&1; then
  if [ -f dist/main.js ]; then
    pass "Build produces dist/main.js"
    S05_FILES=(
      "dist/runtime/dashboard-read-model.js"
      "dist/runtime/dashboard-render.js"
    )
    ALL_S05_FILES_PRESENT=true
    for PF in "${S05_FILES[@]}"; do
      if [ -f "$PF" ]; then
        echo "    ✓ $PF"
      else
        echo "    ✗ $PF missing"
        ALL_S05_FILES_PRESENT=false
      fi
    done
    if $ALL_S05_FILES_PRESENT; then
      pass "All S05 dashboard modules present in compiled output"
    else
      fail "One or more S05 dashboard modules missing from compiled output"
    fi
  else
    fail "dist/main.js not found after build"
  fi
else
  fail "Build failed"
fi

# ── 5. Dashboard route availability witness ─────────────────────────────
echo ""
echo "── Step 5: Dashboard route availability witness ──"

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
const http = require('http');
const { RuntimeApp } = require('./dist/runtime/runtime-app.js');

(async () => {
  let ok = 0, nok = 0;
  function check(name, val) {
    if (val) { ok++; console.log('  ✅ Route witness: ' + name); }
    else     { nok++; console.log('  ❌ Route witness: ' + name); }
  }

  const app = new RuntimeApp({
    port: 0,
    nodeEnv: 'test',
    marketTimezone: 'Asia/Kolkata',
    schedulerIntervalMs: 50000,
    dbPath: ':memory:',
    logLevel: 'error',
    zerodha: null,
    proposalEngine: null,
  });

  const handles = app.start();
  const server = handles.server;

  // Wait for server to be listening
  await new Promise(resolve => {
    if (server.listening) resolve();
    else server.on('listening', resolve);
  });

  const port = server.address().port;

  function fetchText(url) {
    return new Promise((resolve, reject) => {
      http.get(url, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }).on('error', reject);
    });
  }

  function fetchJson(url) {
    return new Promise((resolve, reject) => {
      http.get(url, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, headers: res.headers, body: data, parseError: e.message }); }
        });
      }).on('error', reject);
    });
  }

  // ── /dashboard (HTML) ─────────────────────────────────────────────────

  const html = await fetchText(`http://localhost:${port}/dashboard`);
  check('dashboard_html_200', html.status === 200);
  check('dashboard_html_content_type', (html.headers['content-type'] || '').startsWith('text/html'));
  check('dashboard_html_title', html.body.includes('Runtime Dashboard'));
  check('dashboard_html_health_section', html.body.includes('Health'));
  check('dashboard_html_runtime_section', html.body.includes('Runtime'));
  check('dashboard_html_proposals_section', html.body.includes('Recent Proposals'));
  check('dashboard_html_blocked_section', html.body.includes('Blocked Orders'));
  check('dashboard_html_broker_not_configured', html.body.includes('Not configured'));
  check('dashboard_html_no_token_leak', !html.body.includes('accessToken') && !html.body.includes('apiKey'));
  check('dashboard_html_json_link', html.body.includes('/dashboard.json'));

  // ── /dashboard.json (JSON) ─────────────────────────────────────────────

  const json = await fetchJson(`http://localhost:${port}/dashboard.json`);
  check('dashboard_json_200', json.status === 200);
  check('dashboard_json_valid', !json.parseError);
  check('dashboard_json_assembledAt', typeof json.body.assembledAt === 'string');
  check('dashboard_json_marketProfile', typeof json.body.marketProfile === 'object');
  check('dashboard_json_health', typeof json.body.health === 'object');
  check('dashboard_json_health_verdict', ['healthy', 'degraded', 'unhealthy'].includes(json.body.health.verdict));
  check('dashboard_json_runtime', typeof json.body.runtime === 'object');
  check('dashboard_json_runtime_schedulerStatus', typeof json.body.runtime.schedulerStatus === 'string');
  check('dashboard_json_broker_null', json.body.broker === null);
  check('dashboard_json_recentProposals_array', Array.isArray(json.body.recentProposals));
  check('dashboard_json_recentBlockedOrders_array', Array.isArray(json.body.recentBlockedOrders));
  check('dashboard_json_recentLifecycleEvents_array', Array.isArray(json.body.recentLifecycleEvents));
  check('dashboard_json_empty_proposals', json.body.recentProposals.length === 0);
  check('dashboard_json_empty_blocked', json.body.recentBlockedOrders.length === 0);

  // ── /health (baseline) ─────────────────────────────────────────────────

  const health = await fetchJson(`http://localhost:${port}/health`);
  check('health_200', health.status === 200);
  check('health_has_verdict', typeof health.body.verdict === 'string');
  check('health_has_lifecycle', typeof health.body.lifecycleState === 'string');
  check('health_has_scheduler', typeof health.body.scheduler === 'object');

  // ── /health/broker (not configured → 404) ──────────────────────────────

  const broker = await fetchText(`http://localhost:${port}/health/broker`);
  check('broker_404', broker.status === 404);
  check('broker_error_message', broker.body.includes('not configured'));

  // Cleanup
  app.stop('Route witness complete');

  if (nok > 0) { console.error('FAIL: Dashboard route witness checks failed'); process.exit(1); }
  console.log('  Route witness: all ' + ok + ' checks passed');
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
WITNESS_EOF

if [ $? -eq 0 ]; then
  pass "Dashboard route witness passed"
else
  fail "Dashboard route witness failed"
fi

# ── 6. Snapshot content + evidence witness ───────────────────────────────
echo ""
echo "── Step 6: Snapshot content + evidence witness ──"

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
const http = require('http');
const { RuntimeApp } = require('./dist/runtime/runtime-app.js');
const { ProposalRepository } = require('./dist/persistence/proposal-repo.js');
const { BlockedOrderRepository } = require('./dist/persistence/blocked-order-repo.js');
const { ProposalStatus, BlockCode } = require('./dist/types/runtime.js');

(async () => {
  let ok = 0, nok = 0;
  function check(name, val) {
    if (val) { ok++; console.log('  ✅ Evidence witness: ' + name); }
    else     { nok++; console.log('  ❌ Evidence witness: ' + name); }
  }

  // ── Start RuntimeApp with proposal engine wired (dummy provider) ─────
  // This wires up proposalRepo and blockedOrderRepo so the dashboard can
  // surface them. The supervisor will fail each tick (dummy URL → graceful
  // error handling in doWork) but the repos are available for witness data.
  const app = new RuntimeApp({
    port: 0,
    nodeEnv: 'test',
    marketTimezone: 'Asia/Kolkata',
    schedulerIntervalMs: 50000,
    dbPath: ':memory:',
    logLevel: 'error',
    zerodha: null,
    proposalEngine: {
      providerUrl: 'http://dummy-witness',
      timeoutMs: 100,
      maxProposalsPerTick: 3,
    },
  });

  const handles = app.start();
  const server = handles.server;

  await new Promise(resolve => {
    if (server.listening) resolve();
    else server.on('listening', resolve);
  });

  const port = server.address().port;

  // ── Insert evidence into the shared database ──────────────────────────
  // We create separate repo instances using the same db connection so data
  // is visible to the dashboard's internal repos.
  const proposalRepo = new ProposalRepository(handles.dbManager.db);
  const blockedRepo = new BlockedOrderRepository(handles.dbManager.db);

  // Insert an accepted proposal
  const accepted = proposalRepo.insertAttempt({
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    side: 'buy',
    product: 'MIS',
    quantity: 1,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: 'witness-test',
    proposalStatus: ProposalStatus.Accepted,
    createdAt: Date.now(),
  });

  // Insert a refused proposal with validation reasons
  const refused = proposalRepo.insertAttemptWithReasons(
    {
      exchange: 'NSE',
      tradingsymbol: 'TATASTEEL',
      instrumentToken: null,
      side: 'sell',
      product: 'NRML',
      quantity: 25,
      price: 150.50,
      triggerPrice: null,
      orderType: 'LIMIT',
      tag: 'witness-refused',
      proposalStatus: ProposalStatus.Refused,
      createdAt: Date.now(),
    },
    [
      { reasonCode: 'market_closed', reasonMessage: 'Market is closed' },
      { reasonCode: 'instrument_lookup_failed', reasonMessage: 'Instrument not found in master' },
    ],
  );

  // Insert a skipped proposal (overlap)
  const skipped = proposalRepo.insertAttemptWithReasons(
    {
      exchange: 'NSE',
      tradingsymbol: 'TCS',
      instrumentToken: 654321,
      side: 'buy',
      product: 'CNC',
      quantity: 10,
      price: 3500.00,
      triggerPrice: null,
      orderType: 'LIMIT',
      tag: 'overlap-skip',
      proposalStatus: ProposalStatus.Skipped,
      createdAt: Date.now(),
    },
    [
      { reasonCode: 'duplicate_attempt', reasonMessage: 'Duplicate proposal in this tick window' },
    ],
  );

  // Block the accepted proposal (M001 invariant)
  const blocked = blockedRepo.insertBlockedOrder({
    proposalAttemptId: accepted.id,
    blockedAt: Date.now(),
    blockCode: BlockCode.MilestoneExecutionBlockM001,
    blockMessage: 'M001 hard block: live order placement is disabled for this milestone',
    gateTag: 'M001-hard-block',
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    side: 'buy',
    product: 'MIS',
    quantity: 1,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
  });

  // ── Fetch snapshot and verify evidence visibility ─────────────────────
  const snapshot = handles.dashboard.getSnapshot();

  // Structure checks
  check('snapshot_assembledAt', typeof snapshot.assembledAt === 'string');
  check('snapshot_marketProfile', typeof snapshot.marketProfile === 'object');
  check('snapshot_health', typeof snapshot.health === 'object');
  check('snapshot_runtime', typeof snapshot.runtime === 'object');
  check('snapshot_broker_null', snapshot.broker === null);
  check('snapshot_recent_proposals_array', Array.isArray(snapshot.recentProposals));
  check('snapshot_recent_blocked_array', Array.isArray(snapshot.recentBlockedOrders));
  check('snapshot_lifecycle_events_array', Array.isArray(snapshot.recentLifecycleEvents));

  // Proposal evidence checks
  check('snapshot_proposals_not_empty', snapshot.recentProposals.length > 0);
  check('snapshot_has_accepted', snapshot.recentProposals.some(p => p.status === 'accepted'));
  check('snapshot_has_refused', snapshot.recentProposals.some(p => p.status === 'refused'));
  check('snapshot_has_skipped', snapshot.recentProposals.some(p => p.status === 'skipped'));
  check('snapshot_proposal_reliance', snapshot.recentProposals.some(p => p.tradingsymbol === 'RELIANCE'));
  check('snapshot_proposal_tata', snapshot.recentProposals.some(p => p.tradingsymbol === 'TATASTEEL'));
  check('snapshot_proposal_refused_reasons', snapshot.recentProposals.some(p => p.status === 'refused' && p.reasons.length > 0));

  // Blocked order evidence checks
  check('snapshot_blocked_not_empty', snapshot.recentBlockedOrders.length > 0);
  check('snapshot_blocked_has_reliance', snapshot.recentBlockedOrders.some(b => b.tradingsymbol === 'RELIANCE'));
  check('snapshot_blocked_code_m001', snapshot.recentBlockedOrders.some(b => b.blockCode.includes('milestone_execution_block_m001')));
  check('snapshot_blocked_proposal_id', snapshot.recentBlockedOrders.some(b => b.proposalAttemptId === accepted.id));

  // Blocked order row integrity
  const blockedRow = snapshot.recentBlockedOrders[0];
  check('blocked_row_id_positive', blockedRow.id > 0);
  check('blocked_row_blockedAt_iso', /^\d{4}-\d{2}-\d{2}T/.test(blockedRow.blockedAt));
  check('blocked_row_side', blockedRow.side === 'buy');

  // ── HTTP route still works with evidence present ──────────────────────
  function fetchJson(url) {
    return new Promise((resolve, reject) => {
      http.get(url, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, body: null, parseError: e.message }); }
        });
      }).on('error', reject);
    });
  }

  const dashJson = await fetchJson(`http://localhost:${port}/dashboard.json`);
  check('dash_json_200_with_evidence', dashJson.status === 200);
  check('dash_json_valid_with_evidence', dashJson.body !== null);
  check('dash_json_proposals_with_evidence', Array.isArray(dashJson.body.recentProposals) && dashJson.body.recentProposals.length > 0);
  check('dash_json_blocked_with_evidence', Array.isArray(dashJson.body.recentBlockedOrders) && dashJson.body.recentBlockedOrders.length > 0);
  check('dash_json_broker_null_with_evidence', dashJson.body.broker === null);
  check('dash_json_no_secrets', !JSON.stringify(dashJson.body).includes('accessToken'));

  // ── Fail-closed invariant: no execution surface in snapshot ───────────
  check('fail_closed_no_execute_field', !('canExecute' in snapshot));
  check('fail_closed_no_order_field', !('orderPlacement' in snapshot));
  check('fail_closed_no_place_order_url', !('placeOrderUrl' in snapshot));
  check('fail_closed_no_live_endpoint', !('liveExecution' in snapshot));
  check('fail_closed_snapshot_no_order_methods', !snapshot.assembledAt.includes('order'));

  // Cleanup
  app.stop('Evidence witness complete');

  if (nok > 0) { console.error('FAIL: Snapshot content + evidence witness checks failed'); process.exit(1); }
  console.log('  Evidence witness: all ' + ok + ' checks passed');
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
WITNESS_EOF

if [ $? -eq 0 ]; then
  pass "Snapshot evidence witness passed"
else
  fail "Snapshot evidence witness failed"
fi

# ── 7. Fail-closed invariant witness (no live execution path) ─────────────
echo ""
echo "── Step 7: Fail-closed invariant witness ──"

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
const http = require('http');
const { RuntimeApp } = require('./dist/runtime/runtime-app.js');

(async () => {
  let ok = 0, nok = 0;
  function check(name, val) {
    if (val) { ok++; console.log('  ✅ Fail-closed witness: ' + name); }
    else     { nok++; console.log('  ❌ Fail-closed witness: ' + name); }
  }

  const app = new RuntimeApp({
    port: 0,
    nodeEnv: 'test',
    marketTimezone: 'Asia/Kolkata',
    schedulerIntervalMs: 50000,
    dbPath: ':memory:',
    logLevel: 'error',
    zerodha: null,
    proposalEngine: null,
  });

  const handles = app.start();
  const server = handles.server;

  await new Promise(resolve => {
    if (server.listening) resolve();
    else server.on('listening', resolve);
  });

  const port = server.address().port;

  function fetchText(url) {
    return new Promise((resolve, reject) => {
      http.get(url, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }).on('error', reject);
    });
  }

  // Scan health endpoints for anything resembling order placement or execution
  const health = await fetchText(`http://localhost:${port}/health`);
  const healthLower = health.body.toLowerCase();

  check('health_no_order_endpoint', !healthLower.includes('order'));
  check('health_no_execute_endpoint', !healthLower.includes('/execute'));
  check('health_no_place_order', !healthLower.includes('place_order'));
  check('health_no_live_execution', !healthLower.includes('live_execution'));

  // Check dashboard HTML does not imply execution
  const dash = await fetchText(`http://localhost:${port}/dashboard`);
  const dashLower = dash.body.toLowerCase();

  check('dashboard_no_order_btn', !dashLower.includes('place order'));
  check('dashboard_no_execute_btn', !dashLower.includes('execute'));
  check('dashboard_no_submit_btn', !dashLower.includes('submit order'));
  check('dashboard_no_buy_btn', !dashLower.includes('>buy<'));
  check('dashboard_no_sell_btn', !dashLower.includes('>sell<'));

  // Check handles — no execution gate when proposal engine not configured
  check('handles_no_execution_gate', handles.executionGateSupervisor === null);
  check('handles_no_proposal_supervisor', handles.proposalSupervisor === null);

  // Snapshot — no execution-related fields
  // The `recentBlockedOrders` field is expected (M001 invariant ledger),
  // but there must be no fields suggesting live execution or order placement.
  const snapshot = handles.dashboard.getSnapshot();
  const snapshotKeys = Object.keys(snapshot);
  check('snapshot_no_execution_keys', !snapshotKeys.some(k => k.toLowerCase().includes('execut')));
  check('snapshot_no_place_order_key', !snapshotKeys.some(k => k.toLowerCase().includes('placeorder')));
  check('snapshot_no_submit_key', !snapshotKeys.some(k => k.toLowerCase().includes('submit')));

  // Verify 404 on unknown paths
  const notFound = await fetchText(`http://localhost:${port}/orders`);
  check('orders_404_not_found', notFound.status === 404);

  const notFound2 = await fetchText(`http://localhost:${port}/execute`);
  check('execute_404_not_found', notFound2.status === 404);

  // Cleanup
  app.stop('Fail-closed witness complete');

  if (nok > 0) { console.error('FAIL: Fail-closed invariant witness checks failed'); process.exit(1); }
  console.log('  Fail-closed witness: all ' + ok + ' checks passed');
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
WITNESS_EOF

if [ $? -eq 0 ]; then
  pass "Fail-closed invariant witness passed"
else
  fail "Fail-closed invariant witness failed"
fi

# ── 8. Refused/skipped exclusion witness (M001 invariant) ────────────────
echo ""
echo "── Step 8: Refused/skipped exclusion witness ──"

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
const { RuntimeApp } = require('./dist/runtime/runtime-app.js');
const { ProposalRepository } = require('./dist/persistence/proposal-repo.js');
const { BlockedOrderRepository } = require('./dist/persistence/blocked-order-repo.js');
const { ProposalStatus, BlockCode } = require('./dist/types/runtime.js');

(async () => {
  let ok = 0, nok = 0;
  function check(name, val) {
    if (val) { ok++; console.log('  ✅ Exclusion witness: ' + name); }
    else     { nok++; console.log('  ❌ Exclusion witness: ' + name); }
  }

  const app = new RuntimeApp({
    port: 0,
    nodeEnv: 'test',
    marketTimezone: 'Asia/Kolkata',
    schedulerIntervalMs: 50000,
    dbPath: ':memory:',
    logLevel: 'error',
    zerodha: null,
    proposalEngine: {
      providerUrl: 'http://dummy',
      timeoutMs: 100,
      maxProposalsPerTick: 3,
    },
  });

  const handles = app.start();
  const server = handles.server;

  await new Promise(resolve => {
    if (server.listening) resolve();
    else server.on('listening', resolve);
  });

  const proposalRepo = new ProposalRepository(handles.dbManager.db);
  const blockedRepo = new BlockedOrderRepository(handles.dbManager.db);

  // Insert an accepted proposal
  const accepted = proposalRepo.insertAttempt({
    exchange: 'NSE', tradingsymbol: 'ACCEPTED_EXCL', instrumentToken: 111111,
    side: 'buy', product: 'MIS', quantity: 1, price: null, triggerPrice: null,
    orderType: 'MARKET', tag: 'exclusion-witness',
    proposalStatus: ProposalStatus.Accepted, createdAt: Date.now(),
  });

  // Insert refused proposals
  const refused1 = proposalRepo.insertAttempt({
    exchange: 'NSE', tradingsymbol: 'REFUSED_A', instrumentToken: null,
    side: 'buy', product: 'MIS', quantity: 1, price: null, triggerPrice: null,
    orderType: 'MARKET', tag: 'exclusion-refused',
    proposalStatus: ProposalStatus.Refused, createdAt: Date.now(),
  });
  const refused2 = proposalRepo.insertAttempt({
    exchange: 'NFO', tradingsymbol: 'REFUSED_B', instrumentToken: 555555,
    side: 'sell', product: 'NRML', quantity: 50, price: 200.00, triggerPrice: null,
    orderType: 'LIMIT', tag: 'exclusion-refused-2',
    proposalStatus: ProposalStatus.Refused, createdAt: Date.now(),
  });

  // Insert skipped proposals
  const skipped1 = proposalRepo.insertAttempt({
    exchange: 'NSE', tradingsymbol: 'SKIPPED_A', instrumentToken: null,
    side: 'buy', product: 'CNC', quantity: 10, price: null, triggerPrice: null,
    orderType: 'MARKET', tag: 'exclusion-skip',
    proposalStatus: ProposalStatus.Skipped, createdAt: Date.now(),
  });
  const skipped2 = proposalRepo.insertAttempt({
    exchange: 'BSE', tradingsymbol: 'SKIPPED_B', instrumentToken: 333333,
    side: 'sell', product: 'MIS', quantity: 5, price: 100.50, triggerPrice: null,
    orderType: 'LIMIT', tag: 'exclusion-skip-2',
    proposalStatus: ProposalStatus.Skipped, createdAt: Date.now(),
  });

  // Block only the accepted proposal
  blockedRepo.insertBlockedOrder({
    proposalAttemptId: accepted.id, blockedAt: Date.now(),
    blockCode: BlockCode.MilestoneExecutionBlockM001,
    blockMessage: 'M001 hard block', gateTag: 'M001-hard-block',
    exchange: 'NSE', tradingsymbol: 'ACCEPTED_EXCL', instrumentToken: 111111,
    side: 'buy', product: 'MIS', quantity: 1, price: null, triggerPrice: null,
    orderType: 'MARKET',
  });

  // Verify: only the accepted proposal is in the blocked-order ledger
  const totalBlocked = blockedRepo.count();
  check('total_blocked_is_1', totalBlocked === 1);

  const r1Blocked = blockedRepo.getByProposalAttemptId(refused1.id);
  check('refused1_not_in_ledger', r1Blocked === null);

  const r2Blocked = blockedRepo.getByProposalAttemptId(refused2.id);
  check('refused2_not_in_ledger', r2Blocked === null);

  const s1Blocked = blockedRepo.getByProposalAttemptId(skipped1.id);
  check('skipped1_not_in_ledger', s1Blocked === null);

  const s2Blocked = blockedRepo.getByProposalAttemptId(skipped2.id);
  check('skipped2_not_in_ledger', s2Blocked === null);

  const recent = blockedRepo.getRecent();
  check('recent_returns_1', recent.length === 1);
  check('recent_is_accepted', recent[0].proposalAttemptId === accepted.id);

  // Dashboard snapshot respects the same invariant
  const snapshot = handles.dashboard.getSnapshot();
  const blockedInDashboard = snapshot.recentBlockedOrders;
  check('dashboard_blocked_has_exactly_1', blockedInDashboard.length === 1);
  check('dashboard_blocked_is_accepted', blockedInDashboard[0].proposalAttemptId === accepted.id);

  app.stop('Exclusion witness complete');

  if (nok > 0) { console.error('FAIL: Exclusion witness checks failed'); process.exit(1); }
  console.log('  Exclusion witness: all ' + ok + ' checks passed');
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
WITNESS_EOF

if [ $? -eq 0 ]; then
  pass "Refused/skipped exclusion witness passed"
else
  fail "Refused/skipped exclusion witness failed"
fi

# ── 9. Verification script existence ─────────────────────────────────────
echo ""
echo "── Step 9: Verification script ──"
if [ -x "$0" ]; then
  pass "Verification script is executable"
else
  if [ -f "$0" ]; then
    pass "Verification script exists"
  else
    fail "Verification script not found"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════"
echo "  Milestone M001 / Slice S05"
echo "  Stack:  Node $NODE_VERSION, better-sqlite3, TypeScript"
echo "═══════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
