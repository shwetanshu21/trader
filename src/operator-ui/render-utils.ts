// ── Operator UI render utilities ──
// Shared HTML rendering helpers for the operator dashboard and detail pages.
// All user-supplied text is HTML-escaped before interpolation.
// Zero external dependencies — uses Node built-ins only.

import type { OperatorProvenance } from '../types/runtime.js';

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

/**
 * HTML-entity escape a string for safe interpolation into HTML content.
 * Handles &, <, >, ", and '.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format a number as currency (INR). */
export function formatCurrency(value: number, unit: string | null = 'INR'): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const formatted = abs.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return unit ? `${sign}₹${formatted}` : `${sign}${formatted}`;
}

/** Format a number as a percentage (0-1 → "XX.X%"). */
export function formatPercent(value: number | null, decimals = 1): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(decimals)}%`;
}

/** Format a raw percentage value (e.g. 12.5 → "12.5%"). */
export function formatRawPercent(value: number | null, decimals = 1): string {
  if (value === null) return '—';
  return `${value.toFixed(decimals)}%`;
}

/** Format a number with tabular-nums-friendly formatting. */
export function formatNumber(value: number, decimals = 2): string {
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Format an integer. */
export function formatInt(value: number): string {
  return Math.round(value).toLocaleString('en-IN');
}

/** Format staleness duration (ms) to a human-readable string. */
export function formatStaleness(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** ISO timestamp to compact display (e.g. "2025-01-15 14:30:05"). */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace(/\.\d{3}\+.*$/, '').substring(0, 19);
}

/** Truncate text in the middle, keeping head and tail visible. */
export function truncateMid(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor((maxLen - 3) / 2);
  return text.slice(0, half) + '...' + text.slice(text.length - half);
}

/** Format arbitrary JSON-like data for a readable preformatted block. */
export function formatJson(value: unknown): string {
  return escapeHtml(JSON.stringify(value, null, 2));
}

/** Format a nullable scalar for display. */
export function formatNullable(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return escapeHtml(String(value));
}

// ---------------------------------------------------------------------------
// Verdict/status color helpers
// ---------------------------------------------------------------------------

/** Get CSS color for a verdict or state string. */
export function verdictColor(verdict: string): string {
  switch (verdict) {
    case 'healthy':
    case 'approved':
    case 'accepted':
    case 'promote':
    case 'sufficient':
    case 'ok':
      return '#22c55e';
    case 'degraded':
    case 'refused':
    case 'demote':
    case 'stale':
    case 'warning':
      return '#f59e0b';
    case 'unhealthy':
    case 'error':
    case 'critical':
      return '#ef4444';
    case 'backtest':
      return '#94a3b8';
    case 'paper':
      return '#f59e0b';
    case 'live':
      return '#22c55e';
    default:
      return '#6b7280';
  }
}

// ---------------------------------------------------------------------------
// Provenance label
// ---------------------------------------------------------------------------

/** Render a compact provenance badge. */
export function renderProvenanceBadge(provenance: OperatorProvenance | null): string {
  if (!provenance) return '';
  const sourceColor = provenance.source === 'historical' ? '#6366f1'
    : provenance.source === 'runtime' ? '#22c55e'
    : '#f59e0b';
  return `<span class="provenance" style="background:${sourceColor}22;color:${sourceColor}" title="Source: ${escapeHtml(provenance.source)}${provenance.sourceLabel ? ` (${escapeHtml(provenance.sourceLabel)})` : ''} | As of: ${new Date(provenance.asOf).toISOString()}">${escapeHtml(provenance.source)}</span>`;
}

// ---------------------------------------------------------------------------
// Links / routes
// ---------------------------------------------------------------------------

function buildPath(path: string, params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }
  return `${path}?${search.toString()}`;
}

export function decisionDetailHref(decisionId: number): string {
  return buildPath('/decision', { id: decisionId });
}

export function strategyDetailHref(strategyId: string, strategyVersion: string): string {
  return buildPath('/strategy', { strategyId, strategyVersion });
}

export function backtestDetailHref(runId: number): string {
  return buildPath('/backtest', { runId });
}

export type OperatorConsoleNavKey =
  | 'overview'
  | 'positions'
  | 'strategies'
  | 'decisions'
  | 'governance'
  | 'system-health';

const OPERATOR_CONSOLE_NAV: Array<{ key: OperatorConsoleNavKey; label: string; href: string; description: string }> = [
  { key: 'overview', label: 'Overview', href: '/', description: 'Command view and live operator summary' },
  { key: 'positions', label: 'Positions & Exposure', href: '/positions', description: 'Open positions, concentration, and exposure proxies' },
  { key: 'strategies', label: 'Strategies', href: '/strategies', description: 'Strategy performance and attributed exposure' },
  { key: 'decisions', label: 'Decision Ledger', href: '/decisions', description: 'Recent decisions and execution outcomes' },
  { key: 'governance', label: 'Governance & Backtests', href: '/governance', description: 'Lifecycle history and walk-forward evidence' },
  { key: 'system-health', label: 'System Health', href: '/system-health', description: 'Operator API health and diagnostics' },
];

export function renderOperatorConsoleNav(active?: OperatorConsoleNavKey): string {
  const items = OPERATOR_CONSOLE_NAV.map(item => {
    const activeAttr = item.key === active ? ' data-active="true" aria-current="page"' : ' data-active="false"';
    return `<a class="console-nav-link" href="${item.href}"${activeAttr}>
      <span class="console-nav-label">${escapeHtml(item.label)}</span>
      <span class="console-nav-description">${escapeHtml(item.description)}</span>
    </a>`;
  }).join('');

  return `<aside class="console-sidebar">
    <div class="console-brand">
      <div class="console-brand-kicker">Trader</div>
      <div class="console-brand-title">Operator Console</div>
      <div class="console-brand-subtitle">Authenticated evidence and runtime review</div>
    </div>
    <nav class="console-nav" aria-label="Operator Console Navigation">${items}</nav>
  </aside>`;
}

/** Render an anchor with escaped text. */
export function renderLink(href: string, text: string, title?: string): string {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${href}"${titleAttr}>${escapeHtml(text)}</a>`;
}

// ---------------------------------------------------------------------------
// Section state badges
// ---------------------------------------------------------------------------

function sectionStateLabel(state: 'ok' | 'error' | 'stale' | 'unavailable'): string {
  switch (state) {
    case 'ok':
      return 'Live';
    case 'stale':
      return 'Stale';
    case 'error':
      return 'Refresh failed';
    case 'unavailable':
      return 'Unavailable';
  }
}

/** Render an error banner for a failed section. */
export function renderErrorBanner(message: string): string {
  return `<div class="section-error-banner" role="status" aria-live="polite">
    <span class="section-error-icon">⚠</span>
    <span class="section-error-text">${escapeHtml(message)}</span>
  </div>`;
}

/** Render a stale-data banner. */
export function renderStaleBanner(
  stalenessMs: number | null,
  lastFetchedAt: string | null = null,
  diagnosticMessage: string | null = null,
  isCachedData = false,
): string {
  const freshness = stalenessMs === null
    ? 'Refresh freshness is unknown.'
    : `Last successful snapshot is ${escapeHtml(formatStaleness(stalenessMs))} old.`;
  const lastKnownCopy = isCachedData
    ? lastFetchedAt
      ? `Showing last known data from ${escapeHtml(formatTimestamp(lastFetchedAt))}.`
      : 'Showing last known data from the most recent successful refresh.'
    : 'Section data may be stale.';
  const diagnostics = diagnosticMessage
    ? ` Diagnostics: ${escapeHtml(diagnosticMessage)}`
    : '';

  return `<div class="section-stale-banner" role="status" aria-live="polite">
    <span class="section-stale-icon">⟳</span>
    <span class="section-stale-text">${lastKnownCopy} ${freshness}${diagnostics}</span>
  </div>`;
}

/** Render an unavailable-data banner. */
export function renderUnavailableBanner(message: string): string {
  return `<div class="section-unavailable-banner" role="status" aria-live="polite">
    <span class="section-unavailable-icon">⊘</span>
    <span class="section-unavailable-text">${escapeHtml(message)}</span>
  </div>`;
}

/** Render an empty state placeholder. */
export function renderEmptyState(message: string): string {
  return `<p class="empty-state">${escapeHtml(message)}</p>`;
}

export interface RenderSectionOptions {
  id?: string;
  dataKey?: string;
  lastFetchedAt?: string | null;
  isCachedData?: boolean;
}

// ---------------------------------------------------------------------------
// Standard section wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap section content in a standard section container with state banners.
 */
export function renderSection(
  title: string,
  content: string,
  state: 'ok' | 'error' | 'stale' | 'unavailable' = 'ok',
  errorMessage: string | null = null,
  stalenessMs: number | null = null,
  subtitle: string | null = null,
  options: RenderSectionOptions = {},
): string {
  const borderColor = state === 'error' ? '#ef4444'
    : state === 'stale' ? '#f59e0b'
    : state === 'unavailable' ? '#64748b'
    : '#334155';

  const sectionId = options.id ? ` id="${escapeHtml(options.id)}"` : '';
  const dataKey = options.dataKey ? ` data-dashboard-section="${escapeHtml(options.dataKey)}"` : '';
  const lastFetchedAttr = options.lastFetchedAt ? ` data-last-fetched-at="${escapeHtml(options.lastFetchedAt)}"` : '';
  const staleAttr = stalenessMs !== null ? ` data-staleness-ms="${escapeHtml(String(stalenessMs))}"` : '';
  const cachedAttr = ` data-is-cached-data="${options.isCachedData ? 'true' : 'false'}"`;
  const stateAttr = ` data-section-state="${escapeHtml(state)}"`;

  let banner = '';
  if (state === 'error' && errorMessage) {
    banner = renderErrorBanner(errorMessage);
  } else if (state === 'stale') {
    banner = renderStaleBanner(stalenessMs, options.lastFetchedAt ?? null, errorMessage, options.isCachedData ?? false);
  } else if (state === 'unavailable') {
    banner = renderUnavailableBanner(errorMessage ?? 'Section data is not available.');
  }

  const subtitleHtml = subtitle ? `<span class="section-subtitle">${escapeHtml(subtitle)}</span>` : '';
  const freshnessMeta = [
    `<span class="section-state-pill section-state-${escapeHtml(state)}">${escapeHtml(sectionStateLabel(state))}</span>`,
    options.lastFetchedAt
      ? `<span>Last fetched ${escapeHtml(formatTimestamp(options.lastFetchedAt))}</span>`
      : state === 'unavailable'
        ? '<span>No database snapshot available.</span>'
        : '<span>No successful fetch recorded yet.</span>',
    state === 'stale' && stalenessMs !== null
      ? `<span>Age ${escapeHtml(formatStaleness(stalenessMs))}</span>`
      : '',
    options.isCachedData ? '<span>Showing last known data.</span>' : '',
  ].filter(Boolean).join('<span aria-hidden="true">•</span>');

  return `<section class="section"${sectionId}${dataKey}${stateAttr}${lastFetchedAttr}${staleAttr}${cachedAttr} style="border-left: 3px solid ${borderColor};">
    <h2>${escapeHtml(title)} ${subtitleHtml}</h2>
    <div class="section-meta" data-section-meta>${freshnessMeta}</div>
    ${banner}
    ${state === 'unavailable' ? renderEmptyState(errorMessage ?? 'Section data is not available.') : content}
  </section>`;
}

// ---------------------------------------------------------------------------
// Generic page helpers used by detail routes and error pages
// ---------------------------------------------------------------------------

const PAGE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    color-scheme: dark;
    --bg: #08111f;
    --bg-elevated: #0f1b2d;
    --bg-panel: #132033;
    --bg-panel-2: #17263b;
    --border: #24364d;
    --border-strong: #36506d;
    --text: #e6edf6;
    --muted: #8ba0ba;
    --muted-2: #62748a;
    --ok: #34d399;
    --warn: #fbbf24;
    --err: #f87171;
    --info: #60a5fa;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: radial-gradient(circle at top left, #10223b 0%, var(--bg) 42%), var(--bg);
    color: var(--text);
    padding: 1.25rem;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  a { color: #8cc0ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  h1 { font-size: 1.55rem; font-weight: 700; margin-bottom: 0.25rem; letter-spacing: -0.02em; }
  h2 { font-size: 1rem; font-weight: 650; margin-bottom: 0.65rem; color: #d5deea; }
  h3 { font-size: 0.9rem; font-weight: 600; margin-bottom: 0.5rem; color: #d5deea; }
  p { color: #d1d8e3; }
  code { background: #0a1424; padding: 0.1rem 0.3rem; border-radius: 0.25rem; font-size: 0.78rem; }
  pre { background: #020617; border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.85rem; overflow-x: auto; font-size: 0.78rem; color: var(--text); }
  ul, ol { padding-left: 1.15rem; }
  li + li { margin-top: 0.35rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
  th { text-align: left; padding: 0.55rem 0.5rem; color: #9eb0c7; font-weight: 600; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 0.5rem 0.5rem; border-bottom: 1px solid rgba(36, 54, 77, 0.65); vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .console-shell { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 1rem; align-items: start; }
  .console-sidebar { position: sticky; top: 1.25rem; background: linear-gradient(180deg, rgba(19,32,51,0.94), rgba(12,20,34,0.98)); border: 1px solid var(--border); border-radius: 0.9rem; padding: 1rem; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.22); }
  .console-brand { padding-bottom: 0.9rem; margin-bottom: 0.9rem; border-bottom: 1px solid rgba(54,80,109,0.35); }
  .console-brand-kicker { color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.68rem; font-weight: 700; }
  .console-brand-title { margin-top: 0.2rem; font-size: 1rem; font-weight: 700; color: #f8fbff; }
  .console-brand-subtitle { margin-top: 0.25rem; color: var(--muted); font-size: 0.82rem; text-wrap: pretty; }
  .console-nav { display: grid; gap: 0.45rem; }
  .console-nav-link { display: block; padding: 0.7rem 0.8rem; border-radius: 0.75rem; border: 1px solid transparent; background: rgba(10, 20, 36, 0.28); transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease; }
  .console-nav-link:hover { text-decoration: none; background: rgba(23, 38, 59, 0.9); border-color: rgba(54, 80, 109, 0.7); transform: translateY(-1px); }
  .console-nav-link[data-active="true"] { background: rgba(24, 42, 65, 0.96); border-color: rgba(96, 165, 250, 0.55); box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.18); }
  .console-nav-label { display: block; color: #eef4fb; font-weight: 600; font-size: 0.9rem; }
  .console-nav-description { display: block; margin-top: 0.18rem; color: var(--muted); font-size: 0.76rem; line-height: 1.35; }
  .console-main { min-width: 0; }
  .page-header { margin-bottom: 1.2rem; padding: 1rem 1.1rem; background: linear-gradient(180deg, rgba(19,32,51,0.96), rgba(14,25,41,0.96)); border: 1px solid var(--border); border-radius: 0.9rem; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18); }
  .page-kicker { color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.72rem; font-weight: 700; margin-bottom: 0.35rem; }
  .page-subtitle { color: #a6b7cc; max-width: 75rem; text-wrap: pretty; }
  .page-meta { margin-top: 0.55rem; color: var(--muted-2); font-size: 0.85rem; }
  .page-actions { margin-top: 0.9rem; display: flex; flex-wrap: wrap; gap: 0.85rem; font-size: 0.9rem; }
  .section { background: linear-gradient(180deg, rgba(19,32,51,0.96), rgba(15,27,45,0.97)); border: 1px solid var(--border); border-radius: 0.85rem; padding: 1rem; margin-bottom: 1rem; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.14); }
  .section-subtitle { font-size: 0.75rem; color: var(--muted); font-weight: normal; text-transform: none; letter-spacing: normal; }
  .section-meta { display: flex; flex-wrap: wrap; gap: 0.45rem; align-items: center; margin-bottom: 0.75rem; color: #9eb0c7; font-size: 0.76rem; }
  .section-state-pill { display: inline-flex; align-items: center; padding: 0.12rem 0.5rem; border-radius: 999px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.66rem; }
  .section-state-ok { background: rgba(20, 83, 45, 0.9); color: #9cf4c7; }
  .section-state-stale { background: rgba(120, 53, 15, 0.92); color: #fde68a; }
  .section-state-error { background: rgba(127, 29, 29, 0.92); color: #fecaca; }
  .section-state-unavailable { background: #334155; color: #d8e3ef; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; }
  .summary-card { background: linear-gradient(180deg, rgba(8,17,31,0.92), rgba(11,22,37,0.95)); border: 1px solid rgba(54, 80, 109, 0.65); border-radius: 0.7rem; padding: 0.8rem; }
  .summary-card .label { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .summary-card .value { margin-top: 0.32rem; color: #f8fafc; font-size: 1.16rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .summary-card .meta { margin-top: 0.25rem; color: #94a3b8; font-size: 0.8rem; }
  .kv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.75rem; }
  .kv-card { background: linear-gradient(180deg, rgba(8,17,31,0.92), rgba(11,22,37,0.95)); border: 1px solid rgba(54, 80, 109, 0.65); border-radius: 0.7rem; padding: 0.8rem; }
  .kv-card .key { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }
  .kv-card .value { margin-top: 0.25rem; color: #f8fafc; word-break: break-word; }
  .inline-actions { display: flex; gap: 0.6rem; flex-wrap: wrap; }
  .empty-state { text-align: center; color: var(--muted); font-style: italic; padding: 1rem 0; }
  .section-error-banner { display: flex; align-items: center; gap: 0.5rem; background: rgba(127, 29, 29, 0.16); border: 1px solid rgba(248, 113, 113, 0.45); border-radius: 0.55rem; padding: 0.55rem 0.75rem; margin-bottom: 0.75rem; }
  .section-error-icon { color: var(--err); font-size: 1rem; }
  .section-error-text { color: #fecaca; font-size: 0.8125rem; }
  .section-stale-banner { display: flex; align-items: center; gap: 0.5rem; background: rgba(113, 63, 18, 0.18); border: 1px solid rgba(251, 191, 36, 0.35); border-radius: 0.55rem; padding: 0.55rem 0.75rem; margin-bottom: 0.75rem; }
  .section-stale-icon { color: var(--warn); font-size: 1rem; }
  .section-stale-text { color: #fde68a; font-size: 0.8125rem; }
  .section-unavailable-banner { display: flex; align-items: center; gap: 0.5rem; background: rgba(17, 24, 39, 0.45); border: 1px solid #475569; border-radius: 0.55rem; padding: 0.55rem 0.75rem; margin-bottom: 0.75rem; }
  .section-unavailable-icon { color: #cbd5e1; font-size: 1rem; }
  .section-unavailable-text { color: #dbe4ee; font-size: 0.8125rem; }
  .status-ok { color: var(--ok); font-weight: 650; }
  .status-warn { color: var(--warn); font-weight: 650; }
  .status-err { color: var(--err); font-weight: 650; }
  .status-skip { color: #94a3b8; }
  .status-default { color: #cbd5e1; }
  .provenance { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 0.25rem; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
  @media (max-width: 1080px) {
    .console-shell { grid-template-columns: 1fr; }
    .console-sidebar { position: static; }
  }
`;

export function renderPageLayout(options: {
  title: string;
  kicker?: string;
  subtitle?: string;
  meta?: string;
  actions?: string;
  body: string;
  navActive?: OperatorConsoleNavKey;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(options.title)}</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="console-shell">
    ${renderOperatorConsoleNav(options.navActive)}
    <main class="console-main">
      <div class="page-header">
        ${options.kicker ? `<div class="page-kicker">${escapeHtml(options.kicker)}</div>` : ''}
        <h1>${escapeHtml(options.title)}</h1>
        ${options.subtitle ? `<p class="page-subtitle">${escapeHtml(options.subtitle)}</p>` : ''}
        ${options.meta ? `<div class="page-meta">${options.meta}</div>` : ''}
        ${options.actions ? `<div class="page-actions">${options.actions}</div>` : ''}
      </div>
      ${options.body}
    </main>
  </div>
</body>
</html>`;
}

export function renderStatusPage(options: {
  title: string;
  detail: string;
  statusLabel: string;
  actions?: string;
}): string {
  return renderPageLayout({
    title: options.title,
    kicker: options.statusLabel,
    subtitle: options.detail,
    actions: options.actions,
    body: renderSection('Route Status', `<p>${escapeHtml(options.detail)}</p>`),
  });
}

export function renderSummaryGrid(cards: Array<{ label: string; value: string; meta?: string }>): string {
  const body = cards.map(card => `<div class="summary-card">
    <div class="label">${escapeHtml(card.label)}</div>
    <div class="value">${card.value}</div>
    ${card.meta ? `<div class="meta">${card.meta}</div>` : ''}
  </div>`).join('');
  return `<div class="summary-grid">${body}</div>`;
}

export function renderKeyValueGrid(rows: Array<{ key: string; value: string }>): string {
  const body = rows.map(row => `<div class="kv-card">
    <div class="key">${escapeHtml(row.key)}</div>
    <div class="value">${row.value}</div>
  </div>`).join('');
  return `<div class="kv-grid">${body}</div>`;
}

// ---------------------------------------------------------------------------
// Table renderer
// ---------------------------------------------------------------------------

/**
 * Render an HTML table from column definitions and data rows.
 */
export function renderTable<T extends Record<string, unknown>>(
  columns: Array<{
    key: keyof T & string;
    label: string;
    render?: (value: T[keyof T & string], row: T) => string;
    cellClass?: string | ((value: T[keyof T & string], row: T) => string);
  }>,
  rows: T[],
  emptyMessage = 'No data available.',
): string {
  if (rows.length === 0) {
    return renderEmptyState(emptyMessage);
  }

  const thead = columns.map(col => `<th>${escapeHtml(col.label)}</th>`).join('');

  const tbody = rows.map(row => {
    const cells = columns.map(col => {
      const value = row[col.key];
      let cellContent: string;
      if (col.render) {
        cellContent = col.render(value, row);
      } else if (value === null || value === undefined) {
        cellContent = '—';
      } else if (typeof value === 'number') {
        cellContent = escapeHtml(formatNumber(value));
      } else {
        cellContent = escapeHtml(String(value));
      }

      let cls = '';
      if (col.cellClass) {
        cls = typeof col.cellClass === 'function'
          ? ` class="${col.cellClass(value, row)}"`
          : ` class="${col.cellClass}"`;
      }

      return `<td${cls}>${cellContent}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  return `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Status class helper (for CSS styling)
// ---------------------------------------------------------------------------

/** Get a CSS class name for a status/verdict string. */
export function statusClass(status: string): string {
  const ok = ['approved', 'accepted', 'healthy', 'promote', 'sufficient', 'ok', 'filled', 'active', 'live', 'completed', 'selected'];
  const warn = ['refused', 'degraded', 'demote', 'stale', 'warning', 'pending', 'paper', 'backtest', 'no_winner', 'hold'];
  const err = ['unhealthy', 'error', 'critical', 'rejected', 'cancelled', 'failed'];
  const skip = ['skipped', 'flat', 'unknown', 'none', 'unconsumed'];

  if (ok.includes(status)) return 'status-ok';
  if (warn.includes(status)) return 'status-warn';
  if (err.includes(status)) return 'status-err';
  if (skip.includes(status)) return 'status-skip';
  return 'status-default';
}

// ---------------------------------------------------------------------------
// Duration formatting (uptime-like)
// ---------------------------------------------------------------------------

export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
}
