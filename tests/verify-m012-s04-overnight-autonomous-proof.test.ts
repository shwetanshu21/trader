import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { MarketClock } from '../src/runtime/market-clock.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';
import { OvernightRunRepo, OvernightRunStatus } from '../src/research/overnight-run-repo.js';
import { OvernightOrchestrator } from '../src/research/overnight-orchestrator.js';
import { OvernightTriggerSupervisor } from '../src/research/overnight-trigger.js';
import type { OvernightAuditArtifact } from '../src/research/overnight-research-main.js';

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

const REGULAR_TIME = indiaTime(2025, 1, 6, 11, 30, 0);
const CLOSED_TIME = indiaTime(2025, 1, 6, 16, 30, 0);

function createFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm012-s04-proof-'));
  const dbManager = new DatabaseManager(':memory:');
  const repo = new OvernightRunRepo(dbManager.db);
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const orchestrator = new OvernightOrchestrator(repo, clock);
  return { tmpDir, dbManager, repo, orchestrator };
}

describe('M012/S04 overnight autonomous trigger proof', () => {
  it('refuses during the open window without launching work', async () => {
    const { tmpDir, dbManager, repo, orchestrator } = createFixture();
    const launches: number[] = [];

    const supervisor = new OvernightTriggerSupervisor({
      orchestrator,
      researchDbPath: path.join(tmpDir, 'research.db'),
      resolveWindow: () => ({
        key: '2025-01-06-open',
        label: 'overnight-auto-open-2025-01-06',
        workspacePath: path.join(tmpDir, 'open-window'),
      }),
      launcher: {
        async launch(input) {
          launches.push(input.runId);
        },
      },
    });

    await supervisor.doWork(REGULAR_TIME, {} as never);

    const run = repo.getLatestRun();
    expect(launches).toEqual([]);
    expect(run?.status).toBe(OvernightRunStatus.Refused);
    expect(run?.refusalReason).toContain('Market is open');
    expect(supervisor.getDiagnostics().lastLaunchedRunId).toBeNull();

    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes durable unattended proof artifacts for the closed-window branch', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm012-s04-script-'));
    const run = spawnSync('node', ['--import', 'tsx', 'src/deployment/verify-m012-s04-overnight-autonomous-proof.ts'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(run.status).toBe(0);
    const match = /Artifact written: (.+\.json)/.exec(run.stdout);
    expect(match).not.toBeNull();
    const artifactPath = match![1];
    expect(fs.existsSync(artifactPath)).toBe(true);

    const summary = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as {
      verdict: string;
      artifactType: string;
      branches: {
        refusedOpenWindow: { launcherInvoked: boolean; runStatus: string; refusalReason: string | null };
        acceptedClosedWindow: {
          launcherInvoked: boolean;
          overnightAuditPath: string;
          resumeStubPath: string;
          triggerLaunchArtifactPath: string;
        };
      };
    };

    expect(summary.verdict).toBe('PASS');
    expect(summary.artifactType).toBe('overnight-trigger-proof');
    expect(summary.branches.refusedOpenWindow.launcherInvoked).toBe(false);
    expect(summary.branches.refusedOpenWindow.runStatus).toBe('refused');
    expect(summary.branches.refusedOpenWindow.refusalReason).toContain('Market is open');
    expect(summary.branches.acceptedClosedWindow.launcherInvoked).toBe(true);
    expect(fs.existsSync(summary.branches.acceptedClosedWindow.overnightAuditPath)).toBe(true);
    expect(fs.existsSync(summary.branches.acceptedClosedWindow.resumeStubPath)).toBe(true);
    expect(fs.existsSync(summary.branches.acceptedClosedWindow.triggerLaunchArtifactPath)).toBe(true);

    const audit = JSON.parse(fs.readFileSync(summary.branches.acceptedClosedWindow.overnightAuditPath, 'utf-8')) as OvernightAuditArtifact;
    expect(audit.artifactType).toBe('overnight-audit');
    expect(audit.accepted).toBe(true);
    expect(audit.run.workspacePath).toContain('closed-window');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 120000);
});
