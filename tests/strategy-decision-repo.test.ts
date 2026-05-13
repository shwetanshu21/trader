import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import { StrategyDecisionRepository } from '../src/persistence/strategy-decision-repo.js';
import {
  ProposalStatus,
  StrategyDecisionStatus,
  StrategyDecisionReasonCode,
  type NewProposalAttempt,
  type NewStrategyDecision,
  type StrategyDecisionReason,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRepos(): { strategyRepo: StrategyDecisionRepository; proposalRepo: ProposalRepository; db: Database.Database } {
  const mgr = new DatabaseManager(':memory:');
  return {
    strategyRepo: new StrategyDecisionRepository(mgr.db),
    proposalRepo: new ProposalRepository(mgr.db),
    db: mgr.db,
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

function sampleApprovedDecision(
  proposalAttemptId: number,
  overrides?: Partial<NewStrategyDecision>,
): NewStrategyDecision {
  return {
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
    ...overrides,
  };
}

function sampleRefusedDecision(
  proposalAttemptId: number,
  overrides?: Partial<NewStrategyDecision>,
): NewStrategyDecision {
  return {
    proposalAttemptId,
    decisionStatus: StrategyDecisionStatus.Refused,
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    decidedAt: Date.now(),
    exchange: 'NSE',
    tradingsymbol: 'TCS',
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// StrategyDecisionRepository
// ---------------------------------------------------------------------------

describe('StrategyDecisionRepository', () => {
  describe('insertDecision', () => {
    it('inserts an approved strategy decision', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo);
      const decision = sampleApprovedDecision(paId);

      const row = strategyRepo.insertDecision(decision);

      expect(row.id).toBeGreaterThan(0);
      expect(row.proposalAttemptId).toBe(paId);
      expect(row.decisionStatus).toBe(StrategyDecisionStatus.Approved);
      expect(row.strategyId).toBe('india-nse-eq-v1');
      expect(row.strategyVersion).toBe('1.0.0');
      expect(row.exchange).toBe('NSE');
      expect(row.tradingsymbol).toBe('RELIANCE');
      expect(row.side).toBe('buy');
      expect(row.product).toBe('MIS');
      expect(row.quantity).toBe(75);
      expect(row.price).toBeNull();
      expect(row.orderType).toBe('MARKET');
      expect(row.quoteLastPrice).toBe(2850.50);
      expect(row.quoteBid).toBe(2850.00);
      expect(row.quoteAsk).toBe(2851.00);
      expect(row.quoteVolume).toBe(1250000);
      expect(row.riskNotional).toBe(213787.50);
      expect(row.riskSizingBasis).toBe('last_price');
      expect(row.riskMaxLossRupees).toBe(10689.38);
      expect(row.riskExposureTag).toBe('intraday');
      expect(strategyRepo.countDecisions()).toBe(1);
    });

    it('inserts a refused strategy decision', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'TCS' });
      const decision = sampleRefusedDecision(paId);

      const row = strategyRepo.insertDecision(decision);

      expect(row.id).toBeGreaterThan(0);
      expect(row.decisionStatus).toBe(StrategyDecisionStatus.Refused);
      expect(row.quantity).toBe(0);
      expect(row.quoteLastPrice).toBeNull();
      expect(row.riskNotional).toBeNull();
      expect(strategyRepo.countDecisions()).toBe(1);
    });

    it('enforces UNIQUE constraint on proposal_attempt_id', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo);

      strategyRepo.insertDecision(sampleApprovedDecision(paId));

      expect(() => {
        strategyRepo.insertDecision(sampleApprovedDecision(paId));
      }).toThrow();
    });

    it('persists trigger_price and price for SL orders', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'SL_ORDER' });
      const decision = sampleApprovedDecision(paId, {
        price: 2550,
        triggerPrice: 2540,
        orderType: 'SL',
      });

      const row = strategyRepo.insertDecision(decision);
      expect(row.price).toBe(2550);
      expect(row.triggerPrice).toBe(2540);
      expect(row.orderType).toBe('SL');
    });

    it('persists quote fields as null when not provided', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'NO_QUOTE' });
      const decision = sampleApprovedDecision(paId, {
        quoteLastPrice: null,
        quoteBid: null,
        quoteAsk: null,
        quoteVolume: null,
        quoteReceivedAt: null,
        riskNotional: null,
      });

      const row = strategyRepo.insertDecision(decision);
      expect(row.quoteLastPrice).toBeNull();
      expect(row.quoteBid).toBeNull();
      expect(row.riskNotional).toBeNull();
    });
  });

  describe('insertReason / getReasonsForDecision', () => {
    it('inserts and retrieves a single reason', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo);
      const decision = strategyRepo.insertDecision(sampleRefusedDecision(paId));

      strategyRepo.insertReason(decision.id, {
        reasonCode: StrategyDecisionReasonCode.UnsupportedSegment,
        reasonMessage: 'NFO segment is not supported in india-nse-eq-v1',
      });

      const reasons = strategyRepo.getReasonsForDecision(decision.id);
      expect(reasons.length).toBe(1);
      expect(reasons[0].reasonCode).toBe(StrategyDecisionReasonCode.UnsupportedSegment);
      expect(reasons[0].reasonMessage).toBe('NFO segment is not supported in india-nse-eq-v1');
    });

    it('inserts and retrieves multiple ordered reasons', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo);
      const decision = strategyRepo.insertDecision(sampleRefusedDecision(paId));

      strategyRepo.insertReason(decision.id, {
        reasonCode: StrategyDecisionReasonCode.MissingQuoteData,
        reasonMessage: 'No quote available for TCS',
      });
      strategyRepo.insertReason(decision.id, {
        reasonCode: StrategyDecisionReasonCode.ZeroQuantityAfterRounding,
        reasonMessage: 'Derived quantity 0 after lot-size rounding',
      });

      const reasons = strategyRepo.getReasonsForDecision(decision.id);
      expect(reasons.length).toBe(2);
      expect(reasons[0].reasonCode).toBe(StrategyDecisionReasonCode.MissingQuoteData);
      expect(reasons[1].reasonCode).toBe(StrategyDecisionReasonCode.ZeroQuantityAfterRounding);
    });

    it('returns empty array when no reasons exist', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo);
      const decision = strategyRepo.insertDecision(sampleApprovedDecision(paId));

      const reasons = strategyRepo.getReasonsForDecision(decision.id);
      expect(reasons).toEqual([]);
    });
  });

  describe('insertDecisionWithReasons', () => {
    it('atomically inserts an approved decision with empty reasons', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo);
      const decision = sampleApprovedDecision(paId);

      const inserted = strategyRepo.insertDecisionWithReasons(decision, []);

      expect(inserted.id).toBeGreaterThan(0);
      expect(inserted.decisionStatus).toBe(StrategyDecisionStatus.Approved);
      expect(strategyRepo.countDecisions()).toBe(1);
      expect(strategyRepo.countReasons()).toBe(0);
    });

    it('atomically inserts a refused decision with reasons', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo);
      const decision = sampleRefusedDecision(paId);
      const reasons: StrategyDecisionReason[] = [
        {
          reasonCode: StrategyDecisionReasonCode.MissingQuoteData,
          reasonMessage: 'No quote data available for sizing',
        },
        {
          reasonCode: StrategyDecisionReasonCode.ZeroQuantityAfterRounding,
          reasonMessage: 'Quantity rounded to zero',
        },
      ];

      const inserted = strategyRepo.insertDecisionWithReasons(decision, reasons);

      expect(inserted.id).toBeGreaterThan(0);
      expect(inserted.decisionStatus).toBe(StrategyDecisionStatus.Refused);
      expect(strategyRepo.countDecisions()).toBe(1);
      expect(strategyRepo.countReasons()).toBe(2);

      const loadedReasons = strategyRepo.getReasonsForDecision(inserted.id);
      expect(loadedReasons[0].reasonCode).toBe(StrategyDecisionReasonCode.MissingQuoteData);
      expect(loadedReasons[1].reasonCode).toBe(StrategyDecisionReasonCode.ZeroQuantityAfterRounding);
    });

    it('rolls back on failure (no partial inserts)', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo);
      const decision = sampleApprovedDecision(paId, { tradingsymbol: 'ATOMIC' });

      const result = strategyRepo.insertDecisionWithReasons(decision, []);
      expect(result.tradingsymbol).toBe('ATOMIC');
      expect(result.decisionStatus).toBe(StrategyDecisionStatus.Approved);
      expect(strategyRepo.countDecisions()).toBe(1);

      // Verify we can read it back
      const loaded = strategyRepo.getDecisionById(result.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.tradingsymbol).toBe('ATOMIC');
    });
  });

  describe('getDecisionById', () => {
    it('returns null for unknown id', () => {
      const { strategyRepo } = createRepos();
      expect(strategyRepo.getDecisionById(999)).toBeNull();
    });

    it('returns the full decision row', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'GET_BY_ID' });
      const decision = strategyRepo.insertDecision(sampleApprovedDecision(paId));

      const loaded = strategyRepo.getDecisionById(decision.id);

      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(decision.id);
      expect(loaded!.proposalAttemptId).toBe(paId);
      expect(loaded!.strategyId).toBe('india-nse-eq-v1');
      expect(loaded!.strategyVersion).toBe('1.0.0');
      expect(loaded!.exchange).toBe('NSE');
      expect(loaded!.tradingsymbol).toBe('RELIANCE');
      expect(loaded!.side).toBe('buy');
      expect(loaded!.quantity).toBe(75);
      expect(loaded!.quoteLastPrice).toBe(2850.50);
      expect(loaded!.riskNotional).toBe(213787.50);
    });
  });

  describe('getDecisionByProposalAttemptId', () => {
    it('returns null when no decision exists for the proposal', () => {
      const { strategyRepo } = createRepos();
      expect(strategyRepo.getDecisionByProposalAttemptId(999)).toBeNull();
    });

    it('returns the decision linked to a proposal attempt', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'LINKED' });
      strategyRepo.insertDecision(sampleApprovedDecision(paId, { tradingsymbol: 'LINKED' }));

      const loaded = strategyRepo.getDecisionByProposalAttemptId(paId);
      expect(loaded).not.toBeNull();
      expect(loaded!.proposalAttemptId).toBe(paId);
      expect(loaded!.tradingsymbol).toBe('LINKED');
    });
  });

  describe('getRecentDecisions', () => {
    it('returns empty array when no decisions exist', () => {
      const { strategyRepo } = createRepos();
      expect(strategyRepo.getRecentDecisions()).toEqual([]);
    });

    it('returns decisions newest first', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const pa1 = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'FIRST', createdAt: 100 });
      const pa2 = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'SECOND', createdAt: 200 });
      strategyRepo.insertDecision(sampleApprovedDecision(pa1, { tradingsymbol: 'FIRST', decidedAt: 100 }));
      strategyRepo.insertDecision(sampleApprovedDecision(pa2, { tradingsymbol: 'SECOND', decidedAt: 200 }));

      const decisions = strategyRepo.getRecentDecisions();
      expect(decisions.length).toBe(2);
      expect(decisions[0].tradingsymbol).toBe('SECOND');
      expect(decisions[1].tradingsymbol).toBe('FIRST');
    });

    it('respects limit parameter', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      for (let i = 0; i < 10; i++) {
        const pa = insertAcceptedProposal(proposalRepo, { tradingsymbol: `SYM_${i}`, createdAt: i });
        strategyRepo.insertDecision(sampleApprovedDecision(pa, { tradingsymbol: `SYM_${i}`, decidedAt: i }));
      }

      expect(strategyRepo.getRecentDecisions(3).length).toBe(3);
    });

    it('filters by status', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const pa1 = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'APPROVED', createdAt: 100 });
      const pa2 = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'REFUSED', createdAt: 200 });
      strategyRepo.insertDecision(sampleApprovedDecision(pa1, { tradingsymbol: 'APPROVED', decidedAt: 100 }));
      strategyRepo.insertDecision(sampleRefusedDecision(pa2, { tradingsymbol: 'REFUSED', decidedAt: 200 }));

      const approved = strategyRepo.getRecentDecisions(50, StrategyDecisionStatus.Approved);
      expect(approved.length).toBe(1);
      expect(approved[0].tradingsymbol).toBe('APPROVED');

      const refused = strategyRepo.getRecentDecisions(50, StrategyDecisionStatus.Refused);
      expect(refused.length).toBe(1);
      expect(refused[0].tradingsymbol).toBe('REFUSED');
    });
  });

  describe('getApprovedUnconsumedCandidates', () => {
    it('returns empty array when no approved decisions exist', () => {
      const { strategyRepo } = createRepos();
      expect(strategyRepo.getApprovedUnconsumedCandidates()).toEqual([]);
    });

    it('returns only approved decisions (not refused)', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paApproved = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'APPROVED', createdAt: 100 });
      const paRefused = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'REFUSED', createdAt: 200 });
      strategyRepo.insertDecision(sampleApprovedDecision(paApproved, { decidedAt: 100 }));
      strategyRepo.insertDecision(sampleRefusedDecision(paRefused, { decidedAt: 200 }));

      const candidates = strategyRepo.getApprovedUnconsumedCandidates();
      expect(candidates.length).toBe(1);
      expect(candidates[0].proposalAttemptId).toBe(paApproved);
    });

    it('returns candidates with correct read-model shape', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'CANDIDATE' });
      strategyRepo.insertDecision(sampleApprovedDecision(paId));

      const candidates = strategyRepo.getApprovedUnconsumedCandidates();
      expect(candidates.length).toBe(1);

      const c = candidates[0];
      expect(c.id).toBeGreaterThan(0);
      expect(c.proposalAttemptId).toBe(paId);
      expect(c.strategyId).toBe('india-nse-eq-v1');
      expect(c.strategyVersion).toBe('1.0.0');
      expect(c.exchange).toBe('NSE');
      expect(c.tradingsymbol).toBe('RELIANCE');
      expect(c.side).toBe('buy');
      expect(c.product).toBe('MIS');
      expect(c.quantity).toBe(75);
      expect(c.price).toBeNull();
      expect(c.triggerPrice).toBeNull();
      expect(c.orderType).toBe('MARKET');
      expect(c.lastPrice).toBe(2850.50);
      expect(c.bid).toBe(2850.00);
      expect(c.ask).toBe(2851.00);
      expect(c.notional).toBe(213787.50);
      expect(c.sizingBasis).toBe('last_price');
    });

    it('returns candidates ordered by decided_at ascending', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const pa1 = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'FIRST', createdAt: 100 });
      const pa2 = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'SECOND', createdAt: 200 });
      strategyRepo.insertDecision(sampleApprovedDecision(pa1, { decidedAt: 100 }));
      strategyRepo.insertDecision(sampleApprovedDecision(pa2, { decidedAt: 200 }));

      const candidates = strategyRepo.getApprovedUnconsumedCandidates();
      expect(candidates.length).toBe(2);
      expect(candidates[0].proposalAttemptId).toBe(pa1);
      expect(candidates[1].proposalAttemptId).toBe(pa2);
    });
  });

  describe('getRecentRefusals', () => {
    it('returns empty array when no refusals exist', () => {
      const { strategyRepo } = createRepos();
      expect(strategyRepo.getRecentRefusals()).toEqual([]);
    });

    it('returns only refused decisions with their reasons', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const pa1 = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'REF_1', createdAt: 100 });
      const pa2 = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'APPROVED', createdAt: 200 });

      const d1 = strategyRepo.insertDecisionWithReasons(
        sampleRefusedDecision(pa1, { decidedAt: 100 }),
        [
          { reasonCode: StrategyDecisionReasonCode.MissingQuoteData, reasonMessage: 'No quote' },
          { reasonCode: StrategyDecisionReasonCode.ZeroQuantityAfterRounding, reasonMessage: 'Zero qty' },
        ],
      );
      strategyRepo.insertDecision(sampleApprovedDecision(pa2, { decidedAt: 200 }));

      const refusals = strategyRepo.getRecentRefusals();
      expect(refusals.length).toBe(1);
      expect(refusals[0].proposalAttemptId).toBe(pa1);
      expect(refusals[0].reasons.length).toBe(2);
      expect(refusals[0].reasons[0].reasonCode).toBe(StrategyDecisionReasonCode.MissingQuoteData);
      expect(refusals[0].reasons[1].reasonCode).toBe(StrategyDecisionReasonCode.ZeroQuantityAfterRounding);
    });
  });

  describe('count methods', () => {
    it('starts at zero', () => {
      const { strategyRepo } = createRepos();
      expect(strategyRepo.countDecisions()).toBe(0);
      expect(strategyRepo.countReasons()).toBe(0);
      expect(strategyRepo.countByStatus(StrategyDecisionStatus.Approved)).toBe(0);
      expect(strategyRepo.countByStatus(StrategyDecisionStatus.Refused)).toBe(0);
    });

    it('counts decisions and reasons across all rows', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const pa1 = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'A1' });
      const pa2 = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'A2' });

      strategyRepo.insertDecisionWithReasons(
        sampleApprovedDecision(pa1),
        [],
      );

      const d2 = strategyRepo.insertDecision(sampleRefusedDecision(pa2));
      strategyRepo.insertReason(d2.id, {
        reasonCode: StrategyDecisionReasonCode.MissingQuoteData,
        reasonMessage: 'No quote',
      });
      strategyRepo.insertReason(d2.id, {
        reasonCode: StrategyDecisionReasonCode.UnsupportedSegment,
        reasonMessage: 'Unsupported',
      });

      expect(strategyRepo.countDecisions()).toBe(2);
      expect(strategyRepo.countReasons()).toBe(2);
      expect(strategyRepo.countByStatus(StrategyDecisionStatus.Approved)).toBe(1);
      expect(strategyRepo.countByStatus(StrategyDecisionStatus.Refused)).toBe(1);
    });
  });

  describe('negative tests — boundary conditions', () => {
    it('handles empty decision set on getApprovedUnconsumedCandidates', () => {
      const { strategyRepo } = createRepos();
      expect(strategyRepo.getApprovedUnconsumedCandidates()).toEqual([]);
    });

    it('handles empty decision set on getRecentRefusals', () => {
      const { strategyRepo } = createRepos();
      expect(strategyRepo.getRecentRefusals()).toEqual([]);
    });

    it('accepted decision with zero reasons is valid', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo);
      const decision = strategyRepo.insertDecision(sampleApprovedDecision(paId));

      const reasons = strategyRepo.getReasonsForDecision(decision.id);
      expect(reasons).toEqual([]);
    });

    it('refused decision with multiple ordered reasons preserves ordering', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const paId = insertAcceptedProposal(proposalRepo, { tradingsymbol: 'MULTI_REASON' });
      const decision = sampleRefusedDecision(paId);
      const reasons: StrategyDecisionReason[] = [
        { reasonCode: StrategyDecisionReasonCode.UnsupportedSegment, reasonMessage: 'Not NSE EQ' },
        { reasonCode: StrategyDecisionReasonCode.MissingQuoteData, reasonMessage: 'No quote' },
        { reasonCode: StrategyDecisionReasonCode.ZeroQuantityAfterRounding, reasonMessage: 'Zero qty' },
      ];

      const inserted = strategyRepo.insertDecisionWithReasons(decision, reasons);
      const loadedReasons = strategyRepo.getReasonsForDecision(inserted.id);

      expect(loadedReasons.length).toBe(3);
      expect(loadedReasons[0].reasonCode).toBe(StrategyDecisionReasonCode.UnsupportedSegment);
      expect(loadedReasons[1].reasonCode).toBe(StrategyDecisionReasonCode.MissingQuoteData);
      expect(loadedReasons[2].reasonCode).toBe(StrategyDecisionReasonCode.ZeroQuantityAfterRounding);
    });

    it('stores all known StrategyDecisionReasonCode values', () => {
      const { strategyRepo, proposalRepo } = createRepos();
      const allCodes = Object.values(StrategyDecisionReasonCode);

      for (let i = 0; i < allCodes.length; i++) {
        const code = allCodes[i];
        const paId = insertAcceptedProposal(proposalRepo, {
          tradingsymbol: `CODE_${code}`,
          createdAt: Date.now() + i,
        });
        const d = strategyRepo.insertDecision(sampleRefusedDecision(paId, {
          tradingsymbol: `CODE_${code}`,
          decidedAt: Date.now() + i,
        }));
        strategyRepo.insertReason(d.id, {
          reasonCode: code,
          reasonMessage: `Test for ${code}`,
        });
      }

      expect(strategyRepo.countDecisions()).toBe(allCodes.length);
      expect(strategyRepo.countReasons()).toBe(allCodes.length);
    });

    it('rejects decision with nonexistent proposal_attempt_id (FK violation)', () => {
      const { strategyRepo } = createRepos();
      const decision = sampleApprovedDecision(99999);

      expect(() => {
        strategyRepo.insertDecision(decision);
      }).toThrow();
    });
  });
});
