// ── S02 Runtime Integration Test ──
// Verifies that broker services compose correctly into the runtime,
// the health surface includes broker fields, and the supervisor runs
// on scheduler ticks without crashing.
//
// Uses :memory: SQLite — no disk persistence required.

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { RuntimeStateRepository } from '../src/persistence/runtime-state-repo.js';
import { ZerodhaRepository } from '../src/persistence/zerodha-repo.js';
import { LifecycleManager } from '../src/runtime/lifecycle.js';
import { HealthService } from '../src/runtime/health-service.js';
import { MarketClock } from '../src/runtime/market-clock.js';
import { Scheduler, type TickWork } from '../src/runtime/scheduler.js';
import { Telemetry } from '../src/runtime/telemetry.js';
import { SessionService } from '../src/integrations/zerodha/session-service.js';
import { InstrumentsService } from '../src/integrations/zerodha/instruments-service.js';
import { MarketDataStream } from '../src/integrations/zerodha/market-data-stream.js';
import { ZerodhaSupervisor } from '../src/integrations/zerodha/zerodha-supervisor.js';
import {
  HealthVerdict,
  LifecycleState,
  SchedulerStatus,
  MarketPhase,
  type ZerodhaConfig,
  type HealthStatus,
  type InstrumentRecord,
} from '../src/types/runtime.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal Zerodha config for testing (valid-enough structure). */
function createTestZerodhaConfig(): ZerodhaConfig {
  return {
    apiKey: 'test_api_key',
    apiSecret: 'test_api_secret',
    userId: 'test_user',
    totpKey: 'test_totp_key',
    sessionRefreshIntervalMs: 21_600_000,
  };
}

function createFixtures() {
  const mgr = new DatabaseManager(':memory:');
  const repo = new RuntimeStateRepository(mgr.db);
  const zerodhaRepo = new ZerodhaRepository(mgr.db);
  const lifecycle = new LifecycleManager(repo);
  const health = new HealthService(lifecycle, repo, Date.now());
  const telemetry = new Telemetry(repo);
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);

  return { mgr, repo, zerodhaRepo, lifecycle, health, telemetry, clock };
}

function createZerodhaServices(zerodhaRepo: ZerodhaRepository, zerodhaConfig: ZerodhaConfig) {
  const session = new SessionService(zerodhaConfig, zerodhaRepo);
  const instruments = new InstrumentsService(zerodhaRepo);
  const stream = new MarketDataStream(zerodhaRepo);
  const supervisor = new ZerodhaSupervisor(session, instruments, zerodhaRepo, stream);
  return { session, instruments, stream, supervisor };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('S02 Runtime — Zerodha composition', () => {
  describe('ZerodhaSupervisor', () => {
    it('reports configured status', () => {
      const { zerodhaRepo } = createFixtures();
      const { supervisor } = createZerodhaServices(zerodhaRepo, createTestZerodhaConfig());
      expect(supervisor.isConfigured).toBe(true);
    });

    it('refreshes instruments on warm restart when MCP key cache is empty', async () => {
      const { zerodhaRepo } = createFixtures();
      const session = new SessionService(
        {
          transport: 'mcp',
          mcpUrl: 'http://localhost:8787/mcp',
          sessionRefreshIntervalMs: 21_600_000,
        },
        zerodhaRepo,
      );
      const instruments = new InstrumentsService(zerodhaRepo);

      const seededRecord: InstrumentRecord = {
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        instrumentToken: 12345,
        name: 'RELIANCE',
        expiry: null,
        strike: null,
        lotSize: 1,
        tickSize: 0.05,
        instrumentType: 'EQ',
        segment: 'NSE',
        exchangeToken: 12345,
      };

      instruments.syncFromRecords([seededRecord]);
      session.applySessionMaterial({
        accessToken: 'mcp-session',
        expiresAt: Date.now() + 60 * 60 * 1000,
        reason: 'seed session',
      });

      const subscriptions: number[][] = [];
      const stream = {
        connect: async () => {},
        disconnect: async () => {},
        subscribe(tokens: number[]) { subscriptions.push(tokens); },
        unsubscribe() {},
        getLatestQuote: () => null,
        getAllQuotes: () => [],
        getState: () => 'disconnected' as const,
        getDiagnostics: () => ({
          state: 'disconnected' as const,
          connectedAt: null,
          lastHeartbeatAt: null,
          lastQuoteReceivedAt: null,
          reconnectCount: 0,
          parseFailures: 0,
          subscribedCount: subscriptions.flat().length,
          lastError: null,
          createdAt: Date.now(),
        }),
        persistDiagnostics: () => {},
        checkQuoteFreshness: () => ({ isStale: true, stalenessMs: null, lastQuoteAt: null }),
        syncNow: async () => {},
      };

      let fetchCount = 0;
      const supervisor = new ZerodhaSupervisor(
        session,
        instruments,
        zerodhaRepo,
        stream,
        {
          refreshSession: async () => ({ accessToken: 'mcp-session', reason: 'probe' }),
          fetchInstrumentCatalog: async () => {
            fetchCount += 1;
            return [seededRecord];
          },
          hasCachedInstrumentKeys: () => false,
        },
      );

      await supervisor.doWork(new Date(), {
        verdict: HealthVerdict.Healthy,
        uptimeMs: 0,
        lifecycleState: LifecycleState.Running,
        scheduler: {
          status: SchedulerStatus.Running,
          marketPhase: MarketPhase.Closed,
          lastTickTimestamp: null,
          startedAt: null,
          tickCount: 0,
          lastError: null,
        },
        degradedReasons: [],
        checkedAt: new Date().toISOString(),
      });

      expect(fetchCount).toBe(1);
      expect(subscriptions).toContainEqual([12345]);
    });

    it('reports not configured when config is absent', () => {
      // Create supervisor with a config that has empty strings
      const { zerodhaRepo } = createFixtures();
      const session = new SessionService(
        { apiKey: '', apiSecret: '', userId: '', totpKey: '', sessionRefreshIntervalMs: 21_600_000 },
        zerodhaRepo,
      );
      const instruments = new InstrumentsService(zerodhaRepo);
      const supervisor = new ZerodhaSupervisor(session, instruments, zerodhaRepo, null);
      expect(supervisor.isConfigured).toBe(false);
    });
  });

  describe('getBrokerHealth() — defaults before any sync', () => {
    it('returns session health with missing_credentials', () => {
      const { zerodhaRepo } = createFixtures();
      const { supervisor } = createZerodhaServices(zerodhaRepo, createTestZerodhaConfig());
      const health = supervisor.getBrokerHealth();

      expect(health.session.state).toBe('missing_credentials');
      expect(health.session.obtainedAt).toBe(0);
      expect(health.session.expiresAt).toBe(0);
    });

    it('returns instrument health with isStale=true and null counts', () => {
      const { zerodhaRepo } = createFixtures();
      const { supervisor } = createZerodhaServices(zerodhaRepo, createTestZerodhaConfig());
      const health = supervisor.getBrokerHealth();

      expect(health.instruments.isStale).toBe(true);
      expect(health.instruments.lastSuccessAt).toBeNull();
      expect(health.instruments.instrumentCount).toBeNull();
    });

    it('returns stream health with disconnected state', () => {
      const { zerodhaRepo } = createFixtures();
      const { supervisor } = createZerodhaServices(zerodhaRepo, createTestZerodhaConfig());
      const health = supervisor.getBrokerHealth();

      expect(health.stream.state).toBe('disconnected');
      expect(health.stream.reconnectCount).toBe(0);
      expect(health.stream.isStale).toBe(true);
    });

    it('returns empty recentEvents array', () => {
      const { zerodhaRepo } = createFixtures();
      const { supervisor } = createZerodhaServices(zerodhaRepo, createTestZerodhaConfig());
      const health = supervisor.getBrokerHealth();

      expect(health.recentEvents).toEqual([]);
    });
  });

  describe('getBrokerHealth() — after session is established', () => {
    it('returns authenticated state after session upsert', () => {
      const { zerodhaRepo } = createFixtures();
      const config = createTestZerodhaConfig();
      const session = new SessionService(config, zerodhaRepo);
      const instruments = new InstrumentsService(zerodhaRepo);
      const supervisor = new ZerodhaSupervisor(session, instruments, zerodhaRepo, null);

      // Simulate a successful token exchange
      session.handleTokenResponse({
        access_token: 'test_access_token_123',
        login_time: new Date().toISOString(),
      });

      const health = supervisor.getBrokerHealth();
      expect(health.session.state).toBe('authenticated');
      expect(health.session.obtainedAt).toBeGreaterThan(0);
      expect(health.session.expiresAt).toBeGreaterThan(0);
    });

    it('returns auth_failed after failed token exchange', () => {
      const { zerodhaRepo } = createFixtures();
      const config = createTestZerodhaConfig();
      const session = new SessionService(config, zerodhaRepo);
      const instruments = new InstrumentsService(zerodhaRepo);
      const supervisor = new ZerodhaSupervisor(session, instruments, zerodhaRepo, null);

      session.handleTokenResponse(null);

      const health = supervisor.getBrokerHealth();
      expect(health.session.state).toBe('auth_failed');
      expect(health.session.lastError).not.toBeNull();
    });
  });
});

describe('HealthService — broker health integration', () => {
  it('does not include zerodha field when no supervisor is set', () => {
    const { mgr, repo, lifecycle } = createFixtures();
    const health = new HealthService(lifecycle, repo, Date.now());
    lifecycle.start();

    const status = health.getHealth();
    expect(status.zerodha).toBeUndefined();
  });

  it('includes zerodha block when supervisor is set', () => {
    const { zerodhaRepo, repo, lifecycle } = createFixtures();
    const health = new HealthService(lifecycle, repo, Date.now());

    const { supervisor } = createZerodhaServices(zerodhaRepo, createTestZerodhaConfig());
    health.setZerodhaSupervisor(supervisor);
    lifecycle.start();

    const status = health.getHealth();
    expect(status.zerodha).toBeDefined();
    expect(status.zerodha!.session).toBeDefined();
    expect(status.zerodha!.instruments).toBeDefined();
    expect(status.zerodha!.stream).toBeDefined();
    expect(status.zerodha!.recentEvents).toBeDefined();
  });

  it('broker health reflects configured state', () => {
    const { zerodhaRepo, repo, lifecycle } = createFixtures();
    const health = new HealthService(lifecycle, repo, Date.now());

    const config = createTestZerodhaConfig();
    const session = new SessionService(config, zerodhaRepo);
    const instruments = new InstrumentsService(zerodhaRepo);
    const supervisor = new ZerodhaSupervisor(session, instruments, zerodhaRepo, null);

    // Simulate successful auth
    session.handleTokenResponse({ access_token: 'tok123', login_time: new Date().toISOString() });

    health.setZerodhaSupervisor(supervisor);
    lifecycle.start();

    const status = health.getHealth();
    expect(status.zerodha!.session.state).toBe('authenticated');
  });

  it('setZerodhaSupervisor(null) removes the block', () => {
    const { zerodhaRepo, repo, lifecycle } = createFixtures();
    const health = new HealthService(lifecycle, repo, Date.now());

    const { supervisor } = createZerodhaServices(zerodhaRepo, createTestZerodhaConfig());
    health.setZerodhaSupervisor(supervisor);
    health.setZerodhaSupervisor(null);

    const status = health.getHealth();
    expect(status.zerodha).toBeUndefined();
  });
});

describe('Scheduler — TickWork integration', () => {
  it('accepts tickWork array and runs hooks without crashing', async () => {
    const { mgr, repo, zerodhaRepo, lifecycle, health, telemetry, clock } = createFixtures();

    const config = createTestZerodhaConfig();
    const session = new SessionService(config, zerodhaRepo);
    const instruments = new InstrumentsService(zerodhaRepo);
    const stream = new MarketDataStream(zerodhaRepo);
    const supervisor = new ZerodhaSupervisor(session, instruments, zerodhaRepo, stream);
    health.setZerodhaSupervisor(supervisor);

    lifecycle.start();

    const scheduler = new Scheduler({
      clock,
      lifecycle,
      repo,
      health,
      telemetry,
      intervalMs: 20,
      tickWork: [supervisor],
    });

    const initialState = scheduler.start();
    expect(initialState.status).toBe(SchedulerStatus.Running);

    // Let it tick a few times
    await new Promise(r => setTimeout(r, 80));

    const state = scheduler.getState();
    expect(state.tickCount).toBeGreaterThanOrEqual(2);

    // Health should include broker block
    const healthStatus = health.getHealth();
    expect(healthStatus.zerodha).toBeDefined();
    expect(healthStatus.zerodha!.stream.state).toBe('disconnected');
    expect(healthStatus.zerodha!.session.state).toBe('missing_credentials');

    scheduler.stop('test done');
  });

  it('tickWork failures do not crash the scheduler', async () => {
    const { mgr, repo, lifecycle, health, telemetry, clock } = createFixtures();

    // A TickWork that always throws
    const failingWork: TickWork = {
      label: 'failer',
      async doWork() {
        throw new Error('Intentional failure');
      },
    };

    lifecycle.start();

    const scheduler = new Scheduler({
      clock,
      lifecycle,
      repo,
      health,
      telemetry,
      intervalMs: 20,
      tickWork: [failingWork],
    });

    scheduler.start();
    await new Promise(r => setTimeout(r, 80));

    const state = scheduler.getState();
    // Scheduler should still be running despite tickwork failures
    expect(state.status).toBe(SchedulerStatus.Running);
    expect(state.tickCount).toBeGreaterThanOrEqual(2);

    // The lifecycle may be Degraded or recovered-Running depending on tick timing.
    // The key contract: scheduler keeps running and records the failures.
    const diag = health.getHealth();
    expect(diag.lifecycleState).toBeDefined();

    scheduler.stop('test done');
  });

  it('does not re-enter tickWork while a previous scheduler tick is still running', async () => {
    const { repo, lifecycle, health, telemetry, clock } = createFixtures();
    let active = 0;
    let maxActive = 0;
    let invocations = 0;

    const slowWork: TickWork = {
      label: 'slow-work',
      async doWork() {
        invocations++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 60));
        active--;
      },
    };

    lifecycle.start();

    const scheduler = new Scheduler({
      clock,
      lifecycle,
      repo,
      health,
      telemetry,
      intervalMs: 10,
      tickWork: [slowWork],
    });

    scheduler.start();
    await new Promise(resolve => setTimeout(resolve, 95));
    scheduler.stop('test done');

    expect(maxActive).toBe(1);
    expect(invocations).toBeLessThanOrEqual(3);
  });

  it('empty tickWork array works the same as no tickWork', async () => {
    const { mgr, repo, lifecycle, health, telemetry, clock } = createFixtures();
    lifecycle.start();

    const scheduler = new Scheduler({
      clock,
      lifecycle,
      repo,
      health,
      telemetry,
      intervalMs: 20,
      tickWork: [],
    });

    scheduler.start();
    await new Promise(r => setTimeout(r, 60));

    const state = scheduler.getState();
    expect(state.status).toBe(SchedulerStatus.Running);
    expect(state.tickCount).toBeGreaterThanOrEqual(1);

    scheduler.stop('test done');
  });
});

describe('HealthServer — broker endpoint', () => {
  it('returns broker block via getHealth when supervisor is set', () => {
    const { zerodhaRepo, repo, lifecycle } = createFixtures();
    const health = new HealthService(lifecycle, repo, Date.now());
    const { supervisor } = createZerodhaServices(zerodhaRepo, createTestZerodhaConfig());
    health.setZerodhaSupervisor(supervisor);
    lifecycle.start();

    const status = health.getHealth();
    expect(status.zerodha).toBeDefined();
  });
});
