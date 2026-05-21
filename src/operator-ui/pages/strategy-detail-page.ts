import type {
  OperatorDecisionPerformance,
  OperatorGovernanceDecisionDetail,
  OperatorPromotionHistory,
  OperatorStrategyDetail,
  OperatorStrategyWalkForwardDetail,
} from '../../types/runtime.js';
import {
  backtestDetailHref,
  decisionDetailHref,
  escapeHtml,
  formatCurrency,
  formatInt,
  formatJson,
  formatNumber,
  formatPercent,
  formatRawPercent,
  formatTimestamp,
  renderEmptyState,
  renderKeyValueGrid,
  renderLink,
  renderPageLayout,
  renderProvenanceBadge,
  renderSection,
  renderSummaryGrid,
  statusClass,
  strategyDetailHref,
} from '../render-utils.js';

export function renderStrategyDetailPage(detail: OperatorStrategyDetail): string {
  const selfHref = strategyDetailHref(detail.strategyId, detail.strategyVersion);
  const actions = [
    renderLink('/', '← Back to dashboard'),
    renderLink(selfHref, `Permalink ${detail.strategyId}@${detail.strategyVersion}`),
  ].join('');

  const lifecycleEmptyMessage = detail.hostEvidencePresence.lifecycleStates
    ? 'Lifecycle evidence exists on this host, but none has been persisted for this strategy version.'
    : 'No lifecycle evidence has been produced on this host yet.';
  const governanceEmptyMessage = detail.hostEvidencePresence.governanceHistory
    ? 'Governance evidence exists on this host, but none has been persisted for this strategy version.'
    : 'No governance history has been produced on this host yet.';
  const promotionEmptyMessage = detail.hostEvidencePresence.promotionHistory
    ? 'Promotion evidence exists on this host, but none has been persisted for this strategy version.'
    : 'No promotion history has been produced on this host yet.';
  const walkForwardEmptyMessage = detail.hostEvidencePresence.walkForwardRuns
    ? 'Walk-forward evidence exists on this host, but no persisted run is linked to this strategy version.'
    : 'No walk-forward runs have been produced on this host yet.';

  const body = [
    renderSection('Strategy Summary', renderSummaryGrid([
      { label: 'Strategy', value: `<code>${escapeHtml(detail.strategyId)}</code>` },
      { label: 'Version', value: `<code>${escapeHtml(detail.strategyVersion)}</code>` },
      { label: 'Realized P&L', value: escapeHtml(formatCurrency(detail.performance.realizedPnl, 'INR')) },
      { label: 'Unrealized P&L', value: escapeHtml(formatCurrency(detail.performance.unrealizedPnl, 'INR')) },
      { label: 'Total P&L', value: `<span class="${detail.performance.realizedPnl + detail.performance.unrealizedPnl >= 0 ? 'status-ok' : 'status-err'}">${escapeHtml(formatCurrency(detail.performance.realizedPnl + detail.performance.unrealizedPnl, 'INR'))}</span>` },
      { label: 'Trade Count', value: escapeHtml(formatInt(detail.performance.tradeCount)) },
    ]), 'ok', null, null, 'Live/paper execution evidence only'),

    renderSection('Walk-Forward Aggregate', renderSummaryGrid([
      { label: 'Return %', value: detail.performance.totalReturnPct === null ? '—' : `<span class="${detail.performance.totalReturnPct >= 0 ? 'status-ok' : 'status-err'}">${escapeHtml(formatRawPercent(detail.performance.totalReturnPct))}</span>`, meta: 'Backtest / selection-derived, not live account return' },
      { label: 'Sharpe', value: escapeHtml(detail.performance.sharpeRatio === null ? '—' : formatNumber(detail.performance.sharpeRatio, 2)) },
      { label: 'Max Drawdown', value: escapeHtml(detail.performance.maxDrawdownPct === null ? '—' : formatRawPercent(detail.performance.maxDrawdownPct)) },
      { label: 'Win Rate', value: escapeHtml(formatPercent(detail.performance.winRate)) },
      { label: 'Profit Factor', value: escapeHtml(detail.performance.profitFactor === null ? '—' : formatNumber(detail.performance.profitFactor, 2)) },
    ]), 'ok', null, null, 'Historical strategy-quality metrics scoped to walk-forward and governance evidence'),

    renderSection(
      'Current Lifecycle',
      detail.currentStates.length > 0
        ? `<table>
            <thead><tr><th>Market</th><th>Phase</th><th>Updated</th><th>Source</th></tr></thead>
            <tbody>${detail.currentStates.map(state => `<tr>
              <td><code>${escapeHtml(state.marketId)}</code></td>
              <td><span class="${statusClass(state.phase)}">${escapeHtml(state.phase)}</span></td>
              <td>${escapeHtml(formatTimestamp(state.updatedAt))}</td>
              <td>${renderProvenanceBadge(state.provenance)}</td>
            </tr>`).join('')}</tbody>
          </table>`
        : renderEmptyState(lifecycleEmptyMessage),
      'ok',
      null,
      null,
      'Across matching markets',
    ),

    renderSection(
      'Recent Decisions',
      renderDecisionTable(detail.recentDecisions),
      'ok',
      null,
      null,
      'Newest persisted decisions first',
    ),

    renderSection(
      'Governance History',
      renderGovernanceTable(detail.governanceHistory, governanceEmptyMessage),
      'ok',
      null,
      null,
      'Rationale and phase transitions',
    ),

    renderSection(
      'Promotion History',
      renderPromotionTable(detail.promotionHistory, promotionEmptyMessage),
      'ok',
      null,
      null,
      'Promotion-only subset',
    ),

    renderSection(
      'Walk-Forward Evidence',
      renderWalkForwardTable(detail.walkForwardRuns, walkForwardEmptyMessage),
      'ok',
      null,
      null,
      'Linked persisted backtest runs',
    ),

    renderSection(
      'Diagnostics & Provenance',
      `${renderKeyValueGrid([
        { key: 'Provenance', value: renderProvenanceBadge(detail.provenance) || '—' },
        { key: 'Source Label', value: escapeHtml(detail.provenance.sourceLabel ?? '—') },
        { key: 'As Of', value: escapeHtml(formatTimestamp(new Date(detail.provenance.asOf).toISOString())) },
      ])}
      <div style="margin-top:0.9rem;">
        <h3>Diagnostics</h3>
        ${detail.diagnostics.length > 0
          ? `<ul>${detail.diagnostics.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
          : renderEmptyState('No diagnostics were emitted while composing this detail view.')}
      </div>`,
    ),
  ].join('\n');

  return renderPageLayout({
    title: `${detail.strategyId}@${detail.strategyVersion}`,
    kicker: 'Operator Strategy Detail',
    subtitle: 'Lifecycle, governance, decision, and backtest evidence for one persisted strategy identity.',
    meta: `${detail.currentStates.length} active lifecycle row(s) · ${detail.walkForwardRuns.length} linked walk-forward run(s)`,
    actions,
    body,
    navActive: 'strategies',
  });
}

function renderDecisionTable(rows: OperatorDecisionPerformance[]): string {
  if (rows.length === 0) {
    return renderEmptyState('No decision evidence has been persisted for this strategy version yet.');
  }

  return `<table>
    <thead><tr><th>Decision</th><th>Instrument</th><th>Side</th><th class="num">Qty</th><th>Status</th><th>Execution</th><th>Outcome</th><th class="num">Realized P&amp;L</th><th>Decided At</th></tr></thead>
    <tbody>${rows.map(row => `<tr>
      <td>${renderLink(decisionDetailHref(row.decisionId), `#${row.decisionId}`)}</td>
      <td><code>${escapeHtml(row.exchange)}:${escapeHtml(row.tradingsymbol)}</code></td>
      <td>${escapeHtml(row.side)}</td>
      <td class="num">${escapeHtml(formatInt(row.quantity))}</td>
      <td><span class="${statusClass(row.decisionStatus)}">${escapeHtml(row.decisionStatus)}</span></td>
      <td>${row.executionStatus ? `<span class="${statusClass(row.executionStatus)}">${escapeHtml(row.executionStatus)}</span>` : '<span class="status-skip">unconsumed</span>'}</td>
      <td>${escapeHtml(row.outcomeCode ?? '—')}</td>
      <td class="num">${row.realizedPnl === null ? '—' : `<span class="${row.realizedPnl >= 0 ? 'status-ok' : 'status-err'}">${escapeHtml(formatCurrency(row.realizedPnl, 'INR'))}</span>`}</td>
      <td>${escapeHtml(formatTimestamp(row.decidedAt))}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function renderGovernanceTable(rows: OperatorGovernanceDecisionDetail[], emptyMessage: string): string {
  if (rows.length === 0) {
    return renderEmptyState(emptyMessage);
  }

  return `<table>
    <thead><tr><th>ID</th><th>Market</th><th>Verdict</th><th>From</th><th>To</th><th>Rationale</th><th>Winner</th><th>Recorded</th></tr></thead>
    <tbody>${rows.map(row => `<tr>
      <td><code>#${row.id}</code></td>
      <td><code>${escapeHtml(row.marketId)}</code></td>
      <td><span class="${statusClass(row.verdict)}">${escapeHtml(row.verdict)}</span></td>
      <td><code>${escapeHtml(row.previousPhase)}</code></td>
      <td><code>${escapeHtml(row.newPhase)}</code></td>
      <td>${escapeHtml(row.rationale)}</td>
      <td>${row.winnerId === null ? '<span class="status-skip">No winner referenced</span>' : `<code>WF#${row.winnerId}</code>`}</td>
      <td>${escapeHtml(formatTimestamp(row.recordedAt))}</td>
    </tr>
    ${row.evidence ? `<tr><td colspan="8"><details><summary>Evidence JSON</summary><pre>${formatJson(row.evidence)}</pre></details></td></tr>` : ''}`).join('')}</tbody>
  </table>`;
}

function renderPromotionTable(rows: OperatorPromotionHistory[], emptyMessage: string): string {
  if (rows.length === 0) {
    return renderEmptyState(emptyMessage);
  }

  return `<table>
    <thead><tr><th>Market</th><th>From</th><th>To</th><th>Rationale</th><th>Winner Context</th><th>Promoted At</th></tr></thead>
    <tbody>${rows.map(row => `<tr>
      <td><code>${escapeHtml(row.marketId)}</code></td>
      <td><code>${escapeHtml(row.previousPhase)}</code></td>
      <td><span class="${statusClass(row.newPhase)}">${escapeHtml(row.newPhase)}</span></td>
      <td>${escapeHtml(row.rationale)}</td>
      <td>${row.winnerId === null ? '<span class="status-warn">No winner recorded</span>' : `<code>WF#${row.winnerId}</code> · ${renderLink(strategyDetailHref(row.strategyId, row.strategyVersion), 'strategy detail')}`}</td>
      <td>${escapeHtml(formatTimestamp(row.promotedAt))}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function renderWalkForwardTable(rows: OperatorStrategyWalkForwardDetail[], emptyMessage: string): string {
  if (rows.length === 0) {
    return renderEmptyState(emptyMessage);
  }

  return `<table>
    <thead><tr><th>Run</th><th>Market</th><th>Status</th><th>Result</th><th class="num">Windows</th><th class="num">Trials</th><th class="num">Score</th><th class="num">Sharpe</th><th class="num">Return</th><th>Rationale</th><th>Selected At</th></tr></thead>
    <tbody>${rows.map(row => `<tr>
      <td>${renderLink(backtestDetailHref(row.runId), row.label)}</td>
      <td><code>${escapeHtml(row.marketId)}</code></td>
      <td><span class="${statusClass(row.status)}">${escapeHtml(row.status)}</span></td>
      <td>${row.result ? `<span class="${statusClass(row.result)}">${escapeHtml(row.result)}</span>` : '<span class="status-skip">pending</span>'}</td>
      <td class="num">${escapeHtml(formatInt(row.windowCount))}</td>
      <td class="num">${escapeHtml(formatInt(row.totalTrials))}</td>
      <td class="num">${escapeHtml(row.mergedScore === null ? '—' : formatPercent(row.mergedScore))}</td>
      <td class="num">${escapeHtml(row.sharpeRatio === null ? '—' : formatNumber(row.sharpeRatio, 2))}</td>
      <td class="num">${escapeHtml(row.totalReturnPct === null ? '—' : formatRawPercent(row.totalReturnPct))}</td>
      <td>${escapeHtml(row.rationale ?? (row.winnerId === null ? 'No winner selected for this run.' : '—'))}</td>
      <td>${escapeHtml(formatTimestamp(row.selectedAt))}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}
