// ── OvernightOrchestrator ──
// Durable overnight research orchestration seam that:
// 1. Applies a market-window gate via MarketClock so open/pre/post phases
//    refuse execution and closed windows proceed.
// 2. Persists run-level state (status, phase, checkpoint, error) in the
//    overnight_runs table via OvernightRunRepo.
// 3. Exposes checkpoint/audit metadata for resume by a future agent.
//
// This path is intentionally separate from src/runtime/scheduler.ts and
// the current runtime boot sequence. It operates entirely on the research
// workspace and the overnight_runs DB table without touching live runtime state.

import { MarketClock } from '../runtime/market-clock.js';
import { MarketPhase } from '../types/runtime.js';
import {
  OvernightRunRepo,
  OvernightRunStatus,
  type OvernightRunRow,
  type NewOvernightRun,
  type OvernightCheckpointMetadata,
} from './overnight-run-repo.js';

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/** Outcome of a tryStart attempt. */
export interface TryStartResult {
  /** The persisted run row (accepted or refused). */
  run: OvernightRunRow;
  /** True when the run was accepted and marked running. */
  accepted: boolean;
  /** Human-readable reason when accepted is false. */
  refusalReason: string | null;
  /** The market phase at decision time. */
  marketPhase: MarketPhase;
  /** Human-readable market phase name. */
  marketPhaseName: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class OvernightOrchestrator {
  private readonly _repo: OvernightRunRepo;
  private readonly _clock: MarketClock;

  constructor(repo: OvernightRunRepo, clock: MarketClock) {
    this._repo = repo;
    this._clock = clock;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Attempt to start a new overnight research run.
   *
   * Market-window gate behaviour:
   * - When the market is closed (weekend, holiday, after-hours), creates a
   *   pending run, immediately marks it running, and returns accepted=true.
   * - When the market is open (pre, regular, or post), creates a refused run
   *   with the refusal reason and returns accepted=false.
   *
   * @param label - Human-readable label for the run.
   * @param workspacePath - Path to the research workspace for this run.
   * @param now - Optional timestamp override (used by tests).
   * @returns TryStartResult with the persisted run row and gate outcome.
   */
  tryStart(label: string, workspacePath: string, now?: Date): TryStartResult {
    const nowDate = now ?? new Date();
    const marketPhase = this._clock.getPhase(nowDate);
    const marketPhaseName = this._summarizePhase(marketPhase);
    const createdAt = nowDate.getTime();

    if (this._clock.isClosed(nowDate)) {
      // Market is closed — accept and start the run
      const newRun: NewOvernightRun = {
        label,
        status: OvernightRunStatus.Running,
        marketPhase: marketPhase,
        currentPhase: 'generate',
        workspacePath,
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
      };
    }

    // Market is open — refuse
    const refusalReason = `Market is open (phase: ${marketPhaseName}). Overnight research runs are only accepted during closed market windows.`;

    const refusedRun: NewOvernightRun = {
      label,
      status: OvernightRunStatus.Refused,
      marketPhase: marketPhase,
      workspacePath,
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
    };
  }

  /**
   * Save a checkpoint for an active run.
   *
   * Serialises the checkpoint metadata to JSON and stores it in the
   * checkpoint_pointer column. Does not change the run status.
   *
   * @returns The updated run row, or null if the run does not exist.
   */
  saveCheckpoint(runId: number, metadata: OvernightCheckpointMetadata): OvernightRunRow | null {
    const pointerJson = JSON.stringify(metadata);
    return this._repo.updateRun(runId, {
      checkpointPointer: pointerJson,
    });
  }

  /**
   * Update the current phase of an active run.
   *
   * @returns The updated run row, or null if the run does not exist.
   */
  markPhase(runId: number, phase: string): OvernightRunRow | null {
    return this._repo.updateRun(runId, {
      currentPhase: phase,
    });
  }

  /**
   * Mark a run as completed.
   *
   * @returns The updated run row, or null if the run does not exist.
   */
  markCompleted(runId: number): OvernightRunRow | null {
    const now = Date.now();
    return this._repo.updateRun(runId, {
      status: OvernightRunStatus.Completed,
      completedAt: now,
    });
  }

  /**
   * Mark a run as failed with an error message.
   *
   * @returns The updated run row, or null if the run does not exist.
   */
  markFailed(runId: number, error: string): OvernightRunRow | null {
    const now = Date.now();
    return this._repo.updateRun(runId, {
      status: OvernightRunStatus.Failed,
      lastError: error,
      completedAt: now,
    });
  }

  /**
   * Get a run by id.
   */
  getRun(runId: number): OvernightRunRow | null {
    return this._repo.getRun(runId);
  }

  /**
   * Get the latest run across all runs.
   */
  getLatestRun(): OvernightRunRow | null {
    return this._repo.getLatestRun();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Build a human-readable market phase string for error messages and audit trails.
   */
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
