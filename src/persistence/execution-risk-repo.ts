import type Database from 'better-sqlite3';
import {
  HaltState,
  HaltSource,
  type ExecutionRiskStateRow,
  type NewRiskEvent,
  type RiskEventRow,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// ExecutionRiskRepository — durable risk state and append-only risk events
//
// Current state is a singleton row (id=1) in execution_risk_state.
// Risk events are append-only in risk_events for traceability.
// ---------------------------------------------------------------------------

const DEFAULT_RISK_STATE: Omit<ExecutionRiskStateRow, 'id'> = {
  haltState: HaltState.NoHalt,
  haltSource: null,
  haltReason: null,
  haltedAt: null,
  acknowledgedAt: null,
  openPositionCountAtHalt: null,
  dailyPnlAtHalt: null,
  latchCount: 0,
  updatedAt: 0,
};

export class ExecutionRiskRepository {
  private readonly _db: Database.Database;

  // Prepared statements (lazily compiled)
  private _insertEventStmt: Database.Statement | null = null;
  private _getStateStmt: Database.Statement | null = null;
  private _upsertStateStmt: Database.Statement | null = null;
  private _getRecentEventsStmt: Database.Statement | null = null;
  private _getRecentEventsByTypeStmt: Database.Statement | null = null;
  private _getEventsSinceStmt: Database.Statement | null = null;

  constructor(db: Database.Database) {
    this._db = db;
  }

  // -----------------------------------------------------------------------
  // Current risk state accessors
  // -----------------------------------------------------------------------

  /**
   * Read the current risk state.
   * Returns the default (no halt) state if no row exists — restart-safe.
   */
  getCurrentState(): ExecutionRiskStateRow {
    if (!this._getStateStmt) {
      this._getStateStmt = this._db.prepare(
        'SELECT * FROM execution_risk_state WHERE id = 1',
      );
    }
    const row = this._getStateStmt.get() as Record<string, unknown> | undefined;
    if (!row) {
      return { id: 1, ...DEFAULT_RISK_STATE };
    }
    return mapRow(row);
  }

  /**
   * Latch the risk state to a halt condition.
   * Creates the singleton row if it doesn't exist, updates if it does.
   * Increments latchCount if the same `source` is being re-latched.
   */
  latchHalt(
    source: HaltSource,
    reason: string,
    now?: number,
    openPositionCount?: number,
    dailyPnl?: number,
  ): ExecutionRiskStateRow {
    const ts = now ?? Date.now();
    const current = this.getCurrentState();

    const newLatchCount = current.haltState === HaltState.ActiveHalt &&
      current.haltSource === source
      ? current.latchCount + 1
      : current.latchCount + 1;

    this._upsertState({
      haltState: HaltState.ActiveHalt,
      haltSource: source,
      haltReason: reason,
      haltedAt: ts,
      openPositionCountAtHalt: openPositionCount ?? current.openPositionCountAtHalt,
      dailyPnlAtHalt: dailyPnl ?? current.dailyPnlAtHalt,
      latchCount: newLatchCount,
      updatedAt: ts,
    });

    return this.getCurrentState();
  }

  /**
   * Unlatch — return to no-halt state.
   * Resets latch-related fields but preserves recent halt metadata for audit.
   */
  unlatchHalt(acknowledgedAt?: number): ExecutionRiskStateRow {
    const ts = acknowledgedAt ?? Date.now();
    this._upsertState({
      haltState: HaltState.NoHalt,
      haltSource: null,
      haltReason: null,
      haltedAt: null,
      acknowledgedAt: ts,
      openPositionCountAtHalt: null,
      dailyPnlAtHalt: null,
      latchCount: 0,
      updatedAt: ts,
    });
    return this.getCurrentState();
  }

  /**
   * Acknowledge the current halt without unlatching.
   * Sets acknowledgedAt timestamp for operator-visibility tracking.
   */
  acknowledgeHalt(acknowledgedAt?: number): ExecutionRiskStateRow {
    const ts = acknowledgedAt ?? Date.now();
    this._db.prepare(
      'UPDATE execution_risk_state SET acknowledged_at = ?, updated_at = ? WHERE id = 1',
    ).run(ts, ts);
    return this.getCurrentState();
  }

  /**
   * Update the open position count in the current risk state (no halt trigger).
   * Ensures the singleton row exists before updating.
   */
  updatePositionCount(count: number): void {
    const ts = Date.now();
    // Ensure row exists
    this._db.prepare(
      'INSERT OR IGNORE INTO execution_risk_state (id, halt_state, updated_at) VALUES (1, ?, ?)',
    ).run(HaltState.NoHalt, ts);
    this._db.prepare(
      'UPDATE execution_risk_state SET open_position_count_at_halt = ?, updated_at = ? WHERE id = 1',
    ).run(count, ts);
  }

  /**
   * Update the daily P&L snapshot in the current risk state (no halt trigger).
   * Ensures the singleton row exists before updating.
   */
  updateDailyPnl(pnl: number): void {
    const ts = Date.now();
    // Ensure row exists
    this._db.prepare(
      'INSERT OR IGNORE INTO execution_risk_state (id, halt_state, updated_at) VALUES (1, ?, ?)',
    ).run(HaltState.NoHalt, ts);
    this._db.prepare(
      'UPDATE execution_risk_state SET daily_pnl_at_halt = ?, updated_at = ? WHERE id = 1',
    ).run(pnl, ts);
  }

  /** Check whether a halt is currently active. */
  isHalted(): boolean {
    const state = this.getCurrentState();
    return state.haltState === HaltState.ActiveHalt;
  }

  // -----------------------------------------------------------------------
  // Risk events (append-only)
  // -----------------------------------------------------------------------

  /**
   * Insert a new risk event.
   * Returns the full event row with the assigned id.
   */
  insertEvent(event: NewRiskEvent): RiskEventRow {
    if (!this._insertEventStmt) {
      this._insertEventStmt = this._db.prepare(`
        INSERT INTO risk_events
          (event_type, source, severity, message, diagnostic, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
    }
    const result = this._insertEventStmt.run(
      event.eventType,
      event.source,
      event.severity,
      event.message,
      event.diagnostic,
      event.recordedAt,
    );
    return {
      id: Number(result.lastInsertRowid),
      eventType: event.eventType,
      source: event.source,
      severity: event.severity,
      message: event.message,
      diagnostic: event.diagnostic,
      recordedAt: event.recordedAt,
    };
  }

  /**
   * Get the most recent risk events, newest first.
   * @param limit Max events to return (default 10).
   */
  getRecentEvents(limit: number = 10): RiskEventRow[] {
    if (!this._getRecentEventsStmt) {
      this._getRecentEventsStmt = this._db.prepare(
        'SELECT * FROM risk_events ORDER BY recorded_at DESC LIMIT ?',
      );
    }
    const rows = this._getRecentEventsStmt.all(limit) as Record<string, unknown>[];
    return rows.map(mapEventRow);
  }

  /**
   * Get recent risk events filtered by event type, newest first.
   * @param eventType Event type substring match.
   * @param limit Max events to return (default 10).
   */
  getRecentEventsByType(eventType: string, limit: number = 10): RiskEventRow[] {
    if (!this._getRecentEventsByTypeStmt) {
      this._getRecentEventsByTypeStmt = this._db.prepare(
        'SELECT * FROM risk_events WHERE event_type = ? ORDER BY recorded_at DESC LIMIT ?',
      );
    }
    const rows = this._getRecentEventsByTypeStmt.all(eventType, limit) as Record<string, unknown>[];
    return rows.map(mapEventRow);
  }

  /**
   * Get risk events recorded since a given timestamp, newest first.
   * @param since Unix timestamp (ms).
   * @param limit Max events to return (default 50).
   */
  getEventsSince(since: number, limit: number = 50): RiskEventRow[] {
    if (!this._getEventsSinceStmt) {
      this._getEventsSinceStmt = this._db.prepare(
        'SELECT * FROM risk_events WHERE recorded_at >= ? ORDER BY recorded_at DESC LIMIT ?',
      );
    }
    const rows = this._getEventsSinceStmt.all(since, limit) as Record<string, unknown>[];
    return rows.map(mapEventRow);
  }

  /** Total count of risk events in the log. */
  eventCount(): number {
    const row = this._db.prepare('SELECT COUNT(*) as cnt FROM risk_events').get() as { cnt: number };
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private _upsertState(fields: {
    haltState: HaltState;
    haltSource: HaltSource | null;
    haltReason: string | null;
    haltedAt: number | null;
    acknowledgedAt?: number | null;
    openPositionCountAtHalt: number | null;
    dailyPnlAtHalt: number | null;
    latchCount: number;
    updatedAt: number;
  }): void {
    if (!this._upsertStateStmt) {
      this._upsertStateStmt = this._db.prepare(`
        INSERT INTO execution_risk_state
          (id, halt_state, halt_source, halt_reason, halted_at, acknowledged_at,
           open_position_count_at_halt, daily_pnl_at_halt, latch_count, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          halt_state                 = excluded.halt_state,
          halt_source                = excluded.halt_source,
          halt_reason                = excluded.halt_reason,
          halted_at                  = excluded.halted_at,
          acknowledged_at            = excluded.acknowledged_at,
          open_position_count_at_halt = excluded.open_position_count_at_halt,
          daily_pnl_at_halt          = excluded.daily_pnl_at_halt,
          latch_count                = excluded.latch_count,
          updated_at                 = excluded.updated_at
      `);
    }
    this._upsertStateStmt.run(
      fields.haltState,
      fields.haltSource,
      fields.haltReason,
      fields.haltedAt,
      fields.acknowledgedAt ?? null,
      fields.openPositionCountAtHalt,
      fields.dailyPnlAtHalt,
      fields.latchCount,
      fields.updatedAt,
    );
  }
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

function mapRow(row: Record<string, unknown>): ExecutionRiskStateRow {
  return {
    id: Number(row.id),
    haltState: row.halt_state as HaltState,
    haltSource: row.halt_source as HaltSource | null,
    haltReason: row.halt_reason as string | null,
    haltedAt: row.halted_at != null ? Number(row.halted_at) : null,
    acknowledgedAt: row.acknowledged_at != null ? Number(row.acknowledged_at) : null,
    openPositionCountAtHalt: row.open_position_count_at_halt != null
      ? Number(row.open_position_count_at_halt)
      : null,
    dailyPnlAtHalt: row.daily_pnl_at_halt != null
      ? Number(row.daily_pnl_at_halt)
      : null,
    latchCount: Number(row.latch_count),
    updatedAt: Number(row.updated_at),
  };
}

function mapEventRow(row: Record<string, unknown>): RiskEventRow {
  return {
    id: Number(row.id),
    eventType: row.event_type as string,
    source: row.source as HaltSource | null,
    severity: row.severity as string,
    message: row.message as string,
    diagnostic: row.diagnostic as string | null,
    recordedAt: Number(row.recorded_at),
  };
}
