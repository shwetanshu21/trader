// ── Scheduler Integration Tests ──
// Tests the supervised scheduler loop with in-memory SQLite.
// Uses controlled time via the MarketClock's profile (real India profile,
// but we control the Date argument to getPhase for deterministic tests).
// The scheduler runs with a shortened interval for fast test execution.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { RuntimeStateRepository } from '../src/persistence/runtime-state-repo.js';
import { LifecycleManager } from '../src/runtime/lifecycle.js';
import { HealthService } from '../src/runtime/health-service.js';
import { MarketClock } from '../src/runtime/market-clock.js';
import { Scheduler } from '../src/runtime/scheduler.js';
import { Telemetry } from '../src/runtime/telemetry.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';
import {
  LifecycleState,
  SchedulerStatus,
  MarketPhase,
  HealthVerdict,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  dbManager: DatabaseManager;
  repo: RuntimeStateRepository;
  lifecycle: LifecycleManager;
  health: HealthService;
  clock: MarketClock;
  telemetry: Telemetry;
  scheduler: Scheduler;
}

function createFixtures(intervalMs: number = 50): Fixtures {
  const dbManager = new DatabaseManager(':memory:');
  const repo = new RuntimeStateRepository(dbManager.db);
  const lifecycle = new LifecycleManager(repo);
  const health = new HealthService(lifecycle, repo, Date.now());
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const telemetry = new Telemetry(repo);

  const scheduler = new Scheduler({
    clock,
    lifecycle,
    repo,
    health,
    telemetry,
    intervalMs,
  });

  return { dbManager, repo, lifecycle, health, clock, telemetry, scheduler };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

describe('Scheduler', () => {
  describe('initial state', () => {
    it('starts in Idle status with Closed phase', () => {
      const { scheduler } = createFixtures();
      const state = scheduler.getState();

      expect(state.status).toBe(SchedulerStatus.Idle);
      expect(state.tickCount).toBe(0);
      expect(state.startedAt).toBeNull();
      expect(state.lastTickTimestamp).toBeNull();
      expect(state.lastError).toBeNull();
      expect(state.marketPhase).toBe(MarketPhase.Closed);
    });

    it('recovers persisted state from DB', () => {
      const { repo, scheduler: s1 } = createFixtures();

      // Persist a running state
      repo.upsertSchedulerState({
        status: SchedulerStatus.Running,
        marketPhase: MarketPhase.Regular,
        lastTickTimestamp: 5000,
        startedAt: 1000,
        tickCount: 10,
        lastError: null,
      });

      // Create a second scheduler with the same repo
      const db2 = new DatabaseManager(':memory:');
      // Need to copy schema: same approach, use the same DB
      // Actually, let's use the same repo from above
      const s2 = new Scheduler({
        clock: new MarketClock(INDIA_NSE_EQ_MARKET),
        lifecycle: new LifecycleManager(repo),
        repo,
        health: new HealthService(new LifecycleManager(repo), repo, Date.now()),
        telemetry: new Telemetry(repo),
        intervalMs: 60000,
      });

      const state = s2.getState();
      expect(state.status).toBe(SchedulerStatus.Running);
      expect(state.marketPhase).toBe(MarketPhase.Regular);
      expect(state.tickCount).toBe(10);
      expect(state.startedAt).toBe(1000);
      expect(state.lastTickTimestamp).toBe(5000);
    });
  });

  describe('start()', () => {
    it('transitions lifecycle to Running and starts ticking', async () => {
      const { scheduler, lifecycle } = createFixtures(20);

      const state = scheduler.start();

      expect(state.status).toBe(SchedulerStatus.Running);
      expect(scheduler.isRunning).toBe(true);

      // Lifecycle should now be Running
      expect(lifecycle.state).toBe(LifecycleState.Running);

      // Wait a few ticks
      await new Promise(r => setTimeout(r, 100));

      const currentState = scheduler.getState();
      expect(currentState.tickCount).toBeGreaterThanOrEqual(2);
      expect(currentState.lastTickTimestamp).not.toBeNull();

      scheduler.stop('test done');
    });

    it('throws if lifecycle is Stopped', () => {
      const { scheduler, lifecycle } = createFixtures();
      lifecycle.start();
      lifecycle.stop('test');

      expect(() => scheduler.start()).toThrow('Cannot start scheduler');
    });

    it('is idempotent — second start does not reset state', () => {
      const { scheduler } = createFixtures(50);

      scheduler.start();
      const state1 = scheduler.getState();
      scheduler.start(); // second call
      const state2 = scheduler.getState();

      // Same state (no reset)
      expect(state2.status).toBe(state1.status);
      expect(state2.tickCount).toBe(state1.tickCount);

      scheduler.stop('test done');
    });

    it('persists state to DB', () => {
      const { scheduler, repo } = createFixtures();
      scheduler.start();

      const persisted = repo.getSchedulerState();
      expect(persisted.status).toBe(SchedulerStatus.Running);
      expect(persisted.startedAt).not.toBeNull();

      scheduler.stop('test done');
    });
  });

  describe('stop()', () => {
    it('stops the loop, sets Stopped status, persists', async () => {
      const { scheduler, lifecycle } = createFixtures(20);

      scheduler.start();
      await new Promise(r => setTimeout(r, 60));

      const finalState = scheduler.stop('graceful shutdown');

      expect(finalState.status).toBe(SchedulerStatus.Stopped);
      expect(scheduler.isRunning).toBe(false);
      expect(lifecycle.state).toBe(LifecycleState.Stopped);

      // Verify DB persistence
      const repo = scheduler['_repo'] as RuntimeStateRepository;
      const persisted = repo.getSchedulerState();
      expect(persisted.status).toBe(SchedulerStatus.Stopped);
    });

    it('works when not started (no-op style)', () => {
      const { scheduler } = createFixtures();
      const state = scheduler.stop('wasnt running');
      // Should set status to Stopped even if not running
      expect(state.status).toBe(SchedulerStatus.Stopped);
    });

    it('tick count stops incrementing after stop', async () => {
      const { scheduler } = createFixtures(20);

      scheduler.start();
      await new Promise(r => setTimeout(r, 60));

      const tickCountBefore = scheduler.getState().tickCount;
      scheduler.stop('done');

      await new Promise(r => setTimeout(r, 60));
      const tickCountAfter = scheduler.getState().tickCount;

      expect(tickCountAfter).toBe(tickCountBefore);
    });
  });

  describe('pause() and resume()', () => {
    it('pause stops the loop and sets Paused status', () => {
      const { scheduler, lifecycle } = createFixtures(50);

      scheduler.start();
      const pausedState = scheduler.pause();

      expect(pausedState.status).toBe(SchedulerStatus.Paused);
      expect(scheduler.isRunning).toBe(false);

      // Lifecycle should still be Running (not Degraded)
      expect(lifecycle.state).toBe(LifecycleState.Running);

      scheduler.stop('test done');
    });

    it('resume restarts the loop from paused state', async () => {
      const { scheduler } = createFixtures(20);

      scheduler.start();
      await new Promise(r => setTimeout(r, 50));
      const tickCountBeforePause = scheduler.getState().tickCount;

      scheduler.pause();
      const resumedState = scheduler.resume();

      expect(resumedState.status).toBe(SchedulerStatus.Running);
      expect(scheduler.isRunning).toBe(true);

      // Give it a moment to tick again
      await new Promise(r => setTimeout(r, 60));

      expect(scheduler.getState().tickCount).toBeGreaterThan(tickCountBeforePause);

      scheduler.stop('test done');
    });

    it('pause on Idle state gives warning but does not crash', () => {
      const { scheduler } = createFixtures();
      const state = scheduler.pause();
      expect(state.status).toBe(SchedulerStatus.Idle);
    });
  });

  describe('getState()', () => {
    it('returns a SchedulerState compatible with the type', () => {
      const { scheduler } = createFixtures();
      const state = scheduler.getState();

      expect(state).toHaveProperty('status');
      expect(state).toHaveProperty('marketPhase');
      expect(state).toHaveProperty('lastTickTimestamp');
      expect(state).toHaveProperty('startedAt');
      expect(state).toHaveProperty('tickCount');
      expect(state).toHaveProperty('lastError');

      // Verify it's a valid SchedulerState
      expect([SchedulerStatus.Idle, SchedulerStatus.Running, SchedulerStatus.Paused, SchedulerStatus.Stopped])
        .toContain(state.status);
      expect([MarketPhase.PreMarket, MarketPhase.Regular, MarketPhase.PostMarket, MarketPhase.Closed])
        .toContain(state.marketPhase);
    });

    it('reflects the latest tick count after running', async () => {
      const { scheduler } = createFixtures(20);

      scheduler.start();
      await new Promise(r => setTimeout(r, 80));

      const state = scheduler.getState();
      expect(state.tickCount).toBeGreaterThanOrEqual(1);
      expect(state.lastTickTimestamp).not.toBeNull();

      scheduler.stop('test done');
    });
  });

  describe('getClock()', () => {
    it('returns the MarketClock instance', () => {
      const { scheduler, clock } = createFixtures();
      expect(scheduler.getClock()).toBe(clock);
    });
  });

  describe('tick behavior', () => {
    it('does not crash when tick encounters no errors', async () => {
      const { scheduler } = createFixtures(20);

      scheduler.start();
      await new Promise(r => setTimeout(r, 100));

      const state = scheduler.getState();
      expect(state.lastError).toBeNull();

      scheduler.stop('test done');
    });

    it('records health checks on each tick', async () => {
      const { scheduler, repo } = createFixtures(20);

      scheduler.start();
      await new Promise(r => setTimeout(r, 100));

      const latestHealth = repo.getLatestHealthCheck();
      expect(latestHealth).not.toBeNull();
      expect(latestHealth!.verdict).toBe(HealthVerdict.Healthy);
      expect(latestHealth!.scheduler.tickCount).toBeGreaterThanOrEqual(1);

      scheduler.stop('test done');
    });

    it('persists scheduler state on each tick', async () => {
      const { scheduler, repo } = createFixtures(20);

      scheduler.start();
      await new Promise(r => setTimeout(r, 80));

      const persisted = repo.getSchedulerState();
      expect(persisted.tickCount).toBeGreaterThanOrEqual(2);
      expect(persisted.lastTickTimestamp).not.toBeNull();
      expect(persisted.startedAt).not.toBeNull();

      scheduler.stop('test done');
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: scheduler + lifecycle + health surface
// ---------------------------------------------------------------------------

describe('Scheduler end-to-end integration', () => {
  it('full lifecycle: boot → start scheduler → tick → stop → unhealthy health', async () => {
    const { scheduler, lifecycle, health, repo } = createFixtures(30);

    // Initial: Booting
    expect(lifecycle.state).toBe(LifecycleState.Booting);

    // Start scheduler (transitions lifecycle to Running)
    scheduler.start();
    expect(lifecycle.state).toBe(LifecycleState.Running);

    // Let it tick a few times
    await new Promise(r => setTimeout(r, 100));

    // Health should be Healthy
    const midHealth = health.getHealth();
    expect(midHealth.verdict).toBe(HealthVerdict.Healthy);
    expect(midHealth.scheduler.tickCount).toBeGreaterThanOrEqual(1);

    // Stop the scheduler
    const finalState = scheduler.stop('e2e test stop');
    expect(finalState.status).toBe(SchedulerStatus.Stopped);
    expect(lifecycle.state).toBe(LifecycleState.Stopped);

    // Health should now be Unhealthy
    const finalHealth = health.getHealth();
    expect(finalHealth.verdict).toBe(HealthVerdict.Unhealthy);
    expect(finalHealth.lifecycleState).toBe(LifecycleState.Stopped);
  });

  it('pause/resume does not transition lifecycle', async () => {
    const { scheduler, lifecycle } = createFixtures(30);

    scheduler.start();
    expect(lifecycle.state).toBe(LifecycleState.Running);

    scheduler.pause();
    expect(lifecycle.state).toBe(LifecycleState.Running);

    scheduler.resume();
    expect(lifecycle.state).toBe(LifecycleState.Running);

    scheduler.stop('test done');
  });
});
