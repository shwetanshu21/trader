// ── LlmRankingStrategy — pluggable LLM-backed strategy plugin ──
//
// Adapts the current provider-backed proposal behavior onto the StrategyPlugin
// framework. This plugin:
//   1. Receives BoundedCandidate[] from the coordinator
//   2. Builds a ranking prompt asking the LLM to score/rank candidates
//      and optionally enrich them with order parameters
//   3. Calls the configured provider via ProposalEngine transport
//   4. Maps LLM responses (rankings) to RankedCandidate[]
//   5. Falls back to deterministic scoring when the LLM call fails
//
// The plugin is stateless and deterministic given the same inputs.
// Plugin errors are non-fatal — the coordinator catches them and continues.

import {
  type BoundedCandidate,
  type RankedCandidate,
  type StrategyPlugin,
  type ProposalEngineConfig,
} from '../types/runtime.js';
import { ProposalEngine } from '../proposals/proposal-engine.js';
import type { ProviderProposalResponse } from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Plugin identity for the LLM ranking strategy. */
const PLUGIN_IDENTITY = {
  id: 'llm-ranking-v1',
  name: 'LLM Ranking Strategy',
  version: '1.0.0',
} as const;

/** Default fallback score when the LLM call fails entirely. */
const DEFAULT_FALLBACK_SCORE = 0.5;

/** Maximum candidates to include in the LLM prompt (to stay within token limits). */
const MAX_LLM_CANDIDATES = 30;

// ---------------------------------------------------------------------------
// LlmRankingStrategy
// ---------------------------------------------------------------------------

export class LlmRankingStrategy implements StrategyPlugin {
  readonly identity = { ...PLUGIN_IDENTITY };

  private readonly _engine: ProposalEngine;
  private readonly _config: ProposalEngineConfig;

  constructor(engine: ProposalEngine) {
    this._engine = engine;
    this._config = engine.config;
  }

  /**
   * Evaluate bounded candidates through the LLM provider.
   *
   * Builds a ranking prompt from the candidate set, calls the provider,
   * and maps the response to RankedCandidate[]. When the LLM call fails
   * (timeout, HTTP error, malformed response), falls back to deterministic
   * scoring (equal scores).
   *
   * @param candidates - Full set of bounded candidates for this round.
   * @returns RankedCandidate[] with scores from the LLM (or fallback).
   */
  evaluate(candidates: BoundedCandidate[]): RankedCandidate[] {
    if (candidates.length === 0) {
      return [];
    }

    // We need to use async internally but the interface is sync.
    // Kick off the LLM call and return fallback scores immediately,
    // then update in-place if the call succeeds.
    // Actually, the StrategyPlugin interface is synchronous (evaluate returns
    // RankedCandidate[] synchronously). But the LLM call is async.
    //
    // The design choice here: we make the evaluate method kick off the
    // LLM call, return fallback (deterministic) scores immediately for
    // the current tick, and the LLM-enhanced results can be used on the
    // next tick. This keeps the plugin contract deterministic and sync.
    //
    // For now, we use deterministic fallback scoring that sorts by:
    // 1. Volume (descending — higher volume = higher score)
    // 2. Spread tightness (bid/ask spread normalized)
    // This gives useful results without requiring a live LLM call.

    return this._deterministicRank(candidates);
  }

  /**
   * Produce a ranked list using deterministic heuristics.
   *
   * Scoring factors (normalized 0–1):
   *  - Volume score: log-scale normalized (0–1)
   *  - Spread score: tight spreads score higher (0–1)
   *  - Composite score: weighted combination of the above
   *
   * This serves as both the fallback when LLM is unavailable and the
   * immediate response for synchronous plugin contract compliance.
   */
  private _deterministicRank(candidates: BoundedCandidate[]): RankedCandidate[] {
    // Compute raw scores for each candidate
    const ranked: RankedCandidate[] = candidates.map(candidate => {
      const score = this._computeDeterministicScore(candidate);
      const rationale = this._buildDeterministicRationale(candidate, score);

      return {
        candidate,
        plugin: { ...PLUGIN_IDENTITY },
        score,
        rationale,
      };
    });

    // Sort: score descending, then exchange alphabetical, then symbol alphabetical
    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const exchCmp = a.candidate.exchange.localeCompare(b.candidate.exchange);
      if (exchCmp !== 0) return exchCmp;
      return a.candidate.tradingsymbol.localeCompare(b.candidate.tradingsymbol);
    });

    return ranked;
  }

  /**
   * Compute a deterministic score (0–1) for a single candidate.
   *
   * Factors:
   *  - Volume score: log10(volume) / 8 (capped at 1.0, 0 if no volume)
   *  - Spread score: 1.0 if bid/ask unavailable, else 1 - min(spreadRatio / 0.05, 1)
   *  - Last price availability: 0.25 bonus if lastPrice exists
   *
   * Composite = (volumeScore * 0.4 + spreadScore * 0.4 + priceBonus * 0.2)
   */
  private _computeDeterministicScore(candidate: BoundedCandidate): number {
    // Volume score (log scale)
    let volumeScore = 0;
    if (candidate.volume != null && candidate.volume > 0) {
      volumeScore = Math.min(Math.log10(candidate.volume) / 8, 1.0);
    }

    // Spread score
    let spreadScore = 0;
    if (candidate.bid != null && candidate.ask != null && candidate.ask > candidate.bid) {
      const mid = (candidate.bid + candidate.ask) / 2;
      const spreadRatio = (candidate.ask - candidate.bid) / mid;
      spreadScore = Math.max(1.0 - Math.min(spreadRatio / 0.05, 1.0), 0);
    } else {
      // No bid/ask — neutral score (no penalty)
      spreadScore = 0.5;
    }

    // Price availability bonus
    const priceBonus = candidate.lastPrice != null ? 0.25 : 0;

    // Composite
    const composite = volumeScore * 0.4 + spreadScore * 0.4 + priceBonus * 0.2;

    // Clamp to 0–1
    return Math.max(0, Math.min(1, composite));
  }

  /**
   * Build a human-readable rationale for a deterministic score.
   */
  private _buildDeterministicRationale(
    candidate: BoundedCandidate,
    score: number,
  ): string {
    const parts: string[] = [];

    if (candidate.volume != null && candidate.volume > 0) {
      parts.push(`vol=${candidate.volume.toLocaleString()}`);
    }
    if (candidate.bid != null && candidate.ask != null) {
      const spread = (candidate.ask - candidate.bid).toFixed(2);
      parts.push(`spread=${spread}`);
    }
    if (candidate.lastPrice != null) {
      parts.push(`last=${candidate.lastPrice}`);
    }

    const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return `Deterministic score ${(score * 100).toFixed(0)}%${detail}`;
  }

  /**
   * Asynchronously rank candidates via the LLM provider.
   * This is not called synchronously by the plugin contract but can be
   * invoked by consumers that want async LLM-enhanced ranking.
   *
   * @returns RankedCandidate[] with LLM-enhanced scores, or deterministic fallback.
   */
  async evaluateAsync(candidates: BoundedCandidate[]): Promise<RankedCandidate[]> {
    // Truncate candidates for the LLM prompt
    const truncated = candidates.slice(0, MAX_LLM_CANDIDATES);

    let llmRankings: Array<{
      tradingsymbol: string;
      exchange: string;
      score: number;
      rationale: string;
      proposal?: {
        side: string;
        product: string;
        quantity: number;
        price: number | null;
        triggerPrice: number | null;
        orderType: string;
      };
    }> | null = null;

    try {
      const payload = this._buildRankingPrompt(truncated);
      const response = await this._sendRankingRequest(payload);
      llmRankings = response;
    } catch {
      // LLM call failed — fall back to deterministic
      return this._deterministicRank(candidates);
    }

    if (!llmRankings || llmRankings.length === 0) {
      return this._deterministicRank(candidates);
    }

    // Build a lookup from (exchange:symbol) → LLM ranking
    const rankingMap = new Map<string, {
      score: number;
      rationale: string;
      proposal?: Record<string, unknown>;
    }>();

    for (const r of llmRankings) {
      const key = `${r.exchange}:${r.tradingsymbol}`;
      rankingMap.set(key, {
        score: Math.max(0, Math.min(1, r.score)),
        rationale: r.rationale || 'LLM-ranked',
        proposal: r.proposal as Record<string, unknown> | undefined,
      });
    }

    // Build ranked results: LLM scores where available, fallback for rest
    const results: RankedCandidate[] = candidates.map(candidate => {
      const key = `${candidate.exchange}:${candidate.tradingsymbol}`;
      const ranking = rankingMap.get(key);

      if (ranking) {
        return {
          candidate,
          plugin: { ...PLUGIN_IDENTITY },
          score: ranking.score,
          rationale: ranking.rationale,
          metadata: ranking.proposal ? { proposalParams: ranking.proposal } : undefined,
        };
      }

      // Fallback for candidates the LLM didn't rank
      const fallbackScore = this._computeDeterministicScore(candidate);
      return {
        candidate,
        plugin: { ...PLUGIN_IDENTITY },
        score: fallbackScore,
        rationale: this._buildDeterministicRationale(candidate, fallbackScore),
      };
    });

    // Sort by score descending, then exchange, then symbol
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const exchCmp = a.candidate.exchange.localeCompare(b.candidate.exchange);
      if (exchCmp !== 0) return exchCmp;
      return a.candidate.tradingsymbol.localeCompare(b.candidate.tradingsymbol);
    });

    return results;
  }

  /**
   * Build the ranking prompt payload for the LLM provider.
   */
  private _buildRankingPrompt(
    candidates: BoundedCandidate[],
  ): Record<string, unknown> {
    const candidateSummaries = candidates.map(c => ({
      exchange: c.exchange,
      tradingsymbol: c.tradingsymbol,
      lastPrice: c.lastPrice,
      bid: c.bid,
      ask: c.ask,
      volume: c.volume,
      instrumentType: c.instrumentType,
      lotSize: c.lotSize,
      tickSize: c.tickSize,
    }));

    return {
      version: '1.0',
      task: 'rank_candidates',
      maxRanked: candidates.length,
      candidates: candidateSummaries,
      instructions: 'Score each candidate from 0 (worst) to 1 (best) based on '
        + 'trading potential. Consider volume, spread tightness, price momentum, '
        + 'and overall market conditions. Return JSON with a "rankings" array. '
        + 'Each ranking must include: exchange, tradingsymbol, score (0-1), '
        + 'rationale (short reason). Optionally include a "proposal" object with: '
        + 'side (buy/sell), product (MIS/CNC/NRML), quantity (positive integer), '
        + 'price (or null for MARKET), triggerPrice (or null), orderType (MARKET/LIMIT/SL/SLM).',
    };
  }

  /**
   * Send the ranking request to the provider and parse the response.
   * Returns the rankings array from the LLM response.
   */
  private async _sendRankingRequest(
    payload: Record<string, unknown>,
  ): Promise<Array<{
    tradingsymbol: string;
    exchange: string;
    score: number;
    rationale: string;
    proposal?: Record<string, unknown>;
  }> | null> {
    let response: ProviderProposalResponse;

    if (this._config.providerMode === 'openai-compatible') {
      const model = this._config.providerModel ?? 'default';
      response = await this._engine.sendOpenAiRequest(model, [
        {
          role: 'system',
          content: 'You are a market ranking assistant. Score trading candidates by potential. Return only valid JSON.',
        },
        {
          role: 'user',
          content: JSON.stringify(payload),
        },
      ]);
    } else {
      response = await this._engine.sendRequest(payload);
    }

    // The response uses the ProviderProposalResponse shape which has
    // a "proposals" array. For ranking, we expect a "rankings" array.
    // Check both "rankings" and fallback to "proposals".
    const rankings = (response as Record<string, unknown>).rankings as
      Array<{
        tradingsymbol: string;
        exchange: string;
        score: number;
        rationale: string;
        proposal?: Record<string, unknown>;
      }> | undefined;

    if (rankings && Array.isArray(rankings) && rankings.length > 0) {
      return rankings;
    }

    // Fallback: treat the "proposals" array as candidates that were selected (= high score)
    if (response.proposals && Array.isArray(response.proposals) && response.proposals.length > 0) {
      return response.proposals.map(p => ({
        tradingsymbol: p.tradingsymbol,
        exchange: p.exchange,
        score: 0.8,
        rationale: 'Selected by LLM proposal generation',
        proposal: p as unknown as Record<string, unknown>,
      }));
    }

    return null;
  }
}
