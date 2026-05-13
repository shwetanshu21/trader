// ── ExecutionRiskGuard — pure domain service for final execution boundary ──
//
// Evaluates a StrategyApprovedCandidate against market-hours gating,
// persistent risk latch state, duplicate/exposure caps, and daily-loss
// limits before the candidate reaches the mode-aware execution service.
//
// Design:
//   - Always fails closed when required local evidence is missing
//   - Never calls broker/network services
//   - Uses only persisted local data: quotes, positions, orders, risk state
//   - Persists structured refusal/halt evidence through the risk repo
//   - Returns structured verdicts that operator surfaces can render as
//     readable explanations
//
// Check order (fail-closed, stop on first refusal/halt):
//   1. Market closed → refuse with persisted event
//   2. Kill-switch latched → refuse
//   3. Duplicate order (exchange, tradingsymbol, product, side) → refuse
//   4. Max open positions → refuse
//   5. Max orders per instrument → refuse
//   6. Aggregate notional exposure cap → refuse
//   7. Daily loss (realized PnL + unrealized MTM) → halt + persist event

import { MarketClock } from '../runtime/market-clock.js';
import { BrokerRepository } from '../persistence/broker-repo.js';
import { ExecutionRiskRepository } from '../persistence/execution-risk-repo.js';
import { PaperOrderRepository } from '../persistence/paper-order-repo.js';
import { PaperPositionRepository } from '../persistence/paper-position-repo.js';
import {
  HaltSource,
  HaltState,
  PositionSide,
  type RiskLimits,
  type StrategyApprovedCandidate,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/** Verdict from the execution risk guard. */
export enum ExecutionGuardVerdict {
  /** Candidate may proceed through the execution boundary. */
  Allow = 'allow',
  /** Candidate is refused — execution blocked for this specific candidate. */
  Refuse = 'refuse',
  /** Candidate triggered a halt condition — runtime is now halted. */
  Halt = 'halt',
}

/** Machine-readable guard refusal reason code. */
export enum GuardRefusalCode {
  MarketClosed = 'market_closed',
  KillSwitchActive = 'kill_switch_active',
  DuplicateActiveOrder = 'duplicate_active_order',
  MaxOpenPositionsExceeded = 'max_open_positions_exceeded',
  MaxOrdersPerInstrumentExceeded = 'max_orders_per_instrument_exceeded',
  ExposureCapExceeded = 'exposure_cap_exceeded',
  DailyLossLimitBreached = 'daily_loss_limit_breached',
  MissingQuote = 'missing_quote',
  StaleQuote = 'stale_quote',
  MissingPositionData = 'missing_position_data',
}

/** A single structured guard refusal reason. */
export interface GuardRefusalReason {
  readonly reasonCode: GuardRefusalCode;
  readonly reasonMessage: string;
}

/** Result of a single guard evaluation. */
export interface GuardResult {
  readonly verdict: ExecutionGuardVerdict;
  readonly refusalReasons: GuardRefusalReason[];
  /** Whether the guard latched the runtime into a halted state. */
  readonly halted: boolean;
  /** The halt source, if a halt was triggered. */
  readonly haltedSource: HaltSource | null;
  /** The halt reason message, if a halt was triggered. */
  readonly haltedReason: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Quote staleness threshold for MTM pricing (5 minutes). */
const MTM_QUOTE_STALENESS_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// ExecutionRiskGuard
// ---------------------------------------------------------------------------

export class ExecutionRiskGuard {
  readonly label = 'execution-risk-guard';

  private readonly _riskRepo: ExecutionRiskRepository;
  private readonly _marketClock: MarketClock;
  private readonly _riskLimits: RiskLimits;
  private readonly _positionRepo: PaperPositionRepository;
  private readonly _orderRepo: PaperOrderRepository;
  private readonly _brokerRepo: BrokerRepository | null;

  constructor(options: {
    riskRepo: ExecutionRiskRepository;
    marketClock: MarketClock;
    riskLimits: RiskLimits;
    positionRepo: PaperPositionRepository;
    orderRepo: PaperOrderRepository;
    brokerRepo?: BrokerRepository | null;
  }) {
    this._riskRepo = options.riskRepo;
    this._marketClock = options.marketClock;
    this._riskLimits = options.riskLimits;
    this._positionRepo = options.positionRepo;
    this._orderRepo = options.orderRepo;
    this._brokerRepo = options.brokerRepo ?? null;
  }

  /**
   * Evaluate a single strategy-approved candidate against all risk checks.
   *
   * Checks are ordered from cheapest to most expensive (roughly), and the
   * first failure stops evaluation (fail-closed, short-circuit).
   *
   * @param candidate - The strategy-approved trade candidate.
   * @param now - Current timestamp (optional, defaults to Date.now()).
   * @returns A structured guard result.
   */
  evaluate(candidate: StrategyApprovedCandidate, now: Date = new Date()): GuardResult {
    const ts = now.getTime();

    // ── 1. Market hours check ────────────────────────────────────────────
    if (!this._marketClock.isRegularSession(now)) {
      const phase = this._marketClock.getPhase(now);
      return this._refuseAndPersist(
        GuardRefusalCode.MarketClosed,
        `Market is not in regular session (phase: ${phase}). Execution blocked.`,
        ts,
      );
    }

    // ── 2. Kill-switch / latch check ─────────────────────────────────────
    const currentState = this._riskRepo.getCurrentState();
    if (currentState.haltState !== HaltState.NoHalt) {
      return this._refuse(
        GuardRefusalCode.KillSwitchActive,
        currentState.haltReason
          ? `Execution halted: ${currentState.haltReason}`
          : 'Execution is halted by an active risk latch.',
      );
    }

    // ── 3. Duplicate active order check ──────────────────────────────────
    // Duplicate policy: same (exchange, tradingsymbol, product, side) with
    // an active pending or open order is a duplicate.
    const activeOrders = this._orderRepo.findActiveOrdersByKey(
      candidate.exchange,
      candidate.tradingsymbol,
      candidate.product,
      candidate.side,
    );

    if (activeOrders.length > 0) {
      const existing = activeOrders[0];
      return this._refuseAndPersist(
        GuardRefusalCode.DuplicateActiveOrder,
        `Duplicate order detected for ${candidate.exchange}:${candidate.tradingsymbol} ` +
        `(${candidate.product}, ${candidate.side}). Active order #${existing.id} exists.`,
        ts,
        candidate,
      );
    }

    // ── 4. Max open positions check ──────────────────────────────────────
    const openPositions = this._positionRepo.getOpenPositions();
    const openPositionCount = openPositions.length;

    if (this._riskLimits.maxOpenPositions > 0 && openPositionCount >= this._riskLimits.maxOpenPositions) {
      return this._refuseAndPersist(
        GuardRefusalCode.MaxOpenPositionsExceeded,
        `Maximum open positions exceeded: ${openPositionCount} open, ` +
        `limit ${this._riskLimits.maxOpenPositions}. Cannot add new position for ` +
        `${candidate.exchange}:${candidate.tradingsymbol}.`,
        ts,
        candidate,
      );
    }

    // ── 5. Max orders per instrument check ───────────────────────────────
    // Count active orders for this specific instrument (any side).
    const instrumentActiveOrders = this._countActiveOrdersForInstrument(
      candidate.exchange,
      candidate.tradingsymbol,
      candidate.product,
    );

    if (this._riskLimits.maxOrdersPerInstrument > 0 && instrumentActiveOrders >= this._riskLimits.maxOrdersPerInstrument) {
      return this._refuseAndPersist(
        GuardRefusalCode.MaxOrdersPerInstrumentExceeded,
        `Maximum orders per instrument exceeded for ${candidate.exchange}:${candidate.tradingsymbol}: ` +
        `${instrumentActiveOrders} active, limit ${this._riskLimits.maxOrdersPerInstrument}.`,
        ts,
        candidate,
      );
    }

    // ── 6. Aggregate notional exposure check ─────────────────────────────
    if (this._riskLimits.maxExposureRupees > 0) {
      const currentExposure = this._computeCurrentExposure(openPositions);
      const candidateNotional = candidate.notional ?? (candidate.quantity * (candidate.lastPrice ?? 0));

      if (currentExposure + candidateNotional > this._riskLimits.maxExposureRupees) {
        return this._refuseAndPersist(
          GuardRefusalCode.ExposureCapExceeded,
          `Aggregate notional exposure would exceed limit: current ${currentExposure} + ` +
          `candidate ${candidateNotional} > limit ${this._riskLimits.maxExposureRupees}.`,
          ts,
          candidate,
        );
      }
    }

    // ── 7. Daily loss limit check (realized PnL + unrealized MTM) ────────
    if (this._riskLimits.maxDailyLossRupees > 0) {
      // Use ALL positions (including closed/flat ones) for realized PnL
      const allPositions = this._positionRepo.getAllPositions();
      const dailyPnlResult = this._computeDailyPnl(allPositions, ts);

      if (!dailyPnlResult.canCompute) {
        // Missing or stale quote data for MTM — fail closed
        return this._refuseAndPersist(
          GuardRefusalCode.MissingQuote,
          dailyPnlResult.failureReason!,
          ts,
          candidate,
        );
      }

      if (dailyPnlResult.totalPnl < -this._riskLimits.maxDailyLossRupees) {
        // Daily loss limit breached — latch the runtime into a halted state
        const haltReason = `Daily loss limit breached: total P&L ${Math.round(dailyPnlResult.totalPnl)} ` +
          `exceeds max daily loss of ${this._riskLimits.maxDailyLossRupees} (realized: ${Math.round(dailyPnlResult.realizedPnl)}, ` +
          `unrealized MTM: ${Math.round(dailyPnlResult.unrealizedMtm)}).`;

        this._riskRepo.latchHalt(
          HaltSource.DailyLoss,
          haltReason,
          ts,
          openPositions.length,
          dailyPnlResult.totalPnl,
        );

        this._riskRepo.insertEvent({
          eventType: 'daily_loss',
          source: HaltSource.DailyLoss,
          severity: 'critical',
          message: haltReason,
          diagnostic: JSON.stringify({
            totalPnl: dailyPnlResult.totalPnl,
            realizedPnl: dailyPnlResult.realizedPnl,
            unrealizedMtm: dailyPnlResult.unrealizedMtm,
            openPositionCount: openPositions.length,
            maxDailyLossRupees: this._riskLimits.maxDailyLossRupees,
          }),
          recordedAt: ts,
        });

        return {
          verdict: ExecutionGuardVerdict.Halt,
          refusalReasons: [{
            reasonCode: GuardRefusalCode.DailyLossLimitBreached,
            reasonMessage: haltReason,
          }],
          halted: true,
          haltedSource: HaltSource.DailyLoss,
          haltedReason: haltReason,
        };
      }
    }

    // ── All checks passed ────────────────────────────────────────────────
    return {
      verdict: ExecutionGuardVerdict.Allow,
      refusalReasons: [],
      halted: false,
      haltedSource: null,
      haltedReason: null,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Count active (pending or open) paper orders for a specific instrument
   * across both buy and sell sides.
   */
  private _countActiveOrdersForInstrument(
    exchange: string,
    tradingsymbol: string,
    product: string,
  ): number {
    return this._orderRepo.countActiveOrdersByKey(exchange, tradingsymbol, product, 'buy')
      + this._orderRepo.countActiveOrdersByKey(exchange, tradingsymbol, product, 'sell');
  }

  /**
   * Compute the current total notional exposure from all open positions.
   * Each position's notional = |quantity| * avgCostPrice.
   */
  private _computeCurrentExposure(openPositions: { quantity: number; avgCostPrice: number }[]): number {
    let total = 0;
    for (const pos of openPositions) {
      total += Math.abs(pos.quantity) * Math.abs(pos.avgCostPrice);
    }
    return total;
  }

  /**
   * Compute daily P&L from realized PnL of all positions plus unrealized MTM
   * of open positions priced from persisted broker quote snapshots.
   *
   * Returns a result indicating whether computation was possible and the
   * breakdown of realized vs unrealized components.
   */
  private _computeDailyPnl(
    openPositions: { exchange: string; tradingsymbol: string; side: PositionSide; quantity: number; avgCostPrice: number; realizedPnl: number }[],
    now: number,
  ): DailyPnlResult {
    // Sum realized PnL across all positions (both flat and open)
    let realizedPnl = 0;
    for (const pos of openPositions) {
      realizedPnl += pos.realizedPnl;
    }

    // Compute unrealized MTM for open positions using broker quote snapshots
    let unrealizedMtm = 0;
    let missingQuoteCount = 0;
    let staleQuoteCount = 0;

    for (const pos of openPositions) {
      if (pos.quantity === 0) continue;

      // Fetch quote from broker repo
      const quote = this._brokerRepo?.getQuote(pos.exchange, pos.tradingsymbol) ?? null;

      if (quote === null) {
        missingQuoteCount++;
        continue;
      }

      // Check quote staleness
      const stalenessMs = now - quote.receivedAt;
      if (stalenessMs > MTM_QUOTE_STALENESS_MS) {
        staleQuoteCount++;
        continue;
      }

      const lastPrice = quote.lastPrice;
      if (lastPrice == null || lastPrice <= 0) {
        missingQuoteCount++;
        continue;
      }

      // Compute unrealized MTM
      if (pos.side === PositionSide.Long) {
        unrealizedMtm += (lastPrice - pos.avgCostPrice) * pos.quantity;
      } else if (pos.side === PositionSide.Short) {
        unrealizedMtm += (pos.avgCostPrice - lastPrice) * Math.abs(pos.quantity);
      }
      // Flat positions contribute 0 unrealized MTM
    }

    if (missingQuoteCount > 0 || staleQuoteCount > 0) {
      return {
        canCompute: false,
        failureReason: `Cannot compute daily P&L: ${missingQuoteCount > 0 ? `${missingQuoteCount} position(s) missing quote, ` : ''}${staleQuoteCount > 0 ? `${staleQuoteCount} position(s) have stale quotes (>${MTM_QUOTE_STALENESS_MS / 1000}s).` : ''}`.replace(/,\s*$/, ''),
        totalPnl: 0,
        realizedPnl: 0,
        unrealizedMtm: 0,
      };
    }

    return {
      canCompute: true,
      failureReason: null,
      totalPnl: realizedPnl + unrealizedMtm,
      realizedPnl,
      unrealizedMtm,
    };
  }

  /**
   * Build a refuse result without persisting an event.
   * Used when the refusal is transient or not actionable beyond this candidate.
   */
  private _refuse(
    reasonCode: GuardRefusalCode,
    reasonMessage: string,
  ): GuardResult {
    return {
      verdict: ExecutionGuardVerdict.Refuse,
      refusalReasons: [{ reasonCode, reasonMessage }],
      halted: false,
      haltedSource: null,
      haltedReason: null,
    };
  }

  /**
   * Build a refuse result AND persist a risk event.
   * Used when the refusal should be visible on operator surfaces.
   */
  private _refuseAndPersist(
    reasonCode: GuardRefusalCode,
    reasonMessage: string,
    ts: number,
    candidate?: StrategyApprovedCandidate,
  ): GuardResult {
    let diagnostic: string | null = null;
    if (candidate) {
      diagnostic = JSON.stringify({
        exchange: candidate.exchange,
        tradingsymbol: candidate.tradingsymbol,
        side: candidate.side,
        product: candidate.product,
        quantity: candidate.quantity,
        notional: candidate.notional,
      });
    }

    this._riskRepo.insertEvent({
      eventType: 'refusal',
      source: this._toHaltSource(reasonCode),
      severity: 'warning',
      message: reasonMessage,
      diagnostic,
      recordedAt: ts,
    });

    return {
      verdict: ExecutionGuardVerdict.Refuse,
      refusalReasons: [{ reasonCode, reasonMessage }],
      halted: false,
      haltedSource: null,
      haltedReason: null,
    };
  }

  /**
   * Map a guard refusal code to the most appropriate halt source.
   */
  private _toHaltSource(code: GuardRefusalCode): HaltSource | null {
    switch (code) {
      case GuardRefusalCode.MarketClosed:
        return HaltSource.MarketHours;
      case GuardRefusalCode.DuplicateActiveOrder:
        return HaltSource.DuplicateCap;
      case GuardRefusalCode.ExposureCapExceeded:
        return HaltSource.ExposureLimit;
      case GuardRefusalCode.DailyLossLimitBreached:
        return HaltSource.DailyLoss;
      default:
        return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DailyPnlResult {
  canCompute: boolean;
  failureReason: string | null;
  totalPnl: number;
  realizedPnl: number;
  unrealizedMtm: number;
}
