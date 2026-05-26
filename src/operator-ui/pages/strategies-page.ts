import type { DashboardPayload } from '../dashboard-data.js';
import type { OperatorStrategyExposure } from '../../types/runtime.js';
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
  renderEmptyState,
  renderPageLayout,
  renderProvenanceBadge,
  renderSection,
} from '../render-utils.js';

function findSummaryValue(payload: DashboardPayload, key: string): string {
  const card = payload.summaryCards.data.find(row => row.key === key);
  if (!card) {
    return '—';
  }
  if (card.display !== null) {
    return card.display;
  }
  if (card.unit === 'INR') {
    return formatCurrency(card.value);
  }
  return formatInt(card.value);
}

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

    content = `${renderExplainabilityStack([
      renderExplainabilityWhat([
        { label: 'Strategy Buckets', value: strategyRows.length, meta: 'Uniquely attributable exposure rows' },
        { label: 'Open Positions', value: strategyRows.reduce((sum, row) => sum + row.openPositionCount, 0), meta: 'Across attributed strategy buckets' },
        { label: 'Attributed Market Value', value: strategyRows.length > 0 ? formatCurrency(strategyRows.reduce((sum, row) => sum + row.grossOpenMarketValue, 0)) : null, meta: 'Unique strategy mapping only' },
        { label: 'Unattributed Market Value', value: unattributedValue > 0 ? formatCurrency(unattributedValue) : null, meta: 'Withheld rather than guessed' },
      ], 'No strategy-linked open exposure is available yet.'),
      renderExplainabilityWhyNarrative({
        summary: 'This section attributes open exposure only when the persisted paper position maps to one strategy version without ambiguity.',
        bullets: [
          unattributedRows.length > 0
            ? 'Open market value that cannot be uniquely tied to one strategy stays explicit as unattributed exposure.'
            : 'Every open position currently maps to a single persisted strategy bucket.',
          'Whole-book capital cards stay visible separately so attributed exposure does not overstate certainty when some rows are withheld.',
        ],
        emptyMessage: 'No strategy exposure narrative is available.',
      }),
      renderExplainabilityEvidenceChecklist({
        items: [
          {
            label: 'Attributed strategy rows',
            verdict: strategyRows.length > 0 ? 'pass' : 'missing',
            observedValue: strategyRows.length,
            expectedValue: '1 or more attributable strategy buckets',
            note: strategyRows.length > 0
              ? 'Attributed rows are backed by persisted open-position linkage.'
              : 'No open exposure currently has a unique persisted strategy owner.',
          },
          {
            label: 'Unattributed exposure',
            verdict: unattributedRows.length > 0 ? 'warn' : 'pass',
            observedValue: unattributedRows.length,
            expectedValue: '0 when attribution is complete',
            note: unattributedRows.length > 0
              ? `${unattributedRows.map(row => row.attributionNote).filter((row): row is string => Boolean(row)).join(' ')} Current unattributed gross market value: ${formatCurrency(unattributedValue)}.`
              : 'No unattributed open exposure is currently present.',
          },
        ],
        emptyMessage: 'No strategy exposure evidence is available for this operator view.',
      }),
    ])}<table>
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

  const content = renderExplainabilityStack([
    renderExplainabilityWhat([
      { label: 'Active Strategy Rows', value: strategyRows.length, meta: 'Persisted strategy performance rows' },
      { label: 'Realized P&L', value: strategyRows.length > 0 ? formatCurrency(realizedPnl) : null, meta: 'From linked realized position events' },
      { label: 'Unrealized P&L', value: strategyRows.length > 0 ? formatCurrency(unrealizedPnl) : null, meta: 'From current open positions' },
      { label: 'Invested Capital', value: findSummaryValue(payload, 'invested_capital'), meta: 'Whole-book open cost basis' },
      { label: 'Current Value', value: findSummaryValue(payload, 'current_value'), meta: 'Whole-book open mark value' },
      { label: 'Net P&L', value: findSummaryValue(payload, 'net_pnl'), meta: 'Whole-book realized plus unrealized P&L' },
      { label: 'Attributed Open Market Value', value: attributedMarketValue > 0 ? formatCurrency(attributedMarketValue) : null, meta: 'Unique strategy attribution only' },
      { label: 'Unattributed Open Market Value', value: unattributedMarketValue > 0 ? formatCurrency(unattributedMarketValue) : null, meta: 'Ambiguous or unlinked positions' },
    ], 'No persisted strategy summary evidence is available.'),
    renderExplainabilityWhyNarrative({
      summary: 'This page separates whole-book paper-ledger capital from strategy-level attribution so operators can inspect strategy results without overstating certainty about open-position ownership.',
      bullets: [
        'Whole-book invested capital, current value, and net P&L come from the same persisted summary-card surface used on the overview route.',
        unattributedMarketValue > 0
          ? 'Some open market value remains intentionally outside strategy buckets because the persisted evidence does not prove a unique owner.'
          : 'All current open market value is attributable to a unique strategy bucket in this snapshot.',
      ],
      emptyMessage: 'No strategy narrative summary is available.',
    }),
    renderExplainabilityEvidenceChecklist({
      items: [
        {
          label: 'Strategy performance rows',
          verdict: strategyRows.length > 0 ? 'pass' : 'missing',
          observedValue: strategyRows.length,
          expectedValue: '1 or more persisted strategy rows',
          note: strategyRows.length > 0
            ? 'Per-strategy realized and unrealized results are read from persisted operator performance rows.'
            : 'No strategy performance rows are available for this host snapshot.',
        },
        {
          label: 'Whole-book capital cards',
          verdict: payload.summaryCards.data.length > 0 ? 'pass' : 'missing',
          observedValue: payload.summaryCards.data.length,
          expectedValue: 'Persisted summary-card evidence',
          note: payload.summaryCards.data.length > 0
            ? 'Invested capital, current value, and net P&L stay anchored to the overview summary-card surface.'
            : 'No persisted summary cards are available to explain whole-book capital context.',
        },
        {
          label: 'Open exposure attribution',
          verdict: unattributedMarketValue > 0 ? 'warn' : attributedMarketValue > 0 ? 'pass' : 'missing',
          observedValue: unattributedMarketValue > 0 ? formatCurrency(unattributedMarketValue) : attributedMarketValue > 0 ? formatCurrency(attributedMarketValue) : 'none',
          expectedValue: 'Attributed when uniquely provable',
          note: unattributedMarketValue > 0
            ? 'Ambiguous or unlinked positions remain outside strategy buckets instead of being inferred.'
            : attributedMarketValue > 0
              ? 'Current open exposure is attributable to persisted strategy buckets.'
              : 'No open exposure attribution evidence is currently available.',
        },
      ],
      emptyMessage: 'No strategy evidence is available for this operator view.',
    }),
  ]);

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

export function renderStrategiesPage(payload: DashboardPayload, exposure: OperatorStrategyExposure[], options: { shellStatus?: import('../components/status-strip.js').OperatorShellStatusViewModel | null } = {}): string {
  const sectionHtml = renderDashboardSectionHtml(payload);

  return renderPageLayout({
    title: 'Strategies',
    kicker: 'Operator Console',
    subtitle: 'Per-strategy realized and unrealized paper evidence, plus conservative open-exposure attribution.',
    meta: `Assembled ${escapeHtml(payload.assembledAt)}`,
    actions: '<a href="/">Back to overview</a><a href="/positions">Positions & exposure</a><a href="/governance">Governance</a>',
    navActive: 'strategies',
    shellStatus: options.shellStatus ?? null,
    body: [
      renderStrategySummarySection(payload, exposure),
      renderStrategyExposureSection(payload, exposure),
      sectionHtml.strategyPerformance,
    ].join('\n'),
  });
}
