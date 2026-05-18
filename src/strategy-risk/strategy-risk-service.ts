// ── Strategy Risk Service ──
// The deterministic authority layer between raw proposal acceptance and execution.
// Evaluates proposals against policy rules, computes sizing/risk, and returns
// decisions (approved candidates or refusal evidence).
//
// Implements the StrategyRiskPort interface from strategy-risk-supervisor.

import {
  StrategyDecisionStatus,
  type StrategyDecisionRow,
  type NewStrategyDecision,
  type StrategyDecisionReason,
} from '../types/runtime.js';
import type {
  StrategyEvaluationInput,
  StrategyEvaluationResult,
  StrategyRiskPort,
} from '../strategy-risk/strategy-risk-supervisor.js';
import { BrokerRepository } from '../persistence/broker-repo.js';
import { ProposalRepository } from '../persistence/proposal-repo.js';
import { StrategyDecisionRepository } from '../persistence/strategy-decision-repo.js';
import { StrategyRunRepository } from '../persistence/strategy-run-repo.js';
import { UniverseService } from '../universe/universe-service.js';
import {
  type IndiaStrategyPolicyConfig,
  INDIA_NSE_EQ_STRATEGY,
  evaluateProposal,
} from './policy.js';

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface StrategyRiskServiceOptions {
  strategyRepo: StrategyDecisionRepository;
  brokerRepo: BrokerRepository;
  universeService: UniverseService;
  proposalRepo?: ProposalRepository;
  strategyRunRepo?: StrategyRunRepository;
  policy?: IndiaStrategyPolicyConfig;
}

// ---------------------------------------------------------------------------
// StrategyRiskService
// ---------------------------------------------------------------------------

export class StrategyRiskService implements StrategyRiskPort {
  private readonly _strategyRepo: StrategyDecisionRepository;
  private readonly _brokerRepo: BrokerRepository;
  private readonly _universeService: UniverseService;
  private readonly _proposalRepo?: ProposalRepository;
  private readonly _strategyRunRepo?: StrategyRunRepository;
  private readonly _policy: IndiaStrategyPolicyConfig;

  constructor(options: StrategyRiskServiceOptions) {
    this._strategyRepo = options.strategyRepo;
    this._brokerRepo = options.brokerRepo;
    this._universeService = options.universeService;
    this._proposalRepo = options.proposalRepo;
    this._strategyRunRepo = options.strategyRunRepo;
    this._policy = options.policy ?? INDIA_NSE_EQ_STRATEGY;
  }

  /** Return the active strategy policy config. */
  getPolicy(): IndiaStrategyPolicyConfig {
    return this._policy;
  }

  /**
   * Evaluate a single proposal against the strategy policy (StrategyRiskPort).
   *
   * Loads quote + instrument metadata + universe eligibility, calls the
   * deterministic policy evaluation, and returns the decision + reasons
   * WITHOUT persisting. The caller (StrategyRiskSupervisor) is responsible
   * for persistence.
   */
  async evaluateProposal(input: StrategyEvaluationInput): Promise<StrategyEvaluationResult> {
    const { exchange, tradingsymbol, quote, instrument } = input;

    const instrumentMeta = instrument
      ? { lotSize: instrument.lotSize, tickSize: instrument.tickSize }
      : null;

    // Check universe eligibility via the bounded universe service
    const isUniverseEligible = this._universeService.isSymbolEligible(tradingsymbol, exchange);

    // Recover India research evidence from the strategy run artifact
    const researchEvidence = this._recoverResearchEvidence(input.proposalAttemptId);

    // Call deterministic policy evaluation
    const evaluation = evaluateProposal({
      exchange,
      tradingsymbol,
      side: input.side,
      product: input.product,
      quantity: input.quantity,
      price: input.price,
      triggerPrice: input.triggerPrice,
      orderType: input.orderType,
      quote,
      instrumentMeta,
      isUniverseEligible,
      policy: this._policy,
    });

    if (!evaluation.approved) {
      return {
        decision: {
          proposalAttemptId: input.proposalAttemptId,
          decisionStatus: StrategyDecisionStatus.Refused,
          strategyId: this._policy.strategyId,
          strategyVersion: this._policy.version,
          decidedAt: Date.now(),
          exchange: input.exchange,
          tradingsymbol: input.tradingsymbol,
          side: input.side,
          product: input.product,
          quantity: input.quantity,
          price: input.price,
          triggerPrice: input.triggerPrice,
          orderType: input.orderType,
          quoteLastPrice: quote?.lastPrice ?? null,
          quoteBid: quote?.bid ?? null,
          quoteAsk: quote?.ask ?? null,
          quoteVolume: quote?.volume ?? null,
          quoteReceivedAt: quote?.receivedAt ?? null,
          riskNotional: null,
          riskSizingBasis: '',
          riskMaxLossRupees: null,
          riskStopDistance: null,
          riskExposureTag: null,
          indiaResearchEvidence: researchEvidence,
        },
        reasons: evaluation.reasons,
      };
    }

    return {
      decision: {
        proposalAttemptId: input.proposalAttemptId,
        decisionStatus: StrategyDecisionStatus.Approved,
        strategyId: this._policy.strategyId,
        strategyVersion: this._policy.version,
        decidedAt: Date.now(),
        exchange: input.exchange,
        tradingsymbol: input.tradingsymbol,
        side: input.side,
        product: input.product,
        quantity: evaluation.quantity,
        price: evaluation.price,
        triggerPrice: evaluation.triggerPrice,
        orderType: evaluation.orderType,
        quoteLastPrice: quote?.lastPrice ?? null,
        quoteBid: quote?.bid ?? null,
        quoteAsk: quote?.ask ?? null,
        quoteVolume: quote?.volume ?? null,
        quoteReceivedAt: quote?.receivedAt ?? null,
        riskNotional: evaluation.riskNotional,
        riskSizingBasis: evaluation.riskSizingBasis,
        riskMaxLossRupees: evaluation.riskMaxLossRupees,
        riskStopDistance: evaluation.riskStopDistance,
        riskExposureTag: evaluation.riskExposureTag,
        indiaResearchEvidence: researchEvidence,
      },
      reasons: [],
    };
  }

  /**
   * Synchronous convenience method: evaluate a ProposalAttemptRow directly,
   * persisting the decision via StrategyDecisionRepository.
   *
   * This is the primary entry point for direct (non-supervisor) consumers.
   * Returns the full persisted StrategyDecisionRow.
   */
  evaluateProposalRow(proposal: import('../types/runtime.js').ProposalAttemptRow): StrategyDecisionRow {
    const quote = this._brokerRepo.getQuote(proposal.exchange, proposal.tradingsymbol);
    const instrument = this._brokerRepo.getInstrument(proposal.exchange, proposal.tradingsymbol);

    const input: StrategyEvaluationInput = {
      proposalAttemptId: proposal.id,
      exchange: proposal.exchange,
      tradingsymbol: proposal.tradingsymbol,
      instrumentToken: proposal.instrumentToken,
      side: proposal.side,
      product: proposal.product,
      quantity: proposal.quantity,
      price: proposal.price,
      triggerPrice: proposal.triggerPrice,
      orderType: proposal.orderType,
      quote,
      instrument,
    };

    return this._evaluateSync(input);
  }

  /**
   * Evaluate and persist decisions for all accepted proposals without
   * strategy decisions. Uses ProposalRepository for reading unprocessed
   * proposals and StrategyDecisionRepository for persisting results.
   *
   * Returns the full StrategyDecisionRow for all processed proposals.
   * Requires proposalRepo to be provided in constructor.
   */
  processAllPendingProposals(): StrategyDecisionRow[] {
    if (!this._proposalRepo) {
      throw new Error('processAllPendingProposals requires proposalRepo in constructor');
    }

    const pendingProposals = this._proposalRepo.getApprovedUnprocessedAttempts();
    const results: StrategyDecisionRow[] = [];

    for (const proposal of pendingProposals) {
      try {
        // Build input from the proposal row
        const quote = this._brokerRepo.getQuote(proposal.exchange, proposal.tradingsymbol);
        const instrument = this._brokerRepo.getInstrument(proposal.exchange, proposal.tradingsymbol);

        const input: StrategyEvaluationInput = {
          proposalAttemptId: proposal.id,
          exchange: proposal.exchange,
          tradingsymbol: proposal.tradingsymbol,
          instrumentToken: proposal.instrumentToken,
          side: proposal.side,
          product: proposal.product,
          quantity: proposal.quantity,
          price: proposal.price,
          triggerPrice: proposal.triggerPrice,
          orderType: proposal.orderType,
          quote,
          instrument,
        };

        // Call evaluate synchronously — it's actually sync despite the port
        // using async, so we inline.
        const result = this._evaluateSync(input);
        results.push(result);
      } catch (err) {
        console.error(
          `[strategy-risk] Failed to evaluate proposal ${proposal.id} (${proposal.tradingsymbol}):`,
          err,
        );
      }
    }

    return results;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /**
   * Recover India research evidence for a proposal from its strategy run
   * candidate, if a strategy run repo is wired.
   *
   * Looks up the strategy run that contains a candidate linked to this
   * proposal attempt, and returns the research evidence if present.
   * Returns null when the run repo is not wired, no run is found, or
   * no research evidence exists.
   */
  private _recoverResearchEvidence(
    proposalAttemptId: number,
  ): import('../types/runtime.js').IndiaResearchDecisionEvidence | null {
    if (!this._strategyRunRepo) return null;

    try {
      const run = this._strategyRunRepo.getRunByProposalAttemptId(proposalAttemptId);
      if (!run) return null;

      // Find the candidate linked to this proposal attempt
      const candidate = run.candidates.find(c => c.proposalAttemptId === proposalAttemptId);
      if (!candidate || !candidate.indiaResearchEvidence) return null;

      const candEvidence = candidate.indiaResearchEvidence;

      // Convert candidate-level evidence to decision-level evidence
      return {
        summary: candEvidence.summary,
        tags: candEvidence.tags,
        freshnessMs: candEvidence.freshnessMs,
        influenceContext: candEvidence.influenceScore != null
          ? `Research influence score: ${candEvidence.influenceScore.toFixed(3)}`
          : null,
      };
    } catch {
      // Best-effort — recovery failure should not crash the decision pipeline
      return null;
    }
  }

  /**
   * Synchronous version of evaluateProposal that also persists.
   * Used by processAllPendingProposals for batch processing.
   */
  private _evaluateSync(input: StrategyEvaluationInput): StrategyDecisionRow {
    const { instrument, quote } = input;

    const instrumentMeta = instrument
      ? { lotSize: instrument.lotSize, tickSize: instrument.tickSize }
      : null;

    const isUniverseEligible = this._universeService.isSymbolEligible(
      input.tradingsymbol,
      input.exchange,
    );

    // Recover India research evidence from the strategy run artifact
    const researchEvidence = this._recoverResearchEvidence(input.proposalAttemptId);

    const evaluation = evaluateProposal({
      exchange: input.exchange,
      tradingsymbol: input.tradingsymbol,
      side: input.side,
      product: input.product,
      quantity: input.quantity,
      price: input.price,
      triggerPrice: input.triggerPrice,
      orderType: input.orderType,
      quote,
      instrumentMeta,
      isUniverseEligible,
      policy: this._policy,
    });

    if (!evaluation.approved) {
      const decision: NewStrategyDecision = {
        proposalAttemptId: input.proposalAttemptId,
        decisionStatus: StrategyDecisionStatus.Refused,
        strategyId: this._policy.strategyId,
        strategyVersion: this._policy.version,
        decidedAt: Date.now(),
        exchange: input.exchange,
        tradingsymbol: input.tradingsymbol,
        side: input.side,
        product: input.product,
        quantity: input.quantity,
        price: input.price,
        triggerPrice: input.triggerPrice,
        orderType: input.orderType,
        quoteLastPrice: quote?.lastPrice ?? null,
        quoteBid: quote?.bid ?? null,
        quoteAsk: quote?.ask ?? null,
        quoteVolume: quote?.volume ?? null,
        quoteReceivedAt: quote?.receivedAt ?? null,
        riskNotional: null,
        riskSizingBasis: '',
        riskMaxLossRupees: null,
        riskStopDistance: null,
        riskExposureTag: null,
        indiaResearchEvidence: researchEvidence,
      };

      return this._strategyRepo.insertDecisionWithReasons(decision, evaluation.reasons);
    }

    const decision: NewStrategyDecision = {
      proposalAttemptId: input.proposalAttemptId,
      decisionStatus: StrategyDecisionStatus.Approved,
      strategyId: this._policy.strategyId,
      strategyVersion: this._policy.version,
      decidedAt: Date.now(),
      exchange: input.exchange,
      tradingsymbol: input.tradingsymbol,
      side: input.side,
      product: input.product,
      quantity: evaluation.quantity,
      price: evaluation.price,
      triggerPrice: evaluation.triggerPrice,
      orderType: evaluation.orderType,
      quoteLastPrice: quote?.lastPrice ?? null,
      quoteBid: quote?.bid ?? null,
      quoteAsk: quote?.ask ?? null,
      quoteVolume: quote?.volume ?? null,
      quoteReceivedAt: quote?.receivedAt ?? null,
      riskNotional: evaluation.riskNotional,
      riskSizingBasis: evaluation.riskSizingBasis,
      riskMaxLossRupees: evaluation.riskMaxLossRupees,
      riskStopDistance: evaluation.riskStopDistance,
      riskExposureTag: evaluation.riskExposureTag,
      indiaResearchEvidence: researchEvidence,
    };

    return this._strategyRepo.insertDecisionWithReasons(decision, []);
  }
}
