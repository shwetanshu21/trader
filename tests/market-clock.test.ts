// ── Market Clock unit tests ──

import { describe, it, expect } from 'vitest';
import { MarketPhase } from '../src/types/runtime.js';
import { MarketClock } from '../src/runtime/market-clock.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a UTC Date for a given calendar date + time in India (Asia/Kolkata = UTC+5:30). */
function indiaTime(
  year: number,
  month: number,  // 1-indexed
  day: number,
  hours: number,
  minutes: number = 0,
  seconds: number = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hours - 5, minutes - 30, seconds));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const clock = new MarketClock(INDIA_NSE_EQ_MARKET);

// A few reference times
const PRE_MARKET_TIME   = indiaTime(2025, 1, 6, 9, 5, 0);   // Mon 09:05 IST → PreMarket
const REGULAR_TIME      = indiaTime(2025, 1, 6, 12, 0, 0);  // Mon 12:00 IST → Regular
const POST_MARKET_TIME  = indiaTime(2025, 1, 6, 15, 45, 0); // Mon 15:45 IST → PostMarket
const CLOSED_AFTER      = indiaTime(2025, 1, 6, 16, 30, 0); // Mon 16:30 IST → Closed
const SATURDAY          = indiaTime(2025, 1, 4, 12, 0, 0);  // Sat 12:00 IST → Closed
const SUNDAY            = indiaTime(2025, 1, 5, 12, 0, 0);  // Sun 12:00 IST → Closed
const HOLIDAY           = indiaTime(2025, 8, 15, 12, 0, 0); // Fri Independence Day → Closed
const BEFORE_OPEN       = indiaTime(2025, 1, 6, 8, 30, 0);  // Mon 08:30 IST → Closed

// ---------------------------------------------------------------------------
// Phase queries
// ---------------------------------------------------------------------------

describe('MarketClock.getPhase', () => {
  it('delegates to profile.getPhase', () => {
    expect(clock.getPhase(REGULAR_TIME)).toBe(MarketPhase.Regular);
    expect(clock.getPhase(PRE_MARKET_TIME)).toBe(MarketPhase.PreMarket);
    expect(clock.getPhase(POST_MARKET_TIME)).toBe(MarketPhase.PostMarket);
    expect(clock.getPhase(CLOSED_AFTER)).toBe(MarketPhase.Closed);
  });
});

describe('MarketClock.isOpen', () => {
  it('returns true for PreMarket', () => {
    expect(clock.isOpen(PRE_MARKET_TIME)).toBe(true);
  });

  it('returns true for Regular', () => {
    expect(clock.isOpen(REGULAR_TIME)).toBe(true);
  });

  it('returns true for PostMarket', () => {
    expect(clock.isOpen(POST_MARKET_TIME)).toBe(true);
  });

  it('returns false for Closed', () => {
    expect(clock.isOpen(CLOSED_AFTER)).toBe(false);
    expect(clock.isOpen(SATURDAY)).toBe(false);
    expect(clock.isOpen(SUNDAY)).toBe(false);
  });
});

describe('MarketClock.isRegularSession', () => {
  it('returns true during Regular', () => {
    expect(clock.isRegularSession(REGULAR_TIME)).toBe(true);
  });

  it('returns false during PreMarket', () => {
    expect(clock.isRegularSession(PRE_MARKET_TIME)).toBe(false);
  });

  it('returns false during PostMarket', () => {
    expect(clock.isRegularSession(POST_MARKET_TIME)).toBe(false);
  });

  it('returns false when Closed', () => {
    expect(clock.isRegularSession(CLOSED_AFTER)).toBe(false);
  });
});

describe('MarketClock.isClosed', () => {
  it('returns true when market is closed', () => {
    expect(clock.isClosed(CLOSED_AFTER)).toBe(true);
    expect(clock.isClosed(SATURDAY)).toBe(true);
    expect(clock.isClosed(SUNDAY)).toBe(true);
    expect(clock.isClosed(HOLIDAY)).toBe(true);
  });

  it('returns false when market is open', () => {
    expect(clock.isClosed(REGULAR_TIME)).toBe(false);
    expect(clock.isClosed(PRE_MARKET_TIME)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Time-until-boundary calculations
// ---------------------------------------------------------------------------

describe('MarketClock.timeUntilNextOpen', () => {
  it('returns 0 if already open (Regular)', () => {
    expect(clock.timeUntilNextOpen(REGULAR_TIME)).toBe(0);
  });

  it('returns 0 if already open (PreMarket)', () => {
    expect(clock.timeUntilNextOpen(PRE_MARKET_TIME)).toBe(0);
  });

  it('returns 0 if already open (PostMarket)', () => {
    expect(clock.timeUntilNextOpen(POST_MARKET_TIME)).toBe(0);
  });

  it('returns ms until next PreMarket when called BeforeOpen (same day)', () => {
    // 08:30 IST → next open is PreMarket at 09:00 IST = 30 min
    const expectedMs = 30 * 60_000;
    const result = clock.timeUntilNextOpen(BEFORE_OPEN);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(expectedMs + 1000);
  });

  it('returns ms until Monday PreMarket when called on Saturday', () => {
    // Sat 12:00 IST → Mon 09:00 IST = ~45 hours
    const result = clock.timeUntilNextOpen(SATURDAY);
    expect(result).toBeGreaterThan(44 * 3600_000);
    expect(result).toBeLessThan(46 * 3600_000 + 1000);
  });

  it('returns ms until next open when called after close on a trading day', () => {
    // Mon 16:30 IST → Tue 09:00 IST = ~16.5 hours
    const result = clock.timeUntilNextOpen(CLOSED_AFTER);
    expect(result).toBeGreaterThan(16 * 3600_000);
    expect(result).toBeLessThan(17 * 3600_000 + 1000);
  });

  it('returns a finite value for a holiday (next trading day)', () => {
    // Friday holiday → next open is Monday
    const result = clock.timeUntilNextOpen(HOLIDAY);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(4 * 24 * 3600_000);
  });
});

describe('MarketClock.timeUntilNextClose', () => {
  it('returns ms until PreMarket ends when called during PreMarket', () => {
    // 09:05 IST → PreMarket closes at 09:15 IST = 10 min
    const result = clock.timeUntilNextClose(PRE_MARKET_TIME);
    expect(result).toBeGreaterThan(9 * 60_000);  // ~10 min
    expect(result).toBeLessThanOrEqual(11 * 60_000);
  });

  it('returns ms until Regular ends when called mid-session', () => {
    // 12:00 IST → Regular closes at 15:30 IST = 210 min
    const result = clock.timeUntilNextClose(REGULAR_TIME);
    expect(result).toBeGreaterThan(209 * 60_000);
    expect(result).toBeLessThanOrEqual(211 * 60_000);
  });

  it('returns ms until PostMarket ends when called during PostMarket', () => {
    // 15:45 IST → PostMarket closes at 16:00 = 15 min
    const result = clock.timeUntilNextClose(POST_MARKET_TIME);
    expect(result).toBeGreaterThan(14 * 60_000);
    expect(result).toBeLessThanOrEqual(16 * 60_000);
  });

  it('returns 0 when already closed', () => {
    expect(clock.timeUntilNextClose(CLOSED_AFTER)).toBe(0);
    expect(clock.timeUntilNextClose(SATURDAY)).toBe(0);
    expect(clock.timeUntilNextClose(HOLIDAY)).toBe(0);
  });
});

describe('MarketClock.timeUntilNextPhaseChange', () => {
  it('returns ms until PreMarket→Regular transition', () => {
    // 09:05 IST → next phase at 09:15 IST = 10 min
    const result = clock.timeUntilNextPhaseChange(PRE_MARKET_TIME);
    expect(result).toBeGreaterThan(9 * 60_000);
    expect(result).toBeLessThanOrEqual(11 * 60_000);
  });

  it('returns ms until Regular→PostMarket transition', () => {
    // 12:00 IST → next phase at 15:30 IST = 210 min
    const result = clock.timeUntilNextPhaseChange(REGULAR_TIME);
    expect(result).toBeGreaterThan(209 * 60_000);
    expect(result).toBeLessThanOrEqual(211 * 60_000);
  });

  it('returns ms until Closed→PreMarket (next day) transition', () => {
    // 16:30 IST → next phase is next day PreMarket at 09:00 IST
    const result = clock.timeUntilNextPhaseChange(CLOSED_AFTER);
    expect(result).toBeGreaterThan(16 * 3600_000);
    expect(result).toBeLessThan(17 * 3600_000 + 1000);
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

describe('MarketClock.summarize', () => {
  it('includes date, time, timezone, and phase during Regular', () => {
    const s = clock.summarize(REGULAR_TIME);
    expect(s).toContain('2025-01-06');
    expect(s).toContain('Asia/Kolkata');
    expect(s).toContain('regular');
  });

  it('includes the holiday name on a holiday', () => {
    const s = clock.summarize(HOLIDAY);
    expect(s).toContain('holiday');
    expect(s).toContain('Independence Day');
  });

  it('includes "closed" for a closed market', () => {
    const s = clock.summarize(CLOSED_AFTER);
    expect(s).toContain('closed');
  });
});

// ---------------------------------------------------------------------------
// Factory convenience
// ---------------------------------------------------------------------------

describe('createClock', () => {
  it('returns a MarketClock instance', async () => {
    const { createClock } = await import('../src/runtime/market-clock.js');
    const c = createClock(INDIA_NSE_EQ_MARKET);
    expect(c).toBeInstanceOf(MarketClock);
    expect(c.getProfile()).toBe(INDIA_NSE_EQ_MARKET);
  });
});
