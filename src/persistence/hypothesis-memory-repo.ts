import type Database from 'better-sqlite3';

import {
  type HypothesisMemoryLookupResult,
  type HypothesisMemoryRecordRow,
  type HypothesisMemoryStatus,
  type HypothesisValidationReasonCode,
  type NewHypothesisMemoryRecord,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// HypothesisMemoryRepository — exact-failure memory ledger for dedupe
// ---------------------------------------------------------------------------

export class HypothesisMemoryRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  /**
   * Record a failed or rejected hypothesis by canonical hash.
   * Idempotent: if the hash already exists, returns the existing row unchanged.
   */
  recordFailure(input: NewHypothesisMemoryRecord): HypothesisMemoryRecordRow {
    this._db.prepare(`
      INSERT OR IGNORE INTO hypothesis_memory_ledger
        (canonical_hash, status, reason_code, reason_message, hypothesis_graph_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.canonicalHash,
      input.status,
      input.reasonCode,
      input.reasonMessage,
      input.hypothesisGraphId,
      input.createdAt,
    );

    const row = this.getFailureByHash(input.canonicalHash);
    if (!row) {
      throw new Error(`Failed to read hypothesis memory ledger entry for hash ${input.canonicalHash}`);
    }

    return row;
  }

  /** Retrieve a ledger row by canonical hash. */
  getFailureByHash(canonicalHash: string): HypothesisMemoryRecordRow | null {
    const row = this._db.prepare(`
      SELECT * FROM hypothesis_memory_ledger WHERE canonical_hash = ?
    `).get(canonicalHash) as HypothesisMemoryDbRow | undefined;

    return row ? mapMemoryRow(row) : null;
  }

  /**
   * Exact-lookup helper for validators.
   * Returns both a boolean and the stored row for auditable skip reasons.
   */
  hasExactFailure(canonicalHash: string): HypothesisMemoryLookupResult {
    const entry = this.getFailureByHash(canonicalHash);
    return {
      found: entry !== null,
      entry,
    };
  }

  /** Count total ledger rows. */
  count(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM hypothesis_memory_ledger').get() as { cnt: number };
    return row.cnt;
  }
}

interface HypothesisMemoryDbRow {
  id: number;
  canonical_hash: string;
  status: string;
  reason_code: string;
  reason_message: string;
  hypothesis_graph_id: number | null;
  created_at: number;
}

function mapMemoryRow(row: HypothesisMemoryDbRow): HypothesisMemoryRecordRow {
  return {
    id: row.id,
    canonicalHash: row.canonical_hash,
    status: row.status as HypothesisMemoryStatus,
    reasonCode: row.reason_code as HypothesisValidationReasonCode,
    reasonMessage: row.reason_message,
    hypothesisGraphId: row.hypothesis_graph_id,
    createdAt: row.created_at,
  };
}
