import type { DashboardPayload } from '../dashboard-data.js';
import { renderDashboardSectionHtml } from './dashboard-page.js';
import { escapeHtml, renderPageLayout } from '../render-utils.js';

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
    body: sectionHtml.decisionPerformance,
  });
}
