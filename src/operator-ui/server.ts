// ── Operator UI HTTP Server ──
// Standalone HTTP server for the authenticated operator console.
// Uses Node built-in `http` module — zero extra dependencies.

import http from 'node:http';
import type Database from 'better-sqlite3';
import type { OperatorUIConfig } from './config.js';
import type { Authenticator, AuthResult } from './auth.js';
import {
  WWW_AUTHENTICATE_HEADER,
  RETRY_AFTER_HEADER,
} from './auth.js';
import type { OperatorReadModel } from '../operator/operator-read-model.js';
import { OperatorDetailReadModel, OperatorDetailReadModelError } from '../operator/operator-detail-read-model.js';
import { DashboardPayloadAssembler, type DashboardPayload } from './dashboard-data.js';
import { renderStatusPage } from './render-utils.js';
import type { OperatorShellStatusViewModel, OperatorStatusItem, OperatorStatusTone } from './components/status-strip.js';
import { getBridgeAuthSummaryCard } from './bridge-auth-status.js';
import { renderBacktestDetailPage } from './pages/backtest-detail-page.js';
import { renderDashboardPage, renderDashboardSectionHtml, renderOverviewHero } from './pages/dashboard-page.js';
import { renderDecisionDetailPage } from './pages/decision-detail-page.js';
import { renderStrategyDetailPage } from './pages/strategy-detail-page.js';
import { renderPositionsPage } from './pages/positions-page.js';
import { renderStrategiesPage } from './pages/strategies-page.js';
import { renderDecisionsPage } from './pages/decisions-page.js';
import { renderGovernancePage } from './pages/governance-page.js';
import { renderSystemHealthPage, type OperatorSystemHealthViewModel } from './pages/system-health-page.js';
import { UpstoxTokenRefreshCoordinator } from '../upstox/token-refresh-coordinator.js';
import { getUpstoxTokenRefreshHealth } from '../upstox/token-refresh-status.js';

export interface OperatorUIServerOptions {
  config: OperatorUIConfig;
  authenticator: Authenticator;
  db: Database.Database | null;
  dbError: string | null;
  readModel: OperatorReadModel | null;
  dbOpenBootstrap?: DbOpenBootstrapState;
  detailReadModel?: OperatorDetailReadModel | null;
  detailReadModelFactory?: ((db: Database.Database) => OperatorDetailReadModel) | null;
  upstoxTokenRefreshCoordinator?: UpstoxTokenRefreshCoordinator | null;
}

interface DbOpenBootstrapState {
  status: 'ready' | 'recovered' | 'failed';
  attempts: number;
  recoveredAfterRetry: boolean;
  lastError: string | null;
}

interface DetailReadModelBootstrapState {
  status: 'ready' | 'retrying' | 'unavailable';
  attempts: number;
  successes: number;
  failures: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

export function createOperatorUIServer(options: OperatorUIServerOptions): http.Server {
  const { config, authenticator, db, dbError, readModel } = options;
  const dbOpenBootstrap: DbOpenBootstrapState = options.dbOpenBootstrap ?? {
    status: db !== null ? 'ready' : 'failed',
    attempts: 1,
    recoveredAfterRetry: false,
    lastError: db !== null ? null : dbError,
  };
  let detailReadModel = options.detailReadModel ?? null;
  const detailReadModelFactory = options.detailReadModelFactory ?? ((detailDb: Database.Database) => new OperatorDetailReadModel(detailDb));
  let detailReadModelInitError: string | null = null;
  const detailReadModelBootstrap: DetailReadModelBootstrapState = {
    status: detailReadModel !== null ? 'ready' : (db !== null && detailReadModelFactory !== null ? 'retrying' : 'unavailable'),
    attempts: 0,
    successes: detailReadModel !== null ? 1 : 0,
    failures: 0,
    lastAttemptAt: null,
    lastSuccessAt: detailReadModel !== null ? new Date().toISOString() : null,
    lastFailureAt: null,
    lastError: null,
  };
  const getDetailReadModel = (): OperatorDetailReadModel | null => {
    if (detailReadModel !== null) {
      detailReadModelBootstrap.status = 'ready';
      return detailReadModel;
    }
    if (db === null || detailReadModelFactory === null) {
      detailReadModelBootstrap.status = 'unavailable';
      return null;
    }
    detailReadModelBootstrap.attempts += 1;
    detailReadModelBootstrap.lastAttemptAt = new Date().toISOString();
    try {
      detailReadModel = detailReadModelFactory(db);
      detailReadModelInitError = null;
      detailReadModelBootstrap.status = 'ready';
      detailReadModelBootstrap.successes += 1;
      detailReadModelBootstrap.lastSuccessAt = detailReadModelBootstrap.lastAttemptAt;
      detailReadModelBootstrap.lastError = null;
      console.info('[operator-ui] Detail read model bootstrap succeeded.', JSON.stringify({
        event: 'detail-read-model-bootstrap',
        status: 'ready',
        attempts: detailReadModelBootstrap.attempts,
        successes: detailReadModelBootstrap.successes,
        failures: detailReadModelBootstrap.failures,
      }));
      return detailReadModel;
    } catch (err) {
      detailReadModelInitError = err instanceof Error ? err.message : String(err);
      detailReadModelBootstrap.status = 'retrying';
      detailReadModelBootstrap.failures += 1;
      detailReadModelBootstrap.lastFailureAt = detailReadModelBootstrap.lastAttemptAt;
      detailReadModelBootstrap.lastError = detailReadModelInitError;
      console.warn('[operator-ui] Detail read model unavailable during request bootstrap.', JSON.stringify({
        event: 'detail-read-model-bootstrap',
        status: 'retrying',
        attempts: detailReadModelBootstrap.attempts,
        successes: detailReadModelBootstrap.successes,
        failures: detailReadModelBootstrap.failures,
        error: detailReadModelInitError,
      }));
      return null;
    }
  };
  const dashboardPayloadAssembler = new DashboardPayloadAssembler();
  const buildShellStatusForPayload = (payload: DashboardPayload): OperatorShellStatusViewModel => buildOperatorShellStatus(payload);
  const buildShellStatusForRequest = (): OperatorShellStatusViewModel => buildShellStatusForPayload(
    dashboardPayloadAssembler.fetchDashboardPayload(readModel, dbError),
  );
  const corsOrigin = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}`;
  const upstoxTokenRefreshCoordinator = options.upstoxTokenRefreshCoordinator ?? new UpstoxTokenRefreshCoordinator();

  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Accept');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    try {
      switch (url.pathname) {
        case '/health':
          handleLiveness(res, db, dbError);
          return;

        case '/': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleDashboardHtml(res, dashboardPayloadAssembler, readModel, dbError, config.pollIntervalMs, buildShellStatusForRequest());
          return;
        }

        case '/positions': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleTopLevelDashboardPage(res, dashboardPayloadAssembler, readModel, dbError, (payload, options) => renderPositionsPage(payload, readModel?.getStrategyExposure() ?? [], options), buildShellStatusForRequest());
          return;
        }

        case '/strategies': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleTopLevelDashboardPage(res, dashboardPayloadAssembler, readModel, dbError, (payload, pageOptions) => renderStrategiesPage(payload, readModel?.getStrategyExposure() ?? [], pageOptions), buildShellStatusForRequest());
          return;
        }

        case '/decisions': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleTopLevelDashboardPage(res, dashboardPayloadAssembler, readModel, dbError, renderDecisionsPage, buildShellStatusForRequest());
          return;
        }

        case '/governance': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleTopLevelDashboardPage(res, dashboardPayloadAssembler, readModel, dbError, renderGovernancePage, buildShellStatusForRequest());
          return;
        }

        case '/system-health': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleSystemHealthHtml(res, config, db, dbError, authenticator, readModel, dbOpenBootstrap, detailReadModelBootstrap, buildShellStatusForRequest());
          return;
        }

        case '/system-health/upstox/token-refresh': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed', allowed: ['POST'] }));
            return;
          }
          void handleUpstoxTokenRefreshHtml(res, upstoxTokenRefreshCoordinator, buildShellStatusForRequest());
          return;
        }

        case '/decision': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleDecisionDetail(res, url, getDetailReadModel(), dbError ?? detailReadModelInitError, buildShellStatusForRequest());
          return;
        }

        case '/strategy': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleStrategyDetail(res, url, getDetailReadModel(), dbError ?? detailReadModelInitError, buildShellStatusForRequest());
          return;
        }

        case '/backtest': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleBacktestDetail(res, url, getDetailReadModel(), dbError ?? detailReadModelInitError, buildShellStatusForRequest());
          return;
        }

        case '/api/refresh': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleApiRefresh(res, dashboardPayloadAssembler, readModel, dbError, config.pollIntervalMs, buildShellStatusForPayload);
          return;
        }

        case '/api/health': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleApiHealth(res, config, db, dbError, authenticator, readModel, dbOpenBootstrap, detailReadModelBootstrap);
          return;
        }

        case '/api/upstox/token-refresh': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed', allowed: ['POST'] }));
            return;
          }
          void handleUpstoxTokenRefreshApi(res, upstoxTokenRefreshCoordinator);
          return;
        }

        default:
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));
          return;
      }
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : 'Unknown error';
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Internal server error',
        type: err instanceof Error ? err.name : 'Unknown',
        detail,
      }));
    }
  });
}

function verifyAuth(
  req: http.IncomingMessage,
  authenticator: Authenticator,
  res: http.ServerResponse,
): AuthResult {
  const clientIp = authenticator.extractClientIp(
    req.socket.remoteAddress,
    req.headers['x-forwarded-for'] as string | undefined,
  );
  const result = authenticator.authenticate(req.headers.authorization, clientIp);

  if (!result.ok) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (result.status === 401) headers[WWW_AUTHENTICATE_HEADER] = 'Basic realm="Operator Console"';
    if (result.status === 429) headers[RETRY_AFTER_HEADER] = '120';
    res.writeHead(result.status, headers);
    res.end(JSON.stringify({ error: result.message, status: result.status }));
  }

  return result;
}

function toneSeverity(tone: OperatorStatusTone): number {
  switch (tone) {
    case 'critical':
      return 3;
    case 'warning':
      return 2;
    case 'healthy':
      return 1;
    case 'unavailable':
    default:
      return 0;
  }
}

function latestKnownFetch(payload: DashboardPayload): string | null {
  const timestamps = [
    payload.summaryCards.lastFetchedAt,
    payload.strategyPerformance.lastFetchedAt,
    payload.tickerPerformance.lastFetchedAt,
    payload.decisionPerformance.lastFetchedAt,
    payload.lifecycleStates.lastFetchedAt,
    payload.governanceHistory.lastFetchedAt,
    payload.promotionHistory.lastFetchedAt,
    payload.walkForwardLeaderboard.lastFetchedAt,
    payload.researchLineage.lastFetchedAt,
    payload.overnightResearch.lastFetchedAt,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (timestamps.length === 0) return null;
  return timestamps.sort().at(-1) ?? null;
}

function buildOperatorShellStatus(payload: DashboardPayload): OperatorShellStatusViewModel {
  const summaryCards = payload.summaryCards.data;
  const bridgeCard = summaryCards.find(card => card.key === 'upstox_auth') ?? getBridgeAuthSummaryCard();
  const executionAttempts = summaryCards.find(card => card.key === 'total_execution_attempts');
  const latestFetch = latestKnownFetch(payload);

  const staleCount = [
    payload.summaryCards,
    payload.strategyPerformance,
    payload.tickerPerformance,
    payload.decisionPerformance,
    payload.lifecycleStates,
    payload.governanceHistory,
    payload.promotionHistory,
    payload.walkForwardLeaderboard,
    payload.researchLineage,
    payload.overnightResearch,
  ].filter(section => section.state === 'stale').length;
  const unavailableCount = [
    payload.summaryCards,
    payload.strategyPerformance,
    payload.tickerPerformance,
    payload.decisionPerformance,
    payload.lifecycleStates,
    payload.governanceHistory,
    payload.promotionHistory,
    payload.walkForwardLeaderboard,
    payload.researchLineage,
    payload.overnightResearch,
  ].filter(section => section.state === 'error' || section.state === 'unavailable').length;

  const freshness: OperatorStatusItem = !payload.dbAvailable
    ? {
        key: 'freshness',
        label: 'Freshness',
        tone: 'unavailable',
        summary: 'Unavailable',
        detail: payload.dbError ?? 'Operator database is unavailable, so no refresh freshness can be proven.',
        evidence: 'dashboard payload',
        asOf: payload.assembledAt,
      }
    : staleCount > 0
      ? {
          key: 'freshness',
          label: 'Freshness',
          tone: 'warning',
          summary: `${staleCount} stale section(s)`,
          detail: unavailableCount > 0
            ? `${unavailableCount} section(s) also failed or are unavailable.`
            : 'Showing last-known cached data for one or more sections.',
          evidence: 'dashboard section refresh metadata',
          asOf: latestFetch,
        }
      : unavailableCount > 0
        ? {
            key: 'freshness',
            label: 'Freshness',
            tone: 'critical',
            summary: `${unavailableCount} refresh issue(s)`,
            detail: 'One or more sections failed to refresh and no cached replacement was available.',
            evidence: 'dashboard section refresh metadata',
            asOf: latestFetch,
          }
        : {
            key: 'freshness',
            label: 'Freshness',
            tone: 'healthy',
            summary: 'Current',
            detail: 'All rendered dashboard sections refreshed without stale or unavailable flags.',
            evidence: 'dashboard section refresh metadata',
            asOf: latestFetch ?? payload.assembledAt,
          };

  const brokerDisplay = String(bridgeCard.display ?? 'Unknown');
  const brokerTone: OperatorStatusTone = brokerDisplay === 'Healthy'
    ? 'healthy'
    : brokerDisplay === 'Refresh pending' || brokerDisplay === 'Token present'
      ? 'warning'
      : brokerDisplay === 'Approval needed' || brokerDisplay === 'Refresh failed' || brokerDisplay === 'Token expired' || brokerDisplay === 'Token rejected'
        ? 'critical'
        : 'unavailable';
  const broker: OperatorStatusItem = {
    key: 'broker',
    label: 'Broker',
    tone: brokerTone,
    summary: brokerDisplay,
    detail: brokerTone === 'healthy'
      ? 'Upstox bridge authentication evidence is healthy.'
      : brokerTone === 'warning'
        ? 'Broker auth exists but operator intervention or refresh completion may still be required.'
        : brokerTone === 'critical'
          ? 'Broker authentication is degraded and may block live broker-backed activity.'
          : 'No trustworthy broker session proof is available from the operator surfaces.',
    evidence: bridgeCard.provenance?.sourceLabel ?? 'upstox auth summary card',
    asOf: bridgeCard.provenance ? new Date(bridgeCard.provenance.asOf).toISOString() : payload.assembledAt,
  };

  const recentExecutionStatuses = (payload.decisionPerformance.state === 'ok' || payload.decisionPerformance.state === 'stale')
    ? payload.decisionPerformance.data.map(row => row.executionStatus).filter((value): value is string => Boolean(value))
    : [];
  const totalExecutionAttempts = typeof executionAttempts?.value === 'number' ? executionAttempts.value : 0;
  const executionTone: OperatorStatusTone = recentExecutionStatuses.some(status => ['failed', 'error', 'rejected', 'cancelled'].includes(status))
    ? 'critical'
    : recentExecutionStatuses.some(status => ['pending', 'blocked', 'refused', 'skipped'].includes(status))
      ? 'warning'
      : recentExecutionStatuses.some(status => ['completed', 'filled'].includes(status))
        ? 'healthy'
        : totalExecutionAttempts > 0
          ? 'warning'
          : 'unavailable';
  const execution: OperatorStatusItem = {
    key: 'execution',
    label: 'Execution',
    tone: executionTone,
    summary: recentExecutionStatuses[0] ?? (totalExecutionAttempts > 0 ? `${totalExecutionAttempts} attempt(s) recorded` : 'Unavailable'),
    detail: recentExecutionStatuses.length > 0
      ? 'Execution posture is derived from persisted recent decision and execution outcome evidence, not an in-memory runtime mode flag.'
      : totalExecutionAttempts > 0
        ? 'Historical execution attempts exist, but the standalone operator UI cannot prove the current runtime execution mode.'
        : 'No persisted execution attempts exist yet, so current execution posture cannot be proven from operator evidence.',
    evidence: recentExecutionStatuses.length > 0 ? 'decision performance + execution attempts' : 'execution attempt summary card',
    asOf: payload.decisionPerformance.lastFetchedAt ?? (executionAttempts?.provenance ? new Date(executionAttempts.provenance.asOf).toISOString() : payload.assembledAt),
  };

  const market: OperatorStatusItem = {
    key: 'market',
    label: 'Market',
    tone: 'unavailable',
    summary: 'Unavailable',
    detail: 'This SSR operator UI does not persist the current scheduler market phase, so live market-state truth cannot be proven here yet.',
    evidence: 'no persisted scheduler phase on operator routes',
    asOf: payload.assembledAt,
  };

  const risk: OperatorStatusItem = {
    key: 'risk',
    label: 'Risk',
    tone: 'unavailable',
    summary: 'Unavailable',
    detail: 'No global execution-risk halt or guard surface is currently wired into the standalone operator UI payloads.',
    evidence: 'no persisted global risk posture on operator routes',
    asOf: payload.assembledAt,
  };

  const items: OperatorStatusItem[] = [market, execution, broker, risk, freshness];
  const worst = items.reduce((max, item) => Math.max(max, toneSeverity(item.tone)), 0);
  const headline = worst >= 3
    ? 'Operator attention required: one or more global surfaces are degraded.'
    : worst === 2
      ? 'Operator caution: some global surfaces are degraded or partially stale.'
      : worst === 1
        ? 'Operator status is healthy where proof exists.'
        : 'Global status is explicitly unavailable where this SSR UI lacks proof.';

  return {
    assembledAt: payload.assembledAt,
    headline,
    items,
  };
}

function handleLiveness(
  res: http.ServerResponse,
  db: Database.Database | null,
  dbError: string | null,
): void {
  const dbOk = db !== null;
  res.writeHead(dbOk ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: dbOk ? 'alive' : 'degraded',
    service: 'operator-ui',
    dbConnected: dbOk,
    dbError: dbOk ? null : (dbError ?? 'unknown'),
  }));
}

function handleDashboardHtml(
  res: http.ServerResponse,
  dashboardPayloadAssembler: DashboardPayloadAssembler,
  readModel: OperatorReadModel | null,
  dbError: string | null,
  pollIntervalMs: number,
  shellStatus: OperatorShellStatusViewModel | null,
): void {
  if (readModel === null) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Database Unavailable',
      detail: dbError ?? 'Failed to open operator database.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to dashboard</a>',
      shellStatus,
    }));
    return;
  }

  try {
    const payload = dashboardPayloadAssembler.fetchDashboardPayload(readModel, dbError);
    respondHtml(res, 200, renderDashboardPage(payload, { pollIntervalMs, shellStatus }));
  } catch (err) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Dashboard Render Failed',
      detail: err instanceof Error ? err.message : 'Unknown error while assembling dashboard payload.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Retry dashboard</a>',
      shellStatus,
    }));
  }
}

function handleTopLevelDashboardPage(
  res: http.ServerResponse,
  dashboardPayloadAssembler: DashboardPayloadAssembler,
  readModel: OperatorReadModel | null,
  dbError: string | null,
  renderPage: (payload: ReturnType<DashboardPayloadAssembler['fetchDashboardPayload']>, options?: { shellStatus?: OperatorShellStatusViewModel | null }) => string,
  shellStatus: OperatorShellStatusViewModel | null,
): void {
  if (readModel === null) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Database Unavailable',
      detail: dbError ?? 'Failed to open operator database.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to overview</a>',
      shellStatus,
    }));
    return;
  }

  try {
    const payload = dashboardPayloadAssembler.fetchDashboardPayload(readModel, dbError);
    respondHtml(res, 200, renderPage(payload, { shellStatus }));
  } catch (err) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Operator Page Unavailable',
      detail: err instanceof Error ? err.message : 'Unknown error while assembling operator payload.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to overview</a>',
      shellStatus,
    }));
  }
}

function handleDecisionDetail(
  res: http.ServerResponse,
  url: URL,
  detailReadModel: OperatorDetailReadModel | null,
  dbError: string | null,
  shellStatus: OperatorShellStatusViewModel | null,
): void {
  const parsed = parseRequiredInt(url, 'id', 'decision id');
  if (!parsed.ok) {
    respondHtml(res, 400, renderStatusPage({
      title: 'Malformed Decision Request',
      detail: parsed.message,
      statusLabel: '400 Bad Request',
      actions: '<a href="/">Back to dashboard</a>',
      shellStatus,
    }));
    return;
  }

  if (detailReadModel === null) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Decision Detail Unavailable',
      detail: dbError ?? 'Operator database is unavailable, so persisted decision detail cannot be loaded.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to dashboard</a>',
      shellStatus,
    }));
    return;
  }

  try {
    const detail = detailReadModel.getDecisionDetail(parsed.value);
    if (detail === null) {
      respondHtml(res, 404, renderStatusPage({
        title: 'Decision Not Found',
        detail: `No persisted decision detail exists for id=${parsed.value}.`,
        statusLabel: '404 Not Found',
        actions: '<a href="/">Back to dashboard</a>',
        shellStatus,
      }));
      return;
    }

    respondHtml(res, 200, renderDecisionDetailPage(detail, { shellStatus }));
  } catch (err) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Decision Detail Unavailable',
      detail: describeDetailError('decision', err),
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to dashboard</a>',
      shellStatus,
    }));
  }
}

function handleStrategyDetail(
  res: http.ServerResponse,
  url: URL,
  detailReadModel: OperatorDetailReadModel | null,
  dbError: string | null,
  shellStatus: OperatorShellStatusViewModel | null,
): void {
  const strategyId = parseRequiredString(url, 'strategyId', 'strategyId');
  if (!strategyId.ok) {
    respondHtml(res, 400, renderStatusPage({
      title: 'Malformed Strategy Request',
      detail: strategyId.message,
      statusLabel: '400 Bad Request',
      actions: '<a href="/">Back to dashboard</a>',
      shellStatus,
    }));
    return;
  }

  const strategyVersion = parseRequiredString(url, 'strategyVersion', 'strategyVersion');
  if (!strategyVersion.ok) {
    respondHtml(res, 400, renderStatusPage({
      title: 'Malformed Strategy Request',
      detail: strategyVersion.message,
      statusLabel: '400 Bad Request',
      actions: '<a href="/">Back to dashboard</a>',
      shellStatus,
    }));
    return;
  }

  if (detailReadModel === null) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Strategy Detail Unavailable',
      detail: dbError ?? 'Operator database is unavailable, so persisted strategy detail cannot be loaded.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to dashboard</a>',
      shellStatus,
    }));
    return;
  }

  try {
    const detail = detailReadModel.getStrategyDetail(strategyId.value, strategyVersion.value);
    if (detail === null) {
      respondHtml(res, 404, renderStatusPage({
        title: 'Strategy Not Found',
        detail: `No persisted strategy detail exists for ${strategyId.value}@${strategyVersion.value}.`,
        statusLabel: '404 Not Found',
        actions: '<a href="/">Back to dashboard</a>',
        shellStatus,
      }));
      return;
    }

    respondHtml(res, 200, renderStrategyDetailPage(detail, { shellStatus }));
  } catch (err) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Strategy Detail Unavailable',
      detail: describeDetailError('strategy', err),
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to dashboard</a>',
      shellStatus,
    }));
  }
}

function handleBacktestDetail(
  res: http.ServerResponse,
  url: URL,
  detailReadModel: OperatorDetailReadModel | null,
  dbError: string | null,
  shellStatus: OperatorShellStatusViewModel | null,
): void {
  const parsed = parseRequiredInt(url, 'runId', 'runId');
  if (!parsed.ok) {
    respondHtml(res, 400, renderStatusPage({
      title: 'Malformed Backtest Request',
      detail: parsed.message,
      statusLabel: '400 Bad Request',
      actions: '<a href="/">Back to dashboard</a>',
      shellStatus,
    }));
    return;
  }

  if (detailReadModel === null) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Backtest Detail Unavailable',
      detail: dbError ?? 'Operator database is unavailable, so persisted backtest detail cannot be loaded.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to dashboard</a>',
      shellStatus,
    }));
    return;
  }

  try {
    const detail = detailReadModel.getBacktestDetail(parsed.value);
    if (detail === null) {
      respondHtml(res, 404, renderStatusPage({
        title: 'Backtest Run Not Found',
        detail: `No persisted backtest run detail exists for runId=${parsed.value}.`,
        statusLabel: '404 Not Found',
        actions: '<a href="/">Back to dashboard</a>',
        shellStatus,
      }));
      return;
    }

    respondHtml(res, 200, renderBacktestDetailPage(detail, { shellStatus }));
  } catch (err) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Backtest Detail Unavailable',
      detail: describeDetailError('backtest', err),
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to dashboard</a>',
      shellStatus,
    }));
  }
}

function handleApiRefresh(
  res: http.ServerResponse,
  dashboardPayloadAssembler: DashboardPayloadAssembler,
  readModel: OperatorReadModel | null,
  dbError: string | null,
  pollIntervalMs: number,
  buildShellStatus: (payload: DashboardPayload) => OperatorShellStatusViewModel,
): void {
  try {
    const payload = dashboardPayloadAssembler.fetchDashboardPayload(readModel, dbError);
    const shellStatus = buildShellStatus(payload);
    const sectionHtml = renderDashboardSectionHtml(payload);
    res.writeHead(payload.dbAvailable ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      assembledAt: payload.assembledAt,
      dbAvailable: payload.dbAvailable,
      dbError: payload.dbError,
      pollIntervalMs,
      error: payload.dbAvailable ? null : 'Database unavailable',
      shellStatus,
      heroHtml: renderOverviewHero(payload),
      sections: {
        summaryCards: serializeDashboardSection(payload.summaryCards, sectionHtml.summaryCards),
        strategyPerformance: serializeDashboardSection(payload.strategyPerformance, sectionHtml.strategyPerformance),
        tickerPerformance: serializeDashboardSection(payload.tickerPerformance, sectionHtml.tickerPerformance),
        decisionPerformance: serializeDashboardSection(payload.decisionPerformance, sectionHtml.decisionPerformance),
        lifecycleStates: serializeDashboardSection(payload.lifecycleStates, sectionHtml.lifecycleStates),
        governanceHistory: serializeDashboardSection(payload.governanceHistory, sectionHtml.governanceHistory),
        promotionHistory: serializeDashboardSection(payload.promotionHistory, sectionHtml.promotionHistory),
        walkForwardLeaderboard: serializeDashboardSection(payload.walkForwardLeaderboard, sectionHtml.walkForwardLeaderboard),
        researchLineage: serializeDashboardSection(payload.researchLineage, sectionHtml.researchLineage),
        overnightResearch: serializeDashboardSection(payload.overnightResearch, sectionHtml.overnightResearch),
      },
    }, null, 2));
  } catch (err) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Query failed',
      detail: err instanceof Error ? err.message : 'Unknown error',
    }));
  }
}

function serializeDashboardSection(section: {
  state: string;
  data: unknown;
  errorMessage: string | null;
  stalenessMs: number | null;
  lastFetchedAt: string | null;
  isCachedData: boolean;
}, html: string) {
  const data = section.data as any;
  const count = Array.isArray(data)
    ? data.length
    : Array.isArray(data?.recent)
      ? data.recent.length
      : Array.isArray(data?.recentRuns)
        ? data.recentRuns.length
        : 0;
  return {
    state: section.state,
    count,
    data: section.data,
    errorMessage: section.errorMessage,
    stalenessMs: section.stalenessMs,
    lastFetchedAt: section.lastFetchedAt,
    isCachedData: section.isCachedData,
    html,
  };
}

function buildOperatorHealthPayload(
  config: OperatorUIConfig,
  db: Database.Database | null,
  dbError: string | null,
  authenticator: Authenticator,
  readModel: OperatorReadModel | null,
  dbOpenBootstrap: DbOpenBootstrapState,
  detailReadModelBootstrap: unknown,
): OperatorSystemHealthViewModel {
  const dbOk = db !== null;
  const sections: Record<string, unknown> = {};

  if (readModel !== null) {
    try {
      const cards = readModel.getSummaryCards();
      sections.summaryCards = { status: 'ok', count: cards.length };
    } catch (err) {
      sections.summaryCards = { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const decisions = readModel.getDecisionPerformance(5);
      sections.recentDecisions = { status: 'ok', count: decisions.length };
    } catch (err) {
      sections.recentDecisions = { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const strategies = readModel.getStrategyPerformance();
      sections.strategyPerformance = { status: 'ok', count: strategies.length };
    } catch (err) {
      sections.strategyPerformance = { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const tickers = readModel.getTickerPerformance();
      sections.tickerPerformance = { status: 'ok', count: tickers.length };
    } catch (err) {
      sections.tickerPerformance = { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const exposure = readModel.getStrategyExposure();
      sections.strategyExposure = { status: 'ok', count: exposure.length };
    } catch (err) {
      sections.strategyExposure = { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const lifecycle = readModel.getLifecycleStates();
      sections.lifecycle = { status: 'ok', count: lifecycle.length };
    } catch (err) {
      sections.lifecycle = { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const lineage = readModel.getResearchLineageSummary();
      sections.researchLineage = { status: 'ok', count: lineage.recent.length, availability: lineage.status.availability };
    } catch (err) {
      sections.researchLineage = { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const overnight = readModel.getOvernightSummary();
      sections.overnightResearch = { status: 'ok', count: overnight.recentRuns.length, availability: overnight.status.availability };
    } catch (err) {
      sections.overnightResearch = { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    sections.summaryCards = { status: 'unavailable', error: dbError ?? 'Read model not initialized' };
  }

  return {
    status: dbOk ? 'healthy' : 'degraded',
    version: '0.1.0',
    service: 'operator-ui',
    dbConnected: dbOk,
    dbError: dbOk ? null : dbError,
    pollIntervalMs: config.pollIntervalMs,
    authClients: authenticator.getStateSummary(),
    dbOpenBootstrap,
    detailReadModelBootstrap,
    upstoxTokenRefresh: getUpstoxTokenRefreshHealth(),
    sections,
  };
}

function handleSystemHealthHtml(
  res: http.ServerResponse,
  config: OperatorUIConfig,
  db: Database.Database | null,
  dbError: string | null,
  authenticator: Authenticator,
  readModel: OperatorReadModel | null,
  dbOpenBootstrap: DbOpenBootstrapState,
  detailReadModelBootstrap: unknown,
  shellStatus: OperatorShellStatusViewModel | null,
): void {
  respondHtml(res, 200, renderSystemHealthPage(buildOperatorHealthPayload(config, db, dbError, authenticator, readModel, dbOpenBootstrap, detailReadModelBootstrap), { shellStatus }));
}

function handleApiHealth(
  res: http.ServerResponse,
  config: OperatorUIConfig,
  db: Database.Database | null,
  dbError: string | null,
  authenticator: Authenticator,
  readModel: OperatorReadModel | null,
  dbOpenBootstrap: DbOpenBootstrapState,
  detailReadModelBootstrap: unknown,
): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(buildOperatorHealthPayload(config, db, dbError, authenticator, readModel, dbOpenBootstrap, detailReadModelBootstrap)));
}

async function handleUpstoxTokenRefreshApi(
  res: http.ServerResponse,
  coordinator: UpstoxTokenRefreshCoordinator,
): Promise<void> {
  const result = await coordinator.triggerRequest('operator-ui');
  const statusCode = result.action === 'request-sent'
    ? 202
    : result.action === 'suppressed'
      ? 409
      : result.action === 'request-failed'
        ? 503
        : 200;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ action: result.action, refresh: result.status }, null, 2));
}

async function handleUpstoxTokenRefreshHtml(
  res: http.ServerResponse,
  coordinator: UpstoxTokenRefreshCoordinator,
  shellStatus: OperatorShellStatusViewModel | null,
): Promise<void> {
  try {
    const result = await coordinator.triggerRequest('operator-ui');
    const statusCode = result.action === 'request-sent'
      ? 202
      : result.action === 'suppressed'
        ? 409
        : result.action === 'request-failed'
          ? 503
          : 200;
    respondHtml(res, statusCode, renderStatusPage({
      title: 'Upstox Token Refresh',
      detail: result.status.message ?? 'Upstox token refresh request processed.',
      statusLabel: `${statusCode}`,
      actions: '<a href="/system-health">Back to system health</a><a href="/api/health">Raw JSON</a>',
      shellStatus,
    }));
  } catch (err) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Upstox Token Refresh Failed',
      detail: err instanceof Error ? err.message : String(err),
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/system-health">Back to system health</a>',
      shellStatus,
    }));
  }
}

function parseRequiredInt(url: URL, key: string, label: string):
  | { ok: true; value: number }
  | { ok: false; message: string } {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === '') {
    return { ok: false, message: `Missing required query parameter: ${label}.` };
  }
  if (!/^\d+$/.test(raw.trim())) {
    return { ok: false, message: `Invalid ${label}. Expected a positive integer.` };
  }
  return { ok: true, value: Number(raw.trim()) };
}

function parseRequiredString(url: URL, key: string, label: string):
  | { ok: true; value: string }
  | { ok: false; message: string } {
  const raw = url.searchParams.get(key);
  if (raw === null) {
    return { ok: false, message: `Missing required query parameter: ${label}.` };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: `Invalid ${label}. Expected a non-empty string.` };
  }
  return { ok: true, value: trimmed };
}

function describeDetailError(operation: 'decision' | 'strategy' | 'backtest', err: unknown): string {
  if (err instanceof OperatorDetailReadModelError) {
    return `Persisted ${operation} detail is temporarily unavailable because the operator read model could not compose the requested evidence.`;
  }
  return `Persisted ${operation} detail is temporarily unavailable due to an unexpected read failure.`;
}

function respondHtml(res: http.ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}
