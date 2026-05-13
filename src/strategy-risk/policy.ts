// ── India NSE EQ Strategy Policy ──
// Deterministic strategy identity, policy config, and evaluation function.
// This is the pure-domain authority layer between raw proposal acceptance and
// execution. It receives proposal + market data and returns either an approved
// candidate (with derived risk/sizing) or a refusal (with machine-readable reasons).

import {
  type QuoteSnapshot,
  type StrategyDecisionReason,
  StrategyDecisionReasonCode,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Policy config
// ---------------------------------------------------------------------------

/** Configuration for the active strategy policy. */
export interface IndiaStrategyPolicyConfig {
  /** Stable strategy identifier (e.g. 'india-nse-eq-v1'). */
  strategyId: string;
  /** Semver-style version (e.g. '1.0.0'). */
  version: string;
  /** Minimum notional value (quantity × reference price) in rupees. */
  minNotional: number;
  /** Maximum loss as a percentage of notional (e.g. 5 = 5%). */
  maxLossPercent: number;
  /** Supported exchange segments (e.g. ['NSE']). */
  supportedSegments: string[];
}

/** Default India NSE EQ strategy policy singleton. */
export const INDIA_NSE_EQ_STRATEGY: IndiaStrategyPolicyConfig = {
  strategyId: 'india-nse-eq-v1',
  version: '1.0.0',
  minNotional: 10_000,
  maxLossPercent: 5,
  supportedSegments: ['NSE'],
};

// ---------------------------------------------------------------------------
// Quote staleness threshold
// ---------------------------------------------------------------------------

/**
 * Maximum acceptable quote age in milliseconds before it is considered stale.
 * Matches the universe policy threshold (120s = 2 minutes).
 */
export const MAX_QUOTE_STALENESS_MS = 120_000;

// ---------------------------------------------------------------------------
// Evaluation result type
// ---------------------------------------------------------------------------

/** Attached risk metadata for an approved strategy evaluation. */
export interface StrategyRiskComputation {
  riskNotional: number;
  riskSizingBasis: string;
  riskMaxLossRupees: number | null;
  riskStopDistance: number | null;
  riskExposureTag: string;
}

/** Result of a successful (approved) strategy evaluation. */
export interface StrategyApprovedEvaluation {
  approved: true;
  /** Lot-size-rounded deterministic quantity. */
  quantity: number;
  /** Deterministic limit price (carried from proposal). */
  price: number | null;
  /** Deterministic trigger price (carried from proposal). */
  triggerPrice: number | null;
  /** Deterministic order type (carried from proposal). */
  orderType: string;
  riskNotional: number;
  riskSizingBasis: string;
  riskMaxLossRupees: number | null;
  riskStopDistance: number | null;
  riskExposureTag: string;
}

/** Result of a refused strategy evaluation with ordered reasons. */
export interface StrategyRefusedEvaluation {
  approved: false;
  /** Ordered reasons for the refusal (1+). */
  reasons: StrategyDecisionReason[];
}

/** Discriminated union of strategy evaluation results. */
export type StrategyEvaluation = StrategyApprovedEvaluation | StrategyRefusedEvaluation;

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** Instrument metadata required for strategy evaluation. */
export interface StrategyInstrumentMeta {
  lotSize: number;
  tickSize: number | null;
}

/** Parameters for the evaluateProposal function. */
export interface EvaluateProposalParams {
  /** Source proposal exchange (e.g. 'NSE'). */
  exchange: string;
  /** Source proposal trading symbol (e.g. 'RELIANCE'). */
  tradingsymbol: string;
  /** Source proposal trade side. */
  side: string;
  /** Source proposal product (e.g. 'MIS'). */
  product: string;
  /** Source proposal order quantity (positive integer). */
  quantity: number;
  /** Source proposal limit price, or null. */
  price: number | null;
  /** Source proposal trigger price, or null. */
  triggerPrice: number | null;
  /** Source proposal order type. */
  orderType: string;
  /** Latest quote snapshot for the instrument, or null if unavailable. */
  quote: QuoteSnapshot | null;
  /** Instrument metadata (lot size, tick size), or null if unavailable. */
  instrumentMeta: StrategyInstrumentMeta | null;
  /** Whether the symbol is in the bounded universe allowlist. */
  isUniverseEligible: boolean;
  /** Active strategy policy config. */
  policy: IndiaStrategyPolicyConfig;
}

// ---------------------------------------------------------------------------
// evaluateProposal
// ---------------------------------------------------------------------------

/**
 * Evaluate a single proposal against the strategy policy.
 *
 * Decision logic (ordered — first failure is the refusal reason):
 * 1. UnsupportedSegment — if the exchange is not in supportedSegments
 * 2. NotInUniverse — if the symbol is not in the bounded allowlist
 * 3. MissingQuoteData — if no quote snapshot is available
 * 4. StaleQuoteData — if the quote snapshot is older than MAX_QUOTE_STALENESS_MS
 * 5. MissingInstrumentMetadata — if lot size is missing
 * 6. ZeroQuantityAfterRounding — if lot-size rounding produces zero
 * 7. BelowMinimumNotional — if executable post-rounding notional < minNotional
 * 8. Approved — all checks pass, risk metadata computed
 */
export function evaluateProposal(params: EvaluateProposalParams): StrategyEvaluation {
  const { policy } = params;

  // 1. Check segment support
  if (!policy.supportedSegments.includes(params.exchange)) {
    return refused(StrategyDecisionReasonCode.UnsupportedSegment, `Segment ${params.exchange} is not supported by strategy ${policy.strategyId}`);
  }

  // 2. Check universe membership
  if (!params.isUniverseEligible) {
    return refused(StrategyDecisionReasonCode.NotInUniverse, `${params.tradingsymbol} is not in the bounded universe allowlist`);
  }

  // 3. Check quote availability
  if (!params.quote) {
    return refused(StrategyDecisionReasonCode.MissingQuoteData, `No quote available for ${params.tradingsymbol}`);
  }

  const now = Date.now();

  // 4. Check quote staleness
  const stalenessMs = now - params.quote.receivedAt;
  if (stalenessMs > MAX_QUOTE_STALENESS_MS) {
    return refused(
      StrategyDecisionReasonCode.StaleQuoteData,
      `Quote for ${params.tradingsymbol} is ${stalenessMs}ms stale (max ${MAX_QUOTE_STALENESS_MS}ms)`,
    );
  }

  // 5. Check instrument metadata (lot size)
  if (!params.instrumentMeta || !params.instrumentMeta.lotSize || params.instrumentMeta.lotSize <= 0) {
    return refused(
      StrategyDecisionReasonCode.MissingInstrumentMetadata,
      `Missing or invalid lot size for ${params.tradingsymbol}`,
    );
  }

  // Determine reference price for sizing
  const referencePrice = params.quote.lastPrice;
  if (!referencePrice || referencePrice <= 0) {
    return refused(
      StrategyDecisionReasonCode.MissingQuoteData,
      `Quote for ${params.tradingsymbol} has no valid last price`,
    );
  }

  // 6. Round quantity to lot size before any notional checks
  const lotSize = params.instrumentMeta.lotSize;
  const lotRoundedQuantity = Math.floor(params.quantity / lotSize) * lotSize;
  if (lotRoundedQuantity <= 0) {
    return refused(
      StrategyDecisionReasonCode.ZeroQuantityAfterRounding,
      `Quantity ${params.quantity} rounds to 0 after lot-size (${lotSize}) rounding for ${params.tradingsymbol}`,
    );
  }

  // 7. Compute executable notional and check minimum after rounding
  const executableNotional = lotRoundedQuantity * referencePrice;
  if (executableNotional < policy.minNotional) {
    return refused(
      StrategyDecisionReasonCode.BelowMinimumNotional,
      `Executable notional ${executableNotional.toFixed(2)} is below minimum ${policy.minNotional} for ${params.tradingsymbol} after lot-size rounding`,
    );
  }

  // 8. Approved — compute risk metadata from executable quantity
  const maxLossRupees = executableNotional * (policy.maxLossPercent / 100);

  return {
    approved: true,
    quantity: lotRoundedQuantity,
    price: params.price,
    triggerPrice: params.triggerPrice,
    orderType: params.orderType,
    riskNotional: executableNotional,
    riskSizingBasis: 'last_price',
    riskMaxLossRupees: maxLossRupees,
    riskStopDistance: null,
    riskExposureTag: 'intraday',
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────

function refused(code: StrategyDecisionReasonCode, message: string): StrategyRefusedEvaluation {
  return {
    approved: false,
    reasons: [{ reasonCode: code, reasonMessage: message }],
  };
}
