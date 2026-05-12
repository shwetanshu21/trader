#!/usr/bin/env bash
# ── M003-S01 Universe Coverage Verification Script ──
# Verifies the complete M003 S01 universe coverage + operator-visible surface:
#   1. TypeScript compiles cleanly
#   2. Universe-domain tests pass (universe-repo, universe-service,
#      universe-supervisor integration, dashboard-read-model, health-server)
#   3. Full test suite has no regressions
#   4. Build output includes universe modules
#   5. Sufficient coverage witness (all 50 EQ symbols have fresh quotes)
#   6. Degraded coverage witness (missing quotes → degraded verdict)
#   7. Stale quote negative witness (stale quotes → stale verdict, not sufficient)
#   8. Universe coverage on dashboard + /health/universe endpoint
#
# Usage: bash scripts/verify-m003-s01-universe.sh

set -euo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
NODE_VERSION=$(node --version 2>/dev/null || echo "unknown")

pass()  { PASS=$((PASS + 1)); echo "  ✅ PASS: $1"; }
fail()  { FAIL=$((FAIL + 1)); echo "  ❌ FAIL: $1"; }

echo "═══════════════════════════════════════════"
echo "  M003-S01 Universe Coverage Verification"
echo "═══════════════════════════════════════════"

# ── 1. TypeScript compilation ────────────────────────────────────────────
echo ""
echo "── Step 1: TypeScript compilation ──"
if npx tsc --noEmit 2>&1; then
  pass "TypeScript compiles with zero errors"
else
  fail "TypeScript compilation failed"
fi

# ── 2. Universe-domain test suite ────────────────────────────────────────
echo ""
echo "── Step 2: Universe-domain tests ──"
if npx vitest run \
  tests/universe-repo.test.ts \
  tests/universe-service.test.ts \
  tests/universe-supervisor.integration.test.ts \
  tests/dashboard-read-model.test.ts \
  tests/health-server-dashboard.test.ts \
  2>&1; then
  pass "Universe-domain tests pass"
else
  fail "Universe-domain tests failed"
fi

# ── 3. Full test suite (no regressions) ──────────────────────────────────
echo ""
echo "── Step 3: Full test suite ──"
if npx vitest run 2>&1; then
  pass "All tests pass (no regressions)"
else
  fail "Full test suite has failures"
fi

# ── 4. Build output — universe modules exist ─────────────────────────────
echo ""
echo "── Step 4: Build output ──"
if npx tsc --project tsconfig.json 2>&1; then
  if [ -f dist/main.js ]; then
    pass "Build produces dist/main.js"
    UNIVERSE_FILES=(
      "dist/universe/universe-service.js"
      "dist/universe/universe-supervisor.js"
      "dist/universe/policy.js"
      "dist/persistence/universe-repo.js"
      "dist/runtime/dashboard-read-model.js"
      "dist/runtime/dashboard-render.js"
    )
    ALL_UNIVERSE_FILES_PRESENT=true
    for PF in "${UNIVERSE_FILES[@]}"; do
      if [ -f "$PF" ]; then
        echo "    ✓ $PF"
      else
        echo "    ✗ $PF missing"
        ALL_UNIVERSE_FILES_PRESENT=false
      fi
    done
    if $ALL_UNIVERSE_FILES_PRESENT; then
      pass "All universe modules present in compiled output"
    else
      fail "One or more universe modules missing from compiled output"
    fi
  else
    fail "dist/main.js not found after build"
  fi
else
  fail "Build failed"
fi

# ── 5. Sufficient coverage witness ───────────────────────────────────────
echo ""
echo "── Step 5: Sufficient coverage witness ──"
# Prove that with all 50 NSE EQ policy symbols synced and with fresh quotes,
# the universe coverage reports Sufficient on /health/universe and /dashboard.json.

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
const http = require('http');
const { DatabaseManager } = require('./dist/persistence/sqlite.js');
const { BrokerRepository } = require('./dist/persistence/broker-repo.js');
const { UniverseRepository } = require('./dist/persistence/universe-repo.js');
const { UniverseService } = require('./dist/universe/universe-service.js');
const { UniverseSupervisor } = require('./dist/universe/universe-supervisor.js');
const { RuntimeStateRepository } = require('./dist/persistence/runtime-state-repo.js');
const { LifecycleManager } = require('./dist/runtime/lifecycle.js');
const { HealthService } = require('./dist/runtime/health-service.js');
const { MarketClock } = require('./dist/runtime/market-clock.js');
const { DashboardReadModel } = require('./dist/runtime/dashboard-read-model.js');
const { createHealthServer } = require('./dist/runtime/health-server.js');
const { Scheduler } = require('./dist/runtime/scheduler.js');
const { Telemetry } = require('./dist/runtime/telemetry.js');
const { INDIA_NSE_EQ_MARKET } = require('./dist/market/india-profile.js');
const { INDIA_UNIVERSE_POLICY, getEligibleSymbols } = require('./dist/universe/policy.js');
const { UniverseCoverageVerdict } = require('./dist/types/runtime.js');

(async () => {
  let ok = 0, nok = 0;
  function check(name, val) {
    if (val) { ok++; console.log('  ✅ Sufficient witness: ' + name); }
    else     { nok++; console.log('  ❌ Sufficient witness: ' + name); }
  }

  // ── Setup: :memory: SQLite with seeded instruments + fresh quotes ─────
  const db = new DatabaseManager(':memory:');
  const brokerRepo = new BrokerRepository(db.db);
  const universeRepo = new UniverseRepository(db.db);
  const runtimeStateRepo = new RuntimeStateRepository(db.db);
  const lifecycle = new LifecycleManager(runtimeStateRepo);
  lifecycle.start('Sufficient witness');

  // Seed all 50 NSE EQ policy symbols as instruments
  const eligibleSymbols = getEligibleSymbols('NSE');
  const symbols = [...eligibleSymbols].sort();
  const now = Date.now();

  const instruments = symbols.map((s, i) => ({
    exchange: 'NSE',
    tradingsymbol: s,
    instrumentToken: 200000 + i * 100,
    name: s + ' LTD',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    instrumentType: 'EQ',
    segment: 'NSE',
    exchangeToken: 3000 + i,
  }));
  brokerRepo.upsertInstruments(instruments);

  // Seed fresh quotes for all 50 symbols
  for (let i = 0; i < symbols.length; i++) {
    brokerRepo.upsertQuote({
      exchange: 'NSE',
      tradingsymbol: symbols[i],
      instrumentToken: 200000 + i * 100,
      lastPrice: 100 + Math.random() * 500,
      change: 1.0,
      changePercent: 0.5,
      volume: 100000,
      oi: null,
      high: 105,
      low: 95,
      open: 100,
      close: 99,
      bid: 100.5,
      ask: 101.0,
      priceTimestamp: Math.floor(now / 1000),
      receivedAt: now,
    });
  }

  // Seed instrument sync state
  brokerRepo.upsertInstrumentSyncState({
    lastSuccessAt: now,
    lastInstrumentCount: symbols.length,
    lastSkippedCount: 0,
    lastStatus: 'success',
    lastError: null,
  });

  // ── Compute universe snapshot via UniverseSupervisor ──────────────────
  const universeService = new UniverseService(brokerRepo, universeRepo);
  const universeSupervisor = new UniverseSupervisor(universeService);

  const healthStatus = {
    verdict: 'healthy',
    uptimeMs: 1000,
    lifecycleState: 'running',
    scheduler: { status: 'idle', marketPhase: 'regular', lastTickTimestamp: now, startedAt: now, tickCount: 1, lastError: null },
    degradedReasons: [],
    checkedAt: new Date().toISOString(),
  };

  await universeSupervisor.doWork(new Date(), healthStatus);

  // ── Build dashboard + server ─────────────────────────────────────────
  const healthService = new HealthService(lifecycle, runtimeStateRepo, now);
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const mockScheduler = {
    getState: () => ({
      status: 'idle',
      marketPhase: 'regular',
      lastTickTimestamp: now,
      startedAt: now,
      tickCount: 1,
      lastError: null,
    }),
    start: () => {},
    stop: () => {},
  };
  const mockTelemetry = {
    recordSchedulerState: () => {},
    recordHealthCheck: () => {},
  };

  const dashboard = new DashboardReadModel({
    healthService,
    runtimeStateRepo,
    zerodhaRepo: brokerRepo,
    proposalRepo: null,
    blockedOrderRepo: null,
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

  // ── Check snapshot directly ──────────────────────────────────────────
  const snap = universeRepo.getLatestSnapshot();
  check('snapshot_exists', snap !== null);
  check('snapshot_eligible_50', snap.eligibleCount === 50);
  check('snapshot_fresh_50', snap.freshQuoteCount === 50);
  check('snapshot_stale_0', snap.staleQuoteCount === 0);
  check('snapshot_missing_0', snap.missingQuoteCount === 0);
  check('snapshot_verdict_sufficient', snap.verdict === 'sufficient');
  check('snapshot_policy_version', snap.policyVersion === INDIA_UNIVERSE_POLICY.version);

  // ── Check /health/universe ───────────────────────────────────────────
  const universeEndpoint = await fetchJson(`http://localhost:${port}/health/universe`);
  check('health_universe_200', universeEndpoint.status === 200);
  check('health_universe_verdict_sufficient', universeEndpoint.body.verdict === 'sufficient');
  check('health_universe_eligible_50', universeEndpoint.body.eligibleCount === 50);
  check('health_universe_fresh_50', universeEndpoint.body.freshQuoteCount === 50);
  check('health_universe_stale_0', universeEndpoint.body.staleQuoteCount === 0);
  check('health_universe_missing_0', universeEndpoint.body.missingQuoteCount === 0);
  check('health_universe_policy_version', universeEndpoint.body.policyVersion === INDIA_UNIVERSE_POLICY.version);
  check('health_universe_threshold_label', typeof universeEndpoint.body.thresholdLabel === 'string');
  check('health_universe_computedAt_iso', /^\d{4}-\d{2}-\d{2}T/.test(universeEndpoint.body.computedAt));

  // ── Check /dashboard.json includes universe block ────────────────────
  const dashJson = await fetchJson(`http://localhost:${port}/dashboard.json`);
  check('dashboard_json_200', dashJson.status === 200);
  check('dashboard_json_universe_exists', dashJson.body.universe !== null);
  check('dashboard_json_universe_verdict', dashJson.body.universe.verdict === 'sufficient');
  check('dashboard_json_universe_eligible', dashJson.body.universe.eligibleCount === 50);
  check('dashboard_json_no_secrets', !JSON.stringify(dashJson.body).includes('accessToken'));

  // ── Check dashboard HTML includes universe ───────────────────────────
  function fetchText(url) {
    return new Promise((resolve, reject) => {
      http.get(url, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }).on('error', reject);
    });
  }

  const dashHtml = await fetchText(`http://localhost:${port}/dashboard`);
  check('dashboard_html_200', dashHtml.status === 200);
  check('dashboard_html_universe_section', dashHtml.body.includes('Universe'));
  check('dashboard_html_sufficient', dashHtml.body.includes('sufficient'));
  check('dashboard_html_eligible_50', dashHtml.body.includes('50'));

  // Cleanup
  server.close();
  db.close();

  if (nok > 0) { console.error('FAIL: Sufficient coverage witness checks failed'); process.exit(1); }
  console.log('  Sufficient coverage witness: all ' + ok + ' checks passed');
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
WITNESS_EOF

if [ $? -eq 0 ]; then
  pass "Sufficient coverage witness passed"
else
  fail "Sufficient coverage witness failed"
fi

# ── 6. Degraded coverage witness (missing quotes) ────────────────────────
echo ""
echo "── Step 6: Degraded coverage witness ──"
# Prove that when quotes are mostly missing, the verdict is Degraded
# and the dashboard / health universe block reflects the degraded state.

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
const http = require('http');
const { DatabaseManager } = require('./dist/persistence/sqlite.js');
const { BrokerRepository } = require('./dist/persistence/broker-repo.js');
const { UniverseRepository } = require('./dist/persistence/universe-repo.js');
const { UniverseService } = require('./dist/universe/universe-service.js');
const { UniverseSupervisor } = require('./dist/universe/universe-supervisor.js');
const { RuntimeStateRepository } = require('./dist/persistence/runtime-state-repo.js');
const { LifecycleManager } = require('./dist/runtime/lifecycle.js');
const { HealthService } = require('./dist/runtime/health-service.js');
const { MarketClock } = require('./dist/runtime/market-clock.js');
const { DashboardReadModel } = require('./dist/runtime/dashboard-read-model.js');
const { createHealthServer } = require('./dist/runtime/health-server.js');
const { INDIA_NSE_EQ_MARKET } = require('./dist/market/india-profile.js');
const { getEligibleSymbols } = require('./dist/universe/policy.js');
const { UniverseCoverageVerdict } = require('./dist/types/runtime.js');

(async () => {
  let ok = 0, nok = 0;
  function check(name, val) {
    if (val) { ok++; console.log('  ✅ Degraded witness: ' + name); }
    else     { nok++; console.log('  ❌ Degraded witness: ' + name); }
  }

  // ── Setup: seed only 5 quotes out of 50 → missingQuoteCount=45 → Degraded ─
  const db = new DatabaseManager(':memory:');
  const brokerRepo = new BrokerRepository(db.db);
  const universeRepo = new UniverseRepository(db.db);
  const runtimeStateRepo = new RuntimeStateRepository(db.db);
  const lifecycle = new LifecycleManager(runtimeStateRepo);
  lifecycle.start('Degraded witness');

  const eligibleSymbols = getEligibleSymbols('NSE');
  const symbols = [...eligibleSymbols].sort();
  const now = Date.now();

  // Seed all 50 instruments
  const instruments = symbols.map((s, i) => ({
    exchange: 'NSE',
    tradingsymbol: s,
    instrumentToken: 300000 + i * 100,
    name: s + ' LTD',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    instrumentType: 'EQ',
    segment: 'NSE',
    exchangeToken: 4000 + i,
  }));
  brokerRepo.upsertInstruments(instruments);

  // Seed ONLY 5 quotes (10% coverage) → missingQuoteCount = 45 > 50% → Degraded
  for (let i = 0; i < 5; i++) {
    brokerRepo.upsertQuote({
      exchange: 'NSE',
      tradingsymbol: symbols[i],
      instrumentToken: 300000 + i * 100,
      lastPrice: 200 + Math.random() * 300,
      change: 2.0,
      changePercent: 1.0,
      volume: 50000,
      oi: null,
      high: 205,
      low: 195,
      open: 200,
      close: 198,
      bid: 200.5,
      ask: 201.0,
      priceTimestamp: Math.floor(now / 1000),
      receivedAt: now,
    });
  }

  brokerRepo.upsertInstrumentSyncState({
    lastSuccessAt: now,
    lastInstrumentCount: symbols.length,
    lastSkippedCount: 0,
    lastStatus: 'success',
    lastError: null,
  });

  // ── Compute snapshot ─────────────────────────────────────────────────
  const universeService = new UniverseService(brokerRepo, universeRepo);
  const universeSupervisor = new UniverseSupervisor(universeService);

  const healthStatus = {
    verdict: 'healthy',
    uptimeMs: 1000,
    lifecycleState: 'running',
    scheduler: { status: 'idle', marketPhase: 'regular', lastTickTimestamp: now, startedAt: now, tickCount: 1, lastError: null },
    degradedReasons: [],
    checkedAt: new Date().toISOString(),
  };

  await universeSupervisor.doWork(new Date(), healthStatus);

  // ── Build dashboard + server ─────────────────────────────────────────
  const healthService = new HealthService(lifecycle, runtimeStateRepo, now);
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const mockScheduler = {
    getState: () => ({
      status: 'idle',
      marketPhase: 'regular',
      lastTickTimestamp: now,
      startedAt: now,
      tickCount: 1,
      lastError: null,
    }),
    start: () => {},
    stop: () => {},
  };
  const mockTelemetry = {
    recordSchedulerState: () => {},
    recordHealthCheck: () => {},
  };

  const dashboard = new DashboardReadModel({
    healthService,
    runtimeStateRepo,
    zerodhaRepo: brokerRepo,
    proposalRepo: null,
    blockedOrderRepo: null,
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

  // ── Snapshot checks ──────────────────────────────────────────────────
  const snap = universeRepo.getLatestSnapshot();
  check('degraded_snapshot_exists', snap !== null);
  check('degraded_eligible_50', snap.eligibleCount === 50);
  check('degraded_fresh_5', snap.freshQuoteCount === 5);
  check('degraded_missing_45', snap.missingQuoteCount === 45);
  check('degraded_verdict_degraded', snap.verdict === 'degraded');

  // ── /health/universe ─────────────────────────────────────────────────
  const universeEndpoint = await fetchJson(`http://localhost:${port}/health/universe`);
  check('degraded_health_universe_200', universeEndpoint.status === 200);
  check('degraded_health_universe_verdict', universeEndpoint.body.verdict === 'degraded');
  check('degraded_health_universe_missing_45', universeEndpoint.body.missingQuoteCount === 45);
  check('degraded_health_universe_fresh_5', universeEndpoint.body.freshQuoteCount === 5);

  // ── /dashboard.json ──────────────────────────────────────────────────
  const dashJson = await fetchJson(`http://localhost:${port}/dashboard.json`);
  check('degraded_dashboard_json_200', dashJson.status === 200);
  check('degraded_dashboard_json_universe_not_null', dashJson.body.universe !== null);
  check('degraded_dashboard_json_verdict', dashJson.body.universe.verdict === 'degraded');
  check('degraded_dashboard_json_missing_45', dashJson.body.universe.missingQuoteCount === 45);

  // Cleanup
  server.close();
  db.close();

  if (nok > 0) { console.error('FAIL: Degraded coverage witness checks failed'); process.exit(1); }
  console.log('  Degraded coverage witness: all ' + ok + ' checks passed');
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
WITNESS_EOF

if [ $? -eq 0 ]; then
  pass "Degraded coverage witness passed"
else
  fail "Degraded coverage witness failed"
fi

# ── 7. Stale quote negative witness ──────────────────────────────────────
echo ""
echo "── Step 7: Stale quote negative witness ──"
# Prove that when half the quotes are stale, the verdict is Stale (not Sufficient).
# This is the negative check: proposal generation stays bounded/degraded rather
# than silently expanding to the full catalog.

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
const http = require('http');
const { DatabaseManager } = require('./dist/persistence/sqlite.js');
const { BrokerRepository } = require('./dist/persistence/broker-repo.js');
const { UniverseRepository } = require('./dist/persistence/universe-repo.js');
const { UniverseService } = require('./dist/universe/universe-service.js');
const { UniverseSupervisor } = require('./dist/universe/universe-supervisor.js');
const { RuntimeStateRepository } = require('./dist/persistence/runtime-state-repo.js');
const { LifecycleManager } = require('./dist/runtime/lifecycle.js');
const { HealthService } = require('./dist/runtime/health-service.js');
const { MarketClock } = require('./dist/runtime/market-clock.js');
const { DashboardReadModel } = require('./dist/runtime/dashboard-read-model.js');
const { createHealthServer } = require('./dist/runtime/health-server.js');
const { INDIA_NSE_EQ_MARKET } = require('./dist/market/india-profile.js');
const { getEligibleSymbols } = require('./dist/universe/policy.js');
const { UniverseCoverageVerdict } = require('./dist/types/runtime.js');

(async () => {
  let ok = 0, nok = 0;
  function check(name, val) {
    if (val) { ok++; console.log('  ✅ Stale witness: ' + name); }
    else     { nok++; console.log('  ❌ Stale witness: ' + name); }
  }

  // ── Setup: 25 fresh + 25 stale quotes → freshRatio=0.5 → Stale ────────
  const db = new DatabaseManager(':memory:');
  const brokerRepo = new BrokerRepository(db.db);
  const universeRepo = new UniverseRepository(db.db);
  const runtimeStateRepo = new RuntimeStateRepository(db.db);
  const lifecycle = new LifecycleManager(runtimeStateRepo);
  lifecycle.start('Stale witness');

  const eligibleSymbols = getEligibleSymbols('NSE');
  const symbols = [...eligibleSymbols].sort();
  const now = Date.now();

  // Seed all 50 instruments
  const instruments = symbols.map((s, i) => ({
    exchange: 'NSE',
    tradingsymbol: s,
    instrumentToken: 400000 + i * 100,
    name: s + ' LTD',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    instrumentType: 'EQ',
    segment: 'NSE',
    exchangeToken: 5000 + i,
  }));
  brokerRepo.upsertInstruments(instruments);

  // 25 fresh + 25 stale quotes
  for (let i = 0; i < 25; i++) {
    brokerRepo.upsertQuote({
      exchange: 'NSE',
      tradingsymbol: symbols[i],
      instrumentToken: 400000 + i * 100,
      lastPrice: 150 + Math.random() * 200,
      change: 1.5,
      changePercent: 0.8,
      volume: 75000,
      oi: null,
      high: 155,
      low: 145,
      open: 150,
      close: 148,
      bid: 150.5,
      ask: 151.0,
      priceTimestamp: Math.floor(now / 1000),
      receivedAt: now,
    });
  }
  for (let i = 25; i < 50; i++) {
    brokerRepo.upsertQuote({
      exchange: 'NSE',
      tradingsymbol: symbols[i],
      instrumentToken: 400000 + i * 100,
      lastPrice: 180 + Math.random() * 200,
      change: 1.2,
      changePercent: 0.6,
      volume: 60000,
      oi: null,
      high: 185,
      low: 175,
      open: 180,
      close: 178,
      bid: 180.5,
      ask: 181.0,
      priceTimestamp: Math.floor(now / 1000) - 300,
      receivedAt: now - 300_000, // 5 min old = stale (> maxQuoteStalenessMs=120000)
    });
  }

  brokerRepo.upsertInstrumentSyncState({
    lastSuccessAt: now,
    lastInstrumentCount: symbols.length,
    lastSkippedCount: 0,
    lastStatus: 'success',
    lastError: null,
  });

  // ── Compute snapshot ─────────────────────────────────────────────────
  const universeService = new UniverseService(brokerRepo, universeRepo);
  const universeSupervisor = new UniverseSupervisor(universeService);

  const healthStatus = {
    verdict: 'healthy',
    uptimeMs: 1000,
    lifecycleState: 'running',
    scheduler: { status: 'idle', marketPhase: 'regular', lastTickTimestamp: now, startedAt: now, tickCount: 1, lastError: null },
    degradedReasons: [],
    checkedAt: new Date().toISOString(),
  };

  await universeSupervisor.doWork(new Date(), healthStatus);

  // ── Build dashboard + server ─────────────────────────────────────────
  const healthService = new HealthService(lifecycle, runtimeStateRepo, now);
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const mockScheduler = {
    getState: () => ({
      status: 'idle',
      marketPhase: 'regular',
      lastTickTimestamp: now,
      startedAt: now,
      tickCount: 1,
      lastError: null,
    }),
    start: () => {},
    stop: () => {},
  };
  const mockTelemetry = {
    recordSchedulerState: () => {},
    recordHealthCheck: () => {},
  };

  const dashboard = new DashboardReadModel({
    healthService,
    runtimeStateRepo,
    zerodhaRepo: brokerRepo,
    proposalRepo: null,
    blockedOrderRepo: null,
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

  // ── Snapshot checks ──────────────────────────────────────────────────
  const snap = universeRepo.getLatestSnapshot();
  check('stale_snapshot_exists', snap !== null);
  check('stale_eligible_50', snap.eligibleCount === 50);
  check('stale_fresh_25', snap.freshQuoteCount === 25);
  check('stale_stale_25', snap.staleQuoteCount === 25);
  check('stale_missing_0', snap.missingQuoteCount === 0);
  check('stale_verdict_is_stale', snap.verdict === 'stale');
  // Negative: NOT sufficient
  check('stale_not_sufficient', snap.verdict !== 'sufficient');
  // Negative: NOT degraded
  check('stale_not_degraded', snap.verdict !== 'degraded');

  // ── /health/universe ─────────────────────────────────────────────────
  const universeEndpoint = await fetchJson(`http://localhost:${port}/health/universe`);
  check('stale_health_universe_200', universeEndpoint.status === 200);
  check('stale_health_universe_verdict', universeEndpoint.body.verdict === 'stale');
  check('stale_health_universe_fresh_25', universeEndpoint.body.freshQuoteCount === 25);
  check('stale_health_universe_stale_25', universeEndpoint.body.staleQuoteCount === 25);

  // ── /dashboard.json ──────────────────────────────────────────────────
  const dashJson = await fetchJson(`http://localhost:${port}/dashboard.json`);
  check('stale_dashboard_json_verdict', dashJson.body.universe.verdict === 'stale');
  check('stale_dashboard_json_stale_25', dashJson.body.universe.staleQuoteCount === 25);
  check('stale_dashboard_json_not_sufficient', dashJson.body.universe.verdict !== 'sufficient');

  // Cleanup
  server.close();
  db.close();

  if (nok > 0) { console.error('FAIL: Stale quote negative witness checks failed'); process.exit(1); }
  console.log('  Stale quote negative witness: all ' + ok + ' checks passed');
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
WITNESS_EOF

if [ $? -eq 0 ]; then
  pass "Stale quote negative witness passed"
else
  fail "Stale quote negative witness failed"
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
echo "  Milestone M003 / Slice S01 / Task T04"
echo "  Stack:  Node $NODE_VERSION, better-sqlite3, TypeScript"
echo "═══════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
