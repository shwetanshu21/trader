import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { PaperOrderRepository } from '../src/persistence/paper-order-repo.js';
import { PaperFillRepository } from '../src/persistence/paper-fill-repo.js';
import { PaperPositionRepository } from '../src/persistence/paper-position-repo.js';
import { ExecutionAttemptRepository } from '../src/persistence/execution-attempt-repo.js';
import { StrategyDecisionRepository } from '../src/persistence/strategy-decision-repo.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import {
  PaperOrderStatus,
  PositionSide,
  PositionEventType,
  ExecutionAttemptStatus,
  ExecutionMode,
  ExecutionOutcomeCode,
  ProposalStatus,
  StrategyDecisionStatus,
  type NewPaperOrder,
  type NewPaperFill,
  type NewPositionEvent,
  type NewPaperPosition,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestContext {
  orderRepo: PaperOrderRepository;
  fillRepo: PaperFillRepository;
  posRepo: PaperPositionRepository;
  attemptRepo: ExecutionAttemptRepository;
  strategyRepo: StrategyDecisionRepository;
  proposalRepo: ProposalRepository;
  db: Database.Database;
}

function createContext(): TestContext {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;
  return {
    orderRepo: new PaperOrderRepository(db),
    fillRepo: new PaperFillRepository(db),
    posRepo: new PaperPositionRepository(db),
    attemptRepo: new ExecutionAttemptRepository(db),
    strategyRepo: new StrategyDecisionRepository(db),
    proposalRepo: new ProposalRepository(db),
    db,
  };
}

function insertFullPaperFlow(
  ctx: TestContext,
  overrides?: {
    tradingsymbol?: string;
    side?: 'buy' | 'sell';
    quantity?: number;
    price?: number;
    createdAt?: number;
  },
): { proposalId: number; decisionId: number; attemptId: number; orderId: number; fillId: number } {
  const t = overrides?.tradingsymbol ?? 'RELIANCE';
  const now = overrides?.createdAt ?? Date.now();
  const side = overrides?.side ?? 'buy';
  const quantity = overrides?.quantity ?? 75;
  const price = overrides?.price ?? 2850.50;

  const paRow = ctx.proposalRepo.insertAttempt({
    exchange: 'NSE',
    tradingsymbol: t,
    instrumentToken: 123456,
    side,
    product: 'MIS',
    quantity: 1,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: null,
    proposalStatus: ProposalStatus.Accepted,
    createdAt: now,
  });

  const decRow = ctx.strategyRepo.insertDecision({
    proposalAttemptId: paRow.id,
    decisionStatus: StrategyDecisionStatus.Approved,
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    decidedAt: now,
    exchange: 'NSE',
    tradingsymbol: t,
    side,
    product: 'MIS',
    quantity,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    quoteLastPrice: price,
    quoteBid: price - 0.5,
    quoteAsk: price + 0.5,
    quoteVolume: 1250000,
    quoteReceivedAt: now,
    riskNotional: quantity * price,
    riskSizingBasis: 'last_price',
    riskMaxLossRupees: null,
    riskStopDistance: null,
    riskExposureTag: 'intraday',
    indiaResearchEvidence: null,
    executionClass: 'EQ' as const,
    segment: 'NSE',
    instrumentType: 'EQ',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    freezeQuantity: null,
  });

  const attRow = ctx.attemptRepo.insertAttempt({
    strategyDecisionId: decRow.id,
    executionMode: ExecutionMode.Paper,
    status: ExecutionAttemptStatus.Completed,
    outcomeCode: ExecutionOutcomeCode.PaperSimulated,
    brokerOrderId: `paper-${t}-${now}`,
    message: 'Paper broker simulated order placement',
    attemptedAt: now,
    completedAt: now + 100,
  });

  const ordRow = ctx.orderRepo.insert({
    executionAttemptId: attRow.id,
    exchange: 'NSE',
    tradingsymbol: t,
    side,
    product: 'MIS',
    quantity,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: null,
    status: PaperOrderStatus.Filled,
    brokerOrderId: `paper-${t}-${now}`,
    createdAt: now,
    updatedAt: now,
  });

  const fillRow = ctx.fillRepo.insert({
    paperOrderId: ordRow.id,
    executionAttemptId: attRow.id,
    exchange: 'NSE',
    tradingsymbol: t,
    side,
    product: 'MIS',
    filledQuantity: quantity,
    filledPrice: price,
    brokerOrderId: `paper-${t}-${now}`,
    filledAt: now,
  });

  return { proposalId: paRow.id, decisionId: decRow.id, attemptId: attRow.id, orderId: ordRow.id, fillId: fillRow.id };
}

// ---------------------------------------------------------------------------
// PaperPositionRepository
// ---------------------------------------------------------------------------

describe('PaperPositionRepository', () => {
  describe('insertEvent', () => {
    it('inserts a long position event with all fields', () => {
      const ctx = createContext();
      const flow = insertFullPaperFlow(ctx, { tradingsymbol: 'RELIANCE', side: 'buy', quantity: 75, price: 2850.50 });

      const event = ctx.posRepo.insertEvent({
        paperOrderId: flow.orderId,
        paperFillId: flow.fillId,
        executionAttemptId: flow.attemptId,
        eventType: PositionEventType.Fill,
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        product: 'MIS',
        quantityDelta: 75,
        price: 2850.50,
        previousQuantity: 0,
        previousAvgCost: 0,
        newQuantity: 75,
        newAvgCost: 2850.50,
        realizedPnl: 0,
        createdAt: Date.now(),
      });

      expect(event.id).toBeGreaterThan(0);
      expect(event.paperOrderId).toBe(flow.orderId);
      expect(event.paperFillId).toBe(flow.fillId);
      expect(event.eventType).toBe(PositionEventType.Fill);
      expect(event.quantityDelta).toBe(75);
      expect(event.newQuantity).toBe(75);
      expect(event.realizedPnl).toBe(0);
      expect(ctx.posRepo.countEvents()).toBe(1);
    });

    it('inserts a close event with realized P&L', () => {
      const ctx = createContext();
      const flow = insertFullPaperFlow(ctx, { tradingsymbol: 'SBIN', side: 'sell', quantity: 100, price: 800.00 });

      const event = ctx.posRepo.insertEvent({
        paperOrderId: flow.orderId,
        paperFillId: flow.fillId,
        executionAttemptId: flow.attemptId,
        eventType: PositionEventType.Close,
        exchange: 'NSE',
        tradingsymbol: 'SBIN',
        product: 'MIS',
        quantityDelta: -100,
        price: 810.00,
        previousQuantity: 100,
        previousAvgCost: 800.00,
        newQuantity: 0,
        newAvgCost: 0,
        realizedPnl: 1000.00,
        createdAt: Date.now(),
      });

      expect(event.eventType).toBe(PositionEventType.Close);
      expect(event.quantityDelta).toBe(-100);
      expect(event.realizedPnl).toBe(1000.00);
    });

    it('rejects event with nonexistent paper_order_id (FK violation)', () => {
      const ctx = createContext();
      const paId = insertFullPaperFlow(ctx, { tradingsymbol: 'FK_TEST' });

      expect(() => {
        ctx.posRepo.insertEvent({
          paperOrderId: 99999,
          paperFillId: paId.fillId,
          executionAttemptId: paId.attemptId,
          eventType: PositionEventType.Fill,
          exchange: 'NSE',
          tradingsymbol: 'FK_TEST',
          product: 'MIS',
          quantityDelta: 75,
          price: 2850.50,
          previousQuantity: 0,
          previousAvgCost: 0,
          newQuantity: 75,
          newAvgCost: 2850.50,
          realizedPnl: 0,
          createdAt: Date.now(),
        });
      }).toThrow();
    });
  });

  describe('getEventsByKey', () => {
    it('returns empty array for unknown position key', () => {
      const ctx = createContext();
      expect(ctx.posRepo.getEventsByKey('NSE', 'UNKNOWN', 'MIS')).toEqual([]);
    });

    it('returns events oldest first for reconstruction', () => {
      const ctx = createContext();
      const now = Date.now();

      // Buy event
      const buyFlow = insertFullPaperFlow(ctx, { tradingsymbol: 'POSITION_TEST', side: 'buy', quantity: 75, price: 100.00, createdAt: now });
      ctx.posRepo.insertEvent({
        paperOrderId: buyFlow.orderId,
        paperFillId: buyFlow.fillId,
        executionAttemptId: buyFlow.attemptId,
        eventType: PositionEventType.Fill,
        exchange: 'NSE',
        tradingsymbol: 'POSITION_TEST',
        product: 'MIS',
        quantityDelta: 75,
        price: 100.00,
        previousQuantity: 0,
        previousAvgCost: 0,
        newQuantity: 75,
        newAvgCost: 100.00,
        realizedPnl: 0,
        createdAt: now,
      });

      // Sell event (partial close)
      const sellFlow = insertFullPaperFlow(ctx, { tradingsymbol: 'POSITION_TEST', side: 'sell', quantity: 25, price: 110.00, createdAt: now + 1000 });
      ctx.posRepo.insertEvent({
        paperOrderId: sellFlow.orderId,
        paperFillId: sellFlow.fillId,
        executionAttemptId: sellFlow.attemptId,
        eventType: PositionEventType.Adjust,
        exchange: 'NSE',
        tradingsymbol: 'POSITION_TEST',
        product: 'MIS',
        quantityDelta: -25,
        price: 110.00,
        previousQuantity: 75,
        previousAvgCost: 100.00,
        newQuantity: 50,
        newAvgCost: 100.00,
        realizedPnl: 250.00,
        createdAt: now + 1000,
      });

      const events = ctx.posRepo.getEventsByKey('NSE', 'POSITION_TEST', 'MIS');
      expect(events.length).toBe(2);
      expect(events[0].quantityDelta).toBe(75); // First event: buy
      expect(events[1].quantityDelta).toBe(-25); // Second event: sell
      expect(events[0].id).toBeLessThan(events[1].id);
    });
  });

  describe('getRecentEvents', () => {
    it('returns events newest first', () => {
      const ctx = createContext();
      const now = Date.now();

      const f1 = insertFullPaperFlow(ctx, { tradingsymbol: 'EVT1', createdAt: now });
      ctx.posRepo.insertEvent({
        paperOrderId: f1.orderId,
        paperFillId: f1.fillId,
        executionAttemptId: f1.attemptId,
        eventType: PositionEventType.Fill,
        exchange: 'NSE',
        tradingsymbol: 'EVT1',
        product: 'MIS',
        quantityDelta: 75, price: 100, previousQuantity: 0, previousAvgCost: 0,
        newQuantity: 75, newAvgCost: 100, realizedPnl: 0, createdAt: now,
      });

      const f2 = insertFullPaperFlow(ctx, { tradingsymbol: 'EVT2', createdAt: now + 1000 });
      ctx.posRepo.insertEvent({
        paperOrderId: f2.orderId,
        paperFillId: f2.fillId,
        executionAttemptId: f2.attemptId,
        eventType: PositionEventType.Fill,
        exchange: 'NSE',
        tradingsymbol: 'EVT2',
        product: 'MIS',
        quantityDelta: 50, price: 200, previousQuantity: 0, previousAvgCost: 0,
        newQuantity: 50, newAvgCost: 200, realizedPnl: 0, createdAt: now + 1000,
      });

      const recent = ctx.posRepo.getRecentEvents();
      expect(recent.length).toBe(2);
      expect(recent[0].tradingsymbol).toBe('EVT2');
      expect(recent[1].tradingsymbol).toBe('EVT1');
    });
  });

  describe('upsertPosition / getPosition', () => {
    it('inserts a new position', () => {
      const ctx = createContext();
      const pos = ctx.posRepo.upsertPosition({
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        product: 'MIS',
        side: PositionSide.Long,
        quantity: 75,
        avgCostPrice: 2850.50,
        realizedPnl: 0,
        updatedAt: Date.now(),
      });

      expect(pos.id).toBeGreaterThan(0);
      expect(pos.side).toBe(PositionSide.Long);
      expect(pos.quantity).toBe(75);

      const loaded = ctx.posRepo.getPosition('NSE', 'RELIANCE', 'MIS');
      expect(loaded).not.toBeNull();
      expect(loaded!.quantity).toBe(75);
    });

    it('upserts (updates) an existing position', () => {
      const ctx = createContext();

      ctx.posRepo.upsertPosition({
        exchange: 'NSE', tradingsymbol: 'TCS', product: 'MIS',
        side: PositionSide.Long, quantity: 50, avgCostPrice: 3800.00,
        realizedPnl: 0, updatedAt: Date.now(),
      });

      ctx.posRepo.upsertPosition({
        exchange: 'NSE', tradingsymbol: 'TCS', product: 'MIS',
        side: PositionSide.Short, quantity: -25, avgCostPrice: 3900.00,
        realizedPnl: 500.00, updatedAt: Date.now() + 1000,
      });

      const loaded = ctx.posRepo.getPosition('NSE', 'TCS', 'MIS');
      expect(loaded).not.toBeNull();
      expect(loaded!.side).toBe(PositionSide.Short);
      expect(loaded!.quantity).toBe(-25);
      expect(loaded!.avgCostPrice).toBe(3900.00);
      expect(loaded!.realizedPnl).toBe(500.00);
    });

    it('returns null for unknown position', () => {
      const ctx = createContext();
      expect(ctx.posRepo.getPosition('NSE', 'UNKNOWN', 'MIS')).toBeNull();
    });
  });

  describe('getAllPositions', () => {
    it('returns all positions', () => {
      const ctx = createContext();

      ctx.posRepo.upsertPosition({
        exchange: 'NSE', tradingsymbol: 'A', product: 'MIS',
        side: PositionSide.Long, quantity: 10, avgCostPrice: 100,
        realizedPnl: 0, updatedAt: 100,
      });
      ctx.posRepo.upsertPosition({
        exchange: 'NSE', tradingsymbol: 'B', product: 'MIS',
        side: PositionSide.Short, quantity: -5, avgCostPrice: 200,
        realizedPnl: 10, updatedAt: 200,
      });

      const all = ctx.posRepo.getAllPositions();
      expect(all.length).toBe(2);
    });

    it('returns empty array when no positions exist', () => {
      const ctx = createContext();
      expect(ctx.posRepo.getAllPositions()).toEqual([]);
    });
  });

  describe('getOpenPositions', () => {
    it('returns only non-flat positions', () => {
      const ctx = createContext();

      ctx.posRepo.upsertPosition({
        exchange: 'NSE', tradingsymbol: 'OPEN_POS', product: 'MIS',
        side: PositionSide.Long, quantity: 50, avgCostPrice: 100,
        realizedPnl: 0, updatedAt: 100,
      });
      ctx.posRepo.upsertPosition({
        exchange: 'NSE', tradingsymbol: 'FLAT_POS', product: 'MIS',
        side: PositionSide.Flat, quantity: 0, avgCostPrice: 0,
        realizedPnl: 500, updatedAt: 200,
      });

      const open = ctx.posRepo.getOpenPositions();
      expect(open.length).toBe(1);
      expect(open[0].tradingsymbol).toBe('OPEN_POS');
    });
  });

  describe('count methods', () => {
    it('starts at zero', () => {
      const ctx = createContext();
      expect(ctx.posRepo.countEvents()).toBe(0);
      expect(ctx.posRepo.countPositions()).toBe(0);
      expect(ctx.posRepo.countOpenPositions()).toBe(0);
    });
  });

  describe('computePositionFromEvents', () => {
    it('returns flat state when no events exist', () => {
      const ctx = createContext();
      const result = ctx.posRepo.computePositionFromEvents('NSE', 'UNKNOWN', 'MIS');
      expect(result.side).toBe(PositionSide.Flat);
      expect(result.quantity).toBe(0);
      expect(result.avgCostPrice).toBe(0);
      expect(result.realizedPnl).toBe(0);
    });

    it('computes long position state from buy fill event', () => {
      const ctx = createContext();
      const flow = insertFullPaperFlow(ctx, { tradingsymbol: 'COMPUTE', side: 'buy', quantity: 75, price: 100.00 });

      ctx.posRepo.insertEvent({
        paperOrderId: flow.orderId,
        paperFillId: flow.fillId,
        executionAttemptId: flow.attemptId,
        eventType: PositionEventType.Fill,
        exchange: 'NSE',
        tradingsymbol: 'COMPUTE',
        product: 'MIS',
        quantityDelta: 75,
        price: 100.00,
        previousQuantity: 0,
        previousAvgCost: 0,
        newQuantity: 75,
        newAvgCost: 100.00,
        realizedPnl: 0,
        createdAt: Date.now(),
      });

      const result = ctx.posRepo.computePositionFromEvents('NSE', 'COMPUTE', 'MIS');
      expect(result.side).toBe(PositionSide.Long);
      expect(result.quantity).toBe(75);
      expect(result.avgCostPrice).toBe(100.00);
      expect(result.realizedPnl).toBe(0);
    });

    it('computes flat position after buy-then-sell cycle with realized P&L', () => {
      const ctx = createContext();
      const now = Date.now();

      // Buy 50 at 100
      const buy = insertFullPaperFlow(ctx, { tradingsymbol: 'CYCLE', side: 'buy', quantity: 50, price: 100.00, createdAt: now });
      ctx.posRepo.insertEvent({
        paperOrderId: buy.orderId,
        paperFillId: buy.fillId,
        executionAttemptId: buy.attemptId,
        eventType: PositionEventType.Fill,
        exchange: 'NSE', tradingsymbol: 'CYCLE', product: 'MIS',
        quantityDelta: 50, price: 100.00,
        previousQuantity: 0, previousAvgCost: 0,
        newQuantity: 50, newAvgCost: 100.00,
        realizedPnl: 0, createdAt: now,
      });

      // Sell 50 at 110
      const sell = insertFullPaperFlow(ctx, { tradingsymbol: 'CYCLE', side: 'sell', quantity: 50, price: 110.00, createdAt: now + 1000 });
      ctx.posRepo.insertEvent({
        paperOrderId: sell.orderId,
        paperFillId: sell.fillId,
        executionAttemptId: sell.attemptId,
        eventType: PositionEventType.Close,
        exchange: 'NSE', tradingsymbol: 'CYCLE', product: 'MIS',
        quantityDelta: -50, price: 110.00,
        previousQuantity: 50, previousAvgCost: 100.00,
        newQuantity: 0, newAvgCost: 0,
        realizedPnl: 500.00, createdAt: now + 1000,
      });

      const result = ctx.posRepo.computePositionFromEvents('NSE', 'CYCLE', 'MIS');
      expect(result.side).toBe(PositionSide.Flat);
      expect(result.quantity).toBe(0);
      expect(result.avgCostPrice).toBe(0);
      expect(result.realizedPnl).toBe(500.00);
    });
  });

  describe('reconstructAllPositions', () => {
    it('rebuilds positions from events', () => {
      const ctx = createContext();
      const now = Date.now();

      // Buy 75 RELIANCE
      const flow1 = insertFullPaperFlow(ctx, { tradingsymbol: 'RELIANCE', side: 'buy', quantity: 75, price: 2850.00, createdAt: now });
      ctx.posRepo.insertEvent({
        paperOrderId: flow1.orderId, paperFillId: flow1.fillId,
        executionAttemptId: flow1.attemptId,
        eventType: PositionEventType.Fill,
        exchange: 'NSE', tradingsymbol: 'RELIANCE', product: 'MIS',
        quantityDelta: 75, price: 2850.00,
        previousQuantity: 0, previousAvgCost: 0,
        newQuantity: 75, newAvgCost: 2850.00,
        realizedPnl: 0, createdAt: now,
      });

      // Buy 50 TCS
      const flow2 = insertFullPaperFlow(ctx, { tradingsymbol: 'TCS', side: 'buy', quantity: 50, price: 3800.00, createdAt: now + 500 });
      ctx.posRepo.insertEvent({
        paperOrderId: flow2.orderId, paperFillId: flow2.fillId,
        executionAttemptId: flow2.attemptId,
        eventType: PositionEventType.Fill,
        exchange: 'NSE', tradingsymbol: 'TCS', product: 'MIS',
        quantityDelta: 50, price: 3800.00,
        previousQuantity: 0, previousAvgCost: 0,
        newQuantity: 50, newAvgCost: 3800.00,
        realizedPnl: 0, createdAt: now + 500,
      });

      // Reconstruct
      const positions = ctx.posRepo.reconstructAllPositions();
      expect(positions.length).toBe(2);

      const rel = positions.find(p => p.tradingsymbol === 'RELIANCE');
      expect(rel).not.toBeUndefined();
      expect(rel!.quantity).toBe(75);
      expect(rel!.side).toBe(PositionSide.Long);

      const tcs = positions.find(p => p.tradingsymbol === 'TCS');
      expect(tcs).not.toBeUndefined();
      expect(tcs!.quantity).toBe(50);
    });

    it('returns empty array when no events exist', () => {
      const ctx = createContext();
      const positions = ctx.posRepo.reconstructAllPositions();
      expect(positions).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Negative tests
  // -----------------------------------------------------------------------

  describe('negative tests', () => {
    it('handles zero positions after flat close via countOpenPositions', () => {
      const ctx = createContext();
      expect(ctx.posRepo.countOpenPositions()).toBe(0);
    });

    it('handles multiple fills for same position key ordering', () => {
      const ctx = createContext();
      const now = Date.now();

      // Three fills for INFY at different prices
      for (let i = 0; i < 3; i++) {
        const tr = 'INFY';
        const qty = 10;
        const price = 1600 + i * 50;
        const t = now + i * 1000;

        const flow = insertFullPaperFlow(ctx, { tradingsymbol: tr, side: 'buy', quantity: qty, price, createdAt: t });
        ctx.posRepo.insertEvent({
          paperOrderId: flow.orderId, paperFillId: flow.fillId,
          executionAttemptId: flow.attemptId,
          eventType: PositionEventType.Fill,
          exchange: 'NSE', tradingsymbol: tr, product: 'MIS',
          quantityDelta: qty, price,
          previousQuantity: i * qty,
          previousAvgCost: i > 0 ? 1600 + (i - 1) * 50 : 0,
          newQuantity: (i + 1) * qty,
          newAvgCost: price,
          realizedPnl: 0,
          createdAt: t,
        });
      }

      const events = ctx.posRepo.getEventsByKey('NSE', 'INFY', 'MIS');
      expect(events.length).toBe(3);
      expect(events[0].price).toBe(1600);
      expect(events[1].price).toBe(1650);
      expect(events[2].price).toBe(1700);

      // After all fills, position should be 30 long
      const result = ctx.posRepo.computePositionFromEvents('NSE', 'INFY', 'MIS');
      expect(result.quantity).toBe(30);
      expect(result.side).toBe(PositionSide.Long);
    });

    it('handles position event with null paper_fill_id', () => {
      const ctx = createContext();
      const flow = insertFullPaperFlow(ctx, { tradingsymbol: 'NULL_FILL', side: 'buy', quantity: 10, price: 100 });

      const event = ctx.posRepo.insertEvent({
        paperOrderId: flow.orderId,
        paperFillId: null,
        executionAttemptId: flow.attemptId,
        eventType: PositionEventType.Open,
        exchange: 'NSE', tradingsymbol: 'NULL_FILL', product: 'MIS',
        quantityDelta: 10, price: 100,
        previousQuantity: 0, previousAvgCost: 0,
        newQuantity: 10, newAvgCost: 100,
        realizedPnl: 0, createdAt: Date.now(),
      });

      expect(event.paperFillId).toBeNull();
    });
  });
});
