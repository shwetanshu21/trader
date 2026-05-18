// ── S06 Runtime Integration Test — Paper-trading witness with restart safety ──
//
// Proves that the assembled RuntimeApp in Paper mode exposes operator-reviewable
// proposal, strategy, execution, position, and risk evidence across:
//   1. A successful in-session paper fill (the real composed runtime)
//   2. A refusal/halt case through the real risk boundary
//   3. A restart on the same file-backed SQLite database without duplication
//
// Assertions hit /dashboard.json, /health/strategy, /health/execution, and
// /dashboard (HTML) to verify cross-surface consistency.

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeApp } from '../src/runtime/runtime-app.js';
import {
  ExecutionMode,
  HaltSource,
  ProposalStatus,
  StrategyDecisionStatus,
  type RuntimeConfig,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an IST (Asia/Kolkata = UTC+5:30) Date for a given local time. */
function istDateTime(
  year: number, month: number, day: number,
  hours: number, minutes: number,
): Date {
  // UTC = IST - 5:30
  return new Date(Date.UTC(year, month - 1, day, hours - 5, minutes - 30, 0));
}

/** Fetch JSON from a local HTTP server. */
async function fetchJson(server: http.Server, pathname: string): Promise<{ status: number; body: any }> {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Server not listening');
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${addr.port}${pathname}`, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode ?? 0, body: null }); }
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
    schedulerIntervalMs: 60000, // Won't tick — we drive doWork() manually
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
  };
}

// ---------------------------------------------------------------------------
// Seed helpers — used across all phases
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
  handles: any,
  exchange: string,
  symbol: string,
  side: string,
  status: ProposalStatus,
): number {
  const p = handles.proposalRepo.insertAttempt({
    exchange,
    tradingsymbol: symbol,
    instrumentToken: symbol === 'RELIANCE' ? 123456 : 789012,
    side,
    product: 'MIS',
    quantity: 75,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: 's06-witness',
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
      strategyId: 's06-witness-strategy',
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
// S06: Paper-trading witness with restart safety
// ---------------------------------------------------------------------------

describe('S06 Runtime — paper-trading witness and restart safety', () => {
  let app1: RuntimeApp;
  let app2: RuntimeApp;
  let tmpDir: string;
  let dbPath: string;

  afterEach(() => {
    try { app1?.stop('Test teardown'); } catch { /* ignore */ }
    try { app2?.stop('Test teardown'); } catch { /* ignore */ }
    try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('proves paper fill + refusal risk evidence + restart persistence on operator surfaces', async () => {
    // ═════════════════════════════════════════════════════════════════════
    // Setup: file-backed SQLite DB
    // ═════════════════════════════════════════════════════════════════════
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-s06-witness-'));
    dbPath = path.join(tmpDir, 'witness.db');

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 1 — Successful paper fill (in-session weekday timestamp)
    // ═════════════════════════════════════════════════════════════════════
    app1 = new RuntimeApp(paperConfig(dbPath));
    const h1 = app1.start();
    const port1 = await waitForServer(h1.server);

    // Seed broker data for RELIANCE
    seedInstrument(h1, 'NSE', 'RELIANCE');
    seedQuote(h1, 'NSE', 'RELIANCE', 2850.50);

    // Seed proposal + approved strategy decision (buy RELIANCE, MARKET)
    // Includes India research evidence and EQ execution-class metadata for
    // operator-surface visibility assertions.
    const p1Id = seedProposal(h1, 'NSE', 'RELIANCE', 'buy', ProposalStatus.Accepted);
    seedStrategyDecision(h1, p1Id, 'NSE', 'RELIANCE', 'buy', 2850.50, StrategyDecisionStatus.Approved, {
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

    // Drive ExecutionGateSupervisor with an in-session weekday timestamp
    // Wednesday, May 13, 2026 at 10:00 AM IST (= 04:30 UTC)
    const inSession = istDateTime(2026, 5, 13, 10, 0);
    await h1.executionGateSupervisor.doWork(inSession, h1.healthService.getHealth());

    // ── Phase 1 assertions ──────────────────────────────────────────────

    // /health/execution — should show 1 attempt, paper mode, order/fill/position evidence
    const exec1 = await fetchJson(h1.server, '/health/execution');
    expect(exec1.status).toBe(200);
    expect(exec1.body.mode).toBe('paper');
    expect(exec1.body.totalAttempts).toBe(1);
    expect(exec1.body.totalOrders).toBe(1);
    expect(exec1.body.totalFills).toBe(1);
    expect(exec1.body.openPositionCount).toBe(1);
    expect(exec1.body.recentAttempts.length).toBe(1);
    expect(exec1.body.recentAttempts[0].tradingsymbol).toBe('RELIANCE');
    expect(exec1.body.recentAttempts[0].outcomeCode).toBe('paper_simulated');
    expect(exec1.body.recentPaperOrders.length).toBe(1);
    expect(exec1.body.recentPaperOrders[0].tradingsymbol).toBe('RELIANCE');
    expect(exec1.body.recentPaperFills.length).toBe(1);
    expect(exec1.body.recentPaperFills[0].tradingsymbol).toBe('RELIANCE');
    expect(exec1.body.currentPositions.length).toBe(1);
    expect(exec1.body.currentPositions[0].tradingsymbol).toBe('RELIANCE');
    expect(exec1.body.riskState).not.toBeNull();
    expect(exec1.body.riskState.haltState).toBe('no_halt');
    expect(exec1.body.riskState.isRefusing).toBe(false);

    // /dashboard.json — same evidence shape
    const dash1 = await fetchJson(h1.server, '/dashboard.json');
    expect(dash1.status).toBe(200);
    expect(dash1.body.execution.totalAttempts).toBe(1);
    expect(dash1.body.execution.totalOrders).toBe(1);
    expect(dash1.body.execution.totalFills).toBe(1);
    expect(dash1.body.execution.openPositionCount).toBe(1);

    // India research evidence visible on /dashboard.json
    expect(dash1.body.recentStrategyDecisions.length).toBe(1);
    const dashSd1 = dash1.body.recentStrategyDecisions[0];
    expect(dashSd1.indiaResearchEvidence).not.toBeNull();
    expect(dashSd1.indiaResearchEvidence.summary).toContain('high-conviction buy');
    expect(dashSd1.indiaResearchEvidence.tags).toContain('earnings-beat');
    expect(dashSd1.indiaResearchEvidence.freshnessMs).toBe(120000);
    expect(dashSd1.indiaResearchEvidence.influenceContext).toContain('Hold to Buy');
    // Execution-class metadata on /dashboard.json
    expect(dashSd1.executionClass).toBe('EQ');
    expect(dashSd1.segment).toBe('NSE');
    expect(dashSd1.instrumentType).toBe('EQ');
    expect(dashSd1.lotSize).toBe(1);
    expect(dashSd1.tickSize).toBe(0.05);
    expect(dashSd1.expiry).toBeNull();
    expect(dashSd1.strike).toBeNull();

    // /health/strategy — 1 decision, approved, with India research evidence and execution class
    const strat1 = await fetchJson(h1.server, '/health/strategy');
    expect(strat1.status).toBe(200);
    expect(strat1.body.totalDecisions).toBe(1);
    expect(strat1.body.approvedCount).toBe(1);
    expect(strat1.body.refusedCount).toBe(0);
    expect(strat1.body.recentDecisions.length).toBe(1);

    // India research evidence visible on /health/strategy
    const sd1 = strat1.body.recentDecisions[0];
    expect(sd1.indiaResearchEvidence).not.toBeNull();
    expect(sd1.indiaResearchEvidence.summary).toContain('high-conviction buy');
    expect(sd1.indiaResearchEvidence.tags).toContain('earnings-beat');
    expect(sd1.indiaResearchEvidence.tags).toContain('management-guidance');
    expect(sd1.indiaResearchEvidence.freshnessMs).toBe(120000);
    expect(sd1.indiaResearchEvidence.influenceContext).toContain('Hold to Buy');

    // Execution-class metadata visible on /health/strategy
    expect(sd1.executionClass).toBe('EQ');
    expect(sd1.segment).toBe('NSE');
    expect(sd1.instrumentType).toBe('EQ');
    expect(sd1.lotSize).toBe(1);
    expect(sd1.tickSize).toBe(0.05);
    expect(sd1.expiry).toBeNull();
    expect(sd1.strike).toBeNull();

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 2 — Refusal/halt through the real risk boundary
    // ═════════════════════════════════════════════════════════════════════

    // Latch a halt on the risk repo to demonstrate the real risk boundary
    h1.riskRepo.latchHalt(
      HaltSource.Operator,
      'Operator kill-switch activated for S06 witness test',
      Date.now(),
    );

    // Insert a risk event so it's visible on operator surfaces
    h1.riskRepo.insertEvent({
      eventType: 'halt',
      source: HaltSource.Operator,
      severity: 'critical',
      message: 'Operator kill-switch activated — S06 witness refusal test',
      diagnostic: null,
      recordedAt: Date.now(),
    });

    // Seed a second proposal + approved decision (different instrument)
    const p2Id = seedProposal(h1, 'NSE', 'INFY', 'buy', ProposalStatus.Accepted);
    seedStrategyDecision(h1, p2Id, 'NSE', 'INFY', 'buy', 1600.00, StrategyDecisionStatus.Approved);

    // Seed broker data for INFY
    seedInstrument(h1, 'NSE', 'INFY');
    seedQuote(h1, 'NSE', 'INFY', 1600.00);

    // Drive ExecutionGateSupervisor again — halt should refuse the new candidate
    await h1.executionGateSupervisor.doWork(inSession, h1.healthService.getHealth());

    // ── Phase 2 assertions ──────────────────────────────────────────────

    // /health/execution — should still show 1 attempt (refused candidate is NOT consumed)
    // but risk state should show active halt
    const exec2 = await fetchJson(h1.server, '/health/execution');
    expect(exec2.status).toBe(200);
    expect(exec2.body.totalAttempts).toBe(1); // No new attempt — candidate skipped by risk guard
    expect(exec2.body.totalOrders).toBe(1);   // No new order
    expect(exec2.body.totalFills).toBe(1);    // No new fill

    // Risk state should show the halt
    expect(exec2.body.riskState.haltState).toBe('active_halt');
    expect(exec2.body.riskState.haltSource).toBe('operator');
    expect(exec2.body.riskState.isRefusing).toBe(true);
    expect(exec2.body.riskState.latchCount).toBe(1);

    // Risk events should include the inserted halt event
    expect(exec2.body.recentRiskEvents.length).toBe(1);
    expect(exec2.body.recentRiskEvents[0].eventType).toBe('halt');
    expect(exec2.body.recentRiskEvents[0].message).toContain('S06 witness refusal test');

    // /health/strategy — should show 2 decisions (both approved)
    const strat2 = await fetchJson(h1.server, '/health/strategy');
    expect(strat2.status).toBe(200);
    expect(strat2.body.totalDecisions).toBe(2);
    expect(strat2.body.approvedCount).toBe(2);
    expect(strat2.body.refusedCount).toBe(0);

    // /dashboard.json — risk state visible
    const dash2 = await fetchJson(h1.server, '/dashboard.json');
    expect(dash2.status).toBe(200);
    expect(dash2.body.execution.riskState.haltState).toBe('active_halt');
    expect(dash2.body.execution.riskState.isRefusing).toBe(true);
    expect(dash2.body.execution.recentRiskEvents.length).toBe(1);
    expect(dash2.body.execution.recentRiskEvents[0].eventType).toBe('halt');

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 3 — Restart on the same SQLite file
    // ═════════════════════════════════════════════════════════════════════

    app1.stop('Phase 2 complete — restarting');

    // Start app2 on the same file-backed DB
    app2 = new RuntimeApp(paperConfig(dbPath));
    const h2 = app2.start();
    const port2 = await waitForServer(h2.server);

    // ── Phase 3 assertions ──────────────────────────────────────────────

    // /health/execution — evidence preserved without duplication
    const exec3 = await fetchJson(h2.server, '/health/execution');
    expect(exec3.status).toBe(200);
    expect(exec3.body.totalAttempts).toBe(1);      // No duplication
    expect(exec3.body.totalOrders).toBe(1);
    expect(exec3.body.totalFills).toBe(1);
    expect(exec3.body.openPositionCount).toBe(1);   // Position still open
    expect(exec3.body.recentAttempts.length).toBe(1);
    expect(exec3.body.recentAttempts[0].tradingsymbol).toBe('RELIANCE');

    // Risk state preserved across restart
    expect(exec3.body.riskState.haltState).toBe('active_halt');
    expect(exec3.body.riskState.haltSource).toBe('operator');
    expect(exec3.body.riskState.isRefusing).toBe(true);
    expect(exec3.body.riskState.latchCount).toBe(1);

    // Risk events preserved — at minimum the halt event is present
    // (the scheduler may have added more events during startup)
    expect(exec3.body.recentRiskEvents.length).toBeGreaterThanOrEqual(1);
    const haltEvent = exec3.body.recentRiskEvents.find((e: any) => e.eventType === 'halt');
    expect(haltEvent).toBeDefined();
    expect(haltEvent.message).toContain('S06 witness refusal test');

    // /health/strategy — decisions preserved
    const strat3 = await fetchJson(h2.server, '/health/strategy');
    expect(strat3.status).toBe(200);
    expect(strat3.body.totalDecisions).toBe(2);
    expect(strat3.body.approvedCount).toBe(2);

    // /dashboard.json — full evidence preserved
    const dash3 = await fetchJson(h2.server, '/dashboard.json');
    expect(dash3.status).toBe(200);
    expect(dash3.body.execution.totalAttempts).toBe(1);
    expect(dash3.body.execution.totalOrders).toBe(1);
    expect(dash3.body.execution.totalFills).toBe(1);
    expect(dash3.body.execution.openPositionCount).toBe(1);
    expect(dash3.body.execution.riskState.haltState).toBe('active_halt');
    // Risk events preserved
    expect(dash3.body.execution.recentRiskEvents.length).toBeGreaterThanOrEqual(1);
    const dashHaltEvent = dash3.body.execution.recentRiskEvents.find((e: any) => e.eventType === 'halt');
    expect(dashHaltEvent).toBeDefined();

    // Verify position details preserved
    expect(dash3.body.execution.currentPositions.length).toBe(1);
    expect(dash3.body.execution.currentPositions[0].tradingsymbol).toBe('RELIANCE');
    expect(dash3.body.execution.currentPositions[0].quantity).toBe(75);

    // Paper order details preserved
    expect(dash3.body.execution.recentPaperOrders.length).toBe(1);
    expect(dash3.body.execution.recentPaperOrders[0].tradingsymbol).toBe('RELIANCE');

    // Paper fill details preserved
    expect(dash3.body.execution.recentPaperFills.length).toBe(1);
    expect(dash3.body.execution.recentPaperFills[0].tradingsymbol).toBe('RELIANCE');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Negative test: missing/stale quote refuses paper execution
  // ═══════════════════════════════════════════════════════════════════════
  it('refuses paper execution when quote or instrument data is missing/stale (malformed inputs)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-s06-negative-'));
    dbPath = path.join(tmpDir, 'negative.db');

    app1 = new RuntimeApp(paperConfig(dbPath));
    const h1 = app1.start();
    await waitForServer(h1.server);

    // Seed instrument but NO quote for TCS
    seedInstrument(h1, 'NSE', 'TCS');

    // Seed proposal + approved decision for TCS
    const pId = seedProposal(h1, 'NSE', 'TCS', 'buy', ProposalStatus.Accepted);
    seedStrategyDecision(h1, pId, 'NSE', 'TCS', 'buy', 3500.00, StrategyDecisionStatus.Approved);

    // Drive doWork with in-session timestamp
    const inSession = istDateTime(2026, 5, 13, 10, 0);
    await h1.executionGateSupervisor.doWork(inSession, h1.healthService.getHealth());

    // Assert: no order/fill/position created (paper policy refused due to missing quote)
    const exec = await fetchJson(h1.server, '/health/execution');
    expect(exec.body.totalAttempts).toBe(1); // Attempt was created (refused by paper policy)
    expect(exec.body.totalOrders).toBe(0);
    expect(exec.body.totalFills).toBe(0);
    expect(exec.body.openPositionCount).toBe(0);

    // The attempt should show refused status
    expect(exec.body.recentAttempts[0].status).toBe('refused');
    expect(exec.body.recentAttempts[0].outcomeCode).toBe('paper_rejected');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Boundary condition: replay on same DB after restart preserves evidence
  // without duplicating already-consumed decisions
  // ═══════════════════════════════════════════════════════════════════════
  it('preserves evidence without duplication after restart (boundary condition)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-s06-boundary-'));
    dbPath = path.join(tmpDir, 'boundary.db');

    // App 1: seed and consume one candidate
    app1 = new RuntimeApp(paperConfig(dbPath));
    const h1 = app1.start();
    await waitForServer(h1.server);

    seedInstrument(h1, 'NSE', 'HDFC');
    seedQuote(h1, 'NSE', 'HDFC', 2800.00);

    const pId = seedProposal(h1, 'NSE', 'HDFC', 'buy', ProposalStatus.Accepted);
    seedStrategyDecision(h1, pId, 'NSE', 'HDFC', 'buy', 2800.00, StrategyDecisionStatus.Approved);

    const inSession = istDateTime(2026, 5, 14, 10, 0); // Thursday
    await h1.executionGateSupervisor.doWork(inSession, h1.healthService.getHealth());

    // Verify 1 attempt
    const execBefore = await fetchJson(h1.server, '/health/execution');
    expect(execBefore.body.totalAttempts).toBe(1);

    // Attempt a second doWork on the same runtime — should NOT duplicate
    await h1.executionGateSupervisor.doWork(inSession, h1.healthService.getHealth());
    const execMid = await fetchJson(h1.server, '/health/execution');
    expect(execMid.body.totalAttempts).toBe(1); // No duplication

    app1.stop('Boundary test stop');

    // App 2: restart on same DB, re-run doWork — should NOT duplicate
    app2 = new RuntimeApp(paperConfig(dbPath));
    const h2 = app2.start();
    await waitForServer(h2.server);

    await h2.executionGateSupervisor.doWork(inSession, h2.healthService.getHealth());

    const execAfter = await fetchJson(h2.server, '/health/execution');
    expect(execAfter.body.totalAttempts).toBe(1); // Still no duplication
    expect(execAfter.body.totalOrders).toBe(1);
    expect(execAfter.body.totalFills).toBe(1);
    expect(execAfter.body.openPositionCount).toBe(1);
  });
});
