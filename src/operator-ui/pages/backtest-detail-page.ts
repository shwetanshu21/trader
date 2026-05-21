import type { OperatorBacktestDetail } from '../../types/runtime.js';
import {
  escapeHtml,
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

export function renderBacktestDetailPage(detail: OperatorBacktestDetail): string {
  const strategyHref = strategyDetailHref(detail.strategyId, detail.strategyVersion);
  const actions = [
    renderLink('/', '← Back to dashboard'),
    renderLink(strategyHref, `Strategy ${detail.strategyId}@${detail.strategyVersion}`),
  ].join('');

  const noWinner = detail.selectedTrial === null || detail.result === 'no_winner';

  const body = [
    renderSection('Backtest Summary', renderSummaryGrid([
      { label: 'Run', value: `<code>${escapeHtml(detail.label)}</code>`, meta: `#${detail.runId}` },
      { label: 'Strategy', value: renderLink(strategyHref, `${detail.strategyId}@${detail.strategyVersion}`) },
      { label: 'Market', value: `<code>${escapeHtml(detail.marketId)}</code>` },
      { label: 'Status', value: `<span class="${statusClass(detail.status)}">${escapeHtml(detail.status)}</span>` },
      { label: 'Result', value: `<span class="${statusClass(detail.result)}">${escapeHtml(detail.result)}</span>` },
      { label: 'Selection Strategy', value: escapeHtml(detail.selectionStrategy) },
      { label: 'Window Count', value: escapeHtml(formatInt(detail.windowCount)) },
      { label: 'Total Trials', value: escapeHtml(formatInt(detail.totalTrials)) },
      { label: 'Winner Row', value: `<code>WF#${detail.winnerId}</code>` },
      { label: 'Selected Trial', value: detail.selectedTrialId === null ? '<span class="status-warn">No winner selected</span>' : `<code>Trial #${detail.selectedTrialId}</code>` },
    ])),

    renderSection(
      'Selection Rationale',
      `${detail.rationale ? `<p>${escapeHtml(detail.rationale)}</p>` : renderEmptyState('No persisted rationale was recorded for this walk-forward selection.')}
       ${noWinner ? '<div style="margin-top:0.9rem;" class="status-warn">No winner selected for this run.</div>' : ''}`,
      'ok',
      null,
      null,
      'Human-readable persisted outcome',
    ),

    renderSection('Run Lifecycle', renderKeyValueGrid([
      { key: 'Created At', value: escapeHtml(formatTimestamp(detail.createdAt)) },
      { key: 'Started At', value: escapeHtml(formatTimestamp(detail.startedAt)) },
      { key: 'Completed At', value: escapeHtml(formatTimestamp(detail.completedAt)) },
      { key: 'Selected At', value: escapeHtml(formatTimestamp(detail.selectedAt)) },
    ])),

    renderSection(
      'Selected Trial',
      detail.selectedTrial
        ? `${renderSummaryGrid([
            { label: 'Label', value: `<code>${escapeHtml(detail.selectedTrial.label)}</code>` },
            { label: 'Trial Index', value: escapeHtml(formatInt(detail.selectedTrial.trialIndex)) },
            { label: 'Rank', value: escapeHtml(formatInt(detail.selectedTrial.rank)) },
            { label: 'Merged Score', value: escapeHtml(formatPercent(detail.selectedTrial.mergedScore)) },
            { label: 'Deterministic', value: escapeHtml(formatPercent(detail.selectedTrial.deterministicScore)) },
            { label: 'LLM Score', value: escapeHtml(detail.selectedTrial.llmScore === null ? '—' : formatPercent(detail.selectedTrial.llmScore)) },
            { label: 'LLM Status', value: detail.selectedTrial.llmStatus ? `<span class="${statusClass(detail.selectedTrial.llmStatus)}">${escapeHtml(detail.selectedTrial.llmStatus)}</span>` : '<span class="status-skip">—</span>' },
          ])}
          <div style="margin-top:0.9rem;">
            <h3>Params</h3>
            ${detail.selectedTrial.params ? `<pre>${formatJson(detail.selectedTrial.params)}</pre>` : renderEmptyState('No selected-trial params were persisted.')}
          </div>`
        : renderEmptyState('No selected trial evidence was persisted because this run has no winner context.'),
    ),

    renderSection(
      'Per-Window Evidence',
      detail.selectedTrial && detail.selectedTrial.windowEvidence.length > 0
        ? `<table>
            <thead><tr><th>Window</th><th>Type</th><th class="num">Return</th><th class="num">Sharpe</th><th class="num">Max DD</th><th class="num">Win Rate</th><th class="num">Trades</th><th class="num">Profit Factor</th></tr></thead>
            <tbody>${detail.selectedTrial.windowEvidence.map(window => `<tr>
              <td><code>#${window.windowId}</code></td>
              <td><span class="${statusClass(window.windowType)}">${escapeHtml(window.windowType)}</span></td>
              <td class="num">${escapeHtml(formatRawPercent(window.totalReturnPct))}</td>
              <td class="num">${escapeHtml(window.sharpeRatio === null ? '—' : formatNumber(window.sharpeRatio, 2))}</td>
              <td class="num">${escapeHtml(window.maxDrawdownPct === null ? '—' : formatRawPercent(window.maxDrawdownPct))}</td>
              <td class="num">${escapeHtml(formatPercent(window.winRate))}</td>
              <td class="num">${escapeHtml(formatInt(window.tradeCount))}</td>
              <td class="num">${escapeHtml(window.profitFactor === null ? '—' : formatNumber(window.profitFactor, 2))}</td>
            </tr>
            ${window.metrics ? `<tr><td colspan="8"><details><summary>Metrics JSON</summary><pre>${formatJson(window.metrics)}</pre></details></td></tr>` : ''}`).join('')}</tbody>
          </table>`
        : renderEmptyState('No per-window evidence was persisted for the selected trial.'),
    ),

    renderSection(
      'Ranked Candidates',
      detail.rankedCandidates.length > 0
        ? `<table>
            <thead><tr><th>Rank</th><th>Trial</th><th class="num">Merged</th><th class="num">Deterministic</th><th class="num">LLM</th><th>LLM Status</th><th class="num">Windows</th></tr></thead>
            <tbody>${detail.rankedCandidates.map(candidate => `<tr>
              <td class="num">${escapeHtml(formatInt(candidate.rank))}</td>
              <td><code>${escapeHtml(candidate.label)}</code></td>
              <td class="num">${escapeHtml(formatPercent(candidate.mergedScore))}</td>
              <td class="num">${escapeHtml(formatPercent(candidate.deterministicScore))}</td>
              <td class="num">${escapeHtml(candidate.llmScore === null ? '—' : formatPercent(candidate.llmScore))}</td>
              <td>${candidate.llmStatus ? `<span class="${statusClass(candidate.llmStatus)}">${escapeHtml(candidate.llmStatus)}</span>` : '<span class="status-skip">—</span>'}</td>
              <td class="num">${escapeHtml(formatInt(candidate.windowCount))}</td>
            </tr>
            ${candidate.params ? `<tr><td colspan="7"><details><summary>Candidate Params</summary><pre>${formatJson(candidate.params)}</pre></details></td></tr>` : ''}`).join('')}</tbody>
          </table>`
        : renderEmptyState('No ranked candidates were persisted for this run.'),
    ),

    renderSection(
      'Selection Config & Artifacts',
      `${renderKeyValueGrid([
        { key: 'Artifact Paths', value: detail.artifactPaths && detail.artifactPaths.length > 0 ? escapeHtml(detail.artifactPaths.join(', ')) : '—' },
        { key: 'Selection Config Present', value: detail.selectionConfig ? 'Yes' : 'No' },
      ])}
      <div style="margin-top:0.9rem;">
        <h3>Selection Config</h3>
        ${detail.selectionConfig ? `<pre>${formatJson(detail.selectionConfig)}</pre>` : renderEmptyState('No selection config JSON was persisted for this run.')}
      </div>`,
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
    title: `${detail.label} (#${detail.runId})`,
    kicker: 'Operator Backtest Detail',
    subtitle: 'Persisted winner-selection rationale, candidate ranking, and per-window evidence for one walk-forward run.',
    meta: `Strategy ${renderLink(strategyHref, `${detail.strategyId}@${detail.strategyVersion}`)} · Result ${escapeHtml(detail.result)}`,
    actions,
    body,
    navActive: 'governance',
  });
}
