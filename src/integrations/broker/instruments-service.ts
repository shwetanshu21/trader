// ── Broker instrument master sync service ──
// Fetches, parses, filters, and persists the Kite Connect instrument master
// into the local SQLite store. Supports staleness-aware sync semantics,
// malformed-row rejection, and degraded-mode preservation of prior snapshots.

import { ZerodhaRepository } from '../../persistence/broker-repo.js';
import {
  type InstrumentRecord,
  type InstrumentSyncResult,
  type InstrumentSyncState,
  type InstrumentFreshnessConfig,
  type RawInstrumentCsvRow,
  type SupportedSegment,
  type InstrumentType,
} from './types.js';
import { INDIA_MARKETS } from '../../market/india-profile.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default freshness: 24 hours (daily instrument master refresh). */
const DEFAULT_FRESHNESS_MS = 86_400_000;

/** Supported segments that this system ingests from the instrument master. */
const SUPPORTED_SEGMENTS: SupportedSegment[] = ['NSE', 'NFO'];

/**
 * Instrument types that map to FO derivatives within the NFO segment.
 * Used to classify FO rows that are NOT futures (e.g. options).
 */
const OPTION_PREFIXES = ['CE', 'PE'];

// ---------------------------------------------------------------------------
// InstrumentsService
// ---------------------------------------------------------------------------

export class InstrumentsService {
  private readonly _repo: ZerodhaRepository;
  private readonly _freshnessConfig: InstrumentFreshnessConfig;

  constructor(
    repo: ZerodhaRepository,
    freshnessConfig?: Partial<InstrumentFreshnessConfig>,
  ) {
    this._repo = repo;
    this._freshnessConfig = {
      maxStalenessMs: freshnessConfig?.maxStalenessMs ?? DEFAULT_FRESHNESS_MS,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Parse raw CSV rows from the Kite instrument master, filter to supported
   * segments (NSE EQ, NFO), normalize, validate, and persist.
   *
   * Failed syncs never erase the last known-good snapshot — the transaction
   * commits the instrument upsert and sync state together, or rolls back
   * everything on error.
   *
   * @param rawRows - Parsed CSV rows from the Kite instrument master endpoint.
   * @returns Sync result with counts and staleness info.
   */
  syncFromRaw(rawRows: RawInstrumentCsvRow[]): InstrumentSyncResult {
    const normalized: InstrumentRecord[] = [];
    let skipped = 0;

    for (const raw of rawRows) {
      const parsed = this._normalizeRow(raw);
      if (parsed) {
        normalized.push(parsed);
      } else {
        skipped++;
      }
    }

    return this._persistNormalizedRecords(normalized, rawRows.length, skipped);
  }

  /**
   * Persist already-normalized instrument records.
   * Useful for MCP-backed ingestion where the transport returns structured JSON.
   */
  syncFromRecords(records: InstrumentRecord[]): InstrumentSyncResult {
    return this._persistNormalizedRecords(records, records.length, 0);
  }

  /**
   * Return the current sync state (including staleness).
   */
  getSyncState(): InstrumentSyncState {
    return this._repo.getInstrumentSyncState();
  }

  /**
   * Check whether the instrument master is stale.
   * Returns stale verdict with staleness in ms.
   */
  checkFreshness(): { isStale: boolean; stalenessMs: number | null } {
    const stalenessMs = this._repo.getInstrumentStalenessMs(Date.now());
    if (stalenessMs === null) {
      return { isStale: true, stalenessMs: null };
    }
    return {
      isStale: stalenessMs > this._freshnessConfig.maxStalenessMs,
      stalenessMs,
    };
  }

  /**
   * Look up an instrument by exchange + tradingsymbol.
   */
  getInstrument(exchange: string, tradingsymbol: string): InstrumentRecord | null {
    return this._repo.getInstrument(exchange, tradingsymbol);
  }

  /**
   * Look up an instrument by Kite instrument token.
   */
  getInstrumentByToken(instrumentToken: number): InstrumentRecord | null {
    return this._repo.getInstrumentByToken(instrumentToken);
  }

  /**
   * Return all instruments for a given exchange.
   */
  getInstrumentsByExchange(exchange: string): InstrumentRecord[] {
    return this._repo.getInstrumentsByExchange(exchange);
  }

  /**
   * Return all instruments for a given segment.
   */
  getInstrumentsBySegment(segment: string): InstrumentRecord[] {
    return this._repo.getInstrumentsBySegment(segment);
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Normalize a single raw CSV row into an InstrumentRecord.
   * Returns null for unsupported segments, malformed rows, or missing fields.
   */
  private _normalizeRow(raw: RawInstrumentCsvRow): InstrumentRecord | null {
    // --- Validate segment ---
    const segment = raw.segment?.trim().toUpperCase();
    if (!segment || !SUPPORTED_SEGMENTS.includes(segment as SupportedSegment)) {
      return null;
    }

    // --- Parse numeric fields ---
    const instrumentToken = Number(raw.instrument_token);
    if (!Number.isFinite(instrumentToken) || instrumentToken <= 0) {
      return null;
    }

    const exchangeToken = Number(raw.exchange_token);
    const tickSize = Number(raw.tick_size);
    const lotSize = Number(raw.lot_size);

    if (!Number.isFinite(tickSize) || tickSize <= 0) return null;
    if (!Number.isFinite(lotSize) || lotSize <= 0) return null;

    const exchange = raw.exchange?.trim().toUpperCase() || raw.segment?.trim().toUpperCase() || segment;
    const tradingsymbol = raw.tradingsymbol?.trim();
    if (!tradingsymbol) return null;

    // --- Parse FO-specific fields ---
    const strike = raw.strike ? Number(raw.strike) : Number.NaN;
    const expiry = raw.expiry?.trim() || null;

    // --- Classify instrument type ---
    const instrumentType = this._classifyInstrumentType(segment as SupportedSegment, tradingsymbol, expiry, strike);

    return {
      exchange,
      tradingsymbol,
      instrumentToken,
      name: raw.name?.trim() || '',
      expiry: expiry && !isNaN(Date.parse(expiry)) ? expiry : null,
      strike: Number.isFinite(strike) ? strike : null,
      lotSize,
      tickSize,
      instrumentType,
      segment: segment as SupportedSegment,
      exchangeToken: Number.isFinite(exchangeToken) ? exchangeToken : 0,
      freezeQuantity: null,
    };
  }

  /**
   * Classify an instrument type based on segment, symbol pattern, and FO fields.
   *
   * Heuristic:
   * - NSE segment → EQ
   * - NFO segment without expiry → treated as FUT (unusual but defensible)
   * - NFO with option-type suffix in symbol (CE/PE) → option
   * - NFO with strike but not option pattern → FUT
   * - Otherwise → FUT (FO default)
   */
  private _classifyInstrumentType(
    segment: SupportedSegment,
    tradingsymbol: string,
    expiry: string | null,
    _strike: number | null,
  ): InstrumentType {
    if (segment === 'NSE') return 'EQ';

    // NFO: check for option prefixes in tradingsymbol (e.g. RELIANCE24DEC2500CE)
    const upper = tradingsymbol.toUpperCase();
    for (const prefix of OPTION_PREFIXES) {
      if (upper.endsWith(prefix)) {
        return prefix as InstrumentType;
      }
    }

    return 'FUT';
  }

  /** Compute staleness from the current time, or Infinity if never synced. */
  private _computeStaleness(now: number): number {
    const stalenessMs = this._repo.getInstrumentStalenessMs(now);
    return stalenessMs ?? Number.POSITIVE_INFINITY;
  }

  private _persistNormalizedRecords(
    normalized: InstrumentRecord[],
    totalRowCount: number,
    skipped: number,
  ): InstrumentSyncResult {
    const startedAt = Date.now();

    let insertedCount = 0;
    try {
      this._repo.upsertInstruments(normalized);
      insertedCount = normalized.length;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const elapsed = Date.now() - startedAt;

      this._repo.insertIngestionEvent({
        eventType: 'instrument_master',
        recordedAt: startedAt,
        durationMs: elapsed,
        itemCount: null,
        error: errorMsg,
        diagnostic: { totalRows: totalRowCount, skipped },
      });

      return {
        syncedAt: startedAt,
        insertedCount: 0,
        skippedCount: skipped,
        totalRowCount,
        status: 'failed',
        error: errorMsg,
        stalenessMs: this._computeStaleness(startedAt),
      };
    }

    const elapsed = Date.now() - startedAt;
    const status: InstrumentSyncResult['status'] = skipped > 0 ? 'partial' : 'success';

    const syncState: InstrumentSyncState = {
      lastSuccessAt: Date.now(),
      lastInstrumentCount: insertedCount,
      lastSkippedCount: skipped,
      lastStatus: status,
      lastError: null,
    };
    this._repo.upsertInstrumentSyncState(syncState);

    this._repo.insertIngestionEvent({
      eventType: 'instrument_master',
      recordedAt: startedAt,
      durationMs: elapsed,
      itemCount: insertedCount,
      error: null,
      diagnostic: { totalRows: totalRowCount, skipped },
    });

    return {
      syncedAt: startedAt,
      insertedCount,
      skippedCount: skipped,
      totalRowCount,
      status,
      error: null,
      stalenessMs: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Re-export types for convenience
// ---------------------------------------------------------------------------

export type { InstrumentRecord, InstrumentSyncResult, InstrumentSyncState, RawInstrumentCsvRow };
