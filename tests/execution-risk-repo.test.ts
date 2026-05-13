import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ExecutionRiskRepository } from '../src/persistence/execution-risk-repo.js';
import { HaltState, HaltSource } from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createContext(): { repo: ExecutionRiskRepository; db: Database.Database } {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;
  return { repo: new ExecutionRiskRepository(db), db };
}

/** Helper: seed a halted state for tests that need to verify unlatch/acknowledge behavior. */
function seedHalted(repo: ExecutionRiskRepository): void {
  repo.latchHalt(HaltSource.MarketHours, 'Outside regular trading hours', 1000000, 5, -500);
}

describe('ExecutionRiskRepository — empty-state defaults', () => {
  it('returns no-halt state when no row exists', () => {
    const { repo } = createContext();
    const state = repo.getCurrentState();
    expect(state.haltState).toBe(HaltState.NoHalt);
    expect(state.haltSource).toBeNull();
    expect(state.haltReason).toBeNull();
    expect(state.haltedAt).toBeNull();
    expect(state.acknowledgedAt).toBeNull();
    expect(state.openPositionCountAtHalt).toBeNull();
    expect(state.dailyPnlAtHalt).toBeNull();
    expect(state.latchCount).toBe(0);
    expect(state.updatedAt).toBe(0);
  });

  it('isHalted returns false when no row exists', () => {
    const { repo } = createContext();
    expect(repo.isHalted()).toBe(false);
  });

  it('eventCount is 0 when no events exist', () => {
    const { repo } = createContext();
    expect(repo.eventCount()).toBe(0);
  });

  it('getRecentEvents returns empty array when no events exist', () => {
    const { repo } = createContext();
    expect(repo.getRecentEvents()).toEqual([]);
  });

  it('getRecentEventsByType returns empty array when no events exist', () => {
    const { repo } = createContext();
    expect(repo.getRecentEventsByType('halt')).toEqual([]);
  });

  it('getEventsSince returns empty array when no events exist', () => {
    const { repo } = createContext();
    expect(repo.getEventsSince(0)).toEqual([]);
  });
});

describe('ExecutionRiskRepository — latch/unlatch behavior', () => {
  it('latchHalt transitions state to active_halt', () => {
    const { repo } = createContext();
    const state = repo.latchHalt(HaltSource.MarketHours, 'Outside regular trading hours', 500000);
    expect(state.haltState).toBe(HaltState.ActiveHalt);
    expect(state.haltSource).toBe(HaltSource.MarketHours);
    expect(state.haltReason).toBe('Outside regular trading hours');
    expect(state.haltedAt).toBe(500000);
    expect(state.latchCount).toBe(1);
  });

  it('latchHalt sets open position count and daily pnl', () => {
    const { repo } = createContext();
    const state = repo.latchHalt(HaltSource.ExposureLimit, 'Exposure limit exceeded', 600000, 8, -1200);
    expect(state.openPositionCountAtHalt).toBe(8);
    expect(state.dailyPnlAtHalt).toBe(-1200);
  });

  it('latchHalt increments latchCount when same source re-latches', () => {
    const { repo } = createContext();
    repo.latchHalt(HaltSource.DailyLoss, 'Daily loss limit hit', 700000);
    const state2 = repo.latchHalt(HaltSource.DailyLoss, 'Daily loss limit hit again', 800000);
    expect(state2.latchCount).toBe(2);

    // Different source resets the count context but still increments
    const state3 = repo.latchHalt(HaltSource.MarketHours, 'Market closed', 900000);
    expect(state3.latchCount).toBe(3);
  });

  it('unlatchHalt resets to no_halt', () => {
    const { repo } = createContext();
    seedHalted(repo);
    const state = repo.unlatchHalt(2000000);
    expect(state.haltState).toBe(HaltState.NoHalt);
    expect(state.haltSource).toBeNull();
    expect(state.haltReason).toBeNull();
    expect(state.haltedAt).toBeNull();
    expect(state.latchCount).toBe(0);
  });

  it('unlatchHalt sets acknowledgedAt', () => {
    const { repo } = createContext();
    seedHalted(repo);
    const state = repo.unlatchHalt(3000000);
    expect(state.acknowledgedAt).toBe(3000000);
  });

  it('acknowledgeHalt sets acknowledgedAt without unlatching', () => {
    const { repo } = createContext();
    seedHalted(repo);
    const state = repo.acknowledgeHalt(4000000);
    expect(state.haltState).toBe(HaltState.ActiveHalt);
    expect(state.acknowledgedAt).toBe(4000000);
  });

  it('isHalted returns true after latch', () => {
    const { repo } = createContext();
    expect(repo.isHalted()).toBe(false);
    repo.latchHalt(HaltSource.Operator, 'Kill-switch engaged', 500000);
    expect(repo.isHalted()).toBe(true);
    repo.unlatchHalt(600000);
    expect(repo.isHalted()).toBe(false);
  });

  it('updatePositionCount updates the field without triggering halt', () => {
    const { repo } = createContext();
    repo.updatePositionCount(3);
    const state = repo.getCurrentState();
    expect(state.openPositionCountAtHalt).toBe(3);
  });

  it('updateDailyPnl updates the field without triggering halt', () => {
    const { repo } = createContext();
    repo.updateDailyPnl(500);
    const state = repo.getCurrentState();
    expect(state.dailyPnlAtHalt).toBe(500);
  });
});

describe('ExecutionRiskRepository — event history ordering', () => {
  it('insertEvent stores a risk event and returns it with id', () => {
    const { repo } = createContext();
    const event = repo.insertEvent({
      eventType: 'halt',
      source: HaltSource.MarketHours,
      severity: 'critical',
      message: 'Market closed — halt triggered',
      diagnostic: null,
      recordedAt: 100000,
    });
    expect(event.id).toBe(1);
    expect(event.eventType).toBe('halt');
    expect(event.source).toBe(HaltSource.MarketHours);
    expect(event.severity).toBe('critical');
    expect(event.message).toBe('Market closed — halt triggered');
    expect(event.recordedAt).toBe(100000);
  });

  it('getRecentEvents returns events newest first', () => {
    const { repo } = createContext();
    repo.insertEvent({ eventType: 'halt', source: HaltSource.MarketHours, severity: 'critical', message: 'First', diagnostic: null, recordedAt: 1000 });
    repo.insertEvent({ eventType: 'resume', source: null, severity: 'info', message: 'Second', diagnostic: null, recordedAt: 2000 });
    repo.insertEvent({ eventType: 'refusal', source: HaltSource.DuplicateCap, severity: 'warning', message: 'Third', diagnostic: null, recordedAt: 3000 });

    const events = repo.getRecentEvents(2);
    expect(events).toHaveLength(2);
    expect(events[0].recordedAt).toBe(3000);
    expect(events[0].message).toBe('Third');
    expect(events[1].recordedAt).toBe(2000);
    expect(events[1].message).toBe('Second');
  });

  it('getRecentEventsByType filters by event type', () => {
    const { repo } = createContext();
    repo.insertEvent({ eventType: 'halt', source: HaltSource.MarketHours, severity: 'critical', message: 'Halt A', diagnostic: null, recordedAt: 1000 });
    repo.insertEvent({ eventType: 'resume', source: null, severity: 'info', message: 'Resume', diagnostic: null, recordedAt: 2000 });
    repo.insertEvent({ eventType: 'halt', source: HaltSource.Operator, severity: 'critical', message: 'Halt B', diagnostic: null, recordedAt: 3000 });

    const halts = repo.getRecentEventsByType('halt');
    expect(halts).toHaveLength(2);
    expect(halts[0].message).toBe('Halt B');
    expect(halts[1].message).toBe('Halt A');
  });

  it('getEventsSince returns events >= timestamp', () => {
    const { repo } = createContext();
    repo.insertEvent({ eventType: 'halt', source: HaltSource.System, severity: 'critical', message: 'Old', diagnostic: null, recordedAt: 500 });
    repo.insertEvent({ eventType: 'resume', source: null, severity: 'info', message: 'Mid', diagnostic: null, recordedAt: 1500 });
    repo.insertEvent({ eventType: 'halt', source: HaltSource.Operator, severity: 'critical', message: 'Recent', diagnostic: null, recordedAt: 2500 });

    const events = repo.getEventsSince(1000);
    expect(events).toHaveLength(2);
    expect(events[0].message).toBe('Recent');
    expect(events[1].message).toBe('Mid');
  });

  it('insertEvent stores diagnostic JSON', () => {
    const { repo } = createContext();
    const diag = JSON.stringify({ openPositions: 5, dailyPnl: -1200 });
    const event = repo.insertEvent({
      eventType: 'halt',
      source: HaltSource.DailyLoss,
      severity: 'critical',
      message: 'Daily loss exceeded',
      diagnostic: diag,
      recordedAt: 5000,
    });
    expect(event.diagnostic).toBe(diag);
  });

  it('eventCount returns total count', () => {
    const { repo } = createContext();
    expect(repo.eventCount()).toBe(0);
    repo.insertEvent({ eventType: 'halt', source: HaltSource.Operator, severity: 'critical', message: 'X', diagnostic: null, recordedAt: 100 });
    expect(repo.eventCount()).toBe(1);
    repo.insertEvent({ eventType: 'resume', source: null, severity: 'info', message: 'Y', diagnostic: null, recordedAt: 200 });
    expect(repo.eventCount()).toBe(2);
  });
});

describe('ExecutionRiskRepository — restart readback', () => {
  it('persisted halt state survives a fresh repository instance', () => {
    const { repo: repo1, db } = createContext();
    repo1.latchHalt(HaltSource.MarketHours, 'Outside regular hours', 100000, 3, -500);

    // Create a fresh repo against the same DB
    const repo2 = new ExecutionRiskRepository(db);
    const state = repo2.getCurrentState();
    expect(state.haltState).toBe(HaltState.ActiveHalt);
    expect(state.haltSource).toBe(HaltSource.MarketHours);
    expect(state.haltReason).toBe('Outside regular hours');
    expect(state.haltedAt).toBe(100000);
    expect(state.openPositionCountAtHalt).toBe(3);
    expect(state.dailyPnlAtHalt).toBe(-500);
  });

  it('persisted risk events survive a fresh repository instance', () => {
    const { repo: repo1, db } = createContext();
    repo1.insertEvent({ eventType: 'halt', source: HaltSource.System, severity: 'critical', message: 'System error', diagnostic: null, recordedAt: 100 });

    const repo2 = new ExecutionRiskRepository(db);
    const events = repo2.getRecentEvents();
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('System error');
  });

  it('unlatch after restart shows clean state', () => {
    const { repo: repo1, db } = createContext();
    repo1.latchHalt(HaltSource.Operator, 'Kill-switch', 100000);
    repo1.unlatchHalt(200000);

    const repo2 = new ExecutionRiskRepository(db);
    const state = repo2.getCurrentState();
    expect(state.haltState).toBe(HaltState.NoHalt);
    expect(state.latchCount).toBe(0);
  });
});

describe('ExecutionRiskRepository — boundary conditions', () => {
  it('latch with zero open positions and zero loss threshold', () => {
    const { repo } = createContext();
    const state = repo.latchHalt(HaltSource.DuplicateCap, 'Duplicate order cap hit', 5000, 0, 0);
    expect(state.openPositionCountAtHalt).toBe(0);
    expect(state.dailyPnlAtHalt).toBe(0);
  });

  it('first latch event has latchCount 1', () => {
    const { repo } = createContext();
    const state = repo.latchHalt(HaltSource.MarketHours, 'Market closed', 2000);
    expect(state.latchCount).toBe(1);
  });

  it('repeated latch on same reason increments latchCount (within same active halt)', () => {
    const { repo } = createContext();
    repo.latchHalt(HaltSource.MarketHours, 'Market closed', 1000);
    const state2 = repo.latchHalt(HaltSource.MarketHours, 'Market closed again', 2000);
    expect(state2.latchCount).toBe(2);
  });

  it('latchCount resets after unlatch', () => {
    const { repo } = createContext();
    repo.latchHalt(HaltSource.MarketHours, 'Market closed', 1000);
    repo.unlatchHalt(2000);
    // After unlatch, latchCount is 0; new latch starts at 1
    const state = repo.latchHalt(HaltSource.MarketHours, 'Market closed again', 3000);
    expect(state.latchCount).toBe(1);
  });

  it('getRecentEvents with explicit limit', () => {
    const { repo } = createContext();
    for (let i = 0; i < 5; i++) {
      repo.insertEvent({ eventType: 'test', source: null, severity: 'info', message: `Event ${i}`, diagnostic: null, recordedAt: i * 1000 });
    }
    expect(repo.getRecentEvents(3)).toHaveLength(3);
    expect(repo.getRecentEvents(10)).toHaveLength(5);
    expect(repo.getRecentEvents(0)).toHaveLength(0);
  });

  it('insertEvent with null source and null diagnostic', () => {
    const { repo } = createContext();
    const event = repo.insertEvent({
      eventType: 'info',
      source: null,
      severity: 'info',
      message: 'System startup',
      diagnostic: null,
      recordedAt: 0,
    });
    expect(event.source).toBeNull();
    expect(event.diagnostic).toBeNull();
  });
});
