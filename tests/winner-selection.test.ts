// ── WinnerSelector unit tests ──
//
// Covers:
//   - top_ranked selection: picks rank-1 candidate
//   - threshold selection: enforces minMergedScore
//   - composite selection: multi-criteria (Sharpe, drawdown)
//   - HOLD (no_winner) when no candidate qualifies
//   - Tie-breakers: lower drawdown, higher win rate, earlier trial index
//   - Empty candidates list
//   - Minimum window count enforcement
//   - Rationale quality and comparison output

import { describe, it, expect } from 'vitest';
import { WinnerSelector } from '../src/replay/winner-selection.js';
import {
  WalkForwardSelectionStrategy,
  WalkForwardWindowType,
  type WalkForwardSelectionConfig,
  type WalkForwardRankedCandidate,
  type WalkForwardTrialWindowRow,
} from '../src/replay/walk-forward-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSelector(): WinnerSelector {
  return new WinnerSelector();
}

const NOW = 1736025600000; // 2025-01-05T00:00:00.000Z

function sampleCandidate(
  id: number,
  rank: number,
  score: number,
  overrides?: Partial<WalkForwardRankedCandidate>,
): WalkForwardRankedCandidate {
  return {
    trialId: id,
    rank,
    label: `Config ${String.fromCharCode(64 + id)}`,
    paramsJson: JSON.stringify({ momentum: 0.5, volatility: 0.3 }),
    mergedScore: score,
    deterministicScore: score * 0.9,
    llmScore: null,
    windowCount: 3,
    ...overrides,
  };
}

function sampleEvidence(
  trialId: number,
  windowIndex: number,
  overrides?: Partial<WalkForwardTrialWindowRow>,
): WalkForwardTrialWindowRow {
  return {
    id: windowIndex,
    trialId,
    windowId: windowIndex,
    windowType: WalkForwardWindowType.OutOfSample,
    totalReturn: 12.5,
    sharpeRatio: 1.8,
    maxDrawdown: 8.2,
    winRate: 0.65,
    tradeCount: 42,
    profitFactor: 2.1,
    metricsJson: null,
    createdAt: NOW,
    ...overrides,
  };
}

function evidenceMap(
  entries: Array<{
    trialId: number;
    windows: Array<Partial<WalkForwardTrialWindowRow> & { windowIndex: number }>;
  }>,
): Map<number, WalkForwardTrialWindowRow[]> {
  const map = new Map<number, WalkForwardTrialWindowRow[]>();
  for (const entry of entries) {
    const rows = entry.windows.map(w =>
      sampleEvidence(entry.trialId, w.windowIndex, w),
    );
    map.set(entry.trialId, rows);
  }
  return map;
}

// ---------------------------------------------------------------------------
// WinnerSelector
// ---------------------------------------------------------------------------

describe('WinnerSelector', () => {
  describe('top_ranked selection', () => {
    it('selects the rank-1 candidate', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.95),
        sampleCandidate(2, 2, 0.72),
        sampleCandidate(3, 3, 0.55),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.TopRanked,
      };

      const result = selector.selectWinner(candidates, config);

      expect(result.result).toBe('selected');
      expect(result.selectedTrialId).toBe(1);
      expect(result.rationale).toContain('Config A');
      expect(result.rationale).toContain('top-ranked');
    });

    it('includes comparisons with runner-ups', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.95),
        sampleCandidate(2, 2, 0.72),
        sampleCandidate(3, 3, 0.55),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.TopRanked,
      };

      const result = selector.selectWinner(candidates, config);

      expect(result.comparisons.length).toBe(3);
      expect(result.comparisons[0].outcome).toBe('winner');
      expect(result.comparisons[0].trialId).toBe(1);
      expect(result.comparisons[1].outcome).toBe('runner_up');
      expect(result.comparisons[2].outcome).toBe('runner_up');
    });

    it('returns HOLD when no candidates exist', () => {
      const selector = createSelector();
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.TopRanked,
      };

      const result = selector.selectWinner([], config);

      expect(result.result).toBe('no_winner');
      expect(result.selectedTrialId).toBeNull();
      expect(result.rationale).toContain('No candidates');
    });

    it('enforces minimum window count', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.95, { windowCount: 0 }),
        sampleCandidate(2, 2, 0.72, { windowCount: 2 }),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.TopRanked,
        minWindowCount: 1,
      };

      const result = selector.selectWinner(candidates, config);

      // Rank-1 has windowCount=0 which is below minWindowCount=1, so falls through to rank-2
      expect(result.result).toBe('selected');
      expect(result.selectedTrialId).toBe(2);
    });

    it('returns HOLD when no candidate meets minWindowCount', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.95, { windowCount: 0 }),
        sampleCandidate(2, 2, 0.72, { windowCount: 0 }),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.TopRanked,
        minWindowCount: 1,
      };

      const result = selector.selectWinner(candidates, config);

      expect(result.result).toBe('no_winner');
      expect(result.selectedTrialId).toBeNull();
    });
  });

  describe('threshold selection', () => {
    it('selects best qualifying candidate above threshold', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.95),
        sampleCandidate(2, 2, 0.72),
        sampleCandidate(3, 3, 0.55),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Threshold,
        minMergedScore: 0.70,
      };

      const result = selector.selectWinner(candidates, config);

      expect(result.result).toBe('selected');
      expect(result.selectedTrialId).toBe(1);
      expect(result.rationale).toContain('threshold');
    });

    it('disqualifies candidates below threshold', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.95),
        sampleCandidate(2, 2, 0.65),
        sampleCandidate(3, 3, 0.45),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Threshold,
        minMergedScore: 0.80,
      };

      const result = selector.selectWinner(candidates, config);

      expect(result.result).toBe('selected');
      expect(result.selectedTrialId).toBe(1);
      // Runner-ups should be disqualified
      expect(result.comparisons[1].outcome).toBe('disqualified');
      expect(result.comparisons[1].reasons.length).toBeGreaterThan(0);
    });

    it('returns HOLD when no candidate exceeds threshold', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.65),
        sampleCandidate(2, 2, 0.55),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Threshold,
        minMergedScore: 0.80,
      };

      const result = selector.selectWinner(candidates, config);

      expect(result.result).toBe('no_winner');
      expect(result.selectedTrialId).toBeNull();
      expect(result.rationale).toContain('No qualifying candidates');
    });

    it('applies minMergedScore from default when not specified', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.69), // just below default 0.7
        sampleCandidate(2, 2, 0.60),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Threshold,
      };

      const result = selector.selectWinner(candidates, config);

      // Default minMergedScore=0.7 disqualifies 0.69
      expect(result.result).toBe('no_winner');
    });
  });

  describe('composite (multi-criteria) selection', () => {
    it('selects candidate passing all composite criteria', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.92),
        sampleCandidate(2, 2, 0.78),
      ];
      const evidence = evidenceMap([
        {
          trialId: 1,
          windows: [
            { windowIndex: 0, sharpeRatio: 1.5, maxDrawdown: 10.0, winRate: 0.70 },
            { windowIndex: 1, sharpeRatio: 2.0, maxDrawdown: 8.0, winRate: 0.72 },
          ],
        },
        {
          trialId: 2,
          windows: [
            { windowIndex: 0, sharpeRatio: 1.2, maxDrawdown: 15.0, winRate: 0.60 },
          ],
        },
      ]);
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Composite,
        minMergedScore: 0.7,
        minSharpeRatio: 1.0,
        maxDrawdown: 20,
      };

      const result = selector.selectWinner(candidates, config, evidence);

      expect(result.result).toBe('selected');
      expect(result.selectedTrialId).toBe(1);
      expect(result.rationale).toContain('composite');
    });

    it('disqualifies candidate with poor Sharpe', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.92),
        sampleCandidate(2, 2, 0.80),
      ];
      const evidence = evidenceMap([
        {
          trialId: 1,
          windows: [
            { windowIndex: 0, sharpeRatio: 1.8, maxDrawdown: 10.0, winRate: 0.70 },
          ],
        },
        {
          trialId: 2,
          windows: [
            { windowIndex: 0, sharpeRatio: 0.5, maxDrawdown: 15.0, winRate: 0.55 },
          ],
        },
      ]);
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Composite,
        minSharpeRatio: 1.0,
        maxDrawdown: 25,
      };

      const result = selector.selectWinner(candidates, config, evidence);

      // Trial 2 should be disqualified due to low Sharpe
      expect(result.result).toBe('selected');
      expect(result.selectedTrialId).toBe(1);
      const comparison2 = result.comparisons.find(c => c.trialId === 2);
      expect(comparison2).toBeDefined();
      expect(comparison2!.outcome).toBe('disqualified');
      expect(comparison2!.reasons.some(r => r.includes('Sharpe'))).toBe(true);
    });

    it('disqualifies candidate with excessive drawdown', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.92),
        sampleCandidate(2, 2, 0.80),
      ];
      const evidence = evidenceMap([
        {
          trialId: 1,
          windows: [
            { windowIndex: 0, sharpeRatio: 1.8, maxDrawdown: 5.0, winRate: 0.70 },
          ],
        },
        {
          trialId: 2,
          windows: [
            { windowIndex: 0, sharpeRatio: 1.5, maxDrawdown: 30.0, winRate: 0.55 },
          ],
        },
      ]);
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Composite,
        maxDrawdown: 25,
      };

      const result = selector.selectWinner(candidates, config, evidence);

      expect(result.result).toBe('selected');
      expect(result.selectedTrialId).toBe(1);
      const comparison2 = result.comparisons.find(c => c.trialId === 2);
      expect(comparison2).toBeDefined();
      expect(comparison2!.outcome).toBe('disqualified');
      expect(comparison2!.reasons.some(r => r.includes('drawdown'))).toBe(true);
    });

    it('returns HOLD when no candidate passes composite criteria', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.92),
        sampleCandidate(2, 2, 0.80),
      ];
      const evidence = evidenceMap([
        {
          trialId: 1,
          windows: [
            { windowIndex: 0, sharpeRatio: 0.3, maxDrawdown: 50.0, winRate: 0.40 },
          ],
        },
        {
          trialId: 2,
          windows: [
            { windowIndex: 0, sharpeRatio: 0.2, maxDrawdown: 60.0, winRate: 0.35 },
          ],
        },
      ]);
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Composite,
        minSharpeRatio: 1.0,
        maxDrawdown: 20,
      };

      const result = selector.selectWinner(candidates, config, evidence);

      expect(result.result).toBe('no_winner');
      expect(result.selectedTrialId).toBeNull();
      expect(result.rationale).toContain('composite');
    });

    it('returns HOLD when no evidence provided for composite', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.92),
        sampleCandidate(2, 2, 0.80),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Composite,
      };

      const result = selector.selectWinner(candidates, config);

      // Without evidence, composite mode cannot validate criteria → HOLD
      expect(result.result).toBe('no_winner');
      expect(result.selectedTrialId).toBeNull();
    });
  });

  describe('tie-breaking', () => {
    it('prefers lower max drawdown when scores are equal', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.85),
        sampleCandidate(2, 2, 0.85), // same score
      ];
      const evidence = evidenceMap([
        {
          trialId: 1,
          windows: [
            { windowIndex: 0, sharpeRatio: 1.5, maxDrawdown: 15.0, winRate: 0.65 },
          ],
        },
        {
          trialId: 2,
          windows: [
            { windowIndex: 0, sharpeRatio: 1.5, maxDrawdown: 5.0, winRate: 0.65 },
          ],
        },
      ]);
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Threshold,
        minMergedScore: 0.5,
      };

      const result = selector.selectWinner(candidates, config, evidence);

      // Trial 2 has lower drawdown (5% vs 15%), should win
      expect(result.selectedTrialId).toBe(2);
    });

    it('prefers higher win rate when drawdown is equal', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.85),
        sampleCandidate(2, 2, 0.85), // same score and drawdown
      ];
      const evidence = evidenceMap([
        {
          trialId: 1,
          windows: [
            { windowIndex: 0, sharpeRatio: 1.5, maxDrawdown: 10.0, winRate: 0.60 },
          ],
        },
        {
          trialId: 2,
          windows: [
            { windowIndex: 0, sharpeRatio: 1.5, maxDrawdown: 10.0, winRate: 0.75 },
          ],
        },
      ]);
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Threshold,
        minMergedScore: 0.5,
      };

      const result = selector.selectWinner(candidates, config, evidence);

      // Trial 2 has higher win rate (0.75 vs 0.60)
      expect(result.selectedTrialId).toBe(2);
    });

    it('prefers earlier trial index when score and evidence are equal', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(3, 1, 0.85), // higher trialId but same score
        sampleCandidate(1, 2, 0.85), // lower trialId, same score
      ];
      // No evidence provided — tie-breaker should use trialId
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Threshold,
        minMergedScore: 0.5,
      };

      const result = selector.selectWinner(candidates, config);

      // Trial 1 has lower trial ID
      expect(result.selectedTrialId).toBe(1);
    });
  });

  describe('comparison output', () => {
    it('includes evidence scores when trial evidence is provided', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.92),
        sampleCandidate(2, 2, 0.78),
      ];
      const evidence = evidenceMap([
        {
          trialId: 1,
          windows: [
            { windowIndex: 0, sharpeRatio: 2.0, maxDrawdown: 8.0, winRate: 0.70 },
            { windowIndex: 1, sharpeRatio: 1.5, maxDrawdown: 10.0, winRate: 0.68 },
          ],
        },
        {
          trialId: 2,
          windows: [
            { windowIndex: 0, sharpeRatio: 1.2, maxDrawdown: 15.0, winRate: 0.55 },
          ],
        },
      ]);
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Threshold,
        minMergedScore: 0.5,
      };

      const result = selector.selectWinner(candidates, config, evidence);

      expect(result.comparisons.length).toBe(2);
      expect(result.comparisons[0].evidenceScores).toBeDefined();
      expect(result.comparisons[0].evidenceScores!.avgSharpe).toBeCloseTo(1.75, 1);
      expect(result.comparisons[0].evidenceScores!.avgWinRate).toBeCloseTo(0.69, 2);
      expect(result.comparisons[0].evidenceScores!.outOfSampleWindowCount).toBe(2);
      expect(result.comparisons[1].evidenceScores).toBeDefined();
      expect(result.comparisons[1].evidenceScores!.outOfSampleWindowCount).toBe(1);
    });

    it('omits evidence scores when no trial evidence provided', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.92),
        sampleCandidate(2, 2, 0.78),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.TopRanked,
      };

      const result = selector.selectWinner(candidates, config);

      expect(result.comparisons.length).toBe(2);
      expect(result.comparisons[0].evidenceScores).toBeUndefined();
    });

    it('limits comparisons to MAX_COMPARISON_CANDIDATES (5)', () => {
      const selector = createSelector();
      const candidates = Array.from({ length: 10 }, (_, i) =>
        sampleCandidate(i + 1, i + 1, 1.0 - i * 0.08),
      );
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.TopRanked,
      };

      const result = selector.selectWinner(candidates, config);

      expect(result.comparisons.length).toBe(5);
    });
  });

  describe('rationale quality', () => {
    it('includes runner-up details in rationale', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.95),
        sampleCandidate(2, 2, 0.82),
        sampleCandidate(3, 3, 0.70),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.TopRanked,
      };

      const result = selector.selectWinner(candidates, config);

      expect(result.rationale).toContain('Config B');
      expect(result.rationale).toContain('Config C');
    });

    it('includes selection thresholds in rationale for non-top_ranked modes', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.95),
        sampleCandidate(2, 2, 0.80),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Composite,
        minMergedScore: 0.7,
        minSharpeRatio: 1.0,
        maxDrawdown: 20,
      };
      const evidence = evidenceMap([
        {
          trialId: 1,
          windows: [
            { windowIndex: 0, sharpeRatio: 1.5, maxDrawdown: 10.0, winRate: 0.70 },
          ],
        },
        {
          trialId: 2,
          windows: [
            { windowIndex: 0, sharpeRatio: 1.2, maxDrawdown: 15.0, winRate: 0.60 },
          ],
        },
      ]);

      const result = selector.selectWinner(candidates, config, evidence);

      expect(result.rationale).toContain('minMergedScore');
      expect(result.rationale).toContain('minSharpeRatio');
      expect(result.rationale).toContain('maxDrawdown');
    });

    it('includes OOS evidence detail in rationale when available', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.92),
      ];
      const evidence = evidenceMap([
        {
          trialId: 1,
          windows: [
            { windowIndex: 0, sharpeRatio: 2.0, maxDrawdown: 8.0, winRate: 0.75 },
            { windowIndex: 1, sharpeRatio: 1.5, maxDrawdown: 10.0, winRate: 0.70 },
          ],
        },
      ]);
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.TopRanked,
      };

      const result = selector.selectWinner(candidates, config, evidence);

      expect(result.rationale).toContain('OOS Sharpe');
      expect(result.rationale).toContain('OOS drawdown');
      expect(result.rationale).toContain('OOS win rate');
    });
  });

  describe('edge cases', () => {
    it('handles single candidate', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.95),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.TopRanked,
      };

      const result = selector.selectWinner(candidates, config);

      expect(result.result).toBe('selected');
      expect(result.selectedTrialId).toBe(1);
    });

    it('handles all candidates with same score', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(3, 1, 0.80),
        sampleCandidate(1, 2, 0.80),
        sampleCandidate(2, 3, 0.80),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Threshold,
        minMergedScore: 0.7,
      };

      const result = selector.selectWinner(candidates, config);

      // All have same score, tie-breaker by trialId (earliest = trialId 1)
      expect(result.result).toBe('selected');
      expect(result.selectedTrialId).toBe(1);
    });

    it('produces consistent selectionConfigJson', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.95),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Composite,
        minMergedScore: 0.7,
        minSharpeRatio: 1.0,
        maxDrawdown: 20,
      };

      const result = selector.selectWinner(candidates, config);

      const parsed = JSON.parse(result.selectionConfigJson);
      expect(parsed.strategy).toBe('composite');
      expect(parsed.minMergedScore).toBe(0.7);
      expect(parsed.minSharpeRatio).toBe(1.0);
      expect(parsed.maxDrawdown).toBe(20);
    });

    it('handles candidates with zero windows (no evidence)', () => {
      const selector = createSelector();
      const candidates = [
        sampleCandidate(1, 1, 0.95, { windowCount: 0 }),
        sampleCandidate(2, 2, 0.70, { windowCount: 0 }),
      ];
      const config: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Threshold,
        minMergedScore: 0.6,
        minWindowCount: 0,
      };

      const result = selector.selectWinner(candidates, config);

      // With minWindowCount=0, both qualify on score
      expect(result.result).toBe('selected');
      expect(result.selectedTrialId).toBe(1);
    });
  });
});
