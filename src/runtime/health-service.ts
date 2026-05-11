import {
  HealthVerdict,
  HealthStatus,
  LifecycleState,
  type SchedulerState,
} from '../types/runtime.js';
import type { RuntimeStateRepository } from '../persistence/runtime-state-repo.js';
import type { LifecycleManager } from './lifecycle.js';

// ---------------------------------------------------------------------------
// HealthService — composites HealthStatus from lifecycle + scheduler state
// ---------------------------------------------------------------------------

export class HealthService {
  private readonly _lifecycle: LifecycleManager;
  private readonly _repo: RuntimeStateRepository;
  private readonly _startedAt: number;

  constructor(
    lifecycle: LifecycleManager,
    repo: RuntimeStateRepository,
    startedAt: number,
  ) {
    this._lifecycle = lifecycle;
    this._repo = repo;
    this._startedAt = startedAt;
  }

  /** Produce a HealthStatus snapshot without persisting it. */
  getHealth(): HealthStatus {
    const lifecycleState = this._lifecycle.state;
    const scheduler = this._repo.getSchedulerState();
    const uptimeMs = Date.now() - this._startedAt;

    return this.composeStatus(lifecycleState, scheduler, uptimeMs);
  }

  /** Produce a HealthStatus snapshot and persist it as a health check record. */
  recordHealthCheck(): HealthStatus {
    const status = this.getHealth();
    this._repo.insertHealthCheck(status);
    return status;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private composeStatus(
    lifecycleState: LifecycleState,
    scheduler: SchedulerState,
    uptimeMs: number,
  ): HealthStatus {
    const degradedReasons: string[] = [];

    // Collect degradation reasons
    if (lifecycleState === LifecycleState.Degraded) {
      const latest = this._lifecycle.latestEvent;
      if (latest && latest.reason) {
        degradedReasons.push(latest.reason);
      } else {
        degradedReasons.push('Runtime is in degraded state');
      }
    }

    if (scheduler.status === 'paused') {
      degradedReasons.push('Scheduler is paused');
    } else if (scheduler.status === 'stopped') {
      degradedReasons.push('Scheduler is stopped');
    }

    if (scheduler.lastError) {
      degradedReasons.push(`Last scheduler error: ${scheduler.lastError}`);
    }

    // Determine verdict
    let verdict: HealthVerdict;
    if (lifecycleState === LifecycleState.Stopped) {
      verdict = HealthVerdict.Unhealthy;
    } else if (degradedReasons.length > 0) {
      verdict = HealthVerdict.Degraded;
    } else {
      verdict = HealthVerdict.Healthy;
    }

    return {
      verdict,
      uptimeMs,
      lifecycleState,
      scheduler,
      degradedReasons,
      checkedAt: new Date().toISOString(),
    };
  }
}
