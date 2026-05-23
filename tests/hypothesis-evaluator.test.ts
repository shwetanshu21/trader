// ── HypothesisResearchEvaluator unit tests ──
//
// Covers:
//   - Happy path: validated hypothesis → winner-selected evaluation
//   - No-winner path: validated hypothesis → no winner found
//   - Error path: walk-forward evaluator throws → evaluation failed
//   - Precondition: hypothesis not found
//   - Precondition: hypothesis not validated
//   - Precondition: hypothesis already has an evaluation
//   - Artifact emission creates files on disk
//   - Evaluation result structure integrity

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { HypothesisRepository } from '../src/persistence/hypothesis-repo.js';
import { WalkForwardRepository } from '../src/persistence/walk-forward-repo.js';
import { HypothesisResearchEvaluator } from '../src/research/hypothesis-evaluator.js';
import { canonicalizeHypothesis } from '../src/research/hypothesis-canonicalizer.js';
import {
  HypothesisStatus,
  HypothesisEvaluationStatus,
  type HypothesisGraph,
  type NewHypothesisGraph,
  type HypothesisEvaluationResult,
} from '../src/types/runtime.js';
import {
  WalkForwardStatus,
  WalkForwardSelectionStrategy,
  WalkForwardSelectionResult,
  WalkForwardWindowType,
  type WalkForwardRunRow,
  type WalkForwardTrialRow,
  type WalkForwardTrialWindowRow,
  type WalkForwardRankedCandidate,
} from '../src/replay/walk-forward-types.js';
import type { HistoricalDataProvider, ReplayTick } from '../src/replay/historical-data-provider.js';
import type { MarketProfile } from '../src/market/market-profile.js';
import { ReplayFidelity } from '../src/replay/types.js';

// ---------------------------------------------------------------------------
// Fake dependencies
// ---------------------------------------------------------------------------

const NOW = 1736025600000; // 2025-01-05T00:00:00.000Z

class FakeDataProvider implements HistoricalDataProvider {
  readonly label = 'test-fixture-v1';
  private readonly _hasData: boolean;

  constructor(options?: { hasData?: boolean }) {
    this._hasData = options?.hasData ?? true;
  }

  getEffectiveFidelity(_tick: ReplayTick): ReplayFidelity {
    return ReplayFidelity.Synthetic;
  }

  hasData(_rangeStart: number, _rangeEnd: number): boolean {
    return this._hasData;
  }

  async getCandidates(_tick: ReplayTick): Promise<any[]> {
    return [];
  }

  getResolutionMetadata?(): {
    screeningCadenceMinutes: number | null;
    executionResolutionMinutes: number | null;
    supportsFineGrainedExecution: boolean;
  } {
    return {
      screeningCadenceMinutes: 5,
      executionResolutionMinutes: 5,
      supportsFineGrainedExecution: false,
    };
  }
}

class FakeMarketProfile implements MarketProfile {
  readonly marketId = 'INDIA_NSE_EQ';
  readonly displayName = 'NSE India Equities';
  readonly timezone = 'Asia/Kolkata';
  readonly settlementCycle = 'T+1';

  readonly regularSession = {
    open: '09:15',
    close: '15:30',
  };

  readonly preMarketSession = { open: '09:00', close: '09:15' };
  readonly postMarketSession = { open: '15:30', close: '16:00' };

  isTradingDay(_date: Date): boolean {
    return true;
  }

  getMarketTime(): number {
    return NOW;
  }

  formatMarketDate(_ts: number): string {
    return '2025-01-05';
  }

  getCurrentPhase(): string {
    return 'regular';
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function sampleGraph(): HypothesisGraph {
  return {
    schemaVersion: '1',
    signals: [{ type: 'ema_cross', params: { fast: 8, slow: 21 } }],
    filters: [{ type: 'volume_min', params: { min: 500000 } }],
    entryRules: [{ type: 'breakout_confirmed', params: { lookbackBars: 5 } }],
    exitRules: [{ type: 'time_stop', params: { maxBars: 12 } }],
    riskRules: [{ type: 'atr_stop', params: { period: 14, multiple: 2 } }],
  };
}

function newHypothesis(
  status: HypothesisStatus = HypothesisStatus.Validated,
): NewHypothesisGraph {
  const graph = sampleGraph();
  const canonical = canonicalizeHypothesis(graph);
  return {
    canonicalHash: canonical.canonicalHash,
    canonicalJson: canonical.canonicalJson,
    status,
    graph,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function seedHypothesis(
  repo: HypothesisRepository,
  status: HypothesisStatus = HypothesisStatus.Validated,
): number {
  return repo.insertHypothesis(newHypothesis(status)).id;
}

// ---------------------------------------------------------------------------
// Mock evaluator result factory
// ---------------------------------------------------------------------------

function makeMockEvaluatorResult(options: {
  runId: number;
  trialId: number;
  mergedScore: number;
  deterministicScore: number;
}) {
  const trialWindow: WalkForwardTrialWindowRow = {
    id: 1,
    trialId: options.trialId,
    windowId: 1,
    windowType: WalkForwardWindowType.OutOfSample,
    totalReturn: 5.2,
    sharpeRatio: 1.5,
    maxDrawdown: 8.0,
    winRate: 0.6,
    tradeCount: 25,
    profitFactor: 1.8,
    metricsJson: null,
    createdAt: NOW,
  };

  const inSampleWindow: WalkForwardTrialWindowRow = {
    id: 2,
    trialId: options.trialId,
    windowId: 1,
    windowType: WalkForwardWindowType.InSample,
    totalReturn: 8.1,
    sharpeRatio: 2.1,
    maxDrawdown: 5.0,
    winRate: 0.65,
    tradeCount: 50,
    profitFactor: 2.2,
    metricsJson: null,
    createdAt: NOW,
  };

  const mockRun: WalkForwardRunRow = {
    id: options.runId,
    label: `mock-run-${options.runId}`,
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    replaySessionId: null,
    windowCount: 2,
    totalTrials: 1,
    status: WalkForwardStatus.Completed,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW + 1000,
  };

  const mockTrial = {
    trialId: options.trialId,
    runId: options.runId,
    trialIndex: 0,
    label: 'hypothesis-1',
    paramsJson: JSON.stringify({
      hypothesisId: 1,
      canonicalHash: 'abc123',
      schemaVersion: '1',
      signals: [],
      filters: [],
      entryRules: [],
      exitRules: [],
      riskRules: [],
      maxCandidates: 5,
    }),
    mergedScore: options.mergedScore,
    deterministicScore: options.deterministicScore,
    llmScore: null,
    llmStatus: null,
    rank: 1,
    createdAt: NOW,
    windowEvidence: [inSampleWindow, trialWindow],
  };

  const mockRankedCandidate: WalkForwardRankedCandidate = {
    trialId: options.trialId,
    rank: 1,
    label: 'hypothesis-1',
    paramsJson: mockTrial.paramsJson,
    mergedScore: options.mergedScore,
    deterministicScore: options.deterministicScore,
    llmScore: null,
    llmStatus: null,
    windowCount: 2,
  };

  return {
    run: mockRun,
    windows: [
      {
        id: 1,
        runId: options.runId,
        windowIndex: 0,
        rangeStart: NOW - 7 * 86_400_000,
        rangeEnd: NOW,
        windowLabel: 'W01 2025-01-05',
        trialCountOptimized: 1,
        trialCountTested: 1,
        status: 'completed',
        createdAt: NOW,
      },
    ],
    trials: [mockTrial],
    rankedCandidates: [mockRankedCandidate],
    aggregateMetrics: {
      scoreStability: 1.0,
      topKOverlap: 1.0,
      llmConsultationRate: null,
      llmDivergence: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HypothesisResearchEvaluator', () => {
  let hypothesisRepo: HypothesisRepository;
  let walkForwardRepo: WalkForwardRepository;
  let mgr: DatabaseManager;

  beforeEach(() => {
    mgr = new DatabaseManager(':memory:');
    hypothesisRepo = new HypothesisRepository(mgr.db);
    walkForwardRepo = new WalkForwardRepository(mgr.db);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createEvaluator(mockEvaluateFn: (...args: any[]) => any): HypothesisResearchEvaluator {
    const mockEvaluator = {
      evaluate: mockEvaluateFn,
    } as any;

    return new HypothesisResearchEvaluator({
      db: mgr.db,
      dataProvider: new FakeDataProvider(),
      marketProfile: new FakeMarketProfile(),
      hypothesisRepo,
      walkForwardRepo,
      walkForwardEvaluator: mockEvaluator,
    });
  }

  /** Insert a walk_forward_run row with a mock trial so FK references are satisfied. */
  function insertMockRun(overrides?: Partial<Parameters<WalkForwardRepository['insertRun']>[0]>): { runId: number; trialId: number } {
    const runId = walkForwardRepo.insertRun({
      label: 'mock-run',
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      replaySessionId: null,
      windowCount: 2,
      totalTrials: 1,
      status: 'completed' as any,
      createdAt: NOW,
      startedAt: NOW,
      completedAt: NOW + 1000,
      ...overrides,
    }).id;

    const trialId = walkForwardRepo.insertTrial({
      runId,
      trialIndex: 0,
      label: 'mock-trial',
      paramsJson: '{}',
      mergedScore: 0.85,
      deterministicScore: 0.78,
      llmScore: null,
      llmStatus: null,
      rank: 1,
      createdAt: NOW,
    }).id;

    return { runId, trialId };
  }

  it('evaluates a validated hypothesis and returns a completed result with winner', async () => {
    const hypothesisId = seedHypothesis(hypothesisRepo, HypothesisStatus.Validated);
    const { runId: realRunId, trialId: realTrialId } = insertMockRun();
    const mockFn = vi.fn().mockResolvedValue(makeMockEvaluatorResult({
      runId: realRunId,
      trialId: realTrialId,
      mergedScore: 0.85,
      deterministicScore: 0.78,
    }));
    const evaluator = createEvaluator(mockFn);

    const result: HypothesisEvaluationResult = await evaluator.evaluate(hypothesisId, {
      rangeStart: NOW - 7 * 86_400_000,
      rangeEnd: NOW,
    });

    // Verify result structure
    expect(result.evaluation.hypothesisGraphId).toBe(hypothesisId);
    expect(result.finalStatus).toBe(HypothesisEvaluationStatus.Completed);
    expect(result.artifactPaths.length).toBe(3);
    expect(result.walkForwardRun).not.toBeNull();
    expect(result.walkForwardRun?.id).toBe(realRunId);
    expect(result.winner).not.toBeNull();
    expect(result.winner?.aggregateMergedScore).toBe(0.85);
    expect(result.aggregateMetrics).not.toBeNull();
    expect(result.aggregateMetrics?.scoreStability).toBe(1.0);
    expect(result.rationale.length).toBeGreaterThan(0);

    // Verify evaluation was persisted in DB
    const persistedEval = hypothesisRepo.getEvaluationByHypothesisId(hypothesisId);
    expect(persistedEval).not.toBeNull();
    expect(persistedEval?.status).toBe(HypothesisEvaluationStatus.Completed);
    expect(persistedEval?.walkForwardRunId).toBe(realRunId);

    // Verify winner row was persisted via the walk_forward_winners table
    const winnerRow = walkForwardRepo.getWinnerForRun(realRunId);
    expect(winnerRow).not.toBeNull();
    expect(winnerRow?.selectedTrialId).toBe(realTrialId);
    expect(persistedEval?.winnerId).toBe(winnerRow?.id);

    // Verify hypothesis status was updated
    const hypothesis = hypothesisRepo.getHypothesisById(hypothesisId);
    expect(hypothesis?.status).toBe(HypothesisStatus.FailedEvaluation);

    // Verify artifacts were created on disk
    const artifactDir = path.join('data', 'artifacts', 'research', String(hypothesisId));
    expect(fs.existsSync(path.join(artifactDir, 'promotion-artifact.json'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'diagnostics.json'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'hypothesis.json'))).toBe(true);

    // Verify research artifact rows were persisted
    const artifacts = hypothesisRepo.getResearchArtifactsByEvaluationId(result.evaluation.id);
    expect(artifacts.length).toBe(3);
  });

  it('returns no-winner when walk-forward produces no qualifying winner', async () => {
    const hypothesisId = seedHypothesis(hypothesisRepo, HypothesisStatus.Validated);
    const { runId: realRunId } = insertMockRun({ totalTrials: 1 });
    const mockFn = vi.fn().mockResolvedValue(makeMockEvaluatorResult({
      runId: realRunId,
      trialId: 101,
      mergedScore: 0.3,
      deterministicScore: 0.25,
    }));
    const evaluator = createEvaluator(mockFn);

    const result = await evaluator.evaluate(hypothesisId);

    expect(result.finalStatus).toBe(HypothesisEvaluationStatus.NoWinner);
    expect(result.winner).toBeNull();
    expect(result.walkForwardRun).not.toBeNull();
    expect(result.artifactPaths.length).toBeGreaterThanOrEqual(1);

    // Verify DB state
    const persistedEval = hypothesisRepo.getEvaluationByHypothesisId(hypothesisId);
    expect(persistedEval?.status).toBe(HypothesisEvaluationStatus.NoWinner);
    // No winner row should exist for a no-winner result
    const winnerRow = walkForwardRepo.getWinnerForRun(realRunId);
    expect(winnerRow).toBeNull();
  });

  it('returns failed status when walk-forward evaluator throws', async () => {
    const hypothesisId = seedHypothesis(hypothesisRepo, HypothesisStatus.Validated);
    const mockFn = vi.fn().mockRejectedValue(new Error('Data provider has no data'));
    const evaluator = createEvaluator(mockFn);

    const result = await evaluator.evaluate(hypothesisId);

    expect(result.finalStatus).toBe(HypothesisEvaluationStatus.Failed);
    expect(result.walkForwardRun).toBeNull();
    expect(result.winner).toBeNull();
    expect(result.aggregateMetrics).toBeNull();
    expect(result.rationale).toContain('Data provider has no data');

    // Verify DB state
    const persistedEval = hypothesisRepo.getEvaluationByHypothesisId(hypothesisId);
    expect(persistedEval?.status).toBe(HypothesisEvaluationStatus.Failed);
    expect(persistedEval?.rationale).toContain('Data provider has no data');
  });

  it('throws when hypothesis does not exist', async () => {
    const mockFn = vi.fn();
    const evaluator = createEvaluator(mockFn);

    await expect(evaluator.evaluate(999)).rejects.toThrow(
      'Hypothesis graph 999 does not exist',
    );
  });

  it('throws when hypothesis is not validated', async () => {
    const hypothesisId = seedHypothesis(hypothesisRepo, HypothesisStatus.Pending);
    const mockFn = vi.fn();
    const evaluator = createEvaluator(mockFn);

    await expect(evaluator.evaluate(hypothesisId)).rejects.toThrow(
      `status "${HypothesisStatus.Pending}"`,
    );
  });

  it('throws when hypothesis already has an evaluation', async () => {
    const hypothesisId = seedHypothesis(hypothesisRepo, HypothesisStatus.Validated);
    const mockFn = vi.fn();
    const evaluator = createEvaluator(mockFn);

    // Create a pre-existing evaluation
    hypothesisRepo.insertEvaluation({
      hypothesisGraphId: hypothesisId,
      status: HypothesisEvaluationStatus.InProgress,
      rationale: 'Previous evaluation.',
      outcomeDetail: '',
    });

    await expect(evaluator.evaluate(hypothesisId)).rejects.toThrow(
      'already has an evaluation',
    );
  });

  it('cleans up artifacts directory on evaluate even on failure', async () => {
    const hypothesisId = seedHypothesis(hypothesisRepo, HypothesisStatus.Validated);
    const mockFn = vi.fn().mockRejectedValue(new Error('Walk-forward crashed'));
    const evaluator = createEvaluator(mockFn);

    const result = await evaluator.evaluate(hypothesisId);

    // Even on failure, diagnostics artifact should be emitted
    expect(result.artifactPaths.length).toBe(1);
    const artifactDir = path.join('data', 'artifacts', 'research', String(hypothesisId));
    expect(fs.existsSync(path.join(artifactDir, 'diagnostics.json'))).toBe(true);
  });

  it('persists and clears artifact files between evaluations for different hypotheses', async () => {
    const hypothesis1Id = seedHypothesis(hypothesisRepo, HypothesisStatus.Validated);
    const hypothesis2Id = seedHypothesis(hypothesisRepo, HypothesisStatus.Validated);

    const { runId: realRunId1, trialId: realTrialId1 } = insertMockRun();
    const { runId: realRunId2, trialId: realTrialId2 } = insertMockRun();

    const mockFn1 = vi.fn().mockResolvedValue(makeMockEvaluatorResult({
      runId: realRunId1,
      trialId: realTrialId1,
      mergedScore: 0.88,
      deterministicScore: 0.82,
    }));
    const mockFn2 = vi.fn().mockResolvedValue(makeMockEvaluatorResult({
      runId: realRunId2,
      trialId: realTrialId2,
      mergedScore: 0.91,
      deterministicScore: 0.85,
    }));

    const evaluator1 = createEvaluator(mockFn1);
    const evaluator2 = createEvaluator(mockFn2);

    const result1 = await evaluator1.evaluate(hypothesis1Id);
    const result2 = await evaluator2.evaluate(hypothesis2Id);

    // Each hypothesis should have its own artifact directory
    const dir1 = path.join('data', 'artifacts', 'research', String(hypothesis1Id));
    const dir2 = path.join('data', 'artifacts', 'research', String(hypothesis2Id));

    expect(fs.existsSync(path.join(dir1, 'promotion-artifact.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir1, 'diagnostics.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir2, 'promotion-artifact.json'))).toBe(true);

    // Artifact paths should differ by hypothesis id
    expect(result1.artifactPaths[0]).toContain(String(hypothesis1Id));
    expect(result2.artifactPaths[0]).toContain(String(hypothesis2Id));

    // Winners persisted for each run
    const winner1 = walkForwardRepo.getWinnerForRun(realRunId1);
    const winner2 = walkForwardRepo.getWinnerForRun(realRunId2);
    expect(winner1).not.toBeNull();
    expect(winner2).not.toBeNull();
  });
});
