// ── WalkForwardRepository unit tests ──
//
// Covers:
//   - Run CRUD: insert, read, update, lifecycle methods
//   - Window CRUD: insert, read, ordering, update
//   - Trial CRUD: insert, read, ranking order, update
//   - Trial-window evidence: link, read-back, ordering
//   - Joined read models: getRunWithWindows, getTrialWithWindows
//   - Ranked candidates query
//   - Atomic batch insert (insertRunWithWindowsAndTrials)
//   - FK constraints, boundary conditions, negative tests

import { describe, it, expect } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { WalkForwardRepository } from '../src/persistence/walk-forward-repo.js';
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
} from '../src/replay/walk-forward-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRepo(): { repo: WalkForwardRepository; db: ReturnType<DatabaseManager['db']> } {
  const mgr = new DatabaseManager(':memory:');
  return {
    repo: new WalkForwardRepository(mgr.db),
    db: mgr.db,
  };
}

const NOW = 1736025600000; // 2025-01-05T00:00:00.000Z

function sampleRun(overrides?: Partial<NewWalkForwardRun>): NewWalkForwardRun {
  return {
    label: '2025-01 walk-forward v1',
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    replaySessionId: null,
    windowCount: 3,
    totalTrials: 0,
    status: WalkForwardStatus.Pending,
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function sampleWindow(
  runId: number,
  index: number,
  overrides?: Partial<NewWalkForwardWindow>,
): NewWalkForwardWindow {
  return {
    runId,
    windowIndex: index,
    rangeStart: NOW + index * 86400000,
    rangeEnd: NOW + (index + 7) * 86400000,
    windowLabel: `W${String(index + 1).padStart(2, '0')} 2025-01-${String(6 + index * 7).padStart(2, '0')}`,
    trialCountOptimized: 0,
    trialCountTested: 0,
    status: WalkForwardWindowStatus.Pending,
    createdAt: NOW,
    ...overrides,
  };
}

function sampleTrial(
  runId: number,
  index: number,
  score: number,
  rank: number,
  overrides?: Partial<NewWalkForwardTrial>,
): NewWalkForwardTrial {
  return {
    runId,
    trialIndex: index,
    label: `Config ${String.fromCharCode(65 + index)}`,
    paramsJson: JSON.stringify({ momentum: 0.5, volatility: 0.3 }),
    mergedScore: score,
    deterministicScore: score * 0.9,
    llmScore: null,
    llmStatus: null,
    rank,
    createdAt: NOW,
    ...overrides,
  };
}

function sampleTrialWindow(
  trialId: number,
  windowId: number,
  windowType: WalkForwardWindowType,
  overrides?: Partial<NewWalkForwardTrialWindow>,
): NewWalkForwardTrialWindow {
  return {
    trialId,
    windowId,
    windowType,
    totalReturn: 12.5,
    sharpeRatio: 1.8,
    maxDrawdown: -8.2,
    winRate: 0.65,
    tradeCount: 42,
    profitFactor: 2.1,
    metricsJson: null,
    createdAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// WalkForwardRepository
// ---------------------------------------------------------------------------

describe('WalkForwardRepository', () => {
  // -----------------------------------------------------------------------
  // Run CRUD
  // -----------------------------------------------------------------------

  describe('insertRun / getRun', () => {
    it('inserts a run with all fields', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());

      expect(run.id).toBeGreaterThan(0);
      expect(run.label).toBe('2025-01 walk-forward v1');
      expect(run.strategyId).toBe('india-nse-eq-v1');
      expect(run.strategyVersion).toBe('1.0.0');
      expect(run.marketId).toBe('INDIA_NSE_EQ');
      expect(run.replaySessionId).toBeNull();
      expect(run.windowCount).toBe(3);
      expect(run.totalTrials).toBe(0);
      expect(run.status).toBe(WalkForwardStatus.Pending);
      expect(run.createdAt).toBe(NOW);
      expect(run.startedAt).toBeNull();
      expect(run.completedAt).toBeNull();
      expect(repo.countRuns()).toBe(1);
    });

    it('returns null for unknown run id', () => {
      const { repo } = createRepo();
      expect(repo.getRun(999)).toBeNull();
    });

    it('reads back an inserted run', () => {
      const { repo } = createRepo();
      const inserted = repo.insertRun(sampleRun({ label: 'read-back test' }));
      const loaded = repo.getRun(inserted.id);

      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(inserted.id);
      expect(loaded!.label).toBe('read-back test');
      expect(loaded!.strategyId).toBe('india-nse-eq-v1');
    });

    it('persists replay_session_id when provided', () => {
      const { repo, db } = createRepo();
      // Seed a replay session so the FK reference is valid
      db.prepare(`
        INSERT INTO replay_sessions
          (label, strategy_id, strategy_version, market_id,
           cadence_minutes, range_start, range_end,
           requested_fidelity, status, total_ticks, completed_ticks,
           error_message, created_at, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('seed', 'v1', '1.0', 'INDIA_NSE_EQ', 5, NOW, NOW + 86400000, 'full', 'completed', 10, 10, null, NOW, NOW, NOW);

      const run = repo.insertRun(sampleRun({ replaySessionId: 1 }));
      expect(run.replaySessionId).toBe(1);

      const loaded = repo.getRun(run.id);
      expect(loaded!.replaySessionId).toBe(1);
    });
  });

  describe('updateRun', () => {
    it('returns null for unknown run', () => {
      const { repo } = createRepo();
      expect(repo.updateRun(999, { status: WalkForwardStatus.Running })).toBeNull();
    });

    it('updates status and timestamps', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const startedAt = NOW + 1000;

      const updated = repo.updateRun(run.id, {
        status: WalkForwardStatus.Running,
        startedAt,
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe(WalkForwardStatus.Running);
      expect(updated!.startedAt).toBe(startedAt);
      expect(updated!.completedAt).toBeNull();
    });

    it('marks run as completed', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const completed = repo.markCompleted(run.id, NOW + 5000);

      expect(completed).not.toBeNull();
      expect(completed!.status).toBe(WalkForwardStatus.Completed);
      expect(completed!.completedAt).toBe(NOW + 5000);
    });

    it('marks run as failed', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const failed = repo.markFailed(run.id, NOW + 3000);

      expect(failed).not.toBeNull();
      expect(failed!.status).toBe(WalkForwardStatus.Failed);
      expect(failed!.completedAt).toBe(NOW + 3000);
    });

    it('marks run as started', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const started = repo.markStarted(run.id, NOW + 500);

      expect(started).not.toBeNull();
      expect(started!.status).toBe(WalkForwardStatus.Running);
      expect(started!.startedAt).toBe(NOW + 500);
    });
  });

  describe('listRuns', () => {
    it('returns empty array when no runs exist', () => {
      const { repo } = createRepo();
      expect(repo.listRuns()).toEqual([]);
    });

    it('returns runs newest first', () => {
      const { repo } = createRepo();
      repo.insertRun(sampleRun({ label: 'First', createdAt: NOW }));
      repo.insertRun(sampleRun({ label: 'Second', createdAt: NOW + 1000 }));

      const runs = repo.listRuns();
      expect(runs.length).toBe(2);
      expect(runs[0].label).toBe('Second');
      expect(runs[1].label).toBe('First');
    });

    it('respects limit parameter', () => {
      const { repo } = createRepo();
      for (let i = 0; i < 5; i++) {
        repo.insertRun(sampleRun({ label: `Run ${i}`, createdAt: NOW + i }));
      }

      expect(repo.listRuns(3).length).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Window CRUD
  // -----------------------------------------------------------------------

  describe('insertWindow / getWindowsForRun', () => {
    it('inserts a window and reads it back', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const window = repo.insertWindow(sampleWindow(run.id, 0));

      expect(window.id).toBeGreaterThan(0);
      expect(window.runId).toBe(run.id);
      expect(window.windowIndex).toBe(0);
      expect(window.windowLabel).toBe('W01 2025-01-06');
      expect(window.status).toBe(WalkForwardWindowStatus.Pending);
    });

    it('returns windows ordered by index', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());

      repo.insertWindow(sampleWindow(run.id, 2));
      repo.insertWindow(sampleWindow(run.id, 0));
      repo.insertWindow(sampleWindow(run.id, 1));

      const windows = repo.getWindowsForRun(run.id);
      expect(windows.length).toBe(3);
      expect(windows[0].windowIndex).toBe(0);
      expect(windows[1].windowIndex).toBe(1);
      expect(windows[2].windowIndex).toBe(2);
    });

    it('returns empty array when no windows exist for a run', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      expect(repo.getWindowsForRun(run.id)).toEqual([]);
    });

    it('enforces FK constraint (run must exist)', () => {
      const { repo } = createRepo();
      expect(() => {
        repo.insertWindow(sampleWindow(999, 0));
      }).toThrow();
    });
  });

  describe('updateWindow / markWindowCompleted', () => {
    it('updates window status and trial counts', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const window = repo.insertWindow(sampleWindow(run.id, 0));

      const updated = repo.updateWindow(window.id, {
        status: WalkForwardWindowStatus.Completed,
        trialCountOptimized: 5,
        trialCountTested: 3,
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe(WalkForwardWindowStatus.Completed);
      expect(updated!.trialCountOptimized).toBe(5);
      expect(updated!.trialCountTested).toBe(3);
    });

    it('markWindowCompleted sets status to completed', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const window = repo.insertWindow(sampleWindow(run.id, 0));

      repo.markWindowCompleted(window.id);
      const loaded = repo.getWindow(window.id);
      expect(loaded!.status).toBe(WalkForwardWindowStatus.Completed);
    });
  });

  describe('countWindows / countWindowsForRun', () => {
    it('starts at zero', () => {
      const { repo } = createRepo();
      expect(repo.countWindows()).toBe(0);
    });

    it('counts across all runs', () => {
      const { repo } = createRepo();
      const r1 = repo.insertRun(sampleRun({ label: 'Run A' }));
      const r2 = repo.insertRun(sampleRun({ label: 'Run B' }));

      repo.insertWindow(sampleWindow(r1.id, 0));
      repo.insertWindow(sampleWindow(r1.id, 1));
      repo.insertWindow(sampleWindow(r2.id, 0));

      expect(repo.countWindows()).toBe(3);
      expect(repo.countWindowsForRun(r1.id)).toBe(2);
      expect(repo.countWindowsForRun(r2.id)).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Trial CRUD
  // -----------------------------------------------------------------------

  describe('insertTrial / getTrialsForRun', () => {
    it('inserts a trial and reads it back', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const trial = repo.insertTrial(sampleTrial(run.id, 0, 0.85, 1));

      expect(trial.id).toBeGreaterThan(0);
      expect(trial.runId).toBe(run.id);
      expect(trial.trialIndex).toBe(0);
      expect(trial.label).toBe('Config A');
      expect(trial.mergedScore).toBe(0.85);
      expect(trial.deterministicScore).toBeCloseTo(0.765);
      expect(trial.llmScore).toBeNull();
      expect(trial.llmStatus).toBeNull();
      expect(trial.rank).toBe(1);
    });

    it('returns trials ordered by rank ascending', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());

      repo.insertTrial(sampleTrial(run.id, 2, 0.5, 3));
      repo.insertTrial(sampleTrial(run.id, 0, 0.9, 1));
      repo.insertTrial(sampleTrial(run.id, 1, 0.7, 2));

      const trials = repo.getTrialsForRun(run.id);
      expect(trials.length).toBe(3);
      expect(trials[0].rank).toBe(1);
      expect(trials[0].mergedScore).toBe(0.9);
      expect(trials[1].rank).toBe(2);
      expect(trials[1].mergedScore).toBe(0.7);
      expect(trials[2].rank).toBe(3);
      expect(trials[2].mergedScore).toBe(0.5);
    });

    it('persists LLM score and status', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const trial = repo.insertTrial(sampleTrial(run.id, 0, 0.75, 1, {
        llmScore: 0.82,
        llmStatus: 'consulted',
      }));

      expect(trial.llmScore).toBe(0.82);
      expect(trial.llmStatus).toBe('consulted');
    });

    it('enforces FK constraint (run must exist)', () => {
      const { repo } = createRepo();
      expect(() => {
        repo.insertTrial(sampleTrial(999, 0, 0.5, 1));
      }).toThrow();
    });
  });

  describe('updateTrial', () => {
    it('updates rank and scores', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const trial = repo.insertTrial(sampleTrial(run.id, 0, 0.8, 1));

      const updated = repo.updateTrial(trial.id, {
        rank: 2,
        mergedScore: 0.6,
        llmScore: 0.55,
        llmStatus: 'degraded',
      });

      expect(updated!.rank).toBe(2);
      expect(updated!.mergedScore).toBe(0.6);
      expect(updated!.llmScore).toBe(0.55);
      expect(updated!.llmStatus).toBe('degraded');
      // deterministic_score should be unchanged
      expect(updated!.deterministicScore).toBeCloseTo(0.72);
    });

    it('returns null for unknown trial', () => {
      const { repo } = createRepo();
      expect(repo.updateTrial(999, { rank: 1 })).toBeNull();
    });
  });

  describe('countTrials / countTrialsForRun', () => {
    it('starts at zero', () => {
      const { repo } = createRepo();
      expect(repo.countTrials()).toBe(0);
    });

    it('counts across runs', () => {
      const { repo } = createRepo();
      const r1 = repo.insertRun(sampleRun({ label: 'Run A' }));
      const r2 = repo.insertRun(sampleRun({ label: 'Run B' }));

      repo.insertTrial(sampleTrial(r1.id, 0, 0.9, 1));
      repo.insertTrial(sampleTrial(r1.id, 1, 0.8, 2));
      repo.insertTrial(sampleTrial(r2.id, 0, 0.85, 1));

      expect(repo.countTrials()).toBe(3);
      expect(repo.countTrialsForRun(r1.id)).toBe(2);
      expect(repo.countTrialsForRun(r2.id)).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Trial-window evidence CRUD
  // -----------------------------------------------------------------------

  describe('linkTrialToWindow / getTrialWindowEvidence', () => {
    it('links a trial to a window with metrics', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const window = repo.insertWindow(sampleWindow(run.id, 0));
      const trial = repo.insertTrial(sampleTrial(run.id, 0, 0.85, 1));

      const evidence = repo.linkTrialToWindow(
        sampleTrialWindow(trial.id, window.id, WalkForwardWindowType.InSample),
      );

      expect(evidence.id).toBeGreaterThan(0);
      expect(evidence.trialId).toBe(trial.id);
      expect(evidence.windowId).toBe(window.id);
      expect(evidence.windowType).toBe(WalkForwardWindowType.InSample);
      expect(evidence.totalReturn).toBe(12.5);
      expect(evidence.sharpeRatio).toBe(1.8);
      expect(evidence.maxDrawdown).toBe(-8.2);
      expect(evidence.winRate).toBe(0.65);
      expect(evidence.tradeCount).toBe(42);
      expect(evidence.profitFactor).toBe(2.1);
    });

    it('returns evidence ordered by window index', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const trial = repo.insertTrial(sampleTrial(run.id, 0, 0.85, 1));

      const w0 = repo.insertWindow(sampleWindow(run.id, 0));
      const w1 = repo.insertWindow(sampleWindow(run.id, 1));

      // Insert out of order
      repo.linkTrialToWindow(sampleTrialWindow(trial.id, w1.id, WalkForwardWindowType.OutOfSample, {
        totalReturn: 8.0,
      }));
      repo.linkTrialToWindow(sampleTrialWindow(trial.id, w0.id, WalkForwardWindowType.InSample, {
        totalReturn: 12.5,
      }));

      const evidence = repo.getTrialWindowEvidence(trial.id);
      expect(evidence.length).toBe(2);
      expect(evidence[0].windowId).toBe(w0.id);
      expect(evidence[0].totalReturn).toBe(12.5);
      expect(evidence[1].windowId).toBe(w1.id);
      expect(evidence[1].totalReturn).toBe(8.0);
    });

    it('enforces FK constraints', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const trial = repo.insertTrial(sampleTrial(run.id, 0, 0.85, 1));

      expect(() => {
        repo.linkTrialToWindow(sampleTrialWindow(trial.id, 999, WalkForwardWindowType.InSample));
      }).toThrow();

      expect(() => {
        repo.linkTrialToWindow(sampleTrialWindow(999, 1, WalkForwardWindowType.InSample));
      }).toThrow();
    });
  });

  describe('getWindowEvidence', () => {
    it('returns all evidence for a window', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const window = repo.insertWindow(sampleWindow(run.id, 0));
      const t1 = repo.insertTrial(sampleTrial(run.id, 0, 0.9, 1));
      const t2 = repo.insertTrial(sampleTrial(run.id, 1, 0.8, 2));

      repo.linkTrialToWindow(sampleTrialWindow(t1.id, window.id, WalkForwardWindowType.InSample));
      repo.linkTrialToWindow(sampleTrialWindow(t2.id, window.id, WalkForwardWindowType.InSample, {
        totalReturn: 10.0,
      }));

      const evidence = repo.getWindowEvidence(window.id);
      expect(evidence.length).toBe(2);
    });

    it('returns empty array when no evidence exists', () => {
      const { repo } = createRepo();
      expect(repo.getWindowEvidence(999)).toEqual([]);
    });
  });

  describe('countTrialWindowEvidence', () => {
    it('counts all evidence rows', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const window = repo.insertWindow(sampleWindow(run.id, 0));
      const trial = repo.insertTrial(sampleTrial(run.id, 0, 0.85, 1));

      expect(repo.countTrialWindowEvidence()).toBe(0);

      repo.linkTrialToWindow(
        sampleTrialWindow(trial.id, window.id, WalkForwardWindowType.InSample),
      );
      expect(repo.countTrialWindowEvidence()).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Ranked candidates query
  // -----------------------------------------------------------------------

  describe('getRankedCandidates', () => {
    it('returns empty array when no trials exist', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      expect(repo.getRankedCandidates(run.id)).toEqual([]);
    });

    it('returns trials ordered by rank with window counts', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const w0 = repo.insertWindow(sampleWindow(run.id, 0));
      const w1 = repo.insertWindow(sampleWindow(run.id, 1));

      const t1 = repo.insertTrial(sampleTrial(run.id, 0, 0.9, 1, {
        paramsJson: JSON.stringify({ momentum: 0.8, volatility: 0.2 }),
      }));
      const t2 = repo.insertTrial(sampleTrial(run.id, 1, 0.7, 2, {
        paramsJson: JSON.stringify({ momentum: 0.5, volatility: 0.5 }),
      }));

      // t1 has window evidence for both windows, t2 for one
      repo.linkTrialToWindow(sampleTrialWindow(t1.id, w0.id, WalkForwardWindowType.InSample));
      repo.linkTrialToWindow(sampleTrialWindow(t1.id, w1.id, WalkForwardWindowType.OutOfSample, {
        totalReturn: 14.2,
      }));
      repo.linkTrialToWindow(sampleTrialWindow(t2.id, w0.id, WalkForwardWindowType.InSample, {
        totalReturn: 9.1,
      }));

      const candidates = repo.getRankedCandidates(run.id);

      expect(candidates.length).toBe(2);
      expect(candidates[0].rank).toBe(1);
      expect(candidates[0].label).toBe('Config A');
      expect(candidates[0].mergedScore).toBe(0.9);
      expect(candidates[0].deterministicScore).toBeCloseTo(0.81);
      expect(candidates[0].llmScore).toBeNull();
      expect(candidates[0].windowCount).toBe(2);
      expect(candidates[0].paramsJson).toBe(JSON.stringify({ momentum: 0.8, volatility: 0.2 }));

      expect(candidates[1].rank).toBe(2);
      expect(candidates[1].label).toBe('Config B');
      expect(candidates[1].mergedScore).toBe(0.7);
      expect(candidates[1].windowCount).toBe(1);
    });

    it('respects limit parameter', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());

      for (let i = 0; i < 10; i++) {
        repo.insertTrial(sampleTrial(run.id, i, 1.0 - i * 0.1, i + 1));
      }

      expect(repo.getRankedCandidates(run.id, 3).length).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Joined read models
  // -----------------------------------------------------------------------

  describe('getRunWithWindows', () => {
    it('returns null for unknown run', () => {
      const { repo } = createRepo();
      expect(repo.getRunWithWindows(999)).toBeNull();
    });

    it('returns run with empty windows when none exist', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const result = repo.getRunWithWindows(run.id);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(run.id);
      expect(result!.windows).toEqual([]);
    });

    it('returns run with ordered windows', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      repo.insertWindow(sampleWindow(run.id, 1));
      repo.insertWindow(sampleWindow(run.id, 0));

      const result = repo.getRunWithWindows(run.id);
      expect(result!.windows.length).toBe(2);
      expect(result!.windows[0].windowIndex).toBe(0);
      expect(result!.windows[1].windowIndex).toBe(1);
    });
  });

  describe('getTrialWithWindows', () => {
    it('returns null for unknown trial', () => {
      const { repo } = createRepo();
      expect(repo.getTrialWithWindows(999)).toBeNull();
    });

    it('returns trial with evidence', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const window = repo.insertWindow(sampleWindow(run.id, 0));
      const trial = repo.insertTrial(sampleTrial(run.id, 0, 0.85, 1));

      repo.linkTrialToWindow(
        sampleTrialWindow(trial.id, window.id, WalkForwardWindowType.InSample),
      );

      const result = repo.getTrialWithWindows(trial.id);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(trial.id);
      expect(result!.windowEvidence.length).toBe(1);
      expect(result!.windowEvidence[0].windowType).toBe(WalkForwardWindowType.InSample);
    });
  });

  // -----------------------------------------------------------------------
  // Atomic batch insert
  // -----------------------------------------------------------------------

  describe('insertRunWithWindowsAndTrials', () => {
    it('inserts run, windows, trials, and evidence atomically', () => {
      const { repo } = createRepo();

      const beforeCount = repo.countRuns();

      const result = repo.insertRunWithWindowsAndTrials(
        sampleRun({ label: 'Batch test' }),
        [
          sampleWindow(0, 0), // runId is placeholder (0); real ID assigned
          sampleWindow(0, 1),
        ],
        [
          sampleTrial(0, 0, 0.9, 1),
          sampleTrial(0, 1, 0.7, 2),
        ],
        [
          // trailId and windowId here refer to trial/window indices
          {
            trialId: 0,
            windowId: 0,
            windowType: WalkForwardWindowType.InSample,
            totalReturn: 15.0,
            sharpeRatio: 2.1,
            maxDrawdown: -5.0,
            winRate: 0.72,
            tradeCount: 50,
            profitFactor: 2.5,
            metricsJson: null,
            createdAt: NOW,
          },
          {
            trialId: 1,
            windowId: 0,
            windowType: WalkForwardWindowType.InSample,
            totalReturn: 10.0,
            sharpeRatio: 1.5,
            maxDrawdown: -9.0,
            winRate: 0.58,
            tradeCount: 45,
            profitFactor: 1.8,
            metricsJson: null,
            createdAt: NOW,
          },
          {
            trialId: 0,
            windowId: 1,
            windowType: WalkForwardWindowType.OutOfSample,
            totalReturn: 12.0,
            sharpeRatio: 1.6,
            maxDrawdown: -7.0,
            winRate: 0.62,
            tradeCount: 48,
            profitFactor: 2.0,
            metricsJson: '{"calmar":1.5}',
            createdAt: NOW,
          },
        ],
      );

      expect(result.id).toBeGreaterThan(0);
      expect(result.label).toBe('Batch test');
      expect(result.windows.length).toBe(2);
      expect(result.windows[0].windowIndex).toBe(0);
      expect(result.windows[1].windowIndex).toBe(1);

      // Verify counts
      expect(repo.countRuns()).toBe(beforeCount + 1);
      expect(repo.countWindows()).toBe(2);
      expect(repo.countTrials()).toBe(2);
      expect(repo.countTrialWindowEvidence()).toBe(3);

      // Verify trial evidence loaded via read model
      const trial0 = repo.getTrialWithWindows(result.windows[0].id < result.windows[1].id
        ? result.id : result.id); // not needed - let's load trials properly

      const trials = repo.getTrialsForRun(result.id);
      expect(trials.length).toBe(2);

      // Check evidence for trial 0 (best rank)
      const bestTrial = trials[0];
      expect(bestTrial.rank).toBe(1);
      const evidence = repo.getTrialWindowEvidence(bestTrial.id);
      expect(evidence.length).toBe(2); // both windows

      const inSample = evidence.find(e => e.windowType === WalkForwardWindowType.InSample);
      const outOfSample = evidence.find(e => e.windowType === WalkForwardWindowType.OutOfSample);
      expect(inSample).toBeDefined();
      expect(outOfSample).toBeDefined();
      expect(inSample!.totalReturn).toBe(15.0);
      expect(outOfSample!.totalReturn).toBe(12.0);
      expect(outOfSample!.metricsJson).toBe('{"calmar":1.5}');
    });

    it('rolls back on invalid trial index reference', () => {
      const { repo } = createRepo();
      const beforeCount = repo.countRuns();

      expect(() => {
        repo.insertRunWithWindowsAndTrials(
          sampleRun({ label: 'Rollback test' }),
          [sampleWindow(0, 0)],
          [sampleTrial(0, 0, 0.9, 1)],
          [
            {
              trialId: 5, // non-existent trial index
              windowId: 0,
              windowType: WalkForwardWindowType.InSample,
              totalReturn: 10.0,
              sharpeRatio: null,
              maxDrawdown: null,
              winRate: null,
              tradeCount: 10,
              profitFactor: null,
              metricsJson: null,
              createdAt: NOW,
            },
          ],
        );
      }).toThrow();

      // No residual rows
      expect(repo.countRuns()).toBe(beforeCount);
      expect(repo.countWindows()).toBe(0);
      expect(repo.countTrials()).toBe(0);
      expect(repo.countTrialWindowEvidence()).toBe(0);
    });

    it('rolls back on invalid window index reference', () => {
      const { repo } = createRepo();
      const beforeCount = repo.countRuns();

      expect(() => {
        repo.insertRunWithWindowsAndTrials(
          sampleRun({ label: 'Rollback test 2' }),
          [sampleWindow(0, 0)],
          [sampleTrial(0, 0, 0.9, 1)],
          [
            {
              trialId: 0,
              windowId: 99, // non-existent window index
              windowType: WalkForwardWindowType.InSample,
              totalReturn: 10.0,
              sharpeRatio: null,
              maxDrawdown: null,
              winRate: null,
              tradeCount: 10,
              profitFactor: null,
              metricsJson: null,
              createdAt: NOW,
            },
          ],
        );
      }).toThrow();

      expect(repo.countRuns()).toBe(beforeCount);
    });
  });

  // -----------------------------------------------------------------------
  // Negative tests — boundary conditions
  // -----------------------------------------------------------------------

  describe('negative tests', () => {
    it('handles run with zero windows and zero trials', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun({ windowCount: 0, totalTrials: 0 }));

      expect(run.windowCount).toBe(0);
      expect(repo.getWindowsForRun(run.id)).toEqual([]);
      expect(repo.getTrialsForRun(run.id)).toEqual([]);
      expect(repo.getRankedCandidates(run.id)).toEqual([]);
    });

    it('handles getWindow for non-existent id', () => {
      const { repo } = createRepo();
      expect(repo.getWindow(999)).toBeNull();
    });

    it('handles getTrial for non-existent id', () => {
      const { repo } = createRepo();
      expect(repo.getTrial(999)).toBeNull();
    });

    it('handles getTrialWindowEvidence for non-existent trial', () => {
      const { repo } = createRepo();
      expect(repo.getTrialWindowEvidence(999)).toEqual([]);
    });

    it('handles getWindowEvidence for non-existent window', () => {
      const { repo } = createRepo();
      expect(repo.getWindowEvidence(999)).toEqual([]);
    });

    it('handles updateRun for non-existent run', () => {
      const { repo } = createRepo();
      expect(repo.updateRun(999, { status: WalkForwardStatus.Running })).toBeNull();
    });

    it('handles updateWindow for non-existent window', () => {
      const { repo } = createRepo();
      expect(repo.updateWindow(999, { status: WalkForwardWindowStatus.Completed })).toBeNull();
    });

    it('handles updateTrial for non-existent trial', () => {
      const { repo } = createRepo();
      expect(repo.updateTrial(999, { rank: 1 })).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Winner-selection CRUD
  // -----------------------------------------------------------------------

  describe('insertWinner / getWinner', () => {
    it('inserts a winner row for a selected trial', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const trial = repo.insertTrial(sampleTrial(run.id, 0, 0.95, 1));

      const winner = repo.insertWinner({
        runId: run.id,
        result: WalkForwardSelectionResult.Selected,
        selectedTrialId: trial.id,
        selectionStrategy: WalkForwardSelectionStrategy.TopRanked,
        selectionConfigJson: JSON.stringify({ strategy: 'top_ranked', minWindowCount: 1 }),
        rationale: 'Top-ranked trial with merged score 0.95 across 3 windows and Sharpe > 2.0.',
        artifactPathsJson: JSON.stringify([
          'artifacts/trade-log-run-1.csv',
          'artifacts/metrics-run-1.json',
        ]),
        selectedAt: NOW + 5000,
      });

      expect(winner.id).toBeGreaterThan(0);
      expect(winner.runId).toBe(run.id);
      expect(winner.result).toBe(WalkForwardSelectionResult.Selected);
      expect(winner.selectedTrialId).toBe(trial.id);
      expect(winner.selectionStrategy).toBe(WalkForwardSelectionStrategy.TopRanked);
      expect(winner.rationale).toContain('Top-ranked trial');
      expect(winner.artifactPathsJson).toContain('trade-log-run-1.csv');
      expect(winner.selectedAt).toBe(NOW + 5000);
      expect(winner.createdAt).toBe(winner.selectedAt);
      expect(repo.countWinners()).toBe(1);
    });

    it('inserts a HOLD (no_winner) outcome with null trial', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());

      const winner = repo.insertWinner({
        runId: run.id,
        result: WalkForwardSelectionResult.NoWinner,
        selectedTrialId: null,
        selectionStrategy: WalkForwardSelectionStrategy.Threshold,
        selectionConfigJson: JSON.stringify({
          strategy: 'threshold',
          minMergedScore: 0.8,
          minWindowCount: 2,
        }),
        rationale: 'No trial exceeded merged score threshold of 0.8.',
        artifactPathsJson: null,
        selectedAt: NOW + 5000,
      });

      expect(winner.id).toBeGreaterThan(0);
      expect(winner.result).toBe(WalkForwardSelectionResult.NoWinner);
      expect(winner.selectedTrialId).toBeNull();
      expect(winner.selectionStrategy).toBe(WalkForwardSelectionStrategy.Threshold);
      expect(winner.artifactPathsJson).toBeNull();
    });

    it('reads back an inserted winner by id', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      const trial = repo.insertTrial(sampleTrial(run.id, 0, 0.95, 1));

      const inserted = repo.insertWinner({
        runId: run.id,
        result: WalkForwardSelectionResult.Selected,
        selectedTrialId: trial.id,
        selectionStrategy: WalkForwardSelectionStrategy.TopRanked,
        selectionConfigJson: '{}',
        rationale: 'Best trial by merged score.',
        artifactPathsJson: null,
        selectedAt: NOW + 5000,
      });

      const loaded = repo.getWinner(inserted.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(inserted.id);
      expect(loaded!.runId).toBe(run.id);
      expect(loaded!.selectedTrialId).toBe(trial.id);
    });

    it('returns null for unknown winner id', () => {
      const { repo } = createRepo();
      expect(repo.getWinner(999)).toBeNull();
    });

    it('enforces UNIQUE constraint on run_id', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());

      repo.insertWinner({
        runId: run.id,
        result: WalkForwardSelectionResult.Selected,
        selectedTrialId: null,
        selectionStrategy: WalkForwardSelectionStrategy.TopRanked,
        selectionConfigJson: '{}',
        rationale: 'First selection.',
        artifactPathsJson: null,
        selectedAt: NOW,
      });

      expect(() => {
        repo.insertWinner({
          runId: run.id,
          result: WalkForwardSelectionResult.Selected,
          selectedTrialId: null,
          selectionStrategy: WalkForwardSelectionStrategy.TopRanked,
          selectionConfigJson: '{}',
          rationale: 'Dupe.',
          artifactPathsJson: null,
          selectedAt: NOW,
        });
      }).toThrow();
    });

    it('enforces FK constraint on run_id', () => {
      const { repo } = createRepo();
      expect(() => {
        repo.insertWinner({
          runId: 999,
          result: WalkForwardSelectionResult.Selected,
          selectedTrialId: null,
          selectionStrategy: WalkForwardSelectionStrategy.TopRanked,
          selectionConfigJson: '{}',
          rationale: 'Should fail.',
          artifactPathsJson: null,
          selectedAt: NOW,
        });
      }).toThrow();
    });

    it('enforces FK constraint on selected_trial_id', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());

      expect(() => {
        repo.insertWinner({
          runId: run.id,
          result: WalkForwardSelectionResult.Selected,
          selectedTrialId: 999,
          selectionStrategy: WalkForwardSelectionStrategy.TopRanked,
          selectionConfigJson: '{}',
          rationale: 'Should fail.',
          artifactPathsJson: null,
          selectedAt: NOW,
        });
      }).toThrow();
    });
  });

  describe('getWinnerForRun', () => {
    it('returns null when no winner exists for the run', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      expect(repo.getWinnerForRun(run.id)).toBeNull();
    });

    it('returns the winner for a specific run', () => {
      const { repo } = createRepo();
      const r1 = repo.insertRun(sampleRun({ label: 'Run A' }));
      const r2 = repo.insertRun(sampleRun({ label: 'Run B' }));

      repo.insertWinner({
        runId: r2.id,
        result: WalkForwardSelectionResult.Selected,
        selectedTrialId: null,
        selectionStrategy: WalkForwardSelectionStrategy.TopRanked,
        selectionConfigJson: '{}',
        rationale: 'Winner for run B.',
        artifactPathsJson: null,
        selectedAt: NOW,
      });

      expect(repo.getWinnerForRun(r1.id)).toBeNull();
      const w2 = repo.getWinnerForRun(r2.id);
      expect(w2).not.toBeNull();
      expect(w2!.runId).toBe(r2.id);
      expect(w2!.rationale).toBe('Winner for run B.');
    });
  });

  describe('getWinnerWithContext', () => {
    it('returns null when no winner exists for the run', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun());
      expect(repo.getWinnerWithContext(run.id)).toBeNull();
    });

    it('returns winner with run context and ranked candidates for a selected trial', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun({
        label: 'Winner context test',
        strategyId: 'test-strategy-v2',
      }));
      const w0 = repo.insertWindow(sampleWindow(run.id, 0));
      const w1 = repo.insertWindow(sampleWindow(run.id, 1));

      const t1 = repo.insertTrial(sampleTrial(run.id, 0, 0.92, 1, {
        paramsJson: JSON.stringify({ momentum: 0.9, volatility: 0.1 }),
      }));
      const t2 = repo.insertTrial(sampleTrial(run.id, 1, 0.65, 2, {
        paramsJson: JSON.stringify({ momentum: 0.5, volatility: 0.5 }),
      }));

      // t1 has evidence for both windows
      repo.linkTrialToWindow(sampleTrialWindow(t1.id, w0.id, WalkForwardWindowType.InSample));
      repo.linkTrialToWindow(sampleTrialWindow(t1.id, w1.id, WalkForwardWindowType.OutOfSample, {
        totalReturn: 14.5,
      }));
      // t2 has evidence for one window
      repo.linkTrialToWindow(sampleTrialWindow(t2.id, w0.id, WalkForwardWindowType.InSample, {
        totalReturn: 8.2,
      }));

      repo.insertWinner({
        runId: run.id,
        result: WalkForwardSelectionResult.Selected,
        selectedTrialId: t1.id,
        selectionStrategy: WalkForwardSelectionStrategy.Composite,
        selectionConfigJson: JSON.stringify({
          strategy: 'composite',
          minMergedScore: 0.7,
          minSharpeRatio: 1.5,
          maxDrawdown: -15,
        }),
        rationale: 'Config A dominates on merged score (0.92) with 2 windows of evidence.',
        artifactPathsJson: JSON.stringify([
          'artifacts/trade-log.json',
          'artifacts/metrics.json',
        ]),
        selectedAt: NOW + 5000,
      });

      const ctx = repo.getWinnerWithContext(run.id);
      expect(ctx).not.toBeNull();
      expect(ctx!.runId).toBe(run.id);
      expect(ctx!.result).toBe(WalkForwardSelectionResult.Selected);
      expect(ctx!.selectionStrategy).toBe(WalkForwardSelectionStrategy.Composite);
      expect(ctx!.rationale).toContain('Config A');

      // Run context
      expect(ctx!.run.label).toBe('Winner context test');
      expect(ctx!.run.strategyId).toBe('test-strategy-v2');

      // Selected trial with evidence
      expect(ctx!.selectedTrial).not.toBeNull();
      expect(ctx!.selectedTrial!.id).toBe(t1.id);
      expect(ctx!.selectedTrial!.mergedScore).toBe(0.92);
      expect(ctx!.selectedTrial!.windowEvidence.length).toBe(2);

      // Ranked candidates
      expect(ctx!.rankedCandidates.length).toBe(2);
      expect(ctx!.rankedCandidates[0].trialId).toBe(t1.id);
      expect(ctx!.rankedCandidates[0].windowCount).toBe(2);
      expect(ctx!.rankedCandidates[1].trialId).toBe(t2.id);
      expect(ctx!.rankedCandidates[1].windowCount).toBe(1);
    });

    it('returns winner with null selectedTrial for no_winner outcome', () => {
      const { repo } = createRepo();
      const run = repo.insertRun(sampleRun({ label: 'HOLD run' }));

      repo.insertWinner({
        runId: run.id,
        result: WalkForwardSelectionResult.NoWinner,
        selectedTrialId: null,
        selectionStrategy: WalkForwardSelectionStrategy.Threshold,
        selectionConfigJson: JSON.stringify({ strategy: 'threshold', minMergedScore: 0.85 }),
        rationale: 'No trial passed the 0.85 merged score threshold.',
        artifactPathsJson: null,
        selectedAt: NOW + 5000,
      });

      const ctx = repo.getWinnerWithContext(run.id);
      expect(ctx).not.toBeNull();
      expect(ctx!.result).toBe(WalkForwardSelectionResult.NoWinner);
      expect(ctx!.selectedTrialId).toBeNull();
      expect(ctx!.selectedTrial).toBeNull();
      expect(ctx!.run.label).toBe('HOLD run');
      expect(ctx!.rankedCandidates).toEqual([]);
    });
  });

  describe('countWinners', () => {
    it('starts at zero', () => {
      const { repo } = createRepo();
      expect(repo.countWinners()).toBe(0);
    });

    it('counts across runs', () => {
      const { repo } = createRepo();
      const r1 = repo.insertRun(sampleRun({ label: 'Run A' }));
      const r2 = repo.insertRun(sampleRun({ label: 'Run B' }));

      repo.insertWinner({
        runId: r1.id,
        result: WalkForwardSelectionResult.Selected,
        selectedTrialId: null,
        selectionStrategy: WalkForwardSelectionStrategy.TopRanked,
        selectionConfigJson: '{}',
        rationale: 'Winner 1.',
        artifactPathsJson: null,
        selectedAt: NOW,
      });

      repo.insertWinner({
        runId: r2.id,
        result: WalkForwardSelectionResult.NoWinner,
        selectedTrialId: null,
        selectionStrategy: WalkForwardSelectionStrategy.Threshold,
        selectionConfigJson: '{}',
        rationale: 'No winner.',
        artifactPathsJson: null,
        selectedAt: NOW,
      });

      expect(repo.countWinners()).toBe(2);
    });
  });
});
