import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { RuntimeStateRepository } from '../src/persistence/runtime-state-repo.js';
import { LifecycleManager } from '../src/runtime/lifecycle.js';
import { HealthService } from '../src/runtime/health-service.js';
import {
  LifecycleState,
  SchedulerStatus,
  MarketPhase,
  HealthVerdict,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createFixtures() {
  const mgr = new DatabaseManager(':memory:');
  const repo = new RuntimeStateRepository(mgr.db);
  const lifecycle = new LifecycleManager(repo);
  const health = new HealthService(lifecycle, repo, Date.now());
  return { mgr, repo, lifecycle, health };
}

// ---------------------------------------------------------------------------
// HealthService
// ---------------------------------------------------------------------------

describe('HealthService', () => {
  describe('getHealth()', () => {
    it('returns healthy when lifecycle is booting and no scheduler state set', () => {
      const { health, lifecycle } = createFixtures();

      // Default state is Booting (no previous events persisted)
      expect(lifecycle.state).toBe(LifecycleState.Booting);

      const status = health.getHealth();
      expect(status.lifecycleState).toBe(LifecycleState.Booting);
      // Booting is still considered healthy — no degradation yet
      expect(status.verdict).toBe(HealthVerdict.Healthy);
      expect(status.degradedReasons).toEqual([]);
      expect(status.uptimeMs).toBeGreaterThan(0);
      expect(status.scheduler).toBeDefined();
      expect(status.scheduler.status).toBe(SchedulerStatus.Idle);
    });

    it('returns healthy after lifecycle transitions to Running', () => {
      const { health, lifecycle } = createFixtures();
      lifecycle.start();

      const status = health.getHealth();
      expect(status.verdict).toBe(HealthVerdict.Healthy);
      expect(status.lifecycleState).toBe(LifecycleState.Running);
    });

    it('returns degraded when lifecycle is Degraded', () => {
      const { health, lifecycle } = createFixtures();
      lifecycle.start();
      lifecycle.degrade('Price feed timeout');

      const status = health.getHealth();
      expect(status.verdict).toBe(HealthVerdict.Degraded);
      expect(status.lifecycleState).toBe(LifecycleState.Degraded);
      expect(status.degradedReasons).toContain('Price feed timeout');
    });

    it('returns degraded when scheduler is paused', () => {
      const { health, lifecycle, repo } = createFixtures();
      lifecycle.start();
      repo.upsertSchedulerState({
        status: SchedulerStatus.Paused,
        marketPhase: MarketPhase.Regular,
        lastTickTimestamp: 5000,
        startedAt: 1000,
        tickCount: 5,
        lastError: null,
      });

      const status = health.getHealth();
      expect(status.verdict).toBe(HealthVerdict.Degraded);
      expect(status.degradedReasons).toContain('Scheduler is paused');
    });

    it('returns degraded when scheduler has an error', () => {
      const { health, lifecycle, repo } = createFixtures();
      lifecycle.start();
      repo.upsertSchedulerState({
        status: SchedulerStatus.Running,
        marketPhase: MarketPhase.Regular,
        lastTickTimestamp: 5000,
        startedAt: 1000,
        tickCount: 3,
        lastError: 'Connection reset by peer',
      });

      const status = health.getHealth();
      expect(status.verdict).toBe(HealthVerdict.Degraded);
      expect(status.degradedReasons).toContain('Last scheduler error: Connection reset by peer');
    });

    it('returns unhealthy when lifecycle is Stopped', () => {
      const { health, lifecycle } = createFixtures();
      lifecycle.start();
      lifecycle.stop('Shutdown requested');

      const status = health.getHealth();
      expect(status.verdict).toBe(HealthVerdict.Unhealthy);
      expect(status.lifecycleState).toBe(LifecycleState.Stopped);
    });

    it('accumulates multiple degradation reasons', () => {
      const { health, lifecycle, repo } = createFixtures();
      lifecycle.start();
      lifecycle.degrade('Price feed timeout');
      repo.upsertSchedulerState({
        status: SchedulerStatus.Paused,
        marketPhase: MarketPhase.Regular,
        lastTickTimestamp: 5000,
        startedAt: 1000,
        tickCount: 3,
        lastError: 'Rate limit exceeded',
      });

      const status = health.getHealth();
      expect(status.degradedReasons.length).toBeGreaterThanOrEqual(3);
      expect(status.degradedReasons).toContain('Price feed timeout');
      expect(status.degradedReasons).toContain('Scheduler is paused');
      expect(status.degradedReasons).toContain('Last scheduler error: Rate limit exceeded');
    });

    it('uptimeMs increases over time', async () => {
      const { health, lifecycle } = createFixtures();
      lifecycle.start();

      const first = health.getHealth();
      await new Promise(r => setTimeout(r, 10));

      const second = health.getHealth();
      expect(second.uptimeMs).toBeGreaterThan(first.uptimeMs);
    });
  });

  describe('recordHealthCheck()', () => {
    it('persists the health status', () => {
      const { health, lifecycle, repo } = createFixtures();
      lifecycle.start();

      health.recordHealthCheck();
      const saved = repo.getLatestHealthCheck();

      expect(saved).not.toBeNull();
      expect(saved!.verdict).toBe(HealthVerdict.Healthy);
      expect(saved!.lifecycleState).toBe(LifecycleState.Running);
    });

    it('returns the persisted status', () => {
      const { health, lifecycle } = createFixtures();
      lifecycle.start();

      const result = health.recordHealthCheck();
      expect(result.verdict).toBe(HealthVerdict.Healthy);
      expect(typeof result.checkedAt).toBe('string');
    });
  });
});
