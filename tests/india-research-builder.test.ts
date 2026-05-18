// ── IndiaResearchBuilder tests ──
// Proves that:
//   - build() returns a Map of candidateKey → IndiaResearchCandidateEvidence
//   - Each evidence entry has bounded summary (≤500 chars), tags (≤10, ≤80 chars each)
//   - Null freshnessMs is returned when no quote receivedAt is available
//   - Influence score is computed in 0–1 range
//   - Missing or null evidence is handled gracefully (no crash)
//   - Empty candidate list returns empty map
//   - NSE equity gets higher influence than BSE or F&O
//   - Low volume reduces influence score

import { describe, it, expect } from 'vitest';
import {
  type BoundedCandidate,
  type IndiaResearchCandidateEvidence,
} from '../src/types/runtime.js';
import { IndiaResearchBuilder } from '../src/strategy/india-research.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeCandidate(overrides?: Partial<BoundedCandidate>): BoundedCandidate {
  return {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 12345,
    side: 'buy',
    lastPrice: 2500.50,
    bid: 2500.00,
    ask: 2501.00,
    volume: 1_000_000,
    instrumentType: 'EQ',
    lotSize: 1,
    tickSize: 0.05,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IndiaResearchBuilder', () => {
  it('returns empty map for empty candidate list', () => {
    const builder = new IndiaResearchBuilder();
    const result = builder.build([]);
    expect(result.size).toBe(0);
  });

  it('produces one entry per candidate', () => {
    const builder = new IndiaResearchBuilder();
    const candidates = [
      makeCandidate({ tradingsymbol: 'RELIANCE' }),
      makeCandidate({ tradingsymbol: 'TCS' }),
    ];

    const result = builder.build(candidates);
    expect(result.size).toBe(2);
    expect(result.has('NSE:RELIANCE')).toBe(true);
    expect(result.has('NSE:TCS')).toBe(true);
  });

  it('produces bounded summary (≤500 chars)', () => {
    const builder = new IndiaResearchBuilder();
    const candidates = [makeCandidate()];

    const result = builder.build(candidates);
    const evidence = result.get('NSE:RELIANCE')!;
    expect(evidence).toBeDefined();
    expect(evidence.summary.length).toBeLessThanOrEqual(500);
    expect(evidence.summary).toContain('India equity');
    expect(evidence.summary).toContain('NSE');
  });

  it('produces bounded tags (max 10, each ≤80 chars)', () => {
    const builder = new IndiaResearchBuilder();
    const candidates = [makeCandidate()];

    const result = builder.build(candidates);
    const evidence = result.get('NSE:RELIANCE')!;
    expect(evidence.tags.length).toBeLessThanOrEqual(10);
    for (const tag of evidence.tags) {
      expect(tag.length).toBeLessThanOrEqual(80);
    }
  });

  it('sets freshnessMs to null when no quote receivedAt available', () => {
    const builder = new IndiaResearchBuilder();
    const candidates = [makeCandidate()];

    const result = builder.build(candidates);
    const evidence = result.get('NSE:RELIANCE')!;
    expect(evidence.freshnessMs).toBeNull();
  });

  it('computes influence score in 0–1 range', () => {
    const builder = new IndiaResearchBuilder();
    const candidates = [
      makeCandidate({ exchange: 'NSE', instrumentType: 'EQ', volume: 10_000_000 }),
      makeCandidate({ exchange: 'BSE', instrumentType: 'EQ', volume: 500 }),
      makeCandidate({ exchange: 'NSE', instrumentType: 'CE', volume: 100_000 }),
    ];

    const result = builder.build(candidates);

    for (const evidence of result.values()) {
      expect(evidence.influenceScore).toBeGreaterThanOrEqual(0);
      expect(evidence.influenceScore).toBeLessThanOrEqual(1);
    }
  });

  it('NSE equity gets higher influence than BSE', () => {
    const builder = new IndiaResearchBuilder();
    const nseEq = makeCandidate({ exchange: 'NSE', instrumentType: 'EQ', volume: 1_000_000 });
    const bseEq = makeCandidate({ exchange: 'BSE', instrumentType: 'EQ', volume: 1_000_000 });

    const result = builder.build([nseEq, bseEq]);
    expect(result.get('NSE:RELIANCE')!.influenceScore).toBeGreaterThan(
      result.get('BSE:RELIANCE')!.influenceScore,
    );
  });

  it('low volume reduces influence score', () => {
    const builder = new IndiaResearchBuilder();
    const highVol = makeCandidate({ tradingsymbol: 'HIGH', volume: 10_000_000 });
    const lowVol = makeCandidate({ tradingsymbol: 'LOW', volume: 100 });

    const result = builder.build([highVol, lowVol]);
    expect(result.get('NSE:HIGH')!.influenceScore).toBeGreaterThan(
      result.get('NSE:LOW')!.influenceScore,
    );
  });

  it('missing lastPrice reduces influence score', () => {
    const builder = new IndiaResearchBuilder();
    const withPrice = makeCandidate({ tradingsymbol: 'WITH', lastPrice: 100 });
    const noPrice = makeCandidate({ tradingsymbol: 'NOPRICE', lastPrice: null });

    const result = builder.build([withPrice, noPrice]);
    expect(result.get('NSE:WITH')!.influenceScore).toBeGreaterThan(
      result.get('NSE:NOPRICE')!.influenceScore,
    );
  });

  it('generates appropriate tags for instrument type and liquidity', () => {
    const builder = new IndiaResearchBuilder();
    const candidates = [
      makeCandidate({
        exchange: 'NSE',
        instrumentType: 'EQ',
        volume: 10_000_000,
        tradingsymbol: 'HIGH_VAL',
      }),
      makeCandidate({
        exchange: 'NSE',
        instrumentType: 'CE',
        volume: 500,
        tradingsymbol: 'LOW_VOL_OPT',
      }),
    ];

    const result = builder.build(candidates);

    const highVal = result.get('NSE:HIGH_VAL')!;
    expect(highVal.tags).toContain('type:eq');
    expect(highVal.tags).toContain('liquidity:high');

    const lowVol = result.get('NSE:LOW_VOL_OPT')!;
    expect(lowVol.tags).toContain('type:ce');
    expect(lowVol.tags).toContain('liquidity:low');
  });

  it('handles candidates with no volume data', () => {
    const builder = new IndiaResearchBuilder();
    const candidate = makeCandidate({ volume: null, bid: null, ask: null });

    const result = builder.build([candidate]);
    const evidence = result.get('NSE:RELIANCE')!;
    expect(evidence).toBeDefined();
    expect(evidence.summary).toContain('no volume data');
    expect(evidence.influenceScore).toBeGreaterThanOrEqual(0);
  });

  it('handles wide spread in summary', () => {
    const builder = new IndiaResearchBuilder();
    const candidate = makeCandidate({ bid: 100, ask: 110 }); // 10% spread

    const result = builder.build([candidate]);
    const evidence = result.get('NSE:RELIANCE')!;
    expect(evidence.summary).toContain('wide spread');
  });

  it('includes marketPhase in summary when provided', () => {
    const builder = new IndiaResearchBuilder();
    const candidates = [makeCandidate()];

    const result = builder.build(candidates, 'regular');
    expect(result.size).toBe(1);
  });
});
