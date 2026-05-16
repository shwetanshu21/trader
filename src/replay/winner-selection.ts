// ── Winner Selector ──
// Evaluates ranked walk-forward trial candidates against configurable
// selection criteria and produces a governance-ready winner (or HOLD)
// decision with structured rationale.
//
// Three selection modes:
//   top_ranked — picks rank-1 candidate if it meets minimum window count.
//   threshold — all candidates must exceed minMergedScore, best wins.
//   composite — multi-criteria: score, Sharpe, drawdown, win rate with
//               deterministic tie-breakers (lower drawdown, higher win rate,
//               earlier trial index).

import {
  WalkForwardSelectionStrategy,
  WalkForwardSelectionResult,
  WalkForwardWindowType,
  type WalkForwardSelectionConfig,
  type WalkForwardSelectionOutput,
  type WalkForwardRankedCandidate,
  type WalkForwardTrialWindowRow,
  type WalkForwardCandidateComparison,
} from './walk-forward-types.js';

// ---------------------------------------------------------------------------
// Default thresholds
// ---------------------------------------------------------------------------

/** Default minimum merged score when none specified. */
const DEFAULT_MIN_MERGED_SCORE = 0.7;

/** Default minimum number of windows with evidence. */
const DEFAULT_MIN_WINDOW_COUNT = 1;

/** Default minimum Sharpe ratio for composite selection. */
const DEFAULT_MIN_SHARPE_RATIO = 0.8;

/** Default maximum drawdown allowed (as positive percentage) for composite. */
const DEFAULT_MAX_DRAWDOWN = 25;

/** Maximum number of candidates to include in comparison output. */
const MAX_COMPARISON_CANDIDATES = 5;

// ---------------------------------------------------------------------------
// WinnerSelector
// ---------------------------------------------------------------------------

export class WinnerSelector {
  /**
   * Evaluate ranked candidates against the given selection config.
   *
   * @param candidates - Ranked candidates (ordered by rank ascending).
   * @param config - Selection configuration.
   * @param trialEvidence - Map of trialId -> per-window evidence rows.
   *   Required for composite strategy; optional for top_ranked/threshold.
   * @returns A structured selection output with rationale and comparisons.
   */
  selectWinner(
    candidates: WalkForwardRankedCandidate[],
    config: WalkForwardSelectionConfig,
    trialEvidence?: Map<number, WalkForwardTrialWindowRow[]>,
  ): WalkForwardSelectionOutput {
    // Validate inputs
    if (candidates.length === 0) {
      return this._noWinnerResult(config, 'No candidates to evaluate.');
    }

    const minWindowCount = config.minWindowCount ?? DEFAULT_MIN_WINDOW_COUNT;
    const minMergedScore = config.minMergedScore ?? DEFAULT_MIN_MERGED_SCORE;

    // Filter candidates that meet minimum window count
    const qualifying = candidates.filter(c => {
      // Ensure minimum window evidence count
      if (c.windowCount < minWindowCount) return false;

      // For threshold and composite, also check merged score
      if (config.strategy !== WalkForwardSelectionStrategy.TopRanked) {
        if (c.mergedScore < minMergedScore) return false;
      }

      return true;
    });

    if (qualifying.length === 0) {
      const details = this._buildDisqualificationDetails(
        candidates, minWindowCount, minMergedScore, config.strategy,
      );
      return this._noWinnerResult(config, details);
    }

    // Ensure at least rank-1 candidate qualifies for top_ranked
    if (config.strategy === WalkForwardSelectionStrategy.TopRanked) {
      return this._selectTopRanked(qualifying, candidates, config, trialEvidence);
    }

    // Threshold: pick best qualifying candidate by merged score
    if (config.strategy === WalkForwardSelectionStrategy.Threshold) {
      return this._selectThreshold(qualifying, candidates, config, trialEvidence);
    }

    // Composite: multi-criteria evaluation
    return this._selectComposite(qualifying, candidates, config, trialEvidence);
  }

  // -----------------------------------------------------------------------
  // Top-ranked selection
  // -----------------------------------------------------------------------

  /**
   * Select the top-ranked qualifying candidate.
   *
   * The rank-1 candidate is selected if it meets the minimum window count.
   * No additional threshold checks apply.
   */
  private _selectTopRanked(
    qualifying: WalkForwardRankedCandidate[],
    allCandidates: WalkForwardRankedCandidate[],
    config: WalkForwardSelectionConfig,
    trialEvidence?: Map<number, WalkForwardTrialWindowRow[]>,
  ): WalkForwardSelectionOutput {
    const winner = qualifying[0]; // best rank
    const comparisons = this._buildComparisons(
      allCandidates, winner.trialId, config, trialEvidence,
    );

    const rationale = this._formatRationale(
      'top_ranked', winner, qualifying.slice(1), config, trialEvidence,
    );

    return {
      result: WalkForwardSelectionResult.Selected,
      selectedTrialId: winner.trialId,
      selectionStrategy: config.strategy,
      selectionConfigJson: JSON.stringify(config),
      rationale,
      comparisons,
    };
  }

  // -----------------------------------------------------------------------
  // Threshold selection
  // -----------------------------------------------------------------------

  /**
   * Select the best qualifying candidate by merged score.
   *
   * All candidates must exceed the minimum merged score threshold.
   * The highest-scoring qualifying candidate wins.
   * Tie-breaker: prefer lower drawdown, then higher win rate, then earlier trial.
   */
  private _selectThreshold(
    qualifying: WalkForwardRankedCandidate[],
    allCandidates: WalkForwardRankedCandidate[],
    config: WalkForwardSelectionConfig,
    trialEvidence?: Map<number, WalkForwardTrialWindowRow[]>,
  ): WalkForwardSelectionOutput {
    const sorted = this._tieBreakSort(qualifying, trialEvidence);
    const winner = sorted[0];
    const comparisons = this._buildComparisons(
      allCandidates, winner.trialId, config, trialEvidence,
    );

    const rationale = this._formatRationale(
      'threshold', winner, sorted.slice(1), config, trialEvidence,
    );

    return {
      result: WalkForwardSelectionResult.Selected,
      selectedTrialId: winner.trialId,
      selectionStrategy: config.strategy,
      selectionConfigJson: JSON.stringify(config),
      rationale,
      comparisons,
    };
  }

  // -----------------------------------------------------------------------
  // Composite (multi-criteria) selection
  // -----------------------------------------------------------------------

  /**
   * Select the best candidate using multi-criteria evaluation.
   *
   * Candidates must pass ALL of:
   *   1. Minimum merged score threshold
   *   2. Minimum window count
   *   3. Minimum Sharpe ratio (average of out-of-sample windows)
   *   4. Maximum drawdown (max of out-of-sample windows)
   *
   * Tie-breaker: prefer lower drawdown, then higher win rate, then earlier trial.
   */
  private _selectComposite(
    qualifying: WalkForwardRankedCandidate[],
    allCandidates: WalkForwardRankedCandidate[],
    config: WalkForwardSelectionConfig,
    trialEvidence?: Map<number, WalkForwardTrialWindowRow[]>,
  ): WalkForwardSelectionOutput {
    const minSharpe = config.minSharpeRatio ?? DEFAULT_MIN_SHARPE_RATIO;
    const maxDrawdown = config.maxDrawdown ?? DEFAULT_MAX_DRAWDOWN;

    // Further filter by composite criteria
    const compositeQualified: WalkForwardRankedCandidate[] = [];

    for (const candidate of qualifying) {
      if (!trialEvidence) {
        // Without per-window evidence, composite criteria cannot be validated.
        // Fall back to score-only filtering when at least one candidate has evidence.
        continue;
      }

      const evidence = trialEvidence.get(candidate.trialId);
      if (!evidence || evidence.length === 0) {
        // No evidence available — skip candidate for composite
        continue;
      }

      // Compute out-of-sample aggregate metrics
      const oosWindows = evidence.filter(
        e => e.windowType === WalkForwardWindowType.OutOfSample,
      );

      if (oosWindows.length === 0) {
        // No out-of-sample evidence — disqualify for composite
        continue;
      }

      const avgSharpe = this._averageNullable(oosWindows.map(e => e.sharpeRatio));
      const maxDD = oosWindows.reduce(
        (max, e) => Math.max(max, e.maxDrawdown ?? 0), 0,
      );

      // Check Sharpe threshold
      if (avgSharpe != null && avgSharpe < minSharpe) continue;

      // Check drawdown threshold
      if (maxDD > maxDrawdown) continue;

      compositeQualified.push(candidate);
    }

    if (compositeQualified.length === 0) {
      const details = this._buildCompositeDisqualificationDetails(
        qualifying, config, trialEvidence,
      );
      return this._noWinnerResult(config, details);
    }

    // Apply tie-breakers
    const sorted = this._tieBreakSort(compositeQualified, trialEvidence);
    const winner = sorted[0];
    const comparisons = this._buildComparisons(
      allCandidates, winner.trialId, config, trialEvidence,
    );

    const rationale = this._formatRationale(
      'composite', winner, sorted.slice(1), config, trialEvidence,
    );

    return {
      result: WalkForwardSelectionResult.Selected,
      selectedTrialId: winner.trialId,
      selectionStrategy: config.strategy,
      selectionConfigJson: JSON.stringify(config),
      rationale,
      comparisons,
    };
  }

  // -----------------------------------------------------------------------
  // Tie-breaking
  // -----------------------------------------------------------------------

  /**
   * Sort candidates by deterministic tie-breaking rules.
   *
   * Primary: merged score descending (already sorted from ranking).
   * Tie-breaker 1: lower maximum drawdown (prefer less risky).
   * Tie-breaker 2: higher average out-of-sample win rate.
   * Tie-breaker 3: lower trial index (prefer earlier configuration).
   */
  private _tieBreakSort(
    candidates: WalkForwardRankedCandidate[],
    trialEvidence?: Map<number, WalkForwardTrialWindowRow[]>,
  ): WalkForwardRankedCandidate[] {
    return [...candidates].sort((a, b) => {
      // Primary: merged score descending
      if (b.mergedScore !== a.mergedScore) return b.mergedScore - a.mergedScore;

      // Tie-breaker 1: lower max drawdown
      if (trialEvidence) {
        const aDD = this._maxOutOfSampleDrawdown(a.trialId, trialEvidence);
        const bDD = this._maxOutOfSampleDrawdown(b.trialId, trialEvidence);
        if (aDD !== bDD) return aDD - bDD;
      }

      // Tie-breaker 2: higher win rate
      if (trialEvidence) {
        const aWR = this._avgOutOfSampleWinRate(a.trialId, trialEvidence);
        const bWR = this._avgOutOfSampleWinRate(b.trialId, trialEvidence);
        if (aWR != null && bWR != null && aWR !== bWR) return bWR - aWR;
        if (aWR != null && bWR == null) return -1;
        if (aWR == null && bWR != null) return 1;
      }

      // Tie-breaker 3: earlier trial index (lower trialId)
      return a.trialId - b.trialId;
    });
  }

  // -----------------------------------------------------------------------
  // Evidence helpers
  // -----------------------------------------------------------------------

  /**
   * Compute the maximum out-of-sample drawdown for a trial.
   */
  private _maxOutOfSampleDrawdown(
    trialId: number,
    evidence: Map<number, WalkForwardTrialWindowRow[]>,
  ): number {
    const rows = evidence.get(trialId);
    if (!rows || rows.length === 0) return 0;

    return rows
      .filter(e => e.windowType === WalkForwardWindowType.OutOfSample)
      .reduce((max, e) => Math.max(max, e.maxDrawdown ?? 0), 0);
  }

  /**
   * Compute the average out-of-sample win rate for a trial.
   */
  private _avgOutOfSampleWinRate(
    trialId: number,
    evidence: Map<number, WalkForwardTrialWindowRow[]>,
  ): number | null {
    const rows = evidence.get(trialId);
    if (!rows || rows.length === 0) return null;

    const oosRates = rows
      .filter(e => e.windowType === WalkForwardWindowType.OutOfSample)
      .map(e => e.winRate)
      .filter((r): r is number => r != null);

    if (oosRates.length === 0) return null;
    return oosRates.reduce((a, b) => a + b, 0) / oosRates.length;
  }

  /**
   * Compute the average out-of-sample Sharpe ratio for a trial.
   */
  private _avgOutOfSampleSharpe(
    trialId: number,
    evidence: Map<number, WalkForwardTrialWindowRow[]>,
  ): number | null {
    const rows = evidence.get(trialId);
    if (!rows || rows.length === 0) return null;

    const oosSharpe = rows
      .filter(e => e.windowType === WalkForwardWindowType.OutOfSample)
      .map(e => e.sharpeRatio)
      .filter((r): r is number => r != null);

    if (oosSharpe.length === 0) return null;
    return oosSharpe.reduce((a, b) => a + b, 0) / oosSharpe.length;
  }

  // -----------------------------------------------------------------------
  // Comparison builder
  // -----------------------------------------------------------------------

  /**
   * Build comparison entries for top candidates.
   *
   * Produces up to MAX_COMPARISON_CANDIDATES entries with outcome labels.
   */
  private _buildComparisons(
    allCandidates: WalkForwardRankedCandidate[],
    winnerTrialId: number,
    config: WalkForwardSelectionConfig,
    trialEvidence?: Map<number, WalkForwardTrialWindowRow[]>,
  ): WalkForwardCandidateComparison[] {
    const minWindowCount = config.minWindowCount ?? DEFAULT_MIN_WINDOW_COUNT;
    const minMergedScore = config.minMergedScore ?? DEFAULT_MIN_MERGED_SCORE;

    return allCandidates.slice(0, MAX_COMPARISON_CANDIDATES).map(c => {
      const isWinner = c.trialId === winnerTrialId;
      const reasons: string[] = [];

      // Check window count
      if (c.windowCount < minWindowCount) {
        reasons.push(
          `Insufficient window evidence: ${c.windowCount} < ${minWindowCount} required`,
        );
      }

      // Check merged score (for non-top_ranked strategies)
      if (config.strategy !== WalkForwardSelectionStrategy.TopRanked) {
        if (c.mergedScore < minMergedScore) {
          reasons.push(
            `Merged score ${c.mergedScore.toFixed(4)} below threshold ${minMergedScore}`,
          );
        }
      }

      // Check composite criteria
      if (config.strategy === WalkForwardSelectionStrategy.Composite && trialEvidence) {
        const evidence = trialEvidence.get(c.trialId);
        if (!evidence || evidence.length === 0) {
          reasons.push('No per-window evidence available for composite evaluation');
        } else {
          const oosWindows = evidence.filter(
            e => e.windowType === WalkForwardWindowType.OutOfSample,
          );

          if (oosWindows.length === 0) {
            reasons.push('No out-of-sample windows evaluated');
          } else {
            const avgSharpe = this._averageNullable(oosWindows.map(e => e.sharpeRatio));
            const maxDD = oosWindows.reduce(
              (max, e) => Math.max(max, e.maxDrawdown ?? 0), 0,
            );
            const minSharpe = config.minSharpeRatio ?? DEFAULT_MIN_SHARPE_RATIO;
            const maxDrawdown = config.maxDrawdown ?? DEFAULT_MAX_DRAWDOWN;

            if (avgSharpe != null && avgSharpe < minSharpe) {
              reasons.push(
                `Avg OOS Sharpe ${avgSharpe.toFixed(2)} below threshold ${minSharpe}`,
              );
            }
            if (maxDD > maxDrawdown) {
              reasons.push(
                `Max OOS drawdown ${maxDD.toFixed(2)}% exceeds limit ${maxDrawdown}%`,
              );
            }
          }
        }
      }

      if (isWinner && reasons.length === 0) {
        reasons.push('Top-ranked qualifying candidate by selection criteria');
      }

      const outcome: 'winner' | 'runner_up' | 'disqualified' = isWinner
        ? 'winner'
        : reasons.length > 0
          ? 'disqualified'
          : 'runner_up';

      // Build evidence scores
      let evidenceScores: WalkForwardCandidateComparison['evidenceScores'] | undefined;
      if (trialEvidence) {
        const evidence = trialEvidence.get(c.trialId);
        if (evidence) {
          const oosWindows = evidence.filter(
            e => e.windowType === WalkForwardWindowType.OutOfSample,
          );
          evidenceScores = {
            avgSharpe: this._avgOutOfSampleSharpe(c.trialId, trialEvidence),
            maxDrawdown: this._maxOutOfSampleDrawdown(c.trialId, trialEvidence),
            avgWinRate: this._avgOutOfSampleWinRate(c.trialId, trialEvidence),
            outOfSampleWindowCount: oosWindows.length,
          };
        }
      }

      return {
        trialId: c.trialId,
        rank: c.rank,
        label: c.label,
        mergedScore: c.mergedScore,
        outcome,
        reasons,
        ...(evidenceScores ? { evidenceScores } : {}),
      };
    });
  }

  // -----------------------------------------------------------------------
  // Rationale formatter
  // -----------------------------------------------------------------------

  /**
   * Build a human-readable rationale string.
   */
  private _formatRationale(
    mode: 'top_ranked' | 'threshold' | 'composite',
    winner: WalkForwardRankedCandidate,
    runnersUp: WalkForwardRankedCandidate[],
    config: WalkForwardSelectionConfig,
    trialEvidence?: Map<number, WalkForwardTrialWindowRow[]>,
  ): string {
    const parts: string[] = [];
    const label = winner.label;
    const score = winner.mergedScore.toFixed(4);
    const windowCount = winner.windowCount;

    const modeLabel = mode === 'top_ranked'
      ? 'top-ranked'
      : mode === 'threshold'
        ? 'threshold'
        : 'composite';

    parts.push(
      `Selected ${label} (rank ${winner.rank}) via ${modeLabel} selection ` +
      `with merged score ${score} across ${windowCount} windows.`,
    );

    // Add evidence detail when available
    if (trialEvidence) {
      const evidence = trialEvidence.get(winner.trialId);
      if (evidence) {
        const oosWindows = evidence.filter(
          e => e.windowType === WalkForwardWindowType.OutOfSample,
        );
        if (oosWindows.length > 0) {
          const avgSharpe = this._averageNullable(oosWindows.map(e => e.sharpeRatio));
          const maxDD = oosWindows.reduce(
            (max, e) => Math.max(max, e.maxDrawdown ?? 0), 0,
          );
          const avgWR = this._averageNullable(oosWindows.map(e => e.winRate));

          const evidenceParts: string[] = [];
          if (avgSharpe != null) evidenceParts.push(`avg OOS Sharpe=${avgSharpe.toFixed(2)}`);
          if (maxDD > 0) evidenceParts.push(`max OOS drawdown=${maxDD.toFixed(2)}%`);
          if (avgWR != null) evidenceParts.push(`avg OOS win rate=${(avgWR * 100).toFixed(0)}%`);
          evidenceParts.push(`OOS windows=${oosWindows.length}`);

          if (evidenceParts.length > 0) {
            parts.push(`Out-of-sample evidence: ${evidenceParts.join(', ')}.`);
          }
        }
      }
    }

    // Compare against runner-ups
    if (runnersUp.length > 0) {
      const runnerUpDescriptions = runnersUp.slice(0, 3).map(ru => {
        const ruScore = ru.mergedScore.toFixed(4);
        return `${ru.label} (score=${ruScore}, rank=${ru.rank})`;
      });
      parts.push(
        `Runner-ups: ${runnerUpDescriptions.join('; ')}.`,
      );
    }

    // Note the config thresholds applied
    if (mode !== 'top_ranked') {
      const thresholdParts: string[] = [];
      thresholdParts.push(`minMergedScore=${config.minMergedScore ?? DEFAULT_MIN_MERGED_SCORE}`);
      thresholdParts.push(`minWindowCount=${config.minWindowCount ?? DEFAULT_MIN_WINDOW_COUNT}`);
      if (mode === 'composite') {
        thresholdParts.push(
          `minSharpeRatio=${config.minSharpeRatio ?? DEFAULT_MIN_SHARPE_RATIO}`,
        );
        thresholdParts.push(
          `maxDrawdown=${config.maxDrawdown ?? DEFAULT_MAX_DRAWDOWN}%`,
        );
      }
      parts.push(`Selection thresholds: ${thresholdParts.join(', ')}.`);
    }

    return parts.join(' ');
  }

  // -----------------------------------------------------------------------
  // No-winner result builders
  // -----------------------------------------------------------------------

  /**
   * Build a no-winner (HOLD) result.
   */
  private _noWinnerResult(
    config: WalkForwardSelectionConfig,
    detail: string,
  ): WalkForwardSelectionOutput {
    return {
      result: WalkForwardSelectionResult.NoWinner,
      selectedTrialId: null,
      selectionStrategy: config.strategy,
      selectionConfigJson: JSON.stringify(config),
      rationale: detail,
      comparisons: [],
    };
  }

  /**
   * Build a detailed disqualification explanation for threshold/top_ranked failures.
   */
  private _buildDisqualificationDetails(
    candidates: WalkForwardRankedCandidate[],
    minWindowCount: number,
    minMergedScore: number,
    strategy: WalkForwardSelectionStrategy,
  ): string {
    const parts: string[] = ['No qualifying candidates found.'];
    parts.push(
      `Requirements: minWindowCount=${minWindowCount}` +
      (strategy !== WalkForwardSelectionStrategy.TopRanked
        ? `, minMergedScore=${minMergedScore}`
        : ''),
    );

    // Show top candidates and why they failed
    const details = candidates.slice(0, 5).map(c => {
      const failures: string[] = [];
      if (c.windowCount < minWindowCount) {
        failures.push(`windows=${c.windowCount} < ${minWindowCount}`);
      }
      if (strategy !== WalkForwardSelectionStrategy.TopRanked && c.mergedScore < minMergedScore) {
        failures.push(`score=${c.mergedScore.toFixed(4)} < ${minMergedScore}`);
      }
      return `${c.label} (rank ${c.rank}): ${failures.join(', ') || 'disqualified'}`;
    });

    parts.push(`Candidates evaluated: ${details.join('; ')}.`);
    return parts.join(' ');
  }

  /**
   * Build a detailed disqualification explanation for composite failures.
   */
  private _buildCompositeDisqualificationDetails(
    qualifying: WalkForwardRankedCandidate[],
    config: WalkForwardSelectionConfig,
    trialEvidence?: Map<number, WalkForwardTrialWindowRow[]>,
  ): string {
    const minSharpe = config.minSharpeRatio ?? DEFAULT_MIN_SHARPE_RATIO;
    const maxDrawdown = config.maxDrawdown ?? DEFAULT_MAX_DRAWDOWN;
    const minMergedScore = config.minMergedScore ?? DEFAULT_MIN_MERGED_SCORE;

    const parts: string[] = ['No candidates passed all composite criteria.'];
    parts.push(
      `Requirements: minMergedScore=${minMergedScore}, ` +
      `minSharpeRatio=${minSharpe}, maxDrawdown=${maxDrawdown}%.`,
    );

    const details = qualifying.slice(0, 5).map(c => {
      const failures: string[] = [];

      if (trialEvidence) {
        const evidence = trialEvidence.get(c.trialId);
        if (evidence) {
          const oosWindows = evidence.filter(
            e => e.windowType === WalkForwardWindowType.OutOfSample,
          );
          if (oosWindows.length === 0) {
            failures.push('no out-of-sample windows');
          } else {
            const avgSharpe = this._averageNullable(oosWindows.map(e => e.sharpeRatio));
            const maxDD = oosWindows.reduce(
              (max, e) => Math.max(max, e.maxDrawdown ?? 0), 0,
            );
            if (avgSharpe != null && avgSharpe < minSharpe) {
              failures.push(`avgSharpe=${avgSharpe.toFixed(2)} < ${minSharpe}`);
            }
            if (maxDD > maxDrawdown) {
              failures.push(`maxDrawdown=${maxDD.toFixed(2)}% > ${maxDrawdown}%`);
            }
          }
        } else {
          failures.push('no evidence rows');
        }
      } else {
        failures.push('no evidence provided');
      }

      return `${c.label} (score=${c.mergedScore.toFixed(4)}): ${failures.join(', ')}`;
    });

    parts.push(`Candidates evaluated: ${details.join('; ')}.`);
    return parts.join(' ');
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  /**
   * Average an array of nullable numbers, ignoring nulls.
   * Returns null when no non-null values exist.
   */
  private _averageNullable(values: (number | null)[]): number | null {
    const filtered = values.filter((v): v is number => v != null);
    if (filtered.length === 0) return null;
    return filtered.reduce((a, b) => a + b, 0) / filtered.length;
  }
}
