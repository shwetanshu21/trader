import { describe, expect, it } from 'vitest';

import {
  buildUpstoxHistoricalDateChunks,
  parseCliDateEnd,
  parseCliDateStart,
} from '../src/replay/upstox-date-range.js';

describe('upstox-date-range helpers', () => {
  it('parses CLI start/end dates as inclusive UTC day bounds', () => {
    expect(new Date(parseCliDateStart('2026-05-16')).toISOString()).toBe('2026-05-16T00:00:00.000Z');
    expect(new Date(parseCliDateEnd('2026-05-16')).toISOString()).toBe('2026-05-16T23:59:59.999Z');
  });

  it('chunks long ranges into <= 28-day historical windows', () => {
    const chunks = buildUpstoxHistoricalDateChunks(
      parseCliDateStart('2026-04-01'),
      parseCliDateEnd('2026-05-16'),
    );

    expect(chunks).toEqual([
      { fromDate: '2026-04-01', toDate: '2026-04-28' },
      { fromDate: '2026-04-29', toDate: '2026-05-16' },
    ]);
  });
});
