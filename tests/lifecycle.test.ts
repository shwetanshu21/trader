import { describe, it, expect } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { RuntimeStateRepository } from '../src/persistence/runtime-state-repo.js';
import { LifecycleManager } from '../src/runtime/lifecycle.js';
import { LifecycleState } from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createRepo(): RuntimeStateRepository {
  const mgr = new DatabaseManager(':memory:');
  return new RuntimeStateRepository(mgr.db);
}

// ---------------------------------------------------------------------------
// LifecycleManager
// ---------------------------------------------------------------------------

describe('LifecycleManager', () => {
  describe('initial state', () => {
    it('defaults to Booting when no persisted state exists', () => {
      const repo = createRepo();
      const lm = new LifecycleManager(repo);
      expect(lm.state).toBe(LifecycleState.Booting);
    });

    it('recovers persisted state from DB', () => {
      const repo = createRepo();
      repo.insertLifecycleEvent({ state: LifecycleState.Running, reason: 'resume' });

      const lm = new LifecycleManager(repo);
      expect(lm.state).toBe(LifecycleState.Running);
    });

    it('treats a persisted stopped state as a fresh boot', () => {
      const repo = createRepo();
      repo.insertLifecycleEvent({ state: LifecycleState.Stopped, reason: 'previous shutdown' });

      const lm = new LifecycleManager(repo);
      expect(lm.state).toBe(LifecycleState.Booting);
      expect(lm.latestEvent?.state).toBe(LifecycleState.Stopped);
    });
  });

  describe('transitions', () => {
    it('boot -> start -> Running', () => {
      const repo = createRepo();
      const lm = new LifecycleManager(repo);

      const event = lm.start('System ready');
      expect(lm.state).toBe(LifecycleState.Running);
      expect(event.state).toBe(LifecycleState.Running);
      expect(event.reason).toBe('System ready');
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('Running -> degrade -> Degraded', () => {
      const repo = createRepo();
      const lm = new LifecycleManager(repo);
      lm.start();

      const event = lm.degrade('Broker connection lost');
      expect(lm.state).toBe(LifecycleState.Degraded);
      expect(event.state).toBe(LifecycleState.Degraded);
    });

    it('Degraded -> start -> Running (recovery)', () => {
      const repo = createRepo();
      const lm = new LifecycleManager(repo);
      lm.start();
      lm.degrade('Transient error');

      const event = lm.start('Connection restored');
      expect(lm.state).toBe(LifecycleState.Running);
      expect(event.state).toBe(LifecycleState.Running);
    });

    it('Running -> stop -> Stopped', () => {
      const repo = createRepo();
      const lm = new LifecycleManager(repo);
      lm.start();

      const event = lm.stop('SIGTERM received');
      expect(lm.state).toBe(LifecycleState.Stopped);
      expect(event.state).toBe(LifecycleState.Stopped);
    });

    it('Stopped is terminal — no further transitions', () => {
      const repo = createRepo();
      const lm = new LifecycleManager(repo);
      lm.start();
      lm.stop('Done');

      expect(() => lm.start()).toThrow('Invalid lifecycle transition');
      expect(() => lm.degrade('nope')).toThrow('Invalid lifecycle transition');
      expect(() => lm.stop('again')).toThrow('Invalid lifecycle transition');
    });
  });

  describe('validation', () => {
    it('degrade() requires non-empty reason', () => {
      const repo = createRepo();
      const lm = new LifecycleManager(repo);
      lm.start();

      expect(() => lm.degrade('')).toThrow('non-empty reason');
    });

    it('stop() requires non-empty reason', () => {
      const repo = createRepo();
      const lm = new LifecycleManager(repo);
      lm.start();

      expect(() => lm.stop('')).toThrow('non-empty reason');
    });

    it('latestEvent is null before any transition', () => {
      const repo = createRepo();
      const lm = new LifecycleManager(repo);
      expect(lm.latestEvent).toBeNull();
    });

    it('latestEvent is set after transition', () => {
      const repo = createRepo();
      const lm = new LifecycleManager(repo);
      lm.start('go');
      expect(lm.latestEvent).not.toBeNull();
      expect(lm.latestEvent!.state).toBe(LifecycleState.Running);
    });

    it('diagnostic is persisted on degrade', () => {
      const repo = createRepo();
      const lm = new LifecycleManager(repo);
      lm.start();

      const event = lm.degrade('Disk nearly full', { freeBytes: 1024, threshold: 4096 });
      expect(event.diagnostic).toEqual({ freeBytes: 1024, threshold: 4096 });

      // Verify it persists
      const events = lm.getEvents();
      expect(events[0].diagnostic).toEqual({ freeBytes: 1024, threshold: 4096 });
    });
  });
});
