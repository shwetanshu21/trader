// ── ReplaySessionRepository ──
// Append/update/read of replay session state and checkpoint positions.
// Follows the same patterns as StrategyRunRepository and other persistence
// repos in this project.

import type Database from 'better-sqlite3';
import {
  type ReplaySessionRow,
  type NewReplaySession,
  type ReplayCheckpointRow,
  type NewReplayCheckpoint,
  ReplaySessionStatus,
} from '../replay/types.js';

// ---------------------------------------------------------------------------
// Row shapes from SQLite (snake_case → camelCase mapping)
// ---------------------------------------------------------------------------

interface ReplaySessionDbRow {
  id: number;
  label: string;
  strategy_id: string;
  strategy_version: string;
  market_id: string;
  cadence_minutes: number;
  range_start: number;
  range_end: number;
  requested_fidelity: string;
  effective_fidelity: string | null;
  status: string;
  total_ticks: number;
  completed_ticks: number;
  error_message: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

interface ReplayCheckpointDbRow {
  id: number;
  session_id: number;
  tick_index: number;
  tick_timestamp: number;
  strategy_run_id: number | null;
  metadata_json: string | null;
  saved_at: number;
}

// ---------------------------------------------------------------------------
// ReplaySessionRepository
// ---------------------------------------------------------------------------

export class ReplaySessionRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  // -----------------------------------------------------------------------
  // Session CRUD
  // -----------------------------------------------------------------------

  /**
   * Create a new replay session. Returns the full row with auto-generated id.
   */
  createSession(session: NewReplaySession): ReplaySessionRow {
    const result = this._db.prepare(`
      INSERT INTO replay_sessions
        (label, strategy_id, strategy_version, market_id,
         cadence_minutes, range_start, range_end,
         requested_fidelity, effective_fidelity,
         status, total_ticks, completed_ticks,
         error_message, created_at, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.label,
      session.strategyId,
      session.strategyVersion,
      session.marketId,
      session.cadenceMinutes,
      session.rangeStart,
      session.rangeEnd,
      session.requestedFidelity,
      session.effectiveFidelity,
      session.status,
      session.totalTicks,
      session.completedTicks,
      session.errorMessage,
      session.createdAt,
      session.startedAt,
      session.completedAt,
    );

    const id = Number(result.lastInsertRowid);
    return this.getSession(id)!;
  }

  /**
   * Retrieve a replay session by id. Returns null when the session does not exist.
   */
  getSession(id: number): ReplaySessionRow | null {
    const row = this._db.prepare(`
      SELECT id, label, strategy_id, strategy_version, market_id,
             cadence_minutes, range_start, range_end,
             requested_fidelity, effective_fidelity,
             status, total_ticks, completed_ticks,
             error_message, created_at, started_at, completed_at
      FROM replay_sessions
      WHERE id = ?
    `).get(id) as ReplaySessionDbRow | undefined;

    return row ? this._mapSessionRow(row) : null;
  }

  /**
   * Update fields on an existing replay session.
   * Only the provided non-undefined fields are updated.
   */
  updateSession(
    id: number,
    updates: Partial<Omit<NewReplaySession, 'label' | 'strategyId' | 'strategyVersion' | 'marketId' | 'cadenceMinutes' | 'rangeStart' | 'rangeEnd' | 'requestedFidelity' | 'createdAt'>>,
  ): ReplaySessionRow | null {
    const existing = this.getSession(id);
    if (!existing) return null;

    const stmt = this._db.prepare(`
      UPDATE replay_sessions
      SET effective_fidelity = ?,
          status = ?,
          completed_ticks = ?,
          error_message = ?,
          started_at = ?,
          completed_at = ?
      WHERE id = ?
    `);

    stmt.run(
      updates.effectiveFidelity ?? existing.effectiveFidelity,
      updates.status ?? existing.status,
      updates.completedTicks ?? existing.completedTicks,
      updates.errorMessage !== undefined ? updates.errorMessage : existing.errorMessage,
      updates.startedAt !== undefined ? updates.startedAt : existing.startedAt,
      updates.completedAt !== undefined ? updates.completedAt : existing.completedAt,
      id,
    );

    return this.getSession(id);
  }

  /**
   * Mark a session as started.
   */
  markStarted(id: number, startedAt: number): ReplaySessionRow | null {
    return this.updateSession(id, {
      status: ReplaySessionStatus.Running,
      startedAt,
    });
  }

  /**
   * Mark a session as completed.
   */
  markCompleted(id: number, completedAt: number, effectiveFidelity?: string): ReplaySessionRow | null {
    return this.updateSession(id, {
      status: ReplaySessionStatus.Completed,
      completedAt,
      effectiveFidelity: (effectiveFidelity ?? undefined) as any,
    });
  }

  /**
   * Mark a session as failed with an error message.
   */
  markFailed(id: number, completedAt: number, errorMessage: string): ReplaySessionRow | null {
    return this.updateSession(id, {
      status: ReplaySessionStatus.Failed,
      completedAt,
      errorMessage,
    });
  }

  /**
   * Mark a session as interrupted (e.g. process killed).
   */
  markInterrupted(id: number): ReplaySessionRow | null {
    return this.updateSession(id, {
      status: ReplaySessionStatus.Interrupted,
      completedAt: Date.now(),
    });
  }

  /**
   * List all replay sessions, newest first.
   */
  listSessions(limit: number = 20): ReplaySessionRow[] {
    const rows = this._db.prepare(`
      SELECT id, label, strategy_id, strategy_version, market_id,
             cadence_minutes, range_start, range_end,
             requested_fidelity, effective_fidelity,
             status, total_ticks, completed_ticks,
             error_message, created_at, started_at, completed_at
      FROM replay_sessions
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as ReplaySessionDbRow[];

    return rows.map(this._mapSessionRow);
  }

  /** Count total replay sessions. */
  countSessions(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM replay_sessions').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Delete a replay session and all its checkpoints.
   * Returns true if a session was deleted, false otherwise.
   */
  deleteSession(id: number): boolean {
    const tx = this._db.transaction(() => {
      this._db.prepare('DELETE FROM replay_checkpoints WHERE session_id = ?').run(id);
      const info = this._db.prepare('DELETE FROM replay_sessions WHERE id = ?').run(id);
      return info.changes > 0;
    });
    return tx();
  }

  // -----------------------------------------------------------------------
  // Checkpoint CRUD
  // -----------------------------------------------------------------------

  /**
   * Save a checkpoint for a replay session.
   * Checkpoints are append-only — multiple checkpoints can exist per session
   * for full traceability.
   */
  saveCheckpoint(checkpoint: NewReplayCheckpoint): ReplayCheckpointRow {
    const result = this._db.prepare(`
      INSERT INTO replay_checkpoints
        (session_id, tick_index, tick_timestamp, strategy_run_id, metadata_json, saved_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      checkpoint.sessionId,
      checkpoint.tickIndex,
      checkpoint.tickTimestamp,
      checkpoint.strategyRunId,
      checkpoint.metadataJson,
      checkpoint.savedAt,
    );

    const id = Number(result.lastInsertRowid);
    return this._loadCheckpoint(id)!;
  }

  /**
   * Get the latest (most recent) checkpoint for a session.
   * Returns null when no checkpoint exists for the session.
   */
  getLatestCheckpoint(sessionId: number): ReplayCheckpointRow | null {
    const row = this._db.prepare(`
      SELECT id, session_id, tick_index, tick_timestamp,
             strategy_run_id, metadata_json, saved_at
      FROM replay_checkpoints
      WHERE session_id = ?
      ORDER BY tick_index DESC
      LIMIT 1
    `).get(sessionId) as ReplayCheckpointDbRow | undefined;

    return row ? this._mapCheckpointRow(row) : null;
  }

  /**
   * Get all checkpoints for a session, ordered by tick_index ascending.
   */
  getSessionCheckpoints(sessionId: number): ReplayCheckpointRow[] {
    const rows = this._db.prepare(`
      SELECT id, session_id, tick_index, tick_timestamp,
             strategy_run_id, metadata_json, saved_at
      FROM replay_checkpoints
      WHERE session_id = ?
      ORDER BY tick_index ASC
    `).all(sessionId) as ReplayCheckpointDbRow[];

    return rows.map(this._mapCheckpointRow);
  }

  /** Count total checkpoints for a session. */
  countCheckpoints(sessionId: number): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM replay_checkpoints WHERE session_id = ?',
    ).get(sessionId) as { cnt: number };
    return row.cnt;
  }

  /** Count all checkpoints across all sessions. */
  countAllCheckpoints(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM replay_checkpoints').get() as { cnt: number };
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private _loadCheckpoint(id: number): ReplayCheckpointRow | null {
    const row = this._db.prepare(`
      SELECT id, session_id, tick_index, tick_timestamp,
             strategy_run_id, metadata_json, saved_at
      FROM replay_checkpoints
      WHERE id = ?
    `).get(id) as ReplayCheckpointDbRow | undefined;

    return row ? this._mapCheckpointRow(row) : null;
  }

  private _mapSessionRow(row: ReplaySessionDbRow): ReplaySessionRow {
    return {
      id: row.id,
      label: row.label,
      strategyId: row.strategy_id,
      strategyVersion: row.strategy_version,
      marketId: row.market_id,
      cadenceMinutes: row.cadence_minutes,
      rangeStart: row.range_start,
      rangeEnd: row.range_end,
      requestedFidelity: row.requested_fidelity as any,
      effectiveFidelity: row.effective_fidelity as any,
      status: row.status as ReplaySessionStatus,
      totalTicks: row.total_ticks,
      completedTicks: row.completed_ticks,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  private _mapCheckpointRow(row: ReplayCheckpointDbRow): ReplayCheckpointRow {
    return {
      id: row.id,
      sessionId: row.session_id,
      tickIndex: row.tick_index,
      tickTimestamp: row.tick_timestamp,
      strategyRunId: row.strategy_run_id,
      metadataJson: row.metadata_json,
      savedAt: row.saved_at,
    };
  }
}
