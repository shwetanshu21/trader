// ── PaperExecutionLedger — atomic paper-success coordinator ──
//
// Owns the downstream write boundary for successful paper fills.
// Encapsulates the multi-table transaction that persists execution attempt,
// paper order, paper fill, position event, and projected position state
// as one atomic unit.
//
// Invariants:
//   - All downstream rows are written inside a single SQLite transaction
//   - Any failure rolls back the entire write set — no partial residue
//   - Exactly one downstream set per strategy decision (enforced by UNIQUE FKs)
//   - Refusal paths are NOT handled here — they remain attempt-only in the service
//   - Position projection is computed from current state, not assumed flat

import type Database from 'better-sqlite3';
import {
  ExecutionAttemptStatus,
  ExecutionMode,
  ExecutionOutcomeCode,
  PaperOrderStatus,
  PositionEventType,
  PositionSide,
  type ExecutionAttemptRow,
  type NewExecutionAttempt,
  type NewPaperOrder,
  type NewPaperFill,
  type NewPositionEvent,
  type NewPaperPosition,
  type PaperOrderRow,
  type PaperFillRow,
  type PositionEventRow,
  type PaperPositionRow,
  type StrategyApprovedCandidate,
} from '../types/runtime.js';
import type { PaperEvaluationResult } from './paper-execution-policy.js';
import { ExecutionAttemptRepository } from '../persistence/execution-attempt-repo.js';
import { PaperOrderRepository } from '../persistence/paper-order-repo.js';
import { PaperFillRepository } from '../persistence/paper-fill-repo.js';
import { PaperPositionRepository } from '../persistence/paper-position-repo.js';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/**
 * Result of a successful paper fill write through the ledger.
 *
 * Every non-null field is guaranteed to be present when the ledger
 * write completes — the transaction either succeeds fully or aborts.
 */
export interface PaperLedgerResult {
  /** The execution attempt row created. */
  readonly attempt: ExecutionAttemptRow;
  /** The paper order row created. */
  readonly order: PaperOrderRow;
  /** The paper fill row created. */
  readonly fill: PaperFillRow;
  /** The position event row created. */
  readonly positionEvent: PositionEventRow;
  /** The paper position row created or updated. */
  readonly position: PaperPositionRow;
}

// ---------------------------------------------------------------------------
// PaperExecutionLedger
// ---------------------------------------------------------------------------

export class PaperExecutionLedger {
  readonly label = 'paper-execution-ledger';

  private readonly _db: Database.Database;
  private readonly _attemptRepo: ExecutionAttemptRepository;
  private readonly _orderRepo: PaperOrderRepository;
  private readonly _fillRepo: PaperFillRepository;
  private readonly _positionRepo: PaperPositionRepository;

  constructor(options: {
    db: Database.Database;
    attemptRepo: ExecutionAttemptRepository;
    orderRepo: PaperOrderRepository;
    fillRepo: PaperFillRepository;
    positionRepo: PaperPositionRepository;
  }) {
    this._db = options.db;
    this._attemptRepo = options.attemptRepo;
    this._orderRepo = options.orderRepo;
    this._fillRepo = options.fillRepo;
    this._positionRepo = options.positionRepo;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Atomically write a successful paper fill across all downstream tables.
   *
   * Creates:
   *   1. execution_attempt  (Completed, PaperSimulated)
   *   2. paper_order        (Filled, with simulated broker order ID)
   *   3. paper_fill         (full quantity at fill price)
   *   4. position_event     (Open/Adjust/Close based on current position state)
   *   5. paper_position     (upserted current-state projection)
   *
   * All writes happen inside a single SQLite transaction. If any step fails,
   * the entire write set is rolled back — no partial residue.
   *
   * @param candidate - The strategy-approved trade candidate.
   * @param evaluation - The paper evaluation result (must have canFill=true).
   * @returns The complete ledger write result.
   * @throws {Error} If evaluation.canFill is false, or if any DB write fails.
   */
  writeSuccessfulPaperFill(
    candidate: StrategyApprovedCandidate,
    evaluation: PaperEvaluationResult,
  ): PaperLedgerResult {
    if (!evaluation.canFill) {
      throw new Error(
        `PaperExecutionLedger.refuseWriteAttempt: evaluation.canFill is false ` +
        `(candidate ${candidate.id}). Refusal paths must not call writeSuccessfulPaperFill.`,
      );
    }

    // Narrow fillPrice from number|null — guaranteed non-null when canFill is true
    const fillPrice: number = evaluation.fillPrice as number;
    if (fillPrice <= 0) {
      throw new Error(
        `PaperExecutionLedger.invalidFillPrice: fillPrice is ${fillPrice} ` +
        `(candidate ${candidate.id}). A valid positive fill price is required.`,
      );
    }

    if (candidate.quantity <= 0) {
      throw new Error(
        `PaperExecutionLedger.invalidQuantity: quantity is ${candidate.quantity} ` +
        `(candidate ${candidate.id}). Quantity must be positive.`,
      );
    }

    const now = Date.now();

    // ── Atomic transaction ────────────────────────────────────────────────
    const writeTx = this._db.transaction((): PaperLedgerResult => {
      // 1. Insert execution attempt
      const attempt: NewExecutionAttempt = {
        strategyDecisionId: candidate.id,
        executionMode: ExecutionMode.Paper,
        status: ExecutionAttemptStatus.Completed,
        outcomeCode: evaluation.outcomeCode,
        brokerOrderId: evaluation.simulatedBrokerOrderId,
        message: evaluation.message,
        attemptedAt: now,
        completedAt: now,
      };

      const attemptRow = this._attemptRepo.insertAttempt(attempt);

      // 2. Insert paper order (Filled status — paper is immediate full fill)
      const order: NewPaperOrder = {
        executionAttemptId: attemptRow.id,
        exchange: candidate.exchange,
        tradingsymbol: candidate.tradingsymbol,
        side: candidate.side,
        product: candidate.product,
        quantity: candidate.quantity,
        price: candidate.price,
        triggerPrice: candidate.triggerPrice,
        orderType: candidate.orderType,
        tag: null,
        status: PaperOrderStatus.Filled,
        brokerOrderId: evaluation.simulatedBrokerOrderId!,
        createdAt: now,
        updatedAt: null,
      };

      const orderRow = this._orderRepo.insert(order);

      // 3. Insert paper fill (full quantity at fill price)
      const fill: NewPaperFill = {
        paperOrderId: orderRow.id,
        executionAttemptId: attemptRow.id,
        exchange: candidate.exchange,
        tradingsymbol: candidate.tradingsymbol,
        side: candidate.side,
        product: candidate.product,
        filledQuantity: candidate.quantity,
        filledPrice: fillPrice,
        brokerOrderId: evaluation.simulatedBrokerOrderId!,
        filledAt: now,
      };

      const fillRow = this._fillRepo.insert(fill);

      // 4. Compute and insert position event
      const currentPosition = this._positionRepo.getPosition(
        candidate.exchange, candidate.tradingsymbol, candidate.product,
      );

      const positionEvent = this._computePositionEvent(
        candidate, fillPrice, currentPosition, orderRow.id, fillRow.id, attemptRow.id, now,
      );
      const eventRow = this._positionRepo.insertEvent(positionEvent);

      // Cumulative realized PnL = previous cumulative + current fill's realized PnL
      const cumRealizedPnl = (currentPosition?.realizedPnl ?? 0) + eventRow.realizedPnl;

      // 5. Upsert paper position projection with cumulative realized PnL
      const netSide = this._computePositionSide(eventRow.newQuantity);
      const positionRow = this._positionRepo.upsertPosition({
        exchange: candidate.exchange,
        tradingsymbol: candidate.tradingsymbol,
        product: candidate.product,
        side: netSide,
        quantity: eventRow.newQuantity,
        avgCostPrice: eventRow.newAvgCost,
        realizedPnl: cumRealizedPnl,
        updatedAt: now,
      });

      return {
        attempt: attemptRow,
        order: orderRow,
        fill: fillRow,
        positionEvent: eventRow,
        position: positionRow,
      };
    });

    return writeTx();
  }

  // -------------------------------------------------------------------------
  // Position projection computation
  // -------------------------------------------------------------------------

  /**
   * Compute a position event from the current position state and the new fill.
   *
   * Determines:
   *   - Event type (Open / Adjust / Close)
   *   - New quantity and average cost
   *   - Realized P&L when reducing or closing a position
   */
  private _computePositionEvent(
    candidate: StrategyApprovedCandidate,
    fillPrice: number,
    currentPosition: PaperPositionRow | null,
    paperOrderId: number,
    paperFillId: number,
    executionAttemptId: number,
    now: number,
  ): NewPositionEvent {
    const prevQty = currentPosition?.quantity ?? 0;
    const prevAvgCost = currentPosition?.avgCostPrice ?? 0;

    // Quantity delta: buy → +qty (long), sell → -qty (short)
    const qtyDelta = candidate.side.toLowerCase() === 'buy'
      ? candidate.quantity
      : -candidate.quantity;

    const newQty = prevQty + qtyDelta;

    // Determine event type, new average cost, and realized P&L
    let eventType: PositionEventType;
    let newAvgCost: number;
    let realizedPnl = 0;

    if (prevQty === 0) {
      // Opening a new position from flat
      eventType = PositionEventType.Open;
      newAvgCost = fillPrice;
      realizedPnl = 0;
    } else if ((prevQty > 0 && qtyDelta > 0) || (prevQty < 0 && qtyDelta < 0)) {
      // Increasing same-direction position — weighted average
      eventType = PositionEventType.Adjust;
      const absPrev = Math.abs(prevQty);
      const absDelta = Math.abs(qtyDelta);
      const totalQty = absPrev + absDelta;
      const totalCost = absPrev * prevAvgCost + absDelta * fillPrice;
      newAvgCost = totalQty > 0 ? totalCost / totalQty : prevAvgCost;
      realizedPnl = 0;
    } else {
      // Opposite direction — reducing or closing a position
      const absPrev = Math.abs(prevQty);
      const absDelta = Math.abs(qtyDelta);
      const reduceQty = Math.min(absPrev, absDelta);

      // Realized P&L: for long positions being reduced, (fillPrice - avgCost) * qty
      //               for short positions being reduced, (avgCost - fillPrice) * qty
      if (prevQty > 0) {
        realizedPnl = (fillPrice - prevAvgCost) * reduceQty;
      } else {
        realizedPnl = (prevAvgCost - fillPrice) * reduceQty;
      }

      if (newQty === 0) {
        // Position fully closed
        eventType = PositionEventType.Close;
        newAvgCost = 0;
      } else if (absDelta < absPrev) {
        // Partial close — same direction remains, cost basis unchanged
        eventType = PositionEventType.Adjust;
        newAvgCost = prevAvgCost;
      } else {
        // Full close then open in the opposite direction
        eventType = PositionEventType.Adjust;
        newAvgCost = fillPrice;
      }
    }

    return {
      paperOrderId,
      paperFillId,
      executionAttemptId,
      eventType,
      exchange: candidate.exchange,
      tradingsymbol: candidate.tradingsymbol,
      product: candidate.product,
      quantityDelta: qtyDelta,
      price: fillPrice,
      previousQuantity: prevQty,
      previousAvgCost: prevAvgCost,
      newQuantity: newQty,
      newAvgCost,
      realizedPnl,
      createdAt: now,
    };
  }

  /**
   * Compute the net position side from the net quantity.
   */
  private _computePositionSide(quantity: number): PositionSide {
    if (quantity > 0) return PositionSide.Long;
    if (quantity < 0) return PositionSide.Short;
    return PositionSide.Flat;
  }
}
