// ── India NSE Market Profile ──
// Immutable singleton for the National Stock Exchange of India.
// Governs execution rules for both EQ (equity) and FO (F&O) segments.

import { MarketPhase } from '../types/runtime.js';
import type { MarketProfile, MarketCalendar } from './market-profile.js';
import {
  calculatePhase,
  isTradingDay,
} from './market-profile.js';

// ---------------------------------------------------------------------------
// NSE holiday calendar (major public holidays)
// ---------------------------------------------------------------------------
// Sources: NSE trading calendar, SEBI circulars.
// Movable holidays (e.g. Holi, Diwali) are year-specific.

const NSE_HOLIDAYS_BY_YEAR: Record<number, Array<{ date: string; name: string }>> = {
  2025: [
    { date: '2025-01-26', name: 'Republic Day' },
    { date: '2025-02-26', name: 'Maha Shivaratri' },
    { date: '2025-03-14', name: 'Holi' },
    { date: '2025-03-31', name: 'Id-ul-Fitr (Ramzan Id)' },
    { date: '2025-04-10', name: 'Mahavir Jayanti' },
    { date: '2025-04-14', name: 'Ambedkar Jayanti' },
    { date: '2025-04-18', name: 'Good Friday' },
    { date: '2025-05-01', name: 'Maharashtra Day' },
    { date: '2025-08-15', name: 'Independence Day' },
    { date: '2025-08-27', name: 'Ganesh Chaturthi' },
    { date: '2025-10-01', name: 'Dussehra' },
    { date: '2025-10-20', name: 'Diwali / Laxmi Pujan' },
    { date: '2025-11-05', name: 'Guru Nanak Jayanti' },
    { date: '2025-12-25', name: 'Christmas' },
  ],
  2026: [
    { date: '2026-01-26', name: 'Republic Day' },
    { date: '2026-02-16', name: 'Maha Shivaratri' },
    { date: '2026-03-03', name: 'Holi' },
    { date: '2026-03-20', name: 'Id-ul-Fitr (Ramzan Id)' },
    { date: '2026-03-29', name: 'Mahavir Jayanti' },
    { date: '2026-04-14', name: 'Ambedkar Jayanti' },
    { date: '2026-04-03', name: 'Good Friday' },
    { date: '2026-05-01', name: 'Maharashtra Day' },
    { date: '2026-08-15', name: 'Independence Day' },
    { date: '2026-08-31', name: 'Ganesh Chaturthi' },
    { date: '2026-09-22', name: 'Dussehra' },
    { date: '2026-11-07', name: 'Diwali / Laxmi Pujan' },
    { date: '2026-11-25', name: 'Guru Nanak Jayanti' },
    { date: '2026-12-25', name: 'Christmas' },
  ],
};

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const nseCalendar: MarketCalendar = {
  getHoliday(marketDate: string): string | null {
    const year = new Date(marketDate).getFullYear();
    const holidays = NSE_HOLIDAYS_BY_YEAR[year];
    if (!holidays) return null;
    return holidays.find(h => h.date === marketDate)?.name ?? null;
  },

  listHolidays(year: number): Array<{ date: string; name: string }> {
    return NSE_HOLIDAYS_BY_YEAR[year] ?? [];
  },
};

// ---------------------------------------------------------------------------
// NSE session definitions (Asia/Kolkata = UTC+5:30)
// ---------------------------------------------------------------------------

const PRE_MARKET = { open: '09:00', close: '09:15' };
const REGULAR    = { open: '09:15', close: '15:30' };
const POST_MARKET = { open: '15:30', close: '16:00' };

// ---------------------------------------------------------------------------
// Market ID constants
// ---------------------------------------------------------------------------

export const INDIA_MARKET_TZ = 'Asia/Kolkata';
export const INDIA_MAX_OPS   = 10;
export const INDIA_SETTLEMENT_EQ = 'T+1';
export const INDIA_SETTLEMENT_FO = 'T+2';

/** NSE Equities market profile. */
export const INDIA_NSE_EQ_MARKET: MarketProfile = {
  marketId: 'INDIA_NSE_EQ',
  displayName: 'NSE India Equities',
  timezone: INDIA_MARKET_TZ,
  regularSession: REGULAR,
  preMarketSession: PRE_MARKET,
  postMarketSession: POST_MARKET,
  settlementCycle: INDIA_SETTLEMENT_EQ,
  lotSizeType: 'exchange_defined',
  maxOrdersPerSecond: INDIA_MAX_OPS,
  extendedHoursAllowed: false,
  observesDst: false,
  calendar: nseCalendar,

  getPhase(utcDate: Date): MarketPhase {
    return calculatePhase(utcDate, this);
  },

  isTradingDay(utcDate: Date): boolean {
    return isTradingDay(utcDate, this);
  },
};

/** NSE Futures & Options market profile (same sessions, T+2 settlement). */
export const INDIA_NSE_FO_MARKET: MarketProfile = {
  ...INDIA_NSE_EQ_MARKET,
  marketId: 'INDIA_NSE_FO',
  displayName: 'NSE India F&O',
  settlementCycle: INDIA_SETTLEMENT_FO,
};

/** All NSE profiles for iteration. */
export const INDIA_MARKETS: readonly MarketProfile[] = [
  INDIA_NSE_EQ_MARKET,
  INDIA_NSE_FO_MARKET,
];

// ---------------------------------------------------------------------------
// Market resolution helpers
// ---------------------------------------------------------------------------

/**
 * Default config path for NSE EQ instruments.
 * Used when no explicit --config-path is provided and market is INDIA_NSE_EQ.
 */
export const INDIA_EQ_CONFIG_PATH = 'data/nifty-500.json';

/**
 * Default config path for NSE FO instruments.
 * Used when no explicit --config-path is provided and market is INDIA_NSE_FO.
 */
export const INDIA_FO_CONFIG_PATH = 'data/nifty-fo.json';

/**
 * Resolve a MarketProfile for a known India market ID.
 *
 * @returns The matching MarketProfile.
 * @throws If the marketId is not in INDIA_MARKETS.
 */
export function resolveIndiaMarketProfile(marketId: string): MarketProfile {
  const profile = INDIA_MARKETS.find(m => m.marketId === marketId);
  if (!profile) {
    throw new Error(
      `Unknown India market ID "${marketId}". Known markets: ${INDIA_MARKETS.map(m => m.marketId).join(', ')}`,
    );
  }
  return profile;
}

/**
 * Resolve the default config path for a given India market ID.
 *
 * Returns the sensible default for the market segment, which callers can
 * override with an explicit --config-path CLI option.
 */
export function resolveIndiaMarketConfigPath(marketId: string): string {
  switch (marketId) {
    case 'INDIA_NSE_FO':
      return INDIA_FO_CONFIG_PATH;
    default:
      return INDIA_EQ_CONFIG_PATH;
  }
}
