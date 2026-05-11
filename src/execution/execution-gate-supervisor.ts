// ── ExecutionGateSupervisor — TickWork that hard-blocks every accepted proposal ──
//
// This is the M001 execution gate. Its sole downstream action for an accepted
// proposal is writing a blocked-order ledger row. It never:
//   - Calls any broker order API
//   - Re-runs India validation
//   - Fetches fresh broker state
//   - Mutates prior proposal verdicts
//
// Invariant block metadata is encoded once here:
//   blockCode: MilestoneExecutionBlockM001
//   gateTag:   'M001-hard-block'
//   blockMessage: descriptive hard-block notice
//
// Idempotency is handled by BlockedOrderRepository.insertBlockedOrder which
// uses INSERT OR IGNORE + fallback read for UNIQUE(proposal_attempt_id).

import type { TickWork } from '../runtime/scheduler.js';
import type { HealthStatus } from '../types/runtime.js';
import { BlockCode } from '../types/runtime.js';
import { BlockedOrderRepository } from '../persistence/blocked-order-repo.js';

// ---------------------------------------------------------------------------
// Constants — M001 invariant block metadata
// ---------------------------------------------------------------------------

const M001_BLOCK_MESSAGE =
  'M001 hard block: live order placement is disabled for this milestone';
const M001_GATE_TAG = 'M001-hard-block';

// ---------------------------------------------------------------------------
// ExecutionGateSupervisor
// ---------------------------------------------------------------------------

export class ExecutionGateSupervisor implements TickWork {
  readonly label = 'execution-gate';

  private readonly _blockedRepo: BlockedOrderRepository;

  constructor(options: { blockedRepo: BlockedOrderRepository }) {
    this._blockedRepo = options.blockedRepo;
  }

  // ── TickWork ────────────────────────────────────────────────────────────

  async doWork(_now: Date, _health: HealthStatus): Promise<void> {
    try {
      // Query accepted proposals that have NOT yet been blocked
      const unblocked = this._blockedRepo.getAcceptedUnblockedAttempts();

      if (unblocked.length === 0) {
        // No work to do — this is not an error
        return;
      }

      // Insert a blocked-order ledger row for every unblocked accepted proposal
      for (const proposal of unblocked) {
        this._blockedRepo.insertBlockedOrder({
          proposalAttemptId: proposal.proposalAttemptId,
          blockedAt: Date.now(),
          blockCode: BlockCode.MilestoneExecutionBlockM001,
          blockMessage: M001_BLOCK_MESSAGE,
          gateTag: M001_GATE_TAG,

          // Proposal snapshot fields (copied at block time)
          exchange: proposal.exchange,
          tradingsymbol: proposal.tradingsymbol,
          instrumentToken: proposal.instrumentToken,
          side: proposal.side,
          product: proposal.product,
          quantity: proposal.quantity,
          price: proposal.price,
          triggerPrice: proposal.triggerPrice,
          orderType: proposal.orderType,
        });
      }

      console.log(
        `[execution-gate] blocked ${unblocked.length} accepted proposal(s) ` +
        `(M001 hard block)`,
      );
    } catch (err) {
      // Fail-closed: gate errors degrade the lifecycle but do not:
      //   - attempt live execution fallback
      //   - crash the scheduler
      //   - mutate prior proposal verdicts
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[execution-gate] Gate failure: ${errorMsg}`);

      // Re-throw so the scheduler can degrade the lifecycle
      throw err;
    }
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────

  /** Return count of blocked rows for health/observability surfaces. */
  getBlockedCount(): number {
    return this._blockedRepo.count();
  }
}
