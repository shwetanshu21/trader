// ── Dashboard HTML page composition ──
// Renders the full summary-first dashboard from a DashboardPayload.
// Every section is independently state-aware: ok sections render normally,
// stale sections keep last-known rows with explicit copy, error sections show
// refresh failure banners, and unavailable sections show empty-state messages.
//
// All user-visible text is HTML-escaped. No external dependencies.

import type { DashboardPayload, DashboardSection } from '../dashboard-data.js';
import type {
  OperatorSummaryCard,
  OperatorStrategyPerformance,
  OperatorTickerPerformance,
  OperatorDecisionPerformance,
  OperatorLifecycleState,
  OperatorLifecycleHistory,
  OperatorPromotionHistory,
  OperatorWalkForwardLeaderboard,
} from '../../types/runtime.js';
import {
  escapeHtml,
  formatCurrency,
  formatPercent,
  formatRawPercent,
  formatNumber,
  formatInt,
  formatTimestamp,
  renderSection,
  renderProvenanceBadge,
  renderEmptyState,
  statusClass,
  backtestDetailHref,
  decisionDetailHref,
  renderLink,
  strategyDetailHref,
} from '../render-utils.js';

const DASHBOARD_SECTION_ORDER = [
  'summaryCards',
  'strategyPerformance',
  'tickerPerformance',
  'decisionPerformance',
  'lifecycleStates',
  'governanceHistory',
  'promotionHistory',
  'walkForwardLeaderboard',
] as const;

type DashboardSectionKey = typeof DASHBOARD_SECTION_ORDER[number];

type DashboardSectionHtmlMap = Record<DashboardSectionKey, string>;

export interface DashboardPageOptions {
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Full dashboard page
// ---------------------------------------------------------------------------

/**
 * Render the complete dashboard HTML page from a payload.
 */
export function renderDashboardPage(
  payload: DashboardPayload,
  options: DashboardPageOptions = {},
): string {
  const pollIntervalMs = Math.max(1000, options.pollIntervalMs ?? 30_000);
  const sectionHtml = renderDashboardSectionHtml(payload);
  const sections = DASHBOARD_SECTION_ORDER.map(key => sectionHtml[key]).join('\n');
  const bootstrapJson = buildDashboardBootstrapJson(payload, pollIntervalMs);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Operator Console</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 1.5rem; line-height: 1.5; }
  h1 { font-size: 1.3rem; font-weight: 600; margin-bottom: 0.25rem; }
  h2 { font-size: 1rem; font-weight: 600; margin-bottom: 0.5rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
  .header { margin-bottom: 1.5rem; }
  .header .meta { font-size: 0.85rem; color: #64748b; }
  .section { background: #1e293b; border: 1px solid #334155; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1rem; }
  .section h2 { margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .section-subtitle { font-size: 0.75rem; color: #64748b; font-weight: normal; text-transform: none; letter-spacing: normal; }
  .section-meta { display: flex; flex-wrap: wrap; gap: 0.45rem; align-items: center; margin-bottom: 0.75rem; color: #94a3b8; font-size: 0.76rem; }
  .section-state-pill { display: inline-flex; align-items: center; padding: 0.12rem 0.5rem; border-radius: 999px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.66rem; }
  .section-state-ok { background: #14532d; color: #86efac; }
  .section-state-stale { background: #78350f; color: #fcd34d; }
  .section-state-error { background: #7f1d1d; color: #fca5a5; }
  .section-state-unavailable { background: #334155; color: #cbd5e1; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
  th { text-align: left; padding: 0.4rem 0.5rem; background: #1e293b; color: #64748b; font-weight: 600; border-bottom: 1px solid #334155; white-space: nowrap; }
  td { padding: 0.35rem 0.5rem; border-bottom: 1px solid #1e293b; vertical-align: top; }
  td:first-child { white-space: nowrap; }
  .empty-state { text-align: center; color: #64748b; font-style: italic; padding: 1.5rem 0; }

  /* Summary cards */
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.75rem; }
  .summary-card { background: #0f172a; border: 1px solid #334155; border-radius: 0.5rem; padding: 0.75rem; }
  .summary-card .label { font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .summary-card .value { font-size: 1.25rem; font-weight: 700; margin-top: 0.25rem; color: #f1f5f9; font-variant-numeric: tabular-nums; }
  .summary-card .unit { font-size: 0.7rem; color: #64748b; font-weight: normal; }
  .summary-card .provenance { margin-top: 0.25rem; }

  /* Status classes */
  .status-ok { color: #22c55e; font-weight: 600; }
  .status-warn { color: #f59e0b; font-weight: 600; }
  .status-err { color: #ef4444; font-weight: 600; }
  .status-skip { color: #64748b; }
  .status-default { color: #94a3b8; }

  /* Refresh banner */
  .page-refresh-banner { display: none; align-items: center; gap: 0.6rem; padding: 0.75rem 1rem; border-radius: 0.5rem; margin-bottom: 1rem; border: 1px solid #475569; background: #1e293b; color: #cbd5e1; }
  .page-refresh-banner[data-visible="true"] { display: flex; }
  .page-refresh-banner[data-kind="warn"] { border-color: #78350f; background: #713f1222; color: #fcd34d; }
  .page-refresh-banner[data-kind="error"] { border-color: #7f1d1d; background: #7f1d1d22; color: #fecaca; }
  .page-refresh-banner[data-kind="ok"] { border-color: #14532d; background: #14532d22; color: #86efac; }

  /* Error banner */
  .section-error-banner { display: flex; align-items: center; gap: 0.5rem; background: #7f1d1d22; border: 1px solid #7f1d1d; border-radius: 0.375rem; padding: 0.5rem 0.75rem; margin-bottom: 0.75rem; }
  .section-error-icon { color: #ef4444; font-size: 1rem; }
  .section-error-text { color: #fca5a5; font-size: 0.8125rem; }

  /* Stale banner */
  .section-stale-banner { display: flex; align-items: center; gap: 0.5rem; background: #713f1222; border: 1px solid #78350f; border-radius: 0.375rem; padding: 0.5rem 0.75rem; margin-bottom: 0.75rem; }
  .section-stale-icon { color: #f59e0b; font-size: 1rem; }
  .section-stale-text { color: #fbbf24; font-size: 0.8125rem; }

  /* Unavailable banner */
  .section-unavailable-banner { display: flex; align-items: center; gap: 0.5rem; background: #0f172a; border: 1px solid #475569; border-radius: 0.375rem; padding: 0.5rem 0.75rem; margin-bottom: 0.75rem; }
  .section-unavailable-icon { color: #cbd5e1; font-size: 1rem; }
  .section-unavailable-text { color: #cbd5e1; font-size: 0.8125rem; }

  /* Provenance badge */
  .provenance { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 0.25rem; font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }

  /* Nav */
  .nav { margin-top: 1rem; display: flex; gap: 1rem; font-size: 0.875rem; }
  .nav a { color: #3b82f6; text-decoration: none; }
  .nav a:hover { text-decoration: underline; }

  /* Code */
  code { background: #0f172a; padding: 0.1rem 0.3rem; border-radius: 0.25rem; font-size: 0.75rem; }

  /* Verdict badge */
  .verdict-badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; }

  /* Table cell: numeric alignment */
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  th.num { text-align: right; }
</style>
</head>
<body>
<div class="header">
  <h1>Operator Console</h1>
  <div class="meta" id="dashboard-meta" data-dashboard-meta>
    Assembled: ${escapeHtml(formatTimestamp(payload.assembledAt))} &mdash;
    DB: ${payload.dbAvailable ? 'Connected' : `<span style="color:#ef4444;">Disconnected</span>`}
    ${payload.dbError ? `&mdash; <span style="color:#ef4444;">${escapeHtml(payload.dbError)}</span>` : ''}
  </div>
</div>

<div class="page-refresh-banner" id="dashboard-refresh-banner" data-visible="false" data-kind="warn" role="status" aria-live="polite"></div>

<main id="dashboard-root" data-poll-interval-ms="${escapeHtml(String(pollIntervalMs))}">
${sections}
</main>

<div class="nav">
  <a href="/api/refresh">JSON Refresh</a>
  <a href="/api/health">API Health</a>
</div>

<script type="application/json" id="dashboard-bootstrap">${bootstrapJson}</script>
<script>
(() => {
  const bootstrapNode = document.getElementById('dashboard-bootstrap');
  const refreshBanner = document.getElementById('dashboard-refresh-banner');
  const dashboardMeta = document.getElementById('dashboard-meta');

  function setBanner(kind, message) {
    if (!refreshBanner) return;
    if (!message) {
      refreshBanner.textContent = '';
      refreshBanner.setAttribute('data-visible', 'false');
      refreshBanner.setAttribute('data-kind', kind || 'warn');
      return;
    }
    refreshBanner.textContent = message;
    refreshBanner.setAttribute('data-visible', 'true');
    refreshBanner.setAttribute('data-kind', kind || 'warn');
  }

  function formatTimestamp(iso) {
    if (!iso || typeof iso !== 'string') return '—';
    return iso.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace(/\.\d{3}\+.*$/, '').slice(0, 19);
  }

  function renderHeaderMeta(payload) {
    if (!dashboardMeta) return;
    const dbStatus = payload && payload.dbAvailable
      ? 'Connected'
      : '<span style="color:#ef4444;">Disconnected</span>';
    const dbError = payload && payload.dbError
      ? '&mdash; <span style="color:#ef4444;">' + String(payload.dbError).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') + '</span>'
      : '';
    dashboardMeta.innerHTML = 'Assembled: ' + formatTimestamp(payload && payload.assembledAt) + ' &mdash; DB: ' + dbStatus + ' ' + dbError;
  }

  function replaceSection(sectionKey, nextHtml) {
    if (typeof nextHtml !== 'string' || nextHtml.trim().length === 0) {
      return false;
    }
    const current = document.querySelector('[data-dashboard-section="' + sectionKey + '"]');
    if (!current) {
      return false;
    }
    const template = document.createElement('template');
    template.innerHTML = nextHtml.trim();
    const next = template.content.firstElementChild;
    if (!next) {
      return false;
    }
    current.replaceWith(next);
    return true;
  }

  function applyRefreshPayload(payload) {
    if (!payload || typeof payload !== 'object' || !payload.sections || typeof payload.sections !== 'object') {
      setBanner('warn', 'Live refresh degraded: malformed refresh payload. Keeping the last known dashboard view.');
      return;
    }

    let malformedSection = false;
    for (const [sectionKey, sectionPayload] of Object.entries(payload.sections)) {
      if (!sectionPayload || typeof sectionPayload !== 'object' || typeof sectionPayload.html !== 'string') {
        malformedSection = true;
        continue;
      }
      replaceSection(sectionKey, sectionPayload.html);
    }

    renderHeaderMeta(payload);

    if (malformedSection) {
      setBanner('warn', 'Live refresh skipped one or more malformed section updates. Existing dashboard content was preserved.');
      return;
    }

    if (payload.dbAvailable === false) {
      setBanner('warn', 'Live refresh reports the operator database as unavailable. Existing dashboard content remains visible.');
      return;
    }

    setBanner('', '');
  }

  let bootstrap;
  try {
    bootstrap = JSON.parse(bootstrapNode && bootstrapNode.textContent ? bootstrapNode.textContent : '{}');
  } catch (_error) {
    setBanner('warn', 'Live refresh bootstrap could not be parsed. The dashboard will remain static until reload.');
    return;
  }

  const pollIntervalMs = Number(bootstrap.pollIntervalMs);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
    setBanner('warn', 'Live refresh is disabled because the poll interval is invalid.');
    return;
  }

  const refreshUrl = typeof bootstrap.refreshUrl === 'string' ? bootstrap.refreshUrl : '/api/refresh';
  const timeoutMs = Math.max(1000, Math.min(10000, Math.floor(pollIntervalMs * 0.9)));
  let stopped = false;

  async function pollOnce() {
    if (stopped) return;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const response = await fetch(refreshUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });
      const rawBody = await response.text();
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (_error) {
        setBanner('warn', 'Live refresh returned malformed JSON. Keeping the last known dashboard view.');
        return;
      }
      applyRefreshPayload(payload);
    } catch (error) {
      const message = error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
        ? 'Live refresh timed out. Keeping the last known dashboard view until the next poll.'
        : 'Live refresh failed. Keeping the last known dashboard view until the next poll.';
      setBanner('warn', message);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (!stopped) {
        window.setTimeout(pollOnce, pollIntervalMs);
      }
    }
  }

  window.setTimeout(pollOnce, pollIntervalMs);
  window.addEventListener('beforeunload', () => {
    stopped = true;
  }, { once: true });
})();
</script>
</body>
</html>`;
}

export function renderDashboardSectionHtml(payload: DashboardPayload): DashboardSectionHtmlMap {
  return {
    summaryCards: renderSummaryCardsSection(payload.summaryCards),
    strategyPerformance: renderStrategyPerformanceSection(payload.strategyPerformance),
    tickerPerformance: renderTickerPerformanceSection(payload.tickerPerformance),
    decisionPerformance: renderDecisionPerformanceSection(payload.decisionPerformance),
    lifecycleStates: renderLifecycleStatesSection(payload.lifecycleStates),
    governanceHistory: renderGovernanceHistorySection(payload.governanceHistory),
    promotionHistory: renderPromotionHistorySection(payload.promotionHistory),
    walkForwardLeaderboard: renderWalkForwardLeaderboardSection(payload.walkForwardLeaderboard),
  };
}

function buildDashboardBootstrapJson(payload: DashboardPayload, pollIntervalMs: number): string {
  const bootstrap = {
    refreshUrl: '/api/refresh',
    pollIntervalMs,
    assembledAt: payload.assembledAt,
    dbAvailable: payload.dbAvailable,
    dbError: payload.dbError,
    sections: Object.fromEntries(DASHBOARD_SECTION_ORDER.map(key => [key, summarizeSection(payload[key])])),
  };

  return JSON.stringify(bootstrap).replace(/</g, '\\u003c');
}

function summarizeSection<T>(section: DashboardSection<T>) {
  return {
    state: section.state,
    errorMessage: section.errorMessage,
    stalenessMs: section.stalenessMs,
    lastFetchedAt: section.lastFetchedAt,
    isCachedData: section.isCachedData,
  };
}

function renderDashboardSectionWrapper<T>(
  sectionKey: DashboardSectionKey,
  title: string,
  subtitle: string,
  section: DashboardSection<T>,
  content: string,
): string {
  return renderSection(
    title,
    content,
    section.state,
    section.errorMessage,
    section.stalenessMs,
    subtitle,
    {
      id: `dashboard-section-${sectionKey}`,
      dataKey: sectionKey,
      lastFetchedAt: section.lastFetchedAt,
      isCachedData: section.isCachedData,
    },
  );
}

// ---------------------------------------------------------------------------
// Section renderers — each consumes a DashboardSection<T> and renders
// the appropriate HTML based on the section's state.
// ---------------------------------------------------------------------------

// ── 1. Summary Cards ───────────────────────────────────────────────────

function renderSummaryCardsSection(
  section: DashboardSection<OperatorSummaryCard[]>,
): string {
  let content: string;

  if ((section.state === 'ok' || section.state === 'stale') && section.data.length > 0) {
    const cards = section.data.map(c => {
      const value = typeof c.value === 'number'
        ? c.unit === 'INR'
          ? formatCurrency(c.value, c.unit)
          : `${escapeHtml(formatNumber(c.value))}`
        : escapeHtml(String(c.value));

      const label = escapeHtml(c.label || c.key || '');
      const badge = renderProvenanceBadge(c.provenance);

      return `<div class="summary-card">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
        ${badge ? `<div class="provenance">${badge}</div>` : ''}
      </div>`;
    }).join('\n');
    content = `<div class="summary-grid">${cards}</div>`;
  } else if (section.state === 'unavailable') {
    content = renderEmptyState('Database unavailable — summary cards cannot be loaded.');
  } else if (section.state === 'error') {
    content = renderEmptyState(section.errorMessage ?? 'Failed to load summary cards.');
  } else {
    content = renderEmptyState('No summary data available.');
  }

  return renderDashboardSectionWrapper(
    'summaryCards',
    'Summary',
    'Aggregate totals',
    section,
    content,
  );
}

// ── 2. Strategy Performance ─────────────────────────────────────────────

function renderStrategyPerformanceSection(
  section: DashboardSection<OperatorStrategyPerformance[]>,
): string {
  let content: string;

  if ((section.state === 'ok' || section.state === 'stale') && section.data.length > 0) {
    const rows = section.data.map(s => {
      const sharpe = s.sharpeRatio !== null ? formatNumber(s.sharpeRatio, 2) : '—';
      const drawdown = s.maxDrawdownPct !== null ? formatRawPercent(s.maxDrawdownPct) : '—';
      const winRate = s.winRate !== null ? formatPercent(s.winRate) : '—';
      const profitFactor = s.profitFactor !== null ? formatNumber(s.profitFactor, 2) : '—';
      const badge = renderProvenanceBadge(s.provenance);
      const strategyHref = strategyDetailHref(s.strategyId, s.strategyVersion);

      return `<tr>
        <td>${renderLink(strategyHref, s.strategyId)}</td>
        <td><code>${escapeHtml(s.strategyVersion)}</code></td>
        <td class="num">${formatInt(s.tradeCount)}</td>
        <td class="num ${s.realizedPnl >= 0 ? 'status-ok' : 'status-err'}">${formatCurrency(s.realizedPnl, 'INR')}</td>
        <td class="num ${s.unrealizedPnl >= 0 ? 'status-ok' : 'status-err'}">${formatCurrency(s.unrealizedPnl, 'INR')}</td>
        <td class="num ${s.totalReturnPct >= 0 ? 'status-ok' : 'status-err'}">${formatRawPercent(s.totalReturnPct)}</td>
        <td class="num">${sharpe}</td>
        <td class="num">${drawdown}</td>
        <td class="num">${winRate}</td>
        <td class="num">${profitFactor}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('\n');

    content = `<table>
      <thead><tr>
        <th>Strategy</th>
        <th>Version</th>
        <th class="num">Trades</th>
        <th class="num">Realized P&amp;L</th>
        <th class="num">Unrealized P&amp;L</th>
        <th class="num">Return</th>
        <th class="num">Sharpe</th>
        <th class="num">Max DD</th>
        <th class="num">Win Rate</th>
        <th class="num">Profit Factor</th>
        <th>Source</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } else if (section.state === 'unavailable') {
    content = renderEmptyState('Database unavailable — strategy performance cannot be loaded.');
  } else if (section.state === 'error') {
    content = renderEmptyState(section.errorMessage ?? 'Failed to load strategy performance.');
  } else {
    content = renderEmptyState('No strategy performance data available.');
  }

  return renderDashboardSectionWrapper(
    'strategyPerformance',
    'Strategy Performance',
    'Per-strategy P&L and metrics',
    section,
    content,
  );
}

// ── 3. Ticker Performance ───────────────────────────────────────────────

function renderTickerPerformanceSection(
  section: DashboardSection<OperatorTickerPerformance[]>,
): string {
  let content: string;

  if ((section.state === 'ok' || section.state === 'stale') && section.data.length > 0) {
    const rows = section.data.map(t => {
      const sideColor = t.netQuantity > 0 ? 'status-ok' : t.netQuantity < 0 ? 'status-err' : 'status-skip';
      const sideLabel = t.netQuantity > 0 ? 'Long' : t.netQuantity < 0 ? 'Short' : 'Flat';
      const entry = t.avgEntryPrice !== null ? formatCurrency(t.avgEntryPrice, null) : '—';
      const last = t.lastPrice !== null ? formatCurrency(t.lastPrice, null) : '—';
      const winRate = t.winRate !== null ? formatPercent(t.winRate) : '—';
      const badge = renderProvenanceBadge(t.provenance);

      return `<tr>
        <td><code>${escapeHtml(t.exchange)}</code></td>
        <td><code>${escapeHtml(t.tradingsymbol)}</code></td>
        <td class="num"><span class="${sideColor}">${sideLabel}</span></td>
        <td class="num">${formatInt(t.netQuantity)}</td>
        <td class="num">${entry}</td>
        <td class="num">${last}</td>
        <td class="num">${formatInt(t.tradeCount)}</td>
        <td class="num">${winRate}</td>
        <td class="num ${t.realizedPnl >= 0 ? 'status-ok' : 'status-err'}">${formatCurrency(t.realizedPnl, null)}</td>
        <td class="num ${t.unrealizedPnl >= 0 ? 'status-ok' : 'status-err'}">${formatCurrency(t.unrealizedPnl, null)}</td>
        <td class="num ${t.totalPnl >= 0 ? 'status-ok' : 'status-err'}">${formatCurrency(t.totalPnl, null)}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('\n');

    content = `<table>
      <thead><tr>
        <th>Exchange</th>
        <th>Symbol</th>
        <th>Side</th>
        <th class="num">Qty</th>
        <th class="num">Entry</th>
        <th class="num">Last</th>
        <th class="num">Trades</th>
        <th class="num">Win Rate</th>
        <th class="num">Realized</th>
        <th class="num">Unrealized</th>
        <th class="num">Total</th>
        <th>Source</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } else if (section.state === 'unavailable') {
    content = renderEmptyState('Database unavailable — ticker performance cannot be loaded.');
  } else if (section.state === 'error') {
    content = renderEmptyState(section.errorMessage ?? 'Failed to load ticker performance.');
  } else {
    content = renderEmptyState('No ticker performance data available.');
  }

  return renderDashboardSectionWrapper(
    'tickerPerformance',
    'Ticker Performance',
    'Per-symbol P&L and position state',
    section,
    content,
  );
}

// ── 4. Decision Performance ─────────────────────────────────────────────

function renderDecisionPerformanceSection(
  section: DashboardSection<OperatorDecisionPerformance[]>,
): string {
  let content: string;

  if ((section.state === 'ok' || section.state === 'stale') && section.data.length > 0) {
    const rows = section.data.map(d => {
      const status = d.decisionStatus;
      const execStatus = d.executionStatus ?? '—';
      const outcome = d.outcomeCode ?? '—';
      const pnl = d.realizedPnl !== null
        ? `<span class="${d.realizedPnl >= 0 ? 'status-ok' : 'status-err'}">${formatCurrency(d.realizedPnl, null)}</span>`
        : '—';
      const badge = renderProvenanceBadge(d.provenance);
      const decisionHref = decisionDetailHref(d.decisionId);

      return `<tr>
        <td><code>${escapeHtml(d.exchange)}</code></td>
        <td>${renderLink(decisionHref, d.tradingsymbol)}</td>
        <td>${escapeHtml(d.side)}</td>
        <td class="num">${formatInt(d.quantity)}</td>
        <td><span class="${statusClass(status)}">${escapeHtml(status)}</span></td>
        <td>${escapeHtml(execStatus)}</td>
        <td>${escapeHtml(outcome)}</td>
        <td class="num">${pnl}</td>
        <td><code>${escapeHtml(d.strategyId)}</code></td>
        <td>${escapeHtml(formatTimestamp(d.decidedAt))}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('\n');

    content = `<table>
      <thead><tr>
        <th>Exchange</th>
        <th>Symbol</th>
        <th>Side</th>
        <th class="num">Qty</th>
        <th>Status</th>
        <th>Exec Status</th>
        <th>Outcome</th>
        <th class="num">Realized P&amp;L</th>
        <th>Strategy</th>
        <th>Decided At</th>
        <th>Source</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } else if (section.state === 'unavailable') {
    content = renderEmptyState('Database unavailable — decision performance cannot be loaded.');
  } else if (section.state === 'error') {
    content = renderEmptyState(section.errorMessage ?? 'Failed to load decision performance.');
  } else {
    content = renderEmptyState('No decision performance data available.');
  }

  return renderDashboardSectionWrapper(
    'decisionPerformance',
    'Recent Decisions',
    'Newest first',
    section,
    content,
  );
}

// ── 5. Lifecycle States ─────────────────────────────────────────────────

function renderLifecycleStatesSection(
  section: DashboardSection<OperatorLifecycleState[]>,
): string {
  let content: string;

  if ((section.state === 'ok' || section.state === 'stale') && section.data.length > 0) {
    const rows = section.data.map(s => {
      const phaseColor = statusClass(s.phase);
      const badge = renderProvenanceBadge(s.provenance);

      return `<tr>
        <td><code>${escapeHtml(s.strategyId)}</code></td>
        <td><code>${escapeHtml(s.strategyVersion)}</code></td>
        <td><code>${escapeHtml(s.marketId)}</code></td>
        <td><span class="${phaseColor}">${escapeHtml(s.phase)}</span></td>
        <td>${escapeHtml(formatTimestamp(s.updatedAt))}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('\n');

    content = `<table>
      <thead><tr>
        <th>Strategy</th>
        <th>Version</th>
        <th>Market</th>
        <th>Phase</th>
        <th>Updated At</th>
        <th>Source</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } else if (section.state === 'unavailable') {
    content = renderEmptyState('Database unavailable — lifecycle states cannot be loaded.');
  } else if (section.state === 'error') {
    content = renderEmptyState(section.errorMessage ?? 'Failed to load lifecycle states.');
  } else {
    content = renderEmptyState('No lifecycle state data available.');
  }

  return renderDashboardSectionWrapper(
    'lifecycleStates',
    'Lifecycle States',
    'Current strategy phases',
    section,
    content,
  );
}

// ── 6. Governance History ───────────────────────────────────────────────

function renderGovernanceHistorySection(
  section: DashboardSection<OperatorLifecycleHistory[]>,
): string {
  let content: string;

  if ((section.state === 'ok' || section.state === 'stale') && section.data.length > 0) {
    const rows = section.data.map(g => {
      const verdictClass = statusClass(g.verdict);
      const badge = renderProvenanceBadge(g.provenance);

      return `<tr>
        <td><code>${escapeHtml(g.strategyId)}</code></td>
        <td><span class="${verdictClass}">${escapeHtml(g.verdict)}</span></td>
        <td><code>${escapeHtml(g.previousPhase)}</code></td>
        <td><code>${escapeHtml(g.newPhase)}</code></td>
        <td style="max-width:250px;word-break:break-word;">${escapeHtml(g.rationale)}</td>
        <td>${escapeHtml(formatTimestamp(g.recordedAt))}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('\n');

    content = `<table>
      <thead><tr>
        <th>Strategy</th>
        <th>Verdict</th>
        <th>From</th>
        <th>To</th>
        <th>Rationale</th>
        <th>Timestamp</th>
        <th>Source</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } else if (section.state === 'unavailable') {
    content = renderEmptyState('Database unavailable — governance history cannot be loaded.');
  } else if (section.state === 'error') {
    content = renderEmptyState(section.errorMessage ?? 'Failed to load governance history.');
  } else {
    content = renderEmptyState('No governance history data available.');
  }

  return renderDashboardSectionWrapper(
    'governanceHistory',
    'Governance History',
    'Lifecycle phase decisions',
    section,
    content,
  );
}

// ── 7. Promotion History ────────────────────────────────────────────────

function renderPromotionHistorySection(
  section: DashboardSection<OperatorPromotionHistory[]>,
): string {
  let content: string;

  if ((section.state === 'ok' || section.state === 'stale') && section.data.length > 0) {
    const rows = section.data.map(p => {
      const badge = renderProvenanceBadge(p.provenance);
      const strategyHref = strategyDetailHref(p.strategyId, p.strategyVersion);
      const winnerRef = p.winnerId !== null
        ? `<code>WF#${p.winnerId}</code>`
        : '<span class="status-warn">No winner recorded</span>';

      return `<tr>
        <td>${renderLink(strategyHref, p.strategyId)}</td>
        <td><code>${escapeHtml(p.previousPhase)}</code></td>
        <td><code><span class="status-ok">${escapeHtml(p.newPhase)}</span></code></td>
        <td style="max-width:250px;word-break:break-word;">${escapeHtml(p.rationale)}</td>
        <td>${winnerRef}</td>
        <td>${escapeHtml(formatTimestamp(p.promotedAt))}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('\n');

    content = `<table>
      <thead><tr>
        <th>Strategy</th>
        <th>From</th>
        <th>To</th>
        <th>Rationale</th>
        <th>Winner Ref</th>
        <th>Promoted At</th>
        <th>Source</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } else if (section.state === 'unavailable') {
    content = renderEmptyState('Database unavailable — promotion history cannot be loaded.');
  } else if (section.state === 'error') {
    content = renderEmptyState(section.errorMessage ?? 'Failed to load promotion history.');
  } else {
    content = renderEmptyState('No promotion history data available.');
  }

  return renderDashboardSectionWrapper(
    'promotionHistory',
    'Promotion History',
    'Lifecycle promotions only',
    section,
    content,
  );
}

// ── 8. Walk-Forward Leaderboard ─────────────────────────────────────────

function renderWalkForwardLeaderboardSection(
  section: DashboardSection<OperatorWalkForwardLeaderboard[]>,
): string {
  let content: string;

  if ((section.state === 'ok' || section.state === 'stale') && section.data.length > 0) {
    const rows = section.data.map(w => {
      const mergedScore = w.mergedScore !== null ? formatPercent(w.mergedScore) : '—';
      const sharpe = w.sharpeRatio !== null ? formatNumber(w.sharpeRatio, 2) : '—';
      const totalReturn = w.totalReturnPct !== null ? formatRawPercent(w.totalReturnPct) : '—';
      const drawdown = w.maxDrawdownPct !== null ? formatRawPercent(w.maxDrawdownPct) : '—';
      const winRate = w.winRate !== null ? formatPercent(w.winRate) : '—';
      const badge = renderProvenanceBadge(w.provenance);
      const selectedAt = w.selectedAt ? formatTimestamp(w.selectedAt) : '—';
      const runHref = backtestDetailHref(w.runId);
      const strategyHref = strategyDetailHref(w.strategyId, w.strategyVersion);

      return `<tr>
        <td>${renderLink(runHref, w.label)}</td>
        <td>${renderLink(strategyHref, w.strategyId)}</td>
        <td class="num">${formatInt(w.windowCount)}</td>
        <td class="num">${mergedScore}</td>
        <td class="num">${sharpe}</td>
        <td class="num ${(w.totalReturnPct ?? 0) >= 0 ? 'status-ok' : 'status-err'}">${totalReturn}</td>
        <td class="num">${drawdown}</td>
        <td class="num">${winRate}</td>
        <td><code>${escapeHtml(w.selectionStrategy ?? '—')}</code></td>
        <td>${escapeHtml(selectedAt)}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('\n');

    content = `<table>
      <thead><tr>
        <th>Run</th>
        <th>Strategy</th>
        <th class="num">Windows</th>
        <th class="num">Score</th>
        <th class="num">Sharpe</th>
        <th class="num">Return</th>
        <th class="num">Max DD</th>
        <th class="num">Win Rate</th>
        <th>Selection</th>
        <th>Selected At</th>
        <th>Source</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } else if (section.state === 'unavailable') {
    content = renderEmptyState('Database unavailable — walk-forward leaderboard cannot be loaded.');
  } else if (section.state === 'error') {
    content = renderEmptyState(section.errorMessage ?? 'Failed to load walk-forward leaderboard.');
  } else {
    content = renderEmptyState('No walk-forward leaderboard data available.');
  }

  return renderDashboardSectionWrapper(
    'walkForwardLeaderboard',
    'Walk-Forward Leaderboard',
    'Historical backtest results',
    section,
    content,
  );
}
