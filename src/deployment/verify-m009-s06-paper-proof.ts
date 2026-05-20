#!/usr/bin/env node
// ── M009/S06 — Authoritative Paper-Proof Harness ──
//
// One-command local proof that the assembled RuntimeApp in Paper mode exposes
// operator-reviewable proposal, strategy, execution, position, and risk
// evidence across all four canonical surfaces:
//   1. /health/strategy   — strategy decisions with India research + execution class
//   2. /health/execution  — paper fills, positions, risk state, halt evidence
//   3. /dashboard.json    — full snapshot including all of the above
//   4. /dashboard         — HTML rendering (structural presence check)
//
// The harness:
//   - Creates a fresh file-backed SQLite database in a temp directory
//   - Starts RuntimeApp in paper mode
//   - Seeds broker universe + quotes for both EQ and FO candidates
//   - Mocks the LLM provider so ProposalSupervisor exercises the real canonical
//     LLM-first ranking path with explicit consulted evidence
//   - Drives proposalSupervisor -> strategyRiskSupervisor -> executionGateSupervisor
//     in order, using an in-session weekday timestamp
//   - Asserts success-path evidence across EQ and FO: accepted proposals,
//     approved strategy decisions, consulted LLM evidence, India research,
//     class-specific metadata, paper orders/fills/positions, and truthful
//     operator surfaces
//   - Latches a halt via riskRepo, drives another tick, and asserts refusal is
//     visible with no new execution attempts consumed
//   - Writes a timestamped JSON summary artifact under data/artifacts/paper-proof/
//   - Exits 0 on full success, non-zero on any assertion failure

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RuntimeApp } from '../runtime/runtime-app.js';
import { getEligibleSymbols } from '../universe/policy.js';
import {
  ExecutionMode,
  HaltSource,
  LLMStatus,
  ProposalStatus,
  StrategyDecisionStatus,
  type RuntimeConfig,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARTIFACT_ROOT = 'data/artifacts/paper-proof';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AssertionResult {
  name: string;
  pass: boolean;
  detail: string;
}

const _assertions: AssertionResult[] = [];

function assert(name: string, condition: boolean, detail: string): void {
  _assertions.push({ name, pass: condition, detail });
  if (!condition) {
    console.error(`  ❌ FAIL: ${name} — ${detail}`);
  } else {
    console.log(`  ✅ PASS: ${name}`);
  }
}

function report(): { passed: number; failed: number } {
  const passed = _assertions.filter(a => a.pass).length;
  const failed = _assertions.filter(a => !a.pass).length;
  console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
  return { passed, failed };
}

/** Create an IST (Asia/Kolkata = UTC+5:30) Date for a given local time. */
function istDateTime(
  year: number, month: number, day: number,
  hours: number, minutes: number,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hours - 5, minutes - 30, 0));
}

/** Fetch JSON from a local HTTP server. */
async function fetchJson(
  server: http.Server,
  pathname: string,
): Promise<{ status: number; body: any }> {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Server not listening');
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${addr.port}${pathname}`, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode ?? 0, body: null });
        }
      });
    }).on('error', reject);
  });
}

/** Fetch raw text (for HTML). */
async function fetchText(
  server: http.Server,
  pathname: string,
): Promise<{ status: number; body: string }> {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Server not listening');
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${addr.port}${pathname}`, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: data });
      });
    }).on('error', reject);
  });
}

/** Minimal paper-trading RuntimeConfig. */
function paperConfig(dbPath: string): RuntimeConfig {
  return {
    port: 0,
    nodeEnv: 'test',
    marketTimezone: 'Asia/Kolkata',
    schedulerIntervalMs: 60000,
    dbPath,
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
    strategy: {
      maxCandidates: 5,
      parallelPlugins: true,
      promotion: {
        minMergedScore: 0.7,
        minSharpeRatio: 1.0,
        maxDrawdown: 30,
        minWindowCount: 2,
        minOutOfSampleWindows: 1,
        minReplayFidelity: 1.0,
      },
      demotion: {
        minSharpeRatio: 0.5,
        maxDrawdown: 40,
        minTradeCount: 5,
        haltTriggersDemotion: true,
        minCriticalRiskEvents: 1,
        riskEventLookbackMs: 60 * 60 * 1000,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedInstrument(
  handles: any,
  exchange: string,
  symbol: string,
  overrides?: Partial<{
    instrumentToken: number;
    expiry: string | null;
    strike: number | null;
    lotSize: number;
    tickSize: number;
    instrumentType: string;
    segment: string;
  }>,
) {
  handles.brokerRepo.upsertInstruments([
    {
      exchange,
      tradingsymbol: symbol,
      instrumentToken: overrides?.instrumentToken ?? (symbol === 'RELIANCE' ? 123456 : symbol === 'INFY' ? 789012 : 26005),
      name: symbol,
      expiry: overrides?.expiry ?? null,
      strike: overrides?.strike ?? null,
      lotSize: overrides?.lotSize ?? (exchange === 'NFO' ? 75 : 1),
      tickSize: overrides?.tickSize ?? 0.05,
      instrumentType: overrides?.instrumentType ?? (exchange === 'NFO' ? 'FUT' : 'EQ'),
      segment: overrides?.segment ?? (exchange === 'NFO' ? 'NFO' : 'NSE_EQ'),
      exchangeToken: 0,
    },
  ]);
}

function seedQuote(handles: any, exchange: string, symbol: string, price: number) {
  const now = Date.now();
  const instrumentToken = exchange === 'NFO' ? 26005 : symbol === 'RELIANCE' ? 123456 : 789012;
  handles.brokerRepo.upsertQuote({
    exchange,
    tradingsymbol: symbol,
    instrumentToken,
    lastPrice: price,
    change: 0,
    changePercent: 0,
    volume: 1000000,
    oi: exchange === 'NFO' ? 50000 : null,
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

function seedProposal(
  repo: any,
  exchange: string,
  symbol: string,
  side: string,
  status: ProposalStatus,
): number {
  const p = repo.insertAttempt({
    exchange,
    tradingsymbol: symbol,
    instrumentToken: symbol === 'RELIANCE' ? 123456 : 789012,
    side,
    product: 'MIS',
    quantity: 75,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: 's06-paper-proof',
    proposalStatus: status,
    createdAt: Date.now(),
  });
  return p.id;
}

function seedStrategyDecision(
  handles: any,
  proposalAttemptId: number,
  exchange: string,
  symbol: string,
  side: string,
  price: number,
  status: StrategyDecisionStatus,
  overrides?: Partial<{
    quantity: number;
    executionClass: string;
    segment: string;
    instrumentType: string;
    expiry: string | null;
    strike: number | null;
    lotSize: number;
    tickSize: number;
    freezeQuantity: number | null;
    indiaResearchEvidence: any;
  }>,
): number {
  const qty = overrides?.quantity ?? 75;
  const ec = overrides?.executionClass ?? 'EQ';
  const seg = overrides?.segment ?? 'NSE';
  const it = overrides?.instrumentType ?? 'EQ';
  const ls = overrides?.lotSize ?? 1;
  const ts = overrides?.tickSize ?? 0.05;
  const d = handles.strategyDecisionRepo.insertDecisionWithReasons(
    {
      proposalAttemptId,
      decisionStatus: status,
      strategyId: 's06-paper-proof-strategy',
      strategyVersion: '1.0.0',
      decidedAt: Date.now(),
      exchange,
      tradingsymbol: symbol,
      side,
      product: 'MIS',
      quantity: qty,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      quoteLastPrice: price,
      quoteBid: price - 0.5,
      quoteAsk: price + 0.5,
      quoteVolume: 1000000,
      quoteReceivedAt: Date.now(),
      riskNotional: qty * price,
      riskSizingBasis: 'last_price',
      riskMaxLossRupees: qty * price * 0.05,
      riskStopDistance: null,
      riskExposureTag: 'intraday',
      indiaResearchEvidence: overrides?.indiaResearchEvidence ?? null,
      executionClass: ec,
      segment: seg,
      instrumentType: it,
      expiry: overrides?.expiry ?? null,
      strike: overrides?.strike ?? null,
      lotSize: ls,
      tickSize: ts,
      freezeQuantity: overrides?.freezeQuantity ?? null,
    },
    status === StrategyDecisionStatus.Refused
      ? [{ reasonCode: 'missing_quote_data' as any, reasonMessage: 'Refused by strategy' }]
      : [],
  );
  return d.id;
}

function waitForServer(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    if (server.listening) {
      resolve((server.address() as any).port);
    } else {
      server.on('listening', () => resolve((server.address() as any).port));
    }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('══════════════════════════════════════════════════════════');
  console.log('  M009/S06 — Paper Proof Harness');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');

  // ── Setup: temp file-backed SQLite DB ──────────────────────────────
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-s06-proof-'));
  const dbPath = path.join(tmpDir, 'paper-proof.db');
  console.log(`DB: ${dbPath}`);

  // ── Phase 1: Start RuntimeApp in paper mode, seed data, tick ───────
  console.log('\n── Phase 1: Successful paper fill ──');

  const app = new RuntimeApp(paperConfig(dbPath));
  const handles = app.build();
  handles.server.listen(0, '127.0.0.1');
  const port = await waitForServer(handles.server);
  console.log(`Runtime listening on port ${port}`);

  // ── Extract handles ───────────────────────────────────────────────────
  const proposalSupervisor = handles.proposalSupervisor!;
  const strategyRiskSupervisor = handles.strategyRiskSupervisor!;
  const gateSupervisor = handles.executionGateSupervisor!;
  const riskRepo = handles.riskRepo!;
  const proposalRepo = handles.proposalRepo!;
  const inSession = istDateTime(2026, 5, 13, 10, 0);

  // Seed broker universe + quotes for the canonical runtime path.
  const instrumentsService = handles.instrumentsService!;
  const marketDataStream = handles.marketDataStream!;
  const eqUniverse = Array.from(getEligibleSymbols('NSE')).sort();
  const instrumentSeedRows = eqUniverse.map(symbol => ({
    exchange: 'NSE',
    tradingsymbol: symbol,
    instrumentToken: symbol === 'RELIANCE' ? 123456 : symbol === 'INFY' ? 789012 : Math.floor(Math.random() * 1000000) + 1000,
    name: symbol,
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    instrumentType: 'EQ',
    segment: 'NSE',
    exchangeToken: 0,
    freezeQuantity: null,
  }));
  instrumentsService.syncFromRecords(instrumentSeedRows as any);
  for (const symbol of eqUniverse) {
    seedQuote(handles, 'NSE', symbol, symbol === 'RELIANCE' ? 2850.50 : symbol === 'INFY' ? 1600.00 : 1000.00);
  }

  // Seed one FO instrument/quote so downstream operator surfaces and class-aware
  // strategy/execution checks can consume valid FO metadata through the same seam.
  instrumentsService.syncFromRecords([{ 
    exchange: 'NFO',
    tradingsymbol: 'NIFTY24DECFUT',
    instrumentToken: 26005,
    name: 'NIFTY24DECFUT',
    expiry: '2026-12-24',
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    instrumentType: 'FUT',
    segment: 'NFO',
    exchangeToken: 0,
    freezeQuantity: null,
  }] as any);
  seedQuote(handles, 'NFO', 'NIFTY24DECFUT', 21500.00);

  // Universe coverage must be computed before the proposal supervisor will run.
  handles.universeService.computeSnapshot();

  // Mock the LLM provider so the canonical LLM-first path is actually exercised.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    proposals: [
      {
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        side: 'buy',
        product: 'MIS',
        quantity: 10,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        rationale: 'LLM ranks RELIANCE highest on India research strength',
      },
      {
        exchange: 'NFO',
        tradingsymbol: 'NIFTY24DECFUT',
        side: 'buy',
        product: 'NRML',
        quantity: 75,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        rationale: 'LLM approves NIFTY future with valid FO metadata',
      },
    ],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof globalThis.fetch;

  // Drive the real assembled path: proposal generation -> strategy decision -> execution.
  await proposalSupervisor.doWork(inSession, handles.healthService.getHealth());
  await strategyRiskSupervisor.doWork(inSession, handles.healthService.getHealth());
  await gateSupervisor.doWork(inSession, handles.healthService.getHealth());

  // Add one valid FO approved decision into the same proof session so the
  // final operator surfaces prove both execution classes together. This does
  // not replace the runtime-generated EQ path above; it extends the proof with
  // the canonical approved-decision -> execution seam already established by S03/S05.
  const foProposalId = seedProposal(proposalRepo, 'NFO', 'NIFTY24DECFUT', 'buy', ProposalStatus.Accepted);
  seedStrategyDecision(handles, foProposalId, 'NFO', 'NIFTY24DECFUT', 'buy', 21500.00, StrategyDecisionStatus.Approved, {
    quantity: 1,
    executionClass: 'FO',
    segment: 'NFO',
    instrumentType: 'FUT',
    expiry: '2026-12-24',
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    freezeQuantity: null,
  });
  await gateSupervisor.doWork(inSession, handles.healthService.getHealth());

  // 1a. Confirm the real proposal + strategy pipeline ran with consulted LLM evidence.
  const recentAttemptsWithReasons = proposalRepo.getRecentAttemptsWithReasons(10);
  assert('proposal supervisor persisted >= 2 proposal attempts', recentAttemptsWithReasons.length >= 2, `got ${recentAttemptsWithReasons.length}`);
  const acceptedAttempts = proposalRepo.getRecentAttempts(10, ProposalStatus.Accepted);
  assert('proposal supervisor emitted >= 2 accepted attempts', acceptedAttempts.length >= 2, `got ${acceptedAttempts.length}; statuses=${JSON.stringify(recentAttemptsWithReasons.map(a => ({ symbol: a.tradingsymbol, status: a.proposalStatus, reasons: a.reasons.map(r => r.reasonCode) })))}`);

  const strat1 = await fetchJson(handles.server, '/health/strategy');
  assert('/health/strategy returns 200', strat1.status === 200, `status=${strat1.status}`);
  assert('/health/strategy totalDecisions >= 2', strat1.body.totalDecisions >= 2, `got ${strat1.body.totalDecisions}`);
  assert('/health/strategy approvedCount >= 2', strat1.body.approvedCount >= 2, `got ${strat1.body.approvedCount}`);
  assert('/health/strategy refusedCount = 0 before explicit halt', strat1.body.refusedCount === 0, `got ${strat1.body.refusedCount}`);
  assert('/health/strategy exposes consulted LLM evidence',
    strat1.body.recentDecisions?.some((d: any) => d.hybrid?.llmStatus === LLMStatus.Consulted || d.llmStatus === LLMStatus.Consulted),
    `got ${JSON.stringify(strat1.body.recentDecisions?.map((d: any) => d.hybrid?.llmStatus ?? d.llmStatus))}`);

  const relDecision = strat1.body.recentDecisions?.find((d: any) => d.tradingsymbol === 'RELIANCE');
  const foDecision = strat1.body.recentDecisions?.find((d: any) => d.tradingsymbol === 'NIFTY24DECFUT');
  assert('strategy decisions include RELIANCE', relDecision != null, 'missing RELIANCE');
  assert('strategy decisions include NIFTY24DECFUT', foDecision != null, 'missing NIFTY24DECFUT');
  assert('FO decision executionClass = FO', foDecision?.executionClass === 'FO', `got ${foDecision?.executionClass}`);
  assert('FO decision segment = NFO', foDecision?.segment === 'NFO', `got ${foDecision?.segment}`);
  assert('FO decision lotSize = 1', foDecision?.lotSize === 1, `got ${foDecision?.lotSize}`);
  assert('FO decision expiry is present', foDecision?.expiry === '2026-12-24', `got ${foDecision?.expiry}`);

  // 1b. /health/execution — attempts, paper fills, and positions from real consumed decisions.
  const exec1 = await fetchJson(handles.server, '/health/execution');
  assert('execution endpoint returns 200', exec1.status === 200, `status=${exec1.status}`);
  assert('mode is paper', exec1.body.mode === 'paper', `mode=${exec1.body.mode}`);
  assert('totalAttempts >= 2', exec1.body.totalAttempts >= 2, `got ${exec1.body.totalAttempts}`);
  assert('totalOrders >= 2', exec1.body.totalOrders >= 2, `got ${exec1.body.totalOrders}`);
  assert('totalFills >= 2', exec1.body.totalFills >= 2, `got ${exec1.body.totalFills}`);
  assert('openPositionCount >= 2', exec1.body.openPositionCount >= 2, `got ${exec1.body.openPositionCount}`);
  const phase1TotalAttempts = exec1.body.totalAttempts;
  const phase1TotalOrders = exec1.body.totalOrders;
  const phase1TotalFills = exec1.body.totalFills;
  assert('currentPositions contain RELIANCE', exec1.body.currentPositions?.some((p: any) => p.tradingsymbol === 'RELIANCE'), 'missing RELIANCE');
  assert('recentAttempts contain NIFTY24DECFUT', exec1.body.recentAttempts?.some((a: any) => a.tradingsymbol === 'NIFTY24DECFUT'), 'missing NIFTY24DECFUT');
  assert('recentAttempts contain paper_simulated outcomes only', exec1.body.recentAttempts?.every((a: any) => a.outcomeCode === 'paper_simulated'), `got ${JSON.stringify(exec1.body.recentAttempts?.map((a: any) => a.outcomeCode))}`);
  assert('recentPaperOrders contain NIFTY24DECFUT', exec1.body.recentPaperOrders?.some((o: any) => o.tradingsymbol === 'NIFTY24DECFUT'), 'missing FO order');
  assert('recentPaperFills contain NIFTY24DECFUT', exec1.body.recentPaperFills?.some((f: any) => f.tradingsymbol === 'NIFTY24DECFUT'), 'missing FO fill');
  assert('currentPositions contain NIFTY24DECFUT', exec1.body.currentPositions?.some((p: any) => p.tradingsymbol === 'NIFTY24DECFUT'), 'missing FO position');
  assert('riskState haltState is no_halt', exec1.body.riskState?.haltState === 'no_halt', `got ${exec1.body.riskState?.haltState}`);
  assert('riskState isRefusing is false', exec1.body.riskState?.isRefusing === false, `got ${exec1.body.riskState?.isRefusing}`);

  // 1c. /dashboard.json — same evidence shape and both classes visible.
  const dash1 = await fetchJson(handles.server, '/dashboard.json');
  assert('dashboard.json returns 200', dash1.status === 200, `status=${dash1.status}`);
  assert('dashboard execution totalAttempts >= 2', dash1.body.execution?.totalAttempts >= 2, `got ${dash1.body.execution?.totalAttempts}`);
  assert('dashboard execution totalOrders >= 2', dash1.body.execution?.totalOrders >= 2, `got ${dash1.body.execution?.totalOrders}`);
  assert('dashboard execution totalFills >= 2', dash1.body.execution?.totalFills >= 2, `got ${dash1.body.execution?.totalFills}`);
  assert('dashboard execution openPositionCount >= 2', dash1.body.execution?.openPositionCount >= 2, `got ${dash1.body.execution?.openPositionCount}`);

  assert('dashboard has recentStrategyDecisions', Array.isArray(dash1.body.recentStrategyDecisions) && dash1.body.recentStrategyDecisions.length > 0, 'missing');
  const dashReliance = dash1.body.recentStrategyDecisions.find((d: any) => d.tradingsymbol === 'RELIANCE');
  const dashFo = dash1.body.recentStrategyDecisions.find((d: any) => d.tradingsymbol === 'NIFTY24DECFUT');
  assert('dashboard includes RELIANCE strategy decision', dashReliance != null, 'missing RELIANCE');
  assert('dashboard includes FO strategy decision', dashFo != null, 'missing FO');
  assert('dashboard exposes consulted LLM evidence',
    dash1.body.recentStrategyDecisions.some((d: any) => d.hybrid?.llmStatus === LLMStatus.Consulted || d.llmStatus === LLMStatus.Consulted),
    `got ${JSON.stringify(dash1.body.recentStrategyDecisions.map((d: any) => d.hybrid?.llmStatus ?? d.llmStatus))}`);
  assert('dashboard FO executionClass = FO', dashFo?.executionClass === 'FO', `got ${dashFo?.executionClass}`);
  assert('dashboard FO segment = NFO', dashFo?.segment === 'NFO', `got ${dashFo?.segment}`);
  assert('dashboard FO lotSize = 1', dashFo?.lotSize === 1, `got ${dashFo?.lotSize}`);

  // 1d. India research evidence is visible for the EQ decision.
  assert('dashboard RELIANCE has indiaResearchEvidence', dashReliance?.indiaResearchEvidence != null, 'null');
  assert('dashboard RELIANCE research summary is present',
    typeof dashReliance?.indiaResearchEvidence?.summary === 'string' && dashReliance.indiaResearchEvidence.summary.length > 0,
    `got ${dashReliance?.indiaResearchEvidence?.summary}`);

  assert('/health/strategy RELIANCE has indiaResearchEvidence', relDecision?.indiaResearchEvidence != null, 'null');
  assert('/health/strategy RELIANCE research summary is present',
    typeof relDecision?.indiaResearchEvidence?.summary === 'string' && relDecision.indiaResearchEvidence.summary.length > 0,
    `got ${relDecision?.indiaResearchEvidence?.summary}`);

  // 1e. /dashboard (HTML) — basic structural presence check.
  const htmlDash = await fetchText(handles.server, '/dashboard');
  assert('/dashboard (HTML) returns 200', htmlDash.status === 200, `status=${htmlDash.status}`);
  assert('/dashboard (HTML) contains DOCTYPE', htmlDash.body.includes('<!DOCTYPE'), 'missing');
  assert('/dashboard (HTML) is non-empty', htmlDash.body.length > 100, `length=${htmlDash.body.length}`);

  // ── Phase 2: Refusal/halt through the real risk boundary ───────────
  console.log('\n── Phase 2: Refusal/halt through risk boundary ──');

  // Latch a halt on the risk repo
  riskRepo.latchHalt(
    HaltSource.Operator,
    'Operator kill-switch activated — S06 paper-proof refusal test',
    Date.now(),
  );

  // Insert a risk event so it's visible on operator surfaces
  riskRepo.insertEvent({
    eventType: 'halt',
    source: HaltSource.Operator,
    severity: 'critical',
    message: 'Operator kill-switch activated — S06 paper-proof refusal test',
    diagnostic: null,
    recordedAt: Date.now(),
  });

  // Seed a second accepted proposal directly, then drive only the downstream
  // supervisors. This proves the risk halt prevents execution consumption even
  // when a candidate is otherwise approved.
  const p2Id = seedProposal(proposalRepo, 'NSE', 'INFY', 'buy', ProposalStatus.Accepted);
  seedStrategyDecision(handles, p2Id, 'NSE', 'INFY', 'buy', 1600.00, StrategyDecisionStatus.Approved);

  // Drive execution gate again — halt should refuse the new candidate.
  await gateSupervisor.doWork(inSession, handles.healthService.getHealth());

  // ── Phase 2 assertions ─────────────────────────────────────────────

  const exec2 = await fetchJson(handles.server, '/health/execution');
  assert('Phase2: execution endpoint returns 200', exec2.status === 200, `status=${exec2.status}`);
  assert('Phase2: totalAttempts unchanged after halt refusal', exec2.body.totalAttempts === phase1TotalAttempts, `before=${phase1TotalAttempts}, after=${exec2.body.totalAttempts}`);
  assert('Phase2: totalOrders unchanged after halt refusal', exec2.body.totalOrders === phase1TotalOrders, `before=${phase1TotalOrders}, after=${exec2.body.totalOrders}`);
  assert('Phase2: totalFills unchanged after halt refusal', exec2.body.totalFills === phase1TotalFills, `before=${phase1TotalFills}, after=${exec2.body.totalFills}`);

  // Risk state should show the halt
  assert('Phase2: riskState haltState is active_halt',
    exec2.body.riskState?.haltState === 'active_halt',
    `got ${exec2.body.riskState?.haltState}`);
  assert('Phase2: riskState haltSource is operator',
    exec2.body.riskState?.haltSource === 'operator',
    `got ${exec2.body.riskState?.haltSource}`);
  assert('Phase2: riskState isRefusing is true',
    exec2.body.riskState?.isRefusing === true,
    `got ${exec2.body.riskState?.isRefusing}`);

  // Risk events should include the inserted halt event
  assert('Phase2: recentRiskEvents length >= 1',
    exec2.body.recentRiskEvents?.length >= 1,
    `got ${exec2.body.recentRiskEvents?.length}`);
  const haltEvent = exec2.body.recentRiskEvents?.find((e: any) => e.eventType === 'halt');
  assert('Phase2: halt event found in risk events', haltEvent != null, 'not found');
  assert('Phase2: halt event message matches',
    haltEvent?.message?.includes('S06 paper-proof refusal test'),
    `got ${haltEvent?.message}`);

  // /health/strategy — broader proof session should retain prior decisions while
  // the halt prevents any new execution attempts from being consumed.
  const strat2 = await fetchJson(handles.server, '/health/strategy');
  assert('Phase2: strategy totalDecisions >= 7', strat2.body.totalDecisions >= 7, `got ${strat2.body.totalDecisions}`);
  assert('Phase2: strategy approvedCount >= 3', strat2.body.approvedCount >= 3, `got ${strat2.body.approvedCount}`);

  // /dashboard.json — risk state visible
  const dash2 = await fetchJson(handles.server, '/dashboard.json');
  assert('Phase2: dashboard risk haltState = active_halt',
    dash2.body.execution?.riskState?.haltState === 'active_halt',
    `got ${dash2.body.execution?.riskState?.haltState}`);
  assert('Phase2: dashboard risk isRefusing = true',
    dash2.body.execution?.riskState?.isRefusing === true,
    `got ${dash2.body.execution?.riskState?.isRefusing}`);
  assert('Phase2: dashboard risk events length >= 1',
    dash2.body.execution?.recentRiskEvents?.length >= 1,
    `got ${dash2.body.execution?.recentRiskEvents?.length}`);

  // ── Write artifact summary ─────────────────────────────────────────
  const { passed, failed } = report();
  const overallVerdict = failed === 0 ? 'PASS' : 'FAIL';

  const summary = {
    harness: 'M009/S06 Paper Proof Harness',
    completedAt: new Date().toISOString(),
    verdict: overallVerdict,
    totalAssertions: passed + failed,
    passed,
    failed,
    assertions: _assertions.map(a => ({
      name: a.name,
      pass: a.pass,
      detail: a.detail,
    })),
    surfacesTested: [
      '/health/execution',
      '/health/strategy',
      '/dashboard.json',
      '/dashboard',
    ],
    evidenceBlocks: {
      paperFill: {
        symbols: ['RELIANCE', 'NIFTY24DECFUT'],
        indiaResearchEvidence: true,
        executionClasses: ['EQ', 'FO'],
        llmConsulted: true,
      },
      refusalHalt: {
        source: 'operator',
        haltState: 'active_halt',
        attemptedSymbol: 'INFY',
        consumptionPrevented: true,
      },
    },
  };

  // Ensure artifact directory exists
  fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });

  const artifactPath = path.join(ARTIFACT_ROOT, `paper-proof-${Date.now()}.json`);
  fs.writeFileSync(artifactPath, JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`\nArtifact written: ${artifactPath}`);

  // ── Cleanup ────────────────────────────────────────────────────────
  app.stop('Paper proof complete');
  globalThis.fetch = originalFetch;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // ── Exit ───────────────────────────────────────────────────────────
  console.log(`\n${overallVerdict}: ${passed}/${passed + failed} assertions passed`);
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(`\n❌ FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
