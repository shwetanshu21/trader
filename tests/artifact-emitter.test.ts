// ── ArtifactEmitter unit tests ──
//
// Covers:
//   - Winner artifact JSON schema and content
//   - Diagnostics artifact JSON schema and content
//   - Artifact file paths match expected pattern
//   - HOLD (no_winner) artifact output
//   - Evidence fidelity field population
//   - Aggregate metrics inclusion
//   - File system cleanup behavior

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArtifactEmitter } from '../src/replay/artifact-emitter.js';
import {
  WalkForwardStatus,
  WalkForwardSelectionStrategy,
  WalkForwardSelectionResult,
  WalkForwardWindowType,
  type WalkForwardRunRow,
  type WalkForwardRankedCandidate,
  type WalkForwardSelectionConfig,
  type WalkForwardSelectionOutput,
  type WalkForwardCandidateComparison,
  type WalkForwardWinnerArtifact,
  type WalkForwardDiagnosticsArtifact,
} from '../src/replay/walk-forward-types.js';
import type { HistoricalDataProvider, ReplayTick } from '../src/replay/historical-data-provider.js';
import { ReplayFidelity } from '../src/replay/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const NOW = 1736025600000; // 2025-01-05T00:00:00.000Z

class FakeDataProvider implements HistoricalDataProvider {
  readonly label = 'test-fixture-v1';
  private readonly _hasData: boolean;
  private readonly _fidelity: string;

  constructor(options?: { hasData?: boolean; fidelity?: string }) {
    this._hasData = options?.hasData ?? true;
    this._fidelity = options?.fidelity ?? 'fixture-v1';
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
}

function sampleRun(overrides?: Partial<WalkForwardRunRow>): WalkForwardRunRow {
  return {
    id: 42,
    label: '2025-01 walk-forward v1',
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    replaySessionId: null,
    windowCount: 5,
    totalTrials: 4,
    status: WalkForwardStatus.Completed,
    createdAt: NOW,
    startedAt: NOW + 100,
    completedAt: NOW + 5000,
    ...overrides,
  };
}

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
    llmScore: score > 0.8 ? 0.88 : null,
    windowCount: 3,
    ...overrides,
  };
}

function sampleComparison(
  trialId: number,
  rank: number,
  outcome: 'winner' | 'runner_up' | 'disqualified',
  overrides?: Partial<WalkForwardCandidateComparison>,
): WalkForwardCandidateComparison {
  return {
    trialId,
    rank,
    label: `Config ${String.fromCharCode(64 + trialId)}`,
    mergedScore: outcome === 'winner' ? 0.92 : 0.75,
    outcome,
    reasons: outcome === 'winner'
      ? ['Top-ranked qualifying candidate by selection criteria']
      : ['Merged score below threshold'],
    evidenceScores: {
      avgSharpe: 1.5,
      maxDrawdown: 10.0,
      avgWinRate: 0.65,
      outOfSampleWindowCount: 2,
    },
    ...overrides,
  };
}

function sampleSelectionOutput(
  overrides?: Partial<WalkForwardSelectionOutput>,
): WalkForwardSelectionOutput {
  return {
    result: WalkForwardSelectionResult.Selected,
    selectedTrialId: 1,
    selectionStrategy: WalkForwardSelectionStrategy.Composite,
    selectionConfigJson: JSON.stringify({
      strategy: 'composite',
      minMergedScore: 0.7,
      minSharpeRatio: 1.0,
      maxDrawdown: 20,
    }),
    rationale: 'Selected Config A (rank 1) via composite selection with merged score 0.9200 across 3 windows.',
    comparisons: [
      sampleComparison(1, 1, 'winner'),
      sampleComparison(2, 2, 'runner_up', { mergedScore: 0.78 }),
    ],
    ...overrides,
  };
}

const sampleSelectionConfig: WalkForwardSelectionConfig = {
  strategy: WalkForwardSelectionStrategy.Composite,
  minMergedScore: 0.7,
  minSharpeRatio: 1.0,
  maxDrawdown: 20,
};

const sampleAggregateMetrics = {
  scoreStability: 0.85,
  topKOverlap: 0.75,
  llmConsultationRate: 0.5,
  llmDivergence: 0.12,
};

const sampleTradeLog: WalkForwardDiagnosticsArtifact['tradeLog'] = [
  {
    trialId: 1,
    windowIndex: 0,
    windowType: WalkForwardWindowType.InSample,
    tradeCount: 12,
    totalReturn: 0.92,
    winRate: 0.66,
    sharpeRatio: 1.5,
    maxDrawdown: 0.08,
  },
  {
    trialId: 1,
    windowIndex: 0,
    windowType: WalkForwardWindowType.OutOfSample,
    tradeCount: 6,
    totalReturn: 0.81,
    winRate: 0.5,
    sharpeRatio: 1.2,
    maxDrawdown: 0.12,
  },
];

const sampleRankedCandidates: WalkForwardRankedCandidate[] = [
  sampleCandidate(1, 1, 0.92),
  sampleCandidate(2, 2, 0.78),
  sampleCandidate(3, 3, 0.65),
];

// ---------------------------------------------------------------------------
// ArtifactEmitter
// ---------------------------------------------------------------------------

describe('ArtifactEmitter', () => {
  const artifactRoot = 'data/artifacts/walk-forward';
  const testRunId = 42;
  const testArtifactDir = path.join(artifactRoot, String(testRunId));

  let emitter: ArtifactEmitter;
  let dataProvider: HistoricalDataProvider;

  beforeEach(() => {
    dataProvider = new FakeDataProvider();
    emitter = new ArtifactEmitter({ dataProvider });

    // Clean up any leftover artifacts
    if (fs.existsSync(testArtifactDir)) {
      fs.rmSync(testArtifactDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up artifacts after each test
    if (fs.existsSync(testArtifactDir)) {
      fs.rmSync(testArtifactDir, { recursive: true, force: true });
    }
  });

  describe('emitWinnerArtifacts', () => {
    it('creates artifact directory and writes winner.json', () => {
      const run = sampleRun();
      const selection = sampleSelectionOutput();

      const paths = emitter.emitWinnerArtifacts({
        run,
        selection,
        selectionConfig: sampleSelectionConfig,
        rankedCandidates: sampleRankedCandidates,
        aggregateMetrics: sampleAggregateMetrics,
        tradeLog: sampleTradeLog,
        dataProvider,
        windowCount: 5,
        trialCount: 4,
        oosWindowCount: 3,
        selectedAt: NOW + 5000,
      });

      // Verify directory was created
      expect(fs.existsSync(testArtifactDir)).toBe(true);

      // Verify winner.json exists and is valid JSON
      expect(fs.existsSync(paths.winnerPath)).toBe(true);
      expect(paths.winnerPath).toContain('winner.json');

      const winnerContent = JSON.parse(
        fs.readFileSync(paths.winnerPath, 'utf-8'),
      ) as WalkForwardWinnerArtifact;

      expect(winnerContent.schemaVersion).toBe(1);
      expect(winnerContent.artifactType).toBe('winner-selection');
      expect(winnerContent.runId).toBe(42);
      expect(winnerContent.runLabel).toBe('2025-01 walk-forward v1');
      expect(winnerContent.result).toBe('selected');
      expect(winnerContent.winner).not.toBeNull();
      expect(winnerContent.winner!.trialId).toBe(1);
      expect(winnerContent.winner!.trialLabel).toBe('Config A');
      expect(winnerContent.winner!.mergedScore).toBe(0.92);
      expect(winnerContent.rationale).toContain('Config A');
      expect(winnerContent.comparisons.length).toBe(2);
      expect(winnerContent.comparisons[0].outcome).toBe('winner');
      expect(winnerContent.comparisons[1].outcome).toBe('runner_up');
    });

    it('writes diagnostics.json with correct schema', () => {
      const run = sampleRun();
      const selection = sampleSelectionOutput();

      const paths = emitter.emitWinnerArtifacts({
        run,
        selection,
        selectionConfig: sampleSelectionConfig,
        rankedCandidates: sampleRankedCandidates,
        aggregateMetrics: sampleAggregateMetrics,
        tradeLog: sampleTradeLog,
        dataProvider,
        windowCount: 5,
        trialCount: 4,
        oosWindowCount: 3,
        selectedAt: NOW + 5000,
        maxCandidates: 3,
        preCapCandidateCount: 42,
      });

      expect(fs.existsSync(paths.diagnosticsPath)).toBe(true);
      expect(paths.diagnosticsPath).toContain('diagnostics.json');

      const diagnostics = JSON.parse(
        fs.readFileSync(paths.diagnosticsPath, 'utf-8'),
      ) as WalkForwardDiagnosticsArtifact;

      expect(diagnostics.schemaVersion).toBe(1);
      expect(diagnostics.artifactType).toBe('winner-diagnostics');
      expect(diagnostics.runId).toBe(42);
      expect(diagnostics.runLabel).toBe('2025-01 walk-forward v1');

      // Selection summary
      expect(diagnostics.selection.result).toBe('selected');
      expect(diagnostics.selection.rationale).toContain('Config A');
      expect(diagnostics.selection.comparisonsCount).toBe(2);

      // Aggregate metrics
      expect(diagnostics.aggregateMetrics.scoreStability).toBe(0.85);
      expect(diagnostics.aggregateMetrics.topKOverlap).toBe(0.75);
      expect(diagnostics.aggregateMetrics.llmConsultationRate).toBe(0.5);
      expect(diagnostics.aggregateMetrics.llmDivergence).toBe(0.12);

      // Ranked candidates
      expect(diagnostics.rankedCandidates.length).toBe(3);
      expect(diagnostics.rankedCandidates[0].rank).toBe(1);
      expect(diagnostics.rankedCandidates[0].mergedScore).toBe(0.92);
      expect(diagnostics.rankedCandidates[2].rank).toBe(3);

      // Evidence fidelity
      expect(diagnostics.evidenceFidelity.providerLabel).toBe('test-fixture-v1');
      expect(diagnostics.evidenceFidelity.hasData).toBe(true);
      expect(diagnostics.evidenceFidelity.windowCount).toBe(5);
      expect(diagnostics.evidenceFidelity.trialCount).toBe(4);
      expect(diagnostics.evidenceFidelity.outOfSampleWindows).toBe(3);
      // Cap evidence
      expect(diagnostics.evidenceFidelity.maxCandidates).toBe(3);
      expect(diagnostics.evidenceFidelity.preCapCandidateCount).toBe(42);
    });

    it('includes selection config in winner artifact', () => {
      const run = sampleRun();
      const selection = sampleSelectionOutput();

      const paths = emitter.emitWinnerArtifacts({
        run,
        selection,
        selectionConfig: sampleSelectionConfig,
        rankedCandidates: sampleRankedCandidates,
        aggregateMetrics: sampleAggregateMetrics,
        tradeLog: sampleTradeLog,
        dataProvider,
        windowCount: 5,
        trialCount: 4,
        oosWindowCount: 3,
        selectedAt: NOW + 5000,
      });

      const winnerContent = JSON.parse(
        fs.readFileSync(paths.winnerPath, 'utf-8'),
      ) as WalkForwardWinnerArtifact;

      expect(winnerContent.selectionConfig.strategy).toBe('composite');
      expect(winnerContent.selectionConfig.minMergedScore).toBe(0.7);
      expect(winnerContent.selectionConfig.minSharpeRatio).toBe(1.0);
      expect(winnerContent.selectionConfig.maxDrawdown).toBe(20);
    });

    it('includes ISO timestamp in winner artifact', () => {
      const run = sampleRun();
      const selection = sampleSelectionOutput();

      const paths = emitter.emitWinnerArtifacts({
        run,
        selection,
        selectionConfig: sampleSelectionConfig,
        rankedCandidates: sampleRankedCandidates,
        aggregateMetrics: sampleAggregateMetrics,
        tradeLog: sampleTradeLog,
        dataProvider,
        windowCount: 5,
        trialCount: 4,
        oosWindowCount: 3,
        selectedAt: NOW + 5000,
      });

      const winnerContent = JSON.parse(
        fs.readFileSync(paths.winnerPath, 'utf-8'),
      ) as WalkForwardWinnerArtifact;

      expect(winnerContent.selectionTimestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    });

    it('returns correct artifact paths', () => {
      const run = sampleRun();
      const selection = sampleSelectionOutput();

      const paths = emitter.emitWinnerArtifacts({
        run,
        selection,
        selectionConfig: sampleSelectionConfig,
        rankedCandidates: sampleRankedCandidates,
        aggregateMetrics: sampleAggregateMetrics,
        tradeLog: sampleTradeLog,
        dataProvider,
        windowCount: 5,
        trialCount: 4,
        oosWindowCount: 3,
        selectedAt: NOW + 5000,
      });

      expect(paths.winnerPath).toBe(
        path.join(artifactRoot, '42', 'winner.json'),
      );
      expect(paths.diagnosticsPath).toBe(
        path.join(artifactRoot, '42', 'diagnostics.json'),
      );
    });

    it('handles multiple run IDs with separate directories', () => {
      const run1 = sampleRun({ id: 100, label: 'Run 100' });
      const run2 = sampleRun({ id: 200, label: 'Run 200' });

      const paths1 = emitter.emitWinnerArtifacts({
        run: run1,
        selection: sampleSelectionOutput({ selectedTrialId: 1 }),
        selectionConfig: sampleSelectionConfig,
        rankedCandidates: [sampleCandidate(1, 1, 0.90)],
        aggregateMetrics: sampleAggregateMetrics,
        tradeLog: sampleTradeLog,
        dataProvider,
        windowCount: 3,
        trialCount: 2,
        oosWindowCount: 2,
        selectedAt: NOW,
      });

      const paths2 = emitter.emitWinnerArtifacts({
        run: run2,
        selection: sampleSelectionOutput({ selectedTrialId: 2 }),
        selectionConfig: sampleSelectionConfig,
        rankedCandidates: [sampleCandidate(2, 1, 0.85)],
        aggregateMetrics: sampleAggregateMetrics,
        tradeLog: sampleTradeLog,
        dataProvider,
        windowCount: 4,
        trialCount: 3,
        oosWindowCount: 2,
        selectedAt: NOW,
      });

      expect(paths1.winnerPath).toContain('/100/winner.json');
      expect(paths2.winnerPath).toContain('/200/winner.json');
      expect(fs.existsSync(paths1.winnerPath)).toBe(true);
      expect(fs.existsSync(paths2.winnerPath)).toBe(true);
    });
  });

  describe('HOLD (no_winner) artifacts', () => {
    it('produces winner artifact with null winner for no_winner result', () => {
      const run = sampleRun();
      const selection = sampleSelectionOutput({
        result: WalkForwardSelectionResult.NoWinner,
        selectedTrialId: null,
        rationale: 'No trial exceeded merged score threshold of 0.8.',
        comparisons: [],
      });

      const paths = emitter.emitWinnerArtifacts({
        run,
        selection,
        selectionConfig: {
          strategy: WalkForwardSelectionStrategy.Threshold,
          minMergedScore: 0.8,
        },
        rankedCandidates: sampleRankedCandidates,
        aggregateMetrics: sampleAggregateMetrics,
        tradeLog: sampleTradeLog,
        dataProvider,
        windowCount: 5,
        trialCount: 4,
        oosWindowCount: 3,
        selectedAt: NOW + 5000,
      });

      const winnerContent = JSON.parse(
        fs.readFileSync(paths.winnerPath, 'utf-8'),
      ) as WalkForwardWinnerArtifact;

      expect(winnerContent.result).toBe('no_winner');
      expect(winnerContent.winner).toBeNull();
      expect(winnerContent.rationale).toBe(
        'No trial exceeded merged score threshold of 0.8.',
      );
      expect(winnerContent.comparisons).toEqual([]);
    });

    it('includes diagnostics with no_winner selection summary', () => {
      const run = sampleRun();
      const selection = sampleSelectionOutput({
        result: WalkForwardSelectionResult.NoWinner,
        selectedTrialId: null,
        rationale: 'No candidate passed composite criteria.',
        comparisons: [],
      });

      const paths = emitter.emitWinnerArtifacts({
        run,
        selection,
        selectionConfig: sampleSelectionConfig,
        rankedCandidates: sampleRankedCandidates,
        aggregateMetrics: sampleAggregateMetrics,
        tradeLog: sampleTradeLog,
        dataProvider,
        windowCount: 5,
        trialCount: 4,
        oosWindowCount: 3,
        selectedAt: NOW + 5000,
      });

      const diagnostics = JSON.parse(
        fs.readFileSync(paths.diagnosticsPath, 'utf-8'),
      ) as WalkForwardDiagnosticsArtifact;

      expect(diagnostics.selection.result).toBe('no_winner');
      expect(diagnostics.selection.comparisonsCount).toBe(0);
    });
  });

  describe('evidence fidelity', () => {
    it('populates evidenceFidelity from data provider', () => {
      const run = sampleRun();
      const selection = sampleSelectionOutput();

      const paths = emitter.emitWinnerArtifacts({
        run,
        selection,
        selectionConfig: sampleSelectionConfig,
        rankedCandidates: sampleRankedCandidates,
        aggregateMetrics: sampleAggregateMetrics,
        tradeLog: sampleTradeLog,
        dataProvider,
        windowCount: 5,
        trialCount: 4,
        oosWindowCount: 3,
        selectedAt: NOW + 5000,
      });

      const diagnostics = JSON.parse(
        fs.readFileSync(paths.diagnosticsPath, 'utf-8'),
      ) as WalkForwardDiagnosticsArtifact;

      expect(diagnostics.evidenceFidelity.providerLabel).toBe('test-fixture-v1');
      expect(diagnostics.evidenceFidelity.hasData).toBe(true);
    });

    it('reflects provider hasData=false when provider reports no data', () => {
      const noDataProvider = new FakeDataProvider({ hasData: false });
      const emitterNoData = new ArtifactEmitter({ dataProvider: noDataProvider });

      const run = sampleRun({ completedAt: NOW + 5000 });
      const selection = sampleSelectionOutput();

      const paths = emitterNoData.emitWinnerArtifacts({
        run,
        selection,
        selectionConfig: sampleSelectionConfig,
        rankedCandidates: sampleRankedCandidates,
        aggregateMetrics: sampleAggregateMetrics,
        dataProvider: noDataProvider,
        windowCount: 5,
        trialCount: 4,
        oosWindowCount: 3,
        selectedAt: NOW + 5000,
      });

      const diagnostics = JSON.parse(
        fs.readFileSync(paths.diagnosticsPath, 'utf-8'),
      ) as WalkForwardDiagnosticsArtifact;

      expect(diagnostics.evidenceFidelity.hasData).toBe(false);
    });
  });

  describe('file system behavior', () => {
    it('creates parent directories automatically', () => {
      const run = sampleRun();
      const selection = sampleSelectionOutput();

      const paths = emitter.emitWinnerArtifacts({
        run,
        selection,
        selectionConfig: sampleSelectionConfig,
        rankedCandidates: sampleRankedCandidates,
        aggregateMetrics: sampleAggregateMetrics,
        tradeLog: sampleTradeLog,
        dataProvider,
        windowCount: 5,
        trialCount: 4,
        oosWindowCount: 3,
        selectedAt: NOW + 5000,
      });

      expect(fs.existsSync(path.dirname(paths.winnerPath))).toBe(true);
    });

    it('writes valid JSON that parses correctly', () => {
      const run = sampleRun();
      const selection = sampleSelectionOutput();

      const paths = emitter.emitWinnerArtifacts({
        run,
        selection,
        selectionConfig: sampleSelectionConfig,
        rankedCandidates: sampleRankedCandidates,
        aggregateMetrics: sampleAggregateMetrics,
        tradeLog: sampleTradeLog,
        dataProvider,
        windowCount: 5,
        trialCount: 4,
        oosWindowCount: 3,
        selectedAt: NOW + 5000,
      });

      // Should parse without error
      expect(() => JSON.parse(fs.readFileSync(paths.winnerPath, 'utf-8'))).not.toThrow();
      expect(() => JSON.parse(fs.readFileSync(paths.diagnosticsPath, 'utf-8'))).not.toThrow();
    });

    it('overwrites existing artifacts on re-emission', () => {
      const run = sampleRun();
      const selection = sampleSelectionOutput();

      // First emission
      emitter.emitWinnerArtifacts({
        run,
        selection,
        selectionConfig: sampleSelectionConfig,
        rankedCandidates: sampleRankedCandidates,
        aggregateMetrics: sampleAggregateMetrics,
        tradeLog: sampleTradeLog,
        dataProvider,
        windowCount: 5,
        trialCount: 4,
        oosWindowCount: 3,
        selectedAt: NOW + 5000,
      });

      // Second emission with updated rationale
      const updatedSelection = sampleSelectionOutput({
        rationale: 'Updated: Config B selected after re-evaluation.',
        selectedTrialId: 2,
      });

      const paths = emitter.emitWinnerArtifacts({
        run,
        selection: updatedSelection,
        selectionConfig: sampleSelectionConfig,
        rankedCandidates: sampleRankedCandidates,
        aggregateMetrics: sampleAggregateMetrics,
        tradeLog: sampleTradeLog,
        dataProvider,
        windowCount: 5,
        trialCount: 4,
        oosWindowCount: 3,
        selectedAt: NOW + 6000,
      });

      const winnerContent = JSON.parse(
        fs.readFileSync(paths.winnerPath, 'utf-8'),
      ) as WalkForwardWinnerArtifact;

      expect(winnerContent.rationale).toContain('Updated');
      expect(winnerContent.winner!.trialId).toBe(2);
    });
  });
});
