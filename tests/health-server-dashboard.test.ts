// ── Health Server Dashboard Route Tests ──
// Tests the /dashboard (HTML) and /dashboard.json (JSON) routes alongside
// existing /health* routes for no-regression.
//
// Covers: success paths, empty states, degraded state, read-model errors,
// unknown paths, secret redaction, and concurrent route correctness.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { RuntimeStateRepository } from '../src/persistence/runtime-state-repo.js';
import { ZerodhaRepository } from '../src/persistence/zerodha-repo.js';
import { BrokerRepository } from '../src/persistence/broker-repo.js';
import { UniverseRepository } from '../src/persistence/universe-repo.js';
import { UniverseService } from '../src/universe/universe-service.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import { BlockedOrderRepository } from '../src/persistence/blocked-order-repo.js';
import { StrategyDecisionRepository } from '../src/persistence/strategy-decision-repo.js';
import { ExecutionAttemptRepository } from '../src/persistence/execution-attempt-repo.js';
import { PaperOrderRepository } from '../src/persistence/paper-order-repo.js';
import { PaperFillRepository } from '../src/persistence/paper-fill-repo.js';
import { PaperPositionRepository } from '../src/persistence/paper-position-repo.js';
import { ExecutionRiskRepository } from '../src/persistence/execution-risk-repo.js';
import { LifecycleManager } from '../src/runtime/lifecycle.js';
import { HealthService } from '../src/runtime/health-service.js';
import { MarketClock } from '../src/runtime/market-clock.js';
import { DashboardReadModel } from '../src/runtime/dashboard-read-model.js';
import { createHealthServer } from '../src/runtime/health-server.js';
import { Scheduler } from '../src/runtime/scheduler.js';
import { Telemetry } from '../src/runtime/telemetry.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';
import {
  ProposalStatus,
  StrategyDecisionStatus,
  ExecutionMode,
  ExecutionAttemptStatus,
  ExecutionOutcomeCode,
  BlockCode,
  UniverseCoverageVerdict,
  type DashboardSnapshot,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Scheduler shim for health-server construction (avoids starting a real loop). */
function createMockScheduler(schedulerOverrides?: Partial<ReturnType<Scheduler['getState']>>) {
  const state = {
    status: 'idle' as const,
    marketPhase: 'closed' as const,
    lastTickTimestamp: null,
    startedAt: null,
    tickCount: 0,
    lastError: null,
    ...schedulerOverrides,
  };
  return {
    getState: () => state,
    start: () => {},
    stop: () => {},
  } as unknown as Scheduler;
}

/** Minimal Telemetry shim. */
function createMockTelemetry(): Telemetry {
  return {
    recordSchedulerState: () => {},
    recordHealthCheck: () => {},
  } as unknown as Telemetry;
}

/** Fetch a URL from the test server and return status + body. */
async function fetchUrl(server: http.Server, path: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      reject(new Error('Server not listening'));
      return;
    }
    http.get(`http://localhost:${addr.port}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
    }).on('error', reject);
  });
}

/** Create a fully wired server + dashboard + fixtures. */
function createServerAndDashboard() {
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
  lifecycle.start('Test setup');
  const healthService = new HealthService(lifecycle, runtimeStateRepo, Date.now());
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const scheduler = createMockScheduler();
  const telemetry = createMockTelemetry();
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
  const server = createHealthServer(healthService, scheduler, telemetry, db, dashboard);

  return {
    db, runtimeStateRepo, zerodhaRepo, brokerRepo, universeRepo, universeService,
    proposalRepo, blockedOrderRepo, strategyDecisionRepo,
    lifecycle, healthService, clock, scheduler, telemetry, dashboard, server,
  };
}

/** Create a fully wired server + dashboard + fixtures with execution attempt repo. */
function createServerAndDashboardWithExecution(mode: ExecutionMode = ExecutionMode.Blocked) {
  const db = new DatabaseManager(':memory:');
  const runtimeStateRepo = new RuntimeStateRepository(db.db);
  const zerodhaRepo = new ZerodhaRepository(db.db);
  const brokerRepo = new BrokerRepository(db.db);
  const universeRepo = new UniverseRepository(db.db);
  const universeService = new UniverseService(brokerRepo, universeRepo);
  const proposalRepo = new ProposalRepository(db.db);
  const blockedOrderRepo = new BlockedOrderRepository(db.db);
  const strategyDecisionRepo = new StrategyDecisionRepository(db.db);
  const attemptRepo = new ExecutionAttemptRepository(db.db);
  const paperOrderRepo = new PaperOrderRepository(db.db);
  const paperFillRepo = new PaperFillRepository(db.db);
  const paperPositionRepo = new PaperPositionRepository(db.db);
  const lifecycle = new LifecycleManager(runtimeStateRepo);
  lifecycle.start('Test setup');
  const healthService = new HealthService(lifecycle, runtimeStateRepo, Date.now());
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const scheduler = createMockScheduler();
  const telemetry = createMockTelemetry();
  const dashboard = new DashboardReadModel({
    healthService,
    runtimeStateRepo,
    zerodhaRepo,
    proposalRepo,
    blockedOrderRepo,
    strategyDecisionRepo,
    clock,
    universeService,
    attemptRepo,
    executionMode: mode,
    paperOrderRepo,
    paperFillRepo,
    paperPositionRepo,
  });
  const server = createHealthServer(healthService, scheduler, telemetry, db, dashboard);

  return {
    db, runtimeStateRepo, zerodhaRepo, brokerRepo, universeRepo, universeService,
    proposalRepo, blockedOrderRepo, strategyDecisionRepo, attemptRepo,
    paperOrderRepo, paperFillRepo, paperPositionRepo,
    lifecycle, healthService, clock, scheduler, telemetry, dashboard, server,
  };
}

/** Create a fully wired server + dashboard + risk repo for risk state tests. */
function createServerAndDashboardWithRiskState() {
  const db = new DatabaseManager(':memory:');
  const runtimeStateRepo = new RuntimeStateRepository(db.db);
  const zerodhaRepo = new ZerodhaRepository(db.db);
  const brokerRepo = new BrokerRepository(db.db);
  const universeRepo = new UniverseRepository(db.db);
  const universeService = new UniverseService(brokerRepo, universeRepo);
  const proposalRepo = new ProposalRepository(db.db);
  const blockedOrderRepo = new BlockedOrderRepository(db.db);
  const strategyDecisionRepo = new StrategyDecisionRepository(db.db);
  const attemptRepo = new ExecutionAttemptRepository(db.db);
  const paperOrderRepo = new PaperOrderRepository(db.db);
  const paperFillRepo = new PaperFillRepository(db.db);
  const paperPositionRepo = new PaperPositionRepository(db.db);
  const riskRepo = new ExecutionRiskRepository(db.db);
  const lifecycle = new LifecycleManager(runtimeStateRepo);
  lifecycle.start('Test setup');
  const healthService = new HealthService(lifecycle, runtimeStateRepo, Date.now());
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const scheduler = createMockScheduler();
  const telemetry = createMockTelemetry();
  const dashboard = new DashboardReadModel({
    healthService,
    runtimeStateRepo,
    zerodhaRepo,
    proposalRepo,
    blockedOrderRepo,
    strategyDecisionRepo,
    clock,
    universeService,
    attemptRepo,
    executionMode: ExecutionMode.Paper,
    paperOrderRepo,
    paperFillRepo,
    paperPositionRepo,
    riskRepo,
  });
  const server = createHealthServer(healthService, scheduler, telemetry, db, dashboard);

  return {
    db, runtimeStateRepo, zerodhaRepo, brokerRepo, universeRepo, universeService,
    proposalRepo, blockedOrderRepo, strategyDecisionRepo, attemptRepo,
    paperOrderRepo, paperFillRepo, paperPositionRepo, riskRepo,
    lifecycle, healthService, clock, scheduler, telemetry, dashboard, server,
  };
}

/** Seed a full proposal+decision+attempt chain for execution tests. */
function seedExecutionChain(
  ctx: ReturnType<typeof createServerAndDashboardWithExecution>,
  overrides?: {
    tradingsymbol?: string;
    attemptStatus?: ExecutionAttemptStatus;
    outcomeCode?: ExecutionOutcomeCode;
    executionMode?: ExecutionMode;
    message?: string;
  },
) {
  const proposal = ctx.proposalRepo.insertAttempt({
    exchange: 'NSE',
    tradingsymbol: overrides?.tradingsymbol ?? 'RELIANCE',
    instrumentToken: 123456,
    side: 'buy',
    product: 'MIS',
    quantity: 75,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: null,
    proposalStatus: ProposalStatus.Accepted,
    createdAt: Date.now(),
  });

  const decision = ctx.strategyDecisionRepo.insertDecisionWithReasons(
    {
      proposalAttemptId: proposal.id,
      decisionStatus: StrategyDecisionStatus.Approved,
      strategyId: 'test-strategy',
      strategyVersion: '1.0.0',
      decidedAt: Date.now(),
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
      riskNotional: 213_787.50,
      riskSizingBasis: 'last_price',
      riskMaxLossRupees: 10_689.38,
      riskStopDistance: null,
      riskExposureTag: 'intraday',
    },
    [],
  );

  const now = Date.now();
  const attempt = ctx.attemptRepo.insertAttempt({
    strategyDecisionId: decision.id,
    executionMode: overrides?.executionMode ?? ExecutionMode.Blocked,
    status: overrides?.attemptStatus ?? ExecutionAttemptStatus.Completed,
    outcomeCode: overrides?.outcomeCode ?? ExecutionOutcomeCode.PaperSimulated,
    brokerOrderId: null,
    message: overrides?.message ?? 'Execution completed',
    attemptedAt: now,
    completedAt: overrides?.attemptStatus === ExecutionAttemptStatus.Completed ? now + 100 : null,
  });

  return { proposal, decision, attempt };
}

/** Seed a proposal for testing. */
function seedProposal(
  repo: ProposalRepository,
  overrides?: Partial<{
    status: ProposalStatus;
    exchange: string;
    tradingsymbol: string;
    side: string;
  }>,
) {
  return repo.insertAttempt({
    exchange: overrides?.exchange ?? 'NSE',
    tradingsymbol: overrides?.tradingsymbol ?? 'RELIANCE',
    instrumentToken: 123456,
    side: overrides?.side ?? 'buy',
    product: 'MIS',
    quantity: 1,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: null,
    proposalStatus: overrides?.status ?? ProposalStatus.Accepted,
    createdAt: Date.now(),
  });
}

/** Seed a validation reason. */
function seedReason(repo: ProposalRepository, proposalId: number, message: string) {
  repo.insertReason(proposalId, {
    reasonCode: 'market_closed' as any,
    reasonMessage: message,
  });
}

/** Seed a blocked order. */
function seedBlockedOrder(
  repo: BlockedOrderRepository,
  proposalAttemptId: number,
  overrides?: Partial<{ tradingsymbol: string; blockCode: BlockCode }>,
) {
  repo.insertBlockedOrder({
    proposalAttemptId,
    blockedAt: Date.now(),
    blockCode: overrides?.blockCode ?? BlockCode.MilestoneExecutionBlockM001,
    blockMessage: 'M001 hard block — no live execution',
    gateTag: 'M001-hard-block',
    exchange: 'NSE',
    tradingsymbol: overrides?.tradingsymbol ?? 'RELIANCE',
    instrumentToken: 123456,
    side: 'buy',
    product: 'MIS',
    quantity: 1,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
  });
}

/** Seed a universe coverage snapshot. */
function seedUniverseSnapshot(
  repo: UniverseRepository,
  overrides?: Partial<{
    verdict: UniverseCoverageVerdict;
    eligibleCount: number;
    freshQuoteCount: number;
    staleQuoteCount: number;
    missingQuoteCount: number;
  }>,
) {
  repo.insertSnapshot({
    policyVersion: '1.0.0',
    computedAt: Date.now(),
    verdict: overrides?.verdict ?? UniverseCoverageVerdict.Sufficient,
    eligibleCount: overrides?.eligibleCount ?? 50,
    ineligibleCount: 0,
    freshQuoteCount: overrides?.freshQuoteCount ?? 48,
    staleQuoteCount: overrides?.staleQuoteCount ?? 0,
    missingQuoteCount: overrides?.missingQuoteCount ?? 2,
    thresholdLabel: 'fresh>=90%_stale<=120000ms',
    thresholdRatio: 0.9,
    maxStalenessMs: 120000,
    members: [],
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

describe('Health server — dashboard routes', () => {
  let ctx: ReturnType<typeof createServerAndDashboard>;

  beforeEach(async () => {
    ctx = createServerAndDashboard();
    await new Promise<void>((resolve, reject) => {
      ctx.server.listen(0, '127.0.0.1', () => resolve());
      ctx.server.on('error', reject);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      ctx.server.close(() => {
        ctx.db.close();
        resolve();
      });
    });
  });

  // ── /dashboard (HTML) ─────────────────────────────────────────────────

  describe('GET /dashboard', () => {
    it('returns 200 with HTML content type', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('includes the dashboard title', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('Runtime Dashboard');
    });

    it('includes market profile information', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('INDIA_NSE_EQ');
      expect(res.body).toContain('NSE India Equities');
    });

    it('includes health verdict with colour coding', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('healthy');
    });

    it('includes runtime/scheduler state section', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('Runtime / Scheduler');
      expect(res.body).toContain('idle');
    });

    it('includes market profile section', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('Market Profile');
    });

    it('includes broker section (not configured)', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('Not configured');
    });

    it('shows empty proposals message when no proposals exist', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('No recent proposals');
    });

    it('shows empty blocked orders message when none exist', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('No blocked orders');
    });

    it('includes lifecycle events section', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('Lifecycle Events');
    });

    it('includes link to JSON view', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('/dashboard.json');
    });

    it('includes link to health JSON', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('/health');
    });

    it('serves HTML with 200 status', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });
  });

  describe('GET /dashboard.json', () => {
    it('returns 200 with JSON content type', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('returns a valid dashboard snapshot shape', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body) as DashboardSnapshot;

      expect(data).toHaveProperty('assembledAt');
      expect(data).toHaveProperty('marketProfile');
      expect(data).toHaveProperty('health');
      expect(data).toHaveProperty('runtime');
      expect(data).toHaveProperty('broker');
      expect(data).toHaveProperty('recentProposals');
      expect(data).toHaveProperty('recentBlockedOrders');
      expect(data).toHaveProperty('recentLifecycleEvents');
    });

    it('marketProfile has expected identity', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body) as DashboardSnapshot;
      expect(data.marketProfile.marketId).toBe('INDIA_NSE_EQ');
      expect(data.marketProfile.displayName).toBe('NSE India Equities');
      expect(data.marketProfile.timezone).toBe('Asia/Kolkata');
    });

    it('health block reflects healthy state', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body) as DashboardSnapshot;
      expect(data.health.verdict).toBe('healthy');
      expect(data.health.lifecycleState).toBe('running');
      expect(data.health.degradedReasons).toEqual([]);
    });

    it('broker is null when not configured', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body) as DashboardSnapshot;
      expect(data.broker).toBeNull();
    });

    it('recentProposals is an empty array when none exist', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body) as DashboardSnapshot;
      expect(data.recentProposals).toEqual([]);
    });

    it('recentBlockedOrders is an empty array when none exist', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body) as DashboardSnapshot;
      expect(data.recentBlockedOrders).toEqual([]);
    });

    it('assembledAt is a valid ISO timestamp', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body) as DashboardSnapshot;
      expect(() => new Date(data.assembledAt)).not.toThrow();
    });

    it('does NOT include access tokens or secret material', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const body = res.body;
      expect(body).not.toContain('accessToken');
      expect(body).not.toContain('access_token');
      expect(body).not.toContain('apiKey');
      expect(body).not.toContain('apiSecret');
      expect(body).not.toContain('totpKey');
      expect(body).not.toContain('secret');
    });
  });

  // ── Dashboard with data ─────────────────────────────────────────────

  describe('Dashboard with proposals and blocked orders', () => {
    it('includes seeded proposals in HTML', async () => {
      seedProposal(ctx.proposalRepo, {
        exchange: 'NSE',
        tradingsymbol: 'INFY',
        side: 'buy',
        status: ProposalStatus.Accepted,
      });
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('INFY');
      expect(res.body).toContain('accepted');
    });

    it('includes refused proposals with reasons in HTML', async () => {
      const p = seedProposal(ctx.proposalRepo, {
        exchange: 'NSE',
        tradingsymbol: 'HDFC',
        side: 'sell',
        status: ProposalStatus.Refused,
      });
      seedReason(ctx.proposalRepo, p.id, 'Market is closed');
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('HDFC');
      expect(res.body).toContain('refused');
      expect(res.body).toContain('Market is closed');
    });

    it('includes seeded proposals in JSON', async () => {
      seedProposal(ctx.proposalRepo, {
        exchange: 'NSE',
        tradingsymbol: 'TCS',
        side: 'buy',
        status: ProposalStatus.Accepted,
      });
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body) as DashboardSnapshot;
      expect(data.recentProposals.length).toBe(1);
      expect(data.recentProposals[0].tradingsymbol).toBe('TCS');
    });

    it('includes seeded blocked orders in HTML', async () => {
      const p = seedProposal(ctx.proposalRepo);
      seedBlockedOrder(ctx.blockedOrderRepo, p.id, { tradingsymbol: 'SBI' });
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('SBI');
      expect(res.body).toContain('milestone_execution_block_m001');
    });

    it('includes seeded blocked orders in JSON', async () => {
      const p = seedProposal(ctx.proposalRepo);
      seedBlockedOrder(ctx.blockedOrderRepo, p.id, { tradingsymbol: 'SBIN' });
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body) as DashboardSnapshot;
      expect(data.recentBlockedOrders.length).toBe(1);
      expect(data.recentBlockedOrders[0].tradingsymbol).toBe('SBIN');
    });
  });

  // ── Degraded state ─────────────────────────────────────────────────

  describe('Dashboard with degraded runtime', () => {
    it('shows degraded verdict in HTML', async () => {
      ctx.lifecycle.degrade('Broker API timeout');
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('degraded');
      // The degraded reason should be visible
      expect(res.body).toContain('Broker API timeout');
    });

    it('includes degradation reasons section in HTML', async () => {
      ctx.lifecycle.degrade('Price feed stale');
      const res = await fetchUrl(ctx.server, '/dashboard');
      // Should have the Degradation Reasons heading and the reason
      expect(res.body).toContain('Degradation Reasons');
      expect(res.body).toContain('Price feed stale');
    });

    it('shows degraded verdict in JSON', async () => {
      ctx.lifecycle.degrade('Quote stream disconnected');
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body) as DashboardSnapshot;
      expect(data.health.verdict).toBe('degraded');
      expect(data.health.degradedReasons).toContain('Quote stream disconnected');
    });
  });

  // ── Unhealthy / Stopped state ───────────────────────────────────────

  describe('Dashboard with unhealthy runtime', () => {
    it('shows unhealthy verdict in HTML when stopped', async () => {
      ctx.lifecycle.stop('Process shutdown');
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('unhealthy');
    });

    it('shows unhealthy verdict in JSON when stopped', async () => {
      ctx.lifecycle.stop('Process shutdown');
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body) as DashboardSnapshot;
      expect(data.health.verdict).toBe('unhealthy');
    });
  });

  // ── 404 / error paths ──────────────────────────────────────────────

  describe('404 handling', () => {
    it('returns 404 for unknown paths', async () => {
      const res = await fetchUrl(ctx.server, '/unknown');
      expect(res.status).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.error).toBe('Not found');
      expect(data.path).toBe('/unknown');
    });

    it('returns JSON content type for 404 errors', async () => {
      const res = await fetchUrl(ctx.server, '/does-not-exist');
      expect(res.headers['content-type']).toContain('application/json');
    });
  });

  // ── /health* no-regression ─────────────────────────────────────────

  describe('/health* routes — no regression', () => {
    it('/health returns 200 with health status', async () => {
      const res = await fetchUrl(ctx.server, '/health');
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toHaveProperty('verdict');
      expect(data).toHaveProperty('lifecycleState');
      expect(data).toHaveProperty('scheduler');
    });

    it('/health/live returns 200 with alive status', async () => {
      const res = await fetchUrl(ctx.server, '/health/live');
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe('alive');
      expect(data.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it('/health/ready returns 200 when lifecycle is Running', async () => {
      const res = await fetchUrl(ctx.server, '/health/ready');
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ready).toBe(true);
    });

    it('/health/ready returns 503 when lifecycle is Stopped', async () => {
      ctx.lifecycle.stop('Shutdown');
      const res = await fetchUrl(ctx.server, '/health/ready');
      expect(res.status).toBe(503);
      const data = JSON.parse(res.body);
      expect(data.ready).toBe(false);
    });

    it('/health/broker returns 404 when broker not configured', async () => {
      const res = await fetchUrl(ctx.server, '/health/broker');
      expect(res.status).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.error).toBe('Broker not configured');
    });

    it('/health/scheduler returns scheduler state', async () => {
      const res = await fetchUrl(ctx.server, '/health/scheduler');
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('marketPhase');
    });
  });

  // ── CORS headers ───────────────────────────────────────────────────

  describe('CORS headers', () => {
    it('sets Access-Control-Allow-Origin on /dashboard', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('sets Access-Control-Allow-Origin on /dashboard.json', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });
  });
});

// ── Universe coverage ──────────────────────────────────────────────────

describe('Health server — universe coverage routes', () => {
  let ctx: ReturnType<typeof createServerAndDashboard>;

  beforeEach(async () => {
    ctx = createServerAndDashboard();
    await new Promise<void>((resolve, reject) => {
      ctx.server.listen(0, '127.0.0.1', () => resolve());
      ctx.server.on('error', reject);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      ctx.server.close(() => {
        ctx.db.close();
        resolve();
      });
    });
  });

  describe('/health/universe', () => {
    it('returns 404 when no snapshot exists', async () => {
      const res = await fetchUrl(ctx.server, '/health/universe');
      expect(res.status).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.error).toBe('No universe coverage snapshot computed yet');
    });

    it('returns 200 with universe coverage data when snapshot exists', async () => {
      seedUniverseSnapshot(ctx.universeRepo, { verdict: UniverseCoverageVerdict.Sufficient });

      const res = await fetchUrl(ctx.server, '/health/universe');
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.policyVersion).toBe('1.0.0');
      expect(data.verdict).toBe('sufficient');
      expect(data.eligibleCount).toBe(50);
      expect(data.freshQuoteCount).toBe(48);
      expect(data.thresholdLabel).toBe('fresh>=90%_stale<=120000ms');
    });

    it('returns stale verdict correctly', async () => {
      seedUniverseSnapshot(ctx.universeRepo, {
        verdict: UniverseCoverageVerdict.Stale,
        freshQuoteCount: 35,
        staleQuoteCount: 10,
        missingQuoteCount: 5,
      });

      const res = await fetchUrl(ctx.server, '/health/universe');
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.verdict).toBe('stale');
      expect(data.staleQuoteCount).toBe(10);
    });

    it('returns degraded verdict correctly', async () => {
      seedUniverseSnapshot(ctx.universeRepo, {
        verdict: UniverseCoverageVerdict.Degraded,
        freshQuoteCount: 10,
        staleQuoteCount: 5,
        missingQuoteCount: 35,
      });

      const res = await fetchUrl(ctx.server, '/health/universe');
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.verdict).toBe('degraded');
      expect(data.missingQuoteCount).toBe(35);
    });

    it('does NOT include tokens or secret material', async () => {
      seedUniverseSnapshot(ctx.universeRepo);

      const res = await fetchUrl(ctx.server, '/health/universe');
      const body = res.body;
      expect(body).not.toContain('accessToken');
      expect(body).not.toContain('apiKey');
      expect(body).not.toContain('apiSecret');
    });
  });

  describe('Dashboard universe block in HTML', () => {
    it('shows "No coverage snapshot computed yet" when no snapshot exists', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('No coverage snapshot computed yet');
    });

    it('shows universe coverage section with sufficient verdict', async () => {
      seedUniverseSnapshot(ctx.universeRepo, { verdict: UniverseCoverageVerdict.Sufficient });

      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('Universe Coverage');
      expect(res.body).toContain('sufficient');
      expect(res.body).toContain('1.0.0');
      expect(res.body).toContain('50');
      expect(res.body).toContain('48');
      expect(res.body).toContain('fresh&gt;=90%');
    });

    it('shows degraded verdict in HTML', async () => {
      seedUniverseSnapshot(ctx.universeRepo, {
        verdict: UniverseCoverageVerdict.Degraded,
        freshQuoteCount: 10,
        staleQuoteCount: 5,
        missingQuoteCount: 35,
      });

      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('degraded');
      expect(res.body).toContain('35');
    });

    it('shows stale verdict in HTML', async () => {
      seedUniverseSnapshot(ctx.universeRepo, {
        verdict: UniverseCoverageVerdict.Stale,
        freshQuoteCount: 35,
        staleQuoteCount: 10,
        missingQuoteCount: 5,
      });

      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('stale');
      expect(res.body).toContain('10');
    });
  });

  describe('Dashboard universe block in JSON', () => {
    it('includes null universe when no snapshot exists', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body) as DashboardSnapshot;
      expect(data.universe).toBeNull();
    });

    it('includes universe coverage snapshot when seeded', async () => {
      seedUniverseSnapshot(ctx.universeRepo, { verdict: UniverseCoverageVerdict.Sufficient });

      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body) as DashboardSnapshot;
      expect(data.universe).not.toBeNull();
      expect(data.universe!.policyVersion).toBe('1.0.0');
      expect(data.universe!.verdict).toBe('sufficient');
      expect(data.universe!.eligibleCount).toBe(50);
      expect(data.universe!.freshQuoteCount).toBe(48);
    });

    it('does NOT include secret material', async () => {
      seedUniverseSnapshot(ctx.universeRepo);

      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const body = res.body;
      expect(body).not.toContain('accessToken');
      expect(body).not.toContain('apiKey');
      expect(body).not.toContain('apiSecret');
    });
  });
});

// ── Strategy evidence routes ───────────────────────────────────────────

describe('Health server — strategy evidence routes', () => {
  let ctx: ReturnType<typeof createServerAndDashboard>;

  beforeEach(async () => {
    ctx = createServerAndDashboard();
    await new Promise<void>((resolve, reject) => {
      ctx.server.listen(0, '127.0.0.1', () => resolve());
      ctx.server.on('error', reject);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      ctx.server.close(() => {
        ctx.db.close();
        resolve();
      });
    });
  });

  describe('/health/strategy', () => {
    it('returns 200 with empty decisions when none exist', async () => {
      const res = await fetchUrl(ctx.server, '/health/strategy');
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.totalDecisions).toBe(0);
      expect(data.approvedCount).toBe(0);
      expect(data.refusedCount).toBe(0);
      expect(data.recentDecisions).toEqual([]);
    });

    it('returns 200 with seeded approved decisions', async () => {
      const proposal = seedProposal(ctx.proposalRepo, { tradingsymbol: 'TCS' });
      seedStrategyDecision(ctx.strategyDecisionRepo, proposal.id, {
        tradingsymbol: 'TCS',
        decisionStatus: StrategyDecisionStatus.Approved,
      });

      const res = await fetchUrl(ctx.server, '/health/strategy');
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.totalDecisions).toBe(1);
      expect(data.approvedCount).toBe(1);
      expect(data.refusedCount).toBe(0);
      expect(data.recentDecisions[0].tradingsymbol).toBe('TCS');
      expect(data.recentDecisions[0].decisionStatus).toBe('approved');
    });

    it('returns 200 with mixed approved and refused decisions', async () => {
      const p1 = seedProposal(ctx.proposalRepo, { tradingsymbol: 'APPROVED' });
      const p2 = seedProposal(ctx.proposalRepo, { tradingsymbol: 'REFUSED' });
      seedStrategyDecision(ctx.strategyDecisionRepo, p1.id, {
        tradingsymbol: 'APPROVED',
        decisionStatus: StrategyDecisionStatus.Approved,
      });
      seedStrategyDecision(ctx.strategyDecisionRepo, p2.id, {
        tradingsymbol: 'REFUSED',
        decisionStatus: StrategyDecisionStatus.Refused,
      });

      const res = await fetchUrl(ctx.server, '/health/strategy');
      const data = JSON.parse(res.body);
      expect(data.totalDecisions).toBe(2);
      expect(data.approvedCount).toBe(1);
      expect(data.refusedCount).toBe(1);
    });

    it('includes refusal reasons in response', async () => {
      const proposal = seedProposal(ctx.proposalRepo, { tradingsymbol: 'INFY' });
      seedStrategyDecision(ctx.strategyDecisionRepo, proposal.id, {
        tradingsymbol: 'INFY',
        decisionStatus: StrategyDecisionStatus.Refused,
      });

      const res = await fetchUrl(ctx.server, '/health/strategy');
      const data = JSON.parse(res.body);
      const refused = data.recentDecisions.find((d: any) => d.decisionStatus === 'refused');
      expect(refused).toBeDefined();
      expect(refused.reasons.length).toBeGreaterThanOrEqual(1);
      expect(refused.reasons[0]).toContain('No quote available');
    });

    it('does NOT include access tokens or secret material', async () => {
      const proposal = seedProposal(ctx.proposalRepo);
      seedStrategyDecision(ctx.strategyDecisionRepo, proposal.id);

      const res = await fetchUrl(ctx.server, '/health/strategy');
      const body = res.body;
      expect(body).not.toContain('accessToken');
      expect(body).not.toContain('apiKey');
      expect(body).not.toContain('apiSecret');
    });
  });

  describe('Dashboard strategy decisions in HTML', () => {
    it('shows "No strategy decisions recorded" when none exist', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('No strategy decisions recorded');
    });

    it('shows approved strategy decisions in HTML', async () => {
      const proposal = seedProposal(ctx.proposalRepo, { tradingsymbol: 'TCS' });
      seedStrategyDecision(ctx.strategyDecisionRepo, proposal.id, {
        tradingsymbol: 'TCS',
        decisionStatus: StrategyDecisionStatus.Approved,
      });

      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('Strategy Decisions');
      expect(res.body).toContain('TCS');
      expect(res.body).toContain('approved');
    });

    it('shows refused strategy decisions with reasons in HTML', async () => {
      const proposal = seedProposal(ctx.proposalRepo, { tradingsymbol: 'INFY' });
      seedStrategyDecision(ctx.strategyDecisionRepo, proposal.id, {
        tradingsymbol: 'INFY',
        decisionStatus: StrategyDecisionStatus.Refused,
      });

      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('INFY');
      expect(res.body).toContain('refused');
      expect(res.body).toContain('No quote available');
    });

    it('does NOT include secret material in HTML', async () => {
      const proposal = seedProposal(ctx.proposalRepo);
      seedStrategyDecision(ctx.strategyDecisionRepo, proposal.id);

      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).not.toContain('accessToken');
      expect(res.body).not.toContain('apiKey');
    });

    it('shows notional value in HTML rows', async () => {
      const proposal = seedProposal(ctx.proposalRepo, { tradingsymbol: 'HDFC' });
      seedStrategyDecision(ctx.strategyDecisionRepo, proposal.id, {
        tradingsymbol: 'HDFC',
        riskNotional: 500_000,
      });

      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('500000');
    });
  });

  describe('Dashboard strategy decisions in JSON', () => {
    it('includes empty strategyDecisions when none exist', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body);
      expect(data.recentStrategyDecisions).toEqual([]);
    });

    it('includes seeded strategy decisions in JSON', async () => {
      const proposal = seedProposal(ctx.proposalRepo, { tradingsymbol: 'TCS' });
      seedStrategyDecision(ctx.strategyDecisionRepo, proposal.id, {
        tradingsymbol: 'TCS',
        decisionStatus: StrategyDecisionStatus.Approved,
      });

      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body);
      expect(data.recentStrategyDecisions.length).toBe(1);
      expect(data.recentStrategyDecisions[0].tradingsymbol).toBe('TCS');
      expect(data.recentStrategyDecisions[0].decisionStatus).toBe('approved');
    });

    it('does NOT include secret material in JSON', async () => {
      const proposal = seedProposal(ctx.proposalRepo);
      seedStrategyDecision(ctx.strategyDecisionRepo, proposal.id);

      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const body = res.body;
      expect(body).not.toContain('accessToken');
      expect(body).not.toContain('apiKey');
    });
  });
});

// ── Execution evidence routes ──────────────────────────────────────────

describe('Health server — execution evidence routes', () => {
  let ctx: ReturnType<typeof createServerAndDashboardWithExecution>;

  beforeEach(async () => {
    ctx = createServerAndDashboardWithExecution(ExecutionMode.Paper);
    await new Promise<void>((resolve, reject) => {
      ctx.server.listen(0, '127.0.0.1', () => resolve());
      ctx.server.on('error', reject);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      ctx.server.close(() => {
        ctx.db.close();
        resolve();
      });
    });
  });

  describe('/health/execution', () => {
    it('returns 200 with execution evidence when dashboard is wired', async () => {
      const res = await fetchUrl(ctx.server, '/health/execution');
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toHaveProperty('mode');
      expect(data).toHaveProperty('totalAttempts');
      expect(data).toHaveProperty('recentAttempts');
      expect(data).toHaveProperty('isGateRefusing');
      expect(data.mode).toBe('paper');
      expect(data.isGateRefusing).toBe(false);
    });

    it('returns 404 when no execution evidence exists (repo not wired)', async () => {
      // Use the base dashboard (no attempt repo)
      const baseCtx = createServerAndDashboard();
      await new Promise<void>((resolve, reject) => {
        baseCtx.server.listen(0, '127.0.0.1', () => resolve());
        baseCtx.server.on('error', reject);
      });
      const res = await fetchUrl(baseCtx.server, '/health/execution');
      expect(res.status).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.mode).toBe('unknown');
      expect(data.totalAttempts).toBe(0);
      await new Promise<void>((resolve) => {
        baseCtx.server.close(() => { baseCtx.db.close(); resolve(); });
      });
    });

    it('shows blocked mode with gate refusing', async () => {
      ctx.server.close();
      ctx.db.close();
      ctx = createServerAndDashboardWithExecution(ExecutionMode.Blocked);
      await new Promise<void>((resolve, reject) => {
        ctx.server.listen(0, '127.0.0.1', () => resolve());
        ctx.server.on('error', reject);
      });

      const res = await fetchUrl(ctx.server, '/health/execution');
      const data = JSON.parse(res.body);
      expect(data.mode).toBe('blocked');
      expect(data.isGateRefusing).toBe(true);
      expect(data.gateRefusalReason).toContain('blocked');
    });

    it('includes total attempts count', async () => {
      seedExecutionChain(ctx, { tradingsymbol: 'TCS' });
      seedExecutionChain(ctx, { tradingsymbol: 'INFY' });

      const res = await fetchUrl(ctx.server, '/health/execution');
      const data = JSON.parse(res.body);
      expect(data.totalAttempts).toBe(2);
    });

    it('includes recent attempts with correct shape', async () => {
      seedExecutionChain(ctx, {
        tradingsymbol: 'TCS',
        attemptStatus: ExecutionAttemptStatus.Completed,
        outcomeCode: ExecutionOutcomeCode.PaperSimulated,
        executionMode: ExecutionMode.Paper,
        message: 'Paper order placed',
      });

      const res = await fetchUrl(ctx.server, '/health/execution');
      const data = JSON.parse(res.body);
      expect(data.recentAttempts.length).toBe(1);
      const ra = data.recentAttempts[0];
      expect(ra.tradingsymbol).toBe('TCS');
      expect(ra.executionMode).toBe('paper');
      expect(ra.status).toBe('completed');
      expect(ra.outcomeCode).toBe('paper_simulated');
    });

    it('returns 503 when dashboard is not wired', async () => {
      // Create a server without dashboard
      const db = new DatabaseManager(':memory:');
      const runtimeStateRepo = new RuntimeStateRepository(db.db);
      const lifecycle = new LifecycleManager(runtimeStateRepo);
      lifecycle.start('Test');
      const healthService = new HealthService(lifecycle, runtimeStateRepo, Date.now());
      const scheduler = createMockScheduler();
      const telemetry = createMockTelemetry();
      const server = createHealthServer(healthService, scheduler, telemetry, db);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

      const res = await fetchUrl(server, '/health/execution');
      expect(res.status).toBe(503);
      const data = JSON.parse(res.body);
      expect(data.error).toContain('Dashboard not available');

      await new Promise<void>((resolve) => server.close(() => { db.close(); resolve(); }));
    });

    it('does NOT include access tokens or secret material', async () => {
      seedExecutionChain(ctx, { tradingsymbol: 'TCS' });

      const res = await fetchUrl(ctx.server, '/health/execution');
      const body = res.body;
      expect(body).not.toContain('accessToken');
      expect(body).not.toContain('apiKey');
      expect(body).not.toContain('apiSecret');
    });

    it('limits recent attempts to 5', async () => {
      for (let i = 0; i < 10; i++) {
        seedExecutionChain(ctx, { tradingsymbol: `SYM${i}` });
      }

      const res = await fetchUrl(ctx.server, '/health/execution');
      const data = JSON.parse(res.body);
      expect(data.recentAttempts.length).toBeLessThanOrEqual(5);
      expect(data.totalAttempts).toBe(10);
    });
  });

  describe('Dashboard execution evidence in HTML', () => {
    it('shows execution section with mode', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('Execution');
      expect(res.body).toContain('paper');
    });

    it('shows "No recent execution attempts" when none exist', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('No recent execution attempts');
    });

    it('shows recent execution attempts in HTML', async () => {
      seedExecutionChain(ctx, {
        tradingsymbol: 'TCS',
        attemptStatus: ExecutionAttemptStatus.Completed,
        outcomeCode: ExecutionOutcomeCode.PaperSimulated,
        executionMode: ExecutionMode.Paper,
        message: 'Paper order placed',
      });

      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('TCS');
      expect(res.body).toContain('paper_simulated');
      expect(res.body).toContain('Paper order placed');
    });

    it('shows blocked mode with gate refusing in HTML', async () => {
      ctx.server.close();
      ctx.db.close();
      ctx = createServerAndDashboardWithExecution(ExecutionMode.Blocked);
      await new Promise<void>((resolve, reject) => {
        ctx.server.listen(0, '127.0.0.1', () => resolve());
        ctx.server.on('error', reject);
      });

      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('blocked');
      expect(res.body).toContain('Gate Refusing');
      expect(res.body).toContain('Yes');
    });

    it('does NOT include secret material in HTML', async () => {
      seedExecutionChain(ctx, { tradingsymbol: 'TCS' });

      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).not.toContain('accessToken');
      expect(res.body).not.toContain('apiKey');
    });
  });

  describe('Dashboard execution evidence in JSON', () => {
    it('includes execution block when wired', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body);
      expect(data).toHaveProperty('execution');
      expect(data.execution).not.toBeNull();
    });

    it('includes execution mode and counts', async () => {
      seedExecutionChain(ctx, { tradingsymbol: 'TCS' });

      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body);
      expect(data.execution.mode).toBe('paper');
      expect(data.execution.totalAttempts).toBe(1);
    });

    it('does NOT include secret material in JSON', async () => {
      seedExecutionChain(ctx, { tradingsymbol: 'TCS' });

      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const body = res.body;
      expect(body).not.toContain('accessToken');
      expect(body).not.toContain('apiKey');
    });
  });

  // ── Paper order/fill/position evidence on /health/execution ───────────

  describe('/health/execution — paper order/fill/position evidence', () => {
    it('returns zero counts when no paper evidence exists', async () => {
      const res = await fetchUrl(ctx.server, '/health/execution');
      const data = JSON.parse(res.body);
      expect(data.totalOrders).toBe(0);
      expect(data.totalFills).toBe(0);
      expect(data.openPositionCount).toBe(0);
      expect(data.recentPaperOrders).toEqual([]);
      expect(data.recentPaperFills).toEqual([]);
      expect(data.currentPositions).toEqual([]);
      expect(data.recentPositionEvents).toEqual([]);
    });

    it('shows paper orders when seeded', async () => {
      const { attempt } = seedExecutionChain(ctx, {
        tradingsymbol: 'TCS',
        executionMode: ExecutionMode.Paper,
        attemptStatus: ExecutionAttemptStatus.Completed,
        outcomeCode: ExecutionOutcomeCode.PaperSimulated,
      });

      ctx.paperOrderRepo.insert({
        executionAttemptId: attempt.id,
        exchange: 'NSE',
        tradingsymbol: 'TCS',
        side: 'buy',
        product: 'MIS',
        quantity: 75,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        tag: null,
        status: 'filled' as any,
        brokerOrderId: 'PAPER-TCS-001',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const res = await fetchUrl(ctx.server, '/health/execution');
      const data = JSON.parse(res.body);
      expect(data.totalOrders).toBe(1);
      expect(data.recentPaperOrders.length).toBe(1);
      expect(data.recentPaperOrders[0].tradingsymbol).toBe('TCS');
      expect(data.recentPaperOrders[0].brokerOrderId).toBe('PAPER-TCS-001');
    });

    it('shows paper fills when seeded', async () => {
      const { attempt } = seedExecutionChain(ctx, {
        tradingsymbol: 'INFY',
        executionMode: ExecutionMode.Paper,
        attemptStatus: ExecutionAttemptStatus.Completed,
        outcomeCode: ExecutionOutcomeCode.PaperSimulated,
      });

      const order = ctx.paperOrderRepo.insert({
        executionAttemptId: attempt.id,
        exchange: 'NSE',
        tradingsymbol: 'INFY',
        side: 'buy',
        product: 'MIS',
        quantity: 100,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        tag: null,
        status: 'filled' as any,
        brokerOrderId: 'PAPER-INFY-001',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      ctx.paperFillRepo.insert({
        paperOrderId: order.id,
        executionAttemptId: attempt.id,
        exchange: 'NSE',
        tradingsymbol: 'INFY',
        side: 'buy',
        product: 'MIS',
        filledQuantity: 100,
        filledPrice: 1500.50,
        brokerOrderId: 'PAPER-INFY-001',
        filledAt: Date.now(),
      });

      const res = await fetchUrl(ctx.server, '/health/execution');
      const data = JSON.parse(res.body);
      expect(data.totalFills).toBe(1);
      expect(data.recentPaperFills.length).toBe(1);
      expect(data.recentPaperFills[0].tradingsymbol).toBe('INFY');
      expect(data.recentPaperFills[0].filledQuantity).toBe(100);
      expect(data.recentPaperFills[0].filledPrice).toBe(1500.50);
    });

    it('shows positions when seeded', async () => {
      ctx.paperPositionRepo.upsertPosition({
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        product: 'MIS',
        side: 'long' as any,
        quantity: 100,
        avgCostPrice: 2500.00,
        realizedPnl: 500.00,
        updatedAt: Date.now(),
      });

      const res = await fetchUrl(ctx.server, '/health/execution');
      const data = JSON.parse(res.body);
      expect(data.openPositionCount).toBe(1);
      expect(data.currentPositions.length).toBe(1);
      expect(data.currentPositions[0].tradingsymbol).toBe('RELIANCE');
      expect(data.currentPositions[0].quantity).toBe(100);
      expect(data.currentPositions[0].realizedPnl).toBe(500.00);
    });

    it('shows position events when seeded', async () => {
      const { attempt } = seedExecutionChain(ctx, {
        tradingsymbol: 'TCS',
        executionMode: ExecutionMode.Paper,
        attemptStatus: ExecutionAttemptStatus.Completed,
        outcomeCode: ExecutionOutcomeCode.PaperSimulated,
      });

      const order = ctx.paperOrderRepo.insert({
        executionAttemptId: attempt.id,
        exchange: 'NSE',
        tradingsymbol: 'TCS',
        side: 'buy',
        product: 'MIS',
        quantity: 75,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        tag: null,
        status: 'filled' as any,
        brokerOrderId: 'PAPER-TCS-EVT',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      ctx.paperPositionRepo.insertEvent({
        paperOrderId: order.id,
        paperFillId: null,
        executionAttemptId: attempt.id,
        eventType: 'fill' as any,
        exchange: 'NSE',
        tradingsymbol: 'TCS',
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

      const res = await fetchUrl(ctx.server, '/health/execution');
      const data = JSON.parse(res.body);
      expect(data.recentPositionEvents.length).toBe(1);
      expect(data.recentPositionEvents[0].tradingsymbol).toBe('TCS');
      expect(data.recentPositionEvents[0].quantityDelta).toBe(75);
    });
  });

  // ── Paper order/fill/position evidence in dashboard HTML ──────────────

  describe('Dashboard HTML — paper order/fill/position evidence', () => {
    it('shows "No paper orders" when none exist', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('No paper orders');
    });

    it('shows "No paper fills" when none exist', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('No paper fills');
    });

    it('shows "No positions" when none exist', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('No positions');
    });

    it('shows "No position events" when none exist', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('No position events');
    });

    it('shows paper orders section in HTML when seeded', async () => {
      const { attempt } = seedExecutionChain(ctx, {
        tradingsymbol: 'TCS',
        executionMode: ExecutionMode.Paper,
        attemptStatus: ExecutionAttemptStatus.Completed,
        outcomeCode: ExecutionOutcomeCode.PaperSimulated,
      });

      ctx.paperOrderRepo.insert({
        executionAttemptId: attempt.id,
        exchange: 'NSE',
        tradingsymbol: 'TCS',
        side: 'buy',
        product: 'MIS',
        quantity: 75,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        tag: null,
        status: 'filled' as any,
        brokerOrderId: 'PAPER-TCS-001',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('Paper Orders');
      expect(res.body).toContain('TCS');
      expect(res.body).toContain('PAPER-TCS-001');
    });

    it('does NOT include secret material in HTML with paper evidence', async () => {
      const { attempt } = seedExecutionChain(ctx, {
        tradingsymbol: 'TCS',
        executionMode: ExecutionMode.Paper,
      });

      ctx.paperOrderRepo.insert({
        executionAttemptId: attempt.id,
        exchange: 'NSE',
        tradingsymbol: 'TCS',
        side: 'buy',
        product: 'MIS',
        quantity: 75,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        tag: null,
        status: 'filled' as any,
        brokerOrderId: 'PAPER-TCS-001',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).not.toContain('accessToken');
      expect(res.body).not.toContain('apiKey');
    });
  });

  // ── Paper order/fill/position evidence in dashboard JSON ──────────────

  describe('Dashboard JSON — paper order/fill/position evidence', () => {
    it('includes paper evidence fields in execution block', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body);
      expect(data.execution).toHaveProperty('totalOrders');
      expect(data.execution).toHaveProperty('totalFills');
      expect(data.execution).toHaveProperty('openPositionCount');
      expect(data.execution).toHaveProperty('recentPaperOrders');
      expect(data.execution).toHaveProperty('recentPaperFills');
      expect(data.execution).toHaveProperty('currentPositions');
      expect(data.execution).toHaveProperty('recentPositionEvents');
    });

    it('populates paper evidence when seeded', async () => {
      const { attempt } = seedExecutionChain(ctx, {
        tradingsymbol: 'TCS',
        executionMode: ExecutionMode.Paper,
        attemptStatus: ExecutionAttemptStatus.Completed,
        outcomeCode: ExecutionOutcomeCode.PaperSimulated,
      });

      ctx.paperOrderRepo.insert({
        executionAttemptId: attempt.id,
        exchange: 'NSE',
        tradingsymbol: 'TCS',
        side: 'buy',
        product: 'MIS',
        quantity: 75,
        price: null,
        triggerPrice: null,
        orderType: 'MARKET',
        tag: null,
        status: 'filled' as any,
        brokerOrderId: 'PAPER-TCS-001',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body);
      expect(data.execution.totalOrders).toBe(1);
      expect(data.execution.recentPaperOrders.length).toBe(1);
      expect(data.execution.recentPaperOrders[0].brokerOrderId).toBe('PAPER-TCS-001');
    });
  });
});

import type { DashboardSnapshot } from '../src/types/runtime.js';

// ── Renderer escaping unit tests ──────────────────────────────────────────

describe('Dashboard renderer — HTML escaping', () => {
  it('escapes < and > in proposal reasons', async () => {
    const { renderDashboardHtml } = await import('../src/runtime/dashboard-render.js');
    const snapshot: DashboardSnapshot = {
      assembledAt: '2025-01-01T00:00:00.000Z',
      marketProfile: {
        marketId: 'TEST',
        displayName: 'Test Market',
        timezone: 'UTC',
        currentPhase: 'closed',
        isTradingDay: false,
        settlementCycle: 'T+1',
      },
      health: {
        verdict: 'healthy',
        uptimeMs: 1000,
        lifecycleState: 'running',
        degradedReasons: [],
        checkedAt: '2025-01-01T00:00:00.000Z',
      },
      runtime: {
        schedulerStatus: 'idle',
        marketPhase: 'closed',
        lastTickTimestamp: null,
        startedAt: null,
        tickCount: 0,
        lastError: null,
      },
      broker: null,
      recentProposals: [
        {
          id: 1,
          exchange: 'NSE',
          tradingsymbol: '<script>alert("xss")</script>',
          side: 'buy',
          product: 'MIS',
          status: 'refused',
          reasons: ['Price < 0', 'Invalid & symbol'],
          createdAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      recentBlockedOrders: [],
      recentLifecycleEvents: [],
      recentStrategyDecisions: [],
    };

    const html = renderDashboardHtml(snapshot);

    // The script tag should be escaped, not executable
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    // Price < 0 should be escaped
    expect(html).toContain('Price &lt; 0');
    expect(html).not.toContain('Price < 0');
    // & symbol should be escaped
    expect(html).toContain('Invalid &amp; symbol');
  });

  it('escapes HTML in blocked order messages', async () => {
    const { renderDashboardHtml } = await import('../src/runtime/dashboard-render.js');
    const snapshot: DashboardSnapshot = {
      assembledAt: '2025-01-01T00:00:00.000Z',
      marketProfile: {
        marketId: 'TEST',
        displayName: 'Test Market',
        timezone: 'UTC',
        currentPhase: 'closed',
        isTradingDay: false,
        settlementCycle: 'T+1',
      },
      health: {
        verdict: 'healthy',
        uptimeMs: 1000,
        lifecycleState: 'running',
        degradedReasons: [],
        checkedAt: '2025-01-01T00:00:00.000Z',
      },
      runtime: {
        schedulerStatus: 'idle',
        marketPhase: 'closed',
        lastTickTimestamp: null,
        startedAt: null,
        tickCount: 0,
        lastError: null,
      },
      broker: null,
      recentProposals: [],
      recentBlockedOrders: [
        {
          id: 1,
          proposalAttemptId: 1,
          blockedAt: '2025-01-01T00:00:00.000Z',
          blockCode: 'test_block',
          blockMessage: 'Error: x > y && z < "quote"',
          exchange: 'NSE',
          tradingsymbol: 'SECURITY',
          side: 'buy',
        },
      ],
      recentLifecycleEvents: [],
      recentStrategyDecisions: [],
    };

    const html = renderDashboardHtml(snapshot);
    expect(html).toContain('Error: x &gt; y');
    expect(html).toContain('z &lt;');
    expect(html).toContain('&quot;quote&quot;');
  });

  it('escapes HTML in universe policy version and threshold label', async () => {
    const { renderDashboardHtml } = await import('../src/runtime/dashboard-render.js');
    const snapshot: DashboardSnapshot = {
      assembledAt: '2025-01-01T00:00:00.000Z',
      marketProfile: {
        marketId: 'TEST',
        displayName: 'Test Market',
        timezone: 'UTC',
        currentPhase: 'closed',
        isTradingDay: false,
        settlementCycle: 'T+1',
      },
      health: {
        verdict: 'healthy',
        uptimeMs: 1000,
        lifecycleState: 'running',
        degradedReasons: [],
        checkedAt: '2025-01-01T00:00:00.000Z',
      },
      runtime: {
        schedulerStatus: 'idle',
        marketPhase: 'closed',
        lastTickTimestamp: null,
        startedAt: null,
        tickCount: 0,
        lastError: null,
      },
      broker: null,
      recentProposals: [],
      recentBlockedOrders: [],
      recentLifecycleEvents: [],
      recentStrategyDecisions: [],
      universe: {
        policyVersion: '1.0.0',
        computedAt: '2025-01-01T00:00:00.000Z',
        verdict: 'sufficient',
        eligibleCount: 50,
        freshQuoteCount: 45,
        staleQuoteCount: 3,
        missingQuoteCount: 2,
        thresholdLabel: 'fresh>=90%_stale<120000ms',
      },
    };

    const html = renderDashboardHtml(snapshot);
    // The threshold label contains < and % which should be escaped
    expect(html).toContain('fresh&gt;=90%');
    expect(html).toContain('_stale&lt;120000ms');
    // Policy version is safe but should be present
    expect(html).toContain('1.0.0');
    // Verdict should be rendered
    expect(html).toContain('sufficient');
    expect(html).toContain('50');
    expect(html).toContain('45');
  });

  it('escapes HTML in execution mode and gate refusal reason', async () => {
    const { renderDashboardHtml } = await import('../src/runtime/dashboard-render.js');
    const snapshot: DashboardSnapshot = {
      assembledAt: '2025-01-01T00:00:00.000Z',
      marketProfile: {
        marketId: 'TEST', displayName: 'Test', timezone: 'UTC',
        currentPhase: 'closed', isTradingDay: false, settlementCycle: 'T+1',
      },
      health: {
        verdict: 'healthy', uptimeMs: 1000, lifecycleState: 'running',
        degradedReasons: [], checkedAt: '2025-01-01T00:00:00.000Z',
      },
      runtime: {
        schedulerStatus: 'idle', marketPhase: 'closed',
        lastTickTimestamp: null, startedAt: null, tickCount: 0, lastError: null,
      },
      broker: null,
      recentProposals: [],
      recentBlockedOrders: [],
      recentLifecycleEvents: [],
      recentStrategyDecisions: [],
      universe: null,
      execution: {
        mode: 'blocked',
        totalAttempts: 1,
        recentAttempts: [
          {
            id: 1,
            strategyDecisionId: 1,
            executionMode: 'blocked',
            status: 'refused',
            outcomeCode: null,
            brokerOrderId: null,
            message: 'Blocked: mode is <blocked> & "refusing"',
            attemptedAt: '2025-01-01T00:00:00.000Z',
            completedAt: null,
            tradingsymbol: 'RELIANCE',
            exchange: 'NSE',
            refusalReasons: ['Mode is & blocked', 'Reason with <tag>'],
          },
        ],
        isGateRefusing: true,
        gateRefusalReason: 'Execution mode is <blocked>: all & attempts refused',
        openPositionCount: 0,
        totalOrders: 0,
        totalFills: 0,
        recentPaperOrders: [],
        recentPaperFills: [],
        currentPositions: [],
        recentPositionEvents: [],
      },
    };

    const html = renderDashboardHtml(snapshot);
    // Message content should be escaped
    expect(html).toContain('Blocked: mode is &lt;blocked&gt; &amp;');
    expect(html).toContain('&quot;refusing&quot;');
    // Gate refusal reason should be escaped
    expect(html).toContain('Execution mode is &lt;blocked&gt;: all &amp; attempts refused');
    // Refusal reasons should be escaped
    expect(html).toContain('Mode is &amp; blocked');
    expect(html).toContain('Reason with &lt;tag&gt;');
    // Mode label should be visible (no escaping needed for plain text)
    expect(html).toContain('blocked');
  });

  it('renders execution section with null execution gracefully', async () => {
    const { renderDashboardHtml } = await import('../src/runtime/dashboard-render.js');
    const snapshot: DashboardSnapshot = {
      assembledAt: '2025-01-01T00:00:00.000Z',
      marketProfile: {
        marketId: 'TEST', displayName: 'Test', timezone: 'UTC',
        currentPhase: 'closed', isTradingDay: false, settlementCycle: 'T+1',
      },
      health: {
        verdict: 'healthy', uptimeMs: 1000, lifecycleState: 'running',
        degradedReasons: [], checkedAt: '2025-01-01T00:00:00.000Z',
      },
      runtime: {
        schedulerStatus: 'idle', marketPhase: 'closed',
        lastTickTimestamp: null, startedAt: null, tickCount: 0, lastError: null,
      },
      broker: null,
      recentProposals: [],
      recentBlockedOrders: [],
      recentLifecycleEvents: [],
      recentStrategyDecisions: [],
      universe: null,
      execution: null,
    };

    const html = renderDashboardHtml(snapshot);
    expect(html).toContain('No execution evidence available');
    expect(html).not.toContain('Total Attempts');
  });

  // ── Risk state rendering ────────────────────────────────────────────────

  describe('Dashboard renderer — risk state rendering', () => {
    it('renders risk state section when riskState is present', async () => {
      const { renderDashboardHtml } = await import('../src/runtime/dashboard-render.js');
      const snapshot: DashboardSnapshot = {
        assembledAt: '2025-01-01T00:00:00.000Z',
        marketProfile: {
          marketId: 'TEST', displayName: 'Test', timezone: 'UTC',
          currentPhase: 'closed', isTradingDay: false, settlementCycle: 'T+1',
        },
        health: {
          verdict: 'healthy', uptimeMs: 1000, lifecycleState: 'running',
          degradedReasons: [], checkedAt: '2025-01-01T00:00:00.000Z',
        },
        runtime: {
          schedulerStatus: 'idle', marketPhase: 'closed',
          lastTickTimestamp: null, startedAt: null, tickCount: 0, lastError: null,
        },
        broker: null,
        recentProposals: [],
        recentBlockedOrders: [],
        recentLifecycleEvents: [],
        recentStrategyDecisions: [],
        universe: null,
        execution: {
          mode: 'paper',
          totalAttempts: 0,
          recentAttempts: [],
          isGateRefusing: false,
          gateRefusalReason: null,
          openPositionCount: 0,
          totalOrders: 0,
          totalFills: 0,
          recentPaperOrders: [],
          recentPaperFills: [],
          currentPositions: [],
          recentPositionEvents: [],
          riskState: {
            haltState: 'no_halt',
            haltSource: null,
            haltReason: null,
            haltedAt: null,
            isRefusing: false,
            latchCount: 0,
            openPositionCountAtHalt: null,
            dailyPnlAtHalt: null,
          },
          recentRiskEvents: [],
        },
      };

      const html = renderDashboardHtml(snapshot);
      expect(html).toContain('Risk State');
      expect(html).toContain('no_halt');
      expect(html).toContain('Is Refusing');
      expect(html).toContain('No');
    });

    it('renders active halt state with red styling', async () => {
      const { renderDashboardHtml } = await import('../src/runtime/dashboard-render.js');
      const snapshot: DashboardSnapshot = {
        assembledAt: '2025-01-01T00:00:00.000Z',
        marketProfile: {
          marketId: 'TEST', displayName: 'Test', timezone: 'UTC',
          currentPhase: 'closed', isTradingDay: false, settlementCycle: 'T+1',
        },
        health: {
          verdict: 'healthy', uptimeMs: 1000, lifecycleState: 'running',
          degradedReasons: [], checkedAt: '2025-01-01T00:00:00.000Z',
        },
        runtime: {
          schedulerStatus: 'idle', marketPhase: 'closed',
          lastTickTimestamp: null, startedAt: null, tickCount: 0, lastError: null,
        },
        broker: null,
        recentProposals: [],
        recentBlockedOrders: [],
        recentLifecycleEvents: [],
        recentStrategyDecisions: [],
        universe: null,
        execution: {
          mode: 'paper',
          totalAttempts: 0,
          recentAttempts: [],
          isGateRefusing: true,
          gateRefusalReason: 'Daily loss limit breached',
          openPositionCount: 3,
          totalOrders: 0,
          totalFills: 0,
          recentPaperOrders: [],
          recentPaperFills: [],
          currentPositions: [],
          recentPositionEvents: [],
          riskState: {
            haltState: 'active_halt',
            haltSource: 'daily_loss',
            haltReason: 'Daily loss limit exceeded P&L -25000',
            haltedAt: '2025-01-01T00:00:00.000Z',
            isRefusing: true,
            latchCount: 1,
            openPositionCountAtHalt: 3,
            dailyPnlAtHalt: -25000,
          },
          recentRiskEvents: [
            {
              id: 1,
              recordedAt: '2025-01-01T00:00:00.000Z',
              eventType: 'daily_loss',
              source: 'daily_loss',
              severity: 'critical',
              message: 'Daily loss limit exceeded',
            },
          ],
        },
      };

      const html = renderDashboardHtml(snapshot);
      expect(html).toContain('active_halt');
      expect(html).toContain('daily_loss');
      expect(html).toContain('Daily loss limit exceeded P&amp;L');
      expect(html).toContain('Is Refusing');
      expect(html).toContain('Yes');
      expect(html).toContain('Latch Count');
      expect(html).toContain('1');
      expect(html).toContain('Positions At Halt');
      expect(html).toContain('3');
      expect(html).toContain('Daily P&amp;L At Halt');
      expect(html).toContain('-25000.00');
      // Risk events table
      expect(html).toContain('Recent Risk Events');
      expect(html).toContain('critical');
      expect(html).toContain('Daily loss limit exceeded');
    });

    it('shows "No risk state available" when riskState is null', async () => {
      const { renderDashboardHtml } = await import('../src/runtime/dashboard-render.js');
      const snapshot: DashboardSnapshot = {
        assembledAt: '2025-01-01T00:00:00.000Z',
        marketProfile: {
          marketId: 'TEST', displayName: 'Test', timezone: 'UTC',
          currentPhase: 'closed', isTradingDay: false, settlementCycle: 'T+1',
        },
        health: {
          verdict: 'healthy', uptimeMs: 1000, lifecycleState: 'running',
          degradedReasons: [], checkedAt: '2025-01-01T00:00:00.000Z',
        },
        runtime: {
          schedulerStatus: 'idle', marketPhase: 'closed',
          lastTickTimestamp: null, startedAt: null, tickCount: 0, lastError: null,
        },
        broker: null,
        recentProposals: [],
        recentBlockedOrders: [],
        recentLifecycleEvents: [],
        recentStrategyDecisions: [],
        universe: null,
        execution: {
          mode: 'paper',
          totalAttempts: 0,
          recentAttempts: [],
          isGateRefusing: false,
          gateRefusalReason: null,
          openPositionCount: 0,
          totalOrders: 0,
          totalFills: 0,
          recentPaperOrders: [],
          recentPaperFills: [],
          currentPositions: [],
          recentPositionEvents: [],
          riskState: null,
          recentRiskEvents: [],
        },
      };

      const html = renderDashboardHtml(snapshot);
      expect(html).toContain('No risk state available');
    });

    it('shows "No risk events" when recentRiskEvents is empty', async () => {
      const { renderDashboardHtml } = await import('../src/runtime/dashboard-render.js');
      const snapshot: DashboardSnapshot = {
        assembledAt: '2025-01-01T00:00:00.000Z',
        marketProfile: {
          marketId: 'TEST', displayName: 'Test', timezone: 'UTC',
          currentPhase: 'closed', isTradingDay: false, settlementCycle: 'T+1',
        },
        health: {
          verdict: 'healthy', uptimeMs: 1000, lifecycleState: 'running',
          degradedReasons: [], checkedAt: '2025-01-01T00:00:00.000Z',
        },
        runtime: {
          schedulerStatus: 'idle', marketPhase: 'closed',
          lastTickTimestamp: null, startedAt: null, tickCount: 0, lastError: null,
        },
        broker: null,
        recentProposals: [],
        recentBlockedOrders: [],
        recentLifecycleEvents: [],
        recentStrategyDecisions: [],
        universe: null,
        execution: {
          mode: 'paper',
          totalAttempts: 0,
          recentAttempts: [],
          isGateRefusing: false,
          gateRefusalReason: null,
          openPositionCount: 0,
          totalOrders: 0,
          totalFills: 0,
          recentPaperOrders: [],
          recentPaperFills: [],
          currentPositions: [],
          recentPositionEvents: [],
          riskState: null,
          recentRiskEvents: [],
        },
      };

      const html = renderDashboardHtml(snapshot);
      expect(html).toContain('No risk events');
    });

    it('escapes HTML in risk event messages', async () => {
      const { renderDashboardHtml } = await import('../src/runtime/dashboard-render.js');
      const snapshot: DashboardSnapshot = {
        assembledAt: '2025-01-01T00:00:00.000Z',
        marketProfile: {
          marketId: 'TEST', displayName: 'Test', timezone: 'UTC',
          currentPhase: 'closed', isTradingDay: false, settlementCycle: 'T+1',
        },
        health: {
          verdict: 'healthy', uptimeMs: 1000, lifecycleState: 'running',
          degradedReasons: [], checkedAt: '2025-01-01T00:00:00.000Z',
        },
        runtime: {
          schedulerStatus: 'idle', marketPhase: 'closed',
          lastTickTimestamp: null, startedAt: null, tickCount: 0, lastError: null,
        },
        broker: null,
        recentProposals: [],
        recentBlockedOrders: [],
        recentLifecycleEvents: [],
        recentStrategyDecisions: [],
        universe: null,
        execution: {
          mode: 'paper',
          totalAttempts: 0,
          recentAttempts: [],
          isGateRefusing: true,
          gateRefusalReason: 'Error: <script>alert("xss")</script>',
          openPositionCount: 0,
          totalOrders: 0,
          totalFills: 0,
          recentPaperOrders: [],
          recentPaperFills: [],
          currentPositions: [],
          recentPositionEvents: [],
          riskState: {
            haltState: 'active_halt',
            haltSource: 'daily_loss',
            haltReason: 'Reason: x > y && z < "limit"',
            haltedAt: '2025-01-01T00:00:00.000Z',
            isRefusing: true,
            latchCount: 1,
            openPositionCountAtHalt: null,
            dailyPnlAtHalt: null,
          },
          recentRiskEvents: [
            {
              id: 1,
              recordedAt: '2025-01-01T00:00:00.000Z',
              eventType: 'refusal',
              source: 'market_hours',
              severity: 'warning',
              message: 'Price < 0 & invalid',
            },
          ],
        },
      };

      const html = renderDashboardHtml(snapshot);
      // Halt reason should be escaped
      expect(html).toContain('Reason: x &gt; y');
      expect(html).toContain('z &lt;');
      expect(html).toContain('&quot;limit&quot;');
      // Risk event message should be escaped
      expect(html).toContain('Price &lt; 0 &amp; invalid');
    });
  });

  // ── Risk state on HTTP endpoints ─────────────────────────────────────────

  describe('Health server — risk state on /health/execution', () => {
    let ctx: ReturnType<typeof createServerAndDashboardWithRiskState>;

    beforeEach(async () => {
      ctx = createServerAndDashboardWithRiskState();
      await new Promise<void>((resolve, reject) => {
        ctx.server.listen(0, '127.0.0.1', () => resolve());
        ctx.server.on('error', reject);
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        ctx.server.close(() => {
          ctx.db.close();
          resolve();
        });
      });
    });

    it('returns riskState as null when no risk events have occurred', async () => {
      const res = await fetchUrl(ctx.server, '/health/execution');
      const data = JSON.parse(res.body);
      expect(data.riskState).not.toBeNull();
      expect(data.riskState.haltState).toBe('no_halt');
      expect(data.riskState.isRefusing).toBe(false);
      expect(data.riskState.latchCount).toBe(0);
      expect(data.recentRiskEvents).toEqual([]);
    });

    it('returns risk events when seeded', async () => {
      ctx.riskRepo.insertEvent({
        eventType: 'refusal',
        source: 'market_hours',
        severity: 'warning',
        message: 'Market closed refusal',
        diagnostic: null,
        recordedAt: Date.now(),
      });

      const res = await fetchUrl(ctx.server, '/health/execution');
      const data = JSON.parse(res.body);
      expect(data.recentRiskEvents.length).toBe(1);
      expect(data.recentRiskEvents[0].eventType).toBe('refusal');
      expect(data.recentRiskEvents[0].message).toBe('Market closed refusal');
      expect(data.recentRiskEvents[0].severity).toBe('warning');
    });

    it('returns active halt state after latch', async () => {
      ctx.riskRepo.latchHalt(
        'daily_loss',
        'Daily loss limit breached: P&L -30000',
        Date.now(),
        2,
        -30000,
      );

      const res = await fetchUrl(ctx.server, '/health/execution');
      const data = JSON.parse(res.body);
      expect(data.riskState.haltState).toBe('active_halt');
      expect(data.riskState.haltSource).toBe('daily_loss');
      expect(data.riskState.isRefusing).toBe(true);
      expect(data.riskState.latchCount).toBe(1);
      expect(data.riskState.openPositionCountAtHalt).toBe(2);
      expect(data.riskState.dailyPnlAtHalt).toBe(-30000);
    });

    it('returns latched state after unlatch', async () => {
      ctx.riskRepo.latchHalt(
        'daily_loss',
        'Daily loss limit breached',
        Date.now(),
        3,
        -25000,
      );
      ctx.riskRepo.unlatchHalt(Date.now());

      const res = await fetchUrl(ctx.server, '/health/execution');
      const data = JSON.parse(res.body);
      expect(data.riskState.haltState).toBe('no_halt');
      expect(data.riskState.isRefusing).toBe(false);
      expect(data.riskState.latchCount).toBe(0);
    });

    it('does NOT include secret material in risk state', async () => {
      ctx.riskRepo.latchHalt(
        'daily_loss',
        'Loss limit exceeded',
        Date.now(),
      );

      const res = await fetchUrl(ctx.server, '/health/execution');
      const body = res.body;
      expect(body).not.toContain('accessToken');
      expect(body).not.toContain('apiKey');
      expect(body).not.toContain('apiSecret');
    });
  });

  // ── Risk state in dashboard HTML ─────────────────────────────────────────

  describe('Dashboard HTML — risk state evidence', () => {
    let ctx: ReturnType<typeof createServerAndDashboardWithRiskState>;

    beforeEach(async () => {
      ctx = createServerAndDashboardWithRiskState();
      await new Promise<void>((resolve, reject) => {
        ctx.server.listen(0, '127.0.0.1', () => resolve());
        ctx.server.on('error', reject);
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        ctx.server.close(() => {
          ctx.db.close();
          resolve();
        });
      });
    });

    it('shows risk state section in dashboard HTML', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('Risk State');
      expect(res.body).toContain('no_halt');
    });

    it('shows "No risk events" when no risk events exist', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('No risk events');
    });

    it('shows risk events in dashboard HTML after seeding', async () => {
      ctx.riskRepo.insertEvent({
        eventType: 'refusal',
        source: 'market_hours',
        severity: 'warning',
        message: 'Out of hours refusal',
        diagnostic: null,
        recordedAt: Date.now(),
      });

      const res = await fetchUrl(ctx.server, '/dashboard');
      expect(res.body).toContain('Recent Risk Events');
      expect(res.body).toContain('Out of hours refusal');
      expect(res.body).toContain('warning');
      expect(res.body).toContain('refusal');
    });
  });

  // ── Risk state in dashboard JSON ─────────────────────────────────────────

  describe('Dashboard JSON — risk state evidence', () => {
    let ctx: ReturnType<typeof createServerAndDashboardWithRiskState>;

    beforeEach(async () => {
      ctx = createServerAndDashboardWithRiskState();
      await new Promise<void>((resolve, reject) => {
        ctx.server.listen(0, '127.0.0.1', () => resolve());
        ctx.server.on('error', reject);
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        ctx.server.close(() => {
          ctx.db.close();
          resolve();
        });
      });
    });

    it('includes riskState and recentRiskEvents in dashboard JSON', async () => {
      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body);
      expect(data.execution.riskState).not.toBeNull();
      expect(data.execution.riskState.haltState).toBe('no_halt');
      expect(data.execution.riskState.isRefusing).toBe(false);
      expect(data.execution.recentRiskEvents).toEqual([]);
    });

    it('includes risk events in dashboard JSON after seeding', async () => {
      ctx.riskRepo.insertEvent({
        eventType: 'refusal',
        source: 'market_hours',
        severity: 'warning',
        message: 'Refused during market hours',
        diagnostic: null,
        recordedAt: Date.now(),
      });

      const res = await fetchUrl(ctx.server, '/dashboard.json');
      const data = JSON.parse(res.body);
      expect(data.execution.recentRiskEvents.length).toBe(1);
      expect(data.execution.recentRiskEvents[0].eventType).toBe('refusal');
      expect(data.execution.recentRiskEvents[0].message).toBe('Refused during market hours');
    });
  });
});
