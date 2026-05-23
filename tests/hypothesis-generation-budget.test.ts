import { describe, expect, it } from 'vitest';

import {
  applyGenerationOutcomeToBudget,
  decideGenerationBudget,
  initialBudgetState,
  resolveBudgetPolicy,
  summarizeBudgetAttempts,
} from '../src/research/hypothesis-generation-budget.js';
import { GenerationReasonCode, GenerationVerdict } from '../src/types/runtime.js';

describe('hypothesis-generation-budget', () => {
  it('accepts generation while under both budgets and increments llm call state first', () => {
    const decision = decideGenerationBudget(
      { maxAcceptedCandidates: 2, maxLlmCalls: 3 },
      initialBudgetState(),
    );

    expect(decision.kind).toBe('accepted');
    if (decision.kind === 'accepted') {
      expect(decision.state).toEqual({ acceptedCandidates: 0, llmCalls: 1 });
    }
  });

  it('skips generation with persisted provider_disallowed reason when llm-call budget is exhausted', () => {
    const decision = decideGenerationBudget(
      { maxAcceptedCandidates: 5, maxLlmCalls: 1 },
      { acceptedCandidates: 0, llmCalls: 1 },
    );

    expect(decision.kind).toBe('skipped');
    if (decision.kind === 'skipped') {
      expect(decision.reason.reasonCode).toBe(GenerationReasonCode.ProviderDisallowed);
      expect(decision.reason.reasonMessage).toContain('LLM call budget exhausted');
    }
  });

  it('skips generation when candidate budget is exhausted before expensive evaluation', () => {
    const decision = decideGenerationBudget(
      { maxAcceptedCandidates: 1, maxLlmCalls: 5 },
      { acceptedCandidates: 1, llmCalls: 1 },
    );

    expect(decision.kind).toBe('skipped');
    if (decision.kind === 'skipped') {
      expect(decision.reason.reasonCode).toBe(GenerationReasonCode.ProviderDisallowed);
      expect(decision.reason.reasonMessage).toContain('Candidate budget exhausted');
    }
  });

  it('increments accepted candidate count only after an accepted generation outcome', () => {
    const state = applyGenerationOutcomeToBudget(
      { acceptedCandidates: 0, llmCalls: 1 },
      { verdict: GenerationVerdict.Accepted },
    );

    expect(state).toEqual({ acceptedCandidates: 1, llmCalls: 1 });
  });

  it('summarizes accepted, skipped, and exhausted attempts for overnight audit metadata', () => {
    const summary = summarizeBudgetAttempts(
      { maxAcceptedCandidates: 2, maxLlmCalls: 3 },
      [
        { verdict: GenerationVerdict.Accepted, reasons: [] },
        {
          verdict: GenerationVerdict.Skipped,
          reasons: [{ reasonCode: GenerationReasonCode.DuplicateSkipped, reasonMessage: 'duplicate' }],
        },
        {
          verdict: GenerationVerdict.Skipped,
          reasons: [{ reasonCode: GenerationReasonCode.ProviderDisallowed, reasonMessage: 'budget exhausted' }],
        },
      ],
    );

    expect(summary.acceptedAttempts).toBe(1);
    expect(summary.skippedAttempts).toBe(2);
    expect(summary.acceptedCandidateCount).toBe(1);
    expect(summary.llmCallCount).toBe(3);
    expect(summary.exhausted).toBe(true);
    expect(summary.skipReasonCounts[GenerationReasonCode.DuplicateSkipped]).toBe(1);
    expect(summary.skipReasonCounts[GenerationReasonCode.ProviderDisallowed]).toBe(1);
  });

  it('treats omitted policy as unbounded', () => {
    const policy = resolveBudgetPolicy();
    expect(policy.maxAcceptedCandidates).toBe(Number.POSITIVE_INFINITY);
    expect(policy.maxLlmCalls).toBe(Number.POSITIVE_INFINITY);
  });
});
