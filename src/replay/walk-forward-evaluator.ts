// ── Walk-Forward Evaluator ──
// Partitions historical data into rolling windows, generates a bounded search
// space over strategy settings, executes each window through the shared replay
// seam, checkpoints durable progress, and can resume interrupted runs without
// restarting already-persisted trials.

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { ReplayClock } from './replay-clock.js';
import { runReplay } from './replay-runner.js';
import { ReplaySessionRepository } from '../persistence/replay-session-repo.js';
import { StrategyRunRepository } from '../persistence/strategy-run-repo.js';
import { ProposalEngine } from '../proposals/proposal-engine.js';
import { LLMStatus, type StrategyRunWithCandidates } from '../types/runtime.js';
import type { HistoricalDataProvider } from './historical-data-provider.js';
import type { MarketProfile } from '../market/market-profile.js';
import { WalkForwardRepository } from '../persistence/walk-forward-repo.js';
import { ReplaySessionStatus } from './types.js';
import {
  WalkForwardStatus,
  WalkForwardWindowStatus,
  WalkForwardWindowType,
  type WalkForwardRunRow,
  type WalkForwardWindowRow,
  type WalkForwardTrialWindowRow,
  type WalkForwardRankedCandidate,
  type WalkForwardReplayEvidence,
  type WalkForwardWindowMetricsEnvelope,
} from './walk-forward-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalkForwardTrialConfig {
  label: string;
  params: Record<string, unknown>;
  llmConfig?: {
    enabled: boolean;
    weight?: number;
    temperature?: number;
    maxCandidates?: number;
    [key: string]: unknown;
  };
}

export interface WalkForwardParamSpace {
  maxCandidates?: number[];
  volumeWeight?: number[];
  spreadWeight?: number[];
  llmEnabled?: boolean[];
  llmWeight?: number[];
  llmTemperature?: number[];
}

export interface WindowMetrics {
  totalReturn: number;
  sharpeRatio: number | null;
  maxDrawdown: number | null;
  winRate: number | null;
  tradeCount: number;
  profitFactor: number | null;
  deterministicScore: number | null;
  mergedScore: number | null;
  extendedMetrics: WalkForwardWindowMetricsEnvelope | null;
  /** LLM consultation status summarized from persisted replay evidence. */
  llmStatus: string | null;
  /** Average truthful LLM score across ticks where LLM was consulted, or null. */
  llmScore: number | null;
  /** Number of ticks where LLM was actually consulted. */
  llmTickCount: number;
}

export interface WalkForwardAggregateMetrics {
  scoreStability: number;
  topKOverlap: number;
  llmConsultationRate: number | null;
  llmDivergence: number | null;
}

export interface EvaluatorRunResult {
  run: WalkForwardRunRow;
  windows: WalkForwardWindowRow[];
  trials: WalkForwardTrialWithWindows[];
  rankedCandidates: WalkForwardRankedCandidate[];
  aggregateMetrics: WalkForwardAggregateMetrics;
}

interface ReplayExecutionTruthMetrics {
  available: boolean;
  tradeCount: number;
  realizedPnl: number;
  grossProfit: number;
  grossLoss: number;
  winCount: number;
  lossCount: number;
  totalFees: number;
  totalSlippage: number;
  maxDrawdown: number | null;
}

interface PartitionedWindow {
  index: number;
  label: string;
  inSampleStart: number;
  inSampleEnd: number;
  outOfSampleStart: number;
  outOfSampleEnd: number;
}

interface TrialState {
  config: WalkForwardTrialConfig;
  trialIndex: number;
  windowMetrics: Array<{
    windowIndex: number;
    windowType: WalkForwardWindowType;
    metrics: WindowMetrics;
  }>;
  aggregateMergedScore: number;
  aggregateDeterministicScore: number;
  aggregateLlmScore: number | null;
  llmStatus: string | null;
}

interface WalkForwardTrialWithWindows {
  trialId: number;
  trialIndex: number;
  label: string;
  paramsJson: string;
  mergedScore: number;
  deterministicScore: number;
  llmScore: number | null;
  llmStatus: string | null;
  rank: number;
  createdAt: number;
  windowEvidence: WalkForwardTrialWindowRow[];
}

class WalkForwardInterruptionError extends Error {
  readonly runId: number;

  constructor(runId: number, message: string) {
    super(message);
    this.name = 'WalkForwardInterruptionError';
    this.runId = runId;
  }
}

const DEFAULT_IN_SAMPLE_RATIO = 0.8;
const DEFAULT_WINDOW_SIZE_MS = 7 * 86_400_000;
const DEFAULT_STEP_SIZE_MS = 1 * 86_400_000;
const MIN_WINDOW_SIZE_MS = 3600_000;
const MIN_STEP_SIZE_MS = 300_000;
const WIN_SCORE_THRESHOLD = 0.6;
const WALK_FORWARD_ARTIFACTS_ROOT = path.join('data', 'artifacts', 'walk-forward');

interface WalkForwardProgressSnapshot {
  schemaVersion: 1;
  artifactType: 'walk-forward-progress';
  runId: number;
  runLabel: string;
  strategyId: string;
  strategyVersion: string;
  marketId: string;
  status: WalkForwardStatus;
  windowCount: number;
  totalTrials: number;
  completedTrialCount: number;
  lastCompletedTrialIndex: number | null;
  checkpointCount: number;
  resumedFromRunId: number | null;
  activeTrialIndex: number | null;
  activeTrialLabel: string | null;
  activeWindowIndex: number | null;
  activeWindowLabel: string | null;
  activeWindowType: WalkForwardWindowType | null;
  activeReplayLabel: string | null;
  updatedAt: number;
  lastError: string | null;
}

export class WalkForwardEvaluator {
  private readonly _repo: WalkForwardRepository;
  private readonly _clock: ReplayClock;
  private readonly _dataProvider: HistoricalDataProvider;
  private readonly _marketProfile: MarketProfile;
  private readonly _db: Database.Database;
  private readonly _proposalEngine?: ProposalEngine;
  private readonly _replaySessionRepo: ReplaySessionRepository;
  private readonly _strategyRunRepo: StrategyRunRepository;

  constructor(options: {
    db: Database.Database;
    marketProfile: MarketProfile;
    dataProvider: HistoricalDataProvider;
    proposalEngine?: ProposalEngine;
    repo?: WalkForwardRepository;
    clock?: ReplayClock;
  }) {
    this._db = options.db;
    this._repo = options.repo ?? new WalkForwardRepository(options.db);
    this._marketProfile = options.marketProfile;
    this._clock = options.clock ?? new ReplayClock(options.marketProfile);
    this._dataProvider = options.dataProvider;
    this._proposalEngine = options.proposalEngine;
    this._replaySessionRepo = new ReplaySessionRepository(options.db);
    this._strategyRunRepo = new StrategyRunRepository(options.db);
  }

  async evaluate(config: WalkForwardEvaluatorConfig): Promise<EvaluatorRunResult> {
    this._validateConfig(config);

    const now = Date.now();
    const {
      rangeStart,
      rangeEnd,
      windowSizeMs = DEFAULT_WINDOW_SIZE_MS,
      stepSizeMs = DEFAULT_STEP_SIZE_MS,
      inSampleRatio = DEFAULT_IN_SAMPLE_RATIO,
      strategyId = 'india-nse-eq-v1',
      strategyVersion = '1.0.0',
      marketId = 'INDIA_NSE_EQ',
      label = `walk-forward-${new Date(now).toISOString().slice(0, 10)}`,
      stopAfterTrialCount,
      resumeRunId,
      cadenceMinutes = this._clock.getCadenceMinutes(),
    } = config;

    const windows = this._partitionWindows(
      rangeStart,
      rangeEnd,
      windowSizeMs,
      stepSizeMs,
      inSampleRatio,
    );

    if (windows.length === 0) {
      throw new Error(
        `No windows can be created for range [${new Date(rangeStart).toISOString()} → ` +
        `${new Date(rangeEnd).toISOString()}] with windowSize=${windowSizeMs}, stepSize=${stepSizeMs}`,
      );
    }

    const trialConfigs = this._generateTrialConfigs(config.trialConfigs ?? [], config.paramSpace);
    if (trialConfigs.length === 0) {
      throw new Error('No trial configurations generated — provide trialConfigs or paramSpace');
    }
    if (trialConfigs.length > 50) {
      throw new Error(`Trial config count ${trialConfigs.length} exceeds maximum of 50 — reduce the parameter space`);
    }

    const state = this._loadOrCreateRun({
      resumeRunId,
      label,
      strategyId,
      strategyVersion,
      marketId,
      windows,
      trialConfigs,
      now,
    });

    this._writeProgressSnapshot(state.run, {
      status: state.run.status,
      completedTrialCount: this._repo.countTrialsForRun(state.run.id),
      lastCompletedTrialIndex: this._repo.getLatestCheckpoint(state.run.id)?.lastCompletedTrialIndex ?? null,
      checkpointCount: this._repo.countCheckpoints(state.run.id),
      resumedFromRunId: resumeRunId ?? null,
      updatedAt: now,
      lastError: null,
    });

    try {
      let persistedCount = this._repo.countTrialsForRun(state.run.id);
      const completedTrialIndexes = new Set(
        this._repo.getTrialsForRunByIndex(state.run.id).map(trial => trial.trialIndex),
      );

      for (let ti = 0; ti < trialConfigs.length; ti++) {
        if (completedTrialIndexes.has(ti)) continue;

        const trialConfig = trialConfigs[ti];
        const checkpointCountBeforeTrial = this._repo.countCheckpoints(state.run.id);
        console.log(
          `[walk-forward] run ${state.run.id} starting trial ${ti + 1}/${trialConfigs.length}: ${trialConfig.label}`,
        );
        this._writeProgressSnapshot(state.run, {
          status: WalkForwardStatus.Running,
          completedTrialCount: persistedCount,
          lastCompletedTrialIndex: this._repo.getLatestCheckpoint(state.run.id)?.lastCompletedTrialIndex ?? null,
          checkpointCount: checkpointCountBeforeTrial,
          resumedFromRunId: resumeRunId ?? null,
          activeTrialIndex: ti,
          activeTrialLabel: trialConfig.label,
          updatedAt: Date.now(),
          lastError: null,
        });

        const trialState = await this._evaluateTrial(
          state.run,
          ti,
          trialConfig,
          windows,
          strategyId,
          strategyVersion,
          marketId,
          cadenceMinutes,
          config.enablePaperExecution ?? (this._dataProvider.getResolutionMetadata?.().supportsFineGrainedExecution ?? false),
        );

        this._persistTrial(state.run.id, state.insertedWindows, trialState, now);
        persistedCount += 1;
        completedTrialIndexes.add(ti);

        const checkpoint = this._repo.saveCheckpoint({
          runId: state.run.id,
          completedTrialCount: persistedCount,
          lastCompletedTrialIndex: ti,
          metadataJson: JSON.stringify({
            resumedFromRunId: resumeRunId ?? null,
            totalTrials: trialConfigs.length,
            windowCount: windows.length,
            lastCompletedTrialLabel: trialConfig.label,
            cadenceMinutes,
            rangeStart,
            rangeEnd,
            windowSizeMs,
            stepSizeMs,
            inSampleRatio,
            label,
            strategyId,
            strategyVersion,
            marketId,
            trialConfigs,
          }),
          savedAt: Date.now(),
        });
        console.log(
          `[walk-forward] run ${state.run.id} checkpoint ${checkpoint.id} saved after trial ${ti + 1}/${trialConfigs.length}`,
        );
        this._writeProgressSnapshot(state.run, {
          status: WalkForwardStatus.Running,
          completedTrialCount: persistedCount,
          lastCompletedTrialIndex: ti,
          checkpointCount: this._repo.countCheckpoints(state.run.id),
          resumedFromRunId: resumeRunId ?? null,
          updatedAt: checkpoint.savedAt,
          lastError: null,
        });

        if (stopAfterTrialCount != null && persistedCount >= stopAfterTrialCount) {
          this._repo.markInterrupted(state.run.id);
          this._writeProgressSnapshot(state.run, {
            status: WalkForwardStatus.Interrupted,
            completedTrialCount: persistedCount,
            lastCompletedTrialIndex: ti,
            checkpointCount: this._repo.countCheckpoints(state.run.id),
            resumedFromRunId: resumeRunId ?? null,
            updatedAt: Date.now(),
            lastError: `Interrupted after ${persistedCount} persisted trial(s) for resume verification`,
          });
          throw new WalkForwardInterruptionError(
            state.run.id,
            `Interrupted after ${persistedCount} persisted trial(s) for resume verification`,
          );
        }
      }

      this._finalizeRun(state.run.id);
      this._writeProgressSnapshot(state.run, {
        status: WalkForwardStatus.Completed,
        completedTrialCount: persistedCount,
        lastCompletedTrialIndex: persistedCount > 0 ? persistedCount - 1 : null,
        checkpointCount: this._repo.countCheckpoints(state.run.id),
        resumedFromRunId: resumeRunId ?? null,
        updatedAt: Date.now(),
        lastError: null,
      });
      return this._buildResult(state.run.id);
    } catch (error) {
      if (error instanceof WalkForwardInterruptionError) {
        throw error;
      }

      const failedAt = Date.now();
      this._repo.markFailed(state.run.id, failedAt);
      this._writeProgressSnapshot(state.run, {
        status: WalkForwardStatus.Failed,
        completedTrialCount: this._repo.countTrialsForRun(state.run.id),
        lastCompletedTrialIndex: this._repo.getLatestCheckpoint(state.run.id)?.lastCompletedTrialIndex ?? null,
        checkpointCount: this._repo.countCheckpoints(state.run.id),
        resumedFromRunId: resumeRunId ?? null,
        updatedAt: failedAt,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private _loadOrCreateRun(options: {
    resumeRunId?: number;
    label: string;
    strategyId: string;
    strategyVersion: string;
    marketId: string;
    windows: PartitionedWindow[];
    trialConfigs: WalkForwardTrialConfig[];
    now: number;
  }): { run: WalkForwardRunRow; insertedWindows: WalkForwardWindowRow[] } {
    if (options.resumeRunId != null) {
      const run = this._repo.getRun(options.resumeRunId);
      if (!run) throw new Error(`Walk-forward run ${options.resumeRunId} does not exist`);
      if (run.status === WalkForwardStatus.Completed) {
        throw new Error(`Walk-forward run ${options.resumeRunId} is already completed`);
      }
      if (run.windowCount !== options.windows.length) {
        throw new Error(
          `Resume mismatch: run ${run.id} expects ${run.windowCount} windows but current config produced ${options.windows.length}`,
        );
      }
      if (run.totalTrials !== options.trialConfigs.length) {
        throw new Error(
          `Resume mismatch: run ${run.id} expects ${run.totalTrials} trials but current config produced ${options.trialConfigs.length}`,
        );
      }

      const insertedWindows = this._repo.getWindowsForRun(run.id);
      if (insertedWindows.length !== options.windows.length) {
        throw new Error(`Walk-forward run ${run.id} is missing persisted windows required for resume`);
      }

      const resumed = this._repo.updateRun(run.id, {
        status: WalkForwardStatus.Running,
        startedAt: run.startedAt ?? options.now,
        completedAt: null,
      });
      return { run: resumed ?? run, insertedWindows };
    }

    const run = this._repo.insertRun({
      label: options.label,
      strategyId: options.strategyId,
      strategyVersion: options.strategyVersion,
      marketId: options.marketId,
      replaySessionId: null,
      windowCount: options.windows.length,
      totalTrials: options.trialConfigs.length,
      status: WalkForwardStatus.Running,
      createdAt: options.now,
      startedAt: options.now,
      completedAt: null,
    });

    const insertedWindows = options.windows.map(window =>
      this._repo.insertWindow({
        runId: run.id,
        windowIndex: window.index,
        rangeStart: window.inSampleStart,
        rangeEnd: window.outOfSampleEnd,
        windowLabel: window.label,
        trialCountOptimized: 0,
        trialCountTested: 0,
        status: WalkForwardWindowStatus.Pending,
        createdAt: options.now,
      }),
    );

    return { run, insertedWindows };
  }

  private _persistTrial(
    runId: number,
    insertedWindows: WalkForwardWindowRow[],
    trialState: TrialState,
    createdAt: number,
  ): void {
    const trial = this._repo.insertTrial({
      runId,
      trialIndex: trialState.trialIndex,
      label: trialState.config.label,
      paramsJson: JSON.stringify(trialState.config),
      mergedScore: trialState.aggregateMergedScore,
      deterministicScore: trialState.aggregateDeterministicScore,
      llmScore: trialState.aggregateLlmScore,
      llmStatus: trialState.llmStatus,
      rank: 0,
      createdAt,
    });

    for (const wm of trialState.windowMetrics) {
      const windowRow = insertedWindows.find(w => w.windowIndex === wm.windowIndex);
      if (!windowRow) {
        throw new Error(`Missing persisted window for index ${wm.windowIndex}`);
      }

      this._repo.linkTrialToWindow({
        trialId: trial.id,
        windowId: windowRow.id,
        windowType: wm.windowType,
        totalReturn: wm.metrics.totalReturn,
        sharpeRatio: wm.metrics.sharpeRatio,
        maxDrawdown: wm.metrics.maxDrawdown,
        winRate: wm.metrics.winRate,
        tradeCount: wm.metrics.tradeCount,
        profitFactor: wm.metrics.profitFactor,
        metricsJson: wm.metrics.extendedMetrics ? JSON.stringify(wm.metrics.extendedMetrics) : null,
        createdAt,
      });
    }
  }

  private _finalizeRun(runId: number): void {
    const trials = this._repo.getTrialsForRunByIndex(runId);
    const ranked = [...trials].sort((a, b) => {
      if (b.mergedScore !== a.mergedScore) return b.mergedScore - a.mergedScore;
      return a.trialIndex - b.trialIndex;
    });

    ranked.forEach((trial, index) => {
      this._repo.updateTrial(trial.id, { rank: index + 1 });
    });

    const windows = this._repo.getWindowsForRun(runId);
    for (const window of windows) {
      const evidence = this._repo.getWindowEvidence(window.id);
      const optimized = evidence.filter(row => row.windowType === WalkForwardWindowType.InSample).length;
      const tested = evidence.filter(row => row.windowType === WalkForwardWindowType.OutOfSample).length;
      this._repo.updateWindow(window.id, {
        status: WalkForwardWindowStatus.Completed,
        trialCountOptimized: optimized,
        trialCountTested: tested,
      });
    }

    this._repo.markCompleted(runId, Date.now());
  }

  private _buildResult(runId: number): EvaluatorRunResult {
    const run = this._repo.getRun(runId);
    if (!run) throw new Error(`Walk-forward run ${runId} disappeared before result build`);

    const windows = this._repo.getWindowsForRun(runId);
    const trials = this._repo.getTrialsForRun(runId).map(trial => ({
      trialId: trial.id,
      trialIndex: trial.trialIndex,
      label: trial.label,
      paramsJson: trial.paramsJson,
      mergedScore: trial.mergedScore,
      deterministicScore: trial.deterministicScore,
      llmScore: trial.llmScore,
      llmStatus: trial.llmStatus,
      rank: trial.rank,
      createdAt: trial.createdAt,
      windowEvidence: this._repo.getTrialWindowEvidence(trial.id),
    }));

    const rankedCandidates = this._repo.getRankedCandidates(runId);
    const aggregateMetrics = this._computeAggregateMetrics(trials, rankedCandidates);

    return {
      run,
      windows,
      trials,
      rankedCandidates,
      aggregateMetrics,
    };
  }

  private _validateConfig(config: WalkForwardEvaluatorConfig): void {
    if (config.rangeStart >= config.rangeEnd) {
      throw new Error(`rangeStart (${config.rangeStart}) must be before rangeEnd (${config.rangeEnd})`);
    }

    const windowSizeMs = config.windowSizeMs ?? DEFAULT_WINDOW_SIZE_MS;
    const stepSizeMs = config.stepSizeMs ?? DEFAULT_STEP_SIZE_MS;
    const inSampleRatio = config.inSampleRatio ?? DEFAULT_IN_SAMPLE_RATIO;

    if (windowSizeMs < MIN_WINDOW_SIZE_MS) {
      throw new Error(`windowSizeMs (${windowSizeMs}) must be >= ${MIN_WINDOW_SIZE_MS}ms (1 hour)`);
    }
    if (stepSizeMs < MIN_STEP_SIZE_MS) {
      throw new Error(`stepSizeMs (${stepSizeMs}) must be >= ${MIN_STEP_SIZE_MS}ms (5 minutes)`);
    }
    if (config.cadenceMinutes != null && (!Number.isFinite(config.cadenceMinutes) || config.cadenceMinutes < 1)) {
      throw new Error(`cadenceMinutes (${config.cadenceMinutes}) must be >= 1 minute`);
    }
    if (stepSizeMs > windowSizeMs) {
      throw new Error(`stepSizeMs (${stepSizeMs}) must not exceed windowSizeMs (${windowSizeMs})`);
    }
    if (inSampleRatio <= 0 || inSampleRatio >= 1) {
      throw new Error(`inSampleRatio (${inSampleRatio}) must be between 0 (exclusive) and 1 (exclusive)`);
    }

    const rangeSpanMs = config.rangeEnd - config.rangeStart;
    if (rangeSpanMs < windowSizeMs) {
      throw new Error(`Date range span (${rangeSpanMs}ms) must be >= windowSizeMs (${windowSizeMs}ms)`);
    }
    if (!this._dataProvider.hasData(config.rangeStart, config.rangeEnd)) {
      throw new Error('Data provider has no data for the configured range');
    }
  }

  private _partitionWindows(
    rangeStart: number,
    rangeEnd: number,
    windowSizeMs: number,
    stepSizeMs: number,
    inSampleRatio: number,
  ): PartitionedWindow[] {
    const windows: PartitionedWindow[] = [];
    let index = 0;
    let winStart = rangeStart;

    while (winStart + windowSizeMs <= rangeEnd) {
      const winEnd = winStart + windowSizeMs;
      const splitPoint = winStart + Math.round(windowSizeMs * inSampleRatio);
      windows.push({
        index,
        label: `W${String(index + 1).padStart(2, '0')} ${new Date(winStart).toISOString().slice(0, 10)}`,
        inSampleStart: winStart,
        inSampleEnd: splitPoint,
        outOfSampleStart: splitPoint,
        outOfSampleEnd: winEnd,
      });
      index += 1;
      winStart += stepSizeMs;
    }

    return windows;
  }

  private _generateTrialConfigs(
    explicitConfigs: WalkForwardTrialConfig[],
    paramSpace?: WalkForwardParamSpace,
  ): WalkForwardTrialConfig[] {
    if (explicitConfigs.length > 0) return explicitConfigs;
    if (!paramSpace) return [];

    const configs: WalkForwardTrialConfig[] = [];
    const maxCandidatesValues = paramSpace.maxCandidates ?? [5];
    const llmEnabledValues = paramSpace.llmEnabled ?? [false];

    for (const maxCand of maxCandidatesValues) {
      for (const llmEnabled of llmEnabledValues) {
        const trialConfig: WalkForwardTrialConfig = {
          label: `mc${maxCand}-llm${llmEnabled ? 'on' : 'off'}`,
          params: { maxCandidates: maxCand },
        };
        if (llmEnabled) {
          trialConfig.llmConfig = {
            enabled: true,
            weight: 0.5,
            temperature: 0.7,
            maxCandidates: maxCand,
          };
        }
        configs.push(trialConfig);
      }
    }

    return configs;
  }

  private async _evaluateTrial(
    run: WalkForwardRunRow,
    trialIndex: number,
    config: WalkForwardTrialConfig,
    windows: PartitionedWindow[],
    strategyId: string,
    strategyVersion: string,
    marketId: string,
    cadenceMinutes: number,
    enablePaperExecution: boolean,
  ): Promise<TrialState> {
    const windowMetrics: TrialState['windowMetrics'] = [];
    let aggregateMergedSum = 0;
    let aggregateMergedCount = 0;
    let aggregateDeterministicSum = 0;
    let aggregateDeterministicCount = 0;
    let aggregateLlmSum = 0;
    let aggregateLlmCount = 0;
    const llmStatuses = new Set<string>();

    for (const window of windows) {
      const inReplayLabel = this._buildReplayLabel({
        runId: run.id,
        trialIndex,
        trialLabel: config.label,
        window,
        windowType: WalkForwardWindowType.InSample,
      });
      console.log(
        `[walk-forward] run ${run.id} trial ${trialIndex + 1} window ${window.index + 1}/${windows.length} in-sample replay ${inReplayLabel}`,
      );
      this._writeProgressSnapshot(run, {
        status: WalkForwardStatus.Running,
        completedTrialCount: this._repo.countTrialsForRun(run.id),
        lastCompletedTrialIndex: this._repo.getLatestCheckpoint(run.id)?.lastCompletedTrialIndex ?? null,
        checkpointCount: this._repo.countCheckpoints(run.id),
        activeTrialIndex: trialIndex,
        activeTrialLabel: config.label,
        activeWindowIndex: window.index,
        activeWindowLabel: window.label,
        activeWindowType: WalkForwardWindowType.InSample,
        activeReplayLabel: inReplayLabel,
        updatedAt: Date.now(),
        resumedFromRunId: null,
        lastError: null,
      });
      const inSampleMetrics = await this._evaluateWindowRange({
        runId: run.id,
        trialIndex,
        trialLabel: config.label,
        strategyId,
        strategyVersion,
        marketId,
        window,
        windowType: WalkForwardWindowType.InSample,
        rangeStart: window.inSampleStart,
        rangeEnd: window.inSampleEnd,
        maxCandidates: (config.params.maxCandidates as number) ?? config.llmConfig?.maxCandidates ?? 5,
        cadenceMinutes,
        enablePaperExecution,
      });
      windowMetrics.push({
        windowIndex: window.index,
        windowType: WalkForwardWindowType.InSample,
        metrics: inSampleMetrics,
      });

      const outReplayLabel = this._buildReplayLabel({
        runId: run.id,
        trialIndex,
        trialLabel: config.label,
        window,
        windowType: WalkForwardWindowType.OutOfSample,
      });
      console.log(
        `[walk-forward] run ${run.id} trial ${trialIndex + 1} window ${window.index + 1}/${windows.length} out-of-sample replay ${outReplayLabel}`,
      );
      this._writeProgressSnapshot(run, {
        status: WalkForwardStatus.Running,
        completedTrialCount: this._repo.countTrialsForRun(run.id),
        lastCompletedTrialIndex: this._repo.getLatestCheckpoint(run.id)?.lastCompletedTrialIndex ?? null,
        checkpointCount: this._repo.countCheckpoints(run.id),
        activeTrialIndex: trialIndex,
        activeTrialLabel: config.label,
        activeWindowIndex: window.index,
        activeWindowLabel: window.label,
        activeWindowType: WalkForwardWindowType.OutOfSample,
        activeReplayLabel: outReplayLabel,
        updatedAt: Date.now(),
        resumedFromRunId: null,
        lastError: null,
      });
      const outOfSampleMetrics = await this._evaluateWindowRange({
        runId: run.id,
        trialIndex,
        trialLabel: config.label,
        strategyId,
        strategyVersion,
        marketId,
        window,
        windowType: WalkForwardWindowType.OutOfSample,
        rangeStart: window.outOfSampleStart,
        rangeEnd: window.outOfSampleEnd,
        maxCandidates: (config.params.maxCandidates as number) ?? config.llmConfig?.maxCandidates ?? 5,
        cadenceMinutes,
        enablePaperExecution,
      });
      windowMetrics.push({
        windowIndex: window.index,
        windowType: WalkForwardWindowType.OutOfSample,
        metrics: outOfSampleMetrics,
      });

      for (const metrics of [inSampleMetrics, outOfSampleMetrics]) {
        if (metrics.mergedScore != null) {
          aggregateMergedSum += metrics.mergedScore;
          aggregateMergedCount += 1;
        }
        if (metrics.deterministicScore != null) {
          aggregateDeterministicSum += metrics.deterministicScore;
          aggregateDeterministicCount += 1;
        }
        if (metrics.llmScore != null) {
          aggregateLlmSum += metrics.llmScore;
          aggregateLlmCount += 1;
        }
        if (metrics.llmStatus != null) {
          llmStatuses.add(metrics.llmStatus);
        }
      }
    }

    return {
      config,
      trialIndex,
      windowMetrics,
      aggregateMergedScore: aggregateMergedCount > 0
        ? +(aggregateMergedSum / aggregateMergedCount).toFixed(4)
        : 0,
      aggregateDeterministicScore: aggregateDeterministicCount > 0
        ? +(aggregateDeterministicSum / aggregateDeterministicCount).toFixed(4)
        : 0,
      aggregateLlmScore: aggregateLlmCount > 0
        ? +(aggregateLlmSum / aggregateLlmCount).toFixed(4)
        : null,
      llmStatus: this._summarizeLlmStatus(llmStatuses),
    };
  }

  private async _evaluateWindowRange(options: {
    runId: number;
    trialIndex: number;
    trialLabel: string;
    strategyId: string;
    strategyVersion: string;
    marketId: string;
    window: PartitionedWindow;
    windowType: WalkForwardWindowType;
    rangeStart: number;
    rangeEnd: number;
    maxCandidates: number;
    cadenceMinutes: number;
    enablePaperExecution: boolean;
  }): Promise<WindowMetrics> {
    const replayResult = await runReplay({
      db: this._db,
      marketProfile: this._marketProfile,
      dataProvider: this._dataProvider,
      proposalEngine: this._proposalEngine,
      maxCandidates: options.maxCandidates,
      cadenceMinutes: options.cadenceMinutes,
      label: this._buildReplayLabel(options),
      strategyId: options.strategyId,
      strategyVersion: options.strategyVersion,
      marketId: options.marketId,
      rangeStart: options.rangeStart,
      rangeEnd: options.rangeEnd,
      enablePaperExecution: options.enablePaperExecution,
    });

    if (replayResult.session.status !== ReplaySessionStatus.Completed) {
      throw new Error(
        `Replay-backed window evaluation failed for ${options.trialLabel} ${options.window.label} ` +
        `${options.windowType}: ${replayResult.engineResult.errorMessage ?? replayResult.session.errorMessage ?? replayResult.session.status}`,
      );
    }

    return this._summarizeReplaySession(replayResult.session.id);
  }

  private _buildReplayLabel(options: {
    runId: number;
    trialIndex: number;
    trialLabel: string;
    window: PartitionedWindow;
    windowType: WalkForwardWindowType;
  }): string {
    const typeLabel = options.windowType === WalkForwardWindowType.InSample ? 'in' : 'out';
    return [
      `wf${options.runId}`,
      `t${String(options.trialIndex + 1).padStart(2, '0')}`,
      typeLabel,
      options.window.label.replace(/\s+/g, '-'),
      options.trialLabel.replace(/\s+/g, '-').slice(0, 32),
    ].join('-');
  }

  private _progressPath(runId: number): string {
    return path.join(WALK_FORWARD_ARTIFACTS_ROOT, String(runId), 'progress.json');
  }

  private _writeProgressSnapshot(
    run: WalkForwardRunRow,
    snapshot: Partial<Omit<WalkForwardProgressSnapshot,
      'schemaVersion' | 'artifactType' | 'runId' | 'runLabel' | 'strategyId' | 'strategyVersion' | 'marketId' | 'windowCount' | 'totalTrials'>> & {
      status: WalkForwardStatus;
      completedTrialCount: number;
      lastCompletedTrialIndex: number | null;
      checkpointCount: number;
      updatedAt: number;
      lastError: string | null;
    },
  ): void {
    const progressDir = path.dirname(this._progressPath(run.id));
    fs.mkdirSync(progressDir, { recursive: true });

    const payload: WalkForwardProgressSnapshot = {
      schemaVersion: 1,
      artifactType: 'walk-forward-progress',
      runId: run.id,
      runLabel: run.label,
      strategyId: run.strategyId,
      strategyVersion: run.strategyVersion,
      marketId: run.marketId,
      status: snapshot.status,
      windowCount: run.windowCount,
      totalTrials: run.totalTrials,
      completedTrialCount: snapshot.completedTrialCount,
      lastCompletedTrialIndex: snapshot.lastCompletedTrialIndex,
      checkpointCount: snapshot.checkpointCount,
      resumedFromRunId: snapshot.resumedFromRunId ?? null,
      activeTrialIndex: snapshot.activeTrialIndex ?? null,
      activeTrialLabel: snapshot.activeTrialLabel ?? null,
      activeWindowIndex: snapshot.activeWindowIndex ?? null,
      activeWindowLabel: snapshot.activeWindowLabel ?? null,
      activeWindowType: snapshot.activeWindowType ?? null,
      activeReplayLabel: snapshot.activeReplayLabel ?? null,
      updatedAt: snapshot.updatedAt,
      lastError: snapshot.lastError,
    };

    fs.writeFileSync(this._progressPath(run.id), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  private _summarizeReplaySession(sessionId: number): WindowMetrics {
    const session = this._replaySessionRepo.getSession(sessionId);
    if (!session) {
      throw new Error(`Replay session ${sessionId} disappeared before summarization`);
    }

    const checkpoints = this._replaySessionRepo.getSessionCheckpoints(sessionId);
    const strategyRuns: StrategyRunWithCandidates[] = checkpoints
      .map(checkpoint => checkpoint.strategyRunId != null
        ? this._strategyRunRepo.getRunById(checkpoint.strategyRunId)
        : null)
      .filter((run): run is StrategyRunWithCandidates => run != null);

    const topCandidates = strategyRuns
      .map(run => run.candidates[0] ?? null)
      .filter(candidate => candidate != null);

    const mergedScores = topCandidates.map(candidate => candidate.mergedScore);
    const deterministicScores = topCandidates.map(candidate => candidate.deterministicScore);
    const consultedCandidates = topCandidates.filter(candidate => candidate.llmStatus === LLMStatus.Consulted);
    const llmScores = consultedCandidates
      .map(candidate => candidate.llmScore)
      .filter((score): score is number => score != null);
    const llmStatusCounts = this._countLlmStatuses(topCandidates.map(candidate => candidate.llmStatus ?? null));
    const llmStatuses = new Set(Object.keys(llmStatusCounts));
    const pluginErrorCount = topCandidates.filter(candidate => candidate.hasPluginErrors).length;
    const executionTruth = this._summarizeReplayExecutionTruth(sessionId);

    const mergedMean = this._average(mergedScores);
    const mergedStd = this._stdDev(mergedScores, mergedMean);
    const mergedMin = mergedScores.length > 0 ? Math.min(...mergedScores) : null;
    const mergedMax = mergedScores.length > 0 ? Math.max(...mergedScores) : null;
    const winningTicks = mergedScores.filter(score => score >= WIN_SCORE_THRESHOLD).length;
    const losingTicks = mergedScores.filter(score => score < WIN_SCORE_THRESHOLD).length;

    // Extract candidate-cap evidence from checkpoint metadata
    let sessionMaxCandidates = 0;
    let sessionPreCapTotal = 0;
    for (const cp of checkpoints) {
      if (cp.metadataJson) {
        try {
          const meta = JSON.parse(cp.metadataJson);
          if (typeof meta.appliedCap === 'number' && meta.appliedCap > 0) {
            sessionMaxCandidates = Math.max(sessionMaxCandidates, meta.appliedCap);
          }
          if (typeof meta.preCapCandidateCount === 'number') {
            sessionPreCapTotal += meta.preCapCandidateCount;
          }
        } catch {
          // Malformed metadata — skip
        }
      }
    }

    const replayEvidence: WalkForwardReplayEvidence = {
      replaySessionId: session.id,
      replayStatus: session.status,
      replayLabel: session.label,
      replayRangeStart: session.rangeStart,
      replayRangeEnd: session.rangeEnd,
      replayCompletedTicks: session.completedTicks,
      replayTotalTicks: session.totalTicks,
      checkpointCount: checkpoints.length,
      strategyRunCount: strategyRuns.length,
      firstStrategyRunId: strategyRuns[0]?.id ?? null,
      lastStrategyRunId: strategyRuns[strategyRuns.length - 1]?.id ?? null,
      topCandidateCount: topCandidates.length,
      maxCandidates: sessionMaxCandidates,
      preCapCandidateCount: sessionPreCapTotal,
      llmStatusCounts,
      pluginErrorCount,
      errorMessage: session.errorMessage,
      executionTruth: {
        available: executionTruth.available,
        source: executionTruth.available ? 'replay-paper-execution' : 'replay-session',
        tradeCount: executionTruth.tradeCount,
        realizedPnl: executionTruth.realizedPnl,
        grossProfit: executionTruth.grossProfit,
        grossLoss: executionTruth.grossLoss,
        winCount: executionTruth.winCount,
        lossCount: executionTruth.lossCount,
        totalFees: executionTruth.totalFees,
        totalSlippage: executionTruth.totalSlippage,
        maxDrawdown: executionTruth.maxDrawdown,
      },
    };

    if (executionTruth.available) {
      const profitFactor = executionTruth.grossLoss > 0
        ? +(executionTruth.grossProfit / executionTruth.grossLoss).toFixed(4)
        : (executionTruth.grossProfit > 0 ? 999 : null);
      const totalClosedTrades = executionTruth.winCount + executionTruth.lossCount;
      const extendedMetrics: WalkForwardWindowMetricsEnvelope = {
        schemaVersion: 1,
        source: 'replay-paper-execution',
        replayEvidence,
        summary: {
          tickCount: totalClosedTrades,
          meanMergedScore: mergedMean,
          meanDeterministicScore: this._average(deterministicScores),
          meanLlmScore: this._average(llmScores),
          stdDevMergedScore: mergedStd,
          maxMergedScore: mergedMax,
          minMergedScore: mergedMin,
        },
      };

      return {
        totalReturn: +executionTruth.realizedPnl.toFixed(4),
        sharpeRatio: null,
        maxDrawdown: executionTruth.maxDrawdown,
        winRate: totalClosedTrades > 0 ? +(executionTruth.winCount / totalClosedTrades).toFixed(4) : null,
        tradeCount: executionTruth.tradeCount,
        profitFactor,
        deterministicScore: this._average(deterministicScores),
        mergedScore: mergedMean != null ? +mergedMean.toFixed(4) : null,
        extendedMetrics,
        llmStatus: this._summarizeLlmStatus(llmStatuses),
        llmScore: this._average(llmScores),
        llmTickCount: consultedCandidates.length,
      };
    }

    if (mergedScores.length === 0) {
      const extendedMetrics: WalkForwardWindowMetricsEnvelope = {
        schemaVersion: 1,
        source: 'replay-session',
        replayEvidence,
        summary: {
          tickCount: 0,
          meanMergedScore: null,
          meanDeterministicScore: this._average(deterministicScores),
          meanLlmScore: this._average(llmScores),
          stdDevMergedScore: null,
          maxMergedScore: null,
          minMergedScore: null,
        },
      };

      return {
        totalReturn: 0,
        sharpeRatio: null,
        maxDrawdown: null,
        winRate: null,
        tradeCount: 0,
        profitFactor: null,
        deterministicScore: null,
        mergedScore: null,
        extendedMetrics,
        llmStatus: this._summarizeLlmStatus(llmStatuses),
        llmScore: this._average(llmScores),
        llmTickCount: consultedCandidates.length,
      };
    }

    const extendedMetrics: WalkForwardWindowMetricsEnvelope = {
      schemaVersion: 1,
      source: 'replay-session',
      replayEvidence,
      summary: {
        tickCount: mergedScores.length,
        meanMergedScore: mergedMean,
        meanDeterministicScore: this._average(deterministicScores),
        meanLlmScore: this._average(llmScores),
        stdDevMergedScore: mergedStd,
        maxMergedScore: mergedMax,
        minMergedScore: mergedMin,
      },
    };

    const mergedMeanValue = mergedMean ?? 0;
    const mergedStdValue = mergedStd ?? 0;

    return {
      totalReturn: +mergedMeanValue.toFixed(4),
      sharpeRatio: mergedStdValue > 1e-10 ? +(mergedMeanValue / mergedStdValue).toFixed(4) : null,
      maxDrawdown: mergedMin != null && mergedMin < mergedMeanValue ? +(mergedMeanValue - mergedMin).toFixed(4) : 0,
      winRate: +(winningTicks / mergedScores.length).toFixed(4),
      tradeCount: mergedScores.length,
      profitFactor: losingTicks > 0 ? +(winningTicks / losingTicks).toFixed(4) : (winningTicks > 0 ? 999 : null),
      deterministicScore: this._average(deterministicScores),
      mergedScore: +mergedMeanValue.toFixed(4),
      extendedMetrics,
      llmStatus: this._summarizeLlmStatus(llmStatuses),
      llmScore: this._average(llmScores),
      llmTickCount: consultedCandidates.length,
    };
  }

  private _summarizeReplayExecutionTruth(sessionId: number): ReplayExecutionTruthMetrics {
    const tag = `replay-${sessionId}`;
    try {
      const tradeRow = this._db.prepare(`
        SELECT
          COUNT(DISTINCT pf.id) AS trade_count,
          COALESCE(SUM(pe.realized_pnl), 0) AS realized_pnl,
          COALESCE(SUM(CASE WHEN pe.realized_pnl > 0 THEN pe.realized_pnl ELSE 0 END), 0) AS gross_profit,
          COALESCE(SUM(CASE WHEN pe.realized_pnl < 0 THEN ABS(pe.realized_pnl) ELSE 0 END), 0) AS gross_loss,
          COALESCE(SUM(CASE WHEN pe.realized_pnl > 0 THEN 1 ELSE 0 END), 0) AS win_count,
          COALESCE(SUM(CASE WHEN pe.realized_pnl < 0 THEN 1 ELSE 0 END), 0) AS loss_count,
          COALESCE(SUM(pf.fees), 0) AS total_fees,
          COALESCE(SUM(pf.slippage_amount), 0) AS total_slippage
        FROM proposal_attempts pa
        INNER JOIN strategy_decisions sd ON sd.proposal_attempt_id = pa.id
        INNER JOIN execution_attempts ea ON ea.strategy_decision_id = sd.id
        LEFT JOIN paper_fills pf ON pf.execution_attempt_id = ea.id
        LEFT JOIN position_events pe ON pe.execution_attempt_id = ea.id
        WHERE pa.tag = ?
      `).get(tag) as {
        trade_count: number;
        realized_pnl: number;
        gross_profit: number;
        gross_loss: number;
        win_count: number;
        loss_count: number;
        total_fees: number;
        total_slippage: number;
      };

      const events = this._db.prepare(`
        SELECT pe.realized_pnl AS realized_pnl
        FROM proposal_attempts pa
        INNER JOIN strategy_decisions sd ON sd.proposal_attempt_id = pa.id
        INNER JOIN execution_attempts ea ON ea.strategy_decision_id = sd.id
        INNER JOIN position_events pe ON pe.execution_attempt_id = ea.id
        WHERE pa.tag = ?
        ORDER BY pe.created_at ASC, pe.id ASC
      `).all(tag) as Array<{ realized_pnl: number }>;

      let cumulative = 0;
      let peak = 0;
      let maxDrawdown = 0;
      for (const event of events) {
        cumulative += event.realized_pnl;
        peak = Math.max(peak, cumulative);
        maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
      }

      const available = (tradeRow.trade_count ?? 0) > 0 || events.length > 0;
      return {
        available,
        tradeCount: tradeRow.trade_count ?? 0,
        realizedPnl: tradeRow.realized_pnl ?? 0,
        grossProfit: tradeRow.gross_profit ?? 0,
        grossLoss: tradeRow.gross_loss ?? 0,
        winCount: tradeRow.win_count ?? 0,
        lossCount: tradeRow.loss_count ?? 0,
        totalFees: tradeRow.total_fees ?? 0,
        totalSlippage: tradeRow.total_slippage ?? 0,
        maxDrawdown: available ? +maxDrawdown.toFixed(4) : null,
      };
    } catch {
      return {
        available: false,
        tradeCount: 0,
        realizedPnl: 0,
        grossProfit: 0,
        grossLoss: 0,
        winCount: 0,
        lossCount: 0,
        totalFees: 0,
        totalSlippage: 0,
        maxDrawdown: null,
      };
    }
  }

  private _countLlmStatuses(statuses: Array<string | null>): Partial<Record<LLMStatus, number>> {
    const counts: Partial<Record<LLMStatus, number>> = {};
    for (const status of statuses) {
      if (!status) continue;
      const key = status as LLMStatus;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  private _summarizeLlmStatus(statuses: Iterable<string>): string | null {
    const set = new Set(statuses);
    if (set.size === 0) return null;
    if (set.has(LLMStatus.Error)) return LLMStatus.Error;
    if (set.has(LLMStatus.Degraded)) return LLMStatus.Degraded;
    if (set.has(LLMStatus.Consulted)) return LLMStatus.Consulted;
    if (set.has(LLMStatus.Skipped)) return LLMStatus.Skipped;
    return [...set][0] ?? null;
  }

  private _average(values: number[]): number | null {
    if (values.length === 0) return null;
    return +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4);
  }

  private _stdDev(values: number[], mean: number | null): number | null {
    if (values.length === 0 || mean == null) return null;
    const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
    return +Math.sqrt(variance).toFixed(6);
  }

  private _computeAggregateMetrics(
    trials: WalkForwardTrialWithWindows[],
    _rankedCandidates: WalkForwardRankedCandidate[],
  ): WalkForwardAggregateMetrics {
    let stabilitySum = 0;
    let stabilityCount = 0;

    for (const trial of trials) {
      const scores = trial.windowEvidence
        .filter(evidence => evidence.windowType === WalkForwardWindowType.OutOfSample)
        .map(evidence => evidence.totalReturn);
      if (scores.length < 2) continue;

      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (Math.abs(mean) < 1e-10) continue;

      const variance = scores.reduce((acc, score) => acc + (score - mean) ** 2, 0) / scores.length;
      const std = Math.sqrt(variance);
      const cv = Math.abs(std / mean);
      stabilitySum += Math.max(0, 1 - cv);
      stabilityCount += 1;
    }

    const scoreStability = stabilityCount > 0 ? +(stabilitySum / stabilityCount).toFixed(4) : 0;
    const topKOverlap = trials.length > 1 ? 1.0 : 0;
    const llmTrials = trials.filter(trial => trial.llmStatus === LLMStatus.Consulted || trial.llmStatus === LLMStatus.Degraded || trial.llmStatus === LLMStatus.Error);
    const llmConsultationRate = llmTrials.length > 0
      ? +(llmTrials.length / trials.length).toFixed(4)
      : null;

    let divergenceSum = 0;
    let divergenceCount = 0;
    for (const trial of trials) {
      if (trial.llmScore != null) {
        divergenceSum += Math.abs(trial.mergedScore - trial.deterministicScore);
        divergenceCount += 1;
      }
    }

    const llmDivergence = divergenceCount > 0
      ? +(divergenceSum / divergenceCount).toFixed(4)
      : null;

    return {
      scoreStability,
      topKOverlap,
      llmConsultationRate,
      llmDivergence,
    };
  }
}

export interface WalkForwardEvaluatorConfig {
  rangeStart: number;
  rangeEnd: number;
  windowSizeMs?: number;
  stepSizeMs?: number;
  inSampleRatio?: number;
  strategyId?: string;
  strategyVersion?: string;
  marketId?: string;
  label?: string;
  trialConfigs?: WalkForwardTrialConfig[];
  paramSpace?: WalkForwardParamSpace;
  /** Replay screening cadence override in minutes; defaults to the evaluator clock cadence. */
  cadenceMinutes?: number;
  /** When true, execute replay-approved candidates through paper execution state. */
  enablePaperExecution?: boolean;
  /** Resume an interrupted or failed run instead of creating a new one. */
  resumeRunId?: number;
  /** Test/verification hook: stop after N persisted trials and mark interrupted. */
  stopAfterTrialCount?: number;
}

export { WalkForwardInterruptionError };
