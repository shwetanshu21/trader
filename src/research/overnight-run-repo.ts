// ── OvernightRunRepo ──
// Durable run-state persistence for non-trading-window overnight research
// orchestration. Follows the same append/read patterns as WalkForwardRepository
// and ReplaySessionRepository.
//
// Each row represents a single overnight research run with lifecycle status,
// current phase for resume, checkpoint pointer for progress recovery, and
// workspace path so a future agent can locate on-disk artifacts.
//
// Refused runs (market-window gate) are still persisted with a refusal_reason
// so operators can inspect the rejection audit trail.

import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Lifecycle status of an overnight research run. */
export enum OvernightRunStatus {
  /** Run record created but not yet started. */
  Pending = 'pending',
  /** Run is actively executing research phases. */
  Running = 'running',
  /** All phases completed successfully. */
  Completed = 'completed',
  /** Run encountered an error and stopped. */
  Failed = 'failed',
  /** Run was refused by the market-window gate (market is open). */
  Refused = 'refused',
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** Full persisted overnight run row with auto-generated id. */
export interface OvernightRunRow {
  id: number;
  label: string;
  status: OvernightRunStatus;
  /** The MarketPhase snapshot at decision time (e.g. 'regular', 'closed'). */
  marketPhase: string | null;
  /** Current orchestrator phase for resume (e.g. 'generate', 'evaluate', 'publish'). */
  currentPhase: string | null;
  /** JSON pointer to checkpoint metadata (trial progress, last processed id, etc.). */
  checkpointPointer: string | null;
  /** Absolute or relative path to the research workspace for this run. */
  workspacePath: string;
  /** Explicit path to the isolated research DB for this run (empty when not set). */
  researchDbPath: string;
  /** Human-readable reason when status is 'refused'. */
  refusalReason: string | null;
  /** Error message when status is 'failed'. */
  lastError: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

/** Input shape for creating a new overnight run row (id is auto-generated). */
export interface NewOvernightRun {
  label: string;
  status: OvernightRunStatus;
  marketPhase?: string | null;
  currentPhase?: string | null;
  checkpointPointer?: string | null;
  workspacePath: string;
  researchDbPath?: string;
  refusalReason?: string | null;
  lastError?: string | null;
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
}

/** Typed checkpoint metadata payload stored in checkpointPointer JSON. */
export interface OvernightCheckpointMetadata {
  /** Current orchestrator phase at checkpoint time. */
  phase: string;
  /** How many items/units have been processed. */
  completedItems: number;
  /** How many items/units total. */
  totalItems: number;
  /** Identifier of the last processed item (for resume). */
  lastProcessedId?: string;
  /** Arbitrary metadata for domain-specific checkpoint state. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// DB row shapes (snake_case → camelCase mapping)
// ---------------------------------------------------------------------------

interface OvernightRunDbRow {
  id: number;
  label: string;
  status: string;
  market_phase: string | null;
  current_phase: string | null;
  checkpoint_pointer: string | null;
  workspace_path: string;
  research_db_path: string;
  refusal_reason: string | null;
  last_error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

// ---------------------------------------------------------------------------
// OvernightRunRepo
// ---------------------------------------------------------------------------

export class OvernightRunRepo {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  /**
   * Insert a new overnight run. Returns the full row with auto-generated id.
   */
  insertRun(run: NewOvernightRun): OvernightRunRow {
    const result = this._db.prepare(`
      INSERT INTO overnight_runs
        (label, status, market_phase, current_phase, checkpoint_pointer,
         workspace_path, research_db_path, refusal_reason, last_error,
         created_at, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.label,
      run.status,
      run.marketPhase ?? null,
      run.currentPhase ?? null,
      run.checkpointPointer ?? null,
      run.workspacePath,
      run.researchDbPath ?? '',
      run.refusalReason ?? null,
      run.lastError ?? null,
      run.createdAt,
      run.startedAt ?? null,
      run.completedAt ?? null,
    );

    const id = Number(result.lastInsertRowid);
    return this._getRun(id)!;
  }

  /**
   * Get an overnight run by id. Returns null when it does not exist.
   */
  getRun(id: number): OvernightRunRow | null {
    return this._getRun(id);
  }

  /**
   * Get the most recent run, ordered by created_at descending.
   * Returns null when no runs exist.
   */
  getLatestRun(): OvernightRunRow | null {
    const row = this._db.prepare(`
      SELECT id, label, status, market_phase, current_phase,
             checkpoint_pointer, workspace_path, research_db_path,
             refusal_reason, last_error,
             created_at, started_at, completed_at
      FROM overnight_runs
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get() as OvernightRunDbRow | undefined;

    return row ? this._mapRow(row) : null;
  }

  /**
   * List all overnight runs, newest first.
   */
  listRuns(limit: number = 20): OvernightRunRow[] {
    const rows = this._db.prepare(`
      SELECT id, label, status, market_phase, current_phase,
             checkpoint_pointer, workspace_path, research_db_path,
             refusal_reason, last_error,
             created_at, started_at, completed_at
      FROM overnight_runs
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(limit) as OvernightRunDbRow[];

    return rows.map(this._mapRow);
  }

  /**
   * Update a run's status and optional fields.
   */
  updateRun(
    id: number,
    updates: Partial<Pick<OvernightRunRow, 'status' | 'currentPhase' | 'checkpointPointer' | 'researchDbPath' | 'lastError' | 'startedAt' | 'completedAt'>>,
  ): OvernightRunRow | null {
    const existing = this.getRun(id);
    if (!existing) return null;

    this._db.prepare(`
      UPDATE overnight_runs
      SET status = ?,
          current_phase = ?,
          checkpoint_pointer = ?,
          research_db_path = ?,
          last_error = ?,
          started_at = ?,
          completed_at = ?
      WHERE id = ?
    `).run(
      updates.status ?? existing.status,
      updates.currentPhase !== undefined ? updates.currentPhase : existing.currentPhase,
      updates.checkpointPointer !== undefined ? updates.checkpointPointer : existing.checkpointPointer,
      updates.researchDbPath !== undefined ? updates.researchDbPath : existing.researchDbPath,
      updates.lastError !== undefined ? updates.lastError : existing.lastError,
      updates.startedAt !== undefined ? updates.startedAt : existing.startedAt,
      updates.completedAt !== undefined ? updates.completedAt : existing.completedAt,
      id,
    );

    return this.getRun(id);
  }

  /**
   * Count total overnight runs.
   */
  countRuns(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM overnight_runs').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Count runs by status.
   */
  countByStatus(status: OvernightRunStatus): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM overnight_runs WHERE status = ?',
    ).get(status) as { cnt: number };
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private _getRun(id: number): OvernightRunRow | null {
    const row = this._db.prepare(`
      SELECT id, label, status, market_phase, current_phase,
             checkpoint_pointer, workspace_path, research_db_path,
             refusal_reason, last_error,
             created_at, started_at, completed_at
      FROM overnight_runs
      WHERE id = ?
    `).get(id) as OvernightRunDbRow | undefined;

    return row ? this._mapRow(row) : null;
  }

  private _mapRow(row: OvernightRunDbRow): OvernightRunRow {
    return {
      id: row.id,
      label: row.label,
      status: row.status as OvernightRunStatus,
      marketPhase: row.market_phase,
      currentPhase: row.current_phase,
      checkpointPointer: row.checkpoint_pointer,
      workspacePath: row.workspace_path,
      researchDbPath: row.research_db_path,
      refusalReason: row.refusal_reason,
      lastError: row.last_error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }
}
