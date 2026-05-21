// ── PaperExecutionPolicy — bounded paper evaluation using local quote data only ──
//
// Decides fill vs refuse/reject without broker network calls.
// Uses only persisted/local QuoteSnapshot and InstrumentRecord data.
//
// Fill eligibility rules:
// - Must have a non-stale quote with a valid price for the trade side
// - Buy  → use ask price (fallback: lastPrice)
// - Sell → use bid price (fallback: lastPrice)
// - Market orders: fill at the prevailing side price
// - Limit orders: fill only if limit price crosses the side price
// - Missing quote, missing instrument metadata, or zero/negative prices → refuse
//
// Never fabricates fills. Every outcome has a machine-readable reason attached.

import {
  ExecutionOutcomeCode,
  ExecutionRefusalCode,
  type ExecutionRefusalReason,
  type StrategyApprovedCandidate,
} from '../types/runtime.js';
import type { QuoteSnapshot } from '../integrations/broker/types.js';
import type { InstrumentRecord } from '../integrations/broker/types.js';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/** Result of a single paper evaluation. */
export interface PaperEvaluationResult {
  /** Whether the paper broker can simulate a fill. */
  readonly canFill: boolean;
  /** The simulated gross executed fill price (null when cannot fill). */
  readonly fillPrice: number | null;
  /** Reference quote-side price before simulated slippage. */
  readonly referencePrice?: number | null;
  /** Slippage applied per unit in price terms. */
  readonly slippagePerUnit?: number;
  /** Aggregate slippage applied across the fill quantity. */
  readonly slippageAmount?: number;
  /** Aggregate transaction fees/charges for the fill. */
  readonly fees?: number;
  /** Outcome code for the execution attempt. */
  readonly outcomeCode: ExecutionOutcomeCode;
  /** Human-readable message. */
  readonly message: string;
  /** Machine-readable refusal reasons (empty when canFill is true). */
  readonly refusalReasons: ExecutionRefusalReason[];
  /** The simulated broker order ID (non-null when canFill is true). */
  readonly simulatedBrokerOrderId: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Staleness threshold for paper evaluation (5 minutes). */
const PAPER_QUOTE_STALENESS_MS = 5 * 60 * 1000;
/** Adverse slippage applied to market-like paper fills (1 basis point). */
const PAPER_SLIPPAGE_RATE = 0.0001;
/** Transaction charges applied to every paper fill (0.5 basis points). */
const PAPER_FEE_RATE = 0.00005;

// ---------------------------------------------------------------------------
// PaperExecutionPolicy
// ---------------------------------------------------------------------------

export class PaperExecutionPolicy {
  readonly label = 'paper-execution-policy';

  constructor(private readonly _now: () => number = () => Date.now()) {}

  /**
   * Evaluate whether a strategy-approved candidate can be paper-filled using
   * only local quote and instrument data.
   *
   * @param candidate - The strategy-approved trade candidate.
   * @param quote - Local quote snapshot (may be null if none available).
   * @param instrument - Local instrument metadata (may be null if missing).
   * @returns A structured evaluation result.
   */
  evaluate(
    candidate: StrategyApprovedCandidate,
    quote: QuoteSnapshot | null,
    instrument: InstrumentRecord | null,
  ): PaperEvaluationResult {
    // ── Quote availability check ──────────────────────────────────────────
    if (quote === null) {
      return this._refuse(
        ExecutionRefusalCode.StaleOrMissingQuote,
        `No quote snapshot available for ${candidate.exchange}:${candidate.tradingsymbol}`,
      );
    }

    // ── Instrument metadata check ─────────────────────────────────────────
    if (instrument === null) {
      return this._refuse(
        ExecutionRefusalCode.MissingInstrumentData,
        `No instrument record available for ${candidate.exchange}:${candidate.tradingsymbol}`,
      );
    }

    // ── Quote staleness check ─────────────────────────────────────────────
    const stalenessMs = this._now() - quote.receivedAt;
    if (stalenessMs > PAPER_QUOTE_STALENESS_MS) {
      return this._refuse(
        ExecutionRefusalCode.StaleOrMissingQuote,
        `Quote snapshot is stale (${Math.round(stalenessMs / 1000)}s old, threshold ${PAPER_QUOTE_STALENESS_MS / 1000}s)`,
      );
    }

    // ── Side-specific price determination ─────────────────────────────────
    const side = candidate.side?.toLowerCase();

    if (side === 'buy') {
      return this._evaluateBuy(candidate, quote, instrument);
    }

    if (side === 'sell') {
      return this._evaluateSell(candidate, quote, instrument);
    }

    return this._refuse(
      ExecutionRefusalCode.StaleOrMissingQuote,
      `Unknown trade side: "${candidate.side}"`,
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Evaluate a buy order. Uses ask price (preferred) or lastPrice.
   * For limit orders, checks if the limit can cross the ask.
   */
  private _evaluateBuy(
    candidate: StrategyApprovedCandidate,
    quote: QuoteSnapshot,
    instrument: InstrumentRecord,
  ): PaperEvaluationResult {
    const prevailingPrice = quote.ask ?? quote.lastPrice ?? null;

    if (prevailingPrice === null || prevailingPrice <= 0) {
      return this._refuse(
        ExecutionRefusalCode.StaleOrMissingQuote,
        `Cannot determine fill price for buy: ask=${quote.ask}, lastPrice=${quote.lastPrice}`,
      );
    }

    const orderType = candidate.orderType?.toUpperCase();
    const isBoundedOrder = orderType === 'LIMIT' || (orderType === 'SL' && candidate.price !== null && candidate.price > 0);
    let fillPrice = prevailingPrice;

    if (isBoundedOrder) {
      const limitPrice = candidate.price;

      if (limitPrice === null || limitPrice <= 0) {
        return this._refuse(
          ExecutionRefusalCode.StaleOrMissingQuote,
          `Limit buy without a valid limit price (price=${candidate.price})`,
        );
      }

      if (limitPrice < prevailingPrice) {
        return this._refuse(
          ExecutionRefusalCode.StaleOrMissingQuote,
          `Buy limit ${limitPrice} is below ask ${prevailingPrice} — order would not fill at current price`,
        );
      }

      fillPrice = Math.min(limitPrice, prevailingPrice);
    } else {
      fillPrice = this._applyAdverseSlippage(prevailingPrice, 'buy', instrument.tickSize);
    }

    const economics = this._computeExecutionEconomics(candidate.quantity, prevailingPrice, fillPrice);
    const simId = `paper-${Date.now()}-${candidate.id}-buy`;
    return {
      canFill: true,
      fillPrice,
      referencePrice: prevailingPrice,
      slippagePerUnit: economics.slippagePerUnit,
      slippageAmount: economics.slippageAmount,
      fees: economics.fees,
      outcomeCode: ExecutionOutcomeCode.PaperSimulated,
      message: `Paper buy ${candidate.quantity} ${candidate.tradingsymbol} at ${fillPrice} (ref=${prevailingPrice}, slip=${economics.slippageAmount.toFixed(2)}, fees=${economics.fees.toFixed(2)})`,
      refusalReasons: [],
      simulatedBrokerOrderId: simId,
    };
  }

  /**
   * Evaluate a sell order. Uses bid price (preferred) or lastPrice.
   * For limit orders, checks if the limit can cross the bid.
   */
  private _evaluateSell(
    candidate: StrategyApprovedCandidate,
    quote: QuoteSnapshot,
    instrument: InstrumentRecord,
  ): PaperEvaluationResult {
    const prevailingPrice = quote.bid ?? quote.lastPrice ?? null;

    if (prevailingPrice === null || prevailingPrice <= 0) {
      return this._refuse(
        ExecutionRefusalCode.StaleOrMissingQuote,
        `Cannot determine fill price for sell: bid=${quote.bid}, lastPrice=${quote.lastPrice}`,
      );
    }

    const orderType = candidate.orderType?.toUpperCase();
    const isBoundedOrder = orderType === 'LIMIT' || (orderType === 'SL' && candidate.price !== null && candidate.price > 0);
    let fillPrice = prevailingPrice;

    if (isBoundedOrder) {
      const limitPrice = candidate.price;

      if (limitPrice === null || limitPrice <= 0) {
        return this._refuse(
          ExecutionRefusalCode.StaleOrMissingQuote,
          `Limit sell without a valid limit price (price=${candidate.price})`,
        );
      }

      if (limitPrice > prevailingPrice) {
        return this._refuse(
          ExecutionRefusalCode.StaleOrMissingQuote,
          `Sell limit ${limitPrice} is above bid ${prevailingPrice} — order would not fill at current price`,
        );
      }

      fillPrice = Math.max(limitPrice, prevailingPrice);
    } else {
      fillPrice = this._applyAdverseSlippage(prevailingPrice, 'sell', instrument.tickSize);
    }

    const economics = this._computeExecutionEconomics(candidate.quantity, prevailingPrice, fillPrice);
    const simId = `paper-${Date.now()}-${candidate.id}-sell`;
    return {
      canFill: true,
      fillPrice,
      referencePrice: prevailingPrice,
      slippagePerUnit: economics.slippagePerUnit,
      slippageAmount: economics.slippageAmount,
      fees: economics.fees,
      outcomeCode: ExecutionOutcomeCode.PaperSimulated,
      message: `Paper sell ${candidate.quantity} ${candidate.tradingsymbol} at ${fillPrice} (ref=${prevailingPrice}, slip=${economics.slippageAmount.toFixed(2)}, fees=${economics.fees.toFixed(2)})`,
      refusalReasons: [],
      simulatedBrokerOrderId: simId,
    };
  }

  private _computeExecutionEconomics(
    quantity: number,
    referencePrice: number,
    fillPrice: number,
  ): { slippagePerUnit: number; slippageAmount: number; fees: number } {
    const slippagePerUnit = +Math.max(Math.abs(fillPrice - referencePrice), 0).toFixed(4);
    const slippageAmount = +(slippagePerUnit * quantity).toFixed(4);
    const fees = +Math.max(fillPrice * quantity * PAPER_FEE_RATE, 0).toFixed(4);
    return { slippagePerUnit, slippageAmount, fees };
  }

  private _applyAdverseSlippage(
    referencePrice: number,
    side: 'buy' | 'sell',
    tickSize: number | null | undefined,
  ): number {
    const raw = side === 'buy'
      ? referencePrice * (1 + PAPER_SLIPPAGE_RATE)
      : referencePrice * (1 - PAPER_SLIPPAGE_RATE);
    return this._roundToTick(raw, tickSize ?? 0.05, side === 'buy' ? 'up' : 'down');
  }

  private _roundToTick(
    price: number,
    tickSize: number,
    direction: 'up' | 'down',
  ): number {
    if (!(tickSize > 0)) return +price.toFixed(4);
    const steps = price / tickSize;
    const roundedSteps = direction === 'up' ? Math.ceil(steps) : Math.floor(steps);
    return +(roundedSteps * tickSize).toFixed(4);
  }

  /** Build a refused evaluation result. */
  private _refuse(
    code: ExecutionRefusalCode,
    message: string,
  ): PaperEvaluationResult {
    return {
      canFill: false,
      fillPrice: null,
      referencePrice: null,
      slippagePerUnit: 0,
      slippageAmount: 0,
      fees: 0,
      outcomeCode: ExecutionOutcomeCode.PaperRejected,
      message,
      refusalReasons: [{ reasonCode: code, reasonMessage: message }],
      simulatedBrokerOrderId: null,
    };
  }
}
