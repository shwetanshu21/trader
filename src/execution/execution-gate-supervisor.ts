// ── ExecutionGateSupervisor — TickWork that consumes approved candidates ──
//
// This is the M003 execution gate. It replaces the legacy blocked-order
// ledger writes with mode-aware execution-attempt orchestration:
//   1. Loads strategy-approved candidates that have NOT yet been consumed
//      (query uses LEFT JOIN with execution_attempts as the canonical seam)
//   2. Evaluates each candidate through the ExecutionRiskGuard (market-hours,
//      kill-switch, duplicate, exposure, daily-loss checks) BEFORE routing to
//      the mode-aware execution service
//   3. Routes each candidate through ModeAwareExecutionService which
//      dispatches to the active mode adapter (blocked | paper | live)
//   4. Persists the execution attempt row (idempotent per strategy decision)
//
// Invariants:
//   - A candidate is only consumed when an execution attempt row is written
//   - Repeated ticks cannot duplicate execution for the same strategy decision
//   - The risk guard is evaluated first; refused/halted candidates are NOT
//     passed to the execution service, but a risk event IS persisted
//   - blocked_order_attempts is kept only as legacy evidence; canonical
//     consumption checks use execution_attempts exclusively
//   - Failures from the execution service re-throw so the scheduler can
//     degrade the lifecycle; they never silently skip consumption

import type { TickWork } from '../runtime/scheduler.js';
import type { HealthStatus } from '../types/runtime.js';
import { BrokerRepository } from '../persistence/broker-repo.js';
import { ExecutionAttemptRepository } from '../persistence/execution-attempt-repo.js';
import { StrategyDecisionRepository } from '../persistence/strategy-decision-repo.js';
import { ModeAwareExecutionService } from './mode-aware-execution-service.js';
import { ExecutionRiskGuard } from './execution-risk-guard.js';

// ---------------------------------------------------------------------------
// ExecutionGateSupervisor
// ---------------------------------------------------------------------------

export class ExecutionGateSupervisor implements TickWork {
  readonly label = 'execution-gate';

  private readonly _strategyDecisionRepo: StrategyDecisionRepository;
  private readonly _executionService: ModeAwareExecutionService;
  private readonly _attemptRepo: ExecutionAttemptRepository;
  private readonly _brokerRepo: BrokerRepository | null;
  private readonly _riskGuard: ExecutionRiskGuard | null;

  constructor(options: {
    strategyDecisionRepo: StrategyDecisionRepository;
    executionService: ModeAwareExecutionService;
    attemptRepo: ExecutionAttemptRepository;
    brokerRepo?: BrokerRepository | null;
    /** Optional execution risk guard for market-hours, duplicate, exposure, daily-loss checks. */
    riskGuard?: ExecutionRiskGuard | null;
  }) {
    this._strategyDecisionRepo = options.strategyDecisionRepo;
    this._executionService = options.executionService;
    this._attemptRepo = options.attemptRepo;
    this._brokerRepo = options.brokerRepo ?? null;
    this._riskGuard = options.riskGuard ?? null;
  }

  // ── Public accessors ────────────────────────────────────────────────────

  /** The active execution mode. */
  get mode(): string {
    return this._executionService.mode;
  }

  /** Whether the risk guard is active. */
  get hasRiskGuard(): boolean {
    return this._riskGuard !== null;
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

      let refusedCount = 0;
      let haltedCount = 0;

      // Execute each candidate through the mode-aware service,
      // enriching with persisted quote and instrument data when available.
      for (const candidate of candidates) {
        // ── Risk guard evaluation ─────────────────────────────────────
        if (this._riskGuard !== null) {
          const guardResult = this._riskGuard.evaluate(candidate, _now);

          if (guardResult.verdict === 'refuse') {
            refusedCount++;
            console.log(
              `[execution-gate] Risk guard REFUSED ${candidate.exchange}:${candidate.tradingsymbol} ` +
              `(${candidate.product}, ${candidate.side}): ${guardResult.refusalReasons[0]?.reasonMessage ?? 'Unknown'}`,
            );
            continue; // Skip — don't pass to execution service
          }

          if (guardResult.verdict === 'halt') {
            haltedCount++;
            console.log(
              `[execution-gate] Risk guard HALTED execution for ` +
              `${candidate.exchange}:${candidate.tradingsymbol}: ` +
              `${guardResult.refusalReasons[0]?.reasonMessage ?? 'Runtime halted'}`,
            );
            // No more candidates can execute after a halt
            break;
          }

          // verdict === 'allow' — proceed to execution
        }

        let quote = null;
        let instrument = null;

        if (this._brokerRepo !== null) {
          quote = this._brokerRepo.getQuote(candidate.exchange, candidate.tradingsymbol) ?? null;
          instrument = this._brokerRepo.getInstrument(candidate.exchange, candidate.tradingsymbol) ?? null;
        }

        await this._executionService.execute(candidate, quote, instrument);
      }

      const consumedCount = candidates.length - refusedCount - haltedCount;
      console.log(
        `[execution-gate] processed ${candidates.length} candidate(s): ` +
        `${consumedCount} consumed, ${refusedCount} refused, ${haltedCount} halted ` +
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
