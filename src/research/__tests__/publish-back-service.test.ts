// ── ResearchPublishBackService tests ──
// Covers happy path (publish), idempotency (duplicate call returns existing),
// evaluation state edge cases (not found, terminal, non-terminal), prerequisites
// (missing winner, missing artifacts), threshold failures, dry-run support,
// and transaction failure safety.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseManager } from '../../persistence/sqlite.js';
import { HypothesisRepository } from '../../persistence/hypothesis-repo.js';
import { WalkForwardRepository } from '../../persistence/walk-forward-repo.js';
import { StrategyLifecycleRepository } from '../../persistence/strategy-lifecycle-repo.js';
import { ResearchPublishBackService } from '../publish-back-service.js';
import {
  HypothesisEvaluationStatus,
  HypothesisStatus,
  ResearchPublicationStatus,
  ResearchPublishBackVerdict,
  ResearchArtifactType,
  GovernanceVerdict,
  StrategyLifecyclePhase,
  type BoundedCandidate,
  type HypothesisGraph,
  type HypothesisGraphRow,
  type HypothesisEvaluationRow,
  type HypothesisResearchConfig,
} from '../../types/runtime.js';
import { WalkForwardEvaluator } from '../../replay/walk-forward-evaluator.js';
import { FixtureHistoricalDataProvider } from '../../replay/historical-data-provider.js';
import { WinnerSelector } from '../../replay/winner-selection.js';
import { ResearchArtifactWriter } from '../artifact-writer.js';
import { HypothesisResearchEvaluator } from '../hypothesis-evaluator.js';
import { INDIA_NSE_EQ_MARKET } from '../../market/india-profile.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-back-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Create an in-memory DB context with HypothesisRepository and
 * StrategyLifecycleRepository ready.
 */
function createContext(): {
  dbManager: DatabaseManager;
  hypothesisRepo: HypothesisRepository;
  lifecycleRepo: StrategyLifecycleRepository;
  publishBack: ResearchPublishBackService;
} {
  const dbManager = new DatabaseManager(':memory:');
  const hypothesisRepo = new HypothesisRepository(dbManager.db);
  const lifecycleRepo = new StrategyLifecycleRepository(dbManager.db);
  const publishBack = new ResearchPublishBackService({
    db: dbManager.db,
    hypothesisRepo,
    lifecycleRepo,
  });
  return { dbManager, hypothesisRepo, lifecycleRepo, publishBack };
}

function validGraph(overrides?: Partial<HypothesisGraph>): HypothesisGraph {
  return {
    schemaVersion: '1',
    signals: [{ type: 'ema_cross', params: { fast: 8, slow: 21 } }],
    filters: [{ type: 'volume_min', params: { min: 500000 } }],
    entryRules: [{ type: 'breakout_confirmed', params: { lookbackBars: 5 } }],
    exitRules: [{ type: 'time_stop', params: { maxBars: 12 } }],
    riskRules: [{ type: 'atr_stop', params: { period: 14, multiple: 2 } }],
    ...overrides,
  };
}

/** Insert a validated hypothesis graph and return its row. */
function insertValidHypothesis(repo: HypothesisRepository): HypothesisGraphRow {
  const graph = validGraph();
  return repo.insertHypothesis({
    canonicalHash: 'test-hash-1',
    canonicalJson: '{}',
    status: HypothesisStatus.Validated,
    graph,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** Insert a walk-forward run (minimal fields). */
function insertWalkForwardRun(db: DatabaseManager, overrides?: {
  label?: string;
  strategyId?: string;
  strategyVersion?: string;
  marketId?: string;
  status?: string;
}): number {
  const now = Date.now();
  const result = db.db.prepare(`
    INSERT INTO walk_forward_runs
      (label, strategy_id, strategy_version, market_id,
       window_count, total_trials, status, created_at, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides?.label ?? 'test-run',
    overrides?.strategyId ?? 'test-strategy',
    overrides?.strategyVersion ?? '1.0.0',
    overrides?.marketId ?? 'INDIA_NSE_EQ',
    5, 10,
    overrides?.status ?? 'completed',
    now, now, now,
  );
  return Number(result.lastInsertRowid);
}

/** Insert a walk-forward winner row and return its id. */
function insertWinner(db: DatabaseManager, runId: number, overrides?: {
  mergedScore?: number;
  selectedTrialId?: number | null;
}): number {
  const now = Date.now();
  const result = db.db.prepare(`
    INSERT INTO walk_forward_winners
      (run_id, result, selected_trial_id, selection_strategy,
       selection_config_json, rationale, artifact_paths_json,
       selected_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId, 'selected', overrides?.selectedTrialId ?? null, 'threshold',
    '{}', 'Test winner', null, now, now,
  );
  return Number(result.lastInsertRowid);
}

/** Insert a walk_forward_trial row with a merged score, returning its id. */
function insertTrial(db: DatabaseManager, runId: number, mergedScore: number): number {
  const now = Date.now();
  const result = db.db.prepare(`
    INSERT INTO walk_forward_trials
      (run_id, trial_index, label, params_json,
       merged_score, deterministic_score, llm_score, llm_status,
       rank, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId, 0, 'test-trial', '{}',
    mergedScore, 0.7, null, null,
    1, now,
  );
  return Number(result.lastInsertRowid);
}

/** Set up a fully completed evaluation with winner and artifacts. */
function setupCompletedEvaluation(
  ctx: { dbManager: DatabaseManager; hypothesisRepo: HypothesisRepository },
  overrides?: {
    hypothesisOverrides?: Partial<HypothesisGraph>;
    winnerMergedScore?: number;
  },
): {
  hypothesis: HypothesisGraphRow;
  evaluation: HypothesisEvaluationRow;
  winnerId: number;
  runId: number;
} {
  const hypothesis = insertValidHypothesis(ctx.hypothesisRepo);
  const runId = insertWalkForwardRun(ctx.dbManager);
  const mergedScore = overrides?.winnerMergedScore ?? 0.85;
  const trialId = insertTrial(ctx.dbManager, runId, mergedScore);
  const winnerId = insertWinner(ctx.dbManager, runId, {
    selectedTrialId: trialId,
  });

  const now = Date.now();
  const evalRow = ctx.hypothesisRepo.insertEvaluation({
    hypothesisGraphId: hypothesis.id,
    walkForwardRunId: runId,
    status: HypothesisEvaluationStatus.Completed,
    winnerId,
    rationale: 'Test evaluation completed successfully.',
    outcomeDetail: 'Winner selected.',
    createdAt: now,
    updatedAt: now,
  });

  // Insert artifacts for the evaluation
  const artifactDir = makeTmpDir();
  const artifactPath = path.join(artifactDir, 'promotion-artifact.json');
  fs.writeFileSync(artifactPath, '{}', 'utf-8');

  ctx.hypothesisRepo.insertResearchArtifact({
    hypothesisEvaluationId: evalRow.id,
    artifactType: ResearchArtifactType.PromotionArtifact,
    format: 'json',
    filePath: artifactPath,
    label: 'Promotion artifact',
    createdAt: now,
  });

  ctx.hypothesisRepo.insertResearchArtifact({
    hypothesisEvaluationId: evalRow.id,
    artifactType: ResearchArtifactType.Diagnostics,
    format: 'json',
    filePath: path.join(artifactDir, 'diagnostics.json'),
    label: 'Diagnostics',
    createdAt: now,
  });

  return { hypothesis, evaluation: evalRow, winnerId, runId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResearchPublishBackService', () => {
  describe('publish()', () => {
    // ── Happy path ──
    it('should publish a completed evaluation with winner and artifacts', () => {
      const ctx = createContext();
      const { hypothesis, evaluation } = setupCompletedEvaluation(ctx);

      const result = ctx.publishBack.publish(evaluation.id);

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Publish);
      expect(result.isDryRun).toBe(false);
      expect(result.publication).not.toBeNull();
      expect(result.publication!.status).toBe(ResearchPublicationStatus.Published);
      expect(result.publication!.hypothesisEvaluationId).toBe(evaluation.id);
      expect(result.publication!.hypothesisGraphId).toBe(hypothesis.id);
      expect(result.publication!.strategyId).toBe(`research-hypothesis-${hypothesis.id}`);
      expect(result.publication!.strategyVersion).toBe('1.0.0');
      expect(result.publication!.marketId).toBe('INDIA_NSE_EQ');
      expect(result.publication!.publishedAt).not.toBeNull();
      expect(result.publication!.lifecycleStateId).not.toBeNull();
      expect(result.publication!.governanceDecisionId).not.toBeNull();

      // Verify lifecycle state was created
      expect(result.lifecycleStateId).toBe(result.publication!.lifecycleStateId);
      const state = ctx.lifecycleRepo.getCurrentState(
        `research-hypothesis-${hypothesis.id}`,
        '1.0.0',
        'INDIA_NSE_EQ',
      );
      expect(state.phase).toBe(StrategyLifecyclePhase.Backtest);
      expect(state.id).toBe(result.lifecycleStateId);

      // Verify governance decision was created
      expect(result.governanceDecisionId).toBe(result.publication!.governanceDecisionId);
      const decisions = ctx.lifecycleRepo.getDecisionsForStrategy(
        `research-hypothesis-${hypothesis.id}`,
        '1.0.0',
        'INDIA_NSE_EQ',
      );
      expect(decisions.length).toBe(1);
      expect(decisions[0].verdict).toBe(GovernanceVerdict.Promote);
      expect(decisions[0].id).toBe(result.governanceDecisionId);
    });

    // ── Idempotency ──
    it('should return the existing publication on duplicate calls (idempotency)', () => {
      const ctx = createContext();
      const { evaluation } = setupCompletedEvaluation(ctx);

      const firstResult = ctx.publishBack.publish(evaluation.id);
      expect(firstResult.verdict).toBe(ResearchPublishBackVerdict.Publish);
      expect(firstResult.publication).not.toBeNull();

      const secondResult = ctx.publishBack.publish(evaluation.id);
      expect(secondResult.verdict).toBe(ResearchPublishBackVerdict.Publish);
      expect(secondResult.publication).not.toBeNull();
      expect(secondResult.publication!.id).toBe(firstResult.publication!.id);
      expect(secondResult.publication!.status).toBe(ResearchPublicationStatus.Published);
      expect(secondResult.rationale).toContain('Existing publication found');
    });

    // ── Evaluation not found ──
    it('should return rejected when evaluation does not exist', () => {
      const ctx = createContext();

      const result = ctx.publishBack.publish(99999);

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Hold);
      expect(result.publication).toBeNull();
      expect(result.isDryRun).toBe(false);
      expect(result.rationale).toContain('not found');
    });

    // ── Terminal state: Failed ──
    it('should return rejected for Failed evaluations', () => {
      const ctx = createContext();
      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo);
      const now = Date.now();
      const evalRow = ctx.hypothesisRepo.insertEvaluation({
        hypothesisGraphId: hypothesis.id,
        status: HypothesisEvaluationStatus.Failed,
        rationale: 'Evaluation failed.',
        outcomeDetail: 'Error occurred.',
        createdAt: now,
      });

      const result = ctx.publishBack.publish(evalRow.id);

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Hold);
      expect(result.publication).not.toBeNull();
      expect(result.publication!.status).toBe(ResearchPublicationStatus.Rejected);
      expect(result.rationale).toContain('failed');
      expect(result.rationale).toContain('terminal');
    });

    // ── Terminal state: Cancelled ──
    it('should return rejected for Cancelled evaluations', () => {
      const ctx = createContext();
      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo);
      const now = Date.now();
      const evalRow = ctx.hypothesisRepo.insertEvaluation({
        hypothesisGraphId: hypothesis.id,
        status: HypothesisEvaluationStatus.Cancelled,
        rationale: 'Cancelled.',
        outcomeDetail: 'Operator cancelled.',
        createdAt: now,
      });

      const result = ctx.publishBack.publish(evalRow.id);

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Hold);
      expect(result.publication!.status).toBe(ResearchPublicationStatus.Rejected);
    });

    // ── Terminal state: NoWinner ──
    it('should return rejected for NoWinner evaluations', () => {
      const ctx = createContext();
      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo);
      const now = Date.now();
      const evalRow = ctx.hypothesisRepo.insertEvaluation({
        hypothesisGraphId: hypothesis.id,
        status: HypothesisEvaluationStatus.NoWinner,
        rationale: 'No winner selected.',
        outcomeDetail: 'No qualifying trial.',
        createdAt: now,
      });

      const result = ctx.publishBack.publish(evalRow.id);

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Hold);
      expect(result.publication!.status).toBe(ResearchPublicationStatus.Rejected);
    });

    // ── Non-terminal state: Pending ──
    it('should return rejected for non-terminal evaluation states', () => {
      const ctx = createContext();
      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo);
      const now = Date.now();
      const evalRow = ctx.hypothesisRepo.insertEvaluation({
        hypothesisGraphId: hypothesis.id,
        status: HypothesisEvaluationStatus.Pending,
        rationale: 'Pending.',
        outcomeDetail: 'Not started.',
        createdAt: now,
      });

      const result = ctx.publishBack.publish(evalRow.id);

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Hold);
      expect(result.publication!.status).toBe(ResearchPublicationStatus.Rejected);
    });

    // ── No winner linked ──
    it('should hold when evaluation has no linked winner', () => {
      const ctx = createContext();
      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo);
      const runId = insertWalkForwardRun(ctx.dbManager);
      const now = Date.now();
      const evalRow = ctx.hypothesisRepo.insertEvaluation({
        hypothesisGraphId: hypothesis.id,
        walkForwardRunId: runId,
        status: HypothesisEvaluationStatus.Completed,
        winnerId: null,
        rationale: 'Completed but no winner.',
        outcomeDetail: 'No winner.',
        createdAt: now,
      });

      // Add artifacts so the only failure is missing winner
      ctx.hypothesisRepo.insertResearchArtifact({
        hypothesisEvaluationId: evalRow.id,
        artifactType: ResearchArtifactType.PromotionArtifact,
        format: 'json',
        filePath: '/tmp/test-artifact.json',
        label: 'Promotion artifact',
        createdAt: now,
      });

      const result = ctx.publishBack.publish(evalRow.id);

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Hold);
      expect(result.publication).not.toBeNull();
      expect(result.publication!.status).toBe(ResearchPublicationStatus.Held);
      // Should have at least one hold reason about missing winner
      expect(result.rationale).toContain('winner');
    });

    // ── Missing promotion artifact ──
    it('should hold when required promotion artifact is missing', () => {
      const ctx = createContext();
      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo);
      const runId = insertWalkForwardRun(ctx.dbManager);
      const trialId = insertTrial(ctx.dbManager, runId, 0.85);
      const winnerId = insertWinner(ctx.dbManager, runId, { selectedTrialId: trialId });
      const now = Date.now();
      const evalRow = ctx.hypothesisRepo.insertEvaluation({
        hypothesisGraphId: hypothesis.id,
        walkForwardRunId: runId,
        status: HypothesisEvaluationStatus.Completed,
        winnerId,
        rationale: 'Completed.',
        outcomeDetail: 'Winner selected.',
        createdAt: now,
      });

      // No artifacts inserted
      const result = ctx.publishBack.publish(evalRow.id);

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Hold);
      expect(result.publication!.status).toBe(ResearchPublicationStatus.Held);
      expect(result.rationale).toContain('promotion artifact');
    });

    // ── Threshold failure: merged score below minimum ──
    it('should hold when merged score is below minimum threshold', () => {
      const ctx = createContext();
      const { evaluation } = setupCompletedEvaluation(ctx, { winnerMergedScore: 0.3 });

      const result = ctx.publishBack.publish(evaluation.id, { minMergedScore: 0.7 });

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Hold);
      expect(result.publication!.status).toBe(ResearchPublicationStatus.Held);
      expect(result.rationale).toContain('below minimum threshold');
    });

    // ── Threshold failure: merged score null ──
    it('should hold when merged score is null despite having a winner', () => {
      const ctx = createContext();
      // Winner with no selected_trial_id (thus no merged score available)
      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo);
      const runId = insertWalkForwardRun(ctx.dbManager);
      const now = Date.now();

      // Insert winner without a selected_trial_id
      const winnerId = insertWinner(ctx.dbManager, runId, { selectedTrialId: null });

      const evalRow = ctx.hypothesisRepo.insertEvaluation({
        hypothesisGraphId: hypothesis.id,
        walkForwardRunId: runId,
        status: HypothesisEvaluationStatus.Completed,
        winnerId,
        rationale: 'Completed.',
        outcomeDetail: 'Winner selected.',
        createdAt: now,
      });

      ctx.hypothesisRepo.insertResearchArtifact({
        hypothesisEvaluationId: evalRow.id,
        artifactType: ResearchArtifactType.PromotionArtifact,
        format: 'json',
        filePath: '/tmp/test-artifact.json',
        label: 'Promotion artifact',
        createdAt: now,
      });

      const result = ctx.publishBack.publish(evalRow.id);

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Hold);
      expect(result.publication!.status).toBe(ResearchPublicationStatus.Held);
      // Should mention no merged score
      expect(result.rationale).toContain('merged score');
    });

    // ── Dry-run: published scenario ──
    it('should return publish verdict without persisting on dry-run', () => {
      const ctx = createContext();
      const { evaluation } = setupCompletedEvaluation(ctx);

      const result = ctx.publishBack.publish(evaluation.id, { dryRun: true });

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Publish);
      expect(result.isDryRun).toBe(true);
      expect(result.publication).toBeNull();
      expect(result.lifecycleStateId).toBeNull();
      expect(result.governanceDecisionId).toBeNull();

      // Verify nothing was persisted
      const publications = ctx.hypothesisRepo.getRecentPublications();
      expect(publications.length).toBe(0);
      const decisions = ctx.lifecycleRepo.getAllDecisions();
      expect(decisions.length).toBe(0);
    });

    // ── Dry-run: held scenario ──
    it('should return hold verdict without persisting on dry-run when thresholds fail', () => {
      const ctx = createContext();
      const { evaluation } = setupCompletedEvaluation(ctx, { winnerMergedScore: 0.3 });

      const result = ctx.publishBack.publish(evaluation.id, {
        minMergedScore: 0.7,
        dryRun: true,
      });

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Hold);
      expect(result.isDryRun).toBe(true);
      expect(result.publication).toBeNull();

      // Verify nothing was persisted
      const publications = ctx.hypothesisRepo.getRecentPublications();
      expect(publications.length).toBe(0);
    });

    // ── Dry-run: rejected scenario ──
    it('should return rejected verdict without persisting on dry-run for terminal state', () => {
      const ctx = createContext();
      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo);
      const now = Date.now();
      const evalRow = ctx.hypothesisRepo.insertEvaluation({
        hypothesisGraphId: hypothesis.id,
        status: HypothesisEvaluationStatus.Failed,
        rationale: 'Failed.',
        outcomeDetail: 'Error.',
        createdAt: now,
      });

      const result = ctx.publishBack.publish(evalRow.id, { dryRun: true });

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Hold);
      expect(result.isDryRun).toBe(true);
      expect(result.publication).toBeNull();
    });

    // ── Custom strategy version ──
    it('should use default strategy version 1.0.0 for research hypotheses', () => {
      const ctx = createContext();
      const { hypothesis, evaluation } = setupCompletedEvaluation(ctx);

      const result = ctx.publishBack.publish(evaluation.id);

      expect(result.publication!.strategyId).toBe(`research-hypothesis-${hypothesis.id}`);
      expect(result.publication!.strategyVersion).toBe('1.0.0');
    });

    // ── Evaluation with completed but no walk-forward run ──
    it('should hold when evaluation is completed but has no linked walk-forward run', () => {
      const ctx = createContext();
      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo);
      const now = Date.now();
      const evalRow = ctx.hypothesisRepo.insertEvaluation({
        hypothesisGraphId: hypothesis.id,
        walkForwardRunId: null,
        status: HypothesisEvaluationStatus.Completed,
        winnerId: null,
        rationale: 'Completed.',
        outcomeDetail: 'Done.',
        createdAt: now,
      });

      ctx.hypothesisRepo.insertResearchArtifact({
        hypothesisEvaluationId: evalRow.id,
        artifactType: ResearchArtifactType.PromotionArtifact,
        format: 'json',
        filePath: '/tmp/test-artifact.json',
        label: 'Promotion artifact',
        createdAt: now,
      });

      const result = ctx.publishBack.publish(evalRow.id);

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Hold);
      expect(result.publication!.status).toBe(ResearchPublicationStatus.Held);
      expect(result.rationale).toContain('winner');
    });

    // ── Held publication rationale contains all failure reasons ──
    it('should include all hold reasons in the rationale', () => {
      const ctx = createContext();
      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo);
      const now = Date.now();
      const evalRow = ctx.hypothesisRepo.insertEvaluation({
        hypothesisGraphId: hypothesis.id,
        status: HypothesisEvaluationStatus.Completed,
        winnerId: null,
        rationale: 'No winner.',
        outcomeDetail: 'None.',
        createdAt: now,
      });

      // Both winner missing AND artifact missing
      const result = ctx.publishBack.publish(evalRow.id);

      expect(result.verdict).toBe(ResearchPublishBackVerdict.Hold);
      expect(result.publication!.status).toBe(ResearchPublicationStatus.Held);
      expect(result.rationale).toContain('winner');
      expect(result.rationale).toContain('promotion artifact');
    });

    // ── Evidence snapshot shape on publish ──
    it('should embed a valid evidence snapshot on published publications', () => {
      const ctx = createContext();
      const { evaluation } = setupCompletedEvaluation(ctx);

      const result = ctx.publishBack.publish(evaluation.id);

      expect(result.publication).not.toBeNull();
      const evidence = JSON.parse(result.publication!.evidenceJson);
      expect(evidence).toHaveProperty('minMergedScore');
      expect(evidence).toHaveProperty('actualMergedScore');
      expect(evidence).toHaveProperty('hasPromotionArtifact');
      expect(evidence).toHaveProperty('hasArtifacts');
      expect(evidence).toHaveProperty('artifactCount');
      expect(evidence).toHaveProperty('hasRationale');
      expect(evidence).toHaveProperty('hasWinner');
      expect(evidence).toHaveProperty('holdReasons');
      expect(evidence.actualMergedScore).toBeGreaterThan(0);
      expect(evidence.hasPromotionArtifact).toBe(true);
      expect(evidence.hasWinner).toBe(true);
      expect(evidence.holdReasons).toEqual([]);
    });

    // ── getRecentPublications reflects persisted publications ──
    it('should make publications visible via getRecentPublications', () => {
      const ctx = createContext();
      const { hypothesis, evaluation } = setupCompletedEvaluation(ctx);

      ctx.publishBack.publish(evaluation.id);

      const publications = ctx.hypothesisRepo.getRecentPublications();
      expect(publications.length).toBe(1);
      expect(publications[0].hypothesisEvaluationId).toBe(evaluation.id);
      expect(publications[0].hypothesisGraphId).toBe(hypothesis.id);
      expect(publications[0].status).toBe(ResearchPublicationStatus.Published);
    });

    // ── Held publications are visible via getRecentPublications ──
    it('should make held publications visible via getRecentPublications', () => {
      const ctx = createContext();
      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo);
      const now = Date.now();
      const evalRow = ctx.hypothesisRepo.insertEvaluation({
        hypothesisGraphId: hypothesis.id,
        status: HypothesisEvaluationStatus.Completed,
        winnerId: null,
        rationale: 'No winner.',
        outcomeDetail: 'None.',
        createdAt: now,
      });

      ctx.publishBack.publish(evalRow.id);

      const publications = ctx.hypothesisRepo.getRecentPublications();
      expect(publications.length).toBe(1);
      expect(publications[0].status).toBe(ResearchPublicationStatus.Held);
    });

    // ── Rejected publications are visible via getRecentPublications ──
    it('should make rejected publications visible via getRecentPublications', () => {
      const ctx = createContext();
      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo);
      const now = Date.now();
      const evalRow = ctx.hypothesisRepo.insertEvaluation({
        hypothesisGraphId: hypothesis.id,
        status: HypothesisEvaluationStatus.Failed,
        rationale: 'Failed.',
        outcomeDetail: 'Error.',
        createdAt: now,
      });

      ctx.publishBack.publish(evalRow.id);

      const publications = ctx.hypothesisRepo.getRecentPublications();
      expect(publications.length).toBe(1);
      expect(publications[0].status).toBe(ResearchPublicationStatus.Rejected);
    });
  });

  // -----------------------------------------------------------------------
  // Integration tests — real evaluator pipeline → publish-back
  // -----------------------------------------------------------------------

  describe('publish() integration with real evaluator', () => {
    const DAY_MS = 86_400_000;

    const candidates: BoundedCandidate[] = [
      {
        exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 738561, side: 'buy',
        lastPrice: 2450.5, bid: 2450, ask: 2451, volume: 1_250_000, instrumentType: 'EQ',
        lotSize: 1, tickSize: 0.05, expiry: null, strike: null, freezeQuantity: null,
      },
      {
        exchange: 'NSE', tradingsymbol: 'TCS', instrumentToken: 2953217, side: 'buy',
        lastPrice: 3890, bid: 3889.5, ask: 3890.5, volume: 850_000, instrumentType: 'EQ',
        lotSize: 1, tickSize: 0.05, expiry: null, strike: null, freezeQuantity: null,
      },
    ];

    function validGraph(overrides?: Partial<HypothesisGraph>): HypothesisGraph {
      return {
        schemaVersion: '1',
        signals: [{ type: 'ema_cross', params: { fast: 8, slow: 21 } }],
        filters: [{ type: 'volume_min', params: { min: 500000 } }],
        entryRules: [{ type: 'breakout_confirmed', params: { lookbackBars: 5 } }],
        exitRules: [{ type: 'time_stop', params: { maxBars: 12 } }],
        riskRules: [{ type: 'atr_stop', params: { period: 14, multiple: 2 } }],
        ...overrides,
      };
    }

    /**
     * Run the full evaluator pipeline and then attempt publish-back.
     * Tests the end-to-end flow from validated hypothesis → evaluation → publish.
     */
    it('should publish a real evaluator result through the pipeline end-to-end', async () => {
      const cwd = process.cwd();
      let workDir = '';
      try {
        workDir = makeTmpDir();
        process.chdir(workDir);

        const dbManager = new DatabaseManager(':memory:');
        const hypothesisRepo = new HypothesisRepository(dbManager.db);
        const walkForwardRepo = new WalkForwardRepository(dbManager.db);
        const lifecycleRepo = new StrategyLifecycleRepository(dbManager.db);
        const publishBack = new ResearchPublishBackService({
          db: dbManager.db,
          hypothesisRepo,
          lifecycleRepo,
        });

        const rangeEnd = Date.UTC(2025, 0, 31);
        const rangeStart = rangeEnd - 14 * DAY_MS;

        const dataProvider = new FixtureHistoricalDataProvider({
          candidates,
          rangeStart,
          rangeEnd,
        });

        const walkForwardEval = new WalkForwardEvaluator({
          db: dbManager.db,
          marketProfile: INDIA_NSE_EQ_MARKET,
          dataProvider,
        });

        // Insert a validated hypothesis
        const hypothesisRow = hypothesisRepo.insertHypothesis({
          canonicalHash: 'ab'.repeat(32),
          canonicalJson: JSON.stringify(validGraph()),
          status: HypothesisStatus.Validated,
          graph: validGraph(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        const artifactWriter = new ResearchArtifactWriter();
        const winnerSelector = new WinnerSelector();

        const evaluator = new HypothesisResearchEvaluator({
          db: dbManager.db,
          dataProvider,
          marketProfile: INDIA_NSE_EQ_MARKET,
          hypothesisRepo,
          walkForwardRepo,
          artifactWriter,
          winnerSelector,
          walkForwardEvaluator: walkForwardEval,
        });

        // Run evaluation
        const evalConfig: HypothesisResearchConfig = {
          rangeStart,
          rangeEnd,
          windowSizeMs: 4 * DAY_MS,
          stepSizeMs: 2 * DAY_MS,
          inSampleRatio: 0.75,
          maxCandidates: 3,
          cadenceMinutes: 5,
          selectionStrategy: 'threshold',
          minMergedScore: 0.2,
          minWindowCount: 1,
        };

        const evalResult = await evaluator.evaluate(hypothesisRow.id, evalConfig);

        // Evaluation must have completed enough to have an evaluation row
        expect(evalResult.evaluation.id).toBeGreaterThan(0);
        expect(evalResult.evaluation.hypothesisGraphId).toBe(hypothesisRow.id);

        // Only attempt publish if evaluation didn't fail hard
        if (evalResult.finalStatus === HypothesisEvaluationStatus.Completed) {
          // ── Now publish the evaluation result ──
          const pubResult = publishBack.publish(evalResult.evaluation.id);

          // Should have published or held
          expect([ResearchPublishBackVerdict.Publish, ResearchPublishBackVerdict.Hold]).toContain(pubResult.verdict);
          expect(pubResult.isDryRun).toBe(false);

          if (pubResult.verdict === ResearchPublishBackVerdict.Publish) {
            // Verify publication persistence
            expect(pubResult.publication).not.toBeNull();
            expect(pubResult.publication!.status).toBe(ResearchPublicationStatus.Published);
            expect(pubResult.publication!.hypothesisEvaluationId).toBe(evalResult.evaluation.id);
            expect(pubResult.publication!.hypothesisGraphId).toBe(hypothesisRow.id);
            expect(pubResult.publication!.publishedAt).not.toBeNull();
            expect(pubResult.publication!.lifecycleStateId).not.toBeNull();
            expect(pubResult.publication!.governanceDecisionId).not.toBeNull();
            expect(pubResult.lifecycleStateId).toBe(pubResult.publication!.lifecycleStateId);
            expect(pubResult.governanceDecisionId).toBe(pubResult.publication!.governanceDecisionId);

            // Verify lifecycle state was created
            const state = lifecycleRepo.getCurrentState(
              pubResult.publication!.strategyId,
              pubResult.publication!.strategyVersion,
              pubResult.publication!.marketId,
            );
            expect(state).not.toBeNull();
            expect(state.phase).toBe(StrategyLifecyclePhase.Backtest);

            // Verify governance decision was created
            const decisions = lifecycleRepo.getDecisionsForStrategy(
              pubResult.publication!.strategyId,
              pubResult.publication!.strategyVersion,
              pubResult.publication!.marketId,
            );
            expect(decisions.length).toBe(1);
            expect(decisions[0].verdict).toBe(GovernanceVerdict.Promote);

            // Verify publication visible via repo
            const recentPubs = hypothesisRepo.getRecentPublications();
            expect(recentPubs.some(p => p.id === pubResult.publication!.id)).toBe(true);
          } else {
            // Hold — verify evidence snapshot
            expect(pubResult.publication!.status).toBe(ResearchPublicationStatus.Held);
            expect(pubResult.publication!.lifecycleStateId).toBeNull();
            expect(pubResult.publication!.governanceDecisionId).toBeNull();
            const evidence = JSON.parse(pubResult.publication!.evidenceJson);
            expect(evidence.holdReasons.length).toBeGreaterThan(0);
          }
        } else {
          // Evaluation ended in Failed/NoWinner — verify publish returns rejected
          const pubResult = publishBack.publish(evalResult.evaluation.id);
          expect(pubResult.verdict).toBe(ResearchPublishBackVerdict.Hold);
          expect(pubResult.publication).not.toBeNull();
          expect(pubResult.publication!.status).toBe(ResearchPublicationStatus.Rejected);
        }

        dbManager.close();
      } finally {
        process.chdir(cwd);
      }
    }, 60_000); // 60s timeout for the full eval pipeline

    // ── Dry-run integration ──
    it('should not persist anything on dry-run through the full pipeline', async () => {
      const cwd = process.cwd();
      let workDir = '';
      try {
        workDir = makeTmpDir();
        process.chdir(workDir);

        const dbManager = new DatabaseManager(':memory:');
        const hypothesisRepo = new HypothesisRepository(dbManager.db);
        const walkForwardRepo = new WalkForwardRepository(dbManager.db);
        const lifecycleRepo = new StrategyLifecycleRepository(dbManager.db);
        const publishBack = new ResearchPublishBackService({
          db: dbManager.db,
          hypothesisRepo,
          lifecycleRepo,
        });

        const rangeEnd = Date.UTC(2025, 0, 31);
        const rangeStart = rangeEnd - 14 * DAY_MS;

        const dataProvider = new FixtureHistoricalDataProvider({
          candidates,
          rangeStart,
          rangeEnd,
        });

        const walkForwardEval = new WalkForwardEvaluator({
          db: dbManager.db,
          marketProfile: INDIA_NSE_EQ_MARKET,
          dataProvider,
        });

        const hypothesisRow = hypothesisRepo.insertHypothesis({
          canonicalHash: 'cd'.repeat(32),
          canonicalJson: JSON.stringify(validGraph()),
          status: HypothesisStatus.Validated,
          graph: validGraph(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        const evaluator = new HypothesisResearchEvaluator({
          db: dbManager.db,
          dataProvider,
          marketProfile: INDIA_NSE_EQ_MARKET,
          hypothesisRepo,
          walkForwardRepo,
        });

        const evalResult = await evaluator.evaluate(hypothesisRow.id, {
          rangeStart,
          rangeEnd,
          windowSizeMs: 4 * DAY_MS,
          stepSizeMs: 2 * DAY_MS,
          inSampleRatio: 0.75,
          maxCandidates: 3,
          cadenceMinutes: 5,
          selectionStrategy: 'threshold',
          minMergedScore: 0.2,
          minWindowCount: 1,
        });

        // Count publications before dry-run
        const pubsBefore = hypothesisRepo.getRecentPublications().length;

        // Dry-run publish
        const pubResult = publishBack.publish(evalResult.evaluation.id, { dryRun: true });

        expect(pubResult.isDryRun).toBe(true);
        expect(pubResult.publication).toBeNull();
        expect(pubResult.lifecycleStateId).toBeNull();
        expect(pubResult.governanceDecisionId).toBeNull();

        // Verify no new publications were created
        const pubsAfter = hypothesisRepo.getRecentPublications().length;
        expect(pubsAfter).toBe(pubsBefore);

        dbManager.close();
      } finally {
        process.chdir(cwd);
      }
    }, 60_000);
  });
});
