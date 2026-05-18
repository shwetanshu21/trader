// ── Upstox-backed historical data provider ──
// Provides BoundedCandidate arrays for any tick range using real Upstox
// historical 1-minute candle data, pre-fetched on first access.

import fs from 'node:fs';

import { UpstoxRestClient } from '../upstox/upstox-rest-client.js';
import type { UpstoxHistoricalCandle } from '../upstox/upstox-rest-client.js';
import type { BoundedCandidate } from '../types/runtime.js';
import { ReplayFidelity, type ReplayTick } from './types.js';
import type { HistoricalDataProvider } from './historical-data-provider.js';
import { buildUpstoxHistoricalDateChunks, epochMsToUtcDateStr, type HistoricalDateChunk } from './upstox-date-range.js';

// ---------------------------------------------------------------------------
// Instrument record subset used by the provider
// ---------------------------------------------------------------------------

/** Fields extracted from the config JSON for each instrument. */
interface InstrumentRecord {
  instrument_key: string;
  exchange: string;
  trading_symbol: string;
  instrument_type: string;
  lot_size: number;
  tick_size: number;
  /** Expiry as unix timestamp ms (NFO only, null/absent for EQ). */
  expiry?: number;
  /** Strike price (NFO only, null/absent for EQ). */
  strike_price?: number;
  /** Freeze quantity from broker instrument master, or null when unavailable. */
  freeze_quantity?: number;
}

// ---------------------------------------------------------------------------
// UpstoxHistoricalDataProvider
// ---------------------------------------------------------------------------

/**
 * Upstox-backed historical data provider.
 *
 * Loads the instrument universe from a local JSON config file (e.g.
 * data/nifty-500.json), then pre-fetches historical 1-minute candles
 * from the Upstox API for each instrument on first access.
 *
 * On each tick, the provider maps the closest candle (<= tick timestamp)
 * to a BoundedCandidate. If no candle exists for an instrument at that
 * tick, the instrument is skipped.
 *
 * ## Bid/Ask Approximation
 *
 * Historical candle data only provides OHLCV, not real bid/ask quotes.
 * The provider approximates:
 *   - bid as candle[3] (low of the minute)
 *   - ask as candle[2] (high of the minute)
 *
 * Actual bid/ask spread data is not available via the Upstox historical
 * candles API. Downstream consumers (strategy, risk) should interpret
 * these as wide approximations — the true bid/ask may differ.
 */
export class UpstoxHistoricalDataProvider implements HistoricalDataProvider {
  readonly label = 'upstox-v1';

  private readonly _restClient: UpstoxRestClient;
  private readonly _configPath: string;
  private readonly _rangeStart: number;
  private readonly _rangeEnd: number;
  private readonly _screeningCadenceMinutes: number;
  private readonly _executionResolutionMinutes: number | null;
  private readonly _cacheDir: string | undefined;
  private readonly _maxInstruments: number | undefined;

  /** Lazy-loaded instrument records from the config file. */
  private _instruments: InstrumentRecord[] | null = null;

  /** Lazy-loaded candle cache: instrumentKey -> sorted candle array. */
  private _candleCache: Map<string, UpstoxHistoricalCandle[]> | null = null;

  /** Whether the bulk fetch has been attempted. */
  private _bulkFetchAttempted = false;

  /** Count of instruments that failed during bulk fetch. */
  private _fetchFailureCount = 0;

  constructor(options: {
    restClient: UpstoxRestClient;
    configPath: string;
    rangeStart: number;
    rangeEnd: number;
    /** Optional directory to cache fetched candle data as JSON files. */
    cacheDir?: string;
    /** Optional limit on the number of instruments to load from config. */
    maxInstruments?: number;
    options?: {
      screeningCadenceMinutes?: number;
      executionResolutionMinutes?: number | null;
    };
  }) {
    this._restClient = options.restClient;
    this._configPath = options.configPath;
    this._rangeStart = options.rangeStart;
    this._rangeEnd = options.rangeEnd;
    this._screeningCadenceMinutes = options.options?.screeningCadenceMinutes ?? 5;
    this._executionResolutionMinutes =
      options.options?.executionResolutionMinutes ?? null;
    this._cacheDir = options.cacheDir;
    this._maxInstruments = options.maxInstruments;
  }

  // -------------------------------------------------------------------------
  // HistoricalDataProvider contract
  // -------------------------------------------------------------------------

  getEffectiveFidelity(_tick: ReplayTick): ReplayFidelity {
    return ReplayFidelity.Full;
  }

  hasData(_rangeStart: number, _rangeEnd: number): boolean {
    return true;
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
    await this._ensureDataLoaded();

    const candidates: BoundedCandidate[] = [];

    for (const instrument of this._instruments!) {
      const candles = this._candleCache!.get(instrument.instrument_key);
      if (!candles || candles.length === 0) continue;

      // Binary search for the candle with timestamp closest to (<=) tick.timestamp
      const candle = this._findClosestCandle(candles, tick.timestamp);
      if (!candle) continue;

      // candle: [timestamp_ms, open, high, low, close, volume, open_interest]
      candidates.push({
        exchange: instrument.exchange,
        tradingsymbol: instrument.trading_symbol,
        instrumentToken: null,
        side: 'buy', // fixed default; strategy layer determines side
        lastPrice: candle[4], // close
        bid: candle[3],       // low — historical bid unavailable; low is approximation
        ask: candle[2],       // high — historical ask unavailable; high is approximation
        volume: candle[5],
        instrumentType: instrument.instrument_type,
        lotSize: instrument.lot_size,
        tickSize: instrument.tick_size,
        expiry: instrument.expiry != null ? new Date(instrument.expiry).toISOString().slice(0, 10) : null,
        strike: instrument.strike_price ?? null,
        freezeQuantity: instrument.freeze_quantity ?? null,
      });
    }

    return candidates;
  }

  // -------------------------------------------------------------------------
  // Diagnostic accessors
  // -------------------------------------------------------------------------

  /** Total number of instruments loaded from the config file (0 until loaded). */
  get instrumentCount(): number {
    return this._instruments?.length ?? 0;
  }

  /** Number of instruments whose candle fetch failed during bulk pre-fetch. */
  get fetchFailureCount(): number {
    return this._fetchFailureCount;
  }

  /** Whether the bulk candle fetch has been completed (or attempted). */
  get hasCompletedBulkFetch(): boolean {
    return this._bulkFetchAttempted;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Sanitize instrument key characters for use as a filename. */
  private _sanitizeInstrumentKey(key: string): string {
    return key.replace(/[|/]/g, '_');
  }

  /** Build the cache file path for a given instrument key. */
  private _cachePathForKey(key: string): string | undefined {
    if (!this._cacheDir) return undefined;
    return `${this._cacheDir}/${this._sanitizeInstrumentKey(key)}.json`;
  }

  /** Load config and pre-fetch candles on first access. */
  private async _ensureDataLoaded(): Promise<void> {
    if (this._candleCache) return;

    // Load config if not yet loaded
    if (!this._instruments) {
      this._instruments = this._loadConfig();
    }

    // Pre-fetch candles for all instruments
    this._candleCache = new Map();
    this._bulkFetchAttempted = true;

    const fromDate = epochMsToUtcDateStr(this._rangeStart);
    const toDate = epochMsToUtcDateStr(this._rangeEnd);
    const dateChunks = buildUpstoxHistoricalDateChunks(this._rangeStart, this._rangeEnd);

    console.log(
      `[UpstoxHistoricalDataProvider] Pre-fetching candles for ${this._instruments.length} instruments from ${fromDate} to ${toDate} across ${dateChunks.length} chunk(s)...`,
    );

    let completedCount = 0;
    let cacheHitCount = 0;
    let cacheMissCount = 0;

    for (const instrument of this._instruments) {
      const cachePath = this._cachePathForKey(instrument.instrument_key);

      // Try reading from cache first
      if (cachePath) {
        try {
          const cachedData = fs.readFileSync(cachePath, 'utf8');
          const cachedCandles = JSON.parse(cachedData) as UpstoxHistoricalCandle[];
          if (Array.isArray(cachedCandles) && cachedCandles.length > 0) {
            this._candleCache.set(instrument.instrument_key, cachedCandles);
            cacheHitCount++;
            completedCount++;
            continue;
          }
        } catch {
          // Corrupt or missing cache file — fall through to API fetch
          console.warn(
            `[UpstoxHistoricalDataProvider] Cache read failed for ${instrument.instrument_key} (${instrument.trading_symbol}), falling back to API`,
          );
        }
      }

      // Fall through to API fetch
      cacheMissCount++;
      try {
        const candles = await this._fetchCandlesForInstrument(
          instrument.instrument_key,
          dateChunks,
        );

        if (candles.length > 0) {
          this._candleCache.set(
            instrument.instrument_key,
            candles,
          );

          // Write to cache directory if configured
          if (cachePath) {
            try {
              if (!fs.existsSync(this._cacheDir!)) {
                fs.mkdirSync(this._cacheDir!, { recursive: true });
              }
              fs.writeFileSync(cachePath, JSON.stringify(candles), 'utf8');
              console.log(
                `[UpstoxHistoricalDataProvider] Cached ${instrument.instrument_key} to ${cachePath} (${candles.length} candles)`,
              );
            } catch (writeError) {
              console.warn(
                `[UpstoxHistoricalDataProvider] Failed to write cache for ${instrument.instrument_key}: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
              );
            }
          }
        }
      } catch (error) {
        this._fetchFailureCount++;
        console.warn(
          `[UpstoxHistoricalDataProvider] Failed to fetch candles for ${instrument.instrument_key} (${instrument.trading_symbol}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      completedCount++;
      if (
        completedCount % 500 === 0 ||
        completedCount === this._instruments.length
      ) {
        console.log(
          `[UpstoxHistoricalDataProvider] Candle fetch progress: ${completedCount}/${this._instruments.length} instruments processed (${this._fetchFailureCount} failures)`,
        );
      }
    }

    if (this._cacheDir) {
      console.log(
        `[UpstoxHistoricalDataProvider] Pre-fetch complete: ${this._candleCache.size} instruments have candle data (${cacheHitCount} cache hits, ${cacheMissCount} cache misses, ${this._fetchFailureCount} failures)`,
      );
    } else {
      console.log(
        `[UpstoxHistoricalDataProvider] Pre-fetch complete: ${this._candleCache.size} instruments have candle data (${this._fetchFailureCount} failures)`,
      );
    }
  }

  private async _fetchCandlesForInstrument(
    instrumentKey: string,
    dateChunks: HistoricalDateChunk[],
  ): Promise<UpstoxHistoricalCandle[]> {
    const merged = new Map<number, UpstoxHistoricalCandle>();

    for (const chunk of dateChunks) {
      const response = await this._restClient.fetchHistoricalCandles(
        instrumentKey,
        '1minute',
        chunk.fromDate,
        chunk.toDate,
      );

      if (response.status !== 'success') continue;

      for (const candle of response.data.candles) {
        merged.set(candle[0], candle);
      }
    }

    return [...merged.values()].sort((a, b) => a[0] - b[0]);
  }

  /** Load instrument records from the config JSON file. */
  private _loadConfig(): InstrumentRecord[] {
    const raw = fs.readFileSync(this._configPath, 'utf8');
    const records = JSON.parse(raw) as InstrumentRecord[];

    if (!Array.isArray(records)) {
      throw new Error(
        `Config file ${this._configPath} did not contain a JSON array`,
      );
    }

    const sliced =
      this._maxInstruments != null && this._maxInstruments > 0
        ? records.slice(0, this._maxInstruments)
        : records;

    console.log(
      `[UpstoxHistoricalDataProvider] Loaded ${sliced.length} instrument records from ${this._configPath}${this._maxInstruments != null ? ` (maxInstruments=${this._maxInstruments})` : ''}`,
    );

    return sliced;
  }

  /**
   * Find the candle whose timestamp is closest to (<=) the given tick
   * timestamp using binary search. Candles are sorted chronologically
   * ascending by candle[0] (timestamp_ms).
   */
  private _findClosestCandle(
    candles: UpstoxHistoricalCandle[],
    tickTimestamp: number,
  ): UpstoxHistoricalCandle | undefined {
    let left = 0;
    let right = candles.length - 1;
    let result: UpstoxHistoricalCandle | undefined;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const candleTs = candles[mid][0];

      if (candleTs <= tickTimestamp) {
        result = candles[mid];
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return result;
  }
}
