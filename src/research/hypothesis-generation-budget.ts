import {
  GenerationReasonCode,
  type GenerationReason,
  type HypothesisGenerationAttemptWithReasons,
} from '../types/runtime.js';

export interface OvernightBudgetPolicy {
  maxAcceptedCandidates?: number;
  maxLlmCalls?: number;
}

export interface OvernightBudgetState {
  acceptedCandidates: number;
  llmCalls: number;
}

export interface BudgetDecisionAccepted {
  kind: 'accepted';
  state: OvernightBudgetState;
}

export interface BudgetDecisionSkipped {
  kind: 'skipped';
  reason: GenerationReason;
  state: OvernightBudgetState;
}

export type BudgetDecision = BudgetDecisionAccepted | BudgetDecisionSkipped;

export interface BudgetSummary {
  policy: Required<OvernightBudgetPolicy>;
  acceptedAttempts: number;
  skippedAttempts: number;
  acceptedCandidateCount: number;
  llmCallCount: number;
  exhausted: boolean;
  skipReasonCounts: Record<string, number>;
}

const DEFAULT_POLICY: Required<OvernightBudgetPolicy> = {
  maxAcceptedCandidates: Number.POSITIVE_INFINITY,
  maxLlmCalls: Number.POSITIVE_INFINITY,
};

export function resolveBudgetPolicy(policy?: OvernightBudgetPolicy): Required<OvernightBudgetPolicy> {
  return {
    maxAcceptedCandidates: normalizeLimit(policy?.maxAcceptedCandidates),
    maxLlmCalls: normalizeLimit(policy?.maxLlmCalls),
  };
}

export function initialBudgetState(): OvernightBudgetState {
  return { acceptedCandidates: 0, llmCalls: 0 };
}

export function decideGenerationBudget(
  policy: OvernightBudgetPolicy | undefined,
  state: OvernightBudgetState,
): BudgetDecision {
  const resolved = resolveBudgetPolicy(policy);

  if (state.llmCalls >= resolved.maxLlmCalls) {
    return {
      kind: 'skipped',
      state: { ...state },
      reason: {
        reasonCode: GenerationReasonCode.ProviderDisallowed,
        reasonMessage: `LLM call budget exhausted before generation start (${state.llmCalls}/${resolved.maxLlmCalls}).`,
      },
    };
  }

  if (state.acceptedCandidates >= resolved.maxAcceptedCandidates) {
    return {
      kind: 'skipped',
      state: { ...state },
      reason: {
        reasonCode: GenerationReasonCode.ProviderDisallowed,
        reasonMessage: `Candidate budget exhausted before generation start (${state.acceptedCandidates}/${resolved.maxAcceptedCandidates}).`,
      },
    };
  }

  return {
    kind: 'accepted',
    state: {
      acceptedCandidates: state.acceptedCandidates,
      llmCalls: state.llmCalls + 1,
    },
  };
}

export function applyGenerationOutcomeToBudget(
  state: OvernightBudgetState,
  attempt: Pick<HypothesisGenerationAttemptWithReasons, 'verdict'>,
): OvernightBudgetState {
  if (attempt.verdict === 'accepted') {
    return {
      acceptedCandidates: state.acceptedCandidates + 1,
      llmCalls: state.llmCalls,
    };
  }

  return { ...state };
}

export function summarizeBudgetAttempts(
  policy: OvernightBudgetPolicy | undefined,
  attempts: Array<Pick<HypothesisGenerationAttemptWithReasons, 'verdict' | 'reasons'>>,
): BudgetSummary {
  const resolved = resolveBudgetPolicy(policy);
  const skipReasonCounts: Record<string, number> = {};

  let acceptedAttempts = 0;
  let skippedAttempts = 0;
  let acceptedCandidateCount = 0;

  for (const attempt of attempts) {
    if (attempt.verdict === 'accepted') {
      acceptedAttempts += 1;
      acceptedCandidateCount += 1;
      continue;
    }

    if (attempt.verdict === 'skipped') {
      skippedAttempts += 1;
      for (const reason of attempt.reasons) {
        skipReasonCounts[reason.reasonCode] = (skipReasonCounts[reason.reasonCode] ?? 0) + 1;
      }
    }
  }

  const llmCallCount = acceptedAttempts + skippedAttempts;
  const exhausted = llmCallCount >= resolved.maxLlmCalls || acceptedCandidateCount >= resolved.maxAcceptedCandidates;

  return {
    policy: resolved,
    acceptedAttempts,
    skippedAttempts,
    acceptedCandidateCount,
    llmCallCount,
    exhausted,
    skipReasonCounts,
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value == null) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Budget limits must be finite non-negative numbers when provided.');
  }
  return value;
}
