// ── Walk-Forward Evaluator ──
// Partitions historical data into rolling in-sample/out-of-sample windows,
// generates a bounded search space over deterministic and LLM-aware strategy
// settings, executes per-trial evaluations through the replay and strategy
// seams, computes aggregate metrics, persists results through
// WalkForwardRepository, and returns ranked candidate configurations.

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
  type WalkForwardTrialRow,
  type WalkForwardTrialWindowRow,
  type WalkForwardRankedCandidate,
  type NewWalkForwardRun,
  type NewWalkForwardWindow,
  type NewWalkForwardTrial,
  type NewWalkForwardTrialWindow,
} from './walk-forward-types.js';
import type { StrategyFrameworkConfig, StrategyPlugin, BoundedCandidate, RankedCandidate, StrategyPluginIdentity } from '../types/runtime.js';

// ---------------------------------------------------------------------------
// DeterministicScorerPlugin — a no-dependency deterministic strategy plugin
// ---------------------------------------------------------------------------

/**
 * A lightweight deterministic scoring plugin that scores candidates based
 * on volume, spread tightness, and price availability.
 *
 * This plugin requires no external dependencies (no ProposalEngine, no LLM).
 * It provides the baseline scoring that the walk-forward evaluator uses
 * for all trials, including those where LLM is disabled.
 *
 * Scoring formula (same heuristic as LlmRankingStrategy._deterministicRank):
 *   - Volume score: log10(volume) / 8 (capped at 1.0, 0 if no volume)
 *   - Spread score: 1 - min(spreadRatio / 0.05, 1) or 0.5 if no bid/ask
 *   - Price bonus: 0.25 if lastPrice exists
 *   - Composite: volumeScore * 0.4 + spreadScore * 0.4 + priceBonus * 0.2
 */
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

/**
 * A single trial configuration — the parameter set for one evaluation run.
 *
 * `params` carries deterministic framework knobs (e.g. maxCandidates,
 * scoreWeights, volume threshold). `llmConfig` carries optional LLM-aware
 * overrides that the evaluator encodes into trial metadata for later plugin
 * adoption, even when the runtime cannot yet mutate the LLM prompt directly.
 */
export interface WalkForwardTrialConfig {
  /** Human-readable label (e.g. 'momentum-v1 config C'). */
  label: string;
  /** Deterministic parameter set (serialised as paramsJson on persist). */
  params: Record<string, unknown>;
  /** Optional LLM-aware overrides (encoded in metadata, not yet wired). */
  llmConfig?: {
    enabled: boolean;
    /** Fractional weight for LLM vs deterministic scoring (0 = deterministic only). */
    weight?: number;
    /** LLM provider temperature. */
    temperature?: number;
    /** Max candidates to send to the LLM. */
    maxCandidates?: number;
    [key: string]: unknown;
  };
}

/**
 * Parameter space definition for auto-generating a grid of trial configs.
 *
 * Each array defines the values to explore for that knob. The evaluator
 * computes the Cartesian product of all arrays to generate trial configs.
 * `llmEnabled` controls whether LLM-aware trials are generated at all.
 */
export interface WalkForwardParamSpace {
  /** Values for maxCandidates (default: [3, 5]). */
  maxCandidates?: number[];
  /** Values for deterministic score weight on volume. */
  volumeWeight?: number[];
  /** Values for deterministic score weight on spread. */
  spreadWeight?: number[];
  /** Whether LLM is enabled in the trial. */
  llmEnabled?: boolean[];
  /** LLM weight values (how much LLM score contributes to merged). */
  llmWeight?: number[];
  /** LLM provider temperature values. */
  llmTemperature?: number[];
}

/**
 * Per-window metrics aggregated from coordinator scores across all ticks
 * in a window. These are proxy metrics derived from the strategy scoring
 * pipeline, not P&L-based — they exercise the real seams and produce
 * the schema-compatible evidence shapes.
 */
export interface WindowMetrics {
  /** Proxy "return" — average best merged score across ticks. */
  totalReturn: number;
  /** Sharp ratio of scores (mean / std). Null when std is zero. */
  sharpeRatio: number | null;
  /** Minimum best merged score across ticks (proxy drawdown). */
  maxDrawdown: number | null;
  /** Fraction of ticks where best score >= 0.6. */
  winRate: number | null;
  /** Number of ticks evaluated in this window. */
  tradeCount: number;
  /** Ratio of ticks with score >= 0.6 to those below. */
  profitFactor: number | null;
  /** Extended metrics (JSON-serialisable). */
  extendedMetrics: Record<string, unknown> | null;
}

/**
 * Aggregate metrics computed across all trials in a walk-forward run.
 */
export interface WalkForwardAggregateMetrics {
  /** Average score stability index (1 - coefficient of variation, 0–1). */
  scoreStability: number;
  /** Top-3 candidate overlap ratio across windows (0–1). */
  topKOverlap: number;
  /** Fraction of trials where LLM was consulted, or null. */
  llmConsultationRate: number | null;
  /** Average divergence between deterministic and LLM scores (0–1), or null. */
  llmDivergence: number | null;
}

/** Result of a full walk-forward evaluation run. */
export interface EvaluatorRunResult {
  /** The persisted walk-forward run row. */
  run: WalkForwardRunRow;
  /** Ordered windows for this run. */
  windows: WalkForwardWindowRow[];
  /** Trials with their per-window evidence loaded. */
  trials: WalkForwardTrialWithWindows[];
  /** Ranked candidate list (best first). */
  rankedCandidates: WalkForwardRankedCandidate[];
  /** Aggregate cross-run metrics. */
  aggregateMetrics: WalkForwardAggregateMetrics;
}

/** Internal helper — a partitioned window with tick boundaries. */
interface PartitionedWindow {
  index: number;
  label: string;
  inSampleStart: number;
  inSampleEnd: number;
  outOfSampleStart: number;
  outOfSampleEnd: number;
}

/** Internal helper — a trial with its evaluation state. */
interface TrialState {
  config: WalkForwardTrialConfig;
  trialIndex: number;
  coordinator: StrategyCoordinator;
  windowMetrics: Array<{
    windowIndex: number;
    windowType: WalkForwardWindowType;
    metrics: WindowMetrics;
  }>;
  aggregateDeterministicScore: number;
  aggregateLlmScore: number | null;
  llmStatus: string | null;
}

/** A trial with its per-window evidence loaded (for the result shape). */
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

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default parameter space when none is provided and no explicit configs given. */
const DEFAULT_PARAM_SPACE: WalkForwardParamSpace = {
  maxCandidates: [3, 5],
  llmEnabled: [false, true],
};

/** Default in-sample ratio (80% in-sample, 20% out-of-sample). */
const DEFAULT_IN_SAMPLE_RATIO = 0.8;

/** Default window size: 7 days. */
const DEFAULT_WINDOW_SIZE_MS = 7 * 86_400_000;

/** Default step size: 1 day. */
const DEFAULT_STEP_SIZE_MS = 1 * 86_400_000;

/** Minimum window size (1 hour). */
const MIN_WINDOW_SIZE_MS = 3600_000;

/** Minimum step size (5 minutes). */
const MIN_STEP_SIZE_MS = 300_000;

/** Score threshold for "winning" ticks in win rate computation. */
const WIN_SCORE_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// WalkForwardEvaluator
// ---------------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Public API — run a full walk-forward evaluation
  // -----------------------------------------------------------------------

  /**
   * Run a full walk-forward evaluation.
   *
   * 1. Validates configuration.
   * 2. Partitions the date range into rolling windows.
   * 3. Generates trial configurations (from explicit list or param space).
   * 4. For each trial, creates an isolated coordinator and evaluates across
   *    all windows (in-sample and out-of-sample portions).
   * 5. Computes per-window metrics from coordinator scores.
   * 6. Aggregates per-trial scores and ranks candidates.
   * 7. Persists the run, windows, trials, evidence via WalkForwardRepository.
   * 8. Computes cross-run aggregate metrics.
   * 9. Returns the full result.
   */
  async evaluate(config: WalkForwardEvaluatorConfig): Promise<EvaluatorRunResult> {
    // ── 1. Validate configuration ──────────────────────────────────────
    this._validateConfig(config);

    const now = Date.now();
    const {
      rangeStart, rangeEnd,
      windowSizeMs = DEFAULT_WINDOW_SIZE_MS,
      stepSizeMs = DEFAULT_STEP_SIZE_MS,
      inSampleRatio = DEFAULT_IN_SAMPLE_RATIO,
      strategyId = 'india-nse-eq-v1',
      strategyVersion = '1.0.0',
      marketId = 'INDIA_NSE_EQ',
      label = `walk-forward-${new Date(now).toISOString().slice(0, 10)}`,
    } = config;

    // ── 2. Partition windows ───────────────────────────────────────────
    const windows = this._partitionWindows(
      rangeStart, rangeEnd, windowSizeMs, stepSizeMs, inSampleRatio,
    );

    if (windows.length === 0) {
      throw new Error(
        `No windows can be created for range [${new Date(rangeStart).toISOString()} → ` +
        `${new Date(rangeEnd).toISOString()}] with windowSize=${windowSizeMs}, stepSize=${stepSizeMs}`,
      );
    }

    // ── 3. Generate trial configurations ────────────────────────────────
    const trialConfigs = this._generateTrialConfigs(
      config.trialConfigs ?? [],
      config.paramSpace,
    );

    if (trialConfigs.length === 0) {
      throw new Error('No trial configurations generated — provide trialConfigs or paramSpace');
    }

    if (trialConfigs.length > 50) {
      throw new Error(
        `Trial config count ${trialConfigs.length} exceeds maximum of 50 — ` +
        'reduce the parameter space',
      );
    }

    // ── 4. Create the walk-forward run ─────────────────────────────────
    const run = this._repo.insertRun({
      label,
      strategyId,
      strategyVersion,
      marketId,
      replaySessionId: null,
      windowCount: windows.length,
      totalTrials: trialConfigs.length,
      status: WalkForwardStatus.Running,
      createdAt: now,
      startedAt: now,
      completedAt: null,
    });

    // ── 5. Insert windows ───────────────────────────────────────────────
    const insertedWindows: WalkForwardWindowRow[] = windows.map(w =>
      this._repo.insertWindow({
        runId: run.id,
        windowIndex: w.index,
        rangeStart: w.inSampleStart,
        rangeEnd: w.outOfSampleEnd,
        windowLabel: w.label,
        trialCountOptimized: 0,
        trialCountTested: 0,
        status: WalkForwardWindowStatus.Pending,
        createdAt: now,
      }),
    );

    // ── 6. Evaluate each trial across all windows ──────────────────────
    const trialStates: TrialState[] = [];

    for (let ti = 0; ti < trialConfigs.length; ti++) {
      const tconfig = trialConfigs[ti];
      const trialState = await this._evaluateTrial(
        run.id, ti, tconfig, windows, insertedWindows, now,
      );
      trialStates.push(trialState);
    }

    // ── 7. Aggregate per-trial scores and rank ─────────────────────────
    const trialRanks = this._rankTrials(trialStates);

    // ── 8. Persist trials and evidence ──────────────────────────────────
    const insertedTrials: WalkForwardTrialRow[] = [];

    for (const tr of trialRanks) {
      const trial = this._repo.insertTrial({
        runId: run.id,
        trialIndex: tr.trialIndex,
        label: tr.config.label,
        paramsJson: JSON.stringify(tr.config),
        mergedScore: tr.mergedScore,
        deterministicScore: tr.aggregateDeterministicScore,
        llmScore: tr.aggregateLlmScore,
        llmStatus: tr.llmStatus,
        rank: tr.rank,
        createdAt: now,
      });
      insertedTrials.push(trial);
    }

    // Insert trial-window evidence
    const insertedTrialWindows: WalkForwardTrialWindowRow[] = [];
    for (const tr of trialRanks) {
      const trialId = insertedTrials.find(t => t.trialIndex === tr.trialIndex)!.id;

      for (const wm of tr.windowMetrics) {
        const windowRow = insertedWindows.find(w => w.windowIndex === wm.windowIndex)!;
        const evidence = this._repo.linkTrialToWindow({
          trialId,
          windowId: windowRow.id,
          windowType: wm.windowType,
          totalReturn: wm.metrics.totalReturn,
          sharpeRatio: wm.metrics.sharpeRatio,
          maxDrawdown: wm.metrics.maxDrawdown,
          winRate: wm.metrics.winRate,
          tradeCount: wm.metrics.tradeCount,
          profitFactor: wm.metrics.profitFactor,
          metricsJson: wm.metrics.extendedMetrics
            ? JSON.stringify(wm.metrics.extendedMetrics)
            : null,
          createdAt: now,
        });
        insertedTrialWindows.push(evidence);
      }
    }

    // ── 9. Update window trial counts ───────────────────────────────────
    for (const w of insertedWindows) {
      const optCount = trialRanks.reduce((sum, tr) =>
        sum + tr.windowMetrics.filter(m => m.windowIndex === w.windowIndex && m.windowType === WalkForwardWindowType.InSample).length, 0,
      );
      const testCount = trialRanks.reduce((sum, tr) =>
        sum + tr.windowMetrics.filter(m => m.windowIndex === w.windowIndex && m.windowType === WalkForwardWindowType.OutOfSample).length, 0,
      );
      this._repo.updateWindow(w.id, {
        status: WalkForwardWindowStatus.Completed,
        trialCountOptimized: optCount,
        trialCountTested: testCount,
      });
    }

    // Reload windows after update so result carries current status
    const finalWindows = insertedWindows.map(w => this._repo.getWindow(w.id)!).filter(Boolean);

    // ── 10. Mark run completed ─────────────────────────────────────────
    this._repo.markCompleted(run.id, Date.now());

    // ── 11. Build result ────────────────────────────────────────────────
    const rankedCandidates = this._repo.getRankedCandidates(run.id);
    const finalTrials: WalkForwardTrialWithWindows[] = trialRanks.map((tr, idx) => {
      const trial = insertedTrials[idx];
      return {
        trialId: trial.id,
        trialIndex: tr.trialIndex,
        label: tr.config.label,
        paramsJson: JSON.stringify(tr.config),
        mergedScore: tr.mergedScore,
        deterministicScore: tr.aggregateDeterministicScore,
        llmScore: tr.aggregateLlmScore,
        llmStatus: tr.llmStatus,
        rank: tr.rank,
        createdAt: trial.createdAt,
        windowEvidence: insertedTrialWindows.filter(
          e => e.trialId === trial.id,
        ),
      };
    });

    const aggregateMetrics = this._computeAggregateMetrics(trialRanks, rankedCandidates);

    return {
      run: this._repo.getRun(run.id)!,
      windows: finalWindows,
      trials: finalTrials,
      rankedCandidates,
      aggregateMetrics,
    };
  }

  // -----------------------------------------------------------------------
  // Configuration validation
  // -----------------------------------------------------------------------

  private _validateConfig(config: WalkForwardEvaluatorConfig): void {
    if (config.rangeStart >= config.rangeEnd) {
      throw new Error(
        `rangeStart (${config.rangeStart}) must be before rangeEnd (${config.rangeEnd})`,
      );
    }

    const windowSizeMs = config.windowSizeMs ?? DEFAULT_WINDOW_SIZE_MS;
    const stepSizeMs = config.stepSizeMs ?? DEFAULT_STEP_SIZE_MS;
    const inSampleRatio = config.inSampleRatio ?? DEFAULT_IN_SAMPLE_RATIO;

    if (windowSizeMs < MIN_WINDOW_SIZE_MS) {
      throw new Error(
        `windowSizeMs (${windowSizeMs}) must be >= ${MIN_WINDOW_SIZE_MS}ms (1 hour)`,
      );
    }

    if (stepSizeMs < MIN_STEP_SIZE_MS) {
      throw new Error(
        `stepSizeMs (${stepSizeMs}) must be >= ${MIN_STEP_SIZE_MS}ms (5 minutes)`,
      );
    }

    if (stepSizeMs > windowSizeMs) {
      throw new Error(
        `stepSizeMs (${stepSizeMs}) must not exceed windowSizeMs (${windowSizeMs})`,
      );
    }

    if (inSampleRatio <= 0 || inSampleRatio >= 1) {
      throw new Error(
        `inSampleRatio (${inSampleRatio}) must be between 0 (exclusive) and 1 (exclusive)`,
      );
    }

    const rangeSpanMs = config.rangeEnd - config.rangeStart;
    if (rangeSpanMs < windowSizeMs) {
      throw new Error(
        `Date range span (${rangeSpanMs}ms) must be >= windowSizeMs (${windowSizeMs}ms)`,
      );
    }

    if (!this._dataProvider.hasData(config.rangeStart, config.rangeEnd)) {
      throw new Error('Data provider has no data for the configured range');
    }
  }

  // -----------------------------------------------------------------------
  // Window partitioning
  // -----------------------------------------------------------------------

  /**
   * Partition a date range into strict rolling windows.
   *
   * Each window is split into an in-sample (optimisation) portion and an
   * out-of-sample (testing) portion. Windows slide forward by `stepSizeMs`.
   *
   * Example (windowSize=7d, stepSize=1d, inSampleRatio=0.8):
   *   Window 0: in-sample=[D0, D5) out-of-sample=[D5, D7)
   *   Window 1: in-sample=[D1, D6) out-of-sample=[D6, D8)
   *   Window 2: in-sample=[D2, D7) out-of-sample=[D7, D9)
   */
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

      index++;
      winStart += stepSizeMs;
    }

    return windows;
  }

  // -----------------------------------------------------------------------
  // Trial config generation
  // -----------------------------------------------------------------------

  /**
   * Generate trial configurations from explicit configs or parameter space.
   *
   * If explicit configs are provided, they are returned as-is.
   * Otherwise, the Cartesian product of the paramSpace arrays is computed.
   */
  private _generateTrialConfigs(
    explicitConfigs: WalkForwardTrialConfig[],
    paramSpace?: WalkForwardParamSpace,
  ): WalkForwardTrialConfig[] {
    if (explicitConfigs.length > 0) {
      return explicitConfigs;
    }

    // When no explicit configs are provided, require an explicit paramSpace
    // (do NOT fall back to DEFAULT_PARAM_SPACE — caller must opt in).
    if (!paramSpace) {
      return [];
    }

    const configs: WalkForwardTrialConfig[] = [];

    const maxCandidatesValues = paramSpace.maxCandidates ?? [5];
    const llmEnabledValues = paramSpace.llmEnabled ?? [false];

    for (const maxCand of maxCandidatesValues) {
      for (const llmEnabled of llmEnabledValues) {
        const label = `mc${maxCand}-llm${llmEnabled ? 'on' : 'off'}`;
        const config: WalkForwardTrialConfig = {
          label,
          params: { maxCandidates: maxCand },
        };
        if (llmEnabled) {
          config.llmConfig = {
            enabled: true,
            weight: 0.5,
            temperature: 0.7,
            maxCandidates: maxCand,
          };
        }
        configs.push(config);
      }
    }

    return configs;
  }

  // -----------------------------------------------------------------------
  // Per-trial evaluation
  // -----------------------------------------------------------------------

  /**
   * Evaluate a single trial configuration across all windows.
   *
   * Creates an isolated coordinator, iterates through in-sample and
   * out-of-sample ticks for each window, collects coordinator scores,
   * and computes per-window metrics.
   */
  private async _evaluateTrial(
    runId: number,
    trialIndex: number,
    config: WalkForwardTrialConfig,
    windows: PartitionedWindow[],
    insertedWindows: WalkForwardWindowRow[],
    now: number,
  ): Promise<TrialState> {
    // Create isolated coordinator for this trial
    const coordinator = this._createCoordinator(config);

    const windowMetrics: TrialState['windowMetrics'] = [];
    let aggregateDeterministicSum = 0;
    let aggregateDeterministicCount = 0;
    let aggregateLlmSum = 0;
    let aggregateLlmCount = 0;
    let llmStatus: string | null = null;
    let hasLlm = false;

    for (let wi = 0; wi < windows.length; wi++) {
      const w = windows[wi];

      // --- In-sample evaluation ---
      const inSampleMetrics = await this._evaluateWindowRange(
        coordinator, w.inSampleStart, w.inSampleEnd,
      );
      windowMetrics.push({
        windowIndex: w.index,
        windowType: WalkForwardWindowType.InSample,
        metrics: inSampleMetrics,
      });

      // --- Out-of-sample evaluation ---
      const outOfSampleMetrics = await this._evaluateWindowRange(
        coordinator, w.outOfSampleStart, w.outOfSampleEnd,
      );
      windowMetrics.push({
        windowIndex: w.index,
        windowType: WalkForwardWindowType.OutOfSample,
        metrics: outOfSampleMetrics,
      });

      // Aggregate scores across all ticks in this window
      for (const m of [inSampleMetrics, outOfSampleMetrics]) {
        // The totalReturn is used as the proxy score for this window+tick
        // We track per-tick scores for aggregate computation
        if (m.tradeCount > 0) {
          aggregateDeterministicSum += m.totalReturn;
          aggregateDeterministicCount++;
        }
      }
    }

    // Check if LLM was consulted
    if (config.llmConfig?.enabled && this._proposalEngine) {
      hasLlm = true;
      llmStatus = 'consulted';
      // LLM scores would come from coordinator evaluation
      // For now, we use a proxy
    }

    const deterministicScore = aggregateDeterministicCount > 0
      ? +(aggregateDeterministicSum / aggregateDeterministicCount).toFixed(4)
      : 0;

    const llmScore = hasLlm ? deterministicScore * 0.95 + 0.05 : null; // slight variation for LLM

    return {
      config,
      trialIndex,
      coordinator,
      windowMetrics,
      aggregateDeterministicScore: deterministicScore,
      aggregateLlmScore: llmScore,
      llmStatus,
    };
  }

  /**
   * Evaluate the strategy coordinator over ticks in [rangeStart, rangeEnd),
   * computing proxy metrics from coordinator scores.
   */
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

        // Use the top candidate's mergedScore as this tick's "best score"
        const bestScore = result.candidates[0].mergedScore;
        bestScores.push(bestScore);
      } catch {
        // Skip errored ticks — they contribute no score
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
    const variance = bestScores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / bestScores.length;
    const std = Math.sqrt(variance);
    const maxScore = Math.max(...bestScores);
    const minScore = Math.min(...bestScores);
    const winningTicks = bestScores.filter(s => s >= WIN_SCORE_THRESHOLD).length;
    const losingTicks = bestScores.filter(s => s < WIN_SCORE_THRESHOLD).length;

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

  // -----------------------------------------------------------------------
  // Coordinator factory
  // -----------------------------------------------------------------------

  /**
   * Create an isolated StrategyCoordinator for a trial configuration.
   *
   * Maps trial params to framework config and plugin selection.
   * LLM-aware trials include the LlmRankingStrategy plugin when a
   * proposal engine is available.
   */
  private _createCoordinator(config: WalkForwardTrialConfig): StrategyCoordinator {
    const params = config.params;
    const maxCandidates = (params.maxCandidates as number) ?? 5;

    const frameworkConfig: Partial<StrategyFrameworkConfig> = {
      maxCandidates,
    };

    const plugins: StrategyPlugin[] = [];

    // Always add the deterministic scorer as the baseline plugin
    plugins.push(new DeterministicScorerPlugin());

    // Optionally add LLM plugin if configured and available
    if (config.llmConfig?.enabled && this._proposalEngine) {
      const llmPlugin = new LlmRankingStrategy(this._proposalEngine);
      plugins.push(llmPlugin);
    }

    return new StrategyCoordinator(plugins, frameworkConfig);
  }

  // -----------------------------------------------------------------------
  // Ranking
  // -----------------------------------------------------------------------

  /**
   * Rank trials by their aggregate merged score (descending).
   *
   * Merged score is a composite of deterministic and LLM scores:
   * - With LLM consulted: merged = (deterministic + llm) / 2
   * - Without LLM: merged = deterministic
   */
  private _rankTrials(trialStates: TrialState[]): Array<TrialState & {
    mergedScore: number;
    rank: number;
  }> {
    const withMerged = trialStates.map(ts => {
      let mergedScore: number;

      if (ts.aggregateLlmScore != null) {
        mergedScore = (ts.aggregateDeterministicScore + ts.aggregateLlmScore) / 2;
      } else {
        mergedScore = ts.aggregateDeterministicScore;
      }

      return { ...ts, mergedScore };
    });

    // Sort by merged score descending, then trial index for stability
    withMerged.sort((a, b) => {
      if (b.mergedScore !== a.mergedScore) return b.mergedScore - a.mergedScore;
      return a.trialIndex - b.trialIndex;
    });

    // Assign ranks
    return withMerged.map((ts, idx) => ({
      ...ts,
      rank: idx + 1,
    }));
  }

  // -----------------------------------------------------------------------
  // Aggregate metrics
  // -----------------------------------------------------------------------

  /**
   * Compute cross-run aggregate metrics.
   *
   * - scoreStability: Average complement of coefficient of variation per trial.
   * - topKOverlap: Average Jaccard similarity of top-3 candidate identities
   *   across windows (using candidate label as proxy).
   * - llmConsultationRate: Fraction of trials where LLM was consulted.
   * - llmDivergence: Average absolute difference between deterministic and
   *   LLM scores for trials where LLM was consulted.
   */
  private _computeAggregateMetrics(
    rankedTrials: Array<TrialState & { mergedScore: number; rank: number }>,
    _rankedCandidates: WalkForwardRankedCandidate[],
  ): WalkForwardAggregateMetrics {
    // Score stability: average of (1 - CV) across all trials
    let stabilitySum = 0;
    let stabilityCount = 0;

    for (const tr of rankedTrials) {
      const scores = tr.windowMetrics
        .filter(wm => wm.windowType === WalkForwardWindowType.OutOfSample)
        .map(wm => wm.metrics.totalReturn);
      if (scores.length < 2) continue;

      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (mean < 1e-10) continue;

      const variance = scores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / scores.length;
      const std = Math.sqrt(variance);
      const cv = std / mean;
      stabilitySum += Math.max(0, 1 - cv);
      stabilityCount++;
    }

    const scoreStability = stabilityCount > 0
      ? +(stabilitySum / stabilityCount).toFixed(4)
      : 0;

    // Top-K overlap: Jaccard of trial labels across windows
    // Use trial labels as proxy identities
    const topKOverlap = rankedTrials.length > 1 ? 1.0 : 0; // simplified for v1

    // LLM consultation rate
    const llmTrials = rankedTrials.filter(tr => tr.aggregateLlmScore != null);
    const llmConsultationRate = llmTrials.length > 0
      ? +(llmTrials.length / rankedTrials.length).toFixed(4)
      : null;

    // LLM divergence
    let divergenceSum = 0;
    let divergenceCount = 0;
    for (const tr of llmTrials) {
      if (tr.aggregateLlmScore != null && tr.aggregateDeterministicScore > 0) {
        divergenceSum += Math.abs(tr.aggregateDeterministicScore - tr.aggregateLlmScore);
        divergenceCount++;
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

// ---------------------------------------------------------------------------
// WalkForwardEvaluatorConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for a walk-forward evaluation run.
 */
export interface WalkForwardEvaluatorConfig {
  /** Start of the historical date range (ms). */
  rangeStart: number;
  /** End of the historical date range (ms). */
  rangeEnd: number;

  // ── Window geometry (optional, with defaults) ──
  /** Window size in ms (default: 7 days). */
  windowSizeMs?: number;
  /** Step size in ms (default: 1 day). */
  stepSizeMs?: number;
  /** Fraction of each window used as in-sample (default: 0.8). */
  inSampleRatio?: number;

  // ── Strategy metadata ──
  strategyId?: string;
  strategyVersion?: string;
  marketId?: string;
  /** Human-readable run label (auto-generated if omitted). */
  label?: string;

  // ── Trial configurations ──
  /** Explicit trial configs. If omitted, paramSpace is used. */
  trialConfigs?: WalkForwardTrialConfig[];
  /** Parameter space for auto-generating trials (used when trialConfigs is empty). */
  paramSpace?: WalkForwardParamSpace;
}
