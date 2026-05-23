// ── OvernightOrchestrator tests ──
// Tests the market-window gate, run-state transitions, checkpoint/resume
// metadata contract, and edge cases using in-memory SQLite fixtures.

import { describe, expect, it } from 'vitest';

import { DatabaseManager } from '../src/persistence/sqlite.js';
import { MarketPhase } from '../src/types/runtime.js';
import { MarketClock } from '../src/runtime/market-clock.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';
import { OvernightRunRepo, OvernightRunStatus } from '../src/research/overnight-run-repo.js';
import {
  OvernightOrchestrator,
  type TryStartResult,
} from '../src/research/overnight-orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a UTC Date for a given calendar date + time in India (Asia/Kolkata = UTC+5:30). */
function indiaTime(
  year: number,
  month: number,  // 1-indexed
  day: number,
  hours: number,
  minutes: number = 0,
  seconds: number = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hours - 5, minutes - 30, seconds));
}

/** Create an OvernightOrchestrator with an in-memory DB. */
function createOrchestrator(): {
  repo: OvernightRunRepo;
  clock: MarketClock;
  orchestrator: OvernightOrchestrator;
  dbm: DatabaseManager;
} {
  const dbm = new DatabaseManager(':memory:');
  const repo = new OvernightRunRepo(dbm.db);
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const orchestrator = new OvernightOrchestrator(repo, clock);
  return { repo, clock, orchestrator, dbm };
}

// ---------------------------------------------------------------------------
// Shared fixture times
// ---------------------------------------------------------------------------

const REGULAR_TIME    = indiaTime(2025, 1, 6, 12, 0, 0);  // Mon 12:00 IST → Regular
const PRE_MARKET_TIME = indiaTime(2025, 1, 6, 9, 5, 0);   // Mon 09:05 IST → PreMarket
const POST_MARKET_TIME = indiaTime(2025, 1, 6, 15, 45, 0); // Mon 15:45 IST → PostMarket
const CLOSED_AFTER    = indiaTime(2025, 1, 6, 16, 30, 0); // Mon 16:30 IST → Closed
const SATURDAY        = indiaTime(2025, 1, 4, 12, 0, 0);  // Sat 12:00 IST → Closed
const SUNDAY          = indiaTime(2025, 1, 5, 12, 0, 0);  // Sun 12:00 IST → Closed
const HOLIDAY         = indiaTime(2025, 8, 15, 12, 0, 0); // Fri Independence Day → Closed

// ---------------------------------------------------------------------------
// Market-window gate tests
// ---------------------------------------------------------------------------

describe('OvernightOrchestrator tryStart — market-window gate', () => {
  it('refuses execution during Regular market phase', () => {
    const { orchestrator, dbm } = createOrchestrator();
    const result = orchestrator.tryStart('test-run', '/tmp/research', REGULAR_TIME);

    expect(result.accepted).toBe(false);
    expect(result.marketPhase).toBe(MarketPhase.Regular);
    expect(result.marketPhaseName).toBe('regular');
    expect(result.refusalReason).toContain('Market is open');
    expect(result.refusalReason).toContain('regular');
    expect(result.run.status).toBe(OvernightRunStatus.Refused);
    expect(result.run.refusalReason).toBe(result.refusalReason);
    expect(result.run.marketPhase).toBe(MarketPhase.Regular);
    expect(result.run.currentPhase).toBeNull();

    dbm.close();
  });

  it('refuses execution during PreMarket phase', () => {
    const { orchestrator, dbm } = createOrchestrator();
    const result = orchestrator.tryStart('test-run', '/tmp/research', PRE_MARKET_TIME);

    expect(result.accepted).toBe(false);
    expect(result.marketPhase).toBe(MarketPhase.PreMarket);
    expect(result.marketPhaseName).toBe('pre_market');
    expect(result.refusalReason).toContain('Market is open');
    expect(result.run.status).toBe(OvernightRunStatus.Refused);

    dbm.close();
  });

  it('refuses execution during PostMarket phase', () => {
    const { orchestrator, dbm } = createOrchestrator();
    const result = orchestrator.tryStart('test-run', '/tmp/research', POST_MARKET_TIME);

    expect(result.accepted).toBe(false);
    expect(result.marketPhase).toBe(MarketPhase.PostMarket);
    expect(result.marketPhaseName).toBe('post_market');
    expect(result.refusalReason).toContain('Market is open');
    expect(result.run.status).toBe(OvernightRunStatus.Refused);

    dbm.close();
  });

  it('accepts execution when market is closed (after-hours)', () => {
    const { orchestrator, dbm } = createOrchestrator();
    const result = orchestrator.tryStart('after-hours-run', '/tmp/research', CLOSED_AFTER);

    expect(result.accepted).toBe(true);
    expect(result.refusalReason).toBeNull();
    expect(result.marketPhase).toBe(MarketPhase.Closed);
    expect(result.marketPhaseName).toBe('closed');
    expect(result.run.status).toBe(OvernightRunStatus.Running);
    expect(result.run.currentPhase).toBe('generate');

    dbm.close();
  });

  it('accepts execution on Saturday (closed)', () => {
    const { orchestrator, dbm } = createOrchestrator();
    const result = orchestrator.tryStart('saturday-run', '/tmp/research', SATURDAY);

    expect(result.accepted).toBe(true);
    expect(result.marketPhase).toBe(MarketPhase.Closed);
    expect(result.run.status).toBe(OvernightRunStatus.Running);

    dbm.close();
  });

  it('accepts execution on Sunday (closed)', () => {
    const { orchestrator, dbm } = createOrchestrator();
    const result = orchestrator.tryStart('sunday-run', '/tmp/research', SUNDAY);

    expect(result.accepted).toBe(true);
    expect(result.marketPhase).toBe(MarketPhase.Closed);
    expect(result.run.status).toBe(OvernightRunStatus.Running);

    dbm.close();
  });

  it('accepts execution on a holiday (closed)', () => {
    const { orchestrator, dbm } = createOrchestrator();
    const result = orchestrator.tryStart('holiday-run', '/tmp/research', HOLIDAY);

    expect(result.accepted).toBe(true);
    expect(result.marketPhase).toBe(MarketPhase.Closed);
    expect(result.run.status).toBe(OvernightRunStatus.Running);

    dbm.close();
  });
});

// ---------------------------------------------------------------------------
// Run-state transitions
// ---------------------------------------------------------------------------

describe('OvernightOrchestrator — run-state transitions', () => {
  it('persists a refused run with full audit trail', () => {
    const { repo, orchestrator, dbm } = createOrchestrator();

    const result = orchestrator.tryStart('refused-run', '/tmp/research', REGULAR_TIME);
    const persisted = repo.getRun(result.run.id);

    expect(persisted).not.toBeNull();
    expect(persisted!.id).toBe(result.run.id);
    expect(persisted!.status).toBe(OvernightRunStatus.Refused);
    expect(persisted!.label).toBe('refused-run');
    expect(persisted!.workspacePath).toBe('/tmp/research');
    expect(persisted!.marketPhase).toBe(MarketPhase.Regular);
    expect(persisted!.refusalReason).toContain('Market is open');
    expect(persisted!.startedAt).toBeNull();
    expect(persisted!.completedAt).toBeNull();

    dbm.close();
  });

  it('persists an accepted run with startedAt and initial phase', () => {
    const { repo, orchestrator, dbm } = createOrchestrator();

    const result = orchestrator.tryStart('accepted-run', '/tmp/research/run-1', CLOSED_AFTER);
    const persisted = repo.getRun(result.run.id);

    expect(persisted).not.toBeNull();
    expect(persisted!.status).toBe(OvernightRunStatus.Running);
    expect(persisted!.label).toBe('accepted-run');
    expect(persisted!.workspacePath).toBe('/tmp/research/run-1');
    expect(persisted!.marketPhase).toBe(MarketPhase.Closed);
    expect(persisted!.currentPhase).toBe('generate');
    expect(persisted!.startedAt).toBeGreaterThan(0);
    expect(persisted!.completedAt).toBeNull();

    dbm.close();
  });

  it('marks a run as completed', () => {
    const { orchestrator, dbm } = createOrchestrator();
    const start = orchestrator.tryStart('complete-run', '/tmp/ws', CLOSED_AFTER);

    const completed = orchestrator.markCompleted(start.run.id);
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe(OvernightRunStatus.Completed);
    expect(completed!.completedAt).toBeGreaterThan(0);

    dbm.close();
  });

  it('marks a run as failed with error message', () => {
    const { orchestrator, dbm } = createOrchestrator();
    const start = orchestrator.tryStart('fail-run', '/tmp/ws', CLOSED_AFTER);

    const failed = orchestrator.markFailed(start.run.id, 'LLM provider timeout');
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe(OvernightRunStatus.Failed);
    expect(failed!.lastError).toBe('LLM provider timeout');
    expect(failed!.completedAt).toBeGreaterThan(0);

    dbm.close();
  });

  it('updates current phase during execution', () => {
    const { orchestrator, dbm } = createOrchestrator();
    const start = orchestrator.tryStart('phase-test', '/tmp/ws', CLOSED_AFTER);

    const phase1 = orchestrator.markPhase(start.run.id, 'generate');
    expect(phase1!.currentPhase).toBe('generate');

    const phase2 = orchestrator.markPhase(start.run.id, 'evaluate');
    expect(phase2!.currentPhase).toBe('evaluate');

    const phase3 = orchestrator.markPhase(start.run.id, 'publish');
    expect(phase3!.currentPhase).toBe('publish');

    // Verify the last phase persisted
    const persisted = orchestrator.getRun(start.run.id);
    expect(persisted!.currentPhase).toBe('publish');

    dbm.close();
  });
});

// ---------------------------------------------------------------------------
// Checkpoint/resume metadata contract
// ---------------------------------------------------------------------------

describe('OvernightOrchestrator — checkpoint metadata', () => {
  it('saves and retrieves a checkpoint with phase, counts, and last processed id', () => {
    const { orchestrator, dbm } = createOrchestrator();
    const start = orchestrator.tryStart('checkpoint-test', '/tmp/ws', CLOSED_AFTER);

    const updated = orchestrator.saveCheckpoint(start.run.id, {
      phase: 'generate',
      completedItems: 5,
      totalItems: 10,
      lastProcessedId: 'hyp-003',
    });

    expect(updated).not.toBeNull();
    expect(updated!.checkpointPointer).not.toBeNull();

    const parsed = JSON.parse(updated!.checkpointPointer!) as Record<string, unknown>;
    expect(parsed.phase).toBe('generate');
    expect(parsed.completedItems).toBe(5);
    expect(parsed.totalItems).toBe(10);
    expect(parsed.lastProcessedId).toBe('hyp-003');

    dbm.close();
  });

  it('saves checkpoints with arbitrary metadata payload', () => {
    const { orchestrator, dbm } = createOrchestrator();
    const start = orchestrator.tryStart('meta-chk', '/tmp/ws', CLOSED_AFTER);

    const updated = orchestrator.saveCheckpoint(start.run.id, {
      phase: 'evaluate',
      completedItems: 42,
      totalItems: 100,
      metadata: {
        meanScore: 0.78,
        topCandidate: 'trial-007',
        windowsProcessed: 12,
      },
    });

    expect(updated).not.toBeNull();
    const parsed = JSON.parse(updated!.checkpointPointer!) as Record<string, unknown>;
    expect(parsed.phase).toBe('evaluate');
    expect((parsed.metadata as Record<string, unknown>).meanScore).toBe(0.78);
    expect((parsed.metadata as Record<string, unknown>).topCandidate).toBe('trial-007');
    expect((parsed.metadata as Record<string, unknown>).windowsProcessed).toBe(12);

    dbm.close();
  });

  it('overwrites the previous checkpoint on subsequent saves', () => {
    const { orchestrator, dbm } = createOrchestrator();
    const start = orchestrator.tryStart('overwrite-chk', '/tmp/ws', CLOSED_AFTER);

    orchestrator.saveCheckpoint(start.run.id, {
      phase: 'generate',
      completedItems: 3,
      totalItems: 10,
    });

    const updated = orchestrator.saveCheckpoint(start.run.id, {
      phase: 'evaluate',
      completedItems: 8,
      totalItems: 10,
    });

    const parsed = JSON.parse(updated!.checkpointPointer!) as Record<string, unknown>;
    expect(parsed.phase).toBe('evaluate');
    expect(parsed.completedItems).toBe(8);

    dbm.close();
  });

  it('checkpoint pointer is null before any checkpoint is saved', () => {
    const { orchestrator, dbm } = createOrchestrator();
    const start = orchestrator.tryStart('no-chk', '/tmp/ws', CLOSED_AFTER);

    expect(start.run.checkpointPointer).toBeNull();

    dbm.close();
  });
});

// ---------------------------------------------------------------------------
// getRun / getLatestRun
// ---------------------------------------------------------------------------

describe('OvernightOrchestrator — run queries', () => {
  it('returns null for non-existent run', () => {
    const { orchestrator, dbm } = createOrchestrator();
    expect(orchestrator.getRun(999)).toBeNull();
    dbm.close();
  });

  it('returns the latest run across multiple runs', () => {
    const { orchestrator, dbm } = createOrchestrator();

    // First run — refused
    orchestrator.tryStart('first', '/ws/1', REGULAR_TIME);
    // Second run — accepted
    const second = orchestrator.tryStart('second', '/ws/2', CLOSED_AFTER);

    const latest = orchestrator.getLatestRun();
    expect(latest).not.toBeNull();
    expect(latest!.label).toBe('second');
    expect(latest!.id).toBe(second.run.id);

    dbm.close();
  });

  it('returns null for getLatestRun when no runs exist', () => {
    const { orchestrator, dbm } = createOrchestrator();
    expect(orchestrator.getLatestRun()).toBeNull();
    dbm.close();
  });
});

// ---------------------------------------------------------------------------
// Repo-level queries
// ---------------------------------------------------------------------------

describe('OvernightRunRepo — status counts', () => {
  it('counts runs by status', () => {
    const { repo, orchestrator, dbm } = createOrchestrator();

    // Two refused, one accepted
    orchestrator.tryStart('ref1', '/ws/1', REGULAR_TIME);
    orchestrator.tryStart('ref2', '/ws/2', PRE_MARKET_TIME);
    orchestrator.tryStart('ok', '/ws/3', CLOSED_AFTER);

    expect(repo.countRuns()).toBe(3);
    expect(repo.countByStatus(OvernightRunStatus.Refused)).toBe(2);
    expect(repo.countByStatus(OvernightRunStatus.Running)).toBe(1);
    expect(repo.countByStatus(OvernightRunStatus.Completed)).toBe(0);

    dbm.close();
  });

  it('lists runs newest first', () => {
    const { repo, orchestrator, dbm } = createOrchestrator();

    orchestrator.tryStart('first', '/ws/1', CLOSED_AFTER);
    orchestrator.tryStart('second', '/ws/2', CLOSED_AFTER);
    orchestrator.tryStart('third', '/ws/3', CLOSED_AFTER);

    const runs = repo.listRuns(5);
    expect(runs).toHaveLength(3);
    expect(runs[0].label).toBe('third');
    expect(runs[1].label).toBe('second');
    expect(runs[2].label).toBe('first');

    dbm.close();
  });
});
