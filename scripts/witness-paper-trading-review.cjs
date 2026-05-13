#!/usr/bin/env node
// ── M003/S06 Paper-Trading Review — Node witness ──
// Standalone node script run by verify-m003-s06-paper-witness.sh
// Uses .cjs extension because the project has "type": "module" in package.json
// but this script uses CommonJS require() for compiled dist outputs.
//
// This witness:
//   1. Starts RuntimeApp in Paper mode against a temp file-backed SQLite DB
//   2. Seeds instrument + quote data for RELIANCE
//   3. Seeds one accepted proposal + approved strategy decision
//   4. Drives ExecutionGateSupervisor with an in-session weekday timestamp
//   5. Asserts orders, fills, positions, and risk evidence on operator HTTP surfaces
//   6. Creates a halt condition (risk boundary) and seeds a second candidate
//   7. Asserts the halt is visible and the second candidate is not consumed
//   8. Restarts on the same DB and re-asserts persistence without duplication

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { RuntimeApp } = require('../dist/runtime/runtime-app.js');
const { ExecutionMode, HaltSource, ProposalStatus, StrategyDecisionStatus } = require('../dist/types/runtime.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an IST (Asia/Kolkata = UTC+5:30) Date for a given local time. */
function istDateTime(year, month, day, hours, minutes) {
  return new Date(Date.UTC(year, month - 1, day, hours - 5, minutes - 30, 0));
}

/** Fetch JSON from a local HTTP server. */
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

function seedInstrument(repo, exchange, symbol, token) {
  repo.upsertInstruments([{
    exchange,
    tradingsymbol: symbol,
    instrumentToken: token,
    name: symbol,
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    instrumentType: 'EQ',
    segment: 'NSE_EQ',
    exchangeToken: 0,
  }]);
}

function seedQuote(repo, exchange, symbol, token, price) {
  const now = Date.now();
  repo.upsertQuote({
    exchange,
    tradingsymbol: symbol,
    instrumentToken: token,
    lastPrice: price,
    change: 0,
    changePercent: 0,
    volume: 1000000,
    oi: null,
    high: price * 1.02,
    low: price * 0.98,
    open: price,
    close: price,
    bid: price - 0.5,
    ask: price + 0.5,
    priceTimestamp: now,
    receivedAt: now,
  });
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

let ok = 0, nok = 0;
function check(name, val) {
  if (val) { ok++; console.log('  ✅ ' + name); }
  else     { nok++; console.log('  ❌ ' + name); }
}

// ---------------------------------------------------------------------------
// Main witness flow
// ---------------------------------------------------------------------------

(async () => {
  console.log('═══ M003/S06 Paper-Trading Review Witness ═══');
  console.log('');

  // ═════════════════════════════════════════════════════════════════════
  // Setup: temp file-backed SQLite DB
  // ═════════════════════════════════════════════════════════════════════
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-s06-witness-'));
  const dbPath = path.join(tmpDir, 'witness.db');

  let app, handles, port;

  async function startApp() {
    app = new RuntimeApp({
      port: 0,
      nodeEnv: 'test',
      marketTimezone: 'Asia/Kolkata',
      schedulerIntervalMs: 60000,
      dbPath: dbPath,
      logLevel: 'error',
      zerodha: null,
      proposalEngine: {
        providerMode: 'custom',
        providerUrl: 'http://localhost:19999/v1/proposals',
        timeoutMs: 5000,
        maxProposalsPerTick: 3,
      },
      execution: {
        mode: ExecutionMode.Paper,
        operatorBindHost: '127.0.0.1',
        maxRetries: 0,
        riskLimits: {
          maxOpenPositions: 10,
          maxOrdersPerInstrument: 5,
          maxDailyLossRupees: 50000,
          maxExposureRupees: 500000,
          marketHoursStalenessMs: 120000,
        },
      },
    });

    handles = app.start();
    // Wait for the server to be listening (async with port 0)
    port = handles.server.address() ? handles.server.address().port : null;
    if (port === null) {
      // Listen is async — wait for the listening event
      port = new Promise((resolve) => {
        handles.server.on('listening', () => resolve(handles.server.address().port));
      });
    }
    // If port is a promise, await it
    if (typeof port.then === 'function') {
      port = await port;
    }
    console.log(`  RuntimeApp started on port ${port}, db=${dbPath}`);
  }

  function stopApp(label) {
    try { app.stop(label); } catch {}
    console.log(`  App stopped (${label})`);
  }

  // ═════════════════════════════════════════════════════════════════════
  // PHASE 1 — Successful paper fill
  // ═════════════════════════════════════════════════════════════════════
  console.log('── Phase 1: Successful paper fill ──');
  await startApp();
  seedInstrument(handles.brokerRepo, 'NSE', 'RELIANCE', 123456);
  seedQuote(handles.brokerRepo, 'NSE', 'RELIANCE', 123456, 2850.50);

  // Seed proposal + approved strategy decision
  const p1 = handles.proposalRepo.insertAttempt({
    exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 123456,
    side: 'buy', product: 'MIS', quantity: 75,
    price: null, triggerPrice: null, orderType: 'MARKET',
    tag: 's06-witness', proposalStatus: ProposalStatus.Accepted, createdAt: Date.now(),
  });

  handles.strategyDecisionRepo.insertDecisionWithReasons({
    proposalAttemptId: p1.id,
    decisionStatus: StrategyDecisionStatus.Approved,
    strategyId: 's06-witness', strategyVersion: '1.0.0', decidedAt: Date.now(),
    exchange: 'NSE', tradingsymbol: 'RELIANCE', side: 'buy', product: 'MIS', quantity: 75,
    price: null, triggerPrice: null, orderType: 'MARKET',
    quoteLastPrice: 2850.50, quoteBid: 2850.00, quoteAsk: 2851.00, quoteVolume: 1000000, quoteReceivedAt: Date.now(),
    riskNotional: 75 * 2850.50, riskSizingBasis: 'last_price',
    riskMaxLossRupees: 75 * 2850.50 * 0.05, riskStopDistance: null, riskExposureTag: 'intraday',
  }, []);

  // Drive ExecutionGateSupervisor with in-session weekday timestamp
  const inSession = istDateTime(2026, 5, 13, 10, 0); // Wednesday 10:00 IST
  await handles.executionGateSupervisor.doWork(inSession, handles.healthService.getHealth());

  // ── Phase 1 assertions ──────────────────────────────────────────────
  const exec1 = await fetchJson(`http://localhost:${port}/health/execution`);
  check('exec_endpoint_200 (phase 1)', exec1.status === 200);
  check('exec_mode_paper (phase 1)', exec1.body.mode === 'paper');
  check('exec_totalAttempts_1 (phase 1)', exec1.body.totalAttempts === 1);
  check('exec_totalOrders_1 (phase 1)', exec1.body.totalOrders === 1);
  check('exec_totalFills_1 (phase 1)', exec1.body.totalFills === 1);
  check('exec_openPositionCount_1 (phase 1)', exec1.body.openPositionCount === 1);
  check('exec_recentAttempt_RELIANCE (phase 1)', exec1.body.recentAttempts[0].tradingsymbol === 'RELIANCE');
  check('exec_recentAttempt_paper_simulated (phase 1)', exec1.body.recentAttempts[0].outcomeCode === 'paper_simulated');
  check('exec_recentOrders_RELIANCE (phase 1)', exec1.body.recentPaperOrders[0].tradingsymbol === 'RELIANCE');
  check('exec_recentFills_RELIANCE (phase 1)', exec1.body.recentPaperFills[0].tradingsymbol === 'RELIANCE');
  check('exec_position_RELIANCE (phase 1)', exec1.body.currentPositions[0].tradingsymbol === 'RELIANCE');
  check('exec_riskState_no_halt (phase 1)', exec1.body.riskState.haltState === 'no_halt');

  const dash1 = await fetchJson(`http://localhost:${port}/dashboard.json`);
  check('dash_json_totalAttempts_1 (phase 1)', dash1.body.execution.totalAttempts === 1);
  check('dash_json_totalOrders_1 (phase 1)', dash1.body.execution.totalOrders === 1);

  const strat1 = await fetchJson(`http://localhost:${port}/health/strategy`);
  check('strat_totalDecisions_1 (phase 1)', strat1.body.totalDecisions === 1);
  check('strat_approvedCount_1 (phase 1)', strat1.body.approvedCount === 1);

  console.log('');

  // ═════════════════════════════════════════════════════════════════════
  // PHASE 2 — Refusal via risk boundary (halt latch)
  // ═════════════════════════════════════════════════════════════════════
  console.log('── Phase 2: Refusal/halt via risk boundary ──');

  // Latch a halt
  handles.riskRepo.latchHalt(
    HaltSource.Operator,
    'Operator kill-switch activated for S06 witness test',
    Date.now(),
  );

  handles.riskRepo.insertEvent({
    eventType: 'halt',
    source: HaltSource.Operator,
    severity: 'critical',
    message: 'Operator kill-switch activated — S06 witness refusal test',
    diagnostic: null,
    recordedAt: Date.now(),
  });

  // Seed a second candidate (INFY)
  seedInstrument(handles.brokerRepo, 'NSE', 'INFY', 789012);
  seedQuote(handles.brokerRepo, 'NSE', 'INFY', 789012, 1600.00);

  const p2 = handles.proposalRepo.insertAttempt({
    exchange: 'NSE', tradingsymbol: 'INFY', instrumentToken: 789012,
    side: 'buy', product: 'MIS', quantity: 75,
    price: null, triggerPrice: null, orderType: 'MARKET',
    tag: 's06-witness-2', proposalStatus: ProposalStatus.Accepted, createdAt: Date.now(),
  });

  handles.strategyDecisionRepo.insertDecisionWithReasons({
    proposalAttemptId: p2.id,
    decisionStatus: StrategyDecisionStatus.Approved,
    strategyId: 's06-witness', strategyVersion: '1.0.0', decidedAt: Date.now(),
    exchange: 'NSE', tradingsymbol: 'INFY', side: 'buy', product: 'MIS', quantity: 75,
    price: null, triggerPrice: null, orderType: 'MARKET',
    quoteLastPrice: 1600.00, quoteBid: 1599.50, quoteAsk: 1600.50, quoteVolume: 800000, quoteReceivedAt: Date.now(),
    riskNotional: 75 * 1600.00, riskSizingBasis: 'last_price',
    riskMaxLossRupees: 75 * 1600.00 * 0.05, riskStopDistance: null, riskExposureTag: 'intraday',
  }, []);

  // Drive doWork again — halt should refuse the new candidate
  await handles.executionGateSupervisor.doWork(inSession, handles.healthService.getHealth());

  // ── Phase 2 assertions ──────────────────────────────────────────────
  const exec2 = await fetchJson(`http://localhost:${port}/health/execution`);
  check('exec_totalAttempts_still_1 (phase 2)', exec2.body.totalAttempts === 1);
  check('exec_totalOrders_still_1 (phase 2)', exec2.body.totalOrders === 1);
  check('exec_riskState_active_halt (phase 2)', exec2.body.riskState.haltState === 'active_halt');
  check('exec_riskState_halt_source_operator (phase 2)', exec2.body.riskState.haltSource === 'operator');
  check('exec_riskState_refusing (phase 2)', exec2.body.riskState.isRefusing === true);
  check('exec_riskState_latchCount_1 (phase 2)', exec2.body.riskState.latchCount === 1);
  check('exec_riskEvents_1 (phase 2)', exec2.body.recentRiskEvents.length === 1);
  check('exec_riskEvent_type_halt (phase 2)', exec2.body.recentRiskEvents[0].eventType === 'halt');

  const strat2 = await fetchJson(`http://localhost:${port}/health/strategy`);
  check('strat_totalDecisions_2 (phase 2)', strat2.body.totalDecisions === 2);
  check('strat_approvedCount_2 (phase 2)', strat2.body.approvedCount === 2);

  const dash2 = await fetchJson(`http://localhost:${port}/dashboard.json`);
  check('dash_json_riskState_active_halt (phase 2)', dash2.body.execution.riskState.haltState === 'active_halt');

  console.log('');

  // ═════════════════════════════════════════════════════════════════════
  // PHASE 3 — Restart persistence
  // ═════════════════════════════════════════════════════════════════════
  console.log('── Phase 3: Restart persistence ──');
  stopApp('Phase 2 complete');

  await startApp();

  const exec3 = await fetchJson(`http://localhost:${port}/health/execution`);
  check('exec_totalAttempts_preserved (phase 3)', exec3.body.totalAttempts === 1);
  check('exec_totalOrders_preserved (phase 3)', exec3.body.totalOrders === 1);
  check('exec_totalFills_preserved (phase 3)', exec3.body.totalFills === 1);
  check('exec_openPositionCount_preserved (phase 3)', exec3.body.openPositionCount === 1);
  check('exec_riskState_preserved (phase 3)', exec3.body.riskState.haltState === 'active_halt');
  check('exec_riskState_haltSource_preserved (phase 3)', exec3.body.riskState.haltSource === 'operator');
  check('exec_riskEvent_count_ge_1 (phase 3)', exec3.body.recentRiskEvents.length >= 1);
  const haltEvent3 = exec3.body.recentRiskEvents.find(e => e.eventType === 'halt');
  check('exec_riskEvent_halt_preserved (phase 3)', haltEvent3 !== undefined);
  check('exec_no_duplication (phase 3)', exec3.body.totalAttempts === 1);

  const strat3 = await fetchJson(`http://localhost:${port}/health/strategy`);
  check('strat_decisions_preserved (phase 3)', strat3.body.totalDecisions === 2);
  check('strat_approved_preserved (phase 3)', strat3.body.approvedCount === 2);

  const dash3 = await fetchJson(`http://localhost:${port}/dashboard.json`);
  check('dash_json_attempts_preserved (phase 3)', dash3.body.execution.totalAttempts === 1);
  check('dash_json_orders_preserved (phase 3)', dash3.body.execution.totalOrders === 1);
  check('dash_json_fills_preserved (phase 3)', dash3.body.execution.totalFills === 1);
  check('dash_json_positions_preserved (phase 3)', dash3.body.execution.openPositionCount === 1);
  check('dash_json_positions_RELIANCE (phase 3)', dash3.body.execution.currentPositions[0].tradingsymbol === 'RELIANCE');
  check('dash_json_riskState_preserved (phase 3)', dash3.body.execution.riskState.haltState === 'active_halt');

  // ═════════════════════════════════════════════════════════════════════
  // Cleanup
  // ═════════════════════════════════════════════════════════════════════
  stopApp('Witness complete');

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  console.log('');

  // ── Summary ──────────────────────────────────────────────────────
  if (nok > 0) {
    console.error(`FAIL: ${nok} witness check(s) failed (${ok} passed)`);
    process.exit(1);
  }
  console.log(`  Paper-trading review witness: all ${ok} checks passed`);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
