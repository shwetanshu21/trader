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

CREATE TABLE IF NOT EXISTS proposal_attempts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange          TEXT    NOT NULL,
  tradingsymbol     TEXT    NOT NULL,
  instrument_token  INTEGER,
  side              TEXT    NOT NULL,
  product           TEXT    NOT NULL,
  quantity          INTEGER NOT NULL,
  price             REAL,
  trigger_price     REAL,
  order_type        TEXT    NOT NULL DEFAULT 'MARKET',
  tag               TEXT,
  proposal_status   TEXT    NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposal_attempts_lookup ON proposal_attempts(exchange, tradingsymbol);
CREATE INDEX IF NOT EXISTS idx_proposal_attempts_status ON proposal_attempts(proposal_status);
CREATE INDEX IF NOT EXISTS idx_proposal_attempts_created ON proposal_attempts(created_at);

CREATE TABLE IF NOT EXISTS proposal_validation_reasons (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_attempt_id INTEGER NOT NULL REFERENCES proposal_attempts(id),
  reason_code         TEXT    NOT NULL,
  reason_message      TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_validation_reasons_attempt ON proposal_validation_reasons(proposal_attempt_id);
CREATE INDEX IF NOT EXISTS idx_validation_reasons_code ON proposal_validation_reasons(reason_code);

CREATE TABLE IF NOT EXISTS blocked_order_attempts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_attempt_id INTEGER NOT NULL UNIQUE REFERENCES proposal_attempts(id),
  blocked_at          INTEGER NOT NULL,
  block_code          TEXT    NOT NULL,
  block_message       TEXT    NOT NULL DEFAULT '',
  gate_tag            TEXT    NOT NULL DEFAULT '',
  exchange            TEXT    NOT NULL,
  tradingsymbol       TEXT    NOT NULL,
  instrument_token    INTEGER,
  side                TEXT    NOT NULL,
  product             TEXT    NOT NULL,
  quantity            INTEGER NOT NULL,
  price               REAL,
  trigger_price       REAL,
  order_type          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blocked_order_blocked_at ON blocked_order_attempts(blocked_at);
CREATE INDEX IF NOT EXISTS idx_blocked_order_proposal ON blocked_order_attempts(proposal_attempt_id);

CREATE TABLE IF NOT EXISTS universe_members (
  exchange       TEXT    NOT NULL,
  tradingsymbol  TEXT    NOT NULL,
  instrument_type TEXT   NOT NULL DEFAULT 'EQ',
  added_at       INTEGER NOT NULL,
  PRIMARY KEY (exchange, tradingsymbol)
);

CREATE INDEX IF NOT EXISTS idx_universe_members_exchange ON universe_members(exchange);

CREATE TABLE IF NOT EXISTS universe_snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_version      TEXT    NOT NULL,
  computed_at         INTEGER NOT NULL,
  verdict             TEXT    NOT NULL,
  eligible_count      INTEGER NOT NULL,
  ineligible_count    INTEGER NOT NULL,
  fresh_quote_count   INTEGER NOT NULL,
  stale_quote_count   INTEGER NOT NULL,
  missing_quote_count INTEGER NOT NULL,
  threshold_label     TEXT    NOT NULL,
  threshold_ratio     REAL    NOT NULL,
  max_staleness_ms    INTEGER NOT NULL,
  members_json        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_universe_snapshots_computed ON universe_snapshots(computed_at);
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
