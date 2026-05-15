import type Database from 'better-sqlite3';
import {
  ProposalStatus,
  ValidationReasonCode,
  LLMStatus,
  MergePolicy,
  type NewProposalAttempt,
  type ProposalAttemptRow,
  type ProposalAttemptWithReasons,
  type ValidationReason,
  type NewHybridScoreSummary,
  type NewHybridScoreComponent,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// ProposalRepository — typed CRUD over proposal-attempt + validation tables
// Stable identity: exchange + tradingsymbol. instrumentToken is a trace snapshot.
// ---------------------------------------------------------------------------

export class ProposalRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  /**
   * Insert a new proposal attempt and return the full row with the assigned id.
   * Uses a transaction so callers can atomically insert validation reasons after.
   */
  insertAttempt(attempt: NewProposalAttempt): ProposalAttemptRow {
    const stmt = this._db.prepare(`
      INSERT INTO proposal_attempts
        (exchange, tradingsymbol, instrument_token, side, product, quantity,
         price, trigger_price, order_type, tag, proposal_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      attempt.exchange,
      attempt.tradingsymbol,
      attempt.instrumentToken,
      attempt.side,
      attempt.product,
      attempt.quantity,
      attempt.price,
      attempt.triggerPrice,
      attempt.orderType,
      attempt.tag,
      attempt.proposalStatus,
      attempt.createdAt,
    );

    return {
      id: Number(result.lastInsertRowid),
      exchange: attempt.exchange,
      tradingsymbol: attempt.tradingsymbol,
      instrumentToken: attempt.instrumentToken,
      side: attempt.side,
      product: attempt.product,
      quantity: attempt.quantity,
      price: attempt.price,
      triggerPrice: attempt.triggerPrice,
      orderType: attempt.orderType,
      tag: attempt.tag,
      proposalStatus: attempt.proposalStatus,
      createdAt: attempt.createdAt,
    };
  }

  /**
   * Insert a validation reason linked to a proposal attempt.
   */
  insertReason(proposalAttemptId: number, reason: ValidationReason): void {
    this._db.prepare(`
      INSERT INTO proposal_validation_reasons (proposal_attempt_id, reason_code, reason_message)
      VALUES (?, ?, ?)
    `).run(proposalAttemptId, reason.reasonCode, reason.reasonMessage);
  }

  /**
   * Insert a proposal attempt together with its validation reasons in a single transaction.
   * Returns the full attempt row including the assigned id.
   */
  insertAttemptWithReasons(
    attempt: NewProposalAttempt,
    reasons: ValidationReason[],
  ): ProposalAttemptWithReasons {
    const tx = this._db.transaction(() => {
      const row = this.insertAttempt(attempt);
      for (const reason of reasons) {
        this.insertReason(row.id, reason);
      }
      return row;
    });

    const row = tx();

    return {
      ...row,
      reasons: [...reasons],
    };
  }

  /**
   * Insert a proposal attempt together with its validation reasons AND hybrid
   * score evidence in a single atomic transaction.
   *
   * Ensures no orphaned proposal_attempts or hybrid score rows can exist
   * if a write failure occurs mid-way through the batch.
   *
   * Returns the full attempt row including its validation reasons.
   */
  insertAttemptWithReasonsAndHybridScore(
    attempt: NewProposalAttempt,
    reasons: ValidationReason[],
    hybridSummary: NewHybridScoreSummary,
    hybridComponents: NewHybridScoreComponent[],
  ): ProposalAttemptWithReasons {
    const row = this._db.transaction(() => {
      // 1. Insert proposal attempt
      const pa = this.insertAttempt(attempt);

      // 2. Insert validation reasons
      for (const reason of reasons) {
        this.insertReason(pa.id, reason);
      }

      // 3. Insert hybrid score summary (FK → proposal_attempts.id)
      const summaryResult = this._db.prepare(`
        INSERT INTO hybrid_score_summary
          (proposal_attempt_id, deterministic_score, llm_score, llm_status,
           llm_rationale, merged_score, merge_policy, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pa.id,
        hybridSummary.deterministicScore,
        hybridSummary.llmScore,
        hybridSummary.llmStatus,
        hybridSummary.llmRationale,
        hybridSummary.mergedScore,
        hybridSummary.mergePolicy,
        hybridSummary.createdAt,
      );
      const summaryId = Number(summaryResult.lastInsertRowid);

      // 4. Insert hybrid score component rows (FK → hybrid_score_summary.id)
      const componentStmt = this._db.prepare(`
        INSERT INTO hybrid_score_components
          (summary_id, component_name, score, weight, sort_order)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const comp of hybridComponents) {
        componentStmt.run(
          summaryId,
          comp.componentName,
          comp.score,
          comp.weight,
          comp.sortOrder,
        );
      }

      return pa;
    })();

    return {
      ...row,
      reasons: [...reasons],
    };
  }

  /**
   * Retrieve a proposal attempt by id, with its validation reasons.
   */
  getAttemptById(id: number): ProposalAttemptWithReasons | null {
    const row = this._db.prepare(`
      SELECT id, exchange, tradingsymbol, instrument_token, side, product, quantity,
             price, trigger_price, order_type, tag, proposal_status, created_at
      FROM proposal_attempts
      WHERE id = ?
    `).get(id) as ProposalDbRow | undefined;

    if (!row) return null;

    const reasons = this._db.prepare(`
      SELECT reason_code, reason_message
      FROM proposal_validation_reasons
      WHERE proposal_attempt_id = ?
      ORDER BY id
    `).all(id) as Array<{ reason_code: string; reason_message: string }>;

    return {
      ...mapAttemptRow(row),
      reasons: reasons.map(r => ({
        reasonCode: r.reason_code as ValidationReasonCode,
        reasonMessage: r.reason_message,
      })),
    };
  }

  /**
   * Retrieve recent proposal attempts, newest first.
   * Optionally filter by status.
   */
  getRecentAttempts(
    limit = 50,
    status?: ProposalStatus,
  ): ProposalAttemptRow[] {
    let sql: string;
    let params: unknown[];

    if (status !== undefined) {
      sql = `
        SELECT id, exchange, tradingsymbol, instrument_token, side, product, quantity,
               price, trigger_price, order_type, tag, proposal_status, created_at
        FROM proposal_attempts
        WHERE proposal_status = ?
        ORDER BY id DESC
        LIMIT ?
      `;
      params = [status, limit];
    } else {
      sql = `
        SELECT id, exchange, tradingsymbol, instrument_token, side, product, quantity,
               price, trigger_price, order_type, tag, proposal_status, created_at
        FROM proposal_attempts
        ORDER BY id DESC
        LIMIT ?
      `;
      params = [limit];
    }

    const rows = this._db.prepare(sql).all(...params) as ProposalDbRow[];
    return rows.map(mapAttemptRow);
  }

  /**
   * Retrieve recent attempts with their validation reasons, newest first.
   */
  getRecentAttemptsWithReasons(
    limit = 50,
    status?: ProposalStatus,
  ): ProposalAttemptWithReasons[] {
    const rows = this.getRecentAttempts(limit, status);
    return rows.map(row => {
      const reasons = this._db.prepare(`
        SELECT reason_code, reason_message
        FROM proposal_validation_reasons
        WHERE proposal_attempt_id = ?
        ORDER BY id
      `).all(row.id) as Array<{ reason_code: string; reason_message: string }>;

      return {
        ...row,
        reasons: reasons.map(r => ({
          reasonCode: r.reason_code as ValidationReasonCode,
          reasonMessage: r.reason_message,
        })),
      };
    });
  }

  /**
   * Check if a proposal attempt already exists for the given exchange + tradingsymbol
   * within a time window (default: last 60 seconds). Used for overlap-skip detection.
   */
  hasRecentAttempt(
    exchange: string,
    tradingsymbol: string,
    windowMs = 60_000,
  ): boolean {
    const cutoff = Date.now() - windowMs;
    const row = this._db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM proposal_attempts
      WHERE exchange = ? AND tradingsymbol = ? AND created_at >= ?
    `).get(exchange, tradingsymbol, cutoff) as { cnt: number };

    return row.cnt > 0;
  }

  /**
   * Retrieve accepted proposals that have NOT yet been processed by the
   * strategy-risk layer (no corresponding strategy_decision row exists).
   *
   * Uses a LEFT JOIN to filter out proposals that already have a strategy
   * decision, ensuring idempotent batch processing.
   *
   * Returns oldest first for deterministic FIFO processing.
   */
  getApprovedUnprocessedAttempts(limit: number = 100): ProposalAttemptRow[] {
    const sql = `
      SELECT pa.id, pa.exchange, pa.tradingsymbol, pa.instrument_token,
             pa.side, pa.product, pa.quantity, pa.price, pa.trigger_price,
             pa.order_type, pa.tag, pa.proposal_status, pa.created_at
      FROM proposal_attempts pa
      LEFT JOIN strategy_decisions sd ON sd.proposal_attempt_id = pa.id
      WHERE pa.proposal_status = ? AND sd.id IS NULL
      ORDER BY pa.created_at ASC
      LIMIT ?
    `;

    const rows = this._db.prepare(sql).all(ProposalStatus.Accepted, limit) as ProposalDbRow[];
    return rows.map(mapAttemptRow);
  }

  /**
   * Count total proposal attempts.
   */
  countAttempts(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM proposal_attempts').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Count total validation reasons.
   */
  countReasons(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM proposal_validation_reasons').get() as { cnt: number };
    return row.cnt;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ProposalDbRow {
  id: number;
  exchange: string;
  tradingsymbol: string;
  instrument_token: number | null;
  side: string;
  product: string;
  quantity: number;
  price: number | null;
  trigger_price: number | null;
  order_type: string;
  tag: string | null;
  proposal_status: string;
  created_at: number;
}

function mapAttemptRow(row: ProposalDbRow): ProposalAttemptRow {
  return {
    id: row.id,
    exchange: row.exchange,
    tradingsymbol: row.tradingsymbol,
    instrumentToken: row.instrument_token,
    side: row.side,
    product: row.product,
    quantity: row.quantity,
    price: row.price,
    triggerPrice: row.trigger_price,
    orderType: row.order_type,
    tag: row.tag,
    proposalStatus: row.proposal_status as ProposalStatus,
    createdAt: row.created_at,
  };
}
