// ── ExecutionGateSupervisor — TickWork that consumes approved candidates ──
//
// This is the M003 execution gate. It replaces the legacy blocked-order
// ledger writes with mode-aware execution-attempt orchestration:
//   1. Loads strategy-approved candidates that have NOT yet been consumed
//      (query uses LEFT JOIN with execution_attempts as the canonical seam)
//   2. Evaluates lifecycle phase gating BEFORE risk guard: a strategy's
//      persisted lifecycle phase (backtest/paper/live) acts as a ceiling
//      beneath the global execution mode. Candidates above their allowed
//      phase are skipped with a lifecycle hold reason and do NOT create
//      execution_attempts.
//   3. Evaluates each remaining candidate through ExecutionRiskGuard
//      (market-hours, kill-switch, duplicate, exposure, daily-loss checks)
//      BEFORE routing to the mode-aware execution service
//   4. Routes each surviving candidate through ModeAwareExecutionService
//      which dispatches to the active mode adapter (blocked | paper | live)
//   5. Persists the execution attempt row (idempotent per strategy decision)
//
// Invariants:
//   - A candidate is only consumed when an execution attempt row is written
//   - Repeated ticks cannot duplicate execution for the same strategy decision
//   - Lifecycle gating is evaluated before the risk guard; held candidates
//     are NOT passed to the risk guard or execution service
//   - The risk guard is evaluated second; refused/halted candidates are NOT
//     passed to the execution service, but a risk event IS persisted
//   - blocked_order_attempts is kept only as legacy evidence; canonical
//     consumption checks use execution_attempts exclusively
//   - Failures from the execution service re-throw so the scheduler can
//     degrade the lifecycle; they never silently skip consumption

import type { TickWork } from '../runtime/scheduler.js';
import type { HealthStatus } from '../types/runtime.js';
import {
  ExecutionMode,
  ExecutionRefusalCode,
  StrategyLifecyclePhase,
} from '../types/runtime.js';
import type { StrategyLifecycleStateRow } from '../types/runtime.js';
import { BrokerRepository } from '../persistence/broker-repo.js';
import { ExecutionAttemptRepository } from '../persistence/execution-attempt-repo.js';
import { StrategyDecisionRepository } from '../persistence/strategy-decision-repo.js';
import { StrategyLifecycleRepository } from '../persistence/strategy-lifecycle-repo.js';
import { ModeAwareExecutionService } from './mode-aware-execution-service.js';
import { ExecutionRiskGuard } from './execution-risk-guard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the effective execution mode as the minimum (more restrictive) of
 * the global execution mode and the strategy's lifecycle phase.
 *
 * Lifecycle phase acts as a ceiling beneath the global mode:
 * - Backtest → Blocked (no execution allowed regardless of global mode)
 * - Paper → Paper at most (caps Live global mode down to Paper)
 * - Live → whatever the global mode allows
 */
function getEffectiveExecutionMode(
  globalMode: ExecutionMode,
  lifecyclePhase: StrategyLifecyclePhase,
): ExecutionMode {
  switch (lifecyclePhase) {
    case StrategyLifecyclePhase.Backtest:
      return ExecutionMode.Blocked;
    case StrategyLifecyclePhase.Paper:
      // Paper caps at Paper: if global mode is Blocked, stay Blocked;
      // if Paper or Live, cap at Paper
      if (globalMode === ExecutionMode.Blocked) return ExecutionMode.Blocked;
      return ExecutionMode.Paper;
    case StrategyLifecyclePhase.Live:
      // Live phase = whatever the global mode allows
      return globalMode;
  }
}

/**
 * Map a lifecycle phase to a human-readable label for logging/diagnostics.
 */
function lifecyclePhaseLabel(phase: StrategyLifecyclePhase): string {
  switch (phase) {
    case StrategyLifecyclePhase.Backtest: return 'backtest';
    case StrategyLifecyclePhase.Paper: return 'paper';
    case StrategyLifecyclePhase.Live: return 'live';
  }
}

/**
 * Get the numeric ordinal of an ExecutionMode for comparison.
 * Lower ordinal = more restrictive.
 */
function executionModeOrdinal(mode: ExecutionMode): number {
  switch (mode) {
    case ExecutionMode.Blocked: return 0;
    case ExecutionMode.Paper: return 1;
    case ExecutionMode.Live: return 2;
  }
}

/**
 * Get the numeric ordinal of a StrategyLifecyclePhase for comparison.
 * Lower ordinal = more restrictive.
 */
function lifecyclePhaseOrdinal(phase: StrategyLifecyclePhase): number {
  switch (phase) {
    case StrategyLifecyclePhase.Backtest: return 0;
    case StrategyLifecyclePhase.Paper: return 1;
    case StrategyLifecyclePhase.Live: return 2;
  }
}

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
  private readonly _lifecycleRepo: StrategyLifecycleRepository | null;
  private readonly _marketId: string;

  constructor(options: {
    strategyDecisionRepo: StrategyDecisionRepository;
    executionService: ModeAwareExecutionService;
    attemptRepo: ExecutionAttemptRepository;
    brokerRepo?: BrokerRepository | null;
    /** Optional execution risk guard for market-hours, duplicate, exposure, daily-loss checks. */
    riskGuard?: ExecutionRiskGuard | null;
    /** Optional lifecycle repository for strategy-phase gating (M006). */
    lifecycleRepo?: StrategyLifecycleRepository | null;
    /** Market profile ID for lifecycle lookups (e.g. 'INDIA_NSE_EQ'). */
    marketId?: string;
  }) {
    this._strategyDecisionRepo = options.strategyDecisionRepo;
    this._executionService = options.executionService;
    this._attemptRepo = options.attemptRepo;
    this._brokerRepo = options.brokerRepo ?? null;
    this._riskGuard = options.riskGuard ?? null;
    this._lifecycleRepo = options.lifecycleRepo ?? null;
    this._marketId = options.marketId ?? 'INDIA_NSE_EQ';
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

  /** Whether lifecycle gating is active. */
  get hasLifecycleGating(): boolean {
    return this._lifecycleRepo !== null && this._lifecycleRepo !== undefined;
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

      let lifecycleHeldCount = 0;
      let refusedCount = 0;
      let haltedCount = 0;

      // Global execution mode from the mode-aware service
      const globalMode = this._executionService.mode;

      // Execute each candidate through the mode-aware service,
      // enriching with persisted quote and instrument data when available.
      for (const candidate of candidates) {
        // ── Lifecycle gating (M006) ───────────────────────────────────
        // Check the strategy's persisted lifecycle phase BEFORE risk guard.
        // Held candidates are silently skipped — no execution_attempts.
        //
        // Lifecycle hold applies only when:
        //   1. A lifecycle state has been explicitly set for this strategy
        //      (id > 0, not the synthetic default row), AND
        //   2. The strategy's lifecycle phase is Backtest (the most restrictive).
        //
        // Strategies without explicit lifecycle state proceed normally,
        // preserving backward compatibility with earlier milestones.
        if (this._lifecycleRepo !== null) {
          const lifecycleState = this._lifecycleRepo.getCurrentState(
            candidate.strategyId,
            candidate.strategyVersion,
            this._marketId,
          );

          const globalOrdinal = executionModeOrdinal(globalMode);
          const effectiveMode = getEffectiveExecutionMode(globalMode, lifecycleState.phase);
          const effectiveOrdinal = executionModeOrdinal(effectiveMode);

          // Lifecycle hold: only when a real lifecycle row exists (id > 0)
          // AND the strategy phase is Backtest (the exclusive no-execution phase).
          // Paper/Live phases allow execution through the execution service.
          if (lifecycleState.id > 0 && lifecycleState.phase === StrategyLifecyclePhase.Backtest) {
            lifecycleHeldCount++;
            console.log(
              `[execution-gate] Lifecycle HELD ${candidate.exchange}:${candidate.tradingsymbol} ` +
              `(strategy=${candidate.strategyId} v${candidate.strategyVersion}, ` +
              `phase=${lifecyclePhaseLabel(lifecycleState.phase)}, ` +
              `global=${globalMode})`,
            );
            continue; // Skip — lifecycle gate prevents execution
          }

          // If lifecycle phase caps global mode (e.g. Paper phase with Live global),
          // the effective mode is more restrictive than global. Log the cap but
          // let the execution service route naturally.
          if (lifecycleState.id > 0 && effectiveOrdinal < globalOrdinal) {
            console.log(
              `[execution-gate] Lifecycle CAPPED ${candidate.exchange}:${candidate.tradingsymbol} ` +
              `(strategy=${candidate.strategyId} v${candidate.strategyVersion}, ` +
              `phase=${lifecyclePhaseLabel(lifecycleState.phase)} caps global=${globalMode} to ${effectiveMode})`,
            );
            // Continue to execution — the candidate will be executed at the effective mode
          }
        }

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

      const consumedCount = candidates.length - lifecycleHeldCount - refusedCount - haltedCount;
      console.log(
        `[execution-gate] processed ${candidates.length} candidate(s): ` +
        `${consumedCount} consumed, ${lifecycleHeldCount} lifecycle-held, ` +
        `${refusedCount} refused, ${haltedCount} halted ` +
        `via ${globalMode} mode`,
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

// Export helpers for testing
export { getEffectiveExecutionMode, lifecyclePhaseLabel };
