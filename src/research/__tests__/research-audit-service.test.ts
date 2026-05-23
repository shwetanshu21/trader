// ── ResearchAuditService tests ──
// Covers duplicate-skip, completed evaluation, held/rejected publication,
// published lineage, null/missing IDs, zero artifacts, and multiple governance decisions.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseManager } from '../../persistence/sqlite.js';
import { HypothesisRepository } from '../../persistence/hypothesis-repo.js';
import { HypothesisMemoryRepository } from '../../persistence/hypothesis-memory-repo.js';
import { StrategyLifecycleRepository } from '../../persistence/strategy-lifecycle-repo.js';
import { ResearchAuditService } from '../research-audit-service.js';
import {
  HypothesisEvaluationStatus,
  HypothesisMemoryStatus,
  HypothesisStatus,
  HypothesisValidationReasonCode,
  ResearchArtifactType,
  ResearchPublicationStatus,
  ResearchPublishBackVerdict,
  GovernanceVerdict,
  StrategyLifecyclePhase,
  type HypothesisGraph,
  type HypothesisGraphRow,
  type HypothesisEvaluationRow,
  type ResearchLineageSnapshot,
} from '../../types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Create an in-memory DB context with all three repositories and the audit service.
 */
function createContext(): {
  dbManager: DatabaseManager;
  hypothesisRepo: HypothesisRepository;
  memoryRepo: HypothesisMemoryRepository;
  lifecycleRepo: StrategyLifecycleRepository;
  auditService: ResearchAuditService;
} {
  const dbManager = new DatabaseManager(':memory:');
  const hypothesisRepo = new HypothesisRepository(dbManager.db);
  const memoryRepo = new HypothesisMemoryRepository(dbManager.db);
  const lifecycleRepo = new StrategyLifecycleRepository(dbManager.db);
  const auditService = new ResearchAuditService({
    hypothesisRepo,
    memoryRepo,
    lifecycleRepo,
  });
  return { dbManager, hypothesisRepo, memoryRepo, lifecycleRepo, auditService };
}

function validGraph(): HypothesisGraph {
  return {
    schemaVersion: '1',
    signals: [{ type: 'ema_cross', params: { fast: 8, slow: 21 } }],
    filters: [{ type: 'volume_min', params: { min: 500000 } }],
    entryRules: [{ type: 'breakout_confirmed', params: { lookbackBars: 5 } }],
    exitRules: [{ type: 'time_stop', params: { maxBars: 12 } }],
    riskRules: [{ type: 'atr_stop', params: { period: 14, multiple: 2 } }],
  };
}

/** Insert a validated hypothesis graph and return its row. */
function insertValidHypothesis(repo: HypothesisRepository, canonicalHash?: string): HypothesisGraphRow {
  const hash = canonicalHash ?? 'test-hash-audit';
  return repo.insertHypothesis({
    canonicalHash: hash,
    canonicalJson: '{}',
    status: HypothesisStatus.Validated,
    graph: validGraph(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** Insert a walk-forward run (minimal fields). */
function insertWalkForwardRun(db: DatabaseManager): number {
  const now = Date.now();
  const result = db.db.prepare(`
    INSERT INTO walk_forward_runs
      (label, strategy_id, strategy_version, market_id,
       window_count, total_trials, status, created_at, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'test-run', 'test-strategy', '1.0.0', 'INDIA_NSE_EQ',
    5, 10, 'completed', now, now, now,
  );
  return Number(result.lastInsertRowid);
}

/** Insert a walk-forward winner row and return its id. */
function insertWinner(db: DatabaseManager, runId: number): number {
  const now = Date.now();
  const result = db.db.prepare(`
    INSERT INTO walk_forward_winners
      (run_id, result, selected_trial_id, selection_strategy,
       selection_config_json, rationale, artifact_paths_json,
       selected_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId, 'selected', null, 'threshold',
    '{}', 'Test winner', null, now, now,
  );
  return Number(result.lastInsertRowid);
}

/** Insert a walk_forward_trial row. */
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
    mergedScore, 0.7, null, null, 1, now,
  );
  return Number(result.lastInsertRowid);
}

/** Set up a fully completed evaluation with winner and artifacts. */
function setupCompletedEvaluation(
  ctx: { dbManager: DatabaseManager; hypothesisRepo: HypothesisRepository },
  canonicalHash?: string,
): {
  hypothesis: HypothesisGraphRow;
  evaluation: HypothesisEvaluationRow;
  winnerId: number;
  runId: number;
} {
  const hypothesis = insertValidHypothesis(ctx.hypothesisRepo, canonicalHash);
  const runId = insertWalkForwardRun(ctx.dbManager);
  const mergedScore = 0.85;
  const trialId = insertTrial(ctx.dbManager, runId, mergedScore);
  const winnerId = insertWinner(ctx.dbManager, runId);

  const evalRow = ctx.hypothesisRepo.insertEvaluation({
    hypothesisGraphId: hypothesis.id,
    walkForwardRunId: runId,
    status: HypothesisEvaluationStatus.Completed,
    winnerId,
    rationale: 'Test evaluation completed successfully.',
    outcomeDetail: 'Winner selected.',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // Update winner to link to trial
  ctx.dbManager.db.prepare(`
    UPDATE walk_forward_winners SET selected_trial_id = ? WHERE id = ?
  `).run(trialId, winnerId);

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
    createdAt: Date.now(),
  });

  ctx.hypothesisRepo.insertResearchArtifact({
    hypothesisEvaluationId: evalRow.id,
    artifactType: ResearchArtifactType.Diagnostics,
    format: 'json',
    filePath: path.join(artifactDir, 'diagnostics.json'),
    label: 'Diagnostics',
    createdAt: Date.now(),
  });

  return { hypothesis, evaluation: evalRow, winnerId, runId };
}

/** Publish an evaluation to create the full publication chain. */
function publishEvaluation(
  ctx: { dbManager: DatabaseManager; hypothesisRepo: HypothesisRepository; lifecycleRepo: StrategyLifecycleRepository },
  evaluationId: number,
): void {
  const evalRow = ctx.hypothesisRepo.getEvaluationById(evaluationId)!;
  const hypothesis = ctx.hypothesisRepo.getHypothesisById(evalRow.hypothesisGraphId)!;

  const now = Date.now();
  const strategyId = `research-hypothesis-${hypothesis.id}`;

  // Create lifecycle state
  const state = ctx.lifecycleRepo.upsertCurrentState({
    strategyId,
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    phase: StrategyLifecyclePhase.Backtest,
    updatedAt: now,
  });

  // Create governance decision
  const decision = ctx.lifecycleRepo.insertDecision({
    strategyId,
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    verdict: GovernanceVerdict.Promote,
    previousPhase: StrategyLifecyclePhase.Backtest,
    newPhase: StrategyLifecyclePhase.Paper,
    rationale: 'Hypothesis passed all governance thresholds.',
    evidenceJson: JSON.stringify({ minMergedScore: 0.7, actualMergedScore: 0.85 }),
    winnerId: evalRow.winnerId,
    recordedAt: now,
  });

  // Insert second governance decision for multi-decision tests
  ctx.lifecycleRepo.insertDecision({
    strategyId,
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    verdict: GovernanceVerdict.Promote,
    previousPhase: StrategyLifecyclePhase.Paper,
    newPhase: StrategyLifecyclePhase.Live,
    rationale: 'Second promotion after additional evidence.',
    evidenceJson: JSON.stringify({ minMergedScore: 0.7, actualMergedScore: 0.9 }),
    winnerId: evalRow.winnerId,
    recordedAt: now + 1000,
  });

  // Create publication row
  ctx.hypothesisRepo.insertPublication({
    hypothesisEvaluationId: evaluationId,
    hypothesisGraphId: hypothesis.id,
    status: ResearchPublicationStatus.Published,
    strategyId,
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    rationale: 'Hypothesis published after passing governance thresholds.',
    evidenceJson: JSON.stringify({ minMergedScore: 0.7, actualMergedScore: 0.85 }),
    lifecycleStateId: state.id,
    governanceDecisionId: decision.id,
    publishedAt: now,
    createdAt: now,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResearchAuditService', () => {
  describe('assembleLineage()', () => {
    // ── Unknown hash ──
    it('should return empty snapshot for an unknown canonical hash', () => {
      const ctx = createContext();
      const snapshot = ctx.auditService.assembleLineage('unknown-hash');

      expect(snapshot.canonicalHash).toBe('unknown-hash');
      expect(snapshot.duplicateEvidence).toBeNull();
      expect(snapshot.hypothesis).toBeNull();
      expect(snapshot.evaluation).toBeNull();
      expect(snapshot.artifacts).toBeNull();
      expect(snapshot.publicationEvidence).toBeNull();
      expect(snapshot.assembledAt).toBeGreaterThan(0);
    });

    // ── Null/malformed inputs ──
    it('should handle empty string as canonical hash gracefully', () => {
      const ctx = createContext();
      const snapshot = ctx.auditService.assembleLineage('');

      expect(snapshot.canonicalHash).toBe('');
      expect(snapshot.duplicateEvidence).toBeNull();
      expect(snapshot.hypothesis).toBeNull();
    });

    // ── Duplicate-skip with no hypothesis ──
    it('should surface duplicate-skip evidence when memory entry exists without hypothesis', () => {
      const ctx = createContext();
      const hash = 'dupe-hash-no-hypothesis';

      // Record a failed memory entry (no hypothesis row)
      const memory = ctx.memoryRepo.recordFailure({
        canonicalHash: hash,
        status: HypothesisMemoryStatus.Failed,
        reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
        reasonMessage: 'Prior hypothesis with same canonical form failed during evaluation.',
        hypothesisGraphId: null,
        createdAt: Date.now(),
      });

      const snapshot = ctx.auditService.assembleLineage(hash);

      // Should have duplicate evidence
      expect(snapshot.duplicateEvidence).not.toBeNull();
      expect(snapshot.duplicateEvidence!.entry.canonicalHash).toBe(hash);
      expect(snapshot.duplicateEvidence!.entry.status).toBe(HypothesisMemoryStatus.Failed);
      expect(snapshot.duplicateEvidence!.entry.reasonMessage).toContain('failed');
      expect(snapshot.duplicateEvidence!.hasLaterHypothesis).toBe(false);

      // No hypothesis or downstream lineage
      expect(snapshot.hypothesis).toBeNull();
      expect(snapshot.evaluation).toBeNull();
      expect(snapshot.artifacts).toBeNull();
      expect(snapshot.publicationEvidence).toBeNull();
    });

    // ── Duplicate-skip with later hypothesis ──
    it('should surface duplicate-skip evidence with hasLaterHypothesis=true when hypothesis exists', () => {
      const ctx = createContext();
      const hash = 'dupe-hash-with-hypothesis';

      // Record memory entry first
      ctx.memoryRepo.recordFailure({
        canonicalHash: hash,
        status: HypothesisMemoryStatus.Rejected,
        reasonCode: HypothesisValidationReasonCode.ExactRejectedMatch,
        reasonMessage: 'Prior hypothesis was rejected with exact match.',
        hypothesisGraphId: null,
        createdAt: Date.now(),
      });

      // Then insert a hypothesis row (simulating a retry despite the memory)
      insertValidHypothesis(ctx.hypothesisRepo, hash);

      const snapshot = ctx.auditService.assembleLineage(hash);

      expect(snapshot.duplicateEvidence).not.toBeNull();
      expect(snapshot.duplicateEvidence!.entry.status).toBe(HypothesisMemoryStatus.Rejected);
      expect(snapshot.duplicateEvidence!.hasLaterHypothesis).toBe(true);
      expect(snapshot.hypothesis).not.toBeNull();
      expect(snapshot.hypothesis!.canonicalHash).toBe(hash);
    });

    // ── Completed evaluation without publication ──
    it('should return evaluation snapshot with artifacts when evaluation exists without publication', () => {
      const ctx = createContext();
      const hash = 'eval-no-pub';

      const { hypothesis, evaluation } = setupCompletedEvaluation(ctx, hash);

      const snapshot = ctx.auditService.assembleLineage(hash);

      expect(snapshot.hypothesis).not.toBeNull();
      expect(snapshot.hypothesis!.id).toBe(hypothesis.id);

      // Evaluation should be present
      expect(snapshot.evaluation).not.toBeNull();
      expect(snapshot.evaluation!.evaluation.id).toBe(evaluation.id);
      expect(snapshot.evaluation!.evaluation.status).toBe(HypothesisEvaluationStatus.Completed);
      expect(snapshot.evaluation!.walkForwardRun).not.toBeNull();
      expect(snapshot.evaluation!.winner).not.toBeNull();

      // Artifacts should be present
      expect(snapshot.artifacts).not.toBeNull();
      expect(snapshot.artifacts!.length).toBe(2);
      expect(snapshot.artifacts![0].artifactType).toBe(ResearchArtifactType.PromotionArtifact);
      expect(snapshot.artifacts![1].artifactType).toBe(ResearchArtifactType.Diagnostics);

      // No publication evidence
      expect(snapshot.publicationEvidence).toBeNull();
    });

    // ── Held/rejected publication ──
    it('should return held publication evidence when publication status is Held', () => {
      const ctx = createContext();
      const hash = 'held-pub';

      const { hypothesis, evaluation } = setupCompletedEvaluation(ctx, hash);

      const now = Date.now();
      const strategyId = `research-hypothesis-${hypothesis.id}`;

      // Create a held publication (no lifecycle state or governance decision)
      ctx.hypothesisRepo.insertPublication({
        hypothesisEvaluationId: evaluation.id,
        hypothesisGraphId: hypothesis.id,
        status: ResearchPublicationStatus.Held,
        strategyId,
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
        rationale: 'Held: merged score below minimum threshold.',
        evidenceJson: JSON.stringify({
          minMergedScore: 0.7,
          actualMergedScore: 0.3,
          holdReasons: ['Merged score 0.3 is below minimum threshold 0.7'],
        }),
        lifecycleStateId: null,
        governanceDecisionId: null,
        publishedAt: null,
        createdAt: now,
      });

      const snapshot = ctx.auditService.assembleLineage(hash);

      expect(snapshot.publicationEvidence).not.toBeNull();
      expect(snapshot.publicationEvidence!.publication.status).toBe(ResearchPublicationStatus.Held);
      expect(snapshot.publicationEvidence!.publication.rationale).toContain('below minimum threshold');
      expect(snapshot.publicationEvidence!.lifecycleState).toBeNull();
      expect(snapshot.publicationEvidence!.governanceDecisions).toEqual([]);
    });

    // ── Rejected publication (terminal evaluation state) ──
    it('should return rejected publication evidence when evaluation is Failed', () => {
      const ctx = createContext();
      const hash = 'rejected-pub';

      // Insert a hypothesis with a Failed evaluation
      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo, hash);
      const now = Date.now();

      const evalRow = ctx.hypothesisRepo.insertEvaluation({
        hypothesisGraphId: hypothesis.id,
        status: HypothesisEvaluationStatus.Failed,
        rationale: 'Evaluation failed due to data error.',
        outcomeDetail: 'Insufficient historical data.',
        createdAt: now,
      });

      ctx.hypothesisRepo.insertPublication({
        hypothesisEvaluationId: evalRow.id,
        hypothesisGraphId: hypothesis.id,
        status: ResearchPublicationStatus.Rejected,
        strategyId: 'unused',
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
        rationale: 'Rejected: evaluation is in terminal state.',
        evidenceJson: '{}',
        lifecycleStateId: null,
        governanceDecisionId: null,
        publishedAt: null,
        createdAt: now,
      });

      const snapshot = ctx.auditService.assembleLineage(hash);

      expect(snapshot.publicationEvidence).not.toBeNull();
      expect(snapshot.publicationEvidence!.publication.status).toBe(ResearchPublicationStatus.Rejected);
      expect(snapshot.publicationEvidence!.lifecycleState).toBeNull();
    });

    // ── Full published lineage ──
    it('should return full published lineage with lifecycle state and governance decisions', () => {
      const ctx = createContext();
      const hash = 'full-published';

      const { hypothesis, evaluation } = setupCompletedEvaluation(ctx, hash);
      publishEvaluation(ctx, evaluation.id);

      const snapshot = ctx.auditService.assembleLineage(hash);

      // Hypothesis
      expect(snapshot.hypothesis).not.toBeNull();
      expect(snapshot.hypothesis!.id).toBe(hypothesis.id);

      // Evaluation with linked data
      expect(snapshot.evaluation).not.toBeNull();
      expect(snapshot.evaluation!.evaluation.id).toBe(evaluation.id);
      expect(snapshot.evaluation!.walkForwardRun).not.toBeNull();
      expect(snapshot.evaluation!.winner).not.toBeNull();

      // Artifacts
      expect(snapshot.artifacts).not.toBeNull();
      expect(snapshot.artifacts!.length).toBe(2);

      // Publication evidence
      expect(snapshot.publicationEvidence).not.toBeNull();
      expect(snapshot.publicationEvidence!.publication.status).toBe(ResearchPublicationStatus.Published);
      expect(snapshot.publicationEvidence!.publication.publishedAt).not.toBeNull();

      // Lifecycle state
      expect(snapshot.publicationEvidence!.lifecycleState).not.toBeNull();
      expect(snapshot.publicationEvidence!.lifecycleState!.phase).toBe(StrategyLifecyclePhase.Backtest);

      // Governance decisions (we inserted 2)
      expect(snapshot.publicationEvidence!.governanceDecisions.length).toBe(2);
      expect(snapshot.publicationEvidence!.governanceDecisions[0].verdict).toBe(GovernanceVerdict.Promote);
      expect(snapshot.publicationEvidence!.governanceDecisions[0].newPhase).toBe(StrategyLifecyclePhase.Live);
      expect(snapshot.publicationEvidence!.governanceDecisions[1].verdict).toBe(GovernanceVerdict.Promote);
      expect(snapshot.publicationEvidence!.governanceDecisions[1].newPhase).toBe(StrategyLifecyclePhase.Paper);
    });

    // ── Published lineage rationale strings ──
    it('should preserve exact rationale strings from persisted state', () => {
      const ctx = createContext();
      const hash = 'rationale-check';

      const { hypothesis, evaluation } = setupCompletedEvaluation(ctx, hash);
      publishEvaluation(ctx, evaluation.id);

      const snapshot = ctx.auditService.assembleLineage(hash);

      // Evaluation rationale
      expect(snapshot.evaluation!.evaluation.rationale).toBe(
        'Test evaluation completed successfully.',
      );

      // Winner rationale
      expect(snapshot.evaluation!.winner!.rationale).toBe('Test winner');

      // Publication rationale
      expect(snapshot.publicationEvidence!.publication.rationale).toBe(
        'Hypothesis published after passing governance thresholds.',
      );

      // Governance decision rationale
      expect(snapshot.publicationEvidence!.governanceDecisions[1].rationale).toBe(
        'Hypothesis passed all governance thresholds.',
      );
    });

    // ── Artifact ordering ──
    it('should return artifacts in creation order (oldest first)', () => {
      const ctx = createContext();
      const hash = 'artifact-order';

      const { hypothesis, evaluation } = setupCompletedEvaluation(ctx, hash);

      // Add a third artifact with a later timestamp
      ctx.hypothesisRepo.insertResearchArtifact({
        hypothesisEvaluationId: evaluation.id,
        artifactType: ResearchArtifactType.Summary,
        format: 'markdown',
        filePath: '/tmp/summary.md',
        label: 'Summary',
        createdAt: Date.now() + 5000,
      });

      const snapshot = ctx.auditService.assembleLineage(hash);

      expect(snapshot.artifacts).not.toBeNull();
      expect(snapshot.artifacts!.length).toBe(3);
      // First two should be PromotionArtifact and Diagnostics (from setup)
      expect(snapshot.artifacts![0].artifactType).toBe(ResearchArtifactType.PromotionArtifact);
      expect(snapshot.artifacts![2].artifactType).toBe(ResearchArtifactType.Summary);
    });

    // ── Zero artifacts ──
    it('should return empty artifacts array when evaluation has no artifacts', () => {
      const ctx = createContext();
      const hash = 'no-artifacts';

      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo, hash);
      const now = Date.now();

      ctx.hypothesisRepo.insertEvaluation({
        hypothesisGraphId: hypothesis.id,
        status: HypothesisEvaluationStatus.Completed,
        winnerId: null,
        rationale: 'No artifacts.',
        outcomeDetail: 'No artifacts generated.',
        createdAt: now,
      });

      const snapshot = ctx.auditService.assembleLineage(hash);

      expect(snapshot.evaluation).not.toBeNull();
      expect(snapshot.artifacts).not.toBeNull();
      expect(snapshot.artifacts!.length).toBe(0);
    });

    // ── Hypothesis without evaluation ──
    it('should return hypothesis-only snapshot when no evaluation exists', () => {
      const ctx = createContext();
      const hash = 'hypothesis-only';

      const hypothesis = insertValidHypothesis(ctx.hypothesisRepo, hash);

      const snapshot = ctx.auditService.assembleLineage(hash);

      expect(snapshot.hypothesis).not.toBeNull();
      expect(snapshot.hypothesis!.id).toBe(hypothesis.id);
      expect(snapshot.evaluation).toBeNull();
      expect(snapshot.artifacts).toBeNull();
      expect(snapshot.publicationEvidence).toBeNull();
    });

    // ── Multiple governance decisions in published lineage ──
    it('should include all governance decisions in descending order (newest first)', () => {
      const ctx = createContext();
      const hash = 'multi-gov';

      const { hypothesis, evaluation } = setupCompletedEvaluation(ctx, hash);

      const now = Date.now();
      const strategyId = `research-hypothesis-${hypothesis.id}`;

      // Insert lifecycle state
      const state = ctx.lifecycleRepo.upsertCurrentState({
        strategyId,
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
        phase: StrategyLifecyclePhase.Backtest,
        updatedAt: now,
      });

      // Insert 3 governance decisions with different timestamps
      const d1 = ctx.lifecycleRepo.insertDecision({
        strategyId,
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
        verdict: GovernanceVerdict.Promote,
        previousPhase: StrategyLifecyclePhase.Backtest,
        newPhase: StrategyLifecyclePhase.Paper,
        rationale: 'First promotion.',
        evidenceJson: '{}',
        winnerId: null,
        recordedAt: now,
      });

      const d2 = ctx.lifecycleRepo.insertDecision({
        strategyId,
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
        verdict: GovernanceVerdict.Hold,
        previousPhase: StrategyLifecyclePhase.Paper,
        newPhase: StrategyLifecyclePhase.Paper,
        rationale: 'Hold for additional evidence.',
        evidenceJson: '{}',
        winnerId: null,
        recordedAt: now + 2000,
      });

      const d3 = ctx.lifecycleRepo.insertDecision({
        strategyId,
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
        verdict: GovernanceVerdict.Promote,
        previousPhase: StrategyLifecyclePhase.Paper,
        newPhase: StrategyLifecyclePhase.Live,
        rationale: 'Second promotion.',
        evidenceJson: '{}',
        winnerId: null,
        recordedAt: now + 5000,
      });

      // Create publication
      ctx.hypothesisRepo.insertPublication({
        hypothesisEvaluationId: evaluation.id,
        hypothesisGraphId: hypothesis.id,
        status: ResearchPublicationStatus.Published,
        strategyId,
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
        rationale: 'Published.',
        evidenceJson: '{}',
        lifecycleStateId: state.id,
        governanceDecisionId: d1.id,
        publishedAt: now,
        createdAt: now,
      });

      const snapshot = ctx.auditService.assembleLineage(hash);

      expect(snapshot.publicationEvidence).not.toBeNull();
      // Should be 3 decisions (the repo defaults limit is 10, we have 3)
      expect(snapshot.publicationEvidence!.governanceDecisions.length).toBe(3);

      // Newest first
      expect(snapshot.publicationEvidence!.governanceDecisions[0].id).toBe(d3.id);
      expect(snapshot.publicationEvidence!.governanceDecisions[0].rationale).toBe('Second promotion.');
      expect(snapshot.publicationEvidence!.governanceDecisions[0].verdict).toBe(GovernanceVerdict.Promote);

      expect(snapshot.publicationEvidence!.governanceDecisions[1].id).toBe(d2.id);
      expect(snapshot.publicationEvidence!.governanceDecisions[1].rationale).toBe('Hold for additional evidence.');
      expect(snapshot.publicationEvidence!.governanceDecisions[1].verdict).toBe(GovernanceVerdict.Hold);

      expect(snapshot.publicationEvidence!.governanceDecisions[2].id).toBe(d1.id);
      expect(snapshot.publicationEvidence!.governanceDecisions[2].rationale).toBe('First promotion.');
    });

    // ── assembledAt timestamp ──
    it('should include a valid assembledAt timestamp', () => {
      const ctx = createContext();
      const before = Date.now();
      const snapshot = ctx.auditService.assembleLineage('any-hash');
      const after = Date.now();

      expect(snapshot.assembledAt).toBeGreaterThanOrEqual(before);
      expect(snapshot.assembledAt).toBeLessThanOrEqual(after);
    });
  });
});
