import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  basicAuthHeader,
  makeOperatorUiTempDir,
  seedOperatorUiDatabase,
  startOperatorUiProcess,
  stopOperatorUiProcess,
  type StartedOperatorUIProcess,
} from '../src/deployment/operator-ui-proof-support.js';

type StartedProcess = StartedOperatorUIProcess;

const tempDirs: string[] = [];
const startedProcesses: StartedProcess[] = [];

function expectSharedShellHtml(html: string, activeHref?: string): void {
  expect(html).toContain('class="console-shell"');
  expect(html).toContain('data-shell-status-strip');
  expect(html).toContain('data-shell-status-key="market"');
  expect(html).toContain('data-shell-status-key="execution"');
  expect(html).toContain('data-shell-status-key="broker"');
  expect(html).toContain('data-shell-status-key="risk"');
  expect(html).toContain('data-shell-status-key="freshness"');
  expect(html).toContain('Operator Console Navigation');
  if (activeHref) {
    expect(html).toContain(`href="${activeHref}" data-active="true" aria-current="page"`);
  }
}

function expectExplainabilityHierarchy(html: string): void {
  expect(html).toContain('<h3>What</h3>');
  expect(html).toContain('<h3>Why</h3>');
  expect(html).toContain('<h3>Evidence</h3>');
}

function makeTempDir(): string {
  const dir = makeOperatorUiTempDir('operator-ui-e2e-');
  tempDirs.push(dir);
  return dir;
}

async function startTrackedOperatorUiProcess(options: Parameters<typeof startOperatorUiProcess>[0]): Promise<StartedProcess> {
  const app = await startOperatorUiProcess(options);
  startedProcesses.push(app);
  return app;
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

    const app = await startTrackedOperatorUiProcess({ dbPath, rateLimitMax: 50 });
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
    expectSharedShellHtml(html, '/');
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
    expect(html).toContain('/decision?id=1');
    expect(html).toContain('/strategy?strategyId=strat-a&strategyVersion=1.0.0');
    expect(html).toContain('/strategy?strategyId=strat-b&strategyVersion=2.0.0');
    expect(html).toContain('/backtest?runId=1');
    expect(html).toContain('/backtest?runId=2');
    expect(html).toContain('/api/refresh');
    expect(html).toContain('/api/health');
    expectExplainabilityHierarchy(html);

    for (const [route, activeHref, expectedCopy] of [
      ['/positions', '/positions', 'Positions &amp; Exposure'],
      ['/strategies', '/strategies', 'Strategies'],
      ['/decisions', '/decisions', 'Decision Ledger'],
      ['/governance', '/governance', 'Governance &amp; Backtests'],
      ['/system-health', '/system-health', 'System Health'],
    ] as const) {
      const response = await fetch(`${app.baseUrl}${route}`, {
        headers: { Authorization: authHeader },
      });
      const routeHtml = await response.text();
      expect(response.status).toBe(200);
      expectSharedShellHtml(routeHtml, activeHref);
      expectExplainabilityHierarchy(routeHtml);
      expect(routeHtml).toContain(expectedCopy);
      if (route === '/system-health') {
        expect(routeHtml).toContain('Health Summary');
        expect(routeHtml).toContain('Broker Token and Refresh Recovery');
        expect(routeHtml).toContain('Subsystem Evidence');
        expect(routeHtml).toContain('Operator Auth');
        expect(routeHtml).toContain('Request Upstox Token Refresh');
      }
    }

    const decisionResponse = await fetch(`${app.baseUrl}/decision?id=1`, {
      headers: { Authorization: authHeader },
    });
    const decisionHtml = await decisionResponse.text();
    expect(decisionResponse.status).toBe(200);
    expectSharedShellHtml(decisionHtml, '/decisions');
    expect(decisionHtml).toContain('Operator Decision Detail');
    expect(decisionHtml).toContain('trend_alignment');
    expect(decisionHtml).toContain('risk_budget_ok');
    expect(decisionHtml.indexOf('trend_alignment')).toBeLessThan(decisionHtml.indexOf('risk_budget_ok'));
    expect(decisionHtml).toContain('India research favored refinery strength ahead of earnings.');
    expect(decisionHtml).toContain('LLM agreed that refinery momentum and macro context supported approval.');
    expect(decisionHtml).toContain('deterministic_edge');
    expect(decisionHtml).toContain('india_research_support');
    expect(decisionHtml).toContain('Filled RELIANCE at the seeded limit price.');
    expect(decisionHtml).toContain('Current Position Snapshot');

    const noReasonDecisionResponse = await fetch(`${app.baseUrl}/decision?id=3`, {
      headers: { Authorization: authHeader },
    });
    const noReasonDecisionHtml = await noReasonDecisionResponse.text();
    expect(noReasonDecisionResponse.status).toBe(200);
    expectSharedShellHtml(noReasonDecisionHtml, '/decisions');
    expect(noReasonDecisionHtml).toContain('No decision reasons were persisted for this decision.');

    const strategyResponse = await fetch(`${app.baseUrl}/strategy?strategyId=strat-a&strategyVersion=1.0.0`, {
      headers: { Authorization: authHeader },
    });
    const strategyHtml = await strategyResponse.text();
    expect(strategyResponse.status).toBe(200);
    expectSharedShellHtml(strategyHtml, '/strategies');
    expect(strategyHtml).toContain('Operator Strategy Detail');
    expect(strategyHtml).toContain('Strategy A passed walk-forward thresholds');
    expect(strategyHtml).toContain('Evidence JSON');
    expect(strategyHtml).toContain('approvingReviewer');
    expect(strategyHtml).toContain('WF#1');
    expect(strategyHtml).toContain('/decision?id=1');
    expect(strategyHtml).toContain('/backtest?runId=1');
    expect(strategyHtml).toContain('Trial-A has the best risk-adjusted out-of-sample result and cleared promotion gates.');

    const noWinnerStrategyResponse = await fetch(`${app.baseUrl}/strategy?strategyId=strat-b&strategyVersion=2.0.0`, {
      headers: { Authorization: authHeader },
    });
    const noWinnerStrategyHtml = await noWinnerStrategyResponse.text();
    expect(noWinnerStrategyResponse.status).toBe(200);
    expectSharedShellHtml(noWinnerStrategyHtml, '/strategies');
    expect(noWinnerStrategyHtml).toContain('Insufficient out-of-sample performance');
    expect(noWinnerStrategyHtml).toContain('No trial met the minimum merged-score threshold for promotion.');

    const backtestResponse = await fetch(`${app.baseUrl}/backtest?runId=1`, {
      headers: { Authorization: authHeader },
    });
    const backtestHtml = await backtestResponse.text();
    expect(backtestResponse.status).toBe(200);
    expectSharedShellHtml(backtestHtml, '/governance');
    expect(backtestHtml).toContain('Operator Backtest Detail');
    expect(backtestHtml).toContain('Trial-A has the best risk-adjusted out-of-sample result and cleared promotion gates.');
    expect(backtestHtml).toContain('Trial #1');
    expect(backtestHtml).toContain('Candidate Params');
    expect(backtestHtml).toContain('artifacts/wf-001/winner.json');
    expect(backtestHtml).toContain('replaySessionId');
    expect(backtestHtml).toContain('Trial-B');

    const noWinnerBacktestResponse = await fetch(`${app.baseUrl}/backtest?runId=2`, {
      headers: { Authorization: authHeader },
    });
    const noWinnerBacktestHtml = await noWinnerBacktestResponse.text();
    expect(noWinnerBacktestResponse.status).toBe(200);
    expectSharedShellHtml(noWinnerBacktestHtml, '/governance');
    expect(noWinnerBacktestHtml).toContain('No winner selected for this run.');
    expect(noWinnerBacktestHtml).toContain('No selected trial evidence was persisted because this run has no winner context.');
    expect(noWinnerBacktestHtml).toContain('Trial-C');

    const malformedDecisionResponse = await fetch(`${app.baseUrl}/decision?id=abc`, {
      headers: { Authorization: authHeader },
    });
    expect(malformedDecisionResponse.status).toBe(400);
    const malformedDecisionHtml = await malformedDecisionResponse.text();
    expectSharedShellHtml(malformedDecisionHtml, '/decisions');
    expect(malformedDecisionHtml).toContain('Invalid decision id. Expected a positive integer.');

    const malformedStrategyResponse = await fetch(`${app.baseUrl}/strategy?strategyId=strat-a&strategyVersion=%20%20`, {
      headers: { Authorization: authHeader },
    });
    expect(malformedStrategyResponse.status).toBe(400);
    const malformedStrategyHtml = await malformedStrategyResponse.text();
    expectSharedShellHtml(malformedStrategyHtml, '/strategies');
    expect(malformedStrategyHtml).toContain('Invalid strategyVersion. Expected a non-empty string.');

    const malformedBacktestResponse = await fetch(`${app.baseUrl}/backtest?runId=not-a-number`, {
      headers: { Authorization: authHeader },
    });
    expect(malformedBacktestResponse.status).toBe(400);
    const malformedBacktestHtml = await malformedBacktestResponse.text();
    expectSharedShellHtml(malformedBacktestHtml, '/governance');
    expect(malformedBacktestHtml).toContain('Invalid runId. Expected a positive integer.');

    const missingDecisionResponse = await fetch(`${app.baseUrl}/decision?id=9999`, {
      headers: { Authorization: authHeader },
    });
    expect(missingDecisionResponse.status).toBe(404);
    const missingDecisionHtml = await missingDecisionResponse.text();
    expectSharedShellHtml(missingDecisionHtml, '/decisions');
    expect(missingDecisionHtml).toContain('No persisted decision detail exists for id=9999.');

    const missingStrategyResponse = await fetch(`${app.baseUrl}/strategy?strategyId=missing&strategyVersion=9.9.9`, {
      headers: { Authorization: authHeader },
    });
    expect(missingStrategyResponse.status).toBe(404);
    const missingStrategyHtml = await missingStrategyResponse.text();
    expectSharedShellHtml(missingStrategyHtml, '/strategies');
    expect(missingStrategyHtml).toContain('No persisted strategy detail exists for missing@9.9.9.');

    const missingBacktestResponse = await fetch(`${app.baseUrl}/backtest?runId=9999`, {
      headers: { Authorization: authHeader },
    });
    expect(missingBacktestResponse.status).toBe(404);
    const missingBacktestHtml = await missingBacktestResponse.text();
    expectSharedShellHtml(missingBacktestHtml, '/governance');
    expect(missingBacktestHtml).toContain('No persisted backtest run detail exists for runId=9999.');

    const refreshResponse = await fetch(`${app.baseUrl}/api/refresh`, {
      headers: { Authorization: authHeader },
    });
    expect(refreshResponse.status).toBe(200);
    expect(refreshResponse.headers.get('content-type')).toContain('application/json');
    const refreshPayload = await refreshResponse.json();
    expect(refreshPayload.dbAvailable).toBe(true);
    expect(refreshPayload.shellStatusHtml).toContain('data-shell-status-strip');
    expect(refreshPayload.shellStatusHtml).toContain('data-shell-status-key="freshness"');
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
    expect(refreshPayload.sections.walkForwardLeaderboard.count).toBe(2);
    expect(refreshPayload.sections.walkForwardLeaderboard.data[0]).toMatchObject({
      label: 'WF-002',
      strategyId: 'strat-b',
      selectionStrategy: 'threshold',
    });
    expect(refreshPayload.sections.walkForwardLeaderboard.data[1]).toMatchObject({
      label: 'WF-001',
      strategyId: 'strat-a',
      selectionStrategy: 'composite',
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
    expect(apiHealth.detailReadModelBootstrap).toMatchObject({
      status: 'ready',
      attempts: 1,
      failures: 0,
      successes: 1,
    });
    expect(apiHealth.dbOpenBootstrap).toMatchObject({
      status: 'ready',
      attempts: 1,
      recoveredAfterRetry: false,
      lastError: null,
    });
    expect(apiHealth.detailReadModelBootstrap.lastError).toBeNull();
    expect(apiHealth.sections.summaryCards).toMatchObject({ status: 'ok' });
    expect(apiHealth.sections.summaryCards.count).toBeGreaterThanOrEqual(9);
    expect(apiHealth.sections.recentDecisions).toMatchObject({ status: 'ok', count: 3 });
    expect(apiHealth.sections.strategyPerformance).toMatchObject({ status: 'ok', count: 2 });
    expect(apiHealth.sections.tickerPerformance).toMatchObject({ status: 'ok' });
    expect(apiHealth.sections.lifecycle).toMatchObject({ status: 'ok', count: 2 });

    const systemHealthResponse = await fetch(`${app.baseUrl}/system-health`, {
      headers: { Authorization: authHeader },
    });
    expect(systemHealthResponse.status).toBe(200);
    const systemHealthHtml = await systemHealthResponse.text();
    expectSharedShellHtml(systemHealthHtml, '/system-health');
    expectExplainabilityHierarchy(systemHealthHtml);
    expect(systemHealthHtml).toContain('Health Summary');
    expect(systemHealthHtml).toContain('Broker Token and Refresh Recovery');
    expect(systemHealthHtml).toContain('Subsystem Evidence');
    expect(systemHealthHtml).toContain('Operator Auth');
    expect(systemHealthHtml).toContain('Database Open Bootstrap');
    expect(systemHealthHtml).toContain('Detail Read Model Bootstrap');
  });

  it('preserves last-known dashboard rows as stale after a later live refresh failure', async () => {
    const tmpDir = makeTempDir();
    const dbPath = path.join(tmpDir, 'operator-ui-stale-transition.db');
    seedOperatorUiDatabase(dbPath);

    const app = await startTrackedOperatorUiProcess({
      dbPath,
      proofFaultSection: 'summaryCards',
      proofFaultAfterSuccessCount: 2,
      proofFaultMessage: 'Injected summaryCards refresh failure for integration test: authorization=proof-secret-token',
    });
    const authHeader = basicAuthHeader(app.username, app.password);

    const dashboardResponse = await fetch(`${app.baseUrl}/`, {
      headers: { Authorization: authHeader },
    });
    expect(dashboardResponse.status).toBe(200);

    const firstRefreshResponse = await fetch(`${app.baseUrl}/api/refresh`, {
      headers: { Authorization: authHeader },
    });
    expect(firstRefreshResponse.status).toBe(200);
    const firstRefreshPayload = await firstRefreshResponse.json();
    expect(firstRefreshPayload.sections.summaryCards.state).toBe('ok');
    expect(firstRefreshPayload.sections.summaryCards.count).toBeGreaterThanOrEqual(10);

    const secondRefreshResponse = await fetch(`${app.baseUrl}/api/refresh`, {
      headers: { Authorization: authHeader },
    });
    expect(secondRefreshResponse.status).toBe(200);
    const secondRefreshPayload = await secondRefreshResponse.json();
    expect(secondRefreshPayload.sections.summaryCards.state).toBe('stale');
    expect(secondRefreshPayload.sections.summaryCards.count).toBe(firstRefreshPayload.sections.summaryCards.count);
    expect(secondRefreshPayload.sections.summaryCards.isCachedData).toBe(true);
    expect(secondRefreshPayload.sections.summaryCards.lastFetchedAt).toBe(firstRefreshPayload.sections.summaryCards.lastFetchedAt);
    expect(secondRefreshPayload.sections.summaryCards.stalenessMs).toBeGreaterThanOrEqual(0);
    expect(secondRefreshPayload.sections.summaryCards.errorMessage).toContain('authorization=[redacted]');
    expect(secondRefreshPayload.sections.summaryCards.errorMessage).not.toContain('proof-secret-token');
    expect(secondRefreshPayload.shellStatusHtml).toContain('data-shell-status-tone="warning"');
    expect(secondRefreshPayload.sections.summaryCards.html).toContain('Showing last known data');
    expect(secondRefreshPayload.sections.summaryCards.html).toContain('data-section-state="stale"');
    expect(secondRefreshPayload.sections.strategyPerformance.state).toBe('ok');

    const staleDashboardResponse = await fetch(`${app.baseUrl}/`, {
      headers: { Authorization: authHeader },
    });
    const staleDashboardHtml = await staleDashboardResponse.text();
    expect(staleDashboardResponse.status).toBe(200);
    expect(staleDashboardHtml).toContain('Showing last known data');
    expect(staleDashboardHtml).toContain('data-section-state="stale"');
    expect(staleDashboardHtml).toContain('data-dashboard-section="summaryCards"');
  });

  it('starts in degraded mode when the operator database cannot be opened and reports truthful failure surfaces', async () => {
    const tmpDir = makeTempDir();
    const missingDbPath = path.join(tmpDir, 'missing-operator-ui.db');
    const app = await startTrackedOperatorUiProcess({ dbPath: missingDbPath });
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

    const systemHealthResponse = await fetch(`${app.baseUrl}/system-health`, {
      headers: { Authorization: authHeader },
    });
    expect(systemHealthResponse.status).toBe(200);
    const systemHealthHtml = await systemHealthResponse.text();
    expectSharedShellHtml(systemHealthHtml, '/system-health');
    expectExplainabilityHierarchy(systemHealthHtml);
    expect(systemHealthHtml).toContain('Degraded:');
    expect(systemHealthHtml).toContain('Health Summary');
    expect(systemHealthHtml).toContain('data-section-state="error"');
    expect(systemHealthHtml).toContain('Request Upstox Token Refresh');

    for (const [route, activeHref, expectedAction] of [
      ['/decision?id=1', '/decisions', 'Back to decision ledger'],
      ['/strategy?strategyId=strat-a&strategyVersion=1.0.0', '/strategies', 'Back to strategies'],
      ['/backtest?runId=1', '/governance', 'Back to governance'],
    ] as const) {
      const response = await fetch(`${app.baseUrl}${route}`, {
        headers: { Authorization: authHeader },
      });
      const body = await response.text();
      expect(response.status).toBe(503);
      expectSharedShellHtml(body, activeHref);
      expect(body).toContain('Unavailable');
      expect(body).toContain(expectedAction);
    }

    const apiHealthResponse = await fetch(`${app.baseUrl}/api/health`, {
      headers: { Authorization: authHeader },
    });
    expect(apiHealthResponse.status).toBe(200);
    const apiHealth = await apiHealthResponse.json();
    expect(apiHealth.status).toBe('degraded');
    expect(apiHealth.dbConnected).toBe(false);
    expect(apiHealth.dbOpenBootstrap).toMatchObject({
      status: 'failed',
      attempts: 3,
      recoveredAfterRetry: false,
    });
    expect(String(apiHealth.dbOpenBootstrap.lastError)).not.toBe('null');
    expect(apiHealth.sections.summaryCards.status).toBe('unavailable');
  });

  it('surfaces 429 rate limiting through the live authenticated API', async () => {
    const tmpDir = makeTempDir();
    const dbPath = path.join(tmpDir, 'operator-ui-rate-limit.db');
    seedOperatorUiDatabase(dbPath);

    const app = await startTrackedOperatorUiProcess({
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
