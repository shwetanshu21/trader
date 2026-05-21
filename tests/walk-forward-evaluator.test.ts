import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { WalkForwardRepository } from '../src/persistence/walk-forward-repo.js';
import { ReplaySessionRepository } from '../src/persistence/replay-session-repo.js';
import { WalkForwardEvaluator, WalkForwardInterruptionError, type WalkForwardTrialConfig } from '../src/replay/walk-forward-evaluator.js';
import { FixtureHistoricalDataProvider } from '../src/replay/historical-data-provider.js';
import { WalkForwardStatus, type WalkForwardWindowMetricsEnvelope } from '../src/replay/walk-forward-types.js';
import { ReplayFidelity } from '../src/replay/types.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';
import { ProposalEngine } from '../src/proposals/proposal-engine.js';
import { LLMStatus, type BoundedCandidate, type ProposalEngineConfig } from '../src/types/runtime.js';

const DAY_MS = 86_400_000;

const candidates: BoundedCandidate[] = [
  {
    exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 738561, side: 'buy',
    lastPrice: 2450.5, bid: 2450, ask: 2451, volume: 1_250_000, instrumentType: 'EQ', lotSize: 1, tickSize: 0.05,
    expiry: null, strike: null, freezeQuantity: null,
  },
  {
    exchange: 'NSE', tradingsymbol: 'TCS', instrumentToken: 2953217, side: 'buy',
    lastPrice: 3890, bid: 3889.5, ask: 3890.5, volume: 850_000, instrumentType: 'EQ', lotSize: 1, tickSize: 0.05,
    expiry: null, strike: null, freezeQuantity: null,
  },
];

const trialConfigs: WalkForwardTrialConfig[] = [
  { label: 'Config A', params: { maxCandidates: 3 } },
  { label: 'Config B', params: { maxCandidates: 5 } },
];

const tmpDirs: string[] = [];
const originalFetch = globalThis.fetch;

function createDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-evaluator-'));
  tmpDirs.push(dir);
  return path.join(dir, 'walk-forward.db');
}

function makeEngineConfig(overrides?: Partial<ProposalEngineConfig>): ProposalEngineConfig {
  return {
    providerMode: 'custom',
    providerUrl: 'https://llm.example.test/rank',
    timeoutMs: 1000,
    maxProposalsPerTick: 5,
    ...overrides,
  };
}

function createEvaluator(options?: {
  dbPath?: string;
  executionResolutionMinutes?: number;
  proposalEngine?: ProposalEngine;
}): {
  dbManager: DatabaseManager;
  repo: WalkForwardRepository;
  evaluator: WalkForwardEvaluator;
  rangeStart: number;
  rangeEnd: number;
  dataProvider: FixtureHistoricalDataProvider;
} {
  const dbManager = new DatabaseManager(options?.dbPath ?? createDbPath());
  const repo = new WalkForwardRepository(dbManager.db);
  const rangeEnd = Date.UTC(2025, 0, 31);
  const rangeStart = rangeEnd - 14 * DAY_MS;
  const dataProvider = new FixtureHistoricalDataProvider({
    candidates,
    rangeStart,
    rangeEnd,
    priceDrift: 0.001,
    executionResolutionMinutes: options?.executionResolutionMinutes ?? null,
  });
  const evaluator = new WalkForwardEvaluator({
    db: dbManager.db,
    marketProfile: INDIA_NSE_EQ_MARKET,
    dataProvider,
    proposalEngine: options?.proposalEngine,
  });

  return { dbManager, repo, evaluator, rangeStart, rangeEnd, dataProvider };
}

function parseWindowMetrics(metricsJson: string | null): WalkForwardWindowMetricsEnvelope {
  expect(metricsJson).toBeTruthy();
  return JSON.parse(metricsJson!) as WalkForwardWindowMetricsEnvelope;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('WalkForwardEvaluator', () => {
  it('writes durable progress snapshots and persists cadence override into replay sessions', async () => {
    const cwd = process.cwd();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-progress-'));
    tmpDirs.push(workDir);
    process.chdir(workDir);

    try {
      const ctx = createEvaluator();

      const result = await ctx.evaluator.evaluate({
        rangeStart: ctx.rangeStart,
        rangeEnd: ctx.rangeEnd,
        windowSizeMs: 4 * DAY_MS,
        stepSizeMs: 2 * DAY_MS,
        inSampleRatio: 0.75,
        label: 'progress-proof',
        trialConfigs: [{ label: 'Config A', params: { maxCandidates: 3 } }],
        cadenceMinutes: 30,
      });

      const progressPath = path.join(workDir, 'data', 'artifacts', 'walk-forward', '1', 'progress.json');
      const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8')) as {
        status: string;
        checkpointCount: number;
        completedTrialCount: number;
        activeTrialIndex: number | null;
        activeWindowIndex: number | null;
      };

      expect(progress.status).toBe(WalkForwardStatus.Completed);
      expect(progress.checkpointCount).toBe(1);
      expect(progress.completedTrialCount).toBe(1);
      expect(progress.activeTrialIndex).toBeNull();
      expect(progress.activeWindowIndex).toBeNull();

      const firstEnvelope = parseWindowMetrics(result.trials[0].windowEvidence[0].metricsJson);
      const replaySessionRepo = new ReplaySessionRepository(ctx.dbManager.db);
      const replaySession = replaySessionRepo.getSession(firstEnvelope.replayEvidence.replaySessionId);
      expect(replaySession?.cadenceMinutes).toBe(30);

      ctx.dbManager.close();
    } finally {
      process.chdir(cwd);
    }
  });

  it('checkpoints persisted trials and resumes an interrupted run without duplicating completed work', async () => {
    const cwd = process.cwd();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-resume-'));
    tmpDirs.push(workDir);
    process.chdir(workDir);

    try {
      const dbPath = createDbPath();
      const first = createEvaluator({ dbPath });

      await expect(first.evaluator.evaluate({
        rangeStart: first.rangeStart,
        rangeEnd: first.rangeEnd,
        windowSizeMs: 4 * DAY_MS,
        stepSizeMs: 2 * DAY_MS,
        inSampleRatio: 0.75,
        label: 'resume-proof',
        trialConfigs,
        stopAfterTrialCount: 1,
      })).rejects.toBeInstanceOf(WalkForwardInterruptionError);

      const interruptedRun = first.repo.getRun(1);
      expect(interruptedRun?.status).toBe(WalkForwardStatus.Interrupted);
      const interruptedProgress = JSON.parse(
        fs.readFileSync(path.join(workDir, 'data', 'artifacts', 'walk-forward', '1', 'progress.json'), 'utf8'),
      ) as { status: string; lastCompletedTrialIndex: number | null; completedTrialCount: number };
      expect(interruptedProgress.status).toBe(WalkForwardStatus.Interrupted);
      expect(interruptedProgress.lastCompletedTrialIndex).toBe(0);
      expect(interruptedProgress.completedTrialCount).toBe(1);
      expect(first.repo.countTrialsForRun(1)).toBe(1);
      expect(first.repo.countCheckpoints(1)).toBe(1);
      expect(first.repo.getLatestCheckpoint(1)?.lastCompletedTrialIndex).toBe(0);

      const firstTrial = first.repo.getTrialForRunByIndex(1, 0);
      expect(firstTrial?.mergedScore).toBeGreaterThanOrEqual(0);
      const firstTrialEvidence = first.repo.getTrialWindowEvidence(firstTrial!.id);
      const firstEnvelope = parseWindowMetrics(firstTrialEvidence[0].metricsJson);
      expect(firstEnvelope.source).toBe('replay-session');
      expect(firstEnvelope.replayEvidence.replaySessionId).toBeGreaterThan(0);
      expect(firstEnvelope.replayEvidence.checkpointCount).toBeGreaterThan(0);
      expect(firstEnvelope.replayEvidence.strategyRunCount).toBeGreaterThan(0);
      first.dbManager.close();

      const resumed = createEvaluator({ dbPath });
      const result = await resumed.evaluator.evaluate({
        rangeStart: resumed.rangeStart,
        rangeEnd: resumed.rangeEnd,
        windowSizeMs: 4 * DAY_MS,
        stepSizeMs: 2 * DAY_MS,
        inSampleRatio: 0.75,
        label: 'resume-proof',
        trialConfigs,
        resumeRunId: 1,
      });

      expect(result.run.id).toBe(1);
      expect(result.run.status).toBe(WalkForwardStatus.Completed);
      expect(resumed.repo.countTrialsForRun(1)).toBe(2);
      expect(resumed.repo.getTrialsForRunByIndex(1).map(trial => trial.trialIndex)).toEqual([0, 1]);
      expect(resumed.repo.countCheckpoints(1)).toBe(2);
      expect(resumed.repo.getLatestCheckpoint(1)?.lastCompletedTrialIndex).toBe(1);
      expect(resumed.repo.getWindowsForRun(1).every(window => window.status === 'completed')).toBe(true);
      resumed.dbManager.close();
    } finally {
      process.chdir(cwd);
    }
  });

  it('persists replay-backed evidence handles for every trial window', async () => {
    const ctx = createEvaluator({ executionResolutionMinutes: 1 });

    const result = await ctx.evaluator.evaluate({
      rangeStart: ctx.rangeStart,
      rangeEnd: ctx.rangeEnd,
      windowSizeMs: 4 * DAY_MS,
      stepSizeMs: 2 * DAY_MS,
      inSampleRatio: 0.75,
      label: 'replay-evidence-proof',
      trialConfigs,
    });

    expect(result.run.status).toBe(WalkForwardStatus.Completed);
    expect(ctx.dataProvider.getEffectiveFidelity({ index: 0, timestamp: ctx.rangeStart, fidelity: ReplayFidelity.Synthetic })).toBe(ReplayFidelity.Full);
    expect(ctx.dataProvider.getResolutionMetadata()).toEqual({
      screeningCadenceMinutes: 5,
      executionResolutionMinutes: 1,
      supportsFineGrainedExecution: true,
    });

    for (const trial of result.trials) {
      expect(trial.windowEvidence.length).toBeGreaterThan(0);
      for (const evidence of trial.windowEvidence) {
        const envelope = parseWindowMetrics(evidence.metricsJson);
        if (envelope.replayEvidence.executionTruth.available) {
          expect(envelope.source).toBe('replay-paper-execution');
          expect(envelope.replayEvidence.executionTruth.tradeCount).toBeGreaterThan(0);
        } else {
          expect(envelope.source).toBe('replay-session');
        }
        expect(envelope.replayEvidence.replaySessionId).toBeGreaterThan(0);
        expect(envelope.replayEvidence.replayStatus).toBe('completed');
        // Verify cap evidence is present in replay evidence
        expect(typeof envelope.replayEvidence.maxCandidates).toBe('number');
        expect(typeof envelope.replayEvidence.preCapCandidateCount).toBe('number');
        // preCapCandidateCount is 0 only when the session has no checkpoints
        // (empty tick range, e.g. weekend). Otherwise aggregate should be positive.
        if (envelope.replayEvidence.checkpointCount > 0) {
          expect(envelope.replayEvidence.preCapCandidateCount).toBeGreaterThan(0);
        }
        if (envelope.replayEvidence.topCandidateCount > 0) {
          expect(envelope.replayEvidence.firstStrategyRunId).toBeGreaterThan(0);
          expect(envelope.replayEvidence.lastStrategyRunId).toBeGreaterThan(0);
        } else {
          expect(envelope.replayEvidence.firstStrategyRunId).toBeNull();
          expect(envelope.replayEvidence.lastStrategyRunId).toBeNull();
        }
      }
    }

    ctx.dbManager.close();
  });

  it('persists skipped LLM provenance when the trial requests LLM but no provider engine is wired', async () => {
    const ctx = createEvaluator();

    const result = await ctx.evaluator.evaluate({
      rangeStart: ctx.rangeStart,
      rangeEnd: ctx.rangeEnd,
      windowSizeMs: 4 * DAY_MS,
      stepSizeMs: 2 * DAY_MS,
      inSampleRatio: 0.75,
      label: 'llm-skipped-proof',
      trialConfigs: [{
        label: 'LLM requested but disabled',
        params: { maxCandidates: 3 },
        llmConfig: { enabled: true, maxCandidates: 3 },
      }],
    });

    expect(result.trials).toHaveLength(1);
    expect(result.trials[0].llmStatus).toBe(LLMStatus.Skipped);
    expect(result.trials[0].llmScore).toBeNull();

    const skipCounts = result.trials[0].windowEvidence
      .map(evidence => parseWindowMetrics(evidence.metricsJson).replayEvidence.llmStatusCounts.skipped ?? 0);
    expect(skipCounts.some(count => count > 0)).toBe(true);

    ctx.dbManager.close();
  });

  it('persists provider-error LLM provenance from replay-backed evidence', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => new Response('Server Error', { status: 500 }),
    );
    const proposalEngine = new ProposalEngine(makeEngineConfig());
    const ctx = createEvaluator({ proposalEngine });

    const result = await ctx.evaluator.evaluate({
      rangeStart: ctx.rangeStart,
      rangeEnd: ctx.rangeEnd,
      windowSizeMs: 4 * DAY_MS,
      stepSizeMs: 2 * DAY_MS,
      inSampleRatio: 0.75,
      label: 'llm-error-proof',
      trialConfigs: [{
        label: 'LLM provider 5xx',
        params: { maxCandidates: 3 },
        llmConfig: { enabled: true, maxCandidates: 3 },
      }],
    });

    expect(result.trials[0].llmStatus).toBe(LLMStatus.Error);
    expect(result.trials[0].llmScore).toBeNull();
    expect(result.rankedCandidates[0].llmStatus).toBe(LLMStatus.Error);

    const errorCounts = result.trials[0].windowEvidence
      .map(evidence => parseWindowMetrics(evidence.metricsJson).replayEvidence.llmStatusCounts.error ?? 0);
    expect(errorCounts.some(count => count > 0)).toBe(true);
    expect(result.trials[0].windowEvidence.every(evidence =>
      parseWindowMetrics(evidence.metricsJson).replayEvidence.pluginErrorCount >= 0,
    )).toBe(true);

    ctx.dbManager.close();
  });

  it('persists degraded LLM provenance when the provider returns empty rankings', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => new Response(JSON.stringify({ someUnexpectedField: 'value' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const proposalEngine = new ProposalEngine(makeEngineConfig());
    const ctx = createEvaluator({ proposalEngine });

    const result = await ctx.evaluator.evaluate({
      rangeStart: ctx.rangeStart,
      rangeEnd: ctx.rangeEnd,
      windowSizeMs: 4 * DAY_MS,
      stepSizeMs: 2 * DAY_MS,
      inSampleRatio: 0.75,
      label: 'llm-degraded-proof',
      trialConfigs: [{
        label: 'LLM empty rankings',
        params: { maxCandidates: 3 },
        llmConfig: { enabled: true, maxCandidates: 3 },
      }],
    });

    expect(result.trials[0].llmStatus).toBe(LLMStatus.Degraded);
    expect(result.trials[0].llmScore).toBeNull();
    expect(result.rankedCandidates[0].llmStatus).toBe(LLMStatus.Degraded);

    const degradedCounts = result.trials[0].windowEvidence
      .map(evidence => parseWindowMetrics(evidence.metricsJson).replayEvidence.llmStatusCounts.degraded ?? 0);
    expect(degradedCounts.some(count => count > 0)).toBe(true);
    expect(result.trials[0].windowEvidence.every(evidence =>
      parseWindowMetrics(evidence.metricsJson).replayEvidence.replaySessionId > 0,
    )).toBe(true);

    ctx.dbManager.close();
  });
});
