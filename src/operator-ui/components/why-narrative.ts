import type {
  OperatorDecisionDetail,
  OperatorDecisionReasonDetail,
  OperatorExecutionAttemptDetail,
} from '../../types/runtime.js';
import {
  renderExplainabilityEvidenceChecklist,
  renderExplainabilityStack,
  renderExplainabilityWhat,
  renderExplainabilityWhyNarrative,
  type ExplainabilityEvidenceItem,
} from './explainability.js';

export interface WhyNarrativeInput {
  decisionId: OperatorDecisionDetail['decisionId'];
  decisionStatus: OperatorDecisionDetail['decisionStatus'];
  strategyId: OperatorDecisionDetail['strategyId'];
  strategyVersion: OperatorDecisionDetail['strategyVersion'];
  trade: Pick<OperatorDecisionDetail['trade'], 'exchange' | 'tradingsymbol' | 'side'>;
  reasons: OperatorDecisionReasonDetail[];
  executionAttempt: Pick<OperatorExecutionAttemptDetail, 'executionMode' | 'status' | 'outcomeCode' | 'refusalReasons'> | null;
}

function buildNarrativeSummary(explanation: WhyNarrativeInput): string | null {
  if (explanation.reasons.length > 0) {
    return explanation.reasons[0]?.reasonMessage ?? null;
  }

  if (explanation.executionAttempt?.outcomeCode) {
    return `Decision ${explanation.decisionStatus} with downstream outcome ${explanation.executionAttempt.outcomeCode}.`;
  }

  return null;
}

function buildEvidenceItems(explanation: WhyNarrativeInput): ExplainabilityEvidenceItem[] {
  const items: ExplainabilityEvidenceItem[] = [
    {
      label: 'Decision status',
      verdict: explanation.decisionStatus === 'approved' ? 'pass' : 'warn',
      observedValue: explanation.decisionStatus,
      expectedValue: 'approved or refused',
      note: 'Persisted decision state from the operator detail read model.',
    },
  ];

  if (explanation.executionAttempt) {
    items.push(
      {
        label: 'Execution mode',
        verdict: explanation.executionAttempt.executionMode === 'blocked' ? 'warn' : 'pass',
        observedValue: explanation.executionAttempt.executionMode,
        expectedValue: 'blocked, paper, or live',
        note: 'Recorded on the linked execution attempt.',
      },
      {
        label: 'Execution status',
        verdict: explanation.executionAttempt.status === 'failed'
          ? 'fail'
          : explanation.executionAttempt.status === 'refused'
            ? 'warn'
            : 'pass',
        observedValue: explanation.executionAttempt.status,
        expectedValue: 'pending, completed, refused, or failed',
        note: explanation.executionAttempt.outcomeCode
          ? `Outcome ${explanation.executionAttempt.outcomeCode}.`
          : 'No outcome code persisted.',
      },
      {
        label: 'Refusal reasons',
        verdict: explanation.executionAttempt.refusalReasons.length > 0 ? 'warn' : 'missing',
        observedValue: explanation.executionAttempt.refusalReasons.length,
        expectedValue: '0 or more persisted refusal reasons',
        note: explanation.executionAttempt.refusalReasons.length > 0
          ? explanation.executionAttempt.refusalReasons.map(reason => `${reason.reasonCode}: ${reason.reasonMessage}`).join(' | ')
          : 'No refusal reasons were recorded for this execution attempt.',
      },
    );
  } else {
    items.push({
      label: 'Execution evidence',
      verdict: 'missing',
      observedValue: 'unconsumed',
      expectedValue: 'linked execution attempt',
      note: 'No execution attempt has been recorded for this decision yet.',
    });
  }

  return items;
}

export function renderWhyNarrativeCard(explanation: WhyNarrativeInput | null): string {
  if (!explanation) {
    return renderExplainabilityWhyNarrative({
      title: 'Why Narrative',
      summary: null,
      emptyMessage: 'No explainability narrative is available for this decision.',
    });
  }

  const summary = buildNarrativeSummary(explanation);
  const bullets = explanation.reasons.map(reason => `${reason.reasonCode}: ${reason.reasonMessage}`);
  const evidenceItems = buildEvidenceItems(explanation);

  return renderExplainabilityStack([
    renderExplainabilityWhat([
      { label: 'Decision', value: `#${explanation.decisionId}` },
      { label: 'Instrument', value: `${explanation.trade.exchange}:${explanation.trade.tradingsymbol}` },
      { label: 'Side', value: explanation.trade.side },
      { label: 'Strategy', value: `${explanation.strategyId}@${explanation.strategyVersion}` },
      {
        label: 'Execution',
        value: explanation.executionAttempt?.status ?? 'unconsumed',
        meta: explanation.executionAttempt?.outcomeCode ?? null,
      },
    ], 'No decision summary evidence was persisted.'),
    renderExplainabilityWhyNarrative({
      title: 'Why Narrative',
      summary,
      bullets,
      emptyMessage: 'No decision reasons were persisted for this decision.',
    }),
    renderExplainabilityEvidenceChecklist({
      title: 'Evidence',
      items: evidenceItems,
      emptyMessage: 'No explainability evidence was persisted for this decision.',
    }),
  ]);
}
