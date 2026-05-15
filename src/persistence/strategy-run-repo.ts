import type Database from 'better-sqlite3';
import {
  type StrategyRunRow,
  type NewStrategyRun,
  type StrategyRunCandidateRow,
  type NewStrategyRunCandidate,
  type StrategyRunWithCandidates,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Row shapes from SQLite (snake_case → camelCase mapping)
// ---------------------------------------------------------------------------

interface StrategyRunDbRow {
  id: number;
  framework_config: string;
  plugins_json: string;
  plugin_errors_json: string | null;
  universe_snapshot_id: number | null;
  total_evaluated: number;
  has_plugin_errors: number;
  duration_ms: number;
  created_at: number;
}

interface StrategyRunCandidateDbRow {
  id: number;
  strategy_run_id: number;
  candidate_key: string;
  rank: number;
  exchange: string;
  tradingsymbol: string;
  instrument_token: number | null;
  instrument_type: string;
  lot_size: number;
  tick_size: number;
  side: string;
  last_price: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  scores_json: string;
  deterministic_score: number;
  llm_score: number | null;
  llm_status: string | null;
  llm_rationale: string | null;
  merged_score: number;
  merge_policy: string | null;
  proposal_params_json: string | null;
  plugin_errors_json: string | null;
  has_plugin_errors: number;
  emitted: number;
  proposal_attempt_id: number | null;
}

// ---------------------------------------------------------------------------
// StrategyRunRepository — append-only persistence for screening round artifacts
// ---------------------------------------------------------------------------

export class StrategyRunRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  /**
   * Insert a strategy run together with its candidate rows in a single atomic
   * transaction.
   *
   * Returns the full run row with auto-generated id and candidate rows with
   * their assigned ids, all in a single joined artifact.
   *
   * If any candidate insert fails (FK violation, constraint), the entire
   * transaction rolls back — no orphaned run rows.
   */
  insertRunWithCandidates(
    run: NewStrategyRun,
    candidates: NewStrategyRunCandidate[],
  ): StrategyRunWithCandidates {
    const tx = this._db.transaction(() => {
      // 1. Insert the parent run row
      const runResult = this._db.prepare(`
        INSERT INTO strategy_runs
          (framework_config, plugins_json, plugin_errors_json,
           universe_snapshot_id, total_evaluated, has_plugin_errors,
           duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.frameworkConfig,
        run.pluginsJson,
        run.pluginErrorsJson,
        run.universeSnapshotId,
        run.totalEvaluated,
        run.hasPluginErrors ? 1 : 0,
        run.durationMs,
        run.createdAt,
      );

      const runId = Number(runResult.lastInsertRowid);

      // 2. Insert each candidate row, assigning the parent run id
      const candidateStmt = this._db.prepare(`
        INSERT INTO strategy_run_candidates
          (strategy_run_id, candidate_key, rank,
           exchange, tradingsymbol, instrument_token, instrument_type,
           lot_size, tick_size, side,
           last_price, bid, ask, volume,
           scores_json, deterministic_score,
           llm_score, llm_status, llm_rationale,
           merged_score, merge_policy,
           proposal_params_json, plugin_errors_json,
           has_plugin_errors, emitted, proposal_attempt_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertedCandidates: StrategyRunCandidateRow[] = [];

      for (const c of candidates) {
        const cr = candidateStmt.run(
          runId,
          c.candidateKey,
          c.rank,
          c.exchange,
          c.tradingsymbol,
          c.instrumentToken,
          c.instrumentType,
          c.lotSize,
          c.tickSize,
          c.side,
          c.lastPrice,
          c.bid,
          c.ask,
          c.volume,
          c.scoresJson,
          c.deterministicScore,
          c.llmScore,
          c.llmStatus,
          c.llmRationale,
          c.mergedScore,
          c.mergePolicy,
          c.proposalParamsJson,
          c.pluginErrorsJson,
          c.hasPluginErrors ? 1 : 0,
          c.emitted ? 1 : 0,
          c.proposalAttemptId,
        );

        insertedCandidates.push({
          id: Number(cr.lastInsertRowid),
          strategyRunId: runId,
          candidateKey: c.candidateKey,
          rank: c.rank,
          exchange: c.exchange,
          tradingsymbol: c.tradingsymbol,
          instrumentToken: c.instrumentToken,
          instrumentType: c.instrumentType,
          lotSize: c.lotSize,
          tickSize: c.tickSize,
          side: c.side,
          lastPrice: c.lastPrice,
          bid: c.bid,
          ask: c.ask,
          volume: c.volume,
          scoresJson: c.scoresJson,
          deterministicScore: c.deterministicScore,
          llmScore: c.llmScore,
          llmStatus: c.llmStatus,
          llmRationale: c.llmRationale,
          mergedScore: c.mergedScore,
          mergePolicy: c.mergePolicy,
          proposalParamsJson: c.proposalParamsJson,
          pluginErrorsJson: c.pluginErrorsJson,
          hasPluginErrors: c.hasPluginErrors,
          emitted: c.emitted,
          proposalAttemptId: c.proposalAttemptId,
        });
      }

      return {
        id: runId,
        frameworkConfig: run.frameworkConfig,
        pluginsJson: run.pluginsJson,
        pluginErrorsJson: run.pluginErrorsJson,
        universeSnapshotId: run.universeSnapshotId,
        totalEvaluated: run.totalEvaluated,
        hasPluginErrors: run.hasPluginErrors,
        durationMs: run.durationMs,
        createdAt: run.createdAt,
        candidates: insertedCandidates,
      };
    });

    return tx();
  }

  /**
   * Retrieve a strategy run by id, with its candidates ordered by rank.
   * Returns null when the run does not exist.
   */
  getRunById(id: number): StrategyRunWithCandidates | null {
    const runRow = this._db.prepare(`
      SELECT id, framework_config, plugins_json, plugin_errors_json,
             universe_snapshot_id, total_evaluated, has_plugin_errors,
             duration_ms, created_at
      FROM strategy_runs
      WHERE id = ?
    `).get(id) as StrategyRunDbRow | undefined;

    if (!runRow) return null;

    const candidates = this._loadCandidates(id);

    return {
      ...this._mapRunRow(runRow),
      candidates,
    };
  }

  /**
   * Retrieve the most recent strategy runs, newest first.
   * Each run includes its ordered candidates.
   */
  getRecentRuns(limit: number = 20): StrategyRunWithCandidates[] {
    const runRows = this._db.prepare(`
      SELECT id, framework_config, plugins_json, plugin_errors_json,
             universe_snapshot_id, total_evaluated, has_plugin_errors,
             duration_ms, created_at
      FROM strategy_runs
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as StrategyRunDbRow[];

    return runRows.map(runRow => ({
      ...this._mapRunRow(runRow),
      candidates: this._loadCandidates(runRow.id),
    }));
  }

  /**
   * Find a strategy run that contains a candidate linked to the given
   * proposal attempt id.
   *
   * Returns the full run with all its candidates, or null if no candidate
   * has the given proposal attempt linkage.
   */
  getRunByProposalAttemptId(proposalAttemptId: number): StrategyRunWithCandidates | null {
    const runRow = this._db.prepare(`
      SELECT sr.id, sr.framework_config, sr.plugins_json, sr.plugin_errors_json,
             sr.universe_snapshot_id, sr.total_evaluated, sr.has_plugin_errors,
             sr.duration_ms, sr.created_at
      FROM strategy_runs sr
      INNER JOIN strategy_run_candidates src ON src.strategy_run_id = sr.id
      WHERE src.proposal_attempt_id = ?
      LIMIT 1
    `).get(proposalAttemptId) as StrategyRunDbRow | undefined;

    if (!runRow) return null;

    return {
      ...this._mapRunRow(runRow),
      candidates: this._loadCandidates(runRow.id),
    };
  }

  /**
   * Count total strategy runs.
   */
  countRuns(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM strategy_runs').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Count total strategy run candidates.
   */
  countCandidates(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM strategy_run_candidates').get() as { cnt: number };
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Load all candidates for a given run id, ordered by rank ascending. */
  private _loadCandidates(runId: number): StrategyRunCandidateRow[] {
    const rows = this._db.prepare(`
      SELECT id, strategy_run_id, candidate_key, rank,
             exchange, tradingsymbol, instrument_token, instrument_type,
             lot_size, tick_size, side,
             last_price, bid, ask, volume,
             scores_json, deterministic_score,
             llm_score, llm_status, llm_rationale,
             merged_score, merge_policy,
             proposal_params_json, plugin_errors_json,
             has_plugin_errors, emitted, proposal_attempt_id
      FROM strategy_run_candidates
      WHERE strategy_run_id = ?
      ORDER BY rank ASC
    `).all(runId) as StrategyRunCandidateDbRow[];

    return rows.map(this._mapCandidateRow);
  }

  private _mapRunRow(row: StrategyRunDbRow): StrategyRunRow {
    return {
      id: row.id,
      frameworkConfig: row.framework_config,
      pluginsJson: row.plugins_json,
      pluginErrorsJson: row.plugin_errors_json,
      universeSnapshotId: row.universe_snapshot_id,
      totalEvaluated: row.total_evaluated,
      hasPluginErrors: row.has_plugin_errors === 1,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
    };
  }

  private _mapCandidateRow(row: StrategyRunCandidateDbRow): StrategyRunCandidateRow {
    return {
      id: row.id,
      strategyRunId: row.strategy_run_id,
      candidateKey: row.candidate_key,
      rank: row.rank,
      exchange: row.exchange,
      tradingsymbol: row.tradingsymbol,
      instrumentToken: row.instrument_token,
      instrumentType: row.instrument_type,
      lotSize: row.lot_size,
      tickSize: row.tick_size,
      side: row.side,
      lastPrice: row.last_price,
      bid: row.bid,
      ask: row.ask,
      volume: row.volume,
      scoresJson: row.scores_json,
      deterministicScore: row.deterministic_score,
      llmScore: row.llm_score,
      llmStatus: row.llm_status,
      llmRationale: row.llm_rationale,
      mergedScore: row.merged_score,
      mergePolicy: row.merge_policy,
      proposalParamsJson: row.proposal_params_json,
      pluginErrorsJson: row.plugin_errors_json,
      hasPluginErrors: row.has_plugin_errors === 1,
      emitted: row.emitted === 1,
      proposalAttemptId: row.proposal_attempt_id,
    };
  }
}
