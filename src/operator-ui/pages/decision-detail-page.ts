import type { OperatorDecisionDetail } from '../../types/runtime.js';
import {
  decisionDetailHref,
  escapeHtml,
  formatCurrency,
  formatInt,
  formatNumber,
  formatPercent,
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

export function renderDecisionDetailPage(detail: OperatorDecisionDetail): string {
  const strategyHref = strategyDetailHref(detail.strategyId, detail.strategyVersion);
  const actions = [
    renderLink('/', '← Back to dashboard'),
    renderLink(strategyHref, `Strategy ${detail.strategyId}@${detail.strategyVersion}`),
    renderLink(decisionDetailHref(detail.decisionId), `Permalink #${detail.decisionId}`),
  ].join('');

  const body = [
    renderSection('Decision Summary', renderSummaryGrid([
      { label: 'Decision', value: `<code>#${detail.decisionId}</code>`, meta: `Proposal #${detail.proposalAttemptId}` },
      { label: 'Status', value: `<span class="${statusClass(detail.decisionStatus)}">${escapeHtml(detail.decisionStatus)}</span>`, meta: escapeHtml(formatTimestamp(detail.decidedAt)) },
      { label: 'Strategy', value: renderLink(strategyHref, `${detail.strategyId}@${detail.strategyVersion}`) },
      { label: 'Instrument', value: `<code>${escapeHtml(detail.trade.exchange)}:${escapeHtml(detail.trade.tradingsymbol)}</code>`, meta: `${escapeHtml(detail.trade.side.toUpperCase())} · ${escapeHtml(detail.trade.product)}` },
      { label: 'Quantity', value: escapeHtml(formatInt(detail.trade.quantity)) },
      { label: 'Execution', value: detail.executionAttempt ? `<span class="${statusClass(detail.executionAttempt.status)}">${escapeHtml(detail.executionAttempt.status)}</span>` : '<span class="status-skip">unconsumed</span>', meta: escapeHtml(detail.executionAttempt?.outcomeCode ?? 'No execution attempt recorded') },
    ])),

    renderSection(
      'Rationale',
      detail.reasons.length > 0
        ? `<ol>${detail.reasons.map(reason => `<li><strong>${escapeHtml(reason.reasonCode)}</strong>: ${escapeHtml(reason.reasonMessage)}</li>`).join('')}</ol>`
        : renderEmptyState('No decision reasons were persisted for this decision.'),
      'ok',
      null,
      null,
      'Rationale-first evidence',
    ),

    renderSection('Trade & Risk', renderKeyValueGrid([
      { key: 'Exchange', value: `<code>${escapeHtml(detail.trade.exchange)}</code>` },
      { key: 'Trading Symbol', value: `<code>${escapeHtml(detail.trade.tradingsymbol)}</code>` },
      { key: 'Side', value: `<span class="${statusClass(detail.trade.side)}">${escapeHtml(detail.trade.side)}</span>` },
      { key: 'Order Type', value: escapeHtml(detail.trade.orderType) },
      { key: 'Decision Price', value: escapeHtml(detail.trade.price === null ? 'Market' : formatCurrency(detail.trade.price, null)) },
      { key: 'Trigger Price', value: escapeHtml(detail.trade.triggerPrice === null ? '—' : formatCurrency(detail.trade.triggerPrice, null)) },
      { key: 'Quote Last Price', value: escapeHtml(detail.quote.lastPrice === null ? '—' : formatCurrency(detail.quote.lastPrice, null)) },
      { key: 'Quote Spread', value: escapeHtml(detail.quote.bid !== null && detail.quote.ask !== null ? `${formatCurrency(detail.quote.bid, null)} / ${formatCurrency(detail.quote.ask, null)}` : '—') },
      { key: 'Quote Volume', value: escapeHtml(detail.quote.volume === null ? '—' : formatInt(detail.quote.volume)) },
      { key: 'Quote Received', value: escapeHtml(formatTimestamp(detail.quote.receivedAt)) },
      { key: 'Risk Notional', value: escapeHtml(detail.risk.notional === null ? '—' : formatCurrency(detail.risk.notional, 'INR')) },
      { key: 'Risk Budget', value: escapeHtml(detail.risk.riskBudgetRupees === null ? '—' : formatCurrency(detail.risk.riskBudgetRupees, 'INR')) },
      { key: 'Sizing Basis', value: escapeHtml(detail.risk.sizingBasis) },
      { key: 'Max Loss', value: escapeHtml(detail.risk.maxLossRupees === null ? '—' : formatCurrency(detail.risk.maxLossRupees, 'INR')) },
      { key: 'Stop Price', value: escapeHtml(detail.risk.stopPrice === null ? '—' : formatCurrency(detail.risk.stopPrice, null)) },
      { key: 'Stop Distance', value: escapeHtml(detail.risk.stopDistance === null ? '—' : formatNumber(detail.risk.stopDistance, 2)) },
      { key: 'Trailing Stop Distance', value: escapeHtml(detail.risk.trailingStopDistance === null ? '—' : formatNumber(detail.risk.trailingStopDistance, 2)) },
      { key: 'Exposure Tag', value: escapeHtml(detail.risk.exposureTag ?? '—') },
      { key: 'Execution Class', value: escapeHtml(detail.instrument.executionClass) },
      { key: 'Segment / Instrument', value: escapeHtml(`${detail.instrument.segment} · ${detail.instrument.instrumentType}`) },
      { key: 'Expiry / Strike', value: escapeHtml(detail.instrument.expiry || detail.instrument.strike !== null ? `${detail.instrument.expiry ?? '—'} / ${detail.instrument.strike ?? '—'}` : '—') },
      { key: 'Lot / Tick / Freeze', value: escapeHtml(`${formatInt(detail.instrument.lotSize)} / ${formatNumber(detail.instrument.tickSize, 2)} / ${detail.instrument.freezeQuantity === null ? '—' : formatInt(detail.instrument.freezeQuantity)}`) },
    ])),

    renderSection(
      'Research Evidence',
      detail.indiaResearchEvidence
        ? renderKeyValueGrid([
            { key: 'Summary', value: escapeHtml(detail.indiaResearchEvidence.summary) },
            { key: 'Influence Context', value: escapeHtml(detail.indiaResearchEvidence.influenceContext ?? '—') },
            { key: 'Freshness', value: escapeHtml(detail.indiaResearchEvidence.freshnessMs === null || detail.indiaResearchEvidence.freshnessMs === undefined ? '—' : `${formatInt(detail.indiaResearchEvidence.freshnessMs)} ms`) },
            { key: 'Tags', value: escapeHtml(detail.indiaResearchEvidence.tags?.join(', ') || '—') },
          ])
        : renderEmptyState('No India research evidence was persisted for this decision.'),
      'ok',
      null,
      null,
      'Persisted rationale only',
    ),

    renderSection(
      'Hybrid Scoring',
      detail.hybrid
        ? `${renderSummaryGrid([
            { label: 'Merged Score', value: escapeHtml(formatPercent(detail.hybrid.mergedScore)) },
            { label: 'Deterministic', value: escapeHtml(formatPercent(detail.hybrid.deterministicScore)) },
            { label: 'LLM Score', value: escapeHtml(detail.hybrid.llmScore === null ? '—' : formatPercent(detail.hybrid.llmScore)) },
            { label: 'LLM Status', value: `<span class="${statusClass(detail.hybrid.llmStatus)}">${escapeHtml(detail.hybrid.llmStatus)}</span>` },
            { label: 'Merge Policy', value: escapeHtml(detail.hybrid.mergePolicy) },
            { label: 'Recorded', value: escapeHtml(formatTimestamp(detail.hybrid.createdAt)) },
          ])}
          ${detail.hybrid.llmRationale ? `<div style="margin-top:0.9rem;"><h3>LLM Rationale</h3><p>${escapeHtml(detail.hybrid.llmRationale)}</p></div>` : ''}
          <div style="margin-top:0.9rem;">
            <h3>Components</h3>
            <table>
              <thead><tr><th>Name</th><th class="num">Score</th><th class="num">Weight</th><th class="num">Order</th></tr></thead>
              <tbody>${detail.hybrid.components.map(component => `<tr>
                <td><code>${escapeHtml(component.componentName)}</code></td>
                <td class="num">${escapeHtml(formatPercent(component.score))}</td>
                <td class="num">${escapeHtml(formatPercent(component.weight))}</td>
                <td class="num">${escapeHtml(formatInt(component.sortOrder))}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>`
        : renderEmptyState('No hybrid scoring evidence was persisted for this decision.'),
    ),

    renderSection(
      'Execution Outcome',
      detail.executionAttempt
        ? `${renderSummaryGrid([
            { label: 'Execution Mode', value: escapeHtml(detail.executionAttempt.executionMode) },
            { label: 'Status', value: `<span class="${statusClass(detail.executionAttempt.status)}">${escapeHtml(detail.executionAttempt.status)}</span>` },
            { label: 'Outcome', value: escapeHtml(detail.executionAttempt.outcomeCode ?? '—') },
            { label: 'Broker Order', value: escapeHtml(detail.executionAttempt.brokerOrderId ?? '—') },
            { label: 'Attempted At', value: escapeHtml(formatTimestamp(detail.executionAttempt.attemptedAt)) },
            { label: 'Completed At', value: escapeHtml(formatTimestamp(detail.executionAttempt.completedAt)) },
          ])}
          <div style="margin-top:0.9rem;">
            <h3>Execution Message</h3>
            <p>${escapeHtml(detail.executionAttempt.message)}</p>
          </div>
          <div style="margin-top:0.9rem;">
            <h3>Refusal Reasons</h3>
            ${detail.executionAttempt.refusalReasons.length > 0
              ? `<ul>${detail.executionAttempt.refusalReasons.map(reason => `<li><strong>${escapeHtml(reason.reasonCode)}</strong>: ${escapeHtml(reason.reasonMessage)}</li>`).join('')}</ul>`
              : renderEmptyState('No refusal reasons were recorded for this execution attempt.')}
          </div>`
        : renderEmptyState('No execution attempt has been recorded for this decision yet.'),
    ),

    renderSection(
      'Realized P&L Linkage',
      detail.realizedPnl
        ? `${renderSummaryGrid([
            { label: 'Realized P&L', value: escapeHtml(formatCurrency(detail.realizedPnl.realizedPnl, 'INR')) },
            { label: 'Linked Events', value: escapeHtml(formatInt(detail.realizedPnl.eventCount)) },
            { label: 'Latest Event', value: escapeHtml(formatTimestamp(detail.realizedPnl.latestEventAt)) },
          ])}
          <div style="margin-top:0.9rem;">
            <h3>Current Position Snapshot</h3>
            ${detail.realizedPnl.currentPosition
              ? renderKeyValueGrid([
                  { key: 'Exchange', value: `<code>${escapeHtml(detail.realizedPnl.currentPosition.exchange)}</code>` },
                  { key: 'Trading Symbol', value: `<code>${escapeHtml(detail.realizedPnl.currentPosition.tradingsymbol)}</code>` },
                  { key: 'Product / Side', value: escapeHtml(`${detail.realizedPnl.currentPosition.product} · ${detail.realizedPnl.currentPosition.side}`) },
                  { key: 'Quantity', value: escapeHtml(formatInt(detail.realizedPnl.currentPosition.quantity)) },
                  { key: 'Average Cost', value: escapeHtml(formatCurrency(detail.realizedPnl.currentPosition.avgCostPrice, null)) },
                  { key: 'Realized P&L', value: escapeHtml(formatCurrency(detail.realizedPnl.currentPosition.realizedPnl, 'INR')) },
                  { key: 'Mark Price', value: escapeHtml(detail.realizedPnl.currentPosition.markPrice === null ? '—' : formatCurrency(detail.realizedPnl.currentPosition.markPrice, null)) },
                  { key: 'Updated At', value: escapeHtml(formatTimestamp(detail.realizedPnl.currentPosition.updatedAt)) },
                ])
              : renderEmptyState('No current paper position snapshot is linked to this decision.')}
          </div>`
        : renderEmptyState('No realized P&L evidence is available because this decision has not produced linked execution evidence yet.'),
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
    title: `Decision #${detail.decisionId}`,
    kicker: 'Operator Decision Detail',
    subtitle: 'Persisted rationale first, then deeper execution, risk, and scoring evidence.',
    meta: `Strategy ${renderLink(strategyHref, `${detail.strategyId}@${detail.strategyVersion}`)} · Decided ${escapeHtml(formatTimestamp(detail.decidedAt))}`,
    actions,
    body,
  });
}
