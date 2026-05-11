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
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import { BlockedOrderRepository } from '../src/persistence/blocked-order-repo.js';
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
  BlockCode,
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
  const proposalRepo = new ProposalRepository(db.db);
  const blockedOrderRepo = new BlockedOrderRepository(db.db);
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
    clock,
  });
  const server = createHealthServer(healthService, scheduler, telemetry, db, dashboard);

  return {
    db, runtimeStateRepo, zerodhaRepo, proposalRepo, blockedOrderRepo,
    lifecycle, healthService, clock, scheduler, telemetry, dashboard, server,
  };
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
    };

    const html = renderDashboardHtml(snapshot);
    expect(html).toContain('Error: x &gt; y');
    expect(html).toContain('z &lt;');
    expect(html).toContain('&quot;quote&quot;');
  });
});
