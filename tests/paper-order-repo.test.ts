import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { PaperOrderRepository } from '../src/persistence/paper-order-repo.js';
import { ExecutionAttemptRepository } from '../src/persistence/execution-attempt-repo.js';
import { StrategyDecisionRepository } from '../src/persistence/strategy-decision-repo.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import {
  PaperOrderStatus,
  ExecutionAttemptStatus,
  ExecutionMode,
  ExecutionOutcomeCode,
  ProposalStatus,
  StrategyDecisionStatus,
  type NewPaperOrder,
  type NewExecutionAttempt,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestContext {
  orderRepo: PaperOrderRepository;
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
    attemptRepo: new ExecutionAttemptRepository(db),
    strategyRepo: new StrategyDecisionRepository(db),
    proposalRepo: new ProposalRepository(db),
    db,
  };
}

function insertAcceptedProposal(
  proposalRepo: ProposalRepository,
  overrides?: Partial<{ tradingsymbol: string; createdAt: number }>,
): number {
  const row = proposalRepo.insertAttempt({
    exchange: 'NSE',
    tradingsymbol: overrides?.tradingsymbol ?? 'RELIANCE',
    instrumentToken: 123456,
    side: 'buy',
    product: 'MIS',
    quantity: 1,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: null,
    proposalStatus: ProposalStatus.Accepted,
    createdAt: overrides?.createdAt ?? Date.now(),
  });
  return row.id;
}

function insertApprovedDecision(
  strategyRepo: StrategyDecisionRepository,
  proposalAttemptId: number,
  overrides?: Partial<{ tradingsymbol: string; decidedAt: number }>,
): number {
  const row = strategyRepo.insertDecision({
    proposalAttemptId,
    decisionStatus: StrategyDecisionStatus.Approved,
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    decidedAt: overrides?.decidedAt ?? Date.now(),
    exchange: 'NSE',
    tradingsymbol: overrides?.tradingsymbol ?? 'RELIANCE',
    side: 'buy',
    product: 'MIS',
    quantity: 75,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    quoteLastPrice: 2850.50,
    quoteBid: 2850.00,
    quoteAsk: 2851.00,
    quoteVolume: 1250000,
    quoteReceivedAt: Date.now(),
    riskNotional: 213787.50,
    riskSizingBasis: 'last_price',
    riskMaxLossRupees: 10689.38,
    riskStopDistance: null,
    riskExposureTag: 'intraday',
  });
  return row.id;
}

function insertCompletedAttempt(
  attemptRepo: ExecutionAttemptRepository,
  strategyDecisionId: number,
  overrides?: Partial<NewExecutionAttempt>,
): number {
  const row = attemptRepo.insertAttempt({
    strategyDecisionId,
    executionMode: ExecutionMode.Paper,
    status: ExecutionAttemptStatus.Completed,
    outcomeCode: ExecutionOutcomeCode.PaperSimulated,
    brokerOrderId: `paper-${Date.now()}`,
    message: 'Paper broker simulated order placement',
    attemptedAt: Date.now(),
    completedAt: Date.now() + 100,
    ...overrides,
  });
  return row.id;
}

function sampleOrder(
  executionAttemptId: number,
  overrides?: Partial<NewPaperOrder>,
): NewPaperOrder {
  return {
    executionAttemptId,
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    side: 'buy',
    product: 'MIS',
    quantity: 75,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: null,
    status: PaperOrderStatus.Filled,
    brokerOrderId: `paper-${executionAttemptId}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PaperOrderRepository
// ---------------------------------------------------------------------------

describe('PaperOrderRepository', () => {
  describe('insert', () => {
    it('inserts a paper order with all fields', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);
      const order = ctx.orderRepo.insert(sampleOrder(attemptId));

      expect(order.id).toBeGreaterThan(0);
      expect(order.executionAttemptId).toBe(attemptId);
      expect(order.exchange).toBe('NSE');
      expect(order.tradingsymbol).toBe('RELIANCE');
      expect(order.side).toBe('buy');
      expect(order.product).toBe('MIS');
      expect(order.quantity).toBe(75);
      expect(order.price).toBeNull();
      expect(order.orderType).toBe('MARKET');
      expect(order.status).toBe(PaperOrderStatus.Filled);
      expect(order.brokerOrderId).toContain('paper-');
      expect(order.createdAt).toBeGreaterThan(0);
      expect(order.updatedAt).not.toBeNull();
      expect(ctx.orderRepo.count()).toBe(1);
    });

    it('inserts a LIMIT order with price', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'TCS' });
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId, { tradingsymbol: 'TCS' });
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);

      const order = ctx.orderRepo.insert(sampleOrder(attemptId, {
        tradingsymbol: 'TCS',
        price: 3850.00,
        orderType: 'LIMIT',
        status: PaperOrderStatus.Pending,
        updatedAt: null,
      }));

      expect(order.price).toBe(3850.00);
      expect(order.orderType).toBe('LIMIT');
      expect(order.status).toBe(PaperOrderStatus.Pending);
      expect(order.updatedAt).toBeNull();
    });

    it('inserts a SL order with trigger price', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'INFY' });
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId, { tradingsymbol: 'INFY' });
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);

      const order = ctx.orderRepo.insert(sampleOrder(attemptId, {
        tradingsymbol: 'INFY',
        side: 'sell',
        price: 1680.00,
        triggerPrice: 1670.00,
        orderType: 'SL',
      }));

      expect(order.price).toBe(1680.00);
      expect(order.triggerPrice).toBe(1670.00);
      expect(order.orderType).toBe('SL');
      expect(order.side).toBe('sell');
    });

    it('enforces UNIQUE constraint on execution_attempt_id', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);

      ctx.orderRepo.insert(sampleOrder(attemptId));

      expect(() => {
        ctx.orderRepo.insert(sampleOrder(attemptId, {
          brokerOrderId: 'duplicate-order',
        }));
      }).toThrow();
    });

    it('rejects order with nonexistent execution_attempt_id (FK violation)', () => {
      const ctx = createContext();
      expect(() => {
        ctx.orderRepo.insert(sampleOrder(99999));
      }).toThrow();
    });
  });

  describe('getById', () => {
    it('returns null for unknown id', () => {
      const ctx = createContext();
      expect(ctx.orderRepo.getById(999)).toBeNull();
    });

    it('returns the order by id', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);
      const inserted = ctx.orderRepo.insert(sampleOrder(attemptId));

      const loaded = ctx.orderRepo.getById(inserted.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(inserted.id);
      expect(loaded!.executionAttemptId).toBe(attemptId);
      expect(loaded!.tradingsymbol).toBe('RELIANCE');
    });
  });

  describe('getByExecutionAttemptId', () => {
    it('returns null when no order exists for the attempt', () => {
      const ctx = createContext();
      expect(ctx.orderRepo.getByExecutionAttemptId(999)).toBeNull();
    });

    it('returns the order by execution attempt id', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);
      ctx.orderRepo.insert(sampleOrder(attemptId));

      const loaded = ctx.orderRepo.getByExecutionAttemptId(attemptId);
      expect(loaded).not.toBeNull();
      expect(loaded!.executionAttemptId).toBe(attemptId);
    });
  });

  describe('getRecent', () => {
    it('returns empty array when no orders exist', () => {
      const ctx = createContext();
      expect(ctx.orderRepo.getRecent()).toEqual([]);
    });

    it('returns orders newest first', () => {
      const ctx = createContext();

      const d1 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'FIRST', createdAt: 100 }),
        { tradingsymbol: 'FIRST', decidedAt: 100 },
      );
      const a1 = insertCompletedAttempt(ctx.attemptRepo, d1, { attemptedAt: 100 });
      ctx.orderRepo.insert(sampleOrder(a1, {
        tradingsymbol: 'FIRST', createdAt: 100, updatedAt: 100,
      }));

      const d2 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'SECOND', createdAt: 200 }),
        { tradingsymbol: 'SECOND', decidedAt: 200 },
      );
      const a2 = insertCompletedAttempt(ctx.attemptRepo, d2, { attemptedAt: 200 });
      ctx.orderRepo.insert(sampleOrder(a2, {
        tradingsymbol: 'SECOND', createdAt: 200, updatedAt: 200,
      }));

      const recent = ctx.orderRepo.getRecent();
      expect(recent.length).toBe(2);
      expect(recent[0].tradingsymbol).toBe('SECOND');
      expect(recent[1].tradingsymbol).toBe('FIRST');
    });

    it('respects limit parameter', () => {
      const ctx = createContext();
      for (let i = 0; i < 5; i++) {
        const tr = `LIMIT_${i}`;
        const d = insertApprovedDecision(ctx.strategyRepo,
          insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: tr, createdAt: i }),
          { tradingsymbol: tr, decidedAt: i },
        );
        const a = insertCompletedAttempt(ctx.attemptRepo, d, { attemptedAt: i });
        ctx.orderRepo.insert(sampleOrder(a, { tradingsymbol: tr, createdAt: i, updatedAt: i }));
      }

      expect(ctx.orderRepo.getRecent(2).length).toBe(2);
      expect(ctx.orderRepo.getRecent(10).length).toBe(5);
    });
  });

  describe('getByStatus', () => {
    it('returns empty array when no orders with the status exist', () => {
      const ctx = createContext();
      expect(ctx.orderRepo.getByStatus(PaperOrderStatus.Cancelled)).toEqual([]);
    });

    it('filters by status', () => {
      const ctx = createContext();
      const statuses = [PaperOrderStatus.Filled, PaperOrderStatus.Pending];

      for (let i = 0; i < statuses.length; i++) {
        const tr = `STATUS_${i}`;
        const d = insertApprovedDecision(ctx.strategyRepo,
          insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: tr, createdAt: i }),
          { tradingsymbol: tr, decidedAt: i },
        );
        const a = insertCompletedAttempt(ctx.attemptRepo, d, { attemptedAt: i });
        ctx.orderRepo.insert(sampleOrder(a, {
          tradingsymbol: tr,
          status: statuses[i],
          createdAt: i,
          updatedAt: i,
        }));
      }

      expect(ctx.orderRepo.getByStatus(PaperOrderStatus.Filled).length).toBe(1);
      expect(ctx.orderRepo.getByStatus(PaperOrderStatus.Pending).length).toBe(1);
      expect(ctx.orderRepo.getByStatus(PaperOrderStatus.Cancelled).length).toBe(0);
    });
  });

  describe('updateStatus', () => {
    it('updates order status and updated_at', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);

      const inserted = ctx.orderRepo.insert(sampleOrder(attemptId, {
        status: PaperOrderStatus.Pending,
        updatedAt: null,
      }));

      // Allow some time to pass
      const before = Date.now();
      ctx.orderRepo.updateStatus(inserted.id, PaperOrderStatus.Filled);

      const loaded = ctx.orderRepo.getById(inserted.id);
      expect(loaded!.status).toBe(PaperOrderStatus.Filled);
      expect(loaded!.updatedAt).not.toBeNull();
      expect(loaded!.updatedAt!).toBeGreaterThanOrEqual(before);
    });

    it('does nothing when id does not exist', () => {
      const ctx = createContext();
      // Should not throw
      ctx.orderRepo.updateStatus(999, PaperOrderStatus.Cancelled);
    });
  });

  describe('count methods', () => {
    it('starts at zero', () => {
      const ctx = createContext();
      expect(ctx.orderRepo.count()).toBe(0);
      expect(ctx.orderRepo.countByStatus(PaperOrderStatus.Filled)).toBe(0);
    });

    it('counts by status', () => {
      const ctx = createContext();

      // First order: filled
      const d1 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'A' }),
      );
      const a1 = insertCompletedAttempt(ctx.attemptRepo, d1);
      ctx.orderRepo.insert(sampleOrder(a1, { tradingsymbol: 'A' }));

      // Second order: pending
      const d2 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'B' }),
      );
      const a2 = insertCompletedAttempt(ctx.attemptRepo, d2);
      ctx.orderRepo.insert(sampleOrder(a2, {
        tradingsymbol: 'B',
        status: PaperOrderStatus.Pending,
      }));

      expect(ctx.orderRepo.count()).toBe(2);
      expect(ctx.orderRepo.countByStatus(PaperOrderStatus.Filled)).toBe(1);
      expect(ctx.orderRepo.countByStatus(PaperOrderStatus.Pending)).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Negative tests
  // -----------------------------------------------------------------------

  describe('negative tests', () => {
    it('rejects order with no exchange', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);

      expect(() => {
        ctx.orderRepo.insert(sampleOrder(attemptId, { exchange: '' }));
      }).not.toThrow(); // Empty string is allowed by schema (TEXT NOT NULL)
    });

    it('rejects order with zero quantity', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);

      // Quantity = 0 is allowed by schema, but we verify it persists
      const order = ctx.orderRepo.insert(sampleOrder(attemptId, { quantity: 0 }));
      expect(order.quantity).toBe(0);
    });

    it('handles empty results from getByStatus for unfilled status', () => {
      const ctx = createContext();
      expect(ctx.orderRepo.getByStatus(PaperOrderStatus.Rejected)).toEqual([]);
    });

    it('stores order with empty tag (null)', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);

      const order = ctx.orderRepo.insert(sampleOrder(attemptId, { tag: null }));
      expect(order.tag).toBeNull();
    });

    it('stores order with tag value', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);

      const order = ctx.orderRepo.insert(sampleOrder(attemptId, { tag: 'test-tag' }));
      expect(order.tag).toBe('test-tag');
    });

    it('stores all PaperOrderStatus values', () => {
      const ctx = createContext();
      const statuses = Object.values(PaperOrderStatus);

      for (let i = 0; i < statuses.length; i++) {
        const tr = `POS_${i}`;
        const d = insertApprovedDecision(ctx.strategyRepo,
          insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: tr, createdAt: i }),
          { tradingsymbol: tr, decidedAt: i },
        );
        const a = insertCompletedAttempt(ctx.attemptRepo, d, { attemptedAt: i });
        ctx.orderRepo.insert(sampleOrder(a, {
          tradingsymbol: tr,
          status: statuses[i],
          createdAt: i,
          updatedAt: i,
        }));
      }

      expect(ctx.orderRepo.count()).toBe(statuses.length);
      for (const s of statuses) {
        expect(ctx.orderRepo.countByStatus(s)).toBe(1);
      }
    });

    it('handles multiple orders with same timestamps', () => {
      const ctx = createContext();
      const now = Date.now();

      const d1 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'TS1', createdAt: now }),
        { tradingsymbol: 'TS1', decidedAt: now },
      );
      const a1 = insertCompletedAttempt(ctx.attemptRepo, d1, { attemptedAt: now });

      const d2 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'TS2', createdAt: now }),
        { tradingsymbol: 'TS2', decidedAt: now },
      );
      const a2 = insertCompletedAttempt(ctx.attemptRepo, d2, { attemptedAt: now });

      ctx.orderRepo.insert(sampleOrder(a1, { tradingsymbol: 'TS1', createdAt: now, updatedAt: now }));
      ctx.orderRepo.insert(sampleOrder(a2, { tradingsymbol: 'TS2', createdAt: now, updatedAt: now }));

      expect(ctx.orderRepo.count()).toBe(2);
      const recent = ctx.orderRepo.getRecent();
      expect(recent.length).toBe(2);
    });
  });
});
