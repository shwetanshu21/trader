import type Database from 'better-sqlite3';
import {
  type PaperFillRow,
  type NewPaperFill,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// PaperFillRepository — typed CRUD over paper_fills.
//
// One fill per successful paper execution (UNIQUE on execution_attempt_id).
// Current paper policy is immediate full fill, so there is exactly one
// fill row per successful order.
// ---------------------------------------------------------------------------

export class PaperFillRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  /**
   * Insert a paper fill row.
   *
   * One row per execution attempt (UNIQUE constraint on execution_attempt_id).
   * Throws on duplicate.
   * Returns the full row including the assigned id.
   */
  insert(fill: NewPaperFill): PaperFillRow {
    const stmt = this._db.prepare(`
      INSERT INTO paper_fills
        (paper_order_id, execution_attempt_id, exchange, tradingsymbol,
         side, product, filled_quantity, filled_price, reference_price,
         slippage_per_unit, slippage_amount, fees,
         broker_order_id, filled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      fill.paperOrderId,
      fill.executionAttemptId,
      fill.exchange,
      fill.tradingsymbol,
      fill.side,
      fill.product,
      fill.filledQuantity,
      fill.filledPrice,
      fill.referencePrice ?? null,
      fill.slippagePerUnit ?? 0,
      fill.slippageAmount ?? 0,
      fill.fees ?? 0,
      fill.brokerOrderId,
      fill.filledAt,
    );

    return {
      id: Number(result.lastInsertRowid),
      paperOrderId: fill.paperOrderId,
      executionAttemptId: fill.executionAttemptId,
      exchange: fill.exchange,
      tradingsymbol: fill.tradingsymbol,
      side: fill.side,
      product: fill.product,
      filledQuantity: fill.filledQuantity,
      filledPrice: fill.filledPrice,
      referencePrice: fill.referencePrice ?? null,
      slippagePerUnit: fill.slippagePerUnit ?? 0,
      slippageAmount: fill.slippageAmount ?? 0,
      fees: fill.fees ?? 0,
      brokerOrderId: fill.brokerOrderId,
      filledAt: fill.filledAt,
    };
  }

  /**
   * Retrieve a paper fill by id.
   */
  getById(id: number): PaperFillRow | null {
    const row = this._db.prepare('SELECT * FROM paper_fills WHERE id = ?')
      .get(id) as PaperFillDbRow | undefined;

    return row ? mapFillRow(row) : null;
  }

  /**
   * Retrieve a paper fill by paper order id.
   */
  getByOrderId(paperOrderId: number): PaperFillRow | null {
    const row = this._db.prepare(
      'SELECT * FROM paper_fills WHERE paper_order_id = ?',
    ).get(paperOrderId) as PaperFillDbRow | undefined;

    return row ? mapFillRow(row) : null;
  }

  /**
   * Retrieve a paper fill by execution attempt id.
   */
  getByExecutionAttemptId(executionAttemptId: number): PaperFillRow | null {
    const row = this._db.prepare(
      'SELECT * FROM paper_fills WHERE execution_attempt_id = ?',
    ).get(executionAttemptId) as PaperFillDbRow | undefined;

    return row ? mapFillRow(row) : null;
  }

  /**
   * Retrieve recent paper fills, newest first.
   */
  getRecent(limit = 50): PaperFillRow[] {
    const rows = this._db.prepare(
      'SELECT * FROM paper_fills ORDER BY filled_at DESC LIMIT ?',
    ).all(limit) as PaperFillDbRow[];

    return rows.map(mapFillRow);
  }

  /**
   * Count total paper fill rows.
   */
  count(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM paper_fills')
      .get() as { cnt: number };
    return row.cnt;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PaperFillDbRow {
  id: number;
  paper_order_id: number;
  execution_attempt_id: number;
  exchange: string;
  tradingsymbol: string;
  side: string;
  product: string;
  filled_quantity: number;
  filled_price: number;
  reference_price: number | null;
  slippage_per_unit: number;
  slippage_amount: number;
  fees: number;
  broker_order_id: string;
  filled_at: number;
}

function mapFillRow(row: PaperFillDbRow): PaperFillRow {
  return {
    id: row.id,
    paperOrderId: row.paper_order_id,
    executionAttemptId: row.execution_attempt_id,
    exchange: row.exchange,
    tradingsymbol: row.tradingsymbol,
    side: row.side,
    product: row.product,
    filledQuantity: row.filled_quantity,
    filledPrice: row.filled_price,
    referencePrice: row.reference_price,
    slippagePerUnit: row.slippage_per_unit ?? 0,
    slippageAmount: row.slippage_amount ?? 0,
    fees: row.fees ?? 0,
    brokerOrderId: row.broker_order_id,
    filledAt: row.filled_at,
  };
}
