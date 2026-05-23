import { describe, expect, it } from 'vitest';

import { canonicalizeHypothesis } from '../src/research/hypothesis-canonicalizer.js';
import type { HypothesisGraph } from '../src/types/runtime.js';

function sampleGraph(): HypothesisGraph {
  return {
    schemaVersion: '1',
    signals: [
      {
        type: 'ema_cross',
        params: {
          slow: 21,
          fast: 8,
          source: 'close',
        },
      },
    ],
    filters: [
      {
        type: 'volume_min',
        params: {
          min: 1000000,
          venue: 'NSE',
        },
      },
    ],
    entryRules: [
      {
        type: 'breakout_confirmed',
        params: {
          lookbackBars: 5,
          requireCloseAbove: true,
        },
      },
    ],
    exitRules: [
      {
        type: 'time_stop',
        params: {
          maxBars: 12,
        },
      },
    ],
    riskRules: [
      {
        type: 'atr_stop',
        params: {
          multiple: 2,
          period: 14,
        },
      },
    ],
    metadata: {
      hypothesis: 'Momentum continuation with breakout confirmation',
      tags: ['intraday', 'trend'],
    },
  };
}

describe('canonicalizeHypothesis', () => {
  it('produces the same canonical identity for equivalent graphs with different key order', () => {
    const a: HypothesisGraph = sampleGraph();
    const b: HypothesisGraph = {
      schemaVersion: '1',
      signals: [
        {
          type: 'ema_cross',
          params: {
            source: 'close',
            fast: 8,
            slow: 21,
          },
        },
      ],
      filters: [
        {
          type: 'volume_min',
          params: {
            venue: 'NSE',
            min: 1000000,
          },
        },
      ],
      entryRules: [
        {
          type: 'breakout_confirmed',
          params: {
            requireCloseAbove: true,
            lookbackBars: 5,
          },
        },
      ],
      exitRules: [
        {
          type: 'time_stop',
          params: {
            maxBars: 12,
          },
        },
      ],
      riskRules: [
        {
          type: 'atr_stop',
          params: {
            period: 14,
            multiple: 2,
          },
        },
      ],
      metadata: {
        tags: ['intraday', 'trend'],
        hypothesis: 'Momentum continuation with breakout confirmation',
      },
    };

    const canonicalA = canonicalizeHypothesis(a);
    const canonicalB = canonicalizeHypothesis(b);

    expect(canonicalA.canonicalJson).toBe(canonicalB.canonicalJson);
    expect(canonicalA.canonicalHash).toBe(canonicalB.canonicalHash);
  });

  it('emits compact canonical JSON without insignificant serialization whitespace', () => {
    const canonical = canonicalizeHypothesis(sampleGraph());

    expect(canonical.canonicalJson).not.toContain('\n');
    expect(canonical.canonicalJson).not.toContain('  ');
    expect(canonical.canonicalJson).toContain('"entryRules"');
    expect(canonical.canonicalJson).toContain('"riskRules"');
  });

  it('omits undefined object values consistently', () => {
    const withUndefined: HypothesisGraph = {
      ...sampleGraph(),
      metadata: {
        hypothesis: 'Momentum continuation with breakout confirmation',
        note: undefined,
        tags: ['intraday', 'trend'],
      },
    };

    const withoutUndefined: HypothesisGraph = sampleGraph();

    const canonicalA = canonicalizeHypothesis(withUndefined);
    const canonicalB = canonicalizeHypothesis(withoutUndefined);

    expect(canonicalA.canonicalJson).toBe(canonicalB.canonicalJson);
    expect(canonicalA.canonicalHash).toBe(canonicalB.canonicalHash);
  });

  it('changes the canonical identity when a semantically relevant parameter changes', () => {
    const baseline = sampleGraph();
    const changed: HypothesisGraph = {
      ...sampleGraph(),
      riskRules: [
        {
          type: 'atr_stop',
          params: {
            multiple: 3,
            period: 14,
          },
        },
      ],
    };

    const canonicalA = canonicalizeHypothesis(baseline);
    const canonicalB = canonicalizeHypothesis(changed);

    expect(canonicalA.canonicalJson).not.toBe(canonicalB.canonicalJson);
    expect(canonicalA.canonicalHash).not.toBe(canonicalB.canonicalHash);
  });
});
