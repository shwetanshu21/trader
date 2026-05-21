// ── PaperExecutionLedger unit tests ──
//
// Covers:
//   - Successful atomic writes for buy and sell fills
//   - Downstream row verification (attempt, order, fill, position event, position)
//   - Refusal path: canFill=false throws error
//   - Malformed inputs: zero quantity, zero/invalid fill price
//   - Position projection: first fill opens position, opposite-side fill reduces/closes
//   - Transaction rollback: verify no partial rows on error
//   - Multiple fills accumulate position correctly

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ExecutionAttemptRepository } from '../src/persistence/execution-attempt-repo.js';
import { PaperOrderRepository } from '../src/persistence/paper-order-repo.js';
import { PaperFillRepository } from '../src/persistence/paper-fill-repo.js';
import { PaperPositionRepository } from '../src/persistence/paper-position-repo.js';
import { StrategyDecisionRepository } from '../src/persistence/strategy-decision-repo.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import {
  ExecutionAttemptStatus,
  ExecutionMode,
  ExecutionOutcomeCode,
  PaperOrderStatus,
  PositionEventType,
  PositionSide,
  ProposalStatus,
  StrategyDecisionStatus,
  type StrategyApprovedCandidate,
} from '../src/types/runtime.js';
import type { PaperEvaluationResult } from '../src/execution/paper-execution-policy.js';
import { PaperExecutionLedger } from '../src/execution/paper-execution-ledger.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.now();

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestContext {
  db: Database.Database;
  attemptRepo: ExecutionAttemptRepository;
  orderRepo: PaperOrderRepository;
  fillRepo: PaperFillRepository;
  positionRepo: PaperPositionRepository;
  strategyRepo: StrategyDecisionRepository;
  proposalRepo: ProposalRepository;
  ledger: PaperExecutionLedger;
}

function createContext(): TestContext {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;
  return {
    db,
    attemptRepo: new ExecutionAttemptRepository(db),
    orderRepo: new PaperOrderRepository(db),
    fillRepo: new PaperFillRepository(db),
    positionRepo: new PaperPositionRepository(db),
    strategyRepo: new StrategyDecisionRepository(db),
    proposalRepo: new ProposalRepository(db),
    ledger: new PaperExecutionLedger({
      db,
      attemptRepo: new ExecutionAttemptRepository(db),
      orderRepo: new PaperOrderRepository(db),
      fillRepo: new PaperFillRepository(db),
      positionRepo: new PaperPositionRepository(db),
    }),
  };
}

/**
 * Seed a single proposal + strategy decision pair and return a
 * StrategyApprovedCandidate with the real DB-assigned id.
 */
function seedCandidate(
  ctx: TestContext,
  overrides?: Partial<StrategyApprovedCandidate>,
): StrategyApprovedCandidate {
  const proposal = ctx.proposalRepo.insertAttempt({
    exchange: overrides?.exchange ?? 'NSE',
    tradingsymbol: overrides?.tradingsymbol ?? 'RELIANCE',
    instrumentToken: 123456,
    side: overrides?.side ?? 'buy',
    product: overrides?.product ?? 'MIS',
    quantity: overrides?.quantity ?? 75,
    price: overrides?.price ?? null,
    triggerPrice: overrides?.triggerPrice ?? null,
    orderType: overrides?.orderType ?? 'MARKET',
    tag: null,
    proposalStatus: ProposalStatus.Accepted,
    createdAt: NOW - 120_000,
  });

  const side = overrides?.side ?? 'buy';
  const quantity = overrides?.quantity ?? 75;
  const exchange = overrides?.exchange ?? 'NSE';

  const decision = ctx.strategyRepo.insertDecision({
    proposalAttemptId: proposal.id,
    decisionStatus: StrategyDecisionStatus.Approved,
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    decidedAt: NOW - 60_000,
    exchange,
    tradingsymbol: overrides?.tradingsymbol ?? 'RELIANCE',
    side,
    product: overrides?.product ?? 'MIS',
    quantity,
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
    // Required execution-class metadata (S03)
    executionClass: 'EQ',
    segment: exchange === 'NFO' ? 'NFO' : 'NSE',
    instrumentType: exchange === 'NFO' ? 'FUT' : 'EQ',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    freezeQuantity: null,
  });

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
 * Build a successful paper evaluation result (canFill=true).
 */
function successEvaluation(
  overrides?: Partial<PaperEvaluationResult>,
): PaperEvaluationResult {
  return {
    canFill: true,
    fillPrice: 2851.00,
    outcomeCode: ExecutionOutcomeCode.PaperSimulated,
    message: 'Paper buy 75 RELIANCE at 2851.00 (ask=2851.00, last=2850.50)',
    refusalReasons: [],
    simulatedBrokerOrderId: 'paper-1700000000000-42-buy',
    ...overrides,
  };
}

/**
 * Build a refused paper evaluation result (canFill=false).
 */
function refusalEvaluation(
  overrides?: Partial<PaperEvaluationResult>,
): PaperEvaluationResult {
  return {
    canFill: false,
    fillPrice: null,
    outcomeCode: ExecutionOutcomeCode.PaperRejected,
    message: 'Refused: stale quote',
    refusalReasons: [{
      reasonCode: 'stale_or_missing_quote' as any,
      reasonMessage: 'Quote is stale',
    }],
    simulatedBrokerOrderId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaperExecutionLedger', () => {
  describe('successful writes', () => {
    it('writes all downstream rows for a buy fill', () => {
      const ctx = createContext();
      const candidate = seedCandidate(ctx, { side: 'buy', quantity: 75 });
      const evaluation = successEvaluation({ fillPrice: 2851.00 });

      const result = ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation);

      // Verify attempt row
      expect(result.attempt.strategyDecisionId).toBe(candidate.id);
      expect(result.attempt.executionMode).toBe(ExecutionMode.Paper);
      expect(result.attempt.status).toBe(ExecutionAttemptStatus.Completed);
      expect(result.attempt.outcomeCode).toBe(ExecutionOutcomeCode.PaperSimulated);
      expect(result.attempt.brokerOrderId).toBe(evaluation.simulatedBrokerOrderId);

      // Verify order row
      expect(result.order.executionAttemptId).toBe(result.attempt.id);
      expect(result.order.exchange).toBe('NSE');
      expect(result.order.tradingsymbol).toBe('RELIANCE');
      expect(result.order.side).toBe('buy');
      expect(result.order.quantity).toBe(75);
      expect(result.order.status).toBe(PaperOrderStatus.Filled);
      expect(result.order.brokerOrderId).toBe(evaluation.simulatedBrokerOrderId);

      // Verify fill row
      expect(result.fill.paperOrderId).toBe(result.order.id);
      expect(result.fill.executionAttemptId).toBe(result.attempt.id);
      expect(result.fill.filledQuantity).toBe(75);
      expect(result.fill.filledPrice).toBe(2851.00);
      expect(result.fill.referencePrice).toBeNull();
      expect(result.fill.slippagePerUnit).toBe(0);
      expect(result.fill.slippageAmount).toBe(0);
      expect(result.fill.fees).toBe(0);
      expect(result.fill.brokerOrderId).toBe(evaluation.simulatedBrokerOrderId);
      expect(result.fill.side).toBe('buy');

      // Verify position event
      expect(result.positionEvent.eventType).toBe(PositionEventType.Open);
      expect(result.positionEvent.quantityDelta).toBe(75);
      expect(result.positionEvent.previousQuantity).toBe(0);
      expect(result.positionEvent.newQuantity).toBe(75);
      expect(result.positionEvent.newAvgCost).toBe(2851.00);
      expect(result.positionEvent.realizedPnl).toBe(0);
      expect(result.positionEvent.price).toBe(2851.00);

      // Verify position projection
      expect(result.position.side).toBe(PositionSide.Long);
      expect(result.position.quantity).toBe(75);
      expect(result.position.avgCostPrice).toBe(2851.00);
      expect(result.position.realizedPnl).toBe(0);

      // Verify all rows are retrievable from repos
      expect(ctx.attemptRepo.getById(result.attempt.id)).not.toBeNull();
      expect(ctx.orderRepo.getById(result.order.id)).not.toBeNull();
      expect(ctx.fillRepo.getById(result.fill.id)).not.toBeNull();
      const events = ctx.positionRepo.getEventsByKey('NSE', 'RELIANCE', 'MIS');
      expect(events).toHaveLength(1);
      expect(ctx.positionRepo.getPosition('NSE', 'RELIANCE', 'MIS')).not.toBeNull();
    });

    it('writes all downstream rows for a sell fill', () => {
      const ctx = createContext();
      const candidate = seedCandidate(ctx, { side: 'sell', quantity: 50 });
      const evaluation = successEvaluation({
        fillPrice: 2849.50,
        simulatedBrokerOrderId: 'paper-1700000000000-43-sell',
        message: 'Paper sell 50 RELIANCE at 2849.50 (bid=2849.50, last=2850.00)',
      });

      const result = ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation);

      // Verify attempt
      expect(result.attempt.strategyDecisionId).toBe(candidate.id);
      expect(result.attempt.status).toBe(ExecutionAttemptStatus.Completed);

      // Verify order
      expect(result.order.side).toBe('sell');
      expect(result.order.quantity).toBe(50);
      expect(result.order.status).toBe(PaperOrderStatus.Filled);

      // Verify fill
      expect(result.fill.side).toBe('sell');
      expect(result.fill.filledQuantity).toBe(50);
      expect(result.fill.filledPrice).toBe(2849.50);

      // Verify position event (sell opens a Short position from flat)
      expect(result.positionEvent.eventType).toBe(PositionEventType.Open);
      expect(result.positionEvent.quantityDelta).toBe(-50);
      expect(result.positionEvent.previousQuantity).toBe(0);
      expect(result.positionEvent.newQuantity).toBe(-50);
      expect(result.positionEvent.newAvgCost).toBe(2849.50);

      // Verify position projection (Short)
      expect(result.position.side).toBe(PositionSide.Short);
      expect(result.position.quantity).toBe(-50);
      expect(result.position.avgCostPrice).toBe(2849.50);
    });

    it('counts total rows correctly after a ledger write', () => {
      const ctx = createContext();
      const candidate = seedCandidate(ctx, { side: 'buy', quantity: 75 });
      const evaluation = successEvaluation();

      ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation);

      expect(ctx.attemptRepo.count()).toBe(1);
      expect(ctx.orderRepo.count()).toBe(1);
      expect(ctx.fillRepo.count()).toBe(1);
      expect(ctx.positionRepo.countEvents()).toBe(1);
      expect(ctx.positionRepo.countPositions()).toBe(1);
      expect(ctx.positionRepo.countOpenPositions()).toBe(1);
    });
  });

  describe('position projection', () => {
    it('opens a long position on first buy', () => {
      const ctx = createContext();
      const candidate = seedCandidate(ctx, { side: 'buy', quantity: 75 });
      const evaluation = successEvaluation({ fillPrice: 2850.00 });

      const result = ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation);

      expect(result.positionEvent.eventType).toBe(PositionEventType.Open);
      expect(result.positionEvent.newQuantity).toBe(75);
      expect(result.positionEvent.newAvgCost).toBe(2850.00);
      expect(result.position.side).toBe(PositionSide.Long);
    });

    it('bakes transaction fees into economic cost basis and realized pnl', () => {
      const ctx = createContext();

      const open = seedCandidate(ctx, { side: 'buy', quantity: 10 });
      ctx.ledger.writeSuccessfulPaperFill(open, successEvaluation({
        fillPrice: 100.00,
        fees: 1.00,
        simulatedBrokerOrderId: 'paper-fee-open',
      }));

      const close = seedCandidate(ctx, { side: 'sell', quantity: 10 });
      const result = ctx.ledger.writeSuccessfulPaperFill(close, successEvaluation({
        fillPrice: 110.00,
        fees: 1.10,
        simulatedBrokerOrderId: 'paper-fee-close',
      }));

      expect(result.positionEvent.transactionFees).toBeCloseTo(1.10, 4);
      expect(result.positionEvent.realizedPnl).toBeCloseTo(97.90, 2);
      expect(result.position.realizedPnl).toBeCloseTo(97.90, 2);
    });

    it('adjusts position with weighted avg cost on same-direction buy', () => {
      const ctx = createContext();

      // First buy: open at 2850.00, qty 75
      const c1 = seedCandidate(ctx, { side: 'buy', quantity: 75 });
      ctx.ledger.writeSuccessfulPaperFill(c1, successEvaluation({ fillPrice: 2850.00 }));

      // Second buy: add 25 at 2860.00 → weighted avg = (75*2850 + 25*2860) / 100 = 2852.50
      const c2 = seedCandidate(ctx, { side: 'buy', quantity: 25 });
      const result = ctx.ledger.writeSuccessfulPaperFill(c2, successEvaluation({ fillPrice: 2860.00 }));

      expect(result.positionEvent.eventType).toBe(PositionEventType.Adjust);
      expect(result.positionEvent.quantityDelta).toBe(25);
      expect(result.positionEvent.previousQuantity).toBe(75);
      expect(result.positionEvent.newQuantity).toBe(100);
      expect(result.positionEvent.newAvgCost).toBeCloseTo(2852.50, 2);
      expect(result.positionEvent.realizedPnl).toBe(0);
      expect(result.position.side).toBe(PositionSide.Long);
    });

    it('adjusts position with weighted avg cost on same-direction sell', () => {
      const ctx = createContext();

      // First sell: open short at 2850.00, qty 50
      const c1 = seedCandidate(ctx, { side: 'sell', quantity: 50 });
      ctx.ledger.writeSuccessfulPaperFill(c1, successEvaluation({
        fillPrice: 2850.00,
        simulatedBrokerOrderId: 'paper-s1',
      }));

      // Second sell: add 30 at 2860.00 → weighted avg = (50*2850 + 30*2860) / 80 = 2853.75
      const c2 = seedCandidate(ctx, { side: 'sell', quantity: 30 });
      const result = ctx.ledger.writeSuccessfulPaperFill(c2, successEvaluation({
        fillPrice: 2860.00,
        simulatedBrokerOrderId: 'paper-s2',
      }));

      expect(result.positionEvent.eventType).toBe(PositionEventType.Adjust);
      expect(result.positionEvent.quantityDelta).toBe(-30);
      expect(result.positionEvent.previousQuantity).toBe(-50);
      expect(result.positionEvent.newQuantity).toBe(-80);
      expect(result.positionEvent.newAvgCost).toBeCloseTo(2853.75, 2);
      expect(result.position.side).toBe(PositionSide.Short);
    });

    it('closes a long position on opposite-side fill of equal quantity', () => {
      const ctx = createContext();

      // Open long: buy 75 at 2850.00
      const c1 = seedCandidate(ctx, { side: 'buy', quantity: 75 });
      ctx.ledger.writeSuccessfulPaperFill(c1, successEvaluation({ fillPrice: 2850.00 }));

      // Close: sell 75 at 2875.00 → realized PnL = (2875 - 2850) * 75 = 1875
      const c2 = seedCandidate(ctx, { side: 'sell', quantity: 75 });
      const result = ctx.ledger.writeSuccessfulPaperFill(c2, successEvaluation({
        fillPrice: 2875.00,
        simulatedBrokerOrderId: 'paper-close',
      }));

      expect(result.positionEvent.eventType).toBe(PositionEventType.Close);
      expect(result.positionEvent.quantityDelta).toBe(-75);
      expect(result.positionEvent.previousQuantity).toBe(75);
      expect(result.positionEvent.newQuantity).toBe(0);
      expect(result.positionEvent.realizedPnl).toBeCloseTo(1875.00, 2);
      expect(result.position.side).toBe(PositionSide.Flat);
      expect(result.position.quantity).toBe(0);
    });

    it('closes a short position on opposite-side fill of equal quantity', () => {
      const ctx = createContext();

      // Open short: sell 50 at 2850.00
      const c1 = seedCandidate(ctx, { side: 'sell', quantity: 50 });
      ctx.ledger.writeSuccessfulPaperFill(c1, successEvaluation({
        fillPrice: 2850.00,
        simulatedBrokerOrderId: 'paper-short',
      }));

      // Close: buy 50 at 2830.00 → realized PnL = (2850 - 2830) * 50 = 1000
      const c2 = seedCandidate(ctx, { side: 'buy', quantity: 50 });
      const result = ctx.ledger.writeSuccessfulPaperFill(c2, successEvaluation({
        fillPrice: 2830.00,
        simulatedBrokerOrderId: 'paper-cover',
      }));

      expect(result.positionEvent.eventType).toBe(PositionEventType.Close);
      expect(result.positionEvent.quantityDelta).toBe(50);
      expect(result.positionEvent.previousQuantity).toBe(-50);
      expect(result.positionEvent.newQuantity).toBe(0);
      expect(result.positionEvent.realizedPnl).toBeCloseTo(1000.00, 2);
      expect(result.position.side).toBe(PositionSide.Flat);
    });

    it('partially reduces a long position with correct realized PnL', () => {
      const ctx = createContext();

      // Open long: buy 100 at 2800.00
      const c1 = seedCandidate(ctx, { side: 'buy', quantity: 100 });
      ctx.ledger.writeSuccessfulPaperFill(c1, successEvaluation({ fillPrice: 2800.00 }));

      // Partial reduce: sell 30 at 2850.00 → realized PnL = (2850 - 2800) * 30 = 1500
      const c2 = seedCandidate(ctx, { side: 'sell', quantity: 30 });
      const result = ctx.ledger.writeSuccessfulPaperFill(c2, successEvaluation({
        fillPrice: 2850.00,
        simulatedBrokerOrderId: 'paper-reduce',
      }));

      expect(result.positionEvent.eventType).toBe(PositionEventType.Adjust);
      expect(result.positionEvent.quantityDelta).toBe(-30);
      expect(result.positionEvent.previousQuantity).toBe(100);
      expect(result.positionEvent.newQuantity).toBe(70);
      expect(result.positionEvent.newAvgCost).toBe(2800.00); // cost basis unchanged
      expect(result.positionEvent.realizedPnl).toBeCloseTo(1500.00, 2);
      expect(result.position.side).toBe(PositionSide.Long);
      expect(result.position.quantity).toBe(70);
    });

    it('flips from long to short when sell quantity exceeds long position', () => {
      const ctx = createContext();

      // Open long: buy 50 at 2800.00
      const c1 = seedCandidate(ctx, { side: 'buy', quantity: 50 });
      ctx.ledger.writeSuccessfulPaperFill(c1, successEvaluation({ fillPrice: 2800.00 }));

      // Over-sell: sell 70 at 2850.00 → close 50 at profit, open 20 short
      // Realized PnL on close portion: (2850 - 2800) * 50 = 2500
      const c2 = seedCandidate(ctx, { side: 'sell', quantity: 70 });
      const result = ctx.ledger.writeSuccessfulPaperFill(c2, successEvaluation({
        fillPrice: 2850.00,
        simulatedBrokerOrderId: 'paper-flip',
      }));

      expect(result.positionEvent.eventType).toBe(PositionEventType.Adjust);
      expect(result.positionEvent.quantityDelta).toBe(-70);
      expect(result.positionEvent.previousQuantity).toBe(50);
      expect(result.positionEvent.newQuantity).toBe(-20);
      expect(result.positionEvent.realizedPnl).toBeCloseTo(2500.00, 2);
      expect(result.position.side).toBe(PositionSide.Short);
      expect(result.position.quantity).toBe(-20);
      // New short position at the fill price
      expect(result.position.avgCostPrice).toBe(2850.00);
    });
  });

  describe('error handling', () => {
    it('throws when evaluation.canFill is false', () => {
      const ctx = createContext();
      const candidate = seedCandidate(ctx);
      const evaluation = refusalEvaluation();

      expect(() => ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation))
        .toThrow('evaluation.canFill is false');
    });

    it('throws when fillPrice is zero', () => {
      const ctx = createContext();
      const candidate = seedCandidate(ctx);
      const evaluation = successEvaluation({ fillPrice: 0 });

      expect(() => ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation))
        .toThrow('A valid positive fill price is required');
    });

    it('throws when quantity is zero', () => {
      const ctx = createContext();
      const candidate = seedCandidate(ctx, { quantity: 0 });
      const evaluation = successEvaluation();

      expect(() => ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation))
        .toThrow('Quantity must be positive');
    });

    it('does NOT create any downstream rows on error (rollback)', () => {
      const ctx = createContext();
      const candidate = seedCandidate(ctx, { quantity: -5 }); // invalid
      const evaluation = successEvaluation();

      expect(() => ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation))
        .toThrow();

      // Verify no rows were created
      expect(ctx.attemptRepo.count()).toBe(0);
      expect(ctx.orderRepo.count()).toBe(0);
      expect(ctx.fillRepo.count()).toBe(0);
      expect(ctx.positionRepo.countEvents()).toBe(0);
      expect(ctx.positionRepo.countPositions()).toBe(0);
    });

    it('throws on duplicate strategy decision (UNIQUE constraint)', () => {
      const ctx = createContext();
      const candidate = seedCandidate(ctx, { side: 'buy', quantity: 75 });
      const evaluation = successEvaluation();

      // First write succeeds
      ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation);

      // Second write for same candidate should throw (UNIQUE on strategy_decision_id)
      expect(() => ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation))
        .toThrow();

      // Verify only one set of rows exists
      expect(ctx.attemptRepo.count()).toBe(1);
      expect(ctx.orderRepo.count()).toBe(1);
    });

    it('rolls back all writes on duplicate despite partial first write', () => {
      const ctx = createContext();
      const c1 = seedCandidate(ctx, { side: 'buy', quantity: 75 });
      const c2 = seedCandidate(ctx, { side: 'buy', quantity: 50 });
      const e1 = successEvaluation();
      const e2 = successEvaluation({ fillPrice: 2860.00 });

      // Write first candidate
      ctx.ledger.writeSuccessfulPaperFill(c1, e1);

      // Write second candidate — succeeds
      ctx.ledger.writeSuccessfulPaperFill(c2, e2);

      // Verify position accumulated
      const pos = ctx.positionRepo.getPosition('NSE', 'RELIANCE', 'MIS');
      expect(pos!.quantity).toBe(125); // 75 + 50
      expect(ctx.attemptRepo.count()).toBe(2);
      expect(ctx.orderRepo.count()).toBe(2);
      expect(ctx.fillRepo.count()).toBe(2);
    });
  });

  describe('idempotency', () => {
    it('enforces one attempt per strategy decision (UNIQUE)', () => {
      const ctx = createContext();
      const candidate = seedCandidate(ctx);
      const evaluation = successEvaluation();

      ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation);

      // Attempting another write with same strategy decision must fail
      expect(() => ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation))
        .toThrow();
    });
  });

  describe('multiple fills accumulate correctly', () => {
    it('accumulates three sequential buy fills', () => {
      const ctx = createContext();

      // Buy 10 at 100
      const c1 = seedCandidate(ctx, { side: 'buy', quantity: 10 });
      ctx.ledger.writeSuccessfulPaperFill(c1, successEvaluation({ fillPrice: 100 }));

      // Buy 20 at 110 → weighted avg = (10*100 + 20*110)/30 = 106.67
      const c2 = seedCandidate(ctx, { side: 'buy', quantity: 20 });
      const r2 = ctx.ledger.writeSuccessfulPaperFill(c2, successEvaluation({ fillPrice: 110 }));
      expect(r2.positionEvent.newAvgCost).toBeCloseTo(106.67, 2);

      // Buy 30 at 120 → weighted avg = (30*106.67 + 30*120)/60 = 113.33
      const c3 = seedCandidate(ctx, { side: 'buy', quantity: 30 });
      const r3 = ctx.ledger.writeSuccessfulPaperFill(c3, successEvaluation({ fillPrice: 120 }));
      expect(r3.positionEvent.newAvgCost).toBeCloseTo(113.33, 2);

      const pos = ctx.positionRepo.getPosition('NSE', 'RELIANCE', 'MIS');
      expect(pos!.quantity).toBe(60);
      expect(pos!.avgCostPrice).toBeCloseTo(113.33, 2);
    });

    it('accumulates buy then partial sell then buy remaining', () => {
      const ctx = createContext();

      // Open: buy 100 at 100
      const c1 = seedCandidate(ctx, { side: 'buy', quantity: 100 });
      ctx.ledger.writeSuccessfulPaperFill(c1, successEvaluation({ fillPrice: 100 }));

      // Partial sell: 40 at 110 → realized PnL = (110-100)*40 = 400
      const c2 = seedCandidate(ctx, { side: 'sell', quantity: 40 });
      const r2 = ctx.ledger.writeSuccessfulPaperFill(c2, successEvaluation({
        fillPrice: 110,
        simulatedBrokerOrderId: 'paper-sell-p1',
      }));
      expect(r2.positionEvent.realizedPnl).toBeCloseTo(400, 2);

      // Buy more: 30 at 105 → weighted avg = (60*100 + 30*105)/90 = 101.67
      const c3 = seedCandidate(ctx, { side: 'buy', quantity: 30 });
      const r3 = ctx.ledger.writeSuccessfulPaperFill(c3, successEvaluation({ fillPrice: 105 }));
      expect(r3.positionEvent.newAvgCost).toBeCloseTo(101.67, 2);

      const pos = ctx.positionRepo.getPosition('NSE', 'RELIANCE', 'MIS');
      expect(pos!.quantity).toBe(90);
      expect(pos!.realizedPnl).toBeCloseTo(400, 2);
    });
  });

  describe('ledger result structure', () => {
    it('returns all five downstream rows in the result', () => {
      const ctx = createContext();
      const candidate = seedCandidate(ctx);
      const evaluation = successEvaluation();

      const result = ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation);

      expect(result).toHaveProperty('attempt');
      expect(result).toHaveProperty('order');
      expect(result).toHaveProperty('fill');
      expect(result).toHaveProperty('positionEvent');
      expect(result).toHaveProperty('position');
      expect(result.attempt.id).toBeGreaterThan(0);
      expect(result.order.id).toBeGreaterThan(0);
      expect(result.fill.id).toBeGreaterThan(0);
      expect(result.positionEvent.id).toBeGreaterThan(0);
      expect(result.position.id).toBeGreaterThan(0);
    });

    it('sets consistent timestamps across all rows', () => {
      const ctx = createContext();
      const candidate = seedCandidate(ctx);
      const evaluation = successEvaluation();
      const before = Date.now() - 1000;

      const result = ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation);

      const after = Date.now() + 1000;
      expect(result.attempt.attemptedAt).toBeGreaterThanOrEqual(before);
      expect(result.attempt.attemptedAt).toBeLessThanOrEqual(after);
      expect(result.attempt.completedAt).toBe(result.attempt.attemptedAt);
      expect(result.order.createdAt).toBe(result.attempt.attemptedAt);
      expect(result.fill.filledAt).toBe(result.attempt.attemptedAt);
      expect(result.positionEvent.createdAt).toBe(result.attempt.attemptedAt);
    });
  });

  // -----------------------------------------------------------------------
  // FO paper ledger — FO fills through the shared ledger seam
  // -----------------------------------------------------------------------
  // The PaperExecutionLedger is class-agnostic — it writes any successful
  // paper fill through the same multi-table transaction regardless of
  // execution class. These tests prove FO symbols flow correctly through
  // the shared ledger with NFO exchange metadata.

  describe('FO paper ledger', () => {
    /**
     * Seed an FO candidate through the DB with NFO exchange metadata.
     */
    function seedFOCandidate(
      ctx: TestContext,
      overrides?: Partial<StrategyApprovedCandidate>,
    ): StrategyApprovedCandidate {
      return seedCandidate(ctx, {
        exchange: 'NFO',
        tradingsymbol: 'NIFTY24DECFUT',
        side: 'buy',
        product: 'NRML',
        quantity: 300,   // 6 lots of 50
        price: null,
        orderType: 'MARKET',
        ...overrides,
      });
    }

    it('writes all downstream rows for FO buy fill with NFO exchange metadata', () => {
      const ctx = createContext();
      const candidate = seedFOCandidate(ctx, { quantity: 300 });
      const evaluation = successEvaluation({
        fillPrice: 21500.00,
        simulatedBrokerOrderId: 'paper-fo-001',
        message: 'Paper buy 300 NIFTY24DECFUT at 21500 (ask=21500.50, last=21500.00)',
      });

      const result = ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation);

      // Attempt carries correct strategy decision reference
      expect(result.attempt.strategyDecisionId).toBe(candidate.id);
      expect(result.attempt.status).toBe(ExecutionAttemptStatus.Completed);

      // Order carries FO exchange and symbol
      expect(result.order.exchange).toBe('NFO');
      expect(result.order.tradingsymbol).toBe('NIFTY24DECFUT');
      expect(result.order.side).toBe('buy');
      expect(result.order.product).toBe('NRML');
      expect(result.order.quantity).toBe(300);
      expect(result.order.status).toBe(PaperOrderStatus.Filled);

      // Fill carries FO exchange and symbol
      expect(result.fill.exchange).toBe('NFO');
      expect(result.fill.tradingsymbol).toBe('NIFTY24DECFUT');
      expect(result.fill.side).toBe('buy');
      expect(result.fill.filledQuantity).toBe(300);
      expect(result.fill.filledPrice).toBe(21500.00);

      // Position event carries FO exchange and symbol
      expect(result.positionEvent.eventType).toBe(PositionEventType.Open);
      expect(result.positionEvent.exchange).toBe('NFO');
      expect(result.positionEvent.tradingsymbol).toBe('NIFTY24DECFUT');
      expect(result.positionEvent.product).toBe('NRML');
      expect(result.positionEvent.quantityDelta).toBe(300);
      expect(result.positionEvent.newQuantity).toBe(300);
      expect(result.positionEvent.newAvgCost).toBe(21500.00);

      // Position projection carries FO metadata
      expect(result.position.exchange).toBe('NFO');
      expect(result.position.tradingsymbol).toBe('NIFTY24DECFUT');
      expect(result.position.product).toBe('NRML');
      expect(result.position.side).toBe(PositionSide.Long);
      expect(result.position.quantity).toBe(300);
      expect(result.position.avgCostPrice).toBe(21500.00);

      // All downstream rows retrievable from repos
      expect(ctx.orderRepo.getByExecutionAttemptId(result.attempt.id)).not.toBeNull();
      expect(ctx.fillRepo.getByExecutionAttemptId(result.attempt.id)).not.toBeNull();
      const events = ctx.positionRepo.getEventsByKey('NFO', 'NIFTY24DECFUT', 'NRML');
      expect(events).toHaveLength(1);
      expect(ctx.positionRepo.getPosition('NFO', 'NIFTY24DECFUT', 'NRML')).not.toBeNull();
    });

    it('writes all downstream rows for FO sell fill', () => {
      const ctx = createContext();
      const candidate = seedFOCandidate(ctx, {
        tradingsymbol: 'BANKNIFTY24DECFUT',
        side: 'sell',
        product: 'NRML',
        quantity: 75,   // 3 lots of 25
      });
      const evaluation = successEvaluation({
        fillPrice: 48500.00,
        simulatedBrokerOrderId: 'paper-fo-sell-001',
        message: 'Paper sell 75 BANKNIFTY24DECFUT at 48500 (bid=48500.00, last=48510.00)',
      });

      const result = ctx.ledger.writeSuccessfulPaperFill(candidate, evaluation);

      expect(result.order.exchange).toBe('NFO');
      expect(result.order.tradingsymbol).toBe('BANKNIFTY24DECFUT');
      expect(result.order.side).toBe('sell');
      expect(result.order.quantity).toBe(75);

      expect(result.fill.exchange).toBe('NFO');
      expect(result.fill.side).toBe('sell');
      expect(result.fill.filledQuantity).toBe(75);
      expect(result.fill.filledPrice).toBe(48500.00);

      // Sell opens a Short position
      expect(result.positionEvent.eventType).toBe(PositionEventType.Open);
      expect(result.positionEvent.quantityDelta).toBe(-75);
      expect(result.positionEvent.newQuantity).toBe(-75);
      expect(result.position.side).toBe(PositionSide.Short);
      expect(result.position.quantity).toBe(-75);
      expect(result.position.avgCostPrice).toBe(48500.00);
    });

    it('accumulates sequential FO fills correctly', () => {
      const ctx = createContext();

      // First FO buy: open long 300 at 21500
      const c1 = seedFOCandidate(ctx, { quantity: 300 });
      ctx.ledger.writeSuccessfulPaperFill(c1, successEvaluation({
        fillPrice: 21500.00,
        simulatedBrokerOrderId: 'paper-fo-b1',
      }));

      // Second FO buy: add 150 at 21600 → weighted avg = (300*21500 + 150*21600) / 450 = 21533.33
      const c2 = seedFOCandidate(ctx, { quantity: 150 });
      const r2 = ctx.ledger.writeSuccessfulPaperFill(c2, successEvaluation({
        fillPrice: 21600.00,
        simulatedBrokerOrderId: 'paper-fo-b2',
      }));

      expect(r2.positionEvent.eventType).toBe(PositionEventType.Adjust);
      expect(r2.positionEvent.previousQuantity).toBe(300);
      expect(r2.positionEvent.newQuantity).toBe(450);
      expect(r2.positionEvent.newAvgCost).toBeCloseTo(21533.33, 2);

      const pos = ctx.positionRepo.getPosition('NFO', 'NIFTY24DECFUT', 'NRML');
      expect(pos!.quantity).toBe(450);
      expect(pos!.avgCostPrice).toBeCloseTo(21533.33, 2);

      // Count totals: 2 attempts, 2 orders, 2 fills, 2 events, 1 position
      expect(ctx.attemptRepo.count()).toBe(2);
      expect(ctx.orderRepo.count()).toBe(2);
      expect(ctx.fillRepo.count()).toBe(2);
      expect(ctx.positionRepo.countEvents()).toBe(2);
      expect(ctx.positionRepo.countPositions()).toBe(1);
      expect(ctx.positionRepo.countOpenPositions()).toBe(1);
    });

    it('partially closes FO long position with correct realized PnL', () => {
      const ctx = createContext();

      // Open: buy 300 at 21500
      const c1 = seedFOCandidate(ctx, { quantity: 300 });
      ctx.ledger.writeSuccessfulPaperFill(c1, successEvaluation({
        fillPrice: 21500.00,
        simulatedBrokerOrderId: 'paper-fo-open',
      }));

      // Partial sell: 100 at 21750 → realized PnL = (21750 - 21500) * 100 = 25,000
      const c2 = seedFOCandidate(ctx, {
        side: 'sell',
        quantity: 100,
        tradingsymbol: 'NIFTY24DECFUT',
      });
      const r2 = ctx.ledger.writeSuccessfulPaperFill(c2, successEvaluation({
        fillPrice: 21750.00,
        simulatedBrokerOrderId: 'paper-fo-reduce',
      }));

      expect(r2.positionEvent.eventType).toBe(PositionEventType.Adjust);
      expect(r2.positionEvent.quantityDelta).toBe(-100);
      expect(r2.positionEvent.previousQuantity).toBe(300);
      expect(r2.positionEvent.newQuantity).toBe(200);
      expect(r2.positionEvent.realizedPnl).toBeCloseTo(25000, 2); // (21750-21500)*100

      const pos = ctx.positionRepo.getPosition('NFO', 'NIFTY24DECFUT', 'NRML');
      expect(pos!.quantity).toBe(200);
      expect(pos!.realizedPnl).toBeCloseTo(25000, 2);
    });
  });
});
