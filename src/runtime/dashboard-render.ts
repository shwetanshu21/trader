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
  const { marketProfile, health, runtime, broker, universe, recentProposals, recentBlockedOrders, recentLifecycleEvents, recentStrategyDecisions, execution } = snapshot;

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

  const strategyRows = recentStrategyDecisions.length === 0
    ? '<tr><td colspan="8" class="muted">No strategy decisions recorded</td></tr>'
    : recentStrategyDecisions.map(d => {
      const reasons = d.reasons.length > 0
        ? `<div class="reasons">${d.reasons.map(r => `<span class="reason">${escapeHtml(r)}</span>`).join('')}</div>`
        : '';
      const hybridCell = d.hybrid
        ? `<div class="hybrid-block">
            <span class="score">D:${(d.hybrid.deterministicScore * 100).toFixed(0)}%</span>
            <span class="score">M:${(d.hybrid.mergedScore * 100).toFixed(0)}%</span>
            ${d.hybrid.llmScore != null ? `<span class="score llm">L:${(d.hybrid.llmScore * 100).toFixed(0)}%</span>` : `<span class="score muted">L:—</span>`}
            <span class="score policy">${escapeHtml(d.hybrid.mergePolicy)}</span>
            ${d.hybrid.isDowngraded ? `<span class="downgrade-badge" title="${escapeHtml(d.hybrid.downgradeContext ?? '')}">▼ downgraded</span>` : ''}
            ${d.hybrid.components.length > 0 ? `<div class="hybrid-comps">${d.hybrid.components.map(c => `<span class="comp">${escapeHtml(c.componentName)}:${(c.score * 100).toFixed(0)}%</span>`).join('')}</div>` : ''}
            ${d.hybrid.llmRationale ? `<div class="hybrid-rationale">${escapeHtml(d.hybrid.llmRationale)}</div>` : ''}
            ${d.hybrid.downgradeContext && !d.hybrid.isDowngraded ? `<div class="hybrid-note">${escapeHtml(d.hybrid.downgradeContext)}</div>` : ''}
          </div>`
        : '<span class="muted">—</span>';
      return `<tr>
        <td>${escapeHtml(d.exchange)}</td>
        <td>${escapeHtml(d.tradingsymbol)}</td>
        <td>${escapeHtml(d.side)}</td>
        <td class="status-${d.decisionStatus}">${escapeHtml(d.decisionStatus)}</td>
        <td>${d.notional != null ? d.notional.toFixed(0) : '—'}</td>
        <td>${reasons}</td>
        <td>${hybridCell}</td>
      </tr>`;
    }).join('');

  // ── Execution evidence section ──────────────────────────────────────────

  let executionSection: string;
  if (execution) {
    const modeColor = execution.isGateRefusing ? '#dc2626' : execution.mode === 'paper' ? '#d97706' : '#16a34a';
    const modeLabel = execution.isGateRefusing ? 'blocked' : execution.mode;
    const lastAttemptVerdict = execution.recentAttempts.length > 0
      ? execution.recentAttempts[0].status
      : 'none';
    const lastAttemptSymbol = execution.recentAttempts.length > 0
      ? `${escapeHtml(execution.recentAttempts[0].exchange)}:${escapeHtml(execution.recentAttempts[0].tradingsymbol)}`
      : '—';

    // ── Paper orders table ──────────────────────────────────────────
    const paperOrdersRows = execution.recentPaperOrders.length === 0
      ? '<tr><td colspan="6" class="muted">No paper orders</td></tr>'
      : execution.recentPaperOrders.map(o => `<tr>
          <td>${escapeHtml(o.tradingsymbol)}</td>
          <td>${escapeHtml(o.side)}</td>
          <td>${o.quantity}</td>
          <td>${o.price != null ? o.price.toFixed(2) : '—'}</td>
          <td class="status-${o.status}">${escapeHtml(o.status)}</td>
          <td><code>${escapeHtml(o.brokerOrderId)}</code></td>
        </tr>`).join('');

    // ── Paper fills table ───────────────────────────────────────────
    const paperFillsRows = execution.recentPaperFills.length === 0
      ? '<tr><td colspan="5" class="muted">No paper fills</td></tr>'
      : execution.recentPaperFills.map(f => `<tr>
          <td>${escapeHtml(f.tradingsymbol)}</td>
          <td>${escapeHtml(f.side)}</td>
          <td>${f.filledQuantity} @ ${f.filledPrice.toFixed(2)}</td>
          <td><code>${escapeHtml(f.brokerOrderId)}</code></td>
          <td>${escapeHtml(f.filledAt)}</td>
        </tr>`).join('');

    // ── Current positions table ─────────────────────────────────────
    const positionsRows = execution.currentPositions.length === 0
      ? '<tr><td colspan="5" class="muted">No positions</td></tr>'
      : execution.currentPositions.map(p => `<tr>
          <td>${escapeHtml(p.tradingsymbol)}</td>
          <td>${escapeHtml(p.product)}</td>
          <td class="status-${p.side === 'flat' ? 'skipped' : p.side === 'long' ? 'accepted' : 'refused'}">${escapeHtml(p.side)}</td>
          <td>${p.quantity}</td>
          <td>${p.avgCostPrice.toFixed(2)}</td>
          <td>${p.realizedPnl.toFixed(2)}</td>
        </tr>`).join('');

    // ── Recent position events table ─────────────────────────────────
    const positionEventsRows = execution.recentPositionEvents.length === 0
      ? '<tr><td colspan="4" class="muted">No position events</td></tr>'
      : execution.recentPositionEvents.map(e => `<tr>
          <td>${escapeHtml(e.tradingsymbol)}</td>
          <td class="status-${e.eventType === 'open' || e.eventType === 'fill' ? 'accepted' : 'refused'}">${escapeHtml(e.eventType)}</td>
          <td>${e.quantityDelta > 0 ? '+' : ''}${e.quantityDelta} @ ${e.price.toFixed(2)}</td>
          <td>${e.realizedPnl.toFixed(2)}</td>
        </tr>`).join('');

    // ── Risk state section ────────────────────────────────────────────
    const riskStateSection = execution.riskState ? `
        <h3 style="margin-top:0.75rem;font-size:0.9rem;color:#94a3b8;">Risk State</h3>
        <table style="margin-top:0.5rem;">
          <tr><td>Halt State</td><td class="td-value"><span class="verdict" style="background:${execution.riskState.isRefusing ? '#dc262622' : '#16a34a22'};color:${execution.riskState.isRefusing ? '#dc2626' : '#16a34a'}">${escapeHtml(execution.riskState.haltState)}</span></td></tr>
          <tr><td>Halt Source</td><td class="td-value">${execution.riskState.haltSource ? escapeHtml(execution.riskState.haltSource) : '—'}</td></tr>
          <tr><td>Halt Reason</td><td class="td-value">${execution.riskState.haltReason ? escapeHtml(execution.riskState.haltReason) : '—'}</td></tr>
          <tr><td>Halted At</td><td class="td-value">${execution.riskState.haltedAt ?? '—'}</td></tr>
          <tr><td>Is Refusing</td><td class="td-value">${execution.riskState.isRefusing ? 'Yes' : 'No'}</td></tr>
          <tr><td>Latch Count</td><td class="td-value">${execution.riskState.latchCount}</td></tr>
          <tr><td>Positions At Halt</td><td class="td-value">${execution.riskState.openPositionCountAtHalt ?? '—'}</td></tr>
          <tr><td>Daily P&amp;L At Halt</td><td class="td-value">${execution.riskState.dailyPnlAtHalt != null ? execution.riskState.dailyPnlAtHalt.toFixed(2) : '—'}</td></tr>
        </table>` : '<p class="muted" style="margin-top:0.5rem;">No risk state available</p>';

    // ── Recent risk events table ──────────────────────────────────────
    const riskEvents = execution.recentRiskEvents ?? [];
    const riskEventsRows = riskEvents.length === 0
      ? '<tr><td colspan="4" class="muted">No risk events</td></tr>'
      : execution.recentRiskEvents.map(e => {
        const severityColor = e.severity === 'critical' ? '#dc2626' : e.severity === 'warning' ? '#d97706' : '#94a3b8';
        return `<tr>
          <td>${escapeHtml(e.recordedAt)}</td>
          <td>${escapeHtml(e.eventType)}</td>
          <td><span class="verdict" style="background:${severityColor}22;color:${severityColor}">${escapeHtml(e.severity)}</span></td>
          <td>${escapeHtml(e.message)}</td>
        </tr>`;
      }).join('');

    // ── Build the full execution HTML block ─────────────────────────────
    executionSection = `
      <div class="section">
        <h2>Execution</h2>
        <table>
          <tr><td>Mode</td><td class="td-value"><span class="verdict" style="background:${modeColor}22;color:${modeColor}">${escapeHtml(modeLabel)}</span></td></tr>
          <tr><td>Total Attempts</td><td class="td-value">${execution.totalAttempts}</td></tr>
          <tr><td>Orders / Fills</td><td class="td-value">${execution.totalOrders} orders, ${execution.totalFills} fills</td></tr>
          <tr><td>Open Positions</td><td class="td-value">${execution.openPositionCount}</td></tr>
          <tr><td>Gate Refusing</td><td class="td-value">${execution.isGateRefusing ? 'Yes' : 'No'}</td></tr>
          <tr><td>Gate Reason</td><td class="td-value">${execution.gateRefusalReason ? escapeHtml(execution.gateRefusalReason) : '—'}</td></tr>
          <tr><td>Last Attempt</td><td class="td-value">${lastAttemptSymbol} (${escapeHtml(lastAttemptVerdict)})</td></tr>
        </table>
        ${riskStateSection}
        <h3 style="margin-top:0.75rem;font-size:0.9rem;color:#94a3b8;">Recent Risk Events (${riskEvents.length})</h3>
        <table style="margin-top:0.5rem;">
          <thead><tr><td>Timestamp</td><td>Type</td><td>Severity</td><td>Message</td></tr></thead>
          <tbody>${riskEventsRows}</tbody>
        </table>
        ${execution.recentAttempts.length > 0 ? `
        <h3 style="margin-top:0.75rem;font-size:0.9rem;color:#94a3b8;">Recent Attempts</h3>
        <table style="margin-top:0.5rem;">
          <thead><tr><td>#</td><td>Symbol</td><td>Mode</td><td>Status</td><td>Outcome</td><td>Message</td></tr></thead>
          <tbody>${execution.recentAttempts.map(a => `
            <tr>
              <td>${a.id}</td>
              <td>${escapeHtml(a.exchange)}:${escapeHtml(a.tradingsymbol)}</td>
              <td>${escapeHtml(a.executionMode)}</td>
              <td class="status-${a.status}">${escapeHtml(a.status)}</td>
              <td>${a.outcomeCode ? escapeHtml(a.outcomeCode) : '—'}</td>
              <td>${escapeHtml(a.message)}${a.refusalReasons.length > 0 ? `<div class="reasons" style="margin-top:0.25rem;">${a.refusalReasons.map(r => `<span class="reason">${escapeHtml(r)}</span>`).join('')}</div>` : ''}</td>
            </tr>`).join('')}</tbody>
        </table>` : '<p class="muted" style="margin-top:0.5rem;">No recent execution attempts</p>'}
        <h3 style="margin-top:0.75rem;font-size:0.9rem;color:#94a3b8;">Paper Orders (${execution.totalOrders})</h3>
        <table style="margin-top:0.5rem;">
          <thead><tr><td>Symbol</td><td>Side</td><td>Qty</td><td>Price</td><td>Status</td><td>Order ID</td></tr></thead>
          <tbody>${paperOrdersRows}</tbody>
        </table>
        <h3 style="margin-top:0.75rem;font-size:0.9rem;color:#94a3b8;">Paper Fills (${execution.totalFills})</h3>
        <table style="margin-top:0.5rem;">
          <thead><tr><td>Symbol</td><td>Side</td><td>Fill</td><td>Order ID</td><td>Filled At</td></tr></thead>
          <tbody>${paperFillsRows}</tbody>
        </table>
        <h3 style="margin-top:0.75rem;font-size:0.9rem;color:#94a3b8;">Current Positions (${execution.currentPositions.length})</h3>
        <table style="margin-top:0.5rem;">
          <thead><tr><td>Symbol</td><td>Product</td><td>Side</td><td>Qty</td><td>Avg Cost</td><td>Realized P&amp;L</td></tr></thead>
          <tbody>${positionsRows}</tbody>
        </table>
        <h3 style="margin-top:0.75rem;font-size:0.9rem;color:#94a3b8;">Position Events (${execution.recentPositionEvents.length})</h3>
        <table style="margin-top:0.5rem;">
          <thead><tr><td>Symbol</td><td>Type</td><td>Delta</td><td>Realized P&amp;L</td></tr></thead>
          <tbody>${positionEventsRows}</tbody>
        </table>
      </div>`;
  } else {
    executionSection = `
      <div class="section">
        <h2>Execution</h2>
        <p class="muted">No execution evidence available — attempt repo not wired</p>
      </div>`;
  }

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
  .hybrid-block { display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: center; }
  .score { display: inline-block; padding: 0.1rem 0.3rem; border-radius: 0.25rem; font-size: 0.75rem; background: #1e3a5f; color: #93c5fd; font-variant-numeric: tabular-nums; }
  .score.llm { background: #3b1f5e; color: #c4b5fd; }
  .score.policy { background: #1a3a2a; color: #6ee7b7; }
  .downgrade-badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 0.25rem; font-size: 0.7rem; background: #7f1d1d; color: #fca5a5; cursor: help; }
  .hybrid-comps { display: flex; flex-wrap: wrap; gap: 0.2rem; margin-top: 0.15rem; }
  .hybrid-comps .comp { display: inline-block; padding: 0.05rem 0.3rem; border-radius: 0.2rem; font-size: 0.65rem; background: #1e293b; color: #94a3b8; }
  .hybrid-rationale { font-size: 0.7rem; color: #a78bfa; margin-top: 0.1rem; }
  .hybrid-note { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 0.25rem; font-size: 0.7rem; background: #1e3a5f; color: #93c5fd; }
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
  <h2>Strategy Decisions (${recentStrategyDecisions.length})</h2>
  <table>
    <thead><tr><td>Exchange</td><td>Symbol</td><td>Side</td><td>Status</td><td>Notional</td><td>Reasons</td><td>Hybrid</td></tr></thead>
    <tbody>${strategyRows}</tbody>
  </table>
</div>

${executionSection}

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
