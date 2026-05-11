// ── Market Profile unit tests ──

import { describe, it, expect } from 'vitest';
import { MarketPhase } from '../src/types/runtime.js';
import {
  formatMarketDate,
  getMarketDayOfWeek,
  getMarketTime,
  parseSessionTime,
  calculatePhase,
} from '../src/market/market-profile.js';
import {
  INDIA_NSE_EQ_MARKET,
  INDIA_NSE_FO_MARKET,
  INDIA_MARKETS,
} from '../src/market/india-profile.js';

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

// A known trading Monday in 2025 (not a holiday)
const TRADING_MONDAY = indiaTime(2025, 1, 6, 9, 30); // 09:30 IST on Mon Jan 6

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

describe('formatMarketDate', () => {
  it('returns YYYY-MM-DD in the target timezone', () => {
    // 2025-01-06 00:00 UTC = 2025-01-06 05:30 IST
    const utc = new Date(Date.UTC(2025, 0, 6, 0, 0, 0));
    expect(formatMarketDate(utc, 'Asia/Kolkata')).toBe('2025-01-06');
  });

  it('handles date that rolls over in target timezone', () => {
    // 2025-01-05 20:00 UTC = 2025-01-06 01:30 IST (next day)
    const utc = new Date(Date.UTC(2025, 0, 5, 20, 0, 0));
    expect(formatMarketDate(utc, 'Asia/Kolkata')).toBe('2025-01-06');
  });
});

describe('getMarketDayOfWeek', () => {
  it('returns 1 for Monday in India timezone', () => {
    // 2025-01-06 00:00 UTC = Monday in India
    const utc = new Date(Date.UTC(2025, 0, 6, 0, 0, 0));
    expect(getMarketDayOfWeek(utc, 'Asia/Kolkata')).toBe(1);
  });

  it('returns 0 for Sunday', () => {
    // 2025-01-05 00:00 UTC = Sunday
    const utc = new Date(Date.UTC(2025, 0, 5, 0, 0, 0));
    expect(getMarketDayOfWeek(utc, 'Asia/Kolkata')).toBe(0);
  });

  it('returns 6 for Saturday', () => {
    // 2025-01-04 00:00 UTC = Saturday
    const utc = new Date(Date.UTC(2025, 0, 4, 0, 0, 0));
    expect(getMarketDayOfWeek(utc, 'Asia/Kolkata')).toBe(6);
  });
});

describe('getMarketTime', () => {
  it('extracts hours and minutes in the target timezone', () => {
    // 2025-01-06 03:30 UTC = 09:00 IST
    const utc = new Date(Date.UTC(2025, 0, 6, 3, 30, 0));
    const t = getMarketTime(utc, 'Asia/Kolkata');
    expect(t.hours).toBe(9);
    expect(t.minutes).toBe(0);
  });

  it('handles times that roll over to the next day', () => {
    // 2025-01-05 23:30 UTC = 2025-01-06 05:00 IST
    const utc = new Date(Date.UTC(2025, 0, 5, 23, 30, 0));
    const t = getMarketTime(utc, 'Asia/Kolkata');
    expect(t.hours).toBe(5);
    expect(t.minutes).toBe(0);
  });
});

describe('parseSessionTime', () => {
  it('converts 09:15 to 555 minutes', () => {
    const { openMinutes } = parseSessionTime({ open: '09:15', close: '15:30' });
    expect(openMinutes).toBe(9 * 60 + 15); // 555
  });

  it('converts 15:30 to 930 minutes', () => {
    const { closeMinutes } = parseSessionTime({ open: '09:15', close: '15:30' });
    expect(closeMinutes).toBe(15 * 60 + 30); // 930
  });
});

// ---------------------------------------------------------------------------
// India NSE EQ profile — phase calculation
// ---------------------------------------------------------------------------

describe('INDIA_NSE_EQ_MARKET', () => {
  const profile = INDIA_NSE_EQ_MARKET;

  describe('getPhase', () => {
    it('returns PreMarket at 09:00 IST on a trading day', () => {
      const dt = indiaTime(2025, 1, 6, 9, 0, 0); // Mon
      expect(profile.getPhase(dt)).toBe(MarketPhase.PreMarket);
    });

    it('returns PreMarket at 09:14 IST on a trading day', () => {
      const dt = indiaTime(2025, 1, 6, 9, 14, 30);
      expect(profile.getPhase(dt)).toBe(MarketPhase.PreMarket);
    });

    it('returns Regular at 09:15 IST on a trading day', () => {
      const dt = indiaTime(2025, 1, 6, 9, 15, 0);
      expect(profile.getPhase(dt)).toBe(MarketPhase.Regular);
    });

    it('returns Regular at 15:29 IST on a trading day', () => {
      const dt = indiaTime(2025, 1, 6, 15, 29, 59);
      expect(profile.getPhase(dt)).toBe(MarketPhase.Regular);
    });

    it('returns PostMarket at 15:30 IST on a trading day', () => {
      const dt = indiaTime(2025, 1, 6, 15, 30, 0);
      expect(profile.getPhase(dt)).toBe(MarketPhase.PostMarket);
    });

    it('returns PostMarket at 15:59 IST on a trading day', () => {
      const dt = indiaTime(2025, 1, 6, 15, 59, 59);
      expect(profile.getPhase(dt)).toBe(MarketPhase.PostMarket);
    });

    it('returns Closed at 16:00 IST on a trading day', () => {
      const dt = indiaTime(2025, 1, 6, 16, 0, 0);
      expect(profile.getPhase(dt)).toBe(MarketPhase.Closed);
    });

    it('returns Closed before PreMarket opens (08:59 IST)', () => {
      const dt = indiaTime(2025, 1, 6, 8, 59, 59);
      expect(profile.getPhase(dt)).toBe(MarketPhase.Closed);
    });

    it('returns Closed on Saturday', () => {
      const dt = indiaTime(2025, 1, 4, 10, 0, 0); // Sat 10:00 IST
      expect(profile.getPhase(dt)).toBe(MarketPhase.Closed);
    });

    it('returns Closed on Sunday', () => {
      const dt = indiaTime(2025, 1, 5, 10, 0, 0); // Sun 10:00 IST
      expect(profile.getPhase(dt)).toBe(MarketPhase.Closed);
    });

    it('returns Closed on a known holiday (Republic Day 2025-01-26)', () => {
      // Jan 26, 2025 is a Sunday — so it's already closed. Let's pick a weekday holiday.
      const dt = indiaTime(2025, 8, 15, 10, 0, 0); // Independence Day (Friday)
      expect(profile.getPhase(dt)).toBe(MarketPhase.Closed);
    });

    it('returns Regular on a normal trading day mid-session', () => {
      const dt = indiaTime(2025, 6, 16, 12, 0, 0); // Mon Jun 16, 12:00 IST
      expect(profile.getPhase(dt)).toBe(MarketPhase.Regular);
    });
  });

  describe('isTradingDay', () => {
    it('returns true for a weekday that is not a holiday', () => {
      const dt = indiaTime(2025, 1, 6, 10, 0, 0); // Mon Jan 6
      expect(profile.isTradingDay(dt)).toBe(true);
    });

    it('returns false for Saturday', () => {
      const dt = indiaTime(2025, 1, 4, 10, 0, 0);
      expect(profile.isTradingDay(dt)).toBe(false);
    });

    it('returns false for Sunday', () => {
      const dt = indiaTime(2025, 1, 5, 10, 0, 0);
      expect(profile.isTradingDay(dt)).toBe(false);
    });

    it('returns false for a holiday (Independence Day 2025-08-15)', () => {
      const dt = indiaTime(2025, 8, 15, 10, 0, 0); // Friday
      expect(profile.isTradingDay(dt)).toBe(false);
    });
  });

  describe('metadata', () => {
    it('has correct market identity', () => {
      expect(profile.marketId).toBe('INDIA_NSE_EQ');
      expect(profile.displayName).toBe('NSE India Equities');
      expect(profile.timezone).toBe('Asia/Kolkata');
    });

    it('has correct session definitions', () => {
      expect(profile.regularSession).toEqual({ open: '09:15', close: '15:30' });
      expect(profile.preMarketSession).toEqual({ open: '09:00', close: '09:15' });
      expect(profile.postMarketSession).toEqual({ open: '15:30', close: '16:00' });
    });

    it('has correct trading rules', () => {
      expect(profile.settlementCycle).toBe('T+1');
      expect(profile.lotSizeType).toBe('exchange_defined');
      expect(profile.maxOrdersPerSecond).toBe(10);
      expect(profile.extendedHoursAllowed).toBe(false);
      expect(profile.observesDst).toBe(false);
    });
  });

  describe('calendar', () => {
    it('returns holiday name for a known holiday date', () => {
      const result = profile.calendar.getHoliday('2025-12-25');
      expect(result).toBe('Christmas');
    });

    it('returns null for a non-holiday date', () => {
      const result = profile.calendar.getHoliday('2025-01-06');
      expect(result).toBeNull();
    });

    it('lists holidays for a given year', () => {
      const holidays = profile.calendar.listHolidays(2025);
      expect(holidays.length).toBeGreaterThan(10);
      expect(holidays.find(h => h.name === 'Republic Day')).toBeDefined();
      expect(holidays.find(h => h.name === 'Christmas')).toBeDefined();
    });

    it('returns empty list for unknown year', () => {
      expect(profile.calendar.listHolidays(2030)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// India NSE FO profile
// ---------------------------------------------------------------------------

describe('INDIA_NSE_FO_MARKET', () => {
  const fo = INDIA_NSE_FO_MARKET;

  it('has correct market identity', () => {
    expect(fo.marketId).toBe('INDIA_NSE_FO');
    expect(fo.displayName).toBe('NSE India F&O');
  });

  it('uses T+2 settlement for F&O', () => {
    expect(fo.settlementCycle).toBe('T+2');
  });

  it('shares session definitions with EQ profile', () => {
    expect(fo.regularSession).toEqual(INDIA_NSE_EQ_MARKET.regularSession);
    expect(fo.preMarketSession).toEqual(INDIA_NSE_EQ_MARKET.preMarketSession);
    expect(fo.postMarketSession).toEqual(INDIA_NSE_EQ_MARKET.postMarketSession);
  });

  it('computes phases identical to EQ profile', () => {
    const dt = indiaTime(2025, 6, 16, 12, 0, 0);
    expect(fo.getPhase(dt)).toBe(INDIA_NSE_EQ_MARKET.getPhase(dt));
  });
});

// ---------------------------------------------------------------------------
// Market list
// ---------------------------------------------------------------------------

describe('INDIA_MARKETS', () => {
  it('contains both EQ and FO profiles', () => {
    expect(INDIA_MARKETS).toHaveLength(2);
    expect(INDIA_MARKETS.map(m => m.marketId).sort()).toEqual([
      'INDIA_NSE_EQ',
      'INDIA_NSE_FO',
    ]);
  });
});
