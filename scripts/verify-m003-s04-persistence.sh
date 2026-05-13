#!/usr/bin/env bash
# ── M003 S04 Persistence Verification Script ──
# Verifies that the execution gate enriches approved candidates with persisted
# broker data (quote + instrument) and produces durable paper orders, fills,
# positions, and position events that survive restart reconstruction.
#
# Usage: bash scripts/verify-m003-s04-persistence.sh

set -euo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
NODE_VERSION=$(node --version 2>/dev/null || echo "unknown")

pass()  { PASS=$((PASS + 1)); echo "  ✅ PASS: $1"; }
fail()  { FAIL=$((FAIL + 1)); echo "  ❌ FAIL: $1"; }

echo "═══════════════════════════════════════════"
echo "  M003 S04 Persistence Verification"
echo "═══════════════════════════════════════════"

# ── 1. TypeScript compilation ────────────────────────────────────────────
echo ""
echo "── Step 1: TypeScript compilation ──"
if npx tsc --noEmit 2>&1; then
  pass "TypeScript compiles with zero errors"
else
  fail "TypeScript compilation failed"
fi

# ── 2. S04-domain tests ─────────────────────────────────────────────────
echo ""
echo "── Step 2: S04-domain tests ──"
if npx vitest run \
  tests/s04-runtime.integration.test.ts \
  2>&1; then
  pass "S04 runtime integration tests pass"
else
  fail "S04 runtime integration tests failed"
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
    PERSISTENCE_FILES=(
      "dist/execution/execution-gate-supervisor.js"
      "dist/execution/paper-execution-ledger.js"
      "dist/execution/mode-aware-execution-service.js"
      "dist/execution/paper-execution-policy.js"
      "dist/persistence/paper-order-repo.js"
      "dist/persistence/paper-fill-repo.js"
      "dist/persistence/paper-position-repo.js"
      "dist/persistence/broker-repo.js"
    )
    ALL_FILES_PRESENT=true
    for EF in "${PERSISTENCE_FILES[@]}"; do
      if [ -f "$EF" ]; then
        echo "    ✓ $EF"
      else
        echo "    ✗ $EF missing"
        ALL_FILES_PRESENT=false
      fi
    done
    if $ALL_FILES_PRESENT; then
      pass "All persistence modules present in compiled output"
    else
      fail "One or more persistence modules missing from compiled output"
    fi
  else
    fail "dist/main.js not found after build"
  fi
else
  fail "Build failed"
fi

# ── 5. Paper-filled path witness ────────────────────────────────────────
echo ""
echo "── Step 5: Paper-filled path witness ──"

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
const { DatabaseManager } = require('./dist/persistence/sqlite.js');
const { ProposalRepository } = require('./dist/persistence/proposal-repo.js');
const { StrategyDecisionRepository } = require('./dist/persistence/strategy-decision-repo.js');
const { ExecutionAttemptRepository } = require('./dist/persistence/execution-attempt-repo.js');
const { BrokerRepository } = require('./dist/persistence/broker-repo.js');
const { PaperOrderRepository } = require('./dist/persistence/paper-order-repo.js');
const { PaperFillRepository } = require('./dist/persistence/paper-fill-repo.js');
const { PaperPositionRepository } = require('./dist/persistence/paper-position-repo.js');
const { ExecutionGateSupervisor } = require('./dist/execution/execution-gate-supervisor.js');
const { ModeAwareExecutionService } = require('./dist/execution/mode-aware-execution-service.js');
const { PaperExecutionPolicy } = require('./dist/execution/paper-execution-policy.js');
const { PaperExecutionLedger } = require('./dist/execution/paper-execution-ledger.js');
const { BlockedExecutionAdapter, LiveExecutionAdapter } = require('./dist/execution/execution-adapters.js');
const {
  ProposalStatus, StrategyDecisionStatus, ExecutionMode,
  ExecutionAttemptStatus, ExecutionOutcomeCode, PaperOrderStatus,
  PositionSide, PositionEventType,
} = require('./dist/types/runtime.js');

const db = new DatabaseManager(':memory:');
const proposalRepo = new ProposalRepository(db.db);
const strategyDecisionRepo = new StrategyDecisionRepository(db.db);
const attemptRepo = new ExecutionAttemptRepository(db.db);
const brokerRepo = new BrokerRepository(db.db);
const orderRepo = new PaperOrderRepository(db.db);
const fillRepo = new PaperFillRepository(db.db);
const positionRepo = new PaperPositionRepository(db.db);

// Seed broker data
brokerRepo.upsertInstruments([{
  exchange: 'NSE',
  tradingsymbol: 'WITNESS',
  instrumentToken: 999001,
  name: 'WITNESS CORP LTD',
  expiry: null,
  strike: null,
  lotSize: 1,
  tickSize: 0.05,
  instrumentType: 'EQ',
  segment: 'NSE',
  exchangeToken: 9990,
}]);

brokerRepo.upsertQuote({
  exchange: 'NSE',
  tradingsymbol: 'WITNESS',
  instrumentToken: 999001,
  lastPrice: 500.00,
  change: 5.00,
  changePercent: 1.01,
  volume: 500000,
  oi: null,
  high: 502.00,
  low: 496.00,
  open: 497.00,
  close: 495.00,
  bid: 499.50,
  ask: 500.00,
  priceTimestamp: Math.floor(Date.now() / 1000) - 10,
  receivedAt: Date.now() - 5000,
});

// Wire up paper execution stack
const paperPolicy = new PaperExecutionPolicy();
const paperLedger = new PaperExecutionLedger({
  db: db.db,
  attemptRepo,
  orderRepo,
  fillRepo,
  positionRepo,
});
const liveAdapter = new LiveExecutionAdapter(null);
const blockedAdapter = new BlockedExecutionAdapter();
const executionService = new ModeAwareExecutionService({
  attemptRepo,
  paperPolicy,
  paperLedger,
  liveAdapter,
  blockedAdapter,
  mode: ExecutionMode.Paper,
});
const executionGate = new ExecutionGateSupervisor({
  strategyDecisionRepo,
  executionService,
  attemptRepo,
  brokerRepo,
});

let ok = 0, nok = 0;
function check(name, val) {
  if (val) { ok++; console.log('  ✅ Witness: ' + name); }
  else { nok++; console.log('  ❌ Witness: ' + name); }
}

(async () => {
  // Seed proposal + strategy decision
  const proposal = proposalRepo.insertAttempt({
    exchange: 'NSE', tradingsymbol: 'WITNESS', instrumentToken: 999001,
    side: 'buy', product: 'MIS', quantity: 10, price: null, triggerPrice: null,
    orderType: 'MARKET', tag: 'witness-persistence',
    proposalStatus: ProposalStatus.Accepted, createdAt: Date.now(),
  });

  const decision = strategyDecisionRepo.insertDecisionWithReasons({
    proposalAttemptId: proposal.id,
    decisionStatus: StrategyDecisionStatus.Approved,
    strategyId: 'test-strategy', strategyVersion: '1.0.0',
    decidedAt: Date.now(),
    exchange: 'NSE', tradingsymbol: 'WITNESS',
    side: 'buy', product: 'MIS',
    quantity: 10, price: null, triggerPrice: null,
    orderType: 'MARKET',
    quoteLastPrice: 500.00, quoteBid: 499.50, quoteAsk: 500.00,
    quoteVolume: 500000, quoteReceivedAt: Date.now(),
    riskNotional: 5000.00, riskSizingBasis: 'last_price',
    riskMaxLossRupees: 250.00, riskStopDistance: null,
    riskExposureTag: 'intraday',
  }, []);

  // ── Run the gate ───────────────────────────────────────────────────────
  await executionGate.doWork(new Date(), { verdict: 'healthy', uptimeMs: 1000, checkedAt: new Date().toISOString() });

  // ── Check execution attempt ────────────────────────────────────────────
  const attempts = attemptRepo.getRecent();
  check('attempt_created', attempts.length === 1);
  check('attempt_completed', attempts[0].status === ExecutionAttemptStatus.Completed);
  check('attempt_paper_simulated', attempts[0].outcomeCode === ExecutionOutcomeCode.PaperSimulated);
  check('attempt_has_broker_order_id', attempts[0].brokerOrderId !== null && attempts[0].brokerOrderId.startsWith('paper-'));

  // ── Check paper order ──────────────────────────────────────────────────
  const orders = orderRepo.getRecent();
  check('order_created', orders.length === 1);
  check('order_filled', orders[0].status === PaperOrderStatus.Filled);
  check('order_symbol', orders[0].tradingsymbol === 'WITNESS');
  check('order_side', orders[0].side === 'buy');
  check('order_quantity', orders[0].quantity === 10);

  // ── Check paper fill ──────────────────────────────────────────────────
  const fills = fillRepo.getRecent();
  check('fill_created', fills.length === 1);
  check('fill_quantity', fills[0].filledQuantity === 10);
  check('fill_has_price', fills[0].filledPrice > 0);

  // ── Check position event ──────────────────────────────────────────────
  const events = positionRepo.getRecentEvents();
  check('position_event_created', events.length === 1);
  check('position_event_open', events[0].eventType === PositionEventType.Open);
  check('position_event_new_qty', events[0].newQuantity === 10);
  check('position_event_symbol', events[0].tradingsymbol === 'WITNESS');

  // ── Check paper position ──────────────────────────────────────────────
  const position = positionRepo.getPosition('NSE', 'WITNESS', 'MIS');
  check('position_exists', position !== null);
  check('position_long', position.side === PositionSide.Long);
  check('position_quantity', position.quantity === 10);
  check('position_avg_cost', position.avgCostPrice > 0);

  // ── Check decision consumed ────────────────────────────────────────────
  const unconsumed = strategyDecisionRepo.getApprovedUnconsumedCandidates();
  check('decision_consumed', unconsumed.length === 0);

  // ── Check replay idempotency ──────────────────────────────────────────
  await executionGate.doWork(new Date(), { verdict: 'healthy', uptimeMs: 1000, checkedAt: new Date().toISOString() });
  check('replay_no_duplicate_attempt', attemptRepo.count() === 1);
  check('replay_no_duplicate_order', orderRepo.count() === 1);
  check('replay_no_duplicate_fill', fillRepo.count() === 1);

  // ── Check restart reconstruction ──────────────────────────────────────
  // Scramble position to simulate stale cache
  positionRepo.upsertPosition({
    exchange: 'NSE', tradingsymbol: 'WITNESS', product: 'MIS',
    side: PositionSide.Flat, quantity: 0, avgCostPrice: 0, realizedPnl: 0,
    updatedAt: Date.now(),
  });
  const flatPos = positionRepo.getPosition('NSE', 'WITNESS', 'MIS');
  check('position_scrambled_to_flat', flatPos.quantity === 0);

  // Reconstruct from events
  const reconstructed = positionRepo.reconstructAllPositions();
  check('reconstruction_restored', reconstructed.length === 1);
  check('reconstruction_qty', reconstructed[0].quantity === 10);
  check('reconstruction_side', reconstructed[0].side === PositionSide.Long);

  // ── Check computation from events (in-memory) ─────────────────────────
  const computed = positionRepo.computePositionFromEvents('NSE', 'WITNESS', 'MIS');
  check('computed_qty', computed.quantity === 10);
  check('computed_side', computed.side === PositionSide.Long);

  db.close();
  if (nok > 0) { console.error('FAIL: Paper-filled path witness checks failed'); process.exit(1); }
  console.log('  Paper-filled path witness: all ' + ok + ' checks passed');
})().catch(err => { console.error('FAIL: Paper-filled witness threw:', err.message); process.exit(1); });
WITNESS_EOF

# ── 6. Missing-data refusal path witness ─────────────────────────────────
echo ""
echo "── Step 6: Missing-data refusal path witness ──"

node --input-type=commonjs << 'WITNESS_EOF' 2>&1
const { DatabaseManager } = require('./dist/persistence/sqlite.js');
const { ProposalRepository } = require('./dist/persistence/proposal-repo.js');
const { StrategyDecisionRepository } = require('./dist/persistence/strategy-decision-repo.js');
const { ExecutionAttemptRepository } = require('./dist/persistence/execution-attempt-repo.js');
const { BrokerRepository } = require('./dist/persistence/broker-repo.js');
const { PaperOrderRepository } = require('./dist/persistence/paper-order-repo.js');
const { PaperFillRepository } = require('./dist/persistence/paper-fill-repo.js');
const { PaperPositionRepository } = require('./dist/persistence/paper-position-repo.js');
const { ExecutionGateSupervisor } = require('./dist/execution/execution-gate-supervisor.js');
const { ModeAwareExecutionService } = require('./dist/execution/mode-aware-execution-service.js');
const { PaperExecutionPolicy } = require('./dist/execution/paper-execution-policy.js');
const { PaperExecutionLedger } = require('./dist/execution/paper-execution-ledger.js');
const { BlockedExecutionAdapter, LiveExecutionAdapter } = require('./dist/execution/execution-adapters.js');
const {
  ProposalStatus, StrategyDecisionStatus, ExecutionMode,
  ExecutionAttemptStatus, ExecutionOutcomeCode,
} = require('./dist/types/runtime.js');

const db = new DatabaseManager(':memory:');
const proposalRepo = new ProposalRepository(db.db);
const strategyDecisionRepo = new StrategyDecisionRepository(db.db);
const attemptRepo = new ExecutionAttemptRepository(db.db);
const brokerRepo = new BrokerRepository(db.db);
const orderRepo = new PaperOrderRepository(db.db);
const fillRepo = new PaperFillRepository(db.db);
const positionRepo = new PaperPositionRepository(db.db);

// Seed instrument but NOT quote — gate should refuse with stale_or_missing_quote
brokerRepo.upsertInstruments([{
  exchange: 'NSE',
  tradingsymbol: 'MISSING_QUOTE',
  instrumentToken: 888001,
  name: 'MISSING QUOTE CORP',
  expiry: null,
  strike: null,
  lotSize: 1,
  tickSize: 0.05,
  instrumentType: 'EQ',
  segment: 'NSE',
  exchangeToken: 8880,
}]);

const paperPolicy = new PaperExecutionPolicy();
const paperLedger = new PaperExecutionLedger({
  db: db.db, attemptRepo, orderRepo, fillRepo, positionRepo,
});
const executionService = new ModeAwareExecutionService({
  attemptRepo, paperPolicy, paperLedger,
  liveAdapter: new LiveExecutionAdapter(null),
  blockedAdapter: new BlockedExecutionAdapter(),
  mode: ExecutionMode.Paper,
});
const executionGate = new ExecutionGateSupervisor({
  strategyDecisionRepo, executionService, attemptRepo, brokerRepo,
});

let ok = 0, nok = 0;
function check(name, val) {
  if (val) { ok++; console.log('  ✅ Missing-data witness: ' + name); }
  else { nok++; console.log('  ❌ Missing-data witness: ' + name); }
}

(async () => {
  const proposal = proposalRepo.insertAttempt({
    exchange: 'NSE', tradingsymbol: 'MISSING_QUOTE', instrumentToken: 888001,
    side: 'buy', product: 'MIS', quantity: 5, price: null, triggerPrice: null,
    orderType: 'MARKET', tag: 'witness-missing',
    proposalStatus: ProposalStatus.Accepted, createdAt: Date.now(),
  });

  strategyDecisionRepo.insertDecisionWithReasons({
    proposalAttemptId: proposal.id,
    decisionStatus: StrategyDecisionStatus.Approved,
    strategyId: 'test-strategy', strategyVersion: '1.0.0',
    decidedAt: Date.now(),
    exchange: 'NSE', tradingsymbol: 'MISSING_QUOTE',
    side: 'buy', product: 'MIS',
    quantity: 5, price: null, triggerPrice: null,
    orderType: 'MARKET',
    quoteLastPrice: null, quoteBid: null, quoteAsk: null,
    quoteVolume: null, quoteReceivedAt: null,
    riskNotional: null, riskSizingBasis: 'last_price',
    riskMaxLossRupees: null, riskStopDistance: null,
    riskExposureTag: 'intraday',
  }, []);

  await executionGate.doWork(new Date(), { verdict: 'healthy', uptimeMs: 1000, checkedAt: new Date().toISOString() });

  const attempts = attemptRepo.getRecent();
  check('refused_attempt_created', attempts.length === 1);
  check('refused_status', attempts[0].status === ExecutionAttemptStatus.Refused);
  check('refused_reason_stale_quote', attempts[0].message.toLowerCase().includes('quote'));

  const reasons = attemptRepo.getRefusalReasons(attempts[0].id);
  check('refusal_reasons_exist', reasons.length >= 1);
  check('refusal_reason_code_stale', reasons.some(r => r.reasonCode === 'stale_or_missing_quote'));

  // No downstream rows for refusals
  check('no_downstream_order', orderRepo.count() === 0);
  check('no_downstream_fill', fillRepo.count() === 0);
  check('no_downstream_event', positionRepo.countEvents() === 0);
  check('no_downstream_position', positionRepo.countPositions() === 0);

  db.close();
  if (nok > 0) { console.error('FAIL: Missing-data witness checks failed'); process.exit(1); }
  console.log('  Missing-data refusal path witness: all ' + ok + ' checks passed');
})().catch(err => { console.error('FAIL: Missing-data witness threw:', err.message); process.exit(1); });
WITNESS_EOF

# ── Summary ──────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════"
echo "  Milestone M003 / Slice S04"
echo "  Stack:  Node $NODE_VERSION, better-sqlite3, TypeScript"
echo "═══════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
