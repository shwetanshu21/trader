// ── Bounded proposal-generation engine ──
// Built-in fetch + AbortController, no external HTTP deps.
// Calls a configurable LLM provider, normalises JSON output into
// NewProposalAttempt DTOs, and returns structured error/refusal results
// for every failure mode (timeout, 5xx, malformed JSON, empty response).

import {
  type ProviderProposalResponse,
  type NewProposalAttempt,
  type ProposalEngineConfig,
  ProposalStatus,
  ValidationReasonCode,
  type ValidationReason,
} from '../types/runtime.js';

import type {
  InstrumentRecord,
  QuoteSnapshot,
} from '../integrations/broker/types.js';

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** A single normalized proposal candidate ready for validation. */
export interface NormalizedProposal {
  /** Normalized proposal DTO for persistence/validation. */
  attempt: NewProposalAttempt;
  /** The raw provider payload before normalization (for diagnostics). */
  raw: {
    exchange: string;
    tradingsymbol: string;
    side: string;
    product: string;
    quantity: number;
    price: number | null;
    triggerPrice: number | null;
    orderType: string;
  };
}

/** Full result of a single tick's proposal-generation attempt. */
export interface EngineResult {
  /** Normalized proposals (empty on refusal/error). */
  proposals: NormalizedProposal[];
  /** Refusal reason if the engine could not produce proposals, or null. */
  refusal: ValidationReason | null;
  /** Provider reasoning text, if available. */
  reasoning: string | null;
  /** Duration of the provider call in ms, or null if not attempted. */
  durationMs: number | null;
}

// ---------------------------------------------------------------------------
// Context supplied to the engine for building the provider prompt
// ---------------------------------------------------------------------------

export interface EngineContext {
  /** Instruments available for trading with their latest quotes. */
  instruments: Array<{
    instrument: InstrumentRecord;
    quote: QuoteSnapshot | null;
  }>;
  /** Current market phase label. */
  marketPhase: string;
  /** Maximum number of proposals to generate. */
  maxProposals: number;
  /** Exchange segment to focus on (NSE or NFO). */
  segment?: string;
}

// ---------------------------------------------------------------------------
// ProposalEngine
// ---------------------------------------------------------------------------

export class ProposalEngine {
  private readonly _config: ProposalEngineConfig;

  constructor(config: ProposalEngineConfig) {
    this._config = config;
  }

  /**
   * Generate proposals by calling the LLM provider.
   *
   * Failure modes handled:
   *  - Provider timeout (AbortController)
   *  - HTTP error (4xx, 5xx)
   *  - Malformed JSON response
   *  - Empty proposal list
   *  - Missing required fields in individual proposals
   *
   * @returns EngineResult containing normalized proposals or a refusal reason.
   */
  async generateProposals(context: EngineContext): Promise<EngineResult> {
    const startedAt = Date.now();

    // ── Build request payload ─────────────────────────────────────────────
    const payload = this._buildPayload(context);

    // ── Perform bounded fetch ─────────────────────────────────────────────
    let response: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this._config.timeoutMs);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this._config.apiKey) {
        headers['Authorization'] = `Bearer ${this._config.apiKey}`;
      }

      response = await fetch(this._config.providerUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      if (err instanceof DOMException && err.name === 'AbortError') {
        return {
          proposals: [],
          refusal: {
            reasonCode: ValidationReasonCode.QuoteMissing,
            reasonMessage: `Proposal-engine request timed out after ${this._config.timeoutMs}ms`,
          },
          reasoning: null,
          durationMs: elapsed,
        };
      }
      return {
        proposals: [],
        refusal: {
          reasonCode: ValidationReasonCode.QuoteMissing,
          reasonMessage: `Proposal-engine request failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        reasoning: null,
        durationMs: elapsed,
      };
    }

    const elapsed = Date.now() - startedAt;

    // ── Check HTTP status ─────────────────────────────────────────────────
    if (!response.ok) {
      const statusText = `${response.status} ${response.statusText}`;
      let body = '';
      try { body = await response.text(); } catch { /* ignore */ }
      return {
        proposals: [],
        refusal: {
          reasonCode: ValidationReasonCode.QuoteMissing,
          reasonMessage: `Proposal-engine returned HTTP ${statusText}${body ? ': ' + body.slice(0, 200) : ''}`,
        },
        reasoning: null,
        durationMs: elapsed,
      };
    }

    // ── Parse response body ───────────────────────────────────────────────
    let parsed: ProviderProposalResponse;
    try {
      const text = await response.text();
      parsed = JSON.parse(text) as ProviderProposalResponse;
    } catch (err) {
      return {
        proposals: [],
        refusal: {
          reasonCode: ValidationReasonCode.QuoteMissing,
          reasonMessage: `Malformed response from proposal-engine: ${err instanceof Error ? err.message : String(err)}`,
        },
        reasoning: null,
        durationMs: elapsed,
      };
    }

    // ── Validate response structure ───────────────────────────────────────
    if (!parsed.proposals || !Array.isArray(parsed.proposals)) {
      return {
        proposals: [],
        refusal: {
          reasonCode: ValidationReasonCode.QuoteMissing,
          reasonMessage: 'Proposal-engine response missing "proposals" array',
        },
        reasoning: parsed.reasoning ?? null,
        durationMs: elapsed,
      };
    }

    if (parsed.proposals.length === 0) {
      return {
        proposals: [],
        refusal: {
          reasonCode: ValidationReasonCode.QuoteMissing,
          reasonMessage: 'Proposal-engine returned empty proposal list',
        },
        reasoning: parsed.reasoning ?? null,
        durationMs: elapsed,
      };
    }

    // ── Normalize each proposal ───────────────────────────────────────────
    const normalized: NormalizedProposal[] = [];

    for (const raw of parsed.proposals) {
      const attempt = this._normalizeProposal(raw);
      if (attempt) {
        normalized.push({
          attempt,
          raw: {
            exchange: raw.exchange,
            tradingsymbol: raw.tradingsymbol,
            side: raw.side,
            product: raw.product,
            quantity: raw.quantity,
            price: raw.price ?? null,
            triggerPrice: raw.triggerPrice ?? null,
            orderType: raw.orderType,
          },
        });
      }
    }

    if (normalized.length === 0) {
      return {
        proposals: [],
        refusal: {
          reasonCode: ValidationReasonCode.QuoteMissing,
          reasonMessage: 'All provider proposals failed normalization',
        },
        reasoning: parsed.reasoning ?? null,
        durationMs: elapsed,
      };
    }

    return {
      proposals: normalized,
      refusal: null,
      reasoning: parsed.reasoning ?? null,
      durationMs: elapsed,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Build the request payload sent to the LLM provider.
   * Includes market context and available instruments.
   */
  private _buildPayload(context: EngineContext): Record<string, unknown> {
    const instrumentSummaries = context.instruments.map(entry => ({
      exchange: entry.instrument.exchange,
      tradingsymbol: entry.instrument.tradingsymbol,
      segment: entry.instrument.segment,
      instrumentType: entry.instrument.instrumentType,
      lotSize: entry.instrument.lotSize,
      tickSize: entry.instrument.tickSize,
      lastPrice: entry.quote?.lastPrice ?? null,
      change: entry.quote?.change ?? null,
      volume: entry.quote?.volume ?? null,
      oi: entry.quote?.oi ?? null,
      expiry: entry.instrument.expiry,
      strike: entry.instrument.strike,
    }));

    return {
      version: '1.0',
      marketPhase: context.marketPhase,
      segment: context.segment ?? 'NSE',
      maxProposals: context.maxProposals,
      instruments: instrumentSummaries.slice(0, context.maxProposals * 3),
      instructions: 'Generate trade proposals based on current market conditions. '
        + 'Return JSON with a "proposals" array. Each proposal must include: '
        + 'exchange, tradingsymbol, side (buy/sell), product (MIS/CNC/NRML), '
        + 'quantity, price (or null for MARKET), triggerPrice (or null), orderType (MARKET/LIMIT/SL/SLM).',
    };
  }

  /**
   * Normalize a single raw provider proposal into a NewProposalAttempt.
   * Returns null if the proposal has missing or invalid fields.
   */
  private _normalizeProposal(
    raw: ProviderProposalResponse['proposals'][0],
  ): NewProposalAttempt | null {
    const exchange = raw.exchange?.toUpperCase()?.trim();
    if (!exchange || (exchange !== 'NSE' && exchange !== 'NFO')) return null;

    const tradingsymbol = raw.tradingsymbol?.trim();
    if (!tradingsymbol) return null;

    const side = raw.side?.toLowerCase();
    if (!side || (side !== 'buy' && side !== 'sell')) return null;

    const product = raw.product?.toUpperCase()?.trim();
    if (!product || !['MIS', 'CNC', 'NRML'].includes(product)) return null;

    const orderType = raw.orderType?.toUpperCase()?.trim();
    if (!orderType || !['MARKET', 'LIMIT', 'SL', 'SLM'].includes(orderType)) return null;

    const quantity = Math.floor(raw.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return null;

    const price = raw.price != null ? raw.price : null;
    const triggerPrice = raw.triggerPrice != null ? raw.triggerPrice : null;

    // For non-MARKET orders, price must be present and valid
    if (orderType !== 'MARKET' && (price == null || !Number.isFinite(price) || price <= 0)) {
      return null;
    }

    return {
      exchange,
      tradingsymbol,
      instrumentToken: null, // Resolved by supervisor via instrument master lookup
      side,
      product,
      quantity,
      price,
      triggerPrice,
      orderType,
      tag: raw.tag ?? null,
      proposalStatus: ProposalStatus.Pending,
      createdAt: Date.now(),
    };
  }
}
