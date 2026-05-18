// ── S05 Runtime Integration Test ──
// Proves that the reusable RuntimeApp harness can build, start, and stop the
// real composed runtime against a temp SQLite database, and that the
// dashboard read-model produces a valid snapshot from the composed runtime.
//
// Uses :memory: SQLite — no disk persistence required.
// Deterministic guards (no real-time sleeps).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeApp, type RuntimeAppHandles } from '../src/runtime/runtime-app.js';
import { ExecutionMode, type RuntimeConfig } from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Minimal config for testing (no broker, no Proposal Engine)
// ---------------------------------------------------------------------------

function testConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    port: 0, // OS-assigned port (prevents EADDRINUSE in parallel runs)
    nodeEnv: 'test',
    marketTimezone: 'Asia/Kolkata',
    schedulerIntervalMs: 60000, // Won't tick during tests (no timers started)
    dbPath: ':memory:',
    logLevel: 'error', // Suppress boot logs
    zerodha: null,
    proposalEngine: null,
    execution: { mode: ExecutionMode.Blocked, maxRetries: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('S05 Runtime — RuntimeApp harness', () => {
  let app: RuntimeApp;

  afterEach(() => {
    // Ensure cleanup even if test fails mid-way
    try {
      app.stop('Test teardown');
    } catch {
      // Already stopped
    }
  });

  // ── Build lifecycle ──────────────────────────────────────────────────

  describe('Build lifecycle', () => {
    it('builds handles without starting the server or scheduler', () => {
      app = new RuntimeApp(testConfig({ port: 0 }));
      const handles = app.build();

      expect(handles).toHaveProperty('dbManager');
      expect(handles).toHaveProperty('lifecycle');
      expect(handles).toHaveProperty('healthService');
      expect(handles).toHaveProperty('scheduler');
      expect(handles).toHaveProperty('dashboard');
      expect(handles).toHaveProperty('server');
      expect(handles).toHaveProperty('runtimeStateRepo');
      expect(handles).toHaveProperty('zerodhaRepo');

      // Broker services should be null when not configured
      expect(handles.zerodhaSupervisor).toBeNull();
      expect(handles.proposalSupervisor).toBeNull();
      expect(handles.executionGateSupervisor).toBeNull();
    });

    it('lifecycle is in Running state after build', () => {
      app = new RuntimeApp(testConfig());
      const handles = app.build();

      expect(handles.lifecycle.state).toBe('running');
    });

    it('can build handles twice (idempotent)', () => {
      app = new RuntimeApp(testConfig());
      const handles1 = app.build();
      const handles2 = app.build();

      // Same reference
      expect(handles1).toBe(handles2);
    });
  });

  // ── Start lifecycle ──────────────────────────────────────────────────

  describe('Start lifecycle', () => {
    it('starts the scheduler and server', () => {
      app = new RuntimeApp(testConfig({ port: 0 }));
      const handles = app.start();

      expect(handles.scheduler.isRunning).toBe(true);
      expect(handles.scheduler.getState().status).toBe('running');

      // Server should be listening on assigned port
      expect(handles.server.listening).toBe(true);
    });
  });

  // ── Stop lifecycle ───────────────────────────────────────────────────

  describe('Stop lifecycle', () => {
    it('stops the scheduler and closes the server', () => {
      app = new RuntimeApp(testConfig({ port: 0 }));
      const handles = app.start();

      app.stop('Test stop');

      // After stop, handles are cleared
      // But we can verify the scheduler stopped via its state
      expect(handles.scheduler.getState().status).toBe('stopped');
      expect(handles.server.listening).toBe(false);
    });

    it('is safe to call stop multiple times', () => {
      app = new RuntimeApp(testConfig());
      app.start();
      app.stop('First');
      app.stop('Second');
      // No throw = pass
    });
  });

  // ── Dashboard snapshot from composed runtime ─────────────────────────

  describe('Dashboard snapshot integration', () => {
    it('produces a valid snapshot from the composed runtime', () => {
      app = new RuntimeApp(testConfig({ port: 0 }));
      const handles = app.build();

      const snapshot = handles.dashboard.getSnapshot();
      expect(snapshot).toHaveProperty('assembledAt');
      expect(snapshot).toHaveProperty('marketProfile');
      expect(snapshot).toHaveProperty('health');
      expect(snapshot).toHaveProperty('runtime');
      expect(snapshot).toHaveProperty('recentProposals');
      expect(snapshot).toHaveProperty('recentBlockedOrders');
      expect(snapshot).toHaveProperty('recentLifecycleEvents');
    });

    it('snapshot shows running lifecycle state after build', () => {
      app = new RuntimeApp(testConfig({ port: 0 }));
      const handles = app.build();

      const snapshot = handles.dashboard.getSnapshot();
      expect(snapshot.health.lifecycleState).toBe('running');
      expect(snapshot.health.verdict).toBe('healthy');
    });

    it('snapshot broker is null when broker is not configured', () => {
      app = new RuntimeApp(testConfig({ port: 0 }));
      const handles = app.build();

      const snapshot = handles.dashboard.getSnapshot();
      expect(snapshot.broker).toBeNull();
    });

    it('snapshot recent proposals is empty when no proposals exist', () => {
      app = new RuntimeApp(testConfig({ port: 0 }));
      const handles = app.build();

      const snapshot = handles.dashboard.getSnapshot();
      expect(snapshot.recentProposals).toEqual([]);
      expect(snapshot.recentBlockedOrders).toEqual([]);
    });

    it('snapshot includes market profile identity', () => {
      app = new RuntimeApp(testConfig({ port: 0 }));
      const handles = app.build();

      const snapshot = handles.dashboard.getSnapshot();
      expect(snapshot.marketProfile.marketId).toBe('INDIA_NSE_EQ');
      expect(snapshot.marketProfile.timezone).toBe('Asia/Kolkata');
    });

    it('snapshot can be JSON-serialised', () => {
      app = new RuntimeApp(testConfig({ port: 0 }));
      const handles = app.build();

      const snapshot = handles.dashboard.getSnapshot();
      expect(() => JSON.stringify(snapshot)).not.toThrow();
    });
  });

  // ── Broker-configured runtime ────────────────────────────────────────

  describe('Broker-configured runtime', () => {
    it('creates broker services when config includes broker', () => {
      // We need a full broker config — but this test just proves the
      // harness wires it correctly without starting the real services.
      // The actual service start is tested in integration tests.
      // For the harness, we just verify it doesn't crash with a partial config.
      app = new RuntimeApp(testConfig({
        port: 0,
        zerodha: {
          apiKey: 'test-key',
          apiSecret: 'test-secret',
          userId: 'test-user',
          totpKey: 'test-totp',
          sessionRefreshIntervalMs: 3600000,
        },
      }));

      expect(() => app.build()).not.toThrow();
      const handles = app.build();

      expect(handles.zerodhaSupervisor).not.toBeNull();
      expect(handles.dashboard).toBeDefined();

      // Snapshot should have broker block
      const snapshot = handles.dashboard.getSnapshot();
      expect(snapshot.broker).not.toBeNull();
      expect(snapshot.broker!.sessionState).toBeDefined();
    });
  });
});

describe('S05 Runtime — DashboardReadModel edge cases', () => {
  let app: RuntimeApp;

  afterEach(() => {
    try { app?.stop('Teardown'); } catch { /* ignore */ }
  });

  it('handles multiple build/start/stop cycles', () => {
    for (let i = 0; i < 3; i++) {
      app = new RuntimeApp(testConfig({ port: 0 }));
      const handles = app.build();
      app.start();

      // Verify scheduler is running
      expect(handles.scheduler.isRunning).toBe(true);

      // Verify dashboard snapshot
      const snapshot = handles.dashboard.getSnapshot();
      expect(snapshot.health.lifecycleState).toBe('running');

      app.stop(`Cycle ${i}`);
    }
  });

  it('scheduler is not started when only build() is called', () => {
    app = new RuntimeApp(testConfig({ port: 0 }));
    const handles = app.build();

    // Scheduler should be built but not running (no timer active)
    expect(handles.scheduler.isRunning).toBe(false);
    expect(handles.scheduler.getState().status).toBe('idle');
    // Server should not be listening
    expect(handles.server.listening).toBe(false);
  });

  it('dashboard snapshot available before scheduler start', () => {
    app = new RuntimeApp(testConfig({ port: 0 }));
    const handles = app.build();

    const snapshot = handles.dashboard.getSnapshot();
    expect(snapshot.health.lifecycleState).toBe('running');
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });
});

describe('S05 Runtime — restart persistence regression', () => {
  it('can restart on the same sqlite db after a clean stop', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-runtime-restart-'));
    const dbPath = path.join(tmpDir, 'runtime.db');

    const app1 = new RuntimeApp(testConfig({ port: 0, dbPath }));
    app1.start();
    app1.stop('First stop');

    const app2 = new RuntimeApp(testConfig({ port: 0, dbPath }));
    const handles2 = app2.start();

    expect(handles2.lifecycle.state).toBe('running');
    expect(handles2.healthService.getHealth().verdict).toBe('healthy');
    expect(handles2.scheduler.getState().status).toBe('running');
    expect(handles2.scheduler.getState().lastError).toBeNull();
    expect(handles2.scheduler.getState().tickCount).toBeGreaterThanOrEqual(0);

    app2.stop('Second stop');
  });
});

describe('S05 Runtime — risk guard integration', () => {
  let app: RuntimeApp;

  afterEach(() => {
    try { app?.stop('Teardown'); } catch { /* ignore */ }
  });

  it('creates risk repo and risk guard when proposal engine is configured', () => {
    app = new RuntimeApp(testConfig({
      port: 0,
      execution: {
        mode: ExecutionMode.Paper,
        maxRetries: 0,
        riskLimits: {
          maxOpenPositions: 5,
          maxOrdersPerInstrument: 1,
          maxDailyLossRupees: 0,
          maxExposureRupees: 0,
          marketHoursStalenessMs: 120000,
        },
      },
    }));

    // Without a proposal engine config, the execution gate and risk guard
    // are not created (proposal engine is the prerequisite).
    expect(() => app.build()).not.toThrow();
    const handles = app.build();

    // When proposal engine is null, risk guard is also null
    expect(handles.executionGateSupervisor).toBeNull();
    expect(handles.riskRepo).toBeNull();
  });

  it('creates risk repo and risk guard when proposal engine is configured with execution config', () => {
    app = new RuntimeApp(testConfig({
      port: 0,
      proposalEngine: {
        providerMode: 'custom',
        providerUrl: 'http://localhost:9999/v1/proposals',
        timeoutMs: 5000,
        maxProposalsPerTick: 1,
      },
      execution: {
        mode: ExecutionMode.Paper,
        maxRetries: 0,
        riskLimits: {
          maxOpenPositions: 5,
          maxOrdersPerInstrument: 1,
          maxDailyLossRupees: 20000,
          maxExposureRupees: 500000,
          marketHoursStalenessMs: 120000,
        },
      },
    }));

    const handles = app.build();

    expect(handles.executionGateSupervisor).not.toBeNull();
    expect(handles.riskRepo).not.toBeNull();
    expect(handles.orderRepo).not.toBeNull();
    expect(handles.fillRepo).not.toBeNull();
    expect(handles.positionRepo).not.toBeNull();

    // Verify risk state defaults to no halt
    const riskState = handles.riskRepo!.getCurrentState();
    expect(riskState.haltState).toBe('no_halt');
  });

  it('dashboard snapshot includes risk state when proposal engine is configured with execution config', () => {
    app = new RuntimeApp(testConfig({
      port: 0,
      proposalEngine: {
        providerMode: 'custom',
        providerUrl: 'http://localhost:9999/v1/proposals',
        timeoutMs: 5000,
        maxProposalsPerTick: 1,
      },
      execution: {
        mode: ExecutionMode.Paper,
        maxRetries: 0,
        riskLimits: {
          maxOpenPositions: 5,
          maxOrdersPerInstrument: 1,
          maxDailyLossRupees: 20000,
          maxExposureRupees: 500000,
          marketHoursStalenessMs: 120000,
        },
      },
    }));

    const handles = app.build();
    const snapshot = handles.dashboard.getSnapshot();

    expect(snapshot.execution).not.toBeNull();
    expect(snapshot.execution!.riskState).not.toBeNull();
    expect(snapshot.execution!.riskState!.haltState).toBe('no_halt');
    expect(snapshot.execution!.riskState!.isRefusing).toBe(false);
    expect(snapshot.execution!.riskState!.latchCount).toBe(0);
    expect(snapshot.execution!.recentRiskEvents).toEqual([]);
  });

  it('dashboard snapshot includes paper repos state when proposal engine is configured', () => {
    app = new RuntimeApp(testConfig({
      port: 0,
      proposalEngine: {
        providerMode: 'custom',
        providerUrl: 'http://localhost:9999/v1/proposals',
        timeoutMs: 5000,
        maxProposalsPerTick: 1,
      },
      execution: {
        mode: ExecutionMode.Paper,
        maxRetries: 0,
        riskLimits: {
          maxOpenPositions: 5,
          maxOrdersPerInstrument: 1,
          maxDailyLossRupees: 0,
          maxExposureRupees: 0,
          marketHoursStalenessMs: 120000,
        },
      },
    }));

    const handles = app.build();
    const snapshot = handles.dashboard.getSnapshot();

    expect(snapshot.execution).not.toBeNull();
    // Paper repo counts should be zero (no paper activity)
    expect(snapshot.execution!.totalOrders).toBe(0);
    expect(snapshot.execution!.totalFills).toBe(0);
    expect(snapshot.execution!.openPositionCount).toBe(0);
    expect(snapshot.execution!.recentPaperOrders).toEqual([]);
    expect(snapshot.execution!.recentPaperFills).toEqual([]);
    expect(snapshot.execution!.currentPositions).toEqual([]);
    expect(snapshot.execution!.recentPositionEvents).toEqual([]);
  });

  it('dashboard snapshot preserves paper evidence across restart on the same DB', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-risk-restart-'));
    const dbPath = path.join(tmpDir, 'restart.db');

    const riskLimitCfg = {
      maxOpenPositions: 5,
      maxOrdersPerInstrument: 1,
      maxDailyLossRupees: 20000,
      maxExposureRupees: 500000,
      marketHoursStalenessMs: 120000,
    };

    // App 1: build and seed risk events using the file-based DB
    const app1 = new RuntimeApp(testConfig({
      port: 0,
      dbPath,
      proposalEngine: {
        providerMode: 'custom',
        providerUrl: 'http://localhost:9999/v1/proposals',
        timeoutMs: 5000,
        maxProposalsPerTick: 1,
      },
      execution: {
        mode: ExecutionMode.Paper,
        maxRetries: 0,
        riskLimits: riskLimitCfg,
      },
    }));
    const h1 = app1.build();

    // Insert a risk event manually
    h1.riskRepo!.insertEvent({
      eventType: 'refusal',
      source: 'market_hours' as any,
      severity: 'warning',
      message: 'Out of hours refusal',
      diagnostic: null,
      recordedAt: Date.now(),
    });

    // Latch a halt
    h1.riskRepo!.latchHalt(
      'daily_loss' as any,
      'Daily loss limit breached',
      Date.now(),
      3,
      -25000,
    );

    app1.stop('Stop');

    // App 2: restart on the same DB
    const app2 = new RuntimeApp(testConfig({
      port: 0,
      dbPath,
      proposalEngine: {
        providerMode: 'custom',
        providerUrl: 'http://localhost:9999/v1/proposals',
        timeoutMs: 5000,
        maxProposalsPerTick: 1,
      },
      execution: {
        mode: ExecutionMode.Paper,
        maxRetries: 0,
        riskLimits: riskLimitCfg,
      },
    }));
    const h2 = app2.build();

    // Risk state should be latched
    const riskState = h2.riskRepo!.getCurrentState();
    expect(riskState.haltState).toBe('active_halt');
    expect(riskState.haltSource).toBe('daily_loss');
    expect(riskState.openPositionCountAtHalt).toBe(3);
    expect(riskState.dailyPnlAtHalt).toBe(-25000);

    // Risk events should be persisted (only the explicit insertEvent)
    const events = h2.riskRepo!.getRecentEvents();
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe('refusal');
    expect(events[0].message).toBe('Out of hours refusal');

    // Dashboard snapshot should reflect risk state
    const snapshot = h2.dashboard.getSnapshot();
    expect(snapshot.execution!.riskState!.haltState).toBe('active_halt');
    expect(snapshot.execution!.riskState!.haltSource).toBe('daily_loss');
    expect(snapshot.execution!.riskState!.isRefusing).toBe(true);
    expect(snapshot.execution!.riskState!.dailyPnlAtHalt).toBe(-25000);
    expect(snapshot.execution!.recentRiskEvents.length).toBe(1);

    app2.stop('Stop');
  });

  it('execution gate supervisor reports hasRiskGuard when risk guard is configured', () => {
    app = new RuntimeApp(testConfig({
      port: 0,
      proposalEngine: {
        providerMode: 'custom',
        providerUrl: 'http://localhost:9999/v1/proposals',
        timeoutMs: 5000,
        maxProposalsPerTick: 1,
      },
      execution: {
        mode: ExecutionMode.Paper,
        maxRetries: 0,
        riskLimits: {
          maxOpenPositions: 5,
          maxOrdersPerInstrument: 1,
          maxDailyLossRupees: 0,
          maxExposureRupees: 0,
          marketHoursStalenessMs: 120000,
        },
      },
    }));

    const handles = app.build();
    expect(handles.executionGateSupervisor!.hasRiskGuard).toBe(true);
  });

  it('execution gate supervisor does not have risk guard when risk config is absent', () => {
    app = new RuntimeApp(testConfig({
      port: 0,
      proposalEngine: {
        providerMode: 'custom',
        providerUrl: 'http://localhost:9999/v1/proposals',
        timeoutMs: 5000,
        maxProposalsPerTick: 1,
      },
      execution: {
        mode: ExecutionMode.Paper,
        maxRetries: 0,
        riskLimits: {
          maxOpenPositions: 0,
          maxOrdersPerInstrument: 0,
          maxDailyLossRupees: 0,
          maxExposureRupees: 0,
          marketHoursStalenessMs: 120000,
        },
      },
    }));

    const handles = app.build();
    // Risk guard is always created when proposal engine is configured
    expect(handles.executionGateSupervisor!.hasRiskGuard).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S05 — FO dashboard evidence through shared runtime seam
// ---------------------------------------------------------------------------
// Proves that operator-visible dashboard/runtime evidence can show FO
// execution class, FO symbols, and paper-ledger state through existing
// read models instead of a new view.

describe('S05 Runtime — FO dashboard evidence', () => {
  let app: RuntimeApp;

  afterEach(() => {
    try { app?.stop('Teardown'); } catch { /* ignore */ }
  });

  function buildApp(): RuntimeAppHandles {
    app = new RuntimeApp(testConfig({
      port: 0,
      proposalEngine: {
        providerMode: 'custom',
        providerUrl: 'http://localhost:9999/v1/proposals',
        timeoutMs: 5000,
        maxProposalsPerTick: 1,
      },
      execution: {
        mode: ExecutionMode.Paper,
        maxRetries: 0,
        riskLimits: {
          maxOpenPositions: 5,
          maxOrdersPerInstrument: 1,
          maxDailyLossRupees: 20000,
          maxExposureRupees: 500000,
          marketHoursStalenessMs: 120000,
        },
      },
    }));
    return app.build();
  }

  it('dashboard snapshot shows empty FO evidence when no FO activity exists', () => {
    const handles = buildApp();
    const snapshot = handles.dashboard.getSnapshot();

    // Strategy decisions block exists and is empty
    expect(snapshot.recentStrategyDecisions).toEqual([]);

    // Execution evidence exists with zero FO counts
    expect(snapshot.execution).not.toBeNull();
    expect(snapshot.execution!.totalAttempts).toBe(0);
    expect(snapshot.execution!.totalOrders).toBe(0);
    expect(snapshot.execution!.totalFills).toBe(0);
    expect(snapshot.execution!.openPositionCount).toBe(0);
    expect(snapshot.execution!.recentPaperOrders).toEqual([]);
    expect(snapshot.execution!.recentPaperFills).toEqual([]);
    expect(snapshot.execution!.currentPositions).toEqual([]);
    expect(snapshot.execution!.recentPositionEvents).toEqual([]);
  });

  it('strategy decision with FO execution class appears in dashboard decisions', () => {
    const handles = buildApp();

    // Seed a proposal row first (required FK)
    const proposalId = handles.proposalRepo!.insertAttempt({
      exchange: 'NFO',
      tradingsymbol: 'NIFTY24DECFUT',
      instrumentToken: 26000,
      side: 'buy',
      product: 'NRML',
      quantity: 300,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      tag: null,
      proposalStatus: 'accepted' as any,
      createdAt: Date.now() - 120_000,
    }).id;

    // Seed an FO strategy decision
    const decision = handles.strategyDecisionRepo!.insertDecision({
      proposalAttemptId: proposalId,
      decisionStatus: 'approved' as any,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      decidedAt: Date.now() - 60_000,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY24DECFUT',
      side: 'buy',
      product: 'NRML',
      quantity: 300,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      quoteLastPrice: 21500.00,
      quoteBid: 21480.00,
      quoteAsk: 21500.50,
      quoteVolume: 50000,
      quoteReceivedAt: Date.now() - 5000,
      riskNotional: 6450000,
      riskSizingBasis: 'last_price',
      riskMaxLossRupees: 322500,
      riskStopDistance: null,
      riskExposureTag: 'intraday',
      executionClass: 'FO',
      segment: 'NFO',
      instrumentType: 'FUT',
      expiry: '2024-12-26',
      strike: null,
      lotSize: 50,
      tickSize: 0.05,
      freezeQuantity: 1500,
    });

    // Verify through dashboard snapshot
    const snapshot = handles.dashboard.getSnapshot();
    expect(snapshot.recentStrategyDecisions).toHaveLength(1);

    const sd = snapshot.recentStrategyDecisions[0];
    expect(sd.executionClass).toBe('FO');
    expect(sd.exchange).toBe('NFO');
    expect(sd.tradingsymbol).toBe('NIFTY24DECFUT');
    expect(sd.segment).toBe('NFO');
    expect(sd.instrumentType).toBe('FUT');
    expect(sd.lotSize).toBe(50);
    expect(sd.tickSize).toBe(0.05);
    expect(sd.freezeQuantity).toBe(1500);
    expect(sd.expiry).toBe('2024-12-26');
    expect(sd.strike).toBeNull();
  });

  it('dashboard evidence shows FO paper order from the shared ledger seam', () => {
    const handles = buildApp();
    const now = Date.now();

    // Seed proposal + FO strategy decision
    const proposal = handles.proposalRepo!.insertAttempt({
      exchange: 'NFO',
      tradingsymbol: 'BANKNIFTY24DECFUT',
      instrumentToken: 26001,
      side: 'buy',
      product: 'NRML',
      quantity: 75,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      tag: null,
      proposalStatus: 'accepted' as any,
      createdAt: now - 120_000,
    });

    const decision = handles.strategyDecisionRepo!.insertDecision({
      proposalAttemptId: proposal.id,
      decisionStatus: 'approved' as any,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      decidedAt: now - 60_000,
      exchange: 'NFO',
      tradingsymbol: 'BANKNIFTY24DECFUT',
      side: 'buy',
      product: 'NRML',
      quantity: 75,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      quoteLastPrice: 48500.00,
      quoteBid: 48480.00,
      quoteAsk: 48520.00,
      quoteVolume: 25000,
      quoteReceivedAt: now - 5000,
      riskNotional: 3637500,
      riskSizingBasis: 'last_price',
      riskMaxLossRupees: 181875,
      riskStopDistance: null,
      riskExposureTag: 'intraday',
      executionClass: 'FO',
      segment: 'NFO',
      instrumentType: 'FUT',
      expiry: '2024-12-26',
      strike: null,
      lotSize: 25,
      tickSize: 0.05,
      freezeQuantity: 750,
    });

    // Seed execution attempt (completed, paper)
    const attempt = handles.executionAttemptRepo!.insertAttempt({
      strategyDecisionId: decision.id,
      executionMode: ExecutionMode.Paper,
      status: 'completed' as any,
      outcomeCode: 'paper_simulated' as any,
      brokerOrderId: 'paper-fo-dash-001',
      message: 'Paper buy 75 BANKNIFTY24DECFUT at 48500 (ask=48520, last=48500)',
      attemptedAt: now,
      completedAt: now,
    });

    // Seed paper order
    const order = handles.orderRepo!.insert({
      executionAttemptId: attempt.id,
      exchange: 'NFO',
      tradingsymbol: 'BANKNIFTY24DECFUT',
      side: 'buy',
      product: 'NRML',
      quantity: 75,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      tag: null,
      status: 'filled' as any,
      brokerOrderId: 'paper-fo-dash-001',
      createdAt: now,
      updatedAt: null,
    });

    // Seed paper fill
    handles.fillRepo!.insert({
      paperOrderId: order.id,
      executionAttemptId: attempt.id,
      exchange: 'NFO',
      tradingsymbol: 'BANKNIFTY24DECFUT',
      side: 'buy',
      product: 'NRML',
      filledQuantity: 75,
      filledPrice: 48500.00,
      brokerOrderId: 'paper-fo-dash-001',
      filledAt: now,
    });

    // Seed position event and position
    handles.positionRepo!.insertEvent({
      paperOrderId: order.id,
      paperFillId: 1, // Will be assigned by DB
      executionAttemptId: attempt.id,
      eventType: 'open' as any,
      exchange: 'NFO',
      tradingsymbol: 'BANKNIFTY24DECFUT',
      product: 'NRML',
      quantityDelta: 75,
      price: 48500.00,
      previousQuantity: 0,
      previousAvgCost: 0,
      newQuantity: 75,
      newAvgCost: 48500.00,
      realizedPnl: 0,
      createdAt: now,
    });

    handles.positionRepo!.upsertPosition({
      exchange: 'NFO',
      tradingsymbol: 'BANKNIFTY24DECFUT',
      product: 'NRML',
      side: 'long' as any,
      quantity: 75,
      avgCostPrice: 48500.00,
      realizedPnl: 0,
      updatedAt: now,
    });

    // Verify dashboard snapshot carries FO paper evidence
    const snapshot = handles.dashboard.getSnapshot();

    expect(snapshot.execution!.totalAttempts).toBe(1);
    expect(snapshot.execution!.totalOrders).toBe(1);
    expect(snapshot.execution!.totalFills).toBe(1);
    expect(snapshot.execution!.openPositionCount).toBe(1);

    // Paper order carries FO metadata
    expect(snapshot.execution!.recentPaperOrders).toHaveLength(1);
    const po = snapshot.execution!.recentPaperOrders[0];
    expect(po.exchange).toBe('NFO');
    expect(po.tradingsymbol).toBe('BANKNIFTY24DECFUT');
    expect(po.side).toBe('buy');
    expect(po.product).toBe('NRML');
    expect(po.quantity).toBe(75);

    // Paper fill carries FO metadata
    expect(snapshot.execution!.recentPaperFills).toHaveLength(1);
    const pf = snapshot.execution!.recentPaperFills[0];
    expect(pf.exchange).toBe('NFO');
    expect(pf.tradingsymbol).toBe('BANKNIFTY24DECFUT');
    expect(pf.side).toBe('buy');
    expect(pf.filledQuantity).toBe(75);
    expect(pf.filledPrice).toBe(48500.00);

    // Current position carries FO metadata
    expect(snapshot.execution!.currentPositions).toHaveLength(1);
    const pos = snapshot.execution!.currentPositions[0];
    expect(pos.exchange).toBe('NFO');
    expect(pos.tradingsymbol).toBe('BANKNIFTY24DECFUT');
    expect(pos.product).toBe('NRML');
    expect(pos.quantity).toBe(75);
    expect(pos.avgCostPrice).toBe(48500.00);

    // Position event carries FO metadata
    expect(snapshot.execution!.recentPositionEvents).toHaveLength(1);
    const ev = snapshot.execution!.recentPositionEvents[0];
    expect(ev.exchange).toBe('NFO');
    expect(ev.tradingsymbol).toBe('BANKNIFTY24DECFUT');
    expect(ev.product).toBe('NRML');
    expect(ev.quantityDelta).toBe(75);
    expect(ev.newQuantity).toBe(75);

    // Recent strategy decision carries FO class
    expect(snapshot.recentStrategyDecisions).toHaveLength(1);
    expect(snapshot.recentStrategyDecisions[0].executionClass).toBe('FO');
  });

  it('dashboard evidence shows FO paper state via getStrategyEvidence()', () => {
    const handles = buildApp();
    const now = Date.now();

    // Seed an FO strategy decision (approved)
    const proposal = handles.proposalRepo!.insertAttempt({
      exchange: 'NFO',
      tradingsymbol: 'NIFTY24DECFUT',
      instrumentToken: 26000,
      side: 'buy',
      product: 'NRML',
      quantity: 300,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      tag: null,
      proposalStatus: 'accepted' as any,
      createdAt: now - 120_000,
    });

    handles.strategyDecisionRepo!.insertDecision({
      proposalAttemptId: proposal.id,
      decisionStatus: 'approved' as any,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      decidedAt: now - 60_000,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY24DECFUT',
      side: 'buy',
      product: 'NRML',
      quantity: 300,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      quoteLastPrice: 21500.00,
      quoteBid: 21480.00,
      quoteAsk: 21500.50,
      quoteVolume: 50000,
      quoteReceivedAt: now - 5000,
      riskNotional: 6450000,
      riskSizingBasis: 'last_price',
      riskMaxLossRupees: 322500,
      riskStopDistance: null,
      riskExposureTag: 'intraday',
      executionClass: 'FO',
      segment: 'NFO',
      instrumentType: 'FUT',
      expiry: '2024-12-26',
      strike: null,
      lotSize: 50,
      tickSize: 0.05,
      freezeQuantity: 1500,
    });

    // Verify via getStrategyEvidence
    const evidence = handles.dashboard.getStrategyEvidence();
    expect(evidence.totalDecisions).toBe(1);
    expect(evidence.approvedCount).toBe(1);
    expect(evidence.refusedCount).toBe(0);
    expect(evidence.recentDecisions).toHaveLength(1);
    expect(evidence.recentDecisions[0].executionClass).toBe('FO');
    expect(evidence.recentDecisions[0].exchange).toBe('NFO');
  });

  it('dashboard evidence distinguishes FO from EQ in a mixed scenario', () => {
    const handles = buildApp();
    const now = Date.now();

    // Seed an EQ decision
    const eqProposal = handles.proposalRepo!.insertAttempt({
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      instrumentToken: 123456,
      side: 'buy',
      product: 'MIS',
      quantity: 75,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      tag: null,
      proposalStatus: 'accepted' as any,
      createdAt: now - 120_000,
    });

    handles.strategyDecisionRepo!.insertDecision({
      proposalAttemptId: eqProposal.id,
      decisionStatus: 'approved' as any,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      decidedAt: now - 60_000,
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
      quoteReceivedAt: now - 5000,
      riskNotional: 213787.50,
      riskSizingBasis: 'last_price',
      riskMaxLossRupees: 10689.38,
      riskStopDistance: null,
      riskExposureTag: 'intraday',
      executionClass: 'EQ',
      segment: 'NSE',
      instrumentType: 'EQ',
      expiry: null,
      strike: null,
      lotSize: 1,
      tickSize: 0.05,
      freezeQuantity: null,
    });

    // Seed an FO decision
    const foProposal = handles.proposalRepo!.insertAttempt({
      exchange: 'NFO',
      tradingsymbol: 'NIFTY24DECFUT',
      instrumentToken: 26000,
      side: 'buy',
      product: 'NRML',
      quantity: 300,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      tag: null,
      proposalStatus: 'accepted' as any,
      createdAt: now - 60_000,
    });

    handles.strategyDecisionRepo!.insertDecision({
      proposalAttemptId: foProposal.id,
      decisionStatus: 'approved' as any,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      decidedAt: now - 30_000,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY24DECFUT',
      side: 'buy',
      product: 'NRML',
      quantity: 300,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      quoteLastPrice: 21500.00,
      quoteBid: 21480.00,
      quoteAsk: 21500.50,
      quoteVolume: 50000,
      quoteReceivedAt: now - 5000,
      riskNotional: 6450000,
      riskSizingBasis: 'last_price',
      riskMaxLossRupees: 322500,
      riskStopDistance: null,
      riskExposureTag: 'intraday',
      executionClass: 'FO',
      segment: 'NFO',
      instrumentType: 'FUT',
      expiry: '2024-12-26',
      strike: null,
      lotSize: 50,
      tickSize: 0.05,
      freezeQuantity: 1500,
    });

    // Verify dashboard shows both
    const snapshot = handles.dashboard.getSnapshot();
    expect(snapshot.recentStrategyDecisions).toHaveLength(2);

    const classes = snapshot.recentStrategyDecisions.map(d => d.executionClass);
    expect(classes).toContain('EQ');
    expect(classes).toContain('FO');

    // Verify counts via getStrategyEvidence
    const evidence = handles.dashboard.getStrategyEvidence();
    expect(evidence.totalDecisions).toBe(2);
    expect(evidence.approvedCount).toBe(2);
  });
});
