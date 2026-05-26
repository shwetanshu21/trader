import type { DashboardPayload } from '../dashboard-data.js';
import {
  renderExplainabilityEvidenceChecklist,
  renderExplainabilityStack,
  renderExplainabilityWhat,
  renderExplainabilityWhyNarrative,
} from '../components/explainability.js';
import { renderDashboardSectionHtml } from './dashboard-page.js';
import { escapeHtml, renderPageLayout, renderSection } from '../render-utils.js';

function renderDecisionLedgerExplainability(payload: DashboardPayload): string {
  const section = payload.decisionPerformance;
  const decisions = section.state === 'ok' || section.state === 'stale'
    ? section.data
    : [];
  const approvedCount = decisions.filter(decision => decision.decisionStatus === 'approved').length;
  const refusedCount = decisions.filter(decision => decision.decisionStatus === 'refused').length;
  const executionCount = decisions.filter(decision => decision.executionStatus !== null).length;
  const llmEvidenceCount = decisions.filter(decision => decision.llmStatus !== null).length;

  return renderSection(
    'Decision Explainability',
    renderExplainabilityStack([
      renderExplainabilityWhat([
        { label: 'Recent Decisions', value: decisions.length, meta: 'Bounded recent window' },
        { label: 'Approved', value: approvedCount, meta: 'Persisted decision status' },
        { label: 'Refused', value: refusedCount, meta: 'Persisted decision status' },
        { label: 'Execution Outcomes', value: executionCount, meta: 'Linked execution evidence' },
      ], 'No persisted decision rows are available for this operator view.'),
      renderExplainabilityWhyNarrative({
        summary: 'This page stays within the existing persisted decision window so operators can review what was approved, refused, or executed without inventing rationale beyond stored evidence.',
        bullets: [
          'Execution outcomes appear only when the decision row already carries linked execution evidence.',
          llmEvidenceCount > 0
            ? 'Hybrid LLM status is shown only for decisions that persisted it in the bounded recent window.'
            : 'No persisted hybrid LLM evidence exists in this bounded recent window, so the page keeps deterministic decision truth without speculative rationale.',
        ],
        emptyMessage: 'No persisted decision rationale summary is available for this operator view.',
      }),
      renderExplainabilityEvidenceChecklist({
        items: [
          {
            label: 'Recent decision rows',
            verdict: decisions.length > 0 ? 'pass' : 'missing',
            observedValue: decisions.length,
            expectedValue: '1 or more persisted rows',
            note: 'The decision ledger remains bounded to the existing recent read-model window for operator readability.',
          },
          {
            label: 'Execution evidence',
            verdict: executionCount > 0 ? 'pass' : 'missing',
            observedValue: executionCount,
            expectedValue: 'Linked execution outcomes when recorded',
            note: executionCount > 0
              ? 'Only decisions with linked execution rows show downstream status and outcomes.'
              : 'No linked execution outcome was persisted in this recent decision window.',
          },
          {
            label: 'Hybrid LLM rationale',
            verdict: llmEvidenceCount > 0 ? 'pass' : 'missing',
            observedValue: llmEvidenceCount,
            expectedValue: 'Persisted hybrid status when available',
            note: llmEvidenceCount > 0
              ? 'LLM status is displayed from persisted decision rows only.'
              : 'No decision in this recent window persisted hybrid LLM evidence.',
          },
        ],
        emptyMessage: 'No decision evidence is available for this operator view.',
        boundedWindow: { count: decisions.length, noun: 'decision' },
      }),
    ]),
    section.state,
    section.errorMessage,
    section.stalenessMs,
    'Shared what/why/evidence framing for the recent decision ledger',
    {
      id: 'decisions-explainability',
      lastFetchedAt: section.lastFetchedAt,
      isCachedData: section.isCachedData,
    },
  );
}

export function renderDecisionsPage(payload: DashboardPayload, options: { shellStatus?: import('../components/status-strip.js').OperatorShellStatusViewModel | null } = {}): string {
  const sectionHtml = renderDashboardSectionHtml(payload);

  return renderPageLayout({
    title: 'Decision Ledger',
    kicker: 'Operator Console',
    subtitle: 'Recent strategy decisions and their execution outcomes, rendered from the existing persisted decision/evidence surface.',
    meta: `Assembled ${escapeHtml(payload.assembledAt)}`,
    actions: '<a href="/">Back to overview</a><a href="/strategies">Strategies</a><a href="/system-health">System health</a>',
    navActive: 'decisions',
    shellStatus: options.shellStatus ?? null,
    body: [
      renderDecisionLedgerExplainability(payload),
      sectionHtml.decisionPerformance,
    ].join('\n'),
  });
}
