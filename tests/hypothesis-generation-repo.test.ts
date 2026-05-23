import { describe, expect, it } from 'vitest';

import { HypothesisGenerationRepository } from '../src/persistence/hypothesis-generation-repo.js';
import { HypothesisRepository } from '../src/persistence/hypothesis-repo.js';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import {
  GenerationVerdict,
  GenerationReasonCode,
  HypothesisStatus,
  type GenerationContextProvenance,
  type NewHypothesisGenerationAttempt,
  type GenerationReason,
  type HypothesisGraph,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RepoContext {
  genRepo: HypothesisGenerationRepository;
  hypothesisRepo: HypothesisRepository;
}

function createContext(): RepoContext {
  const mgr = new DatabaseManager(':memory:');
  return {
    genRepo: new HypothesisGenerationRepository(mgr.db),
    hypothesisRepo: new HypothesisRepository(mgr.db),
  };
}

function sampleProvenance(
  overrides?: Partial<GenerationContextProvenance>,
): GenerationContextProvenance {
  return {
    providerUrl: 'https://api.openai.com/v1',
    providerModel: 'gpt-4',
    promptVersion: 'v1',
    triggeredAt: Date.now(),
    marketId: 'INDIA_NSE_EQ',
    strategyId: 'india-nse-eq-v1',
    ...overrides,
  };
}

function newAcceptedAttempt(
  overrides?: Partial<NewHypothesisGenerationAttempt>,
): NewHypothesisGenerationAttempt {
  return {
    verdict: GenerationVerdict.Accepted,
    contextProvenance: sampleProvenance(),
    rawProviderOutput: '{"schemaVersion":"1","signals":[{"type":"ema_cross","params":{"fast":8,"slow":21}}],"filters":[],"entryRules":[],"exitRules":[],"riskRules":[]}',
    canonicalHash: 'abc123def456',
    hypothesisGraphId: null,
    hypothesisEvaluationId: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function newMalformedAttempt(
  overrides?: Partial<NewHypothesisGenerationAttempt>,
): NewHypothesisGenerationAttempt {
  return {
    verdict: GenerationVerdict.Rejected,
    contextProvenance: sampleProvenance(),
    rawProviderOutput: '{invalid json here',
    canonicalHash: null,
    hypothesisGraphId: null,
    hypothesisEvaluationId: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function newSkippedAttempt(
  overrides?: Partial<NewHypothesisGenerationAttempt>,
): NewHypothesisGenerationAttempt {
  return {
    verdict: GenerationVerdict.Skipped,
    contextProvenance: sampleProvenance(),
    rawProviderOutput: null,
    canonicalHash: 'abc123def456',
    hypothesisGraphId: null,
    hypothesisEvaluationId: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function malformedReasons(): GenerationReason[] {
  return [
    {
      reasonCode: GenerationReasonCode.MalformedResponse,
      reasonMessage: 'Provider returned non-parseable JSON: Unexpected token at position 5.',
    },
  ];
}

function skippedReasons(): GenerationReason[] {
  return [
    {
      reasonCode: GenerationReasonCode.DuplicateSkipped,
      reasonMessage: 'Exact hash abc123def456 was already generated and accepted in attempt #1.',
    },
  ];
}

function sampleGraph(): HypothesisGraph {
  return {
    schemaVersion: '1',
    signals: [{ type: 'ema_cross', params: { fast: 8, slow: 21 } }],
    filters: [],
    entryRules: [],
    exitRules: [],
    riskRules: [],
  };
}

function seedHypothesis(ctx: RepoContext, status: HypothesisStatus = HypothesisStatus.Validated): number {
  return ctx.hypothesisRepo.insertHypothesis({
    canonicalHash: 'seed-hash-' + Date.now(),
    canonicalJson: JSON.stringify(sampleGraph()),
    status,
    graph: sampleGraph(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }).id;
}

function seedEvaluation(ctx: RepoContext, hypothesisGraphId: number): number {
  return ctx.hypothesisRepo.insertEvaluation({
    hypothesisGraphId,
    status: 'pending',
    rationale: 'Seeded evaluation.',
    outcomeDetail: '',
  }).id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HypothesisGenerationRepository', () => {
  describe('insertAttempt', () => {
    it('inserts and round-trips an accepted attempt with linkage fields', () => {
      const ctx = createContext();
      const graphId = seedHypothesis(ctx);
      const evalId = seedEvaluation(ctx, graphId);
      const input = newAcceptedAttempt({
        hypothesisGraphId: graphId,
        hypothesisEvaluationId: evalId,
      });

      const row = ctx.genRepo.insertAttempt(input);
      const fetched = ctx.genRepo.getById(row.id);

      expect(row.id).toBeGreaterThan(0);
      expect(fetched).not.toBeNull();
      expect(fetched?.verdict).toBe(GenerationVerdict.Accepted);
      expect(fetched?.contextProvenance.providerUrl).toBe('https://api.openai.com/v1');
      expect(fetched?.contextProvenance.providerModel).toBe('gpt-4');
      expect(fetched?.contextProvenance.promptVersion).toBe('v1');
      expect(fetched?.contextProvenance.marketId).toBe('INDIA_NSE_EQ');
      expect(fetched?.contextProvenance.strategyId).toBe('india-nse-eq-v1');
      expect(fetched?.contextProvenance.triggeredAt).toBeGreaterThan(0);
      expect(fetched?.rawProviderOutput).toBe(input.rawProviderOutput);
      expect(fetched?.canonicalHash).toBe('abc123def456');
      expect(fetched?.hypothesisGraphId).toBe(graphId);
      expect(fetched?.hypothesisEvaluationId).toBe(evalId);
      expect(ctx.genRepo.count()).toBe(1);
    });

    it('inserts and round-trips a malformed (rejected) attempt without linkage', () => {
      const ctx = createContext();
      const input = newMalformedAttempt();

      const row = ctx.genRepo.insertAttempt(input);
      const fetched = ctx.genRepo.getById(row.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.verdict).toBe(GenerationVerdict.Rejected);
      expect(fetched?.rawProviderOutput).toBe('{invalid json here');
      expect(fetched?.canonicalHash).toBeNull();
      expect(fetched?.hypothesisGraphId).toBeNull();
      expect(fetched?.hypothesisEvaluationId).toBeNull();
      expect(ctx.genRepo.count()).toBe(1);
    });

    it('inserts and round-trips a skipped attempt with hash but no graph linkage', () => {
      const ctx = createContext();
      const input = newSkippedAttempt();

      const row = ctx.genRepo.insertAttempt(input);
      const fetched = ctx.genRepo.getById(row.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.verdict).toBe(GenerationVerdict.Skipped);
      expect(fetched?.rawProviderOutput).toBeNull();
      expect(fetched?.canonicalHash).toBe('abc123def456');
      expect(fetched?.hypothesisGraphId).toBeNull();
    });

    it('stores null provider fields when absent', () => {
      const ctx = createContext();
      const input: NewHypothesisGenerationAttempt = {
        verdict: GenerationVerdict.Rejected,
        contextProvenance: sampleProvenance({ providerModel: null, promptVersion: null, strategyId: null }),
        rawProviderOutput: null,
        canonicalHash: null,
        hypothesisGraphId: null,
        hypothesisEvaluationId: null,
        createdAt: Date.now(),
      };

      const row = ctx.genRepo.insertAttempt(input);
      const fetched = ctx.genRepo.getById(row.id);

      expect(fetched?.contextProvenance.providerModel).toBeNull();
      expect(fetched?.contextProvenance.promptVersion).toBeNull();
      expect(fetched?.contextProvenance.strategyId).toBeNull();
      expect(fetched?.rawProviderOutput).toBeNull();
    });
  });

  describe('insertAttemptWithReasons', () => {
    it('inserts an attempt with malformed reasons in a single transaction', () => {
      const ctx = createContext();
      const input = newMalformedAttempt();
      const reasons = malformedReasons();

      const row = ctx.genRepo.insertAttemptWithReasons(input, reasons);

      expect(row.id).toBeGreaterThan(0);
      expect(row.verdict).toBe(GenerationVerdict.Rejected);
      expect(row.reasons).toHaveLength(1);
      expect(row.reasons[0]?.reasonCode).toBe(GenerationReasonCode.MalformedResponse);
      expect(row.reasons[0]?.reasonMessage).toContain('non-parseable JSON');

      const fetched = ctx.genRepo.getByIdWithReasons(row.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.reasons).toHaveLength(1);
      expect(fetched?.reasons[0]?.reasonCode).toBe(GenerationReasonCode.MalformedResponse);
      expect(ctx.genRepo.countReasons()).toBe(1);
    });

    it('inserts an attempt with duplicate-skip reasons', () => {
      const ctx = createContext();
      const input = newSkippedAttempt();
      const reasons = skippedReasons();

      const row = ctx.genRepo.insertAttemptWithReasons(input, reasons);

      expect(row.verdict).toBe(GenerationVerdict.Skipped);
      expect(row.reasons).toHaveLength(1);
      expect(row.reasons[0]?.reasonCode).toBe(GenerationReasonCode.DuplicateSkipped);

      const fetched = ctx.genRepo.getByIdWithReasons(row.id);
      expect(fetched?.reasons).toHaveLength(1);
    });

    it('returns empty reasons for accepted attempts inserted without reasons', () => {
      const ctx = createContext();
      const input = newAcceptedAttempt();

      const row = ctx.genRepo.insertAttempt(input);
      const fetched = ctx.genRepo.getByIdWithReasons(row.id);

      expect(fetched?.reasons).toEqual([]);
    });
  });

  describe('getByIdWithReasons', () => {
    it('returns null for non-existent id', () => {
      const ctx = createContext();
      expect(ctx.genRepo.getByIdWithReasons(999)).toBeNull();
    });
  });

  describe('getRecent', () => {
    it('returns attempts newest first, respects limit', () => {
      const ctx = createContext();
      const base = Date.now();

      const a1 = ctx.genRepo.insertAttempt(newAcceptedAttempt({ createdAt: base }));
      const a2 = ctx.genRepo.insertAttempt(newMalformedAttempt({ createdAt: base + 10 }));
      const a3 = ctx.genRepo.insertAttempt(newSkippedAttempt({ createdAt: base + 20 }));

      const recent = ctx.genRepo.getRecent(2);
      expect(recent).toHaveLength(2);
      expect(recent[0]?.id).toBe(a3.id);
      expect(recent[1]?.id).toBe(a2.id);
    });
  });

  describe('getByVerdict', () => {
    it('filters by verdict correctly', () => {
      const ctx = createContext();

      ctx.genRepo.insertAttempt(newAcceptedAttempt());
      ctx.genRepo.insertAttempt(newMalformedAttempt());
      ctx.genRepo.insertAttempt(newSkippedAttempt());

      const accepted = ctx.genRepo.getByVerdict(GenerationVerdict.Accepted);
      const rejected = ctx.genRepo.getByVerdict(GenerationVerdict.Rejected);
      const skipped = ctx.genRepo.getByVerdict(GenerationVerdict.Skipped);

      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.verdict).toBe(GenerationVerdict.Accepted);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.verdict).toBe(GenerationVerdict.Rejected);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.verdict).toBe(GenerationVerdict.Skipped);
    });
  });

  describe('getByHypothesisGraphId', () => {
    it('finds the attempt linked to a hypothesis graph id', () => {
      const ctx = createContext();
      const graphId = seedHypothesis(ctx);
      ctx.genRepo.insertAttempt(newAcceptedAttempt({ hypothesisGraphId: graphId }));

      const found = ctx.genRepo.getByHypothesisGraphId(graphId);
      expect(found).not.toBeNull();
      expect(found?.hypothesisGraphId).toBe(graphId);
      expect(found?.verdict).toBe(GenerationVerdict.Accepted);
    });

    it('returns null when no attempt is linked to the graph id', () => {
      const ctx = createContext();
      expect(ctx.genRepo.getByHypothesisGraphId(999)).toBeNull();
    });

    it('returns the most recent attempt when multiple link to the same graph', () => {
      const ctx = createContext();
      const graphId = seedHypothesis(ctx);
      const base = Date.now();

      ctx.genRepo.insertAttempt(newAcceptedAttempt({
        hypothesisGraphId: graphId,
        createdAt: base,
        rawProviderOutput: '{"first":true}',
      }));
      ctx.genRepo.insertAttempt(newAcceptedAttempt({
        hypothesisGraphId: graphId,
        createdAt: base + 10,
        rawProviderOutput: '{"updated":true}',
      }));

      const found = ctx.genRepo.getByHypothesisGraphId(graphId);
      expect(found?.rawProviderOutput).toBe('{"updated":true}');
    });
  });

  describe('updateLinkage', () => {
    it('updates canonicalHash and hypothesisGraphId', () => {
      const ctx = createContext();
      const graphId = seedHypothesis(ctx);
      const input = newMalformedAttempt();
      const row = ctx.genRepo.insertAttempt(input);

      const updated = ctx.genRepo.updateLinkage(row.id, {
        canonicalHash: 'newhash789',
        hypothesisGraphId: graphId,
      });

      expect(updated).not.toBeNull();
      expect(updated?.canonicalHash).toBe('newhash789');
      expect(updated?.hypothesisGraphId).toBe(graphId);
      expect(updated?.hypothesisEvaluationId).toBeNull(); // unchanged
    });

    it('updates hypothesisEvaluationId', () => {
      const ctx = createContext();
      const graphId = seedHypothesis(ctx);
      const evalId = seedEvaluation(ctx, graphId);
      const input = newAcceptedAttempt({ hypothesisGraphId: graphId });
      const row = ctx.genRepo.insertAttempt(input);

      const updated = ctx.genRepo.updateLinkage(row.id, {
        hypothesisEvaluationId: evalId,
      });

      expect(updated?.hypothesisEvaluationId).toBe(evalId);
    });

    it('updates multiple fields in one call', () => {
      const ctx = createContext();
      const graphId = seedHypothesis(ctx);
      const evalId = seedEvaluation(ctx, graphId);
      const input = newMalformedAttempt();
      const row = ctx.genRepo.insertAttempt(input);

      const updated = ctx.genRepo.updateLinkage(row.id, {
        canonicalHash: 'hash1',
        hypothesisGraphId: graphId,
        hypothesisEvaluationId: evalId,
      });

      expect(updated?.canonicalHash).toBe('hash1');
      expect(updated?.hypothesisGraphId).toBe(graphId);
      expect(updated?.hypothesisEvaluationId).toBe(evalId);
    });

    it('returns null for non-existent id', () => {
      const ctx = createContext();
      const graphId = seedHypothesis(ctx);
      const result = ctx.genRepo.updateLinkage(999, { hypothesisGraphId: graphId });
      expect(result).toBeNull();
    });

    it('returns the row unchanged when no update fields are provided', () => {
      const ctx = createContext();
      const input = newAcceptedAttempt();
      const row = ctx.genRepo.insertAttempt(input);

      const result = ctx.genRepo.updateLinkage(row.id, {});
      expect(result?.canonicalHash).toBe(input.canonicalHash);
      expect(result?.hypothesisGraphId).toBeNull();
    });
  });

  describe('addReason', () => {
    it('adds a reason to an existing attempt', () => {
      const ctx = createContext();
      const row = ctx.genRepo.insertAttempt(newAcceptedAttempt());

      ctx.genRepo.addReason(row.id, {
        reasonCode: GenerationReasonCode.ProviderError,
        reasonMessage: 'Provider returned HTTP 500.',
      });

      const fetched = ctx.genRepo.getByIdWithReasons(row.id);
      expect(fetched?.reasons).toHaveLength(1);
      expect(fetched?.reasons[0]?.reasonCode).toBe(GenerationReasonCode.ProviderError);
    });

    it('accumulates multiple reasons in insertion order', () => {
      const ctx = createContext();
      const row = ctx.genRepo.insertAttempt(newMalformedAttempt());

      ctx.genRepo.addReason(row.id, {
        reasonCode: GenerationReasonCode.MalformedResponse,
        reasonMessage: 'Syntax error.',
      });
      ctx.genRepo.addReason(row.id, {
        reasonCode: GenerationReasonCode.EmptyResponse,
        reasonMessage: 'Response body was empty.',
      });

      const fetched = ctx.genRepo.getByIdWithReasons(row.id);
      expect(fetched?.reasons).toHaveLength(2);
      expect(fetched?.reasons[0]?.reasonCode).toBe(GenerationReasonCode.MalformedResponse);
      expect(fetched?.reasons[1]?.reasonCode).toBe(GenerationReasonCode.EmptyResponse);
    });
  });

  describe('count methods', () => {
    it('countByVerdict returns accurate counts', () => {
      const ctx = createContext();

      ctx.genRepo.insertAttempt(newAcceptedAttempt());
      ctx.genRepo.insertAttempt(newAcceptedAttempt());
      ctx.genRepo.insertAttempt(newMalformedAttempt());
      ctx.genRepo.insertAttempt(newSkippedAttempt());

      expect(ctx.genRepo.countByVerdict(GenerationVerdict.Accepted)).toBe(2);
      expect(ctx.genRepo.countByVerdict(GenerationVerdict.Rejected)).toBe(1);
      expect(ctx.genRepo.countByVerdict(GenerationVerdict.Skipped)).toBe(1);
    });

    it('countReasons returns accurate count', () => {
      const ctx = createContext();

      ctx.genRepo.insertAttemptWithReasons(
        newMalformedAttempt(),
        malformedReasons(),
      );
      ctx.genRepo.insertAttemptWithReasons(
        newSkippedAttempt(),
        skippedReasons(),
      );

      expect(ctx.genRepo.countReasons()).toBe(2);
    });
  });

  describe('idempotence and edge cases', () => {
    it('handles empty raw provider output', () => {
      const ctx = createContext();
      const input: NewHypothesisGenerationAttempt = {
        verdict: GenerationVerdict.Rejected,
        contextProvenance: sampleProvenance(),
        rawProviderOutput: '',
        canonicalHash: null,
        hypothesisGraphId: null,
        hypothesisEvaluationId: null,
        createdAt: Date.now(),
      };

      const row = ctx.genRepo.insertAttempt(input);
      expect(row.rawProviderOutput).toBe('');
      expect(row.id).toBeGreaterThan(0);
    });

    it('handles very long raw provider output', () => {
      const ctx = createContext();
      const longOutput = JSON.stringify({ data: 'x'.repeat(10_000) });

      const input = newAcceptedAttempt({ rawProviderOutput: longOutput });
      const row = ctx.genRepo.insertAttempt(input);
      const fetched = ctx.genRepo.getById(row.id);

      expect(fetched?.rawProviderOutput).toBe(longOutput);
    });

    it('handles all GenerationReasonCode values as reasons', () => {
      const ctx = createContext();
      const allCodes = Object.values(GenerationReasonCode);

      const input = newMalformedAttempt();
      const reasons: GenerationReason[] = allCodes.map(code => ({
        reasonCode: code,
        reasonMessage: `Test reason for ${code}`,
      }));

      const row = ctx.genRepo.insertAttemptWithReasons(input, reasons);
      expect(row.reasons).toHaveLength(allCodes.length);

      const fetched = ctx.genRepo.getByIdWithReasons(row.id);
      expect(fetched?.reasons).toHaveLength(allCodes.length);
      expect(fetched?.reasons.map(r => r.reasonCode)).toEqual(allCodes);
    });
  });
});
