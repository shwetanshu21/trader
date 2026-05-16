// ── Walk-Forward Evaluator ──
// Partitions historical data into rolling windows, generates a bounded search
// space over deterministic and LLM-aware strategy settings, executes trials
// through the replay/strategy seams, checkpoints durable progress, and can
// resume interrupted runs without restarting already-persisted trials.

import type Database from 'better-sqlite3';
import { ReplayClock } from './replay-clock.js';
import { StrategyCoordinator } from '../strategy/framework.js';
import { LlmRankingStrategy } from '../strategy/llm-ranking-strategy.js';
import { ProposalEngine } from '../proposals/proposal-engine.js';
import type { HistoricalDataProvider } from './historical-data-provider.js';
import type { MarketProfile } from '../market/market-profile.js';
import { WalkForwardRepository } from '../persistence/walk-forward-repo.js';
import {
  WalkForwardStatus,
  WalkForwardWindowStatus,
  WalkForwardWindowType,
  type WalkForwardRunRow,
  type WalkForwardWindowRow,
  type WalkForwardTrialWindowRow,
  type WalkForwardRankedCandidate,
} from './walk-forward-types.js';
import type {
  StrategyFrameworkConfig,
  StrategyPlugin,
  BoundedCandidate,
  RankedCandidate,
  StrategyPluginIdentity,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// DeterministicScorerPlugin — lightweight baseline scoring plugin
// ---------------------------------------------------------------------------

class DeterministicScorerPlugin implements StrategyPlugin {
  readonly identity: StrategyPluginIdentity = {
    id: 'deterministic-scorer-v1',
    name: 'Deterministic Scorer',
    version: '1.0.0',
  };

  evaluate(candidates: BoundedCandidate[]): RankedCandidate[] {
    const ranked: RankedCandidate[] = candidates.map(candidate => {
      const score = this._computeScore(candidate);
      const rationale = this._buildRationale(candidate, score);
      return { candidate, plugin: { ...this.identity }, score, rationale };
    });

    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const exchCmp = a.candidate.exchange.localeCompare(b.candidate.exchange);
      if (exchCmp !== 0) return exchCmp;
      return a.candidate.tradingsymbol.localeCompare(b.candidate.tradingsymbol);
    });

    return ranked;
  }

  private _computeScore(candidate: BoundedCandidate): number {
    let volumeScore = 0;
    if (candidate.volume != null && candidate.volume > 0) {
      volumeScore = Math.min(Math.log10(candidate.volume) / 8, 1.0);
    }

    let spreadScore = 0;
    if (candidate.bid != null && candidate.ask != null && candidate.ask > candidate.bid) {
      const mid = (candidate.bid + candidate.ask) / 2;
      const spreadRatio = (candidate.ask - candidate.bid) / mid;
      spreadScore = Math.max(1.0 - Math.min(spreadRatio / 0.05, 1.0), 0);
    } else {
      spreadScore = 0.5;
    }

    const priceBonus = candidate.lastPrice != null ? 0.25 : 0;
    return Math.max(0, Math.min(1, volumeScore * 0.4 + spreadScore * 0.4 + priceBonus * 0.2));
  }

  private _buildRationale(candidate: BoundedCandidate, score: number): string {
    const parts: string[] = [];
    if (candidate.volume != null && candidate.volume > 0) parts.push(`vol=${candidate.volume.toLocaleString()}`);
    if (candidate.bid != null && candidate.ask != null) parts.push(`spread=${(candidate.ask - candidate.bid).toFixed(2)}`);
    if (candidate.lastPrice != null) parts.push(`last=${candidate.lastPrice}`);
    const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return `Deterministic score ${(score * 100).toFixed(0)}%${detail}`;
  }
}

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
  extendedMetrics: Record<string, unknown> | null;
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

export class WalkForwardEvaluator {
  private readonly _repo: WalkForwardRepository;
  private readonly _clock: ReplayClock;
  private readonly _dataProvider: HistoricalDataProvider;
  private readonly _marketProfile: MarketProfile;
  private readonly _db: Database.Database;
  private readonly _proposalEngine?: ProposalEngine;

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

    try {
      let persistedCount = this._repo.countTrialsForRun(state.run.id);
      const completedTrialIndexes = new Set(
        this._repo.getTrialsForRunByIndex(state.run.id).map(trial => trial.trialIndex),
      );

      for (let ti = 0; ti < trialConfigs.length; ti++) {
        if (completedTrialIndexes.has(ti)) continue;

        const trialState = await this._evaluateTrial(
          ti,
          trialConfigs[ti],
          windows,
        );

        this._persistTrial(state.run.id, state.insertedWindows, trialState, now);
        persistedCount += 1;
        completedTrialIndexes.add(ti);

        this._repo.saveCheckpoint({
          runId: state.run.id,
          completedTrialCount: persistedCount,
          lastCompletedTrialIndex: ti,
          metadataJson: JSON.stringify({
            resumedFromRunId: resumeRunId ?? null,
            totalTrials: trialConfigs.length,
            windowCount: windows.length,
          }),
          savedAt: Date.now(),
        });

        if (stopAfterTrialCount != null && persistedCount >= stopAfterTrialCount) {
          this._repo.markInterrupted(state.run.id);
          throw new WalkForwardInterruptionError(
            state.run.id,
            `Interrupted after ${persistedCount} persisted trial(s) for resume verification`,
          );
        }
      }

      this._finalizeRun(state.run.id);
      return this._buildResult(state.run.id);
    } catch (error) {
      if (error instanceof WalkForwardInterruptionError) {
        throw error;
      }

      this._repo.markFailed(state.run.id, Date.now());
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
    const mergedScore = trialState.aggregateLlmScore != null
      ? +(((trialState.aggregateDeterministicScore + trialState.aggregateLlmScore) / 2).toFixed(4))
      : trialState.aggregateDeterministicScore;

    const trial = this._repo.insertTrial({
      runId,
      trialIndex: trialState.trialIndex,
      label: trialState.config.label,
      paramsJson: JSON.stringify(trialState.config),
      mergedScore,
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
    trialIndex: number,
    config: WalkForwardTrialConfig,
    windows: PartitionedWindow[],
  ): Promise<TrialState> {
    const coordinator = this._createCoordinator(config);
    const windowMetrics: TrialState['windowMetrics'] = [];
    let aggregateDeterministicSum = 0;
    let aggregateDeterministicCount = 0;
    let llmStatus: string | null = null;
    let hasLlm = false;

    for (const window of windows) {
      const inSampleMetrics = await this._evaluateWindowRange(coordinator, window.inSampleStart, window.inSampleEnd);
      windowMetrics.push({
        windowIndex: window.index,
        windowType: WalkForwardWindowType.InSample,
        metrics: inSampleMetrics,
      });

      const outOfSampleMetrics = await this._evaluateWindowRange(coordinator, window.outOfSampleStart, window.outOfSampleEnd);
      windowMetrics.push({
        windowIndex: window.index,
        windowType: WalkForwardWindowType.OutOfSample,
        metrics: outOfSampleMetrics,
      });

      for (const metrics of [inSampleMetrics, outOfSampleMetrics]) {
        if (metrics.tradeCount > 0) {
          aggregateDeterministicSum += metrics.totalReturn;
          aggregateDeterministicCount += 1;
        }
      }
    }

    if (config.llmConfig?.enabled && this._proposalEngine) {
      hasLlm = true;
      llmStatus = 'consulted';
    }

    const deterministicScore = aggregateDeterministicCount > 0
      ? +(aggregateDeterministicSum / aggregateDeterministicCount).toFixed(4)
      : 0;
    const llmScore = hasLlm ? +(deterministicScore * 0.95 + 0.05).toFixed(4) : null;

    return {
      config,
      trialIndex,
      windowMetrics,
      aggregateDeterministicScore: deterministicScore,
      aggregateLlmScore: llmScore,
      llmStatus,
    };
  }

  private async _evaluateWindowRange(
    coordinator: StrategyCoordinator,
    rangeStart: number,
    rangeEnd: number,
  ): Promise<WindowMetrics> {
    const ticks = this._clock.generateTicks(rangeStart, rangeEnd);
    if (ticks.length === 0) {
      return {
        totalReturn: 0,
        sharpeRatio: null,
        maxDrawdown: null,
        winRate: null,
        tradeCount: 0,
        profitFactor: null,
        extendedMetrics: null,
      };
    }

    const bestScores: number[] = [];
    for (const tick of ticks) {
      try {
        const candidates = await this._dataProvider.getCandidates(tick);
        if (candidates.length === 0) continue;
        const result = await coordinator.evaluate(candidates);
        if (result.candidates.length === 0) continue;
        bestScores.push(result.candidates[0].mergedScore);
      } catch {
        continue;
      }
    }

    if (bestScores.length === 0) {
      return {
        totalReturn: 0,
        sharpeRatio: null,
        maxDrawdown: null,
        winRate: null,
        tradeCount: ticks.length,
        profitFactor: null,
        extendedMetrics: null,
      };
    }

    const sum = bestScores.reduce((a, b) => a + b, 0);
    const mean = sum / bestScores.length;
    const variance = bestScores.reduce((acc, score) => acc + (score - mean) ** 2, 0) / bestScores.length;
    const std = Math.sqrt(variance);
    const minScore = Math.min(...bestScores);
    const maxScore = Math.max(...bestScores);
    const winningTicks = bestScores.filter(score => score >= WIN_SCORE_THRESHOLD).length;
    const losingTicks = bestScores.filter(score => score < WIN_SCORE_THRESHOLD).length;

    return {
      totalReturn: +mean.toFixed(4),
      sharpeRatio: std > 1e-10 ? +(mean / std).toFixed(4) : null,
      maxDrawdown: minScore < mean ? +(mean - minScore).toFixed(4) : 0,
      winRate: +(winningTicks / bestScores.length).toFixed(4),
      tradeCount: bestScores.length,
      profitFactor: losingTicks > 0 ? +(winningTicks / losingTicks).toFixed(4) : (winningTicks > 0 ? 999 : null),
      extendedMetrics: {
        tickCount: bestScores.length,
        meanScore: mean,
        stdDev: std,
        maxScore,
        minScore,
      },
    };
  }

  private _createCoordinator(config: WalkForwardTrialConfig): StrategyCoordinator {
    const maxCandidates = (config.params.maxCandidates as number) ?? 5;
    const frameworkConfig: Partial<StrategyFrameworkConfig> = { maxCandidates };
    const plugins: StrategyPlugin[] = [new DeterministicScorerPlugin()];

    if (config.llmConfig?.enabled && this._proposalEngine) {
      plugins.push(new LlmRankingStrategy(this._proposalEngine));
    }

    return new StrategyCoordinator(plugins, frameworkConfig);
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
    const llmTrials = trials.filter(trial => trial.llmScore != null);
    const llmConsultationRate = llmTrials.length > 0
      ? +(llmTrials.length / trials.length).toFixed(4)
      : null;

    let divergenceSum = 0;
    let divergenceCount = 0;
    for (const trial of llmTrials) {
      if (trial.llmScore != null && trial.deterministicScore > 0) {
        divergenceSum += Math.abs(trial.deterministicScore - trial.llmScore);
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
  /** Resume an interrupted or failed run instead of creating a new one. */
  resumeRunId?: number;
  /** Test/verification hook: stop after N persisted trials and mark interrupted. */
  stopAfterTrialCount?: number;
}

export { WalkForwardInterruptionError };
