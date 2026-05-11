// ── Market Clock ──
// Scheduler-facing convenience wrapper over a MarketProfile.
// Provides phase queries and time-until-boundary calculations that
// the scheduler loop uses to decide iteration frequency and behavior.

import { MarketPhase } from '../types/runtime.js';
import type { MarketProfile } from '../market/market-profile.js';
import { parseSessionTime, formatMarketDate, getMarketDayOfWeek, getMarketTime } from '../market/market-profile.js';

// ---------------------------------------------------------------------------
// MarketClock
// ---------------------------------------------------------------------------

export class MarketClock {
  constructor(private readonly profile: MarketProfile) {}

  /** The underlying market profile. */
  getProfile(): MarketProfile {
    return this.profile;
  }

  // ── Phase queries ──────────────────────────────────────────────────────

  /** Current market phase. */
  getPhase(now: Date = new Date()): MarketPhase {
    return this.profile.getPhase(now);
  }

  /** True if the market is currently in any open session (pre, regular, or post). */
  isOpen(now: Date = new Date()): boolean {
    const phase = this.getPhase(now);
    return (
      phase === MarketPhase.Regular ||
      phase === MarketPhase.PreMarket ||
      phase === MarketPhase.PostMarket
    );
  }

  /** True if the regular session is currently active. */
  isRegularSession(now: Date = new Date()): boolean {
    return this.getPhase(now) === MarketPhase.Regular;
  }

  /** True if the market is closed. */
  isClosed(now: Date = new Date()): boolean {
    return this.getPhase(now) === MarketPhase.Closed;
  }

  // ── Time-until-boundary calculations ───────────────────────────────────

  /**
   * Milliseconds until the next session opens (Regular or PreMarket).
   * Returns 0 if already in an open session.
   * Scans forward up to 7 days; returns Infinity if no open found
   * (should not happen for any real market).
   */
  timeUntilNextOpen(now: Date = new Date()): number {
    if (this.isOpen(now)) return 0;

    // Scan forward minute-by-minute (scheduler runs at 60s, so this is fine)
    // up to 7 days
    const maxLookahead = 7 * 24 * 60; // minutes
    const ms = now.getTime();

    for (let i = 0; i < maxLookahead; i++) {
      const candidate = new Date(ms + i * 60_000);
      const phase = this.profile.getPhase(candidate);
      if (phase === MarketPhase.PreMarket || phase === MarketPhase.Regular) {
        return candidate.getTime() - ms;
      }
    }
    return Infinity;
  }

  /**
   * Milliseconds until the current session closes (any open session).
   * Returns 0 if already closed — meaning there is no closing boundary to wait for.
   * Scans forward up to 24 hours.
   */
  timeUntilNextClose(now: Date = new Date()): number {
    const currentPhase = this.getPhase(now);
    if (currentPhase === MarketPhase.Closed) return 0;

    // Find when the current phase changes
    const ms = now.getTime();
    const maxLookahead = 24 * 60; // minutes

    for (let i = 1; i <= maxLookahead; i++) {
      const candidate = new Date(ms + i * 60_000);
      const nextPhase = this.profile.getPhase(candidate);
      if (nextPhase !== currentPhase) {
        return candidate.getTime() - ms;
      }
    }
    // If no change within 24h, the current session lasts indefinitely
    // (unrealistic for any real market — safeguard return)
    return 0;
  }

  /**
   * Milliseconds until the next phase transition of any kind.
   * Returns 0 if the exact boundary is ambiguous (at most 1 minute resolution).
   * Scans forward up to 24 hours.
   */
  timeUntilNextPhaseChange(now: Date = new Date()): number {
    const currentPhase = this.getPhase(now);
    const ms = now.getTime();
    const maxLookahead = 24 * 60;

    for (let i = 1; i <= maxLookahead; i++) {
      const candidate = new Date(ms + i * 60_000);
      if (this.profile.getPhase(candidate) !== currentPhase) {
        return candidate.getTime() - ms;
      }
    }
    return 0;
  }

  /**
   * Build a readable status string for log/health-surface output.
   */
  summarize(now: Date = new Date()): string {
    const phase = this.getPhase(now);
    const tz = this.profile.timezone;
    const local = getMarketTime(now, tz);
    const localStr = `${String(local.hours).padStart(2, '0')}:${String(local.minutes).padStart(2, '0')}`;
    const date = formatMarketDate(now, tz);

    // Holiday info
    const holiday = this.profile.calendar.getHoliday(date);
    const holidayNote = holiday ? ` (holiday: ${holiday})` : '';

    return `${date} ${localStr} ${tz} — ${phase}${holidayNote}`;
  }
}

// ── Factory convenience ──────────────────────────────────────────────────

/** Create a MarketClock from a MarketProfile. */
export function createClock(profile: MarketProfile): MarketClock {
  return new MarketClock(profile);
}
