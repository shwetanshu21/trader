import type { DashboardPayload } from '../dashboard-data.js';
import type { OperatorStrategyExposure, OperatorTickerPerformance } from '../../types/runtime.js';
import {
  renderExplainabilityEvidenceChecklist,
  renderExplainabilityStack,
  renderExplainabilityWhat,
  renderExplainabilityWhyNarrative,
} from '../components/explainability.js';
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

  return renderSection(
    'Exposure Summary',
    renderExplainabilityStack([
      renderExplainabilityWhat([
        { label: 'Gross Open Cost Basis', value: usableTickerRows.length > 0 ? formatCurrency(grossOpenCostBasis) : null, meta: 'Proxy from open positions' },
        { label: 'Gross Open Market Value', value: usableTickerRows.length > 0 ? formatCurrency(grossOpenMarketValue) : null, meta: 'Proxy from latest mark or entry prices' },
        { label: 'Largest Position', value: grossOpenMarketValue > 0 ? formatPercent(largestPositionValue / grossOpenMarketValue) : null, meta: 'Share of gross open market value' },
        { label: 'Top 3 Concentration', value: grossOpenMarketValue > 0 ? formatPercent(topThreeValue / grossOpenMarketValue) : null, meta: 'Largest three open positions' },
        { label: 'Unattributed Exposure', value: unattributedValue > 0 ? formatCurrency(unattributedValue) : null, meta: 'Withheld rather than guessed' },
      ], 'No open-position evidence is available to summarize exposure on this host.'),
      renderExplainabilityWhyNarrative({
        summary: 'This page reports exposure only from persisted paper positions and keeps the values clearly labeled as open-position proxies rather than broker cash, NAV, or account equity.',
        bullets: [
          'Concentration is derived from the current open-position set, not from historical closed trades.',
          unattributedValue > 0
            ? 'Some open market value remains unattributed because persisted evidence does not prove a unique strategy owner.'
            : 'All current open market value is attributable to a unique persisted strategy bucket.',
        ],
        emptyMessage: 'No exposure narrative is available because no open-position evidence was persisted.',
      }),
      renderExplainabilityEvidenceChecklist({
        items: [
          {
            label: 'Open position evidence',
            verdict: usableTickerRows.length > 0 ? 'pass' : 'missing',
            observedValue: usableTickerRows.length,
            expectedValue: '1 or more open positions',
            note: usableTickerRows.length > 0
              ? 'Exposure proxies are derived directly from persisted open ticker rows.'
              : 'No open position rows are available for exposure calculations.',
          },
          {
            label: 'Attribution certainty',
            verdict: unattributedValue > 0 ? 'warn' : 'pass',
            observedValue: unattributedValue > 0 ? formatCurrency(unattributedValue) : 'fully attributed',
            expectedValue: 'Unique strategy mapping when provable',
            note: unattributedValue > 0
              ? 'Ambiguous or unlinked positions are withheld from strategy buckets instead of guessed.'
              : 'Every open position currently maps to a unique persisted strategy bucket.',
          },
          {
            label: 'Exposure freshness',
            verdict: tickerSection.state === 'stale' ? 'warn' : tickerSection.state === 'ok' ? 'pass' : tickerSection.state === 'error' ? 'fail' : 'missing',
            observedValue: tickerSection.state,
            expectedValue: 'Live or bounded last-known ticker performance data',
            note: tickerSection.state === 'stale'
              ? 'Concentration metrics are derived from the last successful ticker snapshot.'
              : 'This summary follows the same truthful section-state semantics as the ticker evidence below.',
          },
        ],
        emptyMessage: 'No exposure evidence is available for this operator view.',
      }),
    ]),
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
    const attributedRows = exposure.filter(row => row.bucketType === 'strategy');
    const unattributedRows = exposure.filter(row => row.bucketType === 'unattributed');
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

    content = `${renderExplainabilityStack([
      renderExplainabilityWhat([
        { label: 'Exposure Buckets', value: exposure.length, meta: 'Attributed plus unattributed rows' },
        { label: 'Attributed Buckets', value: attributedRows.length, meta: 'Unique strategy mapping only' },
        { label: 'Unattributed Buckets', value: unattributedRows.length, meta: 'Explicitly withheld rows' },
        { label: 'Total Open Market Value', value: totalMarketValue > 0 ? formatCurrency(totalMarketValue) : null, meta: 'Across all exposure buckets' },
      ], 'No exposure buckets are available for breakdown.'),
      renderExplainabilityWhyNarrative({
        summary: 'Exposure is attributed only when the current open position maps to one persisted strategy without ambiguity.',
        bullets: [
          unattributedRows.length > 0
            ? 'Unattributed rows stay visible with their attribution note so operators can see what was withheld and why.'
            : 'No unattributed rows are currently present in the exposure breakdown.',
          'Share-of-book percentages are derived from the same bounded open-position evidence shown elsewhere on this route.',
        ],
        emptyMessage: 'No attribution narrative is available for the current exposure breakdown.',
      }),
      renderExplainabilityEvidenceChecklist({
        items: [
          {
            label: 'Unique strategy attribution',
            verdict: attributedRows.length > 0 ? 'pass' : 'missing',
            observedValue: attributedRows.length,
            expectedValue: '1 or more uniquely attributable buckets',
            note: attributedRows.length > 0
              ? 'Attributed rows appear only when persisted evidence identifies one strategy owner.'
              : 'No open position currently has a unique persisted strategy attribution.',
          },
          {
            label: 'Unattributed exposure',
            verdict: unattributedRows.length > 0 ? 'warn' : 'pass',
            observedValue: unattributedRows.length,
            expectedValue: '0 when every open position is provably attributable',
            note: unattributedRows.length > 0
              ? 'Unattributed buckets remain explicit so the operator can inspect withheld exposure instead of inferred ownership.'
              : 'There are no withheld exposure buckets in the current snapshot.',
          },
        ],
        emptyMessage: 'No attribution evidence is available for this operator view.',
      }),
    ])}<table>
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
