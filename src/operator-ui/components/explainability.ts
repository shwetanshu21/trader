import {
  escapeHtml,
  formatNullable,
  renderEmptyState,
  renderSummaryGrid,
} from '../render-utils.js';

export type ExplainabilityVerdict = 'pass' | 'fail' | 'warn' | 'missing';

export interface ExplainabilityWhatCard {
  label: string;
  value: string | number | null | undefined;
  meta?: string | number | null;
}

export interface ExplainabilityWhyNarrative {
  title?: string;
  summary: string | null | undefined;
  bullets?: ReadonlyArray<string | null | undefined>;
  emptyMessage: string;
}

export interface ExplainabilityEvidenceItem {
  label: string;
  verdict: ExplainabilityVerdict;
  observedValue?: string | number | null;
  expectedValue?: string | number | null;
  note?: string | null;
  sourceLabel?: string | null;
  sourceHref?: string | null;
}

export interface ExplainabilityEvidenceChecklistOptions {
  title?: string;
  items: ReadonlyArray<ExplainabilityEvidenceItem> | null | undefined;
  emptyMessage: string;
  boundedWindow?: {
    count: number;
    noun: string;
  } | null;
}

function renderBlock(title: string, body: string): string {
  return `<div class="explainability-block">
    <h3>${escapeHtml(title)}</h3>
    ${body}
  </div>`;
}

export function renderExplainabilityBadge(verdict: ExplainabilityVerdict, label?: string): string {
  const cssClass = verdict === 'pass'
    ? 'section-state-ok'
    : verdict === 'fail'
      ? 'section-state-error'
      : verdict === 'warn'
        ? 'section-state-stale'
        : 'section-state-unavailable';

  const text = label ?? verdict;
  return `<span class="section-state-pill ${cssClass}">${escapeHtml(text)}</span>`;
}

export function renderExplainabilityWhat(cards: ReadonlyArray<ExplainabilityWhatCard>, emptyMessage: string): string {
  if (cards.length === 0) {
    return renderBlock('What', renderEmptyState(emptyMessage));
  }

  return renderBlock(
    'What',
    renderSummaryGrid(cards.map(card => ({
      label: card.label,
      value: formatNullable(card.value),
      meta: card.meta === null || card.meta === undefined || card.meta === ''
        ? undefined
        : escapeHtml(String(card.meta)),
    }))),
  );
}

export function renderExplainabilityWhyNarrative(options: ExplainabilityWhyNarrative): string {
  const bullets = (options.bullets ?? []).filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  const summary = typeof options.summary === 'string' && options.summary.trim().length > 0
    ? `<p>${escapeHtml(options.summary)}</p>`
    : renderEmptyState(options.emptyMessage);
  const bulletsHtml = bullets.length > 0
    ? `<ul>${bullets.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '';

  return renderBlock(options.title ?? 'Why', `${summary}${bulletsHtml}`);
}

function pluralize(count: number, noun: string): string {
  if (count === 1) {
    return noun;
  }

  if (noun.endsWith('s')) {
    return noun;
  }

  return `${noun}s`;
}

export function renderBoundedEvidenceNote(count: number, noun: string): string {
  return `<div class="section-note">Recent evidence below is intentionally bounded to the newest ${escapeHtml(String(count))} ${escapeHtml(pluralize(count, noun))} for operator readability.</div>`;
}

export function renderExplainabilityEvidenceChecklist(options: ExplainabilityEvidenceChecklistOptions): string {
  const notes: string[] = [];
  if (options.boundedWindow) {
    notes.push(renderBoundedEvidenceNote(options.boundedWindow.count, options.boundedWindow.noun));
  }

  const items = options.items ?? [];
  if (items.length === 0) {
    return renderBlock(
      options.title ?? 'Evidence',
      `${notes.join('')}${renderEmptyState(options.emptyMessage)}`,
    );
  }

  const rows = items.map(item => {
    const observed = item.observedValue === undefined ? null : item.observedValue;
    const expected = item.expectedValue === undefined ? null : item.expectedValue;
    const observedText = observed === null ? '—' : String(observed);
    const expectedText = expected === null ? '—' : String(expected);
    const detailParts = [
      `Observed: ${escapeHtml(observedText)}`,
      `Expected: ${escapeHtml(expectedText)}`,
    ];

    if (item.note) {
      detailParts.push(escapeHtml(item.note));
    }

    const source = item.sourceHref && item.sourceLabel
      ? `<a href="${escapeHtml(item.sourceHref)}">${escapeHtml(item.sourceLabel)}</a>`
      : item.sourceLabel
        ? escapeHtml(item.sourceLabel)
        : '';

    return `<li>
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem;">
        ${renderExplainabilityBadge(item.verdict)}
        <strong>${escapeHtml(item.label)}</strong>
      </div>
      <div class="section-note">${detailParts.join(' · ')}${source ? ` · Source: ${source}` : ''}</div>
    </li>`;
  }).join('');

  return renderBlock(
    options.title ?? 'Evidence',
    `${notes.join('')}<ul>${rows}</ul>`,
  );
}

export function renderExplainabilityStack(blocks: ReadonlyArray<string>): string {
  return blocks.filter(Boolean).join('');
}
