import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Database manager — schema migration + lifecycle
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lifecycle_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  state     TEXT    NOT NULL,
  reason    TEXT    NOT NULL,
  diagnostic TEXT
);

CREATE TABLE IF NOT EXISTS scheduler_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  status            TEXT    NOT NULL,
  market_phase      TEXT    NOT NULL,
  last_tick_ts      INTEGER,
  started_at        INTEGER,
  tick_count        INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT
);

CREATE TABLE IF NOT EXISTS health_checks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  verdict         TEXT    NOT NULL,
  uptime_ms       INTEGER NOT NULL,
  lifecycle_state TEXT    NOT NULL,
  degraded_reasons TEXT,
  checked_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS zerodha_session (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT    NOT NULL,
  obtained_at  INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  state        TEXT    NOT NULL DEFAULT 'missing_credentials',
  reason       TEXT    NOT NULL DEFAULT '',
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS zerodha_ingestion_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT    NOT NULL,
  recorded_at INTEGER NOT NULL,
  duration_ms INTEGER,
  item_count  INTEGER,
  error       TEXT,
  diagnostic  TEXT
);

CREATE TABLE IF NOT EXISTS zerodha_instruments (
  exchange          TEXT    NOT NULL,
  tradingsymbol     TEXT    NOT NULL,
  instrument_token  INTEGER NOT NULL,
  name              TEXT    NOT NULL DEFAULT '',
  expiry            TEXT,
  strike            REAL,
  lot_size          INTEGER NOT NULL DEFAULT 1,
  tick_size         REAL    NOT NULL DEFAULT 0.05,
  instrument_type   TEXT    NOT NULL,
  segment           TEXT    NOT NULL,
  exchange_token    INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (exchange, tradingsymbol)
);

CREATE INDEX IF NOT EXISTS idx_instruments_token ON zerodha_instruments(instrument_token);
CREATE INDEX IF NOT EXISTS idx_instruments_exchange ON zerodha_instruments(exchange);
CREATE INDEX IF NOT EXISTS idx_instruments_segment ON zerodha_instruments(segment);

CREATE TABLE IF NOT EXISTS zerodha_instrument_sync_state (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  last_success_at       INTEGER,
  last_instrument_count INTEGER,
  last_skipped_count    INTEGER,
  last_status           TEXT,
  last_error            TEXT
);

CREATE TABLE IF NOT EXISTS zerodha_latest_quotes (
  exchange          TEXT    NOT NULL,
  tradingsymbol     TEXT    NOT NULL,
  instrument_token  INTEGER NOT NULL,
  last_price        REAL    NOT NULL DEFAULT 0,
  change            REAL,
  change_percent    REAL,
  volume            INTEGER,
  oi                INTEGER,
  high              REAL,
  low               REAL,
  open              REAL,
  close             REAL,
  bid               REAL,
  ask               REAL,
  price_timestamp   INTEGER,
  received_at       INTEGER NOT NULL,
  PRIMARY KEY (exchange, tradingsymbol)
);

CREATE INDEX IF NOT EXISTS idx_latest_quotes_token ON zerodha_latest_quotes(instrument_token);
CREATE INDEX IF NOT EXISTS idx_latest_quotes_received ON zerodha_latest_quotes(received_at);

CREATE TABLE IF NOT EXISTS zerodha_stream_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  state               TEXT    NOT NULL DEFAULT 'disconnected',
  connected_at        INTEGER,
  last_heartbeat_at   INTEGER,
  last_quote_received_at INTEGER,
  reconnect_count     INTEGER NOT NULL DEFAULT 0,
  parse_failures      INTEGER NOT NULL DEFAULT 0,
  subscribed_count    INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          INTEGER NOT NULL
);
`;

export class DatabaseManager {
  private _db: Database.Database;

  constructor(dbPath: string) {
    this._db = new Database(dbPath);

    // Enable WAL for concurrent-read performance
    this._db.pragma('journal_mode = WAL');

    // Run migrations
    this._db.exec(SCHEMA_SQL);
  }

  /** Expose the underlying better-sqlite3 Database handle. */
  get db(): Database.Database {
    return this._db;
  }

  /** Close the database connection gracefully. */
  close(): void {
    this._db.close();
  }
}
