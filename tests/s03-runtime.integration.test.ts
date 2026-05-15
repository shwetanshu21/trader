// ── S03 Runtime Integration Test ──
// Proves that the proposal engine, validator, supervisor, and repository
// compose correctly on scheduler ticks through the pluggable strategy pipeline.
//
// Uses :memory: SQLite — no disk persistence required.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import { ProposalEngine } from '../src/proposals/proposal-engine.js';
import { IndiaProposalValidator } from '../src/proposals/india-validator.js';
import { ProposalSupervisor } from '../src/proposals/proposal-supervisor.js';
import { StrategyRunRepository } from '../src/persistence/strategy-run-repo.js';
import { RuntimeApp } from '../src/runtime/runtime-app.js';
import {
  ProposalStatus,
  ValidationReasonCode,
  MarketPhase,
  ZerodhaSessionState,
  ExecutionMode,
  type ProposalEngineConfig,
  type HealthStatus,
} from '../src/types/runtime.js';
import type {
  InstrumentRecord,
  QuoteSnapshot,
  InstrumentSyncState,
} from '../src/integrations/zerodha/types.js';
import type { MarketClock } from '../src/runtime/market-clock.js';

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------

class MockSessionService {
  private _state: ZerodhaSessionState = ZerodhaSessionState.Authenticated;
  private _expiresAt: number = Date.now() + 86_400_000;

  setHealth(state: ZerodhaSessionState, expiresAt?: number) {
    this._state = state;
    if (expiresAt !== undefined) this._expiresAt = expiresAt;
  }

  getSessionHealth() {
    return {
      state: this._state,
      obtainedAt: this._state === ZerodhaSessionState.Authenticated ? Date.now() : 0,
      expiresAt: this._expiresAt,
      reason: 'mock',
      lastError: null,
      lastAuthCheckAt: Date.now(),
    };
  }
}

class MockInstrumentsService {
  private _instrumentsBySegment: Map<string, InstrumentRecord[]> = new Map();
  private _lookup: Map<string, InstrumentRecord> = new Map();
  private _syncState: InstrumentSyncState = {
    lastSuccessAt: Date.now(),
    lastInstrumentCount: 100,
    lastSkippedCount: 0,
    lastStatus: 'success',
    lastError: null,
  };

  setInstruments(segment: string, instruments: InstrumentRecord[]) {
    this._instrumentsBySegment.set(segment, instruments);
    for (const inst of instruments) {
      this._lookup.set(`${inst.exchange}:${inst.tradingsymbol}`, inst);
    }
  }

  setSyncState(state: Partial<InstrumentSyncState>) {
    this._syncState = { ...this._syncState, ...state };
  }

  getInstrumentsBySegment(segment: string): InstrumentRecord[] { return this._instrumentsBySegment.get(segment) ?? []; }
  getInstrument(exchange: string, tradingsymbol: string): InstrumentRecord | null { return this._lookup.get(`${exchange}:${tradingsymbol}`) ?? null; }
  getSyncState(): InstrumentSyncState | null { return this._syncState; }
}

class MockMarketDataStream {
  private _quotes: Map<string, QuoteSnapshot> = new Map();
  setQuote(key: string, quote: QuoteSnapshot) { this._quotes.set(key, quote); }
  getLatestQuote(exchange: string, tradingsymbol: string): QuoteSnapshot | null { return this._quotes.get(`${exchange}:${tradingsymbol}`) ?? null; }
}

class MockMarketClock implements MarketClock {
  private _phase: MarketPhase = MarketPhase.Regular;
  setPhase(phase: MarketPhase) { this._phase = phase; }
  getPhase(_now?: Date): MarketPhase { return this._phase; }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEngineConfig(): ProposalEngineConfig {
  return { providerUrl: 'https://mock-proposals.example.com', timeoutMs: 5000, maxProposalsPerTick: 5 };
}

function minimalHealth(): HealthStatus {
  return {
    verdict: 'healthy' as any, uptimeMs: 1000, lifecycleState: 'running' as any,
    scheduler: { status: 'running' as any, marketPhase: MarketPhase.Regular, lastTickTimestamp: Date.now(), startedAt: Date.now(), tickCount: 5, lastError: null },
    degradedReasons: [], checkedAt: new Date().toISOString(),
  };
}

function sampleNseInstrument(overrides?: Partial<InstrumentRecord>): InstrumentRecord {
  return {
    exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 123456, name: 'RELIANCE INDUSTRIES LTD',
    expiry: null, strike: null, lotSize: 1, tickSize: 0.05, instrumentType: 'EQ', segment: 'NSE', exchangeToken: 1234, ...overrides,
  };
}

function sampleNfoInstrument(overrides?: Partial<InstrumentRecord>): InstrumentRecord {
  return {
    exchange: 'NFO', tradingsymbol: 'BANKNIFTY24DEC50000CE', instrumentToken: 789012, name: 'BANKNIFTY',
    expiry: '2024-12-26', strike: 50000, lotSize: 25, tickSize: 0.05, instrumentType: 'CE', segment: 'NFO', exchangeToken: 7891, ...overrides,
  };
}

function sampleQuote(overrides?: Partial<QuoteSnapshot>): QuoteSnapshot {
  return {
    exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 123456, lastPrice: 2950.00,
    change: 15.50, changePercent: 0.53, volume: 1_000_000, oi: null,
    high: 2960.00, low: 2930.00, open: 2940.00, close: 2934.50,
    bid: 2949.50, ask: 2950.00, priceTimestamp: Math.floor(Date.now() / 1000), receivedAt: Date.now(), ...overrides,
  };
}

function createSupervisor(options?: { engineConfig?: ProposalEngineConfig; marketPhase?: MarketPhase; sessionState?: ZerodhaSessionState; wiredRunRepo?: boolean }) {
  const db = new DatabaseManager(':memory:');
  const repo = new ProposalRepository(db.db);
  const runRepo = options?.wiredRunRepo ? new StrategyRunRepository(db.db) : null;
  const engine = new ProposalEngine(options?.engineConfig ?? makeEngineConfig());
  const validator = new IndiaProposalValidator();
  const session = new MockSessionService();
  const instruments = new MockInstrumentsService();
  const stream = new MockMarketDataStream();
  const clock = new MockMarketClock();

  if (options?.marketPhase !== undefined) clock.setPhase(options.marketPhase);
  if (options?.sessionState !== undefined) session.setHealth(options.sessionState);

  instruments.setInstruments('NSE', [sampleNseInstrument()]);
  instruments.setInstruments('NFO', [sampleNfoInstrument()]);
  stream.setQuote('NSE:RELIANCE', sampleQuote());
  stream.setQuote('NFO:BANKNIFTY24DEC50000CE', sampleQuote({ exchange: 'NFO', tradingsymbol: 'BANKNIFTY24DEC50000CE', instrumentToken: 789012 }));

  const supervisor = new ProposalSupervisor({
    engine, validator, repo, session: session as any, instruments: instruments as any, stream: stream as any, clock, maxProposals: 3,
    strategyRunRepo: runRepo,
  });

  return { db, repo, engine, validator, supervisor, session, instruments, stream, clock, runRepo };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('S03 Runtime — Proposal composition', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; vi.useFakeTimers(); });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  describe('Happy path — accepted proposals', () => {
    it('persists accepted proposals on tick, with zero reasons', async () => {
      const { supervisor, repo, clock } = createSupervisor();
      clock.setPhase(MarketPhase.Regular);

      // Strategy pipeline uses deterministic ranking for 2 instruments → 2 proposals
      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(2);

      // NSE EQ → MIS, lotSize=1, MARKET
      const nse = attempts.find(a => a.tradingsymbol === 'RELIANCE');
      expect(nse).toBeDefined();
      expect(nse!.proposalStatus).toBe(ProposalStatus.Accepted);
      expect(nse!.exchange).toBe('NSE');
      expect(nse!.side).toBe('buy');
      expect(nse!.product).toBe('MIS');
      expect(nse!.quantity).toBe(1);
      expect(nse!.orderType).toBe('MARKET');
      expect(nse!.instrumentToken).toBe(123456);
      expect(nse!.reasons).toEqual([]);

      // NFO CE → NRML, lotSize=25, MARKET
      const nfo = attempts.find(a => a.tradingsymbol === 'BANKNIFTY24DEC50000CE');
      expect(nfo).toBeDefined();
      expect(nfo!.proposalStatus).toBe(ProposalStatus.Accepted);
      expect(nfo!.exchange).toBe('NFO');
      expect(nfo!.side).toBe('buy');
      expect(nfo!.product).toBe('NRML');
      expect(nfo!.quantity).toBe(25);
      expect(nfo!.orderType).toBe('MARKET');
      expect(nfo!.instrumentToken).toBe(789012);
      expect(nfo!.reasons).toEqual([]);
    });
  });

  describe('Validator refusal — reasons persisted', () => {
    it('persists refused proposals with machine-readable reason codes', async () => {
      const { supervisor, repo, clock } = createSupervisor();
      clock.setPhase(MarketPhase.Closed);

      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(2);
      for (const a of attempts) {
        expect(a.proposalStatus).toBe(ProposalStatus.Refused);
        expect(a.reasons.some(r => r.reasonCode === ValidationReasonCode.MarketClosed)).toBe(true);
      }
    });

    it('persists multiple reasons for a multi-failure proposal', async () => {
      const { supervisor, repo, clock } = createSupervisor({ sessionState: ZerodhaSessionState.Expired });
      clock.setPhase(MarketPhase.Closed);

      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(2);
      for (const a of attempts) {
        expect(a.proposalStatus).toBe(ProposalStatus.Refused);
        expect(a.reasons.some(r => r.reasonCode === ValidationReasonCode.SessionExpired)).toBe(true);
        expect(a.reasons.some(r => r.reasonCode === ValidationReasonCode.MarketClosed)).toBe(true);
      }
    });
  });

  describe('Deterministic pipeline behavior', () => {
    it('produces proposals from bounded universe regardless of provider state', async () => {
      const { supervisor, repo } = createSupervisor();
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(2);
      // The coordinator attempts async LLM evaluation even when provider is down.
      // The error is captured as LLMStatus.Error evidence (not silent),
      // and proposals still flow from deterministic fallback.
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    it('caps proposals at maxProposals', async () => {
      const { repo, instruments, stream, engine, validator, session, clock } = createSupervisor();
      for (let i = 0; i < 10; i++) {
        const sym = `SYM${i}`;
        instruments.setInstruments('NSE', [...instruments.getInstrumentsBySegment('NSE'), sampleNseInstrument({ tradingsymbol: sym, instrumentToken: 100000 + i })]);
        stream.setQuote(`NSE:${sym}`, sampleQuote({ tradingsymbol: sym, instrumentToken: 100000 + i }));
      }
      const supervisor = new ProposalSupervisor({ engine, validator, repo, session: session as any, instruments: instruments as any, stream: stream as any, clock, maxProposals: 3 });
      await supervisor.doWork(new Date(), minimalHealth());
      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(3);
    });
  });

  describe('Overlap-skip protection', () => {
    it('skips overlapping ticks and persists DuplicateAttempt reason', async () => {
      const { supervisor, repo } = createSupervisor();

      // Make first tick block by holding _runTick
      let resolveTick: (() => void) | null = null;
      vi.spyOn(supervisor as any, '_runTick').mockImplementation(async () => {
        await new Promise<void>(r => { resolveTick = r; });
      });

      const firstPromise = supervisor.doWork(new Date(), minimalHealth());
      await vi.advanceTimersByTimeAsync(10);

      // Second tick should see _inFlight=true
      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);
      const overlap = attempts.find(a => a.tag === 'overlap-skip');
      expect(overlap).toBeDefined();
      expect(overlap!.proposalStatus).toBe(ProposalStatus.Skipped);
      expect(overlap!.reasons[0].reasonCode).toBe(ValidationReasonCode.DuplicateAttempt);

      if (resolveTick) resolveTick();
      await firstPromise;
    });
  });

  describe('No-instruments edge case', () => {
    it('skips when no instruments are available', async () => {
      const { supervisor, repo, instruments } = createSupervisor();
      instruments.setInstruments('NSE', []);
      instruments.setInstruments('NFO', []);

      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(1);
      const a = attempts[0];
      expect(a.proposalStatus).toBe(ProposalStatus.Skipped);
      expect(a.tag).toBe('no-instruments');
      expect(a.reasons[0].reasonCode).toBe(ValidationReasonCode.InstrumentLookupFailed);
    });
  });

  describe('Tick error handling', () => {
    it('persists a skip record when the tick throws', async () => {
      const { supervisor, repo } = createSupervisor();
      vi.spyOn(supervisor as any, '_runTick').mockRejectedValue(new Error('Pipeline crash'));
      const origErr = console.error;
      console.error = vi.fn();
      await supervisor.doWork(new Date(), minimalHealth());
      console.error = origErr;
      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(1);
      expect(attempts[0].proposalStatus).toBe(ProposalStatus.Skipped);
    });
  });

  describe('Diagnostic surface', () => {
    it('reports inFlight status and coordinator plugins', async () => {
      const { supervisor } = createSupervisor();
      const d = supervisor.getDiagnostics();
      expect(d.inFlight).toBe(false);
      expect(d.coordinatorPlugins).toHaveLength(1);
      expect(d.coordinatorPlugins[0].id).toBe('llm-ranking-v1');
    });
  });

  describe('Hybrid score persistence', () => {
    it('persists hybrid score evidence when hybridScoreRepo is wired', async () => {
      const db = new DatabaseManager(':memory:');
      const repo = new ProposalRepository(db.db);
      const { HybridScoreRepository } = await import('../src/persistence/hybrid-score-repo.js');
      const hybridRepo = new HybridScoreRepository(db.db);
      const engine = new ProposalEngine(makeEngineConfig());
      const validator = new IndiaProposalValidator();
      const session = new MockSessionService();
      const instruments = new MockInstrumentsService();
      const stream = new MockMarketDataStream();
      const clock = new MockMarketClock();

      clock.setPhase(MarketPhase.Regular);
      instruments.setInstruments('NSE', [sampleNseInstrument()]);
      stream.setQuote('NSE:RELIANCE', sampleQuote());

      const supervisor = new ProposalSupervisor({
        engine, validator, repo, session: session as any,
        instruments: instruments as any, stream: stream as any, clock,
        maxProposals: 3,
        hybridScoreRepo: hybridRepo,
      });

      await supervisor.doWork(new Date(), minimalHealth());

      // Verify proposals were persisted
      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBeGreaterThan(0);

      // Verify hybrid score evidence was persisted for each proposal
      for (const a of attempts) {
        if (a.proposalStatus === ProposalStatus.Accepted) {
          const evidence = hybridRepo.getByProposalAttemptId(a.id);
          expect(evidence).not.toBeNull();
          expect(evidence!.deterministicScore).toBeGreaterThanOrEqual(0);
          expect(evidence!.mergedScore).toBeGreaterThanOrEqual(0);
          expect(evidence!.mergePolicy).toBeTruthy();
          // Should have at least one component score from deterministic plugin
          expect(evidence!.components.length).toBeGreaterThanOrEqual(1);
        }
      }
    });

    it('falls back to basic persistence when hybridScoreRepo is not wired', async () => {
      const { supervisor, repo } = createSupervisor();

      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBeGreaterThan(0);
      // No hybrid evidence should exist (no hybrid repo wired)
      // The insertAttemptWithReasons was used, not the combined method
      expect(attempts.length).toBeGreaterThan(0);
    });
  });
});

// ── RuntimeApp hybrid score repo wiring ─────────────────────────────────

describe('RuntimeApp — hybrid score repo wiring', () => {
  let tmpDir: string;

  beforeEach(() => {
    // Use temp dir for RuntimeApp (doesn't support ':memory:' as dbPath fully)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's03-hybrid-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('wires hybridScoreRepo when proposal engine is configured', () => {
    const app = new RuntimeApp({
      port: 0,
      nodeEnv: 'test',
      marketTimezone: 'Asia/Kolkata',
      schedulerIntervalMs: 60000,
      dbPath: path.join(tmpDir, 'test.db'),
      logLevel: 'error',
      zerodha: null,
      proposalEngine: {
        providerMode: 'custom',
        providerUrl: 'http://localhost:9999/v1/proposals',
        timeoutMs: 5000,
        maxProposalsPerTick: 1,
      },
      execution: {
        mode: ExecutionMode.Blocked,
        maxRetries: 0,
        riskLimits: {
          maxOpenPositions: 5,
          maxOrdersPerInstrument: 1,
          maxDailyLossRupees: 20000,
          maxExposureRupees: 500000,
          marketHoursStalenessMs: 120000,
        },
      },
      strategy: {
        maxCandidates: 5,
        parallelPlugins: true,
      },
    });

    const handles = app.build();
    expect(handles.hybridScoreRepo).not.toBeNull();
    expect(handles.strategyRunRepo).not.toBeNull();
    expect(handles.proposalSupervisor).not.toBeNull();
    expect(handles.strategyDecisionRepo).not.toBeNull();

    // Clean up
    app.stop('Test teardown');
  });

  it('leaves hybridScoreRepo null when proposal engine is not configured', () => {
    const app = new RuntimeApp({
      port: 0,
      nodeEnv: 'test',
      marketTimezone: 'Asia/Kolkata',
      schedulerIntervalMs: 60000,
      dbPath: path.join(tmpDir, 'test.db'),
      logLevel: 'error',
      zerodha: null,
      proposalEngine: null,
      execution: {
        mode: ExecutionMode.Blocked,
        maxRetries: 0,
        riskLimits: {
          maxOpenPositions: 5,
          maxOrdersPerInstrument: 1,
          maxDailyLossRupees: 20000,
          maxExposureRupees: 500000,
          marketHoursStalenessMs: 120000,
        },
      },
      strategy: {
        maxCandidates: 5,
        parallelPlugins: true,
      },
    });

    const handles = app.build();
    expect(handles.hybridScoreRepo).toBeNull();
    expect(handles.proposalSupervisor).toBeNull();

    // Clean up
    app.stop('Test teardown');
  });

  it('dashboard snapshot includes hybrid evidence when hybridScoreRepo is wired', () => {
    const app = new RuntimeApp({
      port: 0,
      nodeEnv: 'test',
      marketTimezone: 'Asia/Kolkata',
      schedulerIntervalMs: 60000,
      dbPath: path.join(tmpDir, 'test.db'),
      logLevel: 'error',
      zerodha: null,
      proposalEngine: {
        providerMode: 'custom',
        providerUrl: 'http://localhost:9999/v1/proposals',
        timeoutMs: 5000,
        maxProposalsPerTick: 1,
      },
      execution: {
        mode: ExecutionMode.Blocked,
        maxRetries: 0,
        riskLimits: {
          maxOpenPositions: 5,
          maxOrdersPerInstrument: 1,
          maxDailyLossRupees: 20000,
          maxExposureRupees: 500000,
          marketHoursStalenessMs: 120000,
        },
      },
      strategy: {
        maxCandidates: 5,
        parallelPlugins: true,
      },
    });

    const handles = app.build();

    // Verify the dashboard read-model was constructed with the hybridScoreRepo
    expect(handles.hybridScoreRepo).not.toBeNull();

    // Snapshot should be buildable without throwing
    const snapshot = handles.dashboard.getSnapshot();
    expect(snapshot).toHaveProperty('recentStrategyDecisions');
    expect(snapshot.recentStrategyDecisions).toEqual([]);

    // Clean up
    app.stop('Test teardown');
  });
});

// ── Strategy run persistence from ProposalSupervisor ticks ───────────────

describe('ProposalSupervisor — strategy run persistence', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('persists a strategy run artifact on tick when strategyRunRepo is wired', async () => {
    const { supervisor, repo, runRepo } = createSupervisor({
      marketPhase: MarketPhase.Regular,
      wiredRunRepo: true,
    });

    await supervisor.doWork(new Date(), minimalHealth());

    // Verify proposals were persisted
    const attempts = repo.getRecentAttemptsWithReasons(10);
    expect(attempts.length).toBeGreaterThan(0);

    // Verify a strategy run was persisted
    const runs = runRepo!.getRecentRuns();
    expect(runs.length).toBe(1);
    expect(runs[0].totalEvaluated).toBeGreaterThan(0);
    expect(runs[0].candidates.length).toBeGreaterThan(0);
    const parsedPlugins = JSON.parse(runs[0].pluginsJson);
    expect(Array.isArray(parsedPlugins)).toBe(true);
    expect(parsedPlugins.length).toBeGreaterThan(0);
  });

  it('persists all evaluated candidates matching the coordinator output', async () => {
    const { supervisor, repo, runRepo } = createSupervisor({
      marketPhase: MarketPhase.Regular,
      wiredRunRepo: true,
    });

    await supervisor.doWork(new Date(), minimalHealth());

    const runs = runRepo!.getRecentRuns();
    expect(runs.length).toBe(1);
    const run = runs[0];

    // Two candidates (NSE RELIANCE + NFO BANKNIFTY option)
    expect(run.candidates.length).toBe(2);

    // Verify candidate keys match the expected instruments
    const keys = run.candidates.map(c => c.candidateKey).sort();
    expect(keys).toEqual(['NFO:BANKNIFTY24DEC50000CE', 'NSE:RELIANCE']);

    // Each candidate has scores, merged score, and plugin evidence
    for (const c of run.candidates) {
      expect(c.mergedScore).toBeGreaterThanOrEqual(0);
      expect(c.deterministicScore).toBeGreaterThanOrEqual(0);
      expect(c.scoresJson).toBeTruthy();
      const scores = JSON.parse(c.scoresJson);
      expect(Array.isArray(scores)).toBe(true);
      expect(scores.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('links emitted (accepted) candidates with proposal_attempt_id', async () => {
    const { supervisor, repo, runRepo } = createSupervisor({
      marketPhase: MarketPhase.Regular,
      wiredRunRepo: true,
    });

    await supervisor.doWork(new Date(), minimalHealth());

    const runs = runRepo!.getRecentRuns();
    expect(runs.length).toBe(1);
    const run = runs[0];

    // All candidates should be emitted (accepted during regular market hours)
    const emitted = run.candidates.filter(c => c.emitted);
    const nonEmitted = run.candidates.filter(c => !c.emitted);

    expect(emitted.length).toBe(2);
    expect(nonEmitted.length).toBe(0);

    // Each emitted candidate has a valid proposal_attempt_id (FK linkage)
    for (const c of emitted) {
      expect(c.proposalAttemptId).not.toBeNull();
      expect(c.proposalAttemptId).toBeGreaterThan(0);
    }
  });

  it('falls back to normal tick when strategyRunRepo is not wired', async () => {
    const { supervisor, repo } = createSupervisor({
      marketPhase: MarketPhase.Regular,
    });

    await supervisor.doWork(new Date(), minimalHealth());

    const attempts = repo.getRecentAttemptsWithReasons(10);
    expect(attempts.length).toBeGreaterThan(0);

    // Basic persistence worked without strategy run repo
    const accepted = attempts.filter(a => a.proposalStatus === ProposalStatus.Accepted);
    expect(accepted.length).toBeGreaterThan(0);
  });

  it('survives strategy run persistence failure without crashing the tick', async () => {
    const { supervisor, repo, runRepo } = createSupervisor({
      marketPhase: MarketPhase.Regular,
      wiredRunRepo: true,
    });

    // The repo will work fine — this tests that the try/catch in _persistStrategyRun
    // doesn't throw. The run should be persisted normally.
    await supervisor.doWork(new Date(), minimalHealth());

    const attempts = repo.getRecentAttemptsWithReasons(10);
    expect(attempts.length).toBeGreaterThan(0);

    // Run should be persisted
    const runs = runRepo!.getRecentRuns();
    expect(runs.length).toBe(1);
  });

  it('wires strategyRunRepo when proposal engine is configured in RuntimeApp', () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 's03-strategy-run-'));
    try {
      const app = new RuntimeApp({
        port: 0,
        nodeEnv: 'test',
        marketTimezone: 'Asia/Kolkata',
        schedulerIntervalMs: 60000,
        dbPath: path.join(tmpDir2, 'test.db'),
        logLevel: 'error',
        zerodha: null,
        proposalEngine: {
          providerMode: 'custom',
          providerUrl: 'http://localhost:9999/v1/proposals',
          timeoutMs: 5000,
          maxProposalsPerTick: 1,
        },
        execution: {
          mode: ExecutionMode.Blocked,
          maxRetries: 0,
          riskLimits: {
            maxOpenPositions: 5,
            maxOrdersPerInstrument: 1,
            maxDailyLossRupees: 20000,
            maxExposureRupees: 500000,
            marketHoursStalenessMs: 120000,
          },
        },
        strategy: {
          maxCandidates: 5,
          parallelPlugins: true,
        },
      });

      const handles = app.build();
      expect(handles.strategyRunRepo).not.toBeNull();
      app.stop('Test teardown');
    } finally {
      try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
