import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { RuntimeStateRepository } from '../src/persistence/runtime-state-repo.js';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import {
  LifecycleState,
  SchedulerStatus,
  MarketPhase,
  HealthVerdict,
  type SchedulerState,
  type HealthStatus,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an in-memory repo with fresh schema. */
function createRepo(): RuntimeStateRepository {
  const mgr = new DatabaseManager(':memory:');
  return new RuntimeStateRepository(mgr.db);
}

// ---------------------------------------------------------------------------
// RuntimeStateRepository
// ---------------------------------------------------------------------------

describe('RuntimeStateRepository', () => {
  describe('lifecycle events', () => {
    it('inserts and retrieves a lifecycle event', () => {
      const repo = createRepo();
      const event = repo.insertLifecycleEvent({
        state: LifecycleState.Booting,
        reason: 'Process started',
      });

      expect(event.state).toBe(LifecycleState.Booting);
      expect(event.reason).toBe('Process started');
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('accepts explicit timestamp', () => {
      const repo = createRepo();
      const event = repo.insertLifecycleEvent({
        timestamp: 1000,
        state: LifecycleState.Running,
        reason: 'Manual',
      });
      expect(event.timestamp).toBe(1000);
    });

    it('stores and retrieves diagnostic data', () => {
      const repo = createRepo();
      repo.insertLifecycleEvent({
        state: LifecycleState.Degraded,
        reason: 'API timeout',
        diagnostic: { retryCount: 3, endpoint: '/api/price' },
      });

      const events = repo.getLifecycleEvents();
      expect(events.length).toBe(1);
      expect(events[0].diagnostic).toEqual({ retryCount: 3, endpoint: '/api/price' });
    });

    it('getLatestLifecycleState returns null when empty', () => {
      const repo = createRepo();
      expect(repo.getLatestLifecycleState()).toBeNull();
    });

    it('getLatestLifecycleState returns the most recent state', () => {
      const repo = createRepo();
      repo.insertLifecycleEvent({ state: LifecycleState.Booting, reason: 'boot' });
      repo.insertLifecycleEvent({ state: LifecycleState.Running, reason: 'start' });

      expect(repo.getLatestLifecycleState()).toBe(LifecycleState.Running);
    });

    it('getLifecycleEvents returns newest first', () => {
      const repo = createRepo();
      repo.insertLifecycleEvent({ timestamp: 100, state: LifecycleState.Booting, reason: 'boot' });
      repo.insertLifecycleEvent({ timestamp: 200, state: LifecycleState.Running, reason: 'start' });

      const events = repo.getLifecycleEvents();
      expect(events.length).toBe(2);
      expect(events[0].state).toBe(LifecycleState.Running);
      expect(events[1].state).toBe(LifecycleState.Booting);
    });

    it('getLifecycleEvents respects limit', () => {
      const repo = createRepo();
      for (let i = 0; i < 10; i++) {
        repo.insertLifecycleEvent({ state: LifecycleState.Running, reason: `tick ${i}` });
      }
      expect(repo.getLifecycleEvents(3).length).toBe(3);
    });

    it('getLatestLifecycleEvent returns null when empty', () => {
      const repo = createRepo();
      expect(repo.getLatestLifecycleEvent()).toBeNull();
    });

    it('getLatestLifecycleEvent returns the most recent event', () => {
      const repo = createRepo();
      repo.insertLifecycleEvent({ state: LifecycleState.Booting, reason: 'boot' });
      const second = repo.insertLifecycleEvent({ state: LifecycleState.Running, reason: 'start' });

      const latest = repo.getLatestLifecycleEvent();
      expect(latest).not.toBeNull();
      expect(latest!.state).toBe(LifecycleState.Running);
    });
  });

  describe('scheduler state (singleton upsert)', () => {
    it('returns default idle state when no row exists', () => {
      const repo = createRepo();
      const state = repo.getSchedulerState();

      expect(state.status).toBe(SchedulerStatus.Idle);
      expect(state.marketPhase).toBe(MarketPhase.Closed);
      expect(state.tickCount).toBe(0);
      expect(state.lastTickTimestamp).toBeNull();
      expect(state.startedAt).toBeNull();
      expect(state.lastError).toBeNull();
    });

    it('persists and retrieves scheduler state', () => {
      const repo = createRepo();
      const state: SchedulerState = {
        status: SchedulerStatus.Running,
        marketPhase: MarketPhase.Regular,
        lastTickTimestamp: 5000,
        startedAt: 1000,
        tickCount: 42,
        lastError: null,
      };

      repo.upsertSchedulerState(state);
      const loaded = repo.getSchedulerState();

      expect(loaded.status).toBe(SchedulerStatus.Running);
      expect(loaded.marketPhase).toBe(MarketPhase.Regular);
      expect(loaded.lastTickTimestamp).toBe(5000);
      expect(loaded.startedAt).toBe(1000);
      expect(loaded.tickCount).toBe(42);
      expect(loaded.lastError).toBeNull();
    });

    it('upsert replaces previous state', () => {
      const repo = createRepo();

      repo.upsertSchedulerState({
        status: SchedulerStatus.Idle,
        marketPhase: MarketPhase.Closed,
        lastTickTimestamp: null,
        startedAt: null,
        tickCount: 0,
        lastError: null,
      });

      repo.upsertSchedulerState({
        status: SchedulerStatus.Running,
        marketPhase: MarketPhase.Regular,
        lastTickTimestamp: 100,
        startedAt: 50,
        tickCount: 5,
        lastError: null,
      });

      const loaded = repo.getSchedulerState();
      expect(loaded.status).toBe(SchedulerStatus.Running);
      expect(loaded.tickCount).toBe(5);
    });
  });

  describe('health checks', () => {
    it('returns null when no health checks exist', () => {
      const repo = createRepo();
      expect(repo.getLatestHealthCheck()).toBeNull();
    });

    it('persists and retrieves health checks', () => {
      const repo = createRepo();
      const status: HealthStatus = {
        verdict: HealthVerdict.Healthy,
        uptimeMs: 10000,
        lifecycleState: LifecycleState.Running,
        scheduler: {
          status: SchedulerStatus.Running,
          marketPhase: MarketPhase.Regular,
          lastTickTimestamp: 5000,
          startedAt: 1000,
          tickCount: 5,
          lastError: null,
        },
        degradedReasons: [],
        checkedAt: '2025-01-01T00:00:00.000Z',
      };

      repo.insertHealthCheck(status);
      const loaded = repo.getLatestHealthCheck();

      expect(loaded).not.toBeNull();
      expect(loaded!.verdict).toBe(HealthVerdict.Healthy);
      expect(loaded!.uptimeMs).toBe(10000);
      expect(loaded!.lifecycleState).toBe(LifecycleState.Running);
      expect(loaded!.degradedReasons).toEqual([]);
    });

    it('stores degraded reasons as JSON', () => {
      const repo = createRepo();
      const status: HealthStatus = {
        verdict: HealthVerdict.Degraded,
        uptimeMs: 5000,
        lifecycleState: LifecycleState.Degraded,
        scheduler: {
          status: SchedulerStatus.Running,
          marketPhase: MarketPhase.Regular,
          lastTickTimestamp: 3000,
          startedAt: 0,
          tickCount: 3,
          lastError: null,
        },
        degradedReasons: ['API timeout', 'Scheduler paused'],
        checkedAt: '2025-01-01T00:00:00.000Z',
      };

      repo.insertHealthCheck(status);
      const loaded = repo.getLatestHealthCheck();
      expect(loaded!.degradedReasons).toEqual(['API timeout', 'Scheduler paused']);
    });

    it('only returns the most recent health check', () => {
      const repo = createRepo();
      const base = {
        scheduler: {
          status: SchedulerStatus.Running,
          marketPhase: MarketPhase.Regular,
          lastTickTimestamp: 1000,
          startedAt: 0,
          tickCount: 1,
          lastError: null,
        },
        checkedAt: '2025-01-01T00:00:00.000Z',
      };

      repo.insertHealthCheck({
        ...base,
        verdict: HealthVerdict.Healthy,
        uptimeMs: 1000,
        lifecycleState: LifecycleState.Running,
        degradedReasons: [],
      });

      repo.insertHealthCheck({
        ...base,
        verdict: HealthVerdict.Unhealthy,
        uptimeMs: 2000,
        lifecycleState: LifecycleState.Stopped,
        degradedReasons: ['Fatal error'],
      });

      const loaded = repo.getLatestHealthCheck();
      expect(loaded!.verdict).toBe(HealthVerdict.Unhealthy);
    });
  });
});
