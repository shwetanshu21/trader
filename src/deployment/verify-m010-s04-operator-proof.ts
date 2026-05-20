#!/usr/bin/env node
// ── M010/S04 — Operator UI final-assembly proof harness ──
// Seeds a file-backed operator DB, boots the real src/operator-ui/index.ts
// entrypoint, proves authenticated HTML/JSON/detail routes, forces one live
// refresh degradation into explicit stale state, and writes a durable artifact.

import fs from 'node:fs';
import path from 'node:path';
import {
  basicAuthHeader,
  makeOperatorUiTempDir,
  seedOperatorUiDatabase,
  startOperatorUiProcess,
  stopOperatorUiProcess,
  type StartedOperatorUIProcess,
} from './operator-ui-proof-support.js';

const ARTIFACT_ROOT = 'data/artifacts/operator-ui-proof';
const DEFAULT_PORT: number | null = null;
const DEFAULT_USERNAME = 'operator';
const DEFAULT_PASSWORD = 'proof-password';
const DEFAULT_HOLD_OPEN_MS = 0;

type AssertionResult = {
  name: string;
  pass: boolean;
  detail: string;
};

const assertions: AssertionResult[] = [];
const logLines: string[] = [];

function log(message: string): void {
  console.log(message);
  logLines.push(message);
}

function assert(name: string, condition: boolean, detail: string): void {
  assertions.push({ name, pass: condition, detail });
  if (condition) {
    log(`  ✅ PASS: ${name}`);
    return;
  }
  log(`  ❌ FAIL: ${name} — ${detail}`);
}

function parseArgs(argv: string[]): {
  port: number | null;
  username: string;
  password: string;
  holdOpenMs: number;
} {
  const options = {
    port: DEFAULT_PORT,
    username: DEFAULT_USERNAME,
    password: DEFAULT_PASSWORD,
    holdOpenMs: DEFAULT_HOLD_OPEN_MS,
  };

  for (const arg of argv) {
    if (arg.startsWith('--port=')) {
      options.port = Number(arg.slice('--port='.length));
    } else if (arg.startsWith('--username=')) {
      options.username = arg.slice('--username='.length);
    } else if (arg.startsWith('--password=')) {
      options.password = arg.slice('--password='.length);
    } else if (arg.startsWith('--hold-open-ms=')) {
      options.holdOpenMs = Number(arg.slice('--hold-open-ms='.length));
    }
  }

  if (options.port !== null && (!Number.isFinite(options.port) || options.port < 1 || options.port > 65535)) {
    throw new Error(`Invalid --port value: ${options.port}`);
  }
  if (!Number.isFinite(options.holdOpenMs) || options.holdOpenMs < 0) {
    throw new Error(`Invalid --hold-open-ms value: ${options.holdOpenMs}`);
  }
  if (!options.username.trim()) {
    throw new Error('username must be non-empty');
  }
  if (!options.password.trim()) {
    throw new Error('password must be non-empty');
  }

  return options;
}

async function fetchText(url: string, authHeader?: string): Promise<{ status: number; body: string; headers: Headers }> {
  const response = await fetch(url, {
    headers: authHeader ? { Authorization: authHeader } : undefined,
  });
  return { status: response.status, body: await response.text(), headers: response.headers };
}

async function fetchJson(url: string, authHeader?: string): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(url, {
    headers: authHeader ? { Authorization: authHeader } : undefined,
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text), headers: response.headers };
  } catch {
    throw new Error(`Malformed JSON from ${url}: ${text.slice(0, 300)}`);
  }
}

function newestFailureSnippet(processInfo: StartedOperatorUIProcess): { stdoutTail: string; stderrTail: string } {
  return {
    stdoutTail: processInfo.stdout.join('').slice(-4000),
    stderrTail: processInfo.stderr.join('').slice(-4000),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  log('══════════════════════════════════════════════════════════');
  log('  M010/S04 — Operator UI Final-Assembly Proof');
  log('══════════════════════════════════════════════════════════');

  const tmpDir = makeOperatorUiTempDir('operator-ui-proof-');
  const dbPath = path.join(tmpDir, 'operator-ui-proof.db');
  seedOperatorUiDatabase(dbPath);
  log(`Seeded DB: ${dbPath}`);

  let app: StartedOperatorUIProcess | null = null;
  let artifactPath = '';
  let logPath = '';

  try {
    app = await startOperatorUiProcess({
      dbPath,
      username: options.username,
      password: options.password,
      port: options.port ?? undefined,
      pollIntervalMs: 1500,
      rateLimitMax: 100,
      proofFaultSection: 'summaryCards',
      proofFaultAfterSuccessCount: 3,
      proofFaultMessage: 'Injected summaryCards refresh failure for M010/S04 proof: authorization=proof-secret-token',
      readyTimeoutMs: 15_000,
    });

    const authHeader = basicAuthHeader(app.username, app.password);
    log(`Target: ${app.baseUrl}/`);
    log('');
    log('── Phase 1: Liveness + auth truthfulness ──');

    const liveness = await fetchJson(`${app.baseUrl}/health`);
    assert('/health returns 200', liveness.status === 200, `status=${liveness.status}`);
    assert('/health reports alive/dbConnected', liveness.body.status === 'alive' && liveness.body.dbConnected === true, JSON.stringify(liveness.body));

    const unauthenticatedDashboard = await fetchJson(`${app.baseUrl}/`);
    assert('unauthenticated dashboard returns 401', unauthenticatedDashboard.status === 401, `status=${unauthenticatedDashboard.status}`);
    assert('unauthenticated dashboard advertises Basic auth realm', (unauthenticatedDashboard.headers.get('www-authenticate') ?? '').includes('Operator Console'), String(unauthenticatedDashboard.headers.get('www-authenticate')));

    const wrongCredentials = await fetchJson(`${app.baseUrl}/api/health`, basicAuthHeader(app.username, 'wrong-password'));
    assert('wrong credentials return 403', wrongCredentials.status === 403, `status=${wrongCredentials.status}`);

    log('');
    log('── Phase 2: Dashboard + detail surfaces ──');

    const dashboard = await fetchText(`${app.baseUrl}/`, authHeader);
    assert('dashboard HTML returns 200', dashboard.status === 200, `status=${dashboard.status}`);
    assert('dashboard HTML contains operator sections',
      ['Operator Console', 'Strategy Performance', 'Recent Decisions', 'Governance History', 'Walk-Forward Leaderboard', 'RELIANCE', 'TCS', 'HDFC']
        .every(snippet => dashboard.body.includes(snippet)),
      'dashboard missing expected operator evidence');
    assert('dashboard HTML links to detail routes and refresh API',
      ['/decision?id=1', '/strategy?strategyId=strat-a&strategyVersion=1.0.0', '/backtest?runId=1', '/api/refresh', '/api/health']
        .every(snippet => dashboard.body.includes(snippet)),
      'dashboard missing one or more canonical links');

    const decision = await fetchText(`${app.baseUrl}/decision?id=1`, authHeader);
    assert('decision detail returns 200', decision.status === 200, `status=${decision.status}`);
    assert('decision detail shows joined evidence',
      ['Operator Decision Detail', 'trend_alignment', 'risk_budget_ok', 'India research favored refinery strength ahead of earnings.', 'LLM agreed that refinery momentum and macro context supported approval.', 'Current Position Snapshot']
        .every(snippet => decision.body.includes(snippet)),
      'decision detail missing evidence');

    const noReasonDecision = await fetchText(`${app.baseUrl}/decision?id=3`, authHeader);
    assert('decision detail renders no-reason empty state', noReasonDecision.body.includes('No decision reasons were persisted for this decision.'), 'missing no-reason copy');

    const strategy = await fetchText(`${app.baseUrl}/strategy?strategyId=strat-a&strategyVersion=1.0.0`, authHeader);
    assert('strategy detail returns 200', strategy.status === 200, `status=${strategy.status}`);
    assert('strategy detail shows governance and winner evidence',
      ['Operator Strategy Detail', 'Strategy A passed walk-forward thresholds', 'approvingReviewer', 'WF#1', '/decision?id=1', '/backtest?runId=1']
        .every(snippet => strategy.body.includes(snippet)),
      'strategy detail missing promotion evidence');

    const noWinnerStrategy = await fetchText(`${app.baseUrl}/strategy?strategyId=strat-b&strategyVersion=2.0.0`, authHeader);
    assert('strategy detail shows no-winner rationale',
      noWinnerStrategy.body.includes('No trial met the minimum merged-score threshold for promotion.'),
      'missing no-winner strategy rationale');

    const backtest = await fetchText(`${app.baseUrl}/backtest?runId=1`, authHeader);
    assert('backtest detail returns 200', backtest.status === 200, `status=${backtest.status}`);
    assert('backtest detail shows winner and trial evidence',
      ['Operator Backtest Detail', 'Trial-A has the best risk-adjusted out-of-sample result and cleared promotion gates.', 'Candidate Params', 'artifacts/wf-001/winner.json', 'Trial-B']
        .every(snippet => backtest.body.includes(snippet)),
      'missing backtest winner evidence');

    const noWinnerBacktest = await fetchText(`${app.baseUrl}/backtest?runId=2`, authHeader);
    assert('backtest detail shows no-winner empty state',
      noWinnerBacktest.body.includes('No winner selected for this run.')
        && noWinnerBacktest.body.includes('No selected trial evidence was persisted because this run has no winner context.'),
      'missing no-winner backtest copy');

    log('');
    log('── Phase 3: Negative inputs + refresh JSON ──');

    const malformedDecision = await fetchText(`${app.baseUrl}/decision?id=abc`, authHeader);
    assert('malformed decision id returns 400', malformedDecision.status === 400, `status=${malformedDecision.status}`);
    assert('malformed decision id message is truthful', malformedDecision.body.includes('Invalid decision id. Expected a positive integer.'), 'missing malformed decision copy');

    const missingDecision = await fetchText(`${app.baseUrl}/decision?id=9999`, authHeader);
    assert('missing decision returns 404', missingDecision.status === 404, `status=${missingDecision.status}`);
    assert('missing decision message is truthful', missingDecision.body.includes('No persisted decision detail exists for id=9999.'), 'missing not-found decision copy');

    const malformedStrategy = await fetchText(`${app.baseUrl}/strategy?strategyId=strat-a&strategyVersion=%20%20`, authHeader);
    assert('malformed strategy request returns 400', malformedStrategy.status === 400, `status=${malformedStrategy.status}`);

    const malformedBacktest = await fetchText(`${app.baseUrl}/backtest?runId=not-a-number`, authHeader);
    assert('malformed backtest request returns 400', malformedBacktest.status === 400, `status=${malformedBacktest.status}`);

    const refresh1 = await fetchJson(`${app.baseUrl}/api/refresh`, authHeader);
    assert('first /api/refresh returns 200', refresh1.status === 200, `status=${refresh1.status}`);
    assert('first /api/refresh reports healthy summary + strategy sections',
      refresh1.body.dbAvailable === true
        && refresh1.body.sections.summaryCards.state === 'ok'
        && refresh1.body.sections.summaryCards.count >= 8
        && refresh1.body.sections.strategyPerformance.state === 'ok'
        && refresh1.body.sections.walkForwardLeaderboard.count === 2,
      JSON.stringify(refresh1.body.sections));

    const apiHealth = await fetchJson(`${app.baseUrl}/api/health`, authHeader);
    assert('/api/health returns 200', apiHealth.status === 200, `status=${apiHealth.status}`);
    assert('/api/health reports healthy section counts pre-degradation',
      apiHealth.body.status === 'healthy'
        && apiHealth.body.sections.summaryCards?.status === 'ok'
        && apiHealth.body.sections.recentDecisions?.count === 3,
      JSON.stringify(apiHealth.body));

    log('');
    log('── Phase 4: Healthy → stale transition ──');

    const refresh2 = await fetchJson(`${app.baseUrl}/api/refresh`, authHeader);
    assert('second /api/refresh still returns 200 under section degradation', refresh2.status === 200, `status=${refresh2.status}`);
    assert('summary cards degrade to stale with cached rows preserved',
      refresh2.body.sections.summaryCards.state === 'stale'
        && refresh2.body.sections.summaryCards.count === refresh1.body.sections.summaryCards.count
        && refresh2.body.sections.summaryCards.isCachedData === true
        && refresh2.body.sections.summaryCards.lastFetchedAt === refresh1.body.sections.summaryCards.lastFetchedAt
        && typeof refresh2.body.sections.summaryCards.errorMessage === 'string',
      JSON.stringify(refresh2.body.sections.summaryCards));
    assert('stale diagnostics stay redacted in JSON',
      refresh2.body.sections.summaryCards.errorMessage.includes('authorization=[redacted]')
        && !refresh2.body.sections.summaryCards.errorMessage.includes('proof-secret-token'),
      String(refresh2.body.sections.summaryCards.errorMessage));
    assert('non-failing sections remain ok during stale transition',
      refresh2.body.sections.strategyPerformance.state === 'ok'
        && refresh2.body.sections.walkForwardLeaderboard.state === 'ok',
      JSON.stringify({
        strategyPerformance: refresh2.body.sections.strategyPerformance,
        walkForwardLeaderboard: refresh2.body.sections.walkForwardLeaderboard,
      }));

    const staleDashboard = await fetchText(`${app.baseUrl}/`, authHeader);
    assert('dashboard HTML still returns 200 after stale transition', staleDashboard.status === 200, `status=${staleDashboard.status}`);
    assert('dashboard HTML shows stale banner + section metadata',
      staleDashboard.body.includes('Showing last known data')
        && staleDashboard.body.includes('data-section-state="stale"')
        && staleDashboard.body.includes('data-dashboard-section="summaryCards"'),
      'dashboard did not expose stale section metadata');

    const apiHealthAfter = await fetchJson(`${app.baseUrl}/api/health`, authHeader);
    assert('/api/health reports summaryCards error after injected degradation',
      apiHealthAfter.body.sections.summaryCards?.status === 'error',
      JSON.stringify(apiHealthAfter.body.sections.summaryCards));

    const passed = assertions.filter(entry => entry.pass).length;
    const failed = assertions.length - passed;
    const verdict = failed === 0 ? 'PASS' : 'FAIL';

    fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });
    const stamp = Date.now();
    artifactPath = path.join(ARTIFACT_ROOT, `m010-s04-operator-proof-${stamp}.json`);
    logPath = path.join(ARTIFACT_ROOT, `m010-s04-operator-proof-${stamp}.log`);

    const processTails = newestFailureSnippet(app);
    const artifact = {
      harness: 'M010/S04 operator proof',
      completedAt: new Date().toISOString(),
      verdict,
      totalAssertions: assertions.length,
      passed,
      failed,
      browserTarget: {
        baseUrl: `${app.baseUrl}/`,
        username: app.username,
        port: app.port,
        authScheme: 'basic',
        staleStatePrepared: true,
      },
      surfacesTested: [
        '/health',
        '/',
        '/api/refresh',
        '/api/health',
        '/decision?id=1',
        '/decision?id=3',
        '/strategy?strategyId=strat-a&strategyVersion=1.0.0',
        '/strategy?strategyId=strat-b&strategyVersion=2.0.0',
        '/backtest?runId=1',
        '/backtest?runId=2',
      ],
      staleTransition: {
        section: 'summaryCards',
        firstState: refresh1.body.sections.summaryCards.state,
        secondState: refresh2.body.sections.summaryCards.state,
        cachedCount: refresh2.body.sections.summaryCards.count,
        redactedDiagnostic: refresh2.body.sections.summaryCards.errorMessage,
      },
      assertions,
      process: processTails,
    };

    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');
    fs.writeFileSync(logPath, `${logLines.join('\n')}\n`, 'utf8');
    log(`\nArtifact written: ${artifactPath}`);
    log(`Log written: ${logPath}`);

    if (options.holdOpenMs > 0) {
      log(`Holding verified operator UI open for ${options.holdOpenMs} ms at ${app.baseUrl}/`);
      await new Promise(resolve => setTimeout(resolve, options.holdOpenMs));
    }

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    if (app) {
      await stopOperatorUiProcess(app);
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
}

main().catch((error) => {
  console.error(`\n❌ FATAL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
