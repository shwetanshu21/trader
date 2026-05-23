// ── OvernightOrchestrator ──
// Durable overnight research orchestration seam that:
// 1. Applies a market-window gate via MarketClock so open/pre/post phases
//    refuse execution and closed windows proceed.
// 2. Persists run-level state (status, phase, checkpoint, error) in the
//    overnight_runs table via OvernightRunRepo.
// 3. Exposes checkpoint/audit metadata for resume by a future agent.

import { MarketClock } from '../runtime/market-clock.js';
import { MarketPhase } from '../types/runtime.js';
import {
  OvernightRunRepo,
  OvernightRunStatus,
  type OvernightRunRow,
  type NewOvernightRun,
  type OvernightCheckpointMetadata,
  type OvernightPhase,
  type OvernightPublicationSnapshot,
} from './overnight-run-repo.js';

export interface TryStartResult {
  run: OvernightRunRow;
  accepted: boolean;
  refusalReason: string | null;
  marketPhase: MarketPhase;
  marketPhaseName: string;
  resumed: boolean;
}

export class OvernightOrchestrator {
  private readonly _repo: OvernightRunRepo;
  private readonly _clock: MarketClock;

  constructor(repo: OvernightRunRepo, clock: MarketClock) {
    this._repo = repo;
    this._clock = clock;
  }

  tryStart(label: string, workspacePath: string, now?: Date, researchDbPath?: string): TryStartResult {
    return this.tryStartOrResume({ label, workspacePath, now, researchDbPath });
  }

  tryStartOrResume(options: {
    label: string;
    workspacePath: string;
    now?: Date;
    researchDbPath?: string;
    resumeRunId?: number;
  }): TryStartResult {
    const nowDate = options.now ?? new Date();
    const marketPhase = this._clock.getPhase(nowDate);
    const marketPhaseName = this._summarizePhase(marketPhase);
    const createdAt = nowDate.getTime();

    if (!this._clock.isClosed(nowDate)) {
      const refusalReason = `Market is open (phase: ${marketPhaseName}). Overnight research runs are only accepted during closed market windows.`;
      const refusedRun: NewOvernightRun = {
        label: options.label,
        status: OvernightRunStatus.Refused,
        marketPhase: marketPhase,
        workspacePath: options.workspacePath,
        researchDbPath: options.researchDbPath ?? '',
        refusalReason,
        createdAt,
      };
      const run = this._repo.insertRun(refusedRun);
      return {
        run,
        accepted: false,
        refusalReason,
        marketPhase,
        marketPhaseName,
        resumed: false,
      };
    }

    const resumable = options.resumeRunId != null
      ? this._repo.getRun(options.resumeRunId)
      : this._repo.getLatestRunnableRun();

    if (
      resumable
      && resumable.status !== OvernightRunStatus.Completed
      && resumable.status !== OvernightRunStatus.Refused
      && (options.researchDbPath == null || resumable.researchDbPath === options.researchDbPath)
      && resumable.workspacePath === options.workspacePath
    ) {
      const resumed = this.recordResumeAttempt(
        resumable.id,
        'rerun detected; continuing from persisted overnight run state',
        createdAt,
      );
      const reopened = this._repo.updateRun(resumable.id, {
        status: OvernightRunStatus.Running,
        researchDbPath: options.researchDbPath ?? resumable.researchDbPath,
        lastError: null,
      }) ?? resumable;
      return {
        run: reopened,
        accepted: true,
        refusalReason: null,
        marketPhase,
        marketPhaseName,
        resumed: resumed != null,
      };
    }

    const newRun: NewOvernightRun = {
      label: options.label,
      status: OvernightRunStatus.Running,
      marketPhase: marketPhase,
      currentPhase: 'generate',
      workspacePath: options.workspacePath,
      researchDbPath: options.researchDbPath ?? '',
      createdAt,
      startedAt: createdAt,
    };

    const run = this._repo.insertRun(newRun);
    return {
      run,
      accepted: true,
      refusalReason: null,
      marketPhase,
      marketPhaseName,
      resumed: false,
    };
  }

  saveCheckpoint(runId: number, metadata: OvernightCheckpointMetadata): OvernightRunRow | null {
    const pointerJson = JSON.stringify(metadata);
    return this._repo.updateRun(runId, {
      checkpointPointer: pointerJson,
    });
  }

  markPhase(runId: number, phase: string, detail?: string): OvernightRunRow | null {
    const now = Date.now();
    return this._appendMetadata(runId, (metadata) => {
      metadata.phaseTransitions.push({
        phase,
        status: 'started',
        recordedAt: now,
        detail,
      });
      metadata.failureContext = null;
      return {
        currentPhase: phase,
        status: OvernightRunStatus.Running,
        metadataJson: this._repo.serializeMetadata(metadata),
        completedAt: null,
        lastError: null,
      };
    });
  }

  markPhaseCompleted(runId: number, phase: OvernightPhase, detail?: string): OvernightRunRow | null {
    const now = Date.now();
    return this._appendMetadata(runId, (metadata) => {
      metadata.phaseTransitions.push({
        phase,
        status: 'completed',
        recordedAt: now,
        detail,
      });
      metadata.lastSuccessfulPhase = phase;
      metadata.failureContext = null;
      return {
        metadataJson: this._repo.serializeMetadata(metadata),
      };
    });
  }

  recordResumeAttempt(runId: number, reason: string, recordedAt: number = Date.now()): OvernightRunRow | null {
    const run = this._repo.getRun(runId);
    if (!run) return null;
    const checkpoint = this.readCheckpoint(run);
    return this._appendMetadata(runId, (metadata) => {
      metadata.resumeAttempts.push({
        resumedAt: recordedAt,
        fromPhase: run.currentPhase,
        checkpointPhase: checkpoint?.phase ?? null,
        reason,
      });
      return {
        metadataJson: this._repo.serializeMetadata(metadata),
      };
    });
  }

  recordPublication(runId: number, publication: OvernightPublicationSnapshot): OvernightRunRow | null {
    return this._appendMetadata(runId, (metadata) => {
      metadata.publication = publication;
      return {
        metadataJson: this._repo.serializeMetadata(metadata),
      };
    });
  }

  markCompleted(runId: number): OvernightRunRow | null {
    const now = Date.now();
    return this._repo.updateRun(runId, {
      status: OvernightRunStatus.Completed,
      currentPhase: 'completed',
      completedAt: now,
      lastError: null,
    });
  }

  markFailed(runId: number, error: string): OvernightRunRow | null {
    const now = Date.now();
    const run = this._repo.getRun(runId);
    const failedPhase = run?.currentPhase ?? this.readCheckpoint(run)?.phase ?? null;
    return this._appendMetadata(runId, (metadata) => {
      if (failedPhase) {
        metadata.phaseTransitions.push({
          phase: failedPhase,
          status: 'failed',
          recordedAt: now,
          detail: error,
        });
      }
      metadata.failureContext = {
        phase: failedPhase,
        message: error,
        recordedAt: now,
      };
      return {
        status: OvernightRunStatus.Failed,
        lastError: error,
        completedAt: now,
        metadataJson: this._repo.serializeMetadata(metadata),
      };
    });
  }

  getRun(runId: number): OvernightRunRow | null {
    return this._repo.getRun(runId);
  }

  getLatestRun(): OvernightRunRow | null {
    return this._repo.getLatestRun();
  }

  readCheckpoint(run: Pick<OvernightRunRow, 'checkpointPointer'> | null | undefined): OvernightCheckpointMetadata | null {
    if (!run?.checkpointPointer) return null;
    try {
      return JSON.parse(run.checkpointPointer) as OvernightCheckpointMetadata;
    } catch {
      return null;
    }
  }

  getNextPhase(run: OvernightRunRow): OvernightPhase {
    const metadata = this._repo.readMetadata(run);
    if (metadata.lastSuccessfulPhase === 'publish') return 'completed';
    if (metadata.lastSuccessfulPhase === 'evaluate') return 'publish';
    if (metadata.lastSuccessfulPhase === 'generate') return 'evaluate';

    const checkpoint = this.readCheckpoint(run);
    if (checkpoint?.phase === 'evaluate' && checkpoint.completedItems >= checkpoint.totalItems) return 'publish';
    if (checkpoint?.phase === 'generate' && checkpoint.completedItems >= checkpoint.totalItems) return 'evaluate';
    if (run.currentPhase === 'publish') return 'publish';
    if (run.currentPhase === 'evaluate') return 'evaluate';
    return 'generate';
  }

  private _appendMetadata(
    runId: number,
    mutate: (metadata: ReturnType<OvernightRunRepo['readMetadata']>) => Partial<Pick<OvernightRunRow, 'status' | 'currentPhase' | 'checkpointPointer' | 'researchDbPath' | 'lastError' | 'metadataJson' | 'startedAt' | 'completedAt'>>,
  ): OvernightRunRow | null {
    const run = this._repo.getRun(runId);
    if (!run) return null;
    const metadata = this._repo.readMetadata(run);
    const updates = mutate(metadata);
    return this._repo.updateRun(runId, updates);
  }

  private _summarizePhase(phase: MarketPhase): string {
    switch (phase) {
      case MarketPhase.PreMarket:
        return 'pre_market';
      case MarketPhase.Regular:
        return 'regular';
      case MarketPhase.PostMarket:
        return 'post_market';
      case MarketPhase.Closed:
        return 'closed';
      default:
        return phase satisfies never;
    }
  }
}
