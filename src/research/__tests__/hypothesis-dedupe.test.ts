// ── Integration test: exact-dedupe behavior end to end ──
//
// Proves that the real SQLite-backed HypothesisValidator pipeline:
//   1. Remembers a failed hypothesis so an exact repeat is deterministically skipped.
//   2. Preserves the stored failure reason from the memory ledger in the skip verdict.
//   3. Does NOT skip a near-identical graph that differs by one parameter value.
//
// All persistence uses DatabaseManager(':memory:') — no filesystem state required.

import { describe, expect, it } from 'vitest';

import { HypothesisValidator } from '../hypothesis-validator.js';
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
// Helpers
// ---------------------------------------------------------------------------

/** Factory for a structurally valid hypothesis graph. */
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

/** Build a fresh in-memory database and repos for each test. */
function createFixture() {
  const mgr = new DatabaseManager(':memory:');
  const hypothesisRepo = new HypothesisRepository(mgr.db);
  const memoryRepo = new HypothesisMemoryRepository(mgr.db);
  const validator = new HypothesisValidator({ hypothesisRepo, memoryRepo });
  return { mgr, hypothesisRepo, memoryRepo, validator };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HypothesisValidator — exact-dedupe integration (T05)', () => {
  // ── 1. Failed hypothesis is remembered ──
  it('remembers a failed hypothesis so an exact repeat is skipped', () => {
    const { hypothesisRepo, memoryRepo, validator } = createFixture();
    const graph = validGraph();

    // Act 1: validate + persist a graph that passes structural validation.
    // Then record a failure in the memory ledger to simulate what happens
    // when the evaluation phase later finds a problem.
    const { result: firstResult, persistedId } = validator.validateAndPersist(graph, 1000);
    expect(firstResult.kind).toBe('validated');

    // Manually record an evaluation failure in the memory ledger
    // (the validator's persistResult path records failures for rejected
    // outcomes; this simulates an evaluation-phase failure that is
    // recorded by downstream code).
    const canonical = firstResult.kind === 'validated' ? firstResult.canonical : null;
    expect(canonical).not.toBeNull();

    memoryRepo.recordFailure({
      canonicalHash: canonical!.canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'Walk-forward evaluation failed: sharpe < 1.0',
      hypothesisGraphId: persistedId!,
      createdAt: 2000,
    });

    // Act 2: validate the exact same graph again
    const secondResult = validator.validate(graph);

    // Assert: the second attempt is skipped with the stored reason
    expect(secondResult.kind).toBe('skipped');
    if (secondResult.kind === 'skipped') {
      expect(secondResult.status).toBe(HypothesisStatus.Skipped);
      expect(secondResult.canonical.canonicalHash).toBe(canonical!.canonicalHash);
      expect(secondResult.reasons).toHaveLength(1);
      expect(secondResult.reasons[0]!.reasonCode).toBe(
        HypothesisValidationReasonCode.ExactFailureMatch,
      );
      expect(secondResult.reasons[0]!.reasonMessage).toContain('sharpe < 1.0');
    }

    // The hypothesis count should still be 1 (no new insert for skipped)
    expect(hypothesisRepo.count()).toBe(1);
  });

  // ── 2. Exact repeat surfaces the stored reason ──
  //
  // The validator's validate() short-circuits on structural failures (returns
  // 'rejected' before consulting the memory ledger). To test skip behavior,
  // we use structurally VALID graphs that have an evaluation-phase failure
  // recorded in the memory ledger — this simulates what happens when a
  // hypothesis passes structural validation but later fails during evaluation.
  it('surfaces the exact stored failure reason when skipping a repeat', () => {
    const { hypothesisRepo, memoryRepo, validator } = createFixture();
    const graph = validGraph();

    // Step 1: Validate + persist a structurally valid graph
    const { result: firstResult, persistedId } = validator.validateAndPersist(graph, 1000);
    expect(firstResult.kind).toBe('validated');

    const canonical = firstResult.kind === 'validated' ? firstResult.canonical : null;
    expect(canonical).not.toBeNull();

    // Step 2: Record an evaluation-phase failure in the memory ledger with a
    // specific reason message
    memoryRepo.recordFailure({
      canonicalHash: canonical!.canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'Walk-forward evaluation failed: max drawdown exceeded 15%',
      hypothesisGraphId: persistedId!,
      createdAt: 2000,
    });

    // Step 3: Validate the exact same graph — should be skipped with the
    // stored reason message surfaced in the skip verdict
    const skipResult = validator.validate(graph);

    expect(skipResult.kind).toBe('skipped');
    if (skipResult.kind === 'skipped') {
      expect(skipResult.canonical.canonicalHash).toBe(canonical!.canonicalHash);
      expect(skipResult.reasons).toHaveLength(1);
      expect(skipResult.reasons[0]!.reasonCode).toBe(
        HypothesisValidationReasonCode.ExactFailureMatch,
      );
      // The stored failure message is surfaced verbatim in the skip reason
      expect(skipResult.reasons[0]!.reasonMessage).toContain(
        'max drawdown exceeded 15%',
      );
    }

    // Verify the memory ledger has exactly one entry
    expect(memoryRepo.count()).toBe(1);

    // Can read back the stored reason directly from the ledger
    const ledgerEntry = memoryRepo.getFailureByHash(canonical!.canonicalHash);
    expect(ledgerEntry).not.toBeNull();
    expect(ledgerEntry!.reasonMessage).toContain('max drawdown exceeded 15%');
    expect(ledgerEntry!.status).toBe(HypothesisMemoryStatus.Failed);
    expect(ledgerEntry!.createdAt).toBe(2000);

    // No new hypothesis graph row was created for the skip
    expect(hypothesisRepo.count()).toBe(1);
  });

  // ── 3. Near-identical graph with one changed parameter is NOT skipped ──
  it('does NOT skip a near-identical graph with a different parameter value', () => {
    const { hypothesisRepo, memoryRepo, validator } = createFixture();

    // Graph A: fast=8, slow=21
    const graphA = validGraph();
    const { result: resultA } = validator.validateAndPersist(graphA, 1000);
    expect(resultA.kind).toBe('validated');

    // Record a failure for graph A in the memory ledger
    const canonicalA =
      resultA.kind === 'validated' ? resultA.canonical : null;
    expect(canonicalA).not.toBeNull();

    const persistedA = hypothesisRepo.getHypothesisByCanonicalHash(canonicalA!.canonicalHash);
    expect(persistedA).not.toBeNull();

    memoryRepo.recordFailure({
      canonicalHash: canonicalA!.canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'Walk-forward evaluation failed for graph A.',
      hypothesisGraphId: persistedA!.id,
      createdAt: 2000,
    });

    // Graph B: fast=8, slow=34 (different slow parameter — near-identical)
    const graphB = validGraph({
      signals: [{ type: 'ema_cross', params: { fast: 8, slow: 34 } }],
    });

    // Validate graph B — should NOT be skipped because the canonical hash differs
    const resultB = validator.validate(graphB);

    expect(resultB.kind).toBe('validated');
    if (resultB.kind === 'validated') {
      expect(resultB.status).toBe(HypothesisStatus.Validated);
      expect(resultB.canonical.canonicalHash).not.toBe(canonicalA!.canonicalHash);
    }

    // Graph C: also fast=8, slow=34 (same as B) — should be skipped because
    // it was also persisted and should have a memory entry now
    const { result: resultC } = validator.validateAndPersist(graphB, 3000);

    // Now graph B's failure is in the ledger, so C should be skipped
    // Record failure for B first
    const canonicalB = resultC.kind === 'validated' ? resultC.canonical : null;
    expect(canonicalB).not.toBeNull();

    const persistedB = hypothesisRepo.getHypothesisByCanonicalHash(canonicalB!.canonicalHash);
    expect(persistedB).not.toBeNull();

    memoryRepo.recordFailure({
      canonicalHash: canonicalB!.canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'Walk-forward evaluation failed for graph B.',
      hypothesisGraphId: persistedB!.id,
      createdAt: 4000,
    });

    // Now graph C (same as B) should be skipped
    const resultSkippedB = validator.validate(graphB);
    expect(resultSkippedB.kind).toBe('skipped');

    // Verify the memory ledger has two distinct entries (A and B)
    expect(memoryRepo.count()).toBe(2);
  });

  // ── 4. validateAndPersist whole-pipeline: failed → repeat → skip ──
  it('end-to-end validateAndPersist cycle: fail, repeat-skip, near-miss-passes', () => {
    const { hypothesisRepo, memoryRepo, validator } = createFixture();

    // Step 1: validateAndPersist a valid graph
    const graph1 = validGraph();
    const { result: r1, persistedId: p1 } = validator.validateAndPersist(graph1, 1000);
    expect(r1.kind).toBe('validated');
    expect(p1).toBeGreaterThan(0);

    // Record an evaluation failure in the ledger for graph1
    const c1 = r1.kind === 'validated' ? r1.canonical : null;
    expect(c1).not.toBeNull();
    memoryRepo.recordFailure({
      canonicalHash: c1!.canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'Evaluation failed: insufficient win rate.',
      hypothesisGraphId: p1!,
      createdAt: 2000,
    });

    // Step 2: validateAndPersist the exact same graph1 → skipped, no insert
    const { result: r2, persistedId: p2 } = validator.validateAndPersist(graph1, 3000);
    expect(r2.kind).toBe('skipped');
    expect(p2).toBeNull(); // no new row
    expect(hypothesisRepo.count()).toBe(1); // still 1

    // Step 3: validateAndPersist a near-identical graph (different slow param)
    const graph2 = validGraph({
      signals: [{ type: 'ema_cross', params: { fast: 8, slow: 34 } }],
    });
    const { result: r3, persistedId: p3 } = validator.validateAndPersist(graph2, 4000);
    expect(r3.kind).toBe('validated');
    expect(p3).toBeGreaterThan(0);
    expect(p3).not.toBe(p1);
    expect(hypothesisRepo.count()).toBe(2);

    // Step 4: record failure for graph2 and confirm the cycle works for both hashes
    const c3 = r3.kind === 'validated' ? r3.canonical : null;
    expect(c3).not.toBeNull();
    memoryRepo.recordFailure({
      canonicalHash: c3!.canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'Evaluation failed: high drawdown.',
      hypothesisGraphId: p3!,
      createdAt: 5000,
    });

    // Step 5: repeat graph2 → skipped
    const { result: r4 } = validator.validateAndPersist(graph2, 6000);
    expect(r4.kind).toBe('skipped');

    // Memory ledger has 2 entries (graph1 + graph2)
    expect(memoryRepo.count()).toBe(2);

    // Step 6: repeat graph1 → still skipped
    const { result: r5 } = validator.validateAndPersist(graph1, 7000);
    expect(r5.kind).toBe('skipped');

    // Ledger still has 2 entries (no duplicates)
    expect(memoryRepo.count()).toBe(2);
  });

  // ── 5. Different reason codes produce different skip reason codes ──
  //
  // Both graphs are structurally VALID — the memory ledger status determines
  // which reason code appears in the skip verdict.
  it('produces ExactRejectedMatch vs ExactFailureMatch based on ledger status', () => {
    const { hypothesisRepo, memoryRepo, validator } = createFixture();

    // Graph A: validated with Rejected status in memory ledger
    const graphA = validGraph({ metadata: { test: 'A' } });
    const { result: ra, persistedId: pa } = validator.validateAndPersist(graphA, 1000);
    expect(ra.kind).toBe('validated');

    const ca = ra.kind === 'validated' ? ra.canonical : null;
    expect(ca).not.toBeNull();
    memoryRepo.recordFailure({
      canonicalHash: ca!.canonicalHash,
      status: HypothesisMemoryStatus.Rejected,
      reasonCode: HypothesisValidationReasonCode.ExactRejectedMatch,
      reasonMessage: 'Rejected by policy: hypothesis outside allowed parameter range.',
      hypothesisGraphId: pa!,
      createdAt: 2000,
    });

    // Graph B: validated with Failed status in memory ledger
    const graphB = validGraph({ metadata: { test: 'B' } });
    const { result: rb, persistedId: pb } = validator.validateAndPersist(graphB, 3000);
    expect(rb.kind).toBe('validated');

    const cb = rb.kind === 'validated' ? rb.canonical : null;
    expect(cb).not.toBeNull();
    memoryRepo.recordFailure({
      canonicalHash: cb!.canonicalHash,
      status: HypothesisMemoryStatus.Failed,
      reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
      reasonMessage: 'Failed during walk-forward evaluation.',
      hypothesisGraphId: pb!,
      createdAt: 4000,
    });

    // Repeat graph A → ExactRejectedMatch
    const skipA = validator.validate(graphA);
    expect(skipA.kind).toBe('skipped');
    if (skipA.kind === 'skipped') {
      expect(skipA.reasons[0]!.reasonCode).toBe(
        HypothesisValidationReasonCode.ExactRejectedMatch,
      );
      expect(skipA.reasons[0]!.reasonMessage).toContain('Rejected');
    }

    // Repeat graph B → ExactFailureMatch
    const skipB = validator.validate(graphB);
    expect(skipB.kind).toBe('skipped');
    if (skipB.kind === 'skipped') {
      expect(skipB.reasons[0]!.reasonCode).toBe(
        HypothesisValidationReasonCode.ExactFailureMatch,
      );
      expect(skipB.reasons[0]!.reasonMessage).toContain('Failed');
    }

    // Memory ledger has 2 entries (A + B)
    expect(memoryRepo.count()).toBe(2);
  });
});
