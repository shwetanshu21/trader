import type { TickWork } from '../runtime/scheduler.js';
import type { HealthStatus, PaperPositionRow, StrategyApprovedCandidate } from '../types/runtime.js';
import { ExecutionMode, ProposalStatus, StrategyDecisionStatus } from '../types/runtime.js';
import { BrokerRepository } from '../persistence/broker-repo.js';
import { PaperPositionRepository } from '../persistence/paper-position-repo.js';
import { ProposalRepository } from '../persistence/proposal-repo.js';
import { StrategyDecisionRepository } from '../persistence/strategy-decision-repo.js';
import { ModeAwareExecutionService } from './mode-aware-execution-service.js';

export class PaperPositionManager implements TickWork {
  readonly label = 'paper-position-manager';

  constructor(private readonly _deps: {
    brokerRepo: BrokerRepository;
    positionRepo: PaperPositionRepository;
    proposalRepo: ProposalRepository;
    strategyRepo: StrategyDecisionRepository;
    executionService: ModeAwareExecutionService;
  }) {}

  async doWork(_now: Date, _health: HealthStatus): Promise<void> {
    if (this._deps.executionService.mode !== ExecutionMode.Paper) {
      return;
    }

    const openPositions = this._deps.positionRepo.getOpenPositions();
    for (const position of openPositions) {
      const quote = this._deps.brokerRepo.getQuote(position.exchange, position.tradingsymbol);
      if (!quote || quote.lastPrice <= 0) continue;

      const next = this._computeManagedState(position, quote.lastPrice, Date.now());
      this._deps.positionRepo.upsertPosition(next);

      if (this._shouldExit(next, quote.lastPrice)) {
        await this._exitPosition(next, quote.lastPrice);
      }
    }
  }

  private _computeManagedState(position: PaperPositionRow, lastPrice: number, now: number): PaperPositionRow {
    let trailingAnchorPrice = position.trailingAnchorPrice;
    if (position.side === 'long') {
      trailingAnchorPrice = trailingAnchorPrice == null ? lastPrice : Math.max(trailingAnchorPrice, lastPrice);
    } else if (position.side === 'short') {
      trailingAnchorPrice = trailingAnchorPrice == null ? lastPrice : Math.min(trailingAnchorPrice, lastPrice);
    }

    let stopPrice = position.stopPrice;
    if (position.trailingStopDistance != null && trailingAnchorPrice != null) {
      if (position.side === 'long') {
        const candidateStop = trailingAnchorPrice - position.trailingStopDistance;
        stopPrice = stopPrice == null ? candidateStop : Math.max(stopPrice, candidateStop);
      } else if (position.side === 'short') {
        const candidateStop = trailingAnchorPrice + position.trailingStopDistance;
        stopPrice = stopPrice == null ? candidateStop : Math.min(stopPrice, candidateStop);
      }
    }

    return {
      ...position,
      stopPrice,
      trailingAnchorPrice,
      markPrice: lastPrice,
      markedAt: now,
      updatedAt: now,
    };
  }

  private _shouldExit(position: PaperPositionRow, lastPrice: number): boolean {
    if (position.stopPrice == null) return false;
    if (position.side === 'long') return lastPrice <= position.stopPrice;
    if (position.side === 'short') return lastPrice >= position.stopPrice;
    return false;
  }

  private async _exitPosition(position: PaperPositionRow, lastPrice: number): Promise<void> {
    const quantity = Math.abs(position.quantity);
    if (quantity <= 0) return;

    const proposal = this._deps.proposalRepo.insertAttempt({
      exchange: position.exchange,
      tradingsymbol: position.tradingsymbol,
      instrumentToken: this._deps.brokerRepo.getInstrument(position.exchange, position.tradingsymbol)?.instrumentToken ?? null,
      side: position.side === 'long' ? 'sell' : 'buy',
      product: position.product,
      quantity,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      tag: 'paper-stop-exit',
      proposalStatus: ProposalStatus.Accepted,
      createdAt: Date.now(),
    });

    const decision = this._deps.strategyRepo.insertDecision({
      proposalAttemptId: proposal.id,
      decisionStatus: StrategyDecisionStatus.Approved,
      strategyId: 'paper-stop-manager',
      strategyVersion: '1.0.0',
      decidedAt: Date.now(),
      exchange: position.exchange,
      tradingsymbol: position.tradingsymbol,
      side: position.side === 'long' ? 'sell' : 'buy',
      product: position.product,
      quantity,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      quoteLastPrice: lastPrice,
      quoteBid: lastPrice,
      quoteAsk: lastPrice,
      quoteVolume: null,
      quoteReceivedAt: Date.now(),
      riskNotional: quantity * lastPrice,
      riskSizingBasis: 'paper_stop_exit',
      riskMaxLossRupees: null,
      riskStopDistance: null,
      riskStopPrice: null,
      riskTrailingStopDistance: null,
      riskBudgetRupees: null,
      riskExposureTag: 'exit',
      indiaResearchEvidence: null,
      executionClass: 'EQ',
      segment: position.exchange,
      instrumentType: 'EQ',
      expiry: null,
      strike: null,
      lotSize: 1,
      tickSize: 0.05,
      freezeQuantity: null,
    });

    const candidate: StrategyApprovedCandidate = {
      id: decision.id,
      proposalAttemptId: decision.proposalAttemptId,
      strategyId: decision.strategyId,
      strategyVersion: decision.strategyVersion,
      decidedAt: decision.decidedAt,
      exchange: decision.exchange,
      tradingsymbol: decision.tradingsymbol,
      side: decision.side,
      product: decision.product,
      quantity: decision.quantity,
      price: decision.price,
      triggerPrice: decision.triggerPrice,
      orderType: decision.orderType,
      lastPrice,
      bid: lastPrice,
      ask: lastPrice,
      notional: decision.riskNotional,
      sizingBasis: decision.riskSizingBasis,
      maxLossRupees: decision.riskMaxLossRupees,
      stopDistance: decision.riskStopDistance,
      stopPrice: decision.riskStopPrice,
      trailingStopDistance: decision.riskTrailingStopDistance,
      riskBudgetRupees: decision.riskBudgetRupees,
      executionClass: decision.executionClass,
      segment: decision.segment,
      instrumentType: decision.instrumentType,
      expiry: decision.expiry,
      strike: decision.strike,
      lotSize: decision.lotSize,
      tickSize: decision.tickSize,
      freezeQuantity: decision.freezeQuantity,
    };

    await this._deps.executionService.execute(candidate, this._deps.brokerRepo.getQuote(position.exchange, position.tradingsymbol), this._deps.brokerRepo.getInstrument(position.exchange, position.tradingsymbol));
  }
}
