import { describe, expect, it } from 'vitest';

import { canonicalizeHypothesis } from '../src/research/hypothesis-canonicalizer.js';
import { HypothesisMemoryRepository } from '../src/persistence/hypothesis-memory-repo.js';
import { HypothesisRepository } from '../src/persistence/hypothesis-repo.js';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import {
  HypothesisMemoryStatus,
  HypothesisStatus,
  HypothesisValidationReasonCode,
  type HypothesisGraph,
} from '../src/types/runtime.js';

function createRepos(): {
  hypothesisRepo: HypothesisRepository;
  memoryRepo: HypothesisMemoryRepository;
} {
  const mgr = new DatabaseManager(':memory:');
  return {
    hypothesisRepo: new HypothesisRepository(mgr.db),
    memoryRepo: new HypothesisMemoryRepository(mgr.db),
  };
}

function sampleGraph(): HypothesisGraph {
  return {
    schemaVersion: '1',
    signals: [{ type: 'ema_cross', params: { fast: 8, slow: 21 } }],
    filters: [{ type: 'volume_min', params: { min: 500000 } }],
    entryRules: [{ type: 'breakout_confirmed', params: { lookbackBars: 5 } }],
    exitRules: [{ type: 'time_stop', params: { maxBars: 12 } }],
    riskRules: [{ type: 'atr_stop', params: { period: 14, multiple: 2 } }],
    metadata: { source: 'llm' },
  };
}

describe('HypothesisMemoryRepository', () => {
  it('records and retrieves an exact failure with graph linkage', () => {
    const { hypothesisRepo, memoryRepo } = createRepos();
    const graph = sampleGraph();
    const canonical = canonicalizeHypothesis(graph);
    const hypothesis = hypothesisRepo.insertHypothesis({
      canonicalHash: canonical.canonicalHash,
      canonicalJson: canonical.canonicalJson,
      status: HypothesisStatus.FailedEvaluation,
      graph,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const entry = memoryRepo.recordFailure({
      canonicalHash: canonical.canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'Walk-forward evaluation already failed for this exact hypothesis.',
      hypothesisGraphId: hypothesis.id,
      createdAt: Date.now(),
    });

    const fetched = memoryRepo.getFailureByHash(canonical.canonicalHash);

    expect(entry.id).toBeGreaterThan(0);
    expect(fetched).not.toBeNull();
    expect(fetched?.canonicalHash).toBe(canonical.canonicalHash);
    expect(fetched?.status).toBe(HypothesisMemoryStatus.Failed);
    expect(fetched?.hypothesisGraphId).toBe(hypothesis.id);
    expect(memoryRepo.count()).toBe(1);
  });

  it('is idempotent for duplicate canonical hashes and preserves the original entry', () => {
    const { memoryRepo } = createRepos();
    const canonicalHash = canonicalizeHypothesis(sampleGraph()).canonicalHash;
    const createdAt = Date.now();

    const first = memoryRepo.recordFailure({
      canonicalHash,
      status: HypothesisMemoryStatus.Rejected,
      reasonCode: HypothesisValidationReasonCode.ExactRejectedMatch,
      reasonMessage: 'Original rejection reason.',
      hypothesisGraphId: null,
      createdAt,
    });

    const second = memoryRepo.recordFailure({
      canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'This should be ignored because the hash already exists.',
      hypothesisGraphId: 999,
      createdAt: createdAt + 10_000,
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe(HypothesisMemoryStatus.Rejected);
    expect(second.reasonCode).toBe(HypothesisValidationReasonCode.ExactRejectedMatch);
    expect(second.reasonMessage).toBe('Original rejection reason.');
    expect(second.hypothesisGraphId).toBeNull();
    expect(second.createdAt).toBe(createdAt);
    expect(memoryRepo.count()).toBe(1);
  });

  it('returns a structured miss when the canonical hash has never been seen', () => {
    const { memoryRepo } = createRepos();

    const result = memoryRepo.hasExactFailure('missing-hash');

    expect(result.found).toBe(false);
    expect(result.entry).toBeNull();
  });

  it('returns a structured hit when the canonical hash exists', () => {
    const { memoryRepo } = createRepos();
    const canonicalHash = canonicalizeHypothesis(sampleGraph()).canonicalHash;

    memoryRepo.recordFailure({
      canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'Already failed during prior evaluation.',
      hypothesisGraphId: null,
      createdAt: Date.now(),
    });

    const result = memoryRepo.hasExactFailure(canonicalHash);

    expect(result.found).toBe(true);
    expect(result.entry?.reasonMessage).toBe('Already failed during prior evaluation.');
    expect(result.entry?.status).toBe(HypothesisMemoryStatus.Failed);
  });
});
