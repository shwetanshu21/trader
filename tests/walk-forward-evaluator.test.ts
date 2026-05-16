import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { WalkForwardRepository } from '../src/persistence/walk-forward-repo.js';
import { WalkForwardEvaluator, WalkForwardInterruptionError, type WalkForwardTrialConfig } from '../src/replay/walk-forward-evaluator.js';
import { FixtureHistoricalDataProvider } from '../src/replay/historical-data-provider.js';
import { WalkForwardStatus } from '../src/replay/walk-forward-types.js';
import { ReplayFidelity } from '../src/replay/types.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';
import type { BoundedCandidate } from '../src/types/runtime.js';

const DAY_MS = 86_400_000;

const candidates: BoundedCandidate[] = [
  {
    exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 738561, side: 'buy',
    lastPrice: 2450.5, bid: 2450, ask: 2451, volume: 1_250_000, instrumentType: 'EQ', lotSize: 1, tickSize: 0.05,
  },
  {
    exchange: 'NSE', tradingsymbol: 'TCS', instrumentToken: 2953217, side: 'buy',
    lastPrice: 3890, bid: 3889.5, ask: 3890.5, volume: 850_000, instrumentType: 'EQ', lotSize: 1, tickSize: 0.05,
  },
];

const trialConfigs: WalkForwardTrialConfig[] = [
  { label: 'Config A', params: { maxCandidates: 3 } },
  { label: 'Config B', params: { maxCandidates: 5 } },
];

const tmpDirs: string[] = [];

function createDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-evaluator-'));
  tmpDirs.push(dir);
  return path.join(dir, 'walk-forward.db');
}

function createEvaluator(dbPath: string, executionResolutionMinutes?: number): {
  dbManager: DatabaseManager;
  repo: WalkForwardRepository;
  evaluator: WalkForwardEvaluator;
  rangeStart: number;
  rangeEnd: number;
  dataProvider: FixtureHistoricalDataProvider;
} {
  const dbManager = new DatabaseManager(dbPath);
  const repo = new WalkForwardRepository(dbManager.db);
  const rangeEnd = Date.UTC(2025, 0, 31);
  const rangeStart = rangeEnd - 14 * DAY_MS;
  const dataProvider = new FixtureHistoricalDataProvider({
    candidates,
    rangeStart,
    rangeEnd,
    priceDrift: 0.001,
    executionResolutionMinutes: executionResolutionMinutes ?? null,
  });
  const evaluator = new WalkForwardEvaluator({
    db: dbManager.db,
    marketProfile: INDIA_NSE_EQ_MARKET,
    dataProvider,
  });

  return { dbManager, repo, evaluator, rangeStart, rangeEnd, dataProvider };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('WalkForwardEvaluator', () => {
  it('checkpoints persisted trials and resumes an interrupted run without duplicating completed work', async () => {
    const dbPath = createDbPath();
    const first = createEvaluator(dbPath);

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
    expect(first.repo.countTrialsForRun(1)).toBe(1);
    expect(first.repo.countCheckpoints(1)).toBe(1);
    expect(first.repo.getLatestCheckpoint(1)?.lastCompletedTrialIndex).toBe(0);
    first.dbManager.close();

    const resumed = createEvaluator(dbPath);
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
  });

  it('carries fine-grained execution metadata through a full evaluation proof path', async () => {
    const dbPath = createDbPath();
    const ctx = createEvaluator(dbPath, 1);

    const result = await ctx.evaluator.evaluate({
      rangeStart: ctx.rangeStart,
      rangeEnd: ctx.rangeEnd,
      windowSizeMs: 4 * DAY_MS,
      stepSizeMs: 2 * DAY_MS,
      inSampleRatio: 0.75,
      label: 'fine-grained-proof',
      trialConfigs,
    });

    expect(result.run.status).toBe(WalkForwardStatus.Completed);
    expect(ctx.dataProvider.getEffectiveFidelity({ index: 0, timestamp: ctx.rangeStart, fidelity: ReplayFidelity.Synthetic })).toBe(ReplayFidelity.Full);
    expect(ctx.dataProvider.getResolutionMetadata()).toEqual({
      screeningCadenceMinutes: 5,
      executionResolutionMinutes: 1,
      supportsFineGrainedExecution: true,
    });
    ctx.dbManager.close();
  });
});
