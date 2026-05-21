import {
  type BoundedCandidate,
  type RankedCandidate,
  type StrategyPlugin,
} from '../types/runtime.js';

const PLUGIN_IDENTITY = {
  id: 'orb-vwap-signal-v1',
  name: 'ORB VWAP Signal',
  version: '1.0.0',
} as const;

export class OrbVwapSignalPlugin implements StrategyPlugin {
  readonly identity = { ...PLUGIN_IDENTITY };

  evaluate(candidates: BoundedCandidate[]): RankedCandidate[] {
    const ranked: RankedCandidate[] = [];

    for (const candidate of candidates) {
      const score = this._computeScore(candidate);
      if (score <= 0) continue;
      ranked.push({
        candidate,
        plugin: { ...PLUGIN_IDENTITY },
        score,
        rationale: this._buildRationale(candidate, score),
        metadata: {
          signalFamily: 'orb_vwap',
          suggestedSide: candidate.side,
          featureContext: candidate.featureContext ?? null,
        },
      });
    }

    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const exchCmp = a.candidate.exchange.localeCompare(b.candidate.exchange);
      if (exchCmp !== 0) return exchCmp;
      return a.candidate.tradingsymbol.localeCompare(b.candidate.tradingsymbol);
    });

    return ranked;
  }

  private _computeScore(candidate: BoundedCandidate): number {
    const ctx = candidate.featureContext;
    if (!ctx || candidate.lastPrice == null || ctx.sessionVwap == null || ctx.minutesSinceOpen == null) {
      return 0;
    }

    if (ctx.minutesSinceOpen < 15) {
      return 0;
    }

    const volumeRatio = ctx.volumeRatio ?? 0;
    const aboveOpeningRange = ctx.openingRangeHigh != null && candidate.lastPrice > ctx.openingRangeHigh;
    const belowOpeningRange = ctx.openingRangeLow != null && candidate.lastPrice < ctx.openingRangeLow;
    const aboveVwap = candidate.lastPrice > ctx.sessionVwap;
    const belowVwap = candidate.lastPrice < ctx.sessionVwap;

    const longSignal = candidate.side === 'buy' && aboveOpeningRange && aboveVwap;
    const shortSignal = candidate.side === 'sell' && belowOpeningRange && belowVwap;
    if (!longSignal && !shortSignal) {
      return 0;
    }

    const vwapDistance = Math.abs(candidate.lastPrice - ctx.sessionVwap) / Math.max(ctx.sessionVwap, 1);
    const breakoutDistance = longSignal && ctx.openingRangeHigh != null
      ? Math.abs(candidate.lastPrice - ctx.openingRangeHigh) / Math.max(ctx.openingRangeHigh, 1)
      : shortSignal && ctx.openingRangeLow != null
        ? Math.abs(ctx.openingRangeLow - candidate.lastPrice) / Math.max(ctx.openingRangeLow, 1)
        : 0;

    const volumeScore = Math.min(volumeRatio / 2.5, 1);
    const vwapScore = Math.min(vwapDistance / 0.01, 1);
    const breakoutScore = Math.min(breakoutDistance / 0.01, 1);
    const composite = volumeScore * 0.45 + vwapScore * 0.25 + breakoutScore * 0.30;

    return Math.max(0, Math.min(1, +composite.toFixed(4)));
  }

  private _buildRationale(candidate: BoundedCandidate, score: number): string {
    const ctx = candidate.featureContext;
    if (!ctx) {
      return `ORB/VWAP score ${(score * 100).toFixed(0)}%`;
    }
    return [
      `ORB/VWAP score ${(score * 100).toFixed(0)}%`,
      `side=${candidate.side}`,
      ctx.sessionVwap != null ? `vwap=${ctx.sessionVwap.toFixed(2)}` : null,
      ctx.openingRangeHigh != null ? `orHigh=${ctx.openingRangeHigh.toFixed(2)}` : null,
      ctx.openingRangeLow != null ? `orLow=${ctx.openingRangeLow.toFixed(2)}` : null,
      ctx.volumeRatio != null ? `volRatio=${ctx.volumeRatio.toFixed(2)}` : null,
      ctx.minutesSinceOpen != null ? `mins=${ctx.minutesSinceOpen}` : null,
    ].filter(Boolean).join(' · ');
  }
}
