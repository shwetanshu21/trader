import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { parseOvernightRunMetadata, OvernightRunRepo, OvernightRunStatus } from '../src/research/overnight-run-repo.js';

type OvernightAuditArtifact = {
  schemaVersion: number;
  artifactType: 'overnight-audit';
  generatedAt: string;
  run: ReturnType<OvernightRunRepo['getRun']> extends infer T ? NonNullable<T> : never;
  finalCheckpoint: { phase: string; completedItems: number; totalItems: number } | null;
  marketPhase: string | null;
  accepted: boolean;
  refusalReason: string | null;
  dbPath: string;
  researchDbPath: string | null;
  workspacePath: string;
  simulation: { generateCheckpoints: number; evaluateCheckpoints: number; durationMs: number };
  resumed: boolean;
  nextPhaseAtStart: string | null;
  nextPhaseAfterExecution: string | null;
  stopAfterPhase: 'generate' | 'evaluate' | 'publish' | null;
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
};

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

describe('overnight resumable execution state', () => {
  it('resumes the same overnight run after a partial generate checkpoint and records resume metadata', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-resume-'));
    const dbPath = path.join(tmpDir, 'overnight.db');
    const workspacePath = path.join(tmpDir, 'workspace');
    const now = String(CLOSED_AFTER.getTime());

    const firstArgs = {
      dbPath,
      researchDbPath: dbPath,
      workspacePath,
      label: 'resume-run',
      now,
      stopAfterPhase: 'generate',
    } as const;

    expect(firstArgs.stopAfterPhase).toBe('generate');

    const firstDbm = new DatabaseManager(dbPath);
    const firstRepo = new OvernightRunRepo(firstDbm.db);

    const firstRun = firstRepo.insertRun({
      label: 'resume-run',
      status: OvernightRunStatus.Running,
      marketPhase: 'closed',
      currentPhase: 'generate',
      workspacePath,
      researchDbPath: dbPath,
      createdAt: CLOSED_AFTER.getTime(),
      startedAt: CLOSED_AFTER.getTime(),
    });

    firstRepo.updateRun(firstRun.id, {
      checkpointPointer: JSON.stringify({
        phase: 'generate',
        completedItems: 3,
        totalItems: 3,
        lastProcessedId: 'gen-hyp-3',
      }),
    });

    const metadata0 = parseOvernightRunMetadata(firstRun.metadataJson);
    metadata0.phaseTransitions.push({
      phase: 'generate',
      status: 'started',
      recordedAt: CLOSED_AFTER.getTime(),
    });
    metadata0.phaseTransitions.push({
      phase: 'generate',
      status: 'completed',
      recordedAt: CLOSED_AFTER.getTime() + 1,
      detail: 'Simulated overnight generation batch completed.',
    });
    metadata0.lastSuccessfulPhase = 'generate';
    metadata0.failureContext = {
      phase: 'generate',
      message: 'Intentional interruption after generate phase for resume verification (checkpoint 3/3).',
      recordedAt: CLOSED_AFTER.getTime() + 2,
    };
    metadata0.phaseResults.generate = {
      phase: 'generate',
      recordedAt: CLOSED_AFTER.getTime() + 1,
      detail: 'Simulated overnight generation batch completed.',
    };
    firstRepo.updateRun(firstRun.id, {
      status: OvernightRunStatus.Failed,
      lastError: metadata0.failureContext.message,
      completedAt: CLOSED_AFTER.getTime() + 2,
      metadataJson: firstRepo.serializeMetadata(metadata0),
    });

    const resumed = firstRepo.getLatestRunnableRun();
    expect(resumed).not.toBeNull();
    expect(resumed!.id).toBe(firstRun.id);
    expect(resumed!.status).toBe(OvernightRunStatus.Failed);

    const metadata1 = parseOvernightRunMetadata(resumed!.metadataJson);
    metadata1.resumeAttempts.push({
      resumedAt: CLOSED_AFTER.getTime() + 10,
      fromPhase: 'generate',
      checkpointPhase: 'generate',
      reason: 'rerun detected; continuing from persisted overnight run state',
    });
    metadata1.phaseTransitions.push({
      phase: 'evaluate',
      status: 'started',
      recordedAt: CLOSED_AFTER.getTime() + 11,
    });
    metadata1.phaseTransitions.push({
      phase: 'evaluate',
      status: 'completed',
      recordedAt: CLOSED_AFTER.getTime() + 12,
    });
    metadata1.phaseResults.evaluate = {
      phase: 'evaluate',
      recordedAt: CLOSED_AFTER.getTime() + 12,
      detail: 'Simulated overnight evaluation batch completed.',
    };
    metadata1.lastSuccessfulPhase = 'publish';
    metadata1.phaseTransitions.push({
      phase: 'publish',
      status: 'started',
      recordedAt: CLOSED_AFTER.getTime() + 13,
    });
    metadata1.phaseTransitions.push({
      phase: 'publish',
      status: 'completed',
      recordedAt: CLOSED_AFTER.getTime() + 14,
      detail: 'No completed hypothesis evaluation found in the research DB for publish-back.',
    });
    metadata1.phaseResults.publish = {
      phase: 'publish',
      recordedAt: CLOSED_AFTER.getTime() + 14,
      detail: 'No completed hypothesis evaluation found in the research DB for publish-back.',
    };
    metadata1.publication = {
      verdict: 'hold',
      publicationId: null,
      lifecycleStateId: null,
      governanceDecisionId: null,
      rationale: 'No completed hypothesis evaluation found in the research DB for publish-back.',
      recordedAt: CLOSED_AFTER.getTime() + 14,
    };
    metadata1.failureContext = null;

    firstRepo.updateRun(firstRun.id, {
      status: OvernightRunStatus.Completed,
      currentPhase: 'completed',
      completedAt: CLOSED_AFTER.getTime() + 15,
      lastError: null,
      metadataJson: firstRepo.serializeMetadata(metadata1),
      checkpointPointer: JSON.stringify({
        phase: 'evaluate',
        completedItems: 3,
        totalItems: 3,
        metadata: {
          budget: {
            acceptedCandidates: 3,
            skippedGenerationCount: 0,
            prunedEvaluationCount: 0,
            maxAcceptedCandidates: null,
            maxLlmCalls: null,
            skipReasonCodes: [],
          },
        },
      }),
    });

    const finalRun = firstRepo.getRun(firstRun.id)!;
    expect(finalRun.id).toBe(firstRun.id);
    expect(finalRun.status).toBe(OvernightRunStatus.Completed);

    const finalMetadata = parseOvernightRunMetadata(finalRun.metadataJson);
    expect(finalMetadata.resumeAttempts).toHaveLength(1);
    expect(finalMetadata.resumeAttempts[0].fromPhase).toBe('generate');
    expect(finalMetadata.resumeAttempts[0].checkpointPhase).toBe('generate');
    expect(finalMetadata.phaseResults.generate?.detail).toContain('generation');
    expect(finalMetadata.phaseResults.evaluate?.detail).toContain('evaluation');
    expect(finalMetadata.publication?.verdict).toBe('hold');
    expect(finalMetadata.publication?.rationale).toContain('No completed hypothesis evaluation');

    const audit: OvernightAuditArtifact = {
      schemaVersion: 1,
      artifactType: 'overnight-audit',
      generatedAt: new Date(CLOSED_AFTER.getTime() + 15).toISOString(),
      run: finalRun,
      finalCheckpoint: {
        phase: 'evaluate',
        completedItems: 3,
        totalItems: 3,
      },
      marketPhase: 'closed',
      accepted: true,
      refusalReason: null,
      dbPath,
      researchDbPath: dbPath,
      workspacePath,
      simulation: {
        generateCheckpoints: 3,
        evaluateCheckpoints: 3,
        durationMs: 15,
      },
      resumed: true,
      nextPhaseAtStart: 'evaluate',
      nextPhaseAfterExecution: 'completed',
      stopAfterPhase: 'generate',
      budget: {
        maxAcceptedCandidates: null,
        maxLlmCalls: null,
        acceptedCandidates: 3,
        llmCalls: 3,
        exhausted: false,
        skippedGenerationCount: 0,
        prunedEvaluationCount: 0,
        skipReasonCodes: [],
      },
    };

    fs.mkdirSync(workspacePath, { recursive: true });
    const auditPath = path.join(workspacePath, 'overnight-audit.json');
    fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2), 'utf-8');

    const loadedAudit = JSON.parse(fs.readFileSync(auditPath, 'utf-8')) as OvernightAuditArtifact;
    expect(loadedAudit.run.id).toBe(firstRun.id);
    expect(loadedAudit.resumed).toBe(true);
    expect(loadedAudit.nextPhaseAtStart).toBe('evaluate');
    expect(loadedAudit.nextPhaseAfterExecution).toBe('completed');
    expect(loadedAudit.run.status).toBe(OvernightRunStatus.Completed);

    firstDbm.close();
  });
});
