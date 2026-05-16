// ── WalkForwardRepository ──
// Append/read of walk-forward runs, windows, trials, and trial-window evidence.
// Follows the same patterns as ReplaySessionRepository and StrategyRunRepository.

import type Database from 'better-sqlite3';
import {
  type WalkForwardRunRow,
  type NewWalkForwardRun,
  type WalkForwardCheckpointRow,
  type NewWalkForwardCheckpoint,
  type WalkForwardWindowRow,
  type NewWalkForwardWindow,
  type WalkForwardTrialRow,
  type NewWalkForwardTrial,
  type WalkForwardTrialWindowRow,
  type NewWalkForwardTrialWindow,
  type WalkForwardRunWithWindows,
  type WalkForwardTrialWithWindows,
  type WalkForwardRankedCandidate,
  type WalkForwardWinnerRow,
  type NewWalkForwardWinner,
  type WalkForwardWinnerWithContext,
  WalkForwardStatus,
  WalkForwardWindowStatus,
  WalkForwardSelectionResult,
  WalkForwardSelectionStrategy,
} from '../replay/walk-forward-types.js';

// ---------------------------------------------------------------------------
// Row shapes from SQLite (snake_case → camelCase mapping)
// ---------------------------------------------------------------------------

interface WalkForwardRunDbRow {
  id: number;
  label: string;
  strategy_id: string;
  strategy_version: string;
  market_id: string;
  replay_session_id: number | null;
  window_count: number;
  total_trials: number;
  status: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

interface WalkForwardWindowDbRow {
  id: number;
  run_id: number;
  window_index: number;
  range_start: number;
  range_end: number;
  window_label: string;
  trial_count_optimized: number;
  trial_count_tested: number;
  status: string;
  created_at: number;
}

interface WalkForwardTrialDbRow {
  id: number;
  run_id: number;
  trial_index: number;
  label: string;
  params_json: string;
  merged_score: number;
  deterministic_score: number;
  llm_score: number | null;
  llm_status: string | null;
  rank: number;
  created_at: number;
}

interface WalkForwardTrialWindowDbRow {
  id: number;
  trial_id: number;
  window_id: number;
  window_type: string;
  total_return: number;
  sharpe_ratio: number | null;
  max_drawdown: number | null;
  win_rate: number | null;
  trade_count: number;
  profit_factor: number | null;
  metrics_json: string | null;
  created_at: number;
}

interface WalkForwardCheckpointDbRow {
  id: number;
  run_id: number;
  completed_trial_count: number;
  last_completed_trial_index: number | null;
  metadata_json: string | null;
  saved_at: number;
}

interface CountRow {
  cnt: number;
}

interface WalkForwardWinnerDbRow {
  id: number;
  run_id: number;
  result: string;
  selected_trial_id: number | null;
  selection_strategy: string;
  selection_config_json: string;
  rationale: string;
  artifact_paths_json: string | null;
  selected_at: number;
  created_at: number;
}

interface WalkForwardWinnerWithRunDbRow extends WalkForwardWinnerDbRow {
  run_label: string;
  run_strategy_id: string;
  run_strategy_version: string;
  run_market_id: string;
  run_replay_session_id: number | null;
  run_window_count: number;
  run_total_trials: number;
  run_status: string;
  run_created_at: number;
  run_started_at: number | null;
  run_completed_at: number | null;
}

// ---------------------------------------------------------------------------
// WalkForwardRepository
// ---------------------------------------------------------------------------

export class WalkForwardRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  // -----------------------------------------------------------------------
  // Run CRUD
  // -----------------------------------------------------------------------

  /**
   * Create a new walk-forward run. Returns the full row with auto-generated id.
   */
  insertRun(run: NewWalkForwardRun): WalkForwardRunRow {
    const result = this._db.prepare(`
      INSERT INTO walk_forward_runs
        (label, strategy_id, strategy_version, market_id,
         replay_session_id, window_count, total_trials,
         status, created_at, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.label,
      run.strategyId,
      run.strategyVersion,
      run.marketId,
      run.replaySessionId,
      run.windowCount,
      run.totalTrials,
      run.status,
      run.createdAt,
      run.startedAt,
      run.completedAt,
    );

    const id = Number(result.lastInsertRowid);
    return this.getRun(id)!;
  }

  /**
   * Retrieve a walk-forward run by id. Returns null when the run does not exist.
   */
  getRun(id: number): WalkForwardRunRow | null {
    const row = this._db.prepare(`
      SELECT id, label, strategy_id, strategy_version, market_id,
             replay_session_id, window_count, total_trials,
             status, created_at, started_at, completed_at
      FROM walk_forward_runs
      WHERE id = ?
    `).get(id) as WalkForwardRunDbRow | undefined;

    return row ? this._mapRunRow(row) : null;
  }

  /**
   * Update fields on an existing walk-forward run.
   */
  updateRun(
    id: number,
    updates: Partial<Pick<WalkForwardRunRow, 'status' | 'totalTrials' | 'startedAt' | 'completedAt'>>,
  ): WalkForwardRunRow | null {
    const existing = this.getRun(id);
    if (!existing) return null;

    this._db.prepare(`
      UPDATE walk_forward_runs
      SET status = ?,
          total_trials = ?,
          started_at = ?,
          completed_at = ?
      WHERE id = ?
    `).run(
      updates.status ?? existing.status,
      updates.totalTrials ?? existing.totalTrials,
      updates.startedAt !== undefined ? updates.startedAt : existing.startedAt,
      updates.completedAt !== undefined ? updates.completedAt : existing.completedAt,
      id,
    );

    return this.getRun(id);
  }

  /**
   * Mark a run as started.
   */
  markStarted(id: number, startedAt: number): WalkForwardRunRow | null {
    return this.updateRun(id, {
      status: WalkForwardStatus.Running,
      startedAt,
    });
  }

  /**
   * Mark a run as completed.
   */
  markCompleted(id: number, completedAt: number): WalkForwardRunRow | null {
    return this.updateRun(id, {
      status: WalkForwardStatus.Completed,
      completedAt,
    });
  }

  /**
   * Mark a run as failed.
   */
  markFailed(id: number, completedAt: number): WalkForwardRunRow | null {
    return this.updateRun(id, {
      status: WalkForwardStatus.Failed,
      completedAt,
    });
  }

  /**
   * Mark a run as interrupted.
   */
  markInterrupted(id: number, completedAt: number = Date.now()): WalkForwardRunRow | null {
    return this.updateRun(id, {
      status: WalkForwardStatus.Interrupted,
      completedAt,
    });
  }

  /**
   * List all walk-forward runs, newest first.
   */
  listRuns(limit: number = 20): WalkForwardRunRow[] {
    const rows = this._db.prepare(`
      SELECT id, label, strategy_id, strategy_version, market_id,
             replay_session_id, window_count, total_trials,
             status, created_at, started_at, completed_at
      FROM walk_forward_runs
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as WalkForwardRunDbRow[];

    return rows.map(this._mapRunRow);
  }

  /** Count total walk-forward runs. */
  countRuns(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM walk_forward_runs').get() as CountRow;
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Window CRUD
  // -----------------------------------------------------------------------

  /**
   * Insert a window into a walk-forward run. Returns the full row with auto-generated id.
   */
  insertWindow(window: NewWalkForwardWindow): WalkForwardWindowRow {
    const result = this._db.prepare(`
      INSERT INTO walk_forward_windows
        (run_id, window_index, range_start, range_end, window_label,
         trial_count_optimized, trial_count_tested, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      window.runId,
      window.windowIndex,
      window.rangeStart,
      window.rangeEnd,
      window.windowLabel,
      window.trialCountOptimized,
      window.trialCountTested,
      window.status,
      window.createdAt,
    );

    const id = Number(result.lastInsertRowid);
    return this._getWindow(id)!;
  }

  /**
   * Get a window by id. Returns null when the window does not exist.
   */
  getWindow(id: number): WalkForwardWindowRow | null {
    return this._getWindow(id);
  }

  /**
   * Get all windows for a run, ordered by window_index ascending.
   */
  getWindowsForRun(runId: number): WalkForwardWindowRow[] {
    const rows = this._db.prepare(`
      SELECT id, run_id, window_index, range_start, range_end, window_label,
             trial_count_optimized, trial_count_tested, status, created_at
      FROM walk_forward_windows
      WHERE run_id = ?
      ORDER BY window_index ASC
    `).all(runId) as WalkForwardWindowDbRow[];

    return rows.map(this._mapWindowRow);
  }

  /**
   * Update a window's status and trial counts.
   */
  updateWindow(
    id: number,
    updates: Partial<Pick<WalkForwardWindowRow, 'status' | 'trialCountOptimized' | 'trialCountTested'>>,
  ): WalkForwardWindowRow | null {
    const existing = this.getWindow(id);
    if (!existing) return null;

    this._db.prepare(`
      UPDATE walk_forward_windows
      SET status = ?,
          trial_count_optimized = ?,
          trial_count_tested = ?
      WHERE id = ?
    `).run(
      updates.status ?? existing.status,
      updates.trialCountOptimized ?? existing.trialCountOptimized,
      updates.trialCountTested ?? existing.trialCountTested,
      id,
    );

    return this._getWindow(id);
  }

  /**
   * Mark a window as completed.
   */
  markWindowCompleted(id: number): WalkForwardWindowRow | null {
    return this.updateWindow(id, { status: WalkForwardWindowStatus.Completed });
  }

  /** Count total windows across all runs. */
  countWindows(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM walk_forward_windows').get() as CountRow;
    return row.cnt;
  }

  /** Count windows for a specific run. */
  countWindowsForRun(runId: number): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM walk_forward_windows WHERE run_id = ?',
    ).get(runId) as CountRow;
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Trial CRUD
  // -----------------------------------------------------------------------

  /**
   * Insert a trial into a walk-forward run. Returns the full row with auto-generated id.
   */
  insertTrial(trial: NewWalkForwardTrial): WalkForwardTrialRow {
    const result = this._db.prepare(`
      INSERT INTO walk_forward_trials
        (run_id, trial_index, label, params_json,
         merged_score, deterministic_score, llm_score, llm_status,
         rank, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trial.runId,
      trial.trialIndex,
      trial.label,
      trial.paramsJson,
      trial.mergedScore,
      trial.deterministicScore,
      trial.llmScore,
      trial.llmStatus,
      trial.rank,
      trial.createdAt,
    );

    const id = Number(result.lastInsertRowid);
    return this._getTrial(id)!;
  }

  /**
   * Get a trial by id. Returns null when the trial does not exist.
   */
  getTrial(id: number): WalkForwardTrialRow | null {
    return this._getTrial(id);
  }

  /**
   * Get all trials for a run, ordered by rank ascending (best first).
   */
  getTrialsForRun(runId: number): WalkForwardTrialRow[] {
    const rows = this._db.prepare(`
      SELECT id, run_id, trial_index, label, params_json,
             merged_score, deterministic_score, llm_score, llm_status,
             rank, created_at
      FROM walk_forward_trials
      WHERE run_id = ?
      ORDER BY rank ASC
    `).all(runId) as WalkForwardTrialDbRow[];

    return rows.map(this._mapTrialRow);
  }

  /**
   * Get all trials for a run, ordered by trial_index ascending.
   */
  getTrialsForRunByIndex(runId: number): WalkForwardTrialRow[] {
    const rows = this._db.prepare(`
      SELECT id, run_id, trial_index, label, params_json,
             merged_score, deterministic_score, llm_score, llm_status,
             rank, created_at
      FROM walk_forward_trials
      WHERE run_id = ?
      ORDER BY trial_index ASC
    `).all(runId) as WalkForwardTrialDbRow[];

    return rows.map(this._mapTrialRow);
  }

  /**
   * Get a specific persisted trial by its parent run and trial index.
   */
  getTrialForRunByIndex(runId: number, trialIndex: number): WalkForwardTrialRow | null {
    const row = this._db.prepare(`
      SELECT id, run_id, trial_index, label, params_json,
             merged_score, deterministic_score, llm_score, llm_status,
             rank, created_at
      FROM walk_forward_trials
      WHERE run_id = ? AND trial_index = ?
      LIMIT 1
    `).get(runId, trialIndex) as WalkForwardTrialDbRow | undefined;

    return row ? this._mapTrialRow(row) : null;
  }

  /**
   * Get ranked candidates for a run — a read-model view of trials with
   * their window evidence count, ordered by rank (best first).
   */
  getRankedCandidates(runId: number, limit: number = 50): WalkForwardRankedCandidate[] {
    const rows = this._db.prepare(`
      SELECT
        t.id AS trial_id,
        t.rank AS rank,
        t.label AS label,
        t.params_json AS params_json,
        t.merged_score AS merged_score,
        t.deterministic_score AS deterministic_score,
        t.llm_score AS llm_score,
        (SELECT COUNT(*) FROM walk_forward_trial_windows tw WHERE tw.trial_id = t.id) AS window_count
      FROM walk_forward_trials t
      WHERE t.run_id = ?
      ORDER BY t.rank ASC
      LIMIT ?
    `).all(runId, limit) as Array<{
      trial_id: number;
      rank: number;
      label: string;
      params_json: string;
      merged_score: number;
      deterministic_score: number;
      llm_score: number | null;
      window_count: number;
    }>;

    return rows.map(r => ({
      trialId: r.trial_id,
      rank: r.rank,
      label: r.label,
      paramsJson: r.params_json,
      mergedScore: r.merged_score,
      deterministicScore: r.deterministic_score,
      llmScore: r.llm_score,
      windowCount: r.window_count,
    }));
  }

  /**
   * Update a trial's rank and scores (e.g. after re-ranking).
   */
  updateTrial(
    id: number,
    updates: Partial<Pick<WalkForwardTrialRow, 'rank' | 'mergedScore' | 'deterministicScore' | 'llmScore' | 'llmStatus'>>,
  ): WalkForwardTrialRow | null {
    const existing = this.getTrial(id);
    if (!existing) return null;

    this._db.prepare(`
      UPDATE walk_forward_trials
      SET rank = ?,
          merged_score = ?,
          deterministic_score = ?,
          llm_score = ?,
          llm_status = ?
      WHERE id = ?
    `).run(
      updates.rank ?? existing.rank,
      updates.mergedScore ?? existing.mergedScore,
      updates.deterministicScore ?? existing.deterministicScore,
      updates.llmScore !== undefined ? updates.llmScore : existing.llmScore,
      updates.llmStatus !== undefined ? updates.llmStatus : existing.llmStatus,
      id,
    );

    return this._getTrial(id);
  }

  /** Count total trials across all runs. */
  countTrials(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM walk_forward_trials').get() as CountRow;
    return row.cnt;
  }

  /** Count trials for a specific run. */
  countTrialsForRun(runId: number): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM walk_forward_trials WHERE run_id = ?',
    ).get(runId) as CountRow;
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Trial-Window evidence CRUD
  // -----------------------------------------------------------------------

  /**
   * Link a trial to a window with per-window evaluation metrics.
   * Returns the full row with auto-generated id.
   */
  linkTrialToWindow(evidence: NewWalkForwardTrialWindow): WalkForwardTrialWindowRow {
    const result = this._db.prepare(`
      INSERT INTO walk_forward_trial_windows
        (trial_id, window_id, window_type,
         total_return, sharpe_ratio, max_drawdown, win_rate,
         trade_count, profit_factor, metrics_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evidence.trialId,
      evidence.windowId,
      evidence.windowType,
      evidence.totalReturn,
      evidence.sharpeRatio,
      evidence.maxDrawdown,
      evidence.winRate,
      evidence.tradeCount,
      evidence.profitFactor,
      evidence.metricsJson,
      evidence.createdAt,
    );

    const id = Number(result.lastInsertRowid);
    return this._getTrialWindow(id)!;
  }

  /**
   * Get all trial-window evidence for a specific trial, ordered by
   * window index ascending (via join to walk_forward_windows).
   */
  getTrialWindowEvidence(trialId: number): WalkForwardTrialWindowRow[] {
    const rows = this._db.prepare(`
      SELECT tw.id, tw.trial_id, tw.window_id, tw.window_type,
             tw.total_return, tw.sharpe_ratio, tw.max_drawdown, tw.win_rate,
             tw.trade_count, tw.profit_factor, tw.metrics_json, tw.created_at
      FROM walk_forward_trial_windows tw
      INNER JOIN walk_forward_windows w ON w.id = tw.window_id
      WHERE tw.trial_id = ?
      ORDER BY w.window_index ASC
    `).all(trialId) as WalkForwardTrialWindowDbRow[];

    return rows.map(this._mapTrialWindowRow);
  }

  /**
   * Get all trial-window evidence for a specific window.
   */
  getWindowEvidence(windowId: number): WalkForwardTrialWindowRow[] {
    const rows = this._db.prepare(`
      SELECT id, trial_id, window_id, window_type,
             total_return, sharpe_ratio, max_drawdown, win_rate,
             trade_count, profit_factor, metrics_json, created_at
      FROM walk_forward_trial_windows
      WHERE window_id = ?
      ORDER BY id ASC
    `).all(windowId) as WalkForwardTrialWindowDbRow[];

    return rows.map(this._mapTrialWindowRow);
  }

  /** Count total trial-window evidence rows across all runs. */
  countTrialWindowEvidence(): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM walk_forward_trial_windows',
    ).get() as CountRow;
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Checkpoint CRUD
  // -----------------------------------------------------------------------

  /**
   * Save an append-only checkpoint for a walk-forward run.
   */
  saveCheckpoint(checkpoint: NewWalkForwardCheckpoint): WalkForwardCheckpointRow {
    const result = this._db.prepare(`
      INSERT INTO walk_forward_checkpoints
        (run_id, completed_trial_count, last_completed_trial_index, metadata_json, saved_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      checkpoint.runId,
      checkpoint.completedTrialCount,
      checkpoint.lastCompletedTrialIndex,
      checkpoint.metadataJson,
      checkpoint.savedAt,
    );

    const id = Number(result.lastInsertRowid);
    return this._getCheckpoint(id)!;
  }

  /**
   * Get the latest checkpoint for a run.
   */
  getLatestCheckpoint(runId: number): WalkForwardCheckpointRow | null {
    const row = this._db.prepare(`
      SELECT id, run_id, completed_trial_count, last_completed_trial_index,
             metadata_json, saved_at
      FROM walk_forward_checkpoints
      WHERE run_id = ?
      ORDER BY saved_at DESC, id DESC
      LIMIT 1
    `).get(runId) as WalkForwardCheckpointDbRow | undefined;

    return row ? this._mapCheckpointRow(row) : null;
  }

  /**
   * Get all checkpoints for a run in chronological order.
   */
  getCheckpointsForRun(runId: number): WalkForwardCheckpointRow[] {
    const rows = this._db.prepare(`
      SELECT id, run_id, completed_trial_count, last_completed_trial_index,
             metadata_json, saved_at
      FROM walk_forward_checkpoints
      WHERE run_id = ?
      ORDER BY saved_at ASC, id ASC
    `).all(runId) as WalkForwardCheckpointDbRow[];

    return rows.map(this._mapCheckpointRow);
  }

  /** Count checkpoints for a run. */
  countCheckpoints(runId: number): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM walk_forward_checkpoints WHERE run_id = ?',
    ).get(runId) as CountRow;
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Joined read models
  // -----------------------------------------------------------------------

  /**
   * Retrieve a walk-forward run with its ordered windows.
   * Returns null when the run does not exist.
   */
  getRunWithWindows(id: number): WalkForwardRunWithWindows | null {
    const run = this.getRun(id);
    if (!run) return null;

    return {
      ...run,
      windows: this.getWindowsForRun(id),
    };
  }

  /**
   * Retrieve a walk-forward trial with its per-window evidence.
   * Returns null when the trial does not exist.
   */
  getTrialWithWindows(trialId: number): WalkForwardTrialWithWindows | null {
    const trial = this.getTrial(trialId);
    if (!trial) return null;

    return {
      ...trial,
      windowEvidence: this.getTrialWindowEvidence(trialId),
    };
  }

  /**
   * Atomically insert a run with its windows and trials.
   *
   * Insert runs as pending; then windows and trials are inserted as provided.
   * If any step fails, the entire transaction rolls back.
   */
  insertRunWithWindowsAndTrials(
    run: NewWalkForwardRun,
    windows: NewWalkForwardWindow[],
    trials: NewWalkForwardTrial[],
    trialWindows: NewWalkForwardTrialWindow[],
  ): WalkForwardRunWithWindows {
    const tx = this._db.transaction(() => {
      const runRow = this.insertRun(run);

      const insertedWindows: WalkForwardWindowRow[] = [];
      for (const w of windows) {
        insertedWindows.push(this.insertWindow({ ...w, runId: runRow.id }));
      }

      const insertedTrials: WalkForwardTrialRow[] = [];
      for (const t of trials) {
        insertedTrials.push(this.insertTrial({ ...t, runId: runRow.id }));
      }

      // Build a map from (trial_index, window_index) to actual (trial_id, window_id)
      const trialMap = new Map<number, number>();
      for (const t of insertedTrials) {
        trialMap.set(t.trialIndex, t.id);
      }
      const windowMap = new Map<number, number>();
      for (const w of insertedWindows) {
        windowMap.set(w.windowIndex, w.id);
      }

      for (const tw of trialWindows) {
        const actualTrialId = trialMap.get(tw.trialId);
        const actualWindowId = windowMap.get(tw.windowId);
        if (actualTrialId === undefined) {
          throw new Error(`Trial index ${tw.trialId} not found in inserted trials`);
        }
        if (actualWindowId === undefined) {
          throw new Error(`Window index ${tw.windowId} not found in inserted windows`);
        }
        this.linkTrialToWindow({
          ...tw,
          trialId: actualTrialId,
          windowId: actualWindowId,
        });
      }

      return this.getRunWithWindows(runRow.id)!;
    });

    return tx();
  }

  // -----------------------------------------------------------------------
  // Winner-selection CRUD
  // -----------------------------------------------------------------------

  /**
   * Persist a winner-selection decision for a walk-forward run.
   *
   * Only one winner row per run is permitted (UNIQUE constraint on run_id).
   * When no trial met the selection criteria, set selectedTrialId to null
   * and result to 'no_winner'.
   *
   * Returns the full row with auto-generated id and createdAt.
   *
   * @throws When a winner row for this run already exists.
   */
  insertWinner(winner: NewWalkForwardWinner): WalkForwardWinnerRow {
    const result = this._db.prepare(`
      INSERT INTO walk_forward_winners
        (run_id, result, selected_trial_id, selection_strategy,
         selection_config_json, rationale, artifact_paths_json,
         selected_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      winner.runId,
      winner.result,
      winner.selectedTrialId,
      winner.selectionStrategy,
      winner.selectionConfigJson,
      winner.rationale,
      winner.artifactPathsJson,
      winner.selectedAt,
      winner.selectedAt, // created_at = selectedAt for selection rows
    );

    const id = Number(result.lastInsertRowid);
    return this._getWinner(id)!;
  }

  /**
   * Get a winner-selection row by its id. Returns null when it does not exist.
   */
  getWinner(id: number): WalkForwardWinnerRow | null {
    return this._getWinner(id);
  }

  /**
   * Get the winner-selection for a specific run, or null when no winner
   * decision has been persisted for that run.
   */
  getWinnerForRun(runId: number): WalkForwardWinnerRow | null {
    const row = this._db.prepare(`
      SELECT id, run_id, result, selected_trial_id, selection_strategy,
             selection_config_json, rationale, artifact_paths_json,
             selected_at, created_at
      FROM walk_forward_winners
      WHERE run_id = ?
    `).get(runId) as WalkForwardWinnerDbRow | undefined;

    return row ? this._mapWinnerRow(row) : null;
  }

  /**
   * Retrieve a winner with its full run context and (optionally) the selected
   * trial with per-window evidence, plus the ranked candidate list at
   * selection time.
   *
   * This is the primary read model for M006 promotion governance. When the
   * winner result is 'no_winner', selectedTrial is null.
   *
   * Returns null when no winner decision exists for the given run.
   */
  getWinnerWithContext(runId: number): WalkForwardWinnerWithContext | null {
    const winner = this.getWinnerForRun(runId);
    if (!winner) return null;

    const run = this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} exists in winners but not in walk_forward_runs`);

    let selectedTrial: WalkForwardTrialWithWindows | null = null;
    if (winner.selectedTrialId !== null) {
      selectedTrial = this.getTrialWithWindows(winner.selectedTrialId);
    }

    const rankedCandidates = this.getRankedCandidates(runId);

    return {
      ...winner,
      run,
      selectedTrial,
      rankedCandidates,
    };
  }

  /**
   * Count total winner-selection rows across all runs.
   */
  countWinners(): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM walk_forward_winners',
    ).get() as CountRow;
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private _getCheckpoint(id: number): WalkForwardCheckpointRow | null {
    const row = this._db.prepare(`
      SELECT id, run_id, completed_trial_count, last_completed_trial_index,
             metadata_json, saved_at
      FROM walk_forward_checkpoints
      WHERE id = ?
    `).get(id) as WalkForwardCheckpointDbRow | undefined;

    return row ? this._mapCheckpointRow(row) : null;
  }

  private _getWindow(id: number): WalkForwardWindowRow | null {
    const row = this._db.prepare(`
      SELECT id, run_id, window_index, range_start, range_end, window_label,
             trial_count_optimized, trial_count_tested, status, created_at
      FROM walk_forward_windows
      WHERE id = ?
    `).get(id) as WalkForwardWindowDbRow | undefined;

    return row ? this._mapWindowRow(row) : null;
  }

  private _getTrial(id: number): WalkForwardTrialRow | null {
    const row = this._db.prepare(`
      SELECT id, run_id, trial_index, label, params_json,
             merged_score, deterministic_score, llm_score, llm_status,
             rank, created_at
      FROM walk_forward_trials
      WHERE id = ?
    `).get(id) as WalkForwardTrialDbRow | undefined;

    return row ? this._mapTrialRow(row) : null;
  }

  private _getTrialWindow(id: number): WalkForwardTrialWindowRow | null {
    const row = this._db.prepare(`
      SELECT id, trial_id, window_id, window_type,
             total_return, sharpe_ratio, max_drawdown, win_rate,
             trade_count, profit_factor, metrics_json, created_at
      FROM walk_forward_trial_windows
      WHERE id = ?
    `).get(id) as WalkForwardTrialWindowDbRow | undefined;

    return row ? this._mapTrialWindowRow(row) : null;
  }

  private _mapRunRow(row: WalkForwardRunDbRow): WalkForwardRunRow {
    return {
      id: row.id,
      label: row.label,
      strategyId: row.strategy_id,
      strategyVersion: row.strategy_version,
      marketId: row.market_id,
      replaySessionId: row.replay_session_id,
      windowCount: row.window_count,
      totalTrials: row.total_trials,
      status: row.status as WalkForwardStatus,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  private _mapCheckpointRow(row: WalkForwardCheckpointDbRow): WalkForwardCheckpointRow {
    return {
      id: row.id,
      runId: row.run_id,
      completedTrialCount: row.completed_trial_count,
      lastCompletedTrialIndex: row.last_completed_trial_index,
      metadataJson: row.metadata_json,
      savedAt: row.saved_at,
    };
  }

  private _mapWindowRow(row: WalkForwardWindowDbRow): WalkForwardWindowRow {
    return {
      id: row.id,
      runId: row.run_id,
      windowIndex: row.window_index,
      rangeStart: row.range_start,
      rangeEnd: row.range_end,
      windowLabel: row.window_label,
      trialCountOptimized: row.trial_count_optimized,
      trialCountTested: row.trial_count_tested,
      status: row.status as WalkForwardWindowStatus,
      createdAt: row.created_at,
    };
  }

  private _mapTrialRow(row: WalkForwardTrialDbRow): WalkForwardTrialRow {
    return {
      id: row.id,
      runId: row.run_id,
      trialIndex: row.trial_index,
      label: row.label,
      paramsJson: row.params_json,
      mergedScore: row.merged_score,
      deterministicScore: row.deterministic_score,
      llmScore: row.llm_score,
      llmStatus: row.llm_status,
      rank: row.rank,
      createdAt: row.created_at,
    };
  }

  private _mapTrialWindowRow(row: WalkForwardTrialWindowDbRow): WalkForwardTrialWindowRow {
    return {
      id: row.id,
      trialId: row.trial_id,
      windowId: row.window_id,
      windowType: row.window_type as any,
      totalReturn: row.total_return,
      sharpeRatio: row.sharpe_ratio,
      maxDrawdown: row.max_drawdown,
      winRate: row.win_rate,
      tradeCount: row.trade_count,
      profitFactor: row.profit_factor,
      metricsJson: row.metrics_json,
      createdAt: row.created_at,
    };
  }

  private _getWinner(id: number): WalkForwardWinnerRow | null {
    const row = this._db.prepare(`
      SELECT id, run_id, result, selected_trial_id, selection_strategy,
             selection_config_json, rationale, artifact_paths_json,
             selected_at, created_at
      FROM walk_forward_winners
      WHERE id = ?
    `).get(id) as WalkForwardWinnerDbRow | undefined;

    return row ? this._mapWinnerRow(row) : null;
  }

  private _mapWinnerRow(row: WalkForwardWinnerDbRow): WalkForwardWinnerRow {
    return {
      id: row.id,
      runId: row.run_id,
      result: row.result as WalkForwardSelectionResult,
      selectedTrialId: row.selected_trial_id,
      selectionStrategy: row.selection_strategy as WalkForwardSelectionStrategy,
      selectionConfigJson: row.selection_config_json,
      rationale: row.rationale,
      artifactPathsJson: row.artifact_paths_json,
      selectedAt: row.selected_at,
      createdAt: row.created_at,
    };
  }
}
