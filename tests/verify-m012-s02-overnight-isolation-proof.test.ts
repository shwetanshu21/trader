// ── M012/S02 — Overnight Research Isolation Proof Integration Test ──
//
// Proves that explicit research DB routing keeps all overnight and
// downstream research persistence inside the isolated workspace boundary.
// Uses two on-disk SQLite files (research.db + runtime.db) to demonstrate
// that writes via the evaluator never leak into the default runtime path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { DatabaseManager } from '../src/persistence/sqlite.js';
import { HypothesisRepository } from '../src/persistence/hypothesis-repo.js';
import { WalkForwardRepository } from '../src/persistence/walk-forward-repo.js';
import { OvernightRunRepo } from '../src/research/overnight-run-repo.js';
import { OvernightOrchestrator } from '../src/research/overnight-orchestrator.js';
import { MarketClock } from '../src/runtime/market-clock.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';
import { HypothesisResearchEvaluator } from '../src/research/hypothesis-evaluator.js';
import { canonicalizeHypothesis } from '../src/research/hypothesis-canonicalizer.js';
import {
  HypothesisStatus,
  HypothesisEvaluationStatus,
  type NewHypothesisGraph,
  type HypothesisGraph,
} from '../src/types/runtime.js';
import {
  WalkForwardStatus,
  WalkForwardWindowType,
  type WalkForwardRunRow,
  type WalkForwardTrialRow,
  type WalkForwardTrialWindowRow,
  type WalkForwardRankedCandidate,
} from '../src/replay/walk-forward-types.js';
import { ResearchArtifactWriter } from '../src/research/artifact-writer.js';
import { WinnerSelector } from '../src/replay/winner-selection.js';
import type { HistoricalDataProvider, ReplayTick } from '../src/replay/historical-data-provider.js';
import type { MarketProfile } from '../src/market/market-profile.js';
import { ReplayFidelity } from '../src/replay/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1736025600000; // 2025-01-05T00:00:00.000Z

function indiaTime(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number = 0,
  seconds: number = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hours - 5, minutes - 30, seconds));
}

const CLOSED_AFTER = indiaTime(2025, 1, 6, 16, 30, 0);

class FakeDataProvider implements HistoricalDataProvider {
  readonly label = 'test-fixture-v1';
  getEffectiveFidelity(_tick: ReplayTick): ReplayFidelity {
    return ReplayFidelity.Synthetic;
  }
  hasData(_rangeStart: number, _rangeEnd: number): boolean {
    return true;
  }
  async getCandidates(_tick: ReplayTick): Promise<any[]> {
    return [];
  }
  getResolutionMetadata?() {
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
  readonly regularSession = { open: '09:15', close: '15:30' };
  readonly preMarketSession = { open: '09:00', close: '09:15' };
  readonly postMarketSession = { open: '15:30', close: '16:00' };
  isTradingDay(_date: Date): boolean { return true; }
  getMarketTime(): number { return NOW; }
  formatMarketDate(_ts: number): string { return '2025-01-05'; }
  getCurrentPhase(): string { return 'closed'; }
}

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

function newHypothesis(status: HypothesisStatus = HypothesisStatus.Validated): NewHypothesisGraph {
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

function seedHypothesis(repo: HypothesisRepository): number {
  return repo.insertHypothesis(newHypothesis(HypothesisStatus.Validated)).id;
}

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
    paramsJson: JSON.stringify({ hypothesisId: 1, canonicalHash: 'abc123', schemaVersion: '1', signals: [], filters: [], entryRules: [], exitRules: [], riskRules: [], maxCandidates: 5 }),
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
    windows: [{ id: 1, runId: options.runId, windowIndex: 0, rangeStart: NOW - 7 * 86_400_000, rangeEnd: NOW, windowLabel: 'W01 2025-01-05', trialCountOptimized: 1, trialCountTested: 1, status: 'completed', createdAt: NOW }],
    trials: [mockTrial],
    rankedCandidates: [mockRankedCandidate],
    aggregateMetrics: { scoreStability: 1.0, topKOverlap: 1.0, llmConsultationRate: null, llmDivergence: null },
  };
}

function insertMockRun(wfRepo: WalkForwardRepository): { runId: number; trialId: number } {
  const runId = wfRepo.insertRun({
    label: 'mock-run',
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
  }).id;

  const trialId = wfRepo.insertTrial({
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

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

describe('M012/S02 Overnight Isolation Proof', () => {
  let tmpDir: string;
  let researchDbPath: string;
  let runtimeDbPath: string;
  let researchMgr: DatabaseManager;
  let runtimeMgr: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm012-s02-proof-'));
    researchDbPath = path.join(tmpDir, 'research.db');
    runtimeDbPath = path.join(tmpDir, 'runtime.db');
    researchMgr = new DatabaseManager(researchDbPath);
    runtimeMgr = new DatabaseManager(runtimeDbPath);
  });

  afterEach(() => {
    researchMgr.close();
    runtimeMgr.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Test 1: Overnight run isolation
  // -----------------------------------------------------------------------

  it('overnight run persisted in research DB is absent from runtime DB', () => {
    const researchRepo = new OvernightRunRepo(researchMgr.db);
    const researchClock = new MarketClock(INDIA_NSE_EQ_MARKET);
    const researchOrchestrator = new OvernightOrchestrator(researchRepo, researchClock);

    const result = researchOrchestrator.tryStart(
      'iso-overnight-run',
      tmpDir,
      CLOSED_AFTER,
      researchDbPath,
    );
    expect(result.accepted).toBe(true);
    expect(result.run.researchDbPath).toBe(researchDbPath);

    // Research DB has the run
    expect(researchRepo.countRuns()).toBe(1);
    expect(researchOrchestrator.getRun(result.run.id)).not.toBeNull();

    // Runtime DB is untouched
    const runtimeRepo = new OvernightRunRepo(runtimeMgr.db);
    expect(runtimeRepo.countRuns()).toBe(0);
    expect(runtimeRepo.getRun(result.run.id)).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 2: Hypothesis evaluation isolation
  // -----------------------------------------------------------------------

  it('evaluation writes to research DB and leaves runtime DB untouched', async () => {
    const researchHypothesisRepo = new HypothesisRepository(researchMgr.db);
    const researchWfRepo = new WalkForwardRepository(researchMgr.db);

    // Seed a validated hypothesis in the research DB
    const hypothesisId = seedHypothesis(researchHypothesisRepo);
    const { runId: realRunId, trialId: realTrialId } = insertMockRun(researchWfRepo);

    // Create evaluator wired to the research DB
    const mockEvaluateFn = vi.fn().mockResolvedValue(makeMockEvaluatorResult({
      runId: realRunId,
      trialId: realTrialId,
      mergedScore: 0.85,
      deterministicScore: 0.78,
    }));

    const evaluator = new HypothesisResearchEvaluator({
      db: researchMgr.db,
      dataProvider: new FakeDataProvider(),
      marketProfile: new FakeMarketProfile(),
      hypothesisRepo: researchHypothesisRepo,
      walkForwardRepo: researchWfRepo,
      walkForwardEvaluator: { evaluate: mockEvaluateFn } as any,
    });

    const result = await evaluator.evaluate(hypothesisId, {
      rangeStart: NOW - 7 * 86_400_000,
      rangeEnd: NOW,
    });

    expect(result.finalStatus).toBe(HypothesisEvaluationStatus.Completed);
    expect(result.evaluation.hypothesisGraphId).toBe(hypothesisId);

    // Verify evaluation exists in research DB
    expect(researchHypothesisRepo.countEvaluations()).toBe(1);
    expect(researchHypothesisRepo.getEvaluationByHypothesisId(hypothesisId)).not.toBeNull();

    // Verify runtime DB has no evaluations
    const runtimeHypothesisRepo = new HypothesisRepository(runtimeMgr.db);
    expect(runtimeHypothesisRepo.countEvaluations()).toBe(0);
    expect(runtimeHypothesisRepo.count()).toBe(0);
  });

  it('evaluation can be pruned before replay start when the overnight candidate budget is exhausted', async () => {
    const researchHypothesisRepo = new HypothesisRepository(researchMgr.db);
    const researchWfRepo = new WalkForwardRepository(researchMgr.db);

    const hypothesisId = seedHypothesis(researchHypothesisRepo);
    const mockEvaluateFn = vi.fn();

    const evaluator = new HypothesisResearchEvaluator({
      db: researchMgr.db,
      dataProvider: new FakeDataProvider(),
      marketProfile: new FakeMarketProfile(),
      hypothesisRepo: researchHypothesisRepo,
      walkForwardRepo: researchWfRepo,
      walkForwardEvaluator: { evaluate: mockEvaluateFn } as any,
    });

    const result = await evaluator.evaluate(
      hypothesisId,
      { rangeStart: NOW - 7 * 86_400_000, rangeEnd: NOW },
      { maxAcceptedCandidates: 1 },
      { completedEvaluations: 1 },
    );

    expect(result.finalStatus).toBe(HypothesisEvaluationStatus.Cancelled);
    expect(result.rationale).toContain('candidate budget exhausted');
    expect(mockEvaluateFn).not.toHaveBeenCalled();

    const persisted = researchHypothesisRepo.getEvaluationByHypothesisId(hypothesisId);
    expect(persisted?.status).toBe(HypothesisEvaluationStatus.Cancelled);
    expect(persisted?.outcomeDetail).toBe('pre_evaluation_budget_exhausted');
  });

  // -----------------------------------------------------------------------
  // Test 3: Research DB path is persisted in audit metadata
  // -----------------------------------------------------------------------

  it('overnight run row contains the explicit research DB path', () => {
    const researchRepo = new OvernightRunRepo(researchMgr.db);
    const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
    const orchestrator = new OvernightOrchestrator(researchRepo, clock);

    const result = orchestrator.tryStart(
      'audit-metadata-run',
      tmpDir,
      CLOSED_AFTER,
      researchDbPath,
    );

    expect(result.accepted).toBe(true);
    expect(result.run.workspacePath).toBe(tmpDir);
    expect(result.run.researchDbPath).toBe(researchDbPath);

    const persisted = orchestrator.getRun(result.run.id);
    expect(persisted).not.toBeNull();
    expect(persisted!.researchDbPath).toBe(researchDbPath);
  });

  // -----------------------------------------------------------------------
  // Test 4: Refused overnight run still records research DB path
  // -----------------------------------------------------------------------

  it('refused run persists researchDbPath for audit trail', () => {
    const researchRepo = new OvernightRunRepo(researchMgr.db);
    const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
    const orchestrator = new OvernightOrchestrator(researchRepo, clock);
    const regularTime = indiaTime(2025, 1, 6, 12, 0, 0);

    const result = orchestrator.tryStart(
      'refused-audit-run',
      tmpDir,
      regularTime,
      researchDbPath,
    );

    expect(result.accepted).toBe(false);
    expect(result.run.researchDbPath).toBe(researchDbPath);
    expect(result.run.refusalReason).toContain('Market is open');

    const persisted = orchestrator.getRun(result.run.id);
    expect(persisted!.researchDbPath).toBe(researchDbPath);
  });
});
