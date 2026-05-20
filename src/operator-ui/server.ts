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
import { fetchDashboardPayload } from './dashboard-data.js';
import { renderStatusPage } from './render-utils.js';
import { renderBacktestDetailPage } from './pages/backtest-detail-page.js';
import { renderDashboardPage } from './pages/dashboard-page.js';
import { renderDecisionDetailPage } from './pages/decision-detail-page.js';
import { renderStrategyDetailPage } from './pages/strategy-detail-page.js';

export interface OperatorUIServerOptions {
  config: OperatorUIConfig;
  authenticator: Authenticator;
  db: Database.Database | null;
  dbError: string | null;
  readModel: OperatorReadModel | null;
  detailReadModel?: OperatorDetailReadModel | null;
}

export function createOperatorUIServer(options: OperatorUIServerOptions): http.Server {
  const { config, authenticator, db, dbError, readModel } = options;
  const detailReadModel = options.detailReadModel ?? (db !== null ? new OperatorDetailReadModel(db) : null);
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
          handleDashboardHtml(res, readModel, dbError);
          return;
        }

        case '/decision': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleDecisionDetail(res, url, detailReadModel, dbError);
          return;
        }

        case '/strategy': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleStrategyDetail(res, url, detailReadModel, dbError);
          return;
        }

        case '/backtest': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleBacktestDetail(res, url, detailReadModel, dbError);
          return;
        }

        case '/api/refresh': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleApiRefresh(res, readModel, dbError);
          return;
        }

        case '/api/health': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleApiHealth(res, config, db, dbError, authenticator, readModel);
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
  readModel: OperatorReadModel | null,
  dbError: string | null,
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
    const payload = fetchDashboardPayload(readModel, dbError);
    respondHtml(res, 200, renderDashboardPage(payload));
  } catch (err) {
    respondHtml(res, 503, renderStatusPage({
      title: 'Dashboard Render Failed',
      detail: err instanceof Error ? err.message : 'Unknown error while assembling dashboard payload.',
      statusLabel: '503 Service Unavailable',
      actions: '<a href="/">Retry dashboard</a>',
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
  readModel: OperatorReadModel | null,
  dbError: string | null,
): void {
  if (readModel === null) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Database unavailable', detail: dbError }));
    return;
  }

  try {
    const payload = fetchDashboardPayload(readModel, dbError);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      assembledAt: payload.assembledAt,
      dbAvailable: payload.dbAvailable,
      dbError: payload.dbError,
      sections: {
        summaryCards: {
          state: payload.summaryCards.state,
          count: payload.summaryCards.data.length,
          data: payload.summaryCards.data,
          errorMessage: payload.summaryCards.errorMessage,
        },
        strategyPerformance: {
          state: payload.strategyPerformance.state,
          count: payload.strategyPerformance.data.length,
          data: payload.strategyPerformance.data,
          errorMessage: payload.strategyPerformance.errorMessage,
        },
        tickerPerformance: {
          state: payload.tickerPerformance.state,
          count: payload.tickerPerformance.data.length,
          data: payload.tickerPerformance.data,
          errorMessage: payload.tickerPerformance.errorMessage,
        },
        decisionPerformance: {
          state: payload.decisionPerformance.state,
          count: payload.decisionPerformance.data.length,
          data: payload.decisionPerformance.data,
          errorMessage: payload.decisionPerformance.errorMessage,
        },
        lifecycleStates: {
          state: payload.lifecycleStates.state,
          count: payload.lifecycleStates.data.length,
          data: payload.lifecycleStates.data,
          errorMessage: payload.lifecycleStates.errorMessage,
        },
        governanceHistory: {
          state: payload.governanceHistory.state,
          count: payload.governanceHistory.data.length,
          data: payload.governanceHistory.data,
          errorMessage: payload.governanceHistory.errorMessage,
        },
        promotionHistory: {
          state: payload.promotionHistory.state,
          count: payload.promotionHistory.data.length,
          data: payload.promotionHistory.data,
          errorMessage: payload.promotionHistory.errorMessage,
        },
        walkForwardLeaderboard: {
          state: payload.walkForwardLeaderboard.state,
          count: payload.walkForwardLeaderboard.data.length,
          data: payload.walkForwardLeaderboard.data,
          errorMessage: payload.walkForwardLeaderboard.errorMessage,
        },
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

function handleApiHealth(
  res: http.ServerResponse,
  config: OperatorUIConfig,
  db: Database.Database | null,
  dbError: string | null,
  authenticator: Authenticator,
  readModel: OperatorReadModel | null,
): void {
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
      const lifecycle = readModel.getLifecycleStates();
      sections.lifecycle = { status: 'ok', count: lifecycle.length };
    } catch (err) {
      sections.lifecycle = { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    sections.summaryCards = { status: 'unavailable', error: dbError ?? 'Read model not initialized' };
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: dbOk ? 'healthy' : 'degraded',
    version: '0.1.0',
    service: 'operator-ui',
    dbConnected: dbOk,
    dbError: dbOk ? null : dbError,
    pollIntervalMs: config.pollIntervalMs,
    authClients: authenticator.getStateSummary(),
    sections,
  }));
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
