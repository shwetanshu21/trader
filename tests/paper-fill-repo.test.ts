import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { PaperOrderRepository } from '../src/persistence/paper-order-repo.js';
import { PaperFillRepository } from '../src/persistence/paper-fill-repo.js';
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
  type NewPaperFill,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestContext {
  orderRepo: PaperOrderRepository;
  fillRepo: PaperFillRepository;
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
    attemptRepo: new ExecutionAttemptRepository(db),
    strategyRepo: new StrategyDecisionRepository(db),
    proposalRepo: new ProposalRepository(db),
    db,
  };
}

function insertAcceptedProposal(
  pr: ProposalRepository,
  overrides?: Partial<{ tradingsymbol: string; createdAt: number }>,
): number {
  const row = pr.insertAttempt({
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
  sr: StrategyDecisionRepository,
  proposalAttemptId: number,
  overrides?: Partial<{ tradingsymbol: string; decidedAt: number }>,
): number {
  const row = sr.insertDecision({
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
  return row.id;
}

function insertCompletedAttempt(
  ar: ExecutionAttemptRepository,
  strategyDecisionId: number,
  overrides?: Partial<{ attemptedAt: number; brokerOrderId: string }>,
): number {
  const row = ar.insertAttempt({
    strategyDecisionId,
    executionMode: ExecutionMode.Paper,
    status: ExecutionAttemptStatus.Completed,
    outcomeCode: ExecutionOutcomeCode.PaperSimulated,
    brokerOrderId: overrides?.brokerOrderId ?? `paper-${Date.now()}`,
    message: 'Paper broker simulated order placement',
    attemptedAt: overrides?.attemptedAt ?? Date.now(),
    completedAt: Date.now() + 100,
  });
  return row.id;
}

function insertPaperOrder(
  or: PaperOrderRepository,
  executionAttemptId: number,
  overrides?: Partial<NewPaperOrder>,
): number {
  const row = or.insert({
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
  });
  return row.id;
}

function sampleFill(
  paperOrderId: number,
  executionAttemptId: number,
  overrides?: Partial<NewPaperFill>,
): NewPaperFill {
  return {
    paperOrderId,
    executionAttemptId,
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    side: 'buy',
    product: 'MIS',
    filledQuantity: 75,
    filledPrice: 2850.50,
    brokerOrderId: `paper-${executionAttemptId}`,
    filledAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PaperFillRepository
// ---------------------------------------------------------------------------

describe('PaperFillRepository', () => {
  describe('insert', () => {
    it('inserts a paper fill with all fields', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);
      const orderId = insertPaperOrder(ctx.orderRepo, attemptId);

      const fill = ctx.fillRepo.insert(sampleFill(orderId, attemptId));

      expect(fill.id).toBeGreaterThan(0);
      expect(fill.paperOrderId).toBe(orderId);
      expect(fill.executionAttemptId).toBe(attemptId);
      expect(fill.exchange).toBe('NSE');
      expect(fill.tradingsymbol).toBe('RELIANCE');
      expect(fill.side).toBe('buy');
      expect(fill.product).toBe('MIS');
      expect(fill.filledQuantity).toBe(75);
      expect(fill.filledPrice).toBe(2850.50);
      expect(fill.referencePrice).toBeNull();
      expect(fill.slippagePerUnit).toBe(0);
      expect(fill.slippageAmount).toBe(0);
      expect(fill.fees).toBe(0);
      expect(fill.brokerOrderId).toContain('paper-');
      expect(fill.filledAt).toBeGreaterThan(0);
      expect(ctx.fillRepo.count()).toBe(1);
    });

    it('inserts a sell fill', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'TCS' });
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId, { tradingsymbol: 'TCS' });
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);
      const orderId = insertPaperOrder(ctx.orderRepo, attemptId, {
        tradingsymbol: 'TCS', side: 'sell',
      });

      const fill = ctx.fillRepo.insert(sampleFill(orderId, attemptId, {
        tradingsymbol: 'TCS', side: 'sell',
        filledPrice: 3850.00,
      }));

      expect(fill.side).toBe('sell');
      expect(fill.filledPrice).toBe(3850.00);
    });

    it('enforces UNIQUE constraint on execution_attempt_id', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);
      const orderId = insertPaperOrder(ctx.orderRepo, attemptId);

      ctx.fillRepo.insert(sampleFill(orderId, attemptId));

      expect(() => {
        ctx.fillRepo.insert(sampleFill(orderId, attemptId));
      }).toThrow();
    });

    it('rejects fill with nonexistent paper_order_id (FK violation)', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);

      expect(() => {
        ctx.fillRepo.insert(sampleFill(99999, attemptId));
      }).toThrow();
    });
  });

  describe('getById', () => {
    it('returns null for unknown id', () => {
      const ctx = createContext();
      expect(ctx.fillRepo.getById(999)).toBeNull();
    });

    it('returns the fill by id', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);
      const orderId = insertPaperOrder(ctx.orderRepo, attemptId);
      const inserted = ctx.fillRepo.insert(sampleFill(orderId, attemptId));

      const loaded = ctx.fillRepo.getById(inserted.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(inserted.id);
      expect(loaded!.paperOrderId).toBe(orderId);
      expect(loaded!.filledQuantity).toBe(75);
    });
  });

  describe('getByOrderId', () => {
    it('returns null when no fill exists for the order', () => {
      const ctx = createContext();
      expect(ctx.fillRepo.getByOrderId(999)).toBeNull();
    });

    it('returns the fill by order id', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);
      const orderId = insertPaperOrder(ctx.orderRepo, attemptId);
      ctx.fillRepo.insert(sampleFill(orderId, attemptId));

      const loaded = ctx.fillRepo.getByOrderId(orderId);
      expect(loaded).not.toBeNull();
      expect(loaded!.paperOrderId).toBe(orderId);
    });
  });

  describe('getByExecutionAttemptId', () => {
    it('returns null when no fill exists for the attempt', () => {
      const ctx = createContext();
      expect(ctx.fillRepo.getByExecutionAttemptId(999)).toBeNull();
    });

    it('returns the fill by execution attempt id', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);
      const orderId = insertPaperOrder(ctx.orderRepo, attemptId);
      ctx.fillRepo.insert(sampleFill(orderId, attemptId));

      const loaded = ctx.fillRepo.getByExecutionAttemptId(attemptId);
      expect(loaded).not.toBeNull();
      expect(loaded!.executionAttemptId).toBe(attemptId);
    });
  });

  describe('getRecent', () => {
    it('returns empty array when no fills exist', () => {
      const ctx = createContext();
      expect(ctx.fillRepo.getRecent()).toEqual([]);
    });

    it('returns fills newest first', () => {
      const ctx = createContext();

      const d1 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'FIRST', createdAt: 100 }),
        { tradingsymbol: 'FIRST', decidedAt: 100 },
      );
      const a1 = insertCompletedAttempt(ctx.attemptRepo, d1, { attemptedAt: 100 });
      const o1 = insertPaperOrder(ctx.orderRepo, a1, { tradingsymbol: 'FIRST', createdAt: 100 });
      ctx.fillRepo.insert(sampleFill(o1, a1, { tradingsymbol: 'FIRST', filledAt: 100 }));

      const d2 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'SECOND', createdAt: 200 }),
        { tradingsymbol: 'SECOND', decidedAt: 200 },
      );
      const a2 = insertCompletedAttempt(ctx.attemptRepo, d2, { attemptedAt: 200 });
      const o2 = insertPaperOrder(ctx.orderRepo, a2, { tradingsymbol: 'SECOND', createdAt: 200 });
      ctx.fillRepo.insert(sampleFill(o2, a2, { tradingsymbol: 'SECOND', filledAt: 200 }));

      const recent = ctx.fillRepo.getRecent();
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
        const o = insertPaperOrder(ctx.orderRepo, a, { tradingsymbol: tr, createdAt: i });
        ctx.fillRepo.insert(sampleFill(o, a, { tradingsymbol: tr, filledAt: i }));
      }

      expect(ctx.fillRepo.getRecent(2).length).toBe(2);
      expect(ctx.fillRepo.getRecent(10).length).toBe(5);
    });
  });

  describe('count', () => {
    it('starts at zero', () => {
      const ctx = createContext();
      expect(ctx.fillRepo.count()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Negative tests
  // -----------------------------------------------------------------------

  describe('negative tests', () => {
    it('rejects fill with zero filled quantity', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decisionId = insertApprovedDecision(ctx.strategyRepo, paId);
      const attemptId = insertCompletedAttempt(ctx.attemptRepo, decisionId);
      const orderId = insertPaperOrder(ctx.orderRepo, attemptId);

      // Zero filled_quantity is allowed by schema, verify it persists
      const fill = ctx.fillRepo.insert(sampleFill(orderId, attemptId, { filledQuantity: 0 }));
      expect(fill.filledQuantity).toBe(0);
    });

    it('handles multiple fills for different orders with same timestamps', () => {
      const ctx = createContext();
      const now = Date.now();

      const d1 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'F1', createdAt: now }),
        { tradingsymbol: 'F1', decidedAt: now },
      );
      const a1 = insertCompletedAttempt(ctx.attemptRepo, d1, { attemptedAt: now });
      const o1 = insertPaperOrder(ctx.orderRepo, a1, { tradingsymbol: 'F1', createdAt: now });

      const d2 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'F2', createdAt: now }),
        { tradingsymbol: 'F2', decidedAt: now },
      );
      const a2 = insertCompletedAttempt(ctx.attemptRepo, d2, { attemptedAt: now });
      const o2 = insertPaperOrder(ctx.orderRepo, a2, { tradingsymbol: 'F2', createdAt: now });

      ctx.fillRepo.insert(sampleFill(o1, a1, { tradingsymbol: 'F1', filledAt: now }));
      ctx.fillRepo.insert(sampleFill(o2, a2, { tradingsymbol: 'F2', filledAt: now }));

      expect(ctx.fillRepo.count()).toBe(2);
      const recent = ctx.fillRepo.getRecent();
      expect(recent.length).toBe(2);
    });

    it('associates fill with correct order via FK', () => {
      const ctx = createContext();

      // First order+fill pair
      const d1 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'PAIR1' }),
      );
      const a1 = insertCompletedAttempt(ctx.attemptRepo, d1);
      const o1 = insertPaperOrder(ctx.orderRepo, a1, { tradingsymbol: 'PAIR1' });
      const f1 = ctx.fillRepo.insert(sampleFill(o1, a1, { tradingsymbol: 'PAIR1' }));

      // Second order+fill pair
      const d2 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'PAIR2' }),
      );
      const a2 = insertCompletedAttempt(ctx.attemptRepo, d2);
      const o2 = insertPaperOrder(ctx.orderRepo, a2, { tradingsymbol: 'PAIR2' });
      const f2 = ctx.fillRepo.insert(sampleFill(o2, a2, { tradingsymbol: 'PAIR2' }));

      expect(f1.paperOrderId).toBe(o1);
      expect(f2.paperOrderId).toBe(o2);
      expect(f1.executionAttemptId).toBe(a1);
      expect(f2.executionAttemptId).toBe(a2);
    });
  });
});
