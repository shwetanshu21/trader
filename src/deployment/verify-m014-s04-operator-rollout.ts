#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  basicAuthHeader,
  buildOperatorUiRouteUrl,
  DEFAULT_OPERATOR_UI_ROLLOUT_BASE_URL,
  OPERATOR_UI_PROOF_ARTIFACT_ROOT,
  resolveOperatorUiRolloutTarget,
  type OperatorUIRolloutTarget,
} from './operator-ui-proof-support.js';

type AssertionResult = {
  name: string;
  pass: boolean;
  detail: string;
};

export type OperatorUiRolloutCliOptions = {
  baseUrl?: string;
  username: string;
  password: string;
  holdOpenMs: number;
  artifactRoot: string;
};

export type OperatorUiRolloutArtifact = {
  harness: string;
  completedAt: string;
  verdict: 'PASS' | 'FAIL';
  totalAssertions: number;
  passed: number;
  failed: number;
  target: {
    verificationMode: OperatorUIRolloutTarget['verificationMode'];
    baseUrl: string;
    routePrefix: string;
    authScheme: 'basic';
    dbConnected: boolean;
    observedHealthStatus: number;
    observedRuntimeStatus: string;
  };
  routeCoverageMode: 'healthy' | 'degraded';
  surfacesTested: string[];
  authTruthfulness: {
    unauthenticatedStatus: number;
    unauthenticatedRealm: string | null;
    wrongCredentialsStatus: number;
    wrongCredentialsMessage: string | null;
  };
  apiHealth: {
    status: number;
    runtimeStatus: string;
    dbConnected: boolean;
    sectionKeys: string[];
  };
  assertions: AssertionResult[];
};

const DEFAULT_USERNAME = 'operator';
const DEFAULT_HOLD_OPEN_MS = 0;
const HARNESS_NAME = 'M014/S04 operator rollout proof';

const assertions: AssertionResult[] = [];
const logLines: string[] = [];

function log(message: string): void {
  console.log(message);
  logLines.push(message);
}

function assert(name: string, condition: boolean, detail: string): void {
  assertions.push({ name, pass: condition, detail });
  log(condition ? `  ✅ PASS: ${name}` : `  ❌ FAIL: ${name} — ${detail}`);
}

export function parseRolloutProofArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): OperatorUiRolloutCliOptions {
  const options: OperatorUiRolloutCliOptions = {
    baseUrl: undefined,
    username: env.OPERATOR_UI_USERNAME?.trim() || DEFAULT_USERNAME,
    password: env.OPERATOR_UI_PASSWORD?.trim() || '',
    holdOpenMs: DEFAULT_HOLD_OPEN_MS,
    artifactRoot: OPERATOR_UI_PROOF_ARTIFACT_ROOT,
  };

  for (const arg of argv) {
    if (arg.startsWith('--base-url=')) {
      options.baseUrl = arg.slice('--base-url='.length);
    } else if (arg.startsWith('--username=')) {
      options.username = arg.slice('--username='.length);
    } else if (arg.startsWith('--password=')) {
      options.password = arg.slice('--password='.length);
    } else if (arg.startsWith('--hold-open-ms=')) {
      options.holdOpenMs = Number(arg.slice('--hold-open-ms='.length));
    } else if (arg.startsWith('--artifact-root=')) {
      options.artifactRoot = arg.slice('--artifact-root='.length);
    }
  }

  if (!options.username.trim()) {
    throw new Error('username must be non-empty');
  }
  if (!options.password.trim()) {
    throw new Error('password must be provided via --password or OPERATOR_UI_PASSWORD');
  }
  if (!Number.isFinite(options.holdOpenMs) || options.holdOpenMs < 0) {
    throw new Error(`Invalid --hold-open-ms value: ${options.holdOpenMs}`);
  }
  if (!options.artifactRoot.trim()) {
    throw new Error('artifactRoot must be non-empty');
  }

  if (options.baseUrl) {
    resolveOperatorUiRolloutTarget(options.baseUrl);
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
  const bodyText = await response.text();
  try {
    return { status: response.status, body: JSON.parse(bodyText), headers: response.headers };
  } catch {
    throw new Error(`Malformed JSON from ${url}: ${bodyText.slice(0, 300)}`);
  }
}

function dashboardRouteRef(target: OperatorUIRolloutTarget, routePath: string): string {
  const normalizedPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${target.routePrefix}${normalizedPath}` || '/';
}

function healthyDashboardAssertions(target: OperatorUIRolloutTarget, dashboardHtml: string, authHeader: string): Promise<void>[] {
  assert('dashboard HTML contains operator console shell', dashboardHtml.includes('Operator Console') && dashboardHtml.includes('Operator Console Navigation'), 'dashboard shell copy missing');
  assert('dashboard HTML links to canonical detail and refresh routes', [
    dashboardRouteRef(target, '/decision?id=1'),
    dashboardRouteRef(target, '/strategy?strategyId=strat-a&strategyVersion=1.0.0'),
    dashboardRouteRef(target, '/backtest?runId=1'),
    dashboardRouteRef(target, '/api/refresh'),
    dashboardRouteRef(target, '/api/health'),
  ].every(snippet => dashboardHtml.includes(snippet)), 'dashboard missing one or more canonical links');

  return [
    (async () => {
      const decision = await fetchText(buildOperatorUiRouteUrl(target, '/decision?id=1'), authHeader);
      assert('decision detail returns 200', decision.status === 200, `status=${decision.status}`);
      assert('decision detail preserves evidence hierarchy', ['Operator Decision Detail', 'Decision Summary', 'Rationale', 'Research Evidence', 'Hybrid Scoring', 'Execution Outcome'].every(snippet => decision.body.includes(snippet)), 'decision detail missing expected hierarchy');
    })(),
    (async () => {
      const strategy = await fetchText(buildOperatorUiRouteUrl(target, '/strategy?strategyId=strat-a&strategyVersion=1.0.0'), authHeader);
      assert('strategy detail returns 200', strategy.status === 200, `status=${strategy.status}`);
      assert('strategy detail preserves explainability hierarchy', ['Operator Strategy Detail', '<h3>What</h3>', '<h3>Why</h3>', '<h3>Evidence</h3>'].every(snippet => strategy.body.includes(snippet)), 'strategy detail missing expected hierarchy');
    })(),
    (async () => {
      const backtest = await fetchText(buildOperatorUiRouteUrl(target, '/backtest?runId=1'), authHeader);
      assert('backtest detail returns 200', backtest.status === 200, `status=${backtest.status}`);
      assert('backtest detail preserves selection evidence hierarchy', ['Operator Backtest Detail', 'Backtest Summary', 'Selection Rationale', 'Selected Trial', 'Per-Window Evidence'].every(snippet => backtest.body.includes(snippet)), 'backtest detail missing expected hierarchy');
    })(),
    (async () => {
      const malformedDecision = await fetchText(buildOperatorUiRouteUrl(target, '/decision?id=abc'), authHeader);
      assert('malformed decision route returns 400', malformedDecision.status === 400, `status=${malformedDecision.status}`);
      assert('malformed decision route message is truthful', malformedDecision.body.includes('Invalid decision id. Expected a positive integer.'), 'missing malformed decision copy');
    })(),
    (async () => {
      const missingDecision = await fetchText(buildOperatorUiRouteUrl(target, '/decision?id=9999'), authHeader);
      assert('missing decision route returns 404', missingDecision.status === 404, `status=${missingDecision.status}`);
      assert('missing decision route message is truthful', missingDecision.body.includes('No persisted decision detail exists for id=9999.'), 'missing missing-decision copy');
    })(),
  ];
}

function degradedDashboardAssertions(target: OperatorUIRolloutTarget, dashboardHtml: string, authHeader: string): Promise<void>[] {
  assert('degraded dashboard stays truthful', dashboardHtml.includes('Database Unavailable'), 'degraded dashboard copy missing');

  return [
    (async () => {
      const decision = await fetchText(buildOperatorUiRouteUrl(target, '/decision?id=1'), authHeader);
      assert('degraded decision route returns 503', decision.status === 503, `status=${decision.status}`);
      assert('degraded decision route shows unavailable copy', decision.body.includes('Unavailable') && decision.body.includes('Back to decision ledger'), 'decision degraded copy missing');
    })(),
    (async () => {
      const strategy = await fetchText(buildOperatorUiRouteUrl(target, '/strategy?strategyId=strat-a&strategyVersion=1.0.0'), authHeader);
      assert('degraded strategy route returns 503', strategy.status === 503, `status=${strategy.status}`);
      assert('degraded strategy route shows unavailable copy', strategy.body.includes('Unavailable') && strategy.body.includes('Back to strategies'), 'strategy degraded copy missing');
    })(),
    (async () => {
      const backtest = await fetchText(buildOperatorUiRouteUrl(target, '/backtest?runId=1'), authHeader);
      assert('degraded backtest route returns 503', backtest.status === 503, `status=${backtest.status}`);
      assert('degraded backtest route shows unavailable copy', backtest.body.includes('Unavailable') && backtest.body.includes('Back to governance'), 'backtest degraded copy missing');
    })(),
  ];
}

export async function runOperatorUiRolloutProof(options: OperatorUiRolloutCliOptions): Promise<{ artifactPath: string; logPath: string; artifact: OperatorUiRolloutArtifact }> {
  assertions.length = 0;
  logLines.length = 0;

  const target = resolveOperatorUiRolloutTarget(options.baseUrl);
  const authHeader = basicAuthHeader(options.username, options.password);
  const surfacesTested = [
    buildOperatorUiRouteUrl(target, '/health'),
    buildOperatorUiRouteUrl(target, '/'),
    buildOperatorUiRouteUrl(target, '/api/refresh'),
    buildOperatorUiRouteUrl(target, '/api/health'),
    buildOperatorUiRouteUrl(target, '/decision?id=1'),
    buildOperatorUiRouteUrl(target, '/strategy?strategyId=strat-a&strategyVersion=1.0.0'),
    buildOperatorUiRouteUrl(target, '/backtest?runId=1'),
  ];

  log('══════════════════════════════════════════════════════════');
  log('  M014/S04 — Operator UI Rollout Proof');
  log('══════════════════════════════════════════════════════════');
  log(`Target mode: ${target.verificationMode}`);
  log(`Target base URL: ${target.baseUrl || DEFAULT_OPERATOR_UI_ROLLOUT_BASE_URL}`);
  log('');
  log('── Phase 1: Liveness + auth truthfulness ──');

  const liveness = await fetchJson(buildOperatorUiRouteUrl(target, '/health'));
  assert('/health returns truthful operator-ui liveness status', [200, 503].includes(liveness.status), `status=${liveness.status}`);
  assert('/health body identifies operator-ui', liveness.body.service === 'operator-ui', JSON.stringify(liveness.body));
  assert('/health body exposes dbConnected boolean', typeof liveness.body.dbConnected === 'boolean', JSON.stringify(liveness.body));

  const unauthenticatedDashboard = await fetchJson(buildOperatorUiRouteUrl(target, '/'));
  assert('unauthenticated dashboard returns 401', unauthenticatedDashboard.status === 401, `status=${unauthenticatedDashboard.status}`);
  assert('unauthenticated dashboard advertises Basic auth realm', (unauthenticatedDashboard.headers.get('www-authenticate') ?? '').includes('Operator Console'), String(unauthenticatedDashboard.headers.get('www-authenticate')));

  const wrongCredentials = await fetchJson(buildOperatorUiRouteUrl(target, '/api/health'), basicAuthHeader(options.username, `${options.password}--wrong`));
  assert('wrong credentials return 401', wrongCredentials.status === 401, `status=${wrongCredentials.status}`);
  assert('wrong credentials advertise Basic auth realm', (wrongCredentials.headers.get('www-authenticate') ?? '').includes('Operator Console'), String(wrongCredentials.headers.get('www-authenticate')));
  assert('wrong credentials message is truthful', typeof wrongCredentials.body.error === 'string' && wrongCredentials.body.error.includes('attempt(s) remaining before lockout'), JSON.stringify(wrongCredentials.body));

  log('');
  log('── Phase 2: Authenticated route contract ──');

  const dashboard = await fetchText(buildOperatorUiRouteUrl(target, '/'), authHeader);
  const refresh = await fetchJson(buildOperatorUiRouteUrl(target, '/api/refresh'), authHeader);
  const apiHealth = await fetchJson(buildOperatorUiRouteUrl(target, '/api/health'), authHeader);

  assert('authenticated /api/health returns 200', apiHealth.status === 200, `status=${apiHealth.status}`);
  assert('authenticated /api/health identifies operator-ui', apiHealth.body.service === 'operator-ui', JSON.stringify(apiHealth.body));
  assert('authenticated /api/health exposes section diagnostics', typeof apiHealth.body.sections === 'object' && apiHealth.body.sections !== null, JSON.stringify(apiHealth.body));

  const healthyMode = liveness.body.dbConnected === true;
  const routeCoverageMode = healthyMode ? 'healthy' : 'degraded';

  if (healthyMode) {
    assert('authenticated dashboard returns 200 when DB is connected', dashboard.status === 200, `status=${dashboard.status}`);
    assert('authenticated /api/refresh returns 200 when DB is connected', refresh.status === 200, `status=${refresh.status}`);
    assert('authenticated /api/refresh exposes dashboard sections', refresh.body.dbAvailable === true && typeof refresh.body.sections === 'object', JSON.stringify(refresh.body));
    await Promise.all(healthyDashboardAssertions(target, dashboard.body, authHeader));
  } else {
    assert('authenticated dashboard returns 503 when DB is unavailable', dashboard.status === 503, `status=${dashboard.status}`);
    assert('authenticated /api/refresh returns 503 when DB is unavailable', refresh.status === 503, `status=${refresh.status}`);
    assert('degraded /api/refresh reports database unavailable truthfully', refresh.body.error === 'Database unavailable', JSON.stringify(refresh.body));
    await Promise.all(degradedDashboardAssertions(target, dashboard.body, authHeader));
  }

  const passed = assertions.filter(entry => entry.pass).length;
  const failed = assertions.length - passed;
  const verdict: 'PASS' | 'FAIL' = failed === 0 ? 'PASS' : 'FAIL';

  fs.mkdirSync(options.artifactRoot, { recursive: true });
  const stamp = Date.now();
  const artifactPath = path.join(options.artifactRoot, `m014-s04-operator-rollout-${stamp}.json`);
  const logPath = path.join(options.artifactRoot, `m014-s04-operator-rollout-${stamp}.log`);

  const artifact: OperatorUiRolloutArtifact = {
    harness: HARNESS_NAME,
    completedAt: new Date().toISOString(),
    verdict,
    totalAssertions: assertions.length,
    passed,
    failed,
    target: {
      verificationMode: target.verificationMode,
      baseUrl: target.baseUrl,
      routePrefix: target.routePrefix,
      authScheme: 'basic',
      dbConnected: Boolean(liveness.body.dbConnected),
      observedHealthStatus: liveness.status,
      observedRuntimeStatus: typeof apiHealth.body.status === 'string' ? apiHealth.body.status : 'unknown',
    },
    routeCoverageMode,
    surfacesTested,
    authTruthfulness: {
      unauthenticatedStatus: unauthenticatedDashboard.status,
      unauthenticatedRealm: unauthenticatedDashboard.headers.get('www-authenticate'),
      wrongCredentialsStatus: wrongCredentials.status,
      wrongCredentialsMessage: wrongCredentials.body?.error ?? null,
    },
    apiHealth: {
      status: apiHealth.status,
      runtimeStatus: typeof apiHealth.body.status === 'string' ? apiHealth.body.status : 'unknown',
      dbConnected: Boolean(apiHealth.body.dbConnected),
      sectionKeys: Object.keys(apiHealth.body.sections ?? {}),
    },
    assertions: [...assertions],
  };

  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');
  fs.writeFileSync(logPath, `${logLines.join('\n')}\n`, 'utf8');

  log(`\nArtifact written: ${artifactPath}`);
  log(`Log written: ${logPath}`);
  log(`\n${verdict}: ${passed}/${passed + failed} assertions passed`);

  if (options.holdOpenMs > 0) {
    log(`Holding verification open for ${options.holdOpenMs} ms at ${target.baseUrl}/`);
    await new Promise(resolve => setTimeout(resolve, options.holdOpenMs));
  }

  if (failed > 0) {
    throw new Error(`Rollout proof failed with ${failed} assertion(s). See ${artifactPath}`);
  }

  return { artifactPath, logPath, artifact };
}

export async function main(argv = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Promise<void> {
  const options = parseRolloutProofArgs(argv, env);
  await runOperatorUiRolloutProof(options);
}

if (process.argv[1]?.endsWith('verify-m014-s04-operator-rollout.ts')) {
  main().catch((error) => {
    console.error(`\n❌ FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
