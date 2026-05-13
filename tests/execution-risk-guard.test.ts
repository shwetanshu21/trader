// ── ExecutionRiskGuard unit tests ──
//
// Covers:
//   - Market closed → refuse with persisted event
//   - Kill-switch latched → refuse
//   - Duplicate active order → refuse + event
//   - Max open positions exceeded → refuse + event
//   - Max orders per instrument exceeded → refuse + event
//   - Aggregate exposure cap exceeded → refuse + event
//   - Daily loss limit breached → halt + latch + event
//   - Daily loss limit not breached → allow
//   - All checks pass → allow
//   - Missing/stale quote for MTM → refuse
//   - Zero limits (not configured) → skip those checks
//   - Negative price / zero quantity → handled gracefully
//   - Restart-safe: persisted risk state observable on operator surfaces

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ExecutionRiskRepository } from '../src/persistence/execution-risk-repo.js';
import { PaperOrderRepository } from '../src/persistence/paper-order-repo.js';
import { PaperPositionRepository } from '../src/persistence/paper-position-repo.js';
import { BrokerRepository } from '../src/persistence/broker-repo.js';
import { MarketClock } from '../src/runtime/market-clock.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';
import {
  ExecutionRiskGuard,
  ExecutionGuardVerdict,
  GuardRefusalCode,
} from '../src/execution/execution-risk-guard.js';
import {
  HaltState,
  HaltSource,
  PaperOrderStatus,
  PositionSide,
  PositionEventType,
  type RiskLimits,
  type StrategyApprovedCandidate,
  type NewPaperOrder,
  type NewPaperPosition,
  type NewPositionEvent,
  type NewPaperFill,
  type NewExecutionAttempt,
  ExecutionAttemptStatus,
  ExecutionMode,
  ExecutionOutcomeCode,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.now();

// Fixed test timestamp for a Monday 12:00 IST regular session
// (Monday 2025-01-06 12:00 IST = 2025-01-06 06:30 UTC)
const TEST_NOW_MS = new Date(Date.UTC(2025, 0, 6, 6, 30, 0)).getTime();

function sampleCandidate(overrides?: Partial<StrategyApprovedCandidate>): StrategyApprovedCandidate {
  return {
    id: 1001,
    proposalAttemptId: 42,
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    decidedAt: NOW - 60_000,
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    side: 'buy',
    product: 'MIS',
    quantity: 75,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    lastPrice: 2850.50,
    bid: 2850.00,
    ask: 2851.00,
    notional: 213787.50,
    sizingBasis: 'last_price',
    ...overrides,
  };
}

const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxOpenPositions: 10,
  maxOrdersPerInstrument: 1,
  maxDailyLossRupees: 50000,
  maxExposureRupees: 10_000_000,
  marketHoursStalenessMs: 120_000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestContext {
  riskRepo: ExecutionRiskRepository;
  orderRepo: PaperOrderRepository;
  positionRepo: PaperPositionRepository;
  brokerRepo: BrokerRepository;
  guard: ExecutionRiskGuard;
  db: Database.Database;
}

function createContext(limits: RiskLimits = DEFAULT_RISK_LIMITS): TestContext {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;
  // Disable foreign keys for unit testing — paper_orders FK on execution_attempts
  // is not needed when testing guard query logic
  db.pragma('foreign_keys = OFF');
  const riskRepo = new ExecutionRiskRepository(db);
  const orderRepo = new PaperOrderRepository(db);
  const positionRepo = new PaperPositionRepository(db);
  const brokerRepo = new BrokerRepository(db);
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const guard = new ExecutionRiskGuard({
    riskRepo,
    marketClock: clock,
    riskLimits: limits,
    positionRepo,
    orderRepo,
    brokerRepo,
  });
  return { riskRepo, orderRepo, positionRepo, brokerRepo, guard, db };
}

/**
 * Seed the broker repo with a quote snapshot so MTM computations work.
 */
function seedQuote(brokerRepo: BrokerRepository, overrides?: Record<string, unknown>): void {
  brokerRepo.upsertQuote({
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
    priceTimestamp: Math.floor(TEST_NOW_MS / 1000) - 30,
    receivedAt: TEST_NOW_MS - 5000,
    ...overrides,
  } as any);
}

/**
 * Seed a paper order for duplicate-check tests.
 */
function seedActiveOrder(
  orderRepo: PaperOrderRepository,
  overrides?: Partial<NewPaperOrder>,
): void {
  orderRepo.insert({
    executionAttemptId: 1,
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    side: 'buy',
    product: 'MIS',
    quantity: 10,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: null,
    status: PaperOrderStatus.Pending,
    brokerOrderId: 'paper-test-1',
    createdAt: NOW - 10_000,
    updatedAt: null,
    ...overrides,
  });
}

/**
 * Seed an open position for exposure/daily-loss tests.
 */
function seedOpenPosition(
  positionRepo: PaperPositionRepository,
  overrides?: Partial<NewPaperPosition>,
): void {
  positionRepo.upsertPosition({
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    product: 'MIS',
    side: PositionSide.Long,
    quantity: 75,
    avgCostPrice: 2800.00,
    realizedPnl: 0,
    updatedAt: NOW - 60_000,
    ...overrides,
  });
}

/**
 * Seed a closed position with realized PnL for daily-loss tests.
 */
function seedClosedPositionWithPnl(
  positionRepo: PaperPositionRepository,
  tradingsymbol: string,
  realizedPnl: number,
): void {
  positionRepo.upsertPosition({
    exchange: 'NSE',
    tradingsymbol,
    product: 'MIS',
    side: PositionSide.Flat,
    quantity: 0,
    avgCostPrice: 0,
    realizedPnl,
    updatedAt: NOW - 30_000,
  });
}

// ── Build a regular-session time using the fixed test timestamp ──
function regularSessionNow(): Date {
  return new Date(TEST_NOW_MS);
}

function closedSessionNow(): Date {
  // 16:30 IST = 11:00 UTC on the same day
  return new Date(new Date(TEST_NOW_MS).setUTCHours(11, 0, 0, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExecutionRiskGuard — market hours gating', () => {
  it('refuses when market is closed', () => {
    const { guard, riskRepo } = createContext();
    // Saturday at 12:00 IST → Closed
    const closedNow = new Date(Date.UTC(2025, 0, 4, 6, 30, 0)); // Sat 12:00 IST = 06:30 UTC

    const result = guard.evaluate(sampleCandidate(), closedNow);
    expect(result.verdict).toBe(ExecutionGuardVerdict.Refuse);
    expect(result.refusalReasons[0].reasonCode).toBe(GuardRefusalCode.MarketClosed);

    // Verify a risk event was persisted
    const events = riskRepo.getRecentEventsByType('refusal');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].message).toContain('not in regular session');
  });

  it('refuses during pre-market', () => {
    const { guard, riskRepo } = createContext();
    // Mon 09:05 IST → PreMarket
    const pre = new Date(Date.UTC(2025, 0, 6, 3, 35, 0)); // 09:05 IST = 03:35 UTC

    const result = guard.evaluate(sampleCandidate(), pre);
    expect(result.verdict).toBe(ExecutionGuardVerdict.Refuse);
    expect(result.refusalReasons[0].reasonCode).toBe(GuardRefusalCode.MarketClosed);
    expect(result.refusalReasons[0].reasonMessage).toContain('pre_market');
  });

  it('refuses during post-market', () => {
    const { guard } = createContext();
    // Mon 15:45 IST → PostMarket
    const post = new Date(Date.UTC(2025, 0, 6, 10, 15, 0)); // 15:45 IST = 10:15 UTC

    const result = guard.evaluate(sampleCandidate(), post);
    expect(result.verdict).toBe(ExecutionGuardVerdict.Refuse);
    expect(result.refusalReasons[0].reasonCode).toBe(GuardRefusalCode.MarketClosed);
    expect(result.refusalReasons[0].reasonMessage).toContain('post_market');
  });

  it('allows during regular session', () => {
    const { guard } = createContext();
    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    // Should fail at a later check or pass — but not at market hours
    expect(result.refusalReasons.every(r => r.reasonCode !== GuardRefusalCode.MarketClosed)).toBe(true);
  });
});

describe('ExecutionRiskGuard — kill-switch latch', () => {
  it('refuses when risk latch is active', () => {
    const { guard, riskRepo } = createContext();
    riskRepo.latchHalt(HaltSource.Operator, 'Manual kill-switch engaged', NOW - 5000);

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Refuse);
    expect(result.refusalReasons[0].reasonCode).toBe(GuardRefusalCode.KillSwitchActive);
    expect(result.refusalReasons[0].reasonMessage).toContain('Manual kill-switch');
  });

  it('refuses with reason from prior halt', () => {
    const { guard, riskRepo } = createContext();
    riskRepo.latchHalt(HaltSource.DailyLoss, 'Daily loss limit hit at -51000', NOW - 5000);

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Refuse);
    expect(result.refusalReasons[0].reasonMessage).toContain('Daily loss limit hit');
  });

  it('allows when no active latch', () => {
    const { guard } = createContext();
    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.refusalReasons.every(r => r.reasonCode !== GuardRefusalCode.KillSwitchActive)).toBe(true);
  });
});

describe('ExecutionRiskGuard — duplicate order detection', () => {
  it('refuses when active order exists for same (exchange, tradingsymbol, product, side)', () => {
    const { guard, orderRepo, riskRepo } = createContext();
    seedActiveOrder(orderRepo);

    const candidate = sampleCandidate({ side: 'buy', tradingsymbol: 'RELIANCE', exchange: 'NSE', product: 'MIS' });
    const result = guard.evaluate(candidate, regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Refuse);
    expect(result.refusalReasons[0].reasonCode).toBe(GuardRefusalCode.DuplicateActiveOrder);

    // Risk event persisted
    const events = riskRepo.getRecentEventsByType('refusal');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].message).toContain('Duplicate order');
  });

  it('allows when active order has different side', () => {
    const { guard, orderRepo } = createContext();
    seedActiveOrder(orderRepo);

    // Sell while buy is active — different side, not duplicate
    const candidate = sampleCandidate({ side: 'sell' });
    const result = guard.evaluate(candidate, regularSessionNow());
    expect(result.refusalReasons.every(r => r.reasonCode !== GuardRefusalCode.DuplicateActiveOrder)).toBe(true);
  });

  it('allows when active order has different tradingsymbol', () => {
    const { guard, orderRepo } = createContext();
    seedActiveOrder(orderRepo);

    const candidate = sampleCandidate({ tradingsymbol: 'TCS', exchange: 'NSE', product: 'MIS' });
    const result = guard.evaluate(candidate, regularSessionNow());
    expect(result.refusalReasons.every(r => r.reasonCode !== GuardRefusalCode.DuplicateActiveOrder)).toBe(true);
  });

  it('passes when no active orders exist', () => {
    const { guard } = createContext();
    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.refusalReasons.every(r => r.reasonCode !== GuardRefusalCode.DuplicateActiveOrder)).toBe(true);
  });
});

describe('ExecutionRiskGuard — max open positions', () => {
  it('refuses when at max open positions', () => {
    const { guard, positionRepo } = createContext({ ...DEFAULT_RISK_LIMITS, maxOpenPositions: 2 });
    // Seed 2 open positions
    seedOpenPosition(positionRepo, { tradingsymbol: 'RELIANCE', quantity: 75 });
    seedOpenPosition(positionRepo, {
      exchange: 'NSE', tradingsymbol: 'TCS', product: 'MIS',
      side: PositionSide.Long, quantity: 50, avgCostPrice: 3500, realizedPnl: 0, updatedAt: NOW,
    });

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Refuse);
    expect(result.refusalReasons[0].reasonCode).toBe(GuardRefusalCode.MaxOpenPositionsExceeded);
  });

  it('allows when under max open positions', () => {
    const { guard, positionRepo } = createContext({ ...DEFAULT_RISK_LIMITS, maxOpenPositions: 5 });
    seedOpenPosition(positionRepo, { tradingsymbol: 'RELIANCE', quantity: 75 });

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.refusalReasons.every(r => r.reasonCode !== GuardRefusalCode.MaxOpenPositionsExceeded)).toBe(true);
  });

  it('skips check when maxOpenPositions is 0 (no limit)', () => {
    const { guard, positionRepo } = createContext({ ...DEFAULT_RISK_LIMITS, maxOpenPositions: 0 });
    seedOpenPosition(positionRepo, { tradingsymbol: 'RELIANCE', quantity: 75 });

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.refusalReasons.every(r => r.reasonCode !== GuardRefusalCode.MaxOpenPositionsExceeded)).toBe(true);
  });
});

describe('ExecutionRiskGuard — max orders per instrument', () => {
  it('refuses when at max orders per instrument (all sides combined)', () => {
    const { guard, orderRepo } = createContext({ ...DEFAULT_RISK_LIMITS, maxOrdersPerInstrument: 2 });

    // Seed buy + sell active orders for same instrument (2 active orders = at limit)
    seedActiveOrder(orderRepo, { side: 'buy' });
    seedActiveOrder(orderRepo, { executionAttemptId: 2, side: 'buy', brokerOrderId: 'paper-test-2' });

    // Evaluate a sell candidate — no duplicate (different side), but max orders per instrument is hit
    const candidate = sampleCandidate({ side: 'sell' });
    const result = guard.evaluate(candidate, regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Refuse);
    expect(result.refusalReasons[0].reasonCode).toBe(GuardRefusalCode.MaxOrdersPerInstrumentExceeded);
  });

  it('allows when under max orders per instrument', () => {
    const { guard, orderRepo } = createContext({ ...DEFAULT_RISK_LIMITS, maxOrdersPerInstrument: 5 });
    seedActiveOrder(orderRepo, { side: 'buy' });

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.refusalReasons.every(r => r.reasonCode !== GuardRefusalCode.MaxOrdersPerInstrumentExceeded)).toBe(true);
  });

  it('skips check when maxOrdersPerInstrument is 0 (no limit)', () => {
    const { guard } = createContext({ ...DEFAULT_RISK_LIMITS, maxOrdersPerInstrument: 0 });

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.refusalReasons.every(r => r.reasonCode !== GuardRefusalCode.MaxOrdersPerInstrumentExceeded)).toBe(true);
  });
});

describe('ExecutionRiskGuard — exposure cap', () => {
  it('refuses when aggregate exposure would exceed limit', () => {
    const { guard, positionRepo } = createContext({
      ...DEFAULT_RISK_LIMITS,
      maxExposureRupees: 500_000,
    });

    // Seed a position with notional = 75 * 2800 = 210,000
    seedOpenPosition(positionRepo, { tradingsymbol: 'RELIANCE', quantity: 75, avgCostPrice: 2800 });

    // Candidate notional = 75 * 2850.50 = 213,787.5
    // Total = 210,000 + 213,787.5 = 423,787.5 > 500,000? Actually that's under...
    // Let's make it exceed: candidate notional = 300,000
    const candidate = sampleCandidate({ notional: 300_000, quantity: 100, lastPrice: 3000 });

    const result = guard.evaluate(candidate, regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Refuse);
    expect(result.refusalReasons[0].reasonCode).toBe(GuardRefusalCode.ExposureCapExceeded);
  });

  it('allows when aggregate exposure is under limit', () => {
    const { guard, positionRepo } = createContext({
      ...DEFAULT_RISK_LIMITS,
      maxExposureRupees: 1_000_000,
    });

    seedOpenPosition(positionRepo, { tradingsymbol: 'RELIANCE', quantity: 75, avgCostPrice: 2800 });

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.refusalReasons.every(r => r.reasonCode !== GuardRefusalCode.ExposureCapExceeded)).toBe(true);
  });

  it('skips check when maxExposureRupees is 0 (no limit)', () => {
    const { guard } = createContext({ ...DEFAULT_RISK_LIMITS, maxExposureRupees: 0 });

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.refusalReasons.every(r => r.reasonCode !== GuardRefusalCode.ExposureCapExceeded)).toBe(true);
  });

  it('allows when there are no positions (flat portfolio)', () => {
    const { guard } = createContext({ ...DEFAULT_RISK_LIMITS, maxExposureRupees: 100_000 });

    const candidate = sampleCandidate({ notional: 50_000 });
    const result = guard.evaluate(candidate, regularSessionNow());
    expect(result.refusalReasons.every(r => r.reasonCode !== GuardRefusalCode.ExposureCapExceeded)).toBe(true);
  });
});

describe('ExecutionRiskGuard — daily loss limit', () => {
  it('halts the runtime when daily loss exceeds limit', () => {
    const { guard, positionRepo, brokerRepo, riskRepo } = createContext({
      ...DEFAULT_RISK_LIMITS,
      maxDailyLossRupees: 1000,
    });

    // Seed a long position with MTM loss: 75 * (2850.50 - 2800) = 75 * 50.50 = 3787.50 loss... 
    // Actually that's a gain since lastPrice=2850.50 > avgCost=2800.
    // Let's make it a loss: avgCost higher than lastPrice
    seedOpenPosition(positionRepo, {
      tradingsymbol: 'RELIANCE',
      quantity: 75,
      avgCostPrice: 2900.00, // avg cost > lastPrice → unrealized loss
    });

    // Quote gives lastPrice 2850.50 (below avgCost 2900)
    seedQuote(brokerRepo, { lastPrice: 2850.50 });

    // Unrealized MTM loss = (2850.50 - 2900) * 75 = -49.50 * 75 = -3712.50
    // Plus realized PnL from closed positions
    seedClosedPositionWithPnl(positionRepo, 'TCS', -500); // realized loss

    // Total = -500 + -3712.50 = -4212.50 < -1000 → halt
    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Halt);
    expect(result.halted).toBe(true);
    expect(result.haltedSource).toBe(HaltSource.DailyLoss);
    expect(result.refusalReasons[0].reasonCode).toBe(GuardRefusalCode.DailyLossLimitBreached);

    // Verify risk state is now latched
    const state = riskRepo.getCurrentState();
    expect(state.haltState).toBe(HaltState.ActiveHalt);
    expect(state.haltSource).toBe(HaltSource.DailyLoss);
    expect(state.dailyPnlAtHalt).toBeLessThan(-1000);

    // Verify risk events were persisted
    const events = riskRepo.getRecentEventsByType('daily_loss');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].message).toContain('Daily loss limit breached');
  });

  it('allows when daily P&L is within limit (small unrealized loss)', () => {
    const { guard, positionRepo, brokerRepo } = createContext({
      ...DEFAULT_RISK_LIMITS,
      maxDailyLossRupees: 10000,
    });

    seedOpenPosition(positionRepo, {
      tradingsymbol: 'RELIANCE',
      quantity: 75,
      avgCostPrice: 2855.00, // avg cost just above lastPrice
    });
    seedQuote(brokerRepo, { lastPrice: 2850.50 });

    // Unrealized MTM = (2850.50 - 2855) * 75 = -4.50 * 75 = -337.50
    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Allow);
    expect(result.halted).toBe(false);
  });

  it('allows when daily P&L is exactly at threshold (not exceeded)', () => {
    const { guard, positionRepo, brokerRepo } = createContext({
      ...DEFAULT_RISK_LIMITS,
      maxDailyLossRupees: 500,
    });

    // Realized loss of -500 from a closed position
    seedClosedPositionWithPnl(positionRepo, 'TCS', -500);

    // No open positions — no unrealized MTM
    // Total PnL = -500, which is NOT below -500 (it equals the threshold)
    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    // -500 >= -500 → within limit → allow
    expect(result.verdict).toBe(ExecutionGuardVerdict.Allow);
  });

  it('allows when daily P&L is profitable (positive)', () => {
    const { guard, positionRepo, brokerRepo } = createContext({
      ...DEFAULT_RISK_LIMITS,
      maxDailyLossRupees: 10000,
    });

    seedOpenPosition(positionRepo, {
      tradingsymbol: 'RELIANCE',
      quantity: 75,
      avgCostPrice: 2800.00,
    });
    seedQuote(brokerRepo, { lastPrice: 2900.00 }); // profit

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Allow);
  });

  it('skips check when maxDailyLossRupees is 0 (no limit)', () => {
    const { guard, positionRepo, brokerRepo } = createContext({
      ...DEFAULT_RISK_LIMITS,
      maxDailyLossRupees: 0,
    });

    seedOpenPosition(positionRepo, {
      tradingsymbol: 'RELIANCE',
      quantity: 75,
      avgCostPrice: 2900.00, // would be a loss
    });
    seedQuote(brokerRepo, { lastPrice: 2850.50 });

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.refusalReasons.every(r => r.reasonCode !== GuardRefusalCode.DailyLossLimitBreached)).toBe(true);
    expect(result.verdict).toBe(ExecutionGuardVerdict.Allow);
  });

  it('refuses with missing quote for MTM on open position', () => {
    const { guard, positionRepo } = createContext({
      ...DEFAULT_RISK_LIMITS,
      maxDailyLossRupees: 1000,
    });

    // Seed an open position but NO quote in broker repo
    seedOpenPosition(positionRepo, {
      tradingsymbol: 'RELIANCE',
      quantity: 75,
      avgCostPrice: 2900.00,
    });

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Refuse);
    expect(result.refusalReasons[0].reasonCode).toBe(GuardRefusalCode.MissingQuote);
    expect(result.refusalReasons[0].reasonMessage).toContain('missing quote');
  });

  it('refuses with stale quote for MTM on open position', () => {
    const { guard, positionRepo, brokerRepo } = createContext({
      ...DEFAULT_RISK_LIMITS,
      maxDailyLossRupees: 1000,
    });

    seedOpenPosition(positionRepo, {
      tradingsymbol: 'RELIANCE',
      quantity: 75,
      avgCostPrice: 2900.00,
      updatedAt: TEST_NOW_MS - 60_000,
    });

    // Quote is stale (> 5 min old relative to TEST_NOW_MS)
    seedQuote(brokerRepo, {
      lastPrice: 2850.50,
      receivedAt: TEST_NOW_MS - 10 * 60 * 1000, // 10 minutes old
    } as any);

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Refuse);
    expect(result.refusalReasons[0].reasonCode).toBe(GuardRefusalCode.MissingQuote);
    expect(result.refusalReasons[0].reasonMessage).toContain('stale');
  });

  it('computes unrealized MTM correctly for short positions', () => {
    const { guard, positionRepo, brokerRepo } = createContext({
      ...DEFAULT_RISK_LIMITS,
      maxDailyLossRupees: 1000,
    });

    // Short position: avgCost=2800, lastPrice=2850.50 → loss of 50.50 * 75 = 3787.50
    seedOpenPosition(positionRepo, {
      tradingsymbol: 'RELIANCE',
      quantity: -75, // short
      side: PositionSide.Short,
      avgCostPrice: 2800.00,
    });
    seedQuote(brokerRepo, { lastPrice: 2850.50 });

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    // Unrealized loss for short = (2800 - 2850.50) * 75 = -50.50 * 75 = -3787.50 < -1000
    expect(result.verdict).toBe(ExecutionGuardVerdict.Halt);
    expect(result.halted).toBe(true);
  });
});

describe('ExecutionRiskGuard — all checks pass', () => {
  it('allows a valid candidate through all checks', () => {
    const { guard, positionRepo, brokerRepo, orderRepo } = createContext();

    // Set up a clean state: no open positions, no active orders, no close positions
    seedQuote(brokerRepo, { lastPrice: 2850.50 });

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Allow);
    expect(result.refusalReasons).toHaveLength(0);
    expect(result.halted).toBe(false);
    expect(result.haltedSource).toBeNull();
    expect(result.haltedReason).toBeNull();
  });

  it('allows when flat portfolio with no prior trades', () => {
    const { guard } = createContext();

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Allow);
  });
});

describe('ExecutionRiskGuard — short-circuit: market closed comes first', () => {
  it('returns MarketClosed even if kill-switch is also active', () => {
    const { guard, riskRepo } = createContext();
    riskRepo.latchHalt(HaltSource.Operator, 'Kill-switch', NOW - 5000);

    // Market is closed
    const result = guard.evaluate(sampleCandidate(), closedSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Refuse);
    // The first check (market closed) fires, not kill-switch
    expect(result.refusalReasons[0].reasonCode).toBe(GuardRefusalCode.MarketClosed);
  });
});

describe('ExecutionRiskGuard — restart persistence', () => {
  it('halted state is readable from a fresh guard (restart-safe)', () => {
    const { guard, riskRepo, db } = createContext({ ...DEFAULT_RISK_LIMITS, maxDailyLossRupees: 100 });
    const { positionRepo: posRepo, brokerRepo: brRepo } = createContext().guard; // for the seed helpers within the same db context

    // Actually let me use the correct approach - create a fresh guard using the same db
    const ctx = createContext({ ...DEFAULT_RISK_LIMITS, maxDailyLossRupees: 100 });
    const { positionRepo, brokerRepo } = ctx;

    // Seed a position that will trigger daily loss halt
    seedOpenPosition(positionRepo, {
      tradingsymbol: 'RELIANCE',
      quantity: 75,
      avgCostPrice: 3000.00,
    });
    seedQuote(brokerRepo, { lastPrice: 2900.00 }); // (2900-3000)*75 = -7500 < -100 → halt

    // Fresh guard against the same DB
    const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
    const guard2 = new ExecutionRiskGuard({
      riskRepo: ctx.riskRepo,
      marketClock: clock,
      riskLimits: { ...DEFAULT_RISK_LIMITS, maxDailyLossRupees: 100 },
      positionRepo: ctx.positionRepo,
      orderRepo: ctx.orderRepo,
      brokerRepo: ctx.brokerRepo,
    });

    const result = guard2.evaluate(sampleCandidate(), regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Halt);

    // Now verify that even after the halt, state is persisted
    const riskState = ctx.riskRepo.getCurrentState();
    expect(riskState.haltState).toBe(HaltState.ActiveHalt);

    // A third guard (restart) reads the persisted halt
    const guard3 = new ExecutionRiskGuard({
      riskRepo: ctx.riskRepo,
      marketClock: clock,
      riskLimits: { ...DEFAULT_RISK_LIMITS, maxDailyLossRupees: 100 },
      positionRepo: ctx.positionRepo,
      orderRepo: ctx.orderRepo,
      brokerRepo: ctx.brokerRepo,
    });

    const result3 = guard3.evaluate(sampleCandidate({ id: 2002, proposalAttemptId: 99 }), regularSessionNow());
    expect(result3.verdict).toBe(ExecutionGuardVerdict.Refuse);
    expect(result3.refusalReasons[0].reasonCode).toBe(GuardRefusalCode.KillSwitchActive);
    expect(result3.refusalReasons[0].reasonMessage).toContain('Daily loss');
  });
});

describe('ExecutionRiskGuard — edge cases', () => {
  it('handles zero quantity candidate gracefully', () => {
    const { guard } = createContext();
    const candidate = sampleCandidate({ quantity: 0 });

    const result = guard.evaluate(candidate, regularSessionNow());
    // Should still pass market-hours and latch checks, then hit later checks
    // Since quantity=0, notional=0 → no exposure issue
    // Daily loss check would still pass
    expect(result.verdict).toBe(ExecutionGuardVerdict.Allow);
  });

  it('handles null notional gracefully', () => {
    const { guard, positionRepo } = createContext({
      ...DEFAULT_RISK_LIMITS,
      maxExposureRupees: 100_000,
    });

    // Seed a position close to the cap
    seedOpenPosition(positionRepo, { tradingsymbol: 'RELIANCE', quantity: 35, avgCostPrice: 2800 });
    // Current exposure = 35 * 2800 = 98,000
    // Candidate with null notional → falls back to qty * lastPrice = 75 * 2850.50 = 213,787.50
    // Total = 98,000 + 213,787.50 > 100,000 → exceeds
    const candidate = sampleCandidate({ notional: null, lastPrice: 2850.50 });
    const result = guard.evaluate(candidate, regularSessionNow());
    expect(result.verdict).toBe(ExecutionGuardVerdict.Refuse);
    expect(result.refusalReasons[0].reasonCode).toBe(GuardRefusalCode.ExposureCapExceeded);
  });

  it('handles multiple open positions with mixed PnL for daily loss', () => {
    const { guard, positionRepo, brokerRepo } = createContext({
      ...DEFAULT_RISK_LIMITS,
      maxDailyLossRupees: 5000,
    });

    // Position 1: Long RELIANCE → gain (2800→2850.50 = +50.50*75 = +3787.50)
    seedOpenPosition(positionRepo, {
      tradingsymbol: 'RELIANCE',
      quantity: 75,
      avgCostPrice: 2800.00,
    });

    // Position 2: Short TCS → loss (3500→3400 = gain for short = +100*30 = +3000)
    seedOpenPosition(positionRepo, {
      exchange: 'NSE',
      tradingsymbol: 'TCS',
      product: 'MIS',
      side: PositionSide.Short,
      quantity: -30,
      avgCostPrice: 3500.00,
      realizedPnl: 0,
      updatedAt: NOW,
    });

    // Position 3: Long INFY → loss (4500→4300 = -200*20 = -4000)
    seedOpenPosition(positionRepo, {
      exchange: 'NSE',
      tradingsymbol: 'INFY',
      product: 'MIS',
      side: PositionSide.Long,
      quantity: 20,
      avgCostPrice: 4500.00,
      realizedPnl: 0,
      updatedAt: NOW,
    });

    seedQuote(brokerRepo, { tradingsymbol: 'RELIANCE', lastPrice: 2850.50, receivedAt: NOW - 1000 } as any);
    // TCS quote for short position: lastPrice = 3400 (gain: 3500-3400 = +100 * 30 = +3000)
    // But the brokerRepo.getQuote looks up by exchange+tradingsymbol, so we need to insert for TCS too
    const brCtx = brokerRepo as any;

    // Hmm, BrokerRepository uses upsertQuote which does ON CONFLICT(exchange, tradingsymbol)
    // Let me use the public API
    brokerRepo.upsertQuote({
      exchange: 'NSE',
      tradingsymbol: 'TCS',
      instrumentToken: 999,
      lastPrice: 3400,
      change: -100,
      changePercent: -2.86,
      volume: 500000,
      oi: null,
      high: 3550,
      low: 3380,
      open: 3500,
      close: 3500,
      bid: 3399,
      ask: 3401,
      priceTimestamp: Math.floor(NOW / 1000) - 30,
      receivedAt: NOW - 1000,
    } as any);

    brokerRepo.upsertQuote({
      exchange: 'NSE',
      tradingsymbol: 'INFY',
      instrumentToken: 888,
      lastPrice: 4300,
      change: -200,
      changePercent: -4.44,
      volume: 300000,
      oi: null,
      high: 4550,
      low: 4280,
      open: 4500,
      close: 4500,
      bid: 4299,
      ask: 4301,
      priceTimestamp: Math.floor(NOW / 1000) - 30,
      receivedAt: NOW - 1000,
    } as any);

    const result = guard.evaluate(sampleCandidate(), regularSessionNow());
    // Total MTM: RELIANCE +3787.50, TCS +3000, INFY -4000 = +2787.50
    // Realized PnL: 0
    // Total: +2787.50 > -5000 → within limit → allow
    expect(result.verdict).toBe(ExecutionGuardVerdict.Allow);
  });
});
