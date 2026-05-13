// ── ExecutionGateSupervisor — TickWork that consumes approved candidates ──
//
// This is the M003 execution gate. It replaces the legacy blocked-order
// ledger writes with mode-aware execution-attempt orchestration:
//   1. Loads strategy-approved candidates that have NOT yet been consumed
//      (query uses LEFT JOIN with execution_attempts as the canonical seam)
//   2. Routes each candidate through ModeAwareExecutionService which
//      dispatches to the active mode adapter (blocked | paper | live)
//   3. Persists the execution attempt row (idempotent per strategy decision)
//
// Invariants:
//   - A candidate is only consumed when an execution attempt row is written
//   - Repeated ticks cannot duplicate execution for the same strategy decision
//   - blocked_order_attempts is kept only as legacy evidence; canonical
//     consumption checks use execution_attempts exclusively
//   - Failures from the execution service re-throw so the scheduler can
//     degrade the lifecycle; they never silently skip consumption

import type { TickWork } from '../runtime/scheduler.js';
import type { HealthStatus } from '../types/runtime.js';
import { ExecutionAttemptRepository } from '../persistence/execution-attempt-repo.js';
import { StrategyDecisionRepository } from '../persistence/strategy-decision-repo.js';
import { ModeAwareExecutionService } from './mode-aware-execution-service.js';

// ---------------------------------------------------------------------------
// ExecutionGateSupervisor
// ---------------------------------------------------------------------------

export class ExecutionGateSupervisor implements TickWork {
  readonly label = 'execution-gate';

  private readonly _strategyDecisionRepo: StrategyDecisionRepository;
  private readonly _executionService: ModeAwareExecutionService;
  private readonly _attemptRepo: ExecutionAttemptRepository;

  constructor(options: {
    strategyDecisionRepo: StrategyDecisionRepository;
    executionService: ModeAwareExecutionService;
    attemptRepo: ExecutionAttemptRepository;
  }) {
    this._strategyDecisionRepo = options.strategyDecisionRepo;
    this._executionService = options.executionService;
    this._attemptRepo = options.attemptRepo;
  }

  // ── Public accessors ────────────────────────────────────────────────────

  /** The active execution mode. */
  get mode(): string {
    return this._executionService.mode;
  }

  // ── TickWork ────────────────────────────────────────────────────────────

  async doWork(_now: Date, _health: HealthStatus): Promise<void> {
    try {
      // Query strategy-approved candidates that have NOT yet been consumed
      // (Uses execution_attempts LEFT JOIN — canonical consumption seam)
      const candidates = this._strategyDecisionRepo.getApprovedUnconsumedCandidates();

      if (candidates.length === 0) {
        return;
      }

      // Execute each candidate through the mode-aware service
      for (const candidate of candidates) {
        await this._executionService.execute(candidate, null, null);
      }

      console.log(
        `[execution-gate] consumed ${candidates.length} strategy-approved candidate(s) ` +
        `via ${this._executionService.mode} mode`,
      );
    } catch (err) {
      // Fail-closed: gate errors degrade the lifecycle but do not:
      //   - attempt live execution fallback
      //   - crash the scheduler
      //   - mutate prior proposal/strategy/execution verdicts
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[execution-gate] Gate failure: ${errorMsg}`);

      // Re-throw so the scheduler can degrade the lifecycle
      throw err;
    }
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────

  /** Return total execution attempt count for health/observability surfaces. */
  getExecutionAttemptCount(): number {
    return this._attemptRepo.count();
  }
}
