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
//   - Seeds proposal + approved strategy decision with India research evidence
//     and EQ execution-class metadata
//   - Drives ExecutionGateSupervisor.doWork() with an in-session weekday timestamp
//   - Asserts success-path evidence: 1 attempt, 1 order, 1 fill, 1 position,
//     India research visible on /health/strategy and /dashboard.json,
//     execution-class metadata present on both surfaces
//   - Latches a halt via riskRepo, seeds a second candidate, drives another tick
//   - Asserts refusal is visible: risk state shows active_halt, no new attempts
//   - Writes a timestamped JSON summary artifact under data/artifacts/paper-proof/
//   - Exits 0 on full success, non-zero on any assertion failure

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RuntimeApp } from '../runtime/runtime-app.js';
import {
  ExecutionMode,
  HaltSource,
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

function seedInstrument(handles: any, exchange: string, symbol: string) {
  handles.brokerRepo.upsertInstruments([
    {
      exchange,
      tradingsymbol: symbol,
      instrumentToken: symbol === 'RELIANCE' ? 123456 : 789012,
      name: symbol,
      expiry: null,
      strike: null,
      lotSize: symbol === 'RELIANCE' ? 1 : 75,
      tickSize: 0.05,
      instrumentType: 'EQ',
      segment: 'NSE_EQ',
      exchangeToken: 0,
    },
  ]);
}

function seedQuote(handles: any, exchange: string, symbol: string, price: number) {
  const now = Date.now();
  handles.brokerRepo.upsertQuote({
    exchange,
    tradingsymbol: symbol,
    instrumentToken: symbol === 'RELIANCE' ? 123456 : 789012,
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
      quantity: 75,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      quoteLastPrice: price,
      quoteBid: price - 0.5,
      quoteAsk: price + 0.5,
      quoteVolume: 1000000,
      quoteReceivedAt: Date.now(),
      riskNotional: 75 * price,
      riskSizingBasis: 'last_price',
      riskMaxLossRupees: 75 * price * 0.05,
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
  const handles = app.start();
  const port = await waitForServer(handles.server);
  console.log(`Runtime listening on port ${port}`);

  // ── Extract handles ───────────────────────────────────────────────────
  const gateSupervisor = handles.executionGateSupervisor!;
  const riskRepo = handles.riskRepo!;
  const proposalRepo = handles.proposalRepo!;
  const inSession = istDateTime(2026, 5, 13, 10, 0);

  // Seed broker data for RELIANCE
  seedInstrument(handles, 'NSE', 'RELIANCE');
  seedQuote(handles, 'NSE', 'RELIANCE', 2850.50);

  // Seed proposal + approved strategy decision with India research evidence
  // and EQ execution-class metadata
  const p1Id = seedProposal(proposalRepo, 'NSE', 'RELIANCE', 'buy', ProposalStatus.Accepted);
  seedStrategyDecision(handles, p1Id, 'NSE', 'RELIANCE', 'buy', 2850.50, StrategyDecisionStatus.Approved, {
    indiaResearchEvidence: {
      summary: 'India research flagged RELIANCE as high-conviction buy based on Q4 earnings beat and positive management commentary',
      tags: ['earnings-beat', 'management-guidance', 'high-conviction'],
      freshnessMs: 120000,
      influenceContext: 'India research committee upgraded rating from Hold to Buy after Q4 earnings review',
    },
    executionClass: 'EQ',
    segment: 'NSE',
    instrumentType: 'EQ',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    freezeQuantity: null,
  });

  await gateSupervisor.doWork(inSession, handles.healthService.getHealth());

  // ── Phase 1 assertions ─────────────────────────────────────────────

  // 1a. /health/execution — 1 attempt, paper mode, order/fill/position evidence
  const exec1 = await fetchJson(handles.server, '/health/execution');
  assert('execution endpoint returns 200', exec1.status === 200, `status=${exec1.status}`);
  assert('mode is paper', exec1.body.mode === 'paper', `mode=${exec1.body.mode}`);
  assert('totalAttempts = 1', exec1.body.totalAttempts === 1, `got ${exec1.body.totalAttempts}`);
  assert('totalOrders = 1', exec1.body.totalOrders === 1, `got ${exec1.body.totalOrders}`);
  assert('totalFills = 1', exec1.body.totalFills === 1, `got ${exec1.body.totalFills}`);
  assert('openPositionCount = 1', exec1.body.openPositionCount === 1, `got ${exec1.body.openPositionCount}`);
  assert('recentAttempts[0] is RELIANCE', exec1.body.recentAttempts[0]?.tradingsymbol === 'RELIANCE', `got ${exec1.body.recentAttempts[0]?.tradingsymbol}`);
  assert('recentAttempts[0] outcome is paper_simulated', exec1.body.recentAttempts[0]?.outcomeCode === 'paper_simulated', `got ${exec1.body.recentAttempts[0]?.outcomeCode}`);
  assert('recentPaperOrders[0] is RELIANCE', exec1.body.recentPaperOrders[0]?.tradingsymbol === 'RELIANCE', `got ${exec1.body.recentPaperOrders[0]?.tradingsymbol}`);
  assert('recentPaperFills[0] is RELIANCE', exec1.body.recentPaperFills[0]?.tradingsymbol === 'RELIANCE', `got ${exec1.body.recentPaperFills[0]?.tradingsymbol}`);
  assert('currentPositions[0] is RELIANCE', exec1.body.currentPositions[0]?.tradingsymbol === 'RELIANCE', `got ${exec1.body.currentPositions[0]?.tradingsymbol}`);
  assert('riskState haltState is no_halt', exec1.body.riskState?.haltState === 'no_halt', `got ${exec1.body.riskState?.haltState}`);
  assert('riskState isRefusing is false', exec1.body.riskState?.isRefusing === false, `got ${exec1.body.riskState?.isRefusing}`);

  // 1b. /dashboard.json — same evidence shape
  const dash1 = await fetchJson(handles.server, '/dashboard.json');
  assert('dashboard.json returns 200', dash1.status === 200, `status=${dash1.status}`);
  assert('dashboard execution totalAttempts = 1', dash1.body.execution?.totalAttempts === 1, `got ${dash1.body.execution?.totalAttempts}`);
  assert('dashboard execution totalOrders = 1', dash1.body.execution?.totalOrders === 1, `got ${dash1.body.execution?.totalOrders}`);
  assert('dashboard execution totalFills = 1', dash1.body.execution?.totalFills === 1, `got ${dash1.body.execution?.totalFills}`);
  assert('dashboard execution openPositionCount = 1', dash1.body.execution?.openPositionCount === 1, `got ${dash1.body.execution?.openPositionCount}`);

  // 1c. India research evidence visible on /dashboard.json
  assert('dashboard has recentStrategyDecisions', Array.isArray(dash1.body.recentStrategyDecisions) && dash1.body.recentStrategyDecisions.length > 0, 'missing');
  const dashSd = dash1.body.recentStrategyDecisions[0];
  assert('dashboard SD has indiaResearchEvidence', dashSd?.indiaResearchEvidence != null, 'null');
  assert('dashboard SD indiaResearchEvidence.summary mentions high-conviction buy',
    dashSd?.indiaResearchEvidence?.summary?.includes('high-conviction buy'),
    `got ${dashSd?.indiaResearchEvidence?.summary}`);
  assert('dashboard SD indiaResearchEvidence.tags includes earnings-beat',
    dashSd?.indiaResearchEvidence?.tags?.includes('earnings-beat'),
    `got ${JSON.stringify(dashSd?.indiaResearchEvidence?.tags)}`);
  assert('dashboard SD indiaResearchEvidence.freshnessMs = 120000',
    dashSd?.indiaResearchEvidence?.freshnessMs === 120000,
    `got ${dashSd?.indiaResearchEvidence?.freshnessMs}`);
  assert('dashboard SD indiaResearchEvidence.influenceContext mentions Hold to Buy',
    dashSd?.indiaResearchEvidence?.influenceContext?.includes('Hold to Buy'),
    `got ${dashSd?.indiaResearchEvidence?.influenceContext}`);

  // 1d. Execution-class metadata on /dashboard.json
  assert('dashboard SD executionClass = EQ', dashSd?.executionClass === 'EQ', `got ${dashSd?.executionClass}`);
  assert('dashboard SD segment = NSE', dashSd?.segment === 'NSE', `got ${dashSd?.segment}`);
  assert('dashboard SD instrumentType = EQ', dashSd?.instrumentType === 'EQ', `got ${dashSd?.instrumentType}`);
  assert('dashboard SD lotSize = 1', dashSd?.lotSize === 1, `got ${dashSd?.lotSize}`);
  assert('dashboard SD tickSize = 0.05', dashSd?.tickSize === 0.05, `got ${dashSd?.tickSize}`);
  assert('dashboard SD expiry is null', dashSd?.expiry == null, `got ${dashSd?.expiry}`);
  assert('dashboard SD strike is null', dashSd?.strike == null, `got ${dashSd?.strike}`);

  // 1e. /health/strategy — decisions with India research evidence and execution class
  const strat1 = await fetchJson(handles.server, '/health/strategy');
  assert('/health/strategy returns 200', strat1.status === 200, `status=${strat1.status}`);
  assert('/health/strategy totalDecisions = 1', strat1.body.totalDecisions === 1, `got ${strat1.body.totalDecisions}`);
  assert('/health/strategy approvedCount = 1', strat1.body.approvedCount === 1, `got ${strat1.body.approvedCount}`);
  assert('/health/strategy refusedCount = 0', strat1.body.refusedCount === 0, `got ${strat1.body.refusedCount}`);

  const sd1 = strat1.body.recentDecisions[0];
  assert('/health/strategy SD has indiaResearchEvidence', sd1?.indiaResearchEvidence != null, 'null');
  assert('/health/strategy SD indiaResearchEvidence.summary mentions high-conviction buy',
    sd1?.indiaResearchEvidence?.summary?.includes('high-conviction buy'),
    `got ${sd1?.indiaResearchEvidence?.summary}`);
  assert('/health/strategy SD indiaResearchEvidence.tags includes earnings-beat',
    sd1?.indiaResearchEvidence?.tags?.includes('earnings-beat'),
    `got ${JSON.stringify(sd1?.indiaResearchEvidence?.tags)}`);
  assert('/health/strategy SD indiaResearchEvidence.tags includes management-guidance',
    sd1?.indiaResearchEvidence?.tags?.includes('management-guidance'),
    `got ${JSON.stringify(sd1?.indiaResearchEvidence?.tags)}`);
  assert('/health/strategy SD indiaResearchEvidence.freshnessMs = 120000',
    sd1?.indiaResearchEvidence?.freshnessMs === 120000,
    `got ${sd1?.indiaResearchEvidence?.freshnessMs}`);
  assert('/health/strategy SD indiaResearchEvidence.influenceContext mentions Hold to Buy',
    sd1?.indiaResearchEvidence?.influenceContext?.includes('Hold to Buy'),
    `got ${sd1?.indiaResearchEvidence?.influenceContext}`);

  // 1f. Execution-class metadata on /health/strategy
  assert('/health/strategy SD executionClass = EQ', sd1?.executionClass === 'EQ', `got ${sd1?.executionClass}`);
  assert('/health/strategy SD segment = NSE', sd1?.segment === 'NSE', `got ${sd1?.segment}`);
  assert('/health/strategy SD instrumentType = EQ', sd1?.instrumentType === 'EQ', `got ${sd1?.instrumentType}`);
  assert('/health/strategy SD lotSize = 1', sd1?.lotSize === 1, `got ${sd1?.lotSize}`);
  assert('/health/strategy SD tickSize = 0.05', sd1?.tickSize === 0.05, `got ${sd1?.tickSize}`);
  assert('/health/strategy SD expiry is null', sd1?.expiry == null, `got ${sd1?.expiry}`);
  assert('/health/strategy SD strike is null', sd1?.strike == null, `got ${sd1?.strike}`);

  // 1g. /dashboard (HTML) — basic structural presence check
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

  // Seed a second proposal + approved decision (different instrument)
  seedInstrument(handles, 'NSE', 'INFY');
  seedQuote(handles, 'NSE', 'INFY', 1600.00);
  const p2Id = seedProposal(proposalRepo, 'NSE', 'INFY', 'buy', ProposalStatus.Accepted);
  seedStrategyDecision(handles, p2Id, 'NSE', 'INFY', 'buy', 1600.00, StrategyDecisionStatus.Approved);

  // Drive ExecutionGateSupervisor again — halt should refuse the new candidate
  await gateSupervisor.doWork(inSession, handles.healthService.getHealth());

  // ── Phase 2 assertions ─────────────────────────────────────────────

  const exec2 = await fetchJson(handles.server, '/health/execution');
  assert('Phase2: execution endpoint returns 200', exec2.status === 200, `status=${exec2.status}`);
  assert('Phase2: totalAttempts still = 1 (no new attempt)', exec2.body.totalAttempts === 1, `got ${exec2.body.totalAttempts}`);
  assert('Phase2: totalOrders still = 1', exec2.body.totalOrders === 1, `got ${exec2.body.totalOrders}`);
  assert('Phase2: totalFills still = 1', exec2.body.totalFills === 1, `got ${exec2.body.totalFills}`);

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

  // /health/strategy — should show 2 decisions (both approved)
  const strat2 = await fetchJson(handles.server, '/health/strategy');
  assert('Phase2: strategy totalDecisions = 2', strat2.body.totalDecisions === 2, `got ${strat2.body.totalDecisions}`);
  assert('Phase2: strategy approvedCount = 2', strat2.body.approvedCount === 2, `got ${strat2.body.approvedCount}`);

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
        symbol: 'RELIANCE',
        side: 'buy',
        price: 2850.50,
        quantity: 75,
        indiaResearchEvidence: true,
        executionClass: 'EQ',
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
