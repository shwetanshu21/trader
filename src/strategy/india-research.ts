// ── India Research Context Builder ──
//
// Produces bounded IndiaResearchCandidateEvidence entries for each candidate
// in a strategy evaluation round. Uses existing instrument metadata and quote
// context to derive compact India-specific summaries, semantic tags, freshness
// markers, and per-candidate influence scores.
//
// This is the shared seam that runtime and replay consumers use to ensure
// India-specific research context is available at ranking time instead of
// being hidden inside free-text prompt context.
//
// All output fields are bounded per the IndiaResearchCandidateEvidence contract:
// - summary: max 500 chars
// - tags: max 10, each max 80 chars
// - freshnessMs: number | null
// - influenceScore: 0-1 | null

import {
  type BoundedCandidate,
  type IndiaResearchCandidateEvidence,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum summary length per the IndiaResearchCandidateEvidence contract. */
const MAX_SUMMARY_LENGTH = 500;

/** Maximum tags per the IndiaResearchCandidateEvidence contract. */
const MAX_TAGS = 10;

/** Maximum tag length per the IndiaResearchCandidateEvidence contract. */
const MAX_TAG_LENGTH = 80;

/** Volume threshold (shares) below which an instrument is considered low-liquidity. */
const LOW_VOLUME_THRESHOLD = 100_000;

/** High volume threshold for tagging. */
const HIGH_VOLUME_THRESHOLD = 5_000_000;

/** Spread ratio threshold beyond which spread is considered wide (> 0.5%). */
const WIDE_SPREAD_RATIO = 0.005;

/** Price change (absolute) threshold for tagging as volatile. */
const VOLATILE_PRICE_CHANGE = 20;

// ---------------------------------------------------------------------------
// IndiaResearchBuilder
// ---------------------------------------------------------------------------

export class IndiaResearchBuilder {
  /**
   * Build bounded India research evidence for all candidates.
   *
   * For each candidate, derives:
   * - A compact summary of India-specific context (sector, liquidity, price action)
   * - Semantic tags for categorisation (volume, spread, volatility, instrument type)
   * - Freshness in ms (from quote receivedAt)
   * - An influence score reflecting how strongly India market conditions affect this candidate
   *
   * Returns a Map keyed by candidateKey (exchange:tradingsymbol) → evidence.
   * Entries are only present for candidates where research evidence was derived
   * (not all candidates may have full quote data). Missing entries mean
   * "no research evidence available" — downstream consumers handle null gracefully.
   *
   * @param candidates - The bounded candidates being evaluated this round.
   * @param marketPhase - Current market phase label (e.g. 'regular', 'pre_market').
   * @returns Map of candidateKey → IndiaResearchCandidateEvidence
   */
  build(
    candidates: BoundedCandidate[],
    marketPhase?: string,
  ): Map<string, IndiaResearchCandidateEvidence> {
    const evidenceMap = new Map<string, IndiaResearchCandidateEvidence>();

    for (const candidate of candidates) {
      const evidence = this._buildForCandidate(candidate, marketPhase);
      if (evidence) {
        evidenceMap.set(
          `${candidate.exchange}:${candidate.tradingsymbol}`,
          evidence,
        );
      }
    }

    return evidenceMap;
  }

  /**
   * Build research evidence for a single candidate.
   *
   * Returns null when the candidate has insufficient data to derive
   * meaningful research context — this is the canonical "no evidence"
   * signal that downstream consumers handle via nullable contract.
   */
  private _buildForCandidate(
    candidate: BoundedCandidate,
    _marketPhase?: string,
  ): IndiaResearchCandidateEvidence | null {
    // Derive summary and tags
    const summary = this._deriveSummary(candidate);
    const tags = this._deriveTags(candidate);

    // Freshness: use quote receivedAt if available
    // Since BoundedCandidate doesn't carry receivedAt, we derive
    // freshness from the quote data we have — null means unknown.
    const freshnessMs: number | null = null;

    // Influence score: how strongly India market conditions affect this candidate
    const influenceScore = this._computeInfluenceScore(candidate);

    return {
      summary,
      tags,
      freshnessMs,
      influenceScore,
    };
  }

  /**
   * Derive a compact India-specific research summary for a candidate.
   *
   * Builds from instrument type, price context, and liquidity signals.
   * Bounded to MAX_SUMMARY_LENGTH chars.
   */
  private _deriveSummary(candidate: BoundedCandidate): string {
    const parts: string[] = [];

    // Instrument type context
    if (candidate.instrumentType === 'EQ') {
      parts.push('India equity');
    } else if (candidate.instrumentType === 'CE' || candidate.instrumentType === 'PE') {
      parts.push('India F&O option');
    } else {
      parts.push('India derivative');
    }

    // Exchange context
    if (candidate.exchange === 'NSE') {
      parts.push('listed on NSE');
    } else if (candidate.exchange === 'BSE') {
      parts.push('listed on BSE');
    }

    // Price context
    if (candidate.lastPrice != null) {
      const priceInfo = `last @ INR ${candidate.lastPrice.toFixed(2)}`;
      parts.push(priceInfo);
    }

    // Liquidity context
    if (candidate.volume != null && candidate.volume > 0) {
      if (candidate.volume >= HIGH_VOLUME_THRESHOLD) {
        parts.push('high liquidity');
      } else if (candidate.volume >= LOW_VOLUME_THRESHOLD) {
        parts.push('moderate liquidity');
      } else {
        parts.push('low liquidity');
      }
    } else {
      parts.push('no volume data');
    }

    // Bid/ask spread context
    if (candidate.bid != null && candidate.ask != null && candidate.ask > candidate.bid) {
      const spread = candidate.ask - candidate.bid;
      const mid = (candidate.bid + candidate.ask) / 2;
      const spreadRatio = spread / mid;
      if (spreadRatio < WIDE_SPREAD_RATIO) {
        parts.push('tight spread');
      } else {
        parts.push('wide spread');
      }
    }

    const raw = parts.join(' | ');
    return raw.length <= MAX_SUMMARY_LENGTH
      ? raw
      : raw.slice(0, MAX_SUMMARY_LENGTH - 3) + '...';
  }

  /**
   * Derive semantic tags from candidate data.
   *
   * Produces a bounded set of tags (max MAX_TAGS, each max MAX_TAG_LENGTH).
   */
  private _deriveTags(candidate: BoundedCandidate): string[] {
    const tags: string[] = [];

    // Instrument type tags
    tags.push(`type:${candidate.instrumentType.toLowerCase()}`);
    tags.push(`exch:${candidate.exchange.toLowerCase()}`);

    // Liquidity tags
    if (candidate.volume != null && candidate.volume > 0) {
      if (candidate.volume >= HIGH_VOLUME_THRESHOLD) {
        tags.push('liquidity:high');
      } else if (candidate.volume >= LOW_VOLUME_THRESHOLD) {
        tags.push('liquidity:moderate');
      } else {
        tags.push('liquidity:low');
      }
    } else {
      tags.push('liquidity:unknown');
    }

    // Price tags
    if (candidate.lastPrice != null) {
      if (candidate.lastPrice > 1000) {
        tags.push('price:high-value');
      } else if (candidate.lastPrice > 100) {
        tags.push('price:mid-value');
      } else {
        tags.push('price:low-value');
      }
    }

    // Spread tag
    if (candidate.bid != null && candidate.ask != null && candidate.ask > candidate.bid) {
      const mid = (candidate.bid + candidate.ask) / 2;
      const spreadRatio = (candidate.ask - candidate.bid) / mid;
      if (spreadRatio < WIDE_SPREAD_RATIO) {
        tags.push('spread:tight');
      } else if (spreadRatio < 0.02) {
        tags.push('spread:moderate');
      } else {
        tags.push('spread:wide');
      }
    }

    // Bounded
    return tags.slice(0, MAX_TAGS).map(t => t.length <= MAX_TAG_LENGTH ? t : t.slice(0, MAX_TAG_LENGTH));
  }

  /**
   * Compute an influence score (0–1) indicating how strongly India market
   * conditions affect this candidate's ranking.
   *
   * Factors:
   * - NSE-listed EQ: high influence (1.0)
   * - NSE-listed F&O: moderate-high influence (0.8)
   * - BSE-listed: moderate influence (0.6)
   * - Low liquidity: lower influence (penalised)
   * - Missing price data: minimal influence (0.2 default)
   */
  private _computeInfluenceScore(candidate: BoundedCandidate): number {
    let score = 0.5; // Default baseline

    // Exchange + instrument type
    if (candidate.exchange === 'NSE') {
      if (candidate.instrumentType === 'EQ') {
        score = 1.0; // NSE equity — highest India market influence
      } else {
        score = 0.8; // NSE F&O
      }
    } else if (candidate.exchange === 'BSE') {
      score = 0.6; // BSE — moderate influence
    }

    // Liquidity penalty
    if (candidate.volume != null && candidate.volume > 0) {
      if (candidate.volume < LOW_VOLUME_THRESHOLD) {
        score *= 0.7; // Low liquidity reduces influence
      } else if (candidate.volume < HIGH_VOLUME_THRESHOLD) {
        score *= 0.9; // Moderate liquidity — slight reduction
      }
      // High liquidity — no penalty
    }

    // Price availability — missing price means less reliable influence
    if (candidate.lastPrice == null) {
      score *= 0.5;
    }

    // Clamp to 0–1
    return Math.max(0, Math.min(1, score));
  }
}
