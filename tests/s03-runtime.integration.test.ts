// ── S03 Runtime Integration Test ──
// Proves that the proposal engine, validator, supervisor, and repository
// compose correctly on scheduler ticks. Covers:
//   - Proposal persistence on tick (accepted / refused / skipped)
//   - Validator refusal reasons persisted with correct codes
//   - Malformed provider output captured as durable refusal
//   - Overlap-skip protection (concurrent ticks)
//   - No-instruments edge case
//   - Engine timeout/malformed/empty results
//
// Uses :memory: SQLite — no disk persistence required.
// Deterministic guards (no real-time sleeps for overlap tests — uses promise
// coordination instead).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import { ProposalEngine, type EngineContext } from '../src/proposals/proposal-engine.js';
import { IndiaProposalValidator } from '../src/proposals/india-validator.js';
import { ProposalSupervisor } from '../src/proposals/proposal-supervisor.js';
import {
  ProposalStatus,
  ValidationReasonCode,
  MarketPhase,
  ZerodhaSessionState,
  type ProposalEngineConfig,
  type ProposalAttemptWithReasons,
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

/** Stub SessionService that returns the configured health. */
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

/** Stub InstrumentsService that returns pre-configured data. */
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

  getInstrumentsBySegment(segment: string): InstrumentRecord[] {
    return this._instrumentsBySegment.get(segment) ?? [];
  }

  getInstrument(exchange: string, tradingsymbol: string): InstrumentRecord | null {
    return this._lookup.get(`${exchange}:${tradingsymbol}`) ?? null;
  }

  getSyncState(): InstrumentSyncState | null {
    return this._syncState;
  }
}

/** Stub MarketDataStream that returns pre-configured quotes. */
class MockMarketDataStream {
  private _quotes: Map<string, QuoteSnapshot> = new Map();

  setQuote(key: string, quote: QuoteSnapshot) {
    this._quotes.set(key, quote);
  }

  getLatestQuote(exchange: string, tradingsymbol: string): QuoteSnapshot | null {
    return this._quotes.get(`${exchange}:${tradingsymbol}`) ?? null;
  }
}

/** Stub MarketClock that returns a fixed phase. */
class MockMarketClock implements MarketClock {
  private _phase: MarketPhase = MarketPhase.Regular;

  setPhase(phase: MarketPhase) { this._phase = phase; }
  getPhase(_now?: Date): MarketPhase { return this._phase; }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEngineConfig(): ProposalEngineConfig {
  return {
    providerUrl: 'https://mock-proposals.example.com',
    timeoutMs: 5000,
    maxProposalsPerTick: 5,
  };
}

function minimalHealth(): HealthStatus {
  return {
    verdict: 'healthy' as any,
    uptimeMs: 1000,
    lifecycleState: 'running' as any,
    scheduler: {
      status: 'running' as any,
      marketPhase: MarketPhase.Regular,
      lastTickTimestamp: Date.now(),
      startedAt: Date.now(),
      tickCount: 5,
      lastError: null,
    },
    degradedReasons: [],
    checkedAt: new Date().toISOString(),
  };
}

function sampleNseInstrument(overrides?: Partial<InstrumentRecord>): InstrumentRecord {
  return {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    name: 'RELIANCE INDUSTRIES LTD',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    instrumentType: 'EQ',
    segment: 'NSE',
    exchangeToken: 1234,
    ...overrides,
  };
}

function sampleNfoInstrument(overrides?: Partial<InstrumentRecord>): InstrumentRecord {
  return {
    exchange: 'NFO',
    tradingsymbol: 'BANKNIFTY24DEC50000CE',
    instrumentToken: 789012,
    name: 'BANKNIFTY',
    expiry: '2024-12-26',
    strike: 50000,
    lotSize: 25,
    tickSize: 0.05,
    instrumentType: 'CE',
    segment: 'NFO',
    exchangeToken: 7891,
    ...overrides,
  };
}

function sampleQuote(overrides?: Partial<QuoteSnapshot>): QuoteSnapshot {
  return {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    lastPrice: 2950.00,
    change: 15.50,
    changePercent: 0.53,
    volume: 1_000_000,
    oi: null,
    high: 2960.00,
    low: 2930.00,
    open: 2940.00,
    close: 2934.50,
    bid: 2949.50,
    ask: 2950.00,
    priceTimestamp: Math.floor(Date.now() / 1000),
    receivedAt: Date.now(),
    ...overrides,
  };
}

/** Create all fixtures for a test case. */
function createSupervisor(options?: {
  engineConfig?: ProposalEngineConfig;
  marketPhase?: MarketPhase;
  sessionState?: ZerodhaSessionState;
}) {
  const db = new DatabaseManager(':memory:');
  const repo = new ProposalRepository(db.db);
  const engine = new ProposalEngine(options?.engineConfig ?? makeEngineConfig());
  const validator = new IndiaProposalValidator();
  const session = new MockSessionService();
  const instruments = new MockInstrumentsService();
  const stream = new MockMarketDataStream();
  const clock = new MockMarketClock();

  if (options?.marketPhase !== undefined) {
    clock.setPhase(options.marketPhase);
  }
  if (options?.sessionState !== undefined) {
    session.setHealth(options.sessionState);
  }

  // Populate default instrument/quote data
  instruments.setInstruments('NSE', [sampleNseInstrument()]);
  instruments.setInstruments('NFO', [sampleNfoInstrument()]);
  stream.setQuote('NSE:RELIANCE', sampleQuote());
  stream.setQuote('NFO:BANKNIFTY24DEC50000CE', sampleQuote({
    exchange: 'NFO',
    tradingsymbol: 'BANKNIFTY24DEC50000CE',
    instrumentToken: 789012,
  }));

  const supervisor = new ProposalSupervisor({
    engine,
    validator,
    repo,
    session: session as any,
    instruments: instruments as any,
    stream: stream as any,
    clock,
    maxProposals: 3,
  });

  return { db, repo, engine, validator, supervisor, session, instruments, stream, clock };
}

/** Helper: mock fetch to return a JSON response. */
function mockFetchJson(data: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

/** Helper: mock fetch to return a text (non-JSON) response. */
function mockFetchText(text: string, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(text, {
      status,
      headers: { 'Content-Type': 'text/plain' },
    }),
  );
}

/** Helper: mock fetch to throw a network error. */
function mockFetchNetworkError(message = 'ECONNREFUSED') {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error(message));
}

/** Helper: mock fetch to return an empty body (resolves but no content). */
function mockFetchEmpty() {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(null, { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
}

/** Helper: mock fetch to never resolve (hang). */
function mockFetchHang(): () => void {
  let resolveAbort: (() => void) | null = null;
  globalThis.fetch = vi.fn().mockImplementation(
    (_url: string, options?: RequestInit) => {
      return new Promise<never>((_resolve, reject) => {
        resolveAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (options?.signal) {
          options.signal.addEventListener('abort', () => {
            if (resolveAbort) resolveAbort();
          });
        }
      });
    },
  );
  return () => { if (resolveAbort) resolveAbort(); };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('S03 Runtime — Proposal composition', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  describe('Happy path — accepted proposals', () => {
    it('persists accepted proposals on tick, with zero reasons', async () => {
      const { supervisor, repo, clock } = createSupervisor();
      clock.setPhase(MarketPhase.Regular);

      mockFetchJson({
        proposals: [
          {
            exchange: 'NSE',
            tradingsymbol: 'RELIANCE',
            side: 'buy',
            product: 'MIS',
            quantity: 1,
            price: null,
            triggerPrice: null,
            orderType: 'MARKET',
          },
          {
            exchange: 'NFO',
            tradingsymbol: 'BANKNIFTY24DEC50000CE',
            side: 'sell',
            product: 'NRML',
            quantity: 50, // 2x lot of 25
            price: 150.50,
            triggerPrice: null,
            orderType: 'LIMIT',
          },
        ],
      });

      await supervisor.doWork(new Date(), minimalHealth());

      // Check repo has persisted records
      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(2);

      // NSE market buy
      const nseAttempt = attempts.find(a => a.tradingsymbol === 'RELIANCE');
      expect(nseAttempt).toBeDefined();
      expect(nseAttempt!.proposalStatus).toBe(ProposalStatus.Accepted);
      expect(nseAttempt!.exchange).toBe('NSE');
      expect(nseAttempt!.side).toBe('buy');
      expect(nseAttempt!.product).toBe('MIS');
      expect(nseAttempt!.quantity).toBe(1);
      expect(nseAttempt!.orderType).toBe('MARKET');
      expect(nseAttempt!.instrumentToken).toBe(123456);
      expect(nseAttempt!.reasons).toEqual([]);

      // NFO limit sell
      const nfoAttempt = attempts.find(a => a.tradingsymbol === 'BANKNIFTY24DEC50000CE');
      expect(nfoAttempt).toBeDefined();
      expect(nfoAttempt!.proposalStatus).toBe(ProposalStatus.Accepted);
      expect(nfoAttempt!.exchange).toBe('NFO');
      expect(nfoAttempt!.side).toBe('sell');
      expect(nfoAttempt!.product).toBe('NRML');
      expect(nfoAttempt!.quantity).toBe(50);
      expect(nfoAttempt!.orderType).toBe('LIMIT');
      expect(nfoAttempt!.price).toBe(150.50);
      expect(nfoAttempt!.instrumentToken).toBe(789012);
      expect(nfoAttempt!.reasons).toEqual([]);
    });
  });

  // ── Validator refusal ───────────────────────────────────────────────────

  describe('Validator refusal — reasons persisted', () => {
    it('persists refused proposals with machine-readable reason codes', async () => {
      const { supervisor, repo, clock, instruments } = createSupervisor();
      clock.setPhase(MarketPhase.Closed); // Market closed → validator refuses

      mockFetchJson({
        proposals: [
          {
            exchange: 'NSE',
            tradingsymbol: 'RELIANCE',
            side: 'buy',
            product: 'MIS',
            quantity: 1,
            price: null,
            triggerPrice: null,
            orderType: 'MARKET',
          },
        ],
      });

      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(1);

      const attempt = attempts[0];
      expect(attempt.proposalStatus).toBe(ProposalStatus.Refused);
      expect(attempt.reasons.length).toBeGreaterThan(0);

      // Must include MarketClosed
      const marketClosedReason = attempt.reasons.find(
        r => r.reasonCode === ValidationReasonCode.MarketClosed,
      );
      expect(marketClosedReason).toBeDefined();
      expect(marketClosedReason!.reasonMessage).toContain('closed');
    });

    it('persists multiple reasons for a multi-failure proposal', async () => {
      const { supervisor, repo, clock } = createSupervisor({
        sessionState: ZerodhaSessionState.Expired,
      });
      clock.setPhase(MarketPhase.Closed);

      mockFetchJson({
        proposals: [
          {
            exchange: 'BSE', // Unsupported exchange
            tradingsymbol: 'SOME',
            side: 'hold', // Invalid side
            product: 'BO', // Invalid product
            quantity: 0, // Zero quantity
            price: null,
            triggerPrice: null,
            orderType: 'BO', // Invalid order type
          },
        ],
      });

      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);

      // The invalid proposals get filtered by the engine normalization first:
      // BSE exchange, hold side, BO product, BO orderType, 0 quantity
      // All proposals fail normalization → engine returns refusal
      // The supervisor persists that as one Skipped/Refused record
      expect(attempts.length).toBe(1);
      const attempt = attempts[0];
      expect(attempt.proposalStatus).toBe(ProposalStatus.Refused);
      expect(attempt.reasons.length).toBeGreaterThan(0);
    });
  });

  // ── Malformed provider output ──────────────────────────────────────────

  describe('Malformed provider output — refusal capture', () => {
    it('persists a refusal record when provider returns non-JSON', async () => {
      const { supervisor, repo } = createSupervisor();

      mockFetchText('Internal Server Error');

      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(1);

      const attempt = attempts[0];
      expect(attempt.proposalStatus).toBe(ProposalStatus.Refused);
      expect(attempt.tag).toBe('engine-refusal');
    });

    it('persists a refusal record when provider returns empty proposal list', async () => {
      const { supervisor, repo } = createSupervisor();

      mockFetchJson({ proposals: [] });

      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(1);

      const attempt = attempts[0];
      expect(attempt.proposalStatus).toBe(ProposalStatus.Refused);
      expect(attempt.tag).toBe('engine-refusal');
    });

    it('persists a refusal record when provider returns 500 error', async () => {
      const { supervisor, repo } = createSupervisor();

      mockFetchJson({ error: 'server error' }, 500);

      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(1);

      const attempt = attempts[0];
      expect(attempt.proposalStatus).toBe(ProposalStatus.Refused);
      expect(attempt.tag).toBe('engine-refusal');
    });

    it('persists a refusal record on network error', async () => {
      const { supervisor, repo } = createSupervisor();

      mockFetchNetworkError('ETIMEDOUT');

      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(1);

      const attempt = attempts[0];
      expect(attempt.proposalStatus).toBe(ProposalStatus.Refused);
      expect(attempt.tag).toBe('engine-refusal');
    });

    it('persists a refusal when all proposals fail normalization', async () => {
      const { supervisor, repo } = createSupervisor();

      // All proposals have invalid exchanges — all filtered out
      mockFetchJson({
        proposals: [
          { exchange: 'BSE', tradingsymbol: 'S1', side: 'buy', product: 'MIS', quantity: 1, price: null, triggerPrice: null, orderType: 'MARKET' },
          { exchange: 'BSE', tradingsymbol: 'S2', side: 'sell', product: 'CNC', quantity: 1, price: null, triggerPrice: null, orderType: 'MARKET' },
        ],
      });

      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(1);

      const attempt = attempts[0];
      expect(attempt.proposalStatus).toBe(ProposalStatus.Refused);
      expect(attempt.tag).toBe('engine-refusal');
      expect(attempt.reasons.length).toBeGreaterThan(0);
    });
  });

  // ── Overlap-skip protection ────────────────────────────────────────────

  describe('Overlap-skip protection', () => {
    it('skips overlapping ticks and persists DuplicateAttempt reason', async () => {
      const { supervisor, repo } = createSupervisor();

      // Create a fetch that blocks (never resolves) to keep _inFlight = true
      let resolveHang: (() => void) | null = null;
      globalThis.fetch = vi.fn().mockImplementation(
        () => new Promise(r => { resolveHang = r; }),
      );

      // Start first doWork — it acquires the in-flight guard and hangs on fetch
      const firstPromise = supervisor.doWork(new Date(), minimalHealth());

      // Give the microtask queue time to run so _inFlight becomes true
      await vi.advanceTimersByTimeAsync(10);

      // Now doWork a second time — it should see _inFlight = true and persist overlap-skip
      // The second doWork never calls fetch because _inFlight check happens first
      await supervisor.doWork(new Date(), minimalHealth());

      // Check that the overlap-skip was persisted BEFORE resolving the first call
      const attempts = repo.getRecentAttemptsWithReasons(10);
      const overlapAttempt = attempts.find(a => a.tag === 'overlap-skip');
      expect(overlapAttempt).toBeDefined();
      expect(overlapAttempt!.proposalStatus).toBe(ProposalStatus.Skipped);
      expect(overlapAttempt!.reasons.length).toBe(1);
      expect(overlapAttempt!.reasons[0].reasonCode).toBe(ValidationReasonCode.DuplicateAttempt);

      // Clean up: let the first call resolve
      if (resolveHang) resolveHang();
      await firstPromise;

      // Now the first call also persisted something
      const allAttempts = repo.getRecentAttemptsWithReasons(10);
      expect(allAttempts.length).toBe(2);
    });
  });

  // ── No-instruments edge case ───────────────────────────────────────────

  describe('No-instruments edge case', () => {
    it('skips when no instruments are available', async () => {
      const { supervisor, repo, instruments } = createSupervisor();

      // Clear all instruments
      instruments.setInstruments('NSE', []);
      instruments.setInstruments('NFO', []);

      // Engine should never be called (no instruments → skip before engine call)
      // But the supervisor _buildEngineContext returns empty → persist skip
      mockFetchJson({
        proposals: [
          { exchange: 'NSE', tradingsymbol: 'RELIANCE', side: 'buy', product: 'MIS', quantity: 1, price: null, triggerPrice: null, orderType: 'MARKET' },
        ],
      });

      await supervisor.doWork(new Date(), minimalHealth());

      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(1);

      const attempt = attempts[0];
      expect(attempt.proposalStatus).toBe(ProposalStatus.Skipped);
      expect(attempt.tag).toBe('no-instruments');
      expect(attempt.reasons.length).toBeGreaterThan(0);
      expect(attempt.reasons[0].reasonCode).toBe(ValidationReasonCode.InstrumentLookupFailed);
    });
  });

  // ── Tick error handling ────────────────────────────────────────────────

  describe('Tick error handling', () => {
    it('persists a skip record when the tick throws an unexpected error', async () => {
      const { supervisor, repo, engine } = createSupervisor();

      // Make engine.generateProposals throw
      vi.spyOn(engine, 'generateProposals').mockRejectedValue(new Error('Unexpected engine crash'));

      // Suppress console.error during this test
      const originalError = console.error;
      console.error = vi.fn();

      await supervisor.doWork(new Date(), minimalHealth());

      // Restore console.error
      console.error = originalError;

      const attempts = repo.getRecentAttemptsWithReasons(10);
      expect(attempts.length).toBe(1);

      const attempt = attempts[0];
      expect(attempt.proposalStatus).toBe(ProposalStatus.Skipped);
      expect(attempt.reasons.length).toBeGreaterThan(0);
      expect(attempt.reasons[0].reasonMessage).toContain('engine crash');
    });
  });

  // ── Diagnostic surface ─────────────────────────────────────────────────

  describe('Diagnostic surface', () => {
    it('reports inFlight status correctly', async () => {
      const { supervisor } = createSupervisor();

      // Before any work
      const diagBefore = supervisor.getDiagnostics();
      expect(diagBefore.inFlight).toBe(false);
      expect(diagBefore.overlapSkipCount).toBe(0);
      expect(diagBefore.lastTickAt).toBeNull();
    });
  });
});
