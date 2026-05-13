import type Database from 'better-sqlite3';
import {
  ExecutionAttemptStatus,
  ExecutionOutcomeCode,
  ExecutionRefusalCode,
  type ExecutionAttemptRow,
  type NewExecutionAttempt,
  type ExecutionAttemptRefusalRow,
  type ExecutionRefusalReason,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// ExecutionAttemptRepository — typed CRUD over execution_attempts.
//
// Invariant: exactly one execution-attempt row per strategy decision.
// Enforced by UNIQUE(strategy_decision_id) in the schema.
//
// This is the canonical consumption seam for S03 — once a strategy decision
// has an execution attempt row, it is considered consumed and will not be
// returned by getApprovedUnconsumedCandidates().
// ---------------------------------------------------------------------------

export class ExecutionAttemptRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  /**
   * Insert an execution attempt row.
   *
   * One row per strategy decision (UNIQUE constraint on strategy_decision_id).
   * Throws on duplicate — execution attempts are append-only per decision.
   * Returns the full row including the assigned id.
   */
  insertAttempt(attempt: NewExecutionAttempt): ExecutionAttemptRow {
    const stmt = this._db.prepare(`
      INSERT INTO execution_attempts
        (strategy_decision_id, execution_mode, status, outcome_code,
         broker_order_id, message, attempted_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      attempt.strategyDecisionId,
      attempt.executionMode,
      attempt.status,
      attempt.outcomeCode,
      attempt.brokerOrderId,
      attempt.message,
      attempt.attemptedAt,
      attempt.completedAt,
    );

    return {
      id: Number(result.lastInsertRowid),
      strategyDecisionId: attempt.strategyDecisionId,
      executionMode: attempt.executionMode,
      status: attempt.status,
      outcomeCode: attempt.outcomeCode,
      brokerOrderId: attempt.brokerOrderId,
      message: attempt.message,
      attemptedAt: attempt.attemptedAt,
      completedAt: attempt.completedAt,
    };
  }

  /**
   * Retrieve an execution attempt by id.
   */
  getById(id: number): ExecutionAttemptRow | null {
    const row = this._db.prepare(`
      SELECT * FROM execution_attempts WHERE id = ?
    `).get(id) as ExecutionAttemptDbRow | undefined;

    return row ? mapAttemptRow(row) : null;
  }

  /**
   * Retrieve an execution attempt by strategy decision id.
   */
  getByStrategyDecisionId(strategyDecisionId: number): ExecutionAttemptRow | null {
    const row = this._db.prepare(`
      SELECT * FROM execution_attempts WHERE strategy_decision_id = ?
    `).get(strategyDecisionId) as ExecutionAttemptDbRow | undefined;

    return row ? mapAttemptRow(row) : null;
  }

  /**
   * Retrieve recent execution attempts, newest first.
   */
  getRecent(limit = 50): ExecutionAttemptRow[] {
    const rows = this._db.prepare(`
      SELECT * FROM execution_attempts ORDER BY attempted_at DESC LIMIT ?
    `).all(limit) as ExecutionAttemptDbRow[];

    return rows.map(mapAttemptRow);
  }

  /**
   * Retrieve execution attempts by status, newest first.
   */
  getByStatus(status: ExecutionAttemptStatus, limit = 50): ExecutionAttemptRow[] {
    const rows = this._db.prepare(`
      SELECT * FROM execution_attempts WHERE status = ? ORDER BY attempted_at DESC LIMIT ?
    `).all(status, limit) as ExecutionAttemptDbRow[];

    return rows.map(mapAttemptRow);
  }

  // -----------------------------------------------------------------------
  // Refusal reasons
  // -----------------------------------------------------------------------

  /**
   * Insert an execution attempt refusal reason.
   */
  insertRefusalReason(executionAttemptId: number, reason: ExecutionRefusalReason): void {
    this._db.prepare(`
      INSERT INTO execution_attempt_refusal_reasons
        (execution_attempt_id, reason_code, reason_message)
      VALUES (?, ?, ?)
    `).run(executionAttemptId, reason.reasonCode, reason.reasonMessage);
  }

  /**
   * Retrieve refusal reasons for an execution attempt, ordered by insertion.
   */
  getRefusalReasons(executionAttemptId: number): ExecutionRefusalReason[] {
    const rows = this._db.prepare(`
      SELECT reason_code, reason_message
      FROM execution_attempt_refusal_reasons
      WHERE execution_attempt_id = ?
      ORDER BY id
    `).all(executionAttemptId) as Array<{ reason_code: string; reason_message: string }>;

    return rows.map(r => ({
      reasonCode: r.reason_code as ExecutionRefusalCode,
      reasonMessage: r.reason_message,
    }));
  }

  /**
   * Insert an attempt with its refusal reasons in a single transaction.
   * Returns the full attempt row including the assigned id.
   */
  insertAttemptWithRefusalReasons(
    attempt: NewExecutionAttempt,
    reasons: ExecutionRefusalReason[],
  ): ExecutionAttemptRow {
    const tx = this._db.transaction(() => {
      const row = this.insertAttempt(attempt);
      for (const reason of reasons) {
        this.insertRefusalReason(row.id, reason);
      }
      return row;
    });

    return tx();
  }

  // -----------------------------------------------------------------------
  // Count methods
  // -----------------------------------------------------------------------

  /** Count total execution attempt rows. */
  count(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM execution_attempts').get() as { cnt: number };
    return row.cnt;
  }

  /** Count execution attempts by status. */
  countByStatus(status: ExecutionAttemptStatus): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM execution_attempts WHERE status = ?',
    ).get(status) as { cnt: number };
    return row.cnt;
  }

  /** Check if a strategy decision has already been consumed (has an execution attempt). */
  isConsumed(strategyDecisionId: number): boolean {
    const row = this._db.prepare(
      'SELECT 1 AS found FROM execution_attempts WHERE strategy_decision_id = ? LIMIT 1',
    ).get(strategyDecisionId) as { found: number } | undefined;

    return row !== undefined;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ExecutionAttemptDbRow {
  id: number;
  strategy_decision_id: number;
  execution_mode: string;
  status: string;
  outcome_code: string | null;
  broker_order_id: string | null;
  message: string;
  attempted_at: number;
  completed_at: number | null;
}

function mapAttemptRow(row: ExecutionAttemptDbRow): ExecutionAttemptRow {
  return {
    id: row.id,
    strategyDecisionId: row.strategy_decision_id,
    executionMode: row.execution_mode as ExecutionAttemptRow['executionMode'],
    status: row.status as ExecutionAttemptStatus,
    outcomeCode: row.outcome_code as ExecutionOutcomeCode | null,
    brokerOrderId: row.broker_order_id,
    message: row.message,
    attemptedAt: row.attempted_at,
    completedAt: row.completed_at,
  };
}
