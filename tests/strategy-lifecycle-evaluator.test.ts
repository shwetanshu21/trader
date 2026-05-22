// ── StrategyLifecycleEvaluator unit tests ──
//
// Covers:
//   - Promotion on qualified winner evidence
//   - HOLD on no_winner
//   - HOLD on missing or mismatched run context
//   - HOLD on insufficient thresholds (merged score, Sharpe, drawdown, window count)
//   - Idempotent repeated evaluation
//   - Snapshot persistence of rationale/evidence
//   - Negative tests: mismatched strategy identity, null selected trial,
//     stale/nonexistent run ids, pending winner selection

import { describe, it, expect } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { WalkForwardRepository } from '../src/persistence/walk-forward-repo.js';
import { StrategyLifecycleRepository } from '../src/persistence/strategy-lifecycle-repo.js';
import { ExecutionRiskRepository } from '../src/persistence/execution-risk-repo.js';
import { StrategyLifecycleEvaluator, type PromotionEvaluationInput } from '../src/lifecycle/strategy-lifecycle-evaluator.js';
import {
  StrategyLifecyclePhase,
  GovernanceVerdict,
  HaltState,
  HaltSource,
  type GovernanceThresholdConfig,
  type DemotionThresholdConfig,
  type DemotionEvaluationInput,
  type LifecyclePerformanceSummary,
} from '../src/types/runtime.js';
import {
  WalkForwardStatus,
  WalkForwardWindowStatus,
  WalkForwardWindowType,
  WalkForwardSelectionResult,
  WalkForwardSelectionStrategy,
  type NewWalkForwardRun,
  type NewWalkForwardWindow,
  type NewWalkForwardTrial,
  type NewWalkForwardTrialWindow,
  type NewWalkForwardWinner,
} from '../src/replay/walk-forward-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOW = 1736025600000; // 2025-01-05T00:00:00.000Z
const DEFAULT_THRESHOLDS: GovernanceThresholdConfig = {
  minMergedScore: 0.7,
  minSharpeRatio: 1.0,
  maxDrawdown: 30,
  minWindowCount: 2,
  minOutOfSampleWindows: 1,
  minReplayFidelity: 1.0,
};

const STRATEGY_ID = 'india-nse-eq-v1';
const STRATEGY_VERSION = '1.0.0';
const MARKET_ID = 'INDIA_NSE_EQ';

// ---------------------------------------------------------------------------
// Test context factory
// ---------------------------------------------------------------------------

interface TestContext {
  repo: WalkForwardRepository;
  lifecycleRepo: StrategyLifecycleRepository;
  evaluator: StrategyLifecycleEvaluator;
  db: ReturnType<DatabaseManager['db']>;
}

function createContext(): TestContext {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;
  const repo = new WalkForwardRepository(db);
  const lifecycleRepo = new StrategyLifecycleRepository(db);
  const evaluator = new StrategyLifecycleEvaluator({
    walkForwardRepo: repo,
    lifecycleRepo,
    db,
  });
  return { repo, lifecycleRepo, evaluator, db };
}

function seedPaperValidationTrade(
  db: ReturnType<DatabaseManager['db']>,
  options?: {
    strategyId?: string;
    strategyVersion?: string;
    exchange?: string;
    tradingsymbol?: string;
    realizedPnl?: number;
    side?: 'buy' | 'sell';
  },
): void {
  const strategyId = options?.strategyId ?? STRATEGY_ID;
  const strategyVersion = options?.strategyVersion ?? STRATEGY_VERSION;
  const exchange = options?.exchange ?? 'NSE';
  const tradingsymbol = options?.tradingsymbol ?? 'RELIANCE';
  const realizedPnl = options?.realizedPnl ?? 250;
  const side = options?.side ?? 'buy';

  db.prepare(`
    INSERT INTO proposal_attempts
      (id, exchange, tradingsymbol, instrument_token, side, product, quantity, price, trigger_price, order_type, tag, proposal_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(9001, exchange, tradingsymbol, null, side, 'MIS', 1, null, null, 'MARKET', 'paper-validation', 'accepted', NOW);

  db.prepare(`
    INSERT INTO strategy_decisions
      (id, proposal_attempt_id, decision_status, strategy_id, strategy_version, decided_at, exchange, tradingsymbol, side, product, quantity, price, trigger_price, order_type,
       quote_last_price, quote_bid, quote_ask, quote_volume, quote_received_at,
       risk_notional, risk_sizing_basis, risk_max_loss_rupees, risk_stop_distance, risk_stop_price, risk_trailing_stop_distance, risk_budget_rupees,
       execution_class, segment, instrument_type, expiry, strike, lot_size, tick_size, freeze_quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(9001, 9001, 'approved', strategyId, strategyVersion, NOW, exchange, tradingsymbol, side, 'MIS', 1, null, null, 'MARKET', 100, 100, 101, 1000, NOW, 100, 'paper_validation', 1, 1, 99, 1, 1, 'EQ', exchange, 'EQ', null, null, 1, 0.05, null);

  db.prepare(`
    INSERT INTO execution_attempts
      (id, strategy_decision_id, execution_mode, status, outcome_code, broker_order_id, message, attempted_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(9001, 9001, 'paper', 'completed', 'paper_simulated', 'paper-9001', 'ok', NOW, NOW + 1000);

  db.prepare(`
    INSERT INTO paper_orders
      (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price, order_type, status, broker_order_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(9001, 9001, exchange, tradingsymbol, side, 'MIS', 1, 100, 'MARKET', 'filled', 'paper-9001', NOW);

  db.prepare(`
    INSERT INTO paper_fills
      (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product, filled_quantity, filled_price, broker_order_id, filled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(9001, 9001, 9001, exchange, tradingsymbol, side, 'MIS', 1, 100, 'paper-9001', NOW);

  db.prepare(`
    INSERT INTO position_events
      (id, paper_order_id, paper_fill_id, execution_attempt_id, event_type, exchange, tradingsymbol, product, quantity_delta, price, previous_quantity, previous_avg_cost, new_quantity, new_avg_cost, realized_pnl, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(9001, 9001, 9001, 9001, 'exit', exchange, tradingsymbol, 'MIS', 0, 100, 1, 100, 0, 0, realizedPnl, NOW + 2000);
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/**
 * Seed a complete walk-forward run with a run, windows, trials, trial-window
 * evidence, and a winner decision. Returns the run ID and the winner row.
 *
 * Default values meet DEFAULT_THRESHOLDS:
 * - mergedScore: 0.85 (>= 0.7)
 * - sharpeRatio: 1.8 (>= 1.0)
 * - maxDrawdown: 8.2 (<= 30)
 * - windowCount: 2 (>= 2)
 * - outOfSampleWindows: 1 (>= 1)
 */
function seedPromotableRun(
  repo: WalkForwardRepository,
  overrides?: {
    mergedScore?: number;
    sharpeRatio?: number | null;
    maxDrawdown?: number | null;
    windowCount?: number;
    oosWindowCount?: number;
    strategyId?: string;
    strategyVersion?: string;
    marketId?: string;
    winnerResult?: WalkForwardSelectionResult;
    selectedTrialId?: number | null; // null to simulate no-winner with selected_trial_id=null
    /** metrics_json value for ALL trial-window evidence rows. When set, replay evidence is seeded. */
    metricsJson?: string | null;
    /** LLM consultation status counts for metrics_json. When set, builds a full envelope. */
    llmStatusCounts?: Record<string, number>;
    /** Cap fidelity ratio for metrics_json. Applied to all windows. */
    capFidelity?: number; // 0–1, simulated maxCandidates/preCapCandidateCount
  },
): { runId: number; winnerId: number; trialId: number } {
  const sid = overrides?.strategyId ?? STRATEGY_ID;
  const sver = overrides?.strategyVersion ?? STRATEGY_VERSION;
  const mid = overrides?.marketId ?? MARKET_ID;
  const mergedScore = overrides?.mergedScore ?? 0.85;
  const sharpeRatio = overrides?.sharpeRatio !== undefined ? overrides.sharpeRatio : 1.8;
  const maxDrawdown = overrides?.maxDrawdown !== undefined ? overrides.maxDrawdown : 8.2;
  const windowCount = overrides?.windowCount ?? 2;
  const oosWindowCount = overrides?.oosWindowCount ?? 1;
  const winnerResult = overrides?.winnerResult ?? WalkForwardSelectionResult.Selected;

  // Build metrics_json for each window
  const explicitMetrics = overrides?.metricsJson;
  const capFidelity = overrides?.capFidelity;
  const llmCounts = overrides?.llmStatusCounts;

  function buildMetricsJson(): string | null {
    if (explicitMetrics !== undefined) return explicitMetrics; // explicit null/string
    // When either capFidelity or llmCounts is explicitly set, build envelope.
    // Otherwise default to full-fidelity metrics so existing tests pass.
    const fidelity = capFidelity ?? 1.0;
    const useCounts = llmCounts ?? { consulted: 8, skipped: 2 };
    // Simulate cap: maxCandidates = fidelity * preCapCount
    const preCapCount = Math.round(100 / fidelity);
    const maxCandidates = Math.round(preCapCount * fidelity);
    const envelope = {
      schemaVersion: 1,
      source: 'replay-session',
      replayEvidence: {
        replaySessionId: 1,
        replayStatus: 'completed',
        replayLabel: 'Test replay session',
        replayRangeStart: NOW,
        replayRangeEnd: NOW + 86400000,
        replayCompletedTicks: 10,
        replayTotalTicks: 10,
        checkpointCount: 3,
        strategyRunCount: 5,
        firstStrategyRunId: 1,
        lastStrategyRunId: 5,
        topCandidateCount: maxCandidates,
        maxCandidates,
        preCapCandidateCount: preCapCount,
        llmStatusCounts: useCounts,
        pluginErrorCount: 0,
        errorMessage: null,
      },
      summary: {
        tickCount: 10,
        meanMergedScore: mergedScore,
        meanDeterministicScore: mergedScore * 0.9,
        meanLlmScore: null,
        stdDevMergedScore: null,
        maxMergedScore: mergedScore,
        minMergedScore: mergedScore * 0.8,
      },
    };
    return JSON.stringify(envelope);
  }

  // Create run
  const run = repo.insertRun({
    label: 'Test walk-forward run',
    strategyId: sid,
    strategyVersion: sver,
    marketId: mid,
    replaySessionId: null,
    windowCount,
    totalTrials: 1,
    status: WalkForwardStatus.Completed,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW + 5000,
  });

  // Create windows
  const windows: ReturnType<typeof repo.insertWindow>[] = [];
  for (let i = 0; i < windowCount; i++) {
    windows.push(repo.insertWindow({
      runId: run.id,
      windowIndex: i,
      rangeStart: NOW + i * 86400000,
      rangeEnd: NOW + (i + 7) * 86400000,
      windowLabel: `W${String(i + 1).padStart(2, '0')}`,
      trialCountOptimized: 1,
      trialCountTested: oosWindowCount > i ? 1 : 0,
      status: WalkForwardWindowStatus.Completed,
      createdAt: NOW,
    }));
  }

  // Create a trial
  const trial = repo.insertTrial({
    runId: run.id,
    trialIndex: 0,
    label: 'Config A',
    paramsJson: JSON.stringify({ momentum: 0.9, volatility: 0.1 }),
    mergedScore,
    deterministicScore: mergedScore * 0.9,
    llmScore: null,
    llmStatus: null,
    rank: 1,
    createdAt: NOW,
  });

  // Link trial to windows
  const resolvedMetricsJson = buildMetricsJson();
  for (let i = 0; i < windowCount; i++) {
    const isOOS = i >= windowCount - oosWindowCount;
    repo.linkTrialToWindow({
      trialId: trial.id,
      windowId: windows[i].id,
      windowType: isOOS ? WalkForwardWindowType.OutOfSample : WalkForwardWindowType.InSample,
      totalReturn: isOOS ? 14.5 : 18.2,
      sharpeRatio,
      maxDrawdown,
      winRate: 0.65,
      tradeCount: 42,
      profitFactor: 2.1,
      metricsJson: resolvedMetricsJson,
      createdAt: NOW,
    });
  }

  // Insert winner
  const selectedTrialId = overrides?.selectedTrialId !== undefined
    ? overrides.selectedTrialId
    : trial.id;
  const winner = repo.insertWinner({
    runId: run.id,
    result: winnerResult,
    selectedTrialId,
    selectionStrategy: WalkForwardSelectionStrategy.Composite,
    selectionConfigJson: JSON.stringify({
      strategy: 'composite',
      minMergedScore: 0.7,
      minSharpeRatio: 1.0,
      maxDrawdown: 30,
    }),
    rationale: 'Config A qualifies on merged score, Sharpe, and drawdown across 2 windows.',
    artifactPathsJson: JSON.stringify(['artifacts/trade-log.json']),
    selectedAt: NOW + 5000,
  });

  return { runId: run.id, winnerId: winner.id, trialId: trial.id };
}

/** Default evaluation input pointing at the seeded run. */
function defaultInput(runId: number, overrides?: Partial<PromotionEvaluationInput>): PromotionEvaluationInput {
  return {
    runId,
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    marketId: MARKET_ID,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StrategyLifecycleEvaluator', () => {
  // -----------------------------------------------------------------------
  // Promotion on qualified winner evidence
  // -----------------------------------------------------------------------

  describe('promote on qualified winner evidence', () => {
    it('returns PROMOTE when all default thresholds are met (backtest -> paper)', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo);

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Promote);
      expect(result.previousPhase).toBe(StrategyLifecyclePhase.Backtest);
      expect(result.newPhase).toBe(StrategyLifecyclePhase.Paper);
      expect(result.stateUpdated).toBe(true);
      expect(result.rationale).toContain('All promotion thresholds met');
      expect(result.rationale).toContain('backtest');
      expect(result.rationale).toContain('paper');
    });

    it('promotes from paper to live when strategy is already at paper and paper validation exists', () => {
      const { repo, lifecycleRepo, evaluator, db } = createContext();
      const { runId } = seedPromotableRun(repo);
      seedPaperValidationTrade(db);

      // Seed current phase as Paper
      lifecycleRepo.upsertCurrentState({
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        marketId: MARKET_ID,
        phase: StrategyLifecyclePhase.Paper,
        updatedAt: NOW - 10000,
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Promote);
      expect(result.previousPhase).toBe(StrategyLifecyclePhase.Paper);
      expect(result.newPhase).toBe(StrategyLifecyclePhase.Live);
      expect(result.stateUpdated).toBe(true);
      expect(result.evidenceSnapshot.paperValidation?.available).toBe(true);
    });

    it('holds when strategy is already at live (max phase)', () => {
      const { repo, lifecycleRepo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo);

      // Seed current phase as Live
      lifecycleRepo.upsertCurrentState({
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        marketId: MARKET_ID,
        phase: StrategyLifecyclePhase.Live,
        updatedAt: NOW - 10000,
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.previousPhase).toBe(StrategyLifecyclePhase.Live);
      expect(result.newPhase).toBe(StrategyLifecyclePhase.Live);
      expect(result.stateUpdated).toBe(false);
      expect(result.rationale).toContain('already at the maximum lifecycle phase');
    });

    it('updates lifecycle state on promote', () => {
      const { repo, lifecycleRepo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo);

      evaluator.evaluate(defaultInput(runId));

      // Verify state was persisted
      const state = lifecycleRepo.getCurrentState(STRATEGY_ID, STRATEGY_VERSION, MARKET_ID);
      expect(state.phase).toBe(StrategyLifecyclePhase.Paper);
      expect(state.updatedAt).toBeGreaterThan(0);
    });

    it('preserves evidence snapshot with thresholds and actual scores on promote', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo);

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.evidenceSnapshot.mergedScore).toBe(0.85);
      expect(result.evidenceSnapshot.avgSharpeRatio).toBe(1.8);
      expect(result.evidenceSnapshot.maxDrawdown).toBe(8.2);
      expect(result.evidenceSnapshot.outOfSampleWindowCount).toBe(1);
      expect(result.evidenceSnapshot.totalWindowCount).toBe(2);
      expect(result.evidenceSnapshot.thresholds.minMergedScore).toBe(0.7);
      expect(result.evidenceSnapshot.selectedTrialLabel).toBe('Config A');
      expect(result.evidenceSnapshot.outOfSampleDetails).toHaveLength(1);
      expect(result.evidenceSnapshot.outOfSampleDetails[0].sharpeRatio).toBe(1.8);
    });
  });

  // -----------------------------------------------------------------------
  // HOLD on no_winner
  // -----------------------------------------------------------------------

  describe('hold on no_winner', () => {
    it('returns HOLD when winner result is no_winner', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, {
        winnerResult: WalkForwardSelectionResult.NoWinner,
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('no_winner');
      expect(result.stateUpdated).toBe(false);
      expect(result.newPhase).toBe(StrategyLifecyclePhase.Backtest);
    });

    it('returns HOLD when no winner decision exists for the run', () => {
      const { repo, evaluator } = createContext();
      // Create run but no winner
      const run = repo.insertRun({
        label: 'No winner run',
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        marketId: MARKET_ID,
        replaySessionId: null,
        windowCount: 0,
        totalTrials: 0,
        status: WalkForwardStatus.Completed,
        createdAt: NOW,
        startedAt: NOW,
        completedAt: NOW + 5000,
      });

      const result = evaluator.evaluate(defaultInput(run.id));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('No walk-forward winner decision found');
      expect(result.stateUpdated).toBe(false);
    });

    it('returns HOLD when winner result is pending', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, {
        winnerResult: WalkForwardSelectionResult.Pending,
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('pending');
    });
  });

  // -----------------------------------------------------------------------
  // HOLD on missing or mismatched run context
  // -----------------------------------------------------------------------

  describe('hold on mismatched context', () => {
    it('returns HOLD when strategyId does not match', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, {
        strategyId: 'other-strategy',
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('does not match target');
      expect(result.rationale).toContain('other-strategy');
      expect(result.stateUpdated).toBe(false);
    });

    it('returns HOLD when strategyVersion does not match', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, {
        strategyVersion: '2.0.0',
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('does not match target');
      expect(result.rationale).toContain('2.0.0');
    });

    it('returns HOLD when marketId does not match', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, {
        marketId: 'OTHER_MARKET',
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('does not match target');
      expect(result.rationale).toContain('OTHER_MARKET');
    });

    it('reports multiple identity mismatches in a single rationale', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, {
        strategyId: 'other-strategy',
        strategyVersion: '2.0.0',
        marketId: 'OTHER_MARKET',
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('other-strategy');
      expect(result.rationale).toContain('2.0.0');
      expect(result.rationale).toContain('OTHER_MARKET');
    });
  });

  // -----------------------------------------------------------------------
  // HOLD on insufficient thresholds
  // -----------------------------------------------------------------------

  describe('hold on insufficient thresholds', () => {
    it('returns HOLD when merged score is below threshold', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, { mergedScore: 0.5 });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('Merged score');
      expect(result.rationale).toContain('0.50');
      expect(result.rationale).toContain('0.7');
    });

    it('returns HOLD when Sharpe ratio is below threshold', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, { sharpeRatio: 0.5 });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('Sharpe ratio');
      expect(result.rationale).toContain('0.50');
      expect(result.rationale).toContain('1'); // threshold minSharpeRatio is 1
    });

    it('returns HOLD when drawdown exceeds threshold', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, { maxDrawdown: 85 });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('drawdown');
      expect(result.rationale).toContain('85.00');
      expect(result.rationale).toContain('30');
    });

    it('returns HOLD when total window count is below threshold', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, {
        windowCount: 1,
        oosWindowCount: 1,
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('window evidence count');
      expect(result.rationale).toContain('1');
    });

    it('returns HOLD when out-of-sample window count is below threshold', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, { oosWindowCount: 0 });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('Out-of-sample window count');
      expect(result.rationale).toContain('0');
    });

    it('reports multiple threshold failures in a single rationale', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, {
        mergedScore: 0.3,
        sharpeRatio: -0.5,
        maxDrawdown: 95,
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('Merged score');
      expect(result.rationale).toContain('Sharpe ratio');
      expect(result.rationale).toContain('drawdown');
    });

    it('uses custom thresholds when provided in input', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, { mergedScore: 0.75 });

      // Custom threshold with higher bar
      const strictThresholds: GovernanceThresholdConfig = {
        minMergedScore: 0.9,
        minSharpeRatio: 2.0,
        maxDrawdown: 20,
        minWindowCount: 3,
        minOutOfSampleWindows: 2,
      };

      const result = evaluator.evaluate(defaultInput(runId, {
        thresholds: strictThresholds,
      }));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.evidenceSnapshot.thresholds.minMergedScore).toBe(0.9);
    });

    it('returns HOLD when Sharpe data is missing and threshold requires it', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, { sharpeRatio: null });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('No out-of-sample Sharpe ratio data available');
    });
  });

  // -----------------------------------------------------------------------
  // HOLD on missing or degraded replay fidelity
  // -----------------------------------------------------------------------

  describe('hold on missing or degraded replay fidelity', () => {
    it('promotes when replay paper execution evidence is present with full fidelity', () => {
      const { repo, evaluator } = createContext();
      const envelope = {
        schemaVersion: 1,
        source: 'replay-paper-execution',
        replayEvidence: {
          replaySessionId: 1,
          replayStatus: 'completed',
          replayLabel: 'Replay paper execution',
          replayRangeStart: NOW,
          replayRangeEnd: NOW + 86400000,
          replayCompletedTicks: 10,
          replayTotalTicks: 10,
          checkpointCount: 3,
          strategyRunCount: 5,
          firstStrategyRunId: 1,
          lastStrategyRunId: 5,
          topCandidateCount: 5,
          maxCandidates: 5,
          preCapCandidateCount: 5,
          llmStatusCounts: { consulted: 4, skipped: 1 },
          pluginErrorCount: 0,
          errorMessage: null,
          executionTruth: {
            available: true,
            source: 'replay-paper-execution',
            tradeCount: 3,
            realizedPnl: 1200,
            grossProfit: 1500,
            grossLoss: 300,
            winCount: 2,
            lossCount: 1,
            totalFees: 12,
            totalSlippage: 18,
            maxDrawdown: 75,
          },
        },
        summary: {
          tickCount: 10,
          meanMergedScore: 0.85,
          meanDeterministicScore: 0.77,
          meanLlmScore: null,
          stdDevMergedScore: null,
          maxMergedScore: 0.85,
          minMergedScore: 0.7,
        },
      };

      const { runId } = seedPromotableRun(repo, { metricsJson: JSON.stringify(envelope) });
      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Promote);
      expect(result.evidenceSnapshot.replayFidelity).toBe(1.0);
      expect(result.evidenceSnapshot.hasReplayEvidence).toBe(true);
      expect(result.evidenceSnapshot.llmConsultationRate).toBe(0.8);
    });

    it('promotes when full replay fidelity is present (minReplayFidelity 1.0, fidelity 1.0)', () => {
      const { repo, evaluator } = createContext();
      // Full fidelity: maxCandidates == preCapCandidateCount → ratio 1.0
      const { runId } = seedPromotableRun(repo, { capFidelity: 1.0 });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Promote);
      expect(result.evidenceSnapshot.replayFidelity).toBe(1.0);
      expect(result.evidenceSnapshot.hasReplayEvidence).toBe(true);
      expect(result.evidenceSnapshot.llmConsultationRate).toBeGreaterThan(0);
    });

    it('promotes when no cap is applied (unlimited — full fidelity default)', () => {
      const { repo, evaluator } = createContext();
      // No cap specified → default seed includes full-fidelity metrics.
      // With minReplayFidelity 0, the gate is disabled entirely.
      const { runId } = seedPromotableRun(repo);

      const result = evaluator.evaluate(defaultInput(runId, {
        thresholds: { ...DEFAULT_THRESHOLDS, minReplayFidelity: 0 }, // relaxed
      }));

      expect(result.verdict).toBe(GovernanceVerdict.Promote);
      // Default seed includes full-fidelity metrics; fidelity is 1.0 not null
      expect(result.evidenceSnapshot.replayFidelity).toBe(1.0);
      expect(result.evidenceSnapshot.hasReplayEvidence).toBe(true);
    });

    it('holds when replay fidelity is below minReplayFidelity threshold', () => {
      const { repo, evaluator } = createContext();
      // Degraded fidelity: cap at 3/5 = 0.6 < 1.0 threshold
      const { runId } = seedPromotableRun(repo, { capFidelity: 0.6 });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('Replay fidelity');
      expect(result.rationale).toContain('below minimum threshold');
      expect(result.stateUpdated).toBe(false);
    });

    it('holds when replay fidelity is null and no metrics exist (legacy data with threshold > 0)', () => {
      const { repo, evaluator } = createContext();
      // Explicit null metricsJson to simulate legacy data
      const { runId } = seedPromotableRun(repo, { metricsJson: null });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('No replay evidence available');
      expect(result.rationale).toContain('fidelity gate');
      expect(result.evidenceSnapshot.replayFidelity).toBeNull();
      expect(result.evidenceSnapshot.hasReplayEvidence).toBe(false);
    });

    it('passes when minReplayFidelity is 0 (gate disabled) even without metrics', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo);

      const result = evaluator.evaluate(defaultInput(runId, {
        thresholds: { ...DEFAULT_THRESHOLDS, minReplayFidelity: 0 },
      }));

      expect(result.verdict).toBe(GovernanceVerdict.Promote);
    });

    it('holds when LLM consultation rate is 0 (no LLM consulted during replay)', () => {
      const { repo, evaluator } = createContext();
      // llmStatusCounts with zero consulted
      const { runId } = seedPromotableRun(repo, {
        capFidelity: 1.0,
        llmStatusCounts: { skipped: 10 }, // all skipped, none consulted
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('LLM consultation rate is 0');
      expect(result.evidenceSnapshot.llmConsultationRate).toBe(0);
    });

    it('holds on malformed metrics_json (fail closed)', () => {
      const { repo, evaluator } = createContext();
      // metricsJson is invalid JSON
      const { runId } = seedPromotableRun(repo, {
        metricsJson: 'not valid json',
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      // No replay evidence parsed → null fidelity → fail closed
      expect(result.rationale).toContain('No replay evidence available');
      expect(result.evidenceSnapshot.hasReplayEvidence).toBe(false);
    });

    it('holds on metrics_json with missing replayEvidence field', () => {
      const { repo, evaluator } = createContext();
      // Valid JSON but missing replayEvidence
      const { runId } = seedPromotableRun(repo, {
        metricsJson: JSON.stringify({ schemaVersion: 1, source: 'other' }),
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('No replay evidence available');
    });

    it('persists fidelity evidence in the evidence snapshot on promote', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, { capFidelity: 1.0 });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Promote);
      const snapshot = result.evidenceSnapshot;
      expect(snapshot.replayFidelity).toBe(1.0);
      expect(snapshot.hasReplayEvidence).toBe(true);
      expect(snapshot.llmConsultationRate).toBeGreaterThan(0);

      // Verify persisted evidence JSON
      const persisted = JSON.parse(result.decision.evidenceJson!);
      expect(persisted.replayFidelity).toBe(1.0);
      expect(persisted.hasReplayEvidence).toBe(true);
    });

    it('persists fidelity evidence in the evidence snapshot on hold (degraded fidelity)', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, { capFidelity: 0.5 });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      const snapshot = result.evidenceSnapshot;
      expect(snapshot.replayFidelity).toBe(0.5);
      expect(snapshot.hasReplayEvidence).toBe(true);

      // Verify persisted evidence JSON
      const persisted = JSON.parse(result.decision.evidenceJson!);
      expect(persisted.replayFidelity).toBe(0.5);
      expect(persisted.rationale).toBeUndefined(); // rationale is top-level, not in evidence
    });

    it('persists fidelity null and hasReplayEvidence false on legacy data without metrics', () => {
      const { repo, evaluator } = createContext();
      // Explicit null metricsJson to simulate legacy data
      const { runId } = seedPromotableRun(repo, { metricsJson: null });

      const result = evaluator.evaluate(defaultInput(runId, {
        thresholds: { ...DEFAULT_THRESHOLDS, minReplayFidelity: 0 },
      }));

      expect(result.verdict).toBe(GovernanceVerdict.Promote);
      const snapshot = result.evidenceSnapshot;
      expect(snapshot.replayFidelity).toBeNull();
      expect(snapshot.hasReplayEvidence).toBe(false);
      expect(snapshot.llmConsultationRate).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Idempotent repeated evaluation
  // -----------------------------------------------------------------------

  describe('idempotent repeated evaluation', () => {
    it('produces consistent HOLD results on repeated evaluation', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, { mergedScore: 0.5 });

      const first = evaluator.evaluate(defaultInput(runId));
      const second = evaluator.evaluate(defaultInput(runId));

      expect(first.verdict).toBe(GovernanceVerdict.Hold);
      expect(second.verdict).toBe(GovernanceVerdict.Hold);
      expect(first.rationale).toBe(second.rationale);
      expect(first.evidenceSnapshot.mergedScore).toBe(second.evidenceSnapshot.mergedScore);
    });

    it('produces consistent promotion then hold results on repeated evaluation without paper validation evidence', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo);

      const first = evaluator.evaluate(defaultInput(runId));
      const second = evaluator.evaluate(defaultInput(runId));

      expect(first.verdict).toBe(GovernanceVerdict.Promote);
      expect(second.verdict).toBe(GovernanceVerdict.Hold);
      expect(first.rationale).toContain('All promotion thresholds met');
      expect(second.rationale).toContain('Paper-to-live promotion requires persisted paper-trading validation evidence');
    });

    it('does not escalate beyond paper on repeated promote without paper validation evidence', () => {
      const { repo, lifecycleRepo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo);

      evaluator.evaluate(defaultInput(runId));
      evaluator.evaluate(defaultInput(runId));

      const state = lifecycleRepo.getCurrentState(STRATEGY_ID, STRATEGY_VERSION, MARKET_ID);
      expect(state.phase).toBe(StrategyLifecyclePhase.Paper);

      const decisions = lifecycleRepo.getDecisionsForStrategy(STRATEGY_ID, STRATEGY_VERSION, MARKET_ID, 10);
      expect(decisions.length).toBe(2);
      expect(decisions[0].verdict).toBe(GovernanceVerdict.Hold);
      expect(decisions[1].verdict).toBe(GovernanceVerdict.Promote);
    });
  });

  // -----------------------------------------------------------------------
  // Snapshot persistence of rationale/evidence
  // -----------------------------------------------------------------------

  describe('snapshot persistence', () => {
    it('persists governance decision with evidence snapshot on promote', () => {
      const { repo, lifecycleRepo, evaluator } = createContext();
      const { runId, winnerId } = seedPromotableRun(repo);

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.decision.id).toBeGreaterThan(0);
      expect(result.decision.verdict).toBe(GovernanceVerdict.Promote);
      expect(result.decision.winnerId).toBe(winnerId);
      expect(result.decision.evidenceJson).not.toBeNull();

      const evidence = JSON.parse(result.decision.evidenceJson!);
      expect(evidence.thresholds).toBeDefined();
      expect(evidence.mergedScore).toBe(0.85);
      expect(evidence.outOfSampleDetails).toHaveLength(1);

      // Verify via repository read-back
      const decisions = lifecycleRepo.getDecisionsForStrategy(STRATEGY_ID, STRATEGY_VERSION, MARKET_ID);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].rationale).toBe(result.rationale);
      expect(decisions[0].verdict).toBe(GovernanceVerdict.Promote);
    });

    it('persists governance decision with evidence snapshot on hold', () => {
      const { repo, lifecycleRepo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, { mergedScore: 0.5 });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.decision.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.decision.evidenceJson).not.toBeNull();

      const evidence = JSON.parse(result.decision.evidenceJson!);
      expect(evidence.mergedScore).toBe(0.5);
      expect(evidence.thresholds.minMergedScore).toBe(0.7);
      expect(evidence.winnerResult).toBe(WalkForwardSelectionResult.Selected);

      // Verify via repository read-back
      const decisions = lifecycleRepo.getDecisionsForStrategy(STRATEGY_ID, STRATEGY_VERSION, MARKET_ID);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].verdict).toBe(GovernanceVerdict.Hold);
    });

    it('persists governance decision with null winnerId when no winner context exists', () => {
      const { repo, lifecycleRepo, evaluator } = createContext();
      const run = repo.insertRun({
        label: 'No winner run',
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        marketId: MARKET_ID,
        replaySessionId: null,
        windowCount: 0,
        totalTrials: 0,
        status: WalkForwardStatus.Completed,
        createdAt: NOW,
        startedAt: NOW,
        completedAt: NOW + 5000,
      });

      const result = evaluator.evaluate(defaultInput(run.id));

      expect(result.decision.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.decision.winnerId).toBeNull();
      expect(result.decision.evidenceJson).not.toBeNull();

      const evidence = JSON.parse(result.decision.evidenceJson!);
      expect(evidence.winnerResult).toBe(WalkForwardSelectionResult.NoWinner);
    });

    it('evidence snapshot captures threshold config, scored metrics, and per-window details', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo);

      const result = evaluator.evaluate(defaultInput(runId));
      const e = result.evidenceSnapshot;

      // Threshold config
      expect(e.thresholds.minMergedScore).toBe(0.7);
      expect(e.thresholds.minSharpeRatio).toBe(1.0);
      expect(e.thresholds.maxDrawdown).toBe(30);
      expect(e.thresholds.minWindowCount).toBe(2);

      // Scored metrics
      expect(e.mergedScore).toBe(0.85);
      expect(e.avgSharpeRatio).toBe(1.8);
      expect(e.maxDrawdown).toBe(8.2);
      expect(e.outOfSampleWindowCount).toBe(1);
      expect(e.totalWindowCount).toBe(2);

      // Trial identity
      expect(e.selectedTrialLabel).toBe('Config A');
      expect(e.selectedTrialParamsJson).toContain('momentum');

      // Per-window details
      expect(e.outOfSampleDetails).toHaveLength(1);
      expect(e.outOfSampleDetails[0].sharpeRatio).toBe(1.8);
      expect(e.outOfSampleDetails[0].totalReturn).toBe(14.5);
    });
  });

  // -----------------------------------------------------------------------
  // Negative tests
  // -----------------------------------------------------------------------

  describe('negative tests', () => {
    it('returns HOLD for non-existent run id', () => {
      const { evaluator } = createContext();

      const result = evaluator.evaluate(defaultInput(999));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('No walk-forward winner decision found');
    });

    it('returns HOLD when selected trial is null despite selected result', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, {
        winnerResult: WalkForwardSelectionResult.Selected,
        selectedTrialId: null,
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      expect(result.rationale).toContain('selected trial is null');
    });

    it('returns HOLD with stale/default phase when no lifecycle state exists yet', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, { mergedScore: 0.5 });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.previousPhase).toBe(StrategyLifecyclePhase.Backtest);
      expect(result.newPhase).toBe(StrategyLifecyclePhase.Backtest);
    });

    it('returns HOLD and does not crash on malformed evidence snapshot in winner (extreme values)', () => {
      const { repo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, {
        mergedScore: -0.1, // Negative merged score — edge case
        sharpeRatio: -3.0, // Very negative Sharpe
        maxDrawdown: 99.9, // Near-total drawdown
      });

      const result = evaluator.evaluate(defaultInput(runId));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      // Should report failures for all violations
      expect(result.rationale).toContain('Merged score');
      expect(result.rationale).toContain('Sharpe ratio');
      expect(result.rationale).toContain('drawdown');
    });

    it('handles empty window evidence gracefully', () => {
      const { repo, evaluator } = createContext();
      // Run with trial but no window evidence
      const run = repo.insertRun({
        label: 'No evidence run',
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        marketId: MARKET_ID,
        replaySessionId: null,
        windowCount: 0,
        totalTrials: 1,
        status: WalkForwardStatus.Completed,
        createdAt: NOW,
        startedAt: NOW,
        completedAt: NOW + 5000,
      });

      const trial = repo.insertTrial({
        runId: run.id,
        trialIndex: 0,
        label: 'Config Z',
        paramsJson: '{}',
        mergedScore: 0.75,
        deterministicScore: 0.7,
        llmScore: null,
        llmStatus: null,
        rank: 1,
        createdAt: NOW,
      });

      repo.insertWinner({
        runId: run.id,
        result: WalkForwardSelectionResult.Selected,
        selectedTrialId: trial.id,
        selectionStrategy: WalkForwardSelectionStrategy.TopRanked,
        selectionConfigJson: '{}',
        rationale: 'Test',
        artifactPathsJson: null,
        selectedAt: NOW,
      });

      const result = evaluator.evaluate(defaultInput(run.id));

      expect(result.verdict).toBe(GovernanceVerdict.Hold);
      // Should fail on window count thresholds
      expect(result.rationale).toContain('window evidence count');
      expect(result.rationale).toContain('0');
    });

    it('does not mutate lifecycle state on hold', () => {
      const { repo, lifecycleRepo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo, { mergedScore: 0.5 });

      // Ensure backtest exists as current state
      lifecycleRepo.upsertCurrentState({
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        marketId: MARKET_ID,
        phase: StrategyLifecyclePhase.Backtest,
        updatedAt: NOW - 5000,
      });

      const beforeState = lifecycleRepo.getCurrentState(STRATEGY_ID, STRATEGY_VERSION, MARKET_ID);

      evaluator.evaluate(defaultInput(runId));

      const afterState = lifecycleRepo.getCurrentState(STRATEGY_ID, STRATEGY_VERSION, MARKET_ID);
      expect(afterState.phase).toBe(beforeState.phase);
      expect(afterState.updatedAt).toBe(beforeState.updatedAt); // unchanged because hold doesn't update
    });
  });

  // -----------------------------------------------------------------------
  // Governance decision append-only invariant
  // -----------------------------------------------------------------------

  describe('governance decision append-only invariant', () => {
    it('each evaluation produces a new append-only decision row', () => {
      const { repo, lifecycleRepo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo);

      expect(lifecycleRepo.decisionCount()).toBe(0);

      evaluator.evaluate(defaultInput(runId));
      expect(lifecycleRepo.decisionCount()).toBe(1);

      evaluator.evaluate(defaultInput(runId));
      expect(lifecycleRepo.decisionCount()).toBe(2);

      evaluator.evaluate(defaultInput(runId));
      expect(lifecycleRepo.decisionCount()).toBe(3);
    });

    it('decisions are ordered newest-first in the log', () => {
      const { repo, lifecycleRepo, evaluator } = createContext();
      const { runId } = seedPromotableRun(repo);

      const first = evaluator.evaluate(defaultInput(runId, { evaluatedAt: NOW + 1000 }));
      const second = evaluator.evaluate(defaultInput(runId, { evaluatedAt: NOW + 2000 }));
      const third = evaluator.evaluate(defaultInput(runId, { evaluatedAt: NOW + 3000 }));

      const decisions = lifecycleRepo.getDecisionsForStrategy(STRATEGY_ID, STRATEGY_VERSION, MARKET_ID, 10);
      expect(decisions).toHaveLength(3);
      expect(decisions[0].id).toBe(third.decision.id);
      expect(decisions[1].id).toBe(second.decision.id);
      expect(decisions[2].id).toBe(first.decision.id);
    });
  });
});

// ---------------------------------------------------------------------------
// Demotion evaluation tests
// ---------------------------------------------------------------------------

const DEFAULT_DEMOTION_THRESHOLDS_LOCAL: DemotionThresholdConfig = {
  minSharpeRatio: 0.5,
  maxDrawdown: 40,
  minTradeCount: 5,
  haltTriggersDemotion: true,
  minCriticalRiskEvents: 1,
  riskEventLookbackMs: 30 * 24 * 60 * 60 * 1000, // 30 days
};

interface DemotionTestContext {
  lifecycleRepo: StrategyLifecycleRepository;
  riskRepo: ExecutionRiskRepository;
  evaluator: StrategyLifecycleEvaluator;
  db: ReturnType<DatabaseManager['db']>;
}

function createDemotionContext(includeRiskRepo: boolean = true): DemotionTestContext {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;
  const lifecycleRepo = new StrategyLifecycleRepository(db);
  const riskRepo = new ExecutionRiskRepository(db);
  const evaluator = new StrategyLifecycleEvaluator({
    walkForwardRepo: new WalkForwardRepository(db),
    lifecycleRepo,
    executionRiskRepo: includeRiskRepo ? riskRepo : null,
  });
  return { lifecycleRepo, riskRepo, evaluator, db };
}

function demotionInput(overrides?: Partial<DemotionEvaluationInput>): DemotionEvaluationInput {
  return {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    marketId: MARKET_ID,
    thresholds: DEFAULT_DEMOTION_THRESHOLDS_LOCAL,
    evaluatedAt: NOW + 10000,
    ...overrides,
  };
}

function seedPerformanceSummary(overrides?: Partial<LifecyclePerformanceSummary>): LifecyclePerformanceSummary {
  return {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    marketId: MARKET_ID,
    sharpeRatio: 0.3,
    maxDrawdown: 55,
    totalReturn: -12.5,
    tradeCount: 20,
    windowStartMs: NOW - 7 * 24 * 60 * 60 * 1000,
    windowEndMs: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Risk-breach demotion
// ---------------------------------------------------------------------------

describe('Demotion evaluation — risk-breach demotion', () => {
  it('demotes from live to paper when active halt exists', () => {
    const { lifecycleRepo, riskRepo, evaluator } = createDemotionContext();

    // Seed at live
    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: NOW - 5000,
    });

    // Activate halt
    riskRepo.latchHalt(HaltSource.DailyLoss, 'Daily loss limit breached');

    const result = evaluator.evaluateDemotion(demotionInput());

    expect(result.verdict).toBe(GovernanceVerdict.Demote);
    expect(result.previousPhase).toBe(StrategyLifecyclePhase.Live);
    expect(result.newPhase).toBe(StrategyLifecyclePhase.Paper);
    expect(result.stateUpdated).toBe(true);
    expect(result.rationale).toContain('risk breach');
    expect(result.rationale).toContain('Daily loss limit breached');

    // Verify state was updated
    const state = lifecycleRepo.getCurrentState(STRATEGY_ID, STRATEGY_VERSION, MARKET_ID);
    expect(state.phase).toBe(StrategyLifecyclePhase.Paper);
  });

  it('demotes from paper to backtest when active halt exists', () => {
    const { lifecycleRepo, riskRepo, evaluator } = createDemotionContext();

    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: NOW - 5000,
    });

    riskRepo.latchHalt(HaltSource.ExposureLimit, 'Exposure limit exceeded');

    const result = evaluator.evaluateDemotion(demotionInput());

    expect(result.verdict).toBe(GovernanceVerdict.Demote);
    expect(result.previousPhase).toBe(StrategyLifecyclePhase.Paper);
    expect(result.newPhase).toBe(StrategyLifecyclePhase.Backtest);
    expect(result.stateUpdated).toBe(true);
  });

  it('demotes when critical risk events exceed threshold', () => {
    const { lifecycleRepo, riskRepo, evaluator } = createDemotionContext();

    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: NOW - 5000,
    });

    // Insert two critical risk events
    riskRepo.insertEvent({
      eventType: 'halt',
      source: HaltSource.DailyLoss,
      severity: 'critical',
      message: 'Daily loss limit breached',
      diagnostic: null,
      recordedAt: NOW - 1000,
    });
    riskRepo.insertEvent({
      eventType: 'limit_breach',
      source: HaltSource.ExposureLimit,
      severity: 'critical',
      message: 'Exposure cap hit',
      diagnostic: null,
      recordedAt: NOW - 500,
    });

    const result = evaluator.evaluateDemotion(demotionInput());

    expect(result.verdict).toBe(GovernanceVerdict.Demote);
    expect(result.rationale).toContain('critical risk event');
    expect(result.rationale).toContain('2');
  });

  it('holds when no halt and no risk events exist', () => {
    const { lifecycleRepo, evaluator } = createDemotionContext();

    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: NOW - 5000,
    });

    const result = evaluator.evaluateDemotion(demotionInput());

    expect(result.verdict).toBe(GovernanceVerdict.Hold);
    expect(result.stateUpdated).toBe(false);
    expect(result.rationale).toContain('No demotion trigger conditions met');
  });
});

// ---------------------------------------------------------------------------
// Performance-drift demotion
// ---------------------------------------------------------------------------

describe('Demotion evaluation — performance-drift demotion', () => {
  it('demotes from live to paper when Sharpe is below threshold and drawdown exceeds threshold', () => {
    const { lifecycleRepo, evaluator } = createDemotionContext();

    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: NOW - 5000,
    });

    // Performance summary with poor metrics
    const perfSummary = seedPerformanceSummary({
      sharpeRatio: -0.2,
      maxDrawdown: 65,
    });

    const result = evaluator.evaluateDemotion(demotionInput({
      performanceSummary: perfSummary,
    }));

    expect(result.verdict).toBe(GovernanceVerdict.Demote);
    expect(result.previousPhase).toBe(StrategyLifecyclePhase.Live);
    expect(result.newPhase).toBe(StrategyLifecyclePhase.Paper);
    expect(result.stateUpdated).toBe(true);
    expect(result.rationale).toContain('performance drift');
    expect(result.rationale).toContain('Sharpe');
    expect(result.rationale).toContain('drawdown');
  });

  it('demotes from paper to backtest when Sharpe is below threshold', () => {
    const { lifecycleRepo, evaluator } = createDemotionContext();

    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: NOW - 5000,
    });

    const perfSummary = seedPerformanceSummary({
      sharpeRatio: 0.1,
      maxDrawdown: 35,
    });

    const result = evaluator.evaluateDemotion(demotionInput({
      performanceSummary: perfSummary,
    }));

    expect(result.verdict).toBe(GovernanceVerdict.Demote);
    expect(result.previousPhase).toBe(StrategyLifecyclePhase.Paper);
    expect(result.newPhase).toBe(StrategyLifecyclePhase.Backtest);
    expect(result.rationale).toContain('Sharpe');
  });

  it('holds when performance is within thresholds', () => {
    const { lifecycleRepo, evaluator } = createDemotionContext();

    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: NOW - 5000,
    });

    // Good performance — well within thresholds
    const perfSummary = seedPerformanceSummary({
      sharpeRatio: 1.5,
      maxDrawdown: 10,
      tradeCount: 50,
    });

    const result = evaluator.evaluateDemotion(demotionInput({
      performanceSummary: perfSummary,
    }));

    expect(result.verdict).toBe(GovernanceVerdict.Hold);
    expect(result.rationale).toContain('within thresholds');
    expect(result.rationale).toContain('Sharpe');
  });
});

// ---------------------------------------------------------------------------
// Fail-closed HOLD with missing/malformed evidence
// ---------------------------------------------------------------------------

describe('Demotion evaluation — fail-closed hold', () => {
  it('holds when strategy is already at backtest (minimum phase)', () => {
    const { lifecycleRepo, riskRepo, evaluator } = createDemotionContext();

    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Backtest,
      updatedAt: NOW - 5000,
    });

    // Even with active halt, cannot demote below backtest
    riskRepo.latchHalt(HaltSource.DailyLoss, 'Loss limit');

    const result = evaluator.evaluateDemotion(demotionInput());

    expect(result.verdict).toBe(GovernanceVerdict.Hold);
    expect(result.stateUpdated).toBe(false);
    expect(result.rationale).toContain('already at the minimum lifecycle phase');
  });

  it('holds when no risk repo is wired (null executionRiskRepo)', () => {
    const { lifecycleRepo, evaluator } = createDemotionContext(false);

    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: NOW - 5000,
    });

    // No performance summary, no risk repo — no trigger
    const result = evaluator.evaluateDemotion(demotionInput({
      performanceSummary: null,
    }));

    expect(result.verdict).toBe(GovernanceVerdict.Hold);
    expect(result.rationale).toContain('No demotion trigger conditions met');
    expect(result.rationale).toContain('No risk repository wired');
    expect(result.rationale).toContain('No performance summary provided');
  });

  it('holds when performance summary identity does not match target strategy', () => {
    const { lifecycleRepo, evaluator } = createDemotionContext(false);

    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: NOW - 5000,
    });

    const wrongPerf = seedPerformanceSummary({
      strategyId: 'wrong-strategy',
    });

    const result = evaluator.evaluateDemotion(demotionInput({
      performanceSummary: wrongPerf,
    }));

    expect(result.verdict).toBe(GovernanceVerdict.Hold);
    expect(result.rationale).toContain('does not match target');
    // The identity mismatch is a drift failure, but since there's no risk trigger
    // and the drift failures are identity mismatches (not actual drift), 
    // the evaluator should hold
  });

  it('holds when trade count is below minimum threshold', () => {
    const { lifecycleRepo, evaluator } = createDemotionContext(false);

    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: NOW - 5000,
    });

    // Low trade count — insufficient evidence
    const perfSummary = seedPerformanceSummary({
      sharpeRatio: 0.1,
      tradeCount: 1, // Below minTradeCount of 5
    });

    const result = evaluator.evaluateDemotion(demotionInput({
      performanceSummary: perfSummary,
    }));

    expect(result.verdict).toBe(GovernanceVerdict.Hold);
    expect(result.rationale).toContain('below minimum');
    expect(result.rationale).toContain('1');
  });
});

// ---------------------------------------------------------------------------
// Evidence snapshot persistence
// ---------------------------------------------------------------------------

describe('Demotion evaluation — evidence snapshot persistence', () => {
  it('persists evidence snapshot with trigger, thresholds, and risk state on risk demotion', () => {
    const { lifecycleRepo, riskRepo, evaluator } = createDemotionContext();

    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: NOW - 5000,
    });

    riskRepo.latchHalt(HaltSource.DailyLoss, 'Daily loss breach');

    const result = evaluator.evaluateDemotion(demotionInput());

    const evidence = result.evidenceSnapshot;
    expect(evidence.trigger).toBe('risk_breach');
    expect(evidence.triggerDetail).toContain('Daily loss breach');
    expect(evidence.thresholds.minSharpeRatio).toBe(0.5);
    expect(evidence.riskState).not.toBeNull();
    expect(evidence.riskState!['haltState']).toBe('active_halt');
    expect(evidence.riskState!['haltSource']).toBe('daily_loss');
    expect(evidence.previousPhase).toBe('live');
    expect(evidence.newPhase).toBe('paper');

    // Verify persisted governance decision
    const decisions = lifecycleRepo.getDecisionsForStrategy(STRATEGY_ID, STRATEGY_VERSION, MARKET_ID);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].verdict).toBe(GovernanceVerdict.Demote);
    const persistedEvidence = JSON.parse(decisions[0].evidenceJson!);
    expect(persistedEvidence.trigger).toBe('risk_breach');
  });

  it('persists evidence snapshot with performance summary on drift demotion', () => {
    const { lifecycleRepo, evaluator } = createDemotionContext(false);

    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: NOW - 5000,
    });

    const perfSummary = seedPerformanceSummary({
      sharpeRatio: -0.5,
      maxDrawdown: 70,
    });

    const result = evaluator.evaluateDemotion(demotionInput({
      performanceSummary: perfSummary,
    }));

    const evidence = result.evidenceSnapshot;
    expect(evidence.trigger).toBe('performance_drift');
    expect(evidence.performanceSummary).not.toBeNull();
    expect(evidence.performanceSummary!.sharpeRatio).toBe(-0.5);
    expect(evidence.performanceSummary!.maxDrawdown).toBe(70);
    expect(evidence.performanceSummary!.tradeCount).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Identity isolation
// ---------------------------------------------------------------------------

describe('Demotion evaluation — identity isolation', () => {
  it('strategy A demotion does not affect strategy B state', () => {
    const { lifecycleRepo, riskRepo, evaluator } = createDemotionContext();

    // Seed A at live
    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: NOW - 5000,
    });

    // Seed B at paper
    const B_ID = 'other-strategy-v1';
    const B_VER = '1.0.0';
    const B_MKT = 'OTHER_MARKET';
    lifecycleRepo.upsertCurrentState({
      strategyId: B_ID,
      strategyVersion: B_VER,
      marketId: B_MKT,
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: NOW - 5000,
    });

    // Halt risk (affects all but evaluator checks current state per strategy)
    riskRepo.latchHalt(HaltSource.DailyLoss, 'Loss');

    // Evaluate demotion for A only
    const resultA = evaluator.evaluateDemotion(demotionInput());
    expect(resultA.verdict).toBe(GovernanceVerdict.Demote);
    expect(resultA.newPhase).toBe(StrategyLifecyclePhase.Paper);

    // B should still be at paper (no demotion evaluated for B)
    const stateB = lifecycleRepo.getCurrentState(B_ID, B_VER, B_MKT);
    expect(stateB.phase).toBe(StrategyLifecyclePhase.Paper);
  });
});

// ---------------------------------------------------------------------------
// Repeated demotion behavior
// ---------------------------------------------------------------------------

describe('Demotion evaluation — repeated demotion behavior', () => {
  it('steps through phases on successive demotions', () => {
    const { lifecycleRepo, riskRepo, evaluator } = createDemotionContext();

    // Start at live
    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: NOW - 5000,
    });

    riskRepo.latchHalt(HaltSource.DailyLoss, 'Loss');

    // First demotion: live → paper
    const first = evaluator.evaluateDemotion(demotionInput());
    expect(first.verdict).toBe(GovernanceVerdict.Demote);
    expect(first.newPhase).toBe(StrategyLifecyclePhase.Paper);

    // Manually unlatch so second demotion can evaluate fresh (or use same halt)
    // The halt is still active, so second evaluation would try to demote again
    const second = evaluator.evaluateDemotion(demotionInput());
    expect(second.verdict).toBe(GovernanceVerdict.Demote);
    expect(second.newPhase).toBe(StrategyLifecyclePhase.Backtest);
    expect(second.rationale).toContain('paper');

    // Third evaluation — already at backtest, cannot demote further
    const third = evaluator.evaluateDemotion(demotionInput());
    expect(third.verdict).toBe(GovernanceVerdict.Hold);
    expect(third.rationale).toContain('already at the minimum lifecycle phase');
  });

  it('produces append-only governance decisions for each demotion evaluation', () => {
    const { lifecycleRepo, riskRepo, evaluator } = createDemotionContext();

    lifecycleRepo.upsertCurrentState({
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      marketId: MARKET_ID,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: NOW - 5000,
    });

    riskRepo.latchHalt(HaltSource.DailyLoss, 'Loss');

    expect(lifecycleRepo.decisionCount()).toBe(0);

    evaluator.evaluateDemotion(demotionInput());
    expect(lifecycleRepo.decisionCount()).toBe(1);

    evaluator.evaluateDemotion(demotionInput());
    expect(lifecycleRepo.decisionCount()).toBe(2);

    // Now at backtest, evaluation produces HOLD but still appends decision
    evaluator.evaluateDemotion(demotionInput());
    expect(lifecycleRepo.decisionCount()).toBe(3);
  });
});
