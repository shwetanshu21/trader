// ── Broker integration DTOs ──
// Normalised session/health types distinct from raw broker responses.
// No implementation, no secrets — pure data shapes.

import type { BrokerSessionState, BrokerSessionRow, BrokerSessionHealth } from '../../types/runtime.js';

// Re-export for convenience from the integration boundary
export type { BrokerSessionState, BrokerSessionRow, BrokerSessionHealth };
export { BrokerSessionState as ZerodhaSessionState } from '../../types/runtime.js';
export type { BrokerSessionRow as ZerodhaSessionRow, BrokerSessionHealth as ZerodhaSessionHealth } from '../../types/runtime.js';

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
// Composite health block emitted by broker services
// ---------------------------------------------------------------------------

/** Backward-compatible broker health block alias — embedded in the top-level HealthStatus. */
export interface ZerodhaHealthBlock {
  session: BrokerSessionHealth;
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

// ---------------------------------------------------------------------------
// Quote / Market Data Stream types
// ---------------------------------------------------------------------------

/** Stream connection states for the Kite WebSocket feed. */
export enum StreamState {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Degraded = 'degraded',
  Closed = 'closed',
}

/** Latest quote snapshot for a single instrument — persisted in SQLite. */
export interface QuoteSnapshot {
  exchange: string;
  tradingsymbol: string;
  instrumentToken: number;
  /** Last traded price (INR). */
  lastPrice: number;
  /** Price change from previous close, or null. */
  change: number | null;
  /** Price change percent from previous close, or null. */
  changePercent: number | null;
  /** Traded volume, or null. */
  volume: number | null;
  /** Open interest, or null. */
  oi: number | null;
  /** Day's high price, or null. */
  high: number | null;
  /** Day's low price, or null. */
  low: number | null;
  /** Open price, or null. */
  open: number | null;
  /** Previous close price, or null. */
  close: number | null;
  /** Best bid price, or null. */
  bid: number | null;
  /** Best ask price, or null. */
  ask: number | null;
  /** Unix timestamp (s) of the tick from the exchange, or null. */
  priceTimestamp: number | null;
  /** Unix timestamp (ms) when this snapshot was received and persisted. */
  receivedAt: number;
}

/** Stream diagnostics snapshot — persisted for agent observability. */
export interface StreamDiagnostics {
  state: StreamState;
  /** Unix timestamp (ms) when the stream last connected. */
  connectedAt: number | null;
  /** Unix timestamp (ms) of the last heartbeat tick. */
  lastHeartbeatAt: number | null;
  /** Unix timestamp (ms) of the last received quote. */
  lastQuoteReceivedAt: number | null;
  /** Number of reconnection attempts since start. */
  reconnectCount: number;
  /** Number of malformed packets received. */
  parseFailures: number;
  /** Number of tokens currently subscribed. */
  subscribedCount: number;
  /** Last error message, or null. */
  lastError: string | null;
  /** Timestamp (ms) when this diagnostics record was created. */
  createdAt: number;
}

/** Result of a quote freshness check. */
export interface QuoteFreshness {
  isStale: boolean;
  /** Staleness in ms, or null if no quote has ever been received. */
  stalenessMs: number | null;
  /** Timestamp (ms) of the last quote received, or null. */
  lastQuoteAt: number | null;
}

/** Configuration for quote stream stale-feed detection. */
export interface QuoteFreshnessConfig {
  /** Maximum age (ms) of a quote snapshot before it is considered stale. */
  maxStalenessMs: number;
}

/** Parsed tick from the Kite binary WebSocket protocol. */
export interface KiteTick {
  /** Packet type code. */
  packetType: number;
  /** Kite instrument token. */
  instrumentToken: number;
  /** Last traded price (INR, scaled to decimal). */
  lastPrice: number;
  /** Price change (INR, scaled to decimal), or null. */
  change: number | null;
  /** Price change percent, or null. */
  changePercent: number | null;
  /** Traded volume, or null. */
  volume: number | null;
  /** Open interest, or null. */
  oi: number | null;
  /** Day's high price (INR), or null. */
  high: number | null;
  /** Day's low price (INR), or null. */
  low: number | null;
  /** Open price (INR), or null. */
  open: number | null;
  /** Previous close price (INR), or null. */
  close: number | null;
  /** Best bid price (INR), or null. */
  bid: number | null;
  /** Best ask price (INR), or null. */
  ask: number | null;
  /** Tick timestamp (epoch seconds), or null. */
  timestamp: number | null;
}

/**
 * WebSocket factory type — injected so tests can provide mock WebSockets
 * without needing network access.
 */
export type WebSocketFactory = (url: string) => WebSocket;

/** Default factory using the global Node 22+ WebSocket. */
export const defaultWebSocketFactory: WebSocketFactory = (url: string): WebSocket => new WebSocket(url);

/** Subscribed instrument entry for the stream supervisor. */
export interface SubscribedInstrument {
  instrumentToken: number;
  exchange: string;
  tradingsymbol: string;
  subscribedAt: number;
}
