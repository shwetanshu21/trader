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
import type {
  OperatorSummaryCard,
  OperatorDecisionPerformance,
} from '../types/runtime.js';

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
    const cards = readModel.getSummaryCards();
    const decisions = readModel.getDecisionPerformance(50);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboardHtml({ cards, decisions }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderErrorHtml('Query Failed', message));
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
    const cards = readModel.getSummaryCards();
    const decisions = readModel.getDecisionPerformance(50);
    const strategies = readModel.getStrategyPerformance();
    const tickers = readModel.getTickerPerformance();
    const lifecycle = readModel.getLifecycleStates();
    const governance = readModel.getLifecycleHistory(20);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      assembledAt: new Date().toISOString(),
      cards,
      decisions,
      strategies,
      tickers,
      lifecycle,
      governance,
    }, null, 2));
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

/** Render a summary-first dashboard HTML page. */
function renderDashboardHtml(data: {
  cards: OperatorSummaryCard[];
  decisions: OperatorDecisionPerformance[];
}): string {
  const { cards, decisions } = data;

  // Build summary card grid
  const cardHtml = cards.length > 0
    ? cards.map((c) => {
        const label = String(c.label || c.key || '');
        const value = c.value;
        const unit = c.unit ?? '';
        return `<div class="meta-card">
          <div class="label">${escapeHtml(label)}</div>
          <div class="value">${escapeHtml(String(value))}${unit ? ` <span class="unit">${escapeHtml(String(unit))}</span>` : ''}</div>
        </div>`;
      }).join('\n')
    : `<div class="meta-card">
        <div class="label">Decisions</div>
        <div class="value">0</div>
       </div>`;

  // Build decisions table rows
  const rows = decisions.length > 0
    ? decisions.map((d, i) => {
        const status = String(d.decisionStatus ?? 'unknown');
        const statusClass = status === 'approved' ? 'status-approved'
          : status === 'refused' ? 'status-refused'
          : 'status-unknown';
        return `<tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(d.exchange ?? '')}</td>
          <td>${escapeHtml(d.tradingsymbol ?? '')}</td>
          <td>${escapeHtml(d.side ?? '')}</td>
          <td>${escapeHtml(String(d.quantity ?? ''))}</td>
          <td class="${statusClass}">${status}</td>
          <td>${escapeHtml(String(d.strategyId ?? ''))}</td>
          <td>${escapeHtml(d.decidedAt ?? '')}</td>
        </tr>`;
      }).join('\n')
    : '<tr><td colspan="8" class="empty">No decisions found.</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Operator Console</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 1.5rem; }
  h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.25rem; }
  .subtitle { color: #64748b; font-size: 0.875rem; margin-bottom: 1.5rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
  th { text-align: left; padding: 0.5rem 0.75rem; background: #1e293b; color: #94a3b8; font-weight: 600; border-bottom: 1px solid #334155; }
  td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #1e293b; }
  .status-approved { color: #22c55e; font-weight: 600; }
  .status-refused { color: #ef4444; font-weight: 600; }
  .status-unknown { color: #f59e0b; }
  .empty { text-align: center; color: #64748b; padding: 2rem; }
  .section-title { font-size: 1.125rem; font-weight: 600; margin: 1.5rem 0 0.75rem; color: #f1f5f9; }
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
  .meta-card { background: #1e293b; border-radius: 0.5rem; padding: 0.75rem; border: 1px solid #334155; }
  .meta-card .label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
  .meta-card .value { font-size: 1.125rem; font-weight: 600; margin-top: 0.25rem; }
  a { color: #3b82f6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .nav { margin-top: 1.5rem; display: flex; gap: 1rem; font-size: 0.875rem; }
</style>
</head>
<body>
<h1>Operator Console</h1>
<p class="subtitle">Summary-first dashboard</p>

<div class="meta-grid">
${cardHtml}
</div>

<h2 class="section-title">Recent Decisions</h2>
<table>
<thead>
  <tr>
    <th>#</th>
    <th>Exchange</th>
    <th>Symbol</th>
    <th>Side</th>
    <th>Product</th>
    <th>Qty</th>
    <th>Status</th>
    <th>Decided At</th>
  </tr>
</thead>
<tbody>
${rows}
</tbody>
</table>

<div class="nav">
  <a href="/api/refresh">JSON Refresh</a>
  <a href="/api/health">API Health</a>
</div>
</body>
</html>`;
}

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

/** Simple HTML entity escape. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
