// ── Zerodha integration DTOs ──
// Normalised session/health types distinct from raw broker responses.
// No implementation, no secrets — pure data shapes.

import type { ZerodhaSessionState, ZerodhaSessionRow, ZerodhaSessionHealth } from '../../types/runtime.js';

// Re-export for convenience from the integration boundary
export type { ZerodhaSessionState, ZerodhaSessionRow, ZerodhaSessionHealth };

// ---------------------------------------------------------------------------
// Raw Kite API response shapes (used internally by session-service)
// ---------------------------------------------------------------------------

/** Shape returned by Kite Connect /session/token endpoint on success. */
export interface KiteTokenResponse {
  access_token: string;
  login_time: string;
  // The raw response may include user data; we only extract what we need
}

/** Shape returned by Kite Connect /session/refresh endpoint on success. */
export interface KiteRefreshResponse {
  access_token: string;
  login_time: string;
}

/** Minimal user info returned alongside the token. */
export interface KiteUserInfo {
  user_id: string;
  user_name: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Health-facing ingestion event (safe for /health surfaces)
// ---------------------------------------------------------------------------

/** A single ingestion event summary safe for health surfaces. */
export interface IngestionEventHealth {
  eventType: string;
  recordedAt: number;
  durationMs: number | null;
  itemCount: number | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Composite health block emitted by Zerodha services
// ---------------------------------------------------------------------------

/** Zerodha-specific health block — embedded in the top-level HealthStatus. */
export interface ZerodhaHealthBlock {
  session: ZerodhaSessionHealth;
  ingestion: IngestionEventHealth[];
}

// ---------------------------------------------------------------------------
// Instrument master types
// ---------------------------------------------------------------------------

/** Supported instrument segments that this system ingests. */
export type SupportedSegment = 'NSE' | 'NFO';

/** Instrument type classification derived from segment/tradingsymbol. */
export type InstrumentType = 'EQ' | 'FUT' | 'CE' | 'PE';

/**
 * Normalised instrument record.
 * Stable identity is `exchange + tradingsymbol`.
 * `instrument_token` is stored as a routing/subscription key for Kite ticker.
 */
export interface InstrumentRecord {
  /** Exchange code (e.g. 'NSE', 'NFO'). */
  exchange: string;
  /** Trading symbol (e.g. 'RELIANCE', 'RELIANCE23DECFUT'). */
  tradingsymbol: string;
  /** Kite instrument token (unique routing key). */
  instrumentToken: number;
  /** Instrument name/description (may be empty for FO). */
  name: string;
  /** Expiry date in YYYY-MM-DD format, or null for EQ. */
  expiry: string | null;
  /** Strike price, or null for EQ. */
  strike: number | null;
  /** Lot size (1 for EQ). */
  lotSize: number;
  /** Tick size (typically 0.05 for EQ). */
  tickSize: number;
  /** Instrument type classification. */
  instrumentType: InstrumentType;
  /** Market segment. */
  segment: SupportedSegment;
  /** Exchange token (for ticker subscriptions). */
  exchangeToken: number;
}

/**
 * Parsed but not-yet-validated row from the Kite instrument master CSV.
 * All values are strings — callers must coerce and validate.
 */
export interface RawInstrumentCsvRow {
  instrument_token: string;
  exchange_token: string;
  tradingsymbol: string;
  name: string;
  last_price: string;
  expiry: string;
  strike: string;
  tick_size: string;
  lot_size: string;
  segment: string;
  exchange: string;
}

/** Result of a single instrument sync cycle. */
export interface InstrumentSyncResult {
  /** Unix timestamp (ms) when the sync completed. */
  syncedAt: number;
  /** Number of rows successfully ingested. */
  insertedCount: number;
  /** Number of rows that were malformed/skipped. */
  skippedCount: number;
  /** Number of total raw rows received. */
  totalRowCount: number;
  /** Human-readable status. */
  status: 'success' | 'partial' | 'failed';
  /** Error message if the sync failed, or null. */
  error: string | null;
  /** Freshness verdict in milliseconds (how stale the snapshot is). */
  stalenessMs: number;
}

/** Persisted sync-state snapshot for the instrument master. */
export interface InstrumentSyncState {
  /** Unix timestamp (ms) of last successful sync. */
  lastSuccessAt: number | null;
  /** Number of instruments in the last successful snapshot. */
  lastInstrumentCount: number | null;
  /** Number of rows skipped during the last sync. */
  lastSkippedCount: number | null;
  /** Sync status. */
  lastStatus: 'success' | 'partial' | 'failed' | null;
  /** Error message from last failure, or null. */
  lastError: string | null;
}

/** Freshness configuration for instrument master staleness checks. */
export interface InstrumentFreshnessConfig {
  /** Maximum age (ms) of a snapshot before it is considered stale. */
  maxStalenessMs: number;
}
