#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseManager } from '../persistence/sqlite.js';
import { MarketClock } from '../runtime/market-clock.js';
import { INDIA_NSE_EQ_MARKET } from '../market/india-profile.js';
import {
  OvernightRunRepo,
  type OvernightRunRow,
  type OvernightCheckpointMetadata,
  type OvernightPhase,
} from './overnight-run-repo.js';
import {
  OvernightOrchestrator,
} from './overnight-orchestrator.js';
import { loadProjectEnvFile } from '../replay/walk-forward-db-path.js';
import { resolveBudgetPolicy } from './hypothesis-generation-budget.js';
import { HypothesisRepository } from '../persistence/hypothesis-repo.js';
import { ResearchPublishBackService } from './publish-back-service.js';
import { HypothesisEvaluationStatus } from '../types/runtime.js';

const RESEARCH_ARTIFACTS_ROOT = path.join('data', 'artifacts', 'overnight');

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
      case '--db-path': options.dbPath = value; i++; break;
      case '--research-db-path': options.researchDbPath = value; i++; break;
      case '--workspace-path': options.workspacePath = value; i++; break;
      case '--label': options.label = value; i++; break;
      case '--now': options.now = new Date(Number(value)); i++; break;
      case '--simulate-phases': options.simulatePhases = !(value === 'false' || value === '0'); i++; break;
      case '--simulate-gen-count': options.simulateGenCount = Number(value); i++; break;
      case '--simulate-eval-count': options.simulateEvalCount = Number(value); i++; break;
      case '--max-accepted-candidates': options.maxAcceptedCandidates = Number(value); i++; break;
      case '--max-llm-calls': options.maxLlmCalls = Number(value); i++; break;
      case '--dry-run': options.dryRun = true; break;
      case '--hold-open-ms': options.holdOpenMs = Number(value); i++; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
        break;
    }
  }

  return options;
}

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
    checkpoint = {
      phase: 'generate',
      completedItems: i,
      totalItems: genCount,
      lastProcessedId: `gen-hyp-${i}`,
      metadata: { hypothesisIndex: i, simulated: true },
    };
    orchestrator.saveCheckpoint(runId, checkpoint);
  }
  return checkpoint;
}

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
      metadata: { trialIndex: i, simulated: true, meanScore: 0.5 + (i / Math.max(1, evalCount)) * 0.4 },
    };
    orchestrator.saveCheckpoint(runId, checkpoint);
  }
  return checkpoint;
}

function findLatestCompletedEvaluationId(dbm: DatabaseManager): number | null {
  const repo = new HypothesisRepository(dbm.db);
  const evaluations = repo.listEvaluations(50);
  for (const evaluation of evaluations) {
    if (evaluation.status === HypothesisEvaluationStatus.Completed) {
      return evaluation.id;
    }
  }
  return null;
}

function simulatePublishPhase(dbm: DatabaseManager, run: OvernightRunRow) {
  const evaluationId = findLatestCompletedEvaluationId(dbm);
  if (evaluationId == null) {
    return {
      verdict: 'hold' as const,
      publicationId: null,
      lifecycleStateId: null,
      governanceDecisionId: null,
      rationale: 'No completed hypothesis evaluation found in the research DB for publish-back.',
      evaluationId: null,
    };
  }

  const service = new ResearchPublishBackService({ db: dbm.db });
  const result = service.publish(evaluationId, { dryRun: false });
  return {
    verdict: result.verdict,
    publicationId: result.publication?.id ?? null,
    lifecycleStateId: result.lifecycleStateId,
    governanceDecisionId: result.governanceDecisionId,
    rationale: result.rationale,
    evaluationId,
  };
}

export interface OvernightAuditArtifact {
  schemaVersion: number;
  artifactType: 'overnight-audit';
  generatedAt: string;
  run: OvernightRunRow;
  finalCheckpoint: OvernightCheckpointMetadata | null;
  marketPhase: string | null;
  accepted: boolean;
  refusalReason: string | null;
  dbPath: string;
  researchDbPath: string | null;
  workspacePath: string;
  simulation: {
    generateCheckpoints: number;
    evaluateCheckpoints: number;
    durationMs: number;
  };
  resumed: boolean;
  nextPhaseAtStart: OvernightPhase | null;
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

async function main(): Promise<void> {
  loadProjectEnvFile();
  const options = parseArgs(process.argv.slice(2));
  const startTime = Date.now();

  if (!options.simulatePhases && !options.researchDbPath) {
    console.error(JSON.stringify({ status: 'refused', reason: 'Fail-closed: --research-db-path is required when --simulate-phases=false.', timestamp: new Date().toISOString() }, null, 2));
    process.exit(1);
  }

  if (options.dryRun) {
    console.log(JSON.stringify({ status: 'dry_run', ...options, now: options.now?.toISOString() ?? null, timestamp: new Date().toISOString() }, null, 2));
    process.exit(0);
  }

  fs.mkdirSync(options.workspacePath, { recursive: true });

  const dbManager = new DatabaseManager(options.dbPath);
  const repo = new OvernightRunRepo(dbManager.db);
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const orchestrator = new OvernightOrchestrator(repo, clock);
  const resolvedBudget = resolveBudgetPolicy({
    maxAcceptedCandidates: options.maxAcceptedCandidates ?? undefined,
    maxLlmCalls: options.maxLlmCalls ?? undefined,
  });

  try {
    const result = orchestrator.tryStartOrResume({
      label: options.label,
      workspacePath: options.workspacePath,
      now: options.now ?? undefined,
      researchDbPath: options.researchDbPath ?? undefined,
    });

    let run = orchestrator.getRun(result.run.id) ?? result.run;
    const nextPhaseAtStart = result.accepted ? orchestrator.getNextPhase(run) : null;
    let simulatedSkippedGenerationReasons: string[] = [];
    let simulatedPrunedEvaluationCount = 0;

    if (result.accepted && options.simulatePhases) {
      const acceptedCandidates = Math.min(options.simulateGenCount, resolvedBudget.maxAcceptedCandidates);
      const skippedCount = Math.max(0, options.simulateGenCount - acceptedCandidates);
      const evaluatedCount = Math.min(options.simulateEvalCount, acceptedCandidates);
      simulatedPrunedEvaluationCount = Math.max(0, acceptedCandidates - evaluatedCount);

      run = orchestrator.getRun(run.id) ?? run;
      let phase = orchestrator.getNextPhase(run);

      if (phase === 'generate') {
        orchestrator.markPhase(run.id, 'generate');
        simulateGeneratePhase(orchestrator, run.id, acceptedCandidates);
        for (let i = 0; i < skippedCount; i++) simulatedSkippedGenerationReasons.push('provider_disallowed');
        orchestrator.markPhaseCompleted(run.id, 'generate');
        run = orchestrator.getRun(run.id) ?? run;
        phase = orchestrator.getNextPhase(run);
      }

      if (phase === 'evaluate') {
        orchestrator.markPhase(run.id, 'evaluate');
        simulateEvaluatePhase(orchestrator, run.id, evaluatedCount);
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
        orchestrator.saveCheckpoint(run.id, budgetCheckpoint);
        orchestrator.markPhaseCompleted(run.id, 'evaluate');
        run = orchestrator.getRun(run.id) ?? run;
        phase = orchestrator.getNextPhase(run);
      }

      if (phase === 'publish') {
        orchestrator.markPhase(run.id, 'publish');
        const publication = simulatePublishPhase(dbManager, run);
        orchestrator.recordPublication(run.id, {
          verdict: publication.verdict,
          publicationId: publication.publicationId,
          lifecycleStateId: publication.lifecycleStateId,
          governanceDecisionId: publication.governanceDecisionId,
          rationale: publication.rationale,
          recordedAt: Date.now(),
        });
        orchestrator.markPhaseCompleted(run.id, 'publish', publication.rationale);
        run = orchestrator.getRun(run.id) ?? run;
      }

      orchestrator.markCompleted(run.id);
      run = orchestrator.getRun(run.id) ?? run;
    }

    const durationMs = Date.now() - startTime;
    const finalRun = orchestrator.getRun(run.id) ?? run;
    const finalCheckpoint = orchestrator.readCheckpoint(finalRun);

    const auditArtifact: OvernightAuditArtifact = {
      schemaVersion: 1,
      artifactType: 'overnight-audit',
      generatedAt: new Date().toISOString(),
      run: finalRun,
      finalCheckpoint,
      marketPhase: result.run.marketPhase,
      accepted: result.accepted,
      refusalReason: result.refusalReason,
      dbPath: options.dbPath,
      researchDbPath: options.researchDbPath,
      workspacePath: options.workspacePath,
      resumed: result.resumed,
      nextPhaseAtStart,
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

    const auditPath = path.join(options.workspacePath, 'overnight-audit.json');
    fs.writeFileSync(auditPath, JSON.stringify(auditArtifact, null, 2), 'utf-8');
    fs.chmodSync(auditPath, 0o600);

    const resumeStub = {
      lastPhase: result.accepted ? (finalRun.currentPhase ?? 'completed') : 'refused',
      refusalReason: result.refusalReason ?? null,
      checkpointProgress: finalCheckpoint ? `${finalCheckpoint.completedItems}/${finalCheckpoint.totalItems} in phase ${finalCheckpoint.phase}` : null,
      workspacePath: options.workspacePath,
      dbPath: options.dbPath,
      researchDbPath: options.researchDbPath,
      runId: finalRun.id,
      runLabel: finalRun.label,
      runStatus: finalRun.status,
      resumed: result.resumed,
      nextPhaseAtStart,
      metadataJson: finalRun.metadataJson,
    };

    const resumePath = path.join(options.workspacePath, 'resume-stub.json');
    fs.writeFileSync(resumePath, JSON.stringify(resumeStub, null, 2), 'utf-8');
    fs.chmodSync(resumePath, 0o600);

    console.log(JSON.stringify({
      status: result.accepted ? 'accepted' : 'refused',
      runId: finalRun.id,
      runLabel: finalRun.label,
      runStatus: finalRun.status,
      accepted: result.accepted,
      resumed: result.resumed,
      refusalReason: result.refusalReason,
      marketPhase: result.marketPhaseName,
      marketPhaseValue: result.marketPhase,
      workspacePath: options.workspacePath,
      dbPath: options.dbPath,
      researchDbPath: options.researchDbPath,
      auditArtifactPath: auditPath,
      resumeStubPath: resumePath,
      checkpointProgress: finalCheckpoint ? `${finalCheckpoint.completedItems}/${finalCheckpoint.totalItems}` : null,
      checkpointPhase: finalCheckpoint?.phase ?? null,
      nextPhaseAtStart,
      simulationDurationMs: durationMs,
    }, null, 2));

    if (options.holdOpenMs > 0) {
      await new Promise(resolve => setTimeout(resolve, options.holdOpenMs));
    }
    process.exit(0);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ status: 'error', error: errorMessage, timestamp: new Date().toISOString() }, null, 2));
    process.exit(1);
  } finally {
    dbManager.close();
  }
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', error: err instanceof Error ? err.message : String(err), timestamp: new Date().toISOString() }, null, 2));
  process.exit(1);
});
