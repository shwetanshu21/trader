// ── Replay Engine Integration Tests ──
// Tests the full replay pipeline: fixture data provider, replay engine,
// strategy run persistence, checkpoint semantics, and failure paths.
//
// These tests use an in-memory SQLite database with the full schema applied,
// a real MarketProfile (INDIA_NSE_EQ), and deterministic fixture data.

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ReplayClock } from '../src/replay/replay-clock.js';
import { ReplaySessionRepository } from '../src/persistence/replay-session-repo.js';
import { StrategyRunRepository } from '../src/persistence/strategy-run-repo.js';
import { StrategyCoordinator } from '../src/strategy/framework.js';
import { ReplayEngine } from '../src/replay/replay-engine.js';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import {
  FixtureHistoricalDataProvider,
  type HistoricalDataProvider,
} from '../src/replay/historical-data-provider.js';
import {
  ReplaySessionStatus,
  ReplayFidelity,
  type ReplaySessionRow,
  type ReplayTick,
} from '../src/replay/types.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';
import type {
  BoundedCandidate,
  RankedCandidate,
  StrategyPlugin,
  StrategyPluginIdentity,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Test helper — simple pass-through plugin
// ---------------------------------------------------------------------------

/** A simple deterministic strategy plugin for testing. Assigns scores based
 *  on lastPrice: higher price = higher score. */
const TEST_PLUGIN_IDENTITY: StrategyPluginIdentity = {
  id: 'test-price-screener-v1',
  name: 'Test Price Screener',
  version: '1.0.0',
};

class TestPriceScreenerPlugin implements StrategyPlugin {
  readonly identity = TEST_PLUGIN_IDENTITY;

  evaluate(candidates: BoundedCandidate[]): RankedCandidate[] {
    return candidates.map(c => ({
      candidate: c,
      plugin: this.identity,
      score: c.lastPrice != null ? Math.min(c.lastPrice / 5000, 1) : 0.5,
      rationale: `Price-based score: ${c.lastPrice}`,
    }));
  }
}

// ---------------------------------------------------------------------------
// Fixture data — deterministic base candidates
// ---------------------------------------------------------------------------

const BASE_CANDIDATES: BoundedCandidate[] = [
  {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 738561,
    side: 'buy',
    lastPrice: 2450.50,
    bid: 2450.00,
    ask: 2451.00,
    volume: 1250000,
    instrumentType: 'EQ',
    lotSize: 1,
    tickSize: 0.05,
  },
  {
    exchange: 'NSE',
    tradingsymbol: 'TCS',
    instrumentToken: 2953217,
    side: 'buy',
    lastPrice: 3890.00,
    bid: 3889.50,
    ask: 3890.50,
    volume: 850000,
    instrumentType: 'EQ',
    lotSize: 1,
    tickSize: 0.05,
  },
  {
    exchange: 'NSE',
    tradingsymbol: 'HDFCBANK',
    instrumentToken: 341249,
    side: 'buy',
    lastPrice: 1680.25,
    bid: 1680.00,
    ask: 1680.50,
    volume: 2100000,
    instrumentType: 'EQ',
    lotSize: 1,
    tickSize: 0.05,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh in-memory DB with the full schema applied. */
function createTestDb(): Database.Database {
  const dbManager = new DatabaseManager(':memory:');
  return dbManager.db;
}

/** Count strategy run rows. */
function countStrategyRuns(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM strategy_runs').get() as { cnt: number };
  return row.cnt;
}

/** Count strategy run candidate rows. */
function countStrategyRunCandidates(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM strategy_run_candidates').get() as { cnt: number };
  return row.cnt;
}

/** Count replay session rows. */
function countReplaySessions(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM replay_sessions').get() as { cnt: number };
  return row.cnt;
}

/** Count replay checkpoint rows. */
function countReplayCheckpoints(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM replay_checkpoints').get() as { cnt: number };
  return row.cnt;
}

/** Find next Friday by walking forward from a date. */
function nextFriday(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
  if (d.getDay() !== 5) d.setDate(d.getDate() + 7); // Safety: advance to next Friday
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Find next Monday by walking forward from a date. */
function nextMonday(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7));
  if (d.getDay() !== 1) d.setDate(d.getDate() + 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FixtureHistoricalDataProvider', () => {
  let db: Database.Database;
  let now: number;

  beforeEach(() => {
    db = createTestDb();
    now = Date.now();
  });

  it('returns candidates with deterministic price drift', async () => {
    const provider = new FixtureHistoricalDataProvider({
      candidates: BASE_CANDIDATES,
      rangeStart: now - 86_400_000,
      rangeEnd: now,
    });

    const tick1: ReplayTick = { index: 1, timestamp: now - 86_400_000, fidelity: ReplayFidelity.Full };
    const tick2: ReplayTick = { index: 2, timestamp: now - 86_399_000, fidelity: ReplayFidelity.Full };

    const results1 = await provider.getCandidates(tick1);
    const results2 = await provider.getCandidates(tick2);

    // Same count as input
    expect(results1).toHaveLength(BASE_CANDIDATES.length);
    expect(results2).toHaveLength(BASE_CANDIDATES.length);

    // Prices drift between ticks
    expect(results1[0].lastPrice).not.toBe(results2[0].lastPrice);
  });

  it('reports synthetic fidelity', () => {
    const provider = new FixtureHistoricalDataProvider({
      candidates: BASE_CANDIDATES,
      rangeStart: now - 86_400_000,
      rangeEnd: now,
    });

    const tick: ReplayTick = { index: 1, timestamp: now, fidelity: ReplayFidelity.Full };
    expect(provider.getEffectiveFidelity(tick)).toBe(ReplayFidelity.Synthetic);
  });

  it('hasData returns true for the configured range', () => {
    const provider = new FixtureHistoricalDataProvider({
      candidates: BASE_CANDIDATES,
      rangeStart: now - 86_400_000,
      rangeEnd: now,
    });

    expect(provider.hasData(now - 86_400_000, now)).toBe(true);
    expect(provider.hasData(now - 172_800_000, now - 86_400_000)).toBe(false);
  });

  it('reports correct label', () => {
    const provider = new FixtureHistoricalDataProvider({
      candidates: BASE_CANDIDATES,
      rangeStart: now - 86_400_000,
      rangeEnd: now,
    });

    expect(provider.label).toBe('fixture-v1');
  });
});

describe('ReplayEngine — empty ticks (weekend range)', () => {
  let db: Database.Database;
  let sessionRepo: ReplaySessionRepository;
  let strategyRunRepo: StrategyRunRepository;
  let session: ReplaySessionRow;

  beforeEach(() => {
    db = createTestDb();
    sessionRepo = new ReplaySessionRepository(db);
    strategyRunRepo = new StrategyRunRepository(db);
  });

  it('completes immediately when the date range has no trading ticks', async () => {
    // Use a Saturday → Sunday range (no trading days)
    const saturday = new Date('2025-01-04T00:00:00Z'); // Saturday
    const sunday = new Date('2025-01-05T00:00:00Z');   // Sunday

    const rangeStart = saturday.getTime();
    const rangeEnd = sunday.getTime();

    const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 5);

    // Total ticks should be 0 for a weekend-only range
    expect(clock.countTicks(rangeStart, rangeEnd)).toBe(0);

    session = sessionRepo.createSession({
      label: 'empty-tick-test',
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      cadenceMinutes: 5,
      rangeStart,
      rangeEnd,
      requestedFidelity: ReplayFidelity.Synthetic,
      effectiveFidelity: null,
      status: ReplaySessionStatus.Pending,
      totalTicks: 0,
      completedTicks: 0,
      errorMessage: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    });

    const dataProvider = new FixtureHistoricalDataProvider({
      candidates: [],
      rangeStart,
      rangeEnd,
    });

    const coordinator = new StrategyCoordinator([new TestPriceScreenerPlugin()], { maxCandidates: 5 });

    const engine = new ReplayEngine({
      clock,
      dataProvider,
      coordinator,
      sessionRepo,
      strategyRunRepo,
      sessionId: session.id,
      rangeStart,
      rangeEnd,
    });

    const result = await engine.run();

    expect(result.ticksProcessed).toBe(0);
    expect(result.strategyRunsPersisted).toBe(0);
    expect(result.wasInterrupted).toBe(false);
    expect(result.errorMessage).toBeNull();
    expect(result.session.status).toBe(ReplaySessionStatus.Completed);
  });
});

describe('ReplayEngine — fixture-backed single-day replay', () => {
  let db: Database.Database;
  let sessionRepo: ReplaySessionRepository;
  let strategyRunRepo: StrategyRunRepository;
  let session: ReplaySessionRow;

  beforeEach(() => {
    db = createTestDb();
    sessionRepo = new ReplaySessionRepository(db);
    strategyRunRepo = new StrategyRunRepository(db);
  });

  it('persists strategy runs and checkpoints for a single trading day', async () => {
    // Pick a known trading day: Monday 2025-01-06
    const monday = new Date('2025-01-06T00:00:00Z');
    const tuesday = new Date('2025-01-07T00:00:00Z');
    const rangeStart = monday.getTime();
    const rangeEnd = tuesday.getTime();

    const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 5);
    const totalTicks = clock.countTicks(rangeStart, rangeEnd);
    expect(totalTicks).toBeGreaterThan(0);

    const dataProvider = new FixtureHistoricalDataProvider({
      candidates: BASE_CANDIDATES,
      rangeStart,
      rangeEnd,
      priceDrift: 0.001,
    });

    const coordinator = new StrategyCoordinator([new TestPriceScreenerPlugin()], { maxCandidates: 5 });

    session = sessionRepo.createSession({
      label: 'single-day-test',
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      cadenceMinutes: 5,
      rangeStart,
      rangeEnd,
      requestedFidelity: ReplayFidelity.Synthetic,
      effectiveFidelity: null,
      status: ReplaySessionStatus.Pending,
      totalTicks,
      completedTicks: 0,
      errorMessage: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    });

    const engine = new ReplayEngine({
      clock,
      dataProvider,
      coordinator,
      sessionRepo,
      strategyRunRepo,
      sessionId: session.id,
      rangeStart,
      rangeEnd,
    });

    const result = await engine.run();

    // All ticks processed
    expect(result.ticksProcessed).toBe(totalTicks);
    expect(result.strategyRunsPersisted).toBe(totalTicks);
    expect(result.session.status).toBe(ReplaySessionStatus.Completed);
    expect(result.session.completedTicks).toBe(totalTicks);

    // Verify strategy_runs table
    expect(countStrategyRuns(db)).toBe(totalTicks);
    expect(countStrategyRunCandidates(db)).toBe(totalTicks * 3); // 3 candidates per tick

    // Verify checkpoints
    expect(countReplayCheckpoints(db)).toBe(totalTicks);

    // Verify each checkpoint has a strategy_run_id and cap metadata
    const checkpoints = sessionRepo.getSessionCheckpoints(session.id);
    expect(checkpoints).toHaveLength(totalTicks);

    for (const cp of checkpoints) {
      expect(cp.strategyRunId).not.toBeNull();
      expect(cp.tickIndex).toBeGreaterThan(0);
      // Verify cap metadata in checkpoint
      if (cp.metadataJson) {
        const meta = JSON.parse(cp.metadataJson);
        // When no engine-level cap is set (0 = unlimited), appliedCap is null
        // but preCapCandidateCount reflects the raw candidate count
        expect(meta.appliedCap).toBeNull();
        expect(typeof meta.preCapCandidateCount).toBe('number');
        expect(meta.preCapCandidateCount).toBe(3); // 3 base candidates
      }
    }

    // Verify strategy runs are retrievable and ordered
    const runs = strategyRunRepo.getRecentRuns(totalTicks);
    expect(runs).toHaveLength(totalTicks);

    // Each run should have 3 candidates
    for (const run of runs) {
      expect(run.candidates).toHaveLength(3);
      // Candidates should be ordered by rank
      const ranks = run.candidates.map(c => c.rank);
      expect(ranks).toEqual([1, 2, 3]);
    }
  });

  it('records synthetic fidelity for fixture-backed replay', async () => {
    const monday = new Date('2025-01-06T00:00:00Z');
    const tuesday = new Date('2025-01-07T00:00:00Z');

    const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 5);
    const totalTicks = clock.countTicks(monday.getTime(), tuesday.getTime());

    const dataProvider = new FixtureHistoricalDataProvider({
      candidates: BASE_CANDIDATES,
      rangeStart: monday.getTime(),
      rangeEnd: tuesday.getTime(),
    });

    const coordinator = new StrategyCoordinator([new TestPriceScreenerPlugin()], { maxCandidates: 5 });

    session = sessionRepo.createSession({
      label: 'fidelity-test',
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      cadenceMinutes: 5,
      rangeStart: monday.getTime(),
      rangeEnd: tuesday.getTime(),
      requestedFidelity: ReplayFidelity.Synthetic,
      effectiveFidelity: null,
      status: ReplaySessionStatus.Pending,
      totalTicks,
      completedTicks: 0,
      errorMessage: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    });

    const engine = new ReplayEngine({
      clock,
      dataProvider,
      coordinator,
      sessionRepo,
      strategyRunRepo,
      sessionId: session.id,
      rangeStart: monday.getTime(),
      rangeEnd: tuesday.getTime(),
    });

    const result = await engine.run();

    expect(result.session.effectiveFidelity).toBe(ReplayFidelity.Synthetic);
  });

  it('handles empty candidate sets gracefully', async () => {
    const monday = new Date('2025-01-06T00:00:00Z');
    const tuesday = new Date('2025-01-07T00:00:00Z');

    const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 5);
    const totalTicks = clock.countTicks(monday.getTime(), tuesday.getTime());

    const dataProvider = new FixtureHistoricalDataProvider({
      candidates: [], // No candidates
      rangeStart: monday.getTime(),
      rangeEnd: tuesday.getTime(),
    });

    const coordinator = new StrategyCoordinator([], { maxCandidates: 5 });

    session = sessionRepo.createSession({
      label: 'empty-candidates-test',
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      cadenceMinutes: 5,
      rangeStart: monday.getTime(),
      rangeEnd: tuesday.getTime(),
      requestedFidelity: ReplayFidelity.Synthetic,
      effectiveFidelity: null,
      status: ReplaySessionStatus.Pending,
      totalTicks,
      completedTicks: 0,
      errorMessage: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    });

    const engine = new ReplayEngine({
      clock,
      dataProvider,
      coordinator,
      sessionRepo,
      strategyRunRepo,
      sessionId: session.id,
      rangeStart: monday.getTime(),
      rangeEnd: tuesday.getTime(),
    });

    const result = await engine.run();

    // Should complete successfully with strategy runs but 0 candidates each
    expect(result.ticksProcessed).toBe(totalTicks);
    expect(result.strategyRunsPersisted).toBe(totalTicks);
    expect(result.session.status).toBe(ReplaySessionStatus.Completed);
  });

  it('applies engine-level candidate cap and records cap metadata in checkpoints', async () => {
    const monday = new Date('2025-01-06T00:00:00Z');
    const tuesday = new Date('2025-01-07T00:00:00Z');
    const rangeStart = monday.getTime();
    const rangeEnd = tuesday.getTime();

    const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 5);
    const totalTicks = clock.countTicks(rangeStart, rangeEnd);
    expect(totalTicks).toBeGreaterThan(0);

    const dataProvider = new FixtureHistoricalDataProvider({
      candidates: BASE_CANDIDATES,
      rangeStart,
      rangeEnd,
      priceDrift: 0.001,
    });

    // Coordinator's maxCandidates is separate from engine cap
    const coordinator = new StrategyCoordinator([new TestPriceScreenerPlugin()], { maxCandidates: 5 });

    session = sessionRepo.createSession({
      label: 'engine-cap-test',
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      cadenceMinutes: 5,
      rangeStart,
      rangeEnd,
      requestedFidelity: ReplayFidelity.Synthetic,
      effectiveFidelity: null,
      status: ReplaySessionStatus.Pending,
      totalTicks,
      completedTicks: 0,
      errorMessage: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    });

    // Engine cap = 2 (trim BEFORE coordinator)
    const engine = new ReplayEngine({
      clock,
      dataProvider,
      coordinator,
      sessionRepo,
      strategyRunRepo,
      sessionId: session.id,
      rangeStart,
      rangeEnd,
      maxCandidates: 2,
    });

    const result = await engine.run();

    expect(result.ticksProcessed).toBe(totalTicks);
    expect(result.strategyRunsPersisted).toBe(totalTicks);
    expect(result.session.status).toBe(ReplaySessionStatus.Completed);

    // Verify each checkpoint records the engine cap
    const checkpoints = sessionRepo.getSessionCheckpoints(session.id);
    expect(checkpoints).toHaveLength(totalTicks);

    for (const cp of checkpoints) {
      expect(cp.metadataJson).not.toBeNull();
      const meta = JSON.parse(cp.metadataJson!);
      expect(meta.appliedCap).toBe(2);
      expect(meta.preCapCandidateCount).toBe(3); // 3 base candidates before cap
      expect(meta.candidateCount).toBe(2);        // 2 passed to coordinator after cap
    }
  });

});

describe('ReplayEngine — checkpoint resumption', () => {
  let db: Database.Database;
  let sessionRepo: ReplaySessionRepository;
  let strategyRunRepo: StrategyRunRepository;

  beforeEach(() => {
    db = createTestDb();
    sessionRepo = new ReplaySessionRepository(db);
    strategyRunRepo = new StrategyRunRepository(db);
  });

  it('resumes from the latest checkpoint and processes remaining ticks', async () => {
    // Use a multi-day range for checkpoint testing
    const monday = new Date('2025-01-06T00:00:00Z');
    const wednesday = new Date('2025-01-08T00:00:00Z');
    const rangeStart = monday.getTime();
    const rangeEnd = wednesday.getTime();

    const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 5);
    const totalTicks = clock.countTicks(rangeStart, rangeEnd);
    expect(totalTicks).toBeGreaterThan(0);

    const dataProvider = new FixtureHistoricalDataProvider({
      candidates: BASE_CANDIDATES,
      rangeStart,
      rangeEnd,
    });

    const coordinator = new StrategyCoordinator([new TestPriceScreenerPlugin()], { maxCandidates: 5 });

    const session = sessionRepo.createSession({
      label: 'resume-test',
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      cadenceMinutes: 5,
      rangeStart,
      rangeEnd,
      requestedFidelity: ReplayFidelity.Synthetic,
      effectiveFidelity: null,
      status: ReplaySessionStatus.Running,
      totalTicks,
      completedTicks: 0,
      errorMessage: null,
      createdAt: Date.now(),
      startedAt: Date.now(),
      completedAt: null,
    });

    // Manually insert a checkpoint at tick 5 to simulate a partial run
    sessionRepo.saveCheckpoint({
      sessionId: session.id,
      tickIndex: 5,
      tickTimestamp: rangeStart + 5 * 5 * 60_000,
      strategyRunId: null,
      metadataJson: JSON.stringify({ note: 'simulated partial checkpoint' }),
      savedAt: Date.now(),
    });

    // Update completed ticks to match
    sessionRepo.updateSession(session.id, { completedTicks: 5 });

    // Run the engine — should resume from tick 6
    const engine = new ReplayEngine({
      clock,
      dataProvider,
      coordinator,
      sessionRepo,
      strategyRunRepo,
      sessionId: session.id,
      rangeStart,
      rangeEnd,
    });

    const result = await engine.run();

    // Should have processed remaining ticks (total - 5)
    expect(result.ticksProcessed).toBe(totalTicks - 5);
    expect(result.strategyRunsPersisted).toBe(totalTicks - 5);
    expect(result.session.status).toBe(ReplaySessionStatus.Completed);

    // Total checkpoints should be totalTicks (5 manual + remaining from engine)
    // The engine saves one checkpoint per tick processed, starting from tick 6
    const expectedCheckpoints = 1 + (totalTicks - 5); // manual index 5 + engine ticks 6..N
    const checkpoints = sessionRepo.getSessionCheckpoints(session.id);
    expect(checkpoints).toHaveLength(expectedCheckpoints);

    // Verify monotonic tick indices
    const tickIndices = checkpoints.map(c => c.tickIndex);
    for (let i = 1; i < tickIndices.length; i++) {
      expect(tickIndices[i]).toBeGreaterThan(tickIndices[i - 1]);
    }
  });

  it('completes immediately when all ticks are already checkpointed', async () => {
    const monday = new Date('2025-01-06T00:00:00Z');
    const tuesday = new Date('2025-01-07T00:00:00Z');
    const rangeStart = monday.getTime();
    const rangeEnd = tuesday.getTime();

    const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 5);
    const totalTicks = clock.countTicks(rangeStart, rangeEnd);

    const session = sessionRepo.createSession({
      label: 'already-complete-test',
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      cadenceMinutes: 5,
      rangeStart,
      rangeEnd,
      requestedFidelity: ReplayFidelity.Synthetic,
      effectiveFidelity: null,
      status: ReplaySessionStatus.Running,
      totalTicks,
      completedTicks: totalTicks,
      errorMessage: null,
      createdAt: Date.now(),
      startedAt: Date.now(),
      completedAt: null,
    });

    // Insert checkpoint at the last tick
    sessionRepo.saveCheckpoint({
      sessionId: session.id,
      tickIndex: totalTicks,
      tickTimestamp: rangeEnd - 60_000,
      strategyRunId: null,
      metadataJson: null,
      savedAt: Date.now(),
    });

    const dataProvider = new FixtureHistoricalDataProvider({
      candidates: BASE_CANDIDATES,
      rangeStart,
      rangeEnd,
    });

    const coordinator = new StrategyCoordinator([], { maxCandidates: 5 });

    const engine = new ReplayEngine({
      clock,
      dataProvider,
      coordinator,
      sessionRepo,
      strategyRunRepo,
      sessionId: session.id,
      rangeStart,
      rangeEnd,
    });

    const result = await engine.run();

    expect(result.ticksProcessed).toBe(0);
    expect(result.strategyRunsPersisted).toBe(0);
    expect(result.session.status).toBe(ReplaySessionStatus.Completed);
  });
});

describe('ReplayEngine — failure states', () => {
  let db: Database.Database;
  let sessionRepo: ReplaySessionRepository;
  let strategyRunRepo: StrategyRunRepository;

  beforeEach(() => {
    db = createTestDb();
    sessionRepo = new ReplaySessionRepository(db);
    strategyRunRepo = new StrategyRunRepository(db);
  });

  it('marks session as failed when the data provider throws', async () => {
    const monday = new Date('2025-01-06T00:00:00Z');
    const tuesday = new Date('2025-01-07T00:00:00Z');
    const rangeStart = monday.getTime();
    const rangeEnd = tuesday.getTime();

    const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 5);
    const totalTicks = clock.countTicks(rangeStart, rangeEnd);

    // Data provider that throws on first call
    const throwingProvider: HistoricalDataProvider = {
      label: 'throwing-provider',
      getCandidates: async () => { throw new Error('Simulated provider failure'); },
      getEffectiveFidelity: () => ReplayFidelity.Synthetic,
      hasData: () => true,
    };

    const coordinator = new StrategyCoordinator([], { maxCandidates: 5 });

    const session = sessionRepo.createSession({
      label: 'failure-test',
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      cadenceMinutes: 5,
      rangeStart,
      rangeEnd,
      requestedFidelity: ReplayFidelity.Synthetic,
      effectiveFidelity: null,
      status: ReplaySessionStatus.Pending,
      totalTicks,
      completedTicks: 0,
      errorMessage: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    });

    const engine = new ReplayEngine({
      clock,
      dataProvider: throwingProvider,
      coordinator,
      sessionRepo,
      strategyRunRepo,
      sessionId: session.id,
      rangeStart,
      rangeEnd,
    });

    const result = await engine.run();

    expect(result.session.status).toBe(ReplaySessionStatus.Failed);
    expect(result.errorMessage).toContain('Simulated provider failure');
    expect(result.ticksProcessed).toBe(0);
  });
});

describe('ReplayEngine — multi-day replay', () => {
  let db: Database.Database;
  let sessionRepo: ReplaySessionRepository;
  let strategyRunRepo: StrategyRunRepository;

  beforeEach(() => {
    db = createTestDb();
    sessionRepo = new ReplaySessionRepository(db);
    strategyRunRepo = new StrategyRunRepository(db);
  });

  it('processes a full week of trading days', async () => {
    // Monday Jan 6 → Friday Jan 10, 2025 (full trading week)
    const monday = new Date('2025-01-06T00:00:00Z');
    const saturday = new Date('2025-01-11T00:00:00Z');
    const rangeStart = monday.getTime();
    const rangeEnd = saturday.getTime();

    const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 5);
    const totalTicks = clock.countTicks(rangeStart, rangeEnd);
    expect(totalTicks).toBeGreaterThan(0);

    const dataProvider = new FixtureHistoricalDataProvider({
      candidates: BASE_CANDIDATES,
      rangeStart,
      rangeEnd,
      priceDrift: 0.001,
    });

    const coordinator = new StrategyCoordinator([new TestPriceScreenerPlugin()], { maxCandidates: 5 });

    const session = sessionRepo.createSession({
      label: 'multi-day-test',
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      cadenceMinutes: 5,
      rangeStart,
      rangeEnd,
      requestedFidelity: ReplayFidelity.Synthetic,
      effectiveFidelity: null,
      status: ReplaySessionStatus.Pending,
      totalTicks,
      completedTicks: 0,
      errorMessage: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    });

    const engine = new ReplayEngine({
      clock,
      dataProvider,
      coordinator,
      sessionRepo,
      strategyRunRepo,
      sessionId: session.id,
      rangeStart,
      rangeEnd,
    });

    const result = await engine.run();

    expect(result.ticksProcessed).toBe(totalTicks);
    expect(result.strategyRunsPersisted).toBe(totalTicks);
    expect(result.session.status).toBe(ReplaySessionStatus.Completed);
    expect(result.wasInterrupted).toBe(false);

    // Verify monotonic checkpoints
    const checkpoints = sessionRepo.getSessionCheckpoints(session.id);
    expect(checkpoints).toHaveLength(totalTicks);

    for (let i = 0; i < checkpoints.length; i++) {
      expect(checkpoints[i].tickIndex).toBe(i + 1);
      if (i > 0) {
        expect(checkpoints[i].tickTimestamp).toBeGreaterThan(checkpoints[i - 1].tickTimestamp);
      }
    }
  });
});
