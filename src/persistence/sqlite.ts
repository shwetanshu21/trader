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
