import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { DatabaseManager } from '../src/persistence/sqlite.js';

type StartedProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  baseUrl: string;
  password: string;
  username: string;
  stdout: string[];
  stderr: string[];
};

const tempDirs: string[] = [];
const startedProcesses: StartedProcess[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-ui-e2e-'));
  tempDirs.push(dir);
  return dir;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate an ephemeral port.'));
        return;
      }
      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  return response.json();
}

function seedOperatorUiDatabase(dbPath: string): void {
  const db = new DatabaseManager(dbPath);
  const now = Date.now();

  db.db.prepare(`
    INSERT INTO proposal_attempts
      (id, exchange, tradingsymbol, instrument_token, side, product, quantity, price,
       trigger_price, order_type, tag, proposal_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'NSE', 'RELIANCE', 123456, 'buy', 'MIS', 10, 2500, null, 'LIMIT', null, 'accepted', now - 61_000);

  db.db.prepare(`
    INSERT INTO proposal_attempts
      (id, exchange, tradingsymbol, instrument_token, side, product, quantity, price,
       trigger_price, order_type, tag, proposal_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 'NSE', 'TCS', 234567, 'sell', 'MIS', 5, 4000, null, 'LIMIT', null, 'accepted', now - 51_000);

  db.db.prepare(`
    INSERT INTO proposal_attempts
      (id, exchange, tradingsymbol, instrument_token, side, product, quantity, price,
       trigger_price, order_type, tag, proposal_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(3, 'NSE', 'HDFC', 345678, 'buy', 'MIS', 20, 1800, null, 'LIMIT', null, 'accepted', now - 41_000);

  db.db.prepare(`
    INSERT INTO strategy_decisions
      (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
       decided_at, exchange, tradingsymbol, side, product, quantity, price, order_type,
       risk_sizing_basis, execution_class, segment, instrument_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 'approved', 'strat-a', '1.0.0', now - 60_000,
    'NSE', 'RELIANCE', 'buy', 'MIS', 10, 2500, 'LIMIT',
    'last_price', 'EQ', 'NSE', 'EQ');

  db.db.prepare(`
    INSERT INTO strategy_decisions
      (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
       decided_at, exchange, tradingsymbol, side, product, quantity, price, order_type,
       risk_sizing_basis, execution_class, segment, instrument_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 2, 'approved', 'strat-a', '1.0.0', now - 50_000,
    'NSE', 'TCS', 'sell', 'MIS', 5, 4000, 'LIMIT',
    'last_price', 'EQ', 'NSE', 'EQ');

  db.db.prepare(`
    INSERT INTO strategy_decisions
      (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
       decided_at, exchange, tradingsymbol, side, product, quantity, price, order_type,
       risk_sizing_basis, execution_class, segment, instrument_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(3, 3, 'approved', 'strat-b', '2.0.0', now - 40_000,
    'NSE', 'HDFC', 'buy', 'MIS', 20, 1800, 'LIMIT',
    'last_price', 'EQ', 'NSE', 'EQ');

  db.db.prepare(`
    INSERT INTO execution_attempts
      (id, strategy_decision_id, execution_mode, status, outcome_code, message, attempted_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 'paper', 'completed', 'paper_simulated', 'Filled RELIANCE', now - 59_000, now - 58_000);

  db.db.prepare(`
    INSERT INTO execution_attempts
      (id, strategy_decision_id, execution_mode, status, outcome_code, message, attempted_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 2, 'paper', 'completed', 'paper_simulated', 'Filled TCS', now - 49_000, now - 48_000);

  db.db.prepare(`
    INSERT INTO execution_attempts
      (id, strategy_decision_id, execution_mode, status, outcome_code, message, attempted_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(3, 3, 'paper', 'completed', 'paper_simulated', 'Filled HDFC', now - 39_000, now - 38_000);

  db.db.prepare(`
    INSERT INTO paper_orders
      (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price,
       order_type, status, broker_order_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 'NSE', 'RELIANCE', 'buy', 'MIS', 10, 2500, 'LIMIT', 'filled', 'ORD-REL', now - 57_000);

  db.db.prepare(`
    INSERT INTO paper_orders
      (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price,
       order_type, status, broker_order_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 2, 'NSE', 'TCS', 'sell', 'MIS', 5, 4000, 'LIMIT', 'filled', 'ORD-TCS', now - 47_000);

  db.db.prepare(`
    INSERT INTO paper_orders
      (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price,
       order_type, status, broker_order_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(3, 3, 'NSE', 'HDFC', 'buy', 'MIS', 20, 1800, 'LIMIT', 'filled', 'ORD-HDFC', now - 37_000);

  db.db.prepare(`
    INSERT INTO paper_fills
      (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product,
       filled_quantity, filled_price, broker_order_id, filled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 1, 'NSE', 'RELIANCE', 'buy', 'MIS', 10, 2500, 'ORD-REL', now - 56_000);

  db.db.prepare(`
    INSERT INTO paper_fills
      (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product,
       filled_quantity, filled_price, broker_order_id, filled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 2, 2, 'NSE', 'TCS', 'sell', 'MIS', 5, 4000, 'ORD-TCS', now - 46_000);

  db.db.prepare(`
    INSERT INTO paper_fills
      (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product,
       filled_quantity, filled_price, broker_order_id, filled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(3, 3, 3, 'NSE', 'HDFC', 'buy', 'MIS', 20, 1800, 'ORD-HDFC', now - 36_000);

  db.db.prepare(`
    INSERT INTO position_events
      (id, paper_order_id, paper_fill_id, execution_attempt_id, event_type,
       exchange, tradingsymbol, product, quantity_delta, price,
       previous_quantity, previous_avg_cost, new_quantity, new_avg_cost,
       realized_pnl, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 1, 1, 'fill', 'NSE', 'RELIANCE', 'MIS', 10, 2500,
    0, 0, 10, 2500, 0, now - 55_000);

  db.db.prepare(`
    INSERT INTO position_events
      (id, paper_order_id, paper_fill_id, execution_attempt_id, event_type,
       exchange, tradingsymbol, product, quantity_delta, price,
       previous_quantity, previous_avg_cost, new_quantity, new_avg_cost,
       realized_pnl, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 2, 2, 2, 'fill', 'NSE', 'TCS', 'MIS', -5, 4000,
    0, 0, -5, 4000, 1_000, now - 45_000);

  db.db.prepare(`
    INSERT INTO position_events
      (id, paper_order_id, paper_fill_id, execution_attempt_id, event_type,
       exchange, tradingsymbol, product, quantity_delta, price,
       previous_quantity, previous_avg_cost, new_quantity, new_avg_cost,
       realized_pnl, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(3, 3, 3, 3, 'fill', 'NSE', 'HDFC', 'MIS', 20, 1800,
    0, 0, 20, 1800, 0, now - 35_000);

  db.db.prepare(`
    INSERT INTO paper_positions
      (exchange, tradingsymbol, product, side, quantity, avg_cost_price,
       realized_pnl, mark_price, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('NSE', 'RELIANCE', 'MIS', 'long', 10, 2500, 0, 2600, now - 30_000);

  db.db.prepare(`
    INSERT INTO paper_positions
      (exchange, tradingsymbol, product, side, quantity, avg_cost_price,
       realized_pnl, mark_price, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('NSE', 'TCS', 'MIS', 'flat', 0, 0, 1_000, null, now - 29_000);

  db.db.prepare(`
    INSERT INTO paper_positions
      (exchange, tradingsymbol, product, side, quantity, avg_cost_price,
       realized_pnl, mark_price, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('NSE', 'HDFC', 'MIS', 'long', 20, 1800, 0, 1830, now - 28_000);

  db.db.prepare(`
    INSERT INTO strategy_lifecycle_state
      (strategy_id, strategy_version, market_id, phase, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('strat-a', '1.0.0', 'INDIA_NSE_EQ', 'paper', now - 25_000);

  db.db.prepare(`
    INSERT INTO strategy_lifecycle_state
      (strategy_id, strategy_version, market_id, phase, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('strat-c', '1.0.0', 'INDIA_NSE_EQ', 'backtest', now - 24_000);

  db.db.prepare(`
    INSERT INTO walk_forward_runs
      (id, label, strategy_id, strategy_version, market_id, window_count,
       total_trials, status, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'WF-001', 'strat-a', '1.0.0', 'INDIA_NSE_EQ', 4, 2, 'completed', now - 23_000, now - 18_000);

  db.db.prepare(`
    INSERT INTO walk_forward_windows
      (id, run_id, window_index, range_start, range_end, window_label,
       trial_count_optimized, trial_count_tested, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 0, now - 120_000, now - 90_000, 'W0-in', 1, 1, 'completed', now - 22_000);

  db.db.prepare(`
    INSERT INTO walk_forward_windows
      (id, run_id, window_index, range_start, range_end, window_label,
       trial_count_optimized, trial_count_tested, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 1, 1, now - 89_000, now - 60_000, 'W1-out', 1, 1, 'completed', now - 21_000);

  db.db.prepare(`
    INSERT INTO walk_forward_trials
      (id, run_id, trial_index, label, params_json, merged_score,
       deterministic_score, rank, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 0, 'Trial-A', '{"lr":0.01}', 0.85, 0.82, 1, now - 20_000);

  db.db.prepare(`
    INSERT INTO walk_forward_trial_windows
      (trial_id, window_id, window_type, total_return, sharpe_ratio,
       max_drawdown, win_rate, trade_count, profit_factor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 'in_sample', 15.5, 1.8, 12.0, 0.65, 50, 1.5, now - 19_000);

  db.db.prepare(`
    INSERT INTO walk_forward_trial_windows
      (trial_id, window_id, window_type, total_return, sharpe_ratio,
       max_drawdown, win_rate, trade_count, profit_factor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 2, 'out_of_sample', 12.3, 1.5, 15.0, 0.60, 45, 1.3, now - 18_500);

  db.db.prepare(`
    INSERT INTO walk_forward_winners
      (id, run_id, result, selected_trial_id, selection_strategy,
       selection_config_json, rationale, selected_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, 'winner_selected', 1, 'best_sharpe', '{}', 'Trial-A has best Sharpe ratio', now - 18_000, now - 18_000);

  db.db.prepare(`
    INSERT INTO governance_decisions
      (id, strategy_id, strategy_version, market_id, verdict, previous_phase, new_phase,
       rationale, winner_id, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'strat-a', '1.0.0', 'INDIA_NSE_EQ', 'promote', 'backtest', 'paper',
    'Strategy A passed walk-forward thresholds', 1, now - 17_000);

  db.db.prepare(`
    INSERT INTO governance_decisions
      (id, strategy_id, strategy_version, market_id, verdict, previous_phase, new_phase,
       rationale, winner_id, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 'strat-b', '2.0.0', 'INDIA_NSE_EQ', 'hold', 'backtest', 'backtest',
    'Insufficient out-of-sample performance', null, now - 16_000);

  db.close();
}

async function waitForServerReady(baseUrl: string, child: ChildProcessWithoutNullStreams, stdout: string[], stderr: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error([
        `Operator UI process exited early with code ${child.exitCode}.`,
        'STDOUT:',
        stdout.join(''),
        'STDERR:',
        stderr.join(''),
      ].join('\n'));
    }

    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200 || response.status === 503) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error([
    `Timed out waiting for operator UI readiness at ${baseUrl}.`,
    lastError instanceof Error ? `Last fetch error: ${lastError.message}` : 'No fetch response received.',
    'STDOUT:',
    stdout.join(''),
    'STDERR:',
    stderr.join(''),
  ].join('\n'));
}

async function startOperatorUiProcess(options: {
  dbPath: string;
  password?: string;
  username?: string;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  lockoutThreshold?: number;
  lockoutDurationMs?: number;
}): Promise<StartedProcess> {
  const port = await getFreePort();
  const password = options.password ?? 'test-password';
  const username = options.username ?? 'operator';
  const baseUrl = `http://127.0.0.1:${port}`;
  const stdout: string[] = [];
  const stderr: string[] = [];

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/operator-ui/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPERATOR_UI_HOST: '127.0.0.1',
      OPERATOR_UI_PORT: String(port),
      OPERATOR_UI_DB_PATH: options.dbPath,
      OPERATOR_UI_USERNAME: username,
      OPERATOR_UI_PASSWORD: password,
      OPERATOR_UI_POLL_INTERVAL_MS: '1500',
      OPERATOR_UI_RATE_LIMIT_MAX: String(options.rateLimitMax ?? 20),
      OPERATOR_UI_RATE_LIMIT_WINDOW_MS: String(options.rateLimitWindowMs ?? 60_000),
      OPERATOR_UI_LOCKOUT_THRESHOLD: String(options.lockoutThreshold ?? 3),
      OPERATOR_UI_LOCKOUT_DURATION_MS: String(options.lockoutDurationMs ?? 120_000),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => stdout.push(String(chunk)));
  child.stderr.on('data', chunk => stderr.push(String(chunk)));

  const started = { child, port, baseUrl, password, username, stdout, stderr };
  startedProcesses.push(started);
  await waitForServerReady(baseUrl, child, stdout, stderr);
  return started;
}

async function stopOperatorUiProcess(processInfo: StartedProcess): Promise<void> {
  const index = startedProcesses.indexOf(processInfo);
  if (index >= 0) {
    startedProcesses.splice(index, 1);
  }

  if (processInfo.child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      processInfo.child.kill('SIGKILL');
    }, 5_000);

    processInfo.child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    processInfo.child.kill('SIGTERM');
  });
}

afterEach(async () => {
  while (startedProcesses.length > 0) {
    const processInfo = startedProcesses.pop();
    if (processInfo) {
      await stopOperatorUiProcess(processInfo);
    }
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('operator UI — live standalone integration', () => {
  it('boots the real entrypoint against a seeded SQLite database and serves live HTML/JSON/health surfaces', async () => {
    const tmpDir = makeTempDir();
    const dbPath = path.join(tmpDir, 'operator-ui.db');
    seedOperatorUiDatabase(dbPath);

    const app = await startOperatorUiProcess({ dbPath });
    const authHeader = basicAuthHeader(app.username, app.password);

    const livenessResponse = await fetch(`${app.baseUrl}/health`);
    expect(livenessResponse.status).toBe(200);
    expect(await livenessResponse.json()).toMatchObject({
      status: 'alive',
      service: 'operator-ui',
      dbConnected: true,
      dbError: null,
    });

    const unauthenticatedDashboard = await fetch(`${app.baseUrl}/`);
    expect(unauthenticatedDashboard.status).toBe(401);
    expect(unauthenticatedDashboard.headers.get('www-authenticate')).toContain('Basic realm="Operator Console"');
    expect(await unauthenticatedDashboard.json()).toMatchObject({
      error: 'Missing Authorization header.',
      status: 401,
    });

    const wrongCredentials = await fetch(`${app.baseUrl}/api/health`, {
      headers: { Authorization: basicAuthHeader(app.username, 'wrong-password') },
    });
    expect(wrongCredentials.status).toBe(403);
    expect(await wrongCredentials.json()).toMatchObject({
      status: 403,
    });

    const htmlResponse = await fetch(`${app.baseUrl}/`, {
      headers: { Authorization: authHeader },
    });
    const html = await htmlResponse.text();
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('Operator Console');
    expect(html).toContain('Summary');
    expect(html).toContain('Strategy Performance');
    expect(html).toContain('Recent Decisions');
    expect(html).toContain('Governance History');
    expect(html).toContain('Walk-Forward Leaderboard');
    expect(html).toContain('RELIANCE');
    expect(html).toContain('TCS');
    expect(html).toContain('HDFC');
    expect(html).toContain('WF-001');
    expect(html).toContain('/api/refresh');
    expect(html).toContain('/api/health');

    const refreshResponse = await fetch(`${app.baseUrl}/api/refresh`, {
      headers: { Authorization: authHeader },
    });
    expect(refreshResponse.status).toBe(200);
    expect(refreshResponse.headers.get('content-type')).toContain('application/json');
    const refreshPayload = await refreshResponse.json();
    expect(refreshPayload.dbAvailable).toBe(true);
    expect(refreshPayload.dbError).toBeNull();
    expect(refreshPayload.sections.summaryCards.state).toBe('ok');
    expect(refreshPayload.sections.summaryCards.count).toBeGreaterThanOrEqual(8);
    expect(refreshPayload.sections.summaryCards.data.some((card: any) => card.key === 'current_pnl')).toBe(true);
    expect(refreshPayload.sections.strategyPerformance.state).toBe('ok');
    expect(refreshPayload.sections.strategyPerformance.count).toBe(2);
    expect(refreshPayload.sections.strategyPerformance.data.some((row: any) => row.strategyId === 'strat-a')).toBe(true);
    expect(refreshPayload.sections.tickerPerformance.count).toBeGreaterThanOrEqual(3);
    expect(refreshPayload.sections.decisionPerformance.count).toBe(3);
    expect(refreshPayload.sections.decisionPerformance.data[0].executionStatus).toBe('completed');
    expect(refreshPayload.sections.lifecycleStates.count).toBe(2);
    expect(refreshPayload.sections.governanceHistory.count).toBe(2);
    expect(refreshPayload.sections.promotionHistory.count).toBe(1);
    expect(refreshPayload.sections.walkForwardLeaderboard.data[0]).toMatchObject({
      label: 'WF-001',
      strategyId: 'strat-a',
      selectionStrategy: 'best_sharpe',
    });

    const apiHealthResponse = await fetch(`${app.baseUrl}/api/health`, {
      headers: { Authorization: authHeader },
    });
    expect(apiHealthResponse.status).toBe(200);
    const apiHealth = await apiHealthResponse.json();
    expect(apiHealth).toMatchObject({
      status: 'healthy',
      service: 'operator-ui',
      dbConnected: true,
      dbError: null,
      pollIntervalMs: 1500,
    });
    expect(apiHealth.sections.summaryCards).toMatchObject({ status: 'ok', count: 9 });
    expect(apiHealth.sections.recentDecisions).toMatchObject({ status: 'ok', count: 3 });
    expect(apiHealth.sections.strategyPerformance).toMatchObject({ status: 'ok', count: 2 });
    expect(apiHealth.sections.tickerPerformance).toMatchObject({ status: 'ok' });
    expect(apiHealth.sections.lifecycle).toMatchObject({ status: 'ok', count: 2 });
  });

  it('starts in degraded mode when the operator database cannot be opened and reports truthful failure surfaces', async () => {
    const tmpDir = makeTempDir();
    const missingDbPath = path.join(tmpDir, 'missing-operator-ui.db');
    const app = await startOperatorUiProcess({ dbPath: missingDbPath });
    const authHeader = basicAuthHeader(app.username, app.password);

    const livenessResponse = await fetch(`${app.baseUrl}/health`);
    expect(livenessResponse.status).toBe(503);
    const liveness = await livenessResponse.json();
    expect(liveness.status).toBe('degraded');
    expect(liveness.service).toBe('operator-ui');
    expect(liveness.dbConnected).toBe(false);
    expect(String(liveness.dbError)).not.toBe('null');

    const dashboardResponse = await fetch(`${app.baseUrl}/`, {
      headers: { Authorization: authHeader },
    });
    const dashboardHtml = await dashboardResponse.text();
    expect(dashboardResponse.status).toBe(503);
    expect(dashboardHtml).toContain('Database Unavailable');

    const refreshResponse = await fetch(`${app.baseUrl}/api/refresh`, {
      headers: { Authorization: authHeader },
    });
    expect(refreshResponse.status).toBe(503);
    expect(await refreshResponse.json()).toMatchObject({
      error: 'Database unavailable',
    });

    const apiHealthResponse = await fetch(`${app.baseUrl}/api/health`, {
      headers: { Authorization: authHeader },
    });
    expect(apiHealthResponse.status).toBe(200);
    const apiHealth = await apiHealthResponse.json();
    expect(apiHealth.status).toBe('degraded');
    expect(apiHealth.dbConnected).toBe(false);
    expect(apiHealth.sections.summaryCards.status).toBe('unavailable');
  });

  it('surfaces 429 rate limiting through the live authenticated API', async () => {
    const tmpDir = makeTempDir();
    const dbPath = path.join(tmpDir, 'operator-ui-rate-limit.db');
    seedOperatorUiDatabase(dbPath);

    const app = await startOperatorUiProcess({
      dbPath,
      rateLimitMax: 1,
      rateLimitWindowMs: 60_000,
    });
    const authHeader = basicAuthHeader(app.username, app.password);

    const firstResponse = await fetch(`${app.baseUrl}/api/health`, {
      headers: { Authorization: authHeader },
    });
    expect(firstResponse.status).toBe(200);

    const secondResponse = await fetch(`${app.baseUrl}/api/health`, {
      headers: { Authorization: authHeader },
    });
    expect(secondResponse.status).toBe(429);
    expect(secondResponse.headers.get('retry-after')).toBe('120');
    const rateLimitPayload = await secondResponse.json();
    expect(rateLimitPayload.status).toBe(429);
    expect(rateLimitPayload.error).toContain('Rate limit exceeded');
  });
});
