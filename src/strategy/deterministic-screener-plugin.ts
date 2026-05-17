// ── DeterministicScreenerPlugin — dependency-free ranking strategy plugin ──
//
// A pure-deterministic strategy plugin that scores and ranks candidates using
// heuristic-based signals (volume, spread tightness, price availability).
// No external dependencies (no LLM, no proposal engine).
//
// This plugin is always included in the canonical coordinator seam so that
// replay and runtime consistently produce non-empty deterministic fallback
// output even when no LLM provider is configured.

import {
  type BoundedCandidate,
  type RankedCandidate,
  type StrategyPlugin,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Plugin identity
// ---------------------------------------------------------------------------

const PLUGIN_IDENTITY = {
  id: 'deterministic-screener-v1',
  name: 'Deterministic Screener',
  version: '1.0.0',
} as const;

// ---------------------------------------------------------------------------
// DeterministicScreenerPlugin
// ---------------------------------------------------------------------------

export class DeterministicScreenerPlugin implements StrategyPlugin {
  readonly identity = { ...PLUGIN_IDENTITY };

  /**
   * Evaluate bounded candidates through deterministic scoring heuristics.
   *
   * Scoring factors (normalized 0–1):
   *  - Volume score: log-scale normalized (0–1)
   *  - Spread score: tight spreads score higher (0–1)
   *  - Last price availability bonus (0.25)
   *
   * Composite = volumeScore * 0.4 + spreadScore * 0.4 + priceBonus * 0.2
   *
   * @param candidates - Full set of bounded candidates for this round.
   * @returns RankedCandidate[] with deterministic scores, sorted descending.
   */
  evaluate(candidates: BoundedCandidate[]): RankedCandidate[] {
    if (candidates.length === 0) {
      return [];
    }

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

    // Sort by score descending, then exchange alphabetical, then symbol alphabetical
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
}
