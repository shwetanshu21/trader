#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseManager } from '../persistence/sqlite.js';
import { MarketClock } from '../runtime/market-clock.js';
import { INDIA_NSE_EQ_MARKET } from '../market/india-profile.js';
import { OvernightRunRepo } from '../research/overnight-run-repo.js';
import { OvernightOrchestrator } from '../research/overnight-orchestrator.js';
import { OvernightTriggerSupervisor } from '../research/overnight-trigger.js';
import type { OvernightAuditArtifact } from '../research/overnight-research-main.js';

const ARTIFACT_ROOT = 'data/artifacts/overnight-proof';

interface Assertion {
  name: string;
  pass: boolean;
  detail: string;
}

interface TriggerBranchSummary {
  decisionAt: string;
  marketPhaseName: string;
  accepted: boolean;
  runId: number | null;
  runStatus: string | null;
  refusalReason: string | null;
  workspacePath: string;
  launcherInvoked: boolean;
  triggerLaunchArtifactPath: string | null;
  launcherStdoutPath: string | null;
  launcherStderrPath: string | null;
  overnightAuditPath: string | null;
  resumeStubPath: string | null;
  diagnostics: ReturnType<OvernightTriggerSupervisor['getDiagnostics']>;
  auditSummary?: {
    artifactType: string;
    accepted: boolean;
    runStatus: string;
    checkpointPhase: string | null;
  };
}

interface ProofSummary {
  schemaVersion: number;
  artifactType: 'overnight-trigger-proof';
  generatedAt: string;
  verdict: 'PASS' | 'FAIL';
  dbPath: string;
  researchDbPath: string;
  workspaceRoot: string;
  assertions: Assertion[];
  branches: {
    refusedOpenWindow: TriggerBranchSummary;
    acceptedClosedWindow: TriggerBranchSummary;
  };
}

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

const assertions: Assertion[] = [];

function assert(name: string, condition: boolean, detail: string): void {
  assertions.push({ name, pass: condition, detail });
  if (condition) {
    console.log(`  ✓ PASS: ${name} — ${detail}`);
  } else {
    console.error(`  ✗ FAIL: ${name} — ${detail}`);
  }
}

function summarizeAssertions(): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const assertion of assertions) {
    if (assertion.pass) passed++; else failed++;
  }
  return { passed, failed };
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readAuditSummary(auditPath: string): TriggerBranchSummary['auditSummary'] {
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf-8')) as OvernightAuditArtifact;
  return {
    artifactType: audit.artifactType,
    accepted: audit.accepted,
    runStatus: audit.run.status,
    checkpointPhase: audit.finalCheckpoint?.phase ?? null,
  };
}

async function main(): Promise<void> {
  console.log('=======================================================');
  console.log('  M012/S04 — Overnight Autonomous Trigger Proof Harness');
  console.log('=======================================================');
  console.log('');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-trigger-proof-'));
  const runtimeDbPath = path.join(tmpDir, 'runtime.db');
  const researchDbPath = path.join(tmpDir, 'research.db');
  const workspaceRoot = path.join(tmpDir, 'workspace');
  const openWorkspace = path.join(workspaceRoot, 'open-window');
  const closedWorkspace = path.join(workspaceRoot, 'closed-window');
  ensureDir(openWorkspace);
  ensureDir(closedWorkspace);

  const dbm = new DatabaseManager(runtimeDbPath);
  const repo = new OvernightRunRepo(dbm.db);
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const orchestrator = new OvernightOrchestrator(repo, clock);

  let openLaunchCount = 0;
  const openSupervisor = new OvernightTriggerSupervisor({
    orchestrator,
    researchDbPath,
    resolveWindow: () => ({
      key: '2025-01-06-open',
      label: 'overnight-auto-open-2025-01-06',
      workspacePath: openWorkspace,
    }),
    launcher: {
      async launch() {
        openLaunchCount++;
      },
    },
  });

  console.log('── Branch 1: open-window refusal ──');
  await openSupervisor.doWork(REGULAR_TIME, {} as never);
  const refusedRun = repo.getLatestRun();
  assert('Open window does not launch work', openLaunchCount === 0, `launchCount=${openLaunchCount}`);
  assert('Open window persists refused run', refusedRun?.status === 'refused', `status=${refusedRun?.status}`);
  assert('Open window refusal mentions market open', (refusedRun?.refusalReason ?? '').includes('Market is open'), `reason=${refusedRun?.refusalReason}`);

  const openSummary: TriggerBranchSummary = {
    decisionAt: REGULAR_TIME.toISOString(),
    marketPhaseName: refusedRun?.marketPhase ?? 'regular',
    accepted: false,
    runId: refusedRun?.id ?? null,
    runStatus: refusedRun?.status ?? null,
    refusalReason: refusedRun?.refusalReason ?? null,
    workspacePath: openWorkspace,
    launcherInvoked: false,
    triggerLaunchArtifactPath: null,
    launcherStdoutPath: null,
    launcherStderrPath: null,
    overnightAuditPath: null,
    resumeStubPath: null,
    diagnostics: openSupervisor.getDiagnostics(),
  };

  let closedLaunchCount = 0;
  const closedSupervisor = new OvernightTriggerSupervisor({
    orchestrator,
    researchDbPath,
    resolveWindow: () => ({
      key: '2025-01-06-closed',
      label: 'overnight-auto-closed-2025-01-06',
      workspacePath: closedWorkspace,
    }),
    launcher: {
      async launch(input) {
        closedLaunchCount++;
        const launchArtifactPath = path.join(closedWorkspace, 'trigger-launch.json');
        const stdoutPath = path.join(closedWorkspace, 'launcher.stdout');
        const stderrPath = path.join(closedWorkspace, 'launcher.stderr');
        const command = [
          'node', '--import', 'tsx', 'src/research/overnight-research-main.ts',
          '--db-path', researchDbPath,
          '--research-db-path', researchDbPath,
          '--workspace-path', closedWorkspace,
          '--label', input.label,
          '--now', String(input.now.getTime()),
        ];
        fs.writeFileSync(launchArtifactPath, JSON.stringify({
          schemaVersion: 1,
          artifactType: 'overnight-trigger-launch',
          launchedAt: new Date().toISOString(),
          runId: input.runId,
          label: input.label,
          windowKey: input.windowKey,
          workspacePath: input.workspacePath,
          researchDbPath: input.researchDbPath ?? null,
          command,
        }, null, 2), 'utf-8');

        const child = spawnSync(command[0], command.slice(1), {
          cwd: process.cwd(),
          encoding: 'utf-8',
        });
        fs.writeFileSync(stdoutPath, child.stdout ?? '', 'utf-8');
        fs.writeFileSync(stderrPath, child.stderr ?? '', 'utf-8');
        if (child.status !== 0) {
          throw new Error(`overnight CLI exited ${child.status}: ${child.stderr ?? child.stdout ?? 'unknown error'}`);
        }
      },
    },
  });

  console.log('\n── Branch 2: closed-window autonomous launch ──');
  await closedSupervisor.doWork(CLOSED_TIME, {} as never);
  const allRuns = repo.listRuns(10);
  const closedRun = allRuns.find(run => run.workspacePath === closedWorkspace) ?? null;
  const auditPath = path.join(closedWorkspace, 'overnight-audit.json');
  const resumePath = path.join(closedWorkspace, 'resume-stub.json');
  const launchArtifactPath = path.join(closedWorkspace, 'trigger-launch.json');
  const stdoutPath = path.join(closedWorkspace, 'launcher.stdout');
  const stderrPath = path.join(closedWorkspace, 'launcher.stderr');

  assert('Closed window launches work exactly once', closedLaunchCount === 1, `launchCount=${closedLaunchCount}`);
  assert('Closed window creates a run for the autonomous workspace', closedRun !== null, `runId=${closedRun?.id ?? 'none'}`);
  assert('Closed window writes overnight audit artifact', fs.existsSync(auditPath), auditPath);
  assert('Closed window writes resume stub artifact', fs.existsSync(resumePath), resumePath);
  assert('Closed window writes trigger launch artifact', fs.existsSync(launchArtifactPath), launchArtifactPath);

  const auditSummary = readAuditSummary(auditPath);
  assert('Closed window audit artifact is accepted', auditSummary.accepted === true, `accepted=${auditSummary.accepted}`);
  assert('Closed window audit artifact has overnight-audit type', auditSummary.artifactType === 'overnight-audit', `type=${auditSummary.artifactType}`);

  const closedSummary: TriggerBranchSummary = {
    decisionAt: CLOSED_TIME.toISOString(),
    marketPhaseName: closedRun?.marketPhase ?? 'closed',
    accepted: true,
    runId: closedRun?.id ?? null,
    runStatus: closedRun?.status ?? null,
    refusalReason: closedRun?.refusalReason ?? null,
    workspacePath: closedWorkspace,
    launcherInvoked: closedLaunchCount > 0,
    triggerLaunchArtifactPath: launchArtifactPath,
    launcherStdoutPath: stdoutPath,
    launcherStderrPath: stderrPath,
    overnightAuditPath: auditPath,
    resumeStubPath: resumePath,
    diagnostics: closedSupervisor.getDiagnostics(),
    auditSummary,
  };

  const { passed, failed } = summarizeAssertions();
  const verdict: 'PASS' | 'FAIL' = failed === 0 ? 'PASS' : 'FAIL';
  const summary: ProofSummary = {
    schemaVersion: 1,
    artifactType: 'overnight-trigger-proof',
    generatedAt: new Date().toISOString(),
    verdict,
    dbPath: runtimeDbPath,
    researchDbPath,
    workspaceRoot,
    assertions: [...assertions],
    branches: {
      refusedOpenWindow: openSummary,
      acceptedClosedWindow: closedSummary,
    },
  };

  ensureDir(ARTIFACT_ROOT);
  const artifactPath = path.join(ARTIFACT_ROOT, `overnight-trigger-proof-${Date.now()}.json`);
  fs.writeFileSync(artifactPath, JSON.stringify(summary, null, 2), 'utf-8');

  console.log(`\nArtifact written: ${artifactPath}`);
  console.log(`${verdict}: ${passed}/${passed + failed} assertions passed`);

  dbm.close();
  if (verdict !== 'PASS') {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
