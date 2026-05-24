// ── OperatorReadModel tests ──
//
// Proves the operator read model returns truthful aggregate totals from
// persisted COUNT/SUM/GROUP BY queries, not from bounded recent lists.
//
// Uses in-memory SQLite databases with deterministic test fixtures so
// every test is isolated and reproducible.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { OperatorReadModel } from '../src/operator/operator-read-model.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an in-memory SQLite database with all tables the read model queries. */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');

  // ── Strategy decisions ────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE strategy_decisions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_attempt_id   INTEGER NOT NULL UNIQUE,
      decision_status       TEXT NOT NULL,
      strategy_id           TEXT NOT NULL,
      strategy_version      TEXT NOT NULL,
      decided_at            INTEGER NOT NULL,
      exchange              TEXT NOT NULL,
      tradingsymbol         TEXT NOT NULL,
      side                  TEXT NOT NULL,
      product               TEXT NOT NULL DEFAULT 'MIS',
      quantity              INTEGER NOT NULL,
      price                 REAL,
      trigger_price         REAL,
      order_type            TEXT NOT NULL DEFAULT 'MARKET',
      quote_last_price      REAL,
      quote_bid             REAL,
      quote_ask             REAL,
      quote_volume          INTEGER,
      quote_received_at     INTEGER,
      risk_notional         REAL,
      risk_sizing_basis     TEXT NOT NULL DEFAULT 'last_price',
      risk_max_loss_rupees  REAL,
      risk_stop_distance    REAL,
      risk_stop_price       REAL,
      risk_trailing_stop_distance REAL,
      risk_budget_rupees    REAL,
      risk_exposure_tag     TEXT,
      india_research_evidence TEXT,
      execution_class       TEXT NOT NULL DEFAULT 'EQ',
      segment               TEXT NOT NULL DEFAULT 'NSE',
      instrument_type       TEXT NOT NULL DEFAULT 'EQ',
      expiry                TEXT,
      strike                REAL,
      lot_size              INTEGER NOT NULL DEFAULT 1,
      tick_size             REAL NOT NULL DEFAULT 0.05,
      freeze_quantity       INTEGER
    )
  `);

  // ── Strategy decision reasons ─────────────────────────────────────────
  db.exec(`
    CREATE TABLE strategy_decision_reasons (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_decision_id  INTEGER NOT NULL,
      reason_code           TEXT NOT NULL,
      reason_message        TEXT NOT NULL,
      FOREIGN KEY (strategy_decision_id) REFERENCES strategy_decisions(id)
    )
  `);

  // ── Execution attempts ────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE execution_attempts (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_decision_id  INTEGER NOT NULL UNIQUE,
      execution_mode        TEXT NOT NULL,
      status                TEXT NOT NULL,
      outcome_code          TEXT,
      broker_order_id       TEXT,
      message               TEXT NOT NULL,
      attempted_at          INTEGER NOT NULL,
      completed_at          INTEGER,
      FOREIGN KEY (strategy_decision_id) REFERENCES strategy_decisions(id)
    )
  `);

  // ── Paper orders ──────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE paper_orders (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_attempt_id  INTEGER NOT NULL UNIQUE,
      exchange              TEXT NOT NULL,
      tradingsymbol         TEXT NOT NULL,
      side                  TEXT NOT NULL,
      product               TEXT NOT NULL,
      quantity              INTEGER NOT NULL,
      price                 REAL,
      trigger_price         REAL,
      order_type            TEXT NOT NULL,
      tag                   TEXT,
      status                TEXT NOT NULL,
      broker_order_id       TEXT NOT NULL,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER
    )
  `);

  // ── Paper fills ───────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE paper_fills (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_order_id        INTEGER NOT NULL,
      execution_attempt_id  INTEGER NOT NULL UNIQUE,
      exchange              TEXT NOT NULL,
      tradingsymbol         TEXT NOT NULL,
      side                  TEXT NOT NULL,
      product               TEXT NOT NULL,
      filled_quantity       INTEGER NOT NULL,
      filled_price          REAL NOT NULL,
      broker_order_id       TEXT NOT NULL,
      filled_at             INTEGER NOT NULL
    )
  `);

  // ── Paper positions ───────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE paper_positions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange              TEXT NOT NULL,
      tradingsymbol         TEXT NOT NULL,
      product               TEXT NOT NULL,
      side                  TEXT NOT NULL,
      quantity              INTEGER NOT NULL,
      avg_cost_price        REAL NOT NULL,
      realized_pnl          REAL NOT NULL DEFAULT 0,
      stop_price            REAL,
      trailing_anchor_price REAL,
      trailing_stop_distance REAL,
      mark_price            REAL,
      marked_at             INTEGER,
      updated_at            INTEGER NOT NULL,
      UNIQUE(exchange, tradingsymbol, product)
    )
  `);

  // ── Position events ───────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE position_events (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_order_id        INTEGER NOT NULL,
      paper_fill_id         INTEGER,
      execution_attempt_id  INTEGER NOT NULL,
      event_type            TEXT NOT NULL,
      exchange              TEXT NOT NULL,
      tradingsymbol         TEXT NOT NULL,
      product               TEXT NOT NULL,
      quantity_delta        INTEGER NOT NULL,
      price                 REAL NOT NULL,
      previous_quantity     INTEGER NOT NULL,
      previous_avg_cost     REAL NOT NULL,
      new_quantity          INTEGER NOT NULL,
      new_avg_cost          REAL NOT NULL,
      realized_pnl          REAL NOT NULL DEFAULT 0,
      stop_price            REAL,
      trailing_anchor_price REAL,
      trailing_stop_distance REAL,
      created_at            INTEGER NOT NULL
    )
  `);

  // ── Strategy lifecycle state ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE strategy_lifecycle_state (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id           TEXT NOT NULL,
      strategy_version      TEXT NOT NULL,
      market_id             TEXT NOT NULL,
      phase                 TEXT NOT NULL,
      updated_at            INTEGER NOT NULL,
      UNIQUE(strategy_id, strategy_version, market_id)
    )
  `);

  // ── Governance decisions ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE governance_decisions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id           TEXT NOT NULL,
      strategy_version      TEXT NOT NULL,
      market_id             TEXT NOT NULL,
      verdict               TEXT NOT NULL,
      previous_phase        TEXT NOT NULL,
      new_phase             TEXT NOT NULL,
      rationale             TEXT NOT NULL,
      evidence_json         TEXT,
      winner_id             INTEGER,
      recorded_at           INTEGER NOT NULL
    )
  `);

  // ── Walk-forward runs ─────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE walk_forward_runs (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      label                 TEXT NOT NULL,
      strategy_id           TEXT NOT NULL,
      strategy_version      TEXT NOT NULL,
      market_id             TEXT NOT NULL,
      replay_session_id     INTEGER,
      window_count          INTEGER NOT NULL DEFAULT 0,
      total_trials          INTEGER NOT NULL DEFAULT 0,
      status                TEXT NOT NULL,
      created_at            INTEGER NOT NULL,
      started_at            INTEGER,
      completed_at          INTEGER
    )
  `);

  // ── Walk-forward windows ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE walk_forward_windows (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id                INTEGER NOT NULL,
      window_index          INTEGER NOT NULL,
      range_start           INTEGER NOT NULL,
      range_end             INTEGER NOT NULL,
      window_label          TEXT NOT NULL,
      trial_count_optimized INTEGER NOT NULL DEFAULT 0,
      trial_count_tested    INTEGER NOT NULL DEFAULT 0,
      status                TEXT NOT NULL,
      created_at            INTEGER NOT NULL
    )
  `);

  // ── Walk-forward trials ───────────────────────────────────────────────
  db.exec(`
    CREATE TABLE walk_forward_trials (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id                INTEGER NOT NULL,
      trial_index           INTEGER NOT NULL,
      label                 TEXT NOT NULL,
      params_json           TEXT NOT NULL DEFAULT '{}',
      merged_score          REAL,
      deterministic_score   REAL,
      llm_score             REAL,
      llm_status            TEXT,
      rank                  INTEGER NOT NULL,
      created_at            INTEGER NOT NULL
    )
  `);

  // ── Walk-forward trial windows ────────────────────────────────────────
  db.exec(`
    CREATE TABLE walk_forward_trial_windows (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      trial_id              INTEGER NOT NULL,
      window_id             INTEGER NOT NULL,
      window_type           TEXT NOT NULL,
      total_return          REAL,
      sharpe_ratio          REAL,
      max_drawdown          REAL,
      win_rate              REAL,
      trade_count           INTEGER NOT NULL DEFAULT 0,
      profit_factor         REAL,
      metrics_json          TEXT,
      created_at            INTEGER NOT NULL
    )
  `);

  // ── Walk-forward winners ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE walk_forward_winners (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id                INTEGER NOT NULL UNIQUE,
      result                TEXT NOT NULL,
      selected_trial_id     INTEGER,
      selection_strategy    TEXT NOT NULL,
      selection_config_json TEXT NOT NULL DEFAULT '{}',
      rationale             TEXT NOT NULL DEFAULT '',
      artifact_paths_json   TEXT,
      selected_at           INTEGER NOT NULL,
      created_at            INTEGER NOT NULL
    )
  `);

  return db;
}

/** Execute the test DB creator, prefix-test to avoid cross-test leaks. */
function setupDb(): Database.Database {
  return createTestDb();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M010 S01 — OperatorReadModel', () => {
  let db: Database.Database;
  let readModel: OperatorReadModel;

  beforeEach(() => {
    db = setupDb();
    readModel = new OperatorReadModel(db);
  });

  // =======================================================================
  // 1. Empty state — all methods return empty arrays / zero totals
  // =======================================================================
  describe('empty state', () => {
    it('getSummaryCards returns zero-value cards without throwing', () => {
      const cards = readModel.getSummaryCards();
      expect(Array.isArray(cards)).toBe(true);
      expect(cards.length).toBeGreaterThan(0);

      for (const card of cards) {
        expect(card.value).toBe(0);
        expect(card.provenance.source).toMatch(/^(runtime|historical)$/);
        expect(card.provenance.asOf).toBeGreaterThan(0);
      }
    });

    it('getStrategyPerformance returns empty array', () => {
      const results = readModel.getStrategyPerformance();
      expect(results).toEqual([]);
    });

    it('getTickerPerformance returns empty array', () => {
      const results = readModel.getTickerPerformance();
      expect(results).toEqual([]);
    });

    it('getDecisionPerformance returns empty array', () => {
      const results = readModel.getDecisionPerformance();
      expect(results).toEqual([]);
    });

    it('getLifecycleStates returns empty array', () => {
      const results = readModel.getLifecycleStates();
      expect(results).toEqual([]);
    });

    it('getLifecycleHistory returns empty array', () => {
      const results = readModel.getLifecycleHistory();
      expect(results).toEqual([]);
    });

    it('getPromotionHistory returns empty array', () => {
      const results = readModel.getPromotionHistory();
      expect(results).toEqual([]);
    });

    it('getWalkForwardLeaderboard returns empty array', () => {
      const results = readModel.getWalkForwardLeaderboard();
      expect(results).toEqual([]);
    });
  });

  // =======================================================================
  // 2. Summary cards with data — totals from COUNT/SUM, not bounded lists
  // =======================================================================
  describe('summary cards with data', () => {
    it('reflects correct counts from persisted rows', () => {
      // Insert strategy decisions
      const insertDecision = db.prepare(`
        INSERT INTO strategy_decisions
          (proposal_attempt_id, decision_status, strategy_id, strategy_version,
           decided_at, exchange, tradingsymbol, side, product, quantity, order_type,
           risk_sizing_basis, execution_class, segment, instrument_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertDecision.run(1, 'approved', 'strategy-a', '1.0.0', 1000, 'NSE', 'RELIANCE', 'buy', 'MIS', 10, 'MARKET', 'last_price', 'EQ', 'NSE', 'EQ');
      insertDecision.run(2, 'refused', 'strategy-a', '1.0.0', 2000, 'NSE', 'TCS', 'buy', 'MIS', 5, 'MARKET', 'last_price', 'EQ', 'NSE', 'EQ');

      // Insert execution attempts
      db.prepare(`
        INSERT INTO execution_attempts
          (strategy_decision_id, execution_mode, status, outcome_code, message, attempted_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(1, 'paper', 'completed', 'paper_simulated', 'OK', 3000);

      // Insert governance decisions
      db.prepare(`
        INSERT INTO governance_decisions
          (strategy_id, strategy_version, market_id, verdict, previous_phase, new_phase, rationale, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('strategy-a', '1.0.0', 'INDIA_NSE_EQ', 'hold', 'backtest', 'backtest', 'Not ready', 4000);

      // Insert walk-forward run with winner
      db.prepare(`
        INSERT INTO walk_forward_runs
          (label, strategy_id, strategy_version, market_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('WF-001', 'strategy-a', '1.0.0', 'INDIA_NSE_EQ', 'completed', 5000);
      db.prepare(`
        INSERT INTO walk_forward_winners
          (run_id, result, selected_trial_id, selection_strategy, selected_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(1, 'winner_selected', null, 'best_sharpe', 6000, 6000);

      // Insert paper orders and fills
      db.prepare(`
        INSERT INTO paper_orders
          (execution_attempt_id, exchange, tradingsymbol, side, product, quantity, order_type, status, broker_order_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'NSE', 'RELIANCE', 'buy', 'MIS', 10, 'MARKET', 'filled', 'ORD001', 7000);
      db.prepare(`
        INSERT INTO paper_fills
          (paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product, filled_quantity, filled_price, broker_order_id, filled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 'NSE', 'RELIANCE', 'buy', 'MIS', 10, 2500, 'ORD001', 8000);

      const cards = readModel.getSummaryCards();
      const cardMap = new Map(cards.map(c => [c.key, c]));

      expect(cardMap.get('current_pnl')!.value).toBe(0); // No positions, realized_pnl = 0
      expect(cardMap.get('total_decisions')!.value).toBe(2);
      expect(cardMap.get('total_execution_attempts')!.value).toBe(1);
      expect(cardMap.get('total_governance_decisions')!.value).toBe(1);
      expect(cardMap.get('total_walk_forward_runs')!.value).toBe(1);
      expect(cardMap.get('total_paper_orders')!.value).toBe(1);
      expect(cardMap.get('total_paper_fills')!.value).toBe(1);
    });

    it('totals come from persisted queries, not bounded recent lists', () => {
      // Insert more than any reasonable cap (e.g. 100 rows)
      const insertDecision = db.prepare(`
        INSERT INTO strategy_decisions
          (proposal_attempt_id, decision_status, strategy_id, strategy_version,
           decided_at, exchange, tradingsymbol, side, product, quantity, order_type,
           risk_sizing_basis, execution_class, segment, instrument_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (let i = 1; i <= 100; i++) {
        insertDecision.run(
          i, 'approved', 'strategy-a', '1.0.0',
          i * 1000, 'NSE', `SYM${i}`, 'buy', 'MIS', 10, 'MARKET',
          'last_price', 'EQ', 'NSE', 'EQ',
        );
      }

      const cards = readModel.getSummaryCards();
      const cardMap = new Map(cards.map(c => [c.key, c]));
      expect(cardMap.get('total_decisions')!.value).toBe(100);
    });
  });

  // =======================================================================
  // 3. Mixed open/flat positions with realized + unrealized P&L
  // =======================================================================
  describe('mixed open and flat positions', () => {
    beforeEach(() => {
      // Seed strategy decisions, execution attempts, fills, and positions

      // Decision 1: RELIANCE buy (approved, consumed)
      db.prepare(`
        INSERT INTO strategy_decisions
          (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
           decided_at, exchange, tradingsymbol, side, product, quantity, price, order_type,
           risk_sizing_basis, execution_class, segment, instrument_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 'approved', 'strategy-a', '1.0.0', 1000,
        'NSE', 'RELIANCE', 'buy', 'MIS', 10, 2500, 'LIMIT',
        'last_price', 'EQ', 'NSE', 'EQ');
      db.prepare(`
        INSERT INTO execution_attempts
          (id, strategy_decision_id, execution_mode, status, outcome_code, message, attempted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 'paper', 'completed', 'paper_simulated', 'OK', 2000);
      db.prepare(`
        INSERT INTO paper_orders
          (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price,
           order_type, status, broker_order_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 'NSE', 'RELIANCE', 'buy', 'MIS', 10, 2500,
        'LIMIT', 'filled', 'ORD001', 3000);
      db.prepare(`
        INSERT INTO paper_fills
          (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product,
           filled_quantity, filled_price, broker_order_id, filled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 1, 'NSE', 'RELIANCE', 'buy', 'MIS', 10, 2500, 'ORD001', 4000);
      db.prepare(`
        INSERT INTO position_events
          (id, paper_order_id, paper_fill_id, execution_attempt_id, event_type,
           exchange, tradingsymbol, product, quantity_delta, price,
           previous_quantity, previous_avg_cost, new_quantity, new_avg_cost,
           realized_pnl, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 1, 1, 'fill', 'NSE', 'RELIANCE', 'MIS', 10, 2500,
        0, 0, 10, 2500, 0, 5000);
      db.prepare(`
        INSERT INTO paper_positions
          (exchange, tradingsymbol, product, side, quantity, avg_cost_price,
           realized_pnl, mark_price, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('NSE', 'RELIANCE', 'MIS', 'long', 10, 2500, 0, 2600, 6000);

      // Decision 2: TCS sell (approved, consumed, closed with profit)
      db.prepare(`
        INSERT INTO strategy_decisions
          (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
           decided_at, exchange, tradingsymbol, side, product, quantity, price, order_type,
           risk_sizing_basis, execution_class, segment, instrument_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 2, 'approved', 'strategy-a', '1.0.0', 7000,
        'NSE', 'TCS', 'sell', 'MIS', 5, 4000, 'LIMIT',
        'last_price', 'EQ', 'NSE', 'EQ');
      db.prepare(`
        INSERT INTO execution_attempts
          (id, strategy_decision_id, execution_mode, status, outcome_code, message, attempted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(2, 2, 'paper', 'completed', 'paper_simulated', 'OK', 8000);
      db.prepare(`
        INSERT INTO paper_orders
          (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price,
           order_type, status, broker_order_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 2, 'NSE', 'TCS', 'sell', 'MIS', 5, 4000,
        'LIMIT', 'filled', 'ORD002', 9000);
      db.prepare(`
        INSERT INTO paper_fills
          (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product,
           filled_quantity, filled_price, broker_order_id, filled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 2, 2, 'NSE', 'TCS', 'sell', 'MIS', 5, 4000, 'ORD002', 10000);
      db.prepare(`
        INSERT INTO position_events
          (id, paper_order_id, paper_fill_id, execution_attempt_id, event_type,
           exchange, tradingsymbol, product, quantity_delta, price,
           previous_quantity, previous_avg_cost, new_quantity, new_avg_cost,
           realized_pnl, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 2, 2, 2, 'fill', 'NSE', 'TCS', 'MIS', -5, 4000,
        0, 0, -5, 4000, 0, 11000);
      // Flat TCS position with realized P&L (bought at 3800, sold at 4000 = 200*5 = 1000 profit)
      db.prepare(`
        INSERT INTO paper_positions
          (exchange, tradingsymbol, product, side, quantity, avg_cost_price,
           realized_pnl, mark_price, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('NSE', 'TCS', 'MIS', 'flat', 0, 0, 1000, null, 12000);
    });

    it('getSummaryCards reflects realized P&L from positions', () => {
      const cards = readModel.getSummaryCards();
      const cardMap = new Map(cards.map(c => [c.key, c]));
      // realized_pnl from paper_positions: RELIANCE=0, TCS=1000 => total=1000
      expect(cardMap.get('current_pnl')!.value).toBe(1000);
    });

    it('getTickerPerformance returns both open and flat tickers', () => {
      const results = readModel.getTickerPerformance();
      // Should have two entries: RELIANCE (open long) and TCS (flat)
      expect(results.length).toBeGreaterThanOrEqual(2);

      const reliance = results.find(r => r.tradingsymbol === 'RELIANCE');
      expect(reliance).toBeDefined();
      expect(reliance!.exchange).toBe('NSE');
      expect(reliance!.netQuantity).toBe(10);
      expect(reliance!.tradeCount).toBe(1);
      // unrealized P&L: (mark_price 2600 - avg_cost 2500) * 10 = 1000
      expect(reliance!.unrealizedPnl).toBe(1000);

      const tcs = results.find(r => r.tradingsymbol === 'TCS');
      expect(tcs).toBeDefined();
      expect(tcs!.netQuantity).toBe(0);
      expect(tcs!.realizedPnl).toBeGreaterThan(0);
    });

    it('getDecisionPerformance returns decisions with execution links', () => {
      const results = readModel.getDecisionPerformance();
      expect(results.length).toBe(2);

      for (const r of results) {
        expect(r.strategyId).toBe('strategy-a');
        expect(r.decisionStatus).toBe('approved');
        expect(r.executionStatus).toBe('completed');
        expect(r.outcomeCode).toBe('paper_simulated');
      }
    });
  });

  // =======================================================================
  // 4. Governance/walk-forward with null winner_id or null selected trial
  // =======================================================================
  describe('null winner / no-winner walk-forward rows', () => {
    beforeEach(() => {
      // Insert a walk-forward run with a 'no_winner' result (null selected_trial_id)
      db.prepare(`
        INSERT INTO walk_forward_runs
          (id, label, strategy_id, strategy_version, market_id, window_count, total_trials, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'WF-NO-WIN', 'strategy-b', '2.0.0', 'INDIA_NSE_EQ', 3, 10, 'completed', 1000);
      db.prepare(`
        INSERT INTO walk_forward_winners
          (run_id, result, selected_trial_id, selection_strategy, selection_config_json, rationale, selected_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'no_winner', null, 'best_sharpe', '{}', 'No trial met criteria', 2000, 2000);

      // Insert a governance decision with no winner reference
      db.prepare(`
        INSERT INTO governance_decisions
          (id, strategy_id, strategy_version, market_id, verdict, previous_phase, new_phase, rationale, winner_id, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'strategy-b', '2.0.0', 'INDIA_NSE_EQ', 'hold', 'backtest', 'backtest', 'Evaluation pending', null, 3000);
    });

    it('getWalkForwardLeaderboard includes no-winner rows with null metrics', () => {
      const results = readModel.getWalkForwardLeaderboard();
      expect(results.length).toBe(1);

      const row = results[0];
      expect(row.label).toBe('WF-NO-WIN');
      expect(row.strategyId).toBe('strategy-b');
      expect(row.winnerId).toBeDefined();
      expect(row.mergedScore).toBeNull();
      expect(row.sharpeRatio).toBeNull();
      expect(row.totalReturnPct).toBeNull();
      expect(row.maxDrawdownPct).toBeNull();
      expect(row.winRate).toBeNull();
      expect(row.selectedAt).toBeDefined();
      expect(row.provenance.source).toBe('historical');
    });

    it('getPromotionHistory excludes non-promote governance decisions', () => {
      const results = readModel.getPromotionHistory();
      expect(results.length).toBe(0);
    });

    it('getLifecycleHistory includes non-promote decisions with null winner_id', () => {
      const results = readModel.getLifecycleHistory();
      expect(results.length).toBe(1);
      expect(results[0].verdict).toBe('hold');
    });
  });

  // =======================================================================
  // 5. Walk-forward leaderboard with winner and per-window evidence
  // =======================================================================
  describe('walk-forward leaderboard with winner evidence', () => {
    beforeEach(() => {
      // Run + windows + trials + trial-windows + winner
      db.prepare(`
        INSERT INTO walk_forward_runs
          (id, label, strategy_id, strategy_version, market_id, window_count, total_trials, status, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'WF-001', 'strategy-c', '3.0.0', 'INDIA_NSE_EQ', 4, 20, 'completed', 1000, 20000);

      db.prepare(`
        INSERT INTO walk_forward_windows
          (id, run_id, window_index, range_start, range_end, window_label, trial_count_optimized, trial_count_tested, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 0, 100000, 200000, 'W0', 5, 5, 'completed', 3000);
      db.prepare(`
        INSERT INTO walk_forward_windows
          (id, run_id, window_index, range_start, range_end, window_label, trial_count_optimized, trial_count_tested, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 1, 1, 200000, 300000, 'W1', 5, 5, 'completed', 4000);

      db.prepare(`
        INSERT INTO walk_forward_trials
          (id, run_id, trial_index, label, params_json, merged_score, deterministic_score, rank, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 0, 'Trial-A', '{"lr":0.01}', 0.85, 0.82, 1, 5000);
      db.prepare(`
        INSERT INTO walk_forward_trials
          (id, run_id, trial_index, label, params_json, merged_score, deterministic_score, rank, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 1, 1, 'Trial-B', '{"lr":0.05}', 0.72, 0.70, 2, 6000);

      // Per-window evidence for Trial-A (the winner)
      db.prepare(`
        INSERT INTO walk_forward_trial_windows
          (trial_id, window_id, window_type, total_return, sharpe_ratio, max_drawdown, win_rate, trade_count, profit_factor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 'in_sample', 15.5, 1.8, 12.0, 0.65, 50, 1.5, 7000);
      db.prepare(`
        INSERT INTO walk_forward_trial_windows
          (trial_id, window_id, window_type, total_return, sharpe_ratio, max_drawdown, win_rate, trade_count, profit_factor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 2, 'out_of_sample', 12.3, 1.5, 15.0, 0.60, 45, 1.3, 8000);

      // Winner selects Trial-A
      db.prepare(`
        INSERT INTO walk_forward_winners
          (run_id, result, selected_trial_id, selection_strategy, selection_config_json, rationale, selected_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'winner_selected', 1, 'best_sharpe', '{}', 'Trial-A has best Sharpe', 9000, 9000);
    });

    it('returns leaderboard with aggregated metrics from selected trial windows', () => {
      const results = readModel.getWalkForwardLeaderboard();
      expect(results.length).toBe(1);

      const row = results[0];
      expect(row.runId).toBe(1);
      expect(row.label).toBe('WF-001');
      expect(row.strategyId).toBe('strategy-c');
      expect(row.windowCount).toBe(4);
      expect(row.winnerId).toBeDefined();
      expect(row.selectionStrategy).toBe('best_sharpe');
      expect(row.mergedScore).toBeCloseTo(0.85);

      // Avg of two windows: (1.8 + 1.5)/2 = 1.65
      expect(row.sharpeRatio).toBeCloseTo(1.65);
      // Avg of two windows: (15.5 + 12.3)/2 = 13.9
      expect(row.totalReturnPct).toBeCloseTo(13.9);
      // Avg of two windows: (12.0 + 15.0)/2 = 13.5
      expect(row.maxDrawdownPct).toBeCloseTo(13.5);
      // Avg of two windows: (0.65 + 0.60)/2 = 0.625
      expect(row.winRate).toBeCloseTo(0.625);
      expect(row.selectedAt).toBeDefined();
      expect(row.provenance.source).toBe('historical');
    });
  });

  // =======================================================================
  // 6. Strategy performance attribution
  // =======================================================================
  describe('strategy performance', () => {
    beforeEach(() => {
      // Two strategies, multiple tickers each

      // Strategy A: RELIANCE buy (open), TCS sell (closed)
      db.prepare(`
        INSERT INTO strategy_decisions
          (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
           decided_at, exchange, tradingsymbol, side, product, quantity, price, order_type,
           risk_sizing_basis, execution_class, segment, instrument_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 'approved', 'strategy-a', '1.0.0', 1000,
        'NSE', 'RELIANCE', 'buy', 'MIS', 10, 2500, 'LIMIT',
        'last_price', 'EQ', 'NSE', 'EQ');
      db.prepare(`
        INSERT INTO execution_attempts
          (id, strategy_decision_id, execution_mode, status, outcome_code, message, attempted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 'paper', 'completed', 'paper_simulated', 'OK', 2000);
      db.prepare(`
        INSERT INTO paper_orders (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price, order_type, status, broker_order_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 'NSE', 'RELIANCE', 'buy', 'MIS', 10, 2500, 'LIMIT', 'filled', 'ORD001', 3000);
      db.prepare(`
        INSERT INTO paper_fills (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product, filled_quantity, filled_price, broker_order_id, filled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 1, 'NSE', 'RELIANCE', 'buy', 'MIS', 10, 2500, 'ORD001', 4000);
      db.prepare(`
        INSERT INTO position_events (id, paper_order_id, paper_fill_id, execution_attempt_id, event_type, exchange, tradingsymbol, product, quantity_delta, price, previous_quantity, previous_avg_cost, new_quantity, new_avg_cost, realized_pnl, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 1, 1, 'fill', 'NSE', 'RELIANCE', 'MIS', 10, 2500, 0, 0, 10, 2500, 0, 5000);
      db.prepare(`
        INSERT INTO paper_positions (exchange, tradingsymbol, product, side, quantity, avg_cost_price, realized_pnl, mark_price, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('NSE', 'RELIANCE', 'MIS', 'long', 10, 2500, 0, 2600, 6000);

      // Strategy B: HDFC buy (closed), INFY sell (closed)
      db.prepare(`
        INSERT INTO strategy_decisions
          (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
           decided_at, exchange, tradingsymbol, side, product, quantity, price, order_type,
           risk_sizing_basis, execution_class, segment, instrument_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 2, 'approved', 'strategy-b', '2.0.0', 10000,
        'NSE', 'HDFC', 'buy', 'MIS', 20, 1800, 'LIMIT',
        'last_price', 'EQ', 'NSE', 'EQ');
      db.prepare(`
        INSERT INTO execution_attempts
          (id, strategy_decision_id, execution_mode, status, outcome_code, message, attempted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(2, 2, 'paper', 'completed', 'paper_simulated', 'OK', 11000);
      db.prepare(`
        INSERT INTO paper_orders (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price, order_type, status, broker_order_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 2, 'NSE', 'HDFC', 'buy', 'MIS', 20, 1800, 'LIMIT', 'filled', 'ORD002', 12000);
      db.prepare(`
        INSERT INTO paper_fills (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product, filled_quantity, filled_price, broker_order_id, filled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 2, 2, 'NSE', 'HDFC', 'buy', 'MIS', 20, 1800, 'ORD002', 13000);

      // Strategy B: INFY sell
      db.prepare(`
        INSERT INTO strategy_decisions
          (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
           decided_at, exchange, tradingsymbol, side, product, quantity, price, order_type,
           risk_sizing_basis, execution_class, segment, instrument_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(3, 3, 'approved', 'strategy-b', '2.0.0', 14000,
        'NSE', 'INFY', 'sell', 'MIS', 15, 1700, 'LIMIT',
        'last_price', 'EQ', 'NSE', 'EQ');
      db.prepare(`
        INSERT INTO execution_attempts
          (id, strategy_decision_id, execution_mode, status, outcome_code, message, attempted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(3, 3, 'paper', 'completed', 'paper_simulated', 'OK', 15000);
      db.prepare(`
        INSERT INTO paper_orders (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price, order_type, status, broker_order_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(3, 3, 'NSE', 'INFY', 'sell', 'MIS', 15, 1700, 'LIMIT', 'filled', 'ORD003', 16000);
      db.prepare(`
        INSERT INTO paper_fills (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product, filled_quantity, filled_price, broker_order_id, filled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(3, 3, 3, 'NSE', 'INFY', 'sell', 'MIS', 15, 1700, 'ORD003', 17000);
    });

    it('getStrategyPerformance returns per-strategy aggregates', () => {
      const results = readModel.getStrategyPerformance();
      expect(results.length).toBe(2);

      const stratA = results.find(r => r.strategyId === 'strategy-a');
      expect(stratA).toBeDefined();
      expect(stratA!.strategyVersion).toBe('1.0.0');
      expect(stratA!.tradeCount).toBe(1); // 1 fill for RELIANCE

      const stratB = results.find(r => r.strategyId === 'strategy-b');
      expect(stratB).toBeDefined();
      expect(stratB!.strategyVersion).toBe('2.0.0');
      expect(stratB!.tradeCount).toBe(2); // 2 fills: HDFC + INFY
    });

    it('getStrategyExposure attributes uniquely linked open positions to a strategy', () => {
      const results = readModel.getStrategyExposure();
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        bucketType: 'strategy',
        strategyId: 'strategy-a',
        strategyVersion: '1.0.0',
        openPositionCount: 1,
        grossOpenCostBasis: 25_000,
        grossOpenMarketValue: 26_000,
        unrealizedPnl: 1_000,
      });
    });

    it('getStrategyExposure withholds ambiguous open positions into an unattributed bucket', () => {
      db.prepare(`
        INSERT INTO strategy_decisions
          (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
           decided_at, exchange, tradingsymbol, side, product, quantity, price, order_type,
           risk_sizing_basis, execution_class, segment, instrument_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(4, 4, 'approved', 'strategy-c', '3.0.0', 18000,
        'NSE', 'RELIANCE', 'buy', 'MIS', 5, 2525, 'LIMIT',
        'last_price', 'EQ', 'NSE', 'EQ');
      db.prepare(`
        INSERT INTO execution_attempts
          (id, strategy_decision_id, execution_mode, status, outcome_code, message, attempted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(4, 4, 'paper', 'completed', 'paper_simulated', 'OK', 18100);
      db.prepare(`
        INSERT INTO paper_orders (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price, order_type, status, broker_order_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(4, 4, 'NSE', 'RELIANCE', 'buy', 'MIS', 5, 2525, 'LIMIT', 'filled', 'ORD004', 18200);
      db.prepare(`
        INSERT INTO paper_fills (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product, filled_quantity, filled_price, broker_order_id, filled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(4, 4, 4, 'NSE', 'RELIANCE', 'buy', 'MIS', 5, 2525, 'ORD004', 18300);

      const results = readModel.getStrategyExposure();
      expect(results).toHaveLength(1);
      expect(results[0].bucketType).toBe('unattributed');
      expect(results[0].attributionNote).toContain('Multiple strategies traded');
      expect(results[0].grossOpenMarketValue).toBe(26_000);
    });
  });

  // =======================================================================
  // 7. Lifecycle state and history
  // =======================================================================
  describe('lifecycle state and history', () => {
    beforeEach(() => {
      db.prepare(`
        INSERT INTO strategy_lifecycle_state (strategy_id, strategy_version, market_id, phase, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('strategy-a', '1.0.0', 'INDIA_NSE_EQ', 'paper', 1000);

      db.prepare(`
        INSERT INTO strategy_lifecycle_state (strategy_id, strategy_version, market_id, phase, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('strategy-b', '2.0.0', 'INDIA_NSE_EQ', 'backtest', 2000);

      // Governance history: promote for A, hold for B
      db.prepare(`
        INSERT INTO governance_decisions
          (id, strategy_id, strategy_version, market_id, verdict, previous_phase, new_phase, rationale, winner_id, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'strategy-a', '1.0.0', 'INDIA_NSE_EQ', 'promote', 'backtest', 'paper', 'Passed backtest thresholds', 1, 3000);

      db.prepare(`
        INSERT INTO governance_decisions
          (id, strategy_id, strategy_version, market_id, verdict, previous_phase, new_phase, rationale, winner_id, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 'strategy-b', '2.0.0', 'INDIA_NSE_EQ', 'hold', 'backtest', 'backtest', 'Not yet evaluated', null, 4000);
    });

    it('getLifecycleStates returns current states', () => {
      const results = readModel.getLifecycleStates();
      expect(results.length).toBe(2);

      const stratA = results.find(r => r.strategyId === 'strategy-a');
      expect(stratA).toBeDefined();
      expect(stratA!.phase).toBe('paper');
      expect(stratA!.provenance.source).toBe('historical');

      const stratB = results.find(r => r.strategyId === 'strategy-b');
      expect(stratB).toBeDefined();
      expect(stratB!.phase).toBe('backtest');
    });

    it('getLifecycleHistory returns all decisions', () => {
      const results = readModel.getLifecycleHistory();
      expect(results.length).toBe(2);
    });

    it('getPromotionHistory returns only promotions with winner_id', () => {
      const results = readModel.getPromotionHistory();
      expect(results.length).toBe(1);
      expect(results[0].previousPhase).toBe('backtest');
      expect(results[0].newPhase).toBe('paper');
      expect(results[0].winnerId).toBe(1);
    });
  });

  // =======================================================================
  // 8. Malformed optional evidence JSON — read model does not parse it
  //    (evidence columns are passed through as-is, so malformed JSON is
  //     a non-issue for the read model — it just selects string fields.)
  // =======================================================================
  describe('malformed optional evidence JSON', () => {
    it('strategy decision with malformed research_evidence still loads', () => {
      // Insert a decision with malformed JSON in india_research_evidence
      db.prepare(`
        INSERT INTO strategy_decisions
          (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
           decided_at, exchange, tradingsymbol, side, product, quantity, order_type,
           risk_sizing_basis, execution_class, segment, instrument_type,
           india_research_evidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 'approved', 'strategy-a', '1.0.0', 1000,
        'NSE', 'RELIANCE', 'buy', 'MIS', 10, 'MARKET',
        'last_price', 'EQ', 'NSE', 'EQ',
        '{bad json: missing quotes}'); // malformed JSON

      // The read model does not parse india_research_evidence — it only
      // queries decision-level aggregates. This should not throw.
      const cards = readModel.getSummaryCards();
      const cardMap = new Map(cards.map(c => [c.key, c]));
      expect(cardMap.get('total_decisions')!.value).toBe(1);

      const decisions = readModel.getDecisionPerformance();
      expect(decisions.length).toBe(1);
      expect(decisions[0].tradingsymbol).toBe('RELIANCE');
    });

    it('governance decision with malformed evidence_json still loads', () => {
      db.prepare(`
        INSERT INTO governance_decisions
          (id, strategy_id, strategy_version, market_id, verdict, previous_phase, new_phase, rationale, evidence_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'strategy-a', '1.0.0', 'INDIA_NSE_EQ', 'hold', 'backtest', 'backtest', 'OK', '{malformed}', 1000);

      const results = readModel.getLifecycleHistory();
      expect(results.length).toBe(1);
      expect(results[0].rationale).toBe('OK');
    });
  });

  // =======================================================================
  // 9. Aggregate-vs-recent-list truthfulness
  //
  // Prove that totals come from persisted COUNT/SUM/GROUP BY, not from
  // bounded recent lists. Insert 100 rows, verify the total is 100
  // (which exceeds any plausible bounded list limit).
  // =======================================================================
  describe('research lineage summary', () => {
    beforeEach(() => {
      db.exec(`
        CREATE TABLE hypothesis_memory_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          canonical_hash TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          reason_code TEXT NOT NULL,
          reason_message TEXT NOT NULL,
          hypothesis_graph_id INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE hypothesis_graphs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          canonical_hash TEXT NOT NULL,
          canonical_json TEXT NOT NULL,
          status TEXT NOT NULL,
          schema_version TEXT NOT NULL,
          signals_json TEXT NOT NULL,
          filters_json TEXT NOT NULL,
          entry_rules_json TEXT NOT NULL,
          exit_rules_json TEXT NOT NULL,
          risk_rules_json TEXT NOT NULL,
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE hypothesis_evaluations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hypothesis_graph_id INTEGER NOT NULL,
          walk_forward_run_id INTEGER,
          status TEXT NOT NULL,
          winner_id INTEGER,
          rationale TEXT NOT NULL,
          outcome_detail TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE hypothesis_generation_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          verdict TEXT NOT NULL,
          provider_url TEXT NOT NULL,
          provider_model TEXT,
          prompt_version TEXT,
          triggered_at INTEGER NOT NULL,
          market_id TEXT NOT NULL,
          strategy_id TEXT,
          raw_provider_output TEXT,
          raw_output_content_hash TEXT,
          raw_output_preview TEXT,
          canonical_hash TEXT,
          hypothesis_graph_id INTEGER,
          hypothesis_evaluation_id INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE hypothesis_generation_reasons (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          generation_attempt_id INTEGER NOT NULL,
          reason_code TEXT NOT NULL,
          reason_message TEXT NOT NULL
        );
        CREATE TABLE research_publications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hypothesis_evaluation_id INTEGER NOT NULL,
          hypothesis_graph_id INTEGER NOT NULL,
          status TEXT NOT NULL,
          strategy_id TEXT NOT NULL,
          strategy_version TEXT NOT NULL,
          market_id TEXT NOT NULL,
          rationale TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          lifecycle_state_id INTEGER,
          governance_decision_id INTEGER,
          published_at INTEGER,
          created_at INTEGER NOT NULL
        );
      `);
    });

    it('returns truthful persisted totals separately from bounded recent lineage rows', () => {
      for (let i = 1; i <= 3; i++) {
        db.prepare(`
          INSERT INTO hypothesis_graphs
            (id, canonical_hash, canonical_json, status, schema_version, signals_json, filters_json, entry_rules_json, exit_rules_json, risk_rules_json, metadata_json, created_at, updated_at)
          VALUES (?, ?, '{}', 'validated', '1', '[]', '[]', '[]', '[]', '[]', null, ?, ?)
        `).run(i, `hash-${i}`, i * 1000, i * 1000);
      }
      for (let i = 1; i <= 2; i++) {
        db.prepare(`
          INSERT INTO hypothesis_evaluations
            (id, hypothesis_graph_id, walk_forward_run_id, status, winner_id, rationale, outcome_detail, created_at, updated_at)
          VALUES (?, ?, null, 'completed', null, 'ok', 'ok', ?, ?)
        `).run(i, i, i * 2000, i * 2000);
      }
      db.prepare(`
        INSERT INTO hypothesis_memory_ledger
          (canonical_hash, status, reason_code, reason_message, hypothesis_graph_id, created_at)
        VALUES ('hash-dup', 'failed', 'exact_failure_match', 'duplicate', null, 3000)
      `).run();
      for (let i = 1; i <= 4; i++) {
        db.prepare(`
          INSERT INTO hypothesis_generation_attempts
            (id, verdict, provider_url, provider_model, prompt_version, triggered_at, market_id, strategy_id, raw_provider_output, raw_output_content_hash, raw_output_preview, canonical_hash, hypothesis_graph_id, hypothesis_evaluation_id, created_at)
          VALUES (?, ?, 'http://provider', 'gpt-test', '1', ?, 'INDIA_NSE_EQ', 'strategy', null, null, null, ?, ?, ?, ?)
        `).run(
          i,
          i === 4 ? 'skipped' : 'accepted',
          i * 4000,
          i === 4 ? 'hash-dup' : `hash-${i}`,
          i <= 3 ? i : null,
          i <= 2 ? i : null,
          i * 4000,
        );
      }
      db.prepare(`INSERT INTO hypothesis_generation_reasons (generation_attempt_id, reason_code, reason_message) VALUES (4, 'duplicate_skipped', 'Exact duplicate')`).run();
      db.prepare(`
        INSERT INTO strategy_lifecycle_state (id, strategy_id, strategy_version, market_id, phase, updated_at)
        VALUES (1, 'published-strategy', '1.0.0', 'INDIA_NSE_EQ', 'paper', 7000)
      `).run();
      db.prepare(`
        INSERT INTO governance_decisions
          (id, strategy_id, strategy_version, market_id, verdict, previous_phase, new_phase, rationale, evidence_json, winner_id, recorded_at)
        VALUES (1, 'published-strategy', '1.0.0', 'INDIA_NSE_EQ', 'promote', 'backtest', 'paper', 'ok', '{}', null, 7100)
      `).run();
      db.prepare(`
        INSERT INTO research_publications
          (id, hypothesis_evaluation_id, hypothesis_graph_id, status, strategy_id, strategy_version, market_id, rationale, evidence_json, lifecycle_state_id, governance_decision_id, published_at, created_at)
        VALUES (1, 1, 1, 'published', 'published-strategy', '1.0.0', 'INDIA_NSE_EQ', 'ok', '{}', 1, 1, 7200, 7200)
      `).run();

      const summary = readModel.getResearchLineageSummary(4);
      expect(summary.totals).toEqual({
        generationAttempts: 4,
        hypotheses: 3,
        evaluations: 2,
        duplicateSkips: 1,
        publications: 1,
      });
      expect(summary.recent).toHaveLength(4);
      expect(summary.status.availability).toBe('ready');
      expect(summary.recent[0].generationAttempt?.id).toBe(4);
      expect(summary.recent[0].duplicateSkip?.reasonCode).toBe('duplicate_skipped');
      const publicationRow = summary.recent.find(entry => entry.publication?.strategyId === 'published-strategy');
      expect(publicationRow?.publication?.strategyId).toBe('published-strategy');
      expect(publicationRow?.publication?.governanceVerdict).toBe('promote');
    });

    it('returns explicit empty status when lineage tables exist but contain no rows', () => {
      const summary = readModel.getResearchLineageSummary();
      expect(summary.totals).toEqual({
        generationAttempts: 0,
        hypotheses: 0,
        evaluations: 0,
        duplicateSkips: 0,
        publications: 0,
      });
      expect(summary.recent).toEqual([]);
      expect(summary.status.availability).toBe('empty');
      expect(summary.status.diagnostics).toEqual([]);
    });
  });
});
