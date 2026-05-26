import {
  renderExplainabilityEvidenceChecklist,
  renderExplainabilityStack,
  renderExplainabilityWhat,
  renderExplainabilityWhyNarrative,
  type ExplainabilityEvidenceItem,
} from '../components/explainability.js';
import { escapeHtml, formatJson, formatTimestamp, renderEmptyState, renderPageLayout, renderSection } from '../render-utils.js';

export interface OperatorSystemHealthViewModel {
  status: string;
  version: string;
  service: string;
  dbConnected: boolean;
  dbError: string | null;
  pollIntervalMs: number;
  authClients: unknown[];
  dbOpenBootstrap: unknown;
  detailReadModelBootstrap: unknown;
  upstoxTokenRefresh?: unknown;
  sections: Record<string, unknown>;
}

type SectionState = 'ok' | 'stale' | 'error' | 'unavailable';

type HealthSectionSummary = {
  key: string;
  label: string;
  status: string;
  count: number | null;
  error: string | null;
  availability: string | null;
};

type AuthClientSummary = {
  clientIp: string;
  failures: number;
  lockedUntilTimestamp: number;
  activeRequestsInWindow: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown, fallback: string | null = null): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bootstrapStatus(value: unknown): string {
  if (!isRecord(value)) {
    return 'unknown';
  }
  return readString(value.status, 'unknown') ?? 'unknown';
}

function bootstrapError(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return readString(value.lastError);
}

function toSectionState(status: string): SectionState {
  switch (status) {
    case 'ready':
    case 'recovered':
    case 'healthy':
    case 'ok':
    case 'idle':
    case 'refreshed':
      return 'ok';
    case 'retrying':
    case 'awaiting_approval':
    case 'suppressed':
    case 'degraded':
    case 'warning':
      return 'stale';
    case 'failed':
    case 'request_failed':
    case 'error':
      return 'error';
    case 'unavailable':
    case 'missing':
      return 'unavailable';
    default:
      return 'stale';
  }
}

function severityRank(state: SectionState): number {
  switch (state) {
    case 'error':
      return 3;
    case 'stale':
      return 2;
    case 'unavailable':
      return 1;
    case 'ok':
    default:
      return 0;
  }
}

function combineStates(states: ReadonlyArray<SectionState>): SectionState {
  return states.reduce<SectionState>((current, next) => (
    severityRank(next) > severityRank(current) ? next : current
  ), 'ok');
}

function renderJsonDisclosure(title: string, value: unknown, open = false): string {
  const openAttr = open ? ' open' : '';
  return `<details${openAttr}><summary>${escapeHtml(title)}</summary><pre>${formatJson(value)}</pre></details>`;
}

function authClients(payload: OperatorSystemHealthViewModel): AuthClientSummary[] {
  if (!Array.isArray(payload.authClients)) {
    return [];
  }

  return payload.authClients
    .filter(isRecord)
    .map(client => ({
      clientIp: readString(client.clientIp, 'unknown') ?? 'unknown',
      failures: readNumber(client.failures, 0),
      lockedUntilTimestamp: readNumber(client.lockedUntilTimestamp, 0),
      activeRequestsInWindow: readNumber(client.activeRequestsInWindow, 0),
    }));
}

function healthSections(payload: OperatorSystemHealthViewModel): HealthSectionSummary[] {
  const labels: Record<string, string> = {
    summaryCards: 'Overview summary cards',
    recentDecisions: 'Recent decision ledger',
    strategyPerformance: 'Strategy performance',
    tickerPerformance: 'Ticker performance',
    strategyExposure: 'Strategy exposure',
    lifecycle: 'Lifecycle state',
    researchLineage: 'Research lineage',
    overnightResearch: 'Overnight research',
  };

  return Object.entries(payload.sections).map(([key, value]) => {
    const record = isRecord(value) ? value : {};
    return {
      key,
      label: labels[key] ?? key,
      status: readString(record.status, 'unknown') ?? 'unknown',
      count: typeof record.count === 'number' && Number.isFinite(record.count) ? record.count : null,
      error: readString(record.error),
      availability: readString(record.availability),
    };
  });
}

function renderHealthSummarySection(payload: OperatorSystemHealthViewModel): string {
  const bootstrapDbStatus = bootstrapStatus(payload.dbOpenBootstrap);
  const bootstrapDetailStatus = bootstrapStatus(payload.detailReadModelBootstrap);
  const auth = authClients(payload);
  const sections = healthSections(payload);
  const failingSections = sections.filter(section => toSectionState(section.status) === 'error');
  const degradedSections = sections.filter(section => toSectionState(section.status) === 'stale');
  const unavailableSections = sections.filter(section => toSectionState(section.status) === 'unavailable');
  const refreshRecord = isRecord(payload.upstoxTokenRefresh) ? payload.upstoxTokenRefresh : null;
  const refresh = refreshRecord && isRecord(refreshRecord.refresh) ? refreshRecord.refresh : null;
  const refreshState = readString(refresh?.state, 'unknown') ?? 'unknown';
  const summaryState = combineStates([
    payload.dbConnected ? 'ok' : 'error',
    toSectionState(bootstrapDbStatus),
    toSectionState(bootstrapDetailStatus),
    toSectionState(refreshState),
    combineStates(sections.map(section => toSectionState(section.status))),
  ]);

  const lockedClients = auth.filter(client => client.lockedUntilTimestamp > Date.now()).length;
  const failedClients = auth.filter(client => client.failures > 0).length;

  const summary = !payload.dbConnected
    ? 'The operator UI is degraded because the database connection is unavailable, so the sections below stay explicit about missing or failed readiness evidence instead of claiming healthy runtime status.'
    : summaryState === 'ok'
      ? 'The operator UI is serving authenticated health diagnostics with ready bootstrap state, live read-model probes, and visible auth plus refresh recovery evidence.'
      : 'The operator UI is reachable, but one or more readiness, refresh, or section probes need attention before operators should treat the surface as fully healthy.';

  return renderSection(
    'Health Summary',
    renderExplainabilityStack([
      renderExplainabilityWhat([
        { label: 'Overall Readiness', value: payload.status, meta: payload.dbConnected ? 'Database connected' : 'Database degraded' },
        { label: 'DB Bootstrap', value: bootstrapDbStatus, meta: 'Read-only DB open status' },
        { label: 'Detail Bootstrap', value: bootstrapDetailStatus, meta: 'Detail read-model readiness' },
        { label: 'Section Probes Needing Attention', value: failingSections.length + degradedSections.length + unavailableSections.length, meta: 'Top-level SSR section checks' },
        { label: 'Tracked Auth Clients', value: auth.length, meta: lockedClients > 0 ? `${lockedClients} locked` : 'No active lockouts' },
        { label: 'Refresh Cadence', value: `${payload.pollIntervalMs} ms`, meta: 'Dashboard polling contract' },
      ], 'No persisted system-health summary is available.'),
      renderExplainabilityWhyNarrative({
        summary,
        bullets: [
          payload.dbConnected
            ? 'The HTML route stays interpretation-first while the raw /api/health contract remains available as an escape hatch.'
            : `Database access is currently degraded${payload.dbError ? `: ${payload.dbError}` : '.'}`,
          failingSections.length > 0
            ? `${failingSections.length} subsystem probe(s) failed and are listed below with their last reported error.`
            : 'No top-level subsystem probe is currently reporting a hard failure.',
          readString(refresh?.message)
            ? `Upstox refresh status reports: ${readString(refresh?.message)}.`
            : 'Upstox refresh evidence remains visible below alongside the manual recovery action.',
        ],
        emptyMessage: 'No system-health narrative is available.',
      }),
      renderExplainabilityEvidenceChecklist({
        items: [
          {
            label: 'Database connectivity',
            verdict: payload.dbConnected ? 'pass' : 'fail',
            observedValue: payload.dbConnected ? 'connected' : 'degraded',
            expectedValue: 'Connected',
            note: payload.dbConnected
              ? 'The health page is backed by a live operator database connection.'
              : (payload.dbError ?? 'Database connection is unavailable.'),
          },
          {
            label: 'DB open bootstrap',
            verdict: bootstrapDbStatus === 'ready' || bootstrapDbStatus === 'recovered' ? 'pass' : bootstrapDbStatus === 'retrying' ? 'warn' : 'fail',
            observedValue: bootstrapDbStatus,
            expectedValue: 'ready or recovered',
            note: bootstrapError(payload.dbOpenBootstrap) ?? 'Read-only DB bootstrap state is reported directly from the server startup tracker.',
          },
          {
            label: 'Detail read-model bootstrap',
            verdict: bootstrapDetailStatus === 'ready' ? 'pass' : bootstrapDetailStatus === 'retrying' ? 'warn' : 'fail',
            observedValue: bootstrapDetailStatus,
            expectedValue: 'ready',
            note: bootstrapError(payload.detailReadModelBootstrap) ?? 'Detail-route readiness is reported directly from the lazy bootstrap tracker.',
          },
          {
            label: 'Top-level route probes',
            verdict: failingSections.length > 0 ? 'fail' : degradedSections.length > 0 || unavailableSections.length > 0 ? 'warn' : 'pass',
            observedValue: `${sections.length} checked / ${failingSections.length + degradedSections.length + unavailableSections.length} needing attention`,
            expectedValue: 'All section probes healthy',
            note: failingSections.length > 0
              ? `Failing probes: ${failingSections.map(section => section.label).join(', ')}.`
              : degradedSections.length > 0 || unavailableSections.length > 0
                ? 'Some subsystem probes are stale or unavailable even though the route is still reachable.'
                : 'All current top-level section probes reported healthy state.',
          },
          {
            label: 'Auth diagnostics visibility',
            verdict: auth.length > 0 || failedClients > 0 || lockedClients > 0 ? 'pass' : 'warn',
            observedValue: auth.length,
            expectedValue: 'Client lockout and rate-limit evidence when activity exists',
            note: auth.length > 0
              ? 'Client-level lockout and request-window counts are visible below without exposing credentials.'
              : 'No active or recently failing auth clients are currently tracked.',
          },
        ],
        emptyMessage: 'No health evidence is available for this route.',
      }),
      renderJsonDisclosure('Database Open Bootstrap', payload.dbOpenBootstrap),
      renderJsonDisclosure('Detail Read Model Bootstrap', payload.detailReadModelBootstrap),
    ]),
    summaryState,
    payload.dbConnected ? null : payload.dbError,
    null,
    'Shared what/why/evidence framing for operator readiness and startup state',
    { id: 'system-health-summary' },
  );
}

function renderRefreshSection(payload: OperatorSystemHealthViewModel): string {
  const record = isRecord(payload.upstoxTokenRefresh) ? payload.upstoxTokenRefresh : null;
  const refresh = record && isRecord(record.refresh) ? record.refresh : null;
  const token = record && isRecord(record.token) ? record.token : null;
  const state = readString(refresh?.state, 'unavailable') ?? 'unavailable';
  const sectionState = toSectionState(state);
  const tokenExists = token ? Boolean(token.exists) : false;
  const tokenExpired = token ? Boolean(token.isExpired) : false;
  const refreshMessage = readString(refresh?.message);
  const statusPath = readString(record?.statusPath);
  const refreshItems: ExplainabilityEvidenceItem[] = [
    {
      label: 'Refresh request state',
      verdict: state === 'request_failed' ? 'fail' : state === 'awaiting_approval' || state === 'suppressed' ? 'warn' : state === 'unavailable' ? 'missing' : 'pass',
      observedValue: state,
      expectedValue: 'idle, refreshed, or pending approval when recovery is in progress',
      note: readString(refresh?.lastError) ?? refreshMessage ?? 'The refresh coordinator reports this state directly.',
    },
    {
      label: 'Token file evidence',
      verdict: tokenExists ? 'pass' : 'missing',
      observedValue: tokenExists ? 'present' : 'missing',
      expectedValue: 'Persisted token metadata',
      note: tokenExists
        ? 'Masked token metadata is available for expiry and issuance checks.'
        : 'No persisted Upstox token metadata is currently available.',
    },
    {
      label: 'Token expiry',
      verdict: tokenExists ? (tokenExpired ? 'fail' : 'pass') : 'missing',
      observedValue: tokenExpired ? 'expired' : readString(token?.expiresAt, 'unknown') ?? 'unknown',
      expectedValue: 'Unexpired token or explicit pending refresh state',
      note: tokenExists
        ? 'Expiry evidence is read from the persisted token snapshot, not inferred from broker calls.'
        : 'Expiry cannot be assessed until a persisted token snapshot exists.',
    },
    {
      label: 'Refresh status file',
      verdict: record?.exists ? 'pass' : 'missing',
      observedValue: record?.exists ? 'present' : 'missing',
      expectedValue: 'Status file present',
      note: statusPath
        ? `Status is read from ${statusPath}.`
        : 'No refresh status path was reported.',
    },
  ];

  return renderSection(
    'Broker Token and Refresh Recovery',
    `${renderExplainabilityStack([
      renderExplainabilityWhat([
        { label: 'Refresh State', value: state, meta: 'Notifier-backed recovery flow' },
        { label: 'Token File', value: tokenExists ? 'present' : 'missing', meta: tokenExpired ? 'Expired snapshot' : 'Masked metadata only' },
        { label: 'Token Expiry', value: readString(token?.expiresAt), meta: 'Persisted expiry if available' },
        { label: 'Last Request', value: readString(refresh?.lastRequestAt), meta: 'Most recent manual or automatic request' },
        { label: 'Last Observed Token', value: readString(refresh?.lastObservedTokenPersistedAt), meta: 'Persisted token snapshot time' },
      ], 'No Upstox token refresh evidence is currently available.'),
      renderExplainabilityWhyNarrative({
        summary: 'This section keeps the manual Upstox recovery action visible while grounding token health in persisted refresh-status and token-file evidence rather than guessing from the UI alone.',
        bullets: [
          refreshMessage
            ? refreshMessage
            : 'Automatic recovery continues to rely on the notifier-backed refresh coordinator.',
          tokenExists
            ? 'Token metadata is shown without exposing secrets so operators can check issuance and expiry timing safely.'
            : 'No persisted token snapshot exists yet, so the page keeps the missing-evidence state explicit.',
        ],
        emptyMessage: 'No Upstox refresh narrative is available.',
      }),
      renderExplainabilityEvidenceChecklist({
        items: refreshItems,
        emptyMessage: 'No Upstox refresh evidence is available for this operator view.',
      }),
    ])}
    <div class="action-stack">
      <p class="meta">Manual trigger sends a fresh Upstox token request. If approval is required, approve it in Upstox / WhatsApp. Automatic recovery runs hourly and re-requests when the token is still expired.</p>
      <form method="post" action="/system-health/upstox/token-refresh">
        <button type="submit">Request Upstox Token Refresh</button>
      </form>
    </div>
    ${renderJsonDisclosure('Upstox Refresh Health JSON', payload.upstoxTokenRefresh ?? { status: 'unavailable' })}`,
    sectionState,
    readString(refresh?.lastError),
    null,
    'Manual recovery action plus persisted token and refresh evidence',
    { id: 'system-health-upstox-refresh' },
  );
}

function renderSubsystemSection(payload: OperatorSystemHealthViewModel): string {
  const sections = healthSections(payload);
  const sectionState = combineStates(sections.map(section => toSectionState(section.status)));
  const failing = sections.filter(section => toSectionState(section.status) === 'error');
  const stale = sections.filter(section => toSectionState(section.status) === 'stale');
  const unavailable = sections.filter(section => toSectionState(section.status) === 'unavailable');

  const rows = sections.length > 0
    ? `<table>
      <thead><tr>
        <th>Subsystem</th>
        <th>Status</th>
        <th class="num">Count</th>
        <th>Availability</th>
        <th>Notes</th>
      </tr></thead>
      <tbody>${sections.map(section => `<tr>
        <td>${escapeHtml(section.label)}</td>
        <td>${escapeHtml(section.status)}</td>
        <td class="num">${section.count === null ? '—' : escapeHtml(String(section.count))}</td>
        <td>${section.availability ? escapeHtml(section.availability) : '—'}</td>
        <td>${escapeHtml(section.error ?? 'Probe returned without error.')}</td>
      </tr>`).join('')}</tbody>
    </table>`
    : renderEmptyState('No subsystem probes were reported in the health payload.');

  return renderSection(
    'Subsystem Evidence',
    `${renderExplainabilityStack([
      renderExplainabilityWhat([
        { label: 'Checked Probes', value: sections.length, meta: 'Top-level SSR read-model checks' },
        { label: 'Failing', value: failing.length, meta: 'Hard refresh failures' },
        { label: 'Stale', value: stale.length, meta: 'Last-known or retrying evidence' },
        { label: 'Unavailable', value: unavailable.length, meta: 'No backing evidence available' },
      ], 'No subsystem probe summary is available.'),
      renderExplainabilityWhyNarrative({
        summary: 'These probes reflect the same top-level operator read-model surfaces used by the SSR routes, so the page shows what can currently be rendered without inventing new runtime telemetry.',
        bullets: [
          failing.length > 0
            ? `Failed probes stay explicit: ${failing.map(section => section.label).join(', ')}.`
            : 'No probe is currently reporting a hard failure.',
          stale.length > 0 || unavailable.length > 0
            ? 'Stale or unavailable probes indicate bounded or missing evidence, not silent success.'
            : 'All current subsystem probes returned healthy state.',
        ],
        emptyMessage: 'No subsystem narrative is available.',
      }),
      renderExplainabilityEvidenceChecklist({
        items: sections.map(section => ({
          label: section.label,
          verdict: toSectionState(section.status) === 'error'
            ? 'fail'
            : toSectionState(section.status) === 'stale'
              ? 'warn'
              : toSectionState(section.status) === 'unavailable'
                ? 'missing'
                : 'pass',
          observedValue: section.status,
          expectedValue: 'ok',
          note: section.error
            ? section.error
            : section.availability
              ? `Availability: ${section.availability}.`
              : section.count !== null
                ? `${section.count} row(s) or cards were reported by this probe.`
                : 'Probe returned without row-count metadata.',
        })),
        emptyMessage: 'No subsystem evidence is available for this route.',
      }),
    ])}
    ${rows}
    ${renderJsonDisclosure('Section Health JSON', payload.sections)}`,
    sectionState,
    failing[0]?.error ?? null,
    null,
    'Read-model probe status for top-level operator routes',
    { id: 'system-health-sections' },
  );
}

function renderAuthSection(payload: OperatorSystemHealthViewModel): string {
  const clients = authClients(payload);
  const now = Date.now();
  const lockedClients = clients.filter(client => client.lockedUntilTimestamp > now);
  const failedClients = clients.filter(client => client.failures > 0);
  const totalActiveRequests = clients.reduce((sum, client) => sum + client.activeRequestsInWindow, 0);
  const sectionState: SectionState = lockedClients.length > 0
    ? 'stale'
    : failedClients.length > 0 || clients.length > 0
      ? 'ok'
      : 'stale';

  const rows = clients.length > 0
    ? `<table>
      <thead><tr>
        <th>Client</th>
        <th class="num">Failures</th>
        <th>Locked Until</th>
        <th class="num">Requests In Window</th>
      </tr></thead>
      <tbody>${clients.map(client => `<tr>
        <td><code>${escapeHtml(client.clientIp)}</code></td>
        <td class="num">${escapeHtml(String(client.failures))}</td>
        <td>${client.lockedUntilTimestamp > now ? escapeHtml(formatTimestamp(new Date(client.lockedUntilTimestamp).toISOString())) : '—'}</td>
        <td class="num">${escapeHtml(String(client.activeRequestsInWindow))}</td>
      </tr>`).join('')}</tbody>
    </table>`
    : renderEmptyState('No recent auth failures, lockouts, or rate-limit activity are currently tracked.');

  return renderSection(
    'Operator Auth',
    `${renderExplainabilityStack([
      renderExplainabilityWhat([
        { label: 'Tracked Clients', value: clients.length, meta: 'Recent auth or rate-limit activity' },
        { label: 'Clients With Failures', value: failedClients.length, meta: 'Consecutive failure counters' },
        { label: 'Locked Clients', value: lockedClients.length, meta: 'Active lockout windows' },
        { label: 'Requests In Window', value: totalActiveRequests, meta: 'Rate-limit diagnostics' },
      ], 'No auth diagnostics are currently available.'),
      renderExplainabilityWhyNarrative({
        summary: 'The auth view exposes lockout and request-window diagnostics without revealing credentials so operators can distinguish quiet health from repeated login trouble.',
        bullets: [
          lockedClients.length > 0
            ? `${lockedClients.length} client(s) are currently locked out and remain visible until the lockout window expires.`
            : 'No active client lockout is currently reported.',
          clients.length > 0
            ? 'Only clients with recent requests, active failures, or lockouts remain in the diagnostic set.'
            : 'No recent auth activity needs operator attention right now.',
        ],
        emptyMessage: 'No auth narrative is available.',
      }),
      renderExplainabilityEvidenceChecklist({
        items: [
          {
            label: 'Tracked auth clients',
            verdict: clients.length > 0 ? 'pass' : 'missing',
            observedValue: clients.length,
            expectedValue: 'Recent activity when auth pressure exists',
            note: clients.length > 0
              ? 'Client IPs, failures, and request-window counts are persisted in memory for diagnostics only.'
              : 'No recent auth or rate-limit activity is currently tracked.',
          },
          {
            label: 'Lockout visibility',
            verdict: lockedClients.length > 0 ? 'warn' : 'pass',
            observedValue: lockedClients.length,
            expectedValue: '0 active lockouts',
            note: lockedClients.length > 0
              ? 'One or more clients are currently locked out and remain visible below.'
              : 'No active lockout window is currently reported.',
          },
          {
            label: 'Rate-limit activity',
            verdict: totalActiveRequests > 0 ? 'pass' : 'missing',
            observedValue: totalActiveRequests,
            expectedValue: 'Visible request-window counts when traffic exists',
            note: totalActiveRequests > 0
              ? 'Recent request counts are available for rate-limit diagnosis.'
              : 'No recent request-window activity is currently visible.',
          },
        ],
        emptyMessage: 'No auth evidence is available for this route.',
      }),
    ])}
    ${rows}
    ${renderJsonDisclosure('Auth Client State JSON', payload.authClients)}`,
    sectionState,
    lockedClients.length > 0 ? 'One or more auth clients are currently locked out.' : null,
    null,
    'Basic-auth lockout and rate-limit diagnostics without credential exposure',
    { id: 'system-health-auth' },
  );
}

export function renderSystemHealthPage(payload: OperatorSystemHealthViewModel, options: { shellStatus?: import('../components/status-strip.js').OperatorShellStatusViewModel | null } = {}): string {
  return renderPageLayout({
    title: 'System Health',
    kicker: 'Operator Console',
    subtitle: 'Operational readiness, bootstrap truth, broker token recovery, and auth diagnostics for the existing SSR operator surface. The JSON contract at /api/health remains unchanged.',
    meta: payload.dbConnected ? 'Healthy database connection with explicit subsystem evidence below.' : `Degraded: ${payload.dbError ?? 'database unavailable'}`,
    actions: '<a href="/">Back to overview</a><a href="/api/health">Raw JSON</a><a href="/positions">Positions & exposure</a>',
    navActive: 'system-health',
    shellStatus: options.shellStatus ?? null,
    body: [
      renderHealthSummarySection(payload),
      renderRefreshSection(payload),
      renderSubsystemSection(payload),
      renderAuthSection(payload),
    ].join('\n'),
  });
}
