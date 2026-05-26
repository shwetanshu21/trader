// ── Why Narrative Card (Explanation Component) ──
// Plain-English explanation for a trade, block, promotion, or selection.
// Source evidence must exist; otherwise show MissingEvidenceCallout.

import type { TradeDecisionExplanation } from '../types/contracts.js';

/**
 * Render a WhyNarrativeCard component.
 * Shows the plain English reason, reason bullets, evidence pills, and source links.
 */
export function renderWhyNarrativeCard(
  explanation: TradeDecisionExplanation | null,
): string {
  if (!explanation) {
    return `<div class="oc-card">
      <div class="oc-card-header">
        <h3 class="oc-card-title">Why Narrative</h3>
      </div>
      <div class="oc-card-body">
        <p class="empty-state">No explanation available.</p>
      </div>
    </div>`;
  }

  const {
    decisionId,
    symbol,
    side,
    strategyId,
    strategyVersion,
    executionMode,
    primaryReason,
    riskResult,
    executionResult,
    validatorResult,
    orderId,
    fillId,
    fillPrice,
    realizedPnl,
    unrealizedPnl,
  } = explanation;

  // Build title based on execution context
  const titlePrefix = executionMode === 'blocked'
    ? 'Why this order was blocked'
    : executionMode === 'paper'
    ? 'Paper execution reason'
    : 'Why this decision happened';

  const title = `${titlePrefix} for ${escapeHtml(symbol)} ${side}`;

  // Build summary sentence
  let summary: string;
  if (!primaryReason) {
    summary = 'Evidence not captured yet. Add the reason field to the read model before showing this narrative.';
  } else {
    summary = primaryReason;
  }

  // Build reason bullets from primaryReason if available
  let reasonBullets: string[] = [];
  if (primaryReason) {
    reasonBullets = [escapeHtml(primaryReason)];
  }

  // Build evidence pills
  const evidencePills: string[] = [];
  if (executionResult === 'sent') evidencePills.push('Live order sent');
  if (executionResult === 'paper_filled') evidencePills.push('Paper fill recorded');
  if (executionResult === 'blocked') evidencePills.push('Order blocked');
  if (executionResult === 'failed') evidencePills.push('Execution failed');

  if (riskResult === 'allowed') evidencePills.push('Risk allowed');
  if (riskResult === 'blocked') evidencePills.push('Risk blocked');
  if (riskResult === 'warn') evidencePills.push('Risk warned');
  if (validatorResult === 'pass') evidencePills.push('Validator passed');
  if (validatorResult === 'fail') evidencePills.push('Validator failed');

  // Build source links
  const sourceLinks: string[] = [];
  if (decisionId) sourceLinks.push(`/decision?id=${decisionId}`);
  if (orderId) sourceLinks.push(`Order: ${orderId}`);
  if (fillId) sourceLinks.push(`Fill: ${fillId}`);

  const pillHtml = evidencePills.length > 0
    ? `<div class="oc-evidence-list">
        ${evidencePills.map(pill => `<li class="oc-evidence-item">
          <span class="oc-evidence-label">Evidence:</span>
          <span>${escapeHtml(pill)}</span>
        </li>`).join('')}
      </div>`
    : '';

  const linksHtml = sourceLinks.length > 0
    ? `<div class="oc-source-links">
        ${sourceLinks.map(link => `<a href="${escapeHtml(link)}" class="oc-link">Source</a>`).join('')}
      </div>`
    : '';

  return `<div class="oc-card">
    <div class="oc-card-header">
      <h3 class="oc-card-title">${title}</h3>
    </div>
    <div class="oc-card-body">
      <p class="oc-reason">${summary}</p>
      ${reasonBullets.length > 0 ? `<ul class="oc-reason-bullets">
        ${reasonBullets.map(bullet => `<li>${escapeHtml(bullet)}</li>`).join('')}
      </ul>` : ''}
      ${pillHtml}
      ${linksHtml}
    </div>
  </div>`;
}
