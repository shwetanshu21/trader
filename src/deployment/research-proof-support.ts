// ── M011/S04 — Research Proof Support ──
// Shared helpers for the end-to-end research proof harness.
// Creates a temp SQLite DB, seeds duplicate-skip and success-path hypothesis
// data, runs the real validator / evaluator / publish-back services, and
// returns the assembled ResearchLineageSnapshot for assertion.
//
// The walk-forward evaluator is injected as a mock since the inner replay
// engine requires real market data. The research pipeline above it
// (HypothesisValidator -> HypothesisResearchEvaluator -> ResearchPublishBackService
// -> ResearchAuditService) is exercised with real code paths.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type Database from 'better-sqlite3';
import { DatabaseManager } from '../persistence/sqlite.js';
import { HypothesisRepository } from '../persistence/hypothesis-repo.js';
import { HypothesisMemoryRepository } from '../persistence/hypothesis-memory-repo.js';
import { StrategyLifecycleRepository } from '../persistence/strategy-lifecycle-repo.js';
import { WalkForwardRepository } from '../persistence/walk-forward-repo.js';
import { HypothesisValidator } from '../research/hypothesis-validator.js';
import { canonicalizeHypothesis } from '../research/hypothesis-canonicalizer.js';
import { HypothesisResearchEvaluator } from '../research/hypothesis-evaluator.js';
import { ResearchPublishBackService } from '../research/publish-back-service.js';
import { ResearchAuditService } from '../research/research-audit-service.js';
import { ResearchArtifactWriter } from '../research/artifact-writer.js';
import { ReplayFidelity, type ReplayTick } from '../replay/types.js';
import { HypothesisGenerationRepository } from '../persistence/hypothesis-generation-repo.js';
import {
  HypothesisStatus,
  HypothesisEvaluationStatus,
  HypothesisMemoryStatus,
  HypothesisValidationReasonCode,
  ResearchArtifactType,
  GenerationVerdict,
  GenerationReasonCode,
  type GenerationReason,
  type GenerationContextProvenance,
  type HypothesisGenerationAttemptWithReasons,
  type NewHypothesisGenerationAttempt,
  type HypothesisGraph,
  type HypothesisGraphRow,
  type HypothesisEvaluationResult,
  type ResearchLineageSnapshot,
  type ResearchPublishBackResult,
} from '../types/runtime.js';
import {
  WalkForwardStatus,
  WalkForwardWindowType,
  type WalkForwardRunRow,
  type WalkForwardTrialWindowRow,
  type WalkForwardRankedCandidate,
  type NewWalkForwardRun,
  type NewWalkForwardTrial,
} from '../replay/walk-forward-types.js';
import type { HistoricalDataProvider } from '../replay/historical-data-provider.js';
import type { MarketProfile, MarketCalendar } from '../market/market-profile.js';
import { MarketPhase } from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ARTIFACT_ROOT = 'data/artifacts/research-proof';

const NOW = Date.now();

/** A valid hypothesis graph used for the duplicate-skip branch. */
function dupeGraph(): HypothesisGraph {
  return {
    schemaVersion: '1',
    signals: [{ type: 'ema_cross', params: { fast: 8, slow: 21 } }],
    filters: [{ type: 'volume_min', params: { min: 500000 } }],
    entryRules: [{ type: 'breakout_confirmed', params: { lookbackBars: 5 } }],
    exitRules: [{ type: 'time_stop', params: { maxBars: 12 } }],
    riskRules: [{ type: 'atr_stop', params: { period: 14, multiple: 2 } }],
  };
}

/** A valid hypothesis graph used for the success-path branch (slightly different to avoid hash collision with dupeGraph). */
function successGraph(): HypothesisGraph {
  return {
    schemaVersion: '1',
    signals: [{ type: 'ema_cross', params: { fast: 12, slow: 26 } }],
    filters: [{ type: 'volume_min', params: { min: 500000 } }],
    entryRules: [{ type: 'breakout_confirmed', params: { lookbackBars: 5 } }],
    exitRules: [{ type: 'time_stop', params: { maxBars: 12 } }],
    riskRules: [{ type: 'atr_stop', params: { period: 14, multiple: 2 } }],
  };
}

// ---------------------------------------------------------------------------
// Fake MarketCalendar
// ---------------------------------------------------------------------------

class FakeMarketCalendar implements MarketCalendar {
  getHoliday(_marketDate: string): string | null {
    return null;
  }
  listHolidays(_year: number): Array<{ date: string; name: string }> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fake dependencies for the walk-forward evaluator
// ---------------------------------------------------------------------------

export class FakeDataProvider implements HistoricalDataProvider {
  readonly label = 'research-proof-fixture-v1';

  getEffectiveFidelity(_tick: ReplayTick): ReplayFidelity {
    return ReplayFidelity.Synthetic;
  }

  hasData(_rangeStart: number, _rangeEnd: number): boolean {
    return true;
  }

  async getCandidates(_tick: ReplayTick): Promise<any[]> {
    return [];
  }

  getResolutionMetadata(): {
    screeningCadenceMinutes: number;
    executionResolutionMinutes: number | null;
    supportsFineGrainedExecution: boolean;
  } {
    return {
      screeningCadenceMinutes: 5,
      executionResolutionMinutes: 5,
      supportsFineGrainedExecution: false,
    };
  }
}

export class FakeMarketProfile implements MarketProfile {
  readonly marketId = 'INDIA_NSE_EQ';
  readonly displayName = 'NSE India Equities (Proof)';
  readonly timezone = 'Asia/Kolkata';
  readonly settlementCycle = 'T+1';
  readonly lotSizeType: 'fixed' | 'exchange_defined' = 'fixed';
  readonly maxOrdersPerSecond = 10;
  readonly extendedHoursAllowed = false;
  readonly observesDst = false;
  readonly calendar: MarketCalendar = new FakeMarketCalendar();

  readonly regularSession = { open: '09:15', close: '15:30' };
  readonly preMarketSession = { open: '09:00', close: '09:15' };
  readonly postMarketSession = { open: '15:30', close: '16:00' };

  isTradingDay(_date: Date): boolean {
    return true;
  }

  getMarketTime(): number {
    return NOW;
  }

  formatMarketDate(_ts: number): string {
    return '2026-05-22';
  }

  getPhase(_utcDate: Date): MarketPhase {
    return MarketPhase.Regular;
  }
}

// ---------------------------------------------------------------------------
// Mock EvaluatorRunResult factory for deterministic walk-forward output
// ---------------------------------------------------------------------------

export function makeMockWalkForwardResult(
  runId: number,
  trialId: number,
  hypothesisGraphId: number,
  mergedScore: number,
): {
  run: WalkForwardRunRow;
  windows: any[];
  trials: any[];
  rankedCandidates: WalkForwardRankedCandidate[];
  aggregateMetrics: { scoreStability: number; topKOverlap: number; llmConsultationRate: null; llmDivergence: null };
} {
  const outOfSampleWindow: WalkForwardTrialWindowRow = {
    id: 1,
    trialId,
    windowId: 1,
    windowType: WalkForwardWindowType.OutOfSample,
    totalReturn: 12.3,
    sharpeRatio: 1.5,
    maxDrawdown: 8.0,
    winRate: 0.6,
    tradeCount: 25,
    profitFactor: 1.8,
    metricsJson: null,
    createdAt: NOW,
  };

  const inSampleWindow: WalkForwardTrialWindowRow = {
    id: 2,
    trialId,
    windowId: 1,
    windowType: WalkForwardWindowType.InSample,
    totalReturn: 8.1,
    sharpeRatio: 2.1,
    maxDrawdown: 5.0,
    winRate: 0.65,
    tradeCount: 50,
    profitFactor: 2.2,
    metricsJson: null,
    createdAt: NOW,
  };

  const mockRun: WalkForwardRunRow = {
    id: runId,
    label: `research-proof-run-${runId}`,
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    replaySessionId: null,
    windowCount: 2,
    totalTrials: 1,
    status: WalkForwardStatus.Completed,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW + 1000,
  };

  const mockRankedCandidate: WalkForwardRankedCandidate = {
    trialId,
    rank: 1,
    label: `hypothesis-${hypothesisGraphId}`,
    paramsJson: JSON.stringify({
      hypothesisId: hypothesisGraphId,
      canonicalHash: 'proof-hash',
      schemaVersion: '1',
      signals: [],
      filters: [],
      entryRules: [],
      exitRules: [],
      riskRules: [],
      maxCandidates: 5,
    }),
    mergedScore,
    deterministicScore: 0.78,
    llmScore: null,
    llmStatus: null,
    windowCount: 2,
  };

  const mockTrial = {
    trialId,
    runId,
    trialIndex: 0,
    label: `hypothesis-${hypothesisGraphId}`,
    paramsJson: mockRankedCandidate.paramsJson,
    mergedScore,
    deterministicScore: 0.78,
    llmScore: null,
    llmStatus: null,
    rank: 1,
    createdAt: NOW,
    windowEvidence: [inSampleWindow, outOfSampleWindow],
  };

  return {
    run: mockRun,
    windows: [
      {
        id: 1,
        runId,
        windowIndex: 0,
        rangeStart: NOW - 7 * 86_400_000,
        rangeEnd: NOW,
        windowLabel: 'W01-proof',
        trialCountOptimized: 1,
        trialCountTested: 1,
        status: 'completed',
        createdAt: NOW,
      },
    ],
    trials: [mockTrial],
    rankedCandidates: [mockRankedCandidate],
    aggregateMetrics: {
      scoreStability: 1.0,
      topKOverlap: 1.0,
      llmConsultationRate: null,
      llmDivergence: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Proof context -- aggregates all repos and services for one harness run
// ---------------------------------------------------------------------------

export interface ResearchProofContext {
  tmpDir: string;
  dbPath: string;
  dbManager: DatabaseManager;
  db: Database.Database;
  hypothesisRepo: HypothesisRepository;
  memoryRepo: HypothesisMemoryRepository;
  generationRepo: HypothesisGenerationRepository;
  lifecycleRepo: StrategyLifecycleRepository;
  walkForwardRepo: WalkForwardRepository;
  validator: HypothesisValidator;
  auditService: ResearchAuditService;
  publishBackService: ResearchPublishBackService;
}

/**
 * Create a temporary file-backed database with all repositories and services.
 */
export function createResearchProofContext(): ResearchProofContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-proof-'));
  const dbPath = path.join(tmpDir, 'research-proof.db');
  const dbManager = new DatabaseManager(dbPath);
  const db = dbManager.db;

  const hypothesisRepo = new HypothesisRepository(db);
  const memoryRepo = new HypothesisMemoryRepository(db);
  const generationRepo = new HypothesisGenerationRepository(db);
  const lifecycleRepo = new StrategyLifecycleRepository(db);
  const walkForwardRepo = new WalkForwardRepository(db);

  const validator = new HypothesisValidator({ memoryRepo, hypothesisRepo });
  const publishBackService = new ResearchPublishBackService({ db, hypothesisRepo, lifecycleRepo });
  const auditService = new ResearchAuditService({ hypothesisRepo, memoryRepo, lifecycleRepo, generationRepo });

  return {
    tmpDir,
    dbPath,
    dbManager,
    db,
    hypothesisRepo,
    memoryRepo,
    generationRepo,
    lifecycleRepo,
    walkForwardRepo,
    validator,
    auditService,
    publishBackService,
  };
}

/**
 * Clean up the temporary directory.
 */
export function destroyResearchProofContext(ctx: ResearchProofContext): void {
  try {
    ctx.db.close();
  } catch {
    // ignore close errors
  }
  try {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Seed duplicate-skip evidence
// ---------------------------------------------------------------------------

export interface DuplicateSkipSeed {
  canonicalHash: string;
}

/**
 * Seed an exact-failure ledger entry for the duplicate-skip branch.
 * Returns the canonical hash used so the same hash can be validated later.
 */
export function seedDuplicateSkip(ctx: ResearchProofContext): DuplicateSkipSeed {
  const graph = dupeGraph();
  const canonical = canonicalizeHypothesis(graph);
  const hash = canonical.canonicalHash;

  ctx.memoryRepo.recordFailure({
    canonicalHash: hash,
    status: HypothesisMemoryStatus.Failed,
    reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
    reasonMessage: 'S04 proof: prior hypothesis with same canonical form failed during evaluation.',
    hypothesisGraphId: null,
    createdAt: Date.now(),
  });

  return { canonicalHash: hash };
}

/**
 * Validate a hypothesis graph that will hit the duplicate-skip path.
 * Returns the validator result.
 */
export function runDuplicateSkipValidation(
  ctx: ResearchProofContext,
  _hash: string,
): ReturnType<HypothesisValidator['validate']> {
  const graph = dupeGraph();
  return ctx.validator.validate(graph);
}

// ---------------------------------------------------------------------------
// Phase 2: Fresh hypothesis evaluation and publish-back
// ---------------------------------------------------------------------------

/**
 * Run the full success path: validate -> evaluate -> publish -> audit lineage.
 *
 * @param ctx - Proof context with all services.
 * @returns The hypothesis row, evaluation result, publish result, and lineage snapshot.
 */
export async function runSuccessPath(
  ctx: ResearchProofContext,
): Promise<{
  hypothesis: HypothesisGraphRow;
  evaluationResult: HypothesisEvaluationResult;
  publishResult: ResearchPublishBackResult;
  lineage: ResearchLineageSnapshot;
}> {
  const graph = successGraph();
  const canonical = canonicalizeHypothesis(graph);
  const hash = canonical.canonicalHash;

  // 1. Validate the hypothesis (real HypothesisValidator)
  const validationResult = ctx.validator.validateAndPersist(graph, Date.now());
  if (validationResult.result.kind !== 'validated') {
    throw new Error(
      `Hypothesis validation failed: ${JSON.stringify(validationResult.result)}`,
    );
  }
  const hypothesisId = validationResult.persistedId!;
  const hypothesis = ctx.hypothesisRepo.getHypothesisById(hypothesisId)!;

  // 2. Persist walk-forward run + trial so FK references are satisfied
  const runRow = ctx.walkForwardRepo.insertRun({
    label: 'research-proof-run',
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    replaySessionId: null,
    windowCount: 2,
    totalTrials: 1,
    status: WalkForwardStatus.Completed,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW + 1000,
  });
  const runId = runRow.id;

  const mergedScore = 0.85;
  const trialRow = ctx.walkForwardRepo.insertTrial({
    runId,
    trialIndex: 0,
    label: `hypothesis-${hypothesisId}`,
    paramsJson: JSON.stringify({
      hypothesisId,
      canonicalHash: hash,
      schemaVersion: '1',
      signals: [],
      filters: [],
      entryRules: [],
      exitRules: [],
      riskRules: [],
      maxCandidates: 5,
    }),
    mergedScore,
    deterministicScore: 0.78,
    llmScore: null,
    llmStatus: null,
    rank: 1,
    createdAt: NOW,
  });

  // 3. Create mocked walk-forward evaluator that returns a deterministic result
  const mockResult = makeMockWalkForwardResult(runId, trialRow.id, hypothesisId, mergedScore);
  const updatedMockResult = {
    ...mockResult,
    run: { ...mockResult.run, id: runId },
    trials: mockResult.trials.map((t: any) => ({
      ...t,
      trialId: trialRow.id,
      runId,
    })),
    rankedCandidates: mockResult.rankedCandidates.map((c: any) => ({
      ...c,
      trialId: trialRow.id,
    })),
  };

  const mockEvaluator = {
    evaluate: async () => updatedMockResult,
  } as any;

  // 4. Create the real HypothesisResearchEvaluator with injected fake evaluator
  const dataProvider = new FakeDataProvider();
  const marketProfile = new FakeMarketProfile();
  const artifactWriter = new ResearchArtifactWriter();

  const evaluator = new HypothesisResearchEvaluator({
    db: ctx.db,
    dataProvider,
    marketProfile,
    hypothesisRepo: ctx.hypothesisRepo,
    walkForwardRepo: ctx.walkForwardRepo,
    artifactWriter,
    walkForwardEvaluator: mockEvaluator,
  });

  const evaluationResult = await evaluator.evaluate(hypothesisId, {
    rangeStart: NOW - 30 * 86_400_000,
    rangeEnd: NOW,
    windowSizeMs: 7 * 86_400_000,
    stepSizeMs: 1 * 86_400_000,
    inSampleRatio: 0.8,
    minMergedScore: 0.7,
    minWindowCount: 1,
    label: 'research-proof-success',
    enablePaperExecution: false,
  });

  // 5. Publish back through the real ResearchPublishBackService
  const publishResult = ctx.publishBackService.publish(
    evaluationResult.evaluation.id,
    {
      minMergedScore: 0.7,
      requirePromotionArtifact: true,
      requireDiagnosticsArtifact: true,
      dryRun: false,
    },
  );

  if (publishResult.verdict !== 'publish') {
    throw new Error(
      `Publish-back did not succeed: verdict=${publishResult.verdict}, rationale=${publishResult.rationale}`,
    );
  }

  // 6. Read back lineage through the real ResearchAuditService
  const lineage = ctx.auditService.assembleLineage(hash);

  return { hypothesis, evaluationResult, publishResult, lineage };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

export interface AssertionResult {
  name: string;
  pass: boolean;
  detail: string;
}

const _assertions: AssertionResult[] = [];

export function resetAssertions(): void {
  _assertions.length = 0;
}

export function getAssertions(): AssertionResult[] {
  return _assertions;
}

export function assert(name: string, condition: boolean, detail: string): void {
  _assertions.push({ name, pass: condition, detail });
  if (!condition) {
    console.error(`  \u274c FAIL: ${name} \u2014 ${detail}`);
  } else {
    console.log(`  \u2705 PASS: ${name}`);
  }
}

export function report(): { passed: number; failed: number } {
  const passed = _assertions.filter(a => a.pass).length;
  const failed = _assertions.filter(a => !a.pass).length;
  console.log(`\n\u2500\u2500 Results: ${passed} passed, ${failed} failed \u2500\u2500`);
  return { passed, failed };
}

// ===========================================================================
// S05 — Generation proof helpers
// ===========================================================================

/**
 * Seed a malformed/rejected generation attempt with explicit reasons.
 * Uses the real HypothesisGenerationRepository to insert the row + reasons
 * in a single transaction.
 *
 * @returns The persisted generation attempt with reasons loaded.
 */
export function seedMalformedGeneration(
  ctx: ResearchProofContext,
): HypothesisGenerationAttemptWithReasons {
  const genRepo = new HypothesisGenerationRepository(ctx.db);

  const attempt: NewHypothesisGenerationAttempt = {
    verdict: GenerationVerdict.Rejected,
    contextProvenance: {
      providerUrl: 'https://api.provider.test/v1',
      providerModel: 'gpt-4-test',
      promptVersion: '1.0.0',
      triggeredAt: Date.now(),
      marketId: 'INDIA_NSE_EQ',
      strategyId: 'research-hypothesis-generator',
    },
    rawProviderOutput: '{invalid json here}',
    canonicalHash: null,
    hypothesisGraphId: null,
    hypothesisEvaluationId: null,
    createdAt: Date.now(),
  };

  const reasons: GenerationReason[] = [
    {
      reasonCode: GenerationReasonCode.MalformedResponse,
      reasonMessage: 'Provider returned output that is not valid JSON.',
    },
  ];

  return genRepo.insertAttemptWithReasons(attempt, reasons);
}

/**
 * Seed a skipped (duplicate-skip) generation attempt with explicit reason.
 *
 * @returns The persisted generation attempt with reasons loaded.
 */
export function seedSkippedGeneration(
  ctx: ResearchProofContext,
): HypothesisGenerationAttemptWithReasons {
  const genRepo = new HypothesisGenerationRepository(ctx.db);
  const canonicalHash = 'a1b2c3d4e5f6_skipped';

  const attempt: NewHypothesisGenerationAttempt = {
    verdict: GenerationVerdict.Skipped,
    contextProvenance: {
      providerUrl: 'https://api.provider.test/v1',
      providerModel: 'gpt-4-test',
      promptVersion: '1.0.0',
      triggeredAt: Date.now(),
      marketId: 'INDIA_NSE_EQ',
      strategyId: 'research-hypothesis-generator',
    },
    rawProviderOutput: '{"schemaVersion":"1","signals":[{"type":"ema_cross","params":{"fast":8,"slow":21}}],"filters":[],"entryRules":[],"exitRules":[],"riskRules":[]}',
    canonicalHash,
    hypothesisGraphId: null,
    hypothesisEvaluationId: null,
    createdAt: Date.now(),
  };

  const reasons: GenerationReason[] = [
    {
      reasonCode: GenerationReasonCode.DuplicateSkipped,
      reasonMessage: `Exact duplicate of prior accepted hypothesis (generation attempt id=0).`,
    },
  ];

  return genRepo.insertAttemptWithReasons(attempt, reasons);
}

/**
 * Seed an accepted generation attempt that flows through the full pipeline:
 * validated hypothesis -> walk-forward -> evaluation -> generation-attempt linkage.
 *
 * This simulates what the real HypothesisGenerationService does when the
 * provider returns a valid graph: canonicalize, validate, persist, then
 * optionally evaluate. The walk-forward evaluator is mocked (same pattern
 * as S04's runSuccessPath) so no real market data is needed.
 *
 * @returns The generation attempt, hypothesis row, evaluation result, and lineage.
 */
export async function seedAcceptedGeneration(
  ctx: ResearchProofContext,
): Promise<{
  generationAttempt: HypothesisGenerationAttemptWithReasons;
  hypothesis: HypothesisGraphRow;
  evaluationResult: HypothesisEvaluationResult;
  lineage: ResearchLineageSnapshot;
}> {
  const genRepo = new HypothesisGenerationRepository(ctx.db);

  // ── 1. Create a valid hypothesis graph via the real validator ───────────
  const graph: HypothesisGraph = {
    schemaVersion: '1',
    signals: [{ type: 'sma_cross', params: { fast: 10, slow: 30 } }],
    filters: [{ type: 'volume_min', params: { min: 300000 } }],
    entryRules: [{ type: 'range_breakout', params: { lookbackBars: 10, multiplier: 1.5 } }],
    exitRules: [{ type: 'trailing_stop', params: { atrPeriod: 14, atrMultiplier: 3 } }],
    riskRules: [{ type: 'position_size', params: { riskPercent: 1 } }],
  };

  const canonical = canonicalizeHypothesis(graph);
  const hash = canonical.canonicalHash;

  // 2. Validate and persist the hypothesis
  const validationResult = ctx.validator.validateAndPersist(graph, Date.now());
  if (validationResult.result.kind !== 'validated') {
    throw new Error(
      `Hypothesis validation failed: ${JSON.stringify(validationResult.result)}`,
    );
  }
  const hypothesisId = validationResult.persistedId!;
  const hypothesis = ctx.hypothesisRepo.getHypothesisById(hypothesisId)!;

  // 3. Persist a walk-forward run + trial for FK linkage
  const runRow = ctx.walkForwardRepo.insertRun({
    label: 's05-generation-proof-run',
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    replaySessionId: null,
    windowCount: 2,
    totalTrials: 1,
    status: WalkForwardStatus.Completed,
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: Date.now() + 500,
  });
  const runId = runRow.id;

  const mergedScore = 0.82;
  const trialRow = ctx.walkForwardRepo.insertTrial({
    runId,
    trialIndex: 0,
    label: `hypothesis-${hypothesisId}`,
    paramsJson: JSON.stringify({
      hypothesisId,
      canonicalHash: hash,
      schemaVersion: '1',
      signals: [],
      filters: [],
      entryRules: [],
      exitRules: [],
      riskRules: [],
      maxCandidates: 5,
    }),
    mergedScore,
    deterministicScore: 0.75,
    llmScore: null,
    llmStatus: null,
    rank: 1,
    createdAt: Date.now(),
  });

  // 4. Create a mocked walk-forward result
  const mockResult = makeMockWalkForwardResult(runId, trialRow.id, hypothesisId, mergedScore);
  const updatedMockResult = {
    ...mockResult,
    run: { ...mockResult.run, id: runId },
    trials: mockResult.trials.map((t: any) => ({
      ...t,
      trialId: trialRow.id,
      runId,
    })),
    rankedCandidates: mockResult.rankedCandidates.map((c: any) => ({
      ...c,
      trialId: trialRow.id,
    })),
  };

  const mockEvaluator = { evaluate: async () => updatedMockResult } as any;

  // 5. Run the real evaluator with mocked walk-forward
  const dataProvider = new FakeDataProvider();
  const marketProfile = new FakeMarketProfile();
  const artifactWriter = new ResearchArtifactWriter();

  const evaluator = new HypothesisResearchEvaluator({
    db: ctx.db,
    dataProvider,
    marketProfile,
    hypothesisRepo: ctx.hypothesisRepo,
    walkForwardRepo: ctx.walkForwardRepo,
    artifactWriter,
    walkForwardEvaluator: mockEvaluator,
  });

  // 6. Evaluate
  const evaluationResult = await evaluator.evaluate(hypothesisId, {
    rangeStart: Date.now() - 30 * 86_400_000,
    rangeEnd: Date.now(),
    windowSizeMs: 7 * 86_400_000,
    stepSizeMs: 1 * 86_400_000,
    inSampleRatio: 0.8,
    minMergedScore: 0.7,
    minWindowCount: 1,
    label: 's05-generation-proof-eval',
    enablePaperExecution: false,
  });

  // 7. Insert the generation attempt that links to this hypothesis + evaluation
  const attempt: NewHypothesisGenerationAttempt = {
    verdict: GenerationVerdict.Accepted,
    contextProvenance: {
      providerUrl: 'https://api.provider.test/v1',
      providerModel: 'gpt-4-test',
      promptVersion: '1.0.0',
      triggeredAt: Date.now(),
      marketId: 'INDIA_NSE_EQ',
      strategyId: 'research-hypothesis-generator',
    },
    rawProviderOutput: JSON.stringify(graph),
    canonicalHash: hash,
    hypothesisGraphId: hypothesisId,
    hypothesisEvaluationId: evaluationResult.evaluation.id,
    createdAt: Date.now(),
  };

  const generationAttempt = genRepo.insertAttemptWithReasons(attempt, []);

  // 8. Assemble lineage through the real audit service
  const lineage = ctx.auditService.assembleLineage(hash);

  return { generationAttempt, hypothesis, evaluationResult, lineage };
}

// ===========================================================================
// T04 — Real service ingress helpers
// ===========================================================================

import { HypothesisGenerationService } from '../research/hypothesis-generation-service.js';
import type { ProposalEngineConfig } from '../types/runtime.js';

/** Test provider config pointing at a mock endpoint. */
export const PROOF_PROVIDER_CONFIG: ProposalEngineConfig = {
  providerMode: 'custom',
  providerUrl: 'http://proof-provider.local/hypothesis',
  timeoutMs: 5000,
  maxProposalsPerTick: 5,
};

/**
 * Create a HypothesisGenerationService wired to the proof context's repos.
 * Optionally accepts an evaluator for the accepted + evaluation path.
 */
export function createProofGenerationService(
  ctx: ResearchProofContext,
  options?: {
    evaluator?: HypothesisResearchEvaluator;
  },
): HypothesisGenerationService {
  const validator = new HypothesisValidator({
    memoryRepo: ctx.memoryRepo,
    hypothesisRepo: ctx.hypothesisRepo,
  });

  return new HypothesisGenerationService({
    db: ctx.db,
    config: PROOF_PROVIDER_CONFIG,
    hypothesisRepo: ctx.hypothesisRepo,
    generationRepo: ctx.generationRepo,
    memoryRepo: ctx.memoryRepo,
    validator,
    evaluator: options?.evaluator,
    strategyRunRepo: undefined,
  });
}

/**
 * Install a mock global fetch that returns a controlled response body.
 * Returns a restore function to revert fetch to its original value.
 *
 * This is the "controlled local stub/fake transport" seam: the real
 * HypothesisGenerationService code paths for _callProvider / _sendCustomRequest
 * are exercised verbatim; only the actual HTTP round-trip is replaced.
 */
export function setMockFetchResponse(body: string, status = 200): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      text: async () => body,
    } as unknown as Response;
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/**
 * Create a mock walk-forward evaluator that persists a run + trial into the
 * proof DB and returns a deterministic result for the given hypothesis graph.
 *
 * The mock evaluator's `evaluate()` method:
 *   1. Creates a walk-forward run and trial in the proof DB
 *   2. Builds a structured mock result referencing those IDs
 *   3. Returns the result (the real HypothesisResearchEvaluator processes it)
 *
 * This mirrors the pattern used by seedAcceptedGeneration, extracted as a
 * reusable factory so the proof harness can wire it into the service.
 */
export function createMockWalkForwardEvaluator(
  ctx: ResearchProofContext,
): { walkForwardEvaluator: any; cleanup: () => void } {
  // Pre-create a reusable mock — the evaluator calls evaluate() which
  // dynamically creates run + trial for each invocation.
  const walkForwardEvaluator = {
    evaluate: async (_evalConfig: any) => {
      const now = Date.now();
      const runRow = ctx.walkForwardRepo.insertRun({
        label: 's05-proof-mock-run',
        strategyId: 'india-nse-eq-v1',
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
        replaySessionId: null,
        windowCount: 2,
        totalTrials: 1,
        status: WalkForwardStatus.Completed,
        createdAt: now,
        startedAt: now,
        completedAt: now + 500,
      });

      // We don't know the hypothesisGraphId until the evaluator calls us,
      // but makeMockWalkForwardResult needs it. We'll use a placeholder
      // — the evaluator result is used for winner selection, not for
      // hypothesis-specific matching.
      const placeholderGraphId = _evalConfig?.trialConfigs?.[0]?.params?.hypothesisId ?? 0;
      const mergedScore = 0.82;

      const trialRow = ctx.walkForwardRepo.insertTrial({
        runId: runRow.id,
        trialIndex: 0,
        label: `hypothesis-${placeholderGraphId}`,
        paramsJson: JSON.stringify({
          hypothesisId: placeholderGraphId,
          canonicalHash: 'proof-hash',
          schemaVersion: '1',
          signals: [],
          filters: [],
          entryRules: [],
          exitRules: [],
          riskRules: [],
          maxCandidates: 5,
        }),
        mergedScore,
        deterministicScore: 0.75,
        llmScore: null,
        llmStatus: null,
        rank: 1,
        createdAt: now,
      });

      const mockResult = makeMockWalkForwardResult(runRow.id, trialRow.id, placeholderGraphId, mergedScore);
      // Patch the run id to match the actual insertion
      mockResult.run = { ...mockResult.run, id: runRow.id };
      mockResult.trials = mockResult.trials.map((t: any) => ({
        ...t,
        trialId: trialRow.id,
        runId: runRow.id,
      }));
      mockResult.rankedCandidates = mockResult.rankedCandidates.map((c: any) => ({
        ...c,
        trialId: trialRow.id,
      }));
      return mockResult;
    },
  } as any;

  return {
    walkForwardEvaluator,
    cleanup: () => {
      // No special cleanup needed — the context's destroyResearchProofContext
      // handles the temp DB deletion.
    },
  };
}

