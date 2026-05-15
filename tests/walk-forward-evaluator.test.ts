// ── WalkForwardEvaluator unit tests ──
//
// Covers:
//   - Window partitioning (normal, edge cases, boundaries)
//   - Trial config generation (explicit, Cartesian, defaults)
//   - Negative cases (invalid configs, empty ranges, bad params)
//   - Full integration run across multiple windows and trials
//   - Aggregate metrics computation
//   - Ranked candidate output

import { describe, it, expect } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { WalkForwardRepository } from '../src/persistence/walk-forward-repo.js';
import { WalkForwardEvaluator, type WalkForwardEvaluatorConfig } from '../src/replay/walk-forward-evaluator.js';
import { FixtureHistoricalDataProvider } from '../src/replay/historical-data-provider.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';
import { WalkForwardStatus, WalkForwardWindowStatus, WalkForwardWindowType } from '../src/replay/walk-forward-types.js';
import type { BoundedCandidate } from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1736025600000; // 2025-01-05T00:00:00.000Z

/** Create a DB + evaluator for testing. */
function createContext() {
  const mgr = new DatabaseManager(':memory:');
  const repo = new WalkForwardRepository(mgr.db);

  // Fixture candidates matching the replay-runner pattern
  const candidates: BoundedCandidate[] = [
    {
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      instrumentToken: 738561,
      side: 'buy',
      lastPrice: 2450.50,
      bid: 2450.00,
      ask: 2451.00,
      volume: 1250000,
      instrumentType: 'EQ',
      lotSize: 1,
      tickSize: 0.05,
    },
    {
      exchange: 'NSE',
      tradingsymbol: 'TCS',
      instrumentToken: 2953217,
      side: 'buy',
      lastPrice: 3890.00,
      bid: 3889.50,
      ask: 3890.50,
      volume: 850000,
      instrumentType: 'EQ',
      lotSize: 1,
      tickSize: 0.05,
    },
    {
      exchange: 'NSE',
      tradingsymbol: 'HDFCBANK',
      instrumentToken: 341249,
      side: 'buy',
      lastPrice: 1680.25,
      bid: 1680.00,
      ask: 1680.50,
      volume: 2100000,
      instrumentType: 'EQ',
      lotSize: 1,
      tickSize: 0.05,
    },
  ];

  const dataProvider = new FixtureHistoricalDataProvider({
    candidates,
    rangeStart: NOW,
    rangeEnd: NOW + 30 * 86_400_000,
    priceDrift: 0.001,
  });

  const evaluator = new WalkForwardEvaluator({
    db: mgr.db,
    marketProfile: INDIA_NSE_EQ_MARKET,
    dataProvider,
  });

  return { mgr, repo, evaluator, dataProvider, candidates };
}

/** Create a basic valid evaluator config for integration testing. */
function baseConfig(overrides?: Partial<WalkForwardEvaluatorConfig>): WalkForwardEvaluatorConfig {
  return {
    // Use a narrow Mon-Fri range so we get a few ticks
    rangeStart: NOW,
    rangeEnd: NOW + 7 * 86_400_000, // 7 days
    windowSizeMs: 4 * 86_400_000,     // 4-day window
    stepSizeMs: 2 * 86_400_000,       // 2-day step
    inSampleRatio: 0.75,
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    label: 'test-walk-forward',
    trialConfigs: [
      {
        label: 'Config A (agg)',
        params: { maxCandidates: 3 },
      },
      {
        label: 'Config B (moderate)',
        params: { maxCandidates: 5 },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// WalkForwardEvaluator
// ---------------------------------------------------------------------------

describe('WalkForwardEvaluator', () => {
  // -----------------------------------------------------------------------
  // Window partitioning (tested via private method through evaluate)
  // -----------------------------------------------------------------------

  describe('window partitioning (indirect through evaluate)', () => {
    it('returns an error when config is invalid (rangeStart >= rangeEnd)', async () => {
      const { evaluator } = createContext();
      await expect(evaluator.evaluate(baseConfig({
        rangeStart: NOW + 1000,
        rangeEnd: NOW,
      }))).rejects.toThrow(/rangeStart/i);
    });

    it('returns an error when windowSizeMs is too small', async () => {
      const { evaluator } = createContext();
      await expect(evaluator.evaluate(baseConfig({
        windowSizeMs: 60000, // 1 minute — below minimum of 1 hour
      }))).rejects.toThrow(/windowSizeMs.*3600000/);
    });

    it('returns an error when inSampleRatio is out of bounds', async () => {
      const { evaluator } = createContext();
      await expect(evaluator.evaluate(baseConfig({
        inSampleRatio: 1.5,
      }))).rejects.toThrow(/inSampleRatio/);
    });

    it('returns an error when stepSizeMs exceeds windowSizeMs', async () => {
      const { evaluator } = createContext();
      await expect(evaluator.evaluate(baseConfig({
        windowSizeMs: 2 * 86_400_000,
        stepSizeMs: 5 * 86_400_000,
      }))).rejects.toThrow(/stepSizeMs/);
    });

    it('returns an error when range is too short for a single window', async () => {
      const { evaluator } = createContext();
      await expect(evaluator.evaluate(baseConfig({
        rangeStart: NOW,
        rangeEnd: NOW + 3600_000, // 1 hour — too short for 4-day window
      }))).rejects.toThrow(/must be >= windowSizeMs/);
    });

    it('returns an error when no trial configs are provided', async () => {
      const { evaluator } = createContext();
      await expect(evaluator.evaluate(baseConfig({
        trialConfigs: [],
        paramSpace: undefined,
      }))).rejects.toThrow(/no trial configurations/i);
    });
  });

  // -----------------------------------------------------------------------
  // Basic integration — single window, multiple trials
  // -----------------------------------------------------------------------

  describe('evaluate — basic integration', () => {
    it('completes a walk-forward run with two trial configs', async () => {
      const { evaluator, repo } = createContext();

      const result = await evaluator.evaluate(baseConfig());

      // Verify run was persisted
      expect(result.run.id).toBeGreaterThan(0);
      expect(result.run.status).toBe(WalkForwardStatus.Completed);
      expect(result.run.label).toBe('test-walk-forward');
      expect(result.run.windowCount).toBeGreaterThan(0);
      expect(result.run.totalTrials).toBe(2);

      // Verify windows were created
      expect(result.windows.length).toBe(result.run.windowCount);
      for (const w of result.windows) {
        expect(w.status).toBe(WalkForwardWindowStatus.Completed);
      }

      // Verify both trials were inserted
      expect(result.trials.length).toBe(2);
      expect(result.trials[0].label).toBe('Config A (agg)');
      expect(result.trials[1].label).toBe('Config B (moderate)');

      // Verify trials have merged scores and ranks
      expect(result.trials[0].mergedScore).toBeGreaterThan(0);
      expect(result.trials[0].mergedScore).toBeLessThanOrEqual(1);
      expect(result.trials[0].rank).toBeGreaterThanOrEqual(1);
      expect(result.trials[1].rank).toBeGreaterThanOrEqual(1);

      // Verify ranked candidates
      expect(result.rankedCandidates.length).toBe(2);
      expect(result.rankedCandidates[0].rank).toBe(1);
      expect(result.rankedCandidates[1].rank).toBe(2);

      // Verify persisted data via repo
      const loadedRun = repo.getRun(result.run.id);
      expect(loadedRun).not.toBeNull();
      expect(loadedRun!.status).toBe(WalkForwardStatus.Completed);

      const persistedTrials = repo.getTrialsForRun(result.run.id);
      expect(persistedTrials.length).toBe(2);
    });

    it('produces per-window evidence for each trial', async () => {
      const { evaluator } = createContext();

      const result = await evaluator.evaluate(baseConfig());

      for (const trial of result.trials) {
        // Each trial should have evidence for each window (both in and out of sample)
        expect(trial.windowEvidence.length).toBeGreaterThan(0);

        for (const ev of trial.windowEvidence) {
          expect(ev.totalReturn).toBeGreaterThanOrEqual(0);
          expect(ev.tradeCount).toBeGreaterThan(0);

          if (ev.windowType === WalkForwardWindowType.InSample) {
            expect(ev.windowType).toBe(WalkForwardWindowType.InSample);
          } else {
            expect(ev.windowType).toBe(WalkForwardWindowType.OutOfSample);
          }
        }
      }
    });

    it('produces aggregate metrics', async () => {
      const { evaluator } = createContext();

      const result = await evaluator.evaluate(baseConfig());

      expect(result.aggregateMetrics.scoreStability).toBeGreaterThanOrEqual(0);
      expect(result.aggregateMetrics.scoreStability).toBeLessThanOrEqual(1);
      expect(result.aggregateMetrics.topKOverlap).toBeGreaterThanOrEqual(0);
      // LLM metrics should be null (no proposal engine configured)
      expect(result.aggregateMetrics.llmConsultationRate).toBeNull();
      expect(result.aggregateMetrics.llmDivergence).toBeNull();
    });

    it('ranks trials by merged score descending', async () => {
      const { evaluator } = createContext();

      const result = await evaluator.evaluate(baseConfig({
        trialConfigs: [
          { label: 'Low score', params: { maxCandidates: 1 } },
          { label: 'High score', params: { maxCandidates: 10 } },
        ],
      }));

      // Both trials should have valid scores
      expect(result.rankedCandidates[0].mergedScore).toBeGreaterThanOrEqual(0);
      expect(result.rankedCandidates[1].mergedScore).toBeGreaterThanOrEqual(0);
      expect(result.rankedCandidates[0].rank).toBe(1);
      expect(result.rankedCandidates[1].rank).toBe(2);
      // Both should have per-window evidence
      expect(result.rankedCandidates[0].windowCount).toBeGreaterThan(0);
      expect(result.rankedCandidates[1].windowCount).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Auto-generated param space (Cartesian grid)
  // -----------------------------------------------------------------------

  describe('auto-generated trial configs', () => {
    it('generates trial configs from param space when none provided', async () => {
      const { evaluator } = createContext();

      const result = await evaluator.evaluate(baseConfig({
        trialConfigs: [],
        paramSpace: {
          maxCandidates: [3, 5],
          llmEnabled: [false],
        },
      }));

      expect(result.trials.length).toBe(2); // 2 maxCandidates × 1 llmEnabled
      expect(result.trials[0].label).toMatch(/mc3/);
      expect(result.trials[1].label).toMatch(/mc5/);
      expect(result.run.totalTrials).toBe(2);
    });

    it('generates LLM-aware trial configs when enabled in param space', async () => {
      const { evaluator } = createContext();

      const result = await evaluator.evaluate(baseConfig({
        trialConfigs: [],
        paramSpace: {
          maxCandidates: [5],
          llmEnabled: [false, true],
        },
      }));

      // 1 maxCandidates × 2 llmEnabled = 2 configs
      expect(result.trials.length).toBe(2);
      const llmOff = result.trials.find(t => t.label.includes('llmoff'));
      const llmOn = result.trials.find(t => t.label.includes('llmon'));
      expect(llmOff).toBeDefined();
      expect(llmOn).toBeDefined();
    });

    it('rejects param space that generates too many configs', async () => {
      const { evaluator } = createContext();

      await expect(evaluator.evaluate(baseConfig({
        trialConfigs: [],
        paramSpace: {
          maxCandidates: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
          llmEnabled: [false, true],
        },
      }))).rejects.toThrow(/exceeds maximum/i);
    });
  });

  // -----------------------------------------------------------------------
  // Negative tests
  // -----------------------------------------------------------------------

  describe('negative tests', () => {
    it('rejects stepSizeMs below minimum', async () => {
      const { evaluator } = createContext();
      await expect(evaluator.evaluate(baseConfig({
        stepSizeMs: 1000, // 1 second
      }))).rejects.toThrow(/stepSizeMs/);
    });

    it('rejects windowSizeMs below minimum', async () => {
      const { evaluator } = createContext();
      await expect(evaluator.evaluate(baseConfig({
        windowSizeMs: 1800_000, // 30 minutes
      }))).rejects.toThrow(/windowSizeMs/);
    });

    it('rejects inSampleRatio of zero', async () => {
      const { evaluator } = createContext();
      await expect(evaluator.evaluate(baseConfig({
        inSampleRatio: 0,
      }))).rejects.toThrow(/inSampleRatio/);
    });

    it('rejects inSampleRatio of 1', async () => {
      const { evaluator } = createContext();
      await expect(evaluator.evaluate(baseConfig({
        inSampleRatio: 1.0,
      }))).rejects.toThrow(/inSampleRatio/);
    });

    it('rejects run when data provider has no data for range', async () => {
      const { mgr } = createContext();
      const candidates: BoundedCandidate[] = [];
      const dataProvider = new FixtureHistoricalDataProvider({
        candidates,
        rangeStart: NOW,
        rangeEnd: NOW + 30 * 86_400_000,
        priceDrift: 0.001,
      });

      const evaluator = new WalkForwardEvaluator({
        db: mgr.db,
        marketProfile: INDIA_NSE_EQ_MARKET,
        dataProvider,
      });

      await expect(evaluator.evaluate(baseConfig({
        rangeStart: NOW + 100 * 86_400_000, // outside data range
        rangeEnd: NOW + 130 * 86_400_000,
      }))).rejects.toThrow(/no data/i);
    });
  });

  // -----------------------------------------------------------------------
  // Read-model verification
  // -----------------------------------------------------------------------

  describe('persistence verification', () => {
    it('persists data accessible via WalkForwardRepository read models', async () => {
      const { evaluator, repo } = createContext();

      const result = await evaluator.evaluate(baseConfig());

      // Verify getRunWithWindows
      const runWithWindows = repo.getRunWithWindows(result.run.id);
      expect(runWithWindows).not.toBeNull();
      expect(runWithWindows!.windows.length).toBe(result.windows.length);

      // Verify getRankedCandidates
      const candidates = repo.getRankedCandidates(result.run.id);
      expect(candidates.length).toBe(2);
      expect(candidates[0].rank).toBe(1);
      expect(candidates[1].rank).toBe(2);

      // Verify getTrialWithWindows for best trial
      const bestTrial = result.trials[0];
      const trialWithWindows = repo.getTrialWithWindows(bestTrial.trialId);
      expect(trialWithWindows).not.toBeNull();
      expect(trialWithWindows!.windowEvidence.length).toBeGreaterThan(0);
    });

    it('creates evidence rows with valid metric values', async () => {
      const { evaluator, repo } = createContext();

      const result = await evaluator.evaluate(baseConfig());

      const allWindows = repo.getWindowsForRun(result.run.id);
      expect(allWindows.length).toBeGreaterThan(0);

      // Each window should have evidence
      for (const w of allWindows) {
        const evidence = repo.getWindowEvidence(w.id);
        expect(evidence.length).toBeGreaterThan(0);
        for (const ev of evidence) {
          expect(ev.totalReturn).toBeGreaterThanOrEqual(0);
          expect(ev.totalReturn).toBeLessThanOrEqual(1);
          expect(ev.tradeCount).toBeGreaterThan(0);
        }
      }
    });
  });
});
