// ── ReplayClock unit tests ──

import { describe, it, expect } from 'vitest';
import { ReplayFidelity } from '../src/replay/types.js';
import { ReplayClock, createReplayClock } from '../src/replay/replay-clock.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert calendar date to UTC ms (India = UTC+5:30). */
function utcMs(
  year: number,
  month: number, // 1-indexed
  day: number,
  hours: number = 0,
  minutes: number = 0,
): number {
  return Date.UTC(year, month - 1, day, hours - 5, minutes - 30);
}

/** Convert a clock-time like 9,15 to UTC ms for a given date. */
function clockTime(year: number, month: number, day: number, hours: number, minutes: number = 0): number {
  return utcMs(year, month, day, hours, minutes);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const clock = new ReplayClock(INDIA_NSE_EQ_MARKET);

// Monday 2025-01-06 (trading day)
const MON_OPEN  = clockTime(2025, 1, 6, 9, 15);  // 09:15 IST
const MON_CLOSE = clockTime(2025, 1, 6, 15, 30); // 15:30 IST

// Tuesday 2025-01-07 (trading day)
const TUE_OPEN  = clockTime(2025, 1, 7, 9, 15);
const TUE_CLOSE = clockTime(2025, 1, 7, 15, 30);

// Saturday 2025-01-04 (non-trading day)
const SAT_OPEN  = clockTime(2025, 1, 4, 9, 15);
const SAT_CLOSE = clockTime(2025, 1, 4, 15, 30);

// Holiday: Friday 2025-08-15 (Independence Day)
const HOLIDAY_OPEN  = clockTime(2025, 8, 15, 9, 15);
const HOLIDAY_CLOSE = clockTime(2025, 8, 15, 15, 30);

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe('ReplayClock constructor', () => {
  it('uses default 5-minute cadence', () => {
    const c = new ReplayClock(INDIA_NSE_EQ_MARKET);
    expect(c.getCadenceMinutes()).toBe(5);
  });

  it('accepts a custom cadence', () => {
    const c = new ReplayClock(INDIA_NSE_EQ_MARKET, 10);
    expect(c.getCadenceMinutes()).toBe(10);
  });

  it('rejects cadence < 1', () => {
    expect(() => new ReplayClock(INDIA_NSE_EQ_MARKET, 0)).toThrow('Cadence must be >= 1 minute');
  });
});

describe('createReplayClock', () => {
  it('returns a ReplayClock instance', () => {
    const c = createReplayClock(INDIA_NSE_EQ_MARKET);
    expect(c).toBeInstanceOf(ReplayClock);
    expect(c.getProfile()).toBe(INDIA_NSE_EQ_MARKET);
  });

  it('accepts optional cadenceMinutes', () => {
    const c = createReplayClock(INDIA_NSE_EQ_MARKET, 15);
    expect(c.getCadenceMinutes()).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Tick generation — single day
// ---------------------------------------------------------------------------

describe('ReplayClock.generateTicks — single day', () => {
  it('generates 75 ticks for a full regular session with default 5-minute cadence', () => {
    // 09:15 to 15:30 = 6h15m = 375 minutes / 5 = 75 ticks
    const ticks = clock.generateTicks(MON_OPEN, MON_CLOSE);
    expect(ticks.length).toBe(75);
  });

  it('each tick has sequential 1-based index and Full fidelity', () => {
    const ticks = clock.generateTicks(MON_OPEN, MON_CLOSE);

    for (let i = 0; i < ticks.length; i++) {
      expect(ticks[i].index).toBe(i + 1);
      expect(ticks[i].fidelity).toBe(ReplayFidelity.Full);
    }
  });

  it('first tick is at 09:15, last tick is at 15:25 (exclusive of close)', () => {
    const ticks = clock.generateTicks(MON_OPEN, MON_CLOSE);

    expect(ticks[0].timestamp).toBe(MON_OPEN);
    // Last tick should be 15:25 (15:30 - 5 min, since exclusive of close)
    expect(ticks[ticks.length - 1].timestamp).toBe(clockTime(2025, 1, 6, 15, 25));
  });

  it('ticks are aligned to cadence boundaries', () => {
    const ticks = clock.generateTicks(MON_OPEN, MON_CLOSE);

    // Each tick should be an exact multiple of 5 minutes past 09:15
    for (let i = 0; i < ticks.length; i++) {
      const offsetMinutes = (ticks[i].timestamp - MON_OPEN) / 60_000;
      expect(offsetMinutes % 5).toBe(0);
    }
  });

  it('returns empty array when range falls entirely outside trading hours', () => {
    // Before market opens
    const beforeOpen = clockTime(2025, 1, 6, 8, 0);
    const atOpen     = clockTime(2025, 1, 6, 8, 59);
    expect(clock.generateTicks(beforeOpen, atOpen)).toEqual([]);

    // After market closes
    const afterClose = clockTime(2025, 1, 6, 16, 0);
    expect(clock.generateTicks(afterClose, afterClose + 3600_000)).toEqual([]);
  });

  it('returns empty array for a non-trading day (Saturday)', () => {
    const ticks = clock.generateTicks(SAT_OPEN, SAT_CLOSE);
    expect(ticks).toEqual([]);
  });

  it('returns empty array for a holiday', () => {
    const ticks = clock.generateTicks(HOLIDAY_OPEN, HOLIDAY_CLOSE);
    expect(ticks).toEqual([]);
  });

  it('returns at least one tick for a partial range covering part of the session', () => {
    // 12:00 to 12:30 should have 6 ticks at 5-min cadence
    const partialStart = clockTime(2025, 1, 6, 12, 0);
    const partialEnd   = clockTime(2025, 1, 6, 12, 30);
    const ticks = clock.generateTicks(partialStart, partialEnd);

    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0].timestamp).toBe(partialStart);
    expect(ticks[ticks.length - 1].timestamp).toBeLessThanOrEqual(partialEnd);
  });

  it('handles a range that starts before open — clips to session', () => {
    // Range from 08:00 to 10:00 should produce ticks from 09:15 to 10:00
    const rangeStart = clockTime(2025, 1, 6, 8, 0);
    const rangeEnd   = clockTime(2025, 1, 6, 10, 0);
    const ticks = clock.generateTicks(rangeStart, rangeEnd);

    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0].timestamp).toBe(MON_OPEN); // clips to open
    expect(ticks[ticks.length - 1].timestamp).toBeLessThanOrEqual(rangeEnd);
  });

  it('handles a range that ends after close — clips to session', () => {
    // Range from 15:00 to 16:00 should produce ticks from 15:00 to 15:25
    const rangeStart = clockTime(2025, 1, 6, 15, 0);
    const rangeEnd   = clockTime(2025, 1, 6, 16, 0);
    const ticks = clock.generateTicks(rangeStart, rangeEnd);

    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[ticks.length - 1].timestamp).toBe(
      clockTime(2025, 1, 6, 15, 25),
    ); // clips to last tick before close
  });
});

// ---------------------------------------------------------------------------
// Tick generation — multi-day ranges
// ---------------------------------------------------------------------------

describe('ReplayClock.generateTicks — multi-day ranges', () => {
  it('generates ticks spanning multiple trading days, skipping weekends', () => {
    // Mon 2025-01-06 to Tue 2025-01-07 (both trading days)
    const ticks = clock.generateTicks(MON_OPEN, TUE_CLOSE);

    expect(ticks.length).toBe(150); // 75 per day × 2

    // Verify Monday ticks
    const monTicks = ticks.filter(t => {
      const d = new Date(t.timestamp);
      return d.getUTCDate() === 6;
    });
    expect(monTicks.length).toBe(75);
    expect(monTicks[0].timestamp).toBe(MON_OPEN);

    // Verify Tuesday ticks
    const tueTicks = ticks.filter(t => {
      const d = new Date(t.timestamp);
      return d.getUTCDate() === 7;
    });
    expect(tueTicks.length).toBe(75);
    expect(tueTicks[0].timestamp).toBe(TUE_OPEN);
  });

  it('skips Saturday and Sunday when range spans a weekend', () => {
    // Fri 2025-01-03 (trading) to Mon 2025-01-06 (trading)
    const friOpen = clockTime(2025, 1, 3, 9, 15);
    const rangeEnd = MON_CLOSE;

    const ticks = clock.generateTicks(friOpen, rangeEnd);

    // Should have 75 ticks for Fri + 75 for Mon = 150 (skip Sat+Sun)
    expect(ticks.length).toBe(150);

    // Verify no Saturday or Sunday ticks
    for (const t of ticks) {
      const d = new Date(t.timestamp);
      const day = d.getUTCDay();
      expect(day).not.toBe(0); // Not Sunday
      expect(day).not.toBe(6); // Not Saturday
    }
  });

  it('skips holidays when range spans a holiday', () => {
    // Thu 2025-08-14 to Mon 2025-08-18 (Aug 15 is Independence Day holiday)
    const thuOpen  = clockTime(2025, 8, 14, 9, 15);
    const friOpen  = clockTime(2025, 8, 15, 9, 15); // holiday
    const monClose = clockTime(2025, 8, 18, 15, 30);
    // Mon Aug 18 is a Monday

    const ticks = clock.generateTicks(thuOpen, monClose);

    // Should not include Aug 15 ticks
    const holidayTicks = ticks.filter(t => {
      const d = new Date(t.timestamp);
      return d.getUTCMonth() === 7 && d.getUTCDate() === 15; // August 15
    });
    expect(holidayTicks).toEqual([]);

    // Should include Thu Aug 14 and Mon Aug 18 ticks
    expect(ticks.length).toBeGreaterThan(0);
  });

  it('uses monotonic sequential indices across days', () => {
    const ticks = clock.generateTicks(MON_OPEN, TUE_CLOSE);

    for (let i = 0; i < ticks.length; i++) {
      expect(ticks[i].index).toBe(i + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// countTicks
// ---------------------------------------------------------------------------

describe('ReplayClock.countTicks', () => {
  it('matches the length of generateTicks for the same range', () => {
    const count = clock.countTicks(MON_OPEN, MON_CLOSE);
    const ticks = clock.generateTicks(MON_OPEN, MON_CLOSE);
    expect(count).toBe(ticks.length);
    expect(count).toBe(75);
  });

  it('returns 0 for a non-trading day', () => {
    expect(clock.countTicks(SAT_OPEN, SAT_CLOSE)).toBe(0);
  });

  it('returns 0 for a holiday', () => {
    expect(clock.countTicks(HOLIDAY_OPEN, HOLIDAY_CLOSE)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getTickAtIndex
// ---------------------------------------------------------------------------

describe('ReplayClock.getTickAtIndex', () => {
  it('returns the correct tick for index 1', () => {
    const tick = clock.getTickAtIndex(MON_OPEN, MON_CLOSE, 1);
    expect(tick).not.toBeNull();
    expect(tick!.index).toBe(1);
    expect(tick!.timestamp).toBe(MON_OPEN);
    expect(tick!.fidelity).toBe(ReplayFidelity.Full);
  });

  it('returns the correct tick for the last index', () => {
    const total = clock.countTicks(MON_OPEN, MON_CLOSE);
    const tick = clock.getTickAtIndex(MON_OPEN, MON_CLOSE, total);
    expect(tick).not.toBeNull();
    expect(tick!.index).toBe(total);
    expect(tick!.timestamp).toBe(clockTime(2025, 1, 6, 15, 25));
  });

  it('returns null for index 0 (out of bounds)', () => {
    expect(clock.getTickAtIndex(MON_OPEN, MON_CLOSE, 0)).toBeNull();
  });

  it('returns null for index beyond total', () => {
    const total = clock.countTicks(MON_OPEN, MON_CLOSE);
    expect(clock.getTickAtIndex(MON_OPEN, MON_CLOSE, total + 1)).toBeNull();
  });

  it('returns null for empty range', () => {
    expect(clock.getTickAtIndex(SAT_OPEN, SAT_CLOSE, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Custom cadence
// ---------------------------------------------------------------------------

describe('ReplayClock — custom cadence', () => {
  it('generates 38 ticks at 10-minute cadence for a full session', () => {
    // 09:15 to 15:30 = 375 min. Ticks at 0,10,20,...,370 = 38 ticks
    const c = new ReplayClock(INDIA_NSE_EQ_MARKET, 10);
    const ticks = c.generateTicks(MON_OPEN, MON_CLOSE);
    expect(ticks.length).toBe(38);
  });

  it('generates 25 ticks at 15-minute cadence for a full session', () => {
    // 09:15 to 15:30 = 375 min / 15 = 25
    const c = new ReplayClock(INDIA_NSE_EQ_MARKET, 15);
    const ticks = c.generateTicks(MON_OPEN, MON_CLOSE);
    expect(ticks.length).toBe(25);
  });

  it('generates 7 ticks at 1-hour cadence for a full session', () => {
    // 09:15 to 15:30 = 6h15m. At 1h cadence: 09:15, 10:15, 11:15, 12:15,
    // 13:15, 14:15, 15:15 → 7 ticks
    const c = new ReplayClock(INDIA_NSE_EQ_MARKET, 60);
    const ticks = c.generateTicks(MON_OPEN, MON_CLOSE);
    expect(ticks.length).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

describe('ReplayClock.summarize', () => {
  it('includes tick count, cadence, and date range for a populated range', () => {
    const s = clock.summarize(MON_OPEN, MON_CLOSE);
    expect(s).toContain('75 ticks');
    expect(s).toContain('5min');
    expect(s).toContain('2025-01-06');
  });

  it('includes "no ticks" for an empty range', () => {
    const s = clock.summarize(SAT_OPEN, SAT_CLOSE);
    expect(s).toContain('no ticks');
  });
});
