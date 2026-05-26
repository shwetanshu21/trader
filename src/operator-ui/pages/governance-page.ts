import type { DashboardPayload, DashboardSection, SectionState } from '../dashboard-data.js';
import {
  renderExplainabilityEvidenceChecklist,
  renderExplainabilityStack,
  renderExplainabilityWhat,
  renderExplainabilityWhyNarrative,
} from '../components/explainability.js';
import { renderDashboardSectionHtml, renderResearchLineageSection } from './dashboard-page.js';
import { escapeHtml, renderPageLayout, renderSection } from '../render-utils.js';

function combineSectionState(sections: ReadonlyArray<DashboardSection<unknown>>): {
  state: SectionState;
  errorMessage: string | null;
} {
  const unavailableCount = sections.filter(section => section.state === 'unavailable').length;
  if (unavailableCount === sections.length) {
    return {
      state: 'unavailable',
      errorMessage: 'All governance evidence sections are currently unavailable.',
    };
  }

  const errorMessages = sections
    .filter(section => section.state === 'error' || section.state === 'stale')
    .map(section => section.errorMessage)
    .filter((message): message is string => Boolean(message));

  if (sections.some(section => section.state === 'error')) {
    return {
      state: 'error',
      errorMessage: errorMessages[0] ?? 'One or more governance evidence sections failed to refresh.',
    };
  }

  if (sections.some(section => section.state === 'stale')) {
    return {
      state: 'stale',
      errorMessage: errorMessages[0] ?? 'One or more governance evidence sections are showing last-known data.',
    };
  }

  return {
    state: 'ok',
    errorMessage: null,
  };
}

function renderGovernanceExplainability(payload: DashboardPayload): string {
  const sections = [
    payload.lifecycleStates,
    payload.governanceHistory,
    payload.promotionHistory,
    payload.walkForwardLeaderboard,
    payload.researchLineage,
  ] as const;
  const governanceRows = payload.governanceHistory.state === 'ok' || payload.governanceHistory.state === 'stale'
    ? payload.governanceHistory.data
    : [];
  const promotionRows = payload.promotionHistory.state === 'ok' || payload.promotionHistory.state === 'stale'
    ? payload.promotionHistory.data
    : [];
  const walkForwardRows = payload.walkForwardLeaderboard.state === 'ok' || payload.walkForwardLeaderboard.state === 'stale'
    ? payload.walkForwardLeaderboard.data
    : [];
  const lifecycleRows = payload.lifecycleStates.state === 'ok' || payload.lifecycleStates.state === 'stale'
    ? payload.lifecycleStates.data
    : [];
  const lineage = payload.researchLineage.state === 'ok' || payload.researchLineage.state === 'stale'
    ? payload.researchLineage.data
    : null;
  const combined = combineSectionState(sections);

  return renderSection(
    'Governance Explainability',
    renderExplainabilityStack([
      renderExplainabilityWhat([
        { label: 'Lifecycle States', value: lifecycleRows.length, meta: 'Current phase rows' },
        { label: 'Governance Decisions', value: governanceRows.length, meta: 'Recent transition history' },
        { label: 'Promotions', value: promotionRows.length, meta: 'Persisted promotion history' },
        { label: 'Walk-Forward Runs', value: walkForwardRows.length, meta: 'Winner-selection evidence' },
        { label: 'Published Research Total', value: lineage?.totals.publications ?? null, meta: 'Repository-backed total' },
      ], 'No governance evidence is currently available on this host.'),
      renderExplainabilityWhyNarrative({
        summary: 'This page keeps governance truth split into current lifecycle state, recorded transitions, promotions, walk-forward outcomes, and repository-backed lineage totals so each claim stays tied to persisted evidence.',
        bullets: [
          'Recent lineage rows remain intentionally bounded even when repository-backed totals are higher.',
          lineage && lineage.recent.length > 0
            ? 'Bounded lineage rows provide recent publication context without replacing truthful all-time lineage totals.'
            : 'No recent lineage rows are persisted, so the page keeps the missing-evidence state explicit instead of inferring governance context.',
        ],
        emptyMessage: 'No governance narrative summary is available.',
      }),
      renderExplainabilityEvidenceChecklist({
        items: [
          {
            label: 'Lifecycle state evidence',
            verdict: lifecycleRows.length > 0 ? 'pass' : 'missing',
            observedValue: lifecycleRows.length,
            expectedValue: 'Current strategy phase rows',
            note: lifecycleRows.length > 0
              ? 'Current lifecycle phases are persisted on this host.'
              : 'No lifecycle phase rows have been persisted on this host yet.',
          },
          {
            label: 'Governance transition history',
            verdict: governanceRows.length > 0 ? 'pass' : 'missing',
            observedValue: governanceRows.length,
            expectedValue: 'Recent recorded transitions',
            note: governanceRows.length > 0
              ? 'Transition verdicts and rationale are displayed only from persisted governance rows.'
              : 'No governance transition history has been persisted on this host yet.',
          },
          {
            label: 'Research lineage window',
            verdict: lineage && lineage.recent.length > 0 ? 'pass' : 'missing',
            observedValue: lineage?.recent.length ?? 0,
            expectedValue: 'Bounded recent lineage rows',
            note: lineage && lineage.recent.length > 0
              ? 'The recent governance lineage window is bounded for readability and backed by repository totals below.'
              : 'No recent research lineage rows are persisted, so governance keeps an explicit missing-evidence state.',
          },
        ],
        emptyMessage: 'No governance evidence is available for this operator view.',
      }),
    ]),
    combined.state,
    combined.errorMessage,
    combined.state === 'stale'
      ? sections.find(section => section.state === 'stale')?.stalenessMs ?? null
      : null,
    'Shared what/why/evidence framing for lifecycle and promotion review',
    {
      id: 'governance-explainability',
      lastFetchedAt: sections.find(section => section.lastFetchedAt)?.lastFetchedAt ?? null,
      isCachedData: sections.some(section => section.isCachedData),
    },
  );
}

export function renderGovernancePage(payload: DashboardPayload, options: { shellStatus?: import('../components/status-strip.js').OperatorShellStatusViewModel | null } = {}): string {
  const sectionHtml = renderDashboardSectionHtml(payload);
  const governanceResearchLineage = renderResearchLineageSection(payload.researchLineage, {
    emphasizeTotals: true,
    boundedLabel: 'Recent evidence window',
  });

  return renderPageLayout({
    title: 'Governance & Backtests',
    kicker: 'Operator Console',
    subtitle: 'Lifecycle state, governance transitions, promotions, and walk-forward winner evidence on a dedicated operator page.',
    meta: `Assembled ${escapeHtml(payload.assembledAt)}`,
    actions: '<a href="/">Back to overview</a><a href="/strategies">Strategies</a><a href="/decisions">Decision ledger</a>',
    navActive: 'governance',
    shellStatus: options.shellStatus ?? null,
    body: [
      renderGovernanceExplainability(payload),
      sectionHtml.lifecycleStates,
      sectionHtml.governanceHistory,
      sectionHtml.promotionHistory,
      sectionHtml.walkForwardLeaderboard,
      governanceResearchLineage,
    ].join('\n'),
  });
}
