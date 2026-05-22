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
import { DashboardPayloadAssembler } from './dashboard-data.js';
import { renderStatusPage } from './render-utils.js';
import { renderBacktestDetailPage } from './pages/backtest-detail-page.js';
import { renderDashboardPage, renderDashboardSectionHtml, renderOverviewHero } from './pages/dashboard-page.js';
import { renderDecisionDetailPage } from './pages/decision-detail-page.js';
import { renderStrategyDetailPage } from './pages/strategy-detail-page.js';
import { renderPositionsPage } from './pages/positions-page.js';
import { renderStrategiesPage } from './pages/strategies-page.js';
import { renderDecisionsPage } from './pages/decisions-page.js';
import { renderGovernancePage } from './pages/governance-page.js';
import { renderSystemHealthPage, type OperatorSystemHealthViewModel } from './pages/system-health-page.js';

export interface OperatorUIServerOptions {
  config: OperatorUIConfig;
  authenticator: Authenticator;
  db: Database.Database | null;
  dbError: string | null;
  readModel: OperatorReadModel | null;
  detailReadModel?: OperatorDetailReadModel | null;
  detailReadModelFactory?: ((db: Database.Database) => OperatorDetailReadModel) | null;
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
  const corsOrigin = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}`;

  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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
          handleDashboardHtml(res, dashboardPayloadAssembler, readModel, dbError, config.pollIntervalMs);
          return;
        }

        case '/positions': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleTopLevelDashboardPage(res, dashboardPayloadAssembler, readModel, dbError, payload => renderPositionsPage(payload, readModel?.getStrategyExposure() ?? []));
          return;
        }

        case '/strategies': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleTopLevelDashboardPage(res, dashboardPayloadAssembler, readModel, dbError, payload => renderStrategiesPage(payload, readModel?.getStrategyExposure() ?? []));
          return;
        }

        case '/decisions': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleTopLevelDashboardPage(res, dashboardPayloadAssembler, readModel, dbError, renderDecisionsPage);
          return;
        }

        case '/governance': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleTopLevelDashboardPage(res, dashboardPayloadAssembler, readModel, dbError, renderGovernancePage);
          return;
        }

        case '/system-health': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleSystemHealthHtml(res, config, db, dbError, authenticator, readModel, detailReadModelBootstrap);
          return;
        }

        case '/decision': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleDecisionDetail(res, url, getDetailReadModel(), dbError ?? detailReadModelInitError);
          return;
        }

        case '/strategy': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleStrategyDetail(res, url, getDetailReadModel(), dbError ?? detailReadModelInitError);
          return;
        }

        case '/backtest': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleBacktestDetail(res, url, getDetailReadModel(), dbError ?? detailReadModelInitError);
          return;
        }

        case '/api/refresh': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleApiRefresh(res, dashboardPayloadAssembler, readModel, dbError, config.pollIntervalMs);
          return;
        }

        case '/api/health': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleApiHealth(res, config, db, dbError, authenticator, readModel, detailReadModelBootstrap);
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
): void {
  if (readModel === null) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Database Unavailable',
      detail: dbError ?? 'Failed to open operator database.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to dashboard</a>',
    }));
    return;
  }

  try {
    const payload = dashboardPayloadAssembler.fetchDashboardPayload(readModel, dbError);
    respondHtml(res, 200, renderDashboardPage(payload, { pollIntervalMs }));
  } catch (err) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Dashboard Render Failed',
      detail: err instanceof Error ? err.message : 'Unknown error while assembling dashboard payload.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Retry dashboard</a>',
    }));
  }
}

function handleTopLevelDashboardPage(
  res: http.ServerResponse,
  dashboardPayloadAssembler: DashboardPayloadAssembler,
  readModel: OperatorReadModel | null,
  dbError: string | null,
  renderPage: (payload: ReturnType<DashboardPayloadAssembler['fetchDashboardPayload']>) => string,
): void {
  if (readModel === null) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Database Unavailable',
      detail: dbError ?? 'Failed to open operator database.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to overview</a>',
    }));
    return;
  }

  try {
    const payload = dashboardPayloadAssembler.fetchDashboardPayload(readModel, dbError);
    respondHtml(res, 200, renderPage(payload));
  } catch (err) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Operator Page Unavailable',
      detail: err instanceof Error ? err.message : 'Unknown error while assembling operator payload.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to overview</a>',
    }));
  }
}

function handleDecisionDetail(
  res: http.ServerResponse,
  url: URL,
  detailReadModel: OperatorDetailReadModel | null,
  dbError: string | null,
): void {
  const parsed = parseRequiredInt(url, 'id', 'decision id');
  if (!parsed.ok) {
    respondHtml(res, 400, renderStatusPage({
      title: 'Malformed Decision Request',
      detail: parsed.message,
      statusLabel: '400 Bad Request',
      actions: '<a href="/">Back to dashboard</a>',
    }));
    return;
  }

  if (detailReadModel === null) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Decision Detail Unavailable',
      detail: dbError ?? 'Operator database is unavailable, so persisted decision detail cannot be loaded.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to dashboard</a>',
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
      }));
      return;
    }

    respondHtml(res, 200, renderDecisionDetailPage(detail));
  } catch (err) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Decision Detail Unavailable',
      detail: describeDetailError('decision', err),
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to dashboard</a>',
    }));
  }
}

function handleStrategyDetail(
  res: http.ServerResponse,
  url: URL,
  detailReadModel: OperatorDetailReadModel | null,
  dbError: string | null,
): void {
  const strategyId = parseRequiredString(url, 'strategyId', 'strategyId');
  if (!strategyId.ok) {
    respondHtml(res, 400, renderStatusPage({
      title: 'Malformed Strategy Request',
      detail: strategyId.message,
      statusLabel: '400 Bad Request',
      actions: '<a href="/">Back to dashboard</a>',
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
    }));
    return;
  }

  if (detailReadModel === null) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Strategy Detail Unavailable',
      detail: dbError ?? 'Operator database is unavailable, so persisted strategy detail cannot be loaded.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to dashboard</a>',
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
      }));
      return;
    }

    respondHtml(res, 200, renderStrategyDetailPage(detail));
  } catch (err) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Strategy Detail Unavailable',
      detail: describeDetailError('strategy', err),
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to dashboard</a>',
    }));
  }
}

function handleBacktestDetail(
  res: http.ServerResponse,
  url: URL,
  detailReadModel: OperatorDetailReadModel | null,
  dbError: string | null,
): void {
  const parsed = parseRequiredInt(url, 'runId', 'runId');
  if (!parsed.ok) {
    respondHtml(res, 400, renderStatusPage({
      title: 'Malformed Backtest Request',
      detail: parsed.message,
      statusLabel: '400 Bad Request',
      actions: '<a href="/">Back to dashboard</a>',
    }));
    return;
  }

  if (detailReadModel === null) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Backtest Detail Unavailable',
      detail: dbError ?? 'Operator database is unavailable, so persisted backtest detail cannot be loaded.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to dashboard</a>',
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
      }));
      return;
    }

    respondHtml(res, 200, renderBacktestDetailPage(detail));
  } catch (err) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Backtest Detail Unavailable',
      detail: describeDetailError('backtest', err),
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Back to dashboard</a>',
    }));
  }
}

function handleApiRefresh(
  res: http.ServerResponse,
  dashboardPayloadAssembler: DashboardPayloadAssembler,
  readModel: OperatorReadModel | null,
  dbError: string | null,
  pollIntervalMs: number,
): void {
  try {
    const payload = dashboardPayloadAssembler.fetchDashboardPayload(readModel, dbError);
    const sectionHtml = renderDashboardSectionHtml(payload);
    res.writeHead(payload.dbAvailable ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      assembledAt: payload.assembledAt,
      dbAvailable: payload.dbAvailable,
      dbError: payload.dbError,
      pollIntervalMs,
      error: payload.dbAvailable ? null : 'Database unavailable',
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

function serializeDashboardSection<T extends { length: number }>(section: {
  state: string;
  data: T;
  errorMessage: string | null;
  stalenessMs: number | null;
  lastFetchedAt: string | null;
  isCachedData: boolean;
}, html: string) {
  return {
    state: section.state,
    count: section.data.length,
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
    detailReadModelBootstrap,
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
  detailReadModelBootstrap: unknown,
): void {
  respondHtml(res, 200, renderSystemHealthPage(buildOperatorHealthPayload(config, db, dbError, authenticator, readModel, detailReadModelBootstrap)));
}

function handleApiHealth(
  res: http.ServerResponse,
  config: OperatorUIConfig,
  db: Database.Database | null,
  dbError: string | null,
  authenticator: Authenticator,
  readModel: OperatorReadModel | null,
  detailReadModelBootstrap: unknown,
): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(buildOperatorHealthPayload(config, db, dbError, authenticator, readModel, detailReadModelBootstrap)));
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
