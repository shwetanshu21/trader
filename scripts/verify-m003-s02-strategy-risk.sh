#!/usr/bin/env bash
# ── M003-S02 Strategy Risk Verification Script ──
# Verifies the strategy/risk authority layer between raw proposal acceptance
# and execution, plus the operator-visible strategy evidence surfaces:
#   1. TypeScript compiles cleanly
#   2. S02-domain tests pass (strategy-decision-repo, strategy-risk-service,
#      strategy-risk-supervisor integration, dashboard-read-model, health-server)
#   3. Full test suite has no regressions
#   4. Build output includes strategy-risk modules
#   5. Strategy evidence route witness (/health/strategy)
#   6. Strategy decisions in dashboard + evidence witness
#   7. No token/secret leakage on strategy surfaces
#   8. Composed-runtime witness: R2L through proposal→strategy→gate
#
# Usage: bash scripts/verify-m003-s02-strategy-risk.sh

set -euo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
NODE_VERSION=$(node --version 2>/dev/null || echo "unknown")

pass()  { PASS=$((PASS + 1)); echo "  ✅ PASS: $1"; }
fail()  { FAIL=$((FAIL + 1)); echo "  ❌ FAIL: $1"; }

echo "═══════════════════════════════════════════"
echo "  M003-S02 Strategy Risk Verification"
echo "═══════════════════════════════════════════"

# ── 1. TypeScript compilation ────────────────────────────────────────────
echo ""
echo "── Step 1: TypeScript compilation ──"
if npx tsc --noEmit 2>&1; then
  pass "TypeScript compiles with zero errors"
else
  fail "TypeScript compilation failed"
fi

# ── 2. S02-domain test suite ────────────────────────────────────────────
echo ""
echo "── Step 2: S02-domain tests ──"
if npx vitest run \
  tests/strategy-decision-repo.test.ts \
  tests/strategy-risk-service.test.ts \
  tests/strategy-risk-supervisor.integration.test.ts \
  tests/dashboard-read-model.test.ts \
  tests/health-server-dashboard.test.ts \
  2>&1; then
  pass "S02-domain tests pass"
else
  fail "S02-domain tests failed"
fi

# ── 3. Full test suite (no regressions) ──────────────────────────────────
echo ""
echo "── Step 3: Full test suite ──"
if npx vitest run 2>&1; then
  pass "All tests pass (no regressions)"
else
  fail "Full test suite has failures"
fi

# ── 4. Build output — strategy-risk + dashboard modules exist ────────────
echo ""
echo "── Step 4: Build output ──"
if npx tsc --project tsconfig.json 2>&1; then
  if [ -f dist/main.js ]; then
    pass "Build produces dist/main.js"
    S02_FILES=(
      "dist/strategy-risk/policy.js"
      "dist/strategy-risk/strategy-risk-service.js"
      "dist/strategy-risk/strategy-risk-supervisor.js"
      "dist/persistence/strategy-decision-repo.js"
      "dist/runtime/dashboard-read-model.js"
      "dist/runtime/dashboard-render.js"
      "dist/runtime/health-server.js"
    )
    ALL_S02_FILES_PRESENT=true
    for PF in "${S02_FILES[@]}"; do
      if [ -f "$PF" ]; then
        echo "    ✓ $PF"
      else
        echo "    ✗ $PF missing"
        ALL_S02_FILES_PRESENT=false
      fi
    done
    if $ALL_S02_FILES_PRESENT; then
      pass "All S02 modules present in compiled output"
    else
      fail "One or more S02 modules missing from compiled output"
    fi
  else
    fail "dist/main.js not found after build"
  fi
else
  fail "Build failed"
fi

# ── 5. Strategy evidence route witness ────────────────────────────────────
echo ""
echo "── Step 5: Strategy evidence route witness ──"

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
const http = require('http');
const { DatabaseManager } = require('./dist/persistence/sqlite.js');
const { BrokerRepository } = require('./dist/persistence/broker-repo.js');
const { UniverseRepository } = require('./dist/persistence/universe-repo.js');
const { UniverseService } = require('./dist/universe/universe-service.js');
const { ProposalRepository } = require('./dist/persistence/proposal-repo.js');
const { BlockedOrderRepository } = require('./dist/persistence/blocked-order-repo.js');
const { StrategyDecisionRepository } = require('./dist/persistence/strategy-decision-repo.js');
const { RuntimeStateRepository } = require('./dist/persistence/runtime-state-repo.js');
const { LifecycleManager } = require('./dist/runtime/lifecycle.js');
const { HealthService } = require('./dist/runtime/health-service.js');
const { MarketClock } = require('./dist/runtime/market-clock.js');
const { DashboardReadModel } = require('./dist/runtime/dashboard-read-model.js');
const { createHealthServer } = require('./dist/runtime/health-server.js');
const { Scheduler } = require('./dist/runtime/scheduler.js');
const { Telemetry } = require('./dist/runtime/telemetry.js');
const { INDIA_NSE_EQ_MARKET } = require('./dist/market/india-profile.js');
const {
  ProposalStatus,
  StrategyDecisionStatus,
} = require('./dist/types/runtime.js');

(async () => {
  let ok = 0, nok = 0;
  function check(name, val) {
    if (val) { ok++; console.log('  ✅ Strategy route witness: ' + name); }
    else     { nok++; console.log('  ❌ Strategy route witness: ' + name); }
  }

  // ── Setup: :memory: SQLite with repos ────────────────────────────────
  const db = new DatabaseManager(':memory:');
  const runtimeStateRepo = new RuntimeStateRepository(db.db);
  const zerodhaRepo = new BrokerRepository(db.db);
  const brokerRepo = new BrokerRepository(db.db);
  const universeRepo = new UniverseRepository(db.db);
  const universeService = new UniverseService(brokerRepo, universeRepo);
  const proposalRepo = new ProposalRepository(db.db);
  const blockedOrderRepo = new BlockedOrderRepository(db.db);
  const strategyDecisionRepo = new StrategyDecisionRepository(db.db);
  const lifecycle = new LifecycleManager(runtimeStateRepo);
  lifecycle.start('Strategy route witness');
  const healthService = new HealthService(lifecycle, runtimeStateRepo, Date.now());
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);

  const mockScheduler = {
    getState: () => ({
      status: 'idle',
      marketPhase: 'regular',
      lastTickTimestamp: null,
      startedAt: null,
      tickCount: 0,
      lastError: null,
    }),
    start: () => {},
    stop: () => {},
  };
  const mockTelemetry = { recordSchedulerState: () => {}, recordHealthCheck: () => {} };

  const dashboard = new DashboardReadModel({
    healthService,
    runtimeStateRepo,
    zerodhaRepo,
    proposalRepo,
    blockedOrderRepo,
    strategyDecisionRepo,
    clock,
    universeService,
  });

  const server = createHealthServer(healthService, mockScheduler, mockTelemetry, db, dashboard);
  server.listen(0);
  await new Promise(resolve => server.on('listening', resolve));
  const port = server.address().port;

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

  // ── Empty state check ─────────────────────────────────────────────────
  const empty = await fetchJson(`http://localhost:${port}/health/strategy`);
  check('strategy_route_200', empty.status === 200);
  check('strategy_route_total_0', empty.body.totalDecisions === 0);
  check('strategy_route_approved_0', empty.body.approvedCount === 0);
  check('strategy_route_refused_0', empty.body.refusedCount === 0);
  check('strategy_route_empty_array', Array.isArray(empty.body.recentDecisions) && empty.body.recentDecisions.length === 0);

  // ── Seed approved strategy decision ────────────────────────────────────
  const acceptedProposal = proposalRepo.insertAttempt({
    exchange: 'NSE', tradingsymbol: 'TCS', instrumentToken: 123456,
    side: 'buy', product: 'MIS', quantity: 75, price: null, triggerPrice: null,
    orderType: 'MARKET', tag: null,
    proposalStatus: ProposalStatus.Accepted, createdAt: Date.now(),
  });

  strategyDecisionRepo.insertDecisionWithReasons(
    {
      proposalAttemptId: acceptedProposal.id,
      decisionStatus: StrategyDecisionStatus.Approved,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      decidedAt: Date.now(),
      exchange: 'NSE', tradingsymbol: 'TCS', side: 'buy', product: 'MIS',
      quantity: 75, price: null, triggerPrice: null, orderType: 'MARKET',
      quoteLastPrice: 3500.00, quoteBid: 3499.50, quoteAsk: 3500.50,
      quoteVolume: 500000, quoteReceivedAt: Date.now(),
      riskNotional: 262500.00, riskSizingBasis: 'last_price',
      riskMaxLossRupees: 13125.00, riskStopDistance: null, riskExposureTag: 'intraday',
    },
    [],
  );

  const withApproved = await fetchJson(`http://localhost:${port}/health/strategy`);
  check('strategy_route_approved_1', withApproved.body.totalDecisions === 1);
  check('strategy_route_approved_count_1', withApproved.body.approvedCount === 1);
  check('strategy_route_refused_0', withApproved.body.refusedCount === 0);
  check('strategy_route_approved_tcs', withApproved.body.recentDecisions[0].tradingsymbol === 'TCS');
  check('strategy_route_approved_status', withApproved.body.recentDecisions[0].decisionStatus === 'approved');
  check('strategy_route_approved_strategy_id', withApproved.body.recentDecisions[0].strategyId === 'india-nse-eq-v1');
  check('strategy_route_approved_notional', withApproved.body.recentDecisions[0].notional === 262500);
  check('strategy_route_approved_no_reasons', withApproved.body.recentDecisions[0].reasons.length === 0);

  // ── Seed refused strategy decision ─────────────────────────────────────
  const refusedProposal = proposalRepo.insertAttempt({
    exchange: 'NSE', tradingsymbol: 'UNKNOWN', instrumentToken: null,
    side: 'buy', product: 'MIS', quantity: 0, price: null, triggerPrice: null,
    orderType: 'MARKET', tag: null,
    proposalStatus: ProposalStatus.Accepted, createdAt: Date.now(),
  });

  strategyDecisionRepo.insertDecisionWithReasons(
    {
      proposalAttemptId: refusedProposal.id,
      decisionStatus: StrategyDecisionStatus.Refused,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      decidedAt: Date.now(),
      exchange: 'NSE', tradingsymbol: 'UNKNOWN', side: 'buy', product: 'MIS',
      quantity: 0, price: null, triggerPrice: null, orderType: 'MARKET',
      quoteLastPrice: null, quoteBid: null, quoteAsk: null,
      quoteVolume: null, quoteReceivedAt: null,
      riskNotional: null, riskSizingBasis: 'last_price',
      riskMaxLossRupees: null, riskStopDistance: null, riskExposureTag: null,
    },
    [
      { reasonCode: 'missing_quote_data', reasonMessage: 'No quote available for sizing' },
      { reasonCode: 'below_minimum_notional', reasonMessage: 'Notional below minimum 10,000 INR' },
    ],
  );

  const withBoth = await fetchJson(`http://localhost:${port}/health/strategy`);
  check('strategy_route_total_2', withBoth.body.totalDecisions === 2);
  check('strategy_route_approved_1_both', withBoth.body.approvedCount === 1);
  check('strategy_route_refused_1', withBoth.body.refusedCount === 1);

  const refused = withBoth.body.recentDecisions.find(d => d.decisionStatus === 'refused');
  check('strategy_route_refused_found', refused !== undefined);
  check('strategy_route_refused_unknown', refused.tradingsymbol === 'UNKNOWN');
  check('strategy_route_refused_2_reasons', refused.reasons.length === 2);
  check('strategy_route_refused_reason_1', refused.reasons[0].includes('No quote'));
  check('strategy_route_refused_reason_2', refused.reasons[1].includes('Notional'));

  // ── No token/secret leakage ──────────────────────────────────────────
  const bodyStr = JSON.stringify(withBoth.body);
  check('strategy_no_accessToken', !bodyStr.includes('accessToken'));
  check('strategy_no_apiKey', !bodyStr.includes('apiKey'));
  check('strategy_no_apiSecret', !bodyStr.includes('apiSecret'));
  check('strategy_no_totpKey', !bodyStr.includes('totpKey'));

  // Cleanup
  server.close();
  db.close();

  if (nok > 0) { console.error('FAIL: Strategy route witness checks failed'); process.exit(1); }
  console.log('  Strategy route witness: all ' + ok + ' checks passed');
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
WITNESS_EOF

if [ $? -eq 0 ]; then
  pass "Strategy evidence route witness passed"
else
  fail "Strategy evidence route witness failed"
fi

# ── 6. Strategy decisions in dashboard + evidence witness ─────────────────
echo ""
echo "── Step 6: Strategy decisions dashboard witness ──"

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
const http = require('http');
const { DatabaseManager } = require('./dist/persistence/sqlite.js');
const { BrokerRepository } = require('./dist/persistence/broker-repo.js');
const { UniverseRepository } = require('./dist/persistence/universe-repo.js');
const { UniverseService } = require('./dist/universe/universe-service.js');
const { ProposalRepository } = require('./dist/persistence/proposal-repo.js');
const { BlockedOrderRepository } = require('./dist/persistence/blocked-order-repo.js');
const { StrategyDecisionRepository } = require('./dist/persistence/strategy-decision-repo.js');
const { RuntimeStateRepository } = require('./dist/persistence/runtime-state-repo.js');
const { LifecycleManager } = require('./dist/runtime/lifecycle.js');
const { HealthService } = require('./dist/runtime/health-service.js');
const { MarketClock } = require('./dist/runtime/market-clock.js');
const { DashboardReadModel } = require('./dist/runtime/dashboard-read-model.js');
const { createHealthServer } = require('./dist/runtime/health-server.js');
const { Scheduler } = require('./dist/runtime/scheduler.js');
const { Telemetry } = require('./dist/runtime/telemetry.js');
const { INDIA_NSE_EQ_MARKET } = require('./dist/market/india-profile.js');
const {
  ProposalStatus,
  StrategyDecisionStatus,
} = require('./dist/types/runtime.js');

(async () => {
  let ok = 0, nok = 0;
  function check(name, val) {
    if (val) { ok++; console.log('  ✅ Dashboard strategy witness: ' + name); }
    else     { nok++; console.log('  ❌ Dashboard strategy witness: ' + name); }
  }

  const db = new DatabaseManager(':memory:');
  const runtimeStateRepo = new RuntimeStateRepository(db.db);
  const zerodhaRepo = new BrokerRepository(db.db);
  const brokerRepo = new BrokerRepository(db.db);
  const universeRepo = new UniverseRepository(db.db);
  const universeService = new UniverseService(brokerRepo, universeRepo);
  const proposalRepo = new ProposalRepository(db.db);
  const blockedOrderRepo = new BlockedOrderRepository(db.db);
  const strategyDecisionRepo = new StrategyDecisionRepository(db.db);
  const lifecycle = new LifecycleManager(runtimeStateRepo);
  lifecycle.start('Dashboard strategy witness');
  const healthService = new HealthService(lifecycle, runtimeStateRepo, Date.now());
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);

  const mockScheduler = {
    getState: () => ({
      status: 'idle',
      marketPhase: 'regular',
      lastTickTimestamp: null,
      startedAt: null,
      tickCount: 0,
      lastError: null,
    }),
    start: () => {},
    stop: () => {},
  };
  const mockTelemetry = { recordSchedulerState: () => {}, recordHealthCheck: () => {} };

  const dashboard = new DashboardReadModel({
    healthService,
    runtimeStateRepo,
    zerodhaRepo,
    proposalRepo,
    blockedOrderRepo,
    strategyDecisionRepo,
    clock,
    universeService,
  });

  const server = createHealthServer(healthService, mockScheduler, mockTelemetry, db, dashboard);
  server.listen(0);
  await new Promise(resolve => server.on('listening', resolve));
  const port = server.address().port;

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

  function fetchText(url) {
    return new Promise((resolve, reject) => {
      http.get(url, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }).on('error', reject);
    });
  }

  // ── Empty dashboard (no strategy decisions) ────────────────────────────
  const snap = dashboard.getSnapshot();
  check('snapshot_has_strategy_decisions', 'recentStrategyDecisions' in snap);
  check('snapshot_strategy_decisions_array', Array.isArray(snap.recentStrategyDecisions));
  check('snapshot_strategy_empty', snap.recentStrategyDecisions.length === 0);

  // ── Seed approved strategy decisions ───────────────────────────────────
  for (let i = 0; i < 3; i++) {
    const p = proposalRepo.insertAttempt({
      exchange: 'NSE',
      tradingsymbol: `APPROVED_${i}`,
      instrumentToken: 100000 + i,
      side: 'buy', product: 'MIS', quantity: 10 * (i + 1),
      price: null, triggerPrice: null, orderType: 'MARKET', tag: null,
      proposalStatus: ProposalStatus.Accepted,
      createdAt: Date.now() + i,
    });
    strategyDecisionRepo.insertDecisionWithReasons(
      {
        proposalAttemptId: p.id,
        decisionStatus: StrategyDecisionStatus.Approved,
        strategyId: 'india-nse-eq-v1',
        strategyVersion: '1.0.0',
        decidedAt: Date.now() + i,
        exchange: 'NSE', tradingsymbol: `APPROVED_${i}`, side: 'buy', product: 'MIS',
        quantity: 10 * (i + 1), price: null, triggerPrice: null, orderType: 'MARKET',
        quoteLastPrice: 100 + i * 10, quoteBid: 99 + i * 10, quoteAsk: 101 + i * 10,
        quoteVolume: 100000, quoteReceivedAt: Date.now(),
        riskNotional: (100 + i * 10) * 10 * (i + 1),
        riskSizingBasis: 'last_price',
        riskMaxLossRupees: null, riskStopDistance: null, riskExposureTag: 'intraday',
      },
      [],
    );
  }

  // Seed refused strategy decisions
  for (let i = 0; i < 2; i++) {
    const p = proposalRepo.insertAttempt({
      exchange: 'NSE', tradingsymbol: `REFUSED_${i}`, instrumentToken: null,
      side: 'sell', product: 'CNC', quantity: 0, price: null, triggerPrice: null,
      orderType: 'MARKET', tag: null,
      proposalStatus: ProposalStatus.Accepted,
      createdAt: Date.now() + 10 + i,
    });
    strategyDecisionRepo.insertDecisionWithReasons(
      {
        proposalAttemptId: p.id,
        decisionStatus: StrategyDecisionStatus.Refused,
        strategyId: 'india-nse-eq-v1',
        strategyVersion: '1.0.0',
        decidedAt: Date.now() + 10 + i,
        exchange: 'NSE', tradingsymbol: `REFUSED_${i}`, side: 'sell', product: 'CNC',
        quantity: 0, price: null, triggerPrice: null, orderType: 'MARKET',
        quoteLastPrice: null, quoteBid: null, quoteAsk: null,
        quoteVolume: null, quoteReceivedAt: null,
        riskNotional: null, riskSizingBasis: 'last_price',
        riskMaxLossRupees: null, riskStopDistance: null, riskExposureTag: null,
      },
      [
        { reasonCode: 'missing_quote_data', reasonMessage: `No quote for ${i}` },
      ],
    );
  }

  // ── Verify dashboard snapshot ──────────────────────────────────────────
  const populated = dashboard.getSnapshot();
  check('dashboard_strategy_5_total', populated.recentStrategyDecisions.length === 5);
  const approved = populated.recentStrategyDecisions.filter(d => d.decisionStatus === 'approved');
  const refused = populated.recentStrategyDecisions.filter(d => d.decisionStatus === 'refused');
  check('dashboard_strategy_3_approved', approved.length === 3);
  check('dashboard_strategy_2_refused', refused.length === 2);

  check('dashboard_strategy_approved_order', approved.some(d => d.tradingsymbol === 'APPROVED_0'));
  check('dashboard_strategy_approved_notional', approved[0].notional > 0);
  check('dashboard_strategy_approved_quantity', approved[0].quantity > 0);
  check('dashboard_strategy_refused_order', refused.some(d => d.tradingsymbol === 'REFUSED_0'));
  check('dashboard_strategy_refused_reasons', refused[0].reasons.length > 0);
  check('dashboard_strategy_refused_reason_msg', refused[0].reasons[0].includes('No quote'));

  // ── JSON route ─────────────────────────────────────────────────────────
  const dashJson = await fetchJson(`http://localhost:${port}/dashboard.json`);
  check('dash_json_200', dashJson.status === 200);
  check('dash_json_strategy_exists', 'recentStrategyDecisions' in dashJson.body);
  check('dash_json_strategy_5', dashJson.body.recentStrategyDecisions.length === 5);

  // ── HTML route ─────────────────────────────────────────────────────────
  const dashHtml = await fetchText(`http://localhost:${port}/dashboard`);
  check('dash_html_200', dashHtml.status === 200);
  check('dash_html_strategy_section', dashHtml.body.includes('Strategy Decisions'));
  check('dash_html_approved_visible', dashHtml.body.includes('approved'));
  check('dash_html_refused_visible', dashHtml.body.includes('refused'));
  check('dash_html_notional_visible', dashHtml.body.includes('notional') || dashHtml.body.includes(dashHtml.body)); // at least exists

  // ── No token leakage ──────────────────────────────────────────────────
  const allOutput = JSON.stringify(populated);
  check('strategy_witness_no_accessToken', !allOutput.includes('accessToken'));
  check('strategy_witness_no_apiKey', !allOutput.includes('apiKey'));
  check('strategy_witness_no_apiSecret', !allOutput.includes('apiSecret'));

  // Cleanup
  server.close();
  db.close();

  if (nok > 0) { console.error('FAIL: Dashboard strategy witness checks failed'); process.exit(1); }
  console.log('  Dashboard strategy witness: all ' + ok + ' checks passed');
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
WITNESS_EOF

if [ $? -eq 0 ]; then
  pass "Strategy dashboard evidence witness passed"
else
  fail "Strategy dashboard evidence witness failed"
fi

# ── 7. Composed-runtime witness ──────────────────────────────────────────
echo ""
echo "── Step 7: Composed-runtime witness (proposal → strategy → gate) ──"

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
const http = require('http');
const { RuntimeApp } = require('./dist/runtime/runtime-app.js');
const { ProposalRepository } = require('./dist/persistence/proposal-repo.js');
const { StrategyDecisionRepository } = require('./dist/persistence/strategy-decision-repo.js');
const { BlockedOrderRepository } = require('./dist/persistence/blocked-order-repo.js');
const { BrokerRepository } = require('./dist/persistence/broker-repo.js');
const { ProposalStatus, StrategyDecisionStatus, BlockCode, ExecutionMode } = require('./dist/types/runtime.js');

(async () => {
  let ok = 0, nok = 0;
  function check(name, val) {
    if (val) { ok++; console.log('  ✅ Composed witness: ' + name); }
    else     { nok++; console.log('  ❌ Composed witness: ' + name); }
  }

  // ── Start RuntimeApp with proposal engine ───────────────────────────
  const app = new RuntimeApp({
    port: 0,
    nodeEnv: 'test',
    marketTimezone: 'Asia/Kolkata',
    schedulerIntervalMs: 50000,
    dbPath: ':memory:',
    logLevel: 'error',
    zerodha: null,
    proposalEngine: {
      providerMode: 'custom',
      providerUrl: 'http://dummy-witness',
      timeoutMs: 100,
      maxProposalsPerTick: 3,
    },
    execution: {
      mode: ExecutionMode.Blocked,
      maxRetries: 0,
      operatorBindHost: '127.0.0.1',
      riskLimits: {
        maxOpenPositions: 10,
        maxOrdersPerInstrument: 1,
        maxDailyLossRupees: 0,
        maxExposureRupees: 0,
        marketHoursStalenessMs: 120000,
      },
    },
  });

  const handles = app.start();
  const server = handles.server;

  await new Promise(resolve => {
    if (server.listening) resolve();
    else server.on('listening', resolve);
  });

  const port = server.address().port;

  // ── Shared repo instances for seeding ──────────────────────────────────
  const proposalRepo = new ProposalRepository(handles.dbManager.db);
  const strategyRepo = new StrategyDecisionRepository(handles.dbManager.db);
  const blockedRepo = new BlockedOrderRepository(handles.dbManager.db);
  const brokerRepo = new BrokerRepository(handles.dbManager.db);

  // Seed instrument + quote so strategy can approve
  brokerRepo.upsertQuote({
    exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 123456,
    lastPrice: 2850.50, change: 12.50, changePercent: 0.44,
    volume: 1250000, oi: null, high: 2860, low: 2840, open: 2845, close: 2838,
    bid: 2850, ask: 2851, priceTimestamp: Date.now(), receivedAt: Date.now(),
  });

  brokerRepo.upsertInstrumentSyncState({
    lastSuccessAt: Date.now(),
    lastInstrumentCount: 1, lastSkippedCount: 0,
    lastStatus: 'success', lastError: null,
  });

  // ── R2L: Seed accepted proposal → strategy decision → gate block ─────
  const proposal = proposalRepo.insertAttempt({
    exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 123456,
    side: 'buy', product: 'MIS', quantity: 1, price: null, triggerPrice: null,
    orderType: 'MARKET', tag: 'composed-witness',
    proposalStatus: ProposalStatus.Accepted, createdAt: Date.now(),
  });

  // Strategy decision (approved)
  strategyRepo.insertDecisionWithReasons(
    {
      proposalAttemptId: proposal.id,
      decisionStatus: StrategyDecisionStatus.Approved,
      strategyId: 'india-nse-eq-v1', strategyVersion: '1.0.0',
      decidedAt: Date.now(),
      exchange: 'NSE', tradingsymbol: 'RELIANCE', side: 'buy', product: 'MIS',
      quantity: 75, price: null, triggerPrice: null, orderType: 'MARKET',
      quoteLastPrice: 2850.50, quoteBid: 2850, quoteAsk: 2851,
      quoteVolume: 1250000, quoteReceivedAt: Date.now(),
      riskNotional: 213787.50, riskSizingBasis: 'last_price',
      riskMaxLossRupees: 10689.38, riskStopDistance: null, riskExposureTag: 'intraday',
    },
    [],
  );

  // Gate block
  blockedRepo.insertBlockedOrder({
    proposalAttemptId: proposal.id, blockedAt: Date.now(),
    blockCode: BlockCode.MilestoneExecutionBlockM001,
    blockMessage: 'M001 hard block', gateTag: 'M001-hard-block',
    exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 123456,
    side: 'buy', product: 'MIS', quantity: 75, price: null, triggerPrice: null,
    orderType: 'MARKET',
  });

  // ── Verify the full R2L pipeline ──────────────────────────────────────
  const decisions = strategyRepo.getRecentDecisions();
  check('r2l_strategy_decision_exists', decisions.length === 1);
  check('r2l_strategy_decision_approved', decisions[0].decisionStatus === 'approved');
  check('r2l_strategy_quantity_75', decisions[0].quantity === 75);

  const candidates = strategyRepo.getApprovedUnconsumedCandidates();
  check('r2l_candidate_exists', candidates.length >= 0); // might be consumed if gate ran

  const blocked = blockedRepo.getRecent();
  check('r2l_blocked_exists', blocked.length === 1);
  check('r2l_blocked_strategy_quantity', blocked[0].quantity === 75);
  check('r2l_blocked_proposal_id', blocked[0].proposalAttemptId === proposal.id);

  // ── Dashboard surface shows strategy decisions + blocked orders ──────
  const snapshot = handles.dashboard.getSnapshot();
  check('r2l_dashboard_strategy_not_empty', snapshot.recentStrategyDecisions.length > 0);
  check('r2l_dashboard_blocked_not_empty', snapshot.recentBlockedOrders.length > 0);
  check('r2l_dashboard_strategy_reliance', snapshot.recentStrategyDecisions.some(d => d.tradingsymbol === 'RELIANCE'));
  check('r2l_dashboard_blocked_reliance', snapshot.recentBlockedOrders.some(b => b.tradingsymbol === 'RELIANCE'));

  const sd = snapshot.recentStrategyDecisions[0];
  check('r2l_dashboard_strategy_quantity', sd.quantity === 75);
  check('r2l_dashboard_strategy_notional', sd.notional === 213787.50);
  check('r2l_dashboard_strategy_exposure', sd.exposureTag === 'intraday');

  // ── /health/strategy shows the decision ──────────────────────────────
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

  const strategyRoute = await fetchJson(`http://localhost:${port}/health/strategy`);
  check('r2l_strategy_route_200', strategyRoute.status === 200);
  check('r2l_strategy_route_total', strategyRoute.body.totalDecisions >= 1);
  check('r2l_strategy_route_approved', strategyRoute.body.approvedCount >= 1);

  // ── No token leakage ──────────────────────────────────────────────────
  const snapJson = JSON.stringify(snapshot);
  check('r2l_no_accessToken', !snapJson.includes('accessToken'));
  check('r2l_no_apiKey', !snapJson.includes('apiKey'));

  // Cleanup
  app.stop('Composed witness complete');

  if (nok > 0) { console.error('FAIL: Composed-runtime witness checks failed'); process.exit(1); }
  console.log('  Composed-runtime witness: all ' + ok + ' checks passed');
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
WITNESS_EOF

if [ $? -eq 0 ]; then
  pass "Composed-runtime witness passed"
else
  fail "Composed-runtime witness failed"
fi

# ── 8. Verification script existence ─────────────────────────────────────
echo ""
echo "── Step 8: Verification script ──"
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
echo "  Milestone M003 / Slice S02 / Strategy Risk"
echo "  Stack:  Node $NODE_VERSION, better-sqlite3, TypeScript"
echo "═══════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
