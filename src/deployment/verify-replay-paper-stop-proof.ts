#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../persistence/sqlite.js';
import { BrokerRepository } from '../persistence/broker-repo.js';
import { ProposalRepository } from '../persistence/proposal-repo.js';
import { StrategyDecisionRepository } from '../persistence/strategy-decision-repo.js';
import { ExecutionAttemptRepository } from '../persistence/execution-attempt-repo.js';
import { PaperOrderRepository } from '../persistence/paper-order-repo.js';
import { PaperFillRepository } from '../persistence/paper-fill-repo.js';
import { PaperPositionRepository } from '../persistence/paper-position-repo.js';
import { PaperExecutionPolicy } from '../execution/paper-execution-policy.js';
import { PaperExecutionLedger } from '../execution/paper-execution-ledger.js';
import { PaperPositionManager } from '../execution/paper-position-manager.js';
import { ModeAwareExecutionService } from '../execution/mode-aware-execution-service.js';
import { BlockedExecutionAdapter, LiveExecutionAdapter } from '../execution/execution-adapters.js';
import { ExecutionMode, ProposalStatus, StrategyDecisionStatus } from '../types/runtime.js';

const ARTIFACT_ROOT = 'data/artifacts/replay-paper-proof';

const assertions: Array<{ name: string; pass: boolean; detail: string }> = [];
function assert(name: string, condition: boolean, detail: string) {
  assertions.push({ name, pass: condition, detail });
  console.log(`${condition ? '✅' : '❌'} ${name}${condition ? '' : ` — ${detail}`}`);
}

function minimalHealth() {
  return { verdict: 'healthy', checkedAt: Date.now(), uptimeMs: 0, checks: [] } as any;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-replay-paper-proof-'));
  const dbPath = path.join(tmpDir, 'replay-paper-proof.db');
  const dbm = new DatabaseManager(dbPath);
  const db = dbm.db;

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
  const paperPositionManager = new PaperPositionManager({
    brokerRepo,
    positionRepo,
    proposalRepo,
    strategyRepo,
    executionService,
  });

  brokerRepo.upsertInstruments([{
    exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 123456, name: 'Reliance', expiry: null,
    strike: null, lotSize: 1, tickSize: 0.05, instrumentType: 'EQ', segment: 'NSE', exchangeToken: 1, freezeQuantity: null,
  }]);

  const quote = (lastPrice: number) => ({
    exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 123456,
    lastPrice, change: null, changePercent: null, volume: 1000000, oi: null,
    high: null, low: null, open: null, close: null, bid: lastPrice, ask: lastPrice,
    priceTimestamp: null, receivedAt: Date.now(),
  });

  brokerRepo.upsertQuote(quote(100));

  const proposal = proposalRepo.insertAttempt({
    exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 123456,
    side: 'buy', product: 'MIS', quantity: 10, price: null, triggerPrice: null,
    orderType: 'MARKET', tag: 'replay-paper-proof', proposalStatus: ProposalStatus.Accepted, createdAt: Date.now(),
  });

  const decision = strategyRepo.insertDecision({
    proposalAttemptId: proposal.id,
    decisionStatus: StrategyDecisionStatus.Approved,
    strategyId: 'replay-paper-proof',
    strategyVersion: '1.0.0',
    decidedAt: Date.now(),
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    side: 'buy',
    product: 'MIS',
    quantity: 10,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    quoteLastPrice: 100,
    quoteBid: 100,
    quoteAsk: 100,
    quoteVolume: 1000000,
    quoteReceivedAt: Date.now(),
    riskNotional: 1000,
    riskSizingBasis: 'last_price',
    riskMaxLossRupees: 100,
    riskStopDistance: 5,
    riskStopPrice: 95,
    riskTrailingStopDistance: 5,
    riskBudgetRupees: 100,
    riskExposureTag: 'intraday',
    indiaResearchEvidence: null,
    executionClass: 'EQ',
    segment: 'NSE',
    instrumentType: 'EQ',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    freezeQuantity: null,
  });

  await executionService.execute({
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
    lastPrice: 100,
    bid: 100,
    ask: 100,
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
  }, quote(100), brokerRepo.getInstrument('NSE', 'RELIANCE'));

  let pos = positionRepo.getPosition('NSE', 'RELIANCE', 'MIS');
  assert('entry created open position', pos?.quantity === 10, `quantity=${pos?.quantity}`);
  assert('initial stop seeded', pos?.stopPrice === 95, `stop=${pos?.stopPrice}`);

  brokerRepo.upsertQuote(quote(110));
  await paperPositionManager.doWork(new Date(), minimalHealth());
  pos = positionRepo.getPosition('NSE', 'RELIANCE', 'MIS');
  assert('trailing anchor moved up', pos?.trailingAnchorPrice === 110, `anchor=${pos?.trailingAnchorPrice}`);
  assert('stop ratcheted upward', pos?.stopPrice === 105, `stop=${pos?.stopPrice}`);

  brokerRepo.upsertQuote(quote(104));
  await paperPositionManager.doWork(new Date(), minimalHealth());
  pos = positionRepo.getPosition('NSE', 'RELIANCE', 'MIS');
  assert('stop exit flattened position', pos?.quantity === 0, `quantity=${pos?.quantity}`);
  assert('two execution attempts persisted', attemptRepo.count() === 2, `count=${attemptRepo.count()}`);
  assert('two paper fills persisted', fillRepo.count() === 2, `count=${fillRepo.count()}`);

  const passed = assertions.filter(a => a.pass).length;
  const failed = assertions.length - passed;
  const summary = {
    harness: 'replay-paper-stop-proof',
    completedAt: new Date().toISOString(),
    verdict: failed === 0 ? 'PASS' : 'FAIL',
    passed,
    failed,
    assertions,
    evidence: {
      attempts: attemptRepo.count(),
      fills: fillRepo.count(),
      openPositions: positionRepo.countOpenPositions(),
    },
  };

  fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });
  const artifactPath = path.join(ARTIFACT_ROOT, `replay-paper-proof-${Date.now()}.json`);
  fs.writeFileSync(artifactPath, JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`Artifact written: ${artifactPath}`);

  dbm.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
