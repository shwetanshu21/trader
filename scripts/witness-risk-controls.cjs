#!/usr/bin/env node
// ── M003/S05 Execution Risk Controls — Node witness ──
// Standalone node script run by verify-m003-s05-risk-controls.sh
// Uses .cjs extension because the project has "type": "module" in package.json
// but this script uses CommonJS require() for compiled dist outputs.

const http = require('http');
const path = require('path');
const fs = require('fs');

const { DatabaseManager } = require('../dist/persistence/sqlite.js');
const { ExecutionRiskRepository } = require('../dist/persistence/execution-risk-repo.js');
const { PaperOrderRepository } = require('../dist/persistence/paper-order-repo.js');
const { PaperFillRepository } = require('../dist/persistence/paper-fill-repo.js');
const { PaperPositionRepository } = require('../dist/persistence/paper-position-repo.js');
const { BrokerRepository } = require('../dist/persistence/broker-repo.js');
const { ExecutionRiskGuard } = require('../dist/execution/execution-risk-guard.js');
const { MarketClock } = require('../dist/runtime/market-clock.js');
const { INDIA_NSE_EQ_MARKET } = require('../dist/market/india-profile.js');
const { RuntimeApp } = require('../dist/runtime/runtime-app.js');
const { ExecutionMode, HaltSource, HaltState } = require('../dist/types/runtime.js');

const RESTART_DB_PATH = path.join(__dirname, '..', '.witness-restart-test.db');

let ok = 0, nok = 0;
function check(name, val) {
  if (val) { ok++; console.log('  ✅ Risk witness: ' + name); }
  else     { nok++; console.log('  ❌ Risk witness: ' + name); }
}

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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

(async () => {
  // ═══════════════════════════════════════════════════════════
  // Phase A: Start RuntimeApp with Paper execution mode + risk
  // ═══════════════════════════════════════════════════════════

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
    execution: {
      mode: ExecutionMode.Paper,
      operatorBindHost: '127.0.0.1',
      riskLimits: {
        maxOpenPositions: 10,
        maxOrdersPerInstrument: 1,
        maxDailyLossRupees: 5000,
        maxExposureRupees: 100000,
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

  check('risk_repo_wired', handles.riskRepo !== null);
  check('riskGuard_wired', handles.executionGateSupervisor !== null);

  // ═══════════════════════════════════════════════════════════
  // Phase B: Create risk guard directly for detailed checks
  // ═══════════════════════════════════════════════════════════

  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const brokerRepo = new BrokerRepository(handles.dbManager.db);
  const orderRepo = new PaperOrderRepository(handles.dbManager.db);
  const positionRepo = new PaperPositionRepository(handles.dbManager.db);
  const riskRepo = new ExecutionRiskRepository(handles.dbManager.db);

  const riskGuard = new ExecutionRiskGuard({
    riskRepo,
    marketClock: clock,
    riskLimits: {
      maxOpenPositions: 10,
      maxOrdersPerInstrument: 1,
      maxDailyLossRupees: 5000,
      maxExposureRupees: 100000,
      marketHoursStalenessMs: 120000,
    },
    positionRepo,
    orderRepo,
    brokerRepo,
  });

  // Check risk state is clean at start (no_halt)
  const initialRiskState = riskRepo.getCurrentState();
  check('initial_halt_state_no_halt', initialRiskState.haltState === HaltState.NoHalt);
  check('initial_latch_count_zero', initialRiskState.latchCount === 0);

  // ═══════════════════════════════════════════════════════════
  // Phase C: Market-hours refusal and basic guard behavior
  // ═══════════════════════════════════════════════════════════

  // Since we're outside regular market hours (market clock says 'closed'),
  // the guard should refuse execution via market_hours check
  const outOfHoursCheck = riskGuard.evaluate({
    id: 1,
    proposalAttemptId: 1,
    strategyId: 'witness',
    strategyVersion: '1.0.0',
    decidedAt: Date.now(),
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    side: 'buy',
    product: 'MIS',
    quantity: 75,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: 'witness-ooh-check',
    quoteLastPrice: 2850.50,
    quoteBid: 2850.00,
    quoteAsk: 2851.00,
    quoteVolume: 1250000,
    quoteReceivedAt: Date.now(),
    riskNotional: 213787.50,
    riskSizingBasis: 'last_price',
    riskMaxLossRupees: 10689.38,
    riskStopDistance: null,
    riskExposureTag: 'intraday',
  });

  check('out_of_hours_refused', outOfHoursCheck.verdict === 'refuse');
  check('out_of_hours_market_closed_code',
    outOfHoursCheck.refusalReasons.some(r => r.reasonCode === 'market_closed'));

  // ═══════════════════════════════════════════════════════════
  // Phase D: Daily-loss kill-switch latch
  // ═══════════════════════════════════════════════════════════

  riskRepo.latchHalt(HaltSource.DailyLoss, 'Daily loss limit exceeded: P&L -6000 (limit: 5000)', Date.now(), 2, -6000);

  const latchedState = riskRepo.getCurrentState();
  check('halt_state_active', latchedState.haltState === HaltState.ActiveHalt);
  check('halt_source_daily_loss', latchedState.haltSource === 'daily_loss');
  check('halt_latch_count', latchedState.latchCount === 1);
  check('halt_open_positions', latchedState.openPositionCountAtHalt === 2);
  check('halt_daily_pnl', latchedState.dailyPnlAtHalt === -6000);

  // Evaluate after latch — should refuse ALL orders
  const postLatchCheck = riskGuard.evaluate({
    id: 2,
    proposalAttemptId: 2,
    strategyId: 'witness',
    strategyVersion: '1.0.0',
    decidedAt: Date.now(),
    exchange: 'NSE',
    tradingsymbol: 'TCS',
    side: 'buy',
    product: 'MIS',
    quantity: 50,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: 'witness-post-latch',
    quoteLastPrice: 3500.00,
    quoteBid: 3499.00,
    quoteAsk: 3501.00,
    quoteVolume: 800000,
    quoteReceivedAt: Date.now(),
    riskNotional: 175000.00,
    riskSizingBasis: 'last_price',
    riskMaxLossRupees: 8750.00,
    riskStopDistance: null,
    riskExposureTag: 'intraday',
  });
  check('post_latch_refused', postLatchCheck.verdict === 'refuse');
  check('post_latch_refusal_exists', postLatchCheck.refusalReasons.length > 0);

  // ═══════════════════════════════════════════════════════════
  // Phase E: Restart persistence test
  // ═══════════════════════════════════════════════════════════

  try { fs.unlinkSync(RESTART_DB_PATH); } catch {}

  const persistDb = new DatabaseManager(RESTART_DB_PATH);
  const persistRepo = new ExecutionRiskRepository(persistDb.db);

  const persistLatchState = persistRepo.getCurrentState();
  check('persist_empty_no_halt', persistLatchState.haltState === HaltState.NoHalt);

  persistRepo.latchHalt(HaltSource.Operator, 'Operator kill switch activated', Date.now(), 0, 0);

  const afterLatch = persistRepo.getCurrentState();
  check('persist_latched_halt_state', afterLatch.haltState === HaltState.ActiveHalt);
  check('persist_latched_source', afterLatch.haltSource === 'operator');
  check('persist_latch_count', afterLatch.latchCount === 1);

  persistRepo.insertEvent({
    eventType: 'halt',
    source: 'operator',
    severity: 'critical',
    message: 'Operator kill switch activated manually',
    diagnostic: null,
    recordedAt: Date.now(),
  });

  const eventsBeforeClose = persistRepo.getRecentEvents(10);
  check('persist_event_count_before', eventsBeforeClose.length === 1);
  check('persist_event_type', eventsBeforeClose[0].eventType === 'halt');

  persistDb.close();

  // Reopen — simulate restart
  const restartDb = new DatabaseManager(RESTART_DB_PATH);
  const restartRepo = new ExecutionRiskRepository(restartDb.db);

  const restartState = restartRepo.getCurrentState();
  check('restart_persists_halt_state', restartState.haltState === HaltState.ActiveHalt);
  check('restart_persists_halt_source', restartState.haltSource === 'operator');

  const restartEvents = restartRepo.getRecentEvents(10);
  check('restart_persists_event_count', restartEvents.length === 1);
  check('restart_persists_event_type', restartEvents[0].eventType === 'halt');

  restartDb.close();
  try { fs.unlinkSync(RESTART_DB_PATH); } catch {}

  // ═══════════════════════════════════════════════════════════
  // Phase F: Dashboard risk-state visibility via HTTP
  // ═══════════════════════════════════════════════════════════

  handles.riskRepo.latchHalt(HaltSource.DailyLoss, 'Witness daily loss test', Date.now(), 1, -5500);

  const execResp = await fetchJson('http://localhost:' + port + '/health/execution');
  check('exec_endpoint_200', execResp.status === 200);
  check('exec_has_riskState', execResp.body && typeof execResp.body.riskState === 'object');
  check('exec_riskState_active_halt', execResp.body.riskState.haltState === 'active_halt');
  check('exec_riskState_halt_source', execResp.body.riskState.haltSource === 'daily_loss');
  check('exec_riskState_refusing', execResp.body.riskState.isRefusing === true);

  const dashResp = await fetchText('http://localhost:' + port + '/dashboard');
  check('dash_html_200', dashResp.status === 200);
  check('dash_html_risk_section', dashResp.body.indexOf('Risk State') !== -1);
  check('dash_html_halt_state', dashResp.body.indexOf('active_halt') !== -1);
  check('dash_html_halt_source', dashResp.body.indexOf('daily_loss') !== -1);

  const dashJsonResp = await fetchJson('http://localhost:' + port + '/dashboard.json');
  check('dash_json_200', dashJsonResp.status === 200);
  check('dash_json_has_riskState', dashJsonResp.body && dashJsonResp.body.execution && dashJsonResp.body.execution.riskState);
  check('dash_json_riskState_active', dashJsonResp.body.execution.riskState.haltState === 'active_halt');
  check('dash_json_riskState_source', dashJsonResp.body.execution.riskState.haltSource === 'daily_loss');

  // ═══════════════════════════════════════════════════════════
  // Phase G: HTTP hardening verification
  // ═══════════════════════════════════════════════════════════

  const healthResp = await fetchText('http://localhost:' + port + '/health');
  check('cors_not_wildcard', healthResp.headers['access-control-allow-origin'] !== '*');
  check('cors_is_localhost', healthResp.headers['access-control-allow-origin'] === 'http://127.0.0.1');

  const unknownResp = await fetchText('http://localhost:' + port + '/nonexistent-path-xyz');
  check('unknown_path_404', unknownResp.status === 404);

  // ── Cleanup ──────────────────────────────────────────────────────────
  app.stop('Risk controls witness complete');

  if (nok > 0) {
    console.error('\nFAIL: Some risk controls witness checks failed');
    process.exit(1);
  }
  console.log('\n  Risk controls witness: all ' + ok + ' checks passed');
})().catch(err => {
  console.error('FATAL:', err);
  try { fs.unlinkSync(RESTART_DB_PATH); } catch {}
  process.exit(1);
});
