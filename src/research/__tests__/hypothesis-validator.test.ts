import { describe, expect, it } from 'vitest';

import { canonicalizeHypothesis } from '../hypothesis-canonicalizer.js';
import { HypothesisValidator, type ValidatorResult } from '../hypothesis-validator.js';
import { HypothesisMemoryRepository } from '../../persistence/hypothesis-memory-repo.js';
import { HypothesisRepository } from '../../persistence/hypothesis-repo.js';
import { DatabaseManager } from '../../persistence/sqlite.js';
import {
  HypothesisStatus,
  HypothesisMemoryStatus,
  HypothesisValidationReasonCode,
  type HypothesisGraph,
} from '../../types/runtime.js';

// ---------------------------------------------------------------------------
// Sample graphs
// ---------------------------------------------------------------------------

function validGraph(overrides?: Partial<HypothesisGraph>): HypothesisGraph {
  return {
    schemaVersion: '1',
    signals: [{ type: 'ema_cross', params: { fast: 8, slow: 21 } }],
    filters: [{ type: 'volume_min', params: { min: 500000 } }],
    entryRules: [{ type: 'breakout_confirmed', params: { lookbackBars: 5 } }],
    exitRules: [{ type: 'time_stop', params: { maxBars: 12 } }],
    riskRules: [{ type: 'atr_stop', params: { period: 14, multiple: 2 } }],
    metadata: { source: 'llm' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function unwrap(result: ValidatorResult): { kind: string; status: HypothesisStatus } {
  return { kind: result.kind, status: result.status };
}

// ---------------------------------------------------------------------------
// Tests — validateStructure (pure structural validation)
// ---------------------------------------------------------------------------

describe('HypothesisValidator.validateStructure', () => {
  it('returns validated for a fully valid hypothesis graph', () => {
    const validator = new HypothesisValidator();
    const result = validator.validateStructure(validGraph());

    expect(result.status).toBe(HypothesisStatus.Validated);
    expect(result.canonical).toBeDefined();
    expect(result.canonical?.canonicalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.reasons).toHaveLength(0);
  });

  it('rejects when schema version is missing', () => {
    const validator = new HypothesisValidator();
    const result = validator.validateStructure(
      validGraph({ schemaVersion: '' } as HypothesisGraph),
    );

    expect(result.status).toBe(HypothesisStatus.Rejected);
    expect(result.canonical).toBeUndefined();
    expect(result.reasons.length).toBeGreaterThanOrEqual(1);
    expect(result.reasons[0]?.reasonCode).toBe(
      HypothesisValidationReasonCode.UnsupportedSchemaVersion,
    );
  });

  it('rejects when schema version is not a string', () => {
    const validator = new HypothesisValidator();
    // Trick TypeScript with unknown cast
    const result = validator.validateStructure(
      validGraph({ schemaVersion: undefined as unknown as string }),
    );

    expect(result.status).toBe(HypothesisStatus.Rejected);
    expect(result.reasons.some(
      r => r.reasonCode === HypothesisValidationReasonCode.UnsupportedSchemaVersion,
    )).toBe(true);
  });

  it('rejects when a required rule group is missing', () => {
    const validator = new HypothesisValidator();
    const { signals, filters, entryRules, exitRules, riskRules, ...rest } = validGraph();
    const result = validator.validateStructure(
      { ...rest } as unknown as HypothesisGraph,
    );

    expect(result.status).toBe(HypothesisStatus.Rejected);
    expect(result.canonical).toBeUndefined();
    // All 5 groups would be missing (treated as undefined which is not an array)
    expect(result.reasons.length).toBeGreaterThanOrEqual(5);
    expect(result.reasons.every(
      r => r.reasonCode === HypothesisValidationReasonCode.MissingRuleGroup,
    )).toBe(true);
  });

  it('rejects when a rule group is present but empty', () => {
    const validator = new HypothesisValidator();
    const result = validator.validateStructure(
      validGraph({ filters: [] }),
    );

    expect(result.status).toBe(HypothesisStatus.Rejected);
    expect(result.canonical).toBeUndefined();
    expect(result.reasons.some(
      r => r.reasonCode === HypothesisValidationReasonCode.EmptyRuleGroup,
    )).toBe(true);
  });

  it('rejects when a rule group is not an array', () => {
    const validator = new HypothesisValidator();
    const result = validator.validateStructure(
      validGraph({ signals: 'not-an-array' as unknown as HypothesisGraph['signals'] }),
    );

    expect(result.status).toBe(HypothesisStatus.Rejected);
    expect(result.reasons.some(
      r => r.reasonCode === HypothesisValidationReasonCode.MissingRuleGroup,
    )).toBe(true);
  });

  it('rejects when a rule node is missing its type discriminator', () => {
    const validator = new HypothesisValidator();
    const result = validator.validateStructure(
      validGraph({
        entryRules: [{ params: { lookbackBars: 5 } }] as unknown as HypothesisGraph['entryRules'],
      }),
    );

    expect(result.status).toBe(HypothesisStatus.Rejected);
    expect(result.reasons.some(
      r => r.reasonCode === HypothesisValidationReasonCode.MissingRuleType,
    )).toBe(true);
  });

  it('rejects when a rule node has invalid params (null)', () => {
    const validator = new HypothesisValidator();
    const result = validator.validateStructure(
      validGraph({
        riskRules: [{ type: 'atr_stop', params: null as unknown as Record<string, unknown> }],
      }),
    );

    expect(result.status).toBe(HypothesisStatus.Rejected);
    expect(result.reasons.some(
      r => r.reasonCode === HypothesisValidationReasonCode.InvalidRuleParams,
    )).toBe(true);
  });

  it('rejects when a rule node has array params', () => {
    const validator = new HypothesisValidator();
    const result = validator.validateStructure(
      validGraph({
        signals: [{ type: 'ema_cross', params: [] as unknown as Record<string, unknown> }],
      }),
    );

    expect(result.status).toBe(HypothesisStatus.Rejected);
    expect(result.reasons.some(
      r => r.reasonCode === HypothesisValidationReasonCode.InvalidRuleParams,
    )).toBe(true);
  });

  it('collects multiple structural failures in order', () => {
    const validator = new HypothesisValidator();
    // Multiple issues: empty schema, empty signals, missing filters
    const broken: HypothesisGraph = {
      schemaVersion: '',
      signals: [],
      filters: [],
      entryRules: [],
      exitRules: [],
      riskRules: [],
    };

    const result = validator.validateStructure(broken);

    expect(result.status).toBe(HypothesisStatus.Rejected);
    // Should have at least: unsupported_schema_version + 5 empty groups = 6
    expect(result.reasons.length).toBeGreaterThanOrEqual(6);
    // First reason should be schema version
    expect(result.reasons[0]?.reasonCode).toBe(
      HypothesisValidationReasonCode.UnsupportedSchemaVersion,
    );
  });

  it('produces deterministic canonical identity for the same graph', () => {
    const validator = new HypothesisValidator();

    const resultA = validator.validateStructure(validGraph());
    const resultB = validator.validateStructure(validGraph());

    expect(resultA.status).toBe(HypothesisStatus.Validated);
    expect(resultB.status).toBe(HypothesisStatus.Validated);
    expect(resultA.canonical?.canonicalHash).toBe(resultB.canonical?.canonicalHash);
    expect(resultA.canonical?.canonicalJson).toBe(resultB.canonical?.canonicalJson);
  });
});

// ---------------------------------------------------------------------------
// Tests — validate (full pipeline with dedupe)
// ---------------------------------------------------------------------------

describe('HypothesisValidator.validate', () => {
  it('validates through when no memory repo is wired', () => {
    const validator = new HypothesisValidator();
    const result = validator.validate(validGraph());

    expect(result.kind).toBe('validated');
    expect(result.status).toBe(HypothesisStatus.Validated);
    if (result.kind === 'validated') {
      expect(result.canonical.canonicalHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('validates through when memory repo has no matching entry', () => {
    const { memoryRepo } = createRepos();
    const validator = new HypothesisValidator({ memoryRepo });
    const result = validator.validate(validGraph());

    expect(result.kind).toBe('validated');
    expect(result.status).toBe(HypothesisStatus.Validated);
  });

  it('skips when an exact prior failure exists in the memory ledger', () => {
    const { hypothesisRepo, memoryRepo } = createRepos();

    // First, persist a validated graph
    const graph = validGraph();
    const canonical = canonicalizeHypothesis(graph);
    const hypothesisRow = hypothesisRepo.insertHypothesis({
      canonicalHash: canonical.canonicalHash,
      canonicalJson: canonical.canonicalJson,
      status: HypothesisStatus.FailedEvaluation,
      graph,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Record the failure in memory
    memoryRepo.recordFailure({
      canonicalHash: canonical.canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'Walk-forward evaluation failed for this hypothesis.',
      hypothesisGraphId: hypothesisRow.id,
      createdAt: Date.now(),
    });

    // Now validate the same exact graph — should be skipped
    const validator = new HypothesisValidator({ memoryRepo });
    const result = validator.validate(graph);

    expect(result.kind).toBe('skipped');
    expect(result.status).toBe(HypothesisStatus.Skipped);
    if (result.kind === 'skipped') {
      expect(result.reasons).toHaveLength(1);
      expect(result.reasons[0]?.reasonCode).toBe(
        HypothesisValidationReasonCode.ExactFailureMatch,
      );
      expect(result.reasons[0]?.reasonMessage).toContain('failed');
    }
  });

  it('skips when an exact prior rejection exists in the memory ledger', () => {
    const { hypothesisRepo, memoryRepo } = createRepos();

    const graph = validGraph();
    const canonical = canonicalizeHypothesis(graph);
    const hypothesisRow = hypothesisRepo.insertHypothesis({
      canonicalHash: canonical.canonicalHash,
      canonicalJson: canonical.canonicalJson,
      status: HypothesisStatus.Rejected,
      graph,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    memoryRepo.recordFailure({
      canonicalHash: canonical.canonicalHash,
      status: HypothesisMemoryStatus.Rejected,
      reasonCode: HypothesisValidationReasonCode.ExactRejectedMatch,
      reasonMessage: 'Structural validation failed for this hypothesis.',
      hypothesisGraphId: hypothesisRow.id,
      createdAt: Date.now(),
    });

    const validator = new HypothesisValidator({ memoryRepo });
    const result = validator.validate(graph);

    expect(result.kind).toBe('skipped');
    expect(result.status).toBe(HypothesisStatus.Skipped);
    if (result.kind === 'skipped') {
      expect(result.reasons[0]?.reasonCode).toBe(
        HypothesisValidationReasonCode.ExactRejectedMatch,
      );
    }
  });

  it('returns rejected for structurally invalid graphs even with memory repo', () => {
    const { memoryRepo } = createRepos();
    const validator = new HypothesisValidator({ memoryRepo });

    const result = validator.validate(
      validGraph({ signals: [] }),
    );

    expect(result.kind).toBe('rejected');
    expect(result.status).toBe(HypothesisStatus.Rejected);
    if (result.kind === 'rejected') {
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.reasons[0]?.reasonCode).toBe(
        HypothesisValidationReasonCode.EmptyRuleGroup,
      );
    }
  });

  it('assigns correct reasonCode for failed vs rejected memory entries', () => {
    const { hypothesisRepo, memoryRepo } = createRepos();

    // Insert one failed entry and one rejected entry
    const graphA = validGraph({ metadata: { id: 'A' } });
    const graphB = validGraph({ metadata: { id: 'B' } });

    const canonicalA = canonicalizeHypothesis(graphA);
    const canonicalB = canonicalizeHypothesis(graphB);

    const rowA = hypothesisRepo.insertHypothesis({
      canonicalHash: canonicalA.canonicalHash,
      canonicalJson: canonicalA.canonicalJson,
      status: HypothesisStatus.FailedEvaluation,
      graph: graphA,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const rowB = hypothesisRepo.insertHypothesis({
      canonicalHash: canonicalB.canonicalHash,
      canonicalJson: canonicalB.canonicalJson,
      status: HypothesisStatus.Rejected,
      graph: graphB,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    memoryRepo.recordFailure({
      canonicalHash: canonicalA.canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'Failed during evaluation.',
      hypothesisGraphId: rowA.id,
      createdAt: Date.now(),
    });

    memoryRepo.recordFailure({
      canonicalHash: canonicalB.canonicalHash,
      status: HypothesisMemoryStatus.Rejected,
      reasonCode: HypothesisValidationReasonCode.ExactRejectedMatch,
      reasonMessage: 'Rejected by policy.',
      hypothesisGraphId: rowB.id,
      createdAt: Date.now(),
    });

    const validator = new HypothesisValidator({ memoryRepo });

    const resultA = validator.validate(graphA);
    const resultB = validator.validate(graphB);

    expect(resultA.kind).toBe('skipped');
    if (resultA.kind === 'skipped') {
      expect(resultA.reasons[0]?.reasonCode).toBe(
        HypothesisValidationReasonCode.ExactFailureMatch,
      );
    }

    expect(resultB.kind).toBe('skipped');
    if (resultB.kind === 'skipped') {
      expect(resultB.reasons[0]?.reasonCode).toBe(
        HypothesisValidationReasonCode.ExactRejectedMatch,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — persistResult
// ---------------------------------------------------------------------------

describe('HypothesisValidator.persistResult', () => {
  it('persists a validated graph and returns its id', () => {
    const { hypothesisRepo, memoryRepo } = createRepos();
    const validator = new HypothesisValidator({ hypothesisRepo, memoryRepo });

    const result = validator.validate(validGraph());
    expect(result.kind).toBe('validated');

    const persistedId = validator.persistResult(validGraph(), result, { now: 1000 });

    expect(persistedId).toBeGreaterThan(0);

    const fetched = hypothesisRepo.getHypothesisById(persistedId!);
    expect(fetched).not.toBeNull();
    expect(fetched?.status).toBe(HypothesisStatus.Validated);
    expect(fetched?.createdAt).toBe(1000);
  });

  it('persists a rejected graph and records a memory ledger entry', () => {
    const { hypothesisRepo, memoryRepo } = createRepos();
    const validator = new HypothesisValidator({ hypothesisRepo, memoryRepo });

    const result = validator.validate(validGraph({ signals: [] }));
    expect(result.kind).toBe('rejected');

    const persistedId = validator.persistResult(validGraph({ signals: [] }), result, { now: 2000 });

    expect(persistedId).toBeGreaterThan(0);

    const fetched = hypothesisRepo.getHypothesisById(persistedId!);
    expect(fetched).not.toBeNull();
    expect(fetched?.status).toBe(HypothesisStatus.Rejected);
    expect(fetched?.createdAt).toBe(2000);

    // Verify memory ledger entry was created
    const lookup = memoryRepo.hasExactFailure(fetched?.canonicalHash ?? '');
    expect(lookup.found).toBe(true);
    expect(lookup.entry?.status).toBe(HypothesisMemoryStatus.Rejected);
    expect(lookup.entry?.hypothesisGraphId).toBe(persistedId);
  });

  it('returns null for skipped results (no persistence needed)', () => {
    const { hypothesisRepo, memoryRepo } = createRepos();
    const validator = new HypothesisValidator({ hypothesisRepo, memoryRepo });

    // Setup: persist a failure so exact match exists
    const graph = validGraph();
    const canonical = canonicalizeHypothesis(graph);
    const row = hypothesisRepo.insertHypothesis({
      canonicalHash: canonical.canonicalHash,
      canonicalJson: canonical.canonicalJson,
      status: HypothesisStatus.FailedEvaluation,
      graph,
      createdAt: 1000,
      updatedAt: 1000,
    });

    memoryRepo.recordFailure({
      canonicalHash: canonical.canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'Already failed.',
      hypothesisGraphId: row.id,
      createdAt: 1000,
    });

    // Now validate + persist the same graph
    const result = validator.validate(graph);
    expect(result.kind).toBe('skipped');

    const persistedId = validator.persistResult(graph, result);
    expect(persistedId).toBeNull();
  });

  it('throws when persisting validated without hypothesisRepo', () => {
    const validator = new HypothesisValidator();
    const result = validator.validate(validGraph());
    expect(result.kind).toBe('validated');

    expect(() => validator.persistResult(validGraph(), result)).toThrow(
      'HypothesisRepository is required',
    );
  });

  it('throws when persisting rejected without both repos', () => {
    const { hypothesisRepo } = createRepos();
    const validator = new HypothesisValidator({ hypothesisRepo }); // no memoryRepo
    const result = validator.validate(validGraph({ signals: [] }));
    expect(result.kind).toBe('rejected');

    expect(() => validator.persistResult(validGraph({ signals: [] }), result)).toThrow(
      'Both HypothesisRepository and HypothesisMemoryRepository are required',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — validateAndPersist
// ---------------------------------------------------------------------------

describe('HypothesisValidator.validateAndPersist', () => {
  it('validates and persists a valid graph in one call', () => {
    const { hypothesisRepo, memoryRepo } = createRepos();
    const validator = new HypothesisValidator({ hypothesisRepo, memoryRepo });

    const { result, persistedId } = validator.validateAndPersist(validGraph(), 3000);

    expect(result.kind).toBe('validated');
    expect(persistedId).toBeGreaterThan(0);

    const fetched = hypothesisRepo.getHypothesisById(persistedId!);
    expect(fetched?.status).toBe(HypothesisStatus.Validated);
    expect(fetched?.createdAt).toBe(3000);
  });

  it('validates, rejects, and persists in one call', () => {
    const { hypothesisRepo, memoryRepo } = createRepos();
    const validator = new HypothesisValidator({ hypothesisRepo, memoryRepo });

    const { result, persistedId } = validator.validateAndPersist(
      validGraph({ signals: [], filters: [] }),
      4000,
    );

    expect(result.kind).toBe('rejected');
    expect(persistedId).toBeGreaterThan(0);

    const fetched = hypothesisRepo.getHypothesisById(persistedId!);
    expect(fetched?.status).toBe(HypothesisStatus.Rejected);

    // Memory ledger should have the rejection
    const lookup = memoryRepo.hasExactFailure(fetched?.canonicalHash ?? '');
    expect(lookup.found).toBe(true);
    expect(lookup.entry?.status).toBe(HypothesisMemoryStatus.Rejected);
  });

  it('skips and does not persist when exact duplicate is found', () => {
    const { hypothesisRepo, memoryRepo } = createRepos();
    const validator = new HypothesisValidator({ hypothesisRepo, memoryRepo });

    // First, persist a valid graph, then fail it and record in memory
    const graph = validGraph();
    const canonical = canonicalizeHypothesis(graph);
    const row = hypothesisRepo.insertHypothesis({
      canonicalHash: canonical.canonicalHash,
      canonicalJson: canonical.canonicalJson,
      status: HypothesisStatus.FailedEvaluation,
      graph,
      createdAt: 1000,
      updatedAt: 1000,
    });
    memoryRepo.recordFailure({
      canonicalHash: canonical.canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'Already failed.',
      hypothesisGraphId: row.id,
      createdAt: 1000,
    });

    // Second call should skip and not persist
    const { result, persistedId } = validator.validateAndPersist(graph, 5000);

    expect(result.kind).toBe('skipped');
    expect(persistedId).toBeNull();

    // Hypothesis count should still be 1 (no new insert)
    expect(hypothesisRepo.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — ValidatorResult discriminated union exhaustiveness
// ---------------------------------------------------------------------------

describe('ValidatorResult discriminated union', () => {
  it('validated kind has canonical and no reasons', () => {
    const validator = new HypothesisValidator();
    const result = validator.validate(validGraph());

    if (result.kind === 'validated') {
      expect(result.canonical).toBeDefined();
      // TypeScript narrows — no reasons property on validated
    } else {
      // This branch should not be reached for a valid graph
      expect(result.kind).toBe('validated');
    }
  });

  it('rejected kind has reasons and no canonical for structural-only failure', () => {
    const validator = new HypothesisValidator();
    const result = validator.validate(
      validGraph({ signals: [] }),
    );

    if (result.kind === 'rejected') {
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.canonical).toBeUndefined();
    }
  });

  it('skipped kind has canonical and reasons', () => {
    const { hypothesisRepo, memoryRepo } = createRepos();
    const graph = validGraph();
    const canonical = canonicalizeHypothesis(graph);
    const row = hypothesisRepo.insertHypothesis({
      canonicalHash: canonical.canonicalHash,
      canonicalJson: canonical.canonicalJson,
      status: HypothesisStatus.FailedEvaluation,
      graph,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    memoryRepo.recordFailure({
      canonicalHash: canonical.canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'Failed.',
      hypothesisGraphId: row.id,
      createdAt: Date.now(),
    });

    const validator = new HypothesisValidator({ memoryRepo });
    const result = validator.validate(graph);

    if (result.kind === 'skipped') {
      expect(result.canonical).toBeDefined();
      expect(result.reasons).toHaveLength(1);
    }
  });
});
