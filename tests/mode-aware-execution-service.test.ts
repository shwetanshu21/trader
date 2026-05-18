// ── Mode-aware execution service unit tests ──
//
// Covers:
//   - Blocked mode: always refuses with ModeBlocked
//   - Paper mode: simulated fill with valid quote/instrument
//   - Paper mode: refused when quote is missing
//   - Paper mode: refused when instrument is missing
//   - Live mode: fails closed without adapter
//   - Live mode: delegates to adapter when configured
//   - Idempotency: repeated execute returns existing row
//   - All modes produce ExecutionAttemptRow with correct metadata
//   - Machine-readable refusal reasons on all refusal paths
//   - Paper mode with ledger: atomic downstream writes for fills
//   - Paper mode with ledger: refusal paths do not create downstream rows
//   - Paper mode without ledger: backward-compatible existing behavior

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ExecutionAttemptRepository } from '../src/persistence/execution-attempt-repo.js';
import { PaperOrderRepository } from '../src/persistence/paper-order-repo.js';
import { PaperFillRepository } from '../src/persistence/paper-fill-repo.js';
import { PaperPositionRepository } from '../src/persistence/paper-position-repo.js';
import { PaperExecutionLedger } from '../src/execution/paper-execution-ledger.js';
import { StrategyDecisionRepository } from '../src/persistence/strategy-decision-repo.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import {
  ExecutionAttemptStatus,
  ExecutionMode,
  ExecutionOutcomeCode,
  ExecutionRefusalCode,
  PaperOrderStatus,
  ProposalStatus,
  StrategyDecisionStatus,
  type BrokerPlacementPort,
  type OrderPlacementParams,
  type OrderPlacementResult,
  type NewStrategyDecision,
  type StrategyApprovedCandidate,
} from '../src/types/runtime.js';
import type { QuoteSnapshot, InstrumentRecord } from '../src/integrations/broker/types.js';
import { PaperExecutionPolicy } from '../src/execution/paper-execution-policy.js';
import { LiveExecutionAdapter } from '../src/execution/execution-adapters.js';
import { ModeAwareExecutionService } from '../src/execution/mode-aware-execution-service.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.now();

function sampleQuote(overrides?: Partial<QuoteSnapshot>): QuoteSnapshot {
  return {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
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
    priceTimestamp: Math.floor(NOW / 1000) - 30,
    receivedAt: NOW - 5000,
    ...overrides,
  };
}

function sampleInstrument(overrides?: Partial<InstrumentRecord>): InstrumentRecord {
  return {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    name: 'RELIANCE INDUSTRIES LTD',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    instrumentType: 'EQ' as any,
    segment: 'NSE_EQ' as any,
    exchangeToken: 12345,
    ...overrides,
  };
}

/**
 * Quote fixture suitable for FO instrument paper evaluation.
 * The FO candidate is a LIMIT buy at 50, so we need ask >= 50.
 */
function sampleFOQuote(overrides?: Partial<QuoteSnapshot>): QuoteSnapshot {
  return {
    exchange: 'NFO',
    tradingsymbol: 'RELIANCE24DEC3000CE',
    instrumentToken: 789012,
    lastPrice: 48.50,
    change: -1.20,
    changePercent: -2.41,
    volume: 250000,
    oi: 500000,
    high: 51.00,
    low: 47.50,
    open: 49.00,
    close: 49.70,
    bid: 48.00,
    ask: 50.00,
    priceTimestamp: Math.floor(NOW / 1000) - 30,
    receivedAt: NOW - 5000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock BrokerPlacementPort for live mode tests
// ---------------------------------------------------------------------------

class MockPlacementPort implements BrokerPlacementPort {
  readonly isReady: boolean;
  private _placementResult: OrderPlacementResult;
  private _called = false;

  constructor(isReady = true, placementResult?: Partial<OrderPlacementResult>) {
    this.isReady = isReady;
    this._placementResult = {
      success: true,
      brokerOrderId: 'mock-order-001',
      outcomeCode: ExecutionOutcomeCode.OrderPlaced,
      message: 'Mock order placed successfully',
      ...placementResult,
    };
  }

  get called(): boolean {
    return this._called;
  }

  async placeOrder(_params: OrderPlacementParams): Promise<OrderPlacementResult> {
    this._called = true;
    return this._placementResult;
  }

  setResult(result: Partial<OrderPlacementResult>): void {
    this._placementResult = { ...this._placementResult, ...result };
  }
}

// ---------------------------------------------------------------------------
// Test helpers — seed DB with proposal + strategy decision row
// ---------------------------------------------------------------------------

interface TestContext {
  attemptRepo: ExecutionAttemptRepository;
  strategyRepo: StrategyDecisionRepository;
  proposalRepo: ProposalRepository;
  paperPolicy: PaperExecutionPolicy;
  db: Database.Database;
}

function createContext(): TestContext {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;
  return {
    attemptRepo: new ExecutionAttemptRepository(db),
    strategyRepo: new StrategyDecisionRepository(db),
    proposalRepo: new ProposalRepository(db),
    paperPolicy: new PaperExecutionPolicy(),
    db,
  };
}

/**
 * Seed a single proposal + strategy decision pair and return a
 * StrategyApprovedCandidate with the real DB-assigned id.
 */
function seedApprovedCandidate(
  ctx: TestContext,
  overrides?: Partial<NewStrategyDecision>,
): StrategyApprovedCandidate {
  // Insert accepted proposal
  const proposal = ctx.proposalRepo.insertAttempt({
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    side: overrides?.side ?? 'buy',
    product: 'MIS',
    quantity: 75,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: null,
    proposalStatus: ProposalStatus.Accepted,
    createdAt: NOW - 120_000,
  });

  // Build default strategy decision with EQ execution class metadata
  const defaults: NewStrategyDecision = {
    proposalAttemptId: proposal.id,
    decisionStatus: StrategyDecisionStatus.Approved,
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    decidedAt: NOW - 60_000,
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    side: overrides?.side ?? 'buy',
    product: overrides?.product ?? 'MIS',
    quantity: overrides?.quantity ?? 75,
    price: overrides?.price ?? null,
    triggerPrice: overrides?.triggerPrice ?? null,
    orderType: overrides?.orderType ?? 'MARKET',
    quoteLastPrice: 2850.50,
    quoteBid: 2850.00,
    quoteAsk: 2851.00,
    quoteVolume: 1250000,
    quoteReceivedAt: NOW - 5000,
    riskNotional: 213787.50,
    riskSizingBasis: 'last_price',
    riskMaxLossRupees: 10689.38,
    riskStopDistance: null,
    riskExposureTag: 'intraday',
    executionClass: 'EQ' as const,
    segment: 'NSE',
    instrumentType: 'EQ',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    freezeQuantity: null,
    // Spread remaining overrides on top of defaults
    ...overrides,
  };

  const merged: NewStrategyDecision = { ...defaults, ...overrides };

  // Insert approved strategy decision
  const decision = ctx.strategyRepo.insertDecision(merged);

  return {
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
    executionClass: decision.executionClass as 'EQ' | 'FO',
    segment: decision.segment,
    instrumentType: decision.instrumentType,
    expiry: decision.expiry,
    strike: decision.strike,
    lotSize: decision.lotSize,
    tickSize: decision.tickSize,
    freezeQuantity: decision.freezeQuantity,
  };
}

/**
 * Seed an FO candidate with valid defaults through the DB.
 * The candidate carries FO execution-class metadata for class-aware
 * safeguard testing. Overrides can be used to inject violation scenarios.
 */
function seedFOCandidate(
  ctx: TestContext,
  overrides?: Partial<NewStrategyDecision>,
): StrategyApprovedCandidate {
  // Insert accepted proposal
  const proposal = ctx.proposalRepo.insertAttempt({
    exchange: 'NFO',
    tradingsymbol: 'RELIANCE24DEC3000CE',
    instrumentToken: 789012,
    side: 'buy',
    product: 'NRML',
    quantity: 1500,
    price: 50.00,
    triggerPrice: null,
    orderType: 'LIMIT',
    tag: null,
    proposalStatus: ProposalStatus.Accepted,
    createdAt: NOW - 120_000,
  });

  // Build strategy decision defaults with FO execution class metadata
  const defaults: NewStrategyDecision = {
    proposalAttemptId: proposal.id,
    decisionStatus: StrategyDecisionStatus.Approved,
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    decidedAt: NOW - 60_000,
    exchange: 'NFO',
    tradingsymbol: 'RELIANCE24DEC3000CE',
    side: 'buy',
    product: 'NRML',
    quantity: 1500,
    price: 50.00,
    triggerPrice: null,
    orderType: 'LIMIT',
    quoteLastPrice: 48.50,
    quoteBid: 48.00,
    quoteAsk: 50.00,
    quoteVolume: 500000,
    quoteReceivedAt: NOW - 5000,
    riskNotional: 75000,
    riskSizingBasis: 'last_price',
    riskMaxLossRupees: 5000,
    riskStopDistance: null,
    riskExposureTag: 'intraday',
    executionClass: 'FO' as const,
    segment: 'NFO',
    instrumentType: 'CE',
    expiry: '2024-12-26',
    strike: 3000,
    lotSize: 100,
    tickSize: 0.05,
    freezeQuantity: 10000,
  };

  const merged: NewStrategyDecision = { ...defaults, ...overrides };

  // Insert approved strategy decision with merged fields
  const decision = ctx.strategyRepo.insertDecision(merged);

  return {
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
    executionClass: decision.executionClass as 'EQ' | 'FO',
    segment: decision.segment,
    instrumentType: decision.instrumentType,
    expiry: decision.expiry,
    strike: decision.strike,
    lotSize: decision.lotSize,
    tickSize: decision.tickSize,
    freezeQuantity: decision.freezeQuantity,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModeAwareExecutionService', () => {
  describe('blocked mode', () => {
    it('refuses a candidate with ModeBlocked reason', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Blocked,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(row.strategyDecisionId).toBe(candidate.id);
      expect(row.executionMode).toBe(ExecutionMode.Blocked);
      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
      expect(row.outcomeCode).toBeNull();
      expect(row.brokerOrderId).toBeNull();
      expect(row.message).toContain('Blocked');
      expect(row.completedAt).not.toBeNull();

      // Verify refusal reasons were persisted
      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(1);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.ModeBlocked);
    });

    it('persists exactly one attempt row per candidate', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Blocked,
      });

      await service.execute(candidate, sampleQuote(), sampleInstrument());
      const count = ctx.attemptRepo.count();
      expect(count).toBe(1);
    });
  });

  describe('paper mode', () => {
    it('simulates a fill for a valid buy candidate', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(row.executionMode).toBe(ExecutionMode.Paper);
      expect(row.status).toBe(ExecutionAttemptStatus.Completed);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperSimulated);
      expect(row.brokerOrderId).toContain('paper-');
      expect(row.completedAt).not.toBeNull();

      // No refusal reasons for a fill
      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(0);
    });

    it('refuses when quote is missing', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      const row = await service.execute(candidate, null, sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperRejected);

      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(1);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.StaleOrMissingQuote);
    });

    it('refuses when instrument is missing', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      const row = await service.execute(candidate, sampleQuote(), null);

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperRejected);

      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(1);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.MissingInstrumentData);
    });

    it('refuses a sell without valid bid/lastPrice in paper mode', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx, { side: 'sell' });
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      const quote = sampleQuote({ bid: null, lastPrice: null });
      const row = await service.execute(candidate, quote, sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperRejected);

      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(1);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.StaleOrMissingQuote);
    });
  });

  describe('live mode', () => {
    it('fails closed when no adapter is configured', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Live,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(row.executionMode).toBe(ExecutionMode.Live);
      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
      expect(row.outcomeCode).toBeNull();
      expect(row.brokerOrderId).toBeNull();

      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(1);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.LiveBrokerNotConfigured);
    });

    it('fails closed when adapter port is not ready', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const mockPort = new MockPlacementPort(false); // not ready
      const liveAdapter = new LiveExecutionAdapter(mockPort);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter,
        mode: ExecutionMode.Live,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
      expect(mockPort.called).toBe(false); // port was not called because not ready

      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(1);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.LiveBrokerNotConfigured);
    });

    it('delegates to adapter when configured and ready', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const mockPort = new MockPlacementPort(true, {
        success: true,
        brokerOrderId: 'live-order-999',
        outcomeCode: ExecutionOutcomeCode.OrderPlaced,
        message: 'Live order placed successfully',
      });
      const liveAdapter = new LiveExecutionAdapter(mockPort);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter,
        mode: ExecutionMode.Live,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(mockPort.called).toBe(true);
      expect(row.status).toBe(ExecutionAttemptStatus.Completed);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.OrderPlaced);
      expect(row.brokerOrderId).toBe('live-order-999');
    });

    it('records failure when adapter returns unsuccessful result', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const mockPort = new MockPlacementPort(true, {
        success: false,
        brokerOrderId: null,
        outcomeCode: ExecutionOutcomeCode.OrderRejected,
        message: 'Broker rejected the order',
      });
      const liveAdapter = new LiveExecutionAdapter(mockPort);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter,
        mode: ExecutionMode.Live,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(mockPort.called).toBe(true);
      expect(row.status).toBe(ExecutionAttemptStatus.Failed);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.OrderRejected);
    });

    it('does not fall back to paper when live adapter throws', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      // A port that throws on placeOrder
      const throwingPort: BrokerPlacementPort = {
        isReady: true,
        async placeOrder(_params: OrderPlacementParams): Promise<OrderPlacementResult> {
          throw new Error('Connection refused');
        },
      };
      const liveAdapter = new LiveExecutionAdapter(throwingPort);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter,
        mode: ExecutionMode.Live,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      // Must not be paper mode or paper outcome
      expect(row.executionMode).toBe(ExecutionMode.Live);
      expect(row.status).toBe(ExecutionAttemptStatus.Failed);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.OrderRejected);
    });
  });

  describe('idempotency', () => {
    it('returns existing attempt row on repeated execute for same candidate (blocked)', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Blocked,
      });

      const row1 = await service.execute(candidate, sampleQuote(), sampleInstrument());
      const row2 = await service.execute(candidate, sampleQuote(), sampleInstrument());

      // Both return the same row (id matches, only 1 row in DB)
      expect(row1.id).toBe(row2.id);
      const count = ctx.attemptRepo.count();
      expect(count).toBe(1);
    });

    it('returns existing attempt row on repeated execute for same candidate (paper)', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      const row1 = await service.execute(candidate, sampleQuote(), sampleInstrument());
      const row2 = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(row1.id).toBe(row2.id);
      expect(ctx.attemptRepo.count()).toBe(1);
    });

    it('does not multiply execution_attempt rows on repeated attempts', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Blocked,
      });

      await service.execute(candidate, sampleQuote(), sampleInstrument());
      await service.execute(candidate, sampleQuote(), sampleInstrument());
      await service.execute(candidate, sampleQuote(), sampleInstrument());

      // Only 1 attempt row total — idempotency guard prevents duplicates
      const count = ctx.attemptRepo.count();
      expect(count).toBe(1);
    });
  });

  describe('mode routing invariants', () => {
    it('live mode never falls back to paper implicitly', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null, // no live adapter
        mode: ExecutionMode.Live,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      // Must be live mode, not paper
      expect(row.executionMode).toBe(ExecutionMode.Live);

      // Must be refused, not simulated
      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(1);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.LiveBrokerNotConfigured);
    });

    it('paper mode never performs broker network calls', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      // Should succeed without any network — just uses local quote data
      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());
      expect(row.status).toBe(ExecutionAttemptStatus.Completed);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperSimulated);
    });

    it('isLiveReady returns false when no adapter', () => {
      const ctx = createContext();
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Blocked,
      });
      expect(service.isLiveReady).toBe(false);
    });

    it('isLiveReady returns true when adapter is ready', () => {
      const ctx = createContext();
      const mockPort = new MockPlacementPort(true);
      const liveAdapter = new LiveExecutionAdapter(mockPort);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter,
        mode: ExecutionMode.Paper,
      });
      expect(service.isLiveReady).toBe(true);
    });
  });

  describe('paper mode with ledger', () => {
    /**
     * Create a test context with a fully-wired ledger.
     */
    function contextWithLedger(): {
      ctx: ReturnType<typeof createContext>;
      service: ModeAwareExecutionService;
      orderRepo: PaperOrderRepository;
      fillRepo: PaperFillRepository;
      positionRepo: PaperPositionRepository;
    } {
      const ctx = createContext();
      const orderRepo = new PaperOrderRepository(ctx.db);
      const fillRepo = new PaperFillRepository(ctx.db);
      const positionRepo = new PaperPositionRepository(ctx.db);
      const ledger = new PaperExecutionLedger({
        db: ctx.db,
        attemptRepo: ctx.attemptRepo,
        orderRepo,
        fillRepo,
        positionRepo,
      });
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        paperLedger: ledger,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });
      return { ctx, service, orderRepo, fillRepo, positionRepo };
    }

    it('creates downstream order, fill, and position rows for a successful fill', async () => {
      const { ctx, service, orderRepo, fillRepo, positionRepo } = contextWithLedger();
      const candidate = seedApprovedCandidate(ctx);

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      // Attempt should be completed
      expect(row.status).toBe(ExecutionAttemptStatus.Completed);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperSimulated);

      // Verify downstream rows exist via repos
      const order = orderRepo.getByExecutionAttemptId(row.id);
      expect(order).not.toBeNull();
      expect(order!.status).toBe(PaperOrderStatus.Filled);
      expect(order!.brokerOrderId).toBe(row.brokerOrderId);

      const fill = fillRepo.getByExecutionAttemptId(row.id);
      expect(fill).not.toBeNull();
      expect(fill!.filledQuantity).toBe(candidate.quantity);
      expect(fill!.filledPrice).toBeGreaterThan(0);

      const events = positionRepo.getEventsByExecutionAttemptId(row.id);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('open');

      const position = positionRepo.getPosition(
        candidate.exchange, candidate.tradingsymbol, candidate.product,
      );
      expect(position).not.toBeNull();
      expect(position!.quantity).toBe(candidate.quantity);
      expect(position!.side).toBe('long');
    });

    it('does NOT create downstream rows for a refusal (missing quote)', async () => {
      const { ctx, service, orderRepo, fillRepo, positionRepo } = contextWithLedger();
      const candidate = seedApprovedCandidate(ctx);

      const row = await service.execute(candidate, null, sampleInstrument());

      // Attempt should be refused
      expect(row.status).toBe(ExecutionAttemptStatus.Refused);

      // No downstream rows should exist
      expect(orderRepo.count()).toBe(0);
      expect(fillRepo.count()).toBe(0);
      expect(positionRepo.countEvents()).toBe(0);
      expect(positionRepo.countPositions()).toBe(0);
    });

    it('does NOT create downstream rows for a refusal (missing instrument)', async () => {
      const { ctx, service, orderRepo, fillRepo, positionRepo } = contextWithLedger();
      const candidate = seedApprovedCandidate(ctx);

      const row = await service.execute(candidate, sampleQuote(), null);

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);

      expect(orderRepo.count()).toBe(0);
      expect(fillRepo.count()).toBe(0);
      expect(positionRepo.countEvents()).toBe(0);
      expect(positionRepo.countPositions()).toBe(0);
    });

    it('does NOT create downstream rows for a market-price-unknown sell', async () => {
      const { ctx, service, orderRepo, fillRepo, positionRepo } = contextWithLedger();
      const candidate = seedApprovedCandidate(ctx, { side: 'sell' });

      const quote = sampleQuote({ bid: null, lastPrice: null });
      const row = await service.execute(candidate, quote, sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);

      expect(orderRepo.count()).toBe(0);
      expect(fillRepo.count()).toBe(0);
      expect(positionRepo.countEvents()).toBe(0);
      expect(positionRepo.countPositions()).toBe(0);
    });

    it('idempotency guard prevents duplicate downstream rows', async () => {
      const { ctx, service, orderRepo, fillRepo, positionRepo } = contextWithLedger();
      const candidate = seedApprovedCandidate(ctx);

      // First call succeeds
      await service.execute(candidate, sampleQuote(), sampleInstrument());

      // Second call returns existing row (idempotency in execute())
      const row2 = await service.execute(candidate, sampleQuote(), sampleInstrument());

      // Exactly one set of downstream rows
      expect(ctx.attemptRepo.count()).toBe(1);
      expect(orderRepo.count()).toBe(1);
      expect(fillRepo.count()).toBe(1);
      expect(positionRepo.countEvents()).toBe(1);
      expect(positionRepo.countPositions()).toBe(1);

      // Attempt status is Completed (not Refused)
      expect(row2.status).toBe(ExecutionAttemptStatus.Completed);
    });
  });

  describe('paper mode without ledger (backward compat)', () => {
    it('still succeeds without a ledger configured', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Completed);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperSimulated);
      expect(ctx.attemptRepo.count()).toBe(1);
    });

    it('still refuses when missing quote without ledger', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      const row = await service.execute(candidate, null, sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
    });

    it('still refuses when missing instrument without ledger', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      const row = await service.execute(candidate, sampleQuote(), null);

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
    });
  });

  describe('class-aware execution safeguards', () => {
    it('passes EQ candidates through class safeguards with no refusal', async () => {
      const ctx = createContext();
      const candidate = seedApprovedCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      // EQ candidates should pass through with no class-specific refusal
      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Completed);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperSimulated);

      // No class-specific refusal reasons — only paper-policy success
      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(0);
    });

    it('refuses FO candidate with missing expiry metadata', async () => {
      const ctx = createContext();
      const candidate = seedFOCandidate(ctx, { expiry: '' });
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperRejected);

      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(1);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.FOMetadataIncomplete);
      expect(reasons[0].reasonMessage).toContain('expiry');
    });

    it('refuses FO candidate with lot size mismatch', async () => {
      const ctx = createContext();
      // Quantity 75 is not a multiple of lot size 100
      const candidate = seedFOCandidate(ctx, { quantity: 75 });
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperRejected);

      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(1);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.FOLotSizeMismatch);
      expect(reasons[0].reasonMessage).toContain('lot size');
    });

    it('refuses FO candidate exceeding freeze quantity', async () => {
      const ctx = createContext();
      // Quantity 1_500_000 exceeds freezeQuantity 10_000
      const candidate = seedFOCandidate(ctx, { quantity: 1_500_000 });
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperRejected);

      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(1);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.FOFreezeQuantityBreach);
      expect(reasons[0].reasonMessage).toContain('freeze quantity');
    });

    it('refuses FO candidate exceeding market protection notional cap', async () => {
      const ctx = createContext();
      // Notional 6_000_000 exceeds 5_000_000 cap
      const candidate = seedFOCandidate(ctx, { riskNotional: 6_000_000 });
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperRejected);

      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(1);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.FOMarketProtectionBound);
      expect(reasons[0].reasonMessage).toContain('notional');
    });

    it('passes valid FO candidate through class safeguards successfully', async () => {
      const ctx = createContext();
      // Valid FO: has expiry, quantity 1500 is multiple of lot 100,
      // freeze quantity 10000 >= 1500, notional 75000 < 5M
      const candidate = seedFOCandidate(ctx);
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      // Use FO-compatible quote so paper evaluation can complete
      const row = await service.execute(candidate, sampleFOQuote(), sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Completed);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperSimulated);

      // Should proceed to paper evaluation (no class-specific refusal)
      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(0);
    });

    it('refuses FO with multiple safeguard violations at once', async () => {
      const ctx = createContext();
      // Multiple violations: no expiry, wrong lot size, exceeds freeze qty, exceeds notional cap
      const candidate = seedFOCandidate(ctx, {
        expiry: '',
        quantity: 123,
        freezeQuantity: 100,
        riskNotional: 10_000_000,
      });
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperRejected);

      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      // Should have 4 refusal reasons: FOMetadataIncomplete, FOLotSizeMismatch,
      // FOFreezeQuantityBreach, FOMarketProtectionBound
      expect(reasons).toHaveLength(4);
      expect(reasons.map(r => r.reasonCode)).toContain(ExecutionRefusalCode.FOMetadataIncomplete);
      expect(reasons.map(r => r.reasonCode)).toContain(ExecutionRefusalCode.FOLotSizeMismatch);
      expect(reasons.map(r => r.reasonCode)).toContain(ExecutionRefusalCode.FOFreezeQuantityBreach);
      expect(reasons.map(r => r.reasonCode)).toContain(ExecutionRefusalCode.FOMarketProtectionBound);
    });

    it('refuses FO in blocked mode with class safeguards still evaluated first', async () => {
      const ctx = createContext();
      // Even in blocked mode, class safeguards should be evaluated first
      const candidate = seedFOCandidate(ctx, { expiry: '' });
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Blocked,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperRejected);

      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(1);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.FOMetadataIncomplete);
    });

    it('refuses FO in live mode with class safeguards evaluated first', async () => {
      const ctx = createContext();
      const candidate = seedFOCandidate(ctx, {
        quantity: 75, // not a multiple of lot size 100
      });
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Live,
      });

      const row = await service.execute(candidate, sampleQuote(), sampleInstrument());

      expect(row.status).toBe(ExecutionAttemptStatus.Refused);
      expect(row.outcomeCode).toBe(ExecutionOutcomeCode.PaperRejected);

      const reasons = ctx.attemptRepo.getRefusalReasons(row.id);
      expect(reasons).toHaveLength(1);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.FOLotSizeMismatch);
      // Must not reach LiveBrokerNotConfigured
      expect(reasons[0].reasonCode).not.toBe(ExecutionRefusalCode.LiveBrokerNotConfigured);
    });

    it('idempotency guard still works after class safeguard evaluation', async () => {
      const ctx = createContext();
      const candidate = seedFOCandidate(ctx, { expiry: '' });
      const service = new ModeAwareExecutionService({
        attemptRepo: ctx.attemptRepo,
        paperPolicy: ctx.paperPolicy,
        liveAdapter: null,
        mode: ExecutionMode.Paper,
      });

      // First call: refused by class safeguards
      const row1 = await service.execute(candidate, sampleQuote(), sampleInstrument());
      expect(row1.status).toBe(ExecutionAttemptStatus.Refused);

      // Second call: should return existing row (idempotency)
      const row2 = await service.execute(candidate, sampleQuote(), sampleInstrument());
      expect(row2.id).toBe(row1.id);
      expect(ctx.attemptRepo.count()).toBe(1);
    });
  });
});
