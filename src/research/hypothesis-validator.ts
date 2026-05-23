// ── HypothesisValidator ──
// Fail-closed structural validation, canonical identity derivation,
// exact-failure ledger consultation, and rejection-persistence orchestration.
//
// The validator produces structured results that downstream evaluation
// consumes without reinterpreting raw errors. Two validation paths:
//
//   validateStructure(graph)   — pure structural validation (no DB)
//   validate(graph)            — structural + exact-failure dedupe (needs memoryRepo)
//
// Persistence helpers optionally write rejection/skip outcomes through
// the repositories for durable auditability.

import { canonicalizeHypothesis } from './hypothesis-canonicalizer.js';
import { HypothesisMemoryRepository } from '../persistence/hypothesis-memory-repo.js';
import { HypothesisRepository } from '../persistence/hypothesis-repo.js';
import {
  type HypothesisCanonicalRecord,
  type HypothesisDedupeResult,
  type HypothesisGraph,
  type HypothesisValidationReason,
  type HypothesisValidationResult,
  HypothesisStatus,
  HypothesisMemoryStatus,
  HypothesisValidationReasonCode,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Validator result — discriminated union over the two output shapes
// ---------------------------------------------------------------------------

export type ValidatorResult =
  | { kind: 'validated'; status: HypothesisStatus.Validated; canonical: HypothesisCanonicalRecord }
  | { kind: 'rejected'; status: HypothesisStatus.Rejected; canonical?: HypothesisCanonicalRecord; reasons: HypothesisValidationReason[] }
  | { kind: 'skipped'; status: HypothesisStatus.Skipped; canonical: HypothesisCanonicalRecord; reasons: HypothesisValidationReason[] };

// ---------------------------------------------------------------------------
// HypothesisValidator
// ---------------------------------------------------------------------------

export class HypothesisValidator {
  private readonly _memoryRepo: HypothesisMemoryRepository | null;
  private readonly _hypothesisRepo: HypothesisRepository | null;

  constructor(deps?: {
    memoryRepo?: HypothesisMemoryRepository | null;
    hypothesisRepo?: HypothesisRepository | null;
  }) {
    this._memoryRepo = deps?.memoryRepo ?? null;
    this._hypothesisRepo = deps?.hypothesisRepo ?? null;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Pure structural validation of a hypothesis graph.
   *
   * Checks schema version, required rule-group presence/non-emptiness, and
   * per-rule-node type/params validity. Returns a `HypothesisValidationResult`
   * with Rejected status and ordered reasons when any check fails, or
   * Validated status with a canonical identity when all checks pass.
   *
   * Does NOT consult the exact-failure ledger. Use `validate()` for the
   * full pipeline.
   */
  validateStructure(graph: HypothesisGraph): HypothesisValidationResult {
    const reasons = this._checkStructure(graph);

    if (reasons.length > 0) {
      return { status: HypothesisStatus.Rejected, reasons };
    }

    const canonical = canonicalizeHypothesis(graph);
    return { status: HypothesisStatus.Validated, canonical, reasons: [] };
  }

  /**
   * Full validation pipeline: structural validation + exact-failure dedupe.
   *
   * 1. Structural validation — fail-closed. Returns Rejected if any
   *    structural check fails.
   * 2. Canonical identity computed from the validated graph.
   * 3. Exact-failure ledger consulted. If a prior exact match exists,
   *    returns Skipped with an auditable reason from the ledger.
   * 4. If no match found, returns Validated with canonical identity.
   *
   * When the memory repository is not wired, the dedupe step is skipped
   * and all structurally valid graphs validate through.
   */
  validate(graph: HypothesisGraph): ValidatorResult {
    // Step 1: Structural validation (fail-closed)
    const structureReasons = this._checkStructure(graph);

    if (structureReasons.length > 0) {
      return {
        kind: 'rejected',
        status: HypothesisStatus.Rejected,
        reasons: structureReasons,
      };
    }

    // Step 2: Canonical identity
    const canonical = canonicalizeHypothesis(graph);

    // Step 3: Exact-failure ledger consultation
    if (this._memoryRepo) {
      const lookup = this._memoryRepo.hasExactFailure(canonical.canonicalHash);

      if (lookup.found && lookup.entry) {
        const reasonCode = lookup.entry.status === HypothesisMemoryStatus.Rejected
          ? HypothesisValidationReasonCode.ExactRejectedMatch
          : HypothesisValidationReasonCode.ExactFailureMatch;

        const reasons: HypothesisValidationReason[] = [
          {
            reasonCode,
            reasonMessage: `Exact prior ${lookup.entry.status} match: ${lookup.entry.reasonMessage}`,
          },
        ];

        return {
          kind: 'skipped',
          status: HypothesisStatus.Skipped,
          canonical,
          reasons,
        };
      }
    }

    // Step 4: Validated — no issues found
    return {
      kind: 'validated',
      status: HypothesisStatus.Validated,
      canonical,
    };
  }

  /**
   * Persist a rejection or validated outcome through the repository layer.
   *
   * For rejected hypotheses:
   *   - Inserts a hypothesis graph row with `Rejected` status.
   *   - Records an exact-memory ledger entry so future exact duplicates
   *     are deterministically skipped.
   *
   * For validated hypotheses:
   *   - Inserts a hypothesis graph row with `Validated` status.
   *
   * For skipped hypotheses:
   *   - No-op. The prior memory ledger entry already covers this case.
   *
   * Returns the persisted hypothesis graph row id, or null when persistence
   * is not wired or the outcome does not require persistence (skipped).
   *
   * @throws When persistence is required but repositories are not wired.
   */
  persistResult(
    graph: HypothesisGraph,
    result: ValidatorResult,
    timestamps?: { now?: number },
  ): number | null {
    const now = timestamps?.now ?? Date.now();

    switch (result.kind) {
      case 'skipped':
        // The prior memory ledger entry already exists — no persistence needed.
        return null;

      case 'validated': {
        if (!this._hypothesisRepo) {
          throw new Error(
            'HypothesisRepository is required to persist a validated hypothesis result.',
          );
        }

        const row = this._hypothesisRepo.insertHypothesis({
          canonicalHash: result.canonical.canonicalHash,
          canonicalJson: result.canonical.canonicalJson,
          status: HypothesisStatus.Validated,
          graph,
          createdAt: now,
          updatedAt: now,
        });

        return row.id;
      }

      case 'rejected': {
        if (!this._hypothesisRepo || !this._memoryRepo) {
          throw new Error(
            'Both HypothesisRepository and HypothesisMemoryRepository are required ' +
            'to persist a rejected hypothesis result.',
          );
        }

        // Persist the rejected graph
        const row = this._hypothesisRepo.insertHypothesis({
          canonicalHash: result.canonical?.canonicalHash ?? '',
          canonicalJson: result.canonical?.canonicalJson ?? '',
          status: HypothesisStatus.Rejected,
          graph,
          createdAt: now,
          updatedAt: now,
        });

        // Record the rejection in the exact-failure memory ledger
        const primaryReason = result.reasons[0];
        this._memoryRepo.recordFailure({
          canonicalHash: result.canonical?.canonicalHash ?? '',
          status: HypothesisMemoryStatus.Rejected,
          reasonCode: primaryReason?.reasonCode ?? HypothesisValidationReasonCode.MissingRuleGroup,
          reasonMessage: primaryReason?.reasonMessage ?? 'Structural validation failed with no specific reason.',
          hypothesisGraphId: row.id,
          createdAt: now,
        });

        return row.id;
      }
    }
  }

  /**
   * Convenience: validate + persist in a single call.
   *
   * Runs the full validation pipeline (structural + dedupe), then persists
   * the outcome through the repositories. Returns the combined result with
   * the persisted row id when applicable.
   */
  validateAndPersist(graph: HypothesisGraph, now?: number): {
    result: ValidatorResult;
    persistedId: number | null;
  } {
    const result = this.validate(graph);
    const persistedId = this.persistResult(graph, result, { now });
    return { result, persistedId };
  }

  // -----------------------------------------------------------------------
  // Private — structural checks
  // -----------------------------------------------------------------------

  /**
   * Run all structural validation checks and return ordered reasons.
   * Returns an empty array when no issues are found.
   */
  private _checkStructure(graph: HypothesisGraph): HypothesisValidationReason[] {
    const reasons: HypothesisValidationReason[] = [];

    // 1. Schema version
    this._checkSchemaVersion(graph, reasons);

    // 2. Required rule groups — presence and non-emptiness
    this._checkRequiredGroups(graph, reasons);

    // Only check per-rule nodes when all groups are present
    if (this._hasAllGroups(graph)) {
      // 3. Per-rule-node validity
      this._checkRuleNodes(graph, reasons);
    }

    return reasons;
  }

  private _checkSchemaVersion(
    graph: HypothesisGraph,
    reasons: HypothesisValidationReason[],
  ): void {
    if (!graph.schemaVersion || typeof graph.schemaVersion !== 'string') {
      reasons.push({
        reasonCode: HypothesisValidationReasonCode.UnsupportedSchemaVersion,
        reasonMessage: 'Schema version is missing or not a string.',
      });
    }
  }

  private _checkRequiredGroups(
    graph: HypothesisGraph,
    reasons: HypothesisValidationReason[],
  ): void {
    const groups: Array<keyof HypothesisGraph> = [
      'signals', 'filters', 'entryRules', 'exitRules', 'riskRules',
    ];

    for (const group of groups) {
      const value = graph[group];

      if (!Array.isArray(value)) {
        reasons.push({
          reasonCode: HypothesisValidationReasonCode.MissingRuleGroup,
          reasonMessage: `Required rule group "${group}" is missing or not an array.`,
        });
      } else if (value.length === 0) {
        reasons.push({
          reasonCode: HypothesisValidationReasonCode.EmptyRuleGroup,
          reasonMessage: `Rule group "${group}" is present but empty.`,
        });
      }
    }
  }

  /**
   * Returns true when all five required rule groups are present and are arrays.
   * Used to decide whether per-rule-node checks are safe to run.
   */
  private _hasAllGroups(graph: HypothesisGraph): boolean {
    const groups: Array<keyof HypothesisGraph> = [
      'signals', 'filters', 'entryRules', 'exitRules', 'riskRules',
    ];
    return groups.every(g => Array.isArray(graph[g]));
  }

  private _checkRuleNodes(
    graph: HypothesisGraph,
    reasons: HypothesisValidationReason[],
  ): void {
    const groups: Array<keyof HypothesisGraph> = [
      'signals', 'filters', 'entryRules', 'exitRules', 'riskRules',
    ];

    for (const group of groups) {
      const nodes = graph[group] as Array<{ type?: string; params?: unknown }>;

      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];

        // Check type discriminator
        if (!node.type || typeof node.type !== 'string') {
          reasons.push({
            reasonCode: HypothesisValidationReasonCode.MissingRuleType,
            reasonMessage: `Rule at index ${i} in "${group}" is missing a valid type discriminator.`,
          });
        }

        // Check params is a non-null, non-array object
        if (node.params == null || typeof node.params !== 'object' || Array.isArray(node.params)) {
          reasons.push({
            reasonCode: HypothesisValidationReasonCode.InvalidRuleParams,
            reasonMessage: `Rule at index ${i} in "${group}" has missing or non-object params.`,
          });
        }
      }
    }
  }
}
