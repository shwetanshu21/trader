// ── Lifecycle promotion integration test ──
// Tests the promotion evaluation pipeline end-to-end with an in-memory SQLite DB.
// Seeds walk-forward winner data and verifies PROMOTE/HOLD verdicts.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { WalkForwardRepository } from '../src/persistence/walk-forward-repo.js';
import { StrategyLifecycleRepository } from '../src/persistence/strategy-lifecycle-repo.js';
import { StrategyLifecycleEvaluator } from '../src/lifecycle/strategy-lifecycle-evaluator.js';
import {
  GovernanceVerdict,
  StrategyLifecyclePhase,
} from '../src/types/runtime.js';
import {
  WalkForwardSelectionResult,
  WalkForwardWindowType,
} from '../src/replay/walk-forward-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Create walk_forward tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS walk_forward_runs (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      label                 TEXT    NOT NULL,
      strategy_id           TEXT    NOT NULL,
      strategy_version      TEXT    NOT NULL,
      market_id             TEXT    NOT NULL,
      replay_session_id     INTEGER DEFAULT NULL,
      window_count          INTEGER NOT NULL DEFAULT 0,
      total_trials          INTEGER NOT NULL DEFAULT 0,
      status                TEXT    NOT NULL DEFAULT 'pending',
      created_at            INTEGER NOT NULL,
      started_at            INTEGER,
      completed_at          INTEGER
    );

    CREATE TABLE IF NOT EXISTS walk_forward_windows (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id                  INTEGER NOT NULL REFERENCES walk_forward_runs(id),
      window_index            INTEGER NOT NULL,
      range_start             INTEGER NOT NULL,
      range_end               INTEGER NOT NULL,
      window_label            TEXT    NOT NULL DEFAULT '',
      trial_count_optimized   INTEGER NOT NULL DEFAULT 0,
      trial_count_tested      INTEGER NOT NULL DEFAULT 0,
      status                  TEXT    NOT NULL DEFAULT 'pending',
      created_at              INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS walk_forward_trials (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id                INTEGER NOT NULL REFERENCES walk_forward_runs(id),
      trial_index           INTEGER NOT NULL,
      label                 TEXT    NOT NULL,
      params_json           TEXT    NOT NULL,
      merged_score          REAL    NOT NULL,
      deterministic_score   REAL    NOT NULL,
      llm_score             REAL,
      llm_status            TEXT,
      rank                  INTEGER NOT NULL,
      created_at            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS walk_forward_trial_windows (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      trial_id              INTEGER NOT NULL REFERENCES walk_forward_trials(id),
      window_id             INTEGER NOT NULL REFERENCES walk_forward_windows(id),
      window_type           TEXT    NOT NULL,
      total_return          REAL    NOT NULL,
      sharpe_ratio          REAL,
      max_drawdown          REAL,
      win_rate              REAL,
      trade_count           INTEGER NOT NULL DEFAULT 0,
      profit_factor         REAL,
      metrics_json          TEXT,
      created_at            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS walk_forward_winners (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id                  INTEGER NOT NULL UNIQUE REFERENCES walk_forward_runs(id),
      result                  TEXT    NOT NULL,
      selected_trial_id       INTEGER REFERENCES walk_forward_trials(id),
      selection_strategy      TEXT    NOT NULL,
      selection_config_json   TEXT    NOT NULL DEFAULT '{}',
      rationale               TEXT    NOT NULL DEFAULT '',
      artifact_paths_json     TEXT,
      selected_at             INTEGER NOT NULL,
      created_at              INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategy_lifecycle_state (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id       TEXT    NOT NULL,
      strategy_version  TEXT    NOT NULL,
      market_id         TEXT    NOT NULL,
      phase             TEXT    NOT NULL DEFAULT 'backtest',
      updated_at        INTEGER NOT NULL,
      UNIQUE(strategy_id, strategy_version, market_id)
    );

    CREATE TABLE IF NOT EXISTS governance_decisions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id       TEXT    NOT NULL,
      strategy_version  TEXT    NOT NULL,
      market_id         TEXT    NOT NULL,
      verdict           TEXT    NOT NULL,
      previous_phase    TEXT    NOT NULL,
      new_phase         TEXT    NOT NULL,
      rationale         TEXT    NOT NULL,
      evidence_json     TEXT,
      winner_id         INTEGER REFERENCES walk_forward_winners(id),
      recorded_at       INTEGER NOT NULL
    );
  `);

  return db;
}

/**
 * Seed a walk-forward run with a winner and trial evidence.
 * Returns the run ID.
 */
function seedWinner(
  db: Database.Database,
  overrides?: {
    mergedScore?: number;
    sharpeRatio?: number | null;
    maxDrawdown?: number | null;
    windowCount?: number;
    oosCount?: number;
    result?: WalkForwardSelectionResult;
  },
): number {
  const now = Date.now();

  // Insert run
  db.prepare(`
    INSERT INTO walk_forward_runs
      (id, label, strategy_id, strategy_version, market_id,
       replay_session_id, window_count, total_trials,
       status, created_at, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1, 'test-run-upstox', 'india-nse-eq-v1', '1.0.0', 'INDIA_NSE_EQ',
    null, 0, 0, 'completed', now, null, null,
  );

  // Insert windows
  const windowCount = overrides?.windowCount ?? 4;
  const oosCount = overrides?.oosCount ?? 2;
  for (let i = 0; i < windowCount; i++) {
    const wType = i < (windowCount - oosCount) ? 'in_sample' : 'out_of_sample';
    db.prepare(`
      INSERT INTO walk_forward_windows (id, run_id, window_index, range_start, range_end, window_label, trial_count_optimized, trial_count_tested, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(i + 1, 1, i, now - (windowCount - i) * 86_400_000, now - (windowCount - i - 1) * 86_400_000, '', 0, 0, 'completed', now);
  }

  // Insert trial
  const mergedScore = overrides?.mergedScore ?? 0.85;
  db.prepare(`
    INSERT INTO walk_forward_trials
      (id, run_id, trial_index, label, params_json, merged_score, deterministic_score,
       llm_score, llm_status, rank, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 0, 'Config B (5 candidates)', JSON.stringify({ maxCandidates: 5 }),
    mergedScore, 0.85, null, 'skipped', 1, now);

  // Insert trial window evidence
  const sharpe = overrides?.sharpeRatio ?? 1.5;
  const dd = overrides?.maxDrawdown ?? -15;
  for (let i = 0; i < windowCount; i++) {
    const wType = i < (windowCount - oosCount) ? WalkForwardWindowType.InSample : WalkForwardWindowType.OutOfSample;
    const isOos = wType === WalkForwardWindowType.OutOfSample;
    db.prepare(`
      INSERT INTO walk_forward_trial_windows
        (trial_id, window_id, window_type, total_return, sharpe_ratio, max_drawdown, win_rate, trade_count, profit_factor, metrics_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, i + 1, wType, isOos ? 0.05 : 0.12,
      isOos ? (sharpe ?? null) : 2.0, isOos ? (dd ?? -15) : -10,
      isOos ? 0.55 : 0.60, isOos ? 15 : 25, null, null, now);
  }

  // Insert winner
  const result = overrides?.result ?? WalkForwardSelectionResult.Selected;
  db.prepare(`
    INSERT INTO walk_forward_winners
      (run_id, result, selected_trial_id, selection_strategy, selection_config_json, rationale, artifact_paths_json, selected_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, result, result === WalkForwardSelectionResult.Selected ? 1 : null,
    'composite', '{"strategy":"composite"}', 'All thresholds met', '[]', now, now);

  return 1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StrategyLifecycleEvaluator — promotion pipeline', () => {
  let db: Database.Database;
  let dbManager: DatabaseManager;
  let walkForwardRepo: WalkForwardRepository;
  let lifecycleRepo: StrategyLifecycleRepository;
  let evaluator: StrategyLifecycleEvaluator;

  beforeEach(() => {
    db = createMemoryDb();
    // Wrap in a DatabaseManager-compatible interface
    dbManager = {
      db,
      close: () => { db.close(); },
    } as unknown as DatabaseManager;

    walkForwardRepo = new WalkForwardRepository(db);
    lifecycleRepo = new StrategyLifecycleRepository(db);
    evaluator = new StrategyLifecycleEvaluator({
      walkForwardRepo,
      lifecycleRepo,
    });
  });

  it('should PROMOTE when all thresholds are met', () => {
    seedWinner(db, {
      mergedScore: 0.85,
      sharpeRatio: 1.5,
      maxDrawdown: -15,
    });

    const result = evaluator.evaluate({
      runId: 1,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
    });

    expect(result.verdict).toBe(GovernanceVerdict.Promote);
    expect(result.previousPhase).toBe(StrategyLifecyclePhase.Backtest);
    expect(result.newPhase).toBe(StrategyLifecyclePhase.Paper);
    expect(result.stateUpdated).toBe(true);
    expect(result.rationale).toContain('All promotion thresholds met');
    expect(result.decision.verdict).toBe(GovernanceVerdict.Promote);

    // Verify lifecycle state was updated
    const state = lifecycleRepo.getCurrentState(
      'india-nse-eq-v1', '1.0.0', 'INDIA_NSE_EQ',
    );
    expect(state.phase).toBe(StrategyLifecyclePhase.Paper);
    expect(state.updatedAt).toBeGreaterThan(0);
  });

  it('should HOLD when merged score is below threshold', () => {
    seedWinner(db, {
      mergedScore: 0.5, // below default 0.7
      sharpeRatio: 1.5,
      maxDrawdown: -15,
    });

    const result = evaluator.evaluate({
      runId: 1,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
    });

    expect(result.verdict).toBe(GovernanceVerdict.Hold);
    expect(result.newPhase).toBe(result.previousPhase);
    expect(result.stateUpdated).toBe(false);
    expect(result.rationale).toContain('below minimum threshold');
  });

  it('should HOLD when no winner exists', () => {
    // Don't seed any winner — run ID 1 won't exist
    const result = evaluator.evaluate({
      runId: 999,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
    });

    expect(result.verdict).toBe(GovernanceVerdict.Hold);
    expect(result.stateUpdated).toBe(false);
    expect(result.rationale).toContain('No walk-forward winner decision found');
  });

  it('should HOLD when winner result is no_winner', () => {
    seedWinner(db, {
      result: WalkForwardSelectionResult.NoWinner,
      mergedScore: 0,
    });

    const result = evaluator.evaluate({
      runId: 1,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
    });

    expect(result.verdict).toBe(GovernanceVerdict.Hold);
    expect(result.stateUpdated).toBe(false);
    expect(result.rationale).toContain('no_winner');
  });

  it('should HOLD when Sharpe ratio is below threshold', () => {
    seedWinner(db, {
      mergedScore: 0.85,
      sharpeRatio: 0.3, // below default 1.0
      maxDrawdown: -15,
    });

    const result = evaluator.evaluate({
      runId: 1,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
    });

    expect(result.verdict).toBe(GovernanceVerdict.Hold);
    expect(result.stateUpdated).toBe(false);
    expect(result.rationale).toContain('Sharpe');
  });

  it('should HOLD when drawdown exceeds threshold', () => {
    seedWinner(db, {
      mergedScore: 0.85,
      sharpeRatio: 1.5,
      maxDrawdown: -45, // exceeds default 30%
    });

    const result = evaluator.evaluate({
      runId: 1,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
    });

    expect(result.verdict).toBe(GovernanceVerdict.Hold);
    expect(result.stateUpdated).toBe(false);
    expect(result.rationale).toContain('drawdown');
  });

  it('should persist governance decision in append-only log', () => {
    seedWinner(db, {
      mergedScore: 0.85,
      sharpeRatio: 1.5,
      maxDrawdown: -15,
    });

    evaluator.evaluate({
      runId: 1,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
    });

    // Check decision was persisted
    const decisions = lifecycleRepo.getDecisionsForStrategy(
      'india-nse-eq-v1', '1.0.0', 'INDIA_NSE_EQ', 10,
    );
    expect(decisions.length).toBe(1);
    expect(decisions[0].verdict).toBe(GovernanceVerdict.Promote);
    expect(decisions[0].previousPhase).toBe(StrategyLifecyclePhase.Backtest);
    expect(decisions[0].newPhase).toBe(StrategyLifecyclePhase.Paper);
    expect(decisions[0].evidenceJson).toBeTruthy();
    expect(decisions[0].winnerId).toBe(1);

    // Total count
    expect(lifecycleRepo.decisionCount()).toBe(1);
    expect(lifecycleRepo.countStates()).toBe(1);
  });

  it('should promote from Paper to Live on second evaluation', () => {
    // First promotion: Backtest → Paper
    seedWinner(db, {
      mergedScore: 0.85,
      sharpeRatio: 1.5,
      maxDrawdown: -15,
    });

    evaluator.evaluate({
      runId: 1,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
    });

    // Check we're at Paper now
    let state = lifecycleRepo.getCurrentState(
      'india-nse-eq-v1', '1.0.0', 'INDIA_NSE_EQ',
    );
    expect(state.phase).toBe(StrategyLifecyclePhase.Paper);

    // Evaluate again — should try to promote Paper → Live
    const result2 = evaluator.evaluate({
      runId: 1,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
    });

    expect(result2.verdict).toBe(GovernanceVerdict.Promote);
    expect(result2.previousPhase).toBe(StrategyLifecyclePhase.Paper);
    expect(result2.newPhase).toBe(StrategyLifecyclePhase.Live);
    expect(result2.stateUpdated).toBe(true);

    state = lifecycleRepo.getCurrentState(
      'india-nse-eq-v1', '1.0.0', 'INDIA_NSE_EQ',
    );
    expect(state.phase).toBe(StrategyLifecyclePhase.Live);

    // 3rd evaluation: already at Live → HOLD (no further promotion)
    const result3 = evaluator.evaluate({
      runId: 1,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
    });
    expect(result3.verdict).toBe(GovernanceVerdict.Hold);
    expect(result3.rationale).toContain('maximum lifecycle phase');

    // Should have 3 decisions in the log
    expect(lifecycleRepo.decisionCount()).toBe(3);
  });

  it('should support OOS-window and total-window threshold checks', () => {
    seedWinner(db, {
      mergedScore: 0.85,
      sharpeRatio: 1.5,
      maxDrawdown: -15,
      windowCount: 2,
      oosCount: 0, // No OOS windows
    });

    // Should fail minOosWindows check
    const result = evaluator.evaluate({
      runId: 1,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
    });

    expect(result.verdict).toBe(GovernanceVerdict.Hold);
    expect(result.rationale).toContain('out-of-sample');
  });

  it('should use custom thresholds when provided', () => {
    seedWinner(db, {
      mergedScore: 0.5, // below default 0.7, but above custom 0.4
      sharpeRatio: 1.5,
      maxDrawdown: -15,
    });

    // Custom thresholds that this winner should pass
    const result = evaluator.evaluate({
      runId: 1,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      thresholds: {
        minMergedScore: 0.4,
        minSharpeRatio: 1.0,
        maxDrawdown: 30,
        minWindowCount: 1,
        minOutOfSampleWindows: 1,
      },
    });

    expect(result.verdict).toBe(GovernanceVerdict.Promote);
    expect(result.newPhase).toBe(StrategyLifecyclePhase.Paper);
  });

  it('should HOLD when identity does not match', () => {
    seedWinner(db);

    // Run uses india-nse-eq-v1 but we query with a different strategy
    const result = evaluator.evaluate({
      runId: 1,
      strategyId: 'different-strategy',
      strategyVersion: '2.0.0',
      marketId: 'OTHER_MARKET',
    });

    expect(result.verdict).toBe(GovernanceVerdict.Hold);
    expect(result.rationale).toContain('identity');
    expect(result.rationale).toContain('does not match');
    expect(result.stateUpdated).toBe(false);
  });
});
