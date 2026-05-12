// ── Universe Repository ──
// Typed CRUD over universe policy members and coverage snapshots.
// Idempotent upserts by exchange + tradingsymbol.
// Snapshots store member details as JSON for flexible querying.

import type Database from 'better-sqlite3';
import {
  type UniverseSnapshot,
  type NewUniverseSnapshot,
  type UniverseMemberCoverage,
  UniverseCoverageVerdict,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Row shapes from SQLite (snake_case → camelCase mapping)
// ---------------------------------------------------------------------------

interface UniverseSnapshotDbRow {
  id: number;
  policy_version: string;
  computed_at: number;
  verdict: string;
  eligible_count: number;
  ineligible_count: number;
  fresh_quote_count: number;
  stale_quote_count: number;
  missing_quote_count: number;
  threshold_label: string;
  threshold_ratio: number;
  max_staleness_ms: number;
  members_json: string;
}

interface UniverseMemberDbRow {
  exchange: string;
  tradingsymbol: string;
  instrument_type: string;
  added_at: number;
}

// ---------------------------------------------------------------------------
// UniverseRepository
// ---------------------------------------------------------------------------

export class UniverseRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  // ── Members ─────────────────────────────────────────────────────────────

  /** Upsert a universe member. */
  upsertMember(exchange: string, tradingsymbol: string, instrumentType: string = 'EQ', addedAt?: number): void {
    this._db.prepare(`
      INSERT INTO universe_members (exchange, tradingsymbol, instrument_type, added_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(exchange, tradingsymbol) DO UPDATE SET
        instrument_type = excluded.instrument_type
    `).run(exchange, tradingsymbol, instrumentType, addedAt ?? Date.now());
  }

  /** Remove a member from the universe. */
  removeMember(exchange: string, tradingsymbol: string): void {
    this._db.prepare(`
      DELETE FROM universe_members WHERE exchange = ? AND tradingsymbol = ?
    `).run(exchange, tradingsymbol);
  }

  /** Return all universe members, deterministically ordered by exchange + tradingsymbol. */
  getAllMembers(): Array<{ exchange: string; tradingsymbol: string; instrumentType: string; addedAt: number }> {
    const rows = this._db.prepare(`
      SELECT exchange, tradingsymbol, instrument_type, added_at
      FROM universe_members
      ORDER BY exchange, tradingsymbol
    `).all() as UniverseMemberDbRow[];

    return rows.map(r => ({
      exchange: r.exchange,
      tradingsymbol: r.tradingsymbol,
      instrumentType: r.instrument_type,
      addedAt: r.added_at,
    }));
  }

  /** Count universe members. */
  countMembers(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM universe_members').get() as { cnt: number };
    return row.cnt;
  }

  /** Clear all members (e.g. before reloading the allowlist). */
  clearMembers(): void {
    this._db.prepare('DELETE FROM universe_members').run();
  }

  // ── Snapshots ───────────────────────────────────────────────────────────

  /** Persist a new coverage snapshot. Returns the full row with auto-generated id. */
  insertSnapshot(snapshot: NewUniverseSnapshot): UniverseSnapshot {
    const membersJson = JSON.stringify(snapshot.members);

    const result = this._db.prepare(`
      INSERT INTO universe_snapshots (
        policy_version, computed_at, verdict, eligible_count, ineligible_count,
        fresh_quote_count, stale_quote_count, missing_quote_count,
        threshold_label, threshold_ratio, max_staleness_ms, members_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.policyVersion,
      snapshot.computedAt,
      snapshot.verdict,
      snapshot.eligibleCount,
      snapshot.ineligibleCount,
      snapshot.freshQuoteCount,
      snapshot.staleQuoteCount,
      snapshot.missingQuoteCount,
      snapshot.thresholdLabel,
      snapshot.thresholdRatio,
      snapshot.maxStalenessMs,
      membersJson,
    );

    return {
      id: Number(result.lastInsertRowid),
      ...snapshot,
    };
  }

  /** Retrieve the most recent snapshot, or null if none exist. */
  getLatestSnapshot(): UniverseSnapshot | null {
    const row = this._db.prepare(`
      SELECT id, policy_version, computed_at, verdict, eligible_count, ineligible_count,
             fresh_quote_count, stale_quote_count, missing_quote_count,
             threshold_label, threshold_ratio, max_staleness_ms, members_json
      FROM universe_snapshots
      ORDER BY id DESC
      LIMIT 1
    `).get() as UniverseSnapshotDbRow | undefined;

    return row ? this._mapSnapshotRow(row) : null;
  }

  /** Retrieve the most recent snapshots, newest first. */
  getSnapshots(limit: number = 10): UniverseSnapshot[] {
    const rows = this._db.prepare(`
      SELECT id, policy_version, computed_at, verdict, eligible_count, ineligible_count,
             fresh_quote_count, stale_quote_count, missing_quote_count,
             threshold_label, threshold_ratio, max_staleness_ms, members_json
      FROM universe_snapshots
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as UniverseSnapshotDbRow[];

    return rows.map(this._mapSnapshotRow);
  }

  /** Count total snapshots. */
  countSnapshots(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM universe_snapshots').get() as { cnt: number };
    return row.cnt;
  }

  /** Prune old snapshots, keeping the most recent N. Returns count of deleted rows. */
  pruneSnapshots(keep: number = 100): number {
    const result = this._db.prepare(`
      DELETE FROM universe_snapshots
      WHERE id NOT IN (
        SELECT id FROM universe_snapshots
        ORDER BY id DESC
        LIMIT ?
      )
    `).run(keep);

    return result.changes;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private _mapSnapshotRow(row: UniverseSnapshotDbRow): UniverseSnapshot {
    return {
      id: row.id,
      policyVersion: row.policy_version,
      computedAt: row.computed_at,
      verdict: row.verdict as UniverseCoverageVerdict,
      eligibleCount: row.eligible_count,
      ineligibleCount: row.ineligible_count,
      freshQuoteCount: row.fresh_quote_count,
      staleQuoteCount: row.stale_quote_count,
      missingQuoteCount: row.missing_quote_count,
      thresholdLabel: row.threshold_label,
      thresholdRatio: row.threshold_ratio,
      maxStalenessMs: row.max_staleness_ms,
      members: JSON.parse(row.members_json) as UniverseMemberCoverage[],
    };
  }
}
