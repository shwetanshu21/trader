import type {
  OperatorDecisionPerformance,
  OperatorGovernanceDecisionDetail,
  OperatorPromotionHistory,
  OperatorStrategyDetail,
  OperatorStrategyWalkForwardDetail,
} from '../../types/runtime.js';
import {
  renderExplainabilityEvidenceChecklist,
  renderExplainabilityStack,
  renderExplainabilityWhat,
  renderExplainabilityWhyNarrative,
} from '../components/explainability.js';
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

export function renderStrategyDetailPage(detail: OperatorStrategyDetail, options: { shellStatus?: import('../components/status-strip.js').OperatorShellStatusViewModel | null } = {}): string {
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
  const publicationEmptyMessage = detail.hostEvidencePresence.researchPublications
    ? 'Research publication evidence exists on this host, but no published-research provenance is linked to this strategy version.'
    : 'No research publication evidence has been produced on this host yet.';

  const latestWalkForward = detail.walkForwardRuns[0] ?? null;
  const latestGovernance = detail.governanceHistory[0] ?? null;
  const publication = detail.publishedResearchProvenance;

  const body = [
    renderSection('Strategy Explainability', renderExplainabilityStack([
      renderExplainabilityWhat([
        { label: 'Strategy', value: `<code>${escapeHtml(detail.strategyId)}</code>` },
        { label: 'Version', value: `<code>${escapeHtml(detail.strategyVersion)}</code>` },
        { label: 'Realized P&L', value: escapeHtml(formatCurrency(detail.performance.realizedPnl, 'INR')), meta: 'Linked execution evidence only' },
        { label: 'Total P&L', value: `<span class="${detail.performance.realizedPnl + detail.performance.unrealizedPnl >= 0 ? 'status-ok' : 'status-err'}">${escapeHtml(formatCurrency(detail.performance.realizedPnl + detail.performance.unrealizedPnl, 'INR'))}</span>`, meta: 'Realized plus current open-position mark' },
        { label: 'Lifecycle Rows', value: detail.currentStates.length, meta: 'Current state per linked market' },
        { label: 'Governance Events', value: detail.governanceHistory.length, meta: 'Persisted transitions only' },
        { label: 'Walk-Forward Runs', value: detail.walkForwardRuns.length, meta: 'Linked selection evidence only' },
        { label: 'Publication', value: publication ? `<code>#${publication.publicationId}</code>` : null, meta: publication ? publication.publicationStatus : 'No publication linked' },
      ], 'No strategy detail evidence is available.'),
      renderExplainabilityWhyNarrative({
        summary: publication?.rationale
          ?? latestWalkForward?.rationale
          ?? latestGovernance?.rationale
          ?? null,
        bullets: [
          publication
            ? `Published research is linked through canonical hash ${publication.canonicalHash} and remains the strongest persisted lineage proof for this strategy version.`
            : publicationEmptyMessage,
          latestWalkForward?.result === 'no_winner'
            ? (latestWalkForward.rationale ?? 'No candidate cleared persisted walk-forward selection criteria.')
            : latestWalkForward
              ? 'Walk-forward evidence below stays scoped to persisted winner-selection rows and does not infer hidden ranking logic.'
              : walkForwardEmptyMessage,
          latestGovernance
            ? `Latest governance verdict moved ${latestGovernance.previousPhase} → ${latestGovernance.newPhase}.`
            : governanceEmptyMessage,
        ],
        emptyMessage: 'No persisted strategy rationale is available for this detail view.',
      }),
      renderExplainabilityEvidenceChecklist({
        items: [
          {
            label: 'Published research provenance',
            verdict: publication ? 'pass' : detail.hostEvidencePresence.researchPublications ? 'warn' : 'missing',
            observedValue: publication ? `Publication #${publication.publicationId}` : 'none',
            expectedValue: 'Linked publication when research was published',
            note: publication ? 'Publication, evaluation, and canonical-hash lineage are persisted for this strategy version.' : publicationEmptyMessage,
            sourceLabel: publication?.walkForwardRunId ? `Backtest WF#${publication.walkForwardRunId}` : null,
            sourceHref: publication?.walkForwardRunId ? backtestDetailHref(publication.walkForwardRunId) : null,
          },
          {
            label: 'Governance history',
            verdict: detail.governanceHistory.length > 0 ? 'pass' : detail.hostEvidencePresence.governanceHistory ? 'warn' : 'missing',
            observedValue: detail.governanceHistory.length,
            expectedValue: '1 or more recorded governance events',
            note: detail.governanceHistory.length > 0 ? 'Governance verdicts below are read from persisted transition rows.' : governanceEmptyMessage,
          },
          {
            label: 'Promotion evidence',
            verdict: detail.promotionHistory.length > 0 ? 'pass' : detail.hostEvidencePresence.promotionHistory ? 'warn' : 'missing',
            observedValue: detail.promotionHistory.length,
            expectedValue: 'Promotion rows when lifecycle advanced',
            note: detail.promotionHistory.length > 0 ? 'Promotion rows are rendered as a governance subset, not inferred from current state.' : promotionEmptyMessage,
          },
          {
            label: 'Walk-forward selection evidence',
            verdict: detail.walkForwardRuns.length > 0 ? 'pass' : detail.hostEvidencePresence.walkForwardRuns ? 'warn' : 'missing',
            observedValue: detail.walkForwardRuns.length,
            expectedValue: 'Linked persisted run evidence',
            note: detail.walkForwardRuns.some(run => run.result === 'no_winner')
              ? 'At least one linked run ended with no winner, so the page keeps the no-winner state explicit rather than promoting a candidate implicitly.'
              : detail.walkForwardRuns.length > 0
                ? 'Linked run rows provide the comparison surface for this strategy version.'
                : walkForwardEmptyMessage,
          },
          {
            label: 'Recent decision evidence',
            verdict: detail.recentDecisions.length > 0 ? 'pass' : 'missing',
            observedValue: detail.recentDecisions.length,
            expectedValue: 'Bounded recent decisions',
            note: detail.recentDecisions.length > 0
              ? 'Decision rows remain bounded for operator readability and link back to per-decision drill-down evidence.'
              : 'No decision evidence has been persisted for this strategy version yet.',
          },
        ],
        emptyMessage: 'No strategy evidence is available for this operator view.',
        boundedWindow: { count: detail.recentDecisions.length, noun: 'decision row' },
      }),
    ]), 'ok', null, null, 'Shared what/why/evidence hierarchy for one persisted strategy identity'),

    renderSection('Performance Summary', renderSummaryGrid([
      { label: 'Walk-Forward Return %', value: detail.performance.totalReturnPct === null ? '—' : `<span class="${detail.performance.totalReturnPct >= 0 ? 'status-ok' : 'status-err'}">${escapeHtml(formatRawPercent(detail.performance.totalReturnPct))}</span>`, meta: 'Selection-derived, not live account return' },
      { label: 'Sharpe', value: escapeHtml(detail.performance.sharpeRatio === null ? '—' : formatNumber(detail.performance.sharpeRatio, 2)) },
      { label: 'Max Drawdown', value: escapeHtml(detail.performance.maxDrawdownPct === null ? '—' : formatRawPercent(detail.performance.maxDrawdownPct)) },
      { label: 'Win Rate', value: escapeHtml(formatPercent(detail.performance.winRate)) },
      { label: 'Profit Factor', value: escapeHtml(detail.performance.profitFactor === null ? '—' : formatNumber(detail.performance.profitFactor, 2)) },
      { label: 'Trade Count', value: escapeHtml(formatInt(detail.performance.tradeCount)) },
      { label: 'Fees', value: escapeHtml(formatCurrency(detail.performance.totalFees, 'INR')) },
      { label: 'Unrealized P&L', value: escapeHtml(formatCurrency(detail.performance.unrealizedPnl, 'INR')) },
    ]), 'ok', null, null, 'Execution and walk-forward aggregates stay separate but visible'),

    renderSection(
      'Published Research Provenance',
      renderPublishedResearchProvenance(detail, publicationEmptyMessage),
      publication ? 'ok' : 'stale',
      null,
      null,
      'Research lineage, publication rationale, and disclosure JSON',
    ),

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
      'Host-wide absence and strategy-local absence remain distinct',
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
      'Verdicts, rationale, and raw evidence disclosure stay explicit',
    ),

    renderSection(
      'Promotion History',
      renderPromotionTable(detail.promotionHistory, promotionEmptyMessage),
      'ok',
      null,
      null,
      'Promotion-only subset for lifecycle advancement review',
    ),

    renderSection(
      'Walk-Forward Evidence',
      renderWalkForwardTable(detail.walkForwardRuns, walkForwardEmptyMessage),
      'ok',
      null,
      null,
      'Winner and no-winner outcomes stay truthful',
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
    subtitle: 'Lifecycle, governance, publication, decision, and backtest evidence for one persisted strategy identity.',
    meta: `${detail.currentStates.length} lifecycle row(s) · ${detail.walkForwardRuns.length} linked walk-forward run(s)`,
    actions,
    body,
    navActive: 'strategies',
    shellStatus: options.shellStatus ?? null,
  });
}

function renderDecisionTable(rows: OperatorDecisionPerformance[]): string {
  if (rows.length === 0) {
    return renderEmptyState('No decision evidence has been persisted for this strategy version yet.');
  }

  return `<table>
    <thead><tr><th>Decision</th><th>Instrument</th><th>Side</th><th class="num">Qty</th><th>Status</th><th>Execution</th><th>Hybrid</th><th>Outcome</th><th class="num">Fees</th><th class="num">Realized P&amp;L</th><th>Decided At</th></tr></thead>
    <tbody>${rows.map(row => `<tr>
      <td>${renderLink(decisionDetailHref(row.decisionId), `#${row.decisionId}`)}</td>
      <td><code>${escapeHtml(row.exchange)}:${escapeHtml(row.tradingsymbol)}</code></td>
      <td>${escapeHtml(row.side)}</td>
      <td class="num">${escapeHtml(formatInt(row.quantity))}</td>
      <td><span class="${statusClass(row.decisionStatus)}">${escapeHtml(row.decisionStatus)}</span></td>
      <td>${row.executionStatus ? `<span class="${statusClass(row.executionStatus)}">${escapeHtml(row.executionStatus)}</span>` : '<span class="status-skip">unconsumed</span>'}</td>
      <td>${row.llmStatus ? `<span class="${statusClass(row.llmStatus)}">${escapeHtml(row.llmStatus)}</span>` : '<span class="status-skip">no hybrid evidence</span>'}</td>
      <td>${escapeHtml(row.outcomeCode ?? '—')}</td>
      <td class="num">${row.fees === null ? '—' : escapeHtml(formatCurrency(row.fees, 'INR'))}</td>
      <td class="num">${row.realizedPnl === null ? '—' : `<span class="${row.realizedPnl >= 0 ? 'status-ok' : 'status-err'}">${escapeHtml(formatCurrency(row.realizedPnl, 'INR'))}</span>`}</td>
      <td>${escapeHtml(formatTimestamp(row.decidedAt))}</td>
    </tr>
    ${row.llmRationale ? `<tr><td colspan="11"><details><summary>Hybrid rationale</summary><p>${escapeHtml(row.llmRationale)}</p></details></td></tr>` : ''}`).join('')}</tbody>
  </table>`;
}

function renderPublishedResearchProvenance(detail: OperatorStrategyDetail, emptyMessage: string): string {
  const provenance = detail.publishedResearchProvenance;
  if (!provenance) {
    return renderEmptyState(emptyMessage);
  }

  return `${renderSummaryGrid([
    { label: 'Publication', value: `<code>#${provenance.publicationId}</code>` },
    { label: 'Status', value: `<span class="${statusClass(provenance.publicationStatus)}">${escapeHtml(provenance.publicationStatus)}</span>` },
    { label: 'Canonical Hash', value: `<code>${escapeHtml(provenance.canonicalHash)}</code>` },
    { label: 'Hypothesis', value: `<code>HG#${provenance.hypothesisGraphId}</code>` },
    { label: 'Evaluation', value: `<code>HE#${provenance.hypothesisEvaluationId}</code> · <span class="${statusClass(provenance.evaluationStatus)}">${escapeHtml(provenance.evaluationStatus)}</span>` },
    { label: 'Walk-Forward Run', value: provenance.walkForwardRunId === null ? '—' : renderLink(backtestDetailHref(provenance.walkForwardRunId), `WF#${provenance.walkForwardRunId}`) },
    { label: 'Winner', value: provenance.winnerId === null ? '<span class="status-warn">No winner referenced</span>' : `<code>WF#${provenance.winnerId}</code>` },
    { label: 'Market', value: `<code>${escapeHtml(provenance.marketId)}</code>` },
    { label: 'Lifecycle Phase', value: provenance.lifecyclePhase === null ? '—' : `<span class="${statusClass(provenance.lifecyclePhase)}">${escapeHtml(provenance.lifecyclePhase)}</span>` },
    { label: 'Governance Verdict', value: provenance.governanceVerdict === null ? '<span class="status-warn">No governance evidence linked</span>' : `<span class="${statusClass(provenance.governanceVerdict)}">${escapeHtml(provenance.governanceVerdict)}</span>` },
    { label: 'Published At', value: escapeHtml(formatTimestamp(provenance.publishedAt)) },
    { label: 'Linked Strategy', value: renderLink(strategyDetailHref(detail.strategyId, detail.strategyVersion), `${escapeHtml(detail.strategyId)}@${escapeHtml(detail.strategyVersion)}`) },
  ])}
  <div style="margin-top:0.9rem;">
    <h3>Publication Rationale</h3>
    <p>${escapeHtml(provenance.rationale || 'No publication rationale was persisted.')}</p>
  </div>
  <div style="margin-top:0.9rem;">
    <h3>Publication Evidence</h3>
    ${provenance.evidence ? `<pre>${formatJson(provenance.evidence)}</pre>` : renderEmptyState('No publication evidence JSON was persisted for this strategy publication.')}
  </div>
  <div style="margin-top:0.9rem;">
    <h3>Provenance</h3>
    ${renderKeyValueGrid([
      { key: 'Source', value: renderProvenanceBadge(provenance.provenance) || '—' },
      { key: 'Source Label', value: escapeHtml(provenance.provenance.sourceLabel ?? '—') },
      { key: 'Created At', value: escapeHtml(formatTimestamp(provenance.createdAt)) },
    ])}
  </div>`;
}

function renderGovernanceTable(rows: OperatorGovernanceDecisionDetail[], emptyMessage: string): string {
  if (rows.length === 0) {
    return renderEmptyState(emptyMessage);
  }

  return `<table>
    <thead><tr><th>ID</th><th>Market</th><th>Verdict</th><th>From</th><th>To</th><th>Winner</th><th>Recorded</th></tr></thead>
    <tbody>${rows.map(row => `<tr>
      <td><code>#${row.id}</code></td>
      <td><code>${escapeHtml(row.marketId)}</code></td>
      <td><span class="${statusClass(row.verdict)}">${escapeHtml(row.verdict)}</span></td>
      <td><code>${escapeHtml(row.previousPhase)}</code></td>
      <td><code>${escapeHtml(row.newPhase)}</code></td>
      <td>${row.winnerId === null ? '<span class="status-skip">No winner referenced</span>' : `<code>WF#${row.winnerId}</code>`}</td>
      <td>${escapeHtml(formatTimestamp(row.recordedAt))}</td>
    </tr>
    <tr><td colspan="7"><strong>Rationale:</strong> ${escapeHtml(row.rationale)}</td></tr>
    ${row.evidence ? `<tr><td colspan="7"><details><summary>Evidence JSON</summary><pre>${formatJson(row.evidence)}</pre></details></td></tr>` : ''}`).join('')}</tbody>
  </table>`;
}

function renderPromotionTable(rows: OperatorPromotionHistory[], emptyMessage: string): string {
  if (rows.length === 0) {
    return renderEmptyState(emptyMessage);
  }

  return `<table>
    <thead><tr><th>Market</th><th>From</th><th>To</th><th>Winner Context</th><th>Promoted At</th></tr></thead>
    <tbody>${rows.map(row => `<tr>
      <td><code>${escapeHtml(row.marketId)}</code></td>
      <td><code>${escapeHtml(row.previousPhase)}</code></td>
      <td><span class="${statusClass(row.newPhase)}">${escapeHtml(row.newPhase)}</span></td>
      <td>${row.winnerId === null ? '<span class="status-warn">No winner recorded</span>' : `<code>WF#${row.winnerId}</code> · ${renderLink(strategyDetailHref(row.strategyId, row.strategyVersion), 'strategy detail')}`}</td>
      <td>${escapeHtml(formatTimestamp(row.promotedAt))}</td>
    </tr>
    <tr><td colspan="5"><strong>Rationale:</strong> ${escapeHtml(row.rationale)}</td></tr>`).join('')}</tbody>
  </table>`;
}

function renderWalkForwardTable(rows: OperatorStrategyWalkForwardDetail[], emptyMessage: string): string {
  if (rows.length === 0) {
    return renderEmptyState(emptyMessage);
  }

  return `<table>
    <thead><tr><th>Run</th><th>Market</th><th>Status</th><th>Result</th><th class="num">Windows</th><th class="num">Trials</th><th class="num">Score</th><th class="num">Sharpe</th><th class="num">Return</th><th>Selected At</th></tr></thead>
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
      <td>${escapeHtml(formatTimestamp(row.selectedAt))}</td>
    </tr>
    <tr><td colspan="10"><strong>Selection:</strong> ${escapeHtml(row.selectionStrategy ?? 'No persisted selection strategy.')} · <strong>Rationale:</strong> ${escapeHtml(row.rationale ?? (row.winnerId === null ? 'No winner selected for this run.' : '—'))}</td></tr>`).join('')}</tbody>
  </table>`;
}
