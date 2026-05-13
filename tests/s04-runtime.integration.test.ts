// ── S04 Runtime Integration Test ──
// Proves that the execution gate supervisor composes correctly with
// proposal generation and strategy-risk evaluation on scheduler ticks.
// Covers:
//   - Same-tick composition: approved proposals get consumed via execution attempts
//   - Refused/skipped proposals never create execution attempt rows
//   - Gate replay idempotency (re-running gate doesn't duplicate attempts)
//   - Empty gate (no approved candidates → no execution attempts)
//   - Gate error handling
//   - Blocked mode routing (BlockedExecutionAdapter)
//   - Paper mode routing (PaperExecutionPolicy)
//   - Fail-closed live mode (LiveExecutionAdapter with null port)
//   - Exact-once consumption across repeated ticks
//
// Uses :memory: SQLite — no disk persistence required.
// Deterministic guards (no real-time sleeps).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import { StrategyDecisionRepository } from '../src/persistence/strategy-decision-repo.js';
import { ExecutionAttemptRepository } from '../src/persistence/execution-attempt-repo.js';
import { ProposalEngine, type EngineContext } from '../src/proposals/proposal-engine.js';
import { IndiaProposalValidator } from '../src/proposals/india-validator.js';
import { ProposalSupervisor } from '../src/proposals/proposal-supervisor.js';
import { ExecutionGateSupervisor } from '../src/execution/execution-gate-supervisor.js';
import { ModeAwareExecutionService } from '../src/execution/mode-aware-execution-service.js';
import { PaperExecutionPolicy } from '../src/execution/paper-execution-policy.js';
import { BlockedExecutionAdapter, LiveExecutionAdapter } from '../src/execution/execution-adapters.js';
import {
  ProposalStatus,
  StrategyDecisionStatus,
  ExecutionMode,
  ExecutionAttemptStatus,
  ExecutionOutcomeCode,
  ValidationReasonCode,
  MarketPhase,
  ZerodhaSessionState,
  type ProposalEngineConfig,
  type HealthStatus,
  type NewStrategyDecision,
} from '../src/types/runtime.js';
import type {
  InstrumentRecord,
  QuoteSnapshot,
  InstrumentSyncState,
} from '../src/integrations/broker/types.js';
import type { MarketClock } from '../src/runtime/market-clock.js';

// ---------------------------------------------------------------------------
// Mock services (mirrors S03 test patterns)
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

class MockMarketDataStream {
  private _quotes: Map<string, QuoteSnapshot> = new Map();

  setQuote(key: string, quote: QuoteSnapshot) {
    this._quotes.set(key, quote);
  }

  getLatestQuote(exchange: string, tradingsymbol: string): QuoteSnapshot | null {
    return this._quotes.get(`${exchange}:${tradingsymbol}`) ?? null;
  }
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

/** Create a full test context with supervisor + execution gate. */
function createTestContext(options?: {
  engineConfig?: ProposalEngineConfig;
  marketPhase?: MarketPhase;
  sessionState?: ZerodhaSessionState;
  executionMode?: ExecutionMode;
}) {
  const db = new DatabaseManager(':memory:');
  const proposalRepo = new ProposalRepository(db.db);
  const strategyDecisionRepo = new StrategyDecisionRepository(db.db);
  const attemptRepo = new ExecutionAttemptRepository(db.db);
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
  stream.setQuote('NSE:RELIANCE', sampleQuote());

  const supervisor = new ProposalSupervisor({
    engine,
    validator,
    repo: proposalRepo,
    session: session as any,
    instruments: instruments as any,
    stream: stream as any,
    clock,
    maxProposals: 3,
  });

  // Build execution service with configurable mode (default: blocked)
  const mode = options?.executionMode ?? ExecutionMode.Blocked;
  const paperPolicy = new PaperExecutionPolicy();
  const liveAdapter = new LiveExecutionAdapter(null);
  const blockedAdapter = new BlockedExecutionAdapter();
  const executionService = new ModeAwareExecutionService({
    attemptRepo,
    paperPolicy,
    liveAdapter,
    blockedAdapter,
    mode,
  });

  const executionGate = new ExecutionGateSupervisor({
    strategyDecisionRepo,
    executionService,
    attemptRepo,
  });

  return {
    db,
    proposalRepo,
    strategyDecisionRepo,
    attemptRepo,
    engine,
    validator,
    supervisor,
    executionGate,
    executionService,
    session,
    instruments,
    stream,
    clock,
  };
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

/**
 * Create approved strategy decisions for all accepted proposals.
 * This simulates what the StrategyRiskSupervisor would do between proposal
 * generation and execution gating.
 */
function approveAllAcceptedProposals(
  proposalRepo: ProposalRepository,
  strategyDecisionRepo: StrategyDecisionRepository,
): void {
  const accepted = proposalRepo.getRecentAttempts(100, ProposalStatus.Accepted);
  for (const proposal of accepted) {
    const decision: NewStrategyDecision = {
      proposalAttemptId: proposal.id,
      decisionStatus: StrategyDecisionStatus.Approved,
      strategyId: 'test-strategy',
      strategyVersion: '1.0.0',
      decidedAt: Date.now(),
      exchange: proposal.exchange,
      tradingsymbol: proposal.tradingsymbol,
      side: proposal.side,
      product: proposal.product,
      quantity: proposal.quantity,
      price: proposal.price,
      triggerPrice: proposal.triggerPrice,
      orderType: proposal.orderType,
      quoteLastPrice: null,
      quoteBid: null,
      quoteAsk: null,
      quoteVolume: null,
      quoteReceivedAt: null,
      riskNotional: null,
      riskSizingBasis: 'last_price',
      riskMaxLossRupees: null,
      riskStopDistance: null,
      riskExposureTag: null,
    };
    strategyDecisionRepo.insertDecision(decision);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('S04 Runtime — Execution gate composition', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Same-tick composition ──────────────────────────────────────────────

  describe('Same-tick composition — generate, approve, then execute', () => {
    it('consumes approved proposals from the same tick via execution attempts', async () => {
      const { supervisor, executionGate, proposalRepo, attemptRepo, strategyDecisionRepo, clock } =
        createTestContext();
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
        ],
      });

      // Simulate a scheduler tick: proposal supervisor → strategy-risk → execution gate
      await supervisor.doWork(new Date(), minimalHealth());
      approveAllAcceptedProposals(proposalRepo, strategyDecisionRepo);
      await executionGate.doWork(new Date(), minimalHealth());

      // Verify: one accepted proposal
      const accepted = proposalRepo.getRecentAttempts(10, ProposalStatus.Accepted);
      expect(accepted.length).toBe(1);

      // Verify: one execution attempt row was created (consumed)
      const attempts = attemptRepo.getRecent();
      expect(attempts.length).toBe(1);
      expect(attempts[0].status).toBe(ExecutionAttemptStatus.Refused);
      expect(attempts[0].executionMode).toBe(ExecutionMode.Blocked);

      // Verify: no unconsumed candidates remain
      const remaining = strategyDecisionRepo.getApprovedUnconsumedCandidates();
      expect(remaining.length).toBe(0);
    });

    it('consumes multiple approved proposals from the same tick', async () => {
      const { supervisor, executionGate, attemptRepo, strategyDecisionRepo, proposalRepo, clock } =
        createTestContext();
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
            exchange: 'NSE',
            tradingsymbol: 'RELIANCE',
            side: 'sell',
            product: 'CNC',
            quantity: 5,
            price: 3000.00,
            triggerPrice: null,
            orderType: 'LIMIT',
          },
        ],
      });

      await supervisor.doWork(new Date(), minimalHealth());
      approveAllAcceptedProposals(proposalRepo, strategyDecisionRepo);
      await executionGate.doWork(new Date(), minimalHealth());

      const attempts = attemptRepo.getRecent();
      expect(attempts.length).toBe(2);

      // Both should be refused with blocked mode
      for (const attempt of attempts) {
        expect(attempt.status).toBe(ExecutionAttemptStatus.Refused);
        expect(attempt.executionMode).toBe(ExecutionMode.Blocked);
      }
    });
  });

  // ── Refused/skipped exclusion ──────────────────────────────────────────

  describe('Refused/skipped exclusion', () => {
    it('creates zero execution attempts when all proposals are refused (market closed)', async () => {
      const { supervisor, executionGate, attemptRepo, clock } =
        createTestContext({ marketPhase: MarketPhase.Closed });

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
      await executionGate.doWork(new Date(), minimalHealth());

      expect(attemptRepo.count()).toBe(0);
    });

    it('creates zero execution attempts when provider returns empty proposals', async () => {
      const { supervisor, executionGate, attemptRepo, clock } =
        createTestContext();
      clock.setPhase(MarketPhase.Regular);

      mockFetchJson({ proposals: [] });

      await supervisor.doWork(new Date(), minimalHealth());
      await executionGate.doWork(new Date(), minimalHealth());

      // Engine persisted refusal; gate should produce no execution attempts
      expect(attemptRepo.count()).toBe(0);
    });

    it('creates zero execution attempts on provider network error', async () => {
      const { supervisor, executionGate, attemptRepo, clock } =
        createTestContext();
      clock.setPhase(MarketPhase.Regular);

      mockFetchNetworkError('ETIMEDOUT');

      // Suppress console.error from supervisor error handling
      const originalError = console.error;
      console.error = vi.fn();

      await supervisor.doWork(new Date(), minimalHealth());
      await executionGate.doWork(new Date(), minimalHealth());

      console.error = originalError;

      expect(attemptRepo.count()).toBe(0);
    });
  });

  // ── Gate replay idempotency ────────────────────────────────────────────

  describe('Gate replay idempotency', () => {
    it('does not create duplicate execution attempts on repeated gate runs', async () => {
      const { supervisor, executionGate, attemptRepo, strategyDecisionRepo, proposalRepo, clock } =
        createTestContext();
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
        ],
      });

      // First tick: generate → approve → execute
      await supervisor.doWork(new Date(), minimalHealth());
      approveAllAcceptedProposals(proposalRepo, strategyDecisionRepo);
      await executionGate.doWork(new Date(), minimalHealth());

      // Second tick: no new proposals, but gate runs again
      mockFetchJson({ proposals: [] });
      await supervisor.doWork(new Date(), minimalHealth());
      await executionGate.doWork(new Date(), minimalHealth());

      // Still exactly 1 execution attempt row
      expect(attemptRepo.count()).toBe(1);
    });

    it('handles repeated gate runs without any approved candidates', async () => {
      const { executionGate, attemptRepo, clock } = createTestContext();
      clock.setPhase(MarketPhase.Regular);

      // Do three gate runs with no prior approved candidates
      await executionGate.doWork(new Date(), minimalHealth());
      await executionGate.doWork(new Date(), minimalHealth());
      await executionGate.doWork(new Date(), minimalHealth());

      expect(attemptRepo.count()).toBe(0);
    });
  });

  // ── Gate standalone (no proposals) ─────────────────────────────────────

  describe('Gate standalone — no proposals', () => {
    it('produces zero execution attempts when no proposals exist in the DB', async () => {
      const { executionGate, attemptRepo } = createTestContext();

      await executionGate.doWork(new Date(), minimalHealth());

      expect(attemptRepo.count()).toBe(0);
      expect(attemptRepo.getRecent()).toEqual([]);
    });
  });

  // ── Blocked mode routing ───────────────────────────────────────────────

  describe('Blocked mode routing', () => {
    it('refuses all candidates with ModeBlocked in blocked mode', async () => {
      const { proposalRepo, strategyDecisionRepo, executionGate, attemptRepo } = createTestContext();

      // Insert an accepted proposal with a strategy decision directly
      const proposal = proposalRepo.insertAttempt({
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        instrumentToken: 123456,
        side: 'buy',
        product: 'MIS',
        quantity: 1,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        tag: null,
        proposalStatus: ProposalStatus.Accepted,
        createdAt: Date.now(),
      });

      const decision = strategyDecisionRepo.insertDecision({
        proposalAttemptId: proposal.id,
        decisionStatus: StrategyDecisionStatus.Approved,
        strategyId: 'test-strategy',
        strategyVersion: '1.0.0',
        decidedAt: Date.now(),
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        side: 'buy',
        product: 'MIS',
        quantity: 1,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        quoteLastPrice: null,
        quoteBid: null,
        quoteAsk: null,
        quoteVolume: null,
        quoteReceivedAt: null,
        riskNotional: null,
        riskSizingBasis: 'last_price',
        riskMaxLossRupees: null,
        riskStopDistance: null,
        riskExposureTag: null,
      });

      await executionGate.doWork(new Date(), minimalHealth());

      const attempts = attemptRepo.getRecent();
      expect(attempts.length).toBe(1);
      expect(attempts[0].strategyDecisionId).toBe(decision.id);
      expect(attempts[0].status).toBe(ExecutionAttemptStatus.Refused);
      expect(attempts[0].outcomeCode).toBeNull();

      // Verify refusal reason
      const reasons = attemptRepo.getRefusalReasons(attempts[0].id);
      expect(reasons.length).toBe(1);
      expect(reasons[0].reasonCode).toBe('mode_blocked');
    });
  });

  // ── Paper mode routing ─────────────────────────────────────────────────

  describe('Paper mode routing', () => {
    it('routes candidates through paper evaluation when mode is paper', async () => {
      const { proposalRepo, strategyDecisionRepo, attemptRepo, clock } = createTestContext({
        executionMode: ExecutionMode.Paper,
      });
      clock.setPhase(MarketPhase.Regular);

      // Create the execution gate with paper mode
      const paperPolicy = new PaperExecutionPolicy();
      const liveAdapter = new LiveExecutionAdapter(null);
      const blockedAdapter = new BlockedExecutionAdapter();
      const executionService = new ModeAwareExecutionService({
        attemptRepo,
        paperPolicy,
        liveAdapter,
        blockedAdapter,
        mode: ExecutionMode.Paper,
      });
      const executionGate = new ExecutionGateSupervisor({
        strategyDecisionRepo,
        executionService,
        attemptRepo,
      });

      // Insert an accepted proposal with a strategy decision
      const proposal = proposalRepo.insertAttempt({
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        instrumentToken: 123456,
        side: 'buy',
        product: 'MIS',
        quantity: 1,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        tag: null,
        proposalStatus: ProposalStatus.Accepted,
        createdAt: Date.now(),
      });

      const decision = strategyDecisionRepo.insertDecision({
        proposalAttemptId: proposal.id,
        decisionStatus: StrategyDecisionStatus.Approved,
        strategyId: 'test-strategy',
        strategyVersion: '1.0.0',
        decidedAt: Date.now(),
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        side: 'buy',
        product: 'MIS',
        quantity: 1,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        quoteLastPrice: null,
        quoteBid: null,
        quoteAsk: null,
        quoteVolume: null,
        quoteReceivedAt: null,
        riskNotional: null,
        riskSizingBasis: 'last_price',
        riskMaxLossRupees: null,
        riskStopDistance: null,
        riskExposureTag: null,
      });

      // Since we pass null quote/instrument from the gate, paper policy will
      // refuse with StaleOrMissingQuote — that's expected behavior when no
      // market data is available
      await executionGate.doWork(new Date(), minimalHealth());

      const attempts = attemptRepo.getRecent();
      expect(attempts.length).toBe(1);
      expect(attempts[0].strategyDecisionId).toBe(decision.id);
      expect(attempts[0].executionMode).toBe(ExecutionMode.Paper);

      // With null quote, paper policy will refuse
      expect(attempts[0].status).toBe(ExecutionAttemptStatus.Refused);
      const reasons = attemptRepo.getRefusalReasons(attempts[0].id);
      expect(reasons.length).toBeGreaterThanOrEqual(1);
      expect(reasons[0].reasonCode).toBe('stale_or_missing_quote');
    });
  });

  // ── Fail-closed live mode ──────────────────────────────────────────────

  describe('Fail-closed live mode', () => {
    it('refuses all candidates when live mode has no broker placement port', async () => {
      const { proposalRepo, strategyDecisionRepo, attemptRepo, clock } = createTestContext({
        executionMode: ExecutionMode.Live,
      });
      clock.setPhase(MarketPhase.Regular);

      // Create the execution gate with live mode (null live adapter)
      const paperPolicy = new PaperExecutionPolicy();
      const liveAdapter = new LiveExecutionAdapter(null);
      const blockedAdapter = new BlockedExecutionAdapter();
      const executionService = new ModeAwareExecutionService({
        attemptRepo,
        paperPolicy,
        liveAdapter,
        blockedAdapter,
        mode: ExecutionMode.Live,
      });
      const executionGate = new ExecutionGateSupervisor({
        strategyDecisionRepo,
        executionService,
        attemptRepo,
      });

      // Insert an accepted proposal with a strategy decision
      const proposal = proposalRepo.insertAttempt({
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        instrumentToken: 123456,
        side: 'buy',
        product: 'MIS',
        quantity: 1,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        tag: null,
        proposalStatus: ProposalStatus.Accepted,
        createdAt: Date.now(),
      });

      strategyDecisionRepo.insertDecision({
        proposalAttemptId: proposal.id,
        decisionStatus: StrategyDecisionStatus.Approved,
        strategyId: 'test-strategy',
        strategyVersion: '1.0.0',
        decidedAt: Date.now(),
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        side: 'buy',
        product: 'MIS',
        quantity: 1,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        quoteLastPrice: null,
        quoteBid: null,
        quoteAsk: null,
        quoteVolume: null,
        quoteReceivedAt: null,
        riskNotional: null,
        riskSizingBasis: 'last_price',
        riskMaxLossRupees: null,
        riskStopDistance: null,
        riskExposureTag: null,
      });

      await executionGate.doWork(new Date(), minimalHealth());

      const attempts = attemptRepo.getRecent();
      expect(attempts.length).toBe(1);
      expect(attempts[0].executionMode).toBe(ExecutionMode.Live);
      expect(attempts[0].status).toBe(ExecutionAttemptStatus.Refused);

      // Live broker not configured should be the reason
      const reasons = attemptRepo.getRefusalReasons(attempts[0].id);
      expect(reasons.length).toBeGreaterThanOrEqual(1);
      expect(reasons[0].reasonCode).toBe('live_broker_not_configured');
    });
  });

  // ── Exact-once consumption ─────────────────────────────────────────────

  describe('Exact-once consumption', () => {
    it('cannot re-consume the same strategy decision across multiple ticks', async () => {
      const { supervisor, executionGate, attemptRepo, strategyDecisionRepo, proposalRepo, clock } =
        createTestContext();
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
        ],
      });

      // Tick 1: generate → approve → execute
      await supervisor.doWork(new Date(), minimalHealth());
      approveAllAcceptedProposals(proposalRepo, strategyDecisionRepo);
      await executionGate.doWork(new Date(), minimalHealth());

      expect(attemptRepo.count()).toBe(1);

      // Tick 2: same state, gate runs again — no new candidates to consume
      mockFetchJson({ proposals: [] });
      await supervisor.doWork(new Date(), minimalHealth());
      await executionGate.doWork(new Date(), minimalHealth());

      // Still exactly 1 — the second tick found zero unconsumed candidates
      expect(attemptRepo.count()).toBe(1);

      // Tick 3: verify idempotency holds across repeated ticks
      await executionGate.doWork(new Date(), minimalHealth());
      expect(attemptRepo.count()).toBe(1);
    });

    it('consumes strategy-approved candidates, not raw accepted proposals', async () => {
      const { proposalRepo, strategyDecisionRepo, executionGate, attemptRepo } = createTestContext();

      // Insert an accepted proposal WITHOUT a strategy decision
      const proposal = proposalRepo.insertAttempt({
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        instrumentToken: 123456,
        side: 'buy',
        product: 'MIS',
        quantity: 1,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        tag: null,
        proposalStatus: ProposalStatus.Accepted,
        createdAt: Date.now(),
      });

      // Gate should not consume it — no strategy decision exists
      await executionGate.doWork(new Date(), minimalHealth());

      expect(attemptRepo.count()).toBe(0);

      // Now add a strategy decision
      strategyDecisionRepo.insertDecision({
        proposalAttemptId: proposal.id,
        decisionStatus: StrategyDecisionStatus.Approved,
        strategyId: 'test-strategy',
        strategyVersion: '1.0.0',
        decidedAt: Date.now(),
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        side: 'buy',
        product: 'MIS',
        quantity: 1,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        quoteLastPrice: null,
        quoteBid: null,
        quoteAsk: null,
        quoteVolume: null,
        quoteReceivedAt: null,
        riskNotional: null,
        riskSizingBasis: 'last_price',
        riskMaxLossRupees: null,
        riskStopDistance: null,
        riskExposureTag: null,
      });

      // Gate should now consume it
      await executionGate.doWork(new Date(), minimalHealth());

      expect(attemptRepo.count()).toBe(1);
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────

  describe('Gate error handling', () => {
    it('throws on DB failure but does not crash process', async () => {
      // Create a context specifically so we can close the DB
      const context = createTestContext();
      const { executionGate } = context;

      // Close the DB to simulate a failure
      context.db.db.close();

      // The gate should throw (which the scheduler will catch and degrade)
      await expect(
        executionGate.doWork(new Date(), minimalHealth()),
      ).rejects.toThrow();
    });
  });

  // ── Negative tests ─────────────────────────────────────────────────────

  describe('Negative tests — candidate edge cases', () => {
    it('handles approved strategy decisions with null price and triggerPrice', async () => {
      const { proposalRepo, strategyDecisionRepo, executionGate, attemptRepo } = createTestContext();

      // Insert an accepted proposal with null prices
      const proposal = proposalRepo.insertAttempt({
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        instrumentToken: 123456,
        side: 'buy',
        product: 'MIS',
        quantity: 1,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        tag: null,
        proposalStatus: ProposalStatus.Accepted,
        createdAt: Date.now(),
      });

      // Create a strategy decision with null prices
      strategyDecisionRepo.insertDecision({
        proposalAttemptId: proposal.id,
        decisionStatus: StrategyDecisionStatus.Approved,
        strategyId: 'test-strategy',
        strategyVersion: '1.0.0',
        decidedAt: Date.now(),
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        side: 'buy',
        product: 'MIS',
        quantity: 1,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        quoteLastPrice: null,
        quoteBid: null,
        quoteAsk: null,
        quoteVolume: null,
        quoteReceivedAt: null,
        riskNotional: null,
        riskSizingBasis: 'last_price',
        riskMaxLossRupees: null,
        riskStopDistance: null,
        riskExposureTag: null,
      });

      await executionGate.doWork(new Date(), minimalHealth());

      // Blocked mode should still produce a refused attempt regardless of null prices
      const attempts = attemptRepo.getRecent();
      expect(attempts.length).toBe(1);
      expect(attempts[0].status).toBe(ExecutionAttemptStatus.Refused);
    });

    it('handles SL proposals with both price and triggerPrice', async () => {
      const { proposalRepo, strategyDecisionRepo, executionGate, attemptRepo } = createTestContext();

      const proposal = proposalRepo.insertAttempt({
        exchange: 'NSE',
        tradingsymbol: 'SBIN',
        instrumentToken: 789012,
        side: 'sell',
        product: 'MIS',
        quantity: 1,
        price: 500.00,
        triggerPrice: 505.00,
        orderType: 'SL',
        tag: null,
        proposalStatus: ProposalStatus.Accepted,
        createdAt: Date.now(),
      });

      strategyDecisionRepo.insertDecision({
        proposalAttemptId: proposal.id,
        decisionStatus: StrategyDecisionStatus.Approved,
        strategyId: 'test-strategy',
        strategyVersion: '1.0.0',
        decidedAt: Date.now(),
        exchange: 'NSE',
        tradingsymbol: 'SBIN',
        side: 'sell',
        product: 'MIS',
        quantity: 1,
        price: 500.00,
        triggerPrice: 505.00,
        orderType: 'SL',
        quoteLastPrice: null,
        quoteBid: null,
        quoteAsk: null,
        quoteVolume: null,
        quoteReceivedAt: null,
        riskNotional: null,
        riskSizingBasis: 'last_price',
        riskMaxLossRupees: null,
        riskStopDistance: null,
        riskExposureTag: null,
      });

      await executionGate.doWork(new Date(), minimalHealth());

      const attempts = attemptRepo.getRecent();
      expect(attempts.length).toBe(1);
      expect(attempts[0].status).toBe(ExecutionAttemptStatus.Refused);
    });
  });

  // ── Diagnostic surface ─────────────────────────────────────────────────

  describe('Diagnostic surface', () => {
    it('reports execution attempt count via getExecutionAttemptCount', async () => {
      const { executionGate, proposalRepo, strategyDecisionRepo, attemptRepo } = createTestContext();

      expect(executionGate.getExecutionAttemptCount()).toBe(0);

      // Insert an accepted proposal with a strategy decision
      const proposal = proposalRepo.insertAttempt({
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        instrumentToken: 123456,
        side: 'buy',
        product: 'MIS',
        quantity: 1,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        tag: null,
        proposalStatus: ProposalStatus.Accepted,
        createdAt: Date.now(),
      });

      strategyDecisionRepo.insertDecision({
        proposalAttemptId: proposal.id,
        decisionStatus: StrategyDecisionStatus.Approved,
        strategyId: 'test-strategy',
        strategyVersion: '1.0.0',
        decidedAt: Date.now(),
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        side: 'buy',
        product: 'MIS',
        quantity: 1,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        quoteLastPrice: null,
        quoteBid: null,
        quoteAsk: null,
        quoteVolume: null,
        quoteReceivedAt: null,
        riskNotional: null,
        riskSizingBasis: 'last_price',
        riskMaxLossRupees: null,
        riskStopDistance: null,
        riskExposureTag: null,
      });

      await executionGate.doWork(new Date(), minimalHealth());

      // After execution, count should be 1
      expect(executionGate.getExecutionAttemptCount()).toBe(1);
    });

    it('reports the active execution mode', async () => {
      const { executionGate } = createTestContext({ executionMode: ExecutionMode.Blocked });

      expect(executionGate.mode).toBe(ExecutionMode.Blocked);
    });

    it('reports paper mode correctly', async () => {
      const { attemptRepo, strategyDecisionRepo, proposalRepo } = createTestContext();

      const paperPolicy = new PaperExecutionPolicy();
      const liveAdapter = new LiveExecutionAdapter(null);
      const blockedAdapter = new BlockedExecutionAdapter();
      const executionService = new ModeAwareExecutionService({
        attemptRepo,
        paperPolicy,
        liveAdapter,
        blockedAdapter,
        mode: ExecutionMode.Paper,
      });
      const executionGate = new ExecutionGateSupervisor({
        strategyDecisionRepo,
        executionService,
        attemptRepo,
      });

      expect(executionGate.mode).toBe(ExecutionMode.Paper);
    });
  });
});
