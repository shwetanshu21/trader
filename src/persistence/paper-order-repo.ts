import type Database from 'better-sqlite3';
import {
  PaperOrderStatus,
  type PaperOrderRow,
  type NewPaperOrder,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// PaperOrderRepository — typed CRUD over paper_orders.
//
// One row per successful execution attempt (UNIQUE on execution_attempt_id).
// Append-only after insert; status transitions are explicit.
// ---------------------------------------------------------------------------

export class PaperOrderRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  /**
   * Insert a paper order row.
   *
   * One row per execution attempt (UNIQUE constraint on execution_attempt_id).
   * Throws on duplicate.
   * Returns the full row including the assigned id.
   */
  insert(order: NewPaperOrder): PaperOrderRow {
    const stmt = this._db.prepare(`
      INSERT INTO paper_orders
        (execution_attempt_id, exchange, tradingsymbol, side, product,
         quantity, price, trigger_price, order_type, tag,
         status, broker_order_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      order.executionAttemptId,
      order.exchange,
      order.tradingsymbol,
      order.side,
      order.product,
      order.quantity,
      order.price,
      order.triggerPrice,
      order.orderType,
      order.tag,
      order.status,
      order.brokerOrderId,
      order.createdAt,
      order.updatedAt,
    );

    return {
      id: Number(result.lastInsertRowid),
      executionAttemptId: order.executionAttemptId,
      exchange: order.exchange,
      tradingsymbol: order.tradingsymbol,
      side: order.side,
      product: order.product,
      quantity: order.quantity,
      price: order.price,
      triggerPrice: order.triggerPrice,
      orderType: order.orderType,
      tag: order.tag,
      status: order.status,
      brokerOrderId: order.brokerOrderId,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  /**
   * Retrieve a paper order by id.
   */
  getById(id: number): PaperOrderRow | null {
    const row = this._db.prepare('SELECT * FROM paper_orders WHERE id = ?')
      .get(id) as PaperOrderDbRow | undefined;

    return row ? mapOrderRow(row) : null;
  }

  /**
   * Retrieve a paper order by execution attempt id.
   */
  getByExecutionAttemptId(executionAttemptId: number): PaperOrderRow | null {
    const row = this._db.prepare(
      'SELECT * FROM paper_orders WHERE execution_attempt_id = ?',
    ).get(executionAttemptId) as PaperOrderDbRow | undefined;

    return row ? mapOrderRow(row) : null;
  }

  /**
   * Retrieve recent paper orders, newest first.
   */
  getRecent(limit = 50): PaperOrderRow[] {
    const rows = this._db.prepare(
      'SELECT * FROM paper_orders ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as PaperOrderDbRow[];

    return rows.map(mapOrderRow);
  }

  /**
   * Retrieve paper orders by status, newest first.
   */
  getByStatus(status: PaperOrderStatus, limit = 50): PaperOrderRow[] {
    const rows = this._db.prepare(
      'SELECT * FROM paper_orders WHERE status = ? ORDER BY created_at DESC LIMIT ?',
    ).all(status, limit) as PaperOrderDbRow[];

    return rows.map(mapOrderRow);
  }

  /**
   * Update the status of a paper order.
   */
  updateStatus(id: number, status: PaperOrderStatus): void {
    this._db.prepare(
      'UPDATE paper_orders SET status = ?, updated_at = ? WHERE id = ?',
    ).run(status, Date.now(), id);
  }

  /**
   * Count total paper order rows.
   */
  count(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM paper_orders')
      .get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Count paper orders by status.
   */
  countByStatus(status: PaperOrderStatus): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM paper_orders WHERE status = ?',
    ).get(status) as { cnt: number };
    return row.cnt;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PaperOrderDbRow {
  id: number;
  execution_attempt_id: number;
  exchange: string;
  tradingsymbol: string;
  side: string;
  product: string;
  quantity: number;
  price: number | null;
  trigger_price: number | null;
  order_type: string;
  tag: string | null;
  status: string;
  broker_order_id: string;
  created_at: number;
  updated_at: number | null;
}

function mapOrderRow(row: PaperOrderDbRow): PaperOrderRow {
  return {
    id: row.id,
    executionAttemptId: row.execution_attempt_id,
    exchange: row.exchange,
    tradingsymbol: row.tradingsymbol,
    side: row.side,
    product: row.product,
    quantity: row.quantity,
    price: row.price,
    triggerPrice: row.trigger_price,
    orderType: row.order_type,
    tag: row.tag,
    status: row.status as PaperOrderStatus,
    brokerOrderId: row.broker_order_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
