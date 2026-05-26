// ── Operator Status Strip (Global Component) ──
// Shared, always-visible operational truth bar for the operator console shell.
// Renders one typed status contract across every operator route.

export type OperatorStatusTone = 'healthy' | 'warning' | 'critical' | 'unavailable';

export type OperatorStatusKey = 'market' | 'execution' | 'broker' | 'risk' | 'freshness';

export interface OperatorStatusItem {
  key: OperatorStatusKey;
  label: string;
  tone: OperatorStatusTone;
  summary: string;
  detail: string;
  evidence: string;
  asOf: string | null;
}

export interface OperatorShellStatusViewModel {
  assembledAt: string;
  headline: string;
  items: OperatorStatusItem[];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace(/\.\d{3}\+.*$/, '').substring(0, 19);
}

function toneClass(tone: OperatorStatusTone): string {
  switch (tone) {
    case 'healthy':
      return 'console-status-healthy';
    case 'warning':
      return 'console-status-warning';
    case 'critical':
      return 'console-status-critical';
    case 'unavailable':
    default:
      return 'console-status-unavailable';
  }
}

export function renderOperatorStatusStrip(shellStatus: OperatorShellStatusViewModel | null | undefined): string {
  if (!shellStatus) {
    return `<section class="console-status-strip" aria-label="Global operational status" data-shell-status-strip>
      <div class="console-status-strip-header">
        <div>
          <div class="console-status-kicker">Global Status</div>
          <div class="console-status-headline">Operational truth unavailable.</div>
        </div>
      </div>
      <div class="console-status-grid">
        ${['market', 'execution', 'broker', 'risk', 'freshness'].map(key => `<article class="console-status-card console-status-unavailable" data-shell-status-key="${key}" data-shell-status-tone="unavailable">
          <div class="console-status-label">${escapeHtml(key[0].toUpperCase() + key.slice(1))}</div>
          <div class="console-status-summary">Unavailable</div>
          <div class="console-status-detail">No shared operator status contract was provided for this route.</div>
          <div class="console-status-meta">Evidence unavailable</div>
        </article>`).join('')}
      </div>
    </section>`;
  }

  const itemsHtml = shellStatus.items.map(item => `<article
      class="console-status-card ${toneClass(item.tone)}"
      data-shell-status-key="${escapeHtml(item.key)}"
      data-shell-status-tone="${escapeHtml(item.tone)}"
    >
      <div class="console-status-label">${escapeHtml(item.label)}</div>
      <div class="console-status-summary">${escapeHtml(item.summary)}</div>
      <div class="console-status-detail">${escapeHtml(item.detail)}</div>
      <div class="console-status-meta">Evidence: ${escapeHtml(item.evidence)}${item.asOf ? ` • As of ${escapeHtml(formatTimestamp(item.asOf))}` : ''}</div>
    </article>`).join('');

  return `<section class="console-status-strip" aria-label="Global operational status" data-shell-status-strip>
    <div class="console-status-strip-header">
      <div>
        <div class="console-status-kicker">Global Status</div>
        <div class="console-status-headline">${escapeHtml(shellStatus.headline)}</div>
      </div>
      <div class="console-status-meta">Assembled ${escapeHtml(formatTimestamp(shellStatus.assembledAt))}</div>
    </div>
    <div class="console-status-grid">${itemsHtml}</div>
  </section>`;
}
