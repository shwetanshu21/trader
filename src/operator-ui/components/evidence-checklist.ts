import {
  renderExplainabilityEvidenceChecklist,
  type ExplainabilityEvidenceChecklistOptions,
  type ExplainabilityEvidenceItem,
} from './explainability.js';

export interface EvidenceChecklistCriterion {
  name: string;
  result: 'pass' | 'fail' | 'warn' | 'missing';
  observedValue?: string | number | null;
  threshold?: string | number | null;
  source?: {
    label: string;
    href?: string | null;
  } | null;
  note?: string | null;
}

export interface EvidenceChecklistInput {
  title?: string;
  criteria: ReadonlyArray<EvidenceChecklistCriterion> | null;
  emptyMessage?: string;
  boundedWindow?: ExplainabilityEvidenceChecklistOptions['boundedWindow'];
}

function toExplainabilityItem(criterion: EvidenceChecklistCriterion): ExplainabilityEvidenceItem {
  return {
    label: criterion.name,
    verdict: criterion.result,
    observedValue: criterion.observedValue ?? null,
    expectedValue: criterion.threshold ?? null,
    note: criterion.note ?? null,
    sourceLabel: criterion.source?.label ?? null,
    sourceHref: criterion.source?.href ?? null,
  };
}

export function renderEvidenceChecklist(input: EvidenceChecklistInput | null): string {
  return renderExplainabilityEvidenceChecklist({
    title: input?.title ?? 'Validation & Risk Checks',
    items: input?.criteria?.map(toExplainabilityItem) ?? null,
    emptyMessage: input?.emptyMessage ?? 'No validation or risk checks were persisted.',
    boundedWindow: input?.boundedWindow ?? null,
  });
}
