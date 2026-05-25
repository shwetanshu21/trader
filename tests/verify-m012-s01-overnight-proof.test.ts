// ── M012/S01 — Overnight Research Proof Integration Test ──
//
// Vitest-based integration test that exercises the overnight orchestrator
// seam: market-window gate (refusal during hours, acceptance when closed),
// run-state persistence, checkpoint/resume metadata, and workspace audit
// artifact emission.
//
// Uses in-memory SQLite and a temp workspace directory — no external
// fixture files required.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { MarketClock } from '../src/runtime/market-clock.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';
import {
  OvernightRunRepo,
  OvernightRunStatus,
  type OvernightCheckpointMetadata,
} from '../src/research/overnight-run-repo.js';
import { OvernightOrchestrator } from '../src/research/overnight-orchestrator.js';
import type { OvernightAuditArtifact } from '../src/research/overnight-research-main.js';

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// Shared fixture times
// ---------------------------------------------------------------------------

const REGULAR_TIME   = indiaTime(2025, 1, 6, 11, 30, 0); // Mon 11:30 IST → Regular
const PRE_MARKET_TIME = indiaTime(2025, 1, 6, 9, 5, 0);  // Mon 09:05 IST → PreMarket
const POST_MARKET_TIME = indiaTime(2025, 1, 6, 15, 45, 0); // Mon 15:45 IST → PostMarket
const CLOSED_AFTER   = indiaTime(2025, 1, 6, 16, 30, 0); // Mon 16:30 IST → Closed
const SATURDAY       = indiaTime(2025, 1, 4, 12, 0, 0);  // Sat 12:00 IST → Closed
const SUNDAY         = indiaTime(2025, 1, 5, 12, 0, 0);  // Sun 12:00 IST → Closed

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  dbManager: DatabaseManager;
  repo: OvernightRunRepo;
  clock: MarketClock;
  orchestrator: OvernightOrchestrator;
  workspacePath: string;
}

function createFixture(): Fixture {
  const dbManager = new DatabaseManager(':memory:');
  const repo = new OvernightRunRepo(dbManager.db);
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const orchestrator = new OvernightOrchestrator(repo, clock);

  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-test-'));
  fs.mkdirSync(workspacePath, { recursive: true });

  return { dbManager, repo, clock, orchestrator, workspacePath };
}

function destroyFixture(fixture: Fixture): void {
  fixture.dbManager.close();
  try {
    fs.rmSync(fixture.workspacePath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Simulated phases helper
// ---------------------------------------------------------------------------

function simulateFullRun(
  orchestrator: OvernightOrchestrator,
  runId: number,
  genCount: number = 3,
  evalCount: number = 5,
): void {
  // Generate phase
  orchestrator.markPhase(runId, 'generate');
  for (let i = 1; i <= genCount; i++) {
    orchestrator.saveCheckpoint(runId, {
      phase: 'generate',
      completedItems: i,
      totalItems: genCount,
      lastProcessedId: `gen-hyp-${i}`,
      metadata: { hypothesisIndex: i, simulated: true },
    });
  }

  // Evaluate phase
  orchestrator.markPhase(runId, 'evaluate');
  for (let i = 1; i <= evalCount; i++) {
    orchestrator.saveCheckpoint(runId, {
      phase: 'evaluate',
      completedItems: i,
      totalItems: evalCount,
      lastProcessedId: `eval-trial-${i}`,
      metadata: { trialIndex: i, simulated: true, meanScore: 0.5 + (i / evalCount) * 0.4 },
    });
  }

  // Complete
  orchestrator.markPhase(runId, 'completed');
  orchestrator.markCompleted(runId);
}

// ---------------------------------------------------------------------------
// Tests: Market-window gate
// ---------------------------------------------------------------------------

describe('M012/S01 Overnight Proof — Market-window gate', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = createFixture();
  });

  afterEach(() => {
    destroyFixture(fx);
  });

  it('refuses execution during Regular market phase', () => {
    const result = fx.orchestrator.tryStart('test-run', fx.workspacePath, REGULAR_TIME);

    expect(result.accepted).toBe(false);
    expect(result.marketPhaseName).toBe('regular');
    expect(result.refusalReason).toContain('Market is open');
    expect(result.run.status).toBe(OvernightRunStatus.Refused);
    expect(result.run.refusalReason).toBe(result.refusalReason);
  });

  it('refuses execution during PreMarket phase', () => {
    const result = fx.orchestrator.tryStart('pre-test', fx.workspacePath, PRE_MARKET_TIME);

    expect(result.accepted).toBe(false);
    expect(result.marketPhaseName).toBe('pre_market');
    expect(result.refusalReason).toContain('Market is open');
    expect(result.run.status).toBe(OvernightRunStatus.Refused);
  });

  it('accepts execution during PostMarket phase', () => {
    const result = fx.orchestrator.tryStart('post-test', fx.workspacePath, POST_MARKET_TIME);

    expect(result.accepted).toBe(true);
    expect(result.marketPhaseName).toBe('post_market');
    expect(result.refusalReason).toBeNull();
    expect(result.run.status).toBe(OvernightRunStatus.Running);
  });

  it('accepts execution when market is closed (after-hours)', () => {
    const result = fx.orchestrator.tryStart('closed-test', fx.workspacePath, CLOSED_AFTER);

    expect(result.accepted).toBe(true);
    expect(result.refusalReason).toBeNull();
    expect(result.marketPhaseName).toBe('closed');
    expect(result.run.status).toBe(OvernightRunStatus.Running);
    expect(result.run.currentPhase).toBe('generate');
    expect(result.run.startedAt).toBeGreaterThan(0);
  });

  it('accepts execution on Saturday (closed)', () => {
    const result = fx.orchestrator.tryStart('sat-test', fx.workspacePath, SATURDAY);

    expect(result.accepted).toBe(true);
    expect(result.marketPhaseName).toBe('closed');
    expect(result.run.status).toBe(OvernightRunStatus.Running);
  });

  it('accepts execution on Sunday (closed)', () => {
    const result = fx.orchestrator.tryStart('sun-test', fx.workspacePath, SUNDAY);

    expect(result.accepted).toBe(true);
    expect(result.marketPhaseName).toBe('closed');
    expect(result.run.status).toBe(OvernightRunStatus.Running);
  });
});

// ---------------------------------------------------------------------------
// Tests: Full run lifecycle with checkpoints
// ---------------------------------------------------------------------------

describe('M012/S01 Overnight Proof — Full run lifecycle', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = createFixture();
  });

  afterEach(() => {
    destroyFixture(fx);
  });

  it('completes a full run cycle with generation and evaluation checkpoints', () => {
    // Start
    const start = fx.orchestrator.tryStart('lifecycle-test', fx.workspacePath, CLOSED_AFTER);
    expect(start.accepted).toBe(true);

    // Run phases
    simulateFullRun(fx.orchestrator, start.run.id, 3, 5);

    // Verify final state
    const final = fx.orchestrator.getRun(start.run.id);
    expect(final).not.toBeNull();
    expect(final!.status).toBe(OvernightRunStatus.Completed);
    expect(final!.currentPhase).toBe('completed');
    expect(final!.completedAt).toBeGreaterThan(0);

    // Verify checkpoint pointer
    expect(final!.checkpointPointer).not.toBeNull();
    const cp = JSON.parse(final!.checkpointPointer!) as OvernightCheckpointMetadata;
    expect(cp.phase).toBe('evaluate');
    expect(cp.completedItems).toBe(5);
    expect(cp.totalItems).toBe(5);
    expect(cp.lastProcessedId).toBe('eval-trial-5');
    expect((cp.metadata as Record<string, unknown>)?.trialIndex).toBe(5);
  });

  it('persists checkpoint progress incrementally across phases', () => {
    const start = fx.orchestrator.tryStart('incremental-test', fx.workspacePath, CLOSED_AFTER);
    expect(start.accepted).toBe(true);
    const runId = start.run.id;

    // Phase 1: generate — 2 items
    fx.orchestrator.markPhase(runId, 'generate');
    fx.orchestrator.saveCheckpoint(runId, {
      phase: 'generate', completedItems: 1, totalItems: 2,
    });
    const cp1 = fx.orchestrator.saveCheckpoint(runId, {
      phase: 'generate', completedItems: 2, totalItems: 2, lastProcessedId: 'hyp-002',
    });
    const p1 = JSON.parse(cp1!.checkpointPointer!) as OvernightCheckpointMetadata;
    expect(p1.completedItems).toBe(2);
    expect(p1.lastProcessedId).toBe('hyp-002');

    // Phase 2: evaluate — 1 item
    fx.orchestrator.markPhase(runId, 'evaluate');
    const cp2 = fx.orchestrator.saveCheckpoint(runId, {
      phase: 'evaluate', completedItems: 1, totalItems: 1, lastProcessedId: 'trial-001',
    });
    const p2 = JSON.parse(cp2!.checkpointPointer!) as OvernightCheckpointMetadata;
    expect(p2.phase).toBe('evaluate');
    expect(p2.completedItems).toBe(1);
    expect(p2.lastProcessedId).toBe('trial-001');

    // Verify checkpoint overwrote previous
    const final = fx.orchestrator.getRun(runId);
    const fp = JSON.parse(final!.checkpointPointer!) as OvernightCheckpointMetadata;
    expect(fp.phase).toBe('evaluate');
    expect(fp.completedItems).toBe(1);
  });

  it('marks a run as failed with error message', () => {
    const start = fx.orchestrator.tryStart('fail-test', fx.workspacePath, CLOSED_AFTER);
    expect(start.accepted).toBe(true);

    const failed = fx.orchestrator.markFailed(start.run.id, 'LLM provider timeout');
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe(OvernightRunStatus.Failed);
    expect(failed!.lastError).toBe('LLM provider timeout');
    expect(failed!.completedAt).toBeGreaterThan(0);
  });

  it('returns null for non-existent run', () => {
    expect(fx.orchestrator.getRun(999)).toBeNull();
  });

  it('getLatestRun returns null when no runs exist', () => {
    expect(fx.orchestrator.getLatestRun()).toBeNull();
  });

  it('getLatestRun returns the most recent run', () => {
    fx.orchestrator.tryStart('first', fx.workspacePath, REGULAR_TIME); // refused
    const second = fx.orchestrator.tryStart('second', fx.workspacePath, CLOSED_AFTER); // accepted

    const latest = fx.orchestrator.getLatestRun();
    expect(latest).not.toBeNull();
    expect(latest!.label).toBe('second');
    expect(latest!.id).toBe(second.run.id);
  });
});

// ---------------------------------------------------------------------------
// Tests: Audit artifact and resume stub
// ---------------------------------------------------------------------------

describe('M012/S01 Overnight Proof — Workspace audit artifacts', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = createFixture();
  });

  afterEach(() => {
    destroyFixture(fx);
  });

  it('writes a durable audit artifact with checkpoint metadata', () => {
    // Run a complete cycle
    const start = fx.orchestrator.tryStart('audit-test', fx.workspacePath, CLOSED_AFTER);
    expect(start.accepted).toBe(true);

    simulateFullRun(fx.orchestrator, start.run.id, 3, 5);
    const finalRun = fx.orchestrator.getRun(start.run.id)!;

    const finalCheckpoint = finalRun.checkpointPointer
      ? (JSON.parse(finalRun.checkpointPointer) as OvernightCheckpointMetadata)
      : null;

    // Write audit artifact
    const auditArtifact: OvernightAuditArtifact = {
      schemaVersion: 1,
      artifactType: 'overnight-audit',
      generatedAt: new Date().toISOString(),
      run: finalRun,
      finalCheckpoint,
      marketPhase: start.run.marketPhase,
      accepted: true,
      refusalReason: null,
      dbPath: ':memory:',
      researchDbPath: null,
      workspacePath: fx.workspacePath,
      simulation: { generateCheckpoints: 3, evaluateCheckpoints: 5, durationMs: 0 },
    };

    const auditPath = path.join(fx.workspacePath, 'overnight-audit.json');
    fs.writeFileSync(auditPath, JSON.stringify(auditArtifact, null, 2), 'utf-8');

    // Read back and verify
    const readBack = JSON.parse(fs.readFileSync(auditPath, 'utf-8')) as OvernightAuditArtifact;
    expect(readBack.schemaVersion).toBe(1);
    expect(readBack.artifactType).toBe('overnight-audit');
    expect(readBack.run.id).toBe(start.run.id);
    expect(readBack.run.status).toBe(OvernightRunStatus.Completed);
    expect(readBack.accepted).toBe(true);
    expect(readBack.finalCheckpoint!.phase).toBe('evaluate');
    expect(readBack.finalCheckpoint!.completedItems).toBe(5);
    expect(readBack.finalCheckpoint!.totalItems).toBe(5);
    expect(readBack.workspacePath).toBe(fx.workspacePath);
  });

  it('writes a resume stub for future agent inspection', () => {
    const start = fx.orchestrator.tryStart('resume-test', fx.workspacePath, CLOSED_AFTER);
    simulateFullRun(fx.orchestrator, start.run.id, 2, 3);

    const finalRun = fx.orchestrator.getRun(start.run.id)!;
    const finalCp = finalRun.checkpointPointer
      ? (JSON.parse(finalRun.checkpointPointer) as OvernightCheckpointMetadata)
      : null;

    const resumeStub = {
      lastPhase: 'completed',
      refusalReason: null,
      checkpointProgress: finalCp
        ? `${finalCp.completedItems}/${finalCp.totalItems} in phase ${finalCp.phase}`
        : null,
      workspacePath: fx.workspacePath,
      dbPath: ':memory:',
      runId: start.run.id,
      runLabel: 'resume-test',
      runStatus: OvernightRunStatus.Completed,
    };

    const resumePath = path.join(fx.workspacePath, 'resume-stub.json');
    fs.writeFileSync(resumePath, JSON.stringify(resumeStub, null, 2), 'utf-8');

    const readBack = JSON.parse(fs.readFileSync(resumePath, 'utf-8'));
    expect(readBack.lastPhase).toBe('completed');
    expect(readBack.refusalReason).toBeNull();
    expect(readBack.checkpointProgress).toBe('3/3 in phase evaluate');
    expect(readBack.workspacePath).toBe(fx.workspacePath);
    expect(readBack.runId).toBe(start.run.id);
    expect(readBack.runStatus).toBe(OvernightRunStatus.Completed);
  });

  it('refused run produces no workspace artifacts', () => {
    // Run refused (regular hours)
    fx.orchestrator.tryStart('refused-no-artifacts', fx.workspacePath, REGULAR_TIME);

    const files = fs.readdirSync(fx.workspacePath);
    expect(files).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Repo-level queries
// ---------------------------------------------------------------------------

describe('M012/S01 Overnight Proof — Repo queries', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = createFixture();
  });

  afterEach(() => {
    destroyFixture(fx);
  });

  it('counts runs by status', () => {
    // 2 refused, 1 accepted
    fx.orchestrator.tryStart('ref1', fx.workspacePath, REGULAR_TIME);
    fx.orchestrator.tryStart('ref2', fx.workspacePath, PRE_MARKET_TIME);
    fx.orchestrator.tryStart('ok', fx.workspacePath, CLOSED_AFTER);

    expect(fx.repo.countRuns()).toBe(3);
    expect(fx.repo.countByStatus(OvernightRunStatus.Refused)).toBe(2);
    expect(fx.repo.countByStatus(OvernightRunStatus.Running)).toBe(1);
  });

  it('lists runs newest first', () => {
    fx.orchestrator.tryStart('first', `${fx.workspacePath}/first`, CLOSED_AFTER);
    fx.orchestrator.tryStart('second', `${fx.workspacePath}/second`, CLOSED_AFTER);
    fx.orchestrator.tryStart('third', `${fx.workspacePath}/third`, CLOSED_AFTER);

    const runs = fx.repo.listRuns(5);
    expect(runs).toHaveLength(3);
    expect(runs[0].label).toBe('third');
    expect(runs[1].label).toBe('second');
    expect(runs[2].label).toBe('first');
  });
});
