import type { DashboardPayload } from '../dashboard-data.js';
import { renderDashboardSectionHtml, renderResearchLineageSection } from './dashboard-page.js';
import { escapeHtml, renderPageLayout } from '../render-utils.js';

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
      sectionHtml.lifecycleStates,
      sectionHtml.governanceHistory,
      sectionHtml.promotionHistory,
      sectionHtml.walkForwardLeaderboard,
      governanceResearchLineage,
    ].join('\n'),
  });
}
