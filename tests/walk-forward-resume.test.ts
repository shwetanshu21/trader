import { describe, expect, it } from 'vitest';

import { DatabaseManager } from '../src/persistence/sqlite.js';
import { WalkForwardRepository } from '../src/persistence/walk-forward-repo.js';
import { readWalkForwardResumeConfig } from '../src/replay/walk-forward-resume.js';
import { WalkForwardStatus } from '../src/replay/walk-forward-types.js';

describe('readWalkForwardResumeConfig', () => {
  it('parses durable resume metadata from the latest checkpoint', () => {
    const dbm = new DatabaseManager(':memory:');
    const repo = new WalkForwardRepository(dbm.db);
    const run = repo.insertRun({
      label: 'resume-seed',
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      replaySessionId: null,
      windowCount: 1,
      totalTrials: 1,
      status: WalkForwardStatus.Running,
      createdAt: 1,
      startedAt: 1,
      completedAt: null,
    });

    repo.saveCheckpoint({
      runId: run.id,
      completedTrialCount: 1,
      lastCompletedTrialIndex: 0,
      metadataJson: JSON.stringify({
        rangeStart: 100,
        rangeEnd: 200,
        windowSizeMs: 50,
        stepSizeMs: 25,
        inSampleRatio: 0.8,
        label: 'resume-seed',
        strategyId: 'india-nse-eq-v1',
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
        cadenceMinutes: 60,
        trialConfigs: [{ label: 'Config A', params: { maxCandidates: 3 } }],
      }),
      savedAt: 2,
    });

    expect(readWalkForwardResumeConfig(repo, run.id)).toEqual({
      rangeStart: 100,
      rangeEnd: 200,
      windowSizeMs: 50,
      stepSizeMs: 25,
      inSampleRatio: 0.8,
      label: 'resume-seed',
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      cadenceMinutes: 60,
      trialConfigs: [{ label: 'Config A', params: { maxCandidates: 3 } }],
    });

    dbm.close();
  });

  it('returns null when checkpoint metadata is missing required fields', () => {
    const dbm = new DatabaseManager(':memory:');
    const repo = new WalkForwardRepository(dbm.db);
    const run = repo.insertRun({
      label: 'resume-seed',
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      replaySessionId: null,
      windowCount: 1,
      totalTrials: 1,
      status: WalkForwardStatus.Running,
      createdAt: 1,
      startedAt: 1,
      completedAt: null,
    });

    repo.saveCheckpoint({
      runId: run.id,
      completedTrialCount: 1,
      lastCompletedTrialIndex: 0,
      metadataJson: JSON.stringify({ label: 'incomplete' }),
      savedAt: 2,
    });

    expect(readWalkForwardResumeConfig(repo, run.id)).toBeNull();

    dbm.close();
  });
});
