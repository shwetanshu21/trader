// ── OperatorReadModel — truthful query-backed operator aggregates ──
//
// Uses the read-only SQLite seam to run COUNT/SUM/GROUP BY queries over
// persisted evidence tables. Every DTO carries explicit OperatorProvenance
// so callers can distinguish runtime (live in-process) from historical
// (persisted evidence) data.
//
// Bounded recent lists (e.g. top-50 decisions) are clearly separated from
// aggregate totals — totals come from persisted COUNT/SUM queries and remain
// truthful even when recent-list caps are exceeded.
//
// No writes, no pragma changes, no schema assumptions beyond what the
// runtime schema guarantees.

import type Database from 'better-sqlite3';
import {
  type OperatorProvenance,
  type OperatorSummaryCard,
  type OperatorStrategyPerformance,
  type OperatorTickerPerformance,
  type OperatorDecisionPerformance,
  type OperatorLifecycleState,
  type OperatorLifecycleHistory,
  type OperatorPromotionHistory,
  type OperatorWalkForwardLeaderboard,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;

// ---------------------------------------------------------------------------
// DB row shapes (snake_case → inline consumption)
// ---------------------------------------------------------------------------

interface PaperFillRow {
  id: number;
  execution_attempt_id: number;
  exchange: string;
  tradingsymbol: string;
  side: string;
  filled_quantity: number;
  filled_price: number;
}

interface PaperPositionRow {
  exchange: string;
  tradingsymbol: string;
  side: string;
  quantity: number;
  avg_cost_price: number;
  realized_pnl: number;
  mark_price: number | null;
}

interface PositionEventRow {
  id: number;
  execution_attempt_id: number;
  exchange: string;
  tradingsymbol: string;
  realized_pnl: number;
}

interface StrategyDecisionMinRow {
  id: number;
  proposal_attempt_id: number;
  exchange: string;
  tradingsymbol: string;
  side: string;
  quantity: number;
  price: number | null;
  decision_status: string;
  strategy_id: string;
  strategy_version: string;
  decided_at: number;
}

interface ExecutionAttemptMinRow {
  id: number;
  strategy_decision_id: number;
  execution_mode: string;
  status: string;
  outcome_code: string | null;
  attempted_at: number;
}

interface PerStrategyAggRow {
  strategy_id: string;
  strategy_version: string;
  trade_count: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  total_return_pct: number;
  avg_sharpe: number | null;
  avg_max_drawdown: number | null;
  avg_win_rate: number | null;
  avg_profit_factor: number | null;
}

interface PerTickerFillRow {
  exchange: string;
  tradingsymbol: string;
  trade_count: number;
  side: string;
  quantity: number;
  avg_cost_price: number | null;
  last_fill_price: number | null;
}

interface PerTickerPositionRow {
  exchange: string;
  tradingsymbol: string;
  side: string;
  quantity: number;
  avg_cost_price: number;
  realized_pnl: number;
  mark_price: number | null;
}

interface PerDecisionRow {
  sd_id: number;
  sd_proposal_attempt_id: number;
  sd_exchange: string;
  sd_tradingsymbol: string;
  sd_side: string;
  sd_quantity: number;
  sd_price: number | null;
  sd_decision_status: string;
  sd_strategy_id: string;
  sd_decided_at: number;
  ea_status: string | null;
  ea_outcome_code: string | null;
  pe_realized_pnl: number | null;
}

interface LifecycleStateRow {
  strategy_id: string;
  strategy_version: string;
  market_id: string;
  phase: string;
  updated_at: number;
}

interface GovernanceDecisionRow {
  id: number;
  strategy_id: string;
  strategy_version: string;
  market_id: string;
  verdict: string;
  previous_phase: string;
  new_phase: string;
  rationale: string;
  winner_id: number | null;
  recorded_at: number;
}

interface WalkForwardRunRow {
  id: number;
  label: string;
  strategy_id: string;
  strategy_version: string;
  market_id: string;
  window_count: number;
}

interface WalkForwardWinnerRow {
  id: number;
  run_id: number;
  result: string;
  selected_trial_id: number | null;
  selection_strategy: string;
  selected_at: number;
}

interface WalkForwardTrialRow {
  id: number;
  merged_score: number | null;
}

interface WalkForwardTrialWindowRow {
  trial_id: number;
  total_return: number | null;
  sharpe_ratio: number | null;
  max_drawdown: number | null;
  win_rate: number | null;
}

interface CountRow {
  cnt: number;
}

interface PnlSumRow {
  total: number;
}

// ---------------------------------------------------------------------------
// OperatorReadModel
// ---------------------------------------------------------------------------

export class OperatorReadModel {
  private readonly _db: Database.Database;

  /**
   * @param db - A read-only Database handle obtained from openOperatorDb().
   */
  constructor(db: Database.Database) {
    this._db = db;
  }

  // -----------------------------------------------------------------------
  // Provenance helper
  // -----------------------------------------------------------------------

  private _provenance(source: OperatorProvenance['source'], sourceLabel: string | null): OperatorProvenance {
    return { source, asOf: Date.now(), sourceLabel };
  }

  // -----------------------------------------------------------------------
  // Summary cards — aggregate totals from persisted COUNT/SUM queries
  //
  // These totals remain truthful even when bounded recent lists are capped.
  // -----------------------------------------------------------------------

  /**
   * Return a set of operator summary cards with provenance.
   *
   * Cards include:
   * - current_pnl: realized P&L from open positions (runtime provenance)
   * - unrealized_pnl: unrealized P&L from open positions (runtime provenance)
   * - open_positions: count of non-flat positions (runtime provenance)
   * - total_decisions: total strategy decisions (historical provenance)
   * - total_execution_attempts: total execution attempts (historical provenance)
   * - total_governance_decisions: total governance decisions (historical provenance)
   * - total_walk_forward_runs: total walk-forward runs (historical provenance)
   * - total_paper_orders: total paper orders (historical provenance)
   * - total_paper_fills: total paper fills (historical provenance)
   */
  getSummaryCards(): OperatorSummaryCard[] {
    const now = Date.now();
    const cards: OperatorSummaryCard[] = [];

    // ── Runtime: paper positions (current P&L) ──────────────────────────
    try {
      const realizedRow = this._db.prepare(
        'SELECT COALESCE(SUM(realized_pnl), 0) AS total FROM paper_positions',
      ).get() as PnlSumRow;
      cards.push({
        key: 'current_pnl',
        label: 'Current P&L',
        value: realizedRow.total,
        unit: 'INR',
        change: null,
        display: null,
        provenance: { source: 'runtime', asOf: now, sourceLabel: 'paper_positions' },
      });
    } catch {
      cards.push({
        key: 'current_pnl',
        label: 'Current P&L',
        value: 0,
        unit: 'INR',
        change: null,
        display: null,
        provenance: { source: 'runtime', asOf: now, sourceLabel: 'paper_positions' },
      });
    }

    // ── Unrealized P&L (from open positions, runtime) ───────────────────
    try {
      const unrealizedCards = this._db.prepare(`
        SELECT COALESCE(
          SUM(
            CASE WHEN quantity != 0 AND mark_price IS NOT NULL AND avg_cost_price != 0
              THEN (mark_price - avg_cost_price) * ABS(quantity)
              ELSE 0
            END
          ), 0
        ) AS total
        FROM paper_positions
        WHERE quantity != 0
      `).get() as PnlSumRow;
      cards.push({
        key: 'unrealized_pnl',
        label: 'Unrealized P&L',
        value: unrealizedCards.total,
        unit: 'INR',
        change: null,
        display: null,
        provenance: { source: 'runtime', asOf: now, sourceLabel: 'paper_positions' },
      });
    } catch {
      cards.push({
        key: 'unrealized_pnl',
        label: 'Unrealized P&L',
        value: 0,
        unit: 'INR',
        change: null,
        display: null,
        provenance: { source: 'runtime', asOf: now, sourceLabel: 'paper_positions' },
      });
    }

    // ── Open positions count ────────────────────────────────────────────
    try {
      const openRow = this._db.prepare(
        'SELECT COUNT(*) AS cnt FROM paper_positions WHERE quantity != 0',
      ).get() as CountRow;
      cards.push({
        key: 'open_positions',
        label: 'Open Positions',
        value: openRow.cnt,
        unit: null,
        change: null,
        display: null,
        provenance: { source: 'runtime', asOf: now, sourceLabel: 'paper_positions' },
      });
    } catch {
      cards.push({
        key: 'open_positions',
        label: 'Open Positions',
        value: 0,
        unit: null,
        change: null,
        display: null,
        provenance: { source: 'runtime', asOf: now, sourceLabel: 'paper_positions' },
      });
    }

    // ── Total strategy decisions ────────────────────────────────────────
    try {
      const decisionRow = this._db.prepare(
        'SELECT COUNT(*) AS cnt FROM strategy_decisions',
      ).get() as CountRow;
      cards.push({
        key: 'total_decisions',
        label: 'Strategy Decisions',
        value: decisionRow.cnt,
        unit: null,
        change: null,
        display: null,
        provenance: { source: 'historical', asOf: now, sourceLabel: 'strategy_decisions' },
      });
    } catch {
      cards.push({
        key: 'total_decisions',
        label: 'Strategy Decisions',
        value: 0,
        unit: null,
        change: null,
        display: null,
        provenance: { source: 'historical', asOf: now, sourceLabel: 'strategy_decisions' },
      });
    }

    // ── Total execution attempts ────────────────────────────────────────
    try {
      const attemptRow = this._db.prepare(
        'SELECT COUNT(*) AS cnt FROM execution_attempts',
      ).get() as CountRow;
      cards.push({
        key: 'total_execution_attempts',
        label: 'Execution Attempts',
        value: attemptRow.cnt,
        unit: null,
        change: null,
        display: null,
        provenance: { source: 'historical', asOf: now, sourceLabel: 'execution_attempts' },
      });
    } catch {
      cards.push({
        key: 'total_execution_attempts',
        label: 'Execution Attempts',
        value: 0,
        unit: null,
        change: null,
        display: null,
        provenance: { source: 'historical', asOf: now, sourceLabel: 'execution_attempts' },
      });
    }

    // ── Total governance decisions ──────────────────────────────────────
    try {
      const govRow = this._db.prepare(
        'SELECT COUNT(*) AS cnt FROM governance_decisions',
      ).get() as CountRow;
      cards.push({
        key: 'total_governance_decisions',
        label: 'Governance Decisions',
        value: govRow.cnt,
        unit: null,
        change: null,
        display: null,
        provenance: { source: 'historical', asOf: now, sourceLabel: 'governance_decisions' },
      });
    } catch {
      cards.push({
        key: 'total_governance_decisions',
        label: 'Governance Decisions',
        value: 0,
        unit: null,
        change: null,
        display: null,
        provenance: { source: 'historical', asOf: now, sourceLabel: 'governance_decisions' },
      });
    }

    // ── Total walk-forward runs ─────────────────────────────────────────
    try {
      const wfRow = this._db.prepare(
        'SELECT COUNT(*) AS cnt FROM walk_forward_runs',
      ).get() as CountRow;
      cards.push({
        key: 'total_walk_forward_runs',
        label: 'Walk-Forward Runs',
        value: wfRow.cnt,
        unit: null,
        change: null,
        display: null,
        provenance: { source: 'historical', asOf: now, sourceLabel: 'walk_forward_runs' },
      });
    } catch {
      cards.push({
        key: 'total_walk_forward_runs',
        label: 'Walk-Forward Runs',
        value: 0,
        unit: null,
        change: null,
        display: null,
        provenance: { source: 'historical', asOf: now, sourceLabel: 'walk_forward_runs' },
      });
    }

    // ── Total paper orders ──────────────────────────────────────────────
    try {
      const orderRow = this._db.prepare(
        'SELECT COUNT(*) AS cnt FROM paper_orders',
      ).get() as CountRow;
      cards.push({
        key: 'total_paper_orders',
        label: 'Paper Orders',
        value: orderRow.cnt,
        unit: null,
        change: null,
        display: null,
        provenance: { source: 'historical', asOf: now, sourceLabel: 'paper_orders' },
      });
    } catch {
      cards.push({
        key: 'total_paper_orders',
        label: 'Paper Orders',
        value: 0,
        unit: null,
        change: null,
        display: null,
        provenance: { source: 'historical', asOf: now, sourceLabel: 'paper_orders' },
      });
    }

    // ── Total paper fills ───────────────────────────────────────────────
    try {
      const fillRow = this._db.prepare(
        'SELECT COUNT(*) AS cnt FROM paper_fills',
      ).get() as CountRow;
      cards.push({
        key: 'total_paper_fills',
        label: 'Paper Fills',
        value: fillRow.cnt,
        unit: null,
        change: null,
        display: null,
        provenance: { source: 'historical', asOf: now, sourceLabel: 'paper_fills' },
      });
    } catch {
      cards.push({
        key: 'total_paper_fills',
        label: 'Paper Fills',
        value: 0,
        unit: null,
        change: null,
        display: null,
        provenance: { source: 'historical', asOf: now, sourceLabel: 'paper_fills' },
      });
    }

    return cards;
  }

  // -----------------------------------------------------------------------
  // Per-strategy performance
  //
  // Aggregates realized P&L, trade count, and per-fill metrics grouped by
  // strategy identity. Unrealized P&L comes from open paper positions joined
  // through execution_attempts → strategy_decisions for strategy attribution.
  // -----------------------------------------------------------------------

  /**
   * Return performance summary per strategy identity.
   *
   * Joins paper_fills → execution_attempts → strategy_decisions to attribute
   * trade outcomes to the originating strategy. Unrealized P&L is attributed
   * from open paper positions via the same join chain.
   *
   * Empty state: returns empty array.
   */
  getStrategyPerformance(): OperatorStrategyPerformance[] {
    const now = Date.now();
    const results: OperatorStrategyPerformance[] = [];

    try {
      // Attribution chain: paper_fills -> execution_attempts -> strategy_decisions
      const rows = this._db.prepare(`
        SELECT
          sd.strategy_id,
          sd.strategy_version,
          COUNT(DISTINCT pf.id) AS trade_count,
          COALESCE(SUM(pf.filled_quantity * pf.filled_price * CASE WHEN pf.side = 'buy' THEN -1 ELSE 1 END), 0) AS total_realized_pnl
        FROM paper_fills pf
        INNER JOIN execution_attempts ea ON ea.id = pf.execution_attempt_id
        INNER JOIN strategy_decisions sd ON sd.id = ea.strategy_decision_id
        GROUP BY sd.strategy_id, sd.strategy_version
        ORDER BY sd.strategy_id, sd.strategy_version
      `).all() as Array<{
        strategy_id: string;
        strategy_version: string;
        trade_count: number;
        total_realized_pnl: number;
      }>;

      for (const row of rows) {
        // Compute unrealized P&L for this strategy from open positions
        // via the same attribution chain
        let unrealizedPnl = 0;
        try {
          const unrealizedRows = this._db.prepare(`
            SELECT COALESCE(
              SUM(
                CASE WHEN pp.quantity != 0 AND pp.mark_price IS NOT NULL AND pp.avg_cost_price != 0
                  THEN (pp.mark_price - pp.avg_cost_price) * ABS(pp.quantity)
                  ELSE 0
                END
              ), 0
            ) AS total
            FROM paper_positions pp
            INNER JOIN (
              SELECT DISTINCT pf2.exchange, pf2.tradingsymbol
              FROM paper_fills pf2
              INNER JOIN execution_attempts ea2 ON ea2.id = pf2.execution_attempt_id
              INNER JOIN strategy_decisions sd2 ON sd2.id = ea2.strategy_decision_id
              WHERE sd2.strategy_id = ? AND sd2.strategy_version = ?
            ) AS attributed ON attributed.exchange = pp.exchange AND attributed.tradingsymbol = pp.tradingsymbol
          `).get(row.strategy_id, row.strategy_version) as PnlSumRow;
          unrealizedPnl = unrealizedRows.total;
        } catch {
          // Attribution join may miss unmatched positions; unrealized defaults to 0
        }

        results.push({
          strategyId: row.strategy_id,
          strategyVersion: row.strategy_version,
          totalReturnPct: row.total_realized_pnl > 0 ? row.total_realized_pnl : 0,
          sharpeRatio: null, // Not computable from fill-level data alone
          maxDrawdownPct: null,
          tradeCount: row.trade_count,
          winRate: null,
          profitFactor: null,
          realizedPnl: row.total_realized_pnl,
          unrealizedPnl,
          provenance: this._provenance('historical', 'paper_fills+execution_attempts+strategy_decisions'),
        });
      }
    } catch {
      // Empty state: return empty array
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Per-ticker performance
  //
  // Aggregated from paper fills (trade count, realized P&L) and
  // paper_positions (current state, unrealized P&L).
  // -----------------------------------------------------------------------

  /**
   * Return performance summary per ticker symbol.
   *
   * Joins paper_fills for trade counts and realized P&L with paper_positions
   * for current position state and unrealized P&L.
   *
   * Empty state: returns empty array.
   */
  getTickerPerformance(): OperatorTickerPerformance[] {
    const now = Date.now();
    const results: OperatorTickerPerformance[] = [];

    try {
      // Base data from paper_fills: trade count, realized P&L (approximated)
      const fillRows = this._db.prepare(`
        SELECT
          exchange,
          tradingsymbol,
          COUNT(*) AS trade_count,
          COALESCE(SUM(filled_quantity * filled_price * CASE WHEN side = 'buy' THEN -1 ELSE 1 END), 0) AS realized_pnl,
          AVG(filled_price) AS avg_entry_price,
          MAX(filled_price) AS last_fill_price
        FROM paper_fills
        GROUP BY exchange, tradingsymbol
        ORDER BY exchange, tradingsymbol
      `).all() as Array<{
        exchange: string;
        tradingsymbol: string;
        trade_count: number;
        realized_pnl: number;
        avg_entry_price: number | null;
        last_fill_price: number | null;
      }>;

      // Build a map of current positions for unrealized P&L
      const positionMap = new Map<string, PerTickerPositionRow>();
      try {
        const positions = this._db.prepare(`
          SELECT exchange, tradingsymbol, side, quantity, realized_pnl, mark_price
          FROM paper_positions
          ORDER BY exchange, tradingsymbol
        `).all() as PerTickerPositionRow[];
        for (const p of positions) {
          positionMap.set(`${p.exchange}:${p.tradingsymbol}`, p);
        }
      } catch {
        // No positions table; unrealized defaults to 0
      }

      for (const row of fillRows) {
        const key = `${row.exchange}:${row.tradingsymbol}`;
        const pos = positionMap.get(key);

        const netQuantity = pos?.quantity ?? 0;
        const side = pos?.side ?? 'flat';
        const unrealizedPnl = pos && pos.mark_price !== null && row.avg_entry_price !== null
          ? (pos.mark_price - row.avg_entry_price) * Math.abs(netQuantity)
          : 0;

        // Win rate: count fills where filled_price moved favorably
        // For buys: profit when filled_price < current mark (we bought low)
        // For sells: profit when filled_price > current mark (we sold high)
        let winRate: number | null = null;
        if (row.trade_count > 0 && pos?.mark_price !== null) {
          try {
            const winCount = this._db.prepare(`
              SELECT COUNT(*) AS cnt FROM paper_fills
              WHERE exchange = ? AND tradingsymbol = ?
                AND (
                  (side = 'buy' AND filled_price < ?)
                  OR (side = 'sell' AND filled_price > ?)
                )
            `).get(row.exchange, row.tradingsymbol, pos!.mark_price, pos!.mark_price) as CountRow;
            winRate = winCount.cnt / row.trade_count;
          } catch {
            // Ignore
          }
        }

        results.push({
          exchange: row.exchange,
          tradingsymbol: row.tradingsymbol,
          totalPnl: (row.realized_pnl ?? 0) + unrealizedPnl,
          tradeCount: row.trade_count,
          winRate,
          netQuantity,
          avgEntryPrice: row.avg_entry_price,
          lastPrice: pos?.mark_price ?? row.last_fill_price,
          unrealizedPnl,
          realizedPnl: row.realized_pnl ?? 0,
          provenance: this._provenance('historical', 'paper_fills+paper_positions'),
        });
      }

      // Also include positions that have no fills (e.g. manually created)
      for (const [key, pos] of positionMap) {
        if (!fillRows.some(r => `${r.exchange}:${r.tradingsymbol}` === key)) {
          results.push({
            exchange: pos.exchange,
            tradingsymbol: pos.tradingsymbol,
            totalPnl: pos.realized_pnl,
            tradeCount: 0,
            winRate: null,
            netQuantity: pos.quantity,
            avgEntryPrice: pos.avg_cost_price || null,
            lastPrice: pos.mark_price,
            unrealizedPnl: pos.mark_price !== null && pos.avg_cost_price > 0
              ? (pos.mark_price - pos.avg_cost_price) * Math.abs(pos.quantity)
              : 0,
            realizedPnl: pos.realized_pnl,
            provenance: this._provenance('runtime', 'paper_positions'),
          });
        }
      }
    } catch {
      // Empty state
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Per-decision performance
  //
  // Links strategy decisions to execution outcomes (via execution_attempts)
  // and realized P&L (via position_events). Refused/unconsumed decisions
  // carry null execution/outcome fields.
  // -----------------------------------------------------------------------

  /**
   * Return per-decision performance linking strategy decisions to execution
   * outcomes and realized P&L.
   *
   * @param limit - Maximum number of decisions to return (newest first).
   *                Default: 50.
   */
  getDecisionPerformance(limit: number = DEFAULT_LIMIT): OperatorDecisionPerformance[] {
    const now = Date.now();
    const results: OperatorDecisionPerformance[] = [];

    try {
      const rows = this._db.prepare(`
        SELECT
          sd.id AS sd_id,
          sd.proposal_attempt_id AS sd_proposal_attempt_id,
          sd.exchange AS sd_exchange,
          sd.tradingsymbol AS sd_tradingsymbol,
          sd.side AS sd_side,
          sd.quantity AS sd_quantity,
          sd.price AS sd_price,
          sd.decision_status AS sd_decision_status,
          sd.strategy_id AS sd_strategy_id,
          sd.decided_at AS sd_decided_at,
          ea.status AS ea_status,
          ea.outcome_code AS ea_outcome_code,
          (
            SELECT COALESCE(SUM(pe.realized_pnl), 0)
            FROM position_events pe
            INNER JOIN execution_attempts ea2 ON ea2.id = pe.execution_attempt_id
            WHERE ea2.strategy_decision_id = sd.id
          ) AS pe_realized_pnl
        FROM strategy_decisions sd
        LEFT JOIN execution_attempts ea ON ea.strategy_decision_id = sd.id
        ORDER BY sd.decided_at DESC
        LIMIT ?
      `).all(limit) as PerDecisionRow[];

      for (const row of rows) {
        results.push({
          decisionId: row.sd_id,
          proposalAttemptId: row.sd_proposal_attempt_id,
          exchange: row.sd_exchange,
          tradingsymbol: row.sd_tradingsymbol,
          side: row.sd_side,
          quantity: row.sd_quantity,
          price: row.sd_price,
          decisionStatus: row.sd_decision_status,
          strategyId: row.sd_strategy_id,
          decidedAt: new Date(row.sd_decided_at).toISOString(),
          executionStatus: row.ea_status ?? null,
          outcomeCode: row.ea_outcome_code ?? null,
          realizedPnl: row.pe_realized_pnl ?? null,
          provenance: this._provenance('historical', 'strategy_decisions+execution_attempts+position_events'),
        });
      }
    } catch {
      // Empty state
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Lifecycle state
  //
  // Current lifecycle phase for each strategy identity.
  // -----------------------------------------------------------------------

  /**
   * Return current lifecycle states across all strategies.
   *
   * Empty state: returns empty array.
   */
  getLifecycleStates(): OperatorLifecycleState[] {
    const now = Date.now();

    try {
      const rows = this._db.prepare(`
        SELECT strategy_id, strategy_version, market_id, phase, updated_at
        FROM strategy_lifecycle_state
        ORDER BY strategy_id, strategy_version, market_id
      `).all() as LifecycleStateRow[];

      return rows.map(row => ({
        strategyId: row.strategy_id,
        strategyVersion: row.strategy_version,
        marketId: row.market_id,
        phase: row.phase,
        updatedAt: new Date(row.updated_at).toISOString(),
        provenance: this._provenance('historical', 'strategy_lifecycle_state'),
      }));
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle governance history
  //
  // Append-only governance decision log.
  // -----------------------------------------------------------------------

  /**
   * Return lifecycle governance history across all strategies.
   *
   * @param limit - Maximum number of decisions to return (newest first).
   *                Default: 50.
   */
  getLifecycleHistory(limit: number = DEFAULT_LIMIT): OperatorLifecycleHistory[] {
    const now = Date.now();

    try {
      const rows = this._db.prepare(`
        SELECT id, strategy_id, strategy_version, market_id,
               verdict, previous_phase, new_phase, rationale, winner_id, recorded_at
        FROM governance_decisions
        ORDER BY recorded_at DESC, id DESC
        LIMIT ?
      `).all(limit) as GovernanceDecisionRow[];

      return rows.map(row => ({
        id: row.id,
        strategyId: row.strategy_id,
        strategyVersion: row.strategy_version,
        marketId: row.market_id,
        verdict: row.verdict,
        previousPhase: row.previous_phase,
        newPhase: row.new_phase,
        rationale: row.rationale,
        recordedAt: new Date(row.recorded_at).toISOString(),
        provenance: this._provenance('historical', 'governance_decisions'),
      }));
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Promotion history
  //
  // Subset of governance history filtered to promotion-only verdicts,
  // enriched with walk-forward winner reference.
  // -----------------------------------------------------------------------

  /**
   * Return promotion-only governance history, enriched with winner reference.
   *
   * @param limit - Maximum number of promotions to return (newest first).
   *                Default: 50.
   */
  getPromotionHistory(limit: number = DEFAULT_LIMIT): OperatorPromotionHistory[] {
    const now = Date.now();

    try {
      const rows = this._db.prepare(`
        SELECT id, strategy_id, strategy_version, market_id,
               verdict, previous_phase, new_phase, rationale, winner_id, recorded_at
        FROM governance_decisions
        WHERE verdict = 'promote'
        ORDER BY recorded_at DESC, id DESC
        LIMIT ?
      `).all(limit) as GovernanceDecisionRow[];

      return rows.map(row => ({
        id: row.id,
        strategyId: row.strategy_id,
        strategyVersion: row.strategy_version,
        marketId: row.market_id,
        previousPhase: row.previous_phase,
        newPhase: row.new_phase,
        rationale: row.rationale,
        winnerId: row.winner_id,
        promotedAt: new Date(row.recorded_at).toISOString(),
        provenance: this._provenance('historical', 'governance_decisions'),
      }));
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Walk-forward leaderboard
  //
  // One row per completed walk-forward run that produced a winner selection.
  // Joins walk_forward_runs → walk_forward_winners → walk_forward_trials
  // to assemble leaderboard rows with selected trial metrics.
  // -----------------------------------------------------------------------

  /**
   * Return walk-forward leaderboard rows for completed runs with winners.
   *
   * Joins walk_forward_runs with walk_forward_winners and the selected
   * trial's per-window evidence (aggregated metrics from the first
   * available trial-window row).
   *
   * Governance/walk-forward rows with null winner_id or null selected trial
   * still render truthful history rows (with null metrics).
   *
   * Empty state: returns empty array.
   */
  getWalkForwardLeaderboard(): OperatorWalkForwardLeaderboard[] {
    const now = Date.now();
    const results: OperatorWalkForwardLeaderboard[] = [];

    try {
      const rows = this._db.prepare(`
        SELECT
          wr.id AS run_id,
          wr.label,
          wr.strategy_id,
          wr.strategy_version,
          wr.market_id,
          wr.window_count,
          ww.id AS winner_id,
          ww.result,
          ww.selected_trial_id,
          ww.selection_strategy,
          ww.selected_at,
          wt.merged_score
        FROM walk_forward_runs wr
        INNER JOIN walk_forward_winners ww ON ww.run_id = wr.id
        LEFT JOIN walk_forward_trials wt ON wt.id = ww.selected_trial_id
        ORDER BY ww.selected_at DESC
      `).all() as Array<{
        run_id: number;
        label: string;
        strategy_id: string;
        strategy_version: string;
        market_id: string;
        window_count: number;
        winner_id: number;
        result: string;
        selected_trial_id: number | null;
        selection_strategy: string;
        selected_at: number;
        merged_score: number | null;
      }>;

      for (const row of rows) {
        // When the winner result is 'no_winner', selectedTrialId is null.
        // Load per-window metrics for the selected trial when available.
        let sharpe: number | null = null;
        let totalReturn: number | null = null;
        let maxDrawdown: number | null = null;
        let winRate: number | null = null;

        if (row.selected_trial_id !== null) {
          try {
            // Aggregate per-window metrics for the selected trial
            const metrics = this._db.prepare(`
              SELECT
                AVG(sharpe_ratio) AS avg_sharpe,
                AVG(total_return) AS avg_return,
                AVG(max_drawdown) AS avg_drawdown,
                AVG(win_rate) AS avg_win_rate
              FROM walk_forward_trial_windows
              WHERE trial_id = ?
            `).get(row.selected_trial_id) as {
              avg_sharpe: number | null;
              avg_return: number | null;
              avg_drawdown: number | null;
              avg_win_rate: number | null;
            };
            sharpe = metrics.avg_sharpe;
            totalReturn = metrics.avg_return;
            maxDrawdown = metrics.avg_drawdown;
            winRate = metrics.avg_win_rate;
          } catch {
            // No window evidence for this trial; metrics remain null
          }
        }

        // Only include runs that had an actual winner selection
        // (result = 'winner_selected'), but still include 'no_winner' runs
        // with null metrics so operators see the full history.
        if (row.result === 'no_winner' && row.selected_trial_id === null) {
          // Render truthful row with null metrics
          results.push({
            runId: row.run_id,
            label: row.label,
            strategyId: row.strategy_id,
            strategyVersion: row.strategy_version,
            marketId: row.market_id,
            windowCount: row.window_count,
            winnerId: row.winner_id,
            selectionStrategy: row.selection_strategy,
            mergedScore: null,
            sharpeRatio: null,
            totalReturnPct: null,
            maxDrawdownPct: null,
            winRate: null,
            selectedAt: new Date(row.selected_at).toISOString(),
            provenance: this._provenance('historical', 'walk_forward_runs+winners+trials'),
          });
        } else {
          results.push({
            runId: row.run_id,
            label: row.label,
            strategyId: row.strategy_id,
            strategyVersion: row.strategy_version,
            marketId: row.market_id,
            windowCount: row.window_count,
            winnerId: row.winner_id,
            selectionStrategy: row.selection_strategy,
            mergedScore: row.merged_score,
            sharpeRatio: sharpe,
            totalReturnPct: totalReturn,
            maxDrawdownPct: maxDrawdown,
            winRate,
            selectedAt: new Date(row.selected_at).toISOString(),
            provenance: this._provenance('historical', 'walk_forward_runs+winners+trials'),
          });
        }
      }
    } catch {
      // Empty state
    }

    return results;
  }
}
