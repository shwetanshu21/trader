// ── StrategyLifecycleEvaluator ──
// Pure governance evaluator that consumes durable walk-forward winner evidence
// and records lifecycle outcomes (HOLD or PROMOTE) with append-only rationale
// and evidence snapshots. No transient runtime state is referenced.
//
// Also implements demotion evaluation: consumes persisted lifecycle state plus
// persisted execution-risk state/events and performance summary inputs, chooses
// the downgraded phase deterministically, and records append-only governance
// decisions with rationale/evidence (DEMOTE or HOLD).
//
// High-level flow:
//   1. Load winner context from WalkForwardRepository.getWinnerWithContext()
//   2. Validate that the run identity matches the target strategy lifecycle key
//   3. Emit fail-closed HOLD for no_winner, missing/mismatched context
//   4. Compute out-of-sample evidence from the selected trial's window evidence
//   5. Compare persisted evidence against configured thresholds
//   6. Persist each evaluation through StrategyLifecycleRepository (append-only)
//   7. Update current lifecycle phase only on valid promotion
//
// Demotion flow:
//   1. Load current lifecycle state
//   2. Load execution-risk state (halt state, recent risk events)
//   3. Evaluate performance-drift evidence from performance summary
//   4. Evaluate risk-breach evidence from risk state and events
//   5. Persist DEMOTE or HOLD decision with evidence snapshot
//   6. Update current lifecycle phase only on valid demotion

import { WalkForwardRepository } from '../persistence/walk-forward-repo.js';
import { StrategyLifecycleRepository } from '../persistence/strategy-lifecycle-repo.js';
import { ExecutionRiskRepository } from '../persistence/execution-risk-repo.js';
import {
  GovernanceVerdict,
  StrategyLifecyclePhase,
  HaltState,
  type GovernanceThresholdConfig,
  type GovernanceDecisionRow,
  type StrategyLifecycleStateRow,
  type DemotionThresholdConfig,
  type DemotionEvidenceSnapshot,
  type DemotionEvaluationInput,
  type DemotionEvaluationResult,
  type LifecyclePerformanceSummary,
  type ExecutionRiskStateRow,
  type RiskEventRow,
} from '../types/runtime.js';
import {
  WalkForwardWindowType,
  WalkForwardSelectionResult,
} from '../replay/walk-forward-types.js';
import type { WalkForwardWinnerWithContext } from '../replay/walk-forward-types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Evidence snapshot persisted with each governance evaluation.
 *
 * Captures the threshold config snapshot, the selected trial's actual scores,
 * summary stats computed from out-of-sample windows, and per-window details
 * so a future operator or agent can audit the decision without re-executing.
 */
export interface PromotionEvidenceSnapshot {
  /** Threshold configuration used for this evaluation. */
  thresholds: GovernanceThresholdConfig;
  /** Merged score of the selected trial, or null when no winner trial exists. */
  mergedScore: number | null;
  /** Average out-of-sample Sharpe ratio across all OOS windows, or null. */
  avgSharpeRatio: number | null;
  /** Maximum out-of-sample drawdown percentage (positive value), or null. */
  maxDrawdown: number | null;
  /** Number of out-of-sample windows with evidence. */
  outOfSampleWindowCount: number;
  /** Total number of window evidence rows for the selected trial. */
  totalWindowCount: number;
  /** Walk-forward winner result (selected, no_winner, pending). */
  winnerResult: string;
  /** Label of the selected trial, or null. */
  selectedTrialLabel: string | null;
  /** Parameter JSON of the selected trial, or null. */
  selectedTrialParamsJson: string | null;
  /** Per-window out-of-sample details for forensic inspection. */
  outOfSampleDetails: Array<{
    windowId: number;
    sharpeRatio: number | null;
    maxDrawdown: number | null;
    totalReturn: number;
    tradeCount: number;
  }>;
}

/**
 * Input to a promotion evaluation.
 */
export interface PromotionEvaluationInput {
  /** FK → walk_forward_runs(id). The run whose winner context to evaluate. */
  runId: number;
  /** Target strategy identity that would be promoted (e.g. 'india-nse-eq-v1'). */
  strategyId: string;
  /** Target strategy version (e.g. '1.0.0'). */
  strategyVersion: string;
  /** Target market ID (e.g. 'INDIA_NSE_EQ'). */
  marketId: string;
  /** Threshold config to use. Falls back to defaults when not provided. */
  thresholds?: GovernanceThresholdConfig;
  /** Timestamp for the evaluation. Default: Date.now(). */
  evaluatedAt?: number;
}

/**
 * Structured output of a promotion evaluation.
 */
export interface PromotionEvaluationResult {
  /** Governance verdict: hold or promote. */
  verdict: GovernanceVerdict;
  /** Strategy lifecycle phase before this evaluation. */
  previousPhase: StrategyLifecyclePhase;
  /** Strategy lifecycle phase after this evaluation (same as previous on HOLD). */
  newPhase: StrategyLifecyclePhase;
  /** Human-readable rationale explaining the verdict. */
  rationale: string;
  /** Evidence snapshot persisted with the decision. */
  evidenceSnapshot: PromotionEvidenceSnapshot;
  /** Whether the lifecycle state was updated (only true on PROMOTE). */
  stateUpdated: boolean;
  /** The governance decision row that was persisted. */
  decision: GovernanceDecisionRow;
  /** Current state of the strategy after this evaluation, or null if not loaded. */
  currentState: StrategyLifecycleStateRow;
}

// ---------------------------------------------------------------------------
// Default thresholds
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS: GovernanceThresholdConfig = {
  minMergedScore: 0.7,
  minSharpeRatio: 1.0,
  maxDrawdown: 30,
  minWindowCount: 2,
  minOutOfSampleWindows: 1,
};

const DEFAULT_DEMOTION_THRESHOLDS_LOCAL: DemotionThresholdConfig = {
  minSharpeRatio: 0.5,
  maxDrawdown: 40,
  minTradeCount: 5,
  haltTriggersDemotion: true,
  minCriticalRiskEvents: 1,
  riskEventLookbackMs: 7 * 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Phase ordering helpers
// ---------------------------------------------------------------------------

/**
 * Determine the next lifecycle phase after promotion from the given phase.
 * Returns null when the strategy is already at the maximum phase (Live).
 */
function nextPhase(current: StrategyLifecyclePhase): StrategyLifecyclePhase | null {
  switch (current) {
    case StrategyLifecyclePhase.Backtest:
      return StrategyLifecyclePhase.Paper;
    case StrategyLifecyclePhase.Paper:
      return StrategyLifecyclePhase.Live;
    case StrategyLifecyclePhase.Live:
      return null;
  }
}

/**
 * Determine the previous lifecycle phase after demotion from the given phase.
 * Returns null when the strategy is already at the minimum phase (Backtest).
 */
function previousPhase(current: StrategyLifecyclePhase): StrategyLifecyclePhase | null {
  switch (current) {
    case StrategyLifecyclePhase.Live:
      return StrategyLifecyclePhase.Paper;
    case StrategyLifecyclePhase.Paper:
      return StrategyLifecyclePhase.Backtest;
    case StrategyLifecyclePhase.Backtest:
      return null; // Already at minimum — cannot demote further
  }
}

// ---------------------------------------------------------------------------
// StrategyLifecycleEvaluator
// ---------------------------------------------------------------------------

export class StrategyLifecycleEvaluator {
  private readonly _walkForwardRepo: WalkForwardRepository;
  private readonly _lifecycleRepo: StrategyLifecycleRepository;
  private readonly _executionRiskRepo: ExecutionRiskRepository | null;

  constructor(deps: {
    walkForwardRepo: WalkForwardRepository;
    lifecycleRepo: StrategyLifecycleRepository;
    executionRiskRepo?: ExecutionRiskRepository | null;
  }) {
    this._walkForwardRepo = deps.walkForwardRepo;
    this._lifecycleRepo = deps.lifecycleRepo;
    this._executionRiskRepo = deps.executionRiskRepo ?? null;
  }

  // -----------------------------------------------------------------------
  // Promotion evaluation
  // -----------------------------------------------------------------------

  /**
   * Evaluate whether a strategy should be promoted based on walk-forward winner evidence.
   *
   * Pure governance logic — the only state consumed is:
   * - Persisted walk-forward winner context (from WalkForwardRepository)
   * - Current lifecycle phase (from StrategyLifecycleRepository)
   * - Configured governance thresholds
   *
   * @param input - The evaluation input specifying which run, strategy, and thresholds to use.
   * @returns A structured evaluation result with verdict, rationale, and evidence snapshot.
   */
  evaluate(input: PromotionEvaluationInput): PromotionEvaluationResult {
    const evaluatedAt = input.evaluatedAt ?? Date.now();
    const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;

    // -----------------------------------------------------------------------
    // Step 1: Load winner context from WalkForwardRepository
    // -----------------------------------------------------------------------
    const winnerContext = this._walkForwardRepo.getWinnerWithContext(input.runId);

    // No winner decision at all → fail-closed HOLD
    if (!winnerContext) {
      return this._result(
        input, evaluatedAt, thresholds, null,
        GovernanceVerdict.Hold,
        'No walk-forward winner decision found for the given run ID. ' +
        'Cannot evaluate promotion without a persisted winner result.',
        null, null,
      );
    }

    // -----------------------------------------------------------------------
    // Step 2: Validate that the run identity matches the target strategy
    // -----------------------------------------------------------------------
    const identityFailures = this._validateIdentity(input, winnerContext);
    if (identityFailures.length > 0) {
      return this._result(
        input, evaluatedAt, thresholds, winnerContext,
        GovernanceVerdict.Hold,
        identityFailures.join('; '),
        null, null,
      );
    }

    // -----------------------------------------------------------------------
    // Step 3: Fail-closed on no_winner or pending winner result
    // -----------------------------------------------------------------------
    if (winnerContext.result === WalkForwardSelectionResult.NoWinner) {
      return this._result(
        input, evaluatedAt, thresholds, winnerContext,
        GovernanceVerdict.Hold,
        'Walk-forward winner selection returned no_winner. ' +
        'No qualifying trial exists to evaluate for promotion.',
        null, null,
      );
    }

    if (winnerContext.result === WalkForwardSelectionResult.Pending) {
      return this._result(
        input, evaluatedAt, thresholds, winnerContext,
        GovernanceVerdict.Hold,
        'Walk-forward winner selection is still pending. ' +
        'Cannot evaluate promotion before winner selection completes.',
        null, null,
      );
    }

    // -----------------------------------------------------------------------
    // Step 4: Check that a selected trial actually exists
    // -----------------------------------------------------------------------
    if (!winnerContext.selectedTrial) {
      return this._result(
        input, evaluatedAt, thresholds, winnerContext,
        GovernanceVerdict.Hold,
        'Walk-forward winner result is "selected" but the selected trial is null ' +
        '(data inconsistency). Cannot evaluate promotion.',
        null, null,
      );
    }

    // -----------------------------------------------------------------------
    // Step 5: Compute out-of-sample evidence from the selected trial
    // -----------------------------------------------------------------------
    const oosEvidence = this._computeOutOfSampleEvidence(winnerContext.selectedTrial);
    const totalWindowEvidenceCount = winnerContext.selectedTrial.windowEvidence.length;

    const evidenceSnapshot: PromotionEvidenceSnapshot = {
      thresholds,
      mergedScore: winnerContext.selectedTrial.mergedScore,
      avgSharpeRatio: oosEvidence.avgSharpeRatio,
      maxDrawdown: oosEvidence.maxDrawdown,
      outOfSampleWindowCount: oosEvidence.windowCount,
      totalWindowCount: totalWindowEvidenceCount,
      winnerResult: winnerContext.result,
      selectedTrialLabel: winnerContext.selectedTrial.label,
      selectedTrialParamsJson: winnerContext.selectedTrial.paramsJson,
      outOfSampleDetails: oosEvidence.details,
    };

    // -----------------------------------------------------------------------
    // Step 6: Compare against configured thresholds
    // -----------------------------------------------------------------------
    const failures: string[] = [];

    // Minimum merged score
    const mergedScore = winnerContext.selectedTrial.mergedScore;
    if (mergedScore < thresholds.minMergedScore) {
      failures.push(
        `Merged score ${mergedScore.toFixed(4)} is below minimum threshold ${thresholds.minMergedScore}`,
      );
    }

    // Minimum Sharpe ratio
    if (oosEvidence.avgSharpeRatio !== null && oosEvidence.avgSharpeRatio < thresholds.minSharpeRatio) {
      failures.push(
        `Average out-of-sample Sharpe ratio ${oosEvidence.avgSharpeRatio.toFixed(4)} is below minimum threshold ${thresholds.minSharpeRatio}`,
      );
    } else if (oosEvidence.avgSharpeRatio === null && thresholds.minSharpeRatio > 0) {
      failures.push(
        'No out-of-sample Sharpe ratio data available to compare against threshold. ' +
        'Either the selected trial has no out-of-sample windows or no Sharpe ratios were recorded.',
      );
    }

    // Maximum drawdown
    if (oosEvidence.maxDrawdown !== null && oosEvidence.maxDrawdown > thresholds.maxDrawdown) {
      failures.push(
        `Maximum out-of-sample drawdown ${oosEvidence.maxDrawdown.toFixed(2)}% exceeds maximum threshold ${thresholds.maxDrawdown}%`,
      );
    }

    // Minimum total window count
    if (totalWindowEvidenceCount < thresholds.minWindowCount) {
      failures.push(
        `Total window evidence count ${totalWindowEvidenceCount} is below minimum ${thresholds.minWindowCount}`,
      );
    }

    // Minimum out-of-sample window count
    if (oosEvidence.windowCount < thresholds.minOutOfSampleWindows) {
      failures.push(
        `Out-of-sample window count ${oosEvidence.windowCount} is below minimum ${thresholds.minOutOfSampleWindows}`,
      );
    }

    // -----------------------------------------------------------------------
    // Step 7a: Thresholds not met → HOLD
    // -----------------------------------------------------------------------
    if (failures.length > 0) {
      return this._result(
        input, evaluatedAt, thresholds, winnerContext,
        GovernanceVerdict.Hold,
        failures.join('; '),
        evidenceSnapshot, null,
      );
    }

    // -----------------------------------------------------------------------
    // Step 7b: All checks passed → determine promotion target
    // -----------------------------------------------------------------------
    const currentState = this._lifecycleRepo.getCurrentState(
      input.strategyId,
      input.strategyVersion,
      input.marketId,
    );
    const promotionPrevPhase = currentState.phase;
    const promotionTargetPhase = nextPhase(promotionPrevPhase);

    if (!promotionTargetPhase) {
      return this._result(
        input, evaluatedAt, thresholds, winnerContext,
        GovernanceVerdict.Hold,
        'Strategy is already at the maximum lifecycle phase (live). No further promotion possible.',
        evidenceSnapshot, currentState,
      );
    }

    // -----------------------------------------------------------------------
    // Step 8: Persist PROMOTE decision and update lifecycle state
    // -----------------------------------------------------------------------
    return this._result(
      input, evaluatedAt, thresholds, winnerContext,
      GovernanceVerdict.Promote,
      `All promotion thresholds met. Promoting from ${promotionPrevPhase} to ${promotionTargetPhase}.`,
      evidenceSnapshot, currentState,
      promotionTargetPhase,
    );
  }

  // -----------------------------------------------------------------------
  // Demotion evaluation
  // -----------------------------------------------------------------------

  /**
   * Evaluate whether a strategy should be demoted based on performance-drift
   * and/or risk-breach evidence.
   *
   * Fail-closed: missing or malformed evidence produces HOLD, never silent
   * demotion. The evaluator checks two independent trigger paths:
   *
   * 1. **Performance drift**: When a `performanceSummary` is provided, the
   *    evaluator compares Sharpe ratio, drawdown, and trade count against
   *    configured thresholds. If thresholds are breached, the strategy is
   *    considered for drift-based demotion.
   *
   * 2. **Risk breach**: When an `ExecutionRiskRepository` is wired, the
   *    evaluator checks the persisted halt state and recent critical-severity
   *    risk events. If halt state is ActiveHalt (and `haltTriggersDemotion`
   *    is true) or the number of recent critical risk events meets the
   *    threshold, the strategy is considered for risk-based demotion.
   *
   * If both triggers fire, the demotion rationale captures all triggers.
   * If neither trigger fires, the verdict is HOLD.
   *
   * @param input - The demotion evaluation input.
   * @returns A structured evaluation result.
   */
  evaluateDemotion(input: DemotionEvaluationInput): DemotionEvaluationResult {
    const evaluatedAt = input.evaluatedAt ?? Date.now();
    const thresholds = input.thresholds ?? DEFAULT_DEMOTION_THRESHOLDS_LOCAL;

    // -----------------------------------------------------------------------
    // Step 1: Load current lifecycle state
    // -----------------------------------------------------------------------
    const currentState = this._lifecycleRepo.getCurrentState(
      input.strategyId,
      input.strategyVersion,
      input.marketId,
    );
    const currentPhase = currentState.phase;

    // Already at minimum phase — cannot demote further
    if (currentPhase === StrategyLifecyclePhase.Backtest) {
      return this._demotionResult(
        input, evaluatedAt, thresholds, currentState,
        GovernanceVerdict.Hold,
        'Strategy is already at the minimum lifecycle phase (backtest). No demotion possible.',
        null, null, 0,
      );
    }

    // -----------------------------------------------------------------------
    // Step 2: Load execution-risk state (if available)
    // -----------------------------------------------------------------------
    let riskState: ExecutionRiskStateRow | null = null;
    let recentRiskEvents: RiskEventRow[] = [];
    if (this._executionRiskRepo) {
      riskState = this._executionRiskRepo.getCurrentState();
      const lookbackSince = evaluatedAt - thresholds.riskEventLookbackMs;
      recentRiskEvents = this._executionRiskRepo.getEventsSince(lookbackSince, 100);
    }

    // Count critical-severity risk events within lookback
    const criticalRiskEvents = recentRiskEvents.filter(
      e => e.severity === 'critical',
    );
    const criticalRiskEventCount = criticalRiskEvents.length;

    // -----------------------------------------------------------------------
    // Step 3: Evaluate performance-drift evidence
    // -----------------------------------------------------------------------
    const perfSummary = input.performanceSummary ?? null;
    const driftFailures: string[] = [];
    const evalBlockers: string[] = []; // conditions that prevent evaluation

    if (perfSummary !== null) {
      // Validate that the performance summary identity matches
      if (perfSummary.strategyId !== input.strategyId) {
        evalBlockers.push(
          `Performance summary strategyId "${perfSummary.strategyId}" does not match target "${input.strategyId}"`,
        );
      }
      if (perfSummary.strategyVersion !== input.strategyVersion) {
        evalBlockers.push(
          `Performance summary version "${perfSummary.strategyVersion}" does not match target "${input.strategyVersion}"`,
        );
      }
      if (perfSummary.marketId !== input.marketId) {
        evalBlockers.push(
          `Performance summary marketId "${perfSummary.marketId}" does not match target "${input.marketId}"`,
        );
      }

      // Check trade count sufficiency
      if (perfSummary.tradeCount < thresholds.minTradeCount) {
        evalBlockers.push(
          `Trade count ${perfSummary.tradeCount} is below minimum ${thresholds.minTradeCount} — insufficient evidence for drift demotion`,
        );
      }

      // Only check drift thresholds when identity matches and trade count is sufficient
      if (evalBlockers.length === 0) {
        // Check Sharpe ratio
        if (perfSummary.sharpeRatio !== null && perfSummary.sharpeRatio < thresholds.minSharpeRatio) {
          driftFailures.push(
            `Sharpe ratio ${perfSummary.sharpeRatio.toFixed(4)} is below demotion threshold ${thresholds.minSharpeRatio}`,
          );
        }

        // Check drawdown
        if (perfSummary.maxDrawdown !== null && perfSummary.maxDrawdown > thresholds.maxDrawdown) {
          driftFailures.push(
            `Max drawdown ${perfSummary.maxDrawdown.toFixed(2)}% exceeds demotion threshold ${thresholds.maxDrawdown}%`,
          );
        }
      }
    }

    // -----------------------------------------------------------------------
    // Step 4: Evaluate risk-breach evidence
    // -----------------------------------------------------------------------
    const riskFailures: string[] = [];

    if (riskState !== null) {
      // Check halt state
      if (thresholds.haltTriggersDemotion && riskState.haltState === HaltState.ActiveHalt) {
        riskFailures.push(
          `Risk halt is active (source: ${riskState.haltSource ?? 'unknown'}, reason: ${riskState.haltReason ?? 'none'})`,
        );
      }

      // Check critical risk event count
      if (criticalRiskEventCount >= thresholds.minCriticalRiskEvents) {
        riskFailures.push(
          `Found ${criticalRiskEventCount} critical risk event(s) within lookback window, meeting threshold of ${thresholds.minCriticalRiskEvents}`,
        );
      }
    }

    // -----------------------------------------------------------------------
    // Step 5: Determine trigger and build evidence snapshot
    // -----------------------------------------------------------------------
    const allFailures = [...evalBlockers, ...driftFailures, ...riskFailures];

    // Determine the trigger edge(s) that fired
    // Evaluation blockers prevent drift demotion but risk can still fire independently
    const hasDrift = driftFailures.length > 0;
    const hasRisk = riskFailures.length > 0;
    const hasEvalBlockers = evalBlockers.length > 0;

    let trigger: DemotionEvidenceSnapshot['trigger'];
    let triggerDetail: string;

    if (hasEvalBlockers && !hasRisk) {
      // Only eval blockers, no risk trigger → HOLD
      trigger = 'hold';
      triggerDetail = evalBlockers.join('; ');
    } else if (hasDrift && hasRisk) {
      trigger = 'multiple';
      triggerDetail = `Performance drift: ${driftFailures.join('; ')}. Risk breach: ${riskFailures.join('; ')}.`;
      if (hasEvalBlockers) {
        triggerDetail += ` Evaluation notes: ${evalBlockers.join('; ')}.`;
      }
    } else if (hasDrift) {
      trigger = 'performance_drift';
      triggerDetail = driftFailures.join('; ');
    } else if (hasRisk) {
      trigger = 'risk_breach';
      triggerDetail = riskFailures.join('; ');
    } else {
      trigger = 'hold';
      triggerDetail = this._buildDemotionHoldRationale(
        perfSummary, riskState, criticalRiskEventCount, thresholds,
      );
    }

    // Build risk state serialization
    const riskStateSerialized: Record<string, unknown> | null = riskState
      ? {
          haltState: riskState.haltState,
          haltSource: riskState.haltSource,
          haltReason: riskState.haltReason,
          haltedAt: riskState.haltedAt,
          latchCount: riskState.latchCount,
          recentCriticalEventCount: criticalRiskEventCount,
        }
      : null;

    const evidenceSnapshot: DemotionEvidenceSnapshot = {
      thresholds,
      trigger,
      triggerDetail,
      performanceSummary: perfSummary,
      riskState: riskStateSerialized,
      criticalRiskEventCount,
      previousPhase: currentPhase,
      newPhase: currentPhase, // placeholder; updated below if demoting
    };

    // -----------------------------------------------------------------------
    // Step 6: Determine verdict
    // -----------------------------------------------------------------------
    if (!hasRisk && !hasDrift) {
      // No trigger condition met → HOLD.
      // Use triggerDetail when eval blockers produced specific messages;
      // otherwise fall back to the standard hold rationale.
      const rationale = hasEvalBlockers
        ? triggerDetail
        : this._buildDemotionHoldRationale(
            perfSummary, riskState, criticalRiskEventCount, thresholds,
          );
      return this._demotionResult(
        input, evaluatedAt, thresholds, currentState,
        GovernanceVerdict.Hold,
        rationale,
        evidenceSnapshot, null, criticalRiskEventCount,
      );
    }

    // -----------------------------------------------------------------------
    // Step 7: Determine downgrade target
    // -----------------------------------------------------------------------
    const demotionTargetPhase = previousPhase(currentPhase);

    if (!demotionTargetPhase) {
      // Should not happen since we checked Backtest earlier, but guard anyway
      return this._demotionResult(
        input, evaluatedAt, thresholds, currentState,
        GovernanceVerdict.Hold,
        'Strategy is already at minimum phase — cannot demote despite trigger conditions.',
        evidenceSnapshot, null, criticalRiskEventCount,
      );
    }

    // Update evidence snapshot with target phase
    const finalEvidence: DemotionEvidenceSnapshot = {
      ...evidenceSnapshot,
      newPhase: demotionTargetPhase,
    };

    const triggerLabel = hasDrift && hasRisk ? 'performance drift and risk breach' : hasDrift ? 'performance drift' : 'risk breach';

    // -----------------------------------------------------------------------
    // Step 8: Persist DEMOTE decision and update lifecycle state
    // -----------------------------------------------------------------------
    return this._demotionResult(
      input, evaluatedAt, thresholds, currentState,
      GovernanceVerdict.Demote,
      `Demotion triggered by ${triggerLabel}. Downgrading from ${currentPhase} to ${demotionTargetPhase}. Details: ${triggerDetail}`,
      finalEvidence, demotionTargetPhase, criticalRiskEventCount,
    );
  }

  // -----------------------------------------------------------------------
  // Private helpers — promotion
  // -----------------------------------------------------------------------

  /**
   * Validate that the walk-forward run's strategy identity matches the target.
   * Returns an array of failure messages (empty when all match).
   */
  private _validateIdentity(
    input: PromotionEvaluationInput,
    winnerContext: WalkForwardWinnerWithContext,
  ): string[] {
    const failures: string[] = [];
    const run = winnerContext.run;

    if (run.strategyId !== input.strategyId) {
      failures.push(
        `Run strategy identity "${run.strategyId}" does not match target "${input.strategyId}"`,
      );
    }
    if (run.strategyVersion !== input.strategyVersion) {
      failures.push(
        `Run strategy version "${run.strategyVersion}" does not match target "${input.strategyVersion}"`,
      );
    }
    if (run.marketId !== input.marketId) {
      failures.push(
        `Run market ID "${run.marketId}" does not match target "${input.marketId}"`,
      );
    }
    return failures;
  }

  /**
   * Compute out-of-sample evidence from the selected trial's window evidence.
   *
   * Filters for out_of_sample windows, computes aggregate stats (avg Sharpe,
   * max drawdown) and per-window detail rows.
   */
  private _computeOutOfSampleEvidence(trial: NonNullable<WalkForwardWinnerWithContext['selectedTrial']>): {
    avgSharpeRatio: number | null;
    maxDrawdown: number | null;
    windowCount: number;
    details: PromotionEvidenceSnapshot['outOfSampleDetails'];
  } {
    const oosWindows = trial.windowEvidence.filter(
      w => w.windowType === WalkForwardWindowType.OutOfSample,
    );

    if (oosWindows.length === 0) {
      return { avgSharpeRatio: null, maxDrawdown: null, windowCount: 0, details: [] };
    }

    const validSharpe = oosWindows.filter(w => w.sharpeRatio !== null);
    const avgSharpeRatio = validSharpe.length > 0
      ? validSharpe.reduce((sum, w) => sum + w.sharpeRatio!, 0) / validSharpe.length
      : null;

    const validDD = oosWindows.filter(w => w.maxDrawdown !== null);
    const maxDrawdown = validDD.length > 0
      ? Math.max(...validDD.map(w => Math.abs(w.maxDrawdown!)))
      : null;

    const details = oosWindows.map(w => ({
      windowId: w.windowId,
      sharpeRatio: w.sharpeRatio,
      maxDrawdown: w.maxDrawdown !== null ? Math.abs(w.maxDrawdown) : null,
      totalReturn: w.totalReturn,
      tradeCount: w.tradeCount,
    }));

    return { avgSharpeRatio, maxDrawdown, windowCount: oosWindows.length, details };
  }

  /**
   * Build the complete promotion evaluation result, persist the governance decision,
   * and (on PROMOTE) update the lifecycle state.
   */
  private _result(
    input: PromotionEvaluationInput,
    evaluatedAt: number,
    thresholds: GovernanceThresholdConfig,
    winnerContext: WalkForwardWinnerWithContext | null,
    verdict: GovernanceVerdict,
    rationale: string,
    evidenceSnapshot: PromotionEvidenceSnapshot | null,
    currentState: StrategyLifecycleStateRow | null,
    targetPhase?: StrategyLifecyclePhase,
  ): PromotionEvaluationResult {
    let previousPhaseVal: StrategyLifecyclePhase;
    let newPhaseVal: StrategyLifecyclePhase;

    if (currentState) {
      previousPhaseVal = currentState.phase;
    } else {
      const state = this._lifecycleRepo.getCurrentState(
        input.strategyId,
        input.strategyVersion,
        input.marketId,
      );
      previousPhaseVal = state.phase;
    }

    if (verdict === GovernanceVerdict.Promote && targetPhase !== undefined) {
      newPhaseVal = targetPhase;
    } else {
      newPhaseVal = previousPhaseVal;
    }

    const resolvedEvidence: PromotionEvidenceSnapshot = evidenceSnapshot ?? {
      thresholds,
      mergedScore: winnerContext?.selectedTrial?.mergedScore ?? null,
      avgSharpeRatio: null,
      maxDrawdown: null,
      outOfSampleWindowCount: 0,
      totalWindowCount: winnerContext?.selectedTrial?.windowEvidence.length ?? 0,
      winnerResult: winnerContext?.result ?? WalkForwardSelectionResult.NoWinner,
      selectedTrialLabel: winnerContext?.selectedTrial?.label ?? null,
      selectedTrialParamsJson: winnerContext?.selectedTrial?.paramsJson ?? null,
      outOfSampleDetails: [],
    };

    const decision = this._lifecycleRepo.insertDecision({
      strategyId: input.strategyId,
      strategyVersion: input.strategyVersion,
      marketId: input.marketId,
      verdict,
      previousPhase: previousPhaseVal,
      newPhase: newPhaseVal,
      rationale,
      evidenceJson: JSON.stringify(resolvedEvidence),
      winnerId: winnerContext?.id ?? null,
      recordedAt: evaluatedAt,
    });

    let stateUpdated = false;
    if (verdict === GovernanceVerdict.Promote && targetPhase !== undefined) {
      this._lifecycleRepo.upsertCurrentState({
        strategyId: input.strategyId,
        strategyVersion: input.strategyVersion,
        marketId: input.marketId,
        phase: targetPhase,
        updatedAt: evaluatedAt,
      });
      stateUpdated = true;
    }

    const resolvedState = this._lifecycleRepo.getCurrentState(
      input.strategyId,
      input.strategyVersion,
      input.marketId,
    );

    return {
      verdict,
      previousPhase: previousPhaseVal,
      newPhase: newPhaseVal,
      rationale,
      evidenceSnapshot: resolvedEvidence,
      stateUpdated,
      decision,
      currentState: resolvedState,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers — demotion
  // -----------------------------------------------------------------------

  /**
   * Build a human-readable rationale for HOLD when no demotion trigger fires.
   */
  private _buildDemotionHoldRationale(
    perfSummary: LifecyclePerformanceSummary | null,
    riskState: ExecutionRiskStateRow | null,
    criticalRiskEventCount: number,
    thresholds: DemotionThresholdConfig,
  ): string {
    const parts: string[] = ['No demotion trigger conditions met.'];

    if (perfSummary !== null) {
      const driftOk: string[] = [];
      if (perfSummary.sharpeRatio !== null && perfSummary.sharpeRatio >= thresholds.minSharpeRatio) {
        driftOk.push(`Sharpe ${perfSummary.sharpeRatio.toFixed(4)} >= ${thresholds.minSharpeRatio}`);
      }
      if (perfSummary.maxDrawdown !== null && perfSummary.maxDrawdown <= thresholds.maxDrawdown) {
        driftOk.push(`drawdown ${perfSummary.maxDrawdown.toFixed(2)}% <= ${thresholds.maxDrawdown}%`);
      }
      if (perfSummary.tradeCount >= thresholds.minTradeCount) {
        driftOk.push(`trades ${perfSummary.tradeCount} >= ${thresholds.minTradeCount}`);
      }
      if (driftOk.length > 0) {
        parts.push(`Performance within thresholds: ${driftOk.join(', ')}.`);
      } else if (perfSummary.tradeCount < thresholds.minTradeCount) {
        parts.push(`Insufficient trade data (${perfSummary.tradeCount} < ${thresholds.minTradeCount}) for drift evaluation.`);
      }
    } else {
      parts.push('No performance summary provided for drift evaluation.');
    }

    if (riskState !== null) {
      const riskOk: string[] = [];
      if (riskState.haltState !== HaltState.ActiveHalt) {
        riskOk.push('no active halt');
      }
      if (criticalRiskEventCount < thresholds.minCriticalRiskEvents) {
        riskOk.push(`critical events (${criticalRiskEventCount}) below threshold (${thresholds.minCriticalRiskEvents})`);
      }
      if (riskOk.length > 0) {
        parts.push(`Risk state within bounds: ${riskOk.join(', ')}.`);
      }
    } else {
      parts.push('No risk repository wired for risk-breach evaluation.');
    }

    return parts.join(' ');
  }

  /**
   * Build the complete demotion evaluation result, persist the governance
   * decision, and (on DEMOTE) update the lifecycle state.
   */
  private _demotionResult(
    input: DemotionEvaluationInput,
    evaluatedAt: number,
    thresholds: DemotionThresholdConfig,
    currentState: StrategyLifecycleStateRow,
    verdict: GovernanceVerdict,
    rationale: string,
    evidenceSnapshot: DemotionEvidenceSnapshot | null,
    targetPhase: StrategyLifecyclePhase | null,
    criticalRiskEventCount: number,
  ): DemotionEvaluationResult {
    const previousPhaseVal = currentState.phase;
    let newPhaseVal: StrategyLifecyclePhase;

    if (verdict === GovernanceVerdict.Demote && targetPhase !== null) {
      newPhaseVal = targetPhase;
    } else {
      newPhaseVal = previousPhaseVal; // HOLD keeps current phase
    }

    // Build resolved evidence snapshot
    const resolvedEvidence: DemotionEvidenceSnapshot = evidenceSnapshot ?? {
      thresholds,
      trigger: 'hold',
      triggerDetail: 'No trigger condition evaluated.',
      performanceSummary: input.performanceSummary ?? null,
      riskState: null,
      criticalRiskEventCount,
      previousPhase: previousPhaseVal,
      newPhase: newPhaseVal,
    };

    // Persist append-only governance decision
    const decision = this._lifecycleRepo.insertDecision({
      strategyId: input.strategyId,
      strategyVersion: input.strategyVersion,
      marketId: input.marketId,
      verdict,
      previousPhase: previousPhaseVal,
      newPhase: newPhaseVal,
      rationale,
      evidenceJson: JSON.stringify(resolvedEvidence),
      winnerId: null,
      recordedAt: evaluatedAt,
    });

    // On DEMOTE, update the lifecycle state
    let stateUpdated = false;
    if (verdict === GovernanceVerdict.Demote && targetPhase !== null) {
      this._lifecycleRepo.upsertCurrentState({
        strategyId: input.strategyId,
        strategyVersion: input.strategyVersion,
        marketId: input.marketId,
        phase: targetPhase,
        updatedAt: evaluatedAt,
      });
      stateUpdated = true;
    }

    // Reload current state for the output
    const resolvedState = this._lifecycleRepo.getCurrentState(
      input.strategyId,
      input.strategyVersion,
      input.marketId,
    );

    return {
      verdict,
      previousPhase: previousPhaseVal,
      newPhase: newPhaseVal,
      rationale,
      evidenceSnapshot: resolvedEvidence,
      stateUpdated,
      decision,
      currentState: resolvedState,
    };
  }
}
