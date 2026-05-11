// ── India NSE/NFO deterministic proposal validator ──
// Fail-closed validator that consumes only persisted/local runtime surfaces.
// Produces exact machine-readable reason codes for every failure with no
// LLM discretion over validity. Validator output is deterministic, ordered,
// and easy for downstream slices to render.

import {
  ProposalStatus,
  ValidationReasonCode,
  MarketPhase,
  ZerodhaSessionState,
  type NewProposalAttempt,
  type ProposalVerdict,
  type ValidationReason,
} from '../types/runtime.js';

import type {
  InstrumentRecord,
  InstrumentSyncState,
  QuoteSnapshot,
} from '../integrations/zerodha/types.js';

import type { MarketProfile } from '../market/market-profile.js';
import { INDIA_MARKETS } from '../market/india-profile.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default staleness tolerance for quote snapshots (60 s). */
const DEFAULT_QUOTE_STALENESS_MS = 60_000;

/** Default staleness tolerance for instrument sync (24 h). */
const DEFAULT_INSTRUMENT_STALENESS_MS = 86_400_000;

/** Supported exchanges for India trading. */
const SUPPORTED_EXCHANGES = new Set(['NSE', 'NFO']);

/** Valid order types for India markets. */
const VALID_ORDER_TYPES = new Set(['MARKET', 'LIMIT', 'SL', 'SLM']);

/** Valid products per segment. */
const NSE_PRODUCTS = new Set(['MIS', 'CNC']);
const NFO_PRODUCTS = new Set(['MIS', 'NRML']);

/** Valid trade sides. */
const VALID_SIDES = new Set(['buy', 'sell']);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ValidatorConfig {
  /** Staleness tolerance for quote snapshots (ms). Default: 60_000. */
  quoteStalenessMs?: number;
  /** Staleness tolerance for instrument sync (ms). Default: 86_400_000. */
  instrumentStalenessMs?: number;
}

// ---------------------------------------------------------------------------
// Input shape — the full context needed to validate a single proposal
// ---------------------------------------------------------------------------

/**
 * Everything the validator needs comes from local/persisted surfaces.
 * No LLM discretion is involved at any point.
 */
export interface ValidatorInput {
  /** The normalized proposal attempt to validate. */
  proposal: NewProposalAttempt;
  /**
   * Session health snapshot, or null when Zerodha is not configured.
   * When null, session checks are skipped (graceful degradation).
   */
  sessionHealth: {
    state: ZerodhaSessionState;
    expiresAt: number;
  } | null;
  /** Instrument record from the local instrument master, or null if not found. */
  instrument: InstrumentRecord | null;
  /** Latest quote snapshot for this instrument, or null if not available. */
  quote: QuoteSnapshot | null;
  /** Instrument sync state for staleness checks, or null if never synced. */
  syncState: InstrumentSyncState | null;
  /** Current market phase. */
  marketPhase: MarketPhase;
  /** Active market profiles to validate against (defaults to INDIA_MARKETS). */
  marketProfiles?: readonly MarketProfile[];
}

// ---------------------------------------------------------------------------
// IndiaProposalValidator
// ---------------------------------------------------------------------------

export class IndiaProposalValidator {
  private readonly _config: Required<ValidatorConfig>;

  constructor(config?: ValidatorConfig) {
    this._config = {
      quoteStalenessMs: config?.quoteStalenessMs ?? DEFAULT_QUOTE_STALENESS_MS,
      instrumentStalenessMs: config?.instrumentStalenessMs ?? DEFAULT_INSTRUMENT_STALENESS_MS,
    };
  }

  /**
   * Validate a single proposal attempt deterministically.
   *
   * Runs every check in order so that the reason list is stable:
   *   1. Session/auth freshness
   *   2. Supported exchange + product
   *   3. Side validity
   *   4. Order type validity
   *   5. Instrument existence
   *   6. Instrument sync freshness
   *   7. Quote existence
   *   8. Quote freshness
   *   9. Market phase / closed check
   *  10. Cross-market profile mismatch
   *  11. Quantity constraints
   *  12. Tick-size rounding
   *  13. NFO expiry requirement
   *
   * @returns A `ProposalVerdict` with `Refused` status and all reasons when
   *          any check fails, or `Accepted` with an empty reason list.
   */
  validate(input: ValidatorInput): ProposalVerdict {
    const reasons: ValidationReason[] = [];

    // Active market profiles (default to India markets)
    const profiles = input.marketProfiles ?? INDIA_MARKETS;

    // ─── Check 1: Session/auth freshness ────────────────────────────────
    if (input.sessionHealth !== null) {
      this._checkSession(input.sessionHealth, reasons);
    }

    // ─── Check 2: Supported exchange ────────────────────────────────────
    const exchange = input.proposal.exchange?.toUpperCase();
    if (!exchange || !SUPPORTED_EXCHANGES.has(exchange)) {
      reasons.push({
        reasonCode: ValidationReasonCode.InvalidSegment,
        reasonMessage: `Exchange '${exchange ?? input.proposal.exchange}' is not supported for India trading`,
      });
    }

    // ─── Check 3: Side validity ─────────────────────────────────────────
    const side = input.proposal.side?.toLowerCase();
    if (!side || !VALID_SIDES.has(side)) {
      reasons.push({
        reasonCode: ValidationReasonCode.MissingSide,
        reasonMessage: `Trade side '${input.proposal.side}' is invalid; must be 'buy' or 'sell'`,
      });
    }

    // ─── Check 4: Order type validity ───────────────────────────────────
    const orderType = input.proposal.orderType?.toUpperCase();
    if (!orderType || !VALID_ORDER_TYPES.has(orderType)) {
      reasons.push({
        reasonCode: ValidationReasonCode.InvalidOrderType,
        reasonMessage: `Order type '${input.proposal.orderType}' is not supported`,
      });
    }

    // ─── Check 5: Supported product for segment ─────────────────────────
    if (exchange) {
      this._checkProduct(input.proposal.product, exchange, reasons);
    }

    // ─── Check 6: Instrument existence ──────────────────────────────────
    if (!input.instrument) {
      reasons.push({
        reasonCode: ValidationReasonCode.InstrumentLookupFailed,
        reasonMessage: `Instrument not found for ${input.proposal.exchange}:${input.proposal.tradingsymbol} in local instrument master`,
      });
    }

    // ─── Check 7: Instrument sync freshness ─────────────────────────────
    if (input.instrument && input.syncState) {
      this._checkInstrumentFreshness(input.syncState, reasons);
    }

    // ─── Check 8: Quote existence ───────────────────────────────────────
    if (input.instrument && !input.quote) {
      reasons.push({
        reasonCode: ValidationReasonCode.QuoteMissing,
        reasonMessage: `No quote snapshot available for ${input.instrument.exchange}:${input.instrument.tradingsymbol}`,
      });
    }

    // ─── Check 9: Quote freshness ──────────────────────────────────────
    if (input.quote) {
      this._checkQuoteFreshness(input.quote, reasons);
    }

    // ─── Check 10: Market phase ────────────────────────────────────────
    this._checkMarketPhase(input.marketPhase, exchange ?? '', reasons);

    // ─── Check 11: Cross-market profile mismatch ────────────────────────
    if (input.instrument) {
      this._checkProfileMismatch(input.instrument, input.marketPhase, profiles, reasons);
    }

    // ─── Check 12: Quantity constraints ────────────────────────────────
    if (input.instrument) {
      this._checkQuantity(input.proposal.quantity, input.instrument, reasons);
    } else {
      // Without instrument metadata, just check quantity > 0
      if (input.proposal.quantity <= 0) {
        reasons.push({
          reasonCode: ValidationReasonCode.ZeroQuantity,
          reasonMessage: `Quantity must be positive; got ${input.proposal.quantity}`,
        });
      }
    }

    // ─── Check 13: Tick-size rounding (for limit/SL orders) ────────────
    if (input.instrument && orderType && orderType !== 'MARKET') {
      this._checkTickRounding(
        input.proposal.price,
        input.instrument.tickSize,
        reasons,
      );
      // Also check trigger price if present
      if (input.proposal.triggerPrice != null) {
        this._checkTickRounding(
          input.proposal.triggerPrice,
          input.instrument.tickSize,
          reasons,
        );
      }
    }

    // ─── Check 14: NFO expiry requirement ──────────────────────────────
    if (input.instrument && input.instrument.segment === 'NFO') {
      if (!input.instrument.expiry) {
        reasons.push({
          reasonCode: ValidationReasonCode.MissingExpiry,
          reasonMessage: `NFO instrument ${input.instrument.tradingsymbol} is missing expiry context in instrument master`,
        });
      }
    }

    // ─── Verdict ──────────────────────────────────────────────────────
    if (reasons.length > 0) {
      return { status: ProposalStatus.Refused, reasons };
    }

    return { status: ProposalStatus.Accepted, reasons: [] };
  }

  // -----------------------------------------------------------------------
  // Private validation helpers
  // -----------------------------------------------------------------------

  private _checkSession(
    session: { state: ZerodhaSessionState; expiresAt: number },
    reasons: ValidationReason[],
  ): void {
    if (session.state === ZerodhaSessionState.MissingCredentials) {
      reasons.push({
        reasonCode: ValidationReasonCode.SessionNotAuthenticated,
        reasonMessage: 'Zerodha session is missing credentials; authentication required',
      });
      return;
    }

    if (session.state === ZerodhaSessionState.AuthFailed) {
      reasons.push({
        reasonCode: ValidationReasonCode.SessionNotAuthenticated,
        reasonMessage: 'Zerodha authentication failed; no valid session',
      });
      return;
    }

    if (session.state === ZerodhaSessionState.Expired) {
      reasons.push({
        reasonCode: ValidationReasonCode.SessionExpired,
        reasonMessage: 'Zerodha session has expired; refresh required',
      });
      return;
    }

    if (session.state === ZerodhaSessionState.Authenticated) {
      // Check if token is within expiry buffer (5 min)
      const now = Date.now();
      const remainingMs = session.expiresAt - now;
      if (remainingMs <= 0) {
        reasons.push({
          reasonCode: ValidationReasonCode.SessionExpired,
          reasonMessage: 'Zerodha session token has expired',
        });
      } else if (remainingMs < 300_000) {
        // Less than 5 min remaining — treat as expired (refresh window too tight)
        reasons.push({
          reasonCode: ValidationReasonCode.SessionExpired,
          reasonMessage: `Zerodha session expires imminently (${Math.round(remainingMs / 1000)}s remaining)`,
        });
      }
    }
  }

  private _checkProduct(
    product: string,
    exchange: string,
    reasons: ValidationReason[],
  ): void {
    const upper = product?.toUpperCase();
    if (!upper) {
      reasons.push({
        reasonCode: ValidationReasonCode.MissingProduct,
        reasonMessage: 'Product type is missing',
      });
      return;
    }

    if (exchange === 'NSE' && !NSE_PRODUCTS.has(upper)) {
      reasons.push({
        reasonCode: ValidationReasonCode.MissingProduct,
        reasonMessage: `Product '${product}' is not supported for NSE equities (valid: ${Array.from(NSE_PRODUCTS).join(', ')})`,
      });
    } else if (exchange === 'NFO' && !NFO_PRODUCTS.has(upper)) {
      reasons.push({
        reasonCode: ValidationReasonCode.MissingProduct,
        reasonMessage: `Product '${product}' is not supported for NSE F&O (valid: ${Array.from(NFO_PRODUCTS).join(', ')})`,
      });
    }
  }

  private _checkInstrumentFreshness(
    syncState: InstrumentSyncState,
    reasons: ValidationReason[],
  ): void {
    if (!syncState.lastSuccessAt) {
      reasons.push({
        reasonCode: ValidationReasonCode.InstrumentStale,
        reasonMessage: 'Instrument master has never been synced',
      });
      return;
    }

    const stalenessMs = Date.now() - syncState.lastSuccessAt;
    if (stalenessMs > this._config.instrumentStalenessMs) {
      reasons.push({
        reasonCode: ValidationReasonCode.InstrumentStale,
        reasonMessage: `Instrument master sync is stale (${Math.round(stalenessMs / 86_400_000)}d old, max ${Math.round(this._config.instrumentStalenessMs / 86_400_000)}d)`,
      });
    }

    if (syncState.lastStatus === 'failed') {
      reasons.push({
        reasonCode: ValidationReasonCode.InstrumentStale,
        reasonMessage: `Last instrument sync failed: ${syncState.lastError ?? 'unknown error'}`,
      });
    }
  }

  private _checkQuoteFreshness(
    quote: QuoteSnapshot,
    reasons: ValidationReason[],
  ): void {
    const stalenessMs = Date.now() - quote.receivedAt;
    if (stalenessMs > this._config.quoteStalenessMs) {
      reasons.push({
        reasonCode: ValidationReasonCode.QuoteStale,
        reasonMessage: `Quote for ${quote.exchange}:${quote.tradingsymbol} is stale (${Math.round(stalenessMs / 1000)}s old, max ${Math.round(this._config.quoteStalenessMs / 1000)}s)`,
      });
    }
  }

  private _checkMarketPhase(
    phase: MarketPhase,
    exchange: string,
    reasons: ValidationReason[],
  ): void {
    if (phase === MarketPhase.Closed) {
      reasons.push({
        reasonCode: ValidationReasonCode.MarketClosed,
        reasonMessage: `Market is closed for ${exchange || 'trading'}`,
      });
      return;
    }
    if (phase === MarketPhase.PostMarket) {
      reasons.push({
        reasonCode: ValidationReasonCode.MarketClosed,
        reasonMessage: `Post-market session — new proposals not accepted for ${exchange || 'trading'}`,
      });
    }
    // PreMarket and Regular are allowed
  }

  private _checkProfileMismatch(
    instrument: InstrumentRecord,
    phase: MarketPhase,
    profiles: readonly MarketProfile[],
    reasons: ValidationReason[],
  ): void {
    // Determine the expected market profile for this instrument segment
    const targetMarketId = instrument.segment === 'NSE'
      ? 'INDIA_NSE_EQ'
      : instrument.segment === 'NFO'
        ? 'INDIA_NSE_FO'
        : null;

    if (!targetMarketId) return; // Unknown segment — handled elsewhere

    const matchingProfile = profiles.find(p => p.marketId === targetMarketId);
    if (!matchingProfile) {
      reasons.push({
        reasonCode: ValidationReasonCode.CrossMarketMismatch,
        reasonMessage: `No market profile found for segment ${instrument.segment} (expected ${targetMarketId})`,
      });
      return;
    }

    // Check that the current phase is valid for this profile
    if (phase === MarketPhase.Closed) {
      // Already handled in _checkMarketPhase
      return;
    }

    // For pre-market: NSE EQ allows pre-market, NFO typically doesn't
    if (phase === MarketPhase.PreMarket && instrument.segment === 'NFO') {
      reasons.push({
        reasonCode: ValidationReasonCode.MarketClosed,
        reasonMessage: `NFO segment is not available during pre-market session`,
      });
    }
  }

  private _checkQuantity(
    quantity: number,
    instrument: InstrumentRecord,
    reasons: ValidationReason[],
  ): void {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      reasons.push({
        reasonCode: ValidationReasonCode.ZeroQuantity,
        reasonMessage: `Quantity must be a positive integer; got ${quantity}`,
      });
      return;
    }

    if (!Number.isInteger(quantity)) {
      reasons.push({
        reasonCode: ValidationReasonCode.ZeroQuantity,
        reasonMessage: `Quantity must be an integer; got ${quantity}`,
      });
      return;
    }

    // NFO lot-size check
    if (instrument.segment === 'NFO') {
      const lotSize = instrument.lotSize;
      if (!Number.isFinite(lotSize) || lotSize <= 0) {
        reasons.push({
          reasonCode: ValidationReasonCode.InsufficientMetadata,
          reasonMessage: `Cannot validate lot size for ${instrument.tradingsymbol}: lot size is ${lotSize}`,
        });
        return;
      }

      if (quantity % lotSize !== 0) {
        reasons.push({
          reasonCode: ValidationReasonCode.LotSizeMismatch,
          reasonMessage: `Quantity ${quantity} is not a multiple of NFO lot size ${lotSize} for ${instrument.tradingsymbol}`,
        });
      }
    }
  }

  private _checkTickRounding(
    price: number | null | undefined,
    tickSize: number,
    reasons: ValidationReason[],
  ): void {
    if (price == null) {
      // MARKET orders have null price — no rounding checks needed
      return;
    }

    if (!Number.isFinite(price) || price <= 0) {
      reasons.push({
        reasonCode: ValidationReasonCode.PriceNotRounded,
        reasonMessage: `Price ${price} is not a valid positive number`,
      });
      return;
    }

    if (!Number.isFinite(tickSize) || tickSize <= 0) {
      reasons.push({
        reasonCode: ValidationReasonCode.InsufficientMetadata,
        reasonMessage: `Cannot validate tick-size rounding: tick size is ${tickSize}`,
      });
      return;
    }

    // Check that price is a multiple of tick size within floating-point tolerance
    const remainder = Math.abs(price % tickSize);
    const tolerance = tickSize / 100; // 1% of tick size as floating tolerance
    if (remainder > tolerance && Math.abs(remainder - tickSize) > tolerance) {
      reasons.push({
        reasonCode: ValidationReasonCode.PriceNotRounded,
        reasonMessage: `Price ${price} is not rounded to tick size ${tickSize} (remainder ${remainder})`,
      });
    }
  }
}
