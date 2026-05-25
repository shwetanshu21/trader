// ── Operator Read Model — File-backed WAL Integration Test ──
//
// Proves the operator read-only seam works against a real file-backed
// SQLite database under WAL semantics, including concurrent writer access.
//
// Scenarios:
//   1. Basic: writer closes, reader opens, reads verify
//   2. WAL concurrency: writer stays open, reader opens, reads verify
//   3. Writer inserts while reader open: reader sees committed WAL data
//   4. Per-strategy aggregates through fill→attempt→decision chain
//   5. Per-ticker with open long + flat closed positions
//   6. Lifecycle state + governance history + promotion filtering
//   7. Walk-forward leaderboard with winner + trial window metrics
//   8. Negative: flat positions visible in historical aggregates
//   9. Negative: multiple decisions per strategy don't collapse
//  10. Negative: no-winner leaderboard still returns truthful rows
//  11. Negative: malformed evidence JSON doesn't throw

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openOperatorDb, closeOperatorDb, isReadOnly } from '../src/operator/read-only-db.js';
import { OperatorReadModel } from '../src/operator/operator-read-model.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-wal-test-'));
  tmpDirs.push(dir);
  return dir;
}

function makeDbPath(tmpDir: string): string {
  return path.join(tmpDir, 'trader-test.db');
}

/**
 * Create a file-backed, WAL-mode SQLite database with the full runtime schema
 * that the operator read model queries. Returns both the path and a writer
 * handle so the caller can seed data or keep the writer open for concurrency tests.
 */
function createAndSeedWriterDb(
  tmpDir: string,
  seedFn?: (db: Database.Database) => void,
): { dbPath: string; writer: Database.Database } {
  const dbPath = makeDbPath(tmpDir);
  const writer = new Database(dbPath);

  writer.pragma('journal_mode = WAL');
  writer.pragma('foreign_keys = ON');

  // ── Full schema ──────────────────────────────────────────────────────
  writer.exec(`
    CREATE TABLE IF NOT EXISTS strategy_decisions (
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
    );

    CREATE TABLE IF NOT EXISTS execution_attempts (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_decision_id  INTEGER NOT NULL UNIQUE,
      execution_mode        TEXT NOT NULL,
      status                TEXT NOT NULL,
      outcome_code          TEXT,
      broker_order_id       TEXT,
      message               TEXT NOT NULL,
      attempted_at          INTEGER NOT NULL,
      completed_at          INTEGER
    );

    CREATE TABLE IF NOT EXISTS paper_orders (
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
    );

    CREATE TABLE IF NOT EXISTS paper_fills (
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
    );

    CREATE TABLE IF NOT EXISTS paper_positions (
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
    );

    CREATE TABLE IF NOT EXISTS position_events (
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
    );

    CREATE TABLE IF NOT EXISTS strategy_lifecycle_state (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id           TEXT NOT NULL,
      strategy_version      TEXT NOT NULL,
      market_id             TEXT NOT NULL,
      phase                 TEXT NOT NULL,
      updated_at            INTEGER NOT NULL,
      UNIQUE(strategy_id, strategy_version, market_id)
    );

    CREATE TABLE IF NOT EXISTS governance_decisions (
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
    );

    CREATE TABLE IF NOT EXISTS walk_forward_runs (
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
    );

    CREATE TABLE IF NOT EXISTS walk_forward_windows (
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
    );

    CREATE TABLE IF NOT EXISTS walk_forward_trials (
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
    );

    CREATE TABLE IF NOT EXISTS walk_forward_trial_windows (
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
    );

    CREATE TABLE IF NOT EXISTS walk_forward_winners (
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
    );
  `);

  if (seedFn) {
    seedFn(writer);
  }

  return { dbPath, writer };
}

/**
 * Seed comprehensive test data for a full-stack verification.
 * Covers: two strategies, multiple decisions, fills, open + flat positions,
 * lifecycle state, governance history (promote + hold), and walk-forward
 * run with winner.
 */
function seedFullData(db: Database.Database): void {
  // ── Strategy A: RELIANCE buy (open long) + TCS sell (closed flat with profit) ──
  db.prepare(`
    INSERT INTO strategy_decisions
      (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
       decided_at, exchange, tradingsymbol, side, product, quantity, price, order_type,
       risk_sizing_basis, execution_class, segment, instrument_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 'approved', 'strat-a', '1.0.0', 1000,
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
  `).run('NSE', 'RELIANCE', 'MIS', 'long', 10, 2500, 0, 2600, 5500);

  // Decision 2: TCS sell (strategy A, closed flat with 1000 profit)
  db.prepare(`
    INSERT INTO strategy_decisions
      (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
       decided_at, exchange, tradingsymbol, side, product, quantity, price, order_type,
       risk_sizing_basis, execution_class, segment, instrument_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 2, 'approved', 'strat-a', '1.0.0', 6000,
    'NSE', 'TCS', 'sell', 'MIS', 5, 4000, 'LIMIT',
    'last_price', 'EQ', 'NSE', 'EQ');

  db.prepare(`
    INSERT INTO execution_attempts
      (id, strategy_decision_id, execution_mode, status, outcome_code, message, attempted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(2, 2, 'paper', 'completed', 'paper_simulated', 'OK', 7000);

  db.prepare(`
    INSERT INTO paper_orders
      (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price,
       order_type, status, broker_order_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 2, 'NSE', 'TCS', 'sell', 'MIS', 5, 4000,
    'LIMIT', 'filled', 'ORD002', 8000);

  db.prepare(`
    INSERT INTO paper_fills
      (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product,
       filled_quantity, filled_price, broker_order_id, filled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 2, 2, 'NSE', 'TCS', 'sell', 'MIS', 5, 4000, 'ORD002', 9000);

  db.prepare(`
    INSERT INTO position_events
      (id, paper_order_id, paper_fill_id, execution_attempt_id, event_type,
       exchange, tradingsymbol, product, quantity_delta, price,
       previous_quantity, previous_avg_cost, new_quantity, new_avg_cost,
       realized_pnl, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 2, 2, 2, 'fill', 'NSE', 'TCS', 'MIS', -5, 4000,
    0, 0, -5, 4000, 1000, 10000);

  db.prepare(`
    INSERT INTO paper_positions
      (exchange, tradingsymbol, product, side, quantity, avg_cost_price,
       realized_pnl, mark_price, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('NSE', 'TCS', 'MIS', 'flat', 0, 0, 1000, null, 11000);

  // ── Strategy B: HDFC buy (closed, partial data) ──────────────────────
  db.prepare(`
    INSERT INTO strategy_decisions
      (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
       decided_at, exchange, tradingsymbol, side, product, quantity, price, order_type,
       risk_sizing_basis, execution_class, segment, instrument_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(3, 3, 'approved', 'strat-b', '2.0.0', 12000,
    'NSE', 'HDFC', 'buy', 'MIS', 20, 1800, 'LIMIT',
    'last_price', 'EQ', 'NSE', 'EQ');

  db.prepare(`
    INSERT INTO execution_attempts
      (id, strategy_decision_id, execution_mode, status, outcome_code, message, attempted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(3, 3, 'paper', 'completed', 'paper_simulated', 'OK', 13000);

  db.prepare(`
    INSERT INTO paper_orders
      (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price,
       order_type, status, broker_order_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(3, 3, 'NSE', 'HDFC', 'buy', 'MIS', 20, 1800,
    'LIMIT', 'filled', 'ORD003', 14000);

  db.prepare(`
    INSERT INTO paper_fills
      (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product,
       filled_quantity, filled_price, broker_order_id, filled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(3, 3, 3, 'NSE', 'HDFC', 'buy', 'MIS', 20, 1800, 'ORD003', 15000);

  // ── Strategy C: governance + lifecycle only (no fills) ────────────────
  db.prepare(`
    INSERT INTO strategy_lifecycle_state
      (strategy_id, strategy_version, market_id, phase, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('strat-c', '1.0.0', 'INDIA_NSE_EQ', 'paper', 20000);

  // ── Lifecycle state for strategy A ────────────────────────────────────
  db.prepare(`
    INSERT INTO strategy_lifecycle_state
      (strategy_id, strategy_version, market_id, phase, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('strat-a', '1.0.0', 'INDIA_NSE_EQ', 'paper', 16000);

  // ── Governance decisions ──────────────────────────────────────────────
  // Promote: strat-a from backtest to paper
  db.prepare(`
    INSERT INTO governance_decisions
      (id, strategy_id, strategy_version, market_id, verdict, previous_phase, new_phase,
       rationale, winner_id, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'strat-a', '1.0.0', 'INDIA_NSE_EQ', 'promote', 'backtest', 'paper',
    'Strategy A passed backtest thresholds', 1, 17000);

  // Hold: strat-b stays in backtest
  db.prepare(`
    INSERT INTO governance_decisions
      (id, strategy_id, strategy_version, market_id, verdict, previous_phase, new_phase,
       rationale, winner_id, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 'strat-b', '2.0.0', 'INDIA_NSE_EQ', 'hold', 'backtest', 'backtest',
    'Insufficient out-of-sample performance', null, 18000);

  // ── Walk-forward run with winner ─────────────────────────────────────
  db.prepare(`
    INSERT INTO walk_forward_runs
      (id, label, strategy_id, strategy_version, market_id, window_count,
       total_trials, status, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'WF-001', 'strat-a', '1.0.0', 'INDIA_NSE_EQ', 4, 20, 'completed', 19000, 25000);

  db.prepare(`
    INSERT INTO walk_forward_windows
      (id, run_id, window_index, range_start, range_end, window_label,
       trial_count_optimized, trial_count_tested, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 0, 100000, 200000, 'W0-in', 5, 5, 'completed', 20000);
  db.prepare(`
    INSERT INTO walk_forward_windows
      (id, run_id, window_index, range_start, range_end, window_label,
       trial_count_optimized, trial_count_tested, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 1, 1, 200000, 300000, 'W1-out', 5, 5, 'completed', 21000);

  db.prepare(`
    INSERT INTO walk_forward_trials
      (id, run_id, trial_index, label, params_json, merged_score,
       deterministic_score, rank, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 0, 'Trial-A', '{"lr":0.01}', 0.85, 0.82, 1, 22000);
  db.prepare(`
    INSERT INTO walk_forward_trials
      (id, run_id, trial_index, label, params_json, merged_score,
       deterministic_score, rank, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 1, 1, 'Trial-B', '{"lr":0.05}', 0.72, 0.70, 2, 23000);

  // Trial-A windows
  db.prepare(`
    INSERT INTO walk_forward_trial_windows
      (trial_id, window_id, window_type, total_return, sharpe_ratio,
       max_drawdown, win_rate, trade_count, profit_factor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 'in_sample', 15.5, 1.8, 12.0, 0.65, 50, 1.5, 24000);
  db.prepare(`
    INSERT INTO walk_forward_trial_windows
      (trial_id, window_id, window_type, total_return, sharpe_ratio,
       max_drawdown, win_rate, trade_count, profit_factor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 2, 'out_of_sample', 12.3, 1.5, 15.0, 0.60, 45, 1.3, 24500);

  // Winner selects Trial-A
  db.prepare(`
    INSERT INTO walk_forward_winners
      (run_id, result, selected_trial_id, selection_strategy,
       selection_config_json, rationale, selected_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'winner_selected', 1, 'best_sharpe',
    '{}', 'Trial-A has best Sharpe ratio', 25000, 25000);
}

afterEach(() => {
  // Clean up temp directories
  for (const dir of tmpDirs) {
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        fs.unlinkSync(path.join(dir, f));
      }
      fs.rmdirSync(dir);
    } catch {
      // best-effort cleanup
    }
  }
  tmpDirs = [];
});

// =========================================================================
// Scenario 1: Basic WAL — writer closed, reader opens, reads verify
// =========================================================================
describe('Scenario 1 — Basic WAL (writer closed before reader)', () => {
  it('reads all aggregate data correctly through the read-only seam', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir, seedFullData);

    // Close the writer first
    writer.close();

    // Open via the read-only seam
    const result = openOperatorDb(dbPath);
    expect(result.error).toBeNull();
    expect(result.db).not.toBeNull();

    const readerDb = result.db!;
    expect(isReadOnly(readerDb)).toBe(true);

    const readModel = new OperatorReadModel(readerDb);

    // ── Summary cards ─────────────────────────────────────────────────
    const cards = readModel.getSummaryCards();
    const cardMap = new Map(cards.map(c => [c.key, c]));

    expect(cardMap.get('total_decisions')!.value).toBe(3);
    expect(cardMap.get('total_execution_attempts')!.value).toBe(3);
    expect(cardMap.get('total_governance_decisions')!.value).toBe(2);
    expect(cardMap.get('total_walk_forward_runs')!.value).toBe(1);
    expect(cardMap.get('total_paper_orders')!.value).toBe(3);
    expect(cardMap.get('total_paper_fills')!.value).toBe(3);
    // current_pnl: realized_pnl from paper_positions: RELIANCE=0, TCS=1000 => 1000
    expect(cardMap.get('current_pnl')!.value).toBe(1000);
    expect(cardMap.get('invested_capital')!.value).toBe(25_000);
    expect(cardMap.get('current_value')!.value).toBe(26_000);
    expect(cardMap.get('net_pnl')!.value).toBe(2_000);
    // 1 open position (RELIANCE, qty=10)
    expect(cardMap.get('open_positions')!.value).toBe(1);

    // ── Per-strategy performance ──────────────────────────────────────
    const stratPerf = readModel.getStrategyPerformance();
    expect(stratPerf.length).toBe(2); // strat-a + strat-b (have fills)

    const stratA = stratPerf.find(s => s.strategyId === 'strat-a');
    expect(stratA).toBeDefined();
    expect(stratA!.tradeCount).toBe(2); // RELIANCE + TCS fills
    expect(stratA!.realizedPnl).toBe(1000);
    expect(stratA!.unrealizedPnl).toBe(1000);

    const stratB = stratPerf.find(s => s.strategyId === 'strat-b');
    expect(stratB).toBeDefined();
    expect(stratB!.tradeCount).toBe(1); // HDFC fill
    expect(stratB!.realizedPnl).toBe(0);

    // ── Per-ticker performance ────────────────────────────────────────
    const tickerPerf = readModel.getTickerPerformance();
    // Should have: RELIANCE (open long), TCS (flat), HDFC (fill only)
    expect(tickerPerf.length).toBeGreaterThanOrEqual(3);

    const reliance = tickerPerf.find(t => t.tradingsymbol === 'RELIANCE');
    expect(reliance).toBeDefined();
    expect(reliance!.netQuantity).toBe(10);
    expect(reliance!.unrealizedPnl).toBeGreaterThan(0); // (2600-2500)*10 = 1000

    const tcs = tickerPerf.find(t => t.tradingsymbol === 'TCS');
    expect(tcs).toBeDefined();
    expect(tcs!.netQuantity).toBe(0); // flat
    expect(tcs!.realizedPnl).toBe(1000);

    const hdfc = tickerPerf.find(t => t.tradingsymbol === 'HDFC');
    expect(hdfc).toBeDefined();
    expect(hdfc!.tradeCount).toBe(1);

    // ── Decision performance ──────────────────────────────────────────
    const decisions = readModel.getDecisionPerformance();
    expect(decisions.length).toBe(3);

    for (const d of decisions) {
      expect(d.decisionStatus).toBe('approved');
      expect(d.executionStatus).toBe('completed');
      expect(d.outcomeCode).toBe('paper_simulated');
      expect(d.llmStatus).toBeNull();
      expect(d.llmRationale).toBeNull();
    }

    // ── Lifecycle states ──────────────────────────────────────────────
    const states = readModel.getLifecycleStates();
    expect(states.length).toBe(2);

    const stateA = states.find(s => s.strategyId === 'strat-a');
    expect(stateA).toBeDefined();
    expect(stateA!.phase).toBe('paper');

    const stateC = states.find(s => s.strategyId === 'strat-c');
    expect(stateC).toBeDefined();
    expect(stateC!.phase).toBe('paper');

    // ── Lifecycle history ─────────────────────────────────────────────
    const history = readModel.getLifecycleHistory();
    expect(history.length).toBe(2);

    const promote = history.find(h => h.verdict === 'promote');
    expect(promote).toBeDefined();
    expect(promote!.previousPhase).toBe('backtest');
    expect(promote!.newPhase).toBe('paper');

    // ── Promotion history ─────────────────────────────────────────────
    const promotions = readModel.getPromotionHistory();
    expect(promotions.length).toBe(1);
    expect(promotions[0].previousPhase).toBe('backtest');
    expect(promotions[0].newPhase).toBe('paper');

    // ── Walk-forward leaderboard ──────────────────────────────────────
    const leaderboard = readModel.getWalkForwardLeaderboard();
    expect(leaderboard.length).toBe(1);

    const wf = leaderboard[0];
    expect(wf.label).toBe('WF-001');
    expect(wf.strategyId).toBe('strat-a');
    expect(wf.windowCount).toBe(4);
    expect(wf.selectionStrategy).toBe('best_sharpe');
    expect(wf.mergedScore).toBeCloseTo(0.85);
    // Avg of 2 windows: (1.8 + 1.5)/2 = 1.65
    expect(wf.sharpeRatio).toBeCloseTo(1.65);
    // Avg of 2 windows: (15.5 + 12.3)/2 = 13.9
    expect(wf.totalReturnPct).toBeCloseTo(13.9);
    // Avg of 2 windows: (12.0 + 15.0)/2 = 13.5
    expect(wf.maxDrawdownPct).toBeCloseTo(13.5);
    // Avg of 2 windows: (0.65 + 0.60)/2 = 0.625
    expect(wf.winRate).toBeCloseTo(0.625);

    closeOperatorDb(readerDb);
  });
});

// =========================================================================
// Scenario 2: WAL concurrency — writer stays open while reader reads
// =========================================================================
describe('Scenario 2 — WAL concurrency (writer open while reader reads)', () => {
  it('reads through read-only seam while writer DB connection stays open', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir, seedFullData);

    // Writer stays open — simulate concurrent runtime access
    // Open reader via read-only seam
    const result = openOperatorDb(dbPath);
    expect(result.error).toBeNull();
    expect(result.db).not.toBeNull();

    const readerDb = result.db!;
    expect(isReadOnly(readerDb)).toBe(true);

    const readModel = new OperatorReadModel(readerDb);

    // Verify reads work while writer is open
    const cards = readModel.getSummaryCards();
    const cardMap = new Map(cards.map(c => [c.key, c]));
    expect(cardMap.get('total_decisions')!.value).toBe(3);
    expect(cardMap.get('total_paper_fills')!.value).toBe(3);
    expect(cardMap.get('current_pnl')!.value).toBe(1000);
    expect(cardMap.get('invested_capital')!.value).toBe(25_000);
    expect(cardMap.get('current_value')!.value).toBe(26_000);
    expect(cardMap.get('net_pnl')!.value).toBe(2_000);

    // Verify per-strategy reads work
    const stratPerf = readModel.getStrategyPerformance();
    expect(stratPerf.length).toBe(2);

    // Verify lifecycle reads work
    const states = readModel.getLifecycleStates();
    expect(states.length).toBe(2);

    // Verify leaderboard reads work
    const leaderboard = readModel.getWalkForwardLeaderboard();
    expect(leaderboard.length).toBe(1);

    closeOperatorDb(readerDb);
    writer.close();
  });

  it('reads newly committed data after writer inserts while reader is open', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir, (db) => {
      // Seed minimal initial data
      db.prepare(`
        INSERT INTO strategy_decisions
          (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
           decided_at, exchange, tradingsymbol, side, product, quantity, order_type,
           risk_sizing_basis, execution_class, segment, instrument_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 'approved', 'strat-a', '1.0.0', 1000,
        'NSE', 'RELIANCE', 'buy', 'MIS', 10, 'MARKET',
        'last_price', 'EQ', 'NSE', 'EQ');
    });

    // Open reader
    const readerResult = openOperatorDb(dbPath);
    const readerDb = readerResult.db!;
    let readModel = new OperatorReadModel(readerDb);

    // Verify initial state: 1 decision
    let cards = readModel.getSummaryCards();
    let cardMap = new Map(cards.map(c => [c.key, c]));
    expect(cardMap.get('total_decisions')!.value).toBe(1);

    // Writer inserts another decision (simulating a tick)
    writer.prepare(`
      INSERT INTO strategy_decisions
        (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
         decided_at, exchange, tradingsymbol, side, product, quantity, order_type,
         risk_sizing_basis, execution_class, segment, instrument_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(2, 2, 'approved', 'strat-a', '1.0.0', 2000,
      'NSE', 'TCS', 'buy', 'MIS', 5, 'MARKET',
      'last_price', 'EQ', 'NSE', 'EQ');

    // Re-read — WAL ensures reader sees committed data
    cards = readModel.getSummaryCards();
    cardMap = new Map(cards.map(c => [c.key, c]));
    expect(cardMap.get('total_decisions')!.value).toBe(2);

    // Re-create read model with fresh connection to verify persistence
    closeOperatorDb(readerDb);
    const readerResult2 = openOperatorDb(dbPath);
    const readerDb2 = readerResult2.db!;
    readModel = new OperatorReadModel(readerDb2);

    cards = readModel.getSummaryCards();
    cardMap = new Map(cards.map(c => [c.key, c]));
    expect(cardMap.get('total_decisions')!.value).toBe(2);

    closeOperatorDb(readerDb2);
    writer.close();
  });
});

// =========================================================================
// Scenario 3: Read-only seam enforces read-only mode
// =========================================================================
describe('Scenario 3 — Read-only enforcement', () => {
  it('isReadOnly detects writable vs read-only connections', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir);

    // Writer connection should NOT be read-only
    expect(isReadOnly(writer)).toBe(false);

    writer.close();

    // Reader should be read-only
    const readerResult = openOperatorDb(dbPath);
    const readerDb = readerResult.db!;
    expect(isReadOnly(readerDb)).toBe(true);

    closeOperatorDb(readerDb);
  });

  it('write attempt through read-only seam throws', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir);
    writer.close();

    const readerResult = openOperatorDb(dbPath);
    const readerDb = readerResult.db!;

    expect(() => {
      readerDb.exec('CREATE TABLE x (y INTEGER)');
    }).toThrow();

    closeOperatorDb(readerDb);
  });
});

// =========================================================================
// Scenario 4: Negative — flat positions visible in historical aggregates
// =========================================================================
describe('Scenario 4 — Flat positions visible in historical aggregates', () => {
  it('flat/closed positions remain visible while open-position counts stay correct', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir, seedFullData);
    writer.close();

    const readerResult = openOperatorDb(dbPath);
    const readerDb = readerResult.db!;
    const readModel = new OperatorReadModel(readerDb);

    // Ticker performance should include TCS (flat) with its realized P&L
    const tickerPerf = readModel.getTickerPerformance();
    const tcs = tickerPerf.find(t => t.tradingsymbol === 'TCS');
    expect(tcs).toBeDefined();
    expect(tcs!.netQuantity).toBe(0); // flat
    expect(tcs!.realizedPnl).toBe(1000);

    // Open-position count should still be 1 (RELIANCE is open, TCS is flat)
    const cards = readModel.getSummaryCards();
    const cardMap = new Map(cards.map(c => [c.key, c]));
    expect(cardMap.get('open_positions')!.value).toBe(1);

    closeOperatorDb(readerDb);
  });
});

// =========================================================================
// Scenario 5: Negative — multiple decisions per strategy don't collapse
// =========================================================================
describe('Scenario 5 — Multiple decisions per strategy do not collapse incorrectly', () => {
  it('getDecisionPerformance returns one row per decision', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir, seedFullData);
    writer.close();

    const readerResult = openOperatorDb(dbPath);
    const readerDb = readerResult.db!;
    const readModel = new OperatorReadModel(readerDb);

    // strat-a has 2 decisions (RELIANCE + TCS)
    const decisions = readModel.getDecisionPerformance();
    const stratADecisions = decisions.filter(d => d.strategyId === 'strat-a');
    expect(stratADecisions.length).toBe(2);

    // Verify they are distinct (different tradingsymbols)
    const symbols = stratADecisions.map(d => d.tradingsymbol).sort();
    expect(symbols).toEqual(['RELIANCE', 'TCS']);

    closeOperatorDb(readerDb);
  });

  it('getStrategyPerformance collapses by strategy identity (one row per strategy version)', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir, seedFullData);
    writer.close();

    const readerResult = openOperatorDb(dbPath);
    const readerDb = readerResult.db!;
    const readModel = new OperatorReadModel(readerDb);

    const perf = readModel.getStrategyPerformance();
    // strat-a has 2 decisions (2 fills), should be one row with tradeCount=2
    const stratA = perf.find(s => s.strategyId === 'strat-a');
    expect(stratA).toBeDefined();
    expect(stratA!.tradeCount).toBe(2); // RELIANCE + TCS fills
    expect(stratA!.strategyVersion).toBe('1.0.0');

    closeOperatorDb(readerDb);
  });
});

// =========================================================================
// Scenario 6: Negative — no-winner leaderboard still returns truthful rows
// =========================================================================
describe('Scenario 6 — No-winner leaderboard rows', () => {
  it('no-winner or null-selected-trial leaderboard evidence still returns truthful rows without throwing', () => {
    const tmpDir = makeTempDir();
    const dbPath = makeDbPath(tmpDir);
    const writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    writer.pragma('foreign_keys = ON');

    // Minimal schema (only walk-forward tables needed)
    writer.exec(`
      CREATE TABLE walk_forward_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        strategy_version TEXT NOT NULL,
        market_id TEXT NOT NULL,
        window_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE walk_forward_winners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL UNIQUE,
        result TEXT NOT NULL,
        selected_trial_id INTEGER,
        selection_strategy TEXT NOT NULL,
        selection_config_json TEXT NOT NULL DEFAULT '{}',
        rationale TEXT NOT NULL DEFAULT '',
        selected_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE walk_forward_trials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        trial_index INTEGER NOT NULL,
        label TEXT NOT NULL,
        params_json TEXT NOT NULL DEFAULT '{}',
        merged_score REAL,
        rank INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE walk_forward_trial_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trial_id INTEGER NOT NULL,
        window_id INTEGER NOT NULL,
        window_type TEXT NOT NULL,
        total_return REAL,
        sharpe_ratio REAL,
        max_drawdown REAL,
        win_rate REAL,
        trade_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);

    // Seed: two runs — one no-winner, one with winner but selected_trial has no windows
    // Run 1: no_winner
    writer.prepare(`
      INSERT INTO walk_forward_runs (id, label, strategy_id, strategy_version, market_id, window_count, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'WF-NO-WIN', 'strat-x', '1.0.0', 'INDIA_NSE_EQ', 3, 'completed', 1000);
    writer.prepare(`
      INSERT INTO walk_forward_winners (run_id, result, selected_trial_id, selection_strategy, rationale, selected_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'no_winner', null, 'best_sharpe', 'No trial met minimum Sharpe threshold', 2000, 2000);

    // Run 2: winner_selected but selected trial has no window data
    writer.prepare(`
      INSERT INTO walk_forward_runs (id, label, strategy_id, strategy_version, market_id, window_count, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(2, 'WF-NO-DATA', 'strat-y', '1.0.0', 'INDIA_NSE_EQ', 2, 'completed', 3000);
    writer.prepare(`
      INSERT INTO walk_forward_winners (run_id, result, selected_trial_id, selection_strategy, rationale, selected_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(2, 'winner_selected', 99, 'best_return', 'Best return trial', 4000, 4000);
    writer.prepare(`
      INSERT INTO walk_forward_trials (id, run_id, trial_index, label, params_json, merged_score, rank, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(99, 2, 0, 'Trial-Z', '{}', 0.91, 1, 3500);

    writer.close();

    const readerResult = openOperatorDb(dbPath);
    const readerDb = readerResult.db!;
    const readModel = new OperatorReadModel(readerDb);

    const leaderboard = readModel.getWalkForwardLeaderboard();
    expect(leaderboard.length).toBe(2);

    // Run 1: no-winner — all metrics null
    const noWin = leaderboard.find(r => r.label === 'WF-NO-WIN');
    expect(noWin).toBeDefined();
    expect(noWin!.result).toBeUndefined(); // not on the DTO, but winnerId is set
    expect(noWin!.winnerId).toBeDefined();
    expect(noWin!.mergedScore).toBeNull();
    expect(noWin!.sharpeRatio).toBeNull();
    expect(noWin!.totalReturnPct).toBeNull();
    expect(noWin!.maxDrawdownPct).toBeNull();
    expect(noWin!.winRate).toBeNull();
    expect(noWin!.selectedAt).toBeDefined();

    // Run 2: winner selected but trial has no window metrics — still returns row
    const noData = leaderboard.find(r => r.label === 'WF-NO-DATA');
    expect(noData).toBeDefined();
    expect(noData!.mergedScore).toBeCloseTo(0.91);
    // Window metrics should be null since selected_trial_id=99 has no walk_forward_trial_windows rows
    expect(noData!.sharpeRatio).toBeNull();
    expect(noData!.totalReturnPct).toBeNull();
    expect(noData!.maxDrawdownPct).toBeNull();
    expect(noData!.winRate).toBeNull();

    closeOperatorDb(readerDb);
  });
});

// =========================================================================
// Scenario 7: Negative — malformed evidence JSON doesn't throw
// =========================================================================
describe('Scenario 7 — Malformed evidence JSON is benign', () => {
  it('reads still work when india_research_evidence contains malformed JSON', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir, (db) => {
      // Insert a single decision with malformed JSON in the evidence column
      db.prepare(`
        INSERT INTO strategy_decisions
          (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
           decided_at, exchange, tradingsymbol, side, product, quantity, order_type,
           risk_sizing_basis, execution_class, segment, instrument_type,
           india_research_evidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, 'approved', 'strat-a', '1.0.0', 1000,
        'NSE', 'RELIANCE', 'buy', 'MIS', 10, 'MARKET',
        'last_price', 'EQ', 'NSE', 'EQ',
        '{bad json: missing quotes}'); // malformed — read model never parses it
    });
    writer.close();

    const readerResult = openOperatorDb(dbPath);
    const readerDb = readerResult.db!;
    const readModel = new OperatorReadModel(readerDb);

    // Should not throw — cards are COUNT queries, not parsing evidence
    const cards = readModel.getSummaryCards();
    const cardMap = new Map(cards.map(c => [c.key, c]));
    expect(cardMap.get('total_decisions')!.value).toBe(1);

    // Decision performance should also not throw
    const decisions = readModel.getDecisionPerformance();
    expect(decisions.length).toBe(1);
    expect(decisions[0].tradingsymbol).toBe('RELIANCE');

    closeOperatorDb(readerDb);
  });

  it('reads still work when governance evidence_json contains malformed JSON', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir, (db) => {
      db.prepare(`
        INSERT INTO governance_decisions
          (id, strategy_id, strategy_version, market_id, verdict,
           previous_phase, new_phase, rationale, evidence_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'strat-a', '1.0.0', 'INDIA_NSE_EQ', 'hold',
        'backtest', 'backtest', 'OK', '{malformed}', 1000);
    });
    writer.close();

    const readerResult = openOperatorDb(dbPath);
    const readerDb = readerResult.db!;
    const readModel = new OperatorReadModel(readerDb);

    const history = readModel.getLifecycleHistory();
    expect(history.length).toBe(1);
    expect(history[0].rationale).toBe('OK');

    closeOperatorDb(readerDb);
  });
});

// =========================================================================
// Scenario 8: Limit parameter correctness
// =========================================================================
describe('Scenario 8 — Limit parameter correctness', () => {
  it('getDecisionPerformance respects custom limit', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir, (db) => {
      const insertDecision = db.prepare(`
        INSERT INTO strategy_decisions
          (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
           decided_at, exchange, tradingsymbol, side, product, quantity, order_type,
           risk_sizing_basis, execution_class, segment, instrument_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 1; i <= 25; i++) {
        insertDecision.run(i, i, 'approved', 'strat-a', '1.0.0', i * 1000,
          'NSE', `SYM${i}`, 'buy', 'MIS', 10, 'MARKET',
          'last_price', 'EQ', 'NSE', 'EQ');
      }
    });
    writer.close();

    const readerResult = openOperatorDb(dbPath);
    const readerDb = readerResult.db!;
    const readModel = new OperatorReadModel(readerDb);

    expect(readModel.getDecisionPerformance(5).length).toBe(5);
    expect(readModel.getDecisionPerformance(50).length).toBe(25);

    closeOperatorDb(readerDb);
  });

  it('getLifecycleHistory respects custom limit', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir, (db) => {
      const insertGov = db.prepare(`
        INSERT INTO governance_decisions
          (id, strategy_id, strategy_version, market_id, verdict,
           previous_phase, new_phase, rationale, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 1; i <= 15; i++) {
        insertGov.run(i, 'strat-a', '1.0.0', 'INDIA_NSE_EQ', 'hold',
          'backtest', 'backtest', 'Evaluation', i * 1000);
      }
    });
    writer.close();

    const readerResult = openOperatorDb(dbPath);
    const readerDb = readerResult.db!;
    const readModel = new OperatorReadModel(readerDb);

    expect(readModel.getLifecycleHistory(3).length).toBe(3);
    expect(readModel.getLifecycleHistory(50).length).toBe(15);

    closeOperatorDb(readerDb);
  });

  it('getPromotionHistory respects custom limit', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir, (db) => {
      const insertGov = db.prepare(`
        INSERT INTO governance_decisions
          (id, strategy_id, strategy_version, market_id, verdict,
           previous_phase, new_phase, rationale, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 1; i <= 10; i++) {
        insertGov.run(i, 'strat-a', '1.0.0', 'INDIA_NSE_EQ', 'promote',
          'backtest', 'paper', 'Promoted', i * 1000);
      }
    });
    writer.close();

    const readerResult = openOperatorDb(dbPath);
    const readerDb = readerResult.db!;
    const readModel = new OperatorReadModel(readerDb);

    expect(readModel.getPromotionHistory(2).length).toBe(2);
    expect(readModel.getPromotionHistory(50).length).toBe(10);

    closeOperatorDb(readerDb);
  });
});

// =========================================================================
// Scenario 9: Cross-table joins preserve lifecycle-only strategies
// =========================================================================
describe('Scenario 9 — Cross-table join integrity', () => {
  it('strategies with lifecycle or walk-forward history but no fills appear in lifecycle/leaderboard', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir, (db) => {
      // Strategy with lifecycle state but no decisions, fills, or positions
      db.prepare(`
        INSERT INTO strategy_lifecycle_state
          (strategy_id, strategy_version, market_id, phase, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('lifecycle-only-strat', '1.0.0', 'INDIA_NSE_EQ', 'backtest', 1000);

      // Strategy with governance history but no fills
      db.prepare(`
        INSERT INTO strategy_lifecycle_state
          (strategy_id, strategy_version, market_id, phase, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('gov-only-strat', '1.0.0', 'INDIA_NSE_EQ', 'paper', 2000);
      db.prepare(`
        INSERT INTO governance_decisions
          (id, strategy_id, strategy_version, market_id, verdict,
           previous_phase, new_phase, rationale, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'gov-only-strat', '1.0.0', 'INDIA_NSE_EQ', 'promote',
        'backtest', 'paper', 'Passed evaluation', 3000);

      // Strategy with walk-forward history but no fills
      db.prepare(`
        INSERT INTO walk_forward_runs
          (id, label, strategy_id, strategy_version, market_id, window_count, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'WF-WIN-ONLY', 'wf-only-strat', '1.0.0', 'INDIA_NSE_EQ', 2, 'completed', 4000);
      db.prepare(`
        INSERT INTO walk_forward_winners
          (run_id, result, selected_trial_id, selection_strategy, selected_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(1, 'winner_selected', null, 'best_sharpe', 5000, 5000);
    });
    writer.close();

    const readerResult = openOperatorDb(dbPath);
    const readerDb = readerResult.db!;
    const readModel = new OperatorReadModel(readerDb);

    // Lifecycle-only strategy should appear in lifecycle states
    const states = readModel.getLifecycleStates();
    const lifecycleOnly = states.find(s => s.strategyId === 'lifecycle-only-strat');
    expect(lifecycleOnly).toBeDefined();
    expect(lifecycleOnly!.phase).toBe('backtest');

    // Gov-only strategy should appear in lifecycle states and history
    const govOnlyState = states.find(s => s.strategyId === 'gov-only-strat');
    expect(govOnlyState).toBeDefined();
    expect(govOnlyState!.phase).toBe('paper');

    const history = readModel.getLifecycleHistory();
    const govOnlyHist = history.find(h => h.strategyId === 'gov-only-strat');
    expect(govOnlyHist).toBeDefined();

    // WF-only strategy should appear in leaderboard
    const leaderboard = readModel.getWalkForwardLeaderboard();
    const wfOnly = leaderboard.find(r => r.strategyId === 'wf-only-strat');
    expect(wfOnly).toBeDefined();
    expect(wfOnly!.label).toBe('WF-WIN-ONLY');

    // But none of these should appear in strategy performance (no fills)
    const stratPerf = readModel.getStrategyPerformance();
    expect(stratPerf.find(s => s.strategyId === 'lifecycle-only-strat')).toBeUndefined();
    expect(stratPerf.find(s => s.strategyId === 'gov-only-strat')).toBeUndefined();
    expect(stratPerf.find(s => s.strategyId === 'wf-only-strat')).toBeUndefined();

    closeOperatorDb(readerDb);
  });
});

// =========================================================================
// Scenario 10: Provenance metadata correctness
// =========================================================================
describe('Scenario 10 — Provenance metadata', () => {
  it('every DTO carries explicit provenance with correct source type', () => {
    const tmpDir = makeTempDir();
    const { dbPath, writer } = createAndSeedWriterDb(tmpDir, seedFullData);
    writer.close();

    const readerResult = openOperatorDb(dbPath);
    const readerDb = readerResult.db!;
    const readModel = new OperatorReadModel(readerDb);

    // Summary cards
    for (const card of readModel.getSummaryCards()) {
      expect(card.provenance).toBeDefined();
      expect(card.provenance.asOf).toBeGreaterThan(0);
      expect(['runtime', 'historical']).toContain(card.provenance.source);
    }

    // Strategy performance
    for (const s of readModel.getStrategyPerformance()) {
      expect(s.provenance.source).toBe('historical');
    }

    // Ticker performance
    for (const t of readModel.getTickerPerformance()) {
      expect(['historical', 'runtime']).toContain(t.provenance.source);
    }

    // Decisions
    for (const d of readModel.getDecisionPerformance()) {
      expect(d.provenance.source).toBe('historical');
    }

    // Lifecycle states
    for (const s of readModel.getLifecycleStates()) {
      expect(s.provenance.source).toBe('historical');
    }

    // Lifecycle history
    for (const h of readModel.getLifecycleHistory()) {
      expect(h.provenance.source).toBe('historical');
    }

    // Promotion history
    for (const p of readModel.getPromotionHistory()) {
      expect(p.provenance.source).toBe('historical');
    }

    // Walk-forward leaderboard
    for (const w of readModel.getWalkForwardLeaderboard()) {
      expect(w.provenance.source).toBe('historical');
    }

    closeOperatorDb(readerDb);
  });
});
