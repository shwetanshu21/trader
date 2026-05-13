// ── StrategyRiskSupervisor — TickWork that evaluates accepted proposals ──
// Runs on every scheduler tick: reads accepted proposals that have no
// strategy decision yet, loads quote + instrument data, calls the
// strategy-risk service for deterministic evaluation, and persists the
// decision (approved or refused with reasons).
//
// Order: runs after proposal supervisor, before execution gate.
//
// Error handling: failures are caught, logged, and re-thrown so the
// scheduler can degrade the lifecycle. The supervisor never:
//   - Mutates prior proposal verdicts
//   - Calls any broker order API
//   - Re-runs India validation
//   - Blocks the scheduler tick permanently

import type { TickWork } from '../runtime/scheduler.js';
import type { HealthStatus } from '../types/runtime.js';
import type {
  NewStrategyDecision,
  StrategyDecisionReason,
  QuoteSnapshot,
  InstrumentRecord,
} from '../types/runtime.js';
import { StrategyDecisionRepository } from '../persistence/strategy-decision-repo.js';
import { BrokerRepository } from '../persistence/broker-repo.js';

// ---------------------------------------------------------------------------
// Port interface — consumed by the supervisor, implemented by
// src/strategy-risk/strategy-risk-service.ts (T02 deliverable).
// ---------------------------------------------------------------------------

/** Input payload for a single strategy evaluation. */
export interface StrategyEvaluationInput {
  proposalAttemptId: number;
  exchange: string;
  tradingsymbol: string;
  instrumentToken: number | null;
  side: string;
  product: string;
  quantity: number;
  price: number | null;
  triggerPrice: number | null;
  orderType: string;
  /** Quote snapshot at decision time (may be null if unavailable). */
  quote: QuoteSnapshot | null;
  /** Instrument metadata (may be null if lookup failed). */
  instrument: InstrumentRecord | null;
}

/** Output from a strategy evaluation. */
export interface StrategyEvaluationResult {
  decision: NewStrategyDecision;
  reasons: StrategyDecisionReason[];
}

/** Port interface that the strategy-risk service must implement. */
export interface StrategyRiskPort {
  evaluateProposal(input: StrategyEvaluationInput): Promise<StrategyEvaluationResult>;
}

// ---------------------------------------------------------------------------
// StrategyRiskSupervisor — TickWork implementation
// ---------------------------------------------------------------------------

export class StrategyRiskSupervisor implements TickWork {
  readonly label = 'strategy-risk';

  private readonly _strategyRepo: StrategyDecisionRepository;
  private readonly _brokerRepo: BrokerRepository;
  private readonly _riskService: StrategyRiskPort;

  /** Diagnostics: count of proposals evaluated this tick. */
  private _lastTickCount: number = 0;

  constructor(options: {
    strategyRepo: StrategyDecisionRepository;
    brokerRepo: BrokerRepository;
    riskService: StrategyRiskPort;
  }) {
    this._strategyRepo = options.strategyRepo;
    this._brokerRepo = options.brokerRepo;
    this._riskService = options.riskService;
  }

  // ── TickWork ────────────────────────────────────────────────────────────

  async doWork(_now: Date, _health: HealthStatus): Promise<void> {
    try {
      // Query accepted proposals that have NOT yet had a strategy decision
      const unprocessed = this._strategyRepo.getAcceptedProposalsWithoutDecisions();

      if (unprocessed.length === 0) {
        this._lastTickCount = 0;
        return;
      }

      let evaluatedCount = 0;

      for (const proposal of unprocessed) {
        // Load quote snapshot + instrument metadata from broker store
        const quote = this._brokerRepo.getQuote(proposal.exchange, proposal.tradingsymbol);
        const instrument = this._brokerRepo.getInstrument(proposal.exchange, proposal.tradingsymbol);

        // Build input for the strategy-risk service
        const input: StrategyEvaluationInput = {
          proposalAttemptId: proposal.proposalAttemptId,
          exchange: proposal.exchange,
          tradingsymbol: proposal.tradingsymbol,
          instrumentToken: proposal.instrumentToken,
          side: proposal.side,
          product: proposal.product,
          quantity: proposal.quantity,
          price: proposal.price,
          triggerPrice: proposal.triggerPrice,
          orderType: proposal.orderType,
          quote,
          instrument,
        };

        // Call the strategy-risk service for deterministic evaluation
        const result = await this._riskService.evaluateProposal(input);

        // Persist the decision with its reasons (if any)
        this._strategyRepo.insertDecisionWithReasons(result.decision, result.reasons);

        evaluatedCount++;
      }

      if (evaluatedCount > 0) {
        console.log(
          `[strategy-risk] evaluated ${evaluatedCount} proposal(s) ` +
          `(${unprocessed.length - evaluatedCount} skipped or errored)`,
        );
      }

      this._lastTickCount = evaluatedCount;
    } catch (err) {
      // Fail-closed: errors degrade the lifecycle but do not:
      //   - crash the scheduler
      //   - mutate prior proposal/strategy verdicts
      //   - attempt downstream execution
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[strategy-risk] Tick failure: ${errorMsg}`);

      // Re-throw so the scheduler can degrade the lifecycle
      throw err;
    }
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────

  /** Return count of proposals evaluated on the most recent tick. */
  getLastTickCount(): number {
    return this._lastTickCount;
  }
}

// ---------------------------------------------------------------------------
// Default export — wired from expected strategy-risk-service path
// ---------------------------------------------------------------------------

// Re-export the port types so consumers can import from a single location
export type { NewStrategyDecision, StrategyDecisionReason, QuoteSnapshot, InstrumentRecord };
