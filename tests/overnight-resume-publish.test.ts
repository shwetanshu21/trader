import { describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { MarketClock } from '../src/runtime/market-clock.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';
import { OvernightRunRepo, OvernightRunStatus, parseOvernightRunMetadata } from '../src/research/overnight-run-repo.js';
import { OvernightOrchestrator } from '../src/research/overnight-orchestrator.js';

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
  it('resumes the same overnight run after a partial generate checkpoint and records resume metadata', () => {
    const dbm = new DatabaseManager(':memory:');
    const repo = new OvernightRunRepo(dbm.db);
    const orchestrator = new OvernightOrchestrator(repo, new MarketClock(INDIA_NSE_EQ_MARKET));

    const first = orchestrator.tryStartOrResume({
      label: 'resume-run',
      workspacePath: '/tmp/research-ws',
      researchDbPath: '/tmp/research.db',
      now: CLOSED_AFTER,
    });

    expect(first.accepted).toBe(true);
    expect(first.resumed).toBe(false);
    expect(repo.countRuns()).toBe(1);

    orchestrator.markPhase(first.run.id, 'generate');
    orchestrator.saveCheckpoint(first.run.id, {
      phase: 'generate',
      completedItems: 2,
      totalItems: 5,
      lastProcessedId: 'gen-hyp-2',
    });
    orchestrator.markFailed(first.run.id, 'Interrupted after partial generation');

    const rerun = orchestrator.tryStartOrResume({
      label: 'resume-run',
      workspacePath: '/tmp/research-ws',
      researchDbPath: '/tmp/research.db',
      now: CLOSED_AFTER,
    });

    expect(rerun.accepted).toBe(true);
    expect(rerun.resumed).toBe(true);
    expect(rerun.run.id).toBe(first.run.id);
    expect(repo.countRuns()).toBe(1);

    const persisted = repo.getRun(first.run.id)!;
    expect(persisted.status).toBe(OvernightRunStatus.Running);
    expect(orchestrator.getNextPhase(persisted)).toBe('generate');

    const checkpoint = orchestrator.readCheckpoint(persisted);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.phase).toBe('generate');
    expect(checkpoint!.completedItems).toBe(2);

    const metadata = parseOvernightRunMetadata(persisted.metadataJson);
    expect(metadata.resumeAttempts).toHaveLength(1);
    expect(metadata.resumeAttempts[0].fromPhase).toBe('generate');
    expect(metadata.resumeAttempts[0].checkpointPhase).toBe('generate');
    expect(metadata.failureContext).not.toBeNull();
    expect(metadata.failureContext!.message).toContain('Interrupted');

    orchestrator.markPhase(first.run.id, 'generate');
    orchestrator.saveCheckpoint(first.run.id, {
      phase: 'generate',
      completedItems: 5,
      totalItems: 5,
      lastProcessedId: 'gen-hyp-5',
    });
    orchestrator.markPhaseCompleted(first.run.id, 'generate');

    const afterGenerate = repo.getRun(first.run.id)!;
    expect(orchestrator.getNextPhase(afterGenerate)).toBe('evaluate');

    dbm.close();
  });
});
