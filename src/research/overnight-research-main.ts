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
  parseOvernightRunMetadata,
} from './overnight-run-repo.js';
import {
  OvernightOrchestrator,
} from './overnight-orchestrator.js';
import { loadProjectEnvFile } from '../replay/walk-forward-db-path.js';
import { resolveBudgetPolicy } from './hypothesis-generation-budget.js';
import { HypothesisRepository } from '../persistence/hypothesis-repo.js';
import { HypothesisMemoryRepository } from '../persistence/hypothesis-memory-repo.js';
import { StrategyLifecycleRepository } from '../persistence/strategy-lifecycle-repo.js';
import { HypothesisGenerationRepository } from '../persistence/hypothesis-generation-repo.js';
import { ResearchPublishBackService } from './publish-back-service.js';
import { ResearchAuditService } from './research-audit-service.js';
import { HypothesisEvaluationStatus, type ResearchLineageSnapshot, type HypothesisGenerationConfig, type ProposalEngineConfig } from '../types/runtime.js';
import { HypothesisGenerationService } from './hypothesis-generation-service.js';
import { HypothesisValidator } from './hypothesis-validator.js';
import { HypothesisResearchEvaluator } from './hypothesis-evaluator.js';
import { ResearchArtifactWriter } from './artifact-writer.js';
import { WinnerSelector } from '../replay/winner-selection.js';
import { WalkForwardEvaluator } from '../replay/walk-forward-evaluator.js';
import { FixtureHistoricalDataProvider } from '../replay/historical-data-provider.js';
import { IndiaResearchBuilder } from '../strategy/india-research.js';
import { StrategyRunRepository } from '../persistence/strategy-run-repo.js';
import { WalkForwardRepository } from '../persistence/walk-forward-repo.js';
import { loadConfig } from '../config/env.js';

const RESEARCH_ARTIFACTS_ROOT = path.join('data', 'artifacts', 'overnight');

type PhaseStop = 'generate' | 'evaluate' | 'publish' | null;

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
  stopAfterPhase: PhaseStop;
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
    stopAfterPhase: null,
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
      case '--stop-after-phase': {
        if (!['generate', 'evaluate', 'publish'].includes(value)) {
          throw new Error(`Unknown phase for --stop-after-phase: ${value}`);
        }
        options.stopAfterPhase = value as PhaseStop;
        i++;
        break;
      }
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
  totalItems: number,
): OvernightCheckpointMetadata {
  let checkpoint: OvernightCheckpointMetadata = {
    phase: 'evaluate',
    completedItems: 0,
    totalItems,
  };
  for (let i = 1; i <= evalCount; i++) {
    checkpoint = {
      phase: 'evaluate',
      completedItems: i,
      totalItems,
      lastProcessedId: `eval-trial-${i}`,
      metadata: { trialIndex: i, simulated: true, meanScore: 0.5 + (i / Math.max(1, totalItems)) * 0.4 },
    };
    orchestrator.saveCheckpoint(runId, checkpoint);
  }
  return checkpoint;
}

function findCompletedEvaluationIds(dbm: DatabaseManager): number[] {
  const repo = new HypothesisRepository(dbm.db);
  return repo
    .getRecentEvaluations(200)
    .filter(evaluation => evaluation.status === HypothesisEvaluationStatus.Completed)
    .map(evaluation => evaluation.id);
}

function findLatestCompletedEvaluationId(dbm: DatabaseManager): number | null {
  const completed = findCompletedEvaluationIds(dbm);
  return completed.length > 0 ? completed[0] : null;
}

function findEvaluatedHypothesisIds(dbm: DatabaseManager): number[] {
  const repo = new HypothesisRepository(dbm.db);
  return repo
    .getRecentEvaluations(200)
    .filter(evaluation => evaluation.status === HypothesisEvaluationStatus.Completed)
    .map(evaluation => evaluation.hypothesisGraphId);
}

function findGeneratedHypothesisIds(dbm: DatabaseManager): number[] {
  const repo = new HypothesisRepository(dbm.db);
  return repo.getRecentHypotheses(200).map(hypothesis => hypothesis.id);
}

// ---------------------------------------------------------------------------
// Real overnight phase helpers (non-simulate)
// ---------------------------------------------------------------------------

function buildProposalConfig(): ProposalEngineConfig | null {
  try {
    const config = loadConfig(process.env);
    return config.proposalEngine;
  } catch {
    return null;
  }
}

async function runRealGenerationPhase(
  dbManager: DatabaseManager,
  orchestrator: OvernightOrchestrator,
  runId: number,
  budget: ReturnType<typeof resolveBudgetPolicy>,
): Promise<number[]> {
  const proposalConfig = buildProposalConfig();
  if (!proposalConfig) {
    throw new Error('No proposal engine configured. Set TRADER_PROPOSAL_PROVIDER_URL and related env vars.');
  }

  const db = dbManager.db;
  const hypothesisRepo = new HypothesisRepository(db);
  const memoryRepo = new HypothesisMemoryRepository(db);
  const generationRepo = new HypothesisGenerationRepository(db);
  const strategyRunRepo = new StrategyRunRepository(db);
  const validator = new HypothesisValidator({ memoryRepo, hypothesisRepo });

  let evaluator: HypothesisResearchEvaluator | undefined;
  {
    const dataProvider = new FixtureHistoricalDataProvider({
      candidates: [],
      rangeStart: Date.now() - 30 * 86_400_000,
      rangeEnd: Date.now(),
    });
    const walkForwardEval = new WalkForwardEvaluator({
      db,
      marketProfile: INDIA_NSE_EQ_MARKET,
      dataProvider,
    });
    const artifactWriter = new ResearchArtifactWriter();
    const winnerSelector = new WinnerSelector();
    const walkForwardRepo = new WalkForwardRepository(db);
    evaluator = new HypothesisResearchEvaluator({
      db,
      dataProvider,
      marketProfile: INDIA_NSE_EQ_MARKET,
      hypothesisRepo,
      walkForwardRepo,
      artifactWriter,
      winnerSelector,
      walkForwardEvaluator: walkForwardEval,
    });
  }

  const indiaResearchBuilder = new IndiaResearchBuilder();

  const generationService = new HypothesisGenerationService({
    db,
    config: proposalConfig,
    hypothesisRepo,
    generationRepo,
    memoryRepo,
    validator,
    evaluator,
    strategyRunRepo,
    indiaResearchBuilder,
  });

  const genConfig: HypothesisGenerationConfig = {
    instruction: 'Generate one novel trading hypothesis for NSE India equities using mean-reversion or trend-following signals. Focus on liquid stocks (volume > 500k). Combine entry and exit rules with an ATR-based risk stop. Return a valid hypothesis graph JSON object.',
    skipEvaluation: true,
    maxContextCandidates: 5,
    marketId: 'INDIA_NSE_EQ',
  };

  const generatedIds: number[] = [];
  const maxGen = Number.isFinite(budget.maxAcceptedCandidates) ? budget.maxAcceptedCandidates : 5;

  orchestrator.markPhase(runId, 'generate');

  for (let i = 0; i < maxGen; i++) {
    const result = await generationService.generate(genConfig);
    if (result.kind === 'accepted') {
      generatedIds.push(result.hypothesis.id);
      orchestrator.saveCheckpoint(runId, {
        phase: 'generate',
        completedItems: generatedIds.length,
        totalItems: maxGen,
        lastProcessedId: String(result.hypothesis.id),
      });
    } else if (result.kind === 'rejected' || result.kind === 'skipped') {
      // Budget exhausted or duplicate — stop generation
      break;
    } else if (result.kind === 'provider_error') {
      throw new Error(`Provider error during generation: ${result.error}`);
    }
  }

  orchestrator.recordPhaseResult(runId, {
    phase: 'generate',
    recordedAt: Date.now(),
    detail: `Real overnight generation completed. ${generatedIds.length} hypotheses accepted.`,
  });
  orchestrator.markPhaseCompleted(runId, 'generate');

  return generatedIds;
}

async function runRealEvaluatePhase(
  dbManager: DatabaseManager,
  orchestrator: OvernightOrchestrator,
  runId: number,
  hypothesisIds: number[],
): Promise<number[]> {
  const db = dbManager.db;
  const hypothesisRepo = new HypothesisRepository(db);
  const walkForwardRepo = new WalkForwardRepository(db);

  const dataProvider = new FixtureHistoricalDataProvider({
    candidates: [],
    rangeStart: Date.now() - 30 * 86_400_000,
    rangeEnd: Date.now(),
  });
  const walkForwardEval = new WalkForwardEvaluator({
    db,
    marketProfile: INDIA_NSE_EQ_MARKET,
    dataProvider,
  });
  const artifactWriter = new ResearchArtifactWriter();
  const winnerSelector = new WinnerSelector();

  const evaluator = new HypothesisResearchEvaluator({
    db,
    dataProvider,
    marketProfile: INDIA_NSE_EQ_MARKET,
    hypothesisRepo,
    walkForwardRepo,
    artifactWriter,
    winnerSelector,
    walkForwardEvaluator: walkForwardEval,
  });

  orchestrator.markPhase(runId, 'evaluate');

  const completedEvaluationIds: number[] = [];
  for (const hypothesisId of hypothesisIds) {
    const hypothesis = hypothesisRepo.getHypothesisById(hypothesisId);
    if (!hypothesis) continue;

    const evalResult = await evaluator.evaluate(hypothesis.id);
    if (evalResult.evaluation?.status === HypothesisEvaluationStatus.Completed) {
      completedEvaluationIds.push(evalResult.evaluation.id);
    }

    orchestrator.saveCheckpoint(runId, {
      phase: 'evaluate',
      completedItems: completedEvaluationIds.length,
      totalItems: hypothesisIds.length,
      lastProcessedId: String(hypothesisId),
    });
  }

  orchestrator.recordPhaseResult(runId, {
    phase: 'evaluate',
    recordedAt: Date.now(),
    detail: `Real overnight evaluation completed. ${completedEvaluationIds.length}/${hypothesisIds.length} hypotheses evaluated successfully.`,
  });
  orchestrator.markPhaseCompleted(runId, 'evaluate');

  return completedEvaluationIds;
}

function runRealPublishPhase(
  dbManager: DatabaseManager,
  orchestrator: OvernightOrchestrator,
  runId: number,
): { evaluationId: number | null; verdict: 'publish' | 'hold' } {
  const db = dbManager.db;
  const hypothesisRepo = new HypothesisRepository(db);

  const completedEvaluations = hypothesisRepo
    .getRecentEvaluations(200)
    .filter(e => e.status === HypothesisEvaluationStatus.Completed);

  if (completedEvaluations.length === 0) {
    return { evaluationId: null, verdict: 'hold' };
  }

  // Pick the most recent completed evaluation
  const bestEvaluation = completedEvaluations[0];

  orchestrator.markPhase(runId, 'publish');

  const service = new ResearchPublishBackService({ db, hypothesisRepo });
  const result = service.publish(bestEvaluation.id, { dryRun: false });

  orchestrator.recordPublication(runId, {
    verdict: result.verdict,
    publicationId: result.publication?.id ?? null,
    lifecycleStateId: result.lifecycleStateId,
    governanceDecisionId: result.governanceDecisionId,
    rationale: result.rationale,
    recordedAt: Date.now(),
  });
  orchestrator.recordPhaseResult(runId, {
    phase: 'publish',
    recordedAt: Date.now(),
    evaluationId: bestEvaluation.id,
    evaluationStatus: HypothesisEvaluationStatus.Completed,
    detail: result.rationale,
  });
  orchestrator.markPhaseCompleted(runId, 'publish', result.rationale);

  return { evaluationId: bestEvaluation.id, verdict: result.verdict };
}

function simulatePublishPhase(dbm: DatabaseManager) {
  const evaluationId = findLatestCompletedEvaluationId(dbm);
  if (evaluationId == null) {
    return {
      verdict: 'hold' as const,
      publicationId: null,
      lifecycleStateId: null,
      governanceDecisionId: null,
      rationale: 'No completed hypothesis evaluation found in the research DB for publish-back.',
      evaluationId: null,
      hypothesisId: null,
      publicationStatus: null,
    };
  }

  const hypothesisRepo = new HypothesisRepository(dbm.db);
  const service = new ResearchPublishBackService({ db: dbm.db, hypothesisRepo });
  const result = service.publish(evaluationId, { dryRun: false });
  return {
    verdict: result.verdict,
    publicationId: result.publication?.id ?? null,
    lifecycleStateId: result.lifecycleStateId,
    governanceDecisionId: result.governanceDecisionId,
    rationale: result.rationale,
    evaluationId,
    hypothesisId: result.evaluation.hypothesisGraphId,
    publicationStatus: result.publication?.status ?? null,
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
  nextPhaseAfterExecution: OvernightPhase | null;
  stopAfterPhase: PhaseStop;
  generatedHypothesisIds: number[];
  evaluatedHypothesisIds: number[];
  evaluationIds: number[];
  publication: {
    verdict: 'publish' | 'hold' | null;
    publicationId: number | null;
    lifecycleStateId: number | null;
    governanceDecisionId: number | null;
    rationale: string | null;
    publishedEvaluationId: number | null;
    publishedHypothesisId: number | null;
    status: string | null;
  };
  lineage: ResearchLineageSnapshot | null;
  resumeHistory: ReturnType<typeof parseOvernightRunMetadata>['resumeAttempts'];
  phaseTransitions: ReturnType<typeof parseOvernightRunMetadata>['phaseTransitions'];
  failureContext: ReturnType<typeof parseOvernightRunMetadata>['failureContext'];
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

function shouldStopAfter(phase: OvernightPhase, stopAfterPhase: PhaseStop): boolean {
  return stopAfterPhase != null && stopAfterPhase === phase;
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
        const checkpoint = simulateGeneratePhase(orchestrator, run.id, acceptedCandidates);
        for (let i = 0; i < skippedCount; i++) simulatedSkippedGenerationReasons.push('provider_disallowed');
        orchestrator.recordPhaseResult(run.id, {
          phase: 'generate',
          recordedAt: Date.now(),
          detail: 'Simulated overnight generation batch completed.',
        });
        orchestrator.markPhaseCompleted(run.id, 'generate');
        if (shouldStopAfter('generate', options.stopAfterPhase)) {
          run = orchestrator.getRun(run.id) ?? run;
          orchestrator.markFailed(run.id, `Intentional interruption after generate phase for resume verification (checkpoint ${checkpoint.completedItems}/${checkpoint.totalItems}).`);
          run = orchestrator.getRun(run.id) ?? run;
        } else {
          run = orchestrator.getRun(run.id) ?? run;
          phase = orchestrator.getNextPhase(run);
        }
      }

      if (run.status === 'running' && phase === 'evaluate') {
        orchestrator.markPhase(run.id, 'evaluate');
        const budgetCheckpoint = simulateEvaluatePhase(orchestrator, run.id, evaluatedCount, acceptedCandidates);
        budgetCheckpoint.metadata = {
          ...(budgetCheckpoint.metadata ?? {}),
          budget: {
            acceptedCandidates,
            skippedGenerationCount: skippedCount,
            prunedEvaluationCount: simulatedPrunedEvaluationCount,
            maxAcceptedCandidates: Number.isFinite(resolvedBudget.maxAcceptedCandidates) ? resolvedBudget.maxAcceptedCandidates : null,
            maxLlmCalls: Number.isFinite(resolvedBudget.maxLlmCalls) ? resolvedBudget.maxLlmCalls : null,
            skipReasonCodes: simulatedSkippedGenerationReasons,
          },
        };
        orchestrator.saveCheckpoint(run.id, budgetCheckpoint);
        orchestrator.recordPhaseResult(run.id, {
          phase: 'evaluate',
          recordedAt: Date.now(),
          evaluationId: findLatestCompletedEvaluationId(dbManager),
          evaluationStatus: findLatestCompletedEvaluationId(dbManager) == null ? null : HypothesisEvaluationStatus.Completed,
          detail: 'Simulated overnight evaluation batch completed.',
        });
        orchestrator.markPhaseCompleted(run.id, 'evaluate');
        if (shouldStopAfter('evaluate', options.stopAfterPhase)) {
          run = orchestrator.getRun(run.id) ?? run;
          orchestrator.markFailed(run.id, `Intentional interruption after evaluate phase for resume verification (checkpoint ${budgetCheckpoint.completedItems}/${budgetCheckpoint.totalItems}).`);
          run = orchestrator.getRun(run.id) ?? run;
        } else {
          run = orchestrator.getRun(run.id) ?? run;
          phase = orchestrator.getNextPhase(run);
        }
      }

      if (run.status === 'running' && phase === 'publish') {
        orchestrator.markPhase(run.id, 'publish');
        const publication = simulatePublishPhase(dbManager);
        orchestrator.recordPublication(run.id, {
          verdict: publication.verdict,
          publicationId: publication.publicationId,
          lifecycleStateId: publication.lifecycleStateId,
          governanceDecisionId: publication.governanceDecisionId,
          rationale: publication.rationale,
          recordedAt: Date.now(),
        });
        orchestrator.recordPhaseResult(run.id, {
          phase: 'publish',
          recordedAt: Date.now(),
          evaluationId: publication.evaluationId,
          evaluationStatus: publication.evaluationId == null ? null : HypothesisEvaluationStatus.Completed,
          detail: publication.rationale,
        });
        orchestrator.markPhaseCompleted(run.id, 'publish', publication.rationale);
        if (shouldStopAfter('publish', options.stopAfterPhase)) {
          run = orchestrator.getRun(run.id) ?? run;
          orchestrator.markFailed(run.id, 'Intentional interruption after publish phase for resume verification.');
          run = orchestrator.getRun(run.id) ?? run;
        } else {
          orchestrator.markCompleted(run.id);
          run = orchestrator.getRun(run.id) ?? run;
        }
      }
    } else if (result.accepted && !options.simulatePhases) {
      // Real overnight research pipeline: generate → evaluate → publish
      run = orchestrator.getRun(run.id) ?? run;
      let phase = orchestrator.getNextPhase(run);

      if (phase === 'generate') {
        const generatedIds = await runRealGenerationPhase(dbManager, orchestrator, run.id, resolvedBudget);
        if (shouldStopAfter('generate', options.stopAfterPhase)) {
          run = orchestrator.getRun(run.id) ?? run;
          orchestrator.markFailed(run.id, `Intentional interruption after generate phase (${generatedIds.length} hypotheses generated).`);
          run = orchestrator.getRun(run.id) ?? run;
        } else {
          run = orchestrator.getRun(run.id) ?? run;
          phase = orchestrator.getNextPhase(run);
        }
      }

      if (run.status === 'running' && phase === 'evaluate') {
        const generatedIds = findGeneratedHypothesisIds(dbManager);
        const evaluatedIds = await runRealEvaluatePhase(dbManager, orchestrator, run.id, generatedIds);
        if (shouldStopAfter('evaluate', options.stopAfterPhase)) {
          run = orchestrator.getRun(run.id) ?? run;
          orchestrator.markFailed(run.id, `Intentional interruption after evaluate phase (${evaluatedIds.length} evaluations completed).`);
          run = orchestrator.getRun(run.id) ?? run;
        } else {
          run = orchestrator.getRun(run.id) ?? run;
          phase = orchestrator.getNextPhase(run);
        }
      }

      if (run.status === 'running' && phase === 'publish') {
        const publication = runRealPublishPhase(dbManager, orchestrator, run.id);
        if (shouldStopAfter('publish', options.stopAfterPhase)) {
          run = orchestrator.getRun(run.id) ?? run;
          orchestrator.markFailed(run.id, 'Intentional interruption after publish phase for resume verification.');
          run = orchestrator.getRun(run.id) ?? run;
        } else if (publication.verdict === 'publish') {
          orchestrator.markCompleted(run.id);
          run = orchestrator.getRun(run.id) ?? run;
        } else {
          orchestrator.markFailed(run.id, 'Publish phase returned hold — no strategy promoted.');
          run = orchestrator.getRun(run.id) ?? run;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    const finalRun = orchestrator.getRun(run.id) ?? run;
    const finalCheckpoint = orchestrator.readCheckpoint(finalRun);
    const nextPhaseAfterExecution = result.accepted ? orchestrator.getNextPhase(finalRun) : null;
    const metadata = parseOvernightRunMetadata(finalRun.metadataJson);
    const generatedHypothesisIds = findGeneratedHypothesisIds(dbManager);
    const evaluatedHypothesisIds = findEvaluatedHypothesisIds(dbManager);
    const evaluationIds = findCompletedEvaluationIds(dbManager);

    let lineage: ResearchLineageSnapshot | null = null;
    let publishedEvaluationId: number | null = null;
    let publishedHypothesisId: number | null = null;
    let publicationStatus: string | null = null;
    if (metadata.publication?.publicationId != null) {
      const publicationRepo = new HypothesisRepository(dbManager.db);
      const publication = publicationRepo.getPublicationById(metadata.publication.publicationId);
      if (publication) {
        publicationStatus = publication.status;
        publishedEvaluationId = publication.hypothesisEvaluationId;
        publishedHypothesisId = publication.hypothesisGraphId;
        const hypothesis = publicationRepo.getHypothesisById(publication.hypothesisGraphId);
        if (hypothesis) {
          const auditService = new ResearchAuditService({
            hypothesisRepo: publicationRepo,
            memoryRepo: new HypothesisMemoryRepository(dbManager.db),
            lifecycleRepo: new StrategyLifecycleRepository(dbManager.db),
            generationRepo: new HypothesisGenerationRepository(dbManager.db),
          });
          lineage = auditService.assembleLineage(hypothesis.canonicalHash);
        }
      }
    }

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
      nextPhaseAfterExecution,
      stopAfterPhase: options.stopAfterPhase,
      generatedHypothesisIds,
      evaluatedHypothesisIds,
      evaluationIds,
      publication: {
        verdict: metadata.publication?.verdict ?? null,
        publicationId: metadata.publication?.publicationId ?? null,
        lifecycleStateId: metadata.publication?.lifecycleStateId ?? null,
        governanceDecisionId: metadata.publication?.governanceDecisionId ?? null,
        rationale: metadata.publication?.rationale ?? null,
        publishedEvaluationId,
        publishedHypothesisId,
        status: publicationStatus,
      },
      lineage,
      resumeHistory: metadata.resumeAttempts,
      phaseTransitions: metadata.phaseTransitions,
      failureContext: metadata.failureContext,
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
      nextPhaseAfterExecution,
      stopAfterPhase: options.stopAfterPhase,
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
      nextPhaseAfterExecution,
      stopAfterPhase: options.stopAfterPhase,
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
