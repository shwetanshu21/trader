// ── Evidence Checklist Component ──
// Show pass/fail/warn/missing status for validation, risk, governance, and promotion criteria.

import type { StrategyGovernanceExplanation } from '../types/contracts.js';

/**
 * Render an EvidenceChecklist component.
 * Shows criteria with pass/fail/warn/missing status and observed values.
 */
export function renderEvidenceChecklist(
  criteria: Array<{
    name: string;
    result: 'pass' | 'fail' | 'warn' | 'missing';
    observedValue?: string | number;
    threshold?: string | number;
    source?: string;
  }> | null,
): string {
  if (!criteria || criteria.length === 0) {
    return `<div class="oc-card">
      <div class="oc-card-header">
        <h3 class="oc-card-title">Validation &amp; Risk Checks</h3>
      </div>
      <div class="oc-card-body">
        <p class="empty-state">No validation checks available.</p>
      </div>
    </div>`;
  }

  const rows = criteria.map(criterion => {
    const { name, result, observedValue, threshold, source } = criterion;

    // Determine badge class based on result
    const badgeClass = {
      pass: 'oc-badge.ok',
      fail: 'oc-badge.danger',
      warn: 'oc-badge.warn',
      missing: 'oc-badge.info',
    }[result];

    // Build observed value display
    const observedDisplay = observedValue !== undefined && observedValue !== null
      ? escapeHtml(String(observedValue))
      : '—';

    // Build threshold display
    const thresholdDisplay = threshold !== undefined && threshold !== null
      ? escapeHtml(String(threshold))
      : '—';

    // Build source link
    const sourceLink = source ? `<a href="${escapeHtml(source)}" class="oc-link">Source</a>` : '';

    return `<div class="oc-evidence-item">
      <span class="oc-evidence-label">Criterion:</span>
      <span class="oc-evidence-name">${escapeHtml(name)}</span>
      <span class="oc-evidence-result ${badgeClass}">${escapeHtml(result)}</span>
      <span class="oc-evidence-detail">Observed: ${escapeHtml(observedDisplay)} | Required: ${escapeHtml(thresholdDisplay)}</span>
      ${sourceLink}
    </div>`;
  }).join('');

  return `<div class="oc-card">
    <div class="oc-card-header">
      <h3 class="oc-card-title">Validation &amp; Risk Checks</h3>
    </div>
    <div class="oc-card-body">
      <ul class="oc-evidence-list">
        ${rows}
      </ul>
    </div>
  </div>`;
}
