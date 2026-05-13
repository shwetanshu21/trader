// ── Execution adapters — mode-specific execution behaviors ──
//
// Each adapter encapsulates the execution behavior for a specific mode:
//   - BlockedExecutionAdapter: fail-closed, always refuses
//   - LiveExecutionAdapter: delegates to BrokerPlacementPort
//
// All adapters produce outcomes shaped for direct persistence by
// ExecutionAttemptRepository.

import {
  ExecutionAttemptStatus,
  ExecutionOutcomeCode,
  ExecutionRefusalCode,
  type ExecutionRefusalReason,
  type BrokerPlacementPort,
  type OrderPlacementParams,
  type OrderPlacementResult,
  type StrategyApprovedCandidate,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/** Structured result from an execution adapter. */
export interface AdapterExecutionResult {
  /** Status for the execution attempt. */
  readonly status: ExecutionAttemptStatus;
  /** Outcome code (null for refusals). */
  readonly outcomeCode: ExecutionOutcomeCode | null;
  /** Broker order ID if one was obtained. */
  readonly brokerOrderId: string | null;
  /** Human-readable result message. */
  readonly message: string;
  /** Machine-readable refusal reasons (empty when not refused). */
  readonly refusalReasons: ExecutionRefusalReason[];
  /** Whether this adapter encountered an error condition. */
  readonly isError: boolean;
}

// ---------------------------------------------------------------------------
// BlockedExecutionAdapter
// ---------------------------------------------------------------------------

/**
 * Blocked execution adapter — always refusess with a machine-readable
 * ModeBlocked reason. This is the fail-closed default.
 */
export class BlockedExecutionAdapter {
  readonly label = 'blocked';

  /**
   * Execute in blocked mode: always refuses the candidate with ModeBlocked.
   */
  execute(candidate: StrategyApprovedCandidate): AdapterExecutionResult {
    const refusalReasons: ExecutionRefusalReason[] = [
      {
        reasonCode: ExecutionRefusalCode.ModeBlocked,
        reasonMessage:
          `Execution mode is 'blocked': attempt refused for strategy decision ${candidate.id} ` +
          `(${candidate.exchange}:${candidate.tradingsymbol})`,
      },
    ];

    return {
      status: ExecutionAttemptStatus.Refused,
      outcomeCode: null,
      brokerOrderId: null,
      message: `Blocked: execution mode is 'blocked' (candidate ${candidate.id})`,
      refusalReasons,
      isError: false,
    };
  }
}

// ---------------------------------------------------------------------------
// LiveExecutionAdapter
// ---------------------------------------------------------------------------

/**
 * Live execution adapter — delegates order placement to a BrokerPlacementPort.
 *
 * Fail-closed invariants:
 * - If the port is null or not ready, returns a LiveBrokerNotConfigured refusal.
 * - If the port throws or returns a malformed result, returns a Failed status
 *   with a descriptive message.
 * - Never silently downgrades to paper.
 */
export class LiveExecutionAdapter {
  readonly label = 'live';

  private readonly _port: BrokerPlacementPort | null;

  constructor(port: BrokerPlacementPort | null) {
    this._port = port;
  }

  /** Whether the live adapter has a configured and ready port. */
  get isReady(): boolean {
    return this._port !== null && this._port.isReady;
  }

  /**
   * Execute in live mode: place an order through the broker port.
   * Returns a refusal when the port is unavailable.
   */
  async execute(candidate: StrategyApprovedCandidate): Promise<AdapterExecutionResult> {
    // Fail-closed: no port → live-disabled outcome
    if (this._port === null) {
      return {
        status: ExecutionAttemptStatus.Refused,
        outcomeCode: null,
        brokerOrderId: null,
        message:
          `Live execution unavailable: no broker placement port configured ` +
          `(candidate ${candidate.id})`,
        refusalReasons: [
          {
            reasonCode: ExecutionRefusalCode.LiveBrokerNotConfigured,
            reasonMessage: 'No broker placement port is configured for live execution',
          },
        ],
        isError: false,
      };
    }

    if (!this._port.isReady) {
      return {
        status: ExecutionAttemptStatus.Refused,
        outcomeCode: null,
        brokerOrderId: null,
        message:
          `Live execution unavailable: broker placement port is not ready ` +
          `(candidate ${candidate.id})`,
        refusalReasons: [
          {
            reasonCode: ExecutionRefusalCode.LiveBrokerNotConfigured,
            reasonMessage: 'Broker placement port is configured but not ready',
          },
        ],
        isError: false,
      };
    }

    // Build order placement params from the candidate
    const params: OrderPlacementParams = {
      exchange: candidate.exchange,
      tradingsymbol: candidate.tradingsymbol,
      side: candidate.side,
      product: candidate.product,
      quantity: candidate.quantity,
      price: candidate.price,
      triggerPrice: candidate.triggerPrice,
      orderType: candidate.orderType,
    };

    try {
      const result: OrderPlacementResult = await this._port.placeOrder(params);

      if (result.success && result.brokerOrderId) {
        return {
          status: ExecutionAttemptStatus.Completed,
          outcomeCode: result.outcomeCode,
          brokerOrderId: result.brokerOrderId,
          message: result.message,
          refusalReasons: [],
          isError: false,
        };
      }

      // Broker returned a failure
      return {
        status: ExecutionAttemptStatus.Failed,
        outcomeCode: result.outcomeCode,
        brokerOrderId: null,
        message: result.message,
        refusalReasons: [],
        isError: true,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      return {
        status: ExecutionAttemptStatus.Failed,
        outcomeCode: ExecutionOutcomeCode.OrderRejected,
        brokerOrderId: null,
        message: `Live execution adapter threw: ${errorMsg}`,
        refusalReasons: [],
        isError: true,
      };
    }
  }
}
