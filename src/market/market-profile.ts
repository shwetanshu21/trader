// ── Market Profile — identity, sessions, rules, and phase calculation ──
// Immutable contract that every market jurisdiction must satisfy.
// The execution gateway, risk engine, and RAG router validate against
// the active profile before processing data or staging orders.

import { MarketPhase } from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A time range expressed in local market time (HH:mm, 24-hour). */
export interface MarketSession {
  /** Opening time, e.g. '09:15'. */
  readonly open: string;
  /** Closing time, e.g. '15:30'. */
  readonly close: string;
}

/** Holiday calendar contract. */
export interface MarketCalendar {
  /** Return the holiday name if `marketDate` (YYYY-MM-DD in market TZ) is a holiday, else null. */
  getHoliday(marketDate: string): string | null;
  /** List all known holidays for a given year. */
  listHolidays(year: number): Array<{ date: string; name: string }>;
}

/**
 * Immutable market definition.
 *
 * Every component that touches market data must read the active profile
 * rather than hard-coding assumptions — this is the core abstraction that
 * prevents cross-market contamination (US strategy on Indian asset, etc.).
 */
export interface MarketProfile {
  /** Unique market identifier (e.g. 'INDIA_NSE_EQ'). */
  readonly marketId: string;
  /** Human-readable label (e.g. 'NSE India Equities'). */
  readonly displayName: string;
  /** IANA timezone identifier (e.g. 'Asia/Kolkata'). */
  readonly timezone: string;
  /** Regular trading session (required). */
  readonly regularSession: MarketSession;
  /** Optional pre-market session (e.g. 09:00–09:15 IST). */
  readonly preMarketSession: MarketSession | null;
  /** Optional post-market / closing session (e.g. 15:30–16:00 IST). */
  readonly postMarketSession: MarketSession | null;
  /** Settlement cycle label (e.g. 'T+1' for equity, 'T+2' for F&O). */
  readonly settlementCycle: string;
  /** How lot sizes are determined for derivatives. */
  readonly lotSizeType: 'fixed' | 'exchange_defined';
  /** Maximum orders per second permitted by the exchange / regulator. */
  readonly maxOrdersPerSecond: number;
  /** Whether the exchange allows trading during extended (pre/post) sessions. */
  readonly extendedHoursAllowed: boolean;
  /** True if the market observes daylight saving time transitions. */
  readonly observesDst: boolean;
  /** Holiday calendar for this market. */
  readonly calendar: MarketCalendar;

  /** Determine the market phase for a given UTC date. */
  getPhase(utcDate: Date): MarketPhase;
  /** True if utcDate falls on a trading day (weekday and not a holiday). */
  isTradingDay(utcDate: Date): boolean;
}

// ---------------------------------------------------------------------------
// Timezone-aware helpers (used by concrete profiles and the MarketClock)
// ---------------------------------------------------------------------------

/** Format a UTC date as YYYY-MM-DD in the given IANA timezone. */
export function formatMarketDate(date: Date, timezone: string): string {
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

/** Get day-of-week (0=Sun, 6=Sat) in the given IANA timezone. */
export function getMarketDayOfWeek(date: Date, timezone: string): number {
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).format(date);
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return map[label] ?? date.getDay();
}

/** Extract hours and minutes (in market local time) from a UTC date. */
export function getMarketTime(
  date: Date,
  timezone: string,
): { hours: number; minutes: number } {
  const str = date.toLocaleString('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [hours, minutes] = str.split(':').map(Number);
  return { hours, minutes };
}

/** Parse a session time string into minutes since midnight. */
export function parseSessionTime(
  session: MarketSession,
): { openMinutes: number; closeMinutes: number } {
  const [oh, om] = session.open.split(':').map(Number);
  const [ch, cm] = session.close.split(':').map(Number);
  return { openMinutes: oh * 60 + om, closeMinutes: ch * 60 + cm };
}

// ---------------------------------------------------------------------------
// Default phase calculation
// ---------------------------------------------------------------------------

/**
 * Generic market phase calculator.
 *
 * Determines the phase for a date by checking (in order):
 * 1. Weekend → Closed
 * 2. Holiday    → Closed
 * 3. Pre-market → PreMarket (if defined)
 * 4. Regular    → Regular
 * 5. Post-market → PostMarket (if defined)
 * 6. Else       → Closed
 */
export function calculatePhase(
  utcDate: Date,
  profile: MarketProfile,
): MarketPhase {
  const dow = getMarketDayOfWeek(utcDate, profile.timezone);
  if (dow === 0 || dow === 6) return MarketPhase.Closed;

  const marketDate = formatMarketDate(utcDate, profile.timezone);
  if (profile.calendar.getHoliday(marketDate) !== null) {
    return MarketPhase.Closed;
  }

  const { hours, minutes } = getMarketTime(utcDate, profile.timezone);
  const nowMin = hours * 60 + minutes;

  // Pre-market (if defined)
  if (profile.preMarketSession !== null) {
    const pm = parseSessionTime(profile.preMarketSession);
    if (nowMin >= pm.openMinutes && nowMin < pm.closeMinutes) {
      return MarketPhase.PreMarket;
    }
  }

  // Regular session
  const reg = parseSessionTime(profile.regularSession);
  if (nowMin >= reg.openMinutes && nowMin < reg.closeMinutes) {
    return MarketPhase.Regular;
  }

  // Post-market (if defined)
  if (profile.postMarketSession !== null) {
    const post = parseSessionTime(profile.postMarketSession);
    if (nowMin >= post.openMinutes && nowMin < post.closeMinutes) {
      return MarketPhase.PostMarket;
    }
  }

  return MarketPhase.Closed;
}

/** Default trading-day check: weekday and not a holiday. */
export function isTradingDay(utcDate: Date, profile: MarketProfile): boolean {
  const dow = getMarketDayOfWeek(utcDate, profile.timezone);
  if (dow === 0 || dow === 6) return false;

  const marketDate = formatMarketDate(utcDate, profile.timezone);
  return profile.calendar.getHoliday(marketDate) === null;
}
