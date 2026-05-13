#!/usr/bin/env bash
# ── M003 S03 Execution Service Verification Script ──
# Verifies the complete execution service stack:
#   1. TypeScript compiles cleanly
#   2. T04-domain tests pass (execution evidence on operator surfaces)
#   3. Full test suite has no regressions
#   4. Paper-consumed path: execution attempt recorded with paper outcome
#   5. Fail-closed path: blocked mode refuses all attempts with mode_blocked reason
#   6. /health/execution route returns execution evidence
#   7. Dashboard JSON includes execution block with mode and recent attempts
#
# Usage: bash scripts/verify-m003-s03-execution-service.sh

set -euo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
NODE_VERSION=$(node --version 2>/dev/null || echo "unknown")

pass()  { PASS=$((PASS + 1)); echo "  ✅ PASS: $1"; }
fail()  { FAIL=$((FAIL + 1)); echo "  ❌ FAIL: $1"; }

echo "═══════════════════════════════════════════"
echo "  M003 S03 Execution Service Verification"
echo "═══════════════════════════════════════════"

# ── 1. TypeScript compilation ────────────────────────────────────────────
echo ""
echo "── Step 1: TypeScript compilation ──"
if npx tsc --noEmit 2>&1; then
  pass "TypeScript compiles with zero errors"
else
  fail "TypeScript compilation failed"
fi

# ── 2. T04-domain tests ─────────────────────────────────────────────────
echo ""
echo "── Step 2: T04-domain tests (execution evidence) ──"
if npx vitest run \
  tests/dashboard-read-model.test.ts \
  tests/health-server-dashboard.test.ts \
  2>&1; then
  pass "T04-domain tests pass"
else
  fail "T04-domain tests failed"
fi

# ── 3. Full test suite (no regressions) ──────────────────────────────────
echo ""
echo "── Step 3: Full test suite ──"
if npx vitest run 2>&1; then
  pass "All tests pass (no regressions)"
else
  fail "Full test suite has failures"
fi

# ── 4. Build output ─────────────────────────────────────────────────────
echo ""
echo "── Step 4: Build output ──"
if npx tsc --project tsconfig.json 2>&1; then
  if [ -f dist/main.js ]; then
    pass "Build produces dist/main.js"
    EXECUTION_FILES=(
      "dist/execution/mode-aware-execution-service.js"
      "dist/execution/paper-execution-policy.js"
      "dist/execution/execution-adapters.js"
      "dist/execution/execution-gate-supervisor.js"
      "dist/persistence/execution-attempt-repo.js"
      "dist/runtime/dashboard-read-model.js"
      "dist/runtime/dashboard-render.js"
      "dist/runtime/health-server.js"
    )
    ALL_FILES_PRESENT=true
    for EF in "${EXECUTION_FILES[@]}"; do
      if [ -f "$EF" ]; then
        echo "    ✓ $EF"
      else
        echo "    ✗ $EF missing"
        ALL_FILES_PRESENT=false
      fi
    done
    if $ALL_FILES_PRESENT; then
      pass "All execution modules present in compiled output"
    else
      fail "One or more execution modules missing from compiled output"
    fi
  else
    fail "dist/main.js not found after build"
  fi
else
  fail "Build failed"
fi

# ── 5. Paper-consumed path witness ──────────────────────────────────────
echo ""
echo "── Step 5: Paper-consumed path witness ──"

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
const { DatabaseManager } = require('./dist/persistence/sqlite.js');
const { ProposalRepository } = require('./dist/persistence/proposal-repo.js');
const { StrategyDecisionRepository } = require('./dist/persistence/strategy-decision-repo.js');
const { ExecutionAttemptRepository } = require('./dist/persistence/execution-attempt-repo.js');
const { ProposalStatus, StrategyDecisionStatus, ExecutionMode, ExecutionAttemptStatus, ExecutionOutcomeCode } = require('./dist/types/runtime.js');
const { ModeAwareExecutionService } = require('./dist/execution/mode-aware-execution-service.js');
const { PaperExecutionPolicy } = require('./dist/execution/paper-execution-policy.js');

const db = new DatabaseManager(':memory:');
const proposalRepo = new ProposalRepository(db.db);
const strategyDecisionRepo = new StrategyDecisionRepository(db.db);
const attemptRepo = new ExecutionAttemptRepository(db.db);
const paperPolicy = new PaperExecutionPolicy();

// Create paper-mode execution service
const service = new ModeAwareExecutionService({
  attemptRepo,
  paperPolicy,
  liveAdapter: null,
  mode: ExecutionMode.Paper,
});

let ok = 0, nok = 0;
function check(name, val) { if (val) { ok++; console.log('  ✅ Paper witness: ' + name); } else { nok++; console.log('  ❌ Paper witness: ' + name); } }

// Seed a proposal and strategy decision
const proposal = proposalRepo.insertAttempt({
  exchange: 'NSE', tradingsymbol: 'PAPER_TEST', instrumentToken: 123456,
  side: 'buy', product: 'MIS', quantity: 75, price: null, triggerPrice: null,
  orderType: 'MARKET', tag: 'witness-paper',
  proposalStatus: ProposalStatus.Accepted, createdAt: Date.now(),
});

const decision = strategyDecisionRepo.insertDecisionWithReasons({
  proposalAttemptId: proposal.id, decisionStatus: StrategyDecisionStatus.Approved,
  strategyId: 'test-strategy', strategyVersion: '1.0.0', decidedAt: Date.now(),
  exchange: 'NSE', tradingsymbol: 'PAPER_TEST', side: 'buy', product: 'MIS',
  quantity: 75, price: null, triggerPrice: null, orderType: 'MARKET',
  quoteLastPrice: 2850.50, quoteBid: 2850.00, quoteAsk: 2851.00,
  quoteVolume: 1250000, quoteReceivedAt: Date.now(),
  riskNotional: 213787.50, riskSizingBasis: 'last_price',
  riskMaxLossRupees: 10689.38, riskStopDistance: null, riskExposureTag: 'intraday',
}, []);

const candidate = {
  id: decision.id,
  proposalAttemptId: decision.proposalAttemptId,
  strategyId: decision.strategyId,
  strategyVersion: decision.strategyVersion,
  decidedAt: decision.decidedAt,
  exchange: decision.exchange,
  tradingsymbol: decision.tradingsymbol,
  side: decision.side,
  product: decision.product,
  quantity: decision.quantity,
  price: decision.price,
  triggerPrice: decision.triggerPrice,
  orderType: decision.orderType,
  lastPrice: decision.quoteLastPrice,
  bid: decision.quoteBid,
  ask: decision.quoteAsk,
  notional: decision.riskNotional,
  sizingBasis: decision.riskSizingBasis,
};

const quote = {
  exchange: 'NSE',
  tradingsymbol: 'PAPER_TEST',
  instrumentToken: 123456,
  lastPrice: 2850.50,
  change: 10.20,
  changePercent: 0.36,
  volume: 1250000,
  oi: null,
  high: 2860.00,
  low: 2840.00,
  open: 2845.00,
  close: 2840.30,
  bid: 2850.00,
  ask: 2851.00,
  priceTimestamp: Math.floor(Date.now() / 1000) - 30,
  receivedAt: Date.now() - 5000,
};

const instrument = {
  exchange: 'NSE',
  tradingsymbol: 'PAPER_TEST',
  instrumentToken: 123456,
  name: 'PAPER TEST CORP',
  expiry: null,
  strike: null,
  lotSize: 75,
  tickSize: 0.05,
  instrumentType: 'EQ',
  segment: 'NSE_EQ',
  exchangeToken: 54321,
};

// Execute through paper mode (async)
service.execute(candidate, quote, instrument).then((result) => {
  check('paper_result_exists', result !== null);
  check('paper_attempt_completed', result.status === ExecutionAttemptStatus.Completed);
  check('paper_outcome_simulated', result.outcomeCode === ExecutionOutcomeCode.PaperSimulated);
  check('paper_broker_order_id_set', result.brokerOrderId !== null && result.brokerOrderId.startsWith('paper-'));

  // Verify attempt is persisted
  const byDecision = attemptRepo.getByStrategyDecisionId(decision.id);
  check('attempt_persisted', byDecision !== null);
  check('attempt_mode_paper', byDecision.executionMode === ExecutionMode.Paper);
  check('attempt_status_completed', byDecision.status === ExecutionAttemptStatus.Completed);

  // Verify the decision is consumed (no longer appears in unconsumed)
  const unconsumed = strategyDecisionRepo.getApprovedUnconsumedCandidates();
  check('decision_consumed', unconsumed.length === 0);

  // Verify total attempt count
  const count = attemptRepo.count();
  check('total_attempts_1', count === 1);

  db.close();
  if (nok > 0) { console.error('FAIL: Paper-consumed path witness checks failed'); process.exit(1); }
  console.log('  Paper-consumed path witness: all ' + ok + ' checks passed');
}).catch(err => {
  console.error('FAIL: Paper witness threw:', err.message);
  process.exit(1);
});
WITNESS_EOF

# ── 6. Fail-closed path witness (blocked mode) ─────────────────────────
echo ""
echo "── Step 6: Fail-closed path witness (blocked mode) ──"

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
const { DatabaseManager } = require('./dist/persistence/sqlite.js');
const { ProposalRepository } = require('./dist/persistence/proposal-repo.js');
const { StrategyDecisionRepository } = require('./dist/persistence/strategy-decision-repo.js');
const { ExecutionAttemptRepository } = require('./dist/persistence/execution-attempt-repo.js');
const { ProposalStatus, StrategyDecisionStatus, ExecutionMode, ExecutionAttemptStatus, ExecutionOutcomeCode, ExecutionRefusalCode } = require('./dist/types/runtime.js');
const { ModeAwareExecutionService } = require('./dist/execution/mode-aware-execution-service.js');
const { PaperExecutionPolicy } = require('./dist/execution/paper-execution-policy.js');

const db = new DatabaseManager(':memory:');
const proposalRepo = new ProposalRepository(db.db);
const strategyDecisionRepo = new StrategyDecisionRepository(db.db);
const attemptRepo = new ExecutionAttemptRepository(db.db);
const paperPolicy = new PaperExecutionPolicy();

// Create blocked-mode execution service
const service = new ModeAwareExecutionService({
  attemptRepo,
  paperPolicy,
  liveAdapter: null,
  mode: ExecutionMode.Blocked,
});

let ok = 0, nok = 0;
function check(name, val) { if (val) { ok++; console.log('  ✅ Fail-closed witness: ' + name); } else { nok++; console.log('  ❌ Fail-closed witness: ' + name); } }

// Seed a proposal and strategy decision
const proposal = proposalRepo.insertAttempt({
  exchange: 'NSE', tradingsymbol: 'BLOCKED_TEST', instrumentToken: 789012,
  side: 'sell', product: 'NRML', quantity: 25, price: 150.50, triggerPrice: null,
  orderType: 'LIMIT', tag: 'witness-blocked',
  proposalStatus: ProposalStatus.Accepted, createdAt: Date.now(),
});

const decision = strategyDecisionRepo.insertDecisionWithReasons({
  proposalAttemptId: proposal.id, decisionStatus: StrategyDecisionStatus.Approved,
  strategyId: 'test-strategy', strategyVersion: '1.0.0', decidedAt: Date.now(),
  exchange: 'NSE', tradingsymbol: 'BLOCKED_TEST', side: 'sell', product: 'NRML',
  quantity: 25, price: 150.50, triggerPrice: null, orderType: 'LIMIT',
  quoteLastPrice: 150.50, quoteBid: 150.00, quoteAsk: 151.00,
  quoteVolume: 500000, quoteReceivedAt: Date.now(),
  riskNotional: 3762.50, riskSizingBasis: 'last_price',
  riskMaxLossRupees: 188.13, riskStopDistance: null, riskExposureTag: 'intraday',
}, []);

const candidate = {
  id: decision.id,
  proposalAttemptId: decision.proposalAttemptId,
  strategyId: decision.strategyId,
  strategyVersion: decision.strategyVersion,
  decidedAt: decision.decidedAt,
  exchange: decision.exchange,
  tradingsymbol: decision.tradingsymbol,
  side: decision.side,
  product: decision.product,
  quantity: decision.quantity,
  price: decision.price,
  triggerPrice: decision.triggerPrice,
  orderType: decision.orderType,
  lastPrice: decision.quoteLastPrice,
  bid: decision.quoteBid,
  ask: decision.quoteAsk,
  notional: decision.riskNotional,
  sizingBasis: decision.riskSizingBasis,
};

// Attempt execution through blocked mode — should refuse (async)
service.execute(candidate, null, null).then((result) => {
  check('blocked_result_exists', result !== null);
  check('blocked_attempt_refused', result.status === ExecutionAttemptStatus.Refused);
  check('blocked_no_outcome', result.outcomeCode === null);
  check('blocked_message_indicates_refused', result.message.toLowerCase().includes('refus') || result.message.toLowerCase().includes('block'));

  // Verify refusal reasons exist
  const reasons = attemptRepo.getRefusalReasons(result.id);
  check('blocked_has_refusal_reasons', reasons.length > 0);
  check('blocked_refusal_code_mode_blocked', reasons.some(r => r.reasonCode === ExecutionRefusalCode.ModeBlocked));
  check('blocked_refusal_explains_blocked', reasons.some(r => r.reasonMessage.toLowerCase().includes('blocked')));

  // Verify attempt is persisted
  const byDecision = attemptRepo.getByStrategyDecisionId(decision.id);
  check('blocked_attempt_persisted', byDecision !== null);
  check('blocked_attempt_mode_blocked', byDecision.executionMode === ExecutionMode.Blocked);
  check('blocked_attempt_status_refused', byDecision.status === ExecutionAttemptStatus.Refused);

  // Verify the decision is still consumed (no unconsumed remain)
  const unconsumed = strategyDecisionRepo.getApprovedUnconsumedCandidates();
  check('blocked_decision_consumed', unconsumed.length === 0);

  db.close();
  if (nok > 0) { console.error('FAIL: Fail-closed path witness checks failed'); process.exit(1); }
  console.log('  Fail-closed path witness: all ' + ok + ' checks passed');
}).catch(err => {
  console.error('FAIL: Fail-closed witness threw:', err.message);
  process.exit(1);
});
WITNESS_EOF

# ── 7. Execution attempt persistence and health/execution evidence ────────
echo ""
echo "── Step 7: Execution-attempt persistence / health/execution evidence ──"

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
(async () => {
const http = require('node:http');
const { DatabaseManager } = require('./dist/persistence/sqlite.js');
const { RuntimeStateRepository } = require('./dist/persistence/runtime-state-repo.js');
const { ProposalRepository } = require('./dist/persistence/proposal-repo.js');
const { StrategyDecisionRepository } = require('./dist/persistence/strategy-decision-repo.js');
const { ExecutionAttemptRepository } = require('./dist/persistence/execution-attempt-repo.js');
const { LifecycleManager } = require('./dist/runtime/lifecycle.js');
const { HealthService } = require('./dist/runtime/health-service.js');
const { MarketClock } = require('./dist/runtime/market-clock.js');
const { DashboardReadModel } = require('./dist/runtime/dashboard-read-model.js');
const { createHealthServer } = require('./dist/runtime/health-server.js');
const { INDIA_NSE_EQ_MARKET } = require('./dist/market/india-profile.js');
const { ProposalStatus, StrategyDecisionStatus, ExecutionMode, ExecutionAttemptStatus, ExecutionOutcomeCode } = require('./dist/types/runtime.js');

const db = new DatabaseManager(':memory:');
const runtimeStateRepo = new RuntimeStateRepository(db.db);
const proposalRepo = new ProposalRepository(db.db);
const strategyDecisionRepo = new StrategyDecisionRepository(db.db);
const attemptRepo = new ExecutionAttemptRepository(db.db);
const lifecycle = new LifecycleManager(runtimeStateRepo);
lifecycle.start('Witness setup');

const healthService = new HealthService(lifecycle, runtimeStateRepo, Date.now());
const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
const dashboard = new DashboardReadModel({
  healthService,
  runtimeStateRepo,
  zerodhaRepo: { getSession: () => null, getLatestInstruments: () => null, getRecentEvents: () => [] },
  proposalRepo,
  blockedOrderRepo: null,
  strategyDecisionRepo,
  clock,
  universeService: { getCoverageSummary: () => null },
  attemptRepo,
  executionMode: ExecutionMode.Paper,
});

const server = createHealthServer(healthService, { getState: () => ({ status: 'idle', marketPhase: 'closed', lastTickTimestamp: null, startedAt: null, tickCount: 0, lastError: null }) }, { recordSchedulerState: () => {}, recordHealthCheck: () => {} }, db, dashboard);

let ok = 0, nok = 0;
function check(name, val) { if (val) { ok++; console.log('  ✅ Persistence witness: ' + name); } else { nok++; console.log('  ❌ Persistence witness: ' + name); } }

// Seed proposal + decision + paper execution attempt
const proposal = proposalRepo.insertAttempt({
  exchange: 'NSE', tradingsymbol: 'WITNESS', instrumentToken: 555,
  side: 'buy', product: 'MIS', quantity: 10, price: null, triggerPrice: null,
  orderType: 'MARKET', tag: 'witness',
  proposalStatus: ProposalStatus.Accepted, createdAt: Date.now(),
});

const decision = strategyDecisionRepo.insertDecisionWithReasons({
  proposalAttemptId: proposal.id, decisionStatus: StrategyDecisionStatus.Approved,
  strategyId: 'test', strategyVersion: '1.0.0', decidedAt: Date.now(),
  exchange: 'NSE', tradingsymbol: 'WITNESS', side: 'buy', product: 'MIS',
  quantity: 10, price: null, triggerPrice: null, orderType: 'MARKET',
  quoteLastPrice: 500, quoteBid: 499, quoteAsk: 501,
  quoteVolume: 100000, quoteReceivedAt: Date.now(),
  riskNotional: 5000, riskSizingBasis: 'last_price',
  riskMaxLossRupees: 250, riskStopDistance: null, riskExposureTag: 'intraday',
}, []);

attemptRepo.insertAttempt({
  strategyDecisionId: decision.id, executionMode: ExecutionMode.Paper,
  status: ExecutionAttemptStatus.Completed,
  outcomeCode: ExecutionOutcomeCode.PaperSimulated,
  brokerOrderId: null,
  message: 'Witness paper execution',
  attemptedAt: Date.now(),
  completedAt: Date.now() + 50,
});

// Check persistence
check('count_1', attemptRepo.count() === 1);
check('is_consumed', attemptRepo.isConsumed(decision.id) === true);

// Start server and fetch /health/execution
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const addr = server.address();
const port = addr.port;

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

// Fetch /health/execution
const healthExec = await httpGet('/health/execution');
const hd = JSON.parse(healthExec.body);
check('health_exec_status_200', healthExec.status === 200);
check('health_exec_has_mode', hd.mode === 'paper');
check('health_exec_total_1', hd.totalAttempts === 1);
check('health_exec_not_refusing', hd.isGateRefusing === false);
check('health_exec_recent_length', hd.recentAttempts.length === 1);
check('health_exec_recent_symbol', hd.recentAttempts[0].tradingsymbol === 'WITNESS');
check('health_exec_recent_outcome', hd.recentAttempts[0].outcomeCode === 'paper_simulated');
check('health_exec_recent_status', hd.recentAttempts[0].status === 'completed');

// Fetch /dashboard.json and check execution block
const dashJson = await httpGet('/dashboard.json');
const dj = JSON.parse(dashJson.body);
check('dash_json_has_execution', dj.execution !== undefined && dj.execution !== null);
check('dash_exec_mode_paper', dj.execution.mode === 'paper');
check('dash_exec_total_1', dj.execution.totalAttempts === 1);

server.close();
db.close();
if (nok > 0) { console.error('FAIL: Persistence/health/execution witness checks failed'); process.exit(1); }
console.log('  Persistence/health/execution witness: all ' + ok + ' checks passed');
})().catch(err => { console.error('FAIL: Persistence witness threw:', err.message); process.exit(1); });
WITNESS_EOF

# ── Summary ──────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════"
echo "  Milestone M003 / Slice S03"
echo "  Stack:  Node $NODE_VERSION, better-sqlite3, TypeScript"
echo "═══════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
