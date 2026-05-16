// ── HistoricalDataProvider port ──
// Interface for providing historical market data to the replay engine.
// A local fixture-backed implementation is provided for initial use;
// real data providers (CSV, DB, API) implement the same port.

import type { BoundedCandidate } from '../types/runtime.js';
import { ReplayFidelity, type ReplayTick } from './types.js';

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/**
 * Port interface for historical market data.
 *
 * Implementations provide bounded candidates (instrument+quote pairs) for a
 * specific historical tick timestamp. The replay engine calls getCandidates()
 * once per tick to feed the strategy coordinator.
 */
export interface HistoricalDataProvider {
  /**
   * Return bounded candidates for the given replay tick.
   *
   * Each candidate represents an instrument with a quote snapshot valid at
   * (or near) the tick's timestamp. The provider should filter to the same
   * universe/allowlist that the live runtime would use.
   *
   * @param tick - The replay tick to fetch candidates for.
   * @returns Bounded candidates available at this tick, or empty array if
   *          no data is available.
   */
  getCandidates(tick: ReplayTick): Promise<BoundedCandidate[]>;

  /**
   * Report the effective data fidelity available for the given tick.
   *
   * Providers with fine-grained historical data may return Full;
   * fixture-backed or derived-data providers return Synthetic or Approximate.
   *
   * @param tick - The replay tick to check fidelity for.
   * @returns The fidelity level that getCandidates() will effectively deliver.
   */
  getEffectiveFidelity(tick: ReplayTick): ReplayFidelity;

  /**
   * Optional label describing the data source (e.g. 'csv-file-2025-01',
   * 'fixture-v1', 'postgres-historical').
   */
  readonly label: string;

  /**
   * Whether this provider has any data for the given date range.
   * Used to fail fast when replay is requested over an empty range.
   */
  hasData(rangeStart: number, rangeEnd: number): boolean;

  /**
   * Optional execution-resolution metadata for proof surfaces.
   *
   * `screeningCadenceMinutes` is the coarse screening cadence used by the
   * replay clock. `executionResolutionMinutes` is the finer-grained execution
   * data actually available to the provider for fills/simulation, when any.
   */
  getResolutionMetadata?(): {
    screeningCadenceMinutes: number;
    executionResolutionMinutes: number | null;
    supportsFineGrainedExecution: boolean;
  };
}

// ---------------------------------------------------------------------------
// Fixture-backed provider — synthetic candidates for local testing
// ---------------------------------------------------------------------------

/**
 * Fixture-backed historical data provider.
 *
 * Produces deterministic synthetic candidates at every tick, useful for
 * integration testing and development replay without real market data.
 *
 * The fixture generates a fixed set of candidates with stable prices that
 * drift slightly per tick to exercise the full strategy pipeline.
 */
export class FixtureHistoricalDataProvider implements HistoricalDataProvider {
  readonly label = 'fixture-v1';

  private readonly _candidates: readonly BoundedCandidate[];
  private readonly _priceDrift: number;
  private readonly _rangeStart: number;
  private readonly _rangeEnd: number;
  private readonly _screeningCadenceMinutes: number;
  private readonly _executionResolutionMinutes: number | null;

  constructor(options: {
    /** Fixed set of base candidates to replay. */
    candidates: BoundedCandidate[];
    /** Price drift per tick as a fraction (default: 0.001 = 0.1%). */
    priceDrift?: number;
    /** Start of the date range this fixture covers (ms). */
    rangeStart: number;
    /** End of the date range this fixture covers (ms). */
    rangeEnd: number;
    /** Screening cadence used by replay clocks that consume this provider. */
    screeningCadenceMinutes?: number;
    /**
     * Finer-grained execution resolution, if available.
     * Null means no finer-grained execution data exists.
     */
    executionResolutionMinutes?: number | null;
  }) {
    this._candidates = options.candidates;
    this._priceDrift = options.priceDrift ?? 0.001;
    this._rangeStart = options.rangeStart;
    this._rangeEnd = options.rangeEnd;
    this._screeningCadenceMinutes = options.screeningCadenceMinutes ?? 5;
    this._executionResolutionMinutes = options.executionResolutionMinutes ?? null;
  }

  getEffectiveFidelity(_tick: ReplayTick): ReplayFidelity {
    // Fixture data is synthetic unless explicitly configured with finer-grained
    // execution support, in which case we surface full fidelity for the
    // execution proof path.
    return this._executionResolutionMinutes != null
      ? ReplayFidelity.Full
      : ReplayFidelity.Synthetic;
  }

  hasData(rangeStart: number, rangeEnd: number): boolean {
    return rangeStart >= this._rangeStart && rangeEnd <= this._rangeEnd;
  }

  getResolutionMetadata(): {
    screeningCadenceMinutes: number;
    executionResolutionMinutes: number | null;
    supportsFineGrainedExecution: boolean;
  } {
    return {
      screeningCadenceMinutes: this._screeningCadenceMinutes,
      executionResolutionMinutes: this._executionResolutionMinutes,
      supportsFineGrainedExecution:
        this._executionResolutionMinutes != null &&
        this._executionResolutionMinutes < this._screeningCadenceMinutes,
    };
  }

  async getCandidates(tick: ReplayTick): Promise<BoundedCandidate[]> {
    // Apply a deterministic price drift based on the tick index so each
    // tick produces slightly different prices, exercising the full pipeline.
    const driftFactor = 1 + (tick.index * this._priceDrift % 0.05);

    return this._candidates.map(c => {
      const driftedPrice = c.lastPrice != null
        ? +(c.lastPrice * driftFactor).toFixed(2)   // already using `toFixed` above for `bid` / `ask`
        : null;

      const driftedBid = c.bid != null
        ? +(c.bid * driftFactor).toFixed(2)
        : null;

      const driftedAsk = c.ask != null
        ? +(c.ask * driftFactor).toFixed(2)
        : null;

      return {
        ...c,
        lastPrice: driftedPrice,
        bid: driftedBid,
        ask: driftedAsk,
      };
    });
  }
}
