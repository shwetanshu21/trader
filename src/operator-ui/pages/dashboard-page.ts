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
  OperatorResearchLineageSummary,
  OperatorOvernightSummary,
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
  renderOperatorConsoleNav,
  renderSummaryGrid,
  renderResearchLineageBoundedEvidenceNote,
} from '../render-utils.js';
import { renderOperatorStatusStrip, type OperatorShellStatusViewModel } from '../components/status-strip.js';

const DASHBOARD_SECTION_ORDER = [
  'summaryCards',
  'strategyPerformance',
  'tickerPerformance',
  'decisionPerformance',
  'lifecycleStates',
  'governanceHistory',
  'promotionHistory',
  'walkForwardLeaderboard',
  'researchLineage',
  'overnightResearch',
] as const;

type DashboardSectionKey = typeof DASHBOARD_SECTION_ORDER[number];

type DashboardSectionHtmlMap = Record<DashboardSectionKey, string>;

function defaultOvernightResearchSection(): DashboardSection<OperatorOvernightSummary> {
  return {
    state: 'unavailable',
    data: {
      totals: { totalRuns: 0, running: 0, completed: 0, failed: 0, refused: 0 },
      latestRun: null,
      recentRuns: [],
      recentGenerationAttempts: [],
      status: { availability: 'unavailable', diagnostics: [], provenance: [] },
      provenance: { source: 'historical', asOf: 0, sourceLabel: null },
    },
    errorMessage: 'No overnight research payload available.',
    stalenessMs: null,
    lastFetchedAt: null,
    isCachedData: false,
  };
}

export interface DashboardPageOptions {
  pollIntervalMs?: number;
  shellStatus?: OperatorShellStatusViewModel | null;
}

function findSummaryCard(cards: OperatorSummaryCard[], key: string): OperatorSummaryCard | null {
  return cards.find(card => card.key === key) ?? null;
}

export function renderOverviewHero(payload: DashboardPayload): string {
  const cards = payload.summaryCards.data;
  const metricKeys = ['net_pnl', 'invested_capital', 'current_value', 'open_positions'];
  const heroCards = metricKeys
    .map(key => findSummaryCard(cards, key))
    .filter((card): card is OperatorSummaryCard => card !== null);

  const cardHtml = heroCards.map(card => {
    const value = card.display ?? (card.unit === 'INR'
      ? formatCurrency(card.value, card.unit)
      : formatNumber(card.value, 0));
    const toneClass = card.value > 0 ? 'status-ok' : card.value < 0 ? 'status-err' : 'status-default';
    const caveat = card.key === 'invested_capital' || card.key === 'current_value'
      ? '<div class="hero-metric-footnote">Paper-ledger aggregate · not broker cash or account NAV</div>'
      : '';
    return `<div class="hero-metric-card">
      <div class="hero-metric-label">${escapeHtml(card.label)}</div>
      <div class="hero-metric-value ${toneClass}">${value}</div>
      <div class="hero-metric-meta">${renderProvenanceBadge(card.provenance)}</div>
      ${caveat}
    </div>`;
  }).join('');

  const sectionStates = [
    payload.summaryCards,
    payload.strategyPerformance,
    payload.tickerPerformance,
    payload.decisionPerformance,
    payload.lifecycleStates,
    payload.governanceHistory,
    payload.promotionHistory,
    payload.walkForwardLeaderboard,
    payload.researchLineage,
  ];
  const staleCount = sectionStates.filter(section => section.state === 'stale').length;
  const errorCount = sectionStates.filter(section => section.state === 'error' || section.state === 'unavailable').length;

  const exceptions: string[] = [];
  if (!payload.dbAvailable) {
    exceptions.push('Operator database is disconnected. Existing dashboard content may be stale or incomplete.');
  }
  if (errorCount > 0) {
    exceptions.push(`${errorCount} section(s) failed to refresh or are unavailable.`);
  }
  if (staleCount > 0) {
    exceptions.push(`${staleCount} section(s) are showing last-known cached data.`);
  }
  if (exceptions.length === 0) {
    exceptions.push('No active operator exceptions. Runtime evidence and persisted sections are currently loading normally.');
  }

  return `<section class="hero-shell" id="dashboard-hero" data-dashboard-hero>
    <div class="hero-command-strip">
      <span class="hero-chip ${payload.dbAvailable ? 'hero-chip-ok' : 'hero-chip-err'}">${payload.dbAvailable ? 'DB connected' : 'DB unavailable'}</span>
      <span class="hero-chip hero-chip-neutral">Assembled ${escapeHtml(formatTimestamp(payload.assembledAt))}</span>
      <span class="hero-chip ${staleCount > 0 ? 'hero-chip-warn' : 'hero-chip-neutral'}">${staleCount} stale section(s)</span>
      <span class="hero-chip ${errorCount > 0 ? 'hero-chip-err' : 'hero-chip-neutral'}">${errorCount} refresh issue(s)</span>
    </div>
    <div class="hero-grid">
      <div class="hero-primary">
        <div class="hero-eyebrow">Overview</div>
        <h2>Capital, paper-ledger value, and latest operator truth</h2>
        <p class="hero-copy">The console shows realized and unrealized P&amp;L directly from persisted paper state. Invested capital and current value are aggregated from open paper positions and should be read as paper-ledger exposure, not broker cash or account NAV.</p>
        <div class="hero-metrics">${cardHtml}</div>
      </div>
      <div class="hero-secondary">
        <div class="hero-secondary-title">Exceptions &amp; attention</div>
        <ul class="hero-exception-list">${exceptions.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        <div class="hero-secondary-actions">
          <a href="/decisions">Review recent decisions</a>
          <a href="/strategies">Inspect strategies</a>
          <a href="/system-health">Open system health</a>
        </div>
      </div>
    </div>
  </section>`;
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
  const overviewHero = renderOverviewHero(payload);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Operator Console</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    color-scheme: dark;
    --bg: #08111f;
    --bg-elevated: #0f1b2d;
    --bg-panel: #132033;
    --border: #24364d;
    --text: #e6edf6;
    --muted: #8ba0ba;
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
  h2 { font-size: 1rem; font-weight: 650; margin-bottom: 0.5rem; color: #d5deea; }
  .console-shell { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 1rem; align-items: start; }
  .console-sidebar { position: sticky; top: 1.25rem; background: linear-gradient(180deg, rgba(19,32,51,0.94), rgba(12,20,34,0.98)); border: 1px solid var(--border); border-radius: 0.9rem; padding: 1rem; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.22); }
  .console-brand { padding-bottom: 0.9rem; margin-bottom: 0.9rem; border-bottom: 1px solid rgba(54,80,109,0.35); }
  .console-brand-kicker { color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.68rem; font-weight: 700; }
  .console-brand-title { margin-top: 0.2rem; font-size: 1rem; font-weight: 700; color: #f8fbff; }
  .console-brand-subtitle { margin-top: 0.25rem; color: var(--muted); font-size: 0.82rem; }
  .console-nav { display: grid; gap: 0.45rem; }
  .console-nav-link { display: block; padding: 0.7rem 0.8rem; border-radius: 0.75rem; border: 1px solid transparent; background: rgba(10, 20, 36, 0.28); transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease; }
  .console-nav-link:hover { text-decoration: none; background: rgba(23, 38, 59, 0.9); border-color: rgba(54, 80, 109, 0.7); transform: translateY(-1px); }
  .console-nav-link[data-active="true"] { background: rgba(24, 42, 65, 0.96); border-color: rgba(96, 165, 250, 0.55); box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.18); }
  .console-nav-label { display: block; color: #eef4fb; font-weight: 600; font-size: 0.9rem; }
  .console-nav-description { display: block; margin-top: 0.18rem; color: var(--muted); font-size: 0.76rem; line-height: 1.35; }
  .console-main { min-width: 0; }
  .page-header { margin-bottom: 1.2rem; padding: 1rem 1.1rem; background: linear-gradient(180deg, rgba(19,32,51,0.96), rgba(14,25,41,0.96)); border: 1px solid var(--border); border-radius: 0.9rem; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18); }
  .page-meta { margin-top: 0.55rem; color: #8ba0ba; font-size: 0.85rem; }
  .page-subtitle { color: #a6b7cc; max-width: 75rem; }
  .section { background: linear-gradient(180deg, rgba(19,32,51,0.96), rgba(15,27,45,0.97)); border: 1px solid var(--border); border-radius: 0.85rem; padding: 1rem; margin-bottom: 1rem; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.14); }
  .section h2 { margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .section-subtitle { font-size: 0.75rem; color: var(--muted); font-weight: normal; text-transform: none; letter-spacing: normal; }
  .section-meta { display: flex; flex-wrap: wrap; gap: 0.45rem; align-items: center; margin-bottom: 0.75rem; color: #9eb0c7; font-size: 0.76rem; }
  .section-state-pill { display: inline-flex; align-items: center; padding: 0.12rem 0.5rem; border-radius: 999px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.66rem; }
  .section-state-ok { background: rgba(20, 83, 45, 0.9); color: #9cf4c7; }
  .section-state-stale { background: rgba(120, 53, 15, 0.92); color: #fde68a; }
  .section-state-error { background: rgba(127, 29, 29, 0.92); color: #fecaca; }
  .section-state-unavailable { background: #334155; color: #d8e3ef; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
  th { text-align: left; padding: 0.5rem 0.5rem; background: transparent; color: #9eb0c7; font-weight: 600; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 0.45rem 0.5rem; border-bottom: 1px solid rgba(36, 54, 77, 0.65); vertical-align: top; }
  td:first-child { white-space: nowrap; }
  .empty-state { text-align: center; color: var(--muted); font-style: italic; padding: 1.5rem 0; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.75rem; }
  .summary-card { background: linear-gradient(180deg, rgba(8,17,31,0.92), rgba(11,22,37,0.95)); border: 1px solid rgba(54, 80, 109, 0.65); border-radius: 0.7rem; padding: 0.8rem; }
  .summary-card .label { font-size: 0.7rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }
  .summary-card .value { font-size: 1.18rem; font-weight: 700; margin-top: 0.25rem; color: #f1f5f9; font-variant-numeric: tabular-nums; }
  .summary-card .provenance { margin-top: 0.25rem; }
  .status-ok { color: var(--ok); font-weight: 650; }
  .status-warn { color: var(--warn); font-weight: 650; }
  .status-err { color: var(--err); font-weight: 650; }
  .status-skip { color: #64748b; }
  .status-default { color: #94a3b8; }
  .page-refresh-banner { display: none; align-items: center; gap: 0.6rem; padding: 0.75rem 1rem; border-radius: 0.5rem; margin-bottom: 1rem; border: 1px solid #475569; background: #1e293b; color: #cbd5e1; }
  .page-refresh-banner[data-visible="true"] { display: flex; }
  .page-refresh-banner[data-kind="warn"] { border-color: #78350f; background: #713f1222; color: #fcd34d; }
  .page-refresh-banner[data-kind="error"] { border-color: #7f1d1d; background: #7f1d1d22; color: #fecaca; }
  .page-refresh-banner[data-kind="ok"] { border-color: #14532d; background: #14532d22; color: #86efac; }
  .section-error-banner { display: flex; align-items: center; gap: 0.5rem; background: rgba(127, 29, 29, 0.16); border: 1px solid rgba(248, 113, 113, 0.45); border-radius: 0.55rem; padding: 0.55rem 0.75rem; margin-bottom: 0.75rem; }
  .section-error-icon { color: var(--err); font-size: 1rem; }
  .section-error-text { color: #fecaca; font-size: 0.8125rem; }
  .section-stale-banner { display: flex; align-items: center; gap: 0.5rem; background: rgba(113, 63, 18, 0.18); border: 1px solid rgba(251, 191, 36, 0.35); border-radius: 0.55rem; padding: 0.55rem 0.75rem; margin-bottom: 0.75rem; }
  .section-stale-icon { color: var(--warn); font-size: 1rem; }
  .section-stale-text { color: #fde68a; font-size: 0.8125rem; }
  .section-unavailable-banner { display: flex; align-items: center; gap: 0.5rem; background: rgba(17, 24, 39, 0.45); border: 1px solid #475569; border-radius: 0.55rem; padding: 0.55rem 0.75rem; margin-bottom: 0.75rem; }
  .section-unavailable-icon { color: #cbd5e1; font-size: 1rem; }
  .section-unavailable-text { color: #dbe4ee; font-size: 0.8125rem; }
  .provenance { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 0.25rem; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
  code { background: #0a1424; padding: 0.1rem 0.3rem; border-radius: 0.25rem; font-size: 0.75rem; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  th.num { text-align: right; }
  .hero-shell { margin-bottom: 1rem; padding: 1rem 1.1rem; background: linear-gradient(180deg, rgba(19,32,51,0.98), rgba(11,20,34,0.98)); border: 1px solid rgba(54, 80, 109, 0.65); border-radius: 0.9rem; box-shadow: 0 18px 48px rgba(0,0,0,0.18); }
  .hero-command-strip { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.85rem; }
  .hero-chip { display: inline-flex; align-items: center; border-radius: 999px; padding: 0.2rem 0.6rem; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.03em; }
  .hero-chip-ok { background: rgba(20, 83, 45, 0.92); color: #b6f5d3; }
  .hero-chip-warn { background: rgba(120, 53, 15, 0.92); color: #fde68a; }
  .hero-chip-err { background: rgba(127, 29, 29, 0.92); color: #fecaca; }
  .hero-chip-neutral { background: rgba(23, 38, 59, 0.96); color: #d3deeb; }
  .hero-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 1rem; }
  .hero-eyebrow { color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.7rem; font-weight: 700; margin-bottom: 0.3rem; }
  .hero-copy { color: #a8b8ca; max-width: 52rem; margin-top: 0.2rem; }
  .hero-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0.75rem; margin-top: 0.9rem; }
  .hero-metric-card { background: linear-gradient(180deg, rgba(8,17,31,0.92), rgba(11,22,37,0.95)); border: 1px solid rgba(54, 80, 109, 0.65); border-radius: 0.7rem; padding: 0.8rem; }
  .hero-metric-label { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .hero-metric-value { margin-top: 0.35rem; font-size: 1.2rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .hero-metric-meta { margin-top: 0.35rem; }
  .hero-metric-footnote { margin-top: 0.4rem; color: #8da3bd; font-size: 0.74rem; }
  .hero-secondary { background: rgba(8,17,31,0.42); border: 1px solid rgba(54, 80, 109, 0.45); border-radius: 0.75rem; padding: 0.9rem; }
  .hero-secondary-title { font-size: 0.82rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #d5deea; }
  .hero-exception-list { margin-top: 0.75rem; padding-left: 1rem; color: #d6dfeb; }
  .hero-secondary-actions { margin-top: 0.85rem; display: flex; flex-direction: column; gap: 0.45rem; font-size: 0.84rem; }
  .section-note { margin-bottom: 0.7rem; color: #9eb0c7; font-size: 0.8rem; }
  .summary-toolbar { display: flex; flex-wrap: wrap; gap: 0.55rem; margin-bottom: 0.8rem; }
  .summary-toolbar a { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.28rem 0.6rem; border-radius: 999px; border: 1px solid rgba(54, 80, 109, 0.6); background: rgba(10, 20, 36, 0.45); color: #dce7f4; font-size: 0.76rem; text-decoration: none; }
  .summary-toolbar a:hover { background: rgba(23, 38, 59, 0.9); }
  .stack-grid { display: grid; gap: 1rem; }
  .page-actions { margin-top: 0.9rem; display: flex; gap: 0.85rem; flex-wrap: wrap; font-size: 0.9rem; }
  .console-status-strip { margin-bottom: 1rem; padding: 0.95rem 1rem; background: linear-gradient(180deg, rgba(19,32,51,0.98), rgba(11,20,34,0.98)); border: 1px solid rgba(54, 80, 109, 0.65); border-radius: 0.9rem; box-shadow: 0 16px 40px rgba(0,0,0,0.18); }
  .console-status-strip-header { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; margin-bottom: 0.8rem; }
  .console-status-kicker { color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.68rem; font-weight: 700; }
  .console-status-headline { margin-top: 0.2rem; color: #eef4fb; font-size: 0.98rem; font-weight: 650; }
  .console-status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(185px, 1fr)); gap: 0.75rem; }
  .console-status-card { background: linear-gradient(180deg, rgba(8,17,31,0.92), rgba(11,22,37,0.95)); border: 1px solid rgba(54, 80, 109, 0.65); border-radius: 0.75rem; padding: 0.75rem; min-width: 0; }
  .console-status-label { color: var(--muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .console-status-summary { margin-top: 0.3rem; color: #f8fafc; font-size: 1rem; font-weight: 700; }
  .console-status-detail { margin-top: 0.28rem; color: #c7d3e1; font-size: 0.8rem; }
  .console-status-meta { margin-top: 0.42rem; color: #8fa4bc; font-size: 0.74rem; }
  .console-status-healthy { border-color: rgba(52, 211, 153, 0.45); box-shadow: inset 0 0 0 1px rgba(52, 211, 153, 0.14); }
  .console-status-warning { border-color: rgba(251, 191, 36, 0.45); box-shadow: inset 0 0 0 1px rgba(251, 191, 36, 0.14); }
  .console-status-critical { border-color: rgba(248, 113, 113, 0.45); box-shadow: inset 0 0 0 1px rgba(248, 113, 113, 0.14); }
  .console-status-unavailable { border-color: rgba(148, 163, 184, 0.4); box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.12); }
  @media (max-width: 1080px) {
    .console-shell { grid-template-columns: 1fr; }
    .console-sidebar { position: static; }
    .hero-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="console-shell">
  ${renderOperatorConsoleNav('overview')}
  <main class="console-main">
    <div class="page-header">
      <div class="hero-eyebrow">Overview</div>
      <h1>Operator Console</h1>
      <p class="page-subtitle">Authenticated operator surface for persisted trading evidence, execution outcomes, lifecycle governance, and walk-forward backing data.</p>
      <div class="page-meta" id="dashboard-meta" data-dashboard-meta>
        Assembled: ${escapeHtml(formatTimestamp(payload.assembledAt))} &mdash;
        DB: ${payload.dbAvailable ? 'Connected' : `<span style="color:#ef4444;">Disconnected</span>`}
        ${payload.dbError ? `&mdash; <span style="color:#ef4444;">${escapeHtml(payload.dbError)}</span>` : ''}
      </div>
      <div class="page-actions">
        <a href="/api/health">System Health</a>
        <a href="#dashboard-section-decisionPerformance">Recent Decisions</a>
        <a href="#dashboard-section-governanceHistory">Governance</a>
      </div>
    </div>

    <div class="page-refresh-banner" id="dashboard-refresh-banner" data-visible="false" data-kind="warn" role="status" aria-live="polite"></div>

    ${renderOperatorStatusStrip(options.shellStatus)}

    ${overviewHero}

    <div id="dashboard-root" class="stack-grid" data-poll-interval-ms="${escapeHtml(String(pollIntervalMs))}">
    ${sections}
    </div>

    <script type="application/json" id="dashboard-bootstrap">${bootstrapJson}</script>
    <script>
(() => {
  const bootstrapNode = document.getElementById('dashboard-bootstrap');
  const refreshBanner = document.getElementById('dashboard-refresh-banner');
  const dashboardMeta = document.getElementById('dashboard-meta');
  const overviewHero = document.getElementById('dashboard-hero');

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
    return iso.replace('T', ' ').replace(/\\.\\d{3}Z$/, '').replace(/\\.\\d{3}\\+.*$/, '').slice(0, 19);
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

    if (overviewHero && typeof payload.heroHtml === 'string') {
      overviewHero.outerHTML = payload.heroHtml.trim();
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
  </main>
</div>
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
    researchLineage: renderResearchLineageSection(payload.researchLineage),
    overnightResearch: renderOvernightResearchSection(payload.overnightResearch ?? defaultOvernightResearchSection()),
  };
}

function buildDashboardBootstrapJson(payload: DashboardPayload, pollIntervalMs: number): string {
  const bootstrap = {
    refreshUrl: '/api/refresh',
    pollIntervalMs,
    assembledAt: payload.assembledAt,
    dbAvailable: payload.dbAvailable,
    dbError: payload.dbError,
    sections: Object.fromEntries(DASHBOARD_SECTION_ORDER.map((key) => {
      const section = ((payload as unknown) as Record<string, unknown>)[key] as DashboardSection<unknown> | undefined;
      return [key, summarizeSection(section ?? defaultOvernightResearchSection())];
    })),
  };

  return JSON.stringify(bootstrap).replace(/</g, '\\u003c');
}

function summarizeSection(section: DashboardSection<unknown>) {
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
    const toolbar = `<div class="summary-toolbar">
      <a href="#dashboard-section-tickerPerformance">Open positions</a>
      <a href="#dashboard-section-strategyPerformance">Strategy review</a>
      <a href="#dashboard-section-decisionPerformance">Decision ledger</a>
      <a href="/api/health">System health</a>
    </div>`;
    const cards = section.data.map(c => {
      const value = c.display ?? (typeof c.value === 'number'
        ? c.unit === 'INR'
          ? formatCurrency(c.value, c.unit)
          : `${escapeHtml(formatNumber(c.value))}`
        : escapeHtml(String(c.value)));

      const label = escapeHtml(c.label || c.key || '');
      const badge = renderProvenanceBadge(c.provenance);
      const footnote = c.key === 'invested_capital' || c.key === 'current_value'
        ? '<div class="hero-metric-footnote">Paper-ledger aggregate, not broker cash or NAV</div>'
        : '';

      return `<div class="summary-card">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
        ${badge ? `<div class="provenance">${badge}</div>` : ''}
        ${footnote}
      </div>`;
    }).join('\n');
    content = `${toolbar}<div class="summary-grid">${cards}</div>`;
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
    'Live P&L and paper-ledger capital aggregates',
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
        <td class="num">${formatCurrency(s.totalFees, 'INR')}</td>
        <td class="num ${s.unrealizedPnl >= 0 ? 'status-ok' : 'status-err'}">${formatCurrency(s.unrealizedPnl, 'INR')}</td>
        <td class="num">${sharpe}</td>
        <td class="num">${drawdown}</td>
        <td class="num">${winRate}</td>
        <td class="num">${profitFactor}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('\n');

    content = `<div class="section-note">Return percentage is intentionally suppressed here until the backend persists a trusted denominator for live/operator display.</div><table>
      <thead><tr>
        <th>Strategy</th>
        <th>Version</th>
        <th class="num">Trades</th>
        <th class="num">Realized P&amp;L</th>
        <th class="num">Fees</th>
        <th class="num">Unrealized P&amp;L</th>
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
    'Trusted per-strategy P&L with evidence-linked quality metrics',
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
        <td class="num">${formatCurrency(t.totalFees, 'INR')}</td>
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
        <th class="num">Fees</th>
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
    const llmCounts = new Map<string, number>();
    for (const decision of section.data) {
      if (decision.llmStatus) {
        llmCounts.set(decision.llmStatus, (llmCounts.get(decision.llmStatus) ?? 0) + 1);
      }
    }
    const llmSummary = llmCounts.size > 0
      ? `<div class="section-note">Recent hybrid LLM status in this bounded decision window: ${Array.from(llmCounts.entries()).map(([status, count]) => `<span class="hero-chip ${status === 'consulted' ? 'hero-chip-ok' : status === 'degraded' || status === 'error' ? 'hero-chip-warn' : 'hero-chip-neutral'}">${escapeHtml(status)} ${count}</span>`).join(' ')}</div>`
      : '<div class="section-note">Recent hybrid LLM status in this bounded decision window: no persisted hybrid evidence.</div>';

    const rows = section.data.map(d => {
      const status = d.decisionStatus;
      const execStatus = d.executionStatus ?? '—';
      const outcome = d.outcomeCode ?? '—';
      const pnl = d.realizedPnl !== null
        ? `<span class="${d.realizedPnl >= 0 ? 'status-ok' : 'status-err'}">${formatCurrency(d.realizedPnl, null)}</span>`
        : '—';
      const fees = d.fees !== null ? formatCurrency(d.fees, 'INR') : '—';
      const badge = renderProvenanceBadge(d.provenance);
      const decisionHref = decisionDetailHref(d.decisionId);
      const llmStatus = d.llmStatus
        ? `<span class="${statusClass(d.llmStatus)}" title="${escapeHtml(d.llmRationale ?? 'No LLM rationale recorded.')}">${escapeHtml(d.llmStatus)}</span>`
        : '<span class="status-skip">—</span>';

      return `<tr>
        <td><code>${escapeHtml(d.exchange)}</code></td>
        <td>${renderLink(decisionHref, d.tradingsymbol)}</td>
        <td>${escapeHtml(d.side)}</td>
        <td class="num">${formatInt(d.quantity)}</td>
        <td><span class="${statusClass(status)}">${escapeHtml(status)}</span></td>
        <td>${llmStatus}</td>
        <td>${escapeHtml(execStatus)}</td>
        <td>${escapeHtml(outcome)}</td>
        <td class="num">${escapeHtml(fees)}</td>
        <td class="num">${pnl}</td>
        <td><code>${escapeHtml(d.strategyId)}</code></td>
        <td>${escapeHtml(formatTimestamp(d.decidedAt))}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('\n');

    content = `${llmSummary}<table>
      <thead><tr>
        <th>Exchange</th>
        <th>Symbol</th>
        <th>Side</th>
        <th class="num">Qty</th>
        <th>Status</th>
        <th>LLM Status</th>
        <th>Exec Status</th>
        <th>Outcome</th>
        <th class="num">Fees</th>
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
    content = renderEmptyState('No lifecycle state evidence has been produced on this host yet.');
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
    content = renderEmptyState('No governance history has been produced on this host yet.');
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
    content = renderEmptyState('No promotion history has been produced on this host yet.');
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
    content = renderEmptyState('No walk-forward leaderboard entries are available yet. A persisted winner or no-winner selection has not been recorded on this host yet.');
  }

  return renderDashboardSectionWrapper(
    'walkForwardLeaderboard',
    'Walk-Forward Leaderboard',
    'Historical backtest results',
    section,
    content,
  );
}


export function renderResearchLineageSection(
  section: DashboardSection<OperatorResearchLineageSummary>,
  options: { emphasizeTotals?: boolean; boundedLabel?: string } = {},
): string {
  let content: string;

  if ((section.state === 'ok' || section.state === 'stale')) {
    const summary = section.data;
    const totals = summary.totals;
    const totalCards = [
      { label: 'Generation Attempts Total', value: formatInt(totals.generationAttempts) },
      { label: 'Hypotheses Total', value: formatInt(totals.hypotheses) },
      { label: 'Evaluations Total', value: formatInt(totals.evaluations) },
      { label: 'Duplicate Skip Total', value: formatInt(totals.duplicateSkips) },
      { label: 'Published Research Total', value: formatInt(totals.publications) },
    ];
    const totalGrid = renderSummaryGrid(totalCards);

    const provenanceList = summary.status.provenance.length > 0
      ? `<ul>${summary.status.provenance.map(item => `<li><code>${escapeHtml(item.sourceLabel)}</code>${item.detail ? ` — ${escapeHtml(item.detail)}` : ''}</li>`).join('')}</ul>`
      : '<p class="empty-state">No lineage source provenance was reported.</p>';

    const diagnostics = summary.status.diagnostics.length > 0
      ? `<div style="margin-top:0.75rem;"><strong>Diagnostics</strong><ul>${summary.status.diagnostics.map(item => `<li><code>${escapeHtml(item.code)}</code> — ${escapeHtml(item.message)}</li>`).join('')}</ul></div>`
      : '';

    const boundedHeading = options.boundedLabel ?? 'Recent bounded evidence';
    const boundedNote = renderResearchLineageBoundedEvidenceNote(summary.recent.length);
    const recentRows = summary.recent.length > 0
      ? `<div style="margin-top:0.85rem;"><strong>${escapeHtml(boundedHeading)}</strong></div>
        ${boundedNote}
        <table>
          <thead><tr><th>When</th><th>Type</th><th>Status</th><th>Canonical Hash</th><th>Generation</th><th>Evaluation</th><th>Publication</th><th>Notes</th></tr></thead>
          <tbody>${summary.recent.map(row => `<tr>
            <td>${escapeHtml(formatTimestamp(row.happenedAt))}</td>
            <td><code>${escapeHtml(row.lineageType)}</code></td>
            <td><span class="${statusClass(row.status)}">${escapeHtml(row.status)}</span></td>
            <td>${row.canonicalHash ? `<code>${escapeHtml(row.canonicalHash)}</code>` : '<span class="status-skip">None</span>'}</td>
            <td>${row.generationAttempt ? `#${formatInt(row.generationAttempt.id)} · ${escapeHtml(row.generationAttempt.providerLabel ?? 'unknown provider')}` : '<span class="status-skip">None</span>'}</td>
            <td>${row.evaluation ? `#${formatInt(row.evaluation.id)}${row.evaluation.walkForwardRunId !== null ? ` · run ${formatInt(row.evaluation.walkForwardRunId)}` : ''}` : '<span class="status-skip">None</span>'}</td>
            <td>${row.publication ? `${escapeHtml(row.publication.strategyId)}@${escapeHtml(row.publication.strategyVersion)}` : '<span class="status-skip">None</span>'}</td>
            <td>${row.diagnostics.length > 0 ? escapeHtml(row.diagnostics.join('; ')) : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : `${boundedNote}${renderEmptyState('No persisted research lineage has been produced on this host yet.')}`;

    const leadNote = options.emphasizeTotals
      ? '<div class="section-note">Repository-backed totals lead this section so operators can inspect the truthful full lineage first, then review only the bounded recent evidence window below.</div>'
      : '<div class="section-note">Repository-backed totals stay truthful even when recent lineage rows remain bounded for operator payloads.</div>';

    content = `${totalGrid}
      ${leadNote}
      ${recentRows}
      <div style="margin-top:0.75rem;"><strong>Lineage Sources</strong>${provenanceList}</div>
      ${diagnostics}`;
  } else if (section.state === 'unavailable') {
    content = renderEmptyState('No database snapshot available.');
  } else if (section.state === 'error') {
    content = renderEmptyState(section.errorMessage ?? 'Failed to load research lineage.');
  } else {
    content = renderEmptyState('No persisted research lineage has been produced on this host yet.');
  }

  return renderDashboardSectionWrapper(
    'researchLineage',
    'Research Lineage',
    'Repository-backed totals plus bounded recent lineage rows',
    section,
    content,
  );
}

function renderOvernightResearchSection(
  section: DashboardSection<OperatorOvernightSummary>,
): string {
  let content: string;

  if ((section.state === 'ok' || section.state === 'stale')) {
    const summary = section.data;
    const totalsGrid = renderSummaryGrid([
      { label: 'Total Runs', value: formatInt(summary.totals.totalRuns) },
      { label: 'Running', value: formatInt(summary.totals.running) },
      { label: 'Completed', value: formatInt(summary.totals.completed) },
      { label: 'Failed', value: formatInt(summary.totals.failed) },
      { label: 'Refused', value: formatInt(summary.totals.refused) },
    ]);

    const latestRun = summary.latestRun
      ? `<div class="section-note">Latest run <code>#${formatInt(summary.latestRun.id)}</code> ${escapeHtml(summary.latestRun.label)} is <span class="${statusClass(summary.latestRun.status)}">${escapeHtml(summary.latestRun.status)}</span> at <code>${escapeHtml(summary.latestRun.currentPhase ?? '—')}</code>. Last error: ${escapeHtml(summary.latestRun.lastError ?? summary.latestRun.failureContext?.message ?? '—')}</div>`
      : '<div class="section-note">No overnight runs have been recorded yet.</div>';

    const runRows = summary.recentRuns.length > 0
      ? `<table>
          <thead><tr><th>Run</th><th>Label</th><th>Status</th><th>Phase</th><th>Accepted / Evaluated</th><th>Last Error</th></tr></thead>
          <tbody>${summary.recentRuns.map(run => `<tr>
            <td><code>#${formatInt(run.id)}</code></td>
            <td>${escapeHtml(run.label)}</td>
            <td><span class="${statusClass(run.status)}">${escapeHtml(run.status)}</span></td>
            <td><code>${escapeHtml(run.currentPhase ?? '—')}</code></td>
            <td>${formatInt(run.generatedAcceptedCount)} / ${formatInt(run.evaluatedCompletedCount)}</td>
            <td>${escapeHtml(run.lastError ?? run.failureContext?.message ?? '—')}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : renderEmptyState('No persisted overnight runs on this host yet.');

    const attemptRows = summary.recentGenerationAttempts.length > 0
      ? `<table style="margin-top:0.75rem;">
          <thead><tr><th>Attempt</th><th>Model</th><th>Verdict</th><th>Model Outcome(s)</th><th>When</th></tr></thead>
          <tbody>${summary.recentGenerationAttempts.map(attempt => {
            const modelOutcomes = attempt.reasons.length > 0
              ? `<div class="tag-list">${attempt.reasons.map(reason => `<span class="tag">${escapeHtml(reason)}</span>`).join('')}</div>`
              : '—';
            return `<tr>
            <td><code>#${formatInt(attempt.id)}</code></td>
            <td>${escapeHtml(attempt.providerModel ?? attempt.providerLabel ?? 'unknown')}</td>
            <td><span class="${statusClass(attempt.verdict)}">${escapeHtml(attempt.verdict)}</span></td>
            <td>${modelOutcomes}</td>
            <td>${escapeHtml(formatTimestamp(attempt.createdAt))}</td>
          </tr>`;
          }).join('')}</tbody>
        </table>`
      : renderEmptyState('No hypothesis-generation attempts recorded yet.');

    content = `${totalsGrid}${latestRun}${runRows}${attemptRows}`;
  } else if (section.state === 'unavailable') {
    content = renderEmptyState('No database snapshot available.');
  } else if (section.state === 'error') {
    content = renderEmptyState(section.errorMessage ?? 'Failed to load overnight research evidence.');
  } else {
    content = renderEmptyState('No overnight research evidence has been produced on this host yet.');
  }

  return renderDashboardSectionWrapper(
    'overnightResearch',
    'Overnight Research',
    'Persisted overnight runs and recent model-attempt outcomes',
    section,
    content,
  );
}
