import type {
  LifecycleEvent,
  SchedulerState,
  HealthStatus,
} from '../types/runtime.js';
import type { RuntimeStateRepository } from '../persistence/runtime-state-repo.js';

// ---------------------------------------------------------------------------
// Telemetry — higher-level recording and query utilities
// ---------------------------------------------------------------------------

export class Telemetry {
  private readonly _repo: RuntimeStateRepository;

  constructor(repo: RuntimeStateRepository) {
    this._repo = repo;
  }

  /** Record a scheduler state snapshot. */
  recordSchedulerState(state: SchedulerState): void {
    this._repo.upsertSchedulerState(state);
  }

  /** Read the last persisted scheduler state. */
  getSchedulerState(): SchedulerState {
    return this._repo.getSchedulerState();
  }

  /** Read the most recent health check. */
  getLatestHealthCheck(): HealthStatus | null {
    return this._repo.getLatestHealthCheck();
  }

  /** Read recent lifecycle events. */
  getLifecycleEvents(limit?: number): LifecycleEvent[] {
    return this._repo.getLifecycleEvents(limit);
  }
}
