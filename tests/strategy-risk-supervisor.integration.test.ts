// ── StrategyRiskSupervisor — integration tests ──
// Tests the TickWork implementation that evaluates accepted proposals
// via the strategy-risk service port and persists decisions.

import { describe, it, expect, vi } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import { StrategyDecisionRepository } from '../src/persistence/strategy-decision-repo.js';
import { BrokerRepository } from '../src/persistence/broker-repo.js';
import {
  StrategyRiskSupervisor,
  type StrategyRiskPort,
  type StrategyEvaluationInput,
  type StrategyEvaluationResult,
} from '../src/strategy-risk/strategy-risk-supervisor.js';
import {
  ProposalStatus,
  StrategyDecisionStatus,
  StrategyDecisionReasonCode,
  type NewStrategyDecision,
  type StrategyDecisionReason,
} from '../src/types/runtime.js';
import type { HealthStatus } from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestContext {
  proposalRepo: ProposalRepository;
  strategyRepo: StrategyDecisionRepository;
  brokerRepo: BrokerRepository;
  supervisor: StrategyRiskSupervisor;
  mockRiskPort: StrategyRiskPort;
  dbManager: DatabaseManager;
  db: import('better-sqlite3').Database;
}

function createContext(): TestContext {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;

  const proposalRepo = new ProposalRepository(db);
  const strategyRepo = new StrategyDecisionRepository(db);
  const brokerRepo = new BrokerRepository(db);

  // Mock risk service that approves by default
  const mockRiskPort: StrategyRiskPort & { decisions: StrategyEvaluationResult[] } = {
    decisions: [],
    async evaluateProposal(input: StrategyEvaluationInput): Promise<StrategyEvaluationResult> {
      const decision: NewStrategyDecision = {
        proposalAttemptId: input.proposalAttemptId,
        decisionStatus: StrategyDecisionStatus.Approved,
        strategyId: 'test-strategy',
        strategyVersion: '1.0.0',
        decidedAt: Date.now(),
        exchange: input.exchange,
        tradingsymbol: input.tradingsymbol,
        side: input.side,
        product: input.product,
        quantity: input.quantity,
        price: input.price,
        triggerPrice: input.triggerPrice,
        orderType: input.orderType,
        quoteLastPrice: input.quote?.lastPrice ?? null,
        quoteBid: input.quote?.bid ?? null,
        quoteAsk: input.quote?.ask ?? null,
        quoteVolume: input.quote?.volume ?? null,
        quoteReceivedAt: input.quote?.receivedAt ?? null,
        riskNotional: input.quote?.lastPrice != null ? input.quantity * input.quote.lastPrice : null,
        riskSizingBasis: 'last_price',
        riskMaxLossRupees: null,
        riskStopDistance: null,
        riskExposureTag: 'intraday',
      };

      const result: StrategyEvaluationResult = { decision, reasons: [] };
      this.decisions.push(result);
      return result;
    },
  };

  const supervisor = new StrategyRiskSupervisor({
    strategyRepo,
    brokerRepo,
    riskService: mockRiskPort,
  });

  return {
    proposalRepo,
    strategyRepo,
    brokerRepo,
    supervisor,
    mockRiskPort,
    dbManager: mgr,
    db,
  };
}

function insertAcceptedProposal(
  proposalRepo: ProposalRepository,
  overrides?: Partial<{
    exchange: string;
    tradingsymbol: string;
    side: string;
    product: string;
    quantity: number;
    orderType: string;
    createdAt: number;
  }>,
): number {
  const row = proposalRepo.insertAttempt({
    exchange: overrides?.exchange ?? 'NSE',
    tradingsymbol: overrides?.tradingsymbol ?? 'RELIANCE',
    instrumentToken: 123456,
    side: overrides?.side ?? 'buy',
    product: overrides?.product ?? 'MIS',
    quantity: overrides?.quantity ?? 1,
    price: null,
    triggerPrice: null,
    orderType: overrides?.orderType ?? 'MARKET',
    tag: null,
    proposalStatus: ProposalStatus.Accepted,
    createdAt: overrides?.createdAt ?? Date.now(),
  });
  return row.id;
}

function insertRefusedProposal(proposalRepo: ProposalRepository): number {
  return proposalRepo.insertAttempt({
    exchange: 'NSE',
    tradingsymbol: 'TCS',
    instrumentToken: 654321,
    side: 'buy',
    product: 'CNC',
    quantity: 10,
    price: 3500,
    triggerPrice: null,
    orderType: 'LIMIT',
    tag: null,
    proposalStatus: ProposalStatus.Refused,
    createdAt: Date.now(),
  }).id;
}

function sampleHealth(): HealthStatus {
  return {
    verdict: 'healthy' as const,
    uptimeMs: 1000,
    lifecycleState: 'running' as const,
    scheduler: {
      status: 'running' as const,
      marketPhase: 'regular' as const,
      lastTickTimestamp: Date.now(),
      startedAt: Date.now(),
      tickCount: 10,
      lastError: null,
    },
    degradedReasons: [],
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// StrategyRiskSupervisor integration tests
// ---------------------------------------------------------------------------

describe('StrategyRiskSupervisor', () => {
  describe('doWork', () => {
    it('processes accepted proposals without strategy decisions', async () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'EVAL_ME' });

      expect(ctx.strategyRepo.countDecisions()).toBe(0);

      await ctx.supervisor.doWork(new Date(), sampleHealth());

      expect(ctx.strategyRepo.countDecisions()).toBe(1);
      const decision = ctx.strategyRepo.getDecisionByProposalAttemptId(paId);
      expect(decision).not.toBeNull();
      expect(decision!.decisionStatus).toBe(StrategyDecisionStatus.Approved);
    });

    it('skips proposals that already have a strategy decision', async () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'ALREADY_DECIDED' });

      // Insert a decision first
      ctx.strategyRepo.insertDecision({
        proposalAttemptId: paId,
        decisionStatus: StrategyDecisionStatus.Approved,
        strategyId: 'pre-existing',
        strategyVersion: '1.0.0',
        decidedAt: Date.now(),
        exchange: 'NSE',
        tradingsymbol: 'ALREADY_DECIDED',
        side: 'buy',
        product: 'MIS',
        quantity: 75,
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

      expect(ctx.strategyRepo.countDecisions()).toBe(1);

      await ctx.supervisor.doWork(new Date(), sampleHealth());

      // No new decision should be created
      expect(ctx.strategyRepo.countDecisions()).toBe(1);
    });

    it('skips refused proposals (not accepted)', async () => {
      const ctx = createContext();
      insertRefusedProposal(ctx.proposalRepo);

      await ctx.supervisor.doWork(new Date(), sampleHealth());

      expect(ctx.strategyRepo.countDecisions()).toBe(0);
    });

    it('processes multiple accepted proposals in a single tick', async () => {
      const ctx = createContext();
      insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'FIRST', createdAt: 100 });
      insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'SECOND', createdAt: 200 });
      insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'THIRD', createdAt: 300 });

      await ctx.supervisor.doWork(new Date(), sampleHealth());

      expect(ctx.strategyRepo.countDecisions()).toBe(3);
    });

    it('passes quote and instrument data to the risk service', async () => {
      const ctx = createContext();
      // Insert a quote and instrument so the broker repo has them
      ctx.brokerRepo.upsertQuote({
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        instrumentToken: 123456,
        lastPrice: 2850.50,
        change: 12.50,
        changePercent: 0.44,
        volume: 1250000,
        oi: null,
        high: 2860.00,
        low: 2840.00,
        open: 2845.00,
        close: 2838.00,
        bid: 2850.00,
        ask: 2851.00,
        priceTimestamp: Date.now(),
        receivedAt: Date.now(),
      });

      insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'RELIANCE' });

      // Spy on the mock
      const spy = vi.spyOn(ctx.mockRiskPort, 'evaluateProposal');

      await ctx.supervisor.doWork(new Date(), sampleHealth());

      expect(spy).toHaveBeenCalledTimes(1);
      const input = spy.mock.calls[0][0];
      expect(input.quote).not.toBeNull();
      expect(input.quote!.lastPrice).toBe(2850.50);
      expect(input.quote!.bid).toBe(2850.00);
      expect(input.quote!.ask).toBe(2851.00);
    });

    it('passes null quote when instrument has no quote data', async () => {
      const ctx = createContext();
      insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'NO_QUOTE' });

      const spy = vi.spyOn(ctx.mockRiskPort, 'evaluateProposal');

      await ctx.supervisor.doWork(new Date(), sampleHealth());

      expect(spy).toHaveBeenCalledTimes(1);
      const input = spy.mock.calls[0][0];
      expect(input.quote).toBeNull();
    });

    it('passes null instrument when symbol not in master', async () => {
      const ctx = createContext();
      insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'UNKNOWN_SYMBOL' });

      const spy = vi.spyOn(ctx.mockRiskPort, 'evaluateProposal');

      await ctx.supervisor.doWork(new Date(), sampleHealth());

      expect(spy).toHaveBeenCalledTimes(1);
      const input = spy.mock.calls[0][0];
      expect(input.instrument).toBeNull();
    });

    it('processes proposals in created_at order (oldest first)', async () => {
      const ctx = createContext();
      // Mock to track proposal order
      const processedOrder: number[] = [];
      const originalMock = ctx.mockRiskPort.evaluateProposal;
      ctx.mockRiskPort.evaluateProposal = async (input: StrategyEvaluationInput) => {
        processedOrder.push(input.proposalAttemptId);
        return originalMock.call(ctx.mockRiskPort, input);
      };

      const p1 = insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'OLD', createdAt: 100 });
      const p2 = insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'MID', createdAt: 200 });
      const p3 = insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'NEW', createdAt: 300 });

      await ctx.supervisor.doWork(new Date(), sampleHealth());

      expect(processedOrder).toEqual([p1, p2, p3]);
    });

    it('persists refused decisions when risk service refuses', async () => {
      const ctx = createContext();
      const paId = insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'REFUSE_ME' });

      // Override mock to return refused
      const refuseReasons: StrategyDecisionReason[] = [
        { reasonCode: StrategyDecisionReasonCode.MissingQuoteData, reasonMessage: 'No quote available' },
        { reasonCode: StrategyDecisionReasonCode.ZeroQuantityAfterRounding, reasonMessage: 'Quantity rounds to zero' },
      ];

      ctx.mockRiskPort.evaluateProposal = async (input: StrategyEvaluationInput) => ({
        decision: {
          proposalAttemptId: input.proposalAttemptId,
          decisionStatus: StrategyDecisionStatus.Refused,
          strategyId: 'test-strategy',
          strategyVersion: '1.0.0',
          decidedAt: Date.now(),
          exchange: input.exchange,
          tradingsymbol: input.tradingsymbol,
          side: input.side,
          product: input.product,
          quantity: 0,
          price: input.price,
          triggerPrice: input.triggerPrice,
          orderType: input.orderType,
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
        },
        reasons: refuseReasons,
      });

      await ctx.supervisor.doWork(new Date(), sampleHealth());

      expect(ctx.strategyRepo.countDecisions()).toBe(1);
      const decision = ctx.strategyRepo.getDecisionByProposalAttemptId(paId);
      expect(decision).not.toBeNull();
      expect(decision!.decisionStatus).toBe(StrategyDecisionStatus.Refused);

      const reasons = ctx.strategyRepo.getReasonsForDecision(decision!.id);
      expect(reasons.length).toBe(2);
      expect(reasons[0].reasonCode).toBe(StrategyDecisionReasonCode.MissingQuoteData);
      expect(reasons[1].reasonCode).toBe(StrategyDecisionReasonCode.ZeroQuantityAfterRounding);
    });

    it('does nothing when no accepted proposals exist', async () => {
      const ctx = createContext();

      const spy = vi.spyOn(ctx.mockRiskPort, 'evaluateProposal');

      await ctx.supervisor.doWork(new Date(), sampleHealth());

      expect(ctx.strategyRepo.countDecisions()).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    });

    it('does nothing when only non-accepted proposals exist', async () => {
      const ctx = createContext();
      ctx.proposalRepo.insertAttempt({
        exchange: 'NSE',
        tradingsymbol: 'REFUSED',
        instrumentToken: null,
        side: 'buy',
        product: 'MIS',
        quantity: 0,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        tag: null,
        proposalStatus: ProposalStatus.Refused,
        createdAt: Date.now(),
      });
      ctx.proposalRepo.insertAttempt({
        exchange: 'NSE',
        tradingsymbol: 'SKIPPED',
        instrumentToken: null,
        side: 'buy',
        product: 'MIS',
        quantity: 0,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        tag: null,
        proposalStatus: ProposalStatus.Skipped,
        createdAt: Date.now(),
      });

      await ctx.supervisor.doWork(new Date(), sampleHealth());

      expect(ctx.strategyRepo.countDecisions()).toBe(0);
    });

    it('returns getLastTickCount = 0 when no work done', async () => {
      const ctx = createContext();
      expect(ctx.supervisor.getLastTickCount()).toBe(0);

      await ctx.supervisor.doWork(new Date(), sampleHealth());

      expect(ctx.supervisor.getLastTickCount()).toBe(0);
    });

    it('returns positive getLastTickCount after processing proposals', async () => {
      const ctx = createContext();
      insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'TICK_A', createdAt: 100 });
      insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'TICK_B', createdAt: 200 });

      await ctx.supervisor.doWork(new Date(), sampleHealth());

      expect(ctx.supervisor.getLastTickCount()).toBe(2);
    });

    it('throws on risk service failure so scheduler can degrade', async () => {
      const ctx = createContext();
      insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'FAIL' });

      ctx.mockRiskPort.evaluateProposal = async () => {
        throw new Error('Risk service unavailable');
      };

      await expect(ctx.supervisor.doWork(new Date(), sampleHealth())).rejects.toThrow(
        'Risk service unavailable',
      );
    });

    it('handles mixed success/failure: first proposal fails, second succeeds', async () => {
      const ctx = createContext();
      const p1 = insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'FAIL_FIRST', createdAt: 100 });
      const p2 = insertAcceptedProposal(ctx.proposalRepo, { tradingsymbol: 'SUCCEED_SECOND', createdAt: 200 });

      let callCount = 0;
      ctx.mockRiskPort.evaluateProposal = async (input: StrategyEvaluationInput) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('First evaluation failed');
        }
        return {
          decision: {
            proposalAttemptId: input.proposalAttemptId,
            decisionStatus: StrategyDecisionStatus.Approved,
            strategyId: 'test-strategy',
            strategyVersion: '1.0.0',
            decidedAt: Date.now(),
            exchange: input.exchange,
            tradingsymbol: input.tradingsymbol,
            side: input.side,
            product: input.product,
            quantity: input.quantity,
            price: input.price,
            triggerPrice: input.triggerPrice,
            orderType: input.orderType,
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
          },
          reasons: [],
        };
      };

      // Should throw because first proposal fails
      await expect(ctx.supervisor.doWork(new Date(), sampleHealth())).rejects.toThrow(
        'First evaluation failed',
      );

      // No decisions should be persisted (failure halts the tick)
      expect(ctx.strategyRepo.countDecisions()).toBe(0);
    });
  });
});
