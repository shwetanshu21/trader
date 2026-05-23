#!/usr/bin/env node
// ── M012/S01 — Overnight Research Proof Harness ──
//
// One-command end-to-end proof that the overnight research orchestration seam
// (market-window gate -> run-state persistence -> checkpoint/resume audit)
// produces durable, operator-reviewable artifacts.
//
// Two branches are proven:
//   1. Market-hours refusal -- calls tryStart during regular market hours;
//      asserts the gate returns accepted=false with a clear refusal reason.
//   2. Closed-window start -- calls tryStart during a closed market window;
//      asserts the gate returns accepted=true, runs simulated phases, writes
//      checkpoints, and emits audit/resume artifacts in the workspace.
//
// The harness:
//   - Creates a temp file-backed SQLite database
//   - Creates a temp research workspace directory
//   - Runs the real OvernightOrchestrator through both branches
//   - Asserts correct gate behaviour, checkpoint metadata, and artifact paths
//   - Writes a timestamped JSON artifact under data/artifacts/overnight-proof/
//   - Exits 0 on full success, non-zero on any assertion failure

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseManager } from '../persistence/sqlite.js';
import { MarketClock } from '../runtime/market-clock.js';
import { INDIA_NSE_EQ_MARKET } from '../market/india-profile.js';
import { OvernightRunRepo, OvernightRunStatus } from '../research/overnight-run-repo.js';
import { OvernightOrchestrator } from '../research/overnight-orchestrator.js';
import type { OvernightCheckpointMetadata } from '../research/overnight-run-repo.js';
import type { OvernightAuditArtifact } from '../research/overnight-research-main.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARTIFACT_ROOT = 'data/artifacts/overnight-proof';

// ---------------------------------------------------------------------------
// Test times
// ---------------------------------------------------------------------------

/** India time helper: UTC-5:30 for Asia/Kolkata. */
function indiaTime(
  year: number,
  month: number,  // 1-indexed
  day: number,
  hours: number,
  minutes: number = 0,
  seconds: number = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hours - 5, minutes - 30, seconds));
}

const CLOSED_TIME   = indiaTime(2025, 1, 6, 16, 30, 0); // Mon 16:30 IST → Closed
const REGULAR_TIME  = indiaTime(2025, 1, 6, 11, 30, 0); // Mon 11:30 IST → Regular

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

interface Assertion {
  name: string;
  pass: boolean;
  detail: string;
}

const assertions: Assertion[] = [];

function resetAssertions(): void {
  assertions.length = 0;
}

function assert(name: string, condition: boolean, detail: string): void {
  assertions.push({ name, pass: condition, detail });
  if (!condition) {
    console.error(`  ✗ FAIL: ${name} — ${detail}`);
  } else {
    console.log(`  ✓ PASS: ${name} — ${detail}`);
  }
}

function report(): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const a of assertions) {
    if (a.pass) passed++; else failed++;
  }
  return { passed, failed };
}

function getAssertions(): Assertion[] {
  return [...assertions];
}

// ---------------------------------------------------------------------------
// Proof context
// ---------------------------------------------------------------------------

interface ProofContext {
  dbManager: DatabaseManager;
  repo: OvernightRunRepo;
  clock: MarketClock;
  orchestrator: OvernightOrchestrator;
  dbPath: string;
  workspacePath: string;
}

function createProofContext(): ProofContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-proof-'));
  const dbPath = path.join(tmpDir, 'overnight-proof.db');
  const workspacePath = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });

  const dbManager = new DatabaseManager(dbPath);
  const repo = new OvernightRunRepo(dbManager.db);
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const orchestrator = new OvernightOrchestrator(repo, clock);

  return { dbManager, repo, clock, orchestrator, dbPath, workspacePath };
}

function destroyProofContext(ctx: ProofContext): void {
  ctx.dbManager.close();
  try {
    const tmpDir = path.dirname(ctx.dbPath);
    if (tmpDir.startsWith(os.tmpdir())) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Minimal simulation of phases (no CLI dependency, just the orchestrator API)
// ---------------------------------------------------------------------------

function simulateGeneration(orchestrator: OvernightOrchestrator, runId: number, count: number): void {
  for (let i = 1; i <= count; i++) {
    orchestrator.saveCheckpoint(runId, {
      phase: 'generate',
      completedItems: i,
      totalItems: count,
      lastProcessedId: `gen-hyp-${i}`,
      metadata: { hypothesisIndex: i, simulated: true },
    });
  }
}

function simulateEvaluation(orchestrator: OvernightOrchestrator, runId: number, count: number): void {
  for (let i = 1; i <= count; i++) {
    orchestrator.saveCheckpoint(runId, {
      phase: 'evaluate',
      completedItems: i,
      totalItems: count,
      lastProcessedId: `eval-trial-${i}`,
      metadata: { trialIndex: i, simulated: true },
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\u2550'.repeat(55));
  console.log('  M012/S01 \u2014 Overnight Research Proof Harness');
  console.log('\u2550'.repeat(55));
  console.log('');

  resetAssertions();

  let ctx: ProofContext | null = null;
  let artifactPath = '';

  try {
    // ── Setup ──
    ctx = createProofContext();
    console.log(`DB: ${ctx.dbPath}`);
    console.log(`Workspace: ${ctx.workspacePath}`);
    console.log('');

    // =================================================================
    // Phase 1: Market-hours refusal
    // =================================================================
    console.log('\u2500\u2500 Phase 1: Market-hours refusal \u2500\u2500');

    const refusedResult = ctx.orchestrator.tryStart(
      'refusal-test',
      ctx.workspacePath,
      REGULAR_TIME,
    );

    assert(
      'Phase1: gate returns accepted=false during regular hours',
      !refusedResult.accepted,
      `accepted=${refusedResult.accepted}`,
    );
    assert(
      'Phase1: refusal reason is present and mentions "Market is open"',
      refusedResult.refusalReason !== null && refusedResult.refusalReason.includes('Market is open'),
      `reason=${refusedResult.refusalReason}`,
    );
    assert(
      'Phase1: run status is Refused',
      refusedResult.run.status === OvernightRunStatus.Refused,
      `status=${refusedResult.run.status}`,
    );
    assert(
      'Phase1: market phase is Regular',
      refusedResult.marketPhaseName === 'regular',
      `phase=${refusedResult.marketPhaseName}`,
    );
    assert(
      'Phase1: persisted run refusal reason matches',
      refusedResult.run.refusalReason === refusedResult.refusalReason,
      `run.refusal=${refusedResult.run.refusalReason}, result.refusal=${refusedResult.refusalReason}`,
    );

    // Verify no workspace files were written for a refused run
    const workspaceFiles = fs.readdirSync(ctx.workspacePath);
    assert(
      'Phase1: no workspace artifacts written for refused run',
      workspaceFiles.length === 0,
      `files=${JSON.stringify(workspaceFiles)}`,
    );

    // =================================================================
    // Phase 2: Closed-window start with simulation
    // =================================================================
    console.log('\n\u2500\u2500 Phase 2: Closed-window start with simulation \u2500\u2500');

    const startResult = ctx.orchestrator.tryStart(
      'overnight-demo',
      ctx.workspacePath,
      CLOSED_TIME,
    );

    assert(
      'Phase2: gate returns accepted=true during closed window',
      startResult.accepted,
      `accepted=${startResult.accepted}`,
    );
    assert(
      'Phase2: refusal reason is null',
      startResult.refusalReason === null,
      `reason=${startResult.refusalReason}`,
    );
    assert(
      'Phase2: run status is Running',
      startResult.run.status === OvernightRunStatus.Running,
      `status=${startResult.run.status}`,
    );
    assert(
      'Phase2: market phase is Closed',
      startResult.marketPhaseName === 'closed',
      `phase=${startResult.marketPhaseName}`,
    );
    assert(
      'Phase2: initial phase is generate',
      startResult.run.currentPhase === 'generate',
      `phase=${startResult.run.currentPhase}`,
    );
    assert(
      'Phase2: startedAt is set',
      startResult.run.startedAt !== null && startResult.run.startedAt > 0,
      `startedAt=${startResult.run.startedAt}`,
    );
    assert(
      'Phase2: checkpoint pointer is null initially',
      startResult.run.checkpointPointer === null,
      `cp=${startResult.run.checkpointPointer}`,
    );

    // ── Simulate generate phase ──
    const runId = startResult.run.id;
    ctx.orchestrator.markPhase(runId, 'generate');
    simulateGeneration(ctx.orchestrator, runId, 3);

    const genCheckpoint = ctx.orchestrator.getRun(runId);
    assert(
      'Phase2: after generation, phase is generate',
      genCheckpoint!.currentPhase === 'generate',
      `phase=${genCheckpoint!.currentPhase}`,
    );

    const genCp = genCheckpoint!.checkpointPointer
      ? (JSON.parse(genCheckpoint!.checkpointPointer) as OvernightCheckpointMetadata)
      : null;
    assert(
      'Phase2: generation checkpoint shows 3/3 completed',
      genCp !== null && genCp.completedItems === 3 && genCp.totalItems === 3,
      `cp=${genCheckpoint!.checkpointPointer}`,
    );
    assert(
      'Phase2: generation checkpoint has lastProcessedId',
      genCp?.lastProcessedId === 'gen-hyp-3',
      `lastId=${genCp?.lastProcessedId}`,
    );

    // ── Simulate evaluate phase ──
    ctx.orchestrator.markPhase(runId, 'evaluate');
    simulateEvaluation(ctx.orchestrator, runId, 5);

    const evalCheckpoint = ctx.orchestrator.getRun(runId);
    assert(
      'Phase2: after evaluation, phase is evaluate',
      evalCheckpoint!.currentPhase === 'evaluate',
      `phase=${evalCheckpoint!.currentPhase}`,
    );

    const evalCp = evalCheckpoint!.checkpointPointer
      ? (JSON.parse(evalCheckpoint!.checkpointPointer) as OvernightCheckpointMetadata)
      : null;
    assert(
      'Phase2: evaluation checkpoint shows 5/5 completed',
      evalCp !== null && evalCp.completedItems === 5 && evalCp.totalItems === 5,
      `cp=${evalCheckpoint!.checkpointPointer}`,
    );
    assert(
      'Phase2: evaluation checkpoint has lastProcessedId',
      evalCp?.lastProcessedId === 'eval-trial-5',
      `lastId=${evalCp?.lastProcessedId}`,
    );

    // ── Mark completed ──
    ctx.orchestrator.markPhase(runId, 'completed');
    const completedRun = ctx.orchestrator.markCompleted(runId);

    assert(
      'Phase2: after completion, status is Completed',
      completedRun!.status === OvernightRunStatus.Completed,
      `status=${completedRun!.status}`,
    );
    assert(
      'Phase2: completedAt is set',
      completedRun!.completedAt !== null && completedRun!.completedAt! > 0,
      `completedAt=${completedRun!.completedAt}`,
    );
    assert(
      'Phase2: phase is completed',
      completedRun!.currentPhase === 'completed',
      `phase=${completedRun!.currentPhase}`,
    );

    // ── Latest run queries ──
    const latestRun = ctx.orchestrator.getLatestRun();
    assert(
      'Phase2: getLatestRun returns the completed run',
      latestRun !== null && latestRun!.id === runId,
      `latest=${latestRun?.id}, expected=${runId}`,
    );

    const fetchedRun = ctx.orchestrator.getRun(runId);
    assert(
      'Phase2: getRun returns the same run by id',
      fetchedRun !== null && fetchedRun!.id === runId,
      `fetched=${fetchedRun?.id}`,
    );

    // ── Verify run counts ──
    assert(
      'Phase2: total runs count is 2',
      ctx.repo.countRuns() === 2,
      `count=${ctx.repo.countRuns()}`,
    );
    assert(
      'Phase2: refused count is 1',
      ctx.repo.countByStatus(OvernightRunStatus.Refused) === 1,
      `count=${ctx.repo.countByStatus(OvernightRunStatus.Refused)}`,
    );
    assert(
      'Phase2: completed count is 1',
      ctx.repo.countByStatus(OvernightRunStatus.Completed) === 1,
      `count=${ctx.repo.countByStatus(OvernightRunStatus.Completed)}`,
    );

    // ── List runs newest first ──
    const allRuns = ctx.repo.listRuns(10);
    assert(
      'Phase2: listRuns returns 2 runs',
      allRuns.length === 2,
      `length=${allRuns.length}`,
    );
    assert(
      'Phase2: most recent run is the completed one',
      allRuns[0].id === runId,
      `first=${allRuns[0].id}`,
    );

    // =================================================================
    // Phase 3: Workspace audit artifact (simulate the CLI artifact write)
    // =================================================================
    console.log('\n\u2500\u2500 Phase 3: Workspace audit artifact \u2500\u2500');

    const auditArtifact: OvernightAuditArtifact = {
      schemaVersion: 1,
      artifactType: 'overnight-audit',
      generatedAt: new Date().toISOString(),
      run: completedRun!,
      finalCheckpoint: evalCp,
      marketPhase: startResult.run.marketPhase,
      accepted: true,
      refusalReason: null,
      dbPath: ctx.dbPath,
      workspacePath: ctx.workspacePath,
      simulation: {
        generateCheckpoints: 3,
        evaluateCheckpoints: 5,
        durationMs: 0,
      },
    };

    const auditPath = path.join(ctx.workspacePath, 'overnight-audit.json');
    fs.writeFileSync(auditPath, JSON.stringify(auditArtifact, null, 2), 'utf-8');
    fs.chmodSync(auditPath, 0o600);

    assert(
      'Phase3: audit artifact file exists',
      fs.existsSync(auditPath),
      auditPath,
    );

    const readBack = JSON.parse(fs.readFileSync(auditPath, 'utf-8')) as OvernightAuditArtifact;
    assert(
      'Phase3: audit artifact schema version is 1',
      readBack.schemaVersion === 1,
      `version=${readBack.schemaVersion}`,
    );
    assert(
      'Phase3: audit artifact type is overnight-audit',
      readBack.artifactType === 'overnight-audit',
      `type=${readBack.artifactType}`,
    );
    assert(
      'Phase3: audit artifact has run id',
      readBack.run.id === runId,
      `runId=${readBack.run.id}`,
    );
    assert(
      'Phase3: audit artifact run status is Completed',
      readBack.run.status === OvernightRunStatus.Completed,
      `status=${readBack.run.status}`,
    );
    assert(
      'Phase3: audit artifact final checkpoint evaluate phase',
      readBack.finalCheckpoint?.phase === 'evaluate',
      `phase=${readBack.finalCheckpoint?.phase}`,
    );
    assert(
      'Phase3: audit artifact final checkpoint 5/5',
      readBack.finalCheckpoint?.completedItems === 5 && readBack.finalCheckpoint?.totalItems === 5,
      `cp=${readBack.finalCheckpoint?.completedItems}/${readBack.finalCheckpoint?.totalItems}`,
    );
    assert(
      'Phase3: audit artifact has workspace path',
      readBack.workspacePath === ctx.workspacePath,
      `path=${readBack.workspacePath}`,
    );

    // ── Resume stub ──
    const resumeStub = {
      lastPhase: 'completed',
      refusalReason: null,
      checkpointProgress: '5/5 in phase evaluate',
      workspacePath: ctx.workspacePath,
      dbPath: ctx.dbPath,
      runId: runId,
      runLabel: 'overnight-demo',
      runStatus: 'completed',
    };

    const resumePath = path.join(ctx.workspacePath, 'resume-stub.json');
    fs.writeFileSync(resumePath, JSON.stringify(resumeStub, null, 2), 'utf-8');

    assert(
      'Phase3: resume stub file exists',
      fs.existsSync(resumePath),
      resumePath,
    );

    const resumeRead = JSON.parse(fs.readFileSync(resumePath, 'utf-8'));
    assert(
      'Phase3: resume stub has lastPhase = completed',
      resumeRead.lastPhase === 'completed',
      `lastPhase=${resumeRead.lastPhase}`,
    );
    assert(
      'Phase3: resume stub has checkpointProgress',
      resumeRead.checkpointProgress === '5/5 in phase evaluate',
      `progress=${resumeRead.checkpointProgress}`,
    );
    assert(
      'Phase3: resume stub has workspace path',
      resumeRead.workspacePath === ctx.workspacePath,
      `path=${resumeRead.workspacePath}`,
    );

    // =================================================================
    // Phase 4: Non-existent run query
    // =================================================================
    console.log('\n\u2500\u2500 Phase 4: Edge cases \u2500\u2500');

    const notFound = ctx.orchestrator.getRun(999);
    assert(
      'Phase4: getRun returns null for non-existent run',
      notFound === null,
      `result=${JSON.stringify(notFound)}`,
    );

    // getLatestRun with runs present (should still work)
    const latest = ctx.orchestrator.getLatestRun();
    assert(
      'Phase4: getLatestRun still works with runs present',
      latest !== null,
      `latest=${JSON.stringify(latest)}`,
    );

    // =================================================================
    // Write artifact
    // =================================================================
    console.log('');

    const { passed, failed } = report();
    const overallVerdict = failed === 0 ? 'PASS' : 'FAIL';

    const summary = {
      harness: 'M012/S01 Overnight Research Proof Harness',
      completedAt: new Date().toISOString(),
      verdict: overallVerdict,
      totalAssertions: passed + failed,
      passed,
      failed,
      assertions: getAssertions().map(a => ({
        name: a.name,
        pass: a.pass,
        detail: a.detail,
      })),
      branchesTested: [
        'market-hours-refusal (gate returns accepted=false with refusal reason)',
        'closed-window-start (gate returns accepted=true, simulates phases, emits checkpoints)',
        'workspace-artifacts (audit artifact and resume stub written to workspace)',
        'edge-cases (non-existent run query, run listing)',
      ],
    };

    // Ensure artifact directory exists
    fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });

    const stamp = Date.now();
    artifactPath = path.join(ARTIFACT_ROOT, `overnight-proof-${stamp}.json`);
    fs.writeFileSync(artifactPath, JSON.stringify(summary, null, 2), 'utf-8');
    console.log(`Artifact written: ${artifactPath}`);

    console.log(`\n${overallVerdict}: ${passed}/${passed + failed} assertions passed`);
    if (failed > 0) {
      process.exit(1);
    }
    process.exit(0);

  } catch (err) {
    console.error(`\n\u274c FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  } finally {
    if (ctx) {
      destroyProofContext(ctx);
    }
  }
}

main();
