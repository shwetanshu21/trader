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
import type { RuntimeConfig } from '../src/types/runtime.js';

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
