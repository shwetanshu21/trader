// ── ResearchAuditService ──
// Reusable research-lineage audit snapshot that composes existing repositories
// to reconstruct either the duplicate-skip branch or the publish-success branch
// from a single canonical hash. Each lineage segment is independently loaded
// and may be null or empty — the typed shape is the single truth source for
// proof code and operator inspection surfaces.

import {
  type GovernanceDecisionRow,
  type HypothesisGraphRow,
  type ResearchArtifactRow,
  type ResearchLineageDuplicateEvidence,
  type ResearchLineageEvaluationSnapshot,
  type ResearchLineagePublicationEvidence,
  type ResearchLineageSnapshot,
  type ResearchPublicationRow,
  type StrategyLifecycleStateRow,
} from '../types/runtime.js';
import { HypothesisRepository } from '../persistence/hypothesis-repo.js';
import { HypothesisMemoryRepository } from '../persistence/hypothesis-memory-repo.js';
import { StrategyLifecycleRepository } from '../persistence/strategy-lifecycle-repo.js';

// ---------------------------------------------------------------------------
// ResearchAuditService
// ---------------------------------------------------------------------------

export class ResearchAuditService {
  private readonly _hypothesisRepo: HypothesisRepository;
  private readonly _memoryRepo: HypothesisMemoryRepository;
  private readonly _lifecycleRepo: StrategyLifecycleRepository;

  constructor(deps: {
    hypothesisRepo: HypothesisRepository;
    memoryRepo: HypothesisMemoryRepository;
    lifecycleRepo: StrategyLifecycleRepository;
  }) {
    this._hypothesisRepo = deps.hypothesisRepo;
    this._memoryRepo = deps.memoryRepo;
    this._lifecycleRepo = deps.lifecycleRepo;
  }

  /**
   * Assemble a research-lineage snapshot for a canonical hypothesis hash.
   *
   * Each lineage segment is independently loaded and may be null or empty.
   * The snapshot is the single typed truth source for both the
   * duplicate-skip branch (memory entry present, no hypothesis) and the
   * publish-success branch (full evaluation → artifacts → publication →
   * lifecycle → governance chain).
   *
   * @param canonicalHash - Stable SHA-256 digest of the canonical hypothesis form.
   * @returns A fully typed snapshot with null-safe lineage segments.
   */
  assembleLineage(canonicalHash: string): ResearchLineageSnapshot {
    const assembledAt = Date.now();

    // ── 1. Duplicate-skip evidence from memory ledger ──
    const memoryLookup = this._memoryRepo.hasExactFailure(canonicalHash);

    // ── 2. Hypothesis graph row (single query, reused below) ──
    const hypothesis: HypothesisGraphRow | null =
      this._hypothesisRepo.getHypothesisByCanonicalHash(canonicalHash);

    let duplicateEvidence: ResearchLineageDuplicateEvidence | null = null;

    if (memoryLookup.found && memoryLookup.entry) {
      duplicateEvidence = {
        entry: memoryLookup.entry,
        hasLaterHypothesis: hypothesis !== null,
      };
    }

    // ── 3. Evaluation with linked run/winner snapshots ──
    let evaluation: ResearchLineageEvaluationSnapshot | null = null;
    let artifacts: ResearchArtifactRow[] | null = null;

    if (hypothesis) {
      const evalRow = this._hypothesisRepo.getEvaluationByHypothesisId(hypothesis.id);

      if (evalRow) {
        // Load linked walk-forward run and winner via the existing with-linked query
        const withLinked = evalRow.walkForwardRunId != null || evalRow.winnerId != null
          ? this._hypothesisRepo.getEvaluationWithLinked(evalRow.id)
          : null;

        evaluation = {
          evaluation: evalRow,
          walkForwardRun: withLinked?.walkForwardRun ?? null,
          winner: withLinked?.winner ?? null,
        };

        // ── 4. Research artifacts for the evaluation ──
        artifacts = this._hypothesisRepo.getResearchArtifactsByEvaluationId(evalRow.id);
      }
    }

    // ── 5. Publication evidence with lifecycle/governance linkage ──
    let publicationEvidence: ResearchLineagePublicationEvidence | null = null;

    // The publication is keyed by hypothesis evaluation id — we need an evaluation
    // row (loaded above) to look it up. If we have an evaluation, try to find the
    // linked publication.
    if (evaluation) {
      const pubRow = this._hypothesisRepo.getPublicationByEvaluationId(
        evaluation.evaluation.id,
      );
      if (pubRow) {
        publicationEvidence = this._buildPublicationEvidence(pubRow);
      }
    }

    return {
      canonicalHash,
      duplicateEvidence,
      hypothesis,
      evaluation,
      artifacts,
      publicationEvidence,
      assembledAt,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Build publication evidence from a persisted publication row, loading
   * linked lifecycle state and governance decisions.
   */
  private _buildPublicationEvidence(
    pubRow: ResearchPublicationRow,
  ): ResearchLineagePublicationEvidence {
    let lifecycleState: StrategyLifecycleStateRow | null = null;
    let governanceDecisions: GovernanceDecisionRow[] = [];

    if (pubRow.lifecycleStateId != null) {
      // Load the lifecycle state via the strategy identity stored in the publication
      lifecycleState = this._lifecycleRepo.getCurrentState(
        pubRow.strategyId,
        pubRow.strategyVersion,
        pubRow.marketId,
      );
    }

    // Load governance decisions for this publication's strategy identity
    governanceDecisions = this._lifecycleRepo.getDecisionsForStrategy(
      pubRow.strategyId,
      pubRow.strategyVersion,
      pubRow.marketId,
      20,
    );

    return {
      publication: pubRow,
      lifecycleState,
      governanceDecisions,
    };
  }
}
