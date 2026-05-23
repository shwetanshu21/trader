// ── HypothesisResearchEvaluator ──
// Accepts a validated/persisted hypothesis graph row, converts it into a
// single WalkForwardTrialConfig, runs WalkForwardEvaluator with bounded
// config, performs winner selection, persists linked hypothesis evaluation
// evidence, updates hypothesis status for success/failure, and emits a
// promotion-ready JSON artifact under data/artifacts/research/<hypothesis-id>/.
//
// This is the bridge between the hypothesis validation pipeline and the
// walk-forward replay pipeline. It reuses existing walk-forward contracts
// (WalkForwardEvaluator, WinnerSelector, ArtifactEmitter) and keeps the
// research artifact minimal and hypothesis-centric.

import * as path from 'node:path';
import type Database from 'better-sqlite3';
import {
  HypothesisEvaluationStatus,
  HypothesisStatus,
  ResearchArtifactType,
  type HypothesisGraphRow,
  type HypothesisEvaluationResult,
  type HypothesisResearchConfig,
} from '../types/runtime.js';
import { resolveBudgetPolicy, type OvernightBudgetPolicy } from './hypothesis-generation-budget.js';
import { HypothesisRepository } from '../persistence/hypothesis-repo.js';
import { WalkForwardRepository } from '../persistence/walk-forward-repo.js';
import {
  WalkForwardEvaluator,
  type WalkForwardTrialConfig,
} from '../replay/walk-forward-evaluator.js';
import { WinnerSelector } from '../replay/winner-selection.js';
import {
  WalkForwardSelectionStrategy,
  WalkForwardSelectionResult,
  WalkForwardWindowType,
  type WalkForwardSelectionConfig,
  type WalkForwardSelectionOutput,
  type WalkForwardTrialWindowRow,
} from '../replay/walk-forward-types.js';
import { ResearchArtifactWriter } from './artifact-writer.js';
import type { HistoricalDataProvider } from '../replay/historical-data-provider.js';
import type { MarketProfile } from '../market/market-profile.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default data range for a hypothesis evaluation: 30 days. */
const DEFAULT_RANGE_SPAN_MS = 30 * 86_400_000;

/** Default rolling window size for hypothesis evaluation: 7 days. */
const DEFAULT_WINDOW_SIZE_MS = 7 * 86_400_000;

/** Default step size between windows: 1 day. */
const DEFAULT_STEP_SIZE_MS = 1 * 86_400_000;

/** Default in-sample ratio. */
const DEFAULT_IN_SAMPLE_RATIO = 0.8;

/** Default maximum candidates per replay tick. */
const DEFAULT_MAX_CANDIDATES = 5;

/** Default tick cadence in minutes. */
const DEFAULT_CADENCE_MINUTES = 5;

// ---------------------------------------------------------------------------
// HypothesisResearchEvaluator
// ---------------------------------------------------------------------------

export class HypothesisResearchEvaluator {
  private readonly _db: Database.Database;
  private readonly _hypothesisRepo: HypothesisRepository;
  private readonly _walkForwardRepo: WalkForwardRepository;
  private readonly _dataProvider: HistoricalDataProvider;
  private readonly _marketProfile: MarketProfile;
  private readonly _artifactWriter: ResearchArtifactWriter;
  private readonly _winnerSelector: WinnerSelector;
  private readonly _walkForwardEvaluator?: WalkForwardEvaluator;

  constructor(options: {
    db: Database.Database;
    dataProvider: HistoricalDataProvider;
    marketProfile: MarketProfile;
    hypothesisRepo?: HypothesisRepository;
    walkForwardRepo?: WalkForwardRepository;
    artifactWriter?: ResearchArtifactWriter;
    winnerSelector?: WinnerSelector;
    /** Injected walk-forward evaluator. When absent, created on first evaluate call. */
    walkForwardEvaluator?: WalkForwardEvaluator;
  }) {
    this._db = options.db;
    this._dataProvider = options.dataProvider;
    this._marketProfile = options.marketProfile;
    this._hypothesisRepo = options.hypothesisRepo ?? new HypothesisRepository(options.db);
    this._walkForwardRepo = options.walkForwardRepo ?? new WalkForwardRepository(options.db);
    this._artifactWriter = options.artifactWriter ?? new ResearchArtifactWriter();
    this._winnerSelector = options.winnerSelector ?? new WinnerSelector();
    this._walkForwardEvaluator = options.walkForwardEvaluator;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Evaluate a validated hypothesis graph through the walk-forward replay
   * pipeline.
   *
   * Steps:
   *   1. Validate that the hypothesis exists, is in Validated status, and
   *      has no existing evaluation.
   *   2. Create a HypothesisEvaluation in Pending status.
   *   3. Convert the hypothesis graph into a single WalkForwardTrialConfig.
   *   4. Run the WalkForwardEvaluator with bounded config.
   *   5. Perform winner selection on the ranked candidates.
   *   6. Persist the linked evaluation (update status, link run, link winner).
   *   7. Update the hypothesis graph lifecycle status.
   *   8. Emit promotion-ready and diagnostics artifacts.
   *   9. Persist research artifact rows in the database.
   *   10. Return a structured HypothesisEvaluationResult.
   *
   * @param hypothesisGraphId - FK into hypothesis_graphs for a validated row.
   * @param config - Optional evaluation configuration overrides.
   * @returns Structured evaluation result with linkages and artifact paths.
   * @throws When the hypothesis does not exist, is not validated, or already
   *         has an evaluation.
   */
  async evaluate(
    hypothesisGraphId: number,
    config?: HypothesisResearchConfig,
    budgetPolicy?: OvernightBudgetPolicy,
    budgetState?: { completedEvaluations: number },
  ): Promise<HypothesisEvaluationResult> {
    const resolvedBudget = resolveBudgetPolicy(budgetPolicy);
    const completedEvaluations = budgetState?.completedEvaluations ?? 0;
    if (completedEvaluations >= resolvedBudget.maxAcceptedCandidates) {
      const now = Date.now();
      const evaluation = this._hypothesisRepo.insertEvaluation({
        hypothesisGraphId,
        status: HypothesisEvaluationStatus.Cancelled,
        rationale: `Evaluation pruned before replay start: candidate budget exhausted (${completedEvaluations}/${resolvedBudget.maxAcceptedCandidates}).`,
        outcomeDetail: 'pre_evaluation_budget_exhausted',
        createdAt: now,
      });
      this._hypothesisRepo.updateStatus(
        hypothesisGraphId,
        HypothesisStatus.FailedEvaluation,
        now,
      );
      return {
        evaluation,
        walkForwardRun: null,
        winner: null,
        aggregateMetrics: null,
        artifactPaths: [],
        finalStatus: HypothesisEvaluationStatus.Cancelled,
        rationale: evaluation.rationale,
      };
    }

    const now = Date.now();

    // ── Step 1: Validate hypothesis state ────────────────────────────────
    const hypothesis = this._hypothesisRepo.getHypothesisById(hypothesisGraphId);
    if (!hypothesis) {
      throw new Error(
        `Hypothesis graph ${hypothesisGraphId} does not exist. ` +
        'Provide a validated hypothesis id from HypothesisValidator.',
      );
    }

    if (hypothesis.status !== HypothesisStatus.Validated) {
      throw new Error(
        `Hypothesis graph ${hypothesisGraphId} has status "${hypothesis.status}". ` +
        `Only "${HypothesisStatus.Validated}" hypotheses can be evaluated.`,
      );
    }

    const existingEval = this._hypothesisRepo.getEvaluationByHypothesisId(hypothesisGraphId);
    if (existingEval) {
      throw new Error(
        `Hypothesis graph ${hypothesisGraphId} already has an evaluation (id=${existingEval.id}) ` +
        `with status "${existingEval.status}". Each hypothesis may be evaluated once.`,
      );
    }

    // ── Step 2: Create evaluation in Pending status ──────────────────────
    const evaluation = this._hypothesisRepo.insertEvaluation({
      hypothesisGraphId,
      status: HypothesisEvaluationStatus.Pending,
      rationale: 'Evaluation created. Pending walk-forward execution.',
      outcomeDetail: '',
      createdAt: now,
    });

    // ── Resolve config defaults ──────────────────────────────────────────
    const resolvedConfig = this._resolveConfig(config, now);
    const label = resolvedConfig.label ??
      `hypothesis-${hypothesisGraphId}-${new Date(now).toISOString().slice(0, 10)}`;

    // ── Step 3: Convert hypothesis graph to walk-forward trial config ────
    const trialConfig = this._hypothesisToTrialConfig(hypothesis, hypothesisGraphId);

    // ── Mark evaluation in progress ──────────────────────────────────────
    this._hypothesisRepo.updateEvaluation(evaluation.id, {
      status: HypothesisEvaluationStatus.InProgress,
      rationale: 'Walk-forward execution in progress.',
    });

    try {
      // ── Step 4: Run walk-forward evaluator ────────────────────────────
      const evaluator = this._walkForwardEvaluator ?? new WalkForwardEvaluator({
        db: this._db,
        marketProfile: this._marketProfile,
        dataProvider: this._dataProvider,
      });

      const evaluatorResult = await evaluator.evaluate({
        rangeStart: resolvedConfig.rangeStart,
        rangeEnd: resolvedConfig.rangeEnd,
        windowSizeMs: resolvedConfig.windowSizeMs,
        stepSizeMs: resolvedConfig.stepSizeMs,
        inSampleRatio: resolvedConfig.inSampleRatio,
        label,
        trialConfigs: [trialConfig],
        cadenceMinutes: resolvedConfig.cadenceMinutes,
        enablePaperExecution: resolvedConfig.enablePaperExecution ?? false,
      });

      // ── Step 5: Winner selection ──────────────────────────────────────
      const selectionConfig = this._buildSelectionConfig(resolvedConfig);
      const trialEvidence = this._buildTrialEvidenceMap(evaluatorResult.trials);

      const selectionOutput = this._winnerSelector.selectWinner(
        evaluatorResult.rankedCandidates,
        selectionConfig,
        trialEvidence,
      );

      // ── Step 6: Persist evaluation linkages ────────────────────────────
      const run = evaluatorResult.run;

      // Persist the winner selection into the walk_forward_winners table
      // so the FK winner_id reference is satisfied.
      const persistedWinner = selectionOutput.result === WalkForwardSelectionResult.Selected
        ? this._walkForwardRepo.insertWinner({
            runId: run.id,
            result: selectionOutput.result,
            selectedTrialId: selectionOutput.selectedTrialId,
            selectionStrategy: selectionOutput.selectionStrategy,
            selectionConfigJson: selectionOutput.selectionConfigJson,
            rationale: selectionOutput.rationale,
            artifactPathsJson: null,
            selectedAt: Date.now(),
          })
        : null;

      let finalStatus: HypothesisEvaluationStatus;
      let rationale: string;
      let outcomeDetail: string;

      if (selectionOutput.result === WalkForwardSelectionResult.NoWinner) {
        finalStatus = HypothesisEvaluationStatus.NoWinner;
        rationale = selectionOutput.rationale;
        outcomeDetail = 'No qualifying winner selected from walk-forward trials.';
      } else {
        finalStatus = HypothesisEvaluationStatus.Completed;
        rationale = selectionOutput.rationale;
        outcomeDetail = 'Winner selected via walk-forward evaluation.';
      }

      this._hypothesisRepo.updateEvaluation(evaluation.id, {
        status: finalStatus,
        walkForwardRunId: run.id,
        winnerId: persistedWinner?.id ?? null,
        rationale,
        outcomeDetail,
      });

      // ── Step 7: Update hypothesis lifecycle status ─────────────────────
      const updatedHypothesis = this._hypothesisRepo.updateStatus(
        hypothesisGraphId,
        finalStatus === HypothesisEvaluationStatus.Completed
          ? HypothesisStatus.FailedEvaluation
          : HypothesisStatus.FailedEvaluation,
        now,
      );

      // ── Step 8: Emit research artifacts ────────────────────────────────
      const artifactPaths = this._emitResearchArtifacts(
        hypothesisGraphId,
        evaluation.id,
        finalStatus,
        rationale,
        outcomeDetail,
        run,
        selectionOutput,
        evaluatorResult,
        hypothesis,
        now,
      );

      // ── Step 9: Persist research artifact rows in the DB ──────────────
      for (const artifactPath of artifactPaths) {
        const filePathRelative = path.relative(
          this._artifactWriter.ensureDir(hypothesisGraphId),
          artifactPath,
        );

        this._hypothesisRepo.insertResearchArtifact({
          hypothesisEvaluationId: evaluation.id,
          artifactType: artifactPath.endsWith('promotion-artifact.json')
            ? ResearchArtifactType.PromotionArtifact
            : artifactPath.endsWith('diagnostics.json')
              ? ResearchArtifactType.Diagnostics
              : ResearchArtifactType.HypothesisRendered,
          format: 'json',
          filePath: filePathRelative,
          label: artifactPath.endsWith('promotion-artifact.json')
            ? 'Promotion-ready research artifact'
            : artifactPath.endsWith('diagnostics.json')
              ? 'Evaluation diagnostics'
              : 'Hypothesis graph snapshot',
          createdAt: now,
        });
      }

      // ── Step 10: Build and return result ──────────────────────────────
      const walkForwardRun = {
        id: run.id,
        label: run.label,
        status: run.status,
        windowCount: run.windowCount,
        totalTrials: run.totalTrials,
      };

      const winner = persistedWinner?.id != null
        ? this._findTrialInfo(persistedWinner.selectedTrialId!, evaluatorResult.trials)
        : null;

      return {
        evaluation: this._hypothesisRepo.getEvaluationById(evaluation.id)!,
        walkForwardRun,
        winner,
        aggregateMetrics: {
          scoreStability: evaluatorResult.aggregateMetrics.scoreStability,
          topKOverlap: evaluatorResult.aggregateMetrics.topKOverlap,
          llmConsultationRate: evaluatorResult.aggregateMetrics.llmConsultationRate,
          llmDivergence: evaluatorResult.aggregateMetrics.llmDivergence,
        },
        artifactPaths,
        finalStatus,
        rationale,
      };
    } catch (error) {
      // Mark evaluation as failed
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._hypothesisRepo.updateEvaluation(evaluation.id, {
        status: HypothesisEvaluationStatus.Failed,
        rationale: `Evaluation failed: ${errorMessage}`,
        outcomeDetail: errorMessage,
      });

      this._hypothesisRepo.updateStatus(
        hypothesisGraphId,
        HypothesisStatus.FailedEvaluation,
        Date.now(),
      );

      // Emit diagnostics artifact for the failure
      const now = Date.now();
      const errorDiagnosticsPath = this._artifactWriter.writeDiagnosticsArtifact(
        hypothesisGraphId,
        {
          schemaVersion: 1,
          artifactType: 'research-diagnostics',
          hypothesisGraphId,
          hypothesisEvaluationId: evaluation.id,
          generatedAt: new Date(now).toISOString(),
          evaluationStatus: HypothesisEvaluationStatus.Failed,
          outcomeDetail: errorMessage,
          windowCount: 0,
          trialCount: 0,
          durationMs: now - evaluation.createdAt,
          errorMessage,
        },
      );

      this._hypothesisRepo.insertResearchArtifact({
        hypothesisEvaluationId: evaluation.id,
        artifactType: ResearchArtifactType.Diagnostics,
        format: 'json',
        filePath: path.relative(
          this._artifactWriter.ensureDir(hypothesisGraphId),
          errorDiagnosticsPath,
        ),
        label: 'Evaluation diagnostics (failed)',
        createdAt: now,
      });

      // Return a structured result even on failure
      return {
        evaluation: this._hypothesisRepo.getEvaluationById(evaluation.id)!,
        walkForwardRun: null,
        winner: null,
        aggregateMetrics: null,
        artifactPaths: [errorDiagnosticsPath],
        finalStatus: HypothesisEvaluationStatus.Failed,
        rationale: `Evaluation failed: ${errorMessage}`,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Private — hypothesis-to-trial conversion
  // -----------------------------------------------------------------------

  /**
   * Convert a validated hypothesis graph into a single WalkForwardTrialConfig.
   *
   * Encodes the full hypothesis rule structure into params so the walk-forward
   * pipeline treats it as a single configuration to optimize across windows.
   */
  private _hypothesisToTrialConfig(
    hypothesis: HypothesisGraphRow,
    hypothesisGraphId: number,
  ): WalkForwardTrialConfig {
    return {
      label: `hypothesis-${hypothesisGraphId}`,
      params: {
        hypothesisId: hypothesisGraphId,
        canonicalHash: hypothesis.canonicalHash,
        schemaVersion: hypothesis.graph.schemaVersion,
        signals: JSON.parse(JSON.stringify(hypothesis.graph.signals)),
        filters: JSON.parse(JSON.stringify(hypothesis.graph.filters)),
        entryRules: JSON.parse(JSON.stringify(hypothesis.graph.entryRules)),
        exitRules: JSON.parse(JSON.stringify(hypothesis.graph.exitRules)),
        riskRules: JSON.parse(JSON.stringify(hypothesis.graph.riskRules)),
        maxCandidates: DEFAULT_MAX_CANDIDATES,
        ...(hypothesis.graph.metadata ?? {}),
      },
    };
  }

  // -----------------------------------------------------------------------
  // Private — config resolution
  // -----------------------------------------------------------------------

  /**
   * Resolve evaluation configuration with sensible defaults.
   */
  private _resolveConfig(
    config: HypothesisResearchConfig | undefined,
    now: number,
  ): Required<HypothesisResearchConfig> & { maxCandidates: number; cadenceMinutes: number } {
    const rangeEnd = config?.rangeEnd ?? now;
    const rangeStart = config?.rangeStart ?? (rangeEnd - DEFAULT_RANGE_SPAN_MS);

    return {
      rangeStart,
      rangeEnd,
      windowSizeMs: config?.windowSizeMs ?? DEFAULT_WINDOW_SIZE_MS,
      stepSizeMs: config?.stepSizeMs ?? DEFAULT_STEP_SIZE_MS,
      inSampleRatio: config?.inSampleRatio ?? DEFAULT_IN_SAMPLE_RATIO,
      maxCandidates: config?.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
      cadenceMinutes: config?.cadenceMinutes ?? DEFAULT_CADENCE_MINUTES,
      selectionStrategy: config?.selectionStrategy ?? 'threshold',
      minMergedScore: config?.minMergedScore ?? 0.7,
      minWindowCount: config?.minWindowCount ?? 1,
      minSharpeRatio: config?.minSharpeRatio ?? 0.8,
      maxDrawdown: config?.maxDrawdown ?? 25,
      label: config?.label ?? '',
      enablePaperExecution: config?.enablePaperExecution ?? false,
    };
  }

  // -----------------------------------------------------------------------
  // Private — winner selection helpers
  // -----------------------------------------------------------------------

  /**
   * Build a WalkForwardSelectionConfig from research config overrides.
   */
  private _buildSelectionConfig(
    resolved: Required<HypothesisResearchConfig> & { maxCandidates: number; cadenceMinutes: number },
  ): WalkForwardSelectionConfig {
    const strategy = resolved.selectionStrategy === 'composite'
      ? WalkForwardSelectionStrategy.Composite
      : resolved.selectionStrategy === 'top_ranked'
        ? WalkForwardSelectionStrategy.TopRanked
        : WalkForwardSelectionStrategy.Threshold;

    const config: WalkForwardSelectionConfig = {
      strategy,
      minMergedScore: resolved.minMergedScore,
      minWindowCount: resolved.minWindowCount,
    };

    if (strategy === WalkForwardSelectionStrategy.Composite) {
      config.minSharpeRatio = resolved.minSharpeRatio;
      config.maxDrawdown = resolved.maxDrawdown;
    }

    return config;
  }

  /**
   * Build a trial evidence map from the evaluator result's trial windows.
   */
  private _buildTrialEvidenceMap(
    trials: Array<{
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
    }>,
  ): Map<number, WalkForwardTrialWindowRow[]> {
    const map = new Map<number, WalkForwardTrialWindowRow[]>();
    for (const trial of trials) {
      map.set(trial.trialId, trial.windowEvidence);
    }
    return map;
  }

  /**
   * Find trial info for a winner by trialId from the evaluator result trials.
   */
  private _findTrialInfo(
    winnerTrialId: number,
    trials: Array<{
      trialId: number;
      trialIndex: number;
      label: string;
      paramsJson: string;
      mergedScore: number;
      deterministicScore: number;
      llmScore: number | null;
    }>,
  ): {
    trialId: number;
    trialLabel: string;
    paramsJson: string;
    aggregateMergedScore: number;
    aggregateDeterministicScore: number;
    aggregateLlmScore: number | null;
  } | null {
    const trial = trials.find(t => t.trialId === winnerTrialId);
    if (!trial) return null;

    return {
      trialId: trial.trialId,
      trialLabel: trial.label,
      paramsJson: trial.paramsJson,
      aggregateMergedScore: trial.mergedScore,
      aggregateDeterministicScore: trial.deterministicScore,
      aggregateLlmScore: trial.llmScore,
    };
  }

  // -----------------------------------------------------------------------
  // Private — artifact emission
  // -----------------------------------------------------------------------

  /**
   * Emit all research artifacts for the evaluation.
   *
   * Writes three files:
   *   1. promotion-artifact.json — Promotion-ready artifact with full context.
   *   2. diagnostics.json — Evaluation diagnostics.
   *   3. hypothesis.json — Snapshot of the hypothesis graph.
   *
   * @returns Array of absolute artifact file paths.
   */
  private _emitResearchArtifacts(
    hypothesisGraphId: number,
    evaluationId: number,
    finalStatus: HypothesisEvaluationStatus,
    rationale: string,
    outcomeDetail: string,
    run: { id: number; label: string; status: string; windowCount: number; totalTrials: number },
    selectionOutput: WalkForwardSelectionOutput,
    evaluatorResult: {
      windows: Array<any>;
      trials: Array<any>;
      aggregateMetrics: { scoreStability: number; topKOverlap: number; llmConsultationRate: number | null; llmDivergence: number | null };
    },
    hypothesis: HypothesisGraphRow,
    now: number,
  ): string[] {
    const paths: string[] = [];
    const isoNow = new Date(now).toISOString();

    // Determine winner info for the promotion artifact
    const winnerInfo = selectionOutput.selectedTrialId != null
      ? {
          trialId: selectionOutput.selectedTrialId,
          trialLabel: evaluatorResult.trials.find(
            t => t.trialId === selectionOutput.selectedTrialId,
          )?.label ?? 'unknown',
          aggregateMergedScore: evaluatorResult.trials.find(
            t => t.trialId === selectionOutput.selectedTrialId,
          )?.mergedScore ?? 0,
          aggregateDeterministicScore: evaluatorResult.trials.find(
            t => t.trialId === selectionOutput.selectedTrialId,
          )?.deterministicScore ?? 0,
        }
      : null;

    // Build walk-forward run reference
    const walkForwardRunRef = {
      id: run.id,
      label: run.label,
      status: run.status,
      windowCount: run.windowCount,
      totalTrials: run.totalTrials,
    };

    // 1. Promotion artifact
    const promotionPath = this._artifactWriter.writePromotionArtifact(
      hypothesisGraphId,
      {
        schemaVersion: 1,
        artifactType: 'research-promotion-artifact',
        hypothesisGraphId,
        hypothesisEvaluationId: evaluationId,
        generatedAt: isoNow,
        evaluationStatus: finalStatus,
        rationale,
        walkForwardRun: walkForwardRunRef,
        winner: winnerInfo,
        aggregateMetrics: {
          scoreStability: evaluatorResult.aggregateMetrics.scoreStability,
          topKOverlap: evaluatorResult.aggregateMetrics.topKOverlap,
          llmConsultationRate: evaluatorResult.aggregateMetrics.llmConsultationRate,
          llmDivergence: evaluatorResult.aggregateMetrics.llmDivergence,
        },
      },
    );
    paths.push(promotionPath);

    // 2. Diagnostics artifact
    const diagnosticsPath = this._artifactWriter.writeDiagnosticsArtifact(
      hypothesisGraphId,
      {
        schemaVersion: 1,
        artifactType: 'research-diagnostics',
        hypothesisGraphId,
        hypothesisEvaluationId: evaluationId,
        generatedAt: isoNow,
        evaluationStatus: finalStatus,
        outcomeDetail,
        windowCount: run.windowCount,
        trialCount: run.totalTrials,
        durationMs: now - (hypothesis.createdAt),
        errorMessage: null,
      },
    );
    paths.push(diagnosticsPath);

    // 3. Hypothesis graph snapshot
    const snapshotPath = this._artifactWriter.writeHypothesisSnapshot(
      hypothesisGraphId,
      {
        id: hypothesis.id,
        canonicalHash: hypothesis.canonicalHash,
        canonicalJson: hypothesis.canonicalJson,
        status: hypothesis.status,
        graph: hypothesis.graph,
        createdAt: hypothesis.createdAt,
        updatedAt: hypothesis.updatedAt,
      } as unknown as Record<string, unknown>,
    );
    paths.push(snapshotPath);

    return paths;
  }
}
