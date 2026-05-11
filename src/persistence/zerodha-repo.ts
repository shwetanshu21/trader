import type Database from 'better-sqlite3';
import {
  ZerodhaSessionState,
  type ZerodhaSessionRow,
  type IngestionEvent,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// ZerodhaRepository — typed CRUD over Zerodha persistence tables
// ---------------------------------------------------------------------------

export class ZerodhaRepository {
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
}
