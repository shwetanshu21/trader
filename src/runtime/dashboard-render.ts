// ── Dashboard HTML Renderer ──
// Zero-dependency inline HTML rendering for the operator dashboard.
// All persisted text is HTML-escaped before interpolation.
// Produces a complete, readable HTML page for local operator inspection.

import type { DashboardSnapshot } from '../types/runtime.js';

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Verdict colour helper
// ---------------------------------------------------------------------------

function verdictColor(verdict: string): string {
  switch (verdict) {
    case 'healthy':
      return '#16a34a';
    case 'degraded':
      return '#d97706';
    case 'unhealthy':
      return '#dc2626';
    default:
      return '#6b7280';
  }
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
}

function maybeTimestamp(ts: number | null): string {
  if (ts === null) return '—';
  return new Date(ts).toISOString();
}

function maybeValue(val: string | null): string {
  return val ?? '—';
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderDashboardHtml(snapshot: DashboardSnapshot): string {
  const { marketProfile, health, runtime, broker, universe, recentProposals, recentBlockedOrders, recentLifecycleEvents } = snapshot;

  const healthColor = verdictColor(health.verdict);

  // ── Sections ─────────────────────────────────────────────────────────

  const brokerSection = broker ? `
      <div class="section">
        <h2>Broker (Upstox MCP)</h2>
        <table>
          <tr><td>Session</td><td class="td-value">${escapeHtml(broker.sessionState)}</td></tr>
          <tr><td>Instruments</td><td class="td-value">${broker.instruments.count ?? '—'} (${broker.instruments.isStale ? 'stale' : 'fresh'})</td></tr>
          <tr><td>Stream</td><td class="td-value">${escapeHtml(broker.stream.state)} (${broker.stream.isStale ? 'stale' : 'live'})</td></tr>
          <tr><td>Last Quote</td><td class="td-value">${maybeTimestamp(broker.stream.lastQuoteAt)}</td></tr>
          <tr><td>Recent Events</td><td class="td-value">${broker.recentEventCount}</td></tr>
        </table>
      </div>` : `
      <div class="section">
        <h2>Broker</h2>
        <p class="muted">Not configured — running in degraded broker mode</p>
      </div>`;

  // ── Universe coverage section ─────────────────────────────────────────

  const universeSection = (universe && universe.computedAt) ? `
      <div class="section">
        <h2>Universe Coverage</h2>
        <table>
          <tr><td>Policy</td><td class="td-value">${escapeHtml(universe.policyVersion)}</td></tr>
          <tr><td>Verdict</td><td class="td-value"><span class="verdict" style="background:${verdictColor(universe.verdict)}22;color:${verdictColor(universe.verdict)}">${escapeHtml(universe.verdict)}</span></td></tr>
          <tr><td>Eligible</td><td class="td-value">${universe.eligibleCount}</td></tr>
          <tr><td>Fresh Quotes</td><td class="td-value">${universe.freshQuoteCount}</td></tr>
          <tr><td>Stale Quotes</td><td class="td-value">${universe.staleQuoteCount}</td></tr>
          <tr><td>Missing Quotes</td><td class="td-value">${universe.missingQuoteCount}</td></tr>
          <tr><td>Threshold</td><td class="td-value">${escapeHtml(universe.thresholdLabel)}</td></tr>
          <tr><td>Last Snapshot</td><td class="td-value">${escapeHtml(universe.computedAt)}</td></tr>
        </table>
      </div>` : `
      <div class="section">
        <h2>Universe Coverage</h2>
        <p class="muted">No coverage snapshot computed yet</p>
      </div>`;

  const proposalsRows = recentProposals.length === 0
    ? '<tr><td colspan="5" class="muted">No recent proposals</td></tr>'
    : recentProposals.map(p => {
      const reasons = p.reasons.length > 0
        ? `<div class="reasons">${p.reasons.map(r => `<span class="reason">${escapeHtml(r)}</span>`).join('')}</div>`
        : '';
      return `<tr>
        <td>${escapeHtml(p.exchange)}</td>
        <td>${escapeHtml(p.tradingsymbol)}</td>
        <td>${escapeHtml(p.side)}</td>
        <td class="status-${p.status}">${escapeHtml(p.status)}</td>
        <td>${reasons}</td>
      </tr>`;
    }).join('');

  const blockedRows = recentBlockedOrders.length === 0
    ? '<tr><td colspan="5" class="muted">No blocked orders</td></tr>'
    : recentBlockedOrders.map(b => `<tr>
        <td>${escapeHtml(b.exchange)}</td>
        <td>${escapeHtml(b.tradingsymbol)}</td>
        <td>${escapeHtml(b.side)}</td>
        <td><code>${escapeHtml(b.blockCode)}</code></td>
        <td>${escapeHtml(b.blockMessage)}</td>
      </tr>`).join('');

  const lifecycleRows = recentLifecycleEvents.length === 0
    ? '<tr><td colspan="3" class="muted">No lifecycle events recorded</td></tr>'
    : recentLifecycleEvents.map(e => `<tr>
        <td>${escapeHtml(e.timestamp)}</td>
        <td class="status-${e.state}">${escapeHtml(e.state)}</td>
        <td>${escapeHtml(e.reason)}</td>
      </tr>`).join('');

  // ── Degraded reasons ──────────────────────────────────────────────────
  const degradedSection = health.degradedReasons.length > 0 ? `
      <div class="section">
        <h2>Degradation Reasons</h2>
        <ul>${health.degradedReasons.map(r => `<li class="degraded">${escapeHtml(r)}</li>`).join('')}</ul>
      </div>` : '';

  // ── Full page ─────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Runtime Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 1.5rem; line-height: 1.5; }
  h1 { font-size: 1.3rem; font-weight: 600; margin-bottom: 0.25rem; }
  h2 { font-size: 1rem; font-weight: 600; margin-bottom: 0.5rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
  .header { margin-bottom: 1.5rem; }
  .header .meta { font-size: 0.85rem; color: #64748b; }
  .section { background: #1e293b; border: 1px solid #334155; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  td { padding: 0.35rem 0.5rem; border-bottom: 1px solid #334155; vertical-align: top; }
  td:first-child { color: #94a3b8; white-space: nowrap; width: 1px; }
  .td-value { color: #e2e8f0; }
  .verdict { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; }
  .reasons { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .reason { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 0.25rem; font-size: 0.75rem; background: #312e81; color: #a5b4fc; }
  .degraded { color: #fbbf24; font-size: 0.85rem; margin: 0.25rem 0; }
  .muted { color: #64748b; font-style: italic; padding: 0.5rem 0; }
  .status-accepted { color: #4ade80; }
  .status-refused { color: #f87171; }
  .status-skipped { color: #94a3b8; }
  .status-pending { color: #fbbf24; }
  code { background: #0f172a; padding: 0.1rem 0.3rem; border-radius: 0.25rem; font-size: 0.8rem; }
  ul { list-style: none; padding: 0; }
  li { margin: 0.25rem 0; }
  .healthy { border-left: 3px solid #16a34a; }
  .degraded-border { border-left: 3px solid #d97706; }
  .unhealthy-border { border-left: 3px solid #dc2626; }
</style>
</head>
<body>
<div class="header">
  <h1>Runtime Dashboard</h1>
  <div class="meta">
    Assembled: ${escapeHtml(snapshot.assembledAt)} &mdash;
    ${escapeHtml(marketProfile.displayName)} (${escapeHtml(marketProfile.marketId)}) &mdash;
    ${escapeHtml(marketProfile.timezone)}
  </div>
</div>

<div class="section ${health.verdict === 'unhealthy' ? 'unhealthy-border' : health.verdict === 'degraded' ? 'degraded-border' : 'healthy'}">
  <h2>Health</h2>
  <table>
    <tr><td>Verdict</td><td class="td-value"><span class="verdict" style="background:${healthColor}22;color:${healthColor}">${escapeHtml(health.verdict)}</span></td></tr>
    <tr><td>Lifecycle</td><td class="td-value">${escapeHtml(health.lifecycleState)}</td></tr>
    <tr><td>Uptime</td><td class="td-value">${escapeHtml(formatUptime(health.uptimeMs))}</td></tr>
    <tr><td>Checked At</td><td class="td-value">${escapeHtml(health.checkedAt)}</td></tr>
  </table>
</div>

${degradedSection}

<div class="section">
  <h2>Runtime / Scheduler</h2>
  <table>
    <tr><td>Status</td><td class="td-value">${escapeHtml(runtime.schedulerStatus)}</td></tr>
    <tr><td>Market Phase</td><td class="td-value">${escapeHtml(runtime.marketPhase)}</td></tr>
    <tr><td>Tick Count</td><td class="td-value">${runtime.tickCount}</td></tr>
    <tr><td>Last Tick</td><td class="td-value">${maybeTimestamp(runtime.lastTickTimestamp)}</td></tr>
    <tr><td>Started At</td><td class="td-value">${maybeTimestamp(runtime.startedAt)}</td></tr>
    <tr><td>Last Error</td><td class="td-value">${escapeHtml(maybeValue(runtime.lastError))}</td></tr>
  </table>
</div>

<div class="section">
  <h2>Market Profile</h2>
  <table>
    <tr><td>Phase</td><td class="td-value">${escapeHtml(marketProfile.currentPhase)}</td></tr>
    <tr><td>Trading Day</td><td class="td-value">${marketProfile.isTradingDay ? 'Yes' : 'No'}</td></tr>
    <tr><td>Settlement</td><td class="td-value">${escapeHtml(marketProfile.settlementCycle)}</td></tr>
  </table>
</div>

${brokerSection}

${universeSection}

<div class="section">
  <h2>Recent Proposals (${recentProposals.length})</h2>
  <table>
    <thead><tr><td>Exchange</td><td>Symbol</td><td>Side</td><td>Status</td><td>Reasons</td></tr></thead>
    <tbody>${proposalsRows}</tbody>
  </table>
</div>

<div class="section">
  <h2>Blocked Orders (${recentBlockedOrders.length})</h2>
  <table>
    <thead><tr><td>Exchange</td><td>Symbol</td><td>Side</td><td>Code</td><td>Message</td></tr></thead>
    <tbody>${blockedRows}</tbody>
  </table>
</div>

<div class="section">
  <h2>Lifecycle Events (${recentLifecycleEvents.length})</h2>
  <table>
    <thead><tr><td>Timestamp</td><td>State</td><td>Reason</td></tr></thead>
    <tbody>${lifecycleRows}</tbody>
  </table>
</div>

<div class="meta" style="margin-top:1rem;font-size:0.75rem;">
  <a href="/dashboard.json" style="color:#3b82f6;">JSON view</a> &mdash;
  <a href="/health" style="color:#3b82f6;">Health JSON</a>
</div>
</body>
</html>`;
}

/** Render the dashboard snapshot as pretty-printed JSON. */
export function renderDashboardJson(snapshot: DashboardSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}
