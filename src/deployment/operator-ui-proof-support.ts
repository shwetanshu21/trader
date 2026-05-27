import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { DatabaseManager } from '../persistence/sqlite.js';

export type OperatorUIProofFaultSection =
  | 'summaryCards'
  | 'strategyPerformance'
  | 'tickerPerformance'
  | 'decisionPerformance'
  | 'lifecycleStates'
  | 'governanceHistory'
  | 'promotionHistory'
  | 'walkForwardLeaderboard';

type StartedOperatorChild = ChildProcessByStdio<null, Readable, Readable>;

export type StartedOperatorUIProcess = {
  child: StartedOperatorChild;
  port: number;
  baseUrl: string;
  password: string;
  username: string;
  stdout: string[];
  stderr: string[];
  dbPath: string;
};

export function makeOperatorUiTempDir(prefix = 'operator-ui-proof-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function getFreePort(): Promise<number> {
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

export const OPERATOR_UI_PROOF_ARTIFACT_ROOT = 'data/artifacts/operator-ui-proof';
export const DEFAULT_OPERATOR_UI_ROLLOUT_BASE_URL = 'http://127.0.0.1:3100';

export type OperatorUIRolloutTarget = {
  verificationMode: 'host-local-default' | 'explicit-base-url';
  baseUrl: string;
  origin: string;
  routePrefix: string;
};

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

export function resolveOperatorUiRolloutTarget(baseUrl?: string): OperatorUIRolloutTarget {
  const verificationMode = baseUrl ? 'explicit-base-url' : 'host-local-default';
  const candidate = (baseUrl?.trim() || DEFAULT_OPERATOR_UI_ROLLOUT_BASE_URL).replace(/\/+$/, '');
  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Invalid --base-url value: ${baseUrl}`);
  }

  const routePrefix = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  const normalizedBaseUrl = `${url.origin}${routePrefix}`;

  return {
    verificationMode,
    baseUrl: normalizedBaseUrl,
    origin: url.origin,
    routePrefix,
  };
}

export function buildOperatorUiRouteUrl(target: OperatorUIRolloutTarget, routePath: string): string {
  const normalizedPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${target.origin}${target.routePrefix}${normalizedPath}`;
}

export function seedOperatorUiDatabase(dbPath: string): void {
  const manager = new DatabaseManager(dbPath);
  const db = manager.db;
  const now = Date.now();

  const insertProposal = db.prepare(`
    INSERT INTO proposal_attempts
      (id, exchange, tradingsymbol, instrument_token, side, product, quantity, price,
       trigger_price, order_type, tag, proposal_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertProposal.run(1, 'NSE', 'RELIANCE', 123456, 'buy', 'MIS', 10, 2500, null, 'LIMIT', 'seeded-rel', 'accepted', now - 61_000);
  insertProposal.run(2, 'NSE', 'TCS', 234567, 'sell', 'MIS', 5, 4000, null, 'LIMIT', 'seeded-tcs', 'accepted', now - 51_000);
  insertProposal.run(3, 'NSE', 'HDFC', 345678, 'buy', 'MIS', 20, 1800, null, 'LIMIT', 'seeded-hdfc', 'accepted', now - 41_000);

  const insertDecision = db.prepare(`
    INSERT INTO strategy_decisions
      (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
       decided_at, exchange, tradingsymbol, side, product, quantity, price, trigger_price,
       order_type, quote_last_price, quote_bid, quote_ask, quote_volume, quote_received_at,
       risk_notional, risk_sizing_basis, risk_max_loss_rupees, risk_stop_distance,
       risk_stop_price, risk_trailing_stop_distance, risk_budget_rupees, risk_exposure_tag,
       india_research_evidence, execution_class, segment, instrument_type, expiry, strike,
       lot_size, tick_size, freeze_quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertDecision.run(
    1, 1, 'approved', 'strat-a', '1.0.0',
    now - 60_000, 'NSE', 'RELIANCE', 'buy', 'MIS', 10, 2500, null,
    'LIMIT', 2498.5, 2498.0, 2499.0, 1_240_000, now - 60_500,
    25_000, 'last_price', 4_200, 14.5,
    2484, 10.25, 15_000, 'swing_core',
    JSON.stringify({
      summary: 'India research favored refinery strength ahead of earnings.',
      tags: ['india-macro', 'earnings', 'energy'],
      freshnessMs: 300_000,
      influenceContext: 'Supported taking the long candidate over lower-conviction peers.',
    }),
    'EQ', 'NSE', 'EQ', null, null,
    1, 0.05, 10_000,
  );

  insertDecision.run(
    2, 2, 'approved', 'strat-a', '1.0.0',
    now - 50_000, 'NSE', 'TCS', 'sell', 'MIS', 5, 4000, null,
    'LIMIT', 3996.5, 3996, 3997, 920_000, now - 50_500,
    20_000, 'last_price', 3_500, 18,
    4018, 12, 12_500, 'event_short',
    null,
    'EQ', 'NSE', 'EQ', null, null,
    1, 0.05, 9_000,
  );

  insertDecision.run(
    3, 3, 'approved', 'strat-b', '2.0.0',
    now - 40_000, 'NSE', 'HDFC', 'buy', 'MIS', 20, 1800, null,
    'LIMIT', 1798.5, 1798, 1799, 780_000, now - 40_500,
    36_000, 'last_price', 5_000, 11,
    1789, 7.5, 18_000, 'rotation_probe',
    JSON.stringify({
      summary: 'Domestic bank breadth was constructive but conviction stayed below promotion threshold.',
      tags: ['banks', 'breadth'],
      freshnessMs: 420_000,
      influenceContext: null,
    }),
    'EQ', 'NSE', 'EQ', null, null,
    1, 0.05, 8_000,
  );

  const insertDecisionReason = db.prepare(`
    INSERT INTO strategy_decision_reasons
      (strategy_decision_id, reason_code, reason_message)
    VALUES (?, ?, ?)
  `);

  insertDecisionReason.run(1, 'trend_alignment', 'Daily and hourly trend filters aligned long.');
  insertDecisionReason.run(1, 'risk_budget_ok', 'Rounded quantity stayed inside the configured India risk budget.');
  insertDecisionReason.run(2, 'mean_reversion', 'Short setup cleared mean-reversion threshold after the morning fade.');

  db.prepare(`
    INSERT INTO hybrid_score_summary
      (id, proposal_attempt_id, deterministic_score, llm_score, llm_status,
       llm_rationale, merged_score, merge_policy, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1, 1, 0.82, 0.9, 'consulted',
    'LLM agreed that refinery momentum and macro context supported approval.',
    0.86, 'weighted', now - 59_500,
  );

  const insertHybridComponent = db.prepare(`
    INSERT INTO hybrid_score_components
      (summary_id, component_name, score, weight, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertHybridComponent.run(1, 'deterministic_edge', 0.8, 0.5, 1);
  insertHybridComponent.run(1, 'india_research_support', 0.92, 0.3, 2);
  insertHybridComponent.run(1, 'liquidity_quality', 0.88, 0.2, 3);

  const insertExecutionAttempt = db.prepare(`
    INSERT INTO execution_attempts
      (id, strategy_decision_id, execution_mode, status, outcome_code, broker_order_id, message, attempted_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertExecutionAttempt.run(1, 1, 'paper', 'completed', 'paper_simulated', 'ORD-REL', 'Filled RELIANCE at the seeded limit price.', now - 59_000, now - 58_000);
  insertExecutionAttempt.run(2, 2, 'paper', 'completed', 'paper_simulated', 'ORD-TCS', 'Filled TCS after the opening fade.', now - 49_000, now - 48_000);
  insertExecutionAttempt.run(3, 3, 'paper', 'completed', 'paper_simulated', 'ORD-HDFC', 'Filled HDFC in paper mode for monitoring only.', now - 39_000, now - 38_000);

  const insertPaperOrder = db.prepare(`
    INSERT INTO paper_orders
      (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price,
       order_type, status, broker_order_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertPaperOrder.run(1, 1, 'NSE', 'RELIANCE', 'buy', 'MIS', 10, 2500, 'LIMIT', 'filled', 'ORD-REL', now - 57_000);
  insertPaperOrder.run(2, 2, 'NSE', 'TCS', 'sell', 'MIS', 5, 4000, 'LIMIT', 'filled', 'ORD-TCS', now - 47_000);
  insertPaperOrder.run(3, 3, 'NSE', 'HDFC', 'buy', 'MIS', 20, 1800, 'LIMIT', 'filled', 'ORD-HDFC', now - 37_000);

  const insertPaperFill = db.prepare(`
    INSERT INTO paper_fills
      (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product,
       filled_quantity, filled_price, broker_order_id, filled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertPaperFill.run(1, 1, 1, 'NSE', 'RELIANCE', 'buy', 'MIS', 10, 2500, 'ORD-REL', now - 56_000);
  insertPaperFill.run(2, 2, 2, 'NSE', 'TCS', 'sell', 'MIS', 5, 4000, 'ORD-TCS', now - 46_000);
  insertPaperFill.run(3, 3, 3, 'NSE', 'HDFC', 'buy', 'MIS', 20, 1800, 'ORD-HDFC', now - 36_000);

  const insertPositionEvent = db.prepare(`
    INSERT INTO position_events
      (id, paper_order_id, paper_fill_id, execution_attempt_id, event_type,
       exchange, tradingsymbol, product, quantity_delta, price,
       previous_quantity, previous_avg_cost, new_quantity, new_avg_cost,
       realized_pnl, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertPositionEvent.run(1, 1, 1, 1, 'fill', 'NSE', 'RELIANCE', 'MIS', 10, 2500, 0, 0, 10, 2500, 0, now - 55_000);
  insertPositionEvent.run(2, 2, 2, 2, 'fill', 'NSE', 'TCS', 'MIS', -5, 4000, 0, 0, -5, 4000, 1_000, now - 45_000);
  insertPositionEvent.run(3, 3, 3, 3, 'fill', 'NSE', 'HDFC', 'MIS', 20, 1800, 0, 0, 20, 1800, 0, now - 35_000);

  const insertPaperPosition = db.prepare(`
    INSERT INTO paper_positions
      (exchange, tradingsymbol, product, side, quantity, avg_cost_price,
       realized_pnl, mark_price, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertPaperPosition.run('NSE', 'RELIANCE', 'MIS', 'long', 10, 2500, 0, 2600, now - 30_000);
  insertPaperPosition.run('NSE', 'TCS', 'MIS', 'flat', 0, 0, 1_000, null, now - 29_000);
  insertPaperPosition.run('NSE', 'HDFC', 'MIS', 'long', 20, 1800, 0, 1830, now - 28_000);

  const insertLifecycle = db.prepare(`
    INSERT INTO strategy_lifecycle_state
      (strategy_id, strategy_version, market_id, phase, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertLifecycle.run('strat-a', '1.0.0', 'INDIA_NSE_EQ', 'paper', now - 25_000);
  insertLifecycle.run('strat-c', '1.0.0', 'INDIA_NSE_EQ', 'backtest', now - 24_000);

  const insertRun = db.prepare(`
    INSERT INTO walk_forward_runs
      (id, label, strategy_id, strategy_version, market_id, window_count,
       total_trials, status, created_at, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRun.run(1, 'WF-001', 'strat-a', '1.0.0', 'INDIA_NSE_EQ', 2, 2, 'completed', now - 23_000, now - 22_500, now - 18_000);
  insertRun.run(2, 'WF-002', 'strat-b', '2.0.0', 'INDIA_NSE_EQ', 1, 1, 'completed', now - 17_500, now - 17_300, now - 16_100);

  const insertWindow = db.prepare(`
    INSERT INTO walk_forward_windows
      (id, run_id, window_index, range_start, range_end, window_label,
       trial_count_optimized, trial_count_tested, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertWindow.run(1, 1, 0, now - 120_000, now - 90_000, 'W0-in', 2, 0, 'completed', now - 22_000);
  insertWindow.run(2, 1, 1, now - 89_000, now - 60_000, 'W1-out', 0, 2, 'completed', now - 21_000);
  insertWindow.run(3, 2, 0, now - 70_000, now - 40_000, 'W0-eval', 1, 1, 'completed', now - 17_200);

  const insertTrial = db.prepare(`
    INSERT INTO walk_forward_trials
      (id, run_id, trial_index, label, params_json, merged_score,
       deterministic_score, llm_score, llm_status, rank, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertTrial.run(1, 1, 0, 'Trial-A', '{"lr":0.01,"threshold":1.2}', 0.86, 0.82, 0.9, 'consulted', 1, now - 20_000);
  insertTrial.run(2, 1, 1, 'Trial-B', '{"lr":0.02,"threshold":1.1}', 0.79, 0.78, 0.8, 'consulted', 2, now - 19_500);
  insertTrial.run(3, 2, 0, 'Trial-C', '{"rebalanceDays":5}', 0.54, 0.6, 0.48, 'degraded', 1, now - 17_000);

  const insertTrialWindow = db.prepare(`
    INSERT INTO walk_forward_trial_windows
      (id, trial_id, window_id, window_type, total_return, sharpe_ratio,
       max_drawdown, win_rate, trade_count, profit_factor, metrics_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertTrialWindow.run(1, 1, 1, 'in_sample', 15.5, 1.8, 12.0, 0.65, 50, 1.5, JSON.stringify({ replaySessionId: 77, topCandidateCount: 12, meanMergedScore: 0.84 }), now - 19_000);
  insertTrialWindow.run(2, 1, 2, 'out_of_sample', 12.3, 1.5, 15.0, 0.60, 45, 1.3, JSON.stringify({ replaySessionId: 77, topCandidateCount: 12, meanMergedScore: 0.81 }), now - 18_500);
  insertTrialWindow.run(3, 2, 1, 'in_sample', 13.1, 1.6, 13.8, 0.58, 41, 1.2, JSON.stringify({ replaySessionId: 77, topCandidateCount: 12, meanMergedScore: 0.77 }), now - 19_200);
  insertTrialWindow.run(4, 2, 2, 'out_of_sample', 8.7, 1.2, 16.5, 0.52, 39, 1.05, JSON.stringify({ replaySessionId: 77, topCandidateCount: 12, meanMergedScore: 0.73 }), now - 18_400);
  insertTrialWindow.run(5, 3, 3, 'out_of_sample', 2.1, 0.7, 19.5, 0.45, 18, 0.95, null, now - 16_800);

  const insertWinner = db.prepare(`
    INSERT INTO walk_forward_winners
      (id, run_id, result, selected_trial_id, selection_strategy,
       selection_config_json, rationale, artifact_paths_json, selected_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertWinner.run(
    1, 1, 'selected', 1, 'composite',
    JSON.stringify({ strategy: 'composite', minMergedScore: 0.8, minSharpeRatio: 1.2, maxDrawdown: 18 }),
    'Trial-A has the best risk-adjusted out-of-sample result and cleared promotion gates.',
    JSON.stringify(['artifacts/wf-001/winner.json', 'artifacts/wf-001/diagnostics.json']),
    now - 18_000, now - 18_000,
  );
  insertWinner.run(
    2, 2, 'no_winner', null, 'threshold',
    JSON.stringify({ strategy: 'threshold', minMergedScore: 0.7, minWindowCount: 1 }),
    'No trial met the minimum merged-score threshold for promotion.',
    JSON.stringify(['artifacts/wf-002/diagnostics.json']),
    now - 16_300, now - 16_300,
  );

  const insertGovernance = db.prepare(`
    INSERT INTO governance_decisions
      (id, strategy_id, strategy_version, market_id, verdict, previous_phase, new_phase,
       rationale, evidence_json, winner_id, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertGovernance.run(
    1, 'strat-a', '1.0.0', 'INDIA_NSE_EQ', 'promote', 'backtest', 'paper',
    'Strategy A passed walk-forward thresholds',
    JSON.stringify({ gate: 'promotion', minSharpe: 1.2, approvingReviewer: 'ops-bot' }),
    1,
    now - 17_000,
  );
  insertGovernance.run(
    2, 'strat-b', '2.0.0', 'INDIA_NSE_EQ', 'hold', 'backtest', 'backtest',
    'Insufficient out-of-sample performance',
    JSON.stringify({ gate: 'promotion', reason: 'no_winner', reviewedWindows: 1 }),
    2,
    now - 16_000,
  );

  manager.close();
}

export async function waitForOperatorUiReady(
  baseUrl: string,
  child: StartedOperatorChild,
  stdout: string[],
  stderr: string[],
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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

export async function startOperatorUiProcess(options: {
  dbPath: string;
  host?: string;
  password?: string;
  port?: number;
  username?: string;
  pollIntervalMs?: number;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  lockoutThreshold?: number;
  lockoutDurationMs?: number;
  readyTimeoutMs?: number;
  proofFaultSection?: OperatorUIProofFaultSection;
  proofFaultAfterSuccessCount?: number;
  proofFaultMessage?: string;
}): Promise<StartedOperatorUIProcess> {
  const port = options.port ?? await getFreePort();
  const host = options.host ?? '127.0.0.1';
  const password = options.password ?? 'test-password';
  const username = options.username ?? 'operator';
  const baseUrl = `http://${host}:${port}`;
  const stdout: string[] = [];
  const stderr: string[] = [];

  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    OPERATOR_UI_HOST: host,
    OPERATOR_UI_PORT: String(port),
    OPERATOR_UI_DB_PATH: options.dbPath,
    OPERATOR_UI_USERNAME: username,
    OPERATOR_UI_PASSWORD: password,
    OPERATOR_UI_POLL_INTERVAL_MS: String(options.pollIntervalMs ?? 1500),
    OPERATOR_UI_RATE_LIMIT_MAX: String(options.rateLimitMax ?? 20),
    OPERATOR_UI_RATE_LIMIT_WINDOW_MS: String(options.rateLimitWindowMs ?? 60_000),
    OPERATOR_UI_LOCKOUT_THRESHOLD: String(options.lockoutThreshold ?? 3),
    OPERATOR_UI_LOCKOUT_DURATION_MS: String(options.lockoutDurationMs ?? 120_000),
  };

  if (options.proofFaultSection) {
    env.OPERATOR_UI_TEST_FAIL_SECTION = options.proofFaultSection;
    env.OPERATOR_UI_TEST_FAIL_AFTER_SUCCESS_COUNT = String(options.proofFaultAfterSuccessCount ?? 1);
    if (options.proofFaultMessage) {
      env.OPERATOR_UI_TEST_FAIL_MESSAGE = options.proofFaultMessage;
    }
  }

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/operator-ui/index.ts'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => stdout.push(String(chunk)));
  child.stderr.on('data', chunk => stderr.push(String(chunk)));

  const started = { child, port, baseUrl, password, username, stdout, stderr, dbPath: options.dbPath };
  await waitForOperatorUiReady(baseUrl, child, stdout, stderr, options.readyTimeoutMs ?? 10_000);
  return started;
}

export async function stopOperatorUiProcess(processInfo: StartedOperatorUIProcess): Promise<void> {
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
