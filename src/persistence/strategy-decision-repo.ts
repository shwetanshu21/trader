import type Database from 'better-sqlite3';
import {
  ProposalStatus,
  StrategyDecisionStatus,
  StrategyDecisionReasonCode,
  type NewStrategyDecision,
  type StrategyApprovedCandidate,
  type StrategyDecisionReason,
  type StrategyDecisionRow,
  type StrategyRefusal,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// StrategyDecisionRepository — typed CRUD over strategy_decision tables.
//
// One row per source proposal attempt (UNIQUE constraint enforced by schema).
// Carries deterministic strategy-approved fields that override raw proposal values.
// Reasons are stored in a separate ordered table for auditability.
// ---------------------------------------------------------------------------

export class StrategyDecisionRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  /**
   * Insert a strategy decision row.
   * If a row for the same `proposal_attempt_id` already exists, the INSERT fails
   * (UNIQUE constraint) — decisions are append-only per proposal.
   */
  insertDecision(decision: NewStrategyDecision): StrategyDecisionRow {
    const stmt = this._db.prepare(`
      INSERT INTO strategy_decisions
        (proposal_attempt_id, decision_status, strategy_id, strategy_version, decided_at,
         exchange, tradingsymbol, side, product, quantity, price, trigger_price, order_type,
         quote_last_price, quote_bid, quote_ask, quote_volume, quote_received_at,
         risk_notional, risk_sizing_basis, risk_max_loss_rupees, risk_stop_distance, risk_exposure_tag,
         india_research_evidence,
         execution_class, segment, instrument_type, expiry, strike, lot_size, tick_size, freeze_quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      decision.proposalAttemptId,
      decision.decisionStatus,
      decision.strategyId,
      decision.strategyVersion,
      decision.decidedAt,
      decision.exchange,
      decision.tradingsymbol,
      decision.side,
      decision.product,
      decision.quantity,
      decision.price,
      decision.triggerPrice,
      decision.orderType,
      decision.quoteLastPrice,
      decision.quoteBid,
      decision.quoteAsk,
      decision.quoteVolume,
      decision.quoteReceivedAt,
      decision.riskNotional,
      decision.riskSizingBasis,
      decision.riskMaxLossRupees,
      decision.riskStopDistance,
      decision.riskExposureTag,
      decision.indiaResearchEvidence ? JSON.stringify(decision.indiaResearchEvidence) : null,
      decision.executionClass,
      decision.segment,
      decision.instrumentType,
      decision.expiry,
      decision.strike,
      decision.lotSize,
      decision.tickSize,
      decision.freezeQuantity,
    );

    return {
      id: Number(result.lastInsertRowid),
      proposalAttemptId: decision.proposalAttemptId,
      decisionStatus: decision.decisionStatus,
      strategyId: decision.strategyId,
      strategyVersion: decision.strategyVersion,
      decidedAt: decision.decidedAt,
      exchange: decision.exchange,
      tradingsymbol: decision.tradingsymbol,
      side: decision.side,
      product: decision.product,
      quantity: decision.quantity,
      price: decision.price,
      triggerPrice: decision.triggerPrice,
      orderType: decision.orderType,
      quoteLastPrice: decision.quoteLastPrice,
      quoteBid: decision.quoteBid,
      quoteAsk: decision.quoteAsk,
      quoteVolume: decision.quoteVolume,
      quoteReceivedAt: decision.quoteReceivedAt,
      riskNotional: decision.riskNotional,
      riskSizingBasis: decision.riskSizingBasis,
      riskMaxLossRupees: decision.riskMaxLossRupees,
      riskStopDistance: decision.riskStopDistance,
      riskExposureTag: decision.riskExposureTag,
      indiaResearchEvidence: decision.indiaResearchEvidence,
      executionClass: decision.executionClass,
      segment: decision.segment,
      instrumentType: decision.instrumentType,
      expiry: decision.expiry,
      strike: decision.strike,
      lotSize: decision.lotSize,
      tickSize: decision.tickSize,
      freezeQuantity: decision.freezeQuantity,
    };
  }

  /**
   * Insert a strategy decision reason linked to a decision row.
   */
  insertReason(strategyDecisionId: number, reason: StrategyDecisionReason): void {
    this._db.prepare(`
      INSERT INTO strategy_decision_reasons (strategy_decision_id, reason_code, reason_message)
      VALUES (?, ?, ?)
    `).run(strategyDecisionId, reason.reasonCode, reason.reasonMessage);
  }

  /**
   * Insert a strategy decision together with its reasons in a single transaction.
   * Returns the full decision row including the assigned id.
   */
  insertDecisionWithReasons(
    decision: NewStrategyDecision,
    reasons: StrategyDecisionReason[],
  ): StrategyDecisionRow {
    const tx = this._db.transaction(() => {
      const row = this.insertDecision(decision);
      for (const reason of reasons) {
        this.insertReason(row.id, reason);
      }
      return row;
    });

    return tx();
  }

  /**
   * Retrieve a strategy decision by id, with its reasons.
   */
  getDecisionById(id: number): StrategyDecisionRow | null {
    const row = this._db.prepare(`
      SELECT * FROM strategy_decisions WHERE id = ?
    `).get(id) as StrategyDecisionDbRow | undefined;

    if (!row) return null;
    return mapDecisionRow(row);
  }

  /**
   * Retrieve a strategy decision by source proposal attempt id.
   */
  getDecisionByProposalAttemptId(proposalAttemptId: number): StrategyDecisionRow | null {
    const row = this._db.prepare(`
      SELECT * FROM strategy_decisions WHERE proposal_attempt_id = ?
    `).get(proposalAttemptId) as StrategyDecisionDbRow | undefined;

    if (!row) return null;
    return mapDecisionRow(row);
  }

  /**
   * Load reasons for a given strategy decision id, ordered by insertion.
   */
  getReasonsForDecision(strategyDecisionId: number): StrategyDecisionReason[] {
    const rows = this._db.prepare(`
      SELECT reason_code, reason_message
      FROM strategy_decision_reasons
      WHERE strategy_decision_id = ?
      ORDER BY id
    `).all(strategyDecisionId) as Array<{ reason_code: string; reason_message: string }>;

    return rows.map(r => ({
      reasonCode: r.reason_code as StrategyDecisionReasonCode,
      reasonMessage: r.reason_message,
    }));
  }

  /**
   * Retrieve recent strategy decisions, newest first.
   * Optionally filter by decision status.
   */
  getRecentDecisions(limit = 50, status?: StrategyDecisionStatus): StrategyDecisionRow[] {
    let sql: string;
    let params: unknown[];

    if (status !== undefined) {
      sql = 'SELECT * FROM strategy_decisions WHERE decision_status = ? ORDER BY decided_at DESC LIMIT ?';
      params = [status, limit];
    } else {
      sql = 'SELECT * FROM strategy_decisions ORDER BY decided_at DESC LIMIT ?';
      params = [limit];
    }

    const rows = this._db.prepare(sql).all(...params) as StrategyDecisionDbRow[];
    return rows.map(mapDecisionRow);
  }

  /**
   * Retrieve approved strategy decisions that have not yet been consumed by execution.
   *
   * Joins strategy_decisions with execution_attempts, returning only approved
   * decisions that have no corresponding execution attempt row.
   *
   * This is the canonical consumption seam for S03 — once a strategy decision
   * has an execution attempt, it will not appear here.
   */
  getApprovedUnconsumedCandidates(limit = 100): StrategyApprovedCandidate[] {
    const rows = this._db.prepare(`
      SELECT sd.* FROM strategy_decisions sd
      LEFT JOIN execution_attempts ea ON ea.strategy_decision_id = sd.id
      WHERE sd.decision_status = ?
        AND ea.id IS NULL
      ORDER BY sd.decided_at ASC
      LIMIT ?
    `).all(StrategyDecisionStatus.Approved, limit) as StrategyDecisionDbRow[];

    return rows.map(r => ({
      id: r.id,
      proposalAttemptId: r.proposal_attempt_id,
      strategyId: r.strategy_id,
      strategyVersion: r.strategy_version,
      decidedAt: r.decided_at,
      exchange: r.exchange,
      tradingsymbol: r.tradingsymbol,
      side: r.side,
      product: r.product,
      quantity: r.quantity,
      price: r.price,
      triggerPrice: r.trigger_price,
      orderType: r.order_type,
      lastPrice: r.quote_last_price,
      bid: r.quote_bid,
      ask: r.quote_ask,
      notional: r.risk_notional,
      sizingBasis: r.risk_sizing_basis,
      executionClass: r.execution_class as any,
      segment: r.segment,
      instrumentType: r.instrument_type,
      expiry: r.expiry,
      strike: r.strike,
      lotSize: r.lot_size,
      tickSize: r.tick_size,
      freezeQuantity: r.freeze_quantity,
    }));
  }

  /**
   * Retrieve recent refusals with their ordered reasons, newest first.
   */
  getRecentRefusals(limit = 20): StrategyRefusal[] {
    const rows = this._db.prepare(`
      SELECT id, proposal_attempt_id, decided_at
      FROM strategy_decisions
      WHERE decision_status = ?
      ORDER BY decided_at DESC
      LIMIT ?
    `).all(StrategyDecisionStatus.Refused, limit) as Array<{
      id: number;
      proposal_attempt_id: number;
      decided_at: number;
    }>;

    return rows.map(row => {
      const reasons = this._db.prepare(`
        SELECT reason_code, reason_message
        FROM strategy_decision_reasons
        WHERE strategy_decision_id = ?
        ORDER BY id
      `).all(row.id) as Array<{ reason_code: string; reason_message: string }>;

      return {
        id: row.id,
        proposalAttemptId: row.proposal_attempt_id,
        decidedAt: row.decided_at,
        reasons: reasons.map(r => ({
          reasonCode: r.reason_code as StrategyDecisionReasonCode,
          reasonMessage: r.reason_message,
        })),
      };
    });
  }

  // -----------------------------------------------------------------------
  // Count methods
  // -----------------------------------------------------------------------

  /** Count total strategy decision rows. */
  countDecisions(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM strategy_decisions').get() as { cnt: number };
    return row.cnt;
  }

  /** Count total strategy decision reasons. */
  countReasons(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM strategy_decision_reasons').get() as { cnt: number };
    return row.cnt;
  }

  /** Count decisions by status. */
  countByStatus(status: StrategyDecisionStatus): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM strategy_decisions WHERE decision_status = ?',
    ).get(status) as { cnt: number };
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Cross-cutting — accepted proposals without strategy decisions
  // -----------------------------------------------------------------------

  /**
   * Retrieve accepted proposal attempts that do NOT yet have a strategy decision.
   *
   * Uses a LEFT JOIN with IS NULL check to find accepted proposals without
   * a matching strategy decision row. This is the primary query the
   * StrategyRiskSupervisor uses each tick.
   */
  getAcceptedProposalsWithoutDecisions(limit = 100): Array<{
    proposalAttemptId: number;
    exchange: string;
    tradingsymbol: string;
    instrumentToken: number | null;
    side: string;
    product: string;
    quantity: number;
    price: number | null;
    triggerPrice: number | null;
    orderType: string;
    createdAt: number;
  }> {
    const rows = this._db.prepare(`
      SELECT
        pa.id AS proposal_attempt_id,
        pa.exchange,
        pa.tradingsymbol,
        pa.instrument_token AS instrument_token,
        pa.side,
        pa.product,
        pa.quantity,
        pa.price,
        pa.trigger_price AS trigger_price,
        pa.order_type AS order_type,
        pa.created_at AS created_at
      FROM proposal_attempts pa
      LEFT JOIN strategy_decisions sd
        ON sd.proposal_attempt_id = pa.id
      WHERE pa.proposal_status = ?
        AND sd.id IS NULL
      ORDER BY pa.created_at ASC
      LIMIT ?
    `).all(ProposalStatus.Accepted, limit) as Array<{
      proposal_attempt_id: number;
      exchange: string;
      tradingsymbol: string;
      instrument_token: number | null;
      side: string;
      product: string;
      quantity: number;
      price: number | null;
      trigger_price: number | null;
      order_type: string;
      created_at: number;
    }>;

    return rows.map(r => ({
      proposalAttemptId: r.proposal_attempt_id,
      exchange: r.exchange,
      tradingsymbol: r.tradingsymbol,
      instrumentToken: r.instrument_token,
      side: r.side,
      product: r.product,
      quantity: r.quantity,
      price: r.price,
      triggerPrice: r.trigger_price,
      orderType: r.order_type,
      createdAt: r.created_at,
    }));
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface StrategyDecisionDbRow {
  id: number;
  proposal_attempt_id: number;
  decision_status: string;
  strategy_id: string;
  strategy_version: string;
  decided_at: number;
  exchange: string;
  tradingsymbol: string;
  side: string;
  product: string;
  quantity: number;
  price: number | null;
  trigger_price: number | null;
  order_type: string;
  quote_last_price: number | null;
  quote_bid: number | null;
  quote_ask: number | null;
  quote_volume: number | null;
  quote_received_at: number | null;
  risk_notional: number | null;
  risk_sizing_basis: string;
  risk_max_loss_rupees: number | null;
  risk_stop_distance: number | null;
  risk_exposure_tag: string | null;
  india_research_evidence: string | null;
  execution_class: string;
  segment: string;
  instrument_type: string;
  expiry: string | null;
  strike: number | null;
  lot_size: number;
  tick_size: number;
  freeze_quantity: number | null;
}

function mapDecisionRow(row: StrategyDecisionDbRow): StrategyDecisionRow {
  return {
    id: row.id,
    proposalAttemptId: row.proposal_attempt_id,
    decisionStatus: row.decision_status as StrategyDecisionStatus,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    decidedAt: row.decided_at,
    exchange: row.exchange,
    tradingsymbol: row.tradingsymbol,
    side: row.side,
    product: row.product,
    quantity: row.quantity,
    price: row.price,
    triggerPrice: row.trigger_price,
    orderType: row.order_type,
    quoteLastPrice: row.quote_last_price,
    quoteBid: row.quote_bid,
    quoteAsk: row.quote_ask,
    quoteVolume: row.quote_volume,
    quoteReceivedAt: row.quote_received_at,
    riskNotional: row.risk_notional,
    riskSizingBasis: row.risk_sizing_basis,
    riskMaxLossRupees: row.risk_max_loss_rupees,
    riskStopDistance: row.risk_stop_distance,
    riskExposureTag: row.risk_exposure_tag,
    indiaResearchEvidence: row.india_research_evidence
      ? JSON.parse(row.india_research_evidence)
      : null,
    executionClass: row.execution_class as any,
    segment: row.segment,
    instrumentType: row.instrument_type,
    expiry: row.expiry,
    strike: row.strike,
    lotSize: row.lot_size,
    tickSize: row.tick_size,
    freezeQuantity: row.freeze_quantity,
  };
}
