import { describe, expect, it } from 'vitest';

import { DatabaseManager } from '../src/persistence/sqlite.js';
import { MarketClock } from '../src/runtime/market-clock.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';
import { OvernightRunRepo, OvernightRunStatus } from '../src/research/overnight-run-repo.js';
import { OvernightOrchestrator } from '../src/research/overnight-orchestrator.js';
import { OvernightTriggerSupervisor } from '../src/research/overnight-trigger.js';

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

const REGULAR_TIME = indiaTime(2025, 1, 6, 12, 0, 0);
const CLOSED_TIME = indiaTime(2025, 1, 6, 16, 30, 0);
const LATER_CLOSED_TIME = indiaTime(2025, 1, 6, 17, 15, 0);

function createFixtures() {
  const dbm = new DatabaseManager(':memory:');
  const repo = new OvernightRunRepo(dbm.db);
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const orchestrator = new OvernightOrchestrator(repo, clock);
  return { dbm, repo, orchestrator };
}

describe('OvernightTriggerSupervisor', () => {
  it('refuses during open market hours and persists a refused run without launching', async () => {
    const { dbm, repo, orchestrator } = createFixtures();
    const launches: number[] = [];

    const supervisor = new OvernightTriggerSupervisor({
      orchestrator,
      researchDbPath: '/tmp/research.db',
      resolveWindow: () => ({
        key: '2025-01-06',
        label: 'overnight-auto-2025-01-06',
        workspacePath: '/tmp/ws-2025-01-06',
      }),
      launcher: {
        async launch(input) {
          launches.push(input.runId);
        },
      },
    });

    await supervisor.doWork(REGULAR_TIME, {} as never);

    expect(launches).toEqual([]);
    expect(repo.countRuns()).toBe(1);
    const run = repo.getLatestRun();
    expect(run?.status).toBe(OvernightRunStatus.Refused);
    expect(run?.refusalReason).toContain('Market is open');
    expect(supervisor.getDiagnostics().duplicateSkipCount).toBe(0);

    dbm.close();
  });

  it('launches once during a closed window and skips duplicate ticks for the same workspace after completion', async () => {
    const { dbm, repo, orchestrator } = createFixtures();
    const launches: number[] = [];

    const supervisor = new OvernightTriggerSupervisor({
      orchestrator,
      researchDbPath: '/tmp/research.db',
      resolveWindow: () => ({
        key: '2025-01-06',
        label: 'overnight-auto-2025-01-06',
        workspacePath: '/tmp/ws-2025-01-06',
      }),
      launcher: {
        async launch(input) {
          launches.push(input.runId);
          orchestrator.markCompleted(input.runId);
        },
      },
    });

    await supervisor.doWork(CLOSED_TIME, {} as never);
    await supervisor.doWork(LATER_CLOSED_TIME, {} as never);

    expect(launches).toHaveLength(1);
    expect(repo.countRuns()).toBe(1);
    const run = repo.getLatestRun();
    expect(run?.status).toBe(OvernightRunStatus.Completed);
    expect(supervisor.getDiagnostics().duplicateSkipCount).toBe(1);
    expect(supervisor.getDiagnostics().lastLaunchedRunId).toBe(run?.id ?? null);

    dbm.close();
  });

  it('skips overlapping ticks while launch is still in flight', async () => {
    const { dbm, orchestrator } = createFixtures();
    const launches: number[] = [];
    let resolveLaunch: (() => void) | null = null;

    const supervisor = new OvernightTriggerSupervisor({
      orchestrator,
      researchDbPath: '/tmp/research.db',
      resolveWindow: () => ({
        key: '2025-01-06',
        label: 'overnight-auto-2025-01-06',
        workspacePath: '/tmp/ws-2025-01-06',
      }),
      launcher: {
        async launch(input) {
          launches.push(input.runId);
          await new Promise<void>((resolve) => {
            resolveLaunch = resolve;
          });
        },
      },
    });

    const first = supervisor.doWork(CLOSED_TIME, {} as never);
    await Promise.resolve();
    const second = supervisor.doWork(LATER_CLOSED_TIME, {} as never);
    await Promise.resolve();

    expect(launches).toHaveLength(1);
    expect(supervisor.getDiagnostics().inFlight).toBe(true);
    expect(supervisor.getDiagnostics().overlapSkipCount).toBe(1);

    resolveLaunch?.();
    await first;
    await second;

    expect(supervisor.getDiagnostics().inFlight).toBe(false);

    dbm.close();
  });

  it('does not relaunch the same window key after a failed launch within the same supervisor lifecycle', async () => {
    const { dbm, repo, orchestrator } = createFixtures();
    const launches: number[] = [];

    const supervisor = new OvernightTriggerSupervisor({
      orchestrator,
      researchDbPath: '/tmp/research.db',
      resolveWindow: () => ({
        key: '2025-01-06',
        label: 'overnight-auto-2025-01-06',
        workspacePath: '/tmp/ws-2025-01-06',
      }),
      launcher: {
        async launch(input) {
          launches.push(input.runId);
          orchestrator.markFailed(input.runId, 'provider timeout');
        },
      },
    });

    await supervisor.doWork(CLOSED_TIME, {} as never);
    await supervisor.doWork(LATER_CLOSED_TIME, {} as never);

    expect(launches).toHaveLength(1);
    expect(repo.countRuns()).toBe(1);
    const run = repo.getLatestRun();
    expect(run?.status).toBe(OvernightRunStatus.Failed);
    expect(supervisor.getDiagnostics().duplicateSkipCount).toBe(1);

    dbm.close();
  });

  it('marks the run failed when autonomous launch bootstrap throws', async () => {
    const { dbm, repo, orchestrator } = createFixtures();

    const supervisor = new OvernightTriggerSupervisor({
      orchestrator,
      researchDbPath: '/tmp/research.db',
      resolveWindow: () => ({
        key: '2025-01-06',
        label: 'overnight-auto-2025-01-06',
        workspacePath: '/tmp/ws-2025-01-06',
      }),
      launcher: {
        async launch() {
          throw new Error('spawn failed');
        },
      },
    });

    await supervisor.doWork(CLOSED_TIME, {} as never);

    const run = repo.getLatestRun();
    expect(run?.status).toBe(OvernightRunStatus.Failed);
    expect(run?.lastError).toContain('Autonomous overnight trigger launch failed');
    expect(supervisor.getDiagnostics().launchErrorCount).toBe(1);
    expect(supervisor.getDiagnostics().inFlight).toBe(false);

    dbm.close();
  });
});
