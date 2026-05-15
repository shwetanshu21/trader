import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { HybridScoreRepository } from '../src/persistence/hybrid-score-repo.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import {
  LLMStatus,
  MergePolicy,
  ProposalStatus,
  type NewHybridScoreSummary,
  type NewHybridScoreComponent,
  type NewProposalAttempt,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an in-memory repository pair (proposal + hybrid score).
 * Returns both so tests can insert a parent proposal_attempt row first.
 */
function createRepos(): { proposalRepo: ProposalRepository; hybridScoreRepo: HybridScoreRepository; db: Database.Database } {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;
  return {
    proposalRepo: new ProposalRepository(db),
    hybridScoreRepo: new HybridScoreRepository(db),
    db,
  };
}

/**
 * Insert a parent proposal attempt and return its id.
 * Tests need a valid FK reference for proposal_attempt_id.
 */
function seedProposalAttempt(
  proposalRepo: ProposalRepository,
  overrides?: Partial<NewProposalAttempt>,
): number {
  const attempt = {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    side: 'buy',
    product: 'MIS',
    quantity: 1,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: null,
    proposalStatus: ProposalStatus.Accepted,
    createdAt: Date.now(),
    ...overrides,
  };
  return proposalRepo.insertAttempt(attempt).id;
}

function sampleConsultedSummary(
  proposalAttemptId: number,
  overrides?: Partial<NewHybridScoreSummary>,
): NewHybridScoreSummary {
  return {
    proposalAttemptId,
    deterministicScore: 0.75,
    llmScore: 0.82,
    llmStatus: LLMStatus.Consulted,
    llmRationale: 'Strong momentum with high volume confirmation',
    mergedScore: 0.82,
    mergePolicy: MergePolicy.LLMOverride,
    createdAt: Date.now(),
    ...overrides,
  };
}

function sampleComponents(overrides?: Partial<NewHybridScoreComponent>[]): NewHybridScoreComponent[] {
  return [
    {
      summaryId: 0, // placeholder — set during insertFull
      componentName: 'momentum',
      score: 0.85,
      weight: 0.4,
      sortOrder: 0,
      ...(overrides?.[0] ?? {}),
    },
    {
      summaryId: 0,
      componentName: 'volume',
      score: 0.70,
      weight: 0.3,
      sortOrder: 1,
      ...(overrides?.[1] ?? {}),
    },
    {
      summaryId: 0,
      componentName: 'volatility',
      score: 0.65,
      weight: 0.3,
      sortOrder: 2,
      ...(overrides?.[2] ?? {}),
    },
  ];
}

// ---------------------------------------------------------------------------
// HybridScoreRepository — success path tests
// ---------------------------------------------------------------------------

describe('HybridScoreRepository', () => {
  describe('insertSummary', () => {
    it('inserts and returns a consulted summary', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);
      const summary = sampleConsultedSummary(pid);

      const row = hybridScoreRepo.insertSummary(summary);

      expect(row.id).toBeGreaterThan(0);
      expect(row.proposalAttemptId).toBe(pid);
      expect(row.deterministicScore).toBe(0.75);
      expect(row.llmScore).toBe(0.82);
      expect(row.llmStatus).toBe(LLMStatus.Consulted);
      expect(row.llmRationale).toBe('Strong momentum with high volume confirmation');
      expect(row.mergedScore).toBe(0.82);
      expect(row.mergePolicy).toBe(MergePolicy.LLMOverride);
      expect(row.createdAt).toBeGreaterThan(0);
    });

    it('inserts a summary with LLM skipped (deterministic-only)', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);

      const row = hybridScoreRepo.insertSummary({
        proposalAttemptId: pid,
        deterministicScore: 0.60,
        llmScore: null,
        llmStatus: LLMStatus.Skipped,
        llmRationale: null,
        mergedScore: 0.60,
        mergePolicy: MergePolicy.DeterministicOnly,
        createdAt: Date.now(),
      });

      expect(row.id).toBeGreaterThan(0);
      expect(row.llmScore).toBeNull();
      expect(row.llmStatus).toBe(LLMStatus.Skipped);
      expect(row.llmRationale).toBeNull();
      expect(row.mergePolicy).toBe(MergePolicy.DeterministicOnly);
    });

    it('inserts a summary with LLM degraded', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);

      const row = hybridScoreRepo.insertSummary({
        proposalAttemptId: pid,
        deterministicScore: 0.50,
        llmScore: 0.45,
        llmStatus: LLMStatus.Degraded,
        llmRationale: 'Partial response — timeout after 15s',
        mergedScore: 0.50,
        mergePolicy: MergePolicy.DeterministicOnly,
        createdAt: Date.now(),
      });

      expect(row.id).toBeGreaterThan(0);
      expect(row.llmStatus).toBe(LLMStatus.Degraded);
      expect(row.llmRationale).toBe('Partial response — timeout after 15s');
    });

    it('rejects duplicate proposal_attempt_id (UNIQUE constraint)', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);

      hybridScoreRepo.insertSummary(sampleConsultedSummary(pid));

      expect(() => {
        hybridScoreRepo.insertSummary(sampleConsultedSummary(pid));
      }).toThrow();
    });
  });

  describe('insertComponent', () => {
    it('inserts and returns a component row', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);
      const summary = hybridScoreRepo.insertSummary(sampleConsultedSummary(pid));

      const comp = hybridScoreRepo.insertComponent({
        summaryId: summary.id,
        componentName: 'momentum',
        score: 0.85,
        weight: 0.4,
        sortOrder: 0,
      });

      expect(comp.id).toBeGreaterThan(0);
      expect(comp.summaryId).toBe(summary.id);
      expect(comp.componentName).toBe('momentum');
      expect(comp.score).toBe(0.85);
      expect(comp.weight).toBe(0.4);
      expect(comp.sortOrder).toBe(0);
    });

    it('inserts multiple components with different sort orders', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);
      const summary = hybridScoreRepo.insertSummary(sampleConsultedSummary(pid));

      const c1 = hybridScoreRepo.insertComponent({
        summaryId: summary.id, componentName: 'a', score: 0.5, weight: 0.5, sortOrder: 0,
      });
      const c2 = hybridScoreRepo.insertComponent({
        summaryId: summary.id, componentName: 'b', score: 0.8, weight: 0.5, sortOrder: 1,
      });

      expect(c1.id).toBeGreaterThan(0);
      expect(c2.id).toBeGreaterThan(0);
      expect(c2.id).not.toBe(c1.id);
    });
  });

  describe('insertFull', () => {
    it('atomically inserts summary with ordered components', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);
      const summary = sampleConsultedSummary(pid);
      const components = sampleComponents();

      const result = hybridScoreRepo.insertFull(summary, components);

      // Verify summary fields
      expect(result.id).toBeGreaterThan(0);
      expect(result.proposalAttemptId).toBe(pid);
      expect(result.mergedScore).toBe(0.82);
      expect(result.llmStatus).toBe(LLMStatus.Consulted);

      // Verify components
      expect(result.components.length).toBe(3);
      expect(result.components[0].componentName).toBe('momentum');
      expect(result.components[0].score).toBe(0.85);
      expect(result.components[1].componentName).toBe('volume');
      expect(result.components[1].score).toBe(0.70);
      expect(result.components[2].componentName).toBe('volatility');
      expect(result.components[2].score).toBe(0.65);

      // Verify persistence counts
      expect(hybridScoreRepo.countSummaries()).toBe(1);
      expect(hybridScoreRepo.countComponents()).toBe(3);
    });

    it('atomically inserts summary with zero components', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);
      const summary = sampleConsultedSummary(pid);

      const result = hybridScoreRepo.insertFull(summary, []);

      expect(result.id).toBeGreaterThan(0);
      expect(result.components).toEqual([]);
      expect(hybridScoreRepo.countSummaries()).toBe(1);
      expect(hybridScoreRepo.countComponents()).toBe(0);
    });

    it('rolls back on UNIQUE constraint violation (duplicate proposal_attempt_id)', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);
      const summary = sampleConsultedSummary(pid);
      const components = sampleComponents();

      // First insert succeeds
      hybridScoreRepo.insertFull(summary, components);

      // Second insert with same proposal_attempt_id should fail (UNIQUE constraint)
      expect(() => {
        hybridScoreRepo.insertFull(summary, components);
      }).toThrow();

      // Counts should remain at the first insert's values
      expect(hybridScoreRepo.countSummaries()).toBe(1);
      expect(hybridScoreRepo.countComponents()).toBe(3);
    });
  });

  describe('getByProposalAttemptId', () => {
    it('returns null for unknown proposal attempt', () => {
      const { hybridScoreRepo } = createRepos();
      expect(hybridScoreRepo.getByProposalAttemptId(99999)).toBeNull();
    });

    it('returns full summary with ordered components', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);
      const summary = sampleConsultedSummary(pid);
      const components = sampleComponents();

      const inserted = hybridScoreRepo.insertFull(summary, components);

      // Read back
      const loaded = hybridScoreRepo.getByProposalAttemptId(pid);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(inserted.id);
      expect(loaded!.proposalAttemptId).toBe(pid);
      expect(loaded!.deterministicScore).toBe(0.75);
      expect(loaded!.llmScore).toBe(0.82);
      expect(loaded!.llmStatus).toBe(LLMStatus.Consulted);
      expect(loaded!.llmRationale).toBe('Strong momentum with high volume confirmation');
      expect(loaded!.mergedScore).toBe(0.82);
      expect(loaded!.mergePolicy).toBe(MergePolicy.LLMOverride);

      // Components are ordered by sort_order
      expect(loaded!.components.length).toBe(3);
      expect(loaded!.components[0].componentName).toBe('momentum');
      expect(loaded!.components[0].score).toBe(0.85);
      expect(loaded!.components[0].sortOrder).toBe(0);
      expect(loaded!.components[1].componentName).toBe('volume');
      expect(loaded!.components[1].sortOrder).toBe(1);
      expect(loaded!.components[2].componentName).toBe('volatility');
      expect(loaded!.components[2].sortOrder).toBe(2);
    });

    it('returns summary with zero components when none were inserted', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);
      hybridScoreRepo.insertSummary(sampleConsultedSummary(pid));

      const loaded = hybridScoreRepo.getByProposalAttemptId(pid);
      expect(loaded).not.toBeNull();
      expect(loaded!.components).toEqual([]);
    });
  });

  describe('getRecent', () => {
    it('returns empty array when no summaries exist', () => {
      const { hybridScoreRepo } = createRepos();
      expect(hybridScoreRepo.getRecent()).toEqual([]);
    });

    it('returns summaries newest first with components', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();

      // Insert two summaries for two different proposals
      const pid1 = seedProposalAttempt(proposalRepo, { tradingsymbol: 'FIRST', createdAt: 100 });
      const pid2 = seedProposalAttempt(proposalRepo, { tradingsymbol: 'SECOND', createdAt: 200 });

      hybridScoreRepo.insertFull(
        sampleConsultedSummary(pid1, { createdAt: 100 }),
        sampleComponents(),
      );
      hybridScoreRepo.insertFull(
        sampleConsultedSummary(pid2, { createdAt: 200 }),
        sampleComponents(),
      );

      const results = hybridScoreRepo.getRecent();
      expect(results.length).toBe(2);
      // Newest first (pid2 was created later)
      expect(results[0].proposalAttemptId).toBe(pid2);
      expect(results[1].proposalAttemptId).toBe(pid1);

      // Both have their components loaded
      expect(results[0].components.length).toBe(3);
      expect(results[1].components.length).toBe(3);
    });

    it('respects limit parameter', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      for (let i = 0; i < 10; i++) {
        const pid = seedProposalAttempt(proposalRepo, { tradingsymbol: `SYM_${i}`, createdAt: i });
        hybridScoreRepo.insertSummary(sampleConsultedSummary(pid, { createdAt: i }));
      }

      expect(hybridScoreRepo.getRecent(3).length).toBe(3);
    });
  });

  describe('countSummaries / countComponents', () => {
    it('starts at zero', () => {
      const { hybridScoreRepo } = createRepos();
      expect(hybridScoreRepo.countSummaries()).toBe(0);
      expect(hybridScoreRepo.countComponents()).toBe(0);
    });

    it('counts summaries across inserts', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid1 = seedProposalAttempt(proposalRepo, { tradingsymbol: 'A' });
      const pid2 = seedProposalAttempt(proposalRepo, { tradingsymbol: 'B' });

      hybridScoreRepo.insertSummary(sampleConsultedSummary(pid1));
      hybridScoreRepo.insertSummary(sampleConsultedSummary(pid2));

      expect(hybridScoreRepo.countSummaries()).toBe(2);
    });

    it('counts components across all summaries', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid1 = seedProposalAttempt(proposalRepo, { tradingsymbol: 'A' });
      const pid2 = seedProposalAttempt(proposalRepo, { tradingsymbol: 'B' });

      hybridScoreRepo.insertFull(sampleConsultedSummary(pid1), sampleComponents());
      hybridScoreRepo.insertFull(sampleConsultedSummary(pid2), sampleComponents());

      expect(hybridScoreRepo.countComponents()).toBe(6);
    });
  });

  // ---------------------------------------------------------------------------
  // LLM state coverage — explicit degraded, error, and skipped states
  // ---------------------------------------------------------------------------

  describe('LLM state coverage', () => {
    it('round-trips LLM error state with null score and rationale', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);

      const inserted = hybridScoreRepo.insertSummary({
        proposalAttemptId: pid,
        deterministicScore: 0.50,
        llmScore: null,
        llmStatus: LLMStatus.Error,
        llmRationale: 'Provider returned 503 Service Unavailable',
        mergedScore: 0.50,
        mergePolicy: MergePolicy.DeterministicOnly,
        createdAt: Date.now(),
      });

      const loaded = hybridScoreRepo.getByProposalAttemptId(pid);
      expect(loaded).not.toBeNull();
      expect(loaded!.llmScore).toBeNull();
      expect(loaded!.llmStatus).toBe(LLMStatus.Error);
      expect(loaded!.llmRationale).toBe('Provider returned 503 Service Unavailable');
      expect(loaded!.mergePolicy).toBe(MergePolicy.DeterministicOnly);
      expect(loaded!.mergedScore).toBe(0.50);
    });

    it('round-trips LLM degraded state with degraded score', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);

      const inserted = hybridScoreRepo.insertSummary({
        proposalAttemptId: pid,
        deterministicScore: 0.65,
        llmScore: 0.30,
        llmStatus: LLMStatus.Degraded,
        llmRationale: 'Response quality degraded — high latency, partial reasoning',
        mergedScore: 0.65,
        mergePolicy: MergePolicy.DeterministicOnly,
        createdAt: Date.now(),
      });

      const loaded = hybridScoreRepo.getByProposalAttemptId(pid);
      expect(loaded).not.toBeNull();
      expect(loaded!.llmScore).toBe(0.30);
      expect(loaded!.llmStatus).toBe(LLMStatus.Degraded);
      expect(loaded!.llmRationale).toBe('Response quality degraded — high latency, partial reasoning');
    });

    it('round-trips LLM skipped state (deterministic-only) with weighted merge', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);

      const inserted = hybridScoreRepo.insertFull(
        {
          proposalAttemptId: pid,
          deterministicScore: 0.72,
          llmScore: null,
          llmStatus: LLMStatus.Skipped,
          llmRationale: null,
          mergedScore: 0.72,
          mergePolicy: MergePolicy.DeterministicOnly,
          createdAt: Date.now(),
        },
        [
          { summaryId: 0, componentName: 'trend', score: 0.80, weight: 0.5, sortOrder: 0 },
          { summaryId: 0, componentName: 'rsi', score: 0.64, weight: 0.5, sortOrder: 1 },
        ],
      );

      const loaded = hybridScoreRepo.getByProposalAttemptId(pid);
      expect(loaded).not.toBeNull();
      expect(loaded!.llmStatus).toBe(LLMStatus.Skipped);
      expect(loaded!.llmScore).toBeNull();
      expect(loaded!.llmRationale).toBeNull();
      expect(loaded!.mergePolicy).toBe(MergePolicy.DeterministicOnly);
      expect(loaded!.mergedScore).toBe(0.72);
      expect(loaded!.components.length).toBe(2);
      expect(loaded!.components[0].componentName).toBe('trend');
      expect(loaded!.components[0].sortOrder).toBe(0);
      expect(loaded!.components[1].componentName).toBe('rsi');
      expect(loaded!.components[1].sortOrder).toBe(1);
    });

    it('round-trips LLM consulted state with average merge policy', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);

      const inserted = hybridScoreRepo.insertSummary({
        proposalAttemptId: pid,
        deterministicScore: 0.60,
        llmScore: 0.80,
        llmStatus: LLMStatus.Consulted,
        llmRationale: 'Favorable risk/reward setup',
        mergedScore: 0.70,
        mergePolicy: MergePolicy.Average,
        createdAt: Date.now(),
      });

      const loaded = hybridScoreRepo.getByProposalAttemptId(pid);
      expect(loaded).not.toBeNull();
      expect(loaded!.llmStatus).toBe(LLMStatus.Consulted);
      expect(loaded!.llmScore).toBe(0.80);
      expect(loaded!.mergePolicy).toBe(MergePolicy.Average);
      expect(loaded!.mergedScore).toBe(0.70);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases — boundary conditions
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles deterministic score of 0', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);

      const row = hybridScoreRepo.insertSummary({
        proposalAttemptId: pid,
        deterministicScore: 0,
        llmScore: null,
        llmStatus: LLMStatus.Skipped,
        llmRationale: null,
        mergedScore: 0,
        mergePolicy: MergePolicy.DeterministicOnly,
        createdAt: Date.now(),
      });

      expect(row.deterministicScore).toBe(0);
      expect(row.mergedScore).toBe(0);
    });

    it('handles deterministic score of 1', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);

      const row = hybridScoreRepo.insertSummary({
        proposalAttemptId: pid,
        deterministicScore: 1,
        llmScore: null,
        llmStatus: LLMStatus.Skipped,
        llmRationale: null,
        mergedScore: 1,
        mergePolicy: MergePolicy.DeterministicOnly,
        createdAt: Date.now(),
      });

      expect(row.deterministicScore).toBe(1);
      expect(row.mergedScore).toBe(1);
    });

    it('handles component weight of 0', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);
      const summary = sampleConsultedSummary(pid);

      const result = hybridScoreRepo.insertFull(summary, [
        { summaryId: 0, componentName: 'zero_weight', score: 0.5, weight: 0, sortOrder: 0 },
      ]);

      expect(result.components[0].weight).toBe(0);
    });

    it('handles empty component name', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);
      const summary = sampleConsultedSummary(pid);

      const result = hybridScoreRepo.insertFull(summary, [
        { summaryId: 0, componentName: '', score: 0.5, weight: 1.0, sortOrder: 0 },
      ]);

      expect(result.components[0].componentName).toBe('');
    });

    it('handles very long component name', () => {
      const { proposalRepo, hybridScoreRepo } = createRepos();
      const pid = seedProposalAttempt(proposalRepo);
      const summary = sampleConsultedSummary(pid);
      const longName = 'a'.repeat(255);

      const result = hybridScoreRepo.insertFull(summary, [
        { summaryId: 0, componentName: longName, score: 0.5, weight: 1.0, sortOrder: 0 },
      ]);

      expect(result.components[0].componentName).toBe(longName);
    });
  });
});
