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

/** Lifecycle status of an overnight research run. */
export enum OvernightRunStatus {
  Pending = 'pending',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  Refused = 'refused',
}

export type OvernightPhase = 'generate' | 'evaluate' | 'publish' | 'completed';

export interface OvernightResumeEvent {
  resumedAt: number;
  fromPhase: string | null;
  checkpointPhase: string | null;
  reason: string;
}

export interface OvernightPhaseTransition {
  phase: string;
  status: 'started' | 'completed' | 'failed' | 'skipped';
  recordedAt: number;
  detail?: string;
}

export interface OvernightPublicationSnapshot {
  verdict: 'publish' | 'hold';
  publicationId: number | null;
  lifecycleStateId: number | null;
  governanceDecisionId: number | null;
  rationale: string;
  recordedAt: number;
}

export interface OvernightRunMetadata {
  schemaVersion: number;
  resumeAttempts: OvernightResumeEvent[];
  phaseTransitions: OvernightPhaseTransition[];
  lastSuccessfulPhase: string | null;
  publication: OvernightPublicationSnapshot | null;
  failureContext: {
    phase: string | null;
    message: string;
    recordedAt: number;
  } | null;
}

/** Full persisted overnight run row with auto-generated id. */
export interface OvernightRunRow {
  id: number;
  label: string;
  status: OvernightRunStatus;
  marketPhase: string | null;
  currentPhase: string | null;
  checkpointPointer: string | null;
  workspacePath: string;
  researchDbPath: string;
  refusalReason: string | null;
  lastError: string | null;
  metadataJson: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

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
  metadataJson?: string | null;
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface OvernightCheckpointMetadata {
  phase: string;
  completedItems: number;
  totalItems: number;
  lastProcessedId?: string;
  metadata?: Record<string, unknown>;
}

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
  metadata_json: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export class OvernightRunRepo {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  insertRun(run: NewOvernightRun): OvernightRunRow {
    const result = this._db.prepare(`
      INSERT INTO overnight_runs
        (label, status, market_phase, current_phase, checkpoint_pointer,
         workspace_path, research_db_path, refusal_reason, last_error, metadata_json,
         created_at, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      run.metadataJson ?? this.serializeMetadata(createEmptyOvernightRunMetadata()),
      run.createdAt,
      run.startedAt ?? null,
      run.completedAt ?? null,
    );

    const id = Number(result.lastInsertRowid);
    return this._getRun(id)!;
  }

  getRun(id: number): OvernightRunRow | null {
    return this._getRun(id);
  }

  getLatestRun(): OvernightRunRow | null {
    const row = this._db.prepare(`
      SELECT id, label, status, market_phase, current_phase,
             checkpoint_pointer, workspace_path, research_db_path,
             refusal_reason, last_error, metadata_json,
             created_at, started_at, completed_at
      FROM overnight_runs
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get() as OvernightRunDbRow | undefined;

    return row ? this._mapRow(row) : null;
  }

  getLatestRunnableRun(): OvernightRunRow | null {
    const row = this._db.prepare(`
      SELECT id, label, status, market_phase, current_phase,
             checkpoint_pointer, workspace_path, research_db_path,
             refusal_reason, last_error, metadata_json,
             created_at, started_at, completed_at
      FROM overnight_runs
      WHERE status IN (?, ?)
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(OvernightRunStatus.Running, OvernightRunStatus.Failed) as OvernightRunDbRow | undefined;

    return row ? this._mapRow(row) : null;
  }

  listRuns(limit: number = 20): OvernightRunRow[] {
    const rows = this._db.prepare(`
      SELECT id, label, status, market_phase, current_phase,
             checkpoint_pointer, workspace_path, research_db_path,
             refusal_reason, last_error, metadata_json,
             created_at, started_at, completed_at
      FROM overnight_runs
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(limit) as OvernightRunDbRow[];

    return rows.map(this._mapRow);
  }

  updateRun(
    id: number,
    updates: Partial<Pick<OvernightRunRow, 'status' | 'currentPhase' | 'checkpointPointer' | 'researchDbPath' | 'lastError' | 'metadataJson' | 'startedAt' | 'completedAt'>>,
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
          metadata_json = ?,
          started_at = ?,
          completed_at = ?
      WHERE id = ?
    `).run(
      updates.status ?? existing.status,
      updates.currentPhase !== undefined ? updates.currentPhase : existing.currentPhase,
      updates.checkpointPointer !== undefined ? updates.checkpointPointer : existing.checkpointPointer,
      updates.researchDbPath !== undefined ? updates.researchDbPath : existing.researchDbPath,
      updates.lastError !== undefined ? updates.lastError : existing.lastError,
      updates.metadataJson !== undefined ? updates.metadataJson : existing.metadataJson,
      updates.startedAt !== undefined ? updates.startedAt : existing.startedAt,
      updates.completedAt !== undefined ? updates.completedAt : existing.completedAt,
      id,
    );

    return this.getRun(id);
  }

  countRuns(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM overnight_runs').get() as { cnt: number };
    return row.cnt;
  }

  countByStatus(status: OvernightRunStatus): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM overnight_runs WHERE status = ?',
    ).get(status) as { cnt: number };
    return row.cnt;
  }

  readMetadata(run: Pick<OvernightRunRow, 'metadataJson'>): OvernightRunMetadata {
    return parseOvernightRunMetadata(run.metadataJson);
  }

  serializeMetadata(metadata: OvernightRunMetadata): string {
    return JSON.stringify(metadata);
  }

  private _getRun(id: number): OvernightRunRow | null {
    const row = this._db.prepare(`
      SELECT id, label, status, market_phase, current_phase,
             checkpoint_pointer, workspace_path, research_db_path,
             refusal_reason, last_error, metadata_json,
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
      metadataJson: row.metadata_json,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }
}

export function createEmptyOvernightRunMetadata(): OvernightRunMetadata {
  return {
    schemaVersion: 1,
    resumeAttempts: [],
    phaseTransitions: [],
    lastSuccessfulPhase: null,
    publication: null,
    failureContext: null,
  };
}

export function parseOvernightRunMetadata(raw: string | null | undefined): OvernightRunMetadata {
  if (!raw) return createEmptyOvernightRunMetadata();
  try {
    const parsed = JSON.parse(raw) as Partial<OvernightRunMetadata>;
    return {
      schemaVersion: 1,
      resumeAttempts: Array.isArray(parsed.resumeAttempts) ? parsed.resumeAttempts : [],
      phaseTransitions: Array.isArray(parsed.phaseTransitions) ? parsed.phaseTransitions : [],
      lastSuccessfulPhase: typeof parsed.lastSuccessfulPhase === 'string' ? parsed.lastSuccessfulPhase : null,
      publication: parsed.publication ?? null,
      failureContext: parsed.failureContext ?? null,
    };
  } catch {
    return createEmptyOvernightRunMetadata();
  }
}
