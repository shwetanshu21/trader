// ── Operator UI HTTP Server ──
// Standalone HTTP server for the authenticated operator console.
// Uses Node built-in `http` module — zero extra dependencies.
//
// Routes:
//   GET /health         → Unauthenticated liveness probe
//   GET /               → Authenticated dashboard HTML (summary-first)
//   GET /api/refresh    → Authenticated JSON refresh surface
//   GET /api/health     → Authenticated health JSON with DB diagnostics
//
// Security: binds to loopback by default, restricts CORS to loopback origins,
// redacts internal exception detail from 500 responses, and never echoes
// credentials or raw secrets.

import http from 'node:http';
import type { OperatorUIConfig } from './config.js';
import type { Authenticator, AuthResult } from './auth.js';
import {
  WWW_AUTHENTICATE_HEADER,
  RETRY_AFTER_HEADER,
  RATE_LIMIT_LIMIT_HEADER,
  RATE_LIMIT_REMAINING_HEADER,
} from './auth.js';
import type Database from 'better-sqlite3';
import type { OperatorReadModel } from '../operator/operator-read-model.js';
import { fetchDashboardPayload } from './dashboard-data.js';
import { renderDashboardPage } from './pages/dashboard-page.js';

// ---------------------------------------------------------------------------
// Server options
// ---------------------------------------------------------------------------

export interface OperatorUIServerOptions {
  config: OperatorUIConfig;
  authenticator: Authenticator;
  db: Database.Database | null;
  dbError: string | null;
  readModel: OperatorReadModel | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOperatorUIServer(options: OperatorUIServerOptions): http.Server {
  const { config, authenticator, db, dbError, readModel } = options;
  const corsOrigin = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}`;

  return http.createServer((req, res) => {
    // CORS headers restricted to the bind-host origin (never wildcard)
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Accept');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    try {
      switch (url.pathname) {
        // ── Unauthenticated: liveness ────────────────────────────────
        case '/health': {
          handleLiveness(res, db, dbError);
          break;
        }

        // ── Authenticated: dashboard HTML ────────────────────────────
        case '/': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleDashboardHtml(res, readModel, dbError);
          break;
        }

        // ── Authenticated: JSON refresh surface ──────────────────────
        case '/api/refresh': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleApiRefresh(res, readModel, dbError);
          break;
        }

        // ── Authenticated: health JSON ───────────────────────────────
        case '/api/health': {
          const auth = verifyAuth(req, authenticator, res);
          if (!auth.ok) return;
          handleApiHealth(res, config, db, dbError, authenticator, readModel);
          break;
        }

        default: {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));
          break;
        }
      }
    } catch (err) {
      // Truthful redaction: include the error type but not raw exception detail
      const message = err instanceof Error ? `${err.name}: ${err.message}` : 'Unknown error';
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Internal server error',
        type: err instanceof Error ? err.name : 'Unknown',
        detail: message,
      }));
    }
  });
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function verifyAuth(
  req: http.IncomingMessage,
  authenticator: Authenticator,
  res: http.ServerResponse,
): AuthResult {
  const clientIp = authenticator.extractClientIp(
    req.socket.remoteAddress,
    req.headers['x-forwarded-for'] as string | undefined,
  );
  const result = authenticator.authenticate(
    req.headers.authorization,
    clientIp,
  );

  if (!result.ok) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (result.status === 401) {
      headers[WWW_AUTHENTICATE_HEADER] = 'Basic realm="Operator Console"';
    }
    if (result.status === 429) {
      headers[RETRY_AFTER_HEADER] = '120';
    }

    res.writeHead(result.status, headers);
    res.end(JSON.stringify({
      error: result.message,
      status: result.status,
    }));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /health — unauthenticated liveness probe. */
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

/** GET / — authenticated dashboard HTML (summary-first). */
function handleDashboardHtml(
  res: http.ServerResponse,
  readModel: OperatorReadModel | null,
  dbError: string | null,
): void {
  if (readModel === null) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderErrorHtml('Database Unavailable', dbError ?? 'Failed to open database.'));
    return;
  }

  try {
    const payload = fetchDashboardPayload(readModel, dbError);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboardPage(payload));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderErrorHtml('Dashboard Render Failed', message));
  }
}

/** GET /api/refresh — authenticated JSON refresh surface. */
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

    // Build a flat JSON response suitable for client-side polling
    const jsonPayload = {
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
    };

    res.end(JSON.stringify(jsonPayload, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Query failed', detail: message }));
  }
}

/** GET /api/health — authenticated health JSON with diagnostics. */
function handleApiHealth(
  res: http.ServerResponse,
  config: OperatorUIConfig,
  db: Database.Database | null,
  dbError: string | null,
  authenticator: Authenticator,
  readModel: OperatorReadModel | null,
): void {
  const dbOk = db !== null;

  // Section-level diagnostics: each query independently reports success/failure
  const sections: Record<string, unknown> = {};

  if (readModel !== null) {
    // Summary cards
    try {
      const cards = readModel.getSummaryCards();
      sections.summaryCards = { status: 'ok', count: cards.length };
    } catch (err) {
      sections.summaryCards = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Decision performance
    try {
      const decisions = readModel.getDecisionPerformance(5);
      sections.recentDecisions = { status: 'ok', count: decisions.length };
    } catch (err) {
      sections.recentDecisions = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Strategy performance
    try {
      const strategies = readModel.getStrategyPerformance();
      sections.strategyPerformance = { status: 'ok', count: strategies.length };
    } catch (err) {
      sections.strategyPerformance = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Ticker performance
    try {
      const tickers = readModel.getTickerPerformance();
      sections.tickerPerformance = { status: 'ok', count: tickers.length };
    } catch (err) {
      sections.tickerPerformance = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Lifecycle
    try {
      const lifecycle = readModel.getLifecycleStates();
      sections.lifecycle = { status: 'ok', count: lifecycle.length };
    } catch (err) {
      sections.lifecycle = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
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

// ---------------------------------------------------------------------------
// HTML renderers
// ---------------------------------------------------------------------------

/** Render an error HTML page. */
function renderErrorHtml(title: string, detail: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  p { color: #94a3b8; }
  .error { color: #ef4444; }
</style>
</head>
<body>
<h1 class="error">${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple HTML entity escape (local copy for error pages). */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
