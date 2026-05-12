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
   * Generate proposals by calling the configured provider.
   *
   * Failure modes handled:
   *  - Provider timeout (AbortController)
   *  - HTTP error (4xx, 5xx)
   *  - Malformed JSON response
   *  - Empty proposal list
   *  - Missing required fields in individual proposals
   */
  async generateProposals(context: EngineContext): Promise<EngineResult> {
    const startedAt = Date.now();

    let parsed: ProviderProposalResponse;
    try {
      parsed = this._config.providerMode === 'openai-compatible'
        ? await this._fetchOpenAiCompatibleResponse(context)
        : await this._fetchCustomResponse(context);
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
          reasonMessage: err instanceof Error ? err.message : String(err),
        },
        reasoning: null,
        durationMs: elapsed,
      };
    }

    const elapsed = Date.now() - startedAt;

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

  // ── Provider transport adapters ─────────────────────────────────────────

  private async _fetchCustomResponse(context: EngineContext): Promise<ProviderProposalResponse> {
    const payload = this._buildCanonicalPayload(context);
    const response = await this._postJson(payload);
    return this._parseDirectProviderResponse(response);
  }

  private async _fetchOpenAiCompatibleResponse(context: EngineContext): Promise<ProviderProposalResponse> {
    const payload = this._buildOpenAiCompatiblePayload(context);
    const response = await this._postJson(payload);
    return this._parseOpenAiCompatibleResponse(response);
  }

  private async _postJson(payload: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this._config.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this._config.apiKey) {
        headers['Authorization'] = `Bearer ${this._config.apiKey}`;
      }

      return await fetch(this._config.providerUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async _parseDirectProviderResponse(response: Response): Promise<ProviderProposalResponse> {
    if (!response.ok) {
      throw new Error(await this._formatHttpError(response));
    }

    try {
      const text = await response.text();
      return JSON.parse(text) as ProviderProposalResponse;
    } catch (err) {
      throw new Error(`Malformed response from proposal-engine: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async _parseOpenAiCompatibleResponse(response: Response): Promise<ProviderProposalResponse> {
    if (!response.ok) {
      throw new Error(await this._formatHttpError(response));
    }

    let outer: { choices?: Array<{ message?: { content?: unknown } }> };
    try {
      const text = await response.text();
      outer = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
    } catch (err) {
      throw new Error(`Malformed OpenAI-compatible response: ${err instanceof Error ? err.message : String(err)}`);
    }

    const content = outer.choices?.[0]?.message?.content;
    const contentText = this._extractAssistantContent(content);
    if (!contentText) {
      throw new Error('OpenAI-compatible response missing choices[0].message.content');
    }

    try {
      return JSON.parse(contentText) as ProviderProposalResponse;
    } catch (err) {
      throw new Error(`OpenAI-compatible assistant content is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Request builders ────────────────────────────────────────────────────

  /**
   * Canonical business payload used by the legacy custom provider contract.
   */
  private _buildCanonicalPayload(context: EngineContext): Record<string, unknown> {
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

  private _buildOpenAiCompatiblePayload(context: EngineContext): Record<string, unknown> {
    const canonicalPayload = this._buildCanonicalPayload(context);

    return {
      model: this._config.providerModel,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You generate Indian-market trade proposals. Return only valid JSON with a top-level proposals array and optional reasoning field.',
        },
        {
          role: 'user',
          content: JSON.stringify(canonicalPayload),
        },
      ],
    };
  }

  // ── Parse helpers ───────────────────────────────────────────────────────

  private _extractAssistantContent(content: unknown): string | null {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const text = content
        .map(part => {
          if (typeof part === 'string') return part;
          if (
            part
            && typeof part === 'object'
            && 'type' in part
            && (part as { type?: unknown }).type === 'text'
            && 'text' in part
          ) {
            const value = (part as { text?: unknown }).text;
            return typeof value === 'string' ? value : '';
          }
          return '';
        })
        .join('')
        .trim();
      return text || null;
    }

    return null;
  }

  private async _formatHttpError(response: Response): Promise<string> {
    const statusText = `${response.status} ${response.statusText}`;
    let body = '';
    try { body = await response.text(); } catch { /* ignore */ }
    return `Proposal-engine returned HTTP ${statusText}${body ? ': ' + body.slice(0, 200) : ''}`;
  }

  // ── Normalization ───────────────────────────────────────────────────────

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
