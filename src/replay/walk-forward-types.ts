// ── Walk-forward evaluation subsystem types ──
// DTOs, enums, and contracts for walk-forward (rolling-window) optimization
// of deterministic and LLM-aware strategy settings over replay history.
//
// Follows the same pattern as replay types in types.ts and runtime DTOs in
// src/types/runtime.ts.

// ---------------------------------------------------------------------------
// WalkForwardStatus — lifecycle of a walk-forward run
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a walk-forward evaluation run.
 *
 * - `pending`: Run has been created but not started.
 * - `running`: Run is actively partitioning data and executing trials.
 * - `completed`: All windows and trials finished successfully.
 * - `failed`: Run encountered an error and stopped.
 * - `interrupted`: Run was interrupted (e.g. process killed, operator abort).
 */
export enum WalkForwardStatus {
  Pending = 'pending',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  Interrupted = 'interrupted',
}

// ---------------------------------------------------------------------------
// WalkForwardRunRow — top-level run config and lifecycle
// ---------------------------------------------------------------------------

/**
 * Full persisted walk-forward run row.
 *
 * Carries identity, replay session linkage, strategy metadata,
 * rolling-window geometry, completion state, and timeline fields.
 */
export interface WalkForwardRunRow {
  /** Auto-increment row ID. */
  id: number;
  /** Human-readable run label (e.g. '2025-01 walk-forward v1'). */
  label: string;
  /** Strategy identity (e.g. 'india-nse-eq-v1'). */
  strategyId: string;
  /** Strategy version (e.g. '1.0.0'). */
  strategyVersion: string;
  /** Market profile ID used (e.g. 'INDIA_NSE_EQ'). */
  marketId: string;
  /** FK → replay_sessions(id). Null when run is not linked to a specific session. */
  replaySessionId: number | null;
  /** Total number of rolling windows defined for this run. */
  windowCount: number;
  /** Total number of trials executed across all windows. */
  totalTrials: number;
  /** Current run status. */
  status: WalkForwardStatus;
  /** Unix timestamp (ms) when the run was created. */
  createdAt: number;
  /** Unix timestamp (ms) when the run started executing, or null. */
  startedAt: number | null;
  /** Unix timestamp (ms) when the run completed or failed, or null. */
  completedAt: number | null;
}

/** Shape for inserting a new walk-forward run (without id, timestamps). */
export interface NewWalkForwardRun {
  label: string;
  strategyId: string;
  strategyVersion: string;
  marketId: string;
  replaySessionId: number | null;
  windowCount: number;
  totalTrials: number;
  status: WalkForwardStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

// ---------------------------------------------------------------------------
// WalkForwardCheckpointRow — durable progress snapshots for long runs
// ---------------------------------------------------------------------------

/**
 * Append-only checkpoint row for a walk-forward run.
 *
 * Checkpoints are written after durable progress boundaries so interrupted
 * processes can resume from the next incomplete trial instead of restarting
 * the full run.
 */
export interface WalkForwardCheckpointRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → walk_forward_runs(id). */
  runId: number;
  /** Number of fully persisted trials at checkpoint time. */
  completedTrialCount: number;
  /** Highest completed trial index, or null when nothing completed yet. */
  lastCompletedTrialIndex: number | null;
  /** Optional JSON metadata for diagnostics/resume context. */
  metadataJson: string | null;
  /** Unix timestamp (ms) when the checkpoint was saved. */
  savedAt: number;
}

/** Shape for inserting a new walk-forward checkpoint (without id). */
export interface NewWalkForwardCheckpoint {
  runId: number;
  completedTrialCount: number;
  lastCompletedTrialIndex: number | null;
  metadataJson: string | null;
  savedAt: number;
}

// ---------------------------------------------------------------------------
// WalkForwardWindowRow — a single rolling window within a run
// ---------------------------------------------------------------------------

/**
 * Status of a walk-forward window within its run lifecycle.
 */
export enum WalkForwardWindowStatus {
  /** Window has been defined but not yet evaluated. */
  Pending = 'pending',
  /** Window is actively being used for trial evaluation. */
  Active = 'active',
  /** Window has been fully evaluated by all applicable trials. */
  Completed = 'completed',
  /** Window evaluation failed. */
  Failed = 'failed',
}

/**
 * A single rolling-window segment within a walk-forward run.
 *
 * Windows partition the historical data range into sequential, possibly
 * overlapping segments. Each window may serve as in-sample for some
 * optimization trials and out-of-sample for others.
 */
export interface WalkForwardWindowRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → walk_forward_runs(id). */
  runId: number;
  /** 0-based index within the parent run (monotonic ordering). */
  windowIndex: number;
  /** Unix timestamp (ms) of this window's start. */
  rangeStart: number;
  /** Unix timestamp (ms) of this window's end. */
  rangeEnd: number;
  /** Human-readable label for this window (e.g. 'W01 2025-01-06'). */
  windowLabel: string;
  /** Number of trials that used this window as in-sample for optimization. */
  trialCountOptimized: number;
  /** Number of trials that used this window as out-of-sample for testing. */
  trialCountTested: number;
  /** Current window status. */
  status: WalkForwardWindowStatus;
  /** Unix timestamp (ms) when this window row was created. */
  createdAt: number;
}

/** Shape for inserting a new walk-forward window (without id). */
export interface NewWalkForwardWindow {
  runId: number;
  windowIndex: number;
  rangeStart: number;
  rangeEnd: number;
  windowLabel: string;
  trialCountOptimized: number;
  trialCountTested: number;
  status: WalkForwardWindowStatus;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// WalkForwardTrialRow — an optimization trial within a run
// ---------------------------------------------------------------------------

/**
 * A single optimization trial in a walk-forward run.
 *
 * Each trial represents one parameter configuration being tested across
 * one or more windows. The trial carries aggregate scoring so downstream
 * ranking can select winning configurations without re-executing.
 */
export interface WalkForwardTrialRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → walk_forward_runs(id). */
  runId: number;
  /** 0-based trial index within the parent run. */
  trialIndex: number;
  /** Human-readable label (e.g. 'momentum-v1 config C'). */
  label: string;
  /** Parameter configuration stored as JSON. */
  paramsJson: string;
  /** Final merged score (0–1) used for ranking across all windows. */
  mergedScore: number;
  /** Aggregated deterministic score (0–1). */
  deterministicScore: number;
  /** LLM-provided score (0–1), or null when LLM was not used. */
  llmScore: number | null;
  /** LLM consultation status (reuses LLMStatus semantics), or null. */
  llmStatus: string | null;
  /** 1-based rank within the parent run (by merged score descending). */
  rank: number;
  /** Unix timestamp (ms) when this trial was created. */
  createdAt: number;
}

/** Shape for inserting a new walk-forward trial (without id). */
export interface NewWalkForwardTrial {
  runId: number;
  trialIndex: number;
  label: string;
  paramsJson: string;
  mergedScore: number;
  deterministicScore: number;
  llmScore: number | null;
  llmStatus: string | null;
  rank: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// WalkForwardTrialWindowRow — per-window evidence for a trial
// ---------------------------------------------------------------------------

/**
 * The role a window plays for a given trial.
 *
 * - `in_sample`: Window used for parameter optimization/fitting.
 * - `out_of_sample`: Window used for forward-testing the optimized parameters.
 */
export enum WalkForwardWindowType {
  InSample = 'in_sample',
  OutOfSample = 'out_of_sample',
}

/**
 * Per-window evaluation metrics for a single trial.
 *
 * Each trial may have multiple trial-window evidence rows — at minimum
 * one in-sample fit and one out-of-sample test. Additional windows
 * appear as the walk-forward rolls forward.
 */
export interface WalkForwardTrialWindowRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → walk_forward_trials(id). */
  trialId: number;
  /** FK → walk_forward_windows(id). */
  windowId: number;
  /** Whether this window was used for in-sample optimization or out-of-sample testing. */
  windowType: WalkForwardWindowType;
  /** Total return percentage achieved on this window (e.g. 12.5 = +12.5%). */
  totalReturn: number;
  /** Sharpe ratio (annualized) for this window, or null when not computable. */
  sharpeRatio: number | null;
  /** Maximum drawdown percentage (positive value), or null. */
  maxDrawdown: number | null;
  /** Win rate (0–1), or null when no trades were closed. */
  winRate: number | null;
  /** Total number of trades executed in this window. */
  tradeCount: number;
  /** Profit factor (gross profit / gross loss), or null when no losing trades. */
  profitFactor: number | null;
  /** Arbitrary extended metrics stored as JSON (e.g. {"calmar": 1.2, "sortino": 1.8}). */
  metricsJson: string | null;
  /** Unix timestamp (ms) when this evidence row was created. */
  createdAt: number;
}

/** Shape for inserting a new trial-window evidence row (without id). */
export interface NewWalkForwardTrialWindow {
  trialId: number;
  windowId: number;
  windowType: WalkForwardWindowType;
  totalReturn: number;
  sharpeRatio: number | null;
  maxDrawdown: number | null;
  winRate: number | null;
  tradeCount: number;
  profitFactor: number | null;
  metricsJson: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Joined read-model DTOs
// ---------------------------------------------------------------------------

/** A walk-forward run with its ordered windows loaded. */
export interface WalkForwardRunWithWindows extends WalkForwardRunRow {
  /** Ordered windows (by window_index ascending). */
  windows: WalkForwardWindowRow[];
}

/** A walk-forward trial with its per-window evidence loaded. */
export interface WalkForwardTrialWithWindows extends WalkForwardTrialRow {
  /** Per-window evidence rows (by window index ascending). */
  windowEvidence: WalkForwardTrialWindowRow[];
}

/** Ranked trial output — a trial with its rank, score, params, and window evidence count. */
export interface WalkForwardRankedCandidate {
  /** Trial row ID. */
  trialId: number;
  /** 1-based rank (by merged score descending). */
  rank: number;
  /** Human-readable trial label. */
  label: string;
  /** Parameter configuration (parsed from paramsJson). */
  paramsJson: string;
  /** Final merged score (0–1). */
  mergedScore: number;
  /** Aggregated deterministic score (0–1). */
  deterministicScore: number;
  /** LLM-provided score, or null. */
  llmScore: number | null;
  /** Number of windows in which this trial was evaluated (evidence rows). */
  windowCount: number;
}

// ---------------------------------------------------------------------------
// Winner-selection types — strategy, config, result, and artifact DTOs
// ---------------------------------------------------------------------------

/**
 * Selection strategy for choosing a winner from ranked walk-forward trials.
 *
 * - `top_ranked`: Simple top-ranked trial by merged score (rank = 1).
 * - `threshold`: Trial must pass a minimum score threshold to qualify.
 * - `composite`: Multiple criteria (score, Sharpe, drawdown) combined.
 */
export enum WalkForwardSelectionStrategy {
  TopRanked = 'top_ranked',
  Threshold = 'threshold',
  Composite = 'composite',
}

/**
 * Configuration for winner selection.
 *
 * Carries the strategy identifier and any strategy-specific parameters
 * needed to reproduce the selection decision.
 */
export interface WalkForwardSelectionConfig {
  strategy: WalkForwardSelectionStrategy;
  /** Minimum merged score to qualify (for Threshold and Composite strategies). */
  minMergedScore?: number;
  /** Minimum number of windows with evidence (for all strategies). */
  minWindowCount?: number;
  /** Minimum Sharpe ratio (for Composite strategy). */
  minSharpeRatio?: number;
  /** Maximum allowed drawdown percentage (for Composite strategy). */
  maxDrawdown?: number;
  /** Arbitrary extended config as JSON. */
  configJson?: string;
}

/**
 * Result of a winner-selection decision for a walk-forward run.
 *
 * - `selected`: A qualifying trial was chosen.
 * - `no_winner`: No trial met the selection criteria (operator should HOLD).
 * - `pending`: Selection has not been performed yet.
 */
export enum WalkForwardSelectionResult {
  Selected = 'selected',
  NoWinner = 'no_winner',
  Pending = 'pending',
}

/**
 * Persisted winner-selection row for a walk-forward run.
 *
 * One row per run (enforced by UNIQUE on run_id). When no trial qualified,
 * selectedTrialId is null and the result is 'no_winner'.
 */
export interface WalkForwardWinnerRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → walk_forward_runs(id), unique. */
  runId: number;
  /** Selection result indicator. */
  result: WalkForwardSelectionResult;
  /** FK → walk_forward_trials(id), or null for no-winner outcomes. */
  selectedTrialId: number | null;
  /** Selection strategy used. */
  selectionStrategy: WalkForwardSelectionStrategy;
  /** Selection configuration snapshot as JSON. */
  selectionConfigJson: string;
  /** Human-readable rationale explaining why this winner (or no winner) was selected. */
  rationale: string;
  /** JSON array of artifact paths (e.g. trade log, metrics, window evidence). */
  artifactPathsJson: string | null;
  /** Unix timestamp (ms) when the selection was made. */
  selectedAt: number;
  /** Unix timestamp (ms) when this row was created. */
  createdAt: number;
}

/** Shape for inserting a new winner-selection row (without auto-generated fields). */
export interface NewWalkForwardWinner {
  runId: number;
  result: WalkForwardSelectionResult;
  selectedTrialId: number | null;
  selectionStrategy: WalkForwardSelectionStrategy;
  selectionConfigJson: string;
  rationale: string;
  artifactPathsJson: string | null;
  selectedAt: number;
}

/**
 * Expanded read model — winner with its linked run and selected trial context.
 *
 * Provides the full picture needed by downstream M006 promotion governance:
 * the winner decision itself, the parent run configuration, the selected trial's
 * scoring and params, and the ranked candidate list at selection time.
 */
export interface WalkForwardWinnerWithContext extends WalkForwardWinnerRow {
  /** The parent walk-forward run. */
  run: WalkForwardRunRow;
  /** The selected trial with per-window evidence, or null for no-winner outcomes. */
  selectedTrial: WalkForwardTrialWithWindows | null;
  /** Ranked candidates at selection time (for forensic inspection). */
  rankedCandidates: WalkForwardRankedCandidate[];
}

// ---------------------------------------------------------------------------
// Winner-selector input/output types
// ---------------------------------------------------------------------------

/**
 * Comparison detail for a single candidate in the selection decision.
 *
 * Documents why each candidate was chosen as winner, disqualified, or
 * placed as runner-up.
 */
export interface WalkForwardCandidateComparison {
  /** Trial row ID. */
  trialId: number;
  /** 1-based rank within the run. */
  rank: number;
  /** Human-readable trial label. */
  label: string;
  /** Final merged score (0–1). */
  mergedScore: number;
  /** Whether this candidate was selected, is a runner-up, or was disqualified. */
  outcome: 'winner' | 'runner_up' | 'disqualified';
  /** Human-readable list of reasons for this outcome. */
  reasons: string[];
  /** Numerical scores that justify the outcome. */
  evidenceScores?: {
    /** Average out-of-sample Sharpe ratio, or null. */
    avgSharpe?: number | null;
    /** Maximum out-of-sample drawdown, or null. */
    maxDrawdown?: number | null;
    /** Average out-of-sample win rate, or null. */
    avgWinRate?: number | null;
    /** Number of out-of-sample windows evaluated. */
    outOfSampleWindowCount?: number;
  };
}

/**
 * Structured output of a winner-selection decision.
 *
 * Produced by the selector and consumed by the artifact emitter for
 * persisting stable JSON artifacts.
 */
export interface WalkForwardSelectionOutput {
  /** Selection result indicator. */
  result: WalkForwardSelectionResult;
  /** FK → walk_forward_trials(id), or null for no-winner outcomes. */
  selectedTrialId: number | null;
  /** Selection strategy used. */
  selectionStrategy: WalkForwardSelectionStrategy;
  /** Selection configuration snapshot as JSON. */
  selectionConfigJson: string;
  /** Human-readable rationale explaining the decision. */
  rationale: string;
  /** Comparison details for each top candidate. */
  comparisons: WalkForwardCandidateComparison[];
}

// ---------------------------------------------------------------------------
// Artifact types
// ---------------------------------------------------------------------------

/**
 * Winner artifact persisted as JSON under data/artifacts/walk-forward/<run-id>/.
 *
 * Captures the full selection decision with rationale, comparison context,
 * and enough metadata to reconstruct the governance surface.
 */
export interface WalkForwardWinnerArtifact {
  /** Schema version for forward compatibility. */
  schemaVersion: 1;
  /** Artifact type discriminator. */
  artifactType: 'winner-selection';
  /** FK → walk_forward_runs(id). */
  runId: number;
  /** Human-readable run label. */
  runLabel: string;
  /** ISO-8601 timestamp of selection. */
  selectionTimestamp: string;
  /** Selection configuration used. */
  selectionConfig: WalkForwardSelectionConfig;
  /** Selection result. */
  result: WalkForwardSelectionResult;
  /** Details of the selected winner (null for no-winner outcomes). */
  winner: {
    trialId: number | null;
    trialLabel: string | null;
    paramsJson: string | null;
    mergedScore: number | null;
    deterministicScore: number | null;
    llmScore: number | null;
  } | null;
  /** Human-readable selection rationale. */
  rationale: string;
  /** Per-candidate comparison details. */
  comparisons: WalkForwardCandidateComparison[];
}

/**
 * Diagnostics artifact persisted under data/artifacts/walk-forward/<run-id>/.
 *
 * Carries aggregate scores, per-window evidence summary, ranked candidate
 * list, and proof-fidelity fields derived from the provider/evaluator contracts.
 */
export interface WalkForwardDiagnosticsArtifact {
  /** Schema version for forward compatibility. */
  schemaVersion: 1;
  /** Artifact type discriminator. */
  artifactType: 'winner-diagnostics';
  /** FK → walk_forward_runs(id). */
  runId: number;
  /** Human-readable run label. */
  runLabel: string;
  /** ISO-8601 timestamp when diagnostics were generated. */
  generatedAt: string;
  /** Selection decision summary. */
  selection: {
    result: WalkForwardSelectionResult;
    rationale: string;
    comparisonsCount: number;
  };
  /** Aggregate cross-run metrics. */
  aggregateMetrics: {
    scoreStability: number;
    topKOverlap: number;
    llmConsultationRate: number | null;
    llmDivergence: number | null;
  };
  /** Ranked candidates at selection time (ordered by rank ascending). */
  rankedCandidates: WalkForwardRankedCandidate[];
  /** Compact trade-log style evidence summarizing per-window execution. */
  tradeLog: Array<{
    trialId: number;
    windowIndex: number;
    windowType: WalkForwardWindowType;
    tradeCount: number;
    totalReturn: number;
    winRate: number | null;
    sharpeRatio: number | null;
    maxDrawdown: number | null;
  }>;
  /** Data fidelity evidence from the provider. */
  evidenceFidelity: {
    providerLabel: string;
    effectiveFidelity: string;
    hasData: boolean;
    windowCount: number;
    trialCount: number;
    outOfSampleWindows: number;
    screeningCadenceMinutes: number | null;
    executionResolutionMinutes: number | null;
    supportsFineGrainedExecution: boolean;
  };
}

/**
 * Standalone trade-log artifact persisted beside winner/diagnostics outputs.
 *
 * This turns the compact trade-log evidence into its own durable artifact so
 * milestone-level verification can point at an explicit trade-log file.
 */
export interface WalkForwardTradeLogArtifact {
  schemaVersion: 1;
  artifactType: 'trade-log';
  runId: number;
  runLabel: string;
  generatedAt: string;
  entries: WalkForwardDiagnosticsArtifact['tradeLog'];
}
