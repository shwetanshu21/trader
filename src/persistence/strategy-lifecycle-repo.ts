// ── StrategyLifecycleRepository ──
// Durable lifecycle phase state and append-only governance decision log.
//
// Follows the same patterns as ExecutionRiskRepository:
// - Current state uses ON CONFLICT upsert semantics for restart safety.
// - Governance decisions are append-only for audit trail integrity.
// - Row mapping converts snake_case SQLite columns to camelCase TS interfaces.

import type Database from 'better-sqlite3';
import {
  StrategyLifecyclePhase,
  GovernanceVerdict,
  type StrategyLifecycleStateRow,
  type NewStrategyLifecycleState,
  type GovernanceDecisionRow,
  type NewGovernanceDecision,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// DB row shapes (snake_case -> camelCase mapping)
// ---------------------------------------------------------------------------

interface LifecycleStateDbRow {
  id: number;
  strategy_id: string;
  strategy_version: string;
  market_id: string;
  phase: string;
  updated_at: number;
}

interface GovernanceDecisionDbRow {
  id: number;
  strategy_id: string;
  strategy_version: string;
  market_id: string;
  verdict: string;
  previous_phase: string;
  new_phase: string;
  rationale: string;
  evidence_json: string | null;
  winner_id: number | null;
  recorded_at: number;
}

interface CountRow {
  cnt: number;
}

// ---------------------------------------------------------------------------
// StrategyLifecycleRepository
// ---------------------------------------------------------------------------

export class StrategyLifecycleRepository {
  private readonly _db: Database.Database;

  // Prepared statements (lazily compiled)
  private _upsertStateStmt: Database.Statement | null = null;
  private _getStateStmt: Database.Statement | null = null;
  private _getAllStatesStmt: Database.Statement | null = null;
  private _insertDecisionStmt: Database.Statement | null = null;
  private _getDecisionsForIdentityStmt: Database.Statement | null = null;
  private _getLatestDecisionStmt: Database.Statement | null = null;

  constructor(db: Database.Database) {
    this._db = db;
  }

  // -----------------------------------------------------------------------
  // Current state accessors
  // -----------------------------------------------------------------------

  /**
   * Read the current lifecycle phase for a strategy identity.
   *
   * Returns backtest phase (default) when no persisted state exists.
   * This is restart-safe — new strategies always start at the safest phase.
   *
   * @param strategyId - Strategy identity (e.g. 'india-nse-eq-v1').
   * @param strategyVersion - Strategy version (e.g. '1.0.0').
   * @param marketId - Market profile ID (e.g. 'INDIA_NSE_EQ').
   * @returns The current lifecycle state row, or a default backtest-phase row.
   */
  getCurrentState(
    strategyId: string,
    strategyVersion: string,
    marketId: string,
  ): StrategyLifecycleStateRow {
    if (!this._getStateStmt) {
      this._getStateStmt = this._db.prepare(`
        SELECT id, strategy_id, strategy_version, market_id, phase, updated_at
        FROM strategy_lifecycle_state
        WHERE strategy_id = ? AND strategy_version = ? AND market_id = ?
      `);
    }
    const row = this._getStateStmt.get(
      strategyId, strategyVersion, marketId,
    ) as LifecycleStateDbRow | undefined;

    if (!row) {
      return {
        id: 0,
        strategyId,
        strategyVersion,
        marketId,
        phase: StrategyLifecyclePhase.Backtest,
        updatedAt: 0,
      };
    }
    return mapStateRow(row);
  }

  /**
   * Upsert the lifecycle phase for a strategy identity.
   *
   * Creates a new row or updates the existing one. Returns the current
   * state row after the upsert.
   *
   * @param state - The new lifecycle state to persist.
   * @returns The full updated lifecycle state row.
   */
  upsertCurrentState(state: NewStrategyLifecycleState): StrategyLifecycleStateRow {
    if (!this._upsertStateStmt) {
      this._upsertStateStmt = this._db.prepare(`
        INSERT INTO strategy_lifecycle_state
          (strategy_id, strategy_version, market_id, phase, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(strategy_id, strategy_version, market_id) DO UPDATE SET
          phase       = excluded.phase,
          updated_at  = excluded.updated_at
      `);
    }
    this._upsertStateStmt.run(
      state.strategyId,
      state.strategyVersion,
      state.marketId,
      state.phase,
      state.updatedAt,
    );

    // Reload to get the auto-generated id
    return this.getCurrentState(state.strategyId, state.strategyVersion, state.marketId);
  }

  /**
   * List all current lifecycle states across all strategies.
   *
   * @returns An array of all persisted lifecycle state rows.
   */
  getAllCurrentStates(): StrategyLifecycleStateRow[] {
    if (!this._getAllStatesStmt) {
      this._getAllStatesStmt = this._db.prepare(`
        SELECT id, strategy_id, strategy_version, market_id, phase, updated_at
        FROM strategy_lifecycle_state
        ORDER BY strategy_id, strategy_version, market_id
      `);
    }
    const rows = this._getAllStatesStmt.all() as LifecycleStateDbRow[];
    return rows.map(mapStateRow);
  }

  /** Total count of lifecycle state rows. */
  countStates(): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM strategy_lifecycle_state',
    ).get() as CountRow;
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Governance decisions (append-only)
  // -----------------------------------------------------------------------

  /**
   * Insert an append-only governance decision.
   *
   * Each governance evaluation produces one row. Decisions are never
   * updated or deleted — the append-only log provides the full audit trail.
   *
   * @param decision - The governance decision to persist.
   * @returns The full decision row with auto-generated id.
   */
  insertDecision(decision: NewGovernanceDecision): GovernanceDecisionRow {
    if (!this._insertDecisionStmt) {
      this._insertDecisionStmt = this._db.prepare(`
        INSERT INTO governance_decisions
          (strategy_id, strategy_version, market_id, verdict,
           previous_phase, new_phase, rationale, evidence_json,
           winner_id, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    }
    const result = this._insertDecisionStmt.run(
      decision.strategyId,
      decision.strategyVersion,
      decision.marketId,
      decision.verdict,
      decision.previousPhase,
      decision.newPhase,
      decision.rationale,
      decision.evidenceJson,
      decision.winnerId,
      decision.recordedAt,
    );

    return {
      id: Number(result.lastInsertRowid),
      strategyId: decision.strategyId,
      strategyVersion: decision.strategyVersion,
      marketId: decision.marketId,
      verdict: decision.verdict,
      previousPhase: decision.previousPhase,
      newPhase: decision.newPhase,
      rationale: decision.rationale,
      evidenceJson: decision.evidenceJson,
      winnerId: decision.winnerId,
      recordedAt: decision.recordedAt,
    };
  }

  /**
   * Get governance decisions for a strategy identity, newest first.
   *
   * @param strategyId - Strategy identity.
   * @param strategyVersion - Strategy version.
   * @param marketId - Market profile ID.
   * @param limit - Maximum number of decisions to return (default 10).
   * @returns An array of governance decisions, newest first.
   */
  getDecisionsForStrategy(
    strategyId: string,
    strategyVersion: string,
    marketId: string,
    limit: number = 10,
  ): GovernanceDecisionRow[] {
    if (!this._getDecisionsForIdentityStmt) {
      this._getDecisionsForIdentityStmt = this._db.prepare(`
        SELECT id, strategy_id, strategy_version, market_id,
               verdict, previous_phase, new_phase, rationale,
               evidence_json, winner_id, recorded_at
        FROM governance_decisions
        WHERE strategy_id = ? AND strategy_version = ? AND market_id = ?
        ORDER BY recorded_at DESC, id DESC
        LIMIT ?
      `);
    }
    const rows = this._getDecisionsForIdentityStmt.all(
      strategyId, strategyVersion, marketId, limit,
    ) as GovernanceDecisionDbRow[];

    return rows.map(mapDecisionRow);
  }

  /**
   * Get the latest (most recent) governance decision for a strategy identity.
   *
   * Returns null when no governance decision has been recorded for this strategy.
   *
   * @param strategyId - Strategy identity.
   * @param strategyVersion - Strategy version.
   * @param marketId - Market profile ID.
   * @returns The latest decision, or null if no decisions exist.
   */
  getLatestDecision(
    strategyId: string,
    strategyVersion: string,
    marketId: string,
  ): GovernanceDecisionRow | null {
    if (!this._getLatestDecisionStmt) {
      this._getLatestDecisionStmt = this._db.prepare(`
        SELECT id, strategy_id, strategy_version, market_id,
               verdict, previous_phase, new_phase, rationale,
               evidence_json, winner_id, recorded_at
        FROM governance_decisions
        WHERE strategy_id = ? AND strategy_version = ? AND market_id = ?
        ORDER BY recorded_at DESC, id DESC
        LIMIT 1
      `);
    }
    const row = this._getLatestDecisionStmt.get(
      strategyId, strategyVersion, marketId,
    ) as GovernanceDecisionDbRow | undefined;

    return row ? mapDecisionRow(row) : null;
  }

  /**
   * Get all governance decisions across all strategies, newest first.
   *
   * @param limit - Maximum number of decisions to return (default 20).
   * @returns An array of governance decisions, newest first.
   */
  getAllDecisions(limit: number = 20): GovernanceDecisionRow[] {
    const rows = this._db.prepare(`
      SELECT id, strategy_id, strategy_version, market_id,
             verdict, previous_phase, new_phase, rationale,
             evidence_json, winner_id, recorded_at
      FROM governance_decisions
      ORDER BY recorded_at DESC, id DESC
      LIMIT ?
    `).all(limit) as GovernanceDecisionDbRow[];

    return rows.map(mapDecisionRow);
  }

  /** Total count of governance decisions in the log. */
  decisionCount(): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM governance_decisions',
    ).get() as CountRow;
    return row.cnt;
  }
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

function mapStateRow(row: LifecycleStateDbRow): StrategyLifecycleStateRow {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    marketId: row.market_id,
    phase: row.phase as StrategyLifecyclePhase,
    updatedAt: row.updated_at,
  };
}

function mapDecisionRow(row: GovernanceDecisionDbRow): GovernanceDecisionRow {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    marketId: row.market_id,
    verdict: row.verdict as GovernanceVerdict,
    previousPhase: row.previous_phase as StrategyLifecyclePhase,
    newPhase: row.new_phase as StrategyLifecyclePhase,
    rationale: row.rationale,
    evidenceJson: row.evidence_json,
    winnerId: row.winner_id,
    recordedAt: row.recorded_at,
  };
}
