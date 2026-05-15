// ── Replay Engine ──
// Drives historical ticks through the live strategy pipeline, persisting
// strategy-run artifacts and checkpoint progress for interruption-safe
// replay sessions.

import { StrategyCoordinator } from '../strategy/framework.js';
import { StrategyRunRepository } from '../persistence/strategy-run-repo.js';
import { ReplaySessionRepository } from '../persistence/replay-session-repo.js';
import { ReplayClock } from './replay-clock.js';
import {
  ReplaySessionStatus,
  ReplayFidelity,
  type ReplaySessionRow,
  type ReplayTick,
} from './types.js';
import type { HistoricalDataProvider } from './historical-data-provider.js';
import type {
  NewStrategyRun,
  NewStrategyRunCandidate,
  BoundedCandidate,
  HybridCoordinatorResult,
  PluginScoreEvidence,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// ReplayEngineResult
// ---------------------------------------------------------------------------

/** Outcome of a single replay engine run. */
export interface ReplayEngineResult {
  /** The session row after completion. */
  session: ReplaySessionRow;
  /** Number of ticks successfully processed. */
  ticksProcessed: number;
  /** Total strategy runs persisted. */
  strategyRunsPersisted: number;
  /** Duration of the replay run in ms. */
  durationMs: number;
  /** Whether the run was interrupted (e.g. process killed). */
  wasInterrupted: boolean;
  /** Error message if the session failed, or null. */
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// ReplayEngine
// ---------------------------------------------------------------------------

export class ReplayEngine {
  private readonly _clock: ReplayClock;
  private readonly _dataProvider: HistoricalDataProvider;
  private readonly _coordinator: StrategyCoordinator;
  private readonly _sessionRepo: ReplaySessionRepository;
  private readonly _strategyRunRepo: StrategyRunRepository;
  private readonly _sessionId: number;
  private readonly _rangeStart: number;
  private readonly _rangeEnd: number;

  constructor(options: {
    clock: ReplayClock;
    dataProvider: HistoricalDataProvider;
    coordinator: StrategyCoordinator;
    sessionRepo: ReplaySessionRepository;
    strategyRunRepo: StrategyRunRepository;
    sessionId: number;
    rangeStart: number;
    rangeEnd: number;
  }) {
    this._clock = options.clock;
    this._dataProvider = options.dataProvider;
    this._coordinator = options.coordinator;
    this._sessionRepo = options.sessionRepo;
    this._strategyRunRepo = options.strategyRunRepo;
    this._sessionId = options.sessionId;
    this._rangeStart = options.rangeStart;
    this._rangeEnd = options.rangeEnd;
  }

  /**
   * Run the replay engine from the latest checkpoint (or from tick 0).
   *
   * Iterates through all ticks, calling the data provider for candidates
   * and the strategy coordinator for evaluation, persisting each strategy
   * run and checkpoint atomically.
   *
   * Handles:
   * - Empty tick ranges (session completes with 0 ticks)
   * - Empty candidate sets (strategy run with 0 candidates)
   * - Coordinator errors (session marked failed)
   * - Data provider errors (session marked failed)
   * - Interruption detection (session marked interrupted)
   */
  async run(): Promise<ReplayEngineResult> {
    const startedAt = Date.now();

    // ── Phase 1: Determine resume position ──────────────────────────────
    const latestCheckpoint = this._sessionRepo.getLatestCheckpoint(this._sessionId);
    const resumeIndex = latestCheckpoint ? latestCheckpoint.tickIndex : 0;

    // ── Phase 2: Generate ticks ──────────────────────────────────────────
    const allTicks = this._clock.generateTicks(this._rangeStart, this._rangeEnd);

    if (allTicks.length === 0) {
      // Empty range — complete immediately
      const session = this._sessionRepo.markCompleted(
        this._sessionId,
        startedAt,
        ReplayFidelity.Synthetic,
      );

      return {
        session: session!,
        ticksProcessed: 0,
        strategyRunsPersisted: 0,
        durationMs: Date.now() - startedAt,
        wasInterrupted: false,
        errorMessage: null,
      };
    }

    // Ticks to process = total ticks - already checkpointed ticks
    const ticksToProcess = allTicks.filter(t => t.index > resumeIndex);

    if (ticksToProcess.length === 0) {
      // All ticks already checkpointed — session is complete
      const session = this._sessionRepo.markCompleted(
        this._sessionId,
        startedAt,
        this._dataProvider.getEffectiveFidelity(allTicks[0]),
      );

      return {
        session: session!,
        ticksProcessed: 0,
        strategyRunsPersisted: 0,
        durationMs: Date.now() - startedAt,
        wasInterrupted: false,
        errorMessage: null,
      };
    }

    // Mark session as started
    this._sessionRepo.markStarted(this._sessionId, startedAt);

    // ── Phase 3: Process ticks ───────────────────────────────────────────
    let strategyRunsPersisted = 0;
    let lastError: string | null = null;

    for (const tick of ticksToProcess) {
      try {
        await this._processTick(tick);
        strategyRunsPersisted++;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`[replay-engine] Tick ${tick.index} error: ${lastError}`);

        // Mark session as failed and stop
        this._sessionRepo.markFailed(
          this._sessionId,
          Date.now(),
          lastError,
        );

        return {
          session: this._sessionRepo.getSession(this._sessionId)!,
          ticksProcessed: tick.index - resumeIndex - 1,
          strategyRunsPersisted,
          durationMs: Date.now() - startedAt,
          wasInterrupted: false,
          errorMessage: lastError,
        };
      }
    }

    // ── Phase 4: Mark session completed ──────────────────────────────────
    const effectiveFidelity = allTicks.length > 0
      ? this._dataProvider.getEffectiveFidelity(allTicks[0])
      : ReplayFidelity.Synthetic;

    const session = this._sessionRepo.markCompleted(
      this._sessionId,
      Date.now(),
      effectiveFidelity,
    );

    return {
      session: session!,
      ticksProcessed: ticksToProcess.length,
      strategyRunsPersisted,
      durationMs: Date.now() - startedAt,
      wasInterrupted: false,
      errorMessage: null,
    };
  }

  // -----------------------------------------------------------------------
  // Internal: process a single tick
  // -----------------------------------------------------------------------

  private async _processTick(tick: ReplayTick): Promise<void> {
    const tickStartedAt = Date.now();

    // ── Step 1: Fetch historical candidates ──────────────────────────────
    const candidates: BoundedCandidate[] = await this._dataProvider.getCandidates(tick);
    const fidelity = this._dataProvider.getEffectiveFidelity(tick);

    // ── Step 2: Run through strategy coordinator ─────────────────────────
    const coordinatorResult: HybridCoordinatorResult = await this._coordinator.evaluate(candidates);

    // ── Step 3: Build and persist strategy run + candidates ──────────────
    const strategyRun = this._buildStrategyRun(coordinatorResult, candidates.length, tickStartedAt);
    const candidateRows = this._buildCandidateRows(coordinatorResult);
    const runWithCandidates = this._strategyRunRepo.insertRunWithCandidates(
      strategyRun,
      candidateRows,
    );

    // ── Step 4: Save checkpoint ──────────────────────────────────────────
    this._sessionRepo.saveCheckpoint({
      sessionId: this._sessionId,
      tickIndex: tick.index,
      tickTimestamp: tick.timestamp,
      strategyRunId: runWithCandidates.id,
      metadataJson: JSON.stringify({
        fidelity: fidelity,
        candidateCount: candidates.length,
        runDurationMs: Date.now() - tickStartedAt,
      }),
      savedAt: Date.now(),
    });

    // Update completed tick count
    const session = this._sessionRepo.getSession(this._sessionId);
    if (session) {
      this._sessionRepo.updateSession(this._sessionId, {
        completedTicks: tick.index,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Internal: build strategy run DTOs from coordinator result
  // -----------------------------------------------------------------------

  private _buildStrategyRun(
    result: HybridCoordinatorResult,
    totalEvaluated: number,
    createdAt: number,
  ): NewStrategyRun {
    return {
      frameworkConfig: JSON.stringify(this._coordinator.config),
      pluginsJson: JSON.stringify(this._coordinator.plugins),
      pluginErrorsJson: result.hasPluginErrors
        ? JSON.stringify(result.pluginErrors)
        : null,
      universeSnapshotId: null, // Replay does not use universe snapshots
      totalEvaluated,
      hasPluginErrors: result.hasPluginErrors,
      durationMs: result.durationMs,
      createdAt,
    };
  }

  private _buildCandidateRows(
    result: HybridCoordinatorResult,
  ): NewStrategyRunCandidate[] {
    return result.candidates.map((evidence, idx) => {
      const pluginScores: PluginScoreEvidence[] = evidence.pluginScores;

      return {
        strategyRunId: 0, // placeholder — repo assigns real id in transaction
        candidateKey: evidence.candidateKey,
        rank: idx + 1,
        exchange: evidence.candidate.exchange,
        tradingsymbol: evidence.candidate.tradingsymbol,
        instrumentToken: evidence.candidate.instrumentToken,
        instrumentType: evidence.candidate.instrumentType,
        lotSize: evidence.candidate.lotSize,
        tickSize: evidence.candidate.tickSize,
        side: evidence.candidate.side,
        lastPrice: evidence.candidate.lastPrice,
        bid: evidence.candidate.bid,
        ask: evidence.candidate.ask,
        volume: evidence.candidate.volume,
        scoresJson: JSON.stringify(pluginScores),
        deterministicScore: evidence.deterministicScore,
        llmScore: evidence.llmScore,
        llmStatus: evidence.llmStatus ?? null,
        llmRationale: evidence.llmRationale,
        mergedScore: evidence.mergedScore,
        mergePolicy: evidence.mergePolicy ?? null,
        proposalParamsJson: evidence.proposalParams
          ? JSON.stringify(evidence.proposalParams)
          : null,
        pluginErrorsJson: evidence.hasPluginErrors
          ? JSON.stringify(evidence.pluginErrors)
          : null,
        hasPluginErrors: evidence.hasPluginErrors,
        emitted: false,
        proposalAttemptId: null,
      };
    });
  }
}
