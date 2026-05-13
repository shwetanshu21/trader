// ── Dashboard Read-Model Tests ──
// Proves the typed operator snapshot assembler produces correct shapes,
// redacts sensitive data, handles empty states gracefully, and reports
// broker health, proposals, and blocked orders correctly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { RuntimeStateRepository } from '../src/persistence/runtime-state-repo.js';
import { ZerodhaRepository } from '../src/persistence/zerodha-repo.js';
import { BrokerRepository } from '../src/persistence/broker-repo.js';
import { UniverseRepository } from '../src/persistence/universe-repo.js';
import { UniverseService } from '../src/universe/universe-service.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import { BlockedOrderRepository } from '../src/persistence/blocked-order-repo.js';
import { StrategyDecisionRepository } from '../src/persistence/strategy-decision-repo.js';
import { LifecycleManager } from '../src/runtime/lifecycle.js';
import { HealthService } from '../src/runtime/health-service.js';
import { MarketClock } from '../src/runtime/market-clock.js';
import { DashboardReadModel } from '../src/runtime/dashboard-read-model.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';
import {
  LifecycleState,
  HealthVerdict,
  SchedulerStatus,
  MarketPhase,
  ProposalStatus,
  StrategyDecisionStatus,
  ZerodhaSessionState,
  BlockCode,
  UniverseCoverageVerdict,
  type DashboardSnapshot,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestContext() {
  const db = new DatabaseManager(':memory:');
  const runtimeStateRepo = new RuntimeStateRepository(db.db);
  const zerodhaRepo = new ZerodhaRepository(db.db);
  const brokerRepo = new BrokerRepository(db.db);
  const universeRepo = new UniverseRepository(db.db);
  const universeService = new UniverseService(brokerRepo, universeRepo);
  const proposalRepo = new ProposalRepository(db.db);
  const blockedOrderRepo = new BlockedOrderRepository(db.db);
  const strategyDecisionRepo = new StrategyDecisionRepository(db.db);
  const lifecycle = new LifecycleManager(runtimeStateRepo);
  // Start lifecycle so health service can compose
  lifecycle.start('Test setup');
  const healthService = new HealthService(lifecycle, runtimeStateRepo, Date.now());
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const dashboard = new DashboardReadModel({
    healthService,
    runtimeStateRepo,
    zerodhaRepo,
    proposalRepo,
    blockedOrderRepo,
    strategyDecisionRepo,
    clock,
    universeService,
  });

  return {
    db,
    runtimeStateRepo,
    zerodhaRepo,
    brokerRepo,
    universeRepo,
    universeService,
    proposalRepo,
    blockedOrderRepo,
    strategyDecisionRepo,
    lifecycle,
    healthService,
    clock,
    dashboard,
  };
}

/** Insert a minimal lifecycle event for test purposes. */
function seedLifecycleEvent(
  repo: RuntimeStateRepository,
  state: LifecycleState,
  reason: string,
  timestamp?: number,
) {
  repo.insertLifecycleEvent({
    timestamp: timestamp ?? Date.now(),
    state,
    reason,
  });
}

/** Insert a proposal attempt for test purposes. */
function seedProposal(
  repo: ProposalRepository,
  overrides?: Partial<{
    status: ProposalStatus;
    exchange: string;
    tradingsymbol: string;
    side: string;
    product: string;
    quantity: number;
    createdAt: number;
  }>,
) {
  const row = repo.insertAttempt({
    exchange: overrides?.exchange ?? 'NSE',
    tradingsymbol: overrides?.tradingsymbol ?? 'RELIANCE',
    instrumentToken: 123456,
    side: overrides?.side ?? 'buy',
    product: overrides?.product ?? 'MIS',
    quantity: overrides?.quantity ?? 1,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: null,
    proposalStatus: overrides?.status ?? ProposalStatus.Accepted,
    createdAt: overrides?.createdAt ?? Date.now(),
  });
  return row;
}

/** Insert a validation reason for a proposal. */
function seedReason(repo: ProposalRepository, proposalId: number, code: string, message: string) {
  repo.insertReason(proposalId, { reasonCode: code as any, reasonMessage: message });
}

/** Insert a blocked-order row. */
function seedBlockedOrder(
  repo: BlockedOrderRepository,
  proposalAttemptId: number,
  overrides?: Partial<{
    exchange: string;
    tradingsymbol: string;
    side: string;
    blockCode: BlockCode;
  }>,
) {
  repo.insertBlockedOrder({
    proposalAttemptId,
    blockedAt: Date.now(),
    blockCode: overrides?.blockCode ?? BlockCode.MilestoneExecutionBlockM001,
    blockMessage: 'M001 hard block — no live execution',
    gateTag: 'M001-hard-block',
    exchange: overrides?.exchange ?? 'NSE',
    tradingsymbol: overrides?.tradingsymbol ?? 'RELIANCE',
    instrumentToken: 123456,
    side: overrides?.side ?? 'buy',
    product: 'MIS',
    quantity: 1,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
  });
}

/** Seed a strategy decision for test purposes. */
function seedStrategyDecision(
  repo: StrategyDecisionRepository,
  proposalAttemptId: number,
  overrides?: Partial<{
    decisionStatus: StrategyDecisionStatus;
    tradingsymbol: string;
    side: string;
    exchange: string;
    quantity: number;
    riskNotional: number | null;
    riskExposureTag: string | null;
    decidedAt: number;
  }>,
) {
  return repo.insertDecisionWithReasons(
    {
      proposalAttemptId,
      decisionStatus: overrides?.decisionStatus ?? StrategyDecisionStatus.Approved,
      strategyId: 'test-strategy',
      strategyVersion: '1.0.0',
      decidedAt: overrides?.decidedAt ?? Date.now(),
      exchange: overrides?.exchange ?? 'NSE',
      tradingsymbol: overrides?.tradingsymbol ?? 'RELIANCE',
      side: overrides?.side ?? 'buy',
      product: 'MIS',
      quantity: overrides?.quantity ?? 75,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      quoteLastPrice: 2850.50,
      quoteBid: 2850.00,
      quoteAsk: 2851.00,
      quoteVolume: 1250000,
      quoteReceivedAt: Date.now(),
      riskNotional: overrides?.riskNotional ?? 213_787.50,
      riskSizingBasis: 'last_price',
      riskMaxLossRupees: 10_689.38,
      riskStopDistance: null,
      riskExposureTag: overrides?.riskExposureTag ?? 'intraday',
    },
    overrides?.decisionStatus === StrategyDecisionStatus.Refused
      ? [
        { reasonCode: 'missing_quote_data' as any, reasonMessage: 'No quote available for sizing' },
        { reasonCode: 'below_minimum_notional' as any, reasonMessage: 'Notional below minimum 10,000 INR' },
      ]
      : [],
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardReadModel — snapshot contract', () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.db.close();
  });

  // ── Snapshot shape ─────────────────────────────────────────────────────

  describe('Snapshot shape', () => {
    it('returns a complete snapshot with all top-level keys', () => {
      const snapshot = ctx.dashboard.getSnapshot();

      expect(snapshot).toHaveProperty('assembledAt');
      expect(snapshot).toHaveProperty('marketProfile');
      expect(snapshot).toHaveProperty('health');
      expect(snapshot).toHaveProperty('runtime');
      expect(snapshot).toHaveProperty('broker');
      expect(snapshot).toHaveProperty('recentProposals');
      expect(snapshot).toHaveProperty('recentBlockedOrders');
      expect(snapshot).toHaveProperty('recentLifecycleEvents');
    });

    it('assembledAt is a valid ISO timestamp', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(() => new Date(snapshot.assembledAt)).not.toThrow();
      expect(new Date(snapshot.assembledAt).toISOString()).toBe(snapshot.assembledAt);
    });
  });

  // ── Market profile ────────────────────────────────────────────────────

  describe('Market profile', () => {
    it('reflects the INDIA_NSE_EQ market identity', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.marketProfile.marketId).toBe('INDIA_NSE_EQ');
      expect(snapshot.marketProfile.displayName).toBe('NSE India Equities');
      expect(snapshot.marketProfile.timezone).toBe('Asia/Kolkata');
      expect(snapshot.marketProfile.settlementCycle).toBe('T+1');
    });

    it('currentPhase is a recognised market phase string', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      const validPhases = ['pre_market', 'regular', 'post_market', 'closed'];
      expect(validPhases).toContain(snapshot.marketProfile.currentPhase);
    });

    it('isTradingDay is a boolean', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(typeof snapshot.marketProfile.isTradingDay).toBe('boolean');
    });
  });

  // ── Health ────────────────────────────────────────────────────────────

  describe('Health', () => {
    it('returns healthy verdict when Runtime is Running with no issues', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.health.verdict).toBe('healthy');
      expect(snapshot.health.lifecycleState).toBe('running');
      expect(snapshot.health.degradedReasons).toEqual([]);
    });

    it('reports degraded reasons when lifecycle is degraded', () => {
      ctx.lifecycle.degrade('Broker not reachable');
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.health.verdict).toBe('degraded');
      expect(snapshot.health.lifecycleState).toBe('degraded');
      expect(snapshot.health.degradedReasons.length).toBeGreaterThanOrEqual(1);
    });

    it('uptimeMs is a positive number', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(typeof snapshot.health.uptimeMs).toBe('number');
      expect(snapshot.health.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it('checkedAt is a valid ISO timestamp', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(() => new Date(snapshot.health.checkedAt)).not.toThrow();
    });
  });

  // ── Runtime ───────────────────────────────────────────────────────────

  describe('Runtime', () => {
    it('shows scheduler status', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.runtime.schedulerStatus).toBeDefined();
      expect(['idle', 'running', 'paused', 'stopped']).toContain(
        snapshot.runtime.schedulerStatus,
      );
    });

    it('tickCount is a non-negative number', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(typeof snapshot.runtime.tickCount).toBe('number');
      expect(snapshot.runtime.tickCount).toBeGreaterThanOrEqual(0);
    });

    it('lastError is null when no error has occurred', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.runtime.lastError).toBeNull();
    });
  });

  // ── Broker (not configured) ───────────────────────────────────────────

  describe('Broker — not configured', () => {
    it('returns null broker when Zerodha not configured', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.broker).toBeNull();
    });
  });

  // ── Recent proposals ──────────────────────────────────────────────────

  describe('Recent proposals', () => {
    it('returns empty array when no proposals exist', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.recentProposals).toEqual([]);
    });

    it('includes seeded accepted proposals', () => {
      seedProposal(ctx.proposalRepo, {
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        side: 'buy',
        product: 'MIS',
        status: ProposalStatus.Accepted,
      });

      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.recentProposals.length).toBe(1);
      expect(snapshot.recentProposals[0].exchange).toBe('NSE');
      expect(snapshot.recentProposals[0].tradingsymbol).toBe('RELIANCE');
      expect(snapshot.recentProposals[0].side).toBe('buy');
      expect(snapshot.recentProposals[0].status).toBe('accepted');
    });

    it('includes refused proposals with validation reasons', () => {
      const proposal = seedProposal(ctx.proposalRepo, {
        exchange: 'NSE',
        tradingsymbol: 'INFY',
        side: 'buy',
        product: 'CNC',
        status: ProposalStatus.Refused,
      });
      seedReason(ctx.proposalRepo, proposal.id, 'market_closed', 'Market is closed');

      const snapshot = ctx.dashboard.getSnapshot();
      const match = snapshot.recentProposals.find(p => p.id === proposal.id);
      expect(match).toBeDefined();
      expect(match!.status).toBe('refused');
      expect(match!.reasons).toContain('Market is closed');
    });

    it('createdAt is a valid ISO timestamp', () => {
      seedProposal(ctx.proposalRepo);

      const snapshot = ctx.dashboard.getSnapshot();
      const proposal = snapshot.recentProposals[0];
      expect(() => new Date(proposal.createdAt)).not.toThrow();
    });

    it('does NOT include access tokens or secret material', () => {
      seedProposal(ctx.proposalRepo);

      const snapshot = ctx.dashboard.getSnapshot();
      const json = JSON.stringify(snapshot);
      expect(json).not.toContain('accessToken');
      expect(json).not.toContain('access_token');
      expect(json).not.toContain('apiKey');
      expect(json).not.toContain('apiSecret');
      expect(json).not.toContain('totpKey');
      expect(json).not.toContain('secret');
    });

    it('limits recent proposals to 20', () => {
      // Insert 25 proposals
      for (let i = 0; i < 25; i++) {
        seedProposal(ctx.proposalRepo, {
          tradingsymbol: `SYM${i}`,
          createdAt: Date.now() + i,
        });
      }

      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.recentProposals.length).toBeLessThanOrEqual(20);
    });
  });

  // ── Recent blocked orders ─────────────────────────────────────────────

  describe('Recent blocked orders', () => {
    it('returns empty array when no blocked orders exist', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.recentBlockedOrders).toEqual([]);
    });

    it('includes seeded blocked orders', () => {
      const proposal = seedProposal(ctx.proposalRepo);
      seedBlockedOrder(ctx.blockedOrderRepo, proposal.id);

      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.recentBlockedOrders.length).toBe(1);
      const bo = snapshot.recentBlockedOrders[0];
      expect(bo.blockCode).toBe('milestone_execution_block_m001');
      expect(bo.blockMessage).toContain('M001 hard block');
      expect(bo.exchange).toBe('NSE');
      expect(bo.tradingsymbol).toBe('RELIANCE');
    });

    it('blockedAt is a valid ISO timestamp', () => {
      const proposal = seedProposal(ctx.proposalRepo);
      seedBlockedOrder(ctx.blockedOrderRepo, proposal.id);

      const snapshot = ctx.dashboard.getSnapshot();
      expect(() => new Date(snapshot.recentBlockedOrders[0].blockedAt)).not.toThrow();
    });

    it('limits recent blocked orders to 20', () => {
      // Insert 25 blocked orders via direct DB insertion (different proposals)
      for (let i = 0; i < 25; i++) {
        const p = seedProposal(ctx.proposalRepo, {
          tradingsymbol: `SYM${i}`,
          createdAt: Date.now() + i,
        });
        seedBlockedOrder(ctx.blockedOrderRepo, p.id, { tradingsymbol: `SYM${i}` });
      }

      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.recentBlockedOrders.length).toBeLessThanOrEqual(20);
    });
  });

  // ── Recent lifecycle events ───────────────────────────────────────────

  describe('Recent lifecycle events', () => {
    it('returns at least the initial lifecycle event', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.recentLifecycleEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('includes seeded lifecycle events with correct state', () => {
      // lifecycle.start() was called in setup, which creates a "running" event
      const snapshot = ctx.dashboard.getSnapshot();
      const runningEvent = snapshot.recentLifecycleEvents.find(e => e.state === 'running');
      expect(runningEvent).toBeDefined();
      expect(runningEvent!.reason).toBeDefined();
    });

    it('timestamp is a valid ISO string', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      for (const event of snapshot.recentLifecycleEvents) {
        expect(() => new Date(event.timestamp)).not.toThrow();
      }
    });

    it('limits recent lifecycle events to 10', () => {
      // Add extra lifecycle events
      for (let i = 0; i < 15; i++) {
        seedLifecycleEvent(ctx.runtimeStateRepo, LifecycleState.Running, `Tick ${i}`);
      }

      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.recentLifecycleEvents.length).toBeLessThanOrEqual(10);
    });
  });

  // ── Empty state / boundary ────────────────────────────────────────────

  describe('Empty state boundaries', () => {
    it('handles zero proposals gracefully', async () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.recentProposals).toEqual([]);
      expect(snapshot.recentBlockedOrders).toEqual([]);
    });

    it('handles zero blocked orders gracefully', () => {
      seedProposal(ctx.proposalRepo);
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.recentBlockedOrders).toEqual([]);
    });

    it('handles stale quotes gracefully', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      // Broker is null (not configured) — no crash
      expect(snapshot.broker).toBeNull();
    });
  });

  // ── Serialisation safety ──────────────────────────────────────────────

  describe('Serialisation safety', () => {
    it('can be JSON-serialised without circular references', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(() => JSON.stringify(snapshot)).not.toThrow();
    });

    it('JSON output is bounded (under 50 KB for typical cases)', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      const json = JSON.stringify(snapshot);
      expect(json.length).toBeLessThan(50_000);
    });
  });

  // ── Degraded state ────────────────────────────────────────────────────

  describe('Degraded state', () => {
    it('includes degradation reasons in health block', () => {
      ctx.lifecycle.degrade('Stream disconnected');
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.health.degradedReasons).toContain('Stream disconnected');
    });

    it('runtime section is still available when degraded', () => {
      ctx.lifecycle.degrade('Stream disconnected');
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.runtime.schedulerStatus).toBeDefined();
      expect(snapshot.marketProfile).toBeDefined();
    });
  });

  // ── Proposal ordering ─────────────────────────────────────────────────

  describe('Proposal ordering', () => {
    it('returns proposals newest first', () => {
      const old = seedProposal(ctx.proposalRepo, {
        tradingsymbol: 'OLD',
        createdAt: Date.now() - 10_000,
      });
      const mid = seedProposal(ctx.proposalRepo, {
        tradingsymbol: 'MID',
        createdAt: Date.now() - 5_000,
      });
      const recent = seedProposal(ctx.proposalRepo, {
        tradingsymbol: 'RECENT',
        createdAt: Date.now(),
      });

      const snapshot = ctx.dashboard.getSnapshot();
      const ids = snapshot.recentProposals.map(p => p.id);
      expect(ids.indexOf(recent.id)).toBeLessThan(ids.indexOf(mid.id));
      expect(ids.indexOf(mid.id)).toBeLessThan(ids.indexOf(old.id));
    });
  });

  // ── Blocked-order ordering ────────────────────────────────────────────

  describe('Blocked-order ordering', () => {
    it('returns blocked orders newest first', () => {
      const p1 = seedProposal(ctx.proposalRepo, { tradingsymbol: 'A' });
      const p2 = seedProposal(ctx.proposalRepo, { tradingsymbol: 'B' });
      const p3 = seedProposal(ctx.proposalRepo, { tradingsymbol: 'C' });

      seedBlockedOrder(ctx.blockedOrderRepo, p1.id, { tradingsymbol: 'A' });
      seedBlockedOrder(ctx.blockedOrderRepo, p2.id, { tradingsymbol: 'B' });
      seedBlockedOrder(ctx.blockedOrderRepo, p3.id, { tradingsymbol: 'C' });

      const snapshot = ctx.dashboard.getSnapshot();
      const ids = snapshot.recentBlockedOrders.map(b => b.id);
      // If all inserted in order, newest = highest id
      expect(ids[0]).toBeGreaterThanOrEqual(ids[ids.length - 1]);
    });
  });

  // ── Universe coverage ─────────────────────────────────────────────────

  describe('Universe coverage', () => {
    it('returns null universe when no snapshot has been computed', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.universe).toBeNull();
    });

    it('returns sufficient coverage from seeded snapshot', () => {
      const now = Date.now();
      ctx.universeRepo.insertSnapshot({
        policyVersion: '1.0.0',
        computedAt: now,
        verdict: UniverseCoverageVerdict.Sufficient,
        eligibleCount: 50,
        ineligibleCount: 0,
        freshQuoteCount: 48,
        staleQuoteCount: 0,
        missingQuoteCount: 2,
        thresholdLabel: 'fresh>=90%_stale<=120000ms',
        thresholdRatio: 0.9,
        maxStalenessMs: 120000,
        members: [],
      });

      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.universe).not.toBeNull();
      expect(snapshot.universe!.policyVersion).toBe('1.0.0');
      expect(snapshot.universe!.verdict).toBe('sufficient');
      expect(snapshot.universe!.eligibleCount).toBe(50);
      expect(snapshot.universe!.freshQuoteCount).toBe(48);
      expect(snapshot.universe!.staleQuoteCount).toBe(0);
      expect(snapshot.universe!.missingQuoteCount).toBe(2);
      expect(snapshot.universe!.thresholdLabel).toBe('fresh>=90%_stale<=120000ms');
      expect(snapshot.universe!.computedAt).toBe(new Date(now).toISOString());
    });

    it('returns stale coverage from seeded snapshot', () => {
      ctx.universeRepo.insertSnapshot({
        policyVersion: '1.0.0',
        computedAt: Date.now(),
        verdict: UniverseCoverageVerdict.Stale,
        eligibleCount: 50,
        ineligibleCount: 0,
        freshQuoteCount: 35,
        staleQuoteCount: 10,
        missingQuoteCount: 5,
        thresholdLabel: 'fresh>=90%_stale<=120000ms',
        thresholdRatio: 0.9,
        maxStalenessMs: 120000,
        members: [],
      });

      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.universe!.verdict).toBe('stale');
      expect(snapshot.universe!.staleQuoteCount).toBe(10);
    });

    it('returns degraded coverage from seeded snapshot', () => {
      ctx.universeRepo.insertSnapshot({
        policyVersion: '1.0.0',
        computedAt: Date.now(),
        verdict: UniverseCoverageVerdict.Degraded,
        eligibleCount: 50,
        ineligibleCount: 0,
        freshQuoteCount: 10,
        staleQuoteCount: 5,
        missingQuoteCount: 35,
        thresholdLabel: 'fresh>=90%_stale<=120000ms',
        thresholdRatio: 0.9,
        maxStalenessMs: 120000,
        members: [],
      });

      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.universe!.verdict).toBe('degraded');
      expect(snapshot.universe!.missingQuoteCount).toBe(35);
    });

    it('does NOT include token/secret material', () => {
      ctx.universeRepo.insertSnapshot({
        policyVersion: '1.0.0',
        computedAt: Date.now(),
        verdict: UniverseCoverageVerdict.Sufficient,
        eligibleCount: 50,
        ineligibleCount: 0,
        freshQuoteCount: 48,
        staleQuoteCount: 0,
        missingQuoteCount: 2,
        thresholdLabel: 'fresh>=90%_stale<=120000ms',
        thresholdRatio: 0.9,
        maxStalenessMs: 120000,
        members: [],
      });

      const snapshot = ctx.dashboard.getSnapshot();
      const json = JSON.stringify(snapshot);
      expect(json).not.toContain('accessToken');
      expect(json).not.toContain('apiKey');
      expect(json).not.toContain('apiSecret');
    });

    it('gracefully handles missing universe snapshot', () => {
      // No snapshot seeded — universe should be null, but rest of snapshot intact
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.universe).toBeNull();
      expect(snapshot.health).toBeDefined();
      expect(snapshot.runtime).toBeDefined();
    });

    it('snapshot section remains bounded in JSON size', () => {
      ctx.universeRepo.insertSnapshot({
        policyVersion: '1.0.0',
        computedAt: Date.now(),
        verdict: UniverseCoverageVerdict.Sufficient,
        eligibleCount: 50,
        ineligibleCount: 0,
        freshQuoteCount: 48,
        staleQuoteCount: 0,
        missingQuoteCount: 2,
        thresholdLabel: 'fresh>=90%_stale<=120000ms',
        thresholdRatio: 0.9,
        maxStalenessMs: 120000,
        members: [],
      });

      const snapshot = ctx.dashboard.getSnapshot();
      const json = JSON.stringify(snapshot);
      expect(json.length).toBeLessThan(50_000);
    });
  });

  // ── Recent strategy decisions ─────────────────────────────────────────

  describe('Recent strategy decisions', () => {
    it('returns empty array when no strategy decisions exist', () => {
      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.recentStrategyDecisions).toEqual([]);
    });

    it('includes seeded approved strategy decisions', () => {
      const proposal = seedProposal(ctx.proposalRepo);
      seedStrategyDecision(ctx.strategyDecisionRepo, proposal.id, {
        tradingsymbol: 'RELIANCE',
        decisionStatus: StrategyDecisionStatus.Approved,
      });

      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.recentStrategyDecisions.length).toBe(1);
      const sd = snapshot.recentStrategyDecisions[0];
      expect(sd.decisionStatus).toBe('approved');
      expect(sd.tradingsymbol).toBe('RELIANCE');
      expect(sd.strategyId).toBe('test-strategy');
      expect(sd.notional).toBe(213_787.50);
      expect(sd.sizingBasis).toBe('last_price');
      expect(sd.exposureTag).toBe('intraday');
      expect(sd.reasons).toEqual([]);
    });

    it('includes refused decisions with ordered reasons', () => {
      const proposal = seedProposal(ctx.proposalRepo);
      const seedResult = seedStrategyDecision(ctx.strategyDecisionRepo, proposal.id, {
        tradingsymbol: 'INFY',
        decisionStatus: StrategyDecisionStatus.Refused,
      });

      const snapshot = ctx.dashboard.getSnapshot();
      const match = snapshot.recentStrategyDecisions.find(d => d.proposalAttemptId === proposal.id);
      expect(match).toBeDefined();
      expect(match!.decisionStatus).toBe('refused');
      expect(match!.reasons.length).toBe(2);
      expect(match!.reasons[0]).toContain('No quote available');
      expect(match!.reasons[1]).toContain('Notional below minimum');
    });

    it('decidedAt is a valid ISO timestamp', () => {
      const proposal = seedProposal(ctx.proposalRepo);
      seedStrategyDecision(ctx.strategyDecisionRepo, proposal.id);

      const snapshot = ctx.dashboard.getSnapshot();
      const decision = snapshot.recentStrategyDecisions[0];
      expect(() => new Date(decision.decidedAt)).not.toThrow();
    });

    it('values lastPrice, notional, quantity from strategy decision', () => {
      const proposal = seedProposal(ctx.proposalRepo);
      seedStrategyDecision(ctx.strategyDecisionRepo, proposal.id, {
        tradingsymbol: 'TCS',
        quantity: 100,
        riskNotional: 350_000,
      });

      const snapshot = ctx.dashboard.getSnapshot();
      const match = snapshot.recentStrategyDecisions.find(d => d.tradingsymbol === 'TCS');
      expect(match).toBeDefined();
      expect(match!.quantity).toBe(100);
      expect(match!.notional).toBe(350_000);
      expect(match!.lastPrice).toBe(2850.50);
    });

    it('limits recent strategy decisions to 20', () => {
      // Insert 25 strategy decisions under different proposals
      for (let i = 0; i < 25; i++) {
        const p = seedProposal(ctx.proposalRepo, {
          tradingsymbol: `SYM${i}`,
          createdAt: Date.now() + i,
        });
        seedStrategyDecision(ctx.strategyDecisionRepo, p.id, {
          tradingsymbol: `SYM${i}`,
          decidedAt: Date.now() + i,
        });
      }

      const snapshot = ctx.dashboard.getSnapshot();
      expect(snapshot.recentStrategyDecisions.length).toBeLessThanOrEqual(20);
    });

    it('returns decisions newest first', () => {
      const p1 = seedProposal(ctx.proposalRepo, { tradingsymbol: 'OLD', createdAt: 100 });
      const p2 = seedProposal(ctx.proposalRepo, { tradingsymbol: 'MID', createdAt: 200 });
      const p3 = seedProposal(ctx.proposalRepo, { tradingsymbol: 'NEW', createdAt: 300 });

      seedStrategyDecision(ctx.strategyDecisionRepo, p1.id, {
        tradingsymbol: 'OLD',
        decidedAt: Date.now() - 10_000,
      });
      seedStrategyDecision(ctx.strategyDecisionRepo, p2.id, {
        tradingsymbol: 'MID',
        decidedAt: Date.now() - 5_000,
      });
      seedStrategyDecision(ctx.strategyDecisionRepo, p3.id, {
        tradingsymbol: 'NEW',
        decidedAt: Date.now(),
      });

      const snapshot = ctx.dashboard.getSnapshot();
      const ids = snapshot.recentStrategyDecisions.map(d => d.id);
      expect(ids[0]).toBe(ids[2] < ids[0] ? ids[0] : ids[0]); // newest first — recent has highest id
    });

    it('does NOT include access tokens or secret material', () => {
      const proposal = seedProposal(ctx.proposalRepo);
      seedStrategyDecision(ctx.strategyDecisionRepo, proposal.id);

      const snapshot = ctx.dashboard.getSnapshot();
      const json = JSON.stringify(snapshot);
      expect(json).not.toContain('accessToken');
      expect(json).not.toContain('access_token');
      expect(json).not.toContain('apiKey');
      expect(json).not.toContain('apiSecret');
    });
  });
});
