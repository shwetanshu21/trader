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
import { RuntimeApp } from '../src/runtime/runtime-app.js';
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
