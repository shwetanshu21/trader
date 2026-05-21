import type { DashboardPayload } from '../dashboard-data.js';
import type { OperatorStrategyExposure } from '../../types/runtime.js';
import { renderDashboardSectionHtml } from './dashboard-page.js';
import {
  escapeHtml,
  formatCurrency,
  formatInt,
  renderEmptyState,
  renderPageLayout,
  renderProvenanceBadge,
  renderSection,
} from '../render-utils.js';

function renderStrategyExposureSection(payload: DashboardPayload, exposure: OperatorStrategyExposure[]): string {
  const state = payload.strategyPerformance.state;
  const strategyRows = exposure.filter(row => row.bucketType === 'strategy');
  const unattributedRows = exposure.filter(row => row.bucketType === 'unattributed');
  const unattributedValue = unattributedRows.reduce((sum, row) => sum + row.grossOpenMarketValue, 0);

  let content: string;
  if ((state === 'ok' || state === 'stale') && exposure.length > 0) {
    const rows = strategyRows.map(row => `<tr>
      <td><code>${escapeHtml(row.strategyId ?? '—')}</code></td>
      <td><code>${escapeHtml(row.strategyVersion ?? '—')}</code></td>
      <td class="num">${formatInt(row.openPositionCount)}</td>
      <td class="num">${formatCurrency(row.grossOpenCostBasis)}</td>
      <td class="num">${formatCurrency(row.grossOpenMarketValue)}</td>
      <td class="num ${row.unrealizedPnl >= 0 ? 'status-ok' : 'status-err'}">${formatCurrency(row.unrealizedPnl)}</td>
      <td>${renderProvenanceBadge(row.provenance)}</td>
    </tr>`).join('');

    const unattributed = unattributedRows.length > 0
      ? `<div class="section-note">${escapeHtml(unattributedRows.map(row => row.attributionNote).filter((row): row is string => Boolean(row)).join(' '))} Current unattributed gross market value: ${formatCurrency(unattributedValue)}.</div>`
      : '<div class="section-note">All open positions currently map to a single persisted strategy attribution bucket.</div>';

    content = `${unattributed}<table>
      <thead><tr>
        <th>Strategy</th>
        <th>Version</th>
        <th class="num">Open Positions</th>
        <th class="num">Cost Basis</th>
        <th class="num">Market Value</th>
        <th class="num">Unrealized P&amp;L</th>
        <th>Source</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } else if (state === 'unavailable') {
    content = renderEmptyState('Database unavailable — strategy exposure cannot be loaded.');
  } else if (state === 'error') {
    content = renderEmptyState(payload.strategyPerformance.errorMessage ?? 'Failed to load strategy exposure.');
  } else {
    content = renderEmptyState('No strategy-linked open exposure is available yet.');
  }

  return renderSection(
    'Attributed Open Exposure',
    content,
    state,
    payload.strategyPerformance.errorMessage,
    payload.strategyPerformance.stalenessMs,
    'Open positions only; unattributed rows are withheld from strategy buckets',
    {
      id: 'strategies-exposure',
      lastFetchedAt: payload.strategyPerformance.lastFetchedAt,
      isCachedData: payload.strategyPerformance.isCachedData,
    },
  );
}

function renderStrategySummarySection(payload: DashboardPayload, exposure: OperatorStrategyExposure[]): string {
  const state = payload.strategyPerformance.state;
  const strategyRows = (state === 'ok' || state === 'stale') ? payload.strategyPerformance.data : [];
  const realizedPnl = strategyRows.reduce((sum, row) => sum + row.realizedPnl, 0);
  const unrealizedPnl = strategyRows.reduce((sum, row) => sum + row.unrealizedPnl, 0);
  const attributedMarketValue = exposure
    .filter(row => row.bucketType === 'strategy')
    .reduce((sum, row) => sum + row.grossOpenMarketValue, 0);
  const unattributedMarketValue = exposure
    .filter(row => row.bucketType === 'unattributed')
    .reduce((sum, row) => sum + row.grossOpenMarketValue, 0);

  const cards = [
    { label: 'Active Strategy Rows', value: formatInt(strategyRows.length), meta: 'Persisted strategy performance rows' },
    { label: 'Realized P&L', value: formatCurrency(realizedPnl), meta: 'From linked paper fills' },
    { label: 'Unrealized P&L', value: formatCurrency(unrealizedPnl), meta: 'From current open positions' },
    { label: 'Attributed Open Market Value', value: attributedMarketValue > 0 ? formatCurrency(attributedMarketValue) : '—', meta: 'Unique strategy attribution only' },
    { label: 'Unattributed Open Market Value', value: unattributedMarketValue > 0 ? formatCurrency(unattributedMarketValue) : '—', meta: 'Ambiguous or unlinked positions' },
  ];

  const content = `<div class="summary-grid">${cards.map(card => `<div class="summary-card"><div class="label">${escapeHtml(card.label)}</div><div class="value">${card.value}</div><div class="meta">${escapeHtml(card.meta)}</div></div>`).join('')}</div>`;

  return renderSection(
    'Strategy Summary',
    content,
    state,
    payload.strategyPerformance.errorMessage,
    payload.strategyPerformance.stalenessMs,
    'P&L, activity, and open exposure context',
    {
      id: 'strategies-summary',
      lastFetchedAt: payload.strategyPerformance.lastFetchedAt,
      isCachedData: payload.strategyPerformance.isCachedData,
    },
  );
}

export function renderStrategiesPage(payload: DashboardPayload, exposure: OperatorStrategyExposure[]): string {
  const sectionHtml = renderDashboardSectionHtml(payload);

  return renderPageLayout({
    title: 'Strategies',
    kicker: 'Operator Console',
    subtitle: 'Per-strategy realized and unrealized paper evidence, plus conservative open-exposure attribution.',
    meta: `Assembled ${escapeHtml(payload.assembledAt)}`,
    actions: '<a href="/">Back to overview</a><a href="/positions">Positions & exposure</a><a href="/governance">Governance</a>',
    navActive: 'strategies',
    body: [
      renderStrategySummarySection(payload, exposure),
      renderStrategyExposureSection(payload, exposure),
      sectionHtml.strategyPerformance,
    ].join('\n'),
  });
}
