import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ExecutionAttemptRepository } from '../src/persistence/execution-attempt-repo.js';
import { StrategyDecisionRepository } from '../src/persistence/strategy-decision-repo.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import {
  ExecutionAttemptStatus,
  ExecutionMode,
  ExecutionOutcomeCode,
  ExecutionRefusalCode,
  ProposalStatus,
  StrategyDecisionStatus,
  type NewExecutionAttempt,
  type NewProposalAttempt,
  type NewStrategyDecision,
  type ExecutionRefusalReason,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestContext {
  attemptRepo: ExecutionAttemptRepository;
  strategyRepo: StrategyDecisionRepository;
  proposalRepo: ProposalRepository;
  db: Database.Database;
}

function createContext(): TestContext {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;
  return {
    attemptRepo: new ExecutionAttemptRepository(db),
    strategyRepo: new StrategyDecisionRepository(db),
    proposalRepo: new ProposalRepository(db),
    db,
  };
}

function insertAcceptedProposal(
  proposalRepo: ProposalRepository,
  overrides?: Partial<NewProposalAttempt>,
): number {
  const row = proposalRepo.insertAttempt({
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
    ...overrides,
  });
  return row.id;
}

function insertApprovedDecision(
  strategyRepo: StrategyDecisionRepository,
  proposalAttemptId: number,
  overrides?: Partial<NewStrategyDecision>,
): { id: number } {
  const row = strategyRepo.insertDecision({
    proposalAttemptId,
    decisionStatus: StrategyDecisionStatus.Approved,
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    decidedAt: Date.now(),
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
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
    ...overrides,
  });
  return { id: row.id };
}

function sampleAttempt(
  strategyDecisionId: number,
  overrides?: Partial<NewExecutionAttempt>,
): NewExecutionAttempt {
  return {
    strategyDecisionId,
    executionMode: ExecutionMode.Blocked,
    status: ExecutionAttemptStatus.Refused,
    outcomeCode: null,
    brokerOrderId: null,
    message: 'M003 hard block: execution mode is blocked',
    attemptedAt: Date.now(),
    completedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ExecutionAttemptRepository
// ---------------------------------------------------------------------------

describe('ExecutionAttemptRepository', () => {
  describe('insertAttempt', () => {
    it('inserts a refused execution attempt (blocked mode)', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);

      const attempt = ctx.attemptRepo.insertAttempt(
        sampleAttempt(decision.id),
      );

      expect(attempt.id).toBeGreaterThan(0);
      expect(attempt.strategyDecisionId).toBe(decision.id);
      expect(attempt.executionMode).toBe(ExecutionMode.Blocked);
      expect(attempt.status).toBe(ExecutionAttemptStatus.Refused);
      expect(attempt.outcomeCode).toBeNull();
      expect(attempt.brokerOrderId).toBeNull();
      expect(attempt.message).toContain('blocked');
      expect(attempt.completedAt).toBeNull();
      expect(ctx.attemptRepo.count()).toBe(1);
    });

    it('inserts a completed execution attempt (paper mode)', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);

      const attempt = ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id, {
        executionMode: ExecutionMode.Paper,
        status: ExecutionAttemptStatus.Completed,
        outcomeCode: ExecutionOutcomeCode.PaperSimulated,
        brokerOrderId: 'paper-12345',
        message: 'Paper broker simulated order placement',
        attemptedAt: Date.now(),
        completedAt: Date.now() + 100,
      }));

      expect(attempt.id).toBeGreaterThan(0);
      expect(attempt.executionMode).toBe(ExecutionMode.Paper);
      expect(attempt.status).toBe(ExecutionAttemptStatus.Completed);
      expect(attempt.outcomeCode).toBe(ExecutionOutcomeCode.PaperSimulated);
      expect(attempt.brokerOrderId).toBe('paper-12345');
      expect(attempt.completedAt).not.toBeNull();
    });

    it('inserts a completed execution attempt (live mode)', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);

      const attempt = ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id, {
        executionMode: ExecutionMode.Live,
        status: ExecutionAttemptStatus.Completed,
        outcomeCode: ExecutionOutcomeCode.OrderPlaced,
        brokerOrderId: 'live-ORD-67890',
        message: 'Order placed successfully via Kite',
        attemptedAt: Date.now(),
        completedAt: Date.now() + 200,
      }));

      expect(attempt.id).toBeGreaterThan(0);
      expect(attempt.executionMode).toBe(ExecutionMode.Live);
      expect(attempt.status).toBe(ExecutionAttemptStatus.Completed);
      expect(attempt.outcomeCode).toBe(ExecutionOutcomeCode.OrderPlaced);
      expect(attempt.brokerOrderId).toBe('live-ORD-67890');
    });

    it('enforces UNIQUE constraint on strategy_decision_id', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);

      ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id));

      expect(() => {
        ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id));
      }).toThrow();
    });

    it('stores all ExecutionOutcomeCode values', () => {
      const ctx = createContext();
      const codes = Object.values(ExecutionOutcomeCode);

      for (let i = 0; i < codes.length; i++) {
        const paId = insertAcceptedProposal(ctx.proposalRepo, {
          tradingsymbol: `OUTCOME_${i}`,
          createdAt: Date.now() + i,
        });
        const decision = insertApprovedDecision(ctx.strategyRepo, paId, {
          tradingsymbol: `OUTCOME_${i}`,
          decidedAt: Date.now() + i,
        });

        ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id, {
          status: ExecutionAttemptStatus.Completed,
          outcomeCode: codes[i],
          brokerOrderId: `broker-${i}`,
          message: `Outcome: ${codes[i]}`,
          completedAt: Date.now() + i + 1000,
        }));
      }

      expect(ctx.attemptRepo.count()).toBe(codes.length);
      const recent = ctx.attemptRepo.getRecent(codes.length);
      for (const code of codes) {
        const match = recent.find(a => a.outcomeCode === code);
        expect(match).not.toBeUndefined();
      }
    });
  });

  describe('getById', () => {
    it('returns null for unknown id', () => {
      const ctx = createContext();
      expect(ctx.attemptRepo.getById(999)).toBeNull();
    });

    it('returns the attempt by id', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);
      const inserted = ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id));

      const loaded = ctx.attemptRepo.getById(inserted.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(inserted.id);
      expect(loaded!.strategyDecisionId).toBe(decision.id);
      expect(loaded!.status).toBe(ExecutionAttemptStatus.Refused);
    });
  });

  describe('getByStrategyDecisionId', () => {
    it('returns null when no attempt exists for the decision', () => {
      const ctx = createContext();
      expect(ctx.attemptRepo.getByStrategyDecisionId(999)).toBeNull();
    });

    it('returns the attempt by strategy decision id', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);
      ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id));

      const loaded = ctx.attemptRepo.getByStrategyDecisionId(decision.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.strategyDecisionId).toBe(decision.id);
    });
  });

  describe('getRecent', () => {
    it('returns empty array when no attempts exist', () => {
      const ctx = createContext();
      expect(ctx.attemptRepo.getRecent()).toEqual([]);
    });

    it('returns attempts newest first', () => {
      const ctx = createContext();
      const d1 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'FIRST', createdAt: 100 }),
        { decidedAt: 100 },
      );
      const d2 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'SECOND', createdAt: 200 }),
        { decidedAt: 200 },
      );

      ctx.attemptRepo.insertAttempt(sampleAttempt(d1.id, { attemptedAt: 100 }));
      ctx.attemptRepo.insertAttempt(sampleAttempt(d2.id, { attemptedAt: 200 }));

      const recent = ctx.attemptRepo.getRecent();
      expect(recent.length).toBe(2);
      expect(recent[0].strategyDecisionId).toBe(d2.id);
      expect(recent[1].strategyDecisionId).toBe(d1.id);
    });

    it('respects limit parameter', () => {
      const ctx = createContext();
      for (let i = 0; i < 5; i++) {
        const d = insertApprovedDecision(ctx.strategyRepo,
          insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: `LIMIT_${i}`, createdAt: i }),
          { decidedAt: i },
        );
        ctx.attemptRepo.insertAttempt(sampleAttempt(d.id, { attemptedAt: i }));
      }

      expect(ctx.attemptRepo.getRecent(2).length).toBe(2);
      expect(ctx.attemptRepo.getRecent(10).length).toBe(5);
    });
  });

  describe('getByStatus', () => {
    it('returns empty array when no attempts with the status exist', () => {
      const ctx = createContext();
      expect(ctx.attemptRepo.getByStatus(ExecutionAttemptStatus.Dispatched)).toEqual([]);
    });

    it('filters by status', () => {
      const ctx = createContext();

      // One refused
      const d1 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'REFUSED' }),
      );
      ctx.attemptRepo.insertAttempt(sampleAttempt(d1.id));

      // One completed (paper)
      const d2 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'COMPLETED' }),
      );
      ctx.attemptRepo.insertAttempt(sampleAttempt(d2.id, {
        status: ExecutionAttemptStatus.Completed,
        outcomeCode: ExecutionOutcomeCode.PaperSimulated,
        brokerOrderId: 'paper-1',
        message: 'Paper simulated',
        completedAt: Date.now(),
      }));

      // One pending
      const d3 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'PENDING' }),
      );
      ctx.attemptRepo.insertAttempt(sampleAttempt(d3.id, {
        status: ExecutionAttemptStatus.Pending,
        message: 'Waiting for dispatch',
      }));

      expect(ctx.attemptRepo.getByStatus(ExecutionAttemptStatus.Refused).length).toBe(1);
      expect(ctx.attemptRepo.getByStatus(ExecutionAttemptStatus.Completed).length).toBe(1);
      expect(ctx.attemptRepo.getByStatus(ExecutionAttemptStatus.Pending).length).toBe(1);
      expect(ctx.attemptRepo.getByStatus(ExecutionAttemptStatus.Dispatched).length).toBe(0);
    });
  });

  describe('refusal reasons', () => {
    it('inserts and retrieves a single refusal reason', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);
      const attempt = ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id));

      ctx.attemptRepo.insertRefusalReason(attempt.id, {
        reasonCode: ExecutionRefusalCode.ModeBlocked,
        reasonMessage: 'Execution mode is set to blocked',
      });

      const reasons = ctx.attemptRepo.getRefusalReasons(attempt.id);
      expect(reasons.length).toBe(1);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.ModeBlocked);
      expect(reasons[0].reasonMessage).toBe('Execution mode is set to blocked');
    });

    it('inserts and retrieves multiple ordered refusal reasons', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);
      const attempt = ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id));

      ctx.attemptRepo.insertRefusalReason(attempt.id, {
        reasonCode: ExecutionRefusalCode.ModeBlocked,
        reasonMessage: 'Execution mode is set to blocked',
      });
      ctx.attemptRepo.insertRefusalReason(attempt.id, {
        reasonCode: ExecutionRefusalCode.MarketClosed,
        reasonMessage: 'Market is closed',
      });

      const reasons = ctx.attemptRepo.getRefusalReasons(attempt.id);
      expect(reasons.length).toBe(2);
      expect(reasons[0].reasonCode).toBe(ExecutionRefusalCode.ModeBlocked);
      expect(reasons[1].reasonCode).toBe(ExecutionRefusalCode.MarketClosed);
    });

    it('returns empty array when no refusal reasons exist', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);
      const attempt = ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id));

      const reasons = ctx.attemptRepo.getRefusalReasons(attempt.id);
      expect(reasons).toEqual([]);
    });

    it('stores all known ExecutionRefusalCode values', () => {
      const ctx = createContext();
      const allCodes = Object.values(ExecutionRefusalCode);

      for (let i = 0; i < allCodes.length; i++) {
        const code = allCodes[i];
        const paId = insertAcceptedProposal(ctx.proposalRepo, {
          tradingsymbol: `REF_CODE_${i}`,
          createdAt: Date.now() + i,
        });
        const decision = insertApprovedDecision(ctx.strategyRepo, paId, {
          tradingsymbol: `REF_CODE_${i}`,
          decidedAt: Date.now() + i,
        });
        const attempt = ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id, {
          attemptedAt: Date.now() + i,
        }));
        ctx.attemptRepo.insertRefusalReason(attempt.id, {
          reasonCode: code,
          reasonMessage: `Test for ${code}`,
        });
      }

      expect(ctx.attemptRepo.count()).toBe(allCodes.length);
    });
  });

  describe('insertAttemptWithRefusalReasons (transactional)', () => {
    it('atomically inserts an attempt without reasons', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);

      const attempt = ctx.attemptRepo.insertAttemptWithRefusalReasons(
        sampleAttempt(decision.id),
        [],
      );

      expect(attempt.id).toBeGreaterThan(0);
      expect(ctx.attemptRepo.count()).toBe(1);
      expect(ctx.attemptRepo.getRefusalReasons(attempt.id)).toEqual([]);
    });

    it('atomically inserts an attempt with multiple refusal reasons', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);

      const reasons: ExecutionRefusalReason[] = [
        { reasonCode: ExecutionRefusalCode.ModeBlocked, reasonMessage: 'Mode is blocked' },
        { reasonCode: ExecutionRefusalCode.LiveBrokerNotConfigured, reasonMessage: 'No live broker' },
      ];

      const attempt = ctx.attemptRepo.insertAttemptWithRefusalReasons(
        sampleAttempt(decision.id),
        reasons,
      );

      expect(attempt.id).toBeGreaterThan(0);
      expect(ctx.attemptRepo.count()).toBe(1);

      const loadedReasons = ctx.attemptRepo.getRefusalReasons(attempt.id);
      expect(loadedReasons.length).toBe(2);
      expect(loadedReasons[0].reasonCode).toBe(ExecutionRefusalCode.ModeBlocked);
      expect(loadedReasons[1].reasonCode).toBe(ExecutionRefusalCode.LiveBrokerNotConfigured);
    });
  });

  describe('count methods', () => {
    it('starts at zero', () => {
      const ctx = createContext();
      expect(ctx.attemptRepo.count()).toBe(0);
      expect(ctx.attemptRepo.countByStatus(ExecutionAttemptStatus.Refused)).toBe(0);
      expect(ctx.attemptRepo.countByStatus(ExecutionAttemptStatus.Completed)).toBe(0);
    });

    it('counts by status', () => {
      const ctx = createContext();

      const d1 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'A' }),
      );
      ctx.attemptRepo.insertAttempt(sampleAttempt(d1.id));

      const d2 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'B' }),
      );
      ctx.attemptRepo.insertAttempt(sampleAttempt(d2.id, {
        status: ExecutionAttemptStatus.Completed,
        outcomeCode: ExecutionOutcomeCode.PaperSimulated,
        brokerOrderId: 'b-1',
        message: 'Paper',
        completedAt: Date.now(),
      }));

      const d3 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'C' }),
      );
      ctx.attemptRepo.insertAttempt(sampleAttempt(d3.id));

      expect(ctx.attemptRepo.count()).toBe(3);
      expect(ctx.attemptRepo.countByStatus(ExecutionAttemptStatus.Refused)).toBe(2);
      expect(ctx.attemptRepo.countByStatus(ExecutionAttemptStatus.Completed)).toBe(1);
    });
  });

  describe('isConsumed', () => {
    it('returns false for a decision with no attempt', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);

      expect(ctx.attemptRepo.isConsumed(decision.id)).toBe(false);
    });

    it('returns true after an attempt is inserted', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);
      ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id));

      expect(ctx.attemptRepo.isConsumed(decision.id)).toBe(true);
    });

    it('returns false for nonexistent decision id', () => {
      const ctx = createContext();
      expect(ctx.attemptRepo.isConsumed(999)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Negative tests — malformed/edge-case inputs
  // -----------------------------------------------------------------------

  describe('negative tests', () => {
    it('rejects attempt with nonexistent strategy_decision_id (FK violation)', () => {
      const ctx = createContext();
      expect(() => {
        ctx.attemptRepo.insertAttempt(sampleAttempt(99999));
      }).toThrow();
    });

    it('rejects duplicate strategy_decision_id (UNIQUE violation)', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);

      ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id));

      expect(() => {
        ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id));
      }).toThrow();
    });

    it('handles empty results from getByStatus for nonexistent status values', () => {
      const ctx = createContext();
      // Refused is a valid status but no rows exist yet
      expect(ctx.attemptRepo.getByStatus(ExecutionAttemptStatus.Refused)).toEqual([]);
    });

    it('handles multiple attempts for different decisions with same timestamps', () => {
      const ctx = createContext();
      const now = Date.now();
      const d1 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'TS1', createdAt: now }),
        { decidedAt: now },
      );
      const d2 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'TS2', createdAt: now }),
        { decidedAt: now },
      );

      ctx.attemptRepo.insertAttempt(sampleAttempt(d1.id, { attemptedAt: now }));
      ctx.attemptRepo.insertAttempt(sampleAttempt(d2.id, { attemptedAt: now }));

      expect(ctx.attemptRepo.count()).toBe(2);
      const recent = ctx.attemptRepo.getRecent();
      expect(recent.length).toBe(2);
    });

    it('persists attempt with empty message string', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);

      const attempt = ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id, {
        message: '',
      }));

      expect(attempt.message).toBe('');
    });

    it('persists attempt with null outcome_code and broker_order_id', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);

      const attempt = ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id, {
        outcomeCode: null,
        brokerOrderId: null,
      }));

      expect(attempt.outcomeCode).toBeNull();
      expect(attempt.brokerOrderId).toBeNull();
    });

    it('allows completed_at to be null for refused/incomplete attempts', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);

      const attempt = ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id, {
        status: ExecutionAttemptStatus.Pending,
        completedAt: null,
      }));

      expect(attempt.status).toBe(ExecutionAttemptStatus.Pending);
      expect(attempt.completedAt).toBeNull();
    });

    it('handles all five execution status values', () => {
      const ctx = createContext();
      const statuses = Object.values(ExecutionAttemptStatus);

      for (let i = 0; i < statuses.length; i++) {
        const status = statuses[i];
        const paId = insertAcceptedProposal(ctx.proposalRepo, {
          tradingsymbol: `STATUS_${i}`,
          createdAt: Date.now() + i,
        });
        const decision = insertApprovedDecision(ctx.strategyRepo, paId, {
          tradingsymbol: `STATUS_${i}`,
          decidedAt: Date.now() + i,
        });

        const isTerminal = status === ExecutionAttemptStatus.Completed ||
          status === ExecutionAttemptStatus.Failed ||
          status === ExecutionAttemptStatus.Refused;

        ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id, {
          status,
          outcomeCode: isTerminal ? ExecutionOutcomeCode.PaperSimulated : null,
          completedAt: isTerminal ? Date.now() + i + 1000 : null,
          attemptedAt: Date.now() + i,
        }));
      }

      expect(ctx.attemptRepo.count()).toBe(statuses.length);

      for (const status of statuses) {
        expect(ctx.attemptRepo.countByStatus(status)).toBe(1);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Consumption semantics — execution_attempts is the canonical seam
  // -----------------------------------------------------------------------

  describe('consumption semantics via getApprovedUnconsumedCandidates', () => {
    it('returns approved decisions when no execution attempts exist', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      insertApprovedDecision(ctx.strategyRepo, paId);

      const candidates = ctx.strategyRepo.getApprovedUnconsumedCandidates();
      expect(candidates.length).toBe(1);
    });

    it('excludes approved decisions that have an execution attempt', () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo);
      const decision = insertApprovedDecision(ctx.strategyRepo, paId);
      ctx.attemptRepo.insertAttempt(sampleAttempt(decision.id));

      const candidates = ctx.strategyRepo.getApprovedUnconsumedCandidates();
      expect(candidates.length).toBe(0);
    });

    it('returns only unconsumed decisions when mixed', () => {
      const ctx = createContext();

      // Consumed
      const d1 = insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'CONSUMED', createdAt: 100 }),
        { tradingsymbol: 'CONSUMED', decidedAt: 100 },
      );
      ctx.attemptRepo.insertAttempt(sampleAttempt(d1.id));

      // Unconsumed
      insertApprovedDecision(ctx.strategyRepo,
        insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'FRESH', createdAt: 200 }),
        { tradingsymbol: 'FRESH', decidedAt: 200 },
      );

      const candidates = ctx.strategyRepo.getApprovedUnconsumedCandidates();
      expect(candidates.length).toBe(1);
      expect(candidates[0].tradingsymbol).toBe('FRESH');
    });

    it('does not affect refused decisions (they were never approved)', () => {
      const ctx = createContext();

      // Refused decision — should never appear in getApprovedUnconsumedCandidates
      const refusedPaId = insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'REFUSED' });
      ctx.strategyRepo.insertDecision({
        proposalAttemptId: refusedPaId,
        decisionStatus: StrategyDecisionStatus.Refused,
        strategyId: 'india-nse-eq-v1',
        strategyVersion: '1.0.0',
        decidedAt: Date.now(),
        exchange: 'NSE',
        tradingsymbol: 'REFUSED',
        side: 'buy',
        product: 'MIS',
        quantity: 0,
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

      expect(ctx.strategyRepo.getApprovedUnconsumedCandidates().length).toBe(0);
    });
  });
});
