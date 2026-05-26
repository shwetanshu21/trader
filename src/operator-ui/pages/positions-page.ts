import type { DashboardPayload } from '../dashboard-data.js';
import type { OperatorStrategyExposure, OperatorTickerPerformance } from '../../types/runtime.js';
import { renderDashboardSectionHtml } from './dashboard-page.js';
import {
  escapeHtml,
  formatCurrency,
  formatInt,
  formatPercent,
  renderEmptyState,
  renderPageLayout,
  renderProvenanceBadge,
  renderSection,
} from '../render-utils.js';

function computeOpenMarketValue(row: OperatorTickerPerformance): number {
  return Math.abs(row.netQuantity) * (row.lastPrice ?? row.avgEntryPrice ?? 0);
}

function computeOpenCostBasis(row: OperatorTickerPerformance): number {
  return Math.abs(row.netQuantity) * (row.avgEntryPrice ?? 0);
}

function renderExposureSummarySection(payload: DashboardPayload, exposure: OperatorStrategyExposure[]): string {
  const tickerSection = payload.tickerPerformance;
  const usableTickerRows = (tickerSection.state === 'ok' || tickerSection.state === 'stale')
    ? tickerSection.data.filter(row => row.netQuantity !== 0)
    : [];

  const grossOpenMarketValue = usableTickerRows.reduce((sum, row) => sum + computeOpenMarketValue(row), 0);
  const grossOpenCostBasis = usableTickerRows.reduce((sum, row) => sum + computeOpenCostBasis(row), 0);
  const largestPositionValue = usableTickerRows.reduce((max, row) => Math.max(max, computeOpenMarketValue(row)), 0);
  const topThreeValue = [...usableTickerRows]
    .map(computeOpenMarketValue)
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((sum, value) => sum + value, 0);
  const unattributedValue = exposure
    .filter(row => row.bucketType === 'unattributed')
    .reduce((sum, row) => sum + row.grossOpenMarketValue, 0);

  const cards = [
    { label: 'Gross Open Cost Basis', value: usableTickerRows.length > 0 ? formatCurrency(grossOpenCostBasis) : 'Unavailable', meta: 'Proxy from open positions' },
    { label: 'Gross Open Market Value', value: usableTickerRows.length > 0 ? formatCurrency(grossOpenMarketValue) : 'Unavailable', meta: 'Proxy from latest mark/entry prices' },
    { label: 'Largest Position', value: grossOpenMarketValue > 0 ? formatPercent(largestPositionValue / grossOpenMarketValue) : '—', meta: 'Share of gross open market value' },
    { label: 'Top 3 Concentration', value: grossOpenMarketValue > 0 ? formatPercent(topThreeValue / grossOpenMarketValue) : '—', meta: 'Largest three open positions' },
    { label: 'Unattributed Exposure', value: unattributedValue > 0 ? formatCurrency(unattributedValue) : '—', meta: 'Withheld rather than guessed' },
  ];

  const grid = `<div class="summary-grid">${cards.map(card => `<div class="summary-card"><div class="label">${escapeHtml(card.label)}</div><div class="value">${card.value}</div><div class="meta">${escapeHtml(card.meta)}</div></div>`).join('')}</div>`;
  const note = '<p class="page-subtitle" style="margin-top:0.85rem;">All values on this page are exposure proxies derived from persisted paper positions. They are not broker cash, NAV, or account equity.</p>';

  return renderSection(
    'Exposure Summary',
    `${grid}${note}`,
    tickerSection.state,
    tickerSection.errorMessage,
    tickerSection.stalenessMs,
    'Concentration and open-position proxies',
    {
      id: 'positions-exposure-summary',
      lastFetchedAt: tickerSection.lastFetchedAt,
      isCachedData: tickerSection.isCachedData,
    },
  );
}

function renderExposureBreakdownSection(payload: DashboardPayload, exposure: OperatorStrategyExposure[]): string {
  const state = payload.tickerPerformance.state;

  let content: string;
  if ((state === 'ok' || state === 'stale') && exposure.length > 0) {
    const totalMarketValue = exposure.reduce((sum, row) => sum + row.grossOpenMarketValue, 0);
    const rows = exposure.map(row => {
      const share = totalMarketValue > 0 ? formatPercent(row.grossOpenMarketValue / totalMarketValue) : '—';
      const label = row.bucketType === 'strategy' && row.strategyId && row.strategyVersion
        ? `<code>${escapeHtml(row.strategyId)}</code> <span class="status-default">@</span> <code>${escapeHtml(row.strategyVersion)}</code>`
        : `<span class="status-warn">${escapeHtml(row.label)}</span>`;
      const note = row.attributionNote ? `<div class="section-note">${escapeHtml(row.attributionNote)}</div>` : '';
      return `<tr>
        <td>${label}${note}</td>
        <td class="num">${formatInt(row.openPositionCount)}</td>
        <td class="num">${formatCurrency(row.grossOpenCostBasis)}</td>
        <td class="num">${formatCurrency(row.grossOpenMarketValue)}</td>
        <td class="num ${row.unrealizedPnl >= 0 ? 'status-ok' : 'status-err'}">${formatCurrency(row.unrealizedPnl)}</td>
        <td class="num">${share}</td>
        <td>${renderProvenanceBadge(row.provenance)}</td>
      </tr>`;
    }).join('');

    content = `<div class="section-note">Exposure is only attributed when the open position maps to exactly one persisted strategy. Ambiguous or unlinked positions stay explicit.</div>
      <table>
        <thead><tr>
          <th>Exposure Bucket</th>
          <th class="num">Open Positions</th>
          <th class="num">Cost Basis</th>
          <th class="num">Market Value</th>
          <th class="num">Unrealized P&amp;L</th>
          <th class="num">Share</th>
          <th>Source</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  } else if (state === 'unavailable') {
    content = renderEmptyState('Database unavailable — exposure attribution cannot be loaded.');
  } else if (state === 'error') {
    content = renderEmptyState(payload.tickerPerformance.errorMessage ?? 'Failed to load exposure attribution.');
  } else {
    content = renderEmptyState('No open positions are currently available for exposure attribution.');
  }

  return renderSection(
    'Exposure by Strategy',
    content,
    state,
    payload.tickerPerformance.errorMessage,
    payload.tickerPerformance.stalenessMs,
    'Attributed only when persisted evidence is unique',
    {
      id: 'positions-strategy-exposure',
      lastFetchedAt: payload.tickerPerformance.lastFetchedAt,
      isCachedData: payload.tickerPerformance.isCachedData,
    },
  );
}

export function renderPositionsPage(payload: DashboardPayload, exposure: OperatorStrategyExposure[], options: { shellStatus?: import('../components/status-strip.js').OperatorShellStatusViewModel | null } = {}): string {
  const sectionHtml = renderDashboardSectionHtml(payload);

  return renderPageLayout({
    title: 'Positions & Exposure',
    kicker: 'Operator Console',
    subtitle: 'Open-position evidence, concentration, and conservative strategy attribution from persisted paper execution state.',
    meta: `Assembled ${escapeHtml(payload.assembledAt)}`,
    actions: '<a href="/">Back to overview</a><a href="/strategies">Strategies</a><a href="/system-health">System health</a>',
    navActive: 'positions',
    shellStatus: options.shellStatus ?? null,
    body: [
      renderExposureSummarySection(payload, exposure),
      renderExposureBreakdownSection(payload, exposure),
      sectionHtml.tickerPerformance,
    ].join('\n'),
  });
}
