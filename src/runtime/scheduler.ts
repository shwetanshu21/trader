// ── Supervised Scheduler Loop ──
// Periodically wakes, checks market phase via MarketClock, persists state,
// and reports health. Designed to run unattended on Raspberry Pi.
// Error handling: transient errors degrade lifecycle; unrecoverable errors stop.

import {
  MarketPhase,
  SchedulerStatus,
  type SchedulerState,
  type HealthStatus,
} from '../types/runtime.js';
import type { RuntimeStateRepository } from '../persistence/runtime-state-repo.js';
import type { LifecycleManager } from './lifecycle.js';
import type { HealthService } from './health-service.js';
import type { MarketClock } from './market-clock.js';
import type { Telemetry } from './telemetry.js';

// ---------------------------------------------------------------------------
// TickWork — hook interface for supervised broker / ingestion work
// Implementations run on every scheduler tick, AFTER the core tick logic.
// Errors from a TickWork degrade the runtime but do NOT stop the scheduler.
// ---------------------------------------------------------------------------

export interface TickWork {
  /** Short label for logging/diagnostics. */
  readonly label: string;

  /**
   * Execute supervised broker work.
   *
   * @param now     - Current DateTime (same across all TickWork instances per tick)
   * @param health  - Health snapshot recorded this tick (read-only)
   *
   * Throwing or returning a failed result degrades the runtime lifecycle
   * with a labelled reason but the scheduler continues ticking.
   */
  doWork(now: Date, health: HealthStatus): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// TickResult — structured output of a single tick iteration
// ---------------------------------------------------------------------------

export interface TickResult {
  /** The phase the scheduler observed this tick. */
  marketPhase: MarketPhase;
  /** Duration of the tick execution in ms. */
  durationMs: number;
  /** Updated tick count after this tick. */
  tickCount: number;
  /** Error message if tick failed, null otherwise. */
  error: string | null;
  /** ISO timestamp of the tick. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// SchedulerOptions
// ---------------------------------------------------------------------------

export interface SchedulerOptions {
  /** Market clock to read phase from. */
  clock: MarketClock;
  /** Lifecycle manager for state transitions. */
  lifecycle: LifecycleManager;
  /** Repository for persisting scheduler state. */
  repo: RuntimeStateRepository;
  /** Health service for recording health checks. */
  health: HealthService;
  /** Telemetry for higher-level observability. */
  telemetry: Telemetry;
  /** Interval between ticks in ms (from RuntimeConfig.schedulerIntervalMs). */
  intervalMs: number;
  /** Optional list of TickWork hooks to run on every tick. */
  tickWork?: TickWork[];
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  private readonly _clock: MarketClock;
  private readonly _lifecycle: LifecycleManager;
  private readonly _repo: RuntimeStateRepository;
  private readonly _health: HealthService;
  private readonly _telemetry: Telemetry;
  private readonly _intervalMs: number;
  private readonly _tickWork: TickWork[];

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _abortController: AbortController | null = null;
  private _tickCount: number = 0;
  private _startedAt: number | null = null;
  private _lastTickTimestamp: number | null = null;
  private _lastError: string | null = null;
  private _status: SchedulerStatus = SchedulerStatus.Idle;
  private _currentPhase: MarketPhase = MarketPhase.Closed;

  constructor(options: SchedulerOptions) {
    this._clock = options.clock;
    this._lifecycle = options.lifecycle;
    this._repo = options.repo;
    this._health = options.health;
    this._telemetry = options.telemetry;
    this._intervalMs = options.intervalMs;
    this._tickWork = options.tickWork ?? [];

    // Restore persisted state if available
    const persisted = this._repo.getSchedulerState();
    if (persisted.status !== SchedulerStatus.Idle) {
      this._status = persisted.status;
      this._tickCount = persisted.tickCount;
      this._startedAt = persisted.startedAt;
      this._lastTickTimestamp = persisted.lastTickTimestamp;
      this._lastError = persisted.lastError;
      this._currentPhase = persisted.marketPhase;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Start the scheduler loop. Returns the initial scheduler state. */
  start(): SchedulerState {
    if (this._timer !== null) {
      console.warn('[scheduler] start() called but loop is already running');
      return this.getState();
    }

    // Ensure lifecycle is at least Running (start if still Booting)
    if (this._lifecycle.state === 'booting') {
      this._lifecycle.start('Scheduler starting');
    }

    // If lifecycle is stopped, we cannot start
    if (this._lifecycle.state === 'stopped') {
      throw new Error('Cannot start scheduler: lifecycle is in Stopped state');
    }

    this._status = SchedulerStatus.Running;
    this._startedAt = this._startedAt ?? Date.now();
    this._abortController = new AbortController();
    this._currentPhase = this._clock.getPhase();

    // Persist initial running state
    this._persistState();

    console.log(`[scheduler] Starting loop every ${this._intervalMs}ms`);
    console.log(`[scheduler] Initial market phase: ${this._currentPhase}`);

    // Run first tick immediately, then on interval
    this._tick().catch(err => {
      console.error('[scheduler] Initial tick failed:', err);
    });

    this._timer = setInterval(() => {
      this._tick().catch(err => {
        console.error('[scheduler] Tick failed:', err);
      });
    }, this._intervalMs);

    // Allow the process to exit even if the timer is still active
    if (this._timer && typeof this._timer === 'object' && 'unref' in this._timer) {
      this._timer.unref();
    }

    return this.getState();
  }

  /**
   * Gracefully stop the scheduler loop.
   * Transitions lifecycle to Stopped and persists final state.
   */
  stop(reason: string = 'Scheduler stopped'): SchedulerState {
    this._clearTimer();

    this._status = SchedulerStatus.Stopped;
    this._lastError = reason;
    this._persistState();

    // Transition lifecycle — non-fatal if already Stopped
    try {
      this._lifecycle.stop(reason);
    } catch {
      // Lifecycle may already be stopped; that's fine
    }

    return this.getState();
  }

  /** Pause the loop without transitioning lifecycle. */
  pause(): SchedulerState {
    if (this._status !== SchedulerStatus.Running) {
      console.warn(`[scheduler] pause() called but status is ${this._status}`);
      return this.getState();
    }

    this._clearTimer();
    this._status = SchedulerStatus.Paused;
    this._persistState();

    console.log('[scheduler] Paused');

    return this.getState();
  }

  /** Resume from paused state. */
  resume(): SchedulerState {
    if (this._status !== SchedulerStatus.Paused) {
      console.warn(`[scheduler] resume() called but status is ${this._status}`);
      return this.getState();
    }

    this._status = SchedulerStatus.Running;
    this._timer = setInterval(() => {
      this._tick().catch(err => {
        console.error('[scheduler] Tick failed:', err);
      });
    }, this._intervalMs);

    if (this._timer && typeof this._timer === 'object' && 'unref' in this._timer) {
      this._timer.unref();
    }

    this._persistState();
    console.log('[scheduler] Resumed');

    return this.getState();
  }

  /** Get the current scheduler state snapshot (in-memory, not DB). */
  getState(): SchedulerState {
    return {
      status: this._status,
      marketPhase: this._currentPhase,
      lastTickTimestamp: this._lastTickTimestamp,
      startedAt: this._startedAt,
      tickCount: this._tickCount,
      lastError: this._lastError,
    };
  }

  /** Access the underlying clock. */
  getClock(): MarketClock {
    return this._clock;
  }

  /** True if the loop timer is active. */
  get isRunning(): boolean {
    return this._timer !== null && this._status === SchedulerStatus.Running;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Execute a single tick iteration.
   *
   * 1. Check abort signal
   * 2. Read current market phase
   * 3. Update in-memory state
   * 4. Persist scheduler state
   * 5. Record health check
   * 6. If lifecycle is Degraded and this tick recovered, transition back to Running
   */
  private async _tick(): Promise<TickResult> {
    const tickStart = Date.now();
    let error: string | null = null;

    try {
      // Check if we've been aborted
      if (this._abortController?.signal.aborted) {
        this._clearTimer();
        this._status = SchedulerStatus.Stopped;
        this._persistState();
        return {
          marketPhase: this._currentPhase,
          durationMs: Date.now() - tickStart,
          tickCount: this._tickCount,
          error: 'Aborted',
          timestamp: new Date().toISOString(),
        };
      }

      // Read current market phase
      const now = new Date();
      const phase = this._clock.getPhase(now);

      // Update in-memory state
      this._currentPhase = phase;
      this._tickCount++;
      this._lastTickTimestamp = tickStart;

      // Persist scheduler state snapshot
      this._persistState();

      // Record a health check
      const tickHealth = this._health.recordHealthCheck();

      // Run supervised TickWork hooks
      for (const work of this._tickWork) {
        try {
          await work.doWork(now, tickHealth);
        } catch (err) {
          const workError = err instanceof Error ? err.message : String(err);
          console.error(`[scheduler] TickWork "${work.label}" failed: ${workError}`);
          // Degrade lifecycle for tick work failures
          try {
            this._lifecycle.degrade(`TickWork "${work.label}" error: ${workError}`, {
              tickCount: this._tickCount,
              label: work.label,
              error: workError,
            });
          } catch {
            // Already degraded or stopped
          }
        }
      }

      // If lifecycle is Degraded and tick succeeded, try recovering to Running
      // Only attempt recovery from Degraded — not from Stopped
      if (this._lifecycle.state === 'degraded') {
        // Only recover if there's no persistent error
        if (!this._lastError) {
          try {
            this._lifecycle.start('Scheduler tick recovered');
            console.log('[scheduler] Recovered from degraded state');
          } catch {
            // Recovery failed — stay degraded
          }
        }
      }

      // Log at debug level (spammy at info for production)
      if (process.env.TRADER_LOG_LEVEL === 'debug') {
        console.log(`[scheduler] tick ${this._tickCount}: phase=${phase} elapsed=${Date.now() - tickStart}ms`);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this._lastError = error;

      console.error(`[scheduler] Tick error: ${error}`);

      // Persist error state
      this._persistState();

      // On error, degrade lifecycle
      try {
        this._lifecycle.degrade(`Scheduler tick error: ${error}`, {
          tickCount: this._tickCount,
          error,
        });
      } catch {
        // If degradation fails (e.g. already Stopped), that's fine
      }
    }

    return {
      marketPhase: this._currentPhase,
      durationMs: Date.now() - tickStart,
      tickCount: this._tickCount,
      error,
      timestamp: new Date().toISOString(),
    };
  }

  /** Persist the current scheduler state to the DB. */
  private _persistState(): void {
    this._repo.upsertSchedulerState(this.getState());
  }
}
