import { describe, it, expect } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { BrokerRepository } from '../src/persistence/broker-repo.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import { StrategyDecisionRepository } from '../src/persistence/strategy-decision-repo.js';
import { ExecutionAttemptRepository } from '../src/persistence/execution-attempt-repo.js';
import { PaperOrderRepository } from '../src/persistence/paper-order-repo.js';
import { PaperFillRepository } from '../src/persistence/paper-fill-repo.js';
import { PaperPositionRepository } from '../src/persistence/paper-position-repo.js';
import { PaperExecutionPolicy } from '../src/execution/paper-execution-policy.js';
import { PaperExecutionLedger } from '../src/execution/paper-execution-ledger.js';
import { ModeAwareExecutionService } from '../src/execution/mode-aware-execution-service.js';
import { BlockedExecutionAdapter, LiveExecutionAdapter } from '../src/execution/execution-adapters.js';
import { PaperPositionManager } from '../src/execution/paper-position-manager.js';
import { ExecutionMode, PositionSide, ProposalStatus, StrategyDecisionStatus } from '../src/types/runtime.js';

function minimalHealth() {
  return {
    verdict: 'healthy',
    checkedAt: Date.now(),
    uptimeMs: 0,
    checks: [],
  } as any;
}

describe('PaperPositionManager', () => {
  it('trails a long stop upward and exits when price crosses stop', async () => {
    const mgr = new DatabaseManager(':memory:');
    const db = mgr.db;
    const brokerRepo = new BrokerRepository(db);
    const proposalRepo = new ProposalRepository(db);
    const strategyRepo = new StrategyDecisionRepository(db);
    const attemptRepo = new ExecutionAttemptRepository(db);
    const orderRepo = new PaperOrderRepository(db);
    const fillRepo = new PaperFillRepository(db);
    const positionRepo = new PaperPositionRepository(db);
    const paperLedger = new PaperExecutionLedger({ db, attemptRepo, orderRepo, fillRepo, positionRepo });
    const executionService = new ModeAwareExecutionService({
      attemptRepo,
      paperPolicy: new PaperExecutionPolicy(),
      paperLedger,
      liveAdapter: new LiveExecutionAdapter(null),
      blockedAdapter: new BlockedExecutionAdapter(),
      mode: ExecutionMode.Paper,
    });
    const manager = new PaperPositionManager({ brokerRepo, positionRepo, proposalRepo, strategyRepo, executionService });

    brokerRepo.upsertInstruments([{
      exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 123, name: 'Reliance', expiry: null,
      strike: null, lotSize: 1, tickSize: 0.05, instrumentType: 'EQ', segment: 'NSE', exchangeToken: 123, freezeQuantity: null,
    }]);

    const proposal = proposalRepo.insertAttempt({
      exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 123, side: 'buy', product: 'MIS', quantity: 10,
      price: null, triggerPrice: null, orderType: 'MARKET', tag: null, proposalStatus: ProposalStatus.Accepted, createdAt: Date.now(),
    });
    const decision = strategyRepo.insertDecision({
      proposalAttemptId: proposal.id,
      decisionStatus: StrategyDecisionStatus.Approved,
      strategyId: 'test', strategyVersion: '1.0.0', decidedAt: Date.now(),
      exchange: 'NSE', tradingsymbol: 'RELIANCE', side: 'buy', product: 'MIS', quantity: 10,
      price: null, triggerPrice: null, orderType: 'MARKET',
      quoteLastPrice: 100, quoteBid: 100, quoteAsk: 100, quoteVolume: null, quoteReceivedAt: Date.now(),
      riskNotional: 1000, riskSizingBasis: 'last_price', riskMaxLossRupees: 100,
      riskStopDistance: 5, riskStopPrice: 95, riskTrailingStopDistance: 5, riskBudgetRupees: 100,
      riskExposureTag: 'intraday', indiaResearchEvidence: null,
      executionClass: 'EQ', segment: 'NSE', instrumentType: 'EQ', expiry: null, strike: null, lotSize: 1, tickSize: 0.05, freezeQuantity: null,
    });

    await executionService.execute({
      id: decision.id, proposalAttemptId: decision.proposalAttemptId, strategyId: decision.strategyId, strategyVersion: decision.strategyVersion,
      decidedAt: decision.decidedAt, exchange: 'NSE', tradingsymbol: 'RELIANCE', side: 'buy', product: 'MIS', quantity: 10,
      price: null, triggerPrice: null, orderType: 'MARKET', lastPrice: 100, bid: 100, ask: 100,
      notional: 1000, sizingBasis: 'last_price', maxLossRupees: 100, stopDistance: 5, stopPrice: 95, trailingStopDistance: 5, riskBudgetRupees: 100,
      executionClass: 'EQ', segment: 'NSE', instrumentType: 'EQ', expiry: null, strike: null, lotSize: 1, tickSize: 0.05, freezeQuantity: null,
    }, { exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 123, lastPrice: 100, change: null, changePercent: null, volume: null, oi: null, high: null, low: null, open: null, close: null, bid: 100, ask: 100, priceTimestamp: null, receivedAt: Date.now() }, brokerRepo.getInstrument('NSE', 'RELIANCE'));

    brokerRepo.upsertQuote({ exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 123, lastPrice: 110, change: null, changePercent: null, volume: null, oi: null, high: null, low: null, open: null, close: null, bid: 110, ask: 110, priceTimestamp: null, receivedAt: Date.now() });
    await manager.doWork(new Date(), minimalHealth());

    let pos = positionRepo.getPosition('NSE', 'RELIANCE', 'MIS');
    expect(pos?.trailingAnchorPrice).toBe(110);
    expect(pos?.stopPrice).toBe(105);

    brokerRepo.upsertQuote({ exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 123, lastPrice: 104, change: null, changePercent: null, volume: null, oi: null, high: null, low: null, open: null, close: null, bid: 104, ask: 104, priceTimestamp: null, receivedAt: Date.now() });
    await manager.doWork(new Date(), minimalHealth());

    pos = positionRepo.getPosition('NSE', 'RELIANCE', 'MIS');
    expect(pos?.side).toBe(PositionSide.Flat);
    expect(pos?.quantity).toBe(0);
    expect(attemptRepo.count()).toBe(2);
  });
});
