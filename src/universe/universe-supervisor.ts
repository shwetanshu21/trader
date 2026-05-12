// ── UniverseSupervisor — TickWork that refreshes universe coverage ──
// Runs on every scheduler tick AFTER broker ingestion.
// Recomputes and persists the latest universe coverage snapshot so that
// downstream proposal/execution ticks consume a deterministic, operator-visible
// tradable surface rather than scanning the full instrument catalog.
//
// Failure mode (instrument/quotes not yet available):
// UniverseService.computeSnapshot() already handles degraded gracefully —
// it persists a Degraded verdict with empty eligible set. This supervisor
// does NOT throw; it always yields a deterministic snapshot.

import type { TickWork } from '../runtime/scheduler.js';
import type { HealthStatus } from '../types/runtime.js';
import { UniverseService } from './universe-service.js';

// ---------------------------------------------------------------------------
// UniverseSupervisor
// ---------------------------------------------------------------------------

export class UniverseSupervisor implements TickWork {
  readonly label = 'universe';

  private readonly _universeService: UniverseService;
  private _lastRefreshAt: number | null = null;

  constructor(universeService: UniverseService) {
    this._universeService = universeService;
  }

  // ── TickWork ────────────────────────────────────────────────────────────

  async doWork(_now: Date, _health: HealthStatus): Promise<void> {
    // Recompute and persist a fresh universe coverage snapshot.
    // This is idempotent and side-effect-safe: BrokerRepository and Quotes
    // data are read-only sources; the snapshot is overwritten (new row).
    const snapshot = this._universeService.computeSnapshot();
    this._lastRefreshAt = snapshot.computedAt;

    if (process.env.TRADER_LOG_LEVEL === 'debug') {
      console.log(
        `[universe-supervisor] snapshot #${snapshot.id}: verdict=${snapshot.verdict} `
        + `eligible=${snapshot.eligibleCount} fresh=${snapshot.freshQuoteCount} `
        + `stale=${snapshot.staleQuoteCount} missing=${snapshot.missingQuoteCount}`,
      );
    }
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────

  /** Return supervisor diagnostics for health/observability surfaces. */
  getDiagnostics(): {
    lastRefreshAt: number | null;
    label: string;
  } {
    return {
      lastRefreshAt: this._lastRefreshAt,
      label: this.label,
    };
  }

  /** Whether at least one refresh has been attempted. */
  get hasRefreshed(): boolean {
    return this._lastRefreshAt !== null;
  }
}
