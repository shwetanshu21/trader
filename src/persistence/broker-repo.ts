import type Database from 'better-sqlite3';
import {
  ZerodhaSessionState,
  type ZerodhaSessionRow,
  type IngestionEvent,
  type InstrumentRecord,
  type InstrumentSyncState,
  type QuoteSnapshot,
  type StreamDiagnostics,
  type StreamState,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// BrokerRepository — typed CRUD over broker persistence tables
// Legacy table names remain unchanged for compatibility during the transition.
// ---------------------------------------------------------------------------

export class BrokerRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  // ── Session (singleton upsert, id=1) ────────────────────────────────────

  /** Upsert the single Zerodha session row. */
  upsertSession(session: ZerodhaSessionRow): void {
    this._db.prepare(`
      INSERT INTO zerodha_session (id, access_token, obtained_at, expires_at, state, reason, last_error)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        access_token = excluded.access_token,
        obtained_at  = excluded.obtained_at,
        expires_at   = excluded.expires_at,
        state        = excluded.state,
        reason       = excluded.reason,
        last_error   = excluded.last_error
    `).run(
      session.accessToken,
      session.obtainedAt,
      session.expiresAt,
      session.state,
      session.reason,
      session.lastError,
    );
  }

  /** Read the current Zerodha session row, or return a default missing-credentials row. */
  getSession(): ZerodhaSessionRow {
    const row = this._db.prepare(`
      SELECT access_token, obtained_at, expires_at, state, reason, last_error
      FROM zerodha_session
      WHERE id = 1
    `).get() as {
      access_token: string;
      obtained_at: number;
      expires_at: number;
      state: string;
      reason: string;
      last_error: string | null;
    } | undefined;

    if (!row) {
      return {
        accessToken: '',
        obtainedAt: 0,
        expiresAt: 0,
        state: ZerodhaSessionState.MissingCredentials,
        reason: 'No session row persisted yet',
        lastError: null,
      };
    }

    return {
      accessToken: row.access_token,
      obtainedAt: row.obtained_at,
      expiresAt: row.expires_at,
      state: row.state as ZerodhaSessionState,
      reason: row.reason,
      lastError: row.last_error,
    };
  }

  // ── Ingestion events ────────────────────────────────────────────────────

  /** Insert a new ingestion event. */
  insertIngestionEvent(
    event: Omit<IngestionEvent, 'id'>,
  ): IngestionEvent {
    const diagnostic = event.diagnostic
      ? JSON.stringify(event.diagnostic)
      : null;

    const stmt = this._db.prepare(`
      INSERT INTO zerodha_ingestion_events (event_type, recorded_at, duration_ms, item_count, error, diagnostic)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      event.eventType,
      event.recordedAt,
      event.durationMs,
      event.itemCount,
      event.error,
      diagnostic,
    );

    return {
      id: Number(result.lastInsertRowid),
      eventType: event.eventType,
      recordedAt: event.recordedAt,
      durationMs: event.durationMs,
      itemCount: event.itemCount,
      error: event.error,
      diagnostic: event.diagnostic,
    };
  }

  /** Retrieve recent ingestion events, newest first. */
  getIngestionEvents(limit = 50): IngestionEvent[] {
    const rows = this._db.prepare(`
      SELECT id, event_type, recorded_at, duration_ms, item_count, error, diagnostic
      FROM zerodha_ingestion_events
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: number;
      event_type: string;
      recorded_at: number;
      duration_ms: number | null;
      item_count: number | null;
      error: string | null;
      diagnostic: string | null;
    }>;

    return rows.map(r => ({
      id: r.id,
      eventType: r.event_type,
      recordedAt: r.recorded_at,
      durationMs: r.duration_ms,
      itemCount: r.item_count,
      error: r.error,
      diagnostic: r.diagnostic ? JSON.parse(r.diagnostic) as Record<string, unknown> : null,
    }));
  }

  /** Delete old ingestion events, keeping the most recent N. Returns count of deleted rows. */
  pruneIngestionEvents(keep = 1000): number {
    const result = this._db.prepare(`
      DELETE FROM zerodha_ingestion_events
      WHERE id NOT IN (
        SELECT id FROM zerodha_ingestion_events
        ORDER BY id DESC
        LIMIT ?
      )
    `).run(keep);

    return result.changes;
  }

  // ── Instruments ──────────────────────────────────────────────────────────

  /** Batch upsert instrument records inside a single transaction. */
  upsertInstruments(instruments: InstrumentRecord[]): void {
    if (instruments.length === 0) return;

    const now = Date.now();
    const stmt = this._db.prepare(`
      INSERT INTO zerodha_instruments (
        exchange, tradingsymbol, instrument_token, name, expiry, strike,
        lot_size, tick_size, instrument_type, segment, exchange_token, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange, tradingsymbol) DO UPDATE SET
        instrument_token = excluded.instrument_token,
        name             = excluded.name,
        expiry           = excluded.expiry,
        strike           = excluded.strike,
        lot_size         = excluded.lot_size,
        tick_size        = excluded.tick_size,
        instrument_type  = excluded.instrument_type,
        segment          = excluded.segment,
        exchange_token   = excluded.exchange_token,
        updated_at       = excluded.updated_at
    `);

    const insertMany = this._db.transaction((rows: InstrumentRecord[]) => {
      for (const inst of rows) {
        stmt.run(
          inst.exchange,
          inst.tradingsymbol,
          inst.instrumentToken,
          inst.name,
          inst.expiry,
          inst.strike,
          inst.lotSize,
          inst.tickSize,
          inst.instrumentType,
          inst.segment,
          inst.exchangeToken,
          now,
        );
      }
    });

    insertMany(instruments);
  }

  /** Look up an instrument by exchange + tradingsymbol. */
  getInstrument(exchange: string, tradingsymbol: string): InstrumentRecord | null {
    const row = this._db.prepare(`
      SELECT exchange, tradingsymbol, instrument_token, name, expiry, strike,
             lot_size, tick_size, instrument_type, segment, exchange_token, updated_at
      FROM zerodha_instruments
      WHERE exchange = ? AND tradingsymbol = ?
    `).get(exchange, tradingsymbol) as InstrumentDbRow | undefined;

    return row ? mapInstrumentRow(row) : null;
  }

  /** Look up an instrument by its Kite instrument token. */
  getInstrumentByToken(instrumentToken: number): InstrumentRecord | null {
    const row = this._db.prepare(`
      SELECT exchange, tradingsymbol, instrument_token, name, expiry, strike,
             lot_size, tick_size, instrument_type, segment, exchange_token, updated_at
      FROM zerodha_instruments
      WHERE instrument_token = ?
    `).get(instrumentToken) as InstrumentDbRow | undefined;

    return row ? mapInstrumentRow(row) : null;
  }

  /** Return all instruments for a given exchange (e.g. 'NSE', 'NFO'). */
  getInstrumentsByExchange(exchange: string): InstrumentRecord[] {
    const rows = this._db.prepare(`
      SELECT exchange, tradingsymbol, instrument_token, name, expiry, strike,
             lot_size, tick_size, instrument_type, segment, exchange_token, updated_at
      FROM zerodha_instruments
      WHERE exchange = ?
      ORDER BY tradingsymbol
    `).all(exchange) as InstrumentDbRow[];

    return rows.map(mapInstrumentRow);
  }

  /** Return all instruments for a given segment. */
  getInstrumentsBySegment(segment: string): InstrumentRecord[] {
    const rows = this._db.prepare(`
      SELECT exchange, tradingsymbol, instrument_token, name, expiry, strike,
             lot_size, tick_size, instrument_type, segment, exchange_token, updated_at
      FROM zerodha_instruments
      WHERE segment = ?
      ORDER BY exchange, tradingsymbol
    `).all(segment) as InstrumentDbRow[];

    return rows.map(mapInstrumentRow);
  }

  /** Count instruments currently stored. */
  countInstruments(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM zerodha_instruments').get() as { cnt: number };
    return row.cnt;
  }

  // ── Instrument sync state ────────────────────────────────────────────────

  /** Upsert the singleton instrument sync state. */
  upsertInstrumentSyncState(state: InstrumentSyncState): void {
    this._db.prepare(`
      INSERT INTO zerodha_instrument_sync_state (id, last_success_at, last_instrument_count, last_skipped_count, last_status, last_error)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_success_at       = excluded.last_success_at,
        last_instrument_count = excluded.last_instrument_count,
        last_skipped_count    = excluded.last_skipped_count,
        last_status           = excluded.last_status,
        last_error            = excluded.last_error
    `).run(
      state.lastSuccessAt,
      state.lastInstrumentCount,
      state.lastSkippedCount,
      state.lastStatus,
      state.lastError,
    );
  }

  /** Read the current instrument sync state, or return a default stale state. */
  getInstrumentSyncState(): InstrumentSyncState {
    const row = this._db.prepare(`
      SELECT last_success_at, last_instrument_count, last_skipped_count, last_status, last_error
      FROM zerodha_instrument_sync_state
      WHERE id = 1
    `).get() as {
      last_success_at: number | null;
      last_instrument_count: number | null;
      last_skipped_count: number | null;
      last_status: string | null;
      last_error: string | null;
    } | undefined;

    if (!row) {
      return {
        lastSuccessAt: null,
        lastInstrumentCount: null,
        lastSkippedCount: null,
        lastStatus: null,
        lastError: null,
      };
    }

    return {
      lastSuccessAt: row.last_success_at,
      lastInstrumentCount: row.last_instrument_count,
      lastSkippedCount: row.last_skipped_count,
      lastStatus: row.last_status as InstrumentSyncState['lastStatus'],
      lastError: row.last_error,
    };
  }

  /** Determine staleness in ms. Returns null if never synced. */
  getInstrumentStalenessMs(now: number): number | null {
    const state = this.getInstrumentSyncState();
    if (state.lastSuccessAt === null) return null;
    return now - state.lastSuccessAt;
  }

  // ── Latest quotes (upsert, keyed by exchange + tradingsymbol) ──────────

  /** Upsert a latest-quote snapshot. */
  upsertQuote(quote: QuoteSnapshot): void {
    this._db.prepare(`
      INSERT INTO zerodha_latest_quotes (
        exchange, tradingsymbol, instrument_token, last_price, change, change_percent,
        volume, oi, high, low, open, close, bid, ask, price_timestamp, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange, tradingsymbol) DO UPDATE SET
        instrument_token = excluded.instrument_token,
        last_price       = excluded.last_price,
        change           = excluded.change,
        change_percent   = excluded.change_percent,
        volume           = excluded.volume,
        oi               = excluded.oi,
        high             = excluded.high,
        low              = excluded.low,
        open             = excluded.open,
        close            = excluded.close,
        bid              = excluded.bid,
        ask              = excluded.ask,
        price_timestamp  = excluded.price_timestamp,
        received_at      = excluded.received_at
    `).run(
      quote.exchange,
      quote.tradingsymbol,
      quote.instrumentToken,
      quote.lastPrice,
      quote.change,
      quote.changePercent,
      quote.volume,
      quote.oi,
      quote.high,
      quote.low,
      quote.open,
      quote.close,
      quote.bid,
      quote.ask,
      quote.priceTimestamp,
      quote.receivedAt,
    );
  }

  /** Retrieve the latest quote for an instrument by exchange + tradingsymbol. */
  getQuote(exchange: string, tradingsymbol: string): QuoteSnapshot | null {
    const row = this._db.prepare(`
      SELECT exchange, tradingsymbol, instrument_token, last_price, change, change_percent,
             volume, oi, high, low, open, close, bid, ask, price_timestamp, received_at
      FROM zerodha_latest_quotes
      WHERE exchange = ? AND tradingsymbol = ?
    `).get(exchange, tradingsymbol) as QuoteDbRow | undefined;

    return row ? mapQuoteRow(row) : null;
  }

  /** Retrieve the latest quote by instrument token. */
  getQuoteByToken(instrumentToken: number): QuoteSnapshot | null {
    const row = this._db.prepare(`
      SELECT exchange, tradingsymbol, instrument_token, last_price, change, change_percent,
             volume, oi, high, low, open, close, bid, ask, price_timestamp, received_at
      FROM zerodha_latest_quotes
      WHERE instrument_token = ?
    `).get(instrumentToken) as QuoteDbRow | undefined;

    return row ? mapQuoteRow(row) : null;
  }

  /** Return all latest quotes. */
  getAllQuotes(): QuoteSnapshot[] {
    const rows = this._db.prepare(`
      SELECT exchange, tradingsymbol, instrument_token, last_price, change, change_percent,
             volume, oi, high, low, open, close, bid, ask, price_timestamp, received_at
      FROM zerodha_latest_quotes
      ORDER BY exchange, tradingsymbol
    `).all() as QuoteDbRow[];

    return rows.map(mapQuoteRow);
  }

  /** Count how many latest-quote snapshots are stored. */
  countQuotes(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM zerodha_latest_quotes').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Determine the staleness of the newest quote across ALL subscribed instruments.
   * Returns the minimum received_at across all quotes, or null if no quotes exist.
   */
  getQuoteStalenessMs(now: number): { isStale: boolean; stalenessMs: number | null; lastQuoteAt: number | null } {
    const row = this._db.prepare(`
      SELECT MAX(received_at) AS newest_ts FROM zerodha_latest_quotes
    `).get() as { newest_ts: number | null };

    if (row.newest_ts === null) {
      return { isStale: true, stalenessMs: null, lastQuoteAt: null };
    }

    const stalenessMs = now - row.newest_ts;
    return { isStale: stalenessMs > 60_000, stalenessMs, lastQuoteAt: row.newest_ts };
  }

  // ── Stream diagnostics (singleton, id=1) ──────────────────────────────

  /** Upsert the singleton stream diagnostics row. */
  upsertStreamDiagnostics(diag: StreamDiagnostics): void {
    this._db.prepare(`
      INSERT INTO zerodha_stream_state (
        id, state, connected_at, last_heartbeat_at, last_quote_received_at,
        reconnect_count, parse_failures, subscribed_count, last_error, created_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state                = excluded.state,
        connected_at         = excluded.connected_at,
        last_heartbeat_at    = excluded.last_heartbeat_at,
        last_quote_received_at = excluded.last_quote_received_at,
        reconnect_count      = excluded.reconnect_count,
        parse_failures       = excluded.parse_failures,
        subscribed_count     = excluded.subscribed_count,
        last_error           = excluded.last_error,
        created_at           = excluded.created_at
    `).run(
      diag.state,
      diag.connectedAt,
      diag.lastHeartbeatAt,
      diag.lastQuoteReceivedAt,
      diag.reconnectCount,
      diag.parseFailures,
      diag.subscribedCount,
      diag.lastError,
      diag.createdAt,
    );
  }

  /** Read the current stream diagnostics, or return a default disconnected state. */
  getStreamDiagnostics(): StreamDiagnostics {
    const row = this._db.prepare(`
      SELECT state, connected_at, last_heartbeat_at, last_quote_received_at,
             reconnect_count, parse_failures, subscribed_count, last_error, created_at
      FROM zerodha_stream_state
      WHERE id = 1
    `).get() as {
      state: string;
      connected_at: number | null;
      last_heartbeat_at: number | null;
      last_quote_received_at: number | null;
      reconnect_count: number;
      parse_failures: number;
      subscribed_count: number;
      last_error: string | null;
      created_at: number;
    } | undefined;

    if (!row) {
      return {
        state: 'disconnected' as StreamState,
        connectedAt: null,
        lastHeartbeatAt: null,
        lastQuoteReceivedAt: null,
        reconnectCount: 0,
        parseFailures: 0,
        subscribedCount: 0,
        lastError: null,
        createdAt: Date.now(),
      };
    }

    return {
      state: row.state as StreamState,
      connectedAt: row.connected_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      lastQuoteReceivedAt: row.last_quote_received_at,
      reconnectCount: row.reconnect_count,
      parseFailures: row.parse_failures,
      subscribedCount: row.subscribed_count,
      lastError: row.last_error,
      createdAt: row.created_at,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface InstrumentDbRow {
  exchange: string;
  tradingsymbol: string;
  instrument_token: number;
  name: string;
  expiry: string | null;
  strike: number | null;
  lot_size: number;
  tick_size: number;
  instrument_type: string;
  segment: string;
  exchange_token: number;
  updated_at: number;
}

interface QuoteDbRow {
  exchange: string;
  tradingsymbol: string;
  instrument_token: number;
  last_price: number;
  change: number | null;
  change_percent: number | null;
  volume: number | null;
  oi: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
  close: number | null;
  bid: number | null;
  ask: number | null;
  price_timestamp: number | null;
  received_at: number;
}

function mapInstrumentRow(row: InstrumentDbRow): InstrumentRecord {
  return {
    exchange: row.exchange,
    tradingsymbol: row.tradingsymbol,
    instrumentToken: row.instrument_token,
    name: row.name,
    expiry: row.expiry,
    strike: row.strike,
    lotSize: row.lot_size,
    tickSize: row.tick_size,
    instrumentType: row.instrument_type as InstrumentRecord['instrumentType'],
    segment: row.segment as InstrumentRecord['segment'],
    exchangeToken: row.exchange_token,
    freezeQuantity: null,
  };
}

function mapQuoteRow(row: QuoteDbRow): QuoteSnapshot {
  return {
    exchange: row.exchange,
    tradingsymbol: row.tradingsymbol,
    instrumentToken: row.instrument_token,
    lastPrice: row.last_price,
    change: row.change,
    changePercent: row.change_percent,
    volume: row.volume,
    oi: row.oi,
    high: row.high,
    low: row.low,
    open: row.open,
    close: row.close,
    bid: row.bid,
    ask: row.ask,
    priceTimestamp: row.price_timestamp,
    receivedAt: row.received_at,
  };
}

// Backward-compatible export during the broker/upstox rename.
export { BrokerRepository as ZerodhaRepository };
