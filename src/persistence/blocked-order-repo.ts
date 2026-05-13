import type Database from 'better-sqlite3';
import {
  BlockCode,
  ProposalStatus,
  type BlockedOrderRow,
  type NewBlockedOrder,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// BlockedOrderRepository — typed CRUD over the blocked-order ledger table.
//
// Invariant: exactly one blocked-order row per source accepted proposal.
// Enforced by UNIQUE(proposal_attempt_id) in the schema and enforced at the
// application level via INSERT OR IGNORE (idempotent insert).
// ---------------------------------------------------------------------------

export class BlockedOrderRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  /**
   * Insert a blocked-order ledger row idempotently.
   * If a row for the same `proposal_attempt_id` already exists, the INSERT is
   * silently ignored (no error, no row update — first write wins).
   *
   * Returns the inserted row (or the existing row if already blocked).
   */
  insertBlockedOrder(blocked: NewBlockedOrder): BlockedOrderRow {
    const stmt = this._db.prepare(`
      INSERT OR IGNORE INTO blocked_order_attempts
        (proposal_attempt_id, blocked_at, block_code, block_message, gate_tag,
         exchange, tradingsymbol, instrument_token, side, product, quantity,
         price, trigger_price, order_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      blocked.proposalAttemptId,
      blocked.blockedAt,
      blocked.blockCode,
      blocked.blockMessage,
      blocked.gateTag,
      blocked.exchange,
      blocked.tradingsymbol,
      blocked.instrumentToken,
      blocked.side,
      blocked.product,
      blocked.quantity,
      blocked.price,
      blocked.triggerPrice,
      blocked.orderType,
    );

    // If INSERT OR IGNORE did nothing (duplicate), fetch the existing row
    if (result.changes === 0) {
      const existing = this._db.prepare(`
        SELECT * FROM blocked_order_attempts WHERE proposal_attempt_id = ?
      `).get(blocked.proposalAttemptId) as BlockedOrderDbRow | undefined;

      if (existing) {
        return mapBlockedRow(existing);
      }
    }

    return {
      id: Number(result.lastInsertRowid),
      proposalAttemptId: blocked.proposalAttemptId,
      blockedAt: blocked.blockedAt,
      blockCode: blocked.blockCode,
      blockMessage: blocked.blockMessage,
      gateTag: blocked.gateTag,
      exchange: blocked.exchange,
      tradingsymbol: blocked.tradingsymbol,
      instrumentToken: blocked.instrumentToken,
      side: blocked.side,
      product: blocked.product,
      quantity: blocked.quantity,
      price: blocked.price,
      triggerPrice: blocked.triggerPrice,
      orderType: blocked.orderType,
    };
  }

  /**
   * Retrieve a blocked-order row by its id.
   */
  getById(id: number): BlockedOrderRow | null {
    const row = this._db.prepare(`
      SELECT * FROM blocked_order_attempts WHERE id = ?
    `).get(id) as BlockedOrderDbRow | undefined;

    return row ? mapBlockedRow(row) : null;
  }

  /**
   * Retrieve a blocked-order row by source proposal attempt id.
   */
  getByProposalAttemptId(proposalAttemptId: number): BlockedOrderRow | null {
    const row = this._db.prepare(`
      SELECT * FROM blocked_order_attempts WHERE proposal_attempt_id = ?
    `).get(proposalAttemptId) as BlockedOrderDbRow | undefined;

    return row ? mapBlockedRow(row) : null;
  }

  /**
   * Retrieve recent blocked-order rows, newest first.
   */
  getRecent(limit = 50): BlockedOrderRow[] {
    const rows = this._db.prepare(`
      SELECT * FROM blocked_order_attempts
      ORDER BY blocked_at DESC
      LIMIT ?
    `).all(limit) as BlockedOrderDbRow[];

    return rows.map(mapBlockedRow);
  }

  /**
   * Retrieve accepted proposal attempts that have NOT yet been blocked.
   *
   * This is the core query that the execution gate uses each tick:
   * "which accepted proposals still need a blocked-order ledger row?"
   *
   * Uses a LEFT JOIN with IS NULL check to find accepted proposals that
   * have no corresponding blocked-order entry.
   */
  getAcceptedUnblockedAttempts(limit = 100): Array<{
    proposalAttemptId: number;
    exchange: string;
    tradingsymbol: string;
    side: string;
    product: string;
    quantity: number;
    price: number | null;
    triggerPrice: number | null;
    orderType: string;
    instrumentToken: number | null;
    createdAt: number;
  }> {
    const rows = this._db.prepare(`
      SELECT
        pa.id AS proposal_attempt_id,
        pa.exchange,
        pa.tradingsymbol,
        pa.side,
        pa.product,
        pa.quantity,
        pa.price,
        pa.trigger_price AS triggerPrice,
        pa.order_type AS orderType,
        pa.instrument_token AS instrumentToken,
        pa.created_at AS createdAt
      FROM proposal_attempts pa
      LEFT JOIN blocked_order_attempts boa
        ON boa.proposal_attempt_id = pa.id
      WHERE pa.proposal_status = ?
        AND boa.id IS NULL
      ORDER BY pa.created_at ASC
      LIMIT ?
    `).all(ProposalStatus.Accepted, limit) as Array<{
      proposal_attempt_id: number;
      exchange: string;
      tradingsymbol: string;
      side: string;
      product: string;
      quantity: number;
      price: number | null;
      triggerPrice: number | null;
      orderType: string;
      instrumentToken: number | null;
      createdAt: number;
    }>;

    return rows.map(r => ({
      proposalAttemptId: r.proposal_attempt_id,
      exchange: r.exchange,
      tradingsymbol: r.tradingsymbol,
      side: r.side,
      product: r.product,
      quantity: r.quantity,
      price: r.price,
      triggerPrice: r.triggerPrice,
      orderType: r.orderType,
      instrumentToken: r.instrumentToken,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Retrieve strategy-approved candidates that have NOT yet been blocked.
   *
   * Joins strategy_decisions with blocked_order_attempts, returning only
   * approved decisions that have no corresponding blocked-order entry.
   * The returned quantity is the strategy-derived value (lot-size rounded),
   * which may differ from the raw proposal quantity.
   *
   * This is the M003 replacement for getAcceptedUnblockedAttempts — downstream
   * consumers (execution gate) should call this instead.
   */
  getStrategyApprovedUnblocked(limit = 100): Array<{
    id: number;
    proposalAttemptId: number;
    strategyId: string;
    strategyVersion: string;
    decidedAt: number;
    exchange: string;
    tradingsymbol: string;
    instrumentToken: number | null;
    side: string;
    product: string;
    quantity: number;
    price: number | null;
    triggerPrice: number | null;
    orderType: string;
    lastPrice: number | null;
    bid: number | null;
    ask: number | null;
    notional: number | null;
    sizingBasis: string;
  }> {
    const rows = this._db.prepare(`
      SELECT
        sd.id,
        sd.proposal_attempt_id AS proposalAttemptId,
        sd.strategy_id AS strategyId,
        sd.strategy_version AS strategyVersion,
        sd.decided_at AS decidedAt,
        sd.exchange,
        sd.tradingsymbol,
        pa.instrument_token AS instrumentToken,
        sd.side,
        sd.product,
        sd.quantity,
        sd.price,
        sd.trigger_price AS triggerPrice,
        sd.order_type AS orderType,
        sd.quote_last_price AS lastPrice,
        sd.quote_bid AS bid,
        sd.quote_ask AS ask,
        sd.risk_notional AS notional,
        sd.risk_sizing_basis AS sizingBasis
      FROM strategy_decisions sd
      LEFT JOIN blocked_order_attempts boa
        ON boa.proposal_attempt_id = sd.proposal_attempt_id
      LEFT JOIN proposal_attempts pa
        ON pa.id = sd.proposal_attempt_id
      WHERE sd.decision_status = 'approved'
        AND boa.id IS NULL
      ORDER BY sd.decided_at ASC
      LIMIT ?
    `).all(limit) as Array<{
      id: number;
      proposalAttemptId: number;
      strategyId: string;
      strategyVersion: string;
      decidedAt: number;
      exchange: string;
      tradingsymbol: string;
      instrumentToken: number | null;
      side: string;
      product: string;
      quantity: number;
      price: number | null;
      triggerPrice: number | null;
      orderType: string;
      lastPrice: number | null;
      bid: number | null;
      ask: number | null;
      notional: number | null;
      sizingBasis: string;
    }>;

    return rows;
  }

  /**
   * Count total blocked-order rows.
   */
  count(): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM blocked_order_attempts',
    ).get() as { cnt: number };
    return row.cnt;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface BlockedOrderDbRow {
  id: number;
  proposal_attempt_id: number;
  blocked_at: number;
  block_code: string;
  block_message: string;
  gate_tag: string;
  exchange: string;
  tradingsymbol: string;
  instrument_token: number | null;
  side: string;
  product: string;
  quantity: number;
  price: number | null;
  trigger_price: number | null;
  order_type: string;
}

function mapBlockedRow(row: BlockedOrderDbRow): BlockedOrderRow {
  return {
    id: row.id,
    proposalAttemptId: row.proposal_attempt_id,
    blockedAt: row.blocked_at,
    blockCode: row.block_code as BlockCode,
    blockMessage: row.block_message,
    gateTag: row.gate_tag,
    exchange: row.exchange,
    tradingsymbol: row.tradingsymbol,
    instrumentToken: row.instrument_token,
    side: row.side,
    product: row.product,
    quantity: row.quantity,
    price: row.price,
    triggerPrice: row.trigger_price,
    orderType: row.order_type,
  };
}
