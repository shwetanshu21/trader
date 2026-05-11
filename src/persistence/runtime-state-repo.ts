import type Database from 'better-sqlite3';
import type {
  LifecycleEvent,
  LifecycleState,
  SchedulerState,
  HealthStatus,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// RuntimeStateRepository — typed CRUD over the persisted runtime tables
// ---------------------------------------------------------------------------

export class RuntimeStateRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  // ── Lifecycle events ────────────────────────────────────────────────────

  /** Insert a lifecycle event and return it with defaults filled. */
  insertLifecycleEvent(
    event: Omit<LifecycleEvent, 'timestamp'> & { timestamp?: number },
  ): LifecycleEvent {
    const timestamp = event.timestamp ?? Date.now();
    const diagnostic = event.diagnostic
      ? JSON.stringify(event.diagnostic)
      : null;

    const stmt = this._db.prepare(`
      INSERT INTO lifecycle_events (timestamp, state, reason, diagnostic)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(timestamp, event.state, event.reason, diagnostic);

    return { timestamp, state: event.state, reason: event.reason, diagnostic: event.diagnostic };
  }

  /** Retrieve the most recent lifecycle event, or null if none exist. */
  getLatestLifecycleState(): LifecycleState | null {
    const row = this._db.prepare(`
      SELECT state FROM lifecycle_events ORDER BY id DESC LIMIT 1
    `).get() as { state: LifecycleState } | undefined;

    return row?.state ?? null;
  }

  /** Retrieve the most recent lifecycle event record, or null. */
  getLatestLifecycleEvent(): LifecycleEvent | null {
    const row = this._db.prepare(`
      SELECT timestamp, state, reason, diagnostic
      FROM lifecycle_events
      ORDER BY id DESC LIMIT 1
    `).get() as { timestamp: number; state: string; reason: string; diagnostic: string | null } | undefined;

    if (!row) return null;

    return {
      timestamp: row.timestamp,
      state: row.state as LifecycleState,
      reason: row.reason,
      diagnostic: row.diagnostic ? JSON.parse(row.diagnostic) as Record<string, unknown> : undefined,
    };
  }

  /** Retrieve recent lifecycle events, newest first. */
  getLifecycleEvents(limit = 50): LifecycleEvent[] {
    const rows = this._db.prepare(`
      SELECT timestamp, state, reason, diagnostic
      FROM lifecycle_events
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as Array<{ timestamp: number; state: string; reason: string; diagnostic: string | null }>;

    return rows.map(r => ({
      timestamp: r.timestamp,
      state: r.state as LifecycleState,
      reason: r.reason,
      diagnostic: r.diagnostic ? JSON.parse(r.diagnostic) as Record<string, unknown> : undefined,
    }));
  }

  // ── Scheduler state (singleton upsert) ──────────────────────────────────

  /** Upsert the single scheduler state row. */
  upsertSchedulerState(state: SchedulerState): void {
    this._db.prepare(`
      INSERT INTO scheduler_state (id, status, market_phase, last_tick_ts, started_at, tick_count, last_error)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status        = excluded.status,
        market_phase  = excluded.market_phase,
        last_tick_ts  = excluded.last_tick_ts,
        started_at    = excluded.started_at,
        tick_count    = excluded.tick_count,
        last_error    = excluded.last_error
    `).run(
      state.status,
      state.marketPhase,
      state.lastTickTimestamp,
      state.startedAt,
      state.tickCount,
      state.lastError,
    );
  }

  /** Read the current scheduler state, or return a default idle state. */
  getSchedulerState(): SchedulerState {
    const row = this._db.prepare(`
      SELECT status, market_phase, last_tick_ts, started_at, tick_count, last_error
      FROM scheduler_state
      WHERE id = 1
    `).get() as {
      status: string;
      market_phase: string;
      last_tick_ts: number | null;
      started_at: number | null;
      tick_count: number;
      last_error: string | null;
    } | undefined;

    if (!row) {
      return {
        status: 'idle' as SchedulerState['status'],
        marketPhase: 'closed' as SchedulerState['marketPhase'],
        lastTickTimestamp: null,
        startedAt: null,
        tickCount: 0,
        lastError: null,
      };
    }

    // Map snake_case DB columns to camelCase interface
    return {
      status: row.status,
      marketPhase: row.market_phase,
      lastTickTimestamp: row.last_tick_ts,
      startedAt: row.started_at,
      tickCount: row.tick_count,
      lastError: row.last_error,
    } as SchedulerState;
  }

  // ── Health checks ───────────────────────────────────────────────────────

  /** Persist a health check snapshot. */
  insertHealthCheck(status: HealthStatus): void {
    this._db.prepare(`
      INSERT INTO health_checks (verdict, uptime_ms, lifecycle_state, degraded_reasons, checked_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      status.verdict,
      status.uptimeMs,
      status.lifecycleState,
      status.degradedReasons.length > 0 ? JSON.stringify(status.degradedReasons) : null,
      status.checkedAt,
    );
  }

  /** Get the most recent health check, or null. */
  getLatestHealthCheck(): HealthStatus | null {
    const row = this._db.prepare(`
      SELECT verdict, uptime_ms, lifecycle_state, degraded_reasons, checked_at
      FROM health_checks
      ORDER BY id DESC LIMIT 1
    `).get() as {
      verdict: string;
      uptime_ms: number;
      lifecycle_state: string;
      degraded_reasons: string | null;
      checked_at: string;
    } | undefined;

    if (!row) return null;

    return {
      verdict: row.verdict,
      uptimeMs: row.uptime_ms,
      lifecycleState: row.lifecycle_state,
      scheduler: this.getSchedulerState(),
      degradedReasons: row.degraded_reasons
        ? JSON.parse(row.degraded_reasons) as string[]
        : [],
      checkedAt: row.checked_at,
    } as HealthStatus;
  }
}
