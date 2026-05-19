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
  /** The simulated fill price (null when cannot fill). */
  readonly fillPrice: number | null;
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
    _instrument: InstrumentRecord,
  ): PaperEvaluationResult {
    // Prefer ask for buy fills; fall back to lastPrice
    const fillPrice = quote.ask ?? quote.lastPrice ?? null;

    if (fillPrice === null || fillPrice <= 0) {
      return this._refuse(
        ExecutionRefusalCode.StaleOrMissingQuote,
        `Cannot determine fill price for buy: ask=${quote.ask}, lastPrice=${quote.lastPrice}`,
      );
    }

    const orderType = candidate.orderType?.toUpperCase();

    // Limit check: for LIMIT and SL (with limit price) orders, verify price crosses the ask.
    // SL and SLM without limit prices are market-on-trigger and fill at the prevailing price.
    const isBoundedOrder = orderType === 'LIMIT' || (orderType === 'SL' && candidate.price !== null && candidate.price > 0);
    if (isBoundedOrder) {
      const limitPrice = candidate.price;

      if (limitPrice === null || limitPrice <= 0) {
        return this._refuse(
          ExecutionRefusalCode.StaleOrMissingQuote,
          `Limit buy without a valid limit price (price=${candidate.price})`,
        );
      }

      // A buy limit order can fill when limit price >= ask
      if (limitPrice < fillPrice) {
        return this._refuse(
          ExecutionRefusalCode.StaleOrMissingQuote,
          `Buy limit ${limitPrice} is below ask ${fillPrice} — order would not fill at current price`,
        );
      }
    }

    // Market buy or limit that crosses ask → simulated fill
    const simId = `paper-${Date.now()}-${candidate.id}-buy`;
    return {
      canFill: true,
      fillPrice: candidate.price ?? fillPrice,
      outcomeCode: ExecutionOutcomeCode.PaperSimulated,
      message: `Paper buy ${candidate.quantity} ${candidate.tradingsymbol} at ${candidate.price ?? fillPrice} (ask=${quote.ask}, last=${quote.lastPrice})`,
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
    _instrument: InstrumentRecord,
  ): PaperEvaluationResult {
    // Prefer bid for sell fills; fall back to lastPrice
    const fillPrice = quote.bid ?? quote.lastPrice ?? null;

    if (fillPrice === null || fillPrice <= 0) {
      return this._refuse(
        ExecutionRefusalCode.StaleOrMissingQuote,
        `Cannot determine fill price for sell: bid=${quote.bid}, lastPrice=${quote.lastPrice}`,
      );
    }

    const orderType = candidate.orderType?.toUpperCase();

    // Limit check: for LIMIT and SL (with limit price) orders, verify price crosses the bid.
    // SL and SLM without limit prices are market-on-trigger and fill at the prevailing price.
    const isBoundedOrder = orderType === 'LIMIT' || (orderType === 'SL' && candidate.price !== null && candidate.price > 0);
    if (isBoundedOrder) {
      const limitPrice = candidate.price;

      if (limitPrice === null || limitPrice <= 0) {
        return this._refuse(
          ExecutionRefusalCode.StaleOrMissingQuote,
          `Limit sell without a valid limit price (price=${candidate.price})`,
        );
      }

      // A sell limit order can fill when limit price <= bid
      if (limitPrice > fillPrice) {
        return this._refuse(
          ExecutionRefusalCode.StaleOrMissingQuote,
          `Sell limit ${limitPrice} is above bid ${fillPrice} — order would not fill at current price`,
        );
      }
    }

    // Market sell or limit that crosses bid → simulated fill
    const simId = `paper-${Date.now()}-${candidate.id}-sell`;
    return {
      canFill: true,
      fillPrice: candidate.price ?? fillPrice,
      outcomeCode: ExecutionOutcomeCode.PaperSimulated,
      message: `Paper sell ${candidate.quantity} ${candidate.tradingsymbol} at ${candidate.price ?? fillPrice} (bid=${quote.bid}, last=${quote.lastPrice})`,
      refusalReasons: [],
      simulatedBrokerOrderId: simId,
    };
  }

  /** Build a refused evaluation result. */
  private _refuse(
    code: ExecutionRefusalCode,
    message: string,
  ): PaperEvaluationResult {
    return {
      canFill: false,
      fillPrice: null,
      outcomeCode: ExecutionOutcomeCode.PaperRejected,
      message,
      refusalReasons: [{ reasonCode: code, reasonMessage: message }],
      simulatedBrokerOrderId: null,
    };
  }
}
