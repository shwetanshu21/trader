// ── ModeAwareExecutionService — centralized execution routing authority ──
//
// This is the single entry point for all execution attempts. It:
//   1. Checks idempotency (is the candidate already consumed?)
//   2. Routes to the mode-appropriate adapter (blocked | paper | live)
//   3. Persists the execution attempt with refusal reasons
//
// Mode routing rules:
//   - blocked → always refuses via BlockedExecutionAdapter
//   - paper   → evaluates via PaperExecutionPolicy, persists result
//   - live    → delegates to LiveExecutionAdapter (BrokerPlacementPort)
//
// Invariants:
//   - live never falls back to paper implicitly
//   - paper never performs broker network calls
//   - blocked is always safe (fail-closed default)
//   - AlreadyConsumed candidates are refused with idempotency guard
//   - Every outcome is persisted as an execution attempt row

import {
  ExecutionAttemptStatus,
  ExecutionMode,
  ExecutionOutcomeCode,
  type ExecutionAttemptRow,
  type ExecutionRefusalReason,
  type NewExecutionAttempt,
  type StrategyApprovedCandidate,
} from '../types/runtime.js';
import type { QuoteSnapshot } from '../integrations/broker/types.js';
import type { InstrumentRecord } from '../integrations/broker/types.js';
import { ExecutionAttemptRepository } from '../persistence/execution-attempt-repo.js';
import { PaperExecutionPolicy } from './paper-execution-policy.js';
import { PaperExecutionLedger } from './paper-execution-ledger.js';
import { BlockedExecutionAdapter, LiveExecutionAdapter } from './execution-adapters.js';

// ---------------------------------------------------------------------------
// ModeAwareExecutionService
// ---------------------------------------------------------------------------

export class ModeAwareExecutionService {
  readonly label = 'mode-aware-execution';

  private readonly _attemptRepo: ExecutionAttemptRepository;
  private readonly _paperPolicy: PaperExecutionPolicy;
  private readonly _paperLedger: PaperExecutionLedger | null;
  private readonly _liveAdapter: LiveExecutionAdapter;
  private readonly _blockedAdapter: BlockedExecutionAdapter;
  private readonly _mode: ExecutionMode;

  constructor(options: {
    attemptRepo: ExecutionAttemptRepository;
    paperPolicy: PaperExecutionPolicy;
    paperLedger?: PaperExecutionLedger | null;
    liveAdapter: LiveExecutionAdapter | null;
    blockedAdapter?: BlockedExecutionAdapter;
    mode: ExecutionMode;
  }) {
    this._attemptRepo = options.attemptRepo;
    this._paperPolicy = options.paperPolicy;
    this._paperLedger = options.paperLedger ?? null;
    this._liveAdapter = options.liveAdapter ?? new LiveExecutionAdapter(null);
    this._blockedAdapter = options.blockedAdapter ?? new BlockedExecutionAdapter();
    this._mode = options.mode;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** The active execution mode. */
  get mode(): ExecutionMode {
    return this._mode;
  }

  /** Whether the live adapter is configured and ready. */
  get isLiveReady(): boolean {
    return this._liveAdapter.isReady;
  }

  /**
   * Execute a single strategy-approved candidate through the active mode.
   *
   * @param candidate - The strategy-approved trade candidate.
   * @param quote - Local quote snapshot (may be null).
   * @param instrument - Local instrument record (may be null).
   * @returns The persisted (or existing) execution attempt row.
   *
   * @throws {Error} If the repo persist fails (wraps SQLite errors).
   */
  async execute(
    candidate: StrategyApprovedCandidate,
    quote: QuoteSnapshot | null,
    instrument: InstrumentRecord | null,
  ): Promise<ExecutionAttemptRow> {
    // ── Idempotency guard ─────────────────────────────────────────────────
    // If a row already exists for this strategy decision, return it instead of
    // attempting a second insert (which would violate the UNIQUE constraint).
    const existing = this._attemptRepo.getByStrategyDecisionId(candidate.id);
    if (existing !== null) {
      return existing;
    }

    // ── Mode routing ──────────────────────────────────────────────────────
    switch (this._mode) {
      case ExecutionMode.Blocked:
        return this._handleBlocked(candidate);

      case ExecutionMode.Paper:
        return this._handlePaper(candidate, quote, instrument);

      case ExecutionMode.Live:
        return this._handleLive(candidate);
    }
  }

  // -------------------------------------------------------------------------
  // Mode handlers
  // -------------------------------------------------------------------------

  /**
   * Blocked mode: always refuses with ModeBlocked reason.
   * This is the fail-closed default behavior.
   */
  private _handleBlocked(candidate: StrategyApprovedCandidate): ExecutionAttemptRow {
    const result = this._blockedAdapter.execute(candidate);
    return this._persistWithReasons(candidate, result);
  }

  /**
   * Paper mode: evaluate using local quote/instrument data only.
   * Never makes broker network calls.
   *
   * When a paper ledger is configured, successful fills are written atomically
   * across execution_attempts, paper_orders, paper_fills, position_events,
   * and paper_positions in a single SQLite transaction.
   */
  private _handlePaper(
    candidate: StrategyApprovedCandidate,
    quote: QuoteSnapshot | null,
    instrument: InstrumentRecord | null,
  ): ExecutionAttemptRow {
    const evaluation = this._paperPolicy.evaluate(candidate, quote, instrument);

    if (evaluation.canFill) {
      // Route through the ledger for atomic multi-table persistence
      if (this._paperLedger !== null) {
        const ledgerResult = this._paperLedger.writeSuccessfulPaperFill(candidate, evaluation);
        return ledgerResult.attempt;
      }

      // Fallback: legacy path without ledger (attempt-only, no downstream rows)
      const now = Date.now();
      const attempt: NewExecutionAttempt = {
        strategyDecisionId: candidate.id,
        executionMode: ExecutionMode.Paper,
        status: ExecutionAttemptStatus.Completed,
        outcomeCode: evaluation.outcomeCode,
        brokerOrderId: evaluation.simulatedBrokerOrderId,
        message: evaluation.message,
        attemptedAt: now,
        completedAt: now,
      };

      return this._attemptRepo.insertAttempt(attempt);
    }

    // Paper evaluation could not fill — persist as refused
    const now = Date.now();
    const attempt: NewExecutionAttempt = {
      strategyDecisionId: candidate.id,
      executionMode: ExecutionMode.Paper,
      status: ExecutionAttemptStatus.Refused,
      outcomeCode: evaluation.outcomeCode,
      brokerOrderId: null,
      message: evaluation.message,
      attemptedAt: now,
      completedAt: now,
    };

    return this._attemptRepo.insertAttemptWithRefusalReasons(attempt, evaluation.refusalReasons);
  }

  /**
   * Live mode: delegate to the broker placement port.
   * Never falls back to paper implicitly.
   */
  private async _handleLive(candidate: StrategyApprovedCandidate): Promise<ExecutionAttemptRow> {
    const result = await this._liveAdapter.execute(candidate);

    if (result.refusalReasons.length > 0) {
      return this._persistWithReasons(candidate, result);
    }

    return this._persistSimple(candidate, result);
  }

  // -------------------------------------------------------------------------
  // Persistence helpers
  // -------------------------------------------------------------------------

  /** Persist an adapter result that includes refusal reasons. */
  private _persistWithReasons(
    candidate: StrategyApprovedCandidate,
    result: { status: ExecutionAttemptStatus; outcomeCode: ExecutionOutcomeCode | null; brokerOrderId: string | null; message: string; refusalReasons: ExecutionRefusalReason[] },
  ): ExecutionAttemptRow {
    const now = Date.now();
    const attempt: NewExecutionAttempt = {
      strategyDecisionId: candidate.id,
      executionMode: this._mode,
      status: result.status,
      outcomeCode: result.outcomeCode,
      brokerOrderId: result.brokerOrderId,
      message: result.message,
      attemptedAt: now,
      completedAt: result.status === ExecutionAttemptStatus.Refused || result.status === ExecutionAttemptStatus.Completed || result.status === ExecutionAttemptStatus.Failed ? now : null,
    };

    if (result.refusalReasons.length > 0) {
      return this._attemptRepo.insertAttemptWithRefusalReasons(attempt, result.refusalReasons);
    }

    return this._attemptRepo.insertAttempt(attempt);
  }

  /** Persist a simple result without refusal reasons. */
  private _persistSimple(
    candidate: StrategyApprovedCandidate,
    result: { status: ExecutionAttemptStatus; outcomeCode: ExecutionOutcomeCode | null; brokerOrderId: string | null; message: string },
  ): ExecutionAttemptRow {
    const now = Date.now();
    const attempt: NewExecutionAttempt = {
      strategyDecisionId: candidate.id,
      executionMode: this._mode,
      status: result.status,
      outcomeCode: result.outcomeCode,
      brokerOrderId: result.brokerOrderId,
      message: result.message,
      attemptedAt: now,
      completedAt: result.status === ExecutionAttemptStatus.Completed || result.status === ExecutionAttemptStatus.Failed ? now : null,
    };

    return this._attemptRepo.insertAttempt(attempt);
  }
}
