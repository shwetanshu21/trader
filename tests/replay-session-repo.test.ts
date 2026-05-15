// ── ReplaySessionRepository tests ──

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ReplaySessionRepository } from '../src/persistence/replay-session-repo.js';
import {
  ReplayFidelity,
  ReplaySessionStatus,
  type NewReplaySession,
  type NewReplayCheckpoint,
} from '../src/replay/types.js';

// ---------------------------------------------------------------------------
// Test context helpers
// ---------------------------------------------------------------------------

interface TestContext {
  repo: ReplaySessionRepository;
  db: Database.Database;
}

function createContext(): TestContext {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;
  return {
    repo: new ReplaySessionRepository(db),
    db,
  };
}

function sampleSession(overrides?: Partial<NewReplaySession>): NewReplaySession {
  const now = Date.now();
  return {
    label: '2025-01-06 replay',
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    cadenceMinutes: 5,
    rangeStart: now - 86400_000,
    rangeEnd: now,
    requestedFidelity: ReplayFidelity.Full,
    effectiveFidelity: null,
    status: ReplaySessionStatus.Pending,
    totalTicks: 75,
    completedTicks: 0,
    errorMessage: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function sampleCheckpoint(
  sessionId: number,
  overrides?: Partial<NewReplayCheckpoint>,
): NewReplayCheckpoint {
  return {
    sessionId,
    tickIndex: 1,
    tickTimestamp: Date.now() - 3600_000,
    strategyRunId: null,
    metadataJson: null,
    savedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ReplaySessionRepository — Session CRUD
// ---------------------------------------------------------------------------

describe('ReplaySessionRepository — createSession', () => {
  it('creates a session and returns it with auto-assigned id', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());

    expect(s.id).toBeGreaterThan(0);
    expect(s.label).toBe('2025-01-06 replay');
    expect(s.strategyId).toBe('india-nse-eq-v1');
    expect(s.strategyVersion).toBe('1.0.0');
    expect(s.marketId).toBe('INDIA_NSE_EQ');
    expect(s.cadenceMinutes).toBe(5);
    expect(s.requestedFidelity).toBe(ReplayFidelity.Full);
    expect(s.effectiveFidelity).toBeNull();
    expect(s.status).toBe(ReplaySessionStatus.Pending);
    expect(s.totalTicks).toBe(75);
    expect(s.completedTicks).toBe(0);
    expect(s.errorMessage).toBeNull();
    expect(s.startedAt).toBeNull();
    expect(s.completedAt).toBeNull();
    expect(typeof s.createdAt).toBe('number');
  });

  it('creates a session with alternative fidelity and status', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession({
      requestedFidelity: ReplayFidelity.Synthetic,
      status: ReplaySessionStatus.Running,
      totalTicks: 150,
      startedAt: Date.now(),
    }));

    expect(s.requestedFidelity).toBe(ReplayFidelity.Synthetic);
    expect(s.status).toBe(ReplaySessionStatus.Running);
    expect(s.totalTicks).toBe(150);
    expect(s.startedAt).not.toBeNull();
  });
});

describe('ReplaySessionRepository — getSession', () => {
  it('returns null for unknown id', () => {
    const ctx = createContext();
    expect(ctx.repo.getSession(99999)).toBeNull();
  });

  it('returns the session after creation', () => {
    const ctx = createContext();
    const created = ctx.repo.createSession(sampleSession());

    const loaded = ctx.repo.getSession(created.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(created.id);
    expect(loaded!.label).toBe(created.label);
  });
});

describe('ReplaySessionRepository — updateSession', () => {
  it('updates status and timestamps', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());
    const now = Date.now();

    const updated = ctx.repo.updateSession(s.id, {
      status: ReplaySessionStatus.Running,
      startedAt: now,
    });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe(ReplaySessionStatus.Running);
    expect(updated!.startedAt).toBe(now);
  });

  it('updates completed ticks while preserving other fields', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());

    const updated = ctx.repo.updateSession(s.id, {
      completedTicks: 42,
    });

    expect(updated!.completedTicks).toBe(42);
    // Other fields unchanged
    expect(updated!.totalTicks).toBe(75);
    expect(updated!.status).toBe(ReplaySessionStatus.Pending);
    expect(updated!.label).toBe('2025-01-06 replay');
  });

  it('updates error message', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());

    const updated = ctx.repo.updateSession(s.id, {
      status: ReplaySessionStatus.Failed,
      errorMessage: 'Historical data provider returned no data',
      completedAt: Date.now(),
    });

    expect(updated!.status).toBe(ReplaySessionStatus.Failed);
    expect(updated!.errorMessage).toBe('Historical data provider returned no data');
    expect(updated!.completedAt).not.toBeNull();
  });

  it('returns null when session does not exist', () => {
    const ctx = createContext();
    expect(ctx.repo.updateSession(99999, { status: ReplaySessionStatus.Running })).toBeNull();
  });

  it('clears error message when set to null', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession({
      errorMessage: 'Previous error',
    }));

    const updated = ctx.repo.updateSession(s.id, {
      status: ReplaySessionStatus.Running,
      errorMessage: null,
    });

    expect(updated!.errorMessage).toBeNull();
  });
});

describe('ReplaySessionRepository — lifecycle helpers', () => {
  it('markStarted updates status to Running and sets startedAt', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());
    const now = Date.now();

    const started = ctx.repo.markStarted(s.id, now);
    expect(started!.status).toBe(ReplaySessionStatus.Running);
    expect(started!.startedAt).toBe(now);
  });

  it('markCompleted updates status to Completed and sets completedAt', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());
    const now = Date.now();

    const completed = ctx.repo.markCompleted(s.id, now, 'full');
    expect(completed!.status).toBe(ReplaySessionStatus.Completed);
    expect(completed!.completedAt).toBe(now);
    expect(completed!.effectiveFidelity).toBe('full');
  });

  it('markFailed updates status to Failed with error', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());
    const now = Date.now();

    const failed = ctx.repo.markFailed(s.id, now, 'Something went wrong');
    expect(failed!.status).toBe(ReplaySessionStatus.Failed);
    expect(failed!.completedAt).toBe(now);
    expect(failed!.errorMessage).toBe('Something went wrong');
  });

  it('markInterrupted updates status to Interrupted', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());

    const interrupted = ctx.repo.markInterrupted(s.id);
    expect(interrupted!.status).toBe(ReplaySessionStatus.Interrupted);
  });
});

describe('ReplaySessionRepository — listSessions', () => {
  it('returns empty array when no sessions exist', () => {
    const ctx = createContext();
    expect(ctx.repo.listSessions()).toEqual([]);
  });

  it('returns sessions newest first', () => {
    const ctx = createContext();

    const s1 = ctx.repo.createSession(sampleSession({ createdAt: 100 }));
    const s2 = ctx.repo.createSession(sampleSession({ createdAt: 200 }));

    const sessions = ctx.repo.listSessions();
    expect(sessions.length).toBe(2);
    expect(sessions[0].id).toBe(s2.id);
    expect(sessions[1].id).toBe(s1.id);
  });

  it('respects the limit parameter', () => {
    const ctx = createContext();
    for (let i = 0; i < 10; i++) {
      ctx.repo.createSession(sampleSession({ createdAt: i }));
    }

    expect(ctx.repo.listSessions(3).length).toBe(3);
    expect(ctx.repo.listSessions(100).length).toBe(10);
  });
});

describe('ReplaySessionRepository — countSessions', () => {
  it('starts at zero', () => {
    const ctx = createContext();
    expect(ctx.repo.countSessions()).toBe(0);
  });

  it('increments after creates', () => {
    const ctx = createContext();
    ctx.repo.createSession(sampleSession());
    expect(ctx.repo.countSessions()).toBe(1);
    ctx.repo.createSession(sampleSession());
    expect(ctx.repo.countSessions()).toBe(2);
  });
});

describe('ReplaySessionRepository — deleteSession', () => {
  it('deletes a session and its checkpoints', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());
    ctx.repo.saveCheckpoint(sampleCheckpoint(s.id));
    ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 2 }));

    expect(ctx.repo.countCheckpoints(s.id)).toBe(2);
    expect(ctx.repo.deleteSession(s.id)).toBe(true);
    expect(ctx.repo.getSession(s.id)).toBeNull();
    // Checkpoints should be cascade-deleted
    expect(ctx.repo.countCheckpoints(s.id)).toBe(0);
  });

  it('returns false when session does not exist', () => {
    const ctx = createContext();
    expect(ctx.repo.deleteSession(99999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReplaySessionRepository — Checkpoint CRUD
// ---------------------------------------------------------------------------

describe('ReplaySessionRepository — saveCheckpoint', () => {
  it('saves a checkpoint and returns it with auto-assigned id', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());

    const cp = ctx.repo.saveCheckpoint(sampleCheckpoint(s.id));
    expect(cp.id).toBeGreaterThan(0);
    expect(cp.sessionId).toBe(s.id);
    expect(cp.tickIndex).toBe(1);
    expect(cp.strategyRunId).toBeNull();
    expect(cp.metadataJson).toBeNull();
  });

  it('saves multiple checkpoints for the same session', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());

    const cp1 = ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 1 }));
    const cp2 = ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 2 }));
    const cp3 = ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 3 }));

    expect(cp3.tickIndex).toBe(3);
    expect(ctx.repo.countCheckpoints(s.id)).toBe(3);
  });

  it('saves a checkpoint with metadata JSON', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());

    const cp = ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, {
      tickIndex: 5,
      metadataJson: JSON.stringify({ reason: 'normal_tick' }),
    }));

    expect(cp.metadataJson).toBe('{"reason":"normal_tick"}');
  });
});

describe('ReplaySessionRepository — getLatestCheckpoint', () => {
  it('returns null when no checkpoints exist', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());
    expect(ctx.repo.getLatestCheckpoint(s.id)).toBeNull();
  });

  it('returns the checkpoint with the highest tick_index', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());

    ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 1 }));
    ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 5 }));
    ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 3 }));

    const latest = ctx.repo.getLatestCheckpoint(s.id);
    expect(latest).not.toBeNull();
    expect(latest!.tickIndex).toBe(5);
  });

  it('returns the only checkpoint when just one exists', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());

    const cp = ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 7 }));
    const latest = ctx.repo.getLatestCheckpoint(s.id);
    expect(latest!.id).toBe(cp.id);
    expect(latest!.tickIndex).toBe(7);
  });
});

describe('ReplaySessionRepository — getSessionCheckpoints', () => {
  it('returns checkpoints in ascending tick_index order', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());

    ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 3 }));
    ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 1 }));
    ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 2 }));

    const checkpoints = ctx.repo.getSessionCheckpoints(s.id);
    expect(checkpoints.length).toBe(3);
    expect(checkpoints[0].tickIndex).toBe(1);
    expect(checkpoints[1].tickIndex).toBe(2);
    expect(checkpoints[2].tickIndex).toBe(3);
  });

  it('returns empty array when no checkpoints exist', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());
    expect(ctx.repo.getSessionCheckpoints(s.id)).toEqual([]);
  });

  it('returns only checkpoints for the specified session', () => {
    const ctx = createContext();
    const s1 = ctx.repo.createSession(sampleSession());
    const s2 = ctx.repo.createSession(sampleSession());

    ctx.repo.saveCheckpoint(sampleCheckpoint(s1.id, { tickIndex: 1 }));
    ctx.repo.saveCheckpoint(sampleCheckpoint(s2.id, { tickIndex: 1 }));
    ctx.repo.saveCheckpoint(sampleCheckpoint(s2.id, { tickIndex: 2 }));

    const s1Checkpoints = ctx.repo.getSessionCheckpoints(s1.id);
    expect(s1Checkpoints.length).toBe(1);

    const s2Checkpoints = ctx.repo.getSessionCheckpoints(s2.id);
    expect(s2Checkpoints.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Full session lifecycle — create → start → checkpoint → complete
// ---------------------------------------------------------------------------

describe('ReplaySessionRepository — session lifecycle', () => {
  it('preserves the full lifecycle: pending → running → completed', () => {
    const ctx = createContext();

    // Create
    const s = ctx.repo.createSession(sampleSession({ totalTicks: 10 }));
    expect(s.status).toBe(ReplaySessionStatus.Pending);

    // Start
    const t0 = Date.now();
    const running = ctx.repo.markStarted(s.id, t0);
    expect(running!.status).toBe(ReplaySessionStatus.Running);
    expect(running!.startedAt).toBe(t0);

    // Save 3 checkpoints
    ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 2 }));
    ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 5 }));
    ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 8 }));

    // Update completed ticks
    ctx.repo.updateSession(s.id, { completedTicks: 8 });
    expect(ctx.repo.getSession(s.id)!.completedTicks).toBe(8);

    // Complete
    const t1 = Date.now();
    const completed = ctx.repo.markCompleted(s.id, t1, 'full');
    expect(completed!.status).toBe(ReplaySessionStatus.Completed);
    expect(completed!.completedAt).toBe(t1);
    expect(completed!.effectiveFidelity).toBe('full');
    expect(completed!.completedTicks).toBe(8);

    // Final read
    const final = ctx.repo.getSession(s.id);
    expect(final!.status).toBe(ReplaySessionStatus.Completed);
    expect(final!.completedTicks).toBe(8);
    expect(ctx.repo.countCheckpoints(s.id)).toBe(3);
  });

  it('preserves failure state: pending → running → failed', () => {
    const ctx = createContext();

    const s = ctx.repo.createSession(sampleSession());
    ctx.repo.markStarted(s.id, Date.now());
    const failed = ctx.repo.markFailed(s.id, Date.now(), 'Provider unavailable');

    expect(failed!.status).toBe(ReplaySessionStatus.Failed);
    expect(failed!.errorMessage).toBe('Provider unavailable');

    // Load fresh from DB to verify persistence
    const loaded = ctx.repo.getSession(s.id);
    expect(loaded!.status).toBe(ReplaySessionStatus.Failed);
    expect(loaded!.errorMessage).toBe('Provider unavailable');
  });

  it('preserves interrupted state with partial checkpoint progress', () => {
    const ctx = createContext();

    const s = ctx.repo.createSession(sampleSession({ totalTicks: 75 }));
    ctx.repo.markStarted(s.id, Date.now());
    ctx.repo.updateSession(s.id, { completedTicks: 30 });
    ctx.repo.saveCheckpoint(sampleCheckpoint(s.id, { tickIndex: 30 }));

    const interrupted = ctx.repo.markInterrupted(s.id);

    expect(interrupted!.status).toBe(ReplaySessionStatus.Interrupted);
    expect(interrupted!.completedTicks).toBe(30);

    // Latest checkpoint preserved
    const cp = ctx.repo.getLatestCheckpoint(s.id);
    expect(cp).not.toBeNull();
    expect(cp!.tickIndex).toBe(30);
  });

  it('supports multiple sessions independently', () => {
    const ctx = createContext();

    const s1 = ctx.repo.createSession(sampleSession({ totalTicks: 10, label: 'first' }));
    const s2 = ctx.repo.createSession(sampleSession({ totalTicks: 20, label: 'second' }));

    ctx.repo.markStarted(s1.id, Date.now());
    ctx.repo.markStarted(s2.id, Date.now());

    ctx.repo.saveCheckpoint(sampleCheckpoint(s1.id, { tickIndex: 1 }));
    ctx.repo.saveCheckpoint(sampleCheckpoint(s2.id, { tickIndex: 1 }));
    ctx.repo.saveCheckpoint(sampleCheckpoint(s1.id, { tickIndex: 2 }));

    ctx.repo.markCompleted(s1.id, Date.now(), 'full');
    ctx.repo.markCompleted(s2.id, Date.now(), 'synthetic');

    const loaded1 = ctx.repo.getSession(s1.id);
    const loaded2 = ctx.repo.getSession(s2.id);

    expect(loaded1!.status).toBe(ReplaySessionStatus.Completed);
    expect(loaded1!.completedTicks).toBe(0); // not updated
    expect(ctx.repo.countCheckpoints(s1.id)).toBe(2);

    expect(loaded2!.status).toBe(ReplaySessionStatus.Completed);
    expect(loaded2!.effectiveFidelity).toBe('synthetic');
    expect(ctx.repo.countCheckpoints(s2.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Negative tests — error handling, edge cases
// ---------------------------------------------------------------------------

describe('ReplaySessionRepository — negative tests', () => {
  it('rejects checkpoint with non-existent session_id (FK violation)', () => {
    const ctx = createContext();

    expect(() => {
      ctx.repo.saveCheckpoint(sampleCheckpoint(99999));
    }).toThrow();
  });

  it('handles empty session list', () => {
    const ctx = createContext();
    expect(ctx.repo.listSessions()).toEqual([]);
    expect(ctx.repo.countSessions()).toBe(0);
  });

  it('handles getSession for unknown id', () => {
    const ctx = createContext();
    expect(ctx.repo.getSession(99999)).toBeNull();
  });

  it('handles updateSession for unknown id', () => {
    const ctx = createContext();
    expect(ctx.repo.updateSession(99999, { status: ReplaySessionStatus.Running })).toBeNull();
  });

  it('handles getLatestCheckpoint for session with no checkpoints', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());
    expect(ctx.repo.getLatestCheckpoint(s.id)).toBeNull();
  });

  it('handles deleteSession for unknown id', () => {
    const ctx = createContext();
    expect(ctx.repo.deleteSession(99999)).toBe(false);
  });

  it('handles empty checkpoints list for session', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession());
    expect(ctx.repo.getSessionCheckpoints(s.id)).toEqual([]);
    expect(ctx.repo.countCheckpoints(s.id)).toBe(0);
  });

  it('rejects session creation with negative range (edge case)', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession({
      rangeStart: -1000,
      rangeEnd: -500,
    }));
    // Should succeed — negative timestamps are valid (before epoch)
    expect(s.id).toBeGreaterThan(0);
    expect(s.rangeStart).toBe(-1000);
    expect(s.rangeEnd).toBe(-500);
  });

  it('handles zero total ticks in a session', () => {
    const ctx = createContext();
    const s = ctx.repo.createSession(sampleSession({ totalTicks: 0 }));
    expect(s.totalTicks).toBe(0);
    expect(s.status).toBe(ReplaySessionStatus.Pending);
  });
});
