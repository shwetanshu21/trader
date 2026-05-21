import type { DashboardPayload } from '../dashboard-data.js';
import { renderDashboardSectionHtml } from './dashboard-page.js';
import { escapeHtml, renderPageLayout } from '../render-utils.js';

export function renderGovernancePage(payload: DashboardPayload): string {
  const sectionHtml = renderDashboardSectionHtml(payload);

  return renderPageLayout({
    title: 'Governance & Backtests',
    kicker: 'Operator Console',
    subtitle: 'Lifecycle state, governance transitions, promotions, and walk-forward winner evidence on a dedicated operator page.',
    meta: `Assembled ${escapeHtml(payload.assembledAt)}`,
    actions: '<a href="/">Back to overview</a><a href="/strategies">Strategies</a><a href="/decisions">Decision ledger</a>',
    navActive: 'governance',
    body: [
      sectionHtml.lifecycleStates,
      sectionHtml.governanceHistory,
      sectionHtml.promotionHistory,
      sectionHtml.walkForwardLeaderboard,
    ].join('\n'),
  });
}
