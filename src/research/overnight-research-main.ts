#!/usr/bin/env node
// ── Overnight Research CLI ──
// Standalone entrypoint for the overnight research orchestration seam.
// Exercises the market-window gate, run-state transitions, checkpoint/resume
// metadata persistence, and writes durable audit artifacts to the research
// workspace — all without touching src/main.ts or src/runtime/scheduler.ts.
//
// Usage:
//   npx tsx src/research/overnight-research-main.ts [options]
//
// Options:
//   --db-path <string>         Path to SQLite database (default: :memory:).
//   --workspace-path <string>  Path to research workspace (default: auto-generated).
//   --label <string>           Human-readable run label (default: auto-generated).
//   --now <number>             Unix timestamp override for testing market-window gate.
//   --simulate-phases          Run simulated generation/evaluation phases (default: true).
//   --simulate-gen-count <n>   Simulated generation items count (default: 3).
//   --simulate-eval-count <n>  Simulated evaluation items count (default: 5).
//   --dry-run                  Validate env/config without executing.
//   --hold-open-ms <n>         Keep process alive for n ms after completion.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseManager } from '../persistence/sqlite.js';
import { MarketClock } from '../runtime/market-clock.js';
import { INDIA_NSE_EQ_MARKET } from '../market/india-profile.js';
import {
  OvernightRunRepo,
  OvernightRunStatus,
  type OvernightRunRow,
  type OvernightCheckpointMetadata,
} from './overnight-run-repo.js';
import {
  OvernightOrchestrator,
  type TryStartResult,
} from './overnight-orchestrator.js';
import { loadProjectEnvFile } from '../replay/walk-forward-db-path.js';
import { resolveBudgetPolicy } from './hypothesis-generation-budget.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESEARCH_ARTIFACTS_ROOT = path.join('data', 'artifacts', 'overnight');

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------

export interface OvernightCliOptions {
  dbPath: string;
  researchDbPath: string | null;
  workspacePath: string;
  label: string;
  now: Date | null;
  simulatePhases: boolean;
  simulateGenCount: number;
  simulateEvalCount: number;
  maxAcceptedCandidates: number | null;
  maxLlmCalls: number | null;
  dryRun: boolean;
  holdOpenMs: number;
}

export function parseArgs(argv: string[]): OvernightCliOptions {
  const stamp = Date.now();
  const options: OvernightCliOptions = {
    dbPath: ':memory:',
    researchDbPath: null,
    workspacePath: path.join(RESEARCH_ARTIFACTS_ROOT, `run-${stamp}`),
    label: `overnight-research-${stamp}`,
    now: null,
    simulatePhases: true,
    simulateGenCount: 3,
    simulateEvalCount: 5,
    maxAcceptedCandidates: null,
    maxLlmCalls: null,
    dryRun: false,
    holdOpenMs: 0,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];

    switch (arg) {
      case '--db-path':
        options.dbPath = value;
        i++;
        break;
      case '--research-db-path':
        options.researchDbPath = value;
        i++;
        break;
      case '--workspace-path':
        options.workspacePath = value;
        i++;
        break;
      case '--label':
        options.label = value;
        i++;
        break;
      case '--now':
        options.now = new Date(Number(value));
        i++;
        break;
      case '--simulate-phases':
        if (value === 'false' || value === '0') {
          options.simulatePhases = false;
        } else {
          options.simulatePhases = true;
        }
        i++;
        break;
      case '--simulate-gen-count':
        options.simulateGenCount = Number(value);
        if (!Number.isFinite(options.simulateGenCount) || options.simulateGenCount < 0) {
          throw new Error('--simulate-gen-count must be a non-negative integer.');
        }
        i++;
        break;
      case '--simulate-eval-count':
        options.simulateEvalCount = Number(value);
        if (!Number.isFinite(options.simulateEvalCount) || options.simulateEvalCount < 0) {
          throw new Error('--simulate-eval-count must be a non-negative integer.');
        }
        i++;
        break;
      case '--max-accepted-candidates':
        options.maxAcceptedCandidates = Number(value);
        if (!Number.isFinite(options.maxAcceptedCandidates) || options.maxAcceptedCandidates < 0) {
          throw new Error('--max-accepted-candidates must be a non-negative integer.');
        }
        i++;
        break;
      case '--max-llm-calls':
        options.maxLlmCalls = Number(value);
        if (!Number.isFinite(options.maxLlmCalls) || options.maxLlmCalls < 0) {
          throw new Error('--max-llm-calls must be a non-negative integer.');
        }
        i++;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--hold-open-ms':
        options.holdOpenMs = Number(value);
        if (!Number.isFinite(options.holdOpenMs) || options.holdOpenMs < 0) {
          throw new Error('--hold-open-ms must be a non-negative integer.');
        }
        i++;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        break;
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Simulated phases
// ---------------------------------------------------------------------------

/**
 * Simulate the generate phase by advancing checkpoints at a regular cadence.
 * Returns the final checkpoint metadata.
 */
function simulateGeneratePhase(
  orchestrator: OvernightOrchestrator,
  runId: number,
  genCount: number,
): OvernightCheckpointMetadata {
  let checkpoint: OvernightCheckpointMetadata = {
    phase: 'generate',
    completedItems: 0,
    totalItems: genCount,
  };

  for (let i = 1; i <= genCount; i++) {
    // Simulate some work
    checkpoint = {
      phase: 'generate',
      completedItems: i,
      totalItems: genCount,
      lastProcessedId: `gen-hyp-${i}`,
      metadata: {
        hypothesisIndex: i,
        simulated: true,
      },
    };
    orchestrator.saveCheckpoint(runId, checkpoint);
  }

  return checkpoint;
}

/**
 * Simulate the evaluate phase by advancing checkpoints at a regular cadence.
 * Returns the final checkpoint metadata.
 */
function simulateEvaluatePhase(
  orchestrator: OvernightOrchestrator,
  runId: number,
  evalCount: number,
): OvernightCheckpointMetadata {
  let checkpoint: OvernightCheckpointMetadata = {
    phase: 'evaluate',
    completedItems: 0,
    totalItems: evalCount,
  };

  for (let i = 1; i <= evalCount; i++) {
    checkpoint = {
      phase: 'evaluate',
      completedItems: i,
      totalItems: evalCount,
      lastProcessedId: `eval-trial-${i}`,
      metadata: {
        trialIndex: i,
        simulated: true,
        meanScore: 0.5 + (i / evalCount) * 0.4, // improving scores
      },
    };
    orchestrator.saveCheckpoint(runId, checkpoint);
  }

  return checkpoint;
}

// ---------------------------------------------------------------------------
// Audit artifact types
// ---------------------------------------------------------------------------

/** Durable audit artifact written to the research workspace after a run. */
export interface OvernightAuditArtifact {
  schemaVersion: number;
  artifactType: 'overnight-audit';
  /** ISO-8601 timestamp of artifact generation. */
  generatedAt: string;
  /** The full persisted run row with all state transitions. */
  run: OvernightRunRow;
  /** Final checkpoint pointer parsed from the run row (null if none). */
  finalCheckpoint: OvernightCheckpointMetadata | null;
  /** Market phase at decision time. */
  marketPhase: string | null;
  /** Was the run accepted by the gate? */
  accepted: boolean;
  /** Refusal reason when accepted is false. */
  refusalReason: string | null;
  /** Path to the SQLite database used. */
  dbPath: string;
  /** Explicit path to the isolated research DB. */
  researchDbPath: string | null;
  /** Path to the research workspace. */
  workspacePath: string;
  /** Phase simulation timing metadata. */
  simulation: {
    generateCheckpoints: number;
    evaluateCheckpoints: number;
    durationMs: number;
  };
  budget?: {
    maxAcceptedCandidates: number | null;
    maxLlmCalls: number | null;
    acceptedCandidates: number;
    llmCalls: number;
    exhausted: boolean;
    skippedGenerationCount: number;
    prunedEvaluationCount: number;
    skipReasonCodes: string[];
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadProjectEnvFile();

  const options = parseArgs(process.argv.slice(2));
  const startTime = Date.now();

  // ── Fail closed: require explicit research DB path when not simulating ──
  if (!options.simulatePhases && !options.researchDbPath) {
    console.error(JSON.stringify({
      status: 'refused',
      reason: 'Fail-closed: --research-db-path is required when --simulate-phases=false.',
      timestamp: new Date().toISOString(),
    }, null, 2));
    process.exit(1);
  }

  // ── Dry run ──
  if (options.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      dbPath: options.dbPath,
      researchDbPath: options.researchDbPath,
      workspacePath: options.workspacePath,
      label: options.label,
      now: options.now?.toISOString() ?? null,
      simulatePhases: options.simulatePhases,
      simulateGenCount: options.simulateGenCount,
      simulateEvalCount: options.simulateEvalCount,
      maxAcceptedCandidates: options.maxAcceptedCandidates,
      maxLlmCalls: options.maxLlmCalls,
      timestamp: new Date().toISOString(),
    }, null, 2));
    process.exit(0);
  }

  // ── Ensure research workspace directory exists ──
  fs.mkdirSync(options.workspacePath, { recursive: true });

  // ── Open DB and wire services ──
  const dbManager = new DatabaseManager(options.dbPath);
  const repo = new OvernightRunRepo(dbManager.db);
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const orchestrator = new OvernightOrchestrator(repo, clock);
  const resolvedBudget = resolveBudgetPolicy({
    maxAcceptedCandidates: options.maxAcceptedCandidates ?? undefined,
    maxLlmCalls: options.maxLlmCalls ?? undefined,
  });

  try {
    // ── Attempt to start the run ──
    const result = orchestrator.tryStart(
      options.label,
      options.workspacePath,
      options.now ?? undefined,
      options.researchDbPath ?? undefined,
    );

    // ── Simulation phases (only when accepted) ──
    let genCheckpoint: OvernightCheckpointMetadata | null = null;
    let evalCheckpoint: OvernightCheckpointMetadata | null = null;
    let completedRun: OvernightRunRow | null = null;
    const simulatedSkippedGenerationReasons: string[] = [];
    let simulatedPrunedEvaluationCount = 0;

    if (result.accepted && options.simulatePhases) {
      const acceptedCandidates = Math.min(options.simulateGenCount, resolvedBudget.maxAcceptedCandidates);
      const skippedCount = Math.max(0, options.simulateGenCount - acceptedCandidates);
      const evaluatedCount = Math.min(options.simulateEvalCount, acceptedCandidates);
      simulatedPrunedEvaluationCount = Math.max(0, acceptedCandidates - evaluatedCount);

      // Phase 1: Generate
      orchestrator.markPhase(result.run.id, 'generate');
      genCheckpoint = simulateGeneratePhase(orchestrator, result.run.id, acceptedCandidates);
      for (let i = 0; i < skippedCount; i++) {
        simulatedSkippedGenerationReasons.push('provider_disallowed');
      }

      // Phase 2: Evaluate
      orchestrator.markPhase(result.run.id, 'evaluate');
      evalCheckpoint = simulateEvaluatePhase(orchestrator, result.run.id, evaluatedCount);

      const budgetCheckpoint: OvernightCheckpointMetadata = {
        phase: 'evaluate',
        completedItems: evaluatedCount,
        totalItems: acceptedCandidates,
        metadata: {
          budget: {
            acceptedCandidates,
            skippedGenerationCount: skippedCount,
            prunedEvaluationCount: simulatedPrunedEvaluationCount,
            maxAcceptedCandidates: Number.isFinite(resolvedBudget.maxAcceptedCandidates) ? resolvedBudget.maxAcceptedCandidates : null,
            maxLlmCalls: Number.isFinite(resolvedBudget.maxLlmCalls) ? resolvedBudget.maxLlmCalls : null,
            skipReasonCodes: simulatedSkippedGenerationReasons,
          },
        },
      };
      orchestrator.saveCheckpoint(result.run.id, budgetCheckpoint);

      // Phase 3: Complete
      orchestrator.markPhase(result.run.id, 'completed');
      completedRun = orchestrator.markCompleted(result.run.id);
    }

    const finalRun = completedRun ?? orchestrator.getRun(result.run.id);

    // ── Build audit artifact ──
    const durationMs = Date.now() - startTime;
    const finalCheckpoint = finalRun?.checkpointPointer
      ? (JSON.parse(finalRun.checkpointPointer) as OvernightCheckpointMetadata)
      : null;

    const auditArtifact: OvernightAuditArtifact = {
      schemaVersion: 1,
      artifactType: 'overnight-audit',
      generatedAt: new Date().toISOString(),
      run: finalRun ?? result.run,
      finalCheckpoint,
      marketPhase: result.run.marketPhase,
      accepted: result.accepted,
      refusalReason: result.refusalReason,
      dbPath: options.dbPath,
      researchDbPath: options.researchDbPath,
      workspacePath: options.workspacePath,
      simulation: {
        generateCheckpoints: options.simulateGenCount,
        evaluateCheckpoints: options.simulateEvalCount,
        durationMs,
      },
      budget: {
        maxAcceptedCandidates: Number.isFinite(resolvedBudget.maxAcceptedCandidates) ? resolvedBudget.maxAcceptedCandidates : null,
        maxLlmCalls: Number.isFinite(resolvedBudget.maxLlmCalls) ? resolvedBudget.maxLlmCalls : null,
        acceptedCandidates: finalCheckpoint?.metadata?.budget && typeof finalCheckpoint.metadata.budget === 'object' && finalCheckpoint.metadata.budget !== null && 'acceptedCandidates' in finalCheckpoint.metadata.budget
          ? Number((finalCheckpoint.metadata.budget as Record<string, unknown>).acceptedCandidates ?? 0)
          : Math.min(options.simulateGenCount, Number.isFinite(resolvedBudget.maxAcceptedCandidates) ? resolvedBudget.maxAcceptedCandidates : options.simulateGenCount),
        llmCalls: Math.min(options.simulateGenCount, Number.isFinite(resolvedBudget.maxLlmCalls) ? resolvedBudget.maxLlmCalls : options.simulateGenCount),
        exhausted: options.simulateGenCount > (Number.isFinite(resolvedBudget.maxAcceptedCandidates) ? resolvedBudget.maxAcceptedCandidates : options.simulateGenCount)
          || options.simulateGenCount >= (Number.isFinite(resolvedBudget.maxLlmCalls) ? resolvedBudget.maxLlmCalls : Number.POSITIVE_INFINITY),
        skippedGenerationCount: Math.max(0, options.simulateGenCount - Math.min(options.simulateGenCount, Number.isFinite(resolvedBudget.maxAcceptedCandidates) ? resolvedBudget.maxAcceptedCandidates : options.simulateGenCount)),
        prunedEvaluationCount: simulatedPrunedEvaluationCount,
        skipReasonCodes: simulatedSkippedGenerationReasons,
      },
    };

    // ── Write audit artifact to workspace ──
    const auditPath = path.join(options.workspacePath, 'overnight-audit.json');
    const auditJson = JSON.stringify(auditArtifact, null, 2);
    fs.writeFileSync(auditPath, auditJson, 'utf-8');
    fs.chmodSync(auditPath, 0o600);

    // ── Write a resume stub for future agents ──
    const resumeStub: Record<string, unknown> = {
      lastPhase: result.accepted ? 'completed' : 'refused',
      refusalReason: result.refusalReason ?? null,
      checkpointProgress: finalCheckpoint
        ? `${finalCheckpoint.completedItems}/${finalCheckpoint.totalItems} in phase ${finalCheckpoint.phase}`
        : null,
      workspacePath: options.workspacePath,
      dbPath: options.dbPath,
      researchDbPath: options.researchDbPath,
      runId: result.run.id,
      runLabel: options.label,
      runStatus: finalRun?.status ?? result.run.status,
    };

    const resumePath = path.join(options.workspacePath, 'resume-stub.json');
    fs.writeFileSync(resumePath, JSON.stringify(resumeStub, null, 2), 'utf-8');
    fs.chmodSync(resumePath, 0o600);

    // ── Emit output summary as JSON to stdout ──
    const output: Record<string, unknown> = {
      status: result.accepted ? 'accepted' : 'refused',
      runId: result.run.id,
      runLabel: result.run.label,
      runStatus: finalRun?.status ?? result.run.status,
      accepted: result.accepted,
      refusalReason: result.refusalReason,
      marketPhase: result.marketPhaseName,
      marketPhaseValue: result.marketPhase,
      workspacePath: options.workspacePath,
      dbPath: options.dbPath,
      researchDbPath: options.researchDbPath,
      auditArtifactPath: auditPath,
      resumeStubPath: resumePath,
      checkpointProgress: finalCheckpoint
        ? `${finalCheckpoint.completedItems}/${finalCheckpoint.totalItems}`
        : null,
      checkpointPhase: finalCheckpoint?.phase ?? null,
      simulationDurationMs: durationMs,
    };

    if (result.accepted && completedRun) {
      output.completedAt = completedRun.completedAt;
    }

    console.log(JSON.stringify(output, null, 2));

    // ── Hold open if requested ──
    if (options.holdOpenMs > 0) {
      await new Promise(resolve => setTimeout(resolve, options.holdOpenMs));
    }

    // Exit 0 regardless of gate outcome (we want CI to see both branches)
    process.exit(0);

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      status: 'error',
      error: errorMessage,
      timestamp: new Date().toISOString(),
    }, null, 2));
    process.exit(1);
  } finally {
    dbManager.close();
  }
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    error: err instanceof Error ? err.message : String(err),
    timestamp: new Date().toISOString(),
  }, null, 2));
  process.exit(1);
});
