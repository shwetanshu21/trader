// ── Replay Clock ──
// Generates India-market-aligned historical ticks at a configurable cadence
// (default: 5 minutes). Produces deterministic tick sequences within a date
// range, respecting trading day boundaries, session hours, and holidays.

import { MarketPhase } from '../types/runtime.js';
import type { MarketProfile } from '../market/market-profile.js';
import { getMarketTime, formatMarketDate } from '../market/market-profile.js';
import { ReplayFidelity } from './types.js';
import type { ReplayTick } from './types.js';

// ---------------------------------------------------------------------------
// ReplayClock
// ---------------------------------------------------------------------------

export class ReplayClock {
  /** Default cadence in minutes (5-minute screening cadence). */
  static readonly DEFAULT_CADENCE_MINUTES = 5;

  constructor(
    private readonly profile: MarketProfile,
    private readonly cadenceMinutes: number = ReplayClock.DEFAULT_CADENCE_MINUTES,
  ) {
    if (cadenceMinutes < 1) {
      throw new Error(`Cadence must be >= 1 minute, got ${cadenceMinutes}`);
    }
  }

  /** The underlying market profile. */
  getProfile(): MarketProfile {
    return this.profile;
  }

  /** The configured tick cadence in minutes. */
  getCadenceMinutes(): number {
    return this.cadenceMinutes;
  }

  // -----------------------------------------------------------------------
  // Tick generation
  // -----------------------------------------------------------------------

  /**
   * Generate all ticks within [rangeStart, rangeEnd] at the configured
   * cadence, aligned to the regular session (09:15–15:30 IST).
   *
   * Each tick falls on an even multiple of cadenceMinutes past the hour
   * (e.g. 09:15, 09:20, 09:25, …, 15:25, 15:30 for default 5-min cadence).
   *
   * Non-trading days (weekends, holidays) are skipped entirely.
   * Pre-market (09:00–09:15) and Post-market (15:30–16:00) are excluded
   * because screening ticks only make sense during the regular session.
   *
   * @param rangeStart - Unix timestamp (ms) of the earliest tick allowed.
   * @param rangeEnd   - Unix timestamp (ms) of the latest tick allowed.
   * @returns An ordered array of ReplayTick entries, or empty if no ticks
   *          fall in the given range.
   */
  generateTicks(rangeStart: number, rangeEnd: number): ReplayTick[] {
    const ticks: ReplayTick[] = [];
    let index = 0;

    // Snapshot the regular session boundaries from the profile
    const regOpen = this.profile.regularSession.open;   // e.g. '09:15'
    const regClose = this.profile.regularSession.close; // e.g. '15:30'

    // Walk day-by-day starting from rangeStart
    const dayStart = this._floorToDate(rangeStart);

    for (let ms = dayStart; ms <= rangeEnd; ms += 86_400_000) {
      const dayDate = new Date(ms);

      // Skip non-trading days
      if (!this.profile.isTradingDay(dayDate)) continue;

      // Parse regular session boundaries for this day
      const openMs = this._sessionTimeToMs(dayDate, regOpen);
      const closeMs = this._sessionTimeToMs(dayDate, regClose);

      // Generate ticks from open up to (but not past) close
      for (let tickMs = openMs; tickMs < closeMs; tickMs += this.cadenceMinutes * 60_000) {
        if (tickMs < rangeStart || tickMs > rangeEnd) continue;
        index++;
        ticks.push({
          index,
          timestamp: tickMs,
          fidelity: ReplayFidelity.Full,
        });
      }
    }

    return ticks;
  }

  /**
   * Count the total number of ticks that would be generated for the given
   * range, without materializing them. Useful for session totalTicks.
   */
  countTicks(rangeStart: number, rangeEnd: number): number {
    return this.generateTicks(rangeStart, rangeEnd).length;
  }

  /**
   * Get the tick at a specific 1-based index within the range.
   * Returns null if the index is out of bounds (fewer ticks than index).
   */
  getTickAtIndex(rangeStart: number, rangeEnd: number, index: number): ReplayTick | null {
    // Walk forward until we find the requested index
    let currentIndex = 0;
    const dayStart = this._floorToDate(rangeStart);

    for (let ms = dayStart; ms <= rangeEnd; ms += 86_400_000) {
      const dayDate = new Date(ms);
      if (!this.profile.isTradingDay(dayDate)) continue;

      const regOpen = this.profile.regularSession.open;
      const regClose = this.profile.regularSession.close;
      const openMs = this._sessionTimeToMs(dayDate, regOpen);
      const closeMs = this._sessionTimeToMs(dayDate, regClose);

      for (let tickMs = openMs; tickMs < closeMs; tickMs += this.cadenceMinutes * 60_000) {
        if (tickMs < rangeStart || tickMs > rangeEnd) continue;
        currentIndex++;
        if (currentIndex === index) {
          return {
            index,
            timestamp: tickMs,
            fidelity: ReplayFidelity.Full,
          };
        }
      }
    }

    return null;
  }

  /**
   * Build a readable description of the tick sequence for the given range.
   */
  summarize(rangeStart: number, rangeEnd: number): string {
    const ticks = this.generateTicks(rangeStart, rangeEnd);
    const tz = this.profile.timezone;
    const startLocal = formatMarketDate(new Date(rangeStart), tz);
    const endLocal = formatMarketDate(new Date(rangeEnd), tz);
    const cadenceLabel = this.cadenceMinutes >= 60
      ? `${this.cadenceMinutes / 60}h`
      : `${this.cadenceMinutes}min`;

    if (ticks.length === 0) {
      return `ReplayClock: no ticks in [${startLocal} → ${endLocal}] at ${cadenceLabel} cadence`;
    }

    const firstTick = ticks[0];
    const lastTick = ticks[ticks.length - 1];
    const firstLocal = formatMarketDate(new Date(firstTick.timestamp), tz);
    const lastLocal = formatMarketDate(new Date(lastTick.timestamp), tz);

    return `ReplayClock: ${ticks.length} ticks in [${startLocal} → ${endLocal}] at ${cadenceLabel} cadence (${firstLocal} … ${lastLocal})`;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Floor a timestamp to the start of its UTC day (00:00:00.000). */
  private _floorToDate(ts: number): number {
    const d = new Date(ts);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  /**
   * Convert a session time string (e.g. '09:15') to a Unix timestamp (ms)
   * on the same day as the given reference date.
   *
   * Uses Asia/Kolkata offset (UTC+5:30) to compute the effective UTC time.
   */
  private _sessionTimeToMs(refDate: Date, timeStr: string): number {
    const [h, m] = timeStr.split(':').map(Number);
    // Start of day in UTC
    const startOfDay = Date.UTC(
      refDate.getUTCFullYear(),
      refDate.getUTCMonth(),
      refDate.getUTCDate(),
    );
    // India is UTC+5:30
    const offsetMs = 5.5 * 3600_000;
    return startOfDay + h * 3600_000 + m * 60_000 - offsetMs;
  }
}

// ---------------------------------------------------------------------------
// Factory convenience
// ---------------------------------------------------------------------------

/** Create a ReplayClock from a MarketProfile with optional cadence override. */
export function createReplayClock(
  profile: MarketProfile,
  cadenceMinutes?: number,
): ReplayClock {
  return new ReplayClock(profile, cadenceMinutes);
}
