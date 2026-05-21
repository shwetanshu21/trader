import { formatJson, renderPageLayout, renderSection } from '../render-utils.js';

export interface OperatorSystemHealthViewModel {
  status: string;
  version: string;
  service: string;
  dbConnected: boolean;
  dbError: string | null;
  pollIntervalMs: number;
  authClients: unknown[];
  sections: Record<string, unknown>;
}

export function renderSystemHealthPage(payload: OperatorSystemHealthViewModel): string {
  const cards = [
    { label: 'Service', value: payload.service, meta: payload.version },
    { label: 'Status', value: payload.status, meta: payload.dbConnected ? 'DB connected' : 'DB degraded' },
    { label: 'Poll Interval', value: `${payload.pollIntervalMs} ms`, meta: 'Dashboard refresh cadence' },
    { label: 'Tracked Auth Clients', value: String(payload.authClients.length), meta: 'Current rate-limit / lockout state view' },
  ];

  const summary = renderSection(
    'System Summary',
    `<div class="summary-grid">${cards.map(card => `<div class="summary-card"><div class="label">${card.label}</div><div class="value">${card.value}</div><div class="meta">${card.meta}</div></div>`).join('')}</div>`,
    payload.dbConnected ? 'ok' : 'stale',
    payload.dbError,
    null,
    'HTML wrapper around the existing operator health JSON',
    { id: 'system-health-summary' },
  );

  const sections = renderSection(
    'Section Health',
    `<pre>${formatJson(payload.sections)}</pre>`,
    'ok',
    null,
    null,
    'Counts and read-model error surfaces',
    { id: 'system-health-sections' },
  );

  const authState = renderSection(
    'Auth Client State',
    `<pre>${formatJson(payload.authClients)}</pre>`,
    'ok',
    null,
    null,
    'Basic-auth lockout and rate-limit diagnostics',
    { id: 'system-health-auth' },
  );

  return renderPageLayout({
    title: 'System Health',
    kicker: 'Operator Console',
    subtitle: 'Dedicated HTML view for operator health and auth diagnostics. The JSON contract at /api/health remains unchanged.',
    meta: payload.dbConnected ? 'Healthy operator database connection.' : `Degraded: ${payload.dbError ?? 'database unavailable'}`,
    actions: '<a href="/">Back to overview</a><a href="/api/health">Raw JSON</a><a href="/positions">Positions & exposure</a>',
    navActive: 'system-health',
    body: [summary, sections, authState].join('\n'),
  });
}
