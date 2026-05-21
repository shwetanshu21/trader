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
  type WalkForwardWindowMetricsEnvelope,
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
    /** metrics_json for trial-window rows. null = no metrics. */
    metricsJson?: string | null;
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

  // Determine metricsJson value
  const metricsOverride = overrides?.metricsJson;
  let metricsVal: string | null;
  if (metricsOverride !== undefined) {
    // Explicitly set — use as-is (null for legacy simulation)
    metricsVal = metricsOverride;
  } else {
    // Default: full-fidelity metrics so existing tests pass the fidelity gate
    metricsVal = JSON.stringify({
      schemaVersion: 1,
      source: 'replay-session',
      replayEvidence: {
        replaySessionId: 1,
        replayStatus: 'completed',
        replayLabel: 'Test session',
        replayRangeStart: now - 86400000,
        replayRangeEnd: now,
        replayCompletedTicks: 10,
        replayTotalTicks: 10,
        checkpointCount: 3,
        strategyRunCount: 5,
        firstStrategyRunId: 1,
        lastStrategyRunId: 5,
        topCandidateCount: 5,
        maxCandidates: 5,
        preCapCandidateCount: 5,
        llmStatusCounts: { consulted: 4, skipped: 1 },
        pluginErrorCount: 0,
        errorMessage: null,
      },
      summary: {
        tickCount: 10,
        meanMergedScore: mergedScore,
        meanDeterministicScore: mergedScore * 0.9,
        meanLlmScore: null,
        stdDevMergedScore: null,
        maxMergedScore: mergedScore,
        minMergedScore: mergedScore * 0.7,
      },
    });
  }

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
      isOos ? 0.55 : 0.60, isOos ? 15 : 25, null, metricsVal, now);
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

function seedPaperValidationTrade(db: Database.Database): void {
  const now = Date.now();
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposal_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange TEXT NOT NULL,
      tradingsymbol TEXT NOT NULL,
      instrument_token INTEGER,
      side TEXT NOT NULL,
      product TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL,
      trigger_price REAL,
      order_type TEXT NOT NULL DEFAULT 'MARKET',
      tag TEXT,
      proposal_status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS strategy_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_attempt_id INTEGER NOT NULL UNIQUE,
      decision_status TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      decided_at INTEGER NOT NULL,
      exchange TEXT NOT NULL,
      tradingsymbol TEXT NOT NULL,
      side TEXT NOT NULL,
      product TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL,
      trigger_price REAL,
      order_type TEXT NOT NULL,
      quote_last_price REAL,
      quote_bid REAL,
      quote_ask REAL,
      quote_volume INTEGER,
      quote_received_at INTEGER,
      risk_notional REAL,
      risk_sizing_basis TEXT NOT NULL DEFAULT '',
      risk_max_loss_rupees REAL,
      risk_stop_distance REAL,
      risk_stop_price REAL,
      risk_trailing_stop_distance REAL,
      risk_budget_rupees REAL,
      execution_class TEXT NOT NULL DEFAULT 'EQ',
      segment TEXT NOT NULL DEFAULT 'NSE',
      instrument_type TEXT NOT NULL DEFAULT 'EQ',
      expiry TEXT,
      strike REAL,
      lot_size INTEGER NOT NULL DEFAULT 1,
      tick_size REAL NOT NULL DEFAULT 0.05,
      freeze_quantity INTEGER
    );
    CREATE TABLE IF NOT EXISTS execution_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_decision_id INTEGER NOT NULL UNIQUE,
      execution_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      outcome_code TEXT,
      broker_order_id TEXT,
      message TEXT NOT NULL DEFAULT '',
      attempted_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS paper_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_attempt_id INTEGER NOT NULL,
      exchange TEXT NOT NULL,
      tradingsymbol TEXT NOT NULL,
      side TEXT NOT NULL,
      product TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL,
      order_type TEXT NOT NULL,
      status TEXT NOT NULL,
      broker_order_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paper_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_order_id INTEGER NOT NULL,
      execution_attempt_id INTEGER NOT NULL UNIQUE,
      exchange TEXT NOT NULL,
      tradingsymbol TEXT NOT NULL,
      side TEXT NOT NULL,
      product TEXT NOT NULL,
      filled_quantity INTEGER NOT NULL,
      filled_price REAL NOT NULL,
      broker_order_id TEXT NOT NULL,
      filled_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS position_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_order_id INTEGER NOT NULL,
      paper_fill_id INTEGER,
      execution_attempt_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      exchange TEXT NOT NULL,
      tradingsymbol TEXT NOT NULL,
      product TEXT NOT NULL,
      quantity_delta INTEGER NOT NULL,
      price REAL NOT NULL,
      previous_quantity INTEGER NOT NULL,
      previous_avg_cost REAL NOT NULL,
      new_quantity INTEGER NOT NULL,
      new_avg_cost REAL NOT NULL,
      realized_pnl REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO proposal_attempts
      (id, exchange, tradingsymbol, instrument_token, side, product, quantity, price, trigger_price, order_type, tag, proposal_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(9001, 'NSE', 'RELIANCE', null, 'buy', 'MIS', 1, null, null, 'MARKET', 'paper-validation', 'accepted', now);

  db.prepare(`
    INSERT INTO strategy_decisions
      (id, proposal_attempt_id, decision_status, strategy_id, strategy_version, decided_at, exchange, tradingsymbol, side, product, quantity, price, trigger_price, order_type,
       quote_last_price, quote_bid, quote_ask, quote_volume, quote_received_at,
       risk_notional, risk_sizing_basis, risk_max_loss_rupees, risk_stop_distance, risk_stop_price, risk_trailing_stop_distance, risk_budget_rupees,
       execution_class, segment, instrument_type, expiry, strike, lot_size, tick_size, freeze_quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(9001, 9001, 'approved', 'india-nse-eq-v1', '1.0.0', now, 'NSE', 'RELIANCE', 'buy', 'MIS', 1, null, null, 'MARKET', 100, 100, 101, 1000, now, 100, 'paper_validation', 1, 1, 99, 1, 1, 'EQ', 'NSE', 'EQ', null, null, 1, 0.05, null);

  db.prepare(`
    INSERT INTO execution_attempts
      (id, strategy_decision_id, execution_mode, status, outcome_code, broker_order_id, message, attempted_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(9001, 9001, 'paper', 'completed', 'paper_simulated', 'paper-9001', 'ok', now, now + 1000);

  db.prepare(`
    INSERT INTO paper_orders
      (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price, order_type, status, broker_order_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(9001, 9001, 'NSE', 'RELIANCE', 'buy', 'MIS', 1, 100, 'MARKET', 'filled', 'paper-9001', now);

  db.prepare(`
    INSERT INTO paper_fills
      (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product, filled_quantity, filled_price, broker_order_id, filled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(9001, 9001, 9001, 'NSE', 'RELIANCE', 'buy', 'MIS', 1, 100, 'paper-9001', now);

  db.prepare(`
    INSERT INTO position_events
      (id, paper_order_id, paper_fill_id, execution_attempt_id, event_type, exchange, tradingsymbol, product, quantity_delta, price, previous_quantity, previous_avg_cost, new_quantity, new_avg_cost, realized_pnl, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(9001, 9001, 9001, 9001, 'exit', 'NSE', 'RELIANCE', 'MIS', 0, 100, 1, 100, 0, 0, 250, now + 2000);
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
      db,
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

    // Without paper validation evidence, second evaluation must HOLD.
    const holdWithoutPaperEvidence = evaluator.evaluate({
      runId: 1,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
    });

    expect(holdWithoutPaperEvidence.verdict).toBe(GovernanceVerdict.Hold);
    expect(holdWithoutPaperEvidence.rationale).toContain('paper-trading validation evidence');

    seedPaperValidationTrade(db);

    // Evaluate again — now it should promote Paper → Live
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

    // 4th evaluation: already at Live → HOLD (no further promotion)
    const result3 = evaluator.evaluate({
      runId: 1,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
    });
    expect(result3.verdict).toBe(GovernanceVerdict.Hold);
    expect(result3.rationale).toContain('maximum lifecycle phase');

    // Should have 4 decisions in the log:
    // promote to paper, hold without paper evidence, promote to live, hold at max phase.
    expect(lifecycleRepo.decisionCount()).toBe(4);
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
        minReplayFidelity: 0, // relaxed — no metrics in seed data
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

  // -----------------------------------------------------------------------
  // Replay fidelity gate integration tests
  // -----------------------------------------------------------------------

  describe('replay fidelity gate', () => {
    it('should PROMOTE when full replay fidelity evidence is present', () => {
      // Seed with full-fidelity metrics_json
      const now = Date.now();
      const envelope = {
        schemaVersion: 1,
        source: 'replay-session',
        replayEvidence: {
          replaySessionId: 1,
          replayStatus: 'completed',
          replayLabel: 'Test session',
          replayRangeStart: now - 86400000,
          replayRangeEnd: now,
          replayCompletedTicks: 10,
          replayTotalTicks: 10,
          checkpointCount: 3,
          strategyRunCount: 5,
          firstStrategyRunId: 1,
          lastStrategyRunId: 5,
          topCandidateCount: 5,
          maxCandidates: 5,
          preCapCandidateCount: 5,
          llmStatusCounts: { consulted: 4, skipped: 1 },
          pluginErrorCount: 0,
          errorMessage: null,
        },
        summary: {
          tickCount: 10,
          meanMergedScore: 0.85,
          meanDeterministicScore: 0.77,
          meanLlmScore: null,
          stdDevMergedScore: null,
          maxMergedScore: 0.85,
          minMergedScore: 0.7,
        },
      };

      seedWinner(db, {
        mergedScore: 0.85,
        sharpeRatio: 1.5,
        maxDrawdown: -15,
        metricsJson: JSON.stringify(envelope),
      });

      const result = evaluator.evaluate({
        runId: 1,
        strategyId: 'india-nse-eq-v1',
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
      });

      expect(result.verdict).toBe(GovernanceVerdict.Promote);
      expect(result.evidenceSnapshot.replayFidelity).toBe(1.0);
      expect(result.evidenceSnapshot.hasReplayEvidence).toBe(true);
      expect(result.evidenceSnapshot.llmConsultationRate).toBe(0.8); // 4/5 consulted

      // Verify evidence persisted
      const persisted = JSON.parse(result.decision.evidenceJson!);
      expect(persisted.replayFidelity).toBe(1.0);
      expect(persisted.hasReplayEvidence).toBe(true);
    });

    it('should HOLD when replay fidelity is degraded by cap', () => {
      const now = Date.now();
      // Degraded cap: 2/5 = 0.4 fidelity
      const envelope = {
        schemaVersion: 1,
        source: 'replay-session',
        replayEvidence: {
          replaySessionId: 1,
          replayStatus: 'completed',
          replayLabel: 'Test session',
          replayRangeStart: now - 86400000,
          replayRangeEnd: now,
          replayCompletedTicks: 10,
          replayTotalTicks: 10,
          checkpointCount: 3,
          strategyRunCount: 5,
          firstStrategyRunId: 1,
          lastStrategyRunId: 5,
          topCandidateCount: 2,
          maxCandidates: 2,
          preCapCandidateCount: 5,
          llmStatusCounts: { consulted: 2, skipped: 0 },
          pluginErrorCount: 0,
          errorMessage: null,
        },
        summary: {
          tickCount: 10,
          meanMergedScore: 0.85,
          meanDeterministicScore: 0.77,
          meanLlmScore: null,
          stdDevMergedScore: null,
          maxMergedScore: 0.85,
          minMergedScore: 0.7,
        },
      };

      seedWinner(db, {
        mergedScore: 0.85,
        sharpeRatio: 1.5,
        maxDrawdown: -15,
        metricsJson: JSON.stringify(envelope),
      });

      const result = evaluator.evaluate({
        runId: 1,
        strategyId: 'india-nse-eq-v1',
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
      });

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('Replay fidelity');
      expect(result.rationale).toContain('0.40');
      expect(result.evidenceSnapshot.replayFidelity).toBe(0.4);
      expect(result.stateUpdated).toBe(false);
    });

    it('should HOLD when LLM consultation rate is zero during replay', () => {
      const now = Date.now();
      const envelope = {
        schemaVersion: 1,
        source: 'replay-session',
        replayEvidence: {
          replaySessionId: 1,
          replayStatus: 'completed',
          replayLabel: 'Test session',
          replayRangeStart: now - 86400000,
          replayRangeEnd: now,
          replayCompletedTicks: 10,
          replayTotalTicks: 10,
          checkpointCount: 3,
          strategyRunCount: 5,
          firstStrategyRunId: 1,
          lastStrategyRunId: 5,
          topCandidateCount: 5,
          maxCandidates: 5,
          preCapCandidateCount: 5,
          llmStatusCounts: { skipped: 5 }, // zero consulted
          pluginErrorCount: 0,
          errorMessage: null,
        },
        summary: {
          tickCount: 10,
          meanMergedScore: 0.85,
          meanDeterministicScore: 0.77,
          meanLlmScore: null,
          stdDevMergedScore: null,
          maxMergedScore: 0.85,
          minMergedScore: 0.7,
        },
      };

      seedWinner(db, {
        mergedScore: 0.85,
        sharpeRatio: 1.5,
        maxDrawdown: -15,
        metricsJson: JSON.stringify(envelope),
      });

      const result = evaluator.evaluate({
        runId: 1,
        strategyId: 'india-nse-eq-v1',
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
      });

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('LLM consultation rate is 0');
      expect(result.evidenceSnapshot.llmConsultationRate).toBe(0);
      expect(result.stateUpdated).toBe(false);
    });

    it('should HOLD on legacy null metrics (fail closed with default thresholds)', () => {
      // Legacy seed without metricsJson → null metrics
      seedWinner(db, {
        mergedScore: 0.85,
        sharpeRatio: 1.5,
        maxDrawdown: -15,
        metricsJson: null,
      });

      const result = evaluator.evaluate({
        runId: 1,
        strategyId: 'india-nse-eq-v1',
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
      });

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('No replay evidence available');
      expect(result.evidenceSnapshot.replayFidelity).toBeNull();
      expect(result.evidenceSnapshot.hasReplayEvidence).toBe(false);
    });

    it('should PROMOTE with legacy null metrics when minReplayFidelity is 0', () => {
      seedWinner(db, {
        mergedScore: 0.85,
        sharpeRatio: 1.5,
        maxDrawdown: -15,
        metricsJson: null,
      });

      const result = evaluator.evaluate({
        runId: 1,
        strategyId: 'india-nse-eq-v1',
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
        thresholds: {
          minMergedScore: 0.7,
          minSharpeRatio: 1.0,
          maxDrawdown: 30,
          minWindowCount: 2,
          minOutOfSampleWindows: 1,
          minReplayFidelity: 0,
        },
      });

      expect(result.verdict).toBe(GovernanceVerdict.Promote);
      expect(result.evidenceSnapshot.replayFidelity).toBeNull();
      expect(result.evidenceSnapshot.hasReplayEvidence).toBe(false);
    });
  });

  describe('FO promotion flow', () => {
    it('should PROMOTE FO strategy when all thresholds are met with FO market identity', () => {
      // Seed an FO-style winner run
      const now = Date.now();
      db.prepare(`
        INSERT INTO walk_forward_runs
          (id, label, strategy_id, strategy_version, market_id,
           replay_session_id, window_count, total_trials,
           status, created_at, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        100, 'fo-test-run', 'india-nse-fo-v1', '1.0.0', 'INDIA_NSE_FO',
        null, 4, 2, 'completed', now, null, null,
      );

      // Insert windows
      for (let i = 0; i < 4; i++) {
        const wType = i < 2 ? 'in_sample' : 'out_of_sample';
        db.prepare(`
          INSERT INTO walk_forward_windows (id, run_id, window_index, range_start, range_end, window_label, trial_count_optimized, trial_count_tested, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(100 + i, 100, i, now - (4 - i) * 86_400_000, now - (4 - i - 1) * 86_400_000, '', 0, 0, 'completed', now);
      }

      // Insert FO trial
      db.prepare(`
        INSERT INTO walk_forward_trials
          (id, run_id, trial_index, label, params_json, merged_score, deterministic_score,
           llm_score, llm_status, rank, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(100, 100, 0, 'Config A (FO 3 candidates)', JSON.stringify({ maxCandidates: 3 }),
        0.85, 0.85, null, 'skipped', 1, now);

      // Insert trial window evidence with full-fidelity metrics
      const metricsVal = JSON.stringify({
        schemaVersion: 1,
        source: 'replay-session',
        replayEvidence: {
          replaySessionId: 100,
          replayStatus: 'completed',
          replayLabel: 'FO test session',
          replayRangeStart: now - 86400000,
          replayRangeEnd: now,
          replayCompletedTicks: 10,
          replayTotalTicks: 10,
          checkpointCount: 3,
          strategyRunCount: 5,
          firstStrategyRunId: 1,
          lastStrategyRunId: 5,
          topCandidateCount: 3,
          maxCandidates: 3,
          preCapCandidateCount: 3,
          llmStatusCounts: { consulted: 3, skipped: 0 },
          pluginErrorCount: 0,
          errorMessage: null,
        },
        summary: {
          tickCount: 10,
          meanMergedScore: 0.85,
          meanDeterministicScore: 0.77,
          meanLlmScore: null,
          stdDevMergedScore: null,
          maxMergedScore: 0.85,
          minMergedScore: 0.7,
        },
      });

      for (let i = 0; i < 4; i++) {
        const wType = i < 2 ? WalkForwardWindowType.InSample : WalkForwardWindowType.OutOfSample;
        const isOos = wType === WalkForwardWindowType.OutOfSample;
        db.prepare(`
          INSERT INTO walk_forward_trial_windows
            (trial_id, window_id, window_type, total_return, sharpe_ratio, max_drawdown, win_rate, trade_count, profit_factor, metrics_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(100, 100 + i, wType, isOos ? 0.05 : 0.12,
          isOos ? 1.5 : 2.0, isOos ? -15 : -10,
          isOos ? 0.55 : 0.60, isOos ? 15 : 25, null, metricsVal, now);
      }

      // Insert FO winner
      db.prepare(`
        INSERT INTO walk_forward_winners
          (run_id, result, selected_trial_id, selection_strategy, selection_config_json, rationale, artifact_paths_json, selected_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(100, WalkForwardSelectionResult.Selected, 100,
        'composite', '{"strategy":"composite"}', 'All FO thresholds met', '[]', now, now);

      // Evaluate with FO identity
      const result = evaluator.evaluate({
        runId: 100,
        strategyId: 'india-nse-fo-v1',
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_FO',
      });

      expect(result.verdict).toBe(GovernanceVerdict.Promote);
      expect(result.previousPhase).toBe(StrategyLifecyclePhase.Backtest);
      expect(result.newPhase).toBe(StrategyLifecyclePhase.Paper);
      expect(result.stateUpdated).toBe(true);
      expect(result.evidenceSnapshot.replayFidelity).toBe(1.0);
      expect(result.evidenceSnapshot.hasReplayEvidence).toBe(true);

      // Verify FO lifecycle state was created
      const state = lifecycleRepo.getCurrentState(
        'india-nse-fo-v1', '1.0.0', 'INDIA_NSE_FO',
      );
      expect(state).not.toBeNull();
      expect(state.phase).toBe(StrategyLifecyclePhase.Paper);
    });

    it('should HOLD FO strategy when identity mismatch exists', () => {
      // Seed FO data within this test (each test gets a fresh DB from beforeEach)
      const now = Date.now();
      db.prepare(`
        INSERT INTO walk_forward_runs
          (id, label, strategy_id, strategy_version, market_id,
           replay_session_id, window_count, total_trials,
           status, created_at, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        200, 'fo-test-run-mismatch', 'india-nse-fo-v1', '1.0.0', 'INDIA_NSE_FO',
        null, 2, 1, 'completed', now, null, null,
      );

      // Insert windows
      for (let i = 0; i < 2; i++) {
        db.prepare(`
          INSERT INTO walk_forward_windows (id, run_id, window_index, range_start, range_end, window_label, trial_count_optimized, trial_count_tested, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(200 + i, 200, i, now - (2 - i) * 86_400_000, now - (2 - i - 1) * 86_400_000, '', 0, 0, 'completed', now);
      }

      // Insert FO trial
      db.prepare(`
        INSERT INTO walk_forward_trials
          (id, run_id, trial_index, label, params_json, merged_score, deterministic_score,
           llm_score, llm_status, rank, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(200, 200, 0, 'Config A (FO)', JSON.stringify({ maxCandidates: 3 }),
        0.85, 0.85, null, 'skipped', 1, now);

      // Insert FO winner
      db.prepare(`
        INSERT INTO walk_forward_winners
          (run_id, result, selected_trial_id, selection_strategy, selection_config_json, rationale, artifact_paths_json, selected_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(200, WalkForwardSelectionResult.Selected, 200,
        'composite', '{"strategy":"composite"}', 'All FO thresholds met', '[]', now, now);

      // Query with EQ market — market ID mismatch with run's FO market
      const result = evaluator.evaluate({
        runId: 200,
        strategyId: 'india-nse-fo-v1',
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ', // EQ market — mismatch with run's FO market
      });

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('does not match target');
      expect(result.stateUpdated).toBe(false);
    });
  });
});
