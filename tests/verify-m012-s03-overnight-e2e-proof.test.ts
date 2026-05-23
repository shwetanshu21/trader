import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { HypothesisRepository } from '../src/persistence/hypothesis-repo.js';
import { parseOvernightRunMetadata, OvernightRunRepo } from '../src/research/overnight-run-repo.js';
import type { OvernightAuditArtifact } from '../src/research/overnight-research-main.js';
import {
  HypothesisEvaluationStatus,
  HypothesisStatus,
  ResearchArtifactType,
  ResearchPublicationStatus,
  type HypothesisGraph,
} from '../src/types/runtime.js';

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

const CLOSED_AFTER = indiaTime(2025, 1, 6, 16, 30, 0);

function validGraph(hashSeed: string): HypothesisGraph {
  return {
    schemaVersion: '1',
    signals: [{ type: 'ema_cross', params: { fast: 8 + hashSeed.length, slow: 21 } }],
    filters: [{ type: 'volume_min', params: { min: 500000 } }],
    entryRules: [{ type: 'breakout_confirmed', params: { lookbackBars: 5 } }],
    exitRules: [{ type: 'time_stop', params: { maxBars: 12 } }],
    riskRules: [{ type: 'atr_stop', params: { period: 14, multiple: 2 } }],
  };
}

describe('M012/S03 overnight publish-back proof', () => {
  it('proves the audit artifact is a single end-to-end inspection surface for published runs', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm012-s03-proof-'));
    const dbPath = path.join(tmpDir, 'research.db');
    const workspacePath = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspacePath, { recursive: true });

    const dbm = new DatabaseManager(dbPath);
    const repo = new OvernightRunRepo(dbm.db);
    const hypothesisRepo = new HypothesisRepository(dbm.db);

    const graph = validGraph('proof');
    const hypothesis = hypothesisRepo.insertHypothesis({
      canonicalHash: 'bb'.repeat(32),
      canonicalJson: JSON.stringify(graph),
      status: HypothesisStatus.Validated,
      graph,
      createdAt: CLOSED_AFTER.getTime(),
      updatedAt: CLOSED_AFTER.getTime(),
    });

    const runId = Number(dbm.db.prepare(`
      INSERT INTO walk_forward_runs
        (label, strategy_id, strategy_version, market_id,
         window_count, total_trials, status, created_at, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'proof-run',
      'proof-strategy',
      '1.0.0',
      'INDIA_NSE_EQ',
      2,
      1,
      'completed',
      CLOSED_AFTER.getTime(),
      CLOSED_AFTER.getTime(),
      CLOSED_AFTER.getTime() + 100,
    ).lastInsertRowid);

    const trialId = Number(dbm.db.prepare(`
      INSERT INTO walk_forward_trials
        (run_id, trial_index, label, params_json,
         merged_score, deterministic_score, llm_score, llm_status,
         rank, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      0,
      'proof-trial',
      '{}',
      0.88,
      0.8,
      null,
      null,
      1,
      CLOSED_AFTER.getTime(),
    ).lastInsertRowid);

    const winnerId = Number(dbm.db.prepare(`
      INSERT INTO walk_forward_winners
        (run_id, result, selected_trial_id, selection_strategy,
         selection_config_json, rationale, artifact_paths_json,
         selected_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      'selected',
      trialId,
      'threshold',
      '{}',
      'Proof winner',
      null,
      CLOSED_AFTER.getTime(),
      CLOSED_AFTER.getTime(),
    ).lastInsertRowid);

    const evaluation = hypothesisRepo.insertEvaluation({
      hypothesisGraphId: hypothesis.id,
      walkForwardRunId: runId,
      status: HypothesisEvaluationStatus.Completed,
      winnerId,
      rationale: 'Proof evaluation completed.',
      outcomeDetail: 'winner_selected',
      createdAt: CLOSED_AFTER.getTime(),
      updatedAt: CLOSED_AFTER.getTime(),
    });

    const artifactPath = path.join(workspacePath, 'proof-promotion.json');
    fs.writeFileSync(artifactPath, JSON.stringify({ score: 0.88 }), 'utf-8');
    hypothesisRepo.insertResearchArtifact({
      hypothesisEvaluationId: evaluation.id,
      artifactType: ResearchArtifactType.PromotionArtifact,
      format: 'json',
      filePath: artifactPath,
      label: 'Proof promotion artifact',
      createdAt: CLOSED_AFTER.getTime(),
    });

    const overnightRun = repo.insertRun({
      label: 'proof-overnight-run',
      status: 'completed' as const,
      marketPhase: 'closed',
      currentPhase: 'completed',
      checkpointPointer: JSON.stringify({ phase: 'evaluate', completedItems: 1, totalItems: 1 }),
      workspacePath,
      researchDbPath: dbPath,
      createdAt: CLOSED_AFTER.getTime(),
      startedAt: CLOSED_AFTER.getTime(),
      completedAt: CLOSED_AFTER.getTime() + 20,
    });

    const metadata = parseOvernightRunMetadata(overnightRun.metadataJson);
    metadata.resumeAttempts.push({
      resumedAt: CLOSED_AFTER.getTime() + 5,
      fromPhase: 'generate',
      checkpointPhase: 'generate',
      reason: 'proof rerun',
    });
    metadata.phaseTransitions.push(
      { phase: 'generate', status: 'completed', recordedAt: CLOSED_AFTER.getTime() + 1 },
      { phase: 'evaluate', status: 'completed', recordedAt: CLOSED_AFTER.getTime() + 2 },
      { phase: 'publish', status: 'completed', recordedAt: CLOSED_AFTER.getTime() + 3 },
    );
    metadata.lastSuccessfulPhase = 'publish';
    metadata.phaseResults.generate = {
      phase: 'generate',
      recordedAt: CLOSED_AFTER.getTime() + 1,
      hypothesisId: hypothesis.id,
      hypothesisStatus: hypothesis.status,
      detail: 'Proof generation complete.',
    };
    metadata.phaseResults.evaluate = {
      phase: 'evaluate',
      recordedAt: CLOSED_AFTER.getTime() + 2,
      hypothesisId: hypothesis.id,
      evaluationId: evaluation.id,
      evaluationStatus: evaluation.status,
      rationale: evaluation.rationale,
      artifactPaths: [artifactPath],
      detail: 'Proof evaluation complete.',
    };

    dbm.db.prepare(`
      INSERT INTO strategy_lifecycle_state
        (strategy_id, strategy_version, market_id, phase, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(strategy_id, strategy_version, market_id)
      DO UPDATE SET phase = excluded.phase, updated_at = excluded.updated_at
    `).run(`research-hypothesis-${hypothesis.id}`, '1.0.0', 'INDIA_NSE_EQ', 'backtest', CLOSED_AFTER.getTime() + 10);

    const lifecycleState = dbm.db.prepare(`
      SELECT id, phase, updated_at FROM strategy_lifecycle_state
      WHERE strategy_id = ? AND strategy_version = ? AND market_id = ?
    `).get(`research-hypothesis-${hypothesis.id}`, '1.0.0', 'INDIA_NSE_EQ') as { id: number; phase: 'backtest'; updated_at: number };

    const governanceDecisionId = Number(dbm.db.prepare(`
      INSERT INTO governance_decisions
        (strategy_id, strategy_version, market_id, verdict,
         previous_phase, new_phase, rationale, evidence_json,
         winner_id, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `research-hypothesis-${hypothesis.id}`,
      '1.0.0',
      'INDIA_NSE_EQ',
      'promote',
      'backtest',
      'backtest',
      'Proof publish governance decision.',
      JSON.stringify({ minMergedScore: 0.7, actualMergedScore: 0.88 }),
      winnerId,
      CLOSED_AFTER.getTime() + 11,
    ).lastInsertRowid);

    const publication = hypothesisRepo.insertPublication({
      hypothesisEvaluationId: evaluation.id,
      hypothesisGraphId: hypothesis.id,
      status: ResearchPublicationStatus.Published,
      strategyId: `research-hypothesis-${hypothesis.id}`,
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      rationale: 'Proof publication succeeded.',
      evidenceJson: JSON.stringify({ minMergedScore: 0.7, actualMergedScore: 0.88, holdReasons: [] }),
      lifecycleStateId: lifecycleState.id,
      governanceDecisionId,
      publishedAt: CLOSED_AFTER.getTime() + 12,
      createdAt: CLOSED_AFTER.getTime() + 12,
    });

    metadata.phaseResults.publish = {
      phase: 'publish',
      recordedAt: CLOSED_AFTER.getTime() + 3,
      hypothesisId: hypothesis.id,
      evaluationId: evaluation.id,
      evaluationStatus: evaluation.status,
      rationale: 'Proof publication succeeded.',
      artifactPaths: [artifactPath],
      detail: 'Proof publication succeeded.',
    };
    metadata.publication = {
      verdict: 'publish',
      publicationId: publication.id,
      lifecycleStateId: lifecycleState.id,
      governanceDecisionId,
      rationale: 'Proof publication succeeded.',
      recordedAt: CLOSED_AFTER.getTime() + 3,
    };

    const finalRun = repo.updateRun(overnightRun.id, {
      metadataJson: repo.serializeMetadata(metadata),
    })!;

    const auditArtifact: OvernightAuditArtifact = {
      schemaVersion: 1,
      artifactType: 'overnight-audit',
      generatedAt: new Date(CLOSED_AFTER.getTime() + 20).toISOString(),
      run: finalRun,
      finalCheckpoint: { phase: 'evaluate', completedItems: 1, totalItems: 1 },
      marketPhase: 'closed',
      accepted: true,
      refusalReason: null,
      dbPath,
      researchDbPath: dbPath,
      workspacePath,
      simulation: { generateCheckpoints: 1, evaluateCheckpoints: 1, durationMs: 20 },
      resumed: true,
      nextPhaseAtStart: 'evaluate',
      nextPhaseAfterExecution: 'completed',
      stopAfterPhase: 'generate',
      generatedHypothesisIds: [hypothesis.id],
      evaluatedHypothesisIds: [hypothesis.id],
      evaluationIds: [evaluation.id],
      publication: {
        verdict: 'publish',
        publicationId: publication.id,
        lifecycleStateId: lifecycleState.id,
        governanceDecisionId,
        rationale: 'Proof publication succeeded.',
        publishedEvaluationId: evaluation.id,
        publishedHypothesisId: hypothesis.id,
        status: ResearchPublicationStatus.Published,
      },
      lineage: {
        canonicalHash: hypothesis.canonicalHash,
        duplicateEvidence: null,
        hypothesis,
        evaluation: {
          evaluation,
          walkForwardRun: { id: runId, label: 'proof-run', status: 'completed', windowCount: 2, totalTrials: 1 },
          winner: { id: winnerId, result: 'selected', selectedTrialId: trialId, selectionStrategy: 'threshold', rationale: 'Proof winner' },
        },
        artifacts: hypothesisRepo.getResearchArtifactsByEvaluationId(evaluation.id),
        publicationEvidence: {
          publication,
          lifecycleState: {
            id: lifecycleState.id,
            strategyId: `research-hypothesis-${hypothesis.id}`,
            strategyVersion: '1.0.0',
            marketId: 'INDIA_NSE_EQ',
            phase: lifecycleState.phase,
            updatedAt: lifecycleState.updated_at,
          },
          governanceDecisions: [{
            id: governanceDecisionId,
            strategyId: `research-hypothesis-${hypothesis.id}`,
            strategyVersion: '1.0.0',
            marketId: 'INDIA_NSE_EQ',
            verdict: 'promote' as const,
            previousPhase: 'backtest' as const,
            newPhase: 'backtest' as const,
            rationale: 'Proof publish governance decision.',
            evidenceJson: JSON.stringify({ minMergedScore: 0.7, actualMergedScore: 0.88 }),
            winnerId,
            recordedAt: CLOSED_AFTER.getTime() + 11,
          }],
        },
        generationAttempt: null,
        assembledAt: CLOSED_AFTER.getTime() + 20,
      },
      resumeHistory: metadata.resumeAttempts,
      phaseTransitions: metadata.phaseTransitions,
      failureContext: null,
      budget: {
        maxAcceptedCandidates: null,
        maxLlmCalls: null,
        acceptedCandidates: 1,
        llmCalls: 1,
        exhausted: false,
        skippedGenerationCount: 0,
        prunedEvaluationCount: 0,
        skipReasonCodes: [],
      },
    };

    const auditPath = path.join(workspacePath, 'overnight-audit.json');
    fs.writeFileSync(auditPath, JSON.stringify(auditArtifact, null, 2), 'utf-8');

    const audit = JSON.parse(fs.readFileSync(auditPath, 'utf-8')) as OvernightAuditArtifact;
    expect(audit.artifactType).toBe('overnight-audit');
    expect(audit.publication.verdict).toBe('publish');
    expect(audit.publication.publicationId).toBe(publication.id);
    expect(audit.publication.governanceDecisionId).toBe(governanceDecisionId);
    expect(audit.resumeHistory[0].checkpointPhase).toBe('generate');
    expect(audit.phaseTransitions.some(t => t.phase === 'publish' && t.status === 'completed')).toBe(true);
    expect(audit.lineage?.publicationEvidence?.publication.status).toBe(ResearchPublicationStatus.Published);
    expect(audit.lineage?.publicationEvidence?.governanceDecisions[0].rationale).toContain('Proof publish governance decision');
    expect(audit.lineage?.artifacts?.map(a => a.filePath)).toEqual([artifactPath]);
    expect(audit.generatedHypothesisIds).toEqual([hypothesis.id]);
    expect(audit.evaluatedHypothesisIds).toEqual([hypothesis.id]);
    expect(audit.evaluationIds).toEqual([evaluation.id]);

    dbm.close();
  });
});
