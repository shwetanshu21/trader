import type Database from 'better-sqlite3';
import {
  PositionSide,
  PositionEventType,
  type PaperPositionRow,
  type NewPaperPosition,
  type PositionEventRow,
  type NewPositionEvent,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// PaperPositionRepository — typed CRUD over paper_positions and position_events.
//
// paper_positions is a current-state projection keyed by
// (exchange, tradingsymbol, product). Reconstructed from position_events
// on restart if the projection is stale.
//
// position_events is an append-only log of every position-modifying event,
// enabling audit and reconstruction.
// ---------------------------------------------------------------------------

export class PaperPositionRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  // -----------------------------------------------------------------------
  // Position events (append-only)
  // -----------------------------------------------------------------------

  /**
   * Insert a position event row.
   * Returns the full row including the assigned id.
   */
  insertEvent(event: NewPositionEvent): PositionEventRow {
    const stmt = this._db.prepare(`
      INSERT INTO position_events
        (paper_order_id, paper_fill_id, execution_attempt_id, event_type,
         exchange, tradingsymbol, product, quantity_delta, price,
         previous_quantity, previous_avg_cost, new_quantity, new_avg_cost,
         realized_pnl, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      event.paperOrderId,
      event.paperFillId,
      event.executionAttemptId,
      event.eventType,
      event.exchange,
      event.tradingsymbol,
      event.product,
      event.quantityDelta,
      event.price,
      event.previousQuantity,
      event.previousAvgCost,
      event.newQuantity,
      event.newAvgCost,
      event.realizedPnl,
      event.createdAt,
    );

    return {
      id: Number(result.lastInsertRowid),
      paperOrderId: event.paperOrderId,
      paperFillId: event.paperFillId,
      executionAttemptId: event.executionAttemptId,
      eventType: event.eventType,
      exchange: event.exchange,
      tradingsymbol: event.tradingsymbol,
      product: event.product,
      quantityDelta: event.quantityDelta,
      price: event.price,
      previousQuantity: event.previousQuantity,
      previousAvgCost: event.previousAvgCost,
      newQuantity: event.newQuantity,
      newAvgCost: event.newAvgCost,
      realizedPnl: event.realizedPnl,
      createdAt: event.createdAt,
    };
  }

  /**
   * Retrieve events for a specific position key, oldest first (reconstruction order).
   */
  getEventsByKey(exchange: string, tradingsymbol: string, product: string): PositionEventRow[] {
    const rows = this._db.prepare(`
      SELECT * FROM position_events
      WHERE exchange = ? AND tradingsymbol = ? AND product = ?
      ORDER BY id
    `).all(exchange, tradingsymbol, product) as PositionEventDbRow[];

    return rows.map(mapEventRow);
  }

  /**
   * Retrieve all position events for an execution attempt.
   */
  getEventsByExecutionAttemptId(executionAttemptId: number): PositionEventRow[] {
    const rows = this._db.prepare(`
      SELECT * FROM position_events WHERE execution_attempt_id = ?
      ORDER BY id
    `).all(executionAttemptId) as PositionEventDbRow[];

    return rows.map(mapEventRow);
  }

  /**
   * Retrieve recent position events, newest first.
   */
  getRecentEvents(limit = 50): PositionEventRow[] {
    const rows = this._db.prepare(
      'SELECT * FROM position_events ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as PositionEventDbRow[];

    return rows.map(mapEventRow);
  }

  /**
   * Count total position event rows.
   */
  countEvents(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM position_events')
      .get() as { cnt: number };
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Paper positions (current-state projection)
  // -----------------------------------------------------------------------

  /**
   * Upsert a paper position row.
   * Inserts if no row exists for (exchange, tradingsymbol, product),
   * otherwise updates the existing row.
   * Returns the full row including the assigned or existing id.
   */
  upsertPosition(position: NewPaperPosition): PaperPositionRow {
    const stmt = this._db.prepare(`
      INSERT INTO paper_positions
        (exchange, tradingsymbol, product, side, quantity,
         avg_cost_price, realized_pnl, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange, tradingsymbol, product) DO UPDATE SET
        side            = excluded.side,
        quantity        = excluded.quantity,
        avg_cost_price  = excluded.avg_cost_price,
        realized_pnl    = excluded.realized_pnl,
        updated_at      = excluded.updated_at
    `);

    stmt.run(
      position.exchange,
      position.tradingsymbol,
      position.product,
      position.side,
      position.quantity,
      position.avgCostPrice,
      position.realizedPnl,
      position.updatedAt,
    );

    // Retrieve the row to get back the id
    return this.getPosition(position.exchange, position.tradingsymbol, position.product)!;
  }

  /**
   * Retrieve a paper position by composite key.
   */
  getPosition(exchange: string, tradingsymbol: string, product: string): PaperPositionRow | null {
    const row = this._db.prepare(`
      SELECT * FROM paper_positions WHERE exchange = ? AND tradingsymbol = ? AND product = ?
    `).get(exchange, tradingsymbol, product) as PaperPositionDbRow | undefined;

    return row ? mapPositionRow(row) : null;
  }

  /**
   * Retrieve all paper positions.
   */
  getAllPositions(): PaperPositionRow[] {
    const rows = this._db.prepare(
      'SELECT * FROM paper_positions ORDER BY exchange, tradingsymbol',
    ).all() as PaperPositionDbRow[];

    return rows.map(mapPositionRow);
  }

  /**
   * Retrieve open (non-flat) paper positions.
   */
  getOpenPositions(): PaperPositionRow[] {
    const rows = this._db.prepare(`
      SELECT * FROM paper_positions WHERE quantity != 0 ORDER BY exchange, tradingsymbol
    `).all() as PaperPositionDbRow[];

    return rows.map(mapPositionRow);
  }

  /**
   * Count total paper position rows.
   */
  countPositions(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM paper_positions')
      .get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Count open (non-flat) paper positions.
   */
  countOpenPositions(): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM paper_positions WHERE quantity != 0',
    ).get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Reconstruct all current positions from position_events.
   *
   * Rebuilds the paper_positions table by replaying every event in order.
   * Useful after schema migration or when the projection is suspected stale.
   */
  reconstructAllPositions(): PaperPositionRow[] {
    const events = this._db.prepare(
      'SELECT * FROM position_events ORDER BY id',
    ).all() as PositionEventDbRow[];

    // Clear existing positions
    this._db.prepare('DELETE FROM paper_positions').run();

    // Group events by key and compute final state
    const groups = new Map<string, PositionEventDbRow[]>();
    for (const event of events) {
      const key = `${event.exchange}|${event.tradingsymbol}|${event.product}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(event);
    }

    const now = Date.now();
    const positions: PaperPositionRow[] = [];

    for (const [, groupEvents] of groups) {
      if (groupEvents.length === 0) continue;
      const last = groupEvents[groupEvents.length - 1];

      const position: PaperPositionRow = {
        id: 0, // Will be assigned by DB
        exchange: last.exchange,
        tradingsymbol: last.tradingsymbol,
        product: last.product,
        side: last.new_quantity > 0 ? PositionSide.Long
          : last.new_quantity < 0 ? PositionSide.Short
          : PositionSide.Flat,
        quantity: last.new_quantity,
        avgCostPrice: last.new_avg_cost,
        realizedPnl: groupEvents.reduce((sum, e) => sum + e.realized_pnl, 0),
        updatedAt: last.created_at,
      };

      const inserted = this.upsertPosition(position);
      positions.push(inserted);
    }

    return positions;
  }

  /**
   * Compute position state from events for a single key without writing to the DB.
   * Useful for validation and testing.
   */
  computePositionFromEvents(
    exchange: string,
    tradingsymbol: string,
    product: string,
  ): { side: PositionSide; quantity: number; avgCostPrice: number; realizedPnl: number } {
    const events = this.getEventsByKey(exchange, tradingsymbol, product);

    if (events.length === 0) {
      return { side: PositionSide.Flat, quantity: 0, avgCostPrice: 0, realizedPnl: 0 };
    }

    const last = events[events.length - 1];
    const realizedPnl = events.reduce((sum, e) => sum + e.realizedPnl, 0);

    return {
      side: last.newQuantity > 0 ? PositionSide.Long
        : last.newQuantity < 0 ? PositionSide.Short
        : PositionSide.Flat,
      quantity: last.newQuantity,
      avgCostPrice: last.newAvgCost,
      realizedPnl,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PositionEventDbRow {
  id: number;
  paper_order_id: number;
  paper_fill_id: number | null;
  execution_attempt_id: number;
  event_type: string;
  exchange: string;
  tradingsymbol: string;
  product: string;
  quantity_delta: number;
  price: number;
  previous_quantity: number;
  previous_avg_cost: number;
  new_quantity: number;
  new_avg_cost: number;
  realized_pnl: number;
  created_at: number;
}

function mapEventRow(row: PositionEventDbRow): PositionEventRow {
  return {
    id: row.id,
    paperOrderId: row.paper_order_id,
    paperFillId: row.paper_fill_id,
    executionAttemptId: row.execution_attempt_id,
    eventType: row.event_type as PositionEventType,
    exchange: row.exchange,
    tradingsymbol: row.tradingsymbol,
    product: row.product,
    quantityDelta: row.quantity_delta,
    price: row.price,
    previousQuantity: row.previous_quantity,
    previousAvgCost: row.previous_avg_cost,
    newQuantity: row.new_quantity,
    newAvgCost: row.new_avg_cost,
    realizedPnl: row.realized_pnl,
    createdAt: row.created_at,
  };
}

interface PaperPositionDbRow {
  id: number;
  exchange: string;
  tradingsymbol: string;
  product: string;
  side: string;
  quantity: number;
  avg_cost_price: number;
  realized_pnl: number;
  updated_at: number;
}

function mapPositionRow(row: PaperPositionDbRow): PaperPositionRow {
  return {
    id: row.id,
    exchange: row.exchange,
    tradingsymbol: row.tradingsymbol,
    product: row.product,
    side: row.side as PositionSide,
    quantity: row.quantity,
    avgCostPrice: row.avg_cost_price,
    realizedPnl: row.realized_pnl,
    updatedAt: row.updated_at,
  };
}
