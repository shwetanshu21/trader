// ── ResearchPublishBackService ──
// Governed, idempotent publish-back handoff that consumes S02 evaluation
// outputs and writes publication evidence (research_publications row +
// strategy_lifecycle_state entry + governance_decisions row) into the main
// system inside one SQLite transaction.
//
// Design:
// - Atomic lifecycle handoff: publication + lifecycle state + governance
//   decision are persisted inside a single SQLite transaction on publish.
// - Idempotent: duplicate calls with the same evaluation id return the
//   existing publication row instead of violating the UNIQUE constraint.
// - Dry-run support: returns the verdict and rationale without mutating
//   any state, so CLI operators can preview the decision.
// - Fail-closed: validation failures, threshold breaches, and missing
//   prerequisite data produce a HOLD/REJECTED result with explicit
//   rationale — never a partial write.

import type Database from 'better-sqlite3';
import {
  GovernanceVerdict,
  ResearchPublicationStatus,
  ResearchPublishBackVerdict,
  ResearchArtifactType,
  HypothesisEvaluationStatus,
  StrategyLifecyclePhase,
  type HypothesisEvaluationWithLinked,
  type ResearchPublishBackConfig,
  type ResearchPublishBackResult,
  type ResearchPublishBackVerdict as ResearchPublishBackVerdictType,
  type ResearchPublicationEvidenceSnapshot,
} from '../types/runtime.js';
import { HypothesisRepository } from '../persistence/hypothesis-repo.js';
import { StrategyLifecycleRepository } from '../persistence/strategy-lifecycle-repo.js';

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Required<ResearchPublishBackConfig> = {
  minMergedScore: 0.7,
  requirePromotionArtifact: true,
  requireDiagnosticsArtifact: false,
  requireHypothesisArtifact: false,
  label: '',
  dryRun: false,
};

// ---------------------------------------------------------------------------
// ResearchPublishBackService
// ---------------------------------------------------------------------------

export class ResearchPublishBackService {
  private readonly _db: Database.Database;
  private readonly _hypothesisRepo: HypothesisRepository;
  private readonly _lifecycleRepo: StrategyLifecycleRepository;

  constructor(options: {
    db: Database.Database;
    hypothesisRepo?: HypothesisRepository;
    lifecycleRepo?: StrategyLifecycleRepository;
  }) {
    this._db = options.db;
    this._hypothesisRepo = options.hypothesisRepo ?? new HypothesisRepository(options.db);
    this._lifecycleRepo = options.lifecycleRepo ?? new StrategyLifecycleRepository(options.db);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Evaluate and publish a completed hypothesis evaluation into the main
   * system through a governed, idempotent handoff.
   *
   * Steps:
   *   1. Load the evaluation with linked walk-forward run and winner.
   *   2. Check for an existing publication (idempotency guard).
   *   3. Validate evaluation state (must be Completed).
   *   4. Validate prerequisite data (linked winner, artifact completeness).
   *   5. Compute publish vs hold verdict under configurable thresholds.
   *   6. On publish: persist publication + lifecycle state + governance
   *      decision inside one SQLite transaction.
   *   7. On hold: persist publication row with 'held' status (no lifecycle/
   *      governance linkage).
   *   8. On dry-run: return result with isDryRun: true, no side effects.
   *
   * @param hypothesisEvaluationId - FK → hypothesis_evaluations(id).
   * @param config - Optional configuration overrides.
   * @returns Structured result with verdict, publication row, and rationale.
   */
  publish(
    hypothesisEvaluationId: number,
    config?: ResearchPublishBackConfig,
  ): ResearchPublishBackResult {
    const resolvedConfig: Required<ResearchPublishBackConfig> = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    const now = Date.now();

    // -----------------------------------------------------------------------
    // Step 1: Load evaluation with linked data
    // -----------------------------------------------------------------------
    const linked = this._hypothesisRepo.getEvaluationWithLinked(hypothesisEvaluationId);
    if (!linked) {
      return this._rejectedResult(
        hypothesisEvaluationId,
        `Hypothesis evaluation ${hypothesisEvaluationId} not found. Cannot publish an evaluation that does not exist.`,
        resolvedConfig.dryRun,
        now,
      );
    }

    // -----------------------------------------------------------------------
    // Step 2: Check for existing publication (idempotency)
    // -----------------------------------------------------------------------
    const existing = this._hypothesisRepo.getPublicationByEvaluationId(hypothesisEvaluationId);
    if (existing) {
      // Return the existing publication as a published or held result.
      const verdict = existing.status === ResearchPublicationStatus.Published
        ? ResearchPublishBackVerdict.Publish
        : ResearchPublishBackVerdict.Hold;

      return {
        verdict,
        publication: existing,
        evaluation: {
          id: linked.evaluation.id,
          status: linked.evaluation.status,
          hypothesisGraphId: linked.evaluation.hypothesisGraphId,
          rationale: linked.evaluation.rationale,
        },
        winner: linked.winner
          ? {
              mergedScore: this._extractWinnerMergedScore(linked),
              deterministicScore: null,
            }
          : null,
        lifecycleStateId: existing.lifecycleStateId,
        governanceDecisionId: existing.governanceDecisionId,
        rationale: `Existing publication found (id=${existing.id}, status=${existing.status}). Returning existing record.`,
        isDryRun: false,
      };
    }

    // -----------------------------------------------------------------------
    // Step 3: Validate evaluation state
    // -----------------------------------------------------------------------
    const evaluation = linked.evaluation;

    if (evaluation.status === HypothesisEvaluationStatus.Completed) {
      // Completed — eligible for publication evaluation.
    } else if (
      evaluation.status === HypothesisEvaluationStatus.Failed ||
      evaluation.status === HypothesisEvaluationStatus.Cancelled ||
      evaluation.status === HypothesisEvaluationStatus.NoWinner
    ) {
      return this._rejectedResult(
        hypothesisEvaluationId,
        `Hypothesis evaluation ${hypothesisEvaluationId} has terminal status "${evaluation.status}". ` +
        `Only "${HypothesisEvaluationStatus.Completed}" evaluations can be published.`,
        resolvedConfig.dryRun,
        now,
        linked,
      );
    } else {
      return this._rejectedResult(
        hypothesisEvaluationId,
        `Hypothesis evaluation ${hypothesisEvaluationId} has non-terminal status "${evaluation.status}". ` +
        `Only "${HypothesisEvaluationStatus.Completed}" evaluations can be published.`,
        resolvedConfig.dryRun,
        now,
        linked,
      );
    }

    // -----------------------------------------------------------------------
    // Step 4: Validate prerequisite data
    // -----------------------------------------------------------------------
    const prerequisiteFailures: string[] = [];

    // Must have a walk-forward winner
    if (!linked.winner) {
      prerequisiteFailures.push(
        'No walk-forward winner linked to this evaluation. ' +
        'A completed evaluation must have a selected winner for publication.',
      );
    }

    // Must have research artifacts
    const artifacts = this._hypothesisRepo.getResearchArtifactsByEvaluationId(hypothesisEvaluationId);
    const hasPromotionArtifact = artifacts.some(
      a => a.artifactType === ResearchArtifactType.PromotionArtifact,
    );
    const hasDiagnosticsArtifact = artifacts.some(
      a => a.artifactType === ResearchArtifactType.Diagnostics,
    );
    const hasHypothesisArtifact = artifacts.some(
      a => a.artifactType === ResearchArtifactType.HypothesisRendered,
    );

    if (resolvedConfig.requirePromotionArtifact && !hasPromotionArtifact) {
      prerequisiteFailures.push(
        'No promotion artifact found for this evaluation. ' +
        'A promotion artifact (type: promotion_artifact) is required for publication.',
      );
    }

    if (resolvedConfig.requireDiagnosticsArtifact && !hasDiagnosticsArtifact) {
      prerequisiteFailures.push(
        'No diagnostics artifact found for this evaluation. ' +
        'A diagnostics artifact (type: diagnostics) is required for publication.',
      );
    }

    if (resolvedConfig.requireHypothesisArtifact && !hasHypothesisArtifact) {
      prerequisiteFailures.push(
        'No hypothesis rendered artifact found for this evaluation. ' +
        'A hypothesis rendered artifact (type: hypothesis_rendered) is required for publication.',
      );
    }

    if (prerequisiteFailures.length > 0) {
      return this._heldResult(
        hypothesisEvaluationId,
        linked,
        resolvedConfig,
        artifacts.length,
        hasPromotionArtifact,
        hasDiagnosticsArtifact,
        hasHypothesisArtifact,
        prerequisiteFailures,
        resolvedConfig.dryRun,
        now,
      );
    }

    // -----------------------------------------------------------------------
    // Step 5: Compute publish vs hold verdict under thresholds
    // -----------------------------------------------------------------------
    const holdReasons: string[] = [];
    const mergedScore = this._extractWinnerMergedScore(linked);

    // Minimum merged score check
    if (mergedScore !== null && mergedScore < resolvedConfig.minMergedScore) {
      holdReasons.push(
        `Winner merged score ${mergedScore.toFixed(4)} is below minimum threshold ${resolvedConfig.minMergedScore}`,
      );
    } else if (mergedScore === null) {
      holdReasons.push(
        'No merged score available from the walk-forward winner.',
      );
    }

    // Must have a walk-forward run with market info for strategy identity
    const walkForwardRun = linked.walkForwardRun;
    if (!walkForwardRun) {
      holdReasons.push(
        'No walk-forward run linked to this evaluation. Cannot derive strategy identity or market ID.',
      );
    }

    if (holdReasons.length > 0) {
      return this._heldResult(
        hypothesisEvaluationId,
        linked,
        resolvedConfig,
        artifacts.length,
        hasPromotionArtifact,
        hasDiagnosticsArtifact,
        hasHypothesisArtifact,
        holdReasons,
        resolvedConfig.dryRun,
        now,
      );
    }

    // -----------------------------------------------------------------------
    // All checks pass — determine if publish or hold
    // -----------------------------------------------------------------------

    // Resolve strategy identity and market ID from the linked walk-forward run.
    // walkForwardRun is guaranteed non-null by the holdReasons check above.
    const strategyId = `research-hypothesis-${evaluation.hypothesisGraphId}`;
    const strategyVersion = '1.0.0';
    // Query market_id from the run table since the snapshot type doesn't carry it
    const runRow = this._db.prepare(
      'SELECT market_id FROM walk_forward_runs WHERE id = ?',
    ).get(walkForwardRun!.id) as { market_id: string } | undefined;
    const marketId = runRow?.market_id ?? 'INDIA_NSE_EQ';

    // Determine lifecycle phase: start at Backtest as the safest default.
    // The governance evaluator will promote to Paper/Live when thresholds
    // are met in a separate flow.
    const lifecyclePhase = StrategyLifecyclePhase.Backtest;
    const governanceVerdict = GovernanceVerdict.Promote;

    // Build evidence snapshot
    const evidenceSnapshot: ResearchPublicationEvidenceSnapshot = {
      minMergedScore: resolvedConfig.minMergedScore,
      actualMergedScore: mergedScore,
      hasPromotionArtifact,
      hasArtifacts: artifacts.length > 0,
      artifactCount: artifacts.length,
      hasRationale: evaluation.rationale.length > 0,
      hasWinner: linked.winner !== null,
      holdReasons: [],
    };

    // -----------------------------------------------------------------------
    // Step 6/7/8: Persist or dry-run
    // -----------------------------------------------------------------------

    if (resolvedConfig.dryRun) {
      return {
        verdict: ResearchPublishBackVerdict.Publish,
        publication: null,
        evaluation: {
          id: evaluation.id,
          status: evaluation.status,
          hypothesisGraphId: evaluation.hypothesisGraphId,
          rationale: evaluation.rationale,
        },
        winner: {
          mergedScore,
          deterministicScore: null,
        },
        lifecycleStateId: null,
        governanceDecisionId: null,
        rationale: `Dry-run: all publication thresholds met. Would publish "${strategyId}" v${strategyVersion} for market "${marketId}".`,
        isDryRun: true,
      };
    }

    // ── Persist inside a single SQLite transaction ──
    const transaction = this._db.transaction(() => {
      // 6a. Upsert lifecycle state
      const newState = this._lifecycleRepo.upsertCurrentState({
        strategyId,
        strategyVersion,
        marketId,
        phase: lifecyclePhase,
        updatedAt: now,
      });

      // 6b. Insert append-only governance decision
      const decision = this._lifecycleRepo.insertDecision({
        strategyId,
        strategyVersion,
        marketId,
        verdict: governanceVerdict,
        previousPhase: StrategyLifecyclePhase.Backtest,
        newPhase: lifecyclePhase,
        rationale: `Research hypothesis ${evaluation.hypothesisGraphId} published after governance evaluation. ` +
          `Merged score: ${this._formatScore(mergedScore)}. ` +
          `Evaluation rationale: ${evaluation.rationale}`,
        evidenceJson: JSON.stringify(evidenceSnapshot),
        winnerId: null, // Research publications reference the evaluation's winner via FK chain
        recordedAt: now,
      });

      // 6c. Insert publication row
      const publication = this._hypothesisRepo.insertPublication({
        hypothesisEvaluationId: hypothesisEvaluationId,
        hypothesisGraphId: evaluation.hypothesisGraphId,
        status: ResearchPublicationStatus.Published,
        strategyId,
        strategyVersion,
        marketId,
        rationale: `Published hypothesis ${evaluation.hypothesisGraphId} as strategy "${strategyId}" v${strategyVersion} in "${lifecyclePhase}" phase. ` +
          `Evaluation: ${evaluation.rationale}`,
        evidenceJson: JSON.stringify(evidenceSnapshot),
        lifecycleStateId: newState.id,
        governanceDecisionId: decision.id,
        publishedAt: now,
        createdAt: now,
      });

      return { publication, lifecycleStateId: newState.id, governanceDecisionId: decision.id };
    });

    let result: { publication: import('../types/runtime.js').ResearchPublicationRow; lifecycleStateId: number; governanceDecisionId: number };
    try {
      result = transaction();
    } catch (err) {
      // Transaction failed — return a held result so the caller sees
      // the failure rather than a partial write.
      const message = err instanceof Error ? err.message : String(err);
      return this._heldResult(
        hypothesisEvaluationId,
        linked,
        resolvedConfig,
        artifacts.length,
        hasPromotionArtifact,
        hasDiagnosticsArtifact,
        hasHypothesisArtifact,
        [`Publication transaction failed: ${message}`],
        false,
        now,
      );
    }

    return {
      verdict: ResearchPublishBackVerdict.Publish,
      publication: result.publication,
      evaluation: {
        id: evaluation.id,
        status: evaluation.status,
        hypothesisGraphId: evaluation.hypothesisGraphId,
        rationale: evaluation.rationale,
      },
      winner: {
        mergedScore,
        deterministicScore: null,
      },
      lifecycleStateId: result.lifecycleStateId,
      governanceDecisionId: result.governanceDecisionId,
      rationale: `Hypothesis ${evaluation.hypothesisGraphId} published as strategy "${strategyId}" v${strategyVersion} in "${lifecyclePhase}" phase. ` +
        `Publication id=${result.publication.id}, lifecycle state id=${result.lifecycleStateId}, governance decision id=${result.governanceDecisionId}.`,
      isDryRun: false,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Extract the merged score from the linked evaluation's winner, or null.
   */
  /**
   * Extract the merged score from the linked evaluation's winner by loading
   * the walk_forward_trial identified by selected_trial_id.
   */
  private _extractWinnerMergedScore(linked: HypothesisEvaluationWithLinked): number | null {
    if (!linked.winner || !linked.winner.selectedTrialId) {
      return null;
    }
    try {
      const row = this._db.prepare(
        'SELECT merged_score FROM walk_forward_trials WHERE id = ?',
      ).get(linked.winner.selectedTrialId) as { merged_score: number } | undefined;
      return row?.merged_score ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Format a score for human-readable output.
   */
  private _formatScore(score: number | null): string {
    if (score === null) return 'N/A';
    return score.toFixed(4);
  }

  /**
   * Build a rejected result — used when the evaluation is in a terminal
   * state that precludes publication (Failed, Cancelled, NoWinner).
   */
  private _rejectedResult(
    hypothesisEvaluationId: number,
    rationale: string,
    isDryRun: boolean,
    now: number,
    linked?: HypothesisEvaluationWithLinked | null,
  ): ResearchPublishBackResult {
    const evaluation = linked?.evaluation;
    return {
      verdict: ResearchPublishBackVerdict.Hold,
      publication: isDryRun
        ? null
        : evaluation
          ? this._hypothesisRepo.insertPublication({
              hypothesisEvaluationId,
              hypothesisGraphId: evaluation.hypothesisGraphId,
              status: ResearchPublicationStatus.Rejected,
              strategyId: '',
              strategyVersion: '',
              marketId: '',
              rationale,
              evidenceJson: JSON.stringify({
                minMergedScore: DEFAULT_CONFIG.minMergedScore,
                actualMergedScore: null,
                hasPromotionArtifact: false,
                hasArtifacts: false,
                artifactCount: 0,
                hasRationale: false,
                hasWinner: false,
                holdReasons: [rationale],
              } as ResearchPublicationEvidenceSnapshot),
              lifecycleStateId: null,
              governanceDecisionId: null,
              publishedAt: null,
              createdAt: now,
            })
          : null,
      evaluation: {
        id: hypothesisEvaluationId,
        status: evaluation?.status ?? 'unknown',
        hypothesisGraphId: evaluation?.hypothesisGraphId ?? 0,
        rationale: evaluation?.rationale ?? '',
      },
      winner: linked?.winner
        ? (() => {
            const ms = this._extractWinnerMergedScore(linked);
            return { mergedScore: ms, deterministicScore: null };
          })()
        : null,
      lifecycleStateId: null,
      governanceDecisionId: null,
      rationale,
      isDryRun,
    };
  }

  /**
   * Build a held result — used when preconditions or threshold checks fail.
   *
   * On hold, the publication row is persisted with 'held' status but no
   * lifecycle state or governance decision linkage. On dry-run, only the
   * result DTO is returned without any side effects.
   */
  private _heldResult(
    hypothesisEvaluationId: number,
    linked: HypothesisEvaluationWithLinked,
    config: Required<ResearchPublishBackConfig>,
    artifactCount: number,
    hasPromotionArtifact: boolean,
    hasDiagnosticsArtifact: boolean,
    hasHypothesisArtifact: boolean,
    holdReasons: string[],
    isDryRun: boolean,
    now: number,
  ): ResearchPublishBackResult {
    const evaluation = linked.evaluation;
    const mergedScore = this._extractWinnerMergedScore(linked);

    const evidenceSnapshot: ResearchPublicationEvidenceSnapshot = {
      minMergedScore: config.minMergedScore,
      actualMergedScore: mergedScore,
      hasPromotionArtifact,
      hasArtifacts: artifactCount > 0,
      artifactCount,
      hasRationale: evaluation.rationale.length > 0,
      hasWinner: linked.winner !== null,
      holdReasons,
    };

    const rationale = holdReasons.join('; ');

    if (isDryRun) {
      return {
        verdict: ResearchPublishBackVerdict.Hold,
        publication: null,
        evaluation: {
          id: evaluation.id,
          status: evaluation.status,
          hypothesisGraphId: evaluation.hypothesisGraphId,
          rationale: evaluation.rationale,
        },
        winner: {
          mergedScore,
          deterministicScore: null,
        },
        lifecycleStateId: null,
        governanceDecisionId: null,
        rationale: `Dry-run: publication held. ${rationale}`,
        isDryRun: true,
      };
    }

    // Persist a held publication row (no lifecycle state or governance decision)
    const publication = this._hypothesisRepo.insertPublication({
      hypothesisEvaluationId,
      hypothesisGraphId: evaluation.hypothesisGraphId,
      status: ResearchPublicationStatus.Held,
      strategyId: '',
      strategyVersion: '',
      marketId: '',
      rationale,
      evidenceJson: JSON.stringify(evidenceSnapshot),
      lifecycleStateId: null,
      governanceDecisionId: null,
      publishedAt: null,
      createdAt: now,
    });

    return {
      verdict: ResearchPublishBackVerdict.Hold,
      publication,
      evaluation: {
        id: evaluation.id,
        status: evaluation.status,
        hypothesisGraphId: evaluation.hypothesisGraphId,
        rationale: evaluation.rationale,
      },
      winner: {
        mergedScore,
        deterministicScore: null,
      },
      lifecycleStateId: null,
      governanceDecisionId: null,
      rationale,
      isDryRun: false,
    };
  }
}
