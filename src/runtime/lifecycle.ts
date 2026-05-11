import {
  LifecycleState,
  type LifecycleEvent,
} from '../types/runtime.js';
import type { RuntimeStateRepository } from '../persistence/runtime-state-repo.js';

// ---------------------------------------------------------------------------
// LifecycleManager — state machine with persistence
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  [LifecycleState.Booting]: [LifecycleState.Running, LifecycleState.Stopped],
  [LifecycleState.Running]: [LifecycleState.Degraded, LifecycleState.Stopped],
  [LifecycleState.Degraded]: [LifecycleState.Running, LifecycleState.Stopped],
  [LifecycleState.Stopped]: [], // terminal — no transitions out
};

export class LifecycleManager {
  private _state: LifecycleState;
  private readonly _repo: RuntimeStateRepository;
  private _latestEvent: LifecycleEvent | null = null;

  constructor(repo: RuntimeStateRepository) {
    this._repo = repo;

    // Recover last known state from DB, or default to Booting.
    // A persisted Stopped state is terminal for the prior process only — a
    // fresh process boot must be allowed to start again on the same DB.
    const persisted = repo.getLatestLifecycleState();
    this._state = persisted === LifecycleState.Stopped
      ? LifecycleState.Booting
      : (persisted ?? LifecycleState.Booting);

    // Restore the latest event for in-memory access
    this._latestEvent = repo.getLatestLifecycleEvent();
  }

  /** Current lifecycle state (in-memory, not a fresh DB read). */
  get state(): LifecycleState {
    return this._state;
  }

  /** Most recent lifecycle event. */
  get latestEvent(): LifecycleEvent | null {
    return this._latestEvent;
  }

  /** Transition to Running. */
  start(reason = 'Runtime started'): LifecycleEvent {
    return this.transitionTo(LifecycleState.Running, reason);
  }

  /** Transition to Degraded. */
  degrade(reason: string, diagnostic?: Record<string, unknown>): LifecycleEvent {
    if (!reason) throw new Error('degrade() requires a non-empty reason');
    return this.transitionTo(LifecycleState.Degraded, reason, diagnostic);
  }

  /** Transition to Stopped. */
  stop(reason: string, diagnostic?: Record<string, unknown>): LifecycleEvent {
    if (!reason) throw new Error('stop() requires a non-empty reason');
    return this.transitionTo(LifecycleState.Stopped, reason, diagnostic);
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private transitionTo(
    target: LifecycleState,
    reason: string,
    diagnostic?: Record<string, unknown>,
  ): LifecycleEvent {
    const allowed = VALID_TRANSITIONS[this._state];

    if (!allowed.includes(target)) {
      throw new Error(
        `Invalid lifecycle transition: ${this._state} → ${target}. ` +
        `Allowed from ${this._state}: [${allowed.join(', ')}]`,
      );
    }

    const event: LifecycleEvent = {
      timestamp: Date.now(),
      state: target,
      reason,
      diagnostic,
    };

    // Persist
    this._repo.insertLifecycleEvent(event);

    // Update in-memory state
    this._state = target;
    this._latestEvent = event;

    return event;
  }

  /** Return recent events from the repository. */
  getEvents(limit?: number): LifecycleEvent[] {
    return this._repo.getLifecycleEvents(limit);
  }
}
