import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import { StrategyDecisionRepository } from '../src/persistence/strategy-decision-repo.js';
import { HybridScoreRepository } from '../src/persistence/hybrid-score-repo.js';
import { ExecutionAttemptRepository } from '../src/persistence/execution-attempt-repo.js';
import { PaperPositionRepository } from '../src/persistence/paper-position-repo.js';
import { StrategyLifecycleRepository } from '../src/persistence/strategy-lifecycle-repo.js';
import { WalkForwardRepository } from '../src/persistence/walk-forward-repo.js';
import { OperatorDetailReadModel } from '../src/operator/operator-detail-read-model.js';
import {
  ExecutionAttemptStatus,
  ExecutionMode,
  ExecutionOutcomeCode,
  ExecutionRefusalCode,
  LLMStatus,
  MergePolicy,
  PositionEventType,
  PositionSide,
  ProposalStatus,
  StrategyDecisionReasonCode,
  StrategyDecisionStatus,
  StrategyLifecyclePhase,
} from '../src/types/runtime.js';
import {
  WalkForwardSelectionResult,
  WalkForwardSelectionStrategy,
  WalkForwardStatus,
  WalkForwardWindowStatus,
  WalkForwardWindowType,
} from '../src/replay/walk-forward-types.js';

interface TestContext {
  db: Database.Database;
  proposals: ProposalRepository;
  decisions: StrategyDecisionRepository;
  hybrid: HybridScoreRepository;
  attempts: ExecutionAttemptRepository;
  positions: PaperPositionRepository;
  lifecycle: StrategyLifecycleRepository;
  walkForward: WalkForwardRepository;
  readModel: OperatorDetailReadModel;
}

const NOW = 1_715_000_000_000;

function createContext(): TestContext {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;
  return {
    db,
    proposals: new ProposalRepository(db),
    decisions: new StrategyDecisionRepository(db),
    hybrid: new HybridScoreRepository(db),
    attempts: new ExecutionAttemptRepository(db),
    positions: new PaperPositionRepository(db),
    lifecycle: new StrategyLifecycleRepository(db),
    walkForward: new WalkForwardRepository(db),
    readModel: new OperatorDetailReadModel(db),
  };
}

function insertProposal(ctx: TestContext, overrides: Partial<Parameters<ProposalRepository['insertAttempt']>[0]> = {}): number {
  return ctx.proposals.insertAttempt({
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 12345,
    side: 'buy',
    product: 'MIS',
    quantity: 10,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: null,
    proposalStatus: ProposalStatus.Accepted,
    createdAt: NOW,
    ...overrides,
  }).id;
}

describe('OperatorDetailReadModel', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createContext();
  });

  it('composes decision detail from persisted decision, reasons, hybrid, execution, and P&L evidence', () => {
    const proposalAttemptId = insertProposal(ctx);
    const decision = ctx.decisions.insertDecisionWithReasons({
      proposalAttemptId,
      decisionStatus: StrategyDecisionStatus.Approved,
      strategyId: 'swing-alpha',
      strategyVersion: '1.2.3',
      decidedAt: NOW + 1000,
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      side: 'buy',
      product: 'MIS',
      quantity: 25,
      price: 2850,
      triggerPrice: null,
      orderType: 'LIMIT',
      quoteLastPrice: 2851.4,
      quoteBid: 2851.2,
      quoteAsk: 2851.6,
      quoteVolume: 120000,
      quoteReceivedAt: NOW + 900,
      riskNotional: 71250,
      riskSizingBasis: 'last_price',
      riskMaxLossRupees: 1800,
      riskStopDistance: 12,
      riskStopPrice: 2839.4,
      riskTrailingStopDistance: 8,
      riskBudgetRupees: 2000,
      riskExposureTag: 'intraday',
      indiaResearchEvidence: {
        summary: 'Bank-heavy breadth improved and oil stabilized.',
        tags: ['breadth', 'macro'],
        freshnessMs: 60_000,
        influenceContext: 'Lifted conviction for the long setup.',
      },
      executionClass: 'EQ',
      segment: 'NSE',
      instrumentType: 'EQ',
      expiry: null,
      strike: null,
      lotSize: 1,
      tickSize: 0.05,
      freezeQuantity: null,
    }, [
      {
        reasonCode: StrategyDecisionReasonCode.PolicyConstraint,
        reasonMessage: 'Trend filter and liquidity checks passed.',
      },
      {
        reasonCode: StrategyDecisionReasonCode.NotInUniverse,
        reasonMessage: 'Universe override approved by operator policy.',
      },
    ]);

    ctx.hybrid.insertFull({
      proposalAttemptId,
      deterministicScore: 0.71,
      llmScore: 0.82,
      llmStatus: LLMStatus.Consulted,
      llmRationale: 'Momentum persisted across sectors.',
      mergedScore: 0.765,
      mergePolicy: MergePolicy.Weighted,
      createdAt: NOW + 1100,
    }, [
      { summaryId: 0, componentName: 'momentum', score: 0.8, weight: 0.5, sortOrder: 1 },
      { summaryId: 0, componentName: 'liquidity', score: 0.62, weight: 0.5, sortOrder: 2 },
    ]);

    const attempt = ctx.attempts.insertAttempt({
      strategyDecisionId: decision.id,
      executionMode: ExecutionMode.Paper,
      status: ExecutionAttemptStatus.Completed,
      outcomeCode: ExecutionOutcomeCode.PaperSimulated,
      brokerOrderId: 'paper-1',
      message: 'Paper execution filled successfully.',
      attemptedAt: NOW + 1200,
      completedAt: NOW + 1500,
    });

    ctx.db.prepare(`
      INSERT INTO paper_orders
        (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price,
         trigger_price, order_type, tag, status, broker_order_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, attempt.id, 'NSE', 'RELIANCE', 'buy', 'MIS', 25, 2850, null, 'LIMIT', null, 'filled', 'paper-1', NOW + 1300, NOW + 1500);

    ctx.db.prepare(`
      INSERT INTO paper_fills
        (paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product,
         filled_quantity, filled_price, broker_order_id, filled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, attempt.id, 'NSE', 'RELIANCE', 'buy', 'MIS', 25, 2852, 'paper-1', NOW + 1400);

    ctx.positions.insertEvent({
      paperOrderId: 1,
      paperFillId: 1,
      executionAttemptId: attempt.id,
      eventType: PositionEventType.Fill,
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      product: 'MIS',
      quantityDelta: 25,
      price: 2852,
      previousQuantity: 0,
      previousAvgCost: 0,
      newQuantity: 25,
      newAvgCost: 2852,
      realizedPnl: 0,
      stopPrice: 2839.4,
      trailingAnchorPrice: 2852,
      trailingStopDistance: 8,
      createdAt: NOW + 1400,
    });
    ctx.positions.insertEvent({
      paperOrderId: 1,
      paperFillId: null,
      executionAttemptId: attempt.id,
      eventType: PositionEventType.Fill,
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      product: 'MIS',
      quantityDelta: -25,
      price: 2862,
      previousQuantity: 25,
      previousAvgCost: 2852,
      newQuantity: 0,
      newAvgCost: 0,
      realizedPnl: 250,
      stopPrice: null,
      trailingAnchorPrice: null,
      trailingStopDistance: null,
      createdAt: NOW + 2400,
    });
    ctx.positions.upsertPosition({
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      product: 'MIS',
      side: PositionSide.Flat,
      quantity: 0,
      avgCostPrice: 0,
      realizedPnl: 250,
      stopPrice: null,
      trailingAnchorPrice: null,
      trailingStopDistance: null,
      markPrice: 2862,
      markedAt: NOW + 2400,
      updatedAt: NOW + 2400,
    });

    const detail = ctx.readModel.getDecisionDetail(decision.id);
    expect(detail).not.toBeNull();
    expect(detail!.decisionId).toBe(decision.id);
    expect(detail!.reasons.map(reason => reason.reasonMessage)).toEqual([
      'Trend filter and liquidity checks passed.',
      'Universe override approved by operator policy.',
    ]);
    expect(detail!.indiaResearchEvidence?.summary).toContain('breadth improved');
    expect(detail!.hybrid?.mergedScore).toBe(0.765);
    expect(detail!.hybrid?.components.map(component => component.componentName)).toEqual(['momentum', 'liquidity']);
    expect(detail!.executionAttempt?.status).toBe(ExecutionAttemptStatus.Completed);
    expect(detail!.executionAttempt?.outcomeCode).toBe(ExecutionOutcomeCode.PaperSimulated);
    expect(detail!.realizedPnl?.realizedPnl).toBe(250);
    expect(detail!.realizedPnl?.eventCount).toBe(2);
    expect(detail!.realizedPnl?.currentPosition?.realizedPnl).toBe(250);
    expect(detail!.diagnostics).toEqual([]);
  });

  it('returns null for missing detail records and treats malformed optional JSON as diagnostic-only', () => {
    const proposalAttemptId = insertProposal(ctx, { tradingsymbol: 'TCS' });
    ctx.db.prepare(`
      INSERT INTO strategy_decisions
        (proposal_attempt_id, decision_status, strategy_id, strategy_version, decided_at,
         exchange, tradingsymbol, side, product, quantity, price, trigger_price,
         order_type, risk_sizing_basis, execution_class, segment, instrument_type,
         india_research_evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposalAttemptId,
      StrategyDecisionStatus.Refused,
      'mean-revert',
      '0.9.0',
      NOW + 500,
      'NSE',
      'TCS',
      'sell',
      'MIS',
      5,
      null,
      null,
      'MARKET',
      'last_price',
      'EQ',
      'NSE',
      'EQ',
      '{bad json',
    );
    ctx.db.prepare(`
      INSERT INTO strategy_decision_reasons (strategy_decision_id, reason_code, reason_message)
      VALUES (?, ?, ?)
    `).run(1, StrategyDecisionReasonCode.MissingQuoteData, 'Quote freshness SLA missed.');

    const malformedDecision = ctx.readModel.getDecisionDetail(1);
    expect(malformedDecision).not.toBeNull();
    expect(malformedDecision!.indiaResearchEvidence).toBeNull();
    expect(malformedDecision!.hybrid).toBeNull();
    expect(malformedDecision!.diagnostics[0]).toContain('Malformed JSON ignored');

    expect(ctx.readModel.getDecisionDetail(99999)).toBeNull();
    expect(ctx.readModel.getStrategyDetail('unknown', '0.0.1')).toBeNull();
    expect(ctx.readModel.getBacktestDetail(99999)).toBeNull();
  });

  it('composes strategy detail by strategyId + strategyVersion while preserving multiple market histories', () => {
    const proposalA = insertProposal(ctx, { tradingsymbol: 'RELIANCE', createdAt: NOW + 1 });
    const proposalB = insertProposal(ctx, { tradingsymbol: 'NIFTY24JUNFUT', exchange: 'NFO', createdAt: NOW + 2 });
    const otherProposal = insertProposal(ctx, { tradingsymbol: 'INFY', createdAt: NOW + 3 });

    const decisionA = ctx.decisions.insertDecision({
      proposalAttemptId: proposalA,
      decisionStatus: StrategyDecisionStatus.Approved,
      strategyId: 'momentum-core',
      strategyVersion: '2.1.0',
      decidedAt: NOW + 10,
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      side: 'buy',
      product: 'MIS',
      quantity: 10,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      quoteLastPrice: 2800,
      quoteBid: 2799.5,
      quoteAsk: 2800.5,
      quoteVolume: 5000,
      quoteReceivedAt: NOW + 9,
      riskNotional: 28000,
      riskSizingBasis: 'last_price',
      riskMaxLossRupees: 700,
      riskStopDistance: 10,
      riskStopPrice: 2790,
      riskTrailingStopDistance: 6,
      riskBudgetRupees: 1000,
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
    const decisionB = ctx.decisions.insertDecision({
      proposalAttemptId: proposalB,
      decisionStatus: StrategyDecisionStatus.Approved,
      strategyId: 'momentum-core',
      strategyVersion: '2.1.0',
      decidedAt: NOW + 20,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY24JUNFUT',
      side: 'buy',
      product: 'NRML',
      quantity: 50,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      quoteLastPrice: 22500,
      quoteBid: 22499,
      quoteAsk: 22501,
      quoteVolume: 1000,
      quoteReceivedAt: NOW + 19,
      riskNotional: 1_125_000,
      riskSizingBasis: 'last_price',
      riskMaxLossRupees: 12_000,
      riskStopDistance: 120,
      riskStopPrice: 22380,
      riskTrailingStopDistance: 80,
      riskBudgetRupees: 15_000,
      riskExposureTag: 'swing',
      indiaResearchEvidence: null,
      executionClass: 'FO',
      segment: 'NFO',
      instrumentType: 'FUT',
      expiry: '2024-06-27',
      strike: null,
      lotSize: 50,
      tickSize: 0.05,
      freezeQuantity: 900,
    });
    ctx.decisions.insertDecision({
      proposalAttemptId: otherProposal,
      decisionStatus: StrategyDecisionStatus.Approved,
      strategyId: 'other-strategy',
      strategyVersion: '1.0.0',
      decidedAt: NOW + 30,
      exchange: 'NSE',
      tradingsymbol: 'INFY',
      side: 'buy',
      product: 'MIS',
      quantity: 5,
      price: null,
      triggerPrice: null,
      orderType: 'MARKET',
      quoteLastPrice: 1500,
      quoteBid: 1499,
      quoteAsk: 1501,
      quoteVolume: 1000,
      quoteReceivedAt: NOW + 29,
      riskNotional: 7500,
      riskSizingBasis: 'last_price',
      riskMaxLossRupees: 300,
      riskStopDistance: 8,
      riskStopPrice: 1492,
      riskTrailingStopDistance: 4,
      riskBudgetRupees: 500,
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

    const attemptA = ctx.attempts.insertAttempt({
      strategyDecisionId: decisionA.id,
      executionMode: ExecutionMode.Paper,
      status: ExecutionAttemptStatus.Completed,
      outcomeCode: ExecutionOutcomeCode.FullFill,
      brokerOrderId: 'exec-a',
      message: 'Filled.',
      attemptedAt: NOW + 40,
      completedAt: NOW + 45,
    });
    const attemptB = ctx.attempts.insertAttempt({
      strategyDecisionId: decisionB.id,
      executionMode: ExecutionMode.Blocked,
      status: ExecutionAttemptStatus.Refused,
      outcomeCode: null,
      brokerOrderId: null,
      message: 'Blocked by mode.',
      attemptedAt: NOW + 50,
      completedAt: null,
    });
    ctx.attempts.insertRefusalReason(attemptB.id, {
      reasonCode: ExecutionRefusalCode.ModeBlocked,
      reasonMessage: 'Execution mode is blocked.',
    });

    ctx.db.prepare(`
      INSERT INTO paper_orders
        (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price,
         trigger_price, order_type, tag, status, broker_order_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, attemptA.id, 'NSE', 'RELIANCE', 'buy', 'MIS', 10, null, null, 'MARKET', null, 'filled', 'exec-a', NOW + 41, NOW + 45);

    ctx.db.prepare(`
      INSERT INTO paper_fills
        (paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product,
         filled_quantity, filled_price, broker_order_id, filled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, attemptA.id, 'NSE', 'RELIANCE', 'buy', 'MIS', 10, 2801, 'exec-a', NOW + 42);
    ctx.positions.insertEvent({
      paperOrderId: 1,
      paperFillId: 1,
      executionAttemptId: attemptA.id,
      eventType: PositionEventType.Fill,
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      product: 'MIS',
      quantityDelta: 10,
      price: 2801,
      previousQuantity: 0,
      previousAvgCost: 0,
      newQuantity: 10,
      newAvgCost: 2801,
      realizedPnl: 0,
      stopPrice: 2790,
      trailingAnchorPrice: 2801,
      trailingStopDistance: 6,
      createdAt: NOW + 42,
    });
    ctx.positions.upsertPosition({
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      product: 'MIS',
      side: PositionSide.Long,
      quantity: 10,
      avgCostPrice: 2801,
      realizedPnl: 120,
      stopPrice: 2790,
      trailingAnchorPrice: 2815,
      trailingStopDistance: 6,
      markPrice: 2820,
      markedAt: NOW + 60,
      updatedAt: NOW + 60,
    });

    ctx.lifecycle.upsertCurrentState({
      strategyId: 'momentum-core',
      strategyVersion: '2.1.0',
      marketId: 'INDIA_NSE_EQ',
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: NOW + 70,
    });
    ctx.lifecycle.upsertCurrentState({
      strategyId: 'momentum-core',
      strategyVersion: '2.1.0',
      marketId: 'INDIA_NSE_FO',
      phase: StrategyLifecyclePhase.Backtest,
      updatedAt: NOW + 80,
    });

    ctx.db.prepare(`
      INSERT INTO governance_decisions
        (strategy_id, strategy_version, market_id, verdict, previous_phase, new_phase,
         rationale, evidence_json, winner_id, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('momentum-core', '2.1.0', 'INDIA_NSE_EQ', 'promote', 'backtest', 'paper', 'Winner cleared EQ thresholds.', '{"source":"eq"}', null, NOW + 90);
    ctx.db.prepare(`
      INSERT INTO governance_decisions
        (strategy_id, strategy_version, market_id, verdict, previous_phase, new_phase,
         rationale, evidence_json, winner_id, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('momentum-core', '2.1.0', 'INDIA_NSE_FO', 'hold', 'backtest', 'backtest', 'FO still under review.', '{bad json', null, NOW + 95);

    const runEq = ctx.walkForward.insertRun({
      label: 'EQ sweep',
      strategyId: 'momentum-core',
      strategyVersion: '2.1.0',
      marketId: 'INDIA_NSE_EQ',
      replaySessionId: null,
      windowCount: 2,
      totalTrials: 2,
      status: WalkForwardStatus.Completed,
      createdAt: NOW + 100,
      startedAt: NOW + 101,
      completedAt: NOW + 120,
    });
    const eqWindow = ctx.walkForward.insertWindow({
      runId: runEq.id,
      windowIndex: 0,
      rangeStart: NOW - 10_000,
      rangeEnd: NOW - 5_000,
      windowLabel: 'EQ W1',
      trialCountOptimized: 1,
      trialCountTested: 1,
      status: WalkForwardWindowStatus.Completed,
      createdAt: NOW + 100,
    });
    const eqTrial = ctx.walkForward.insertTrial({
      runId: runEq.id,
      trialIndex: 0,
      label: 'EQ config A',
      paramsJson: '{"lookback":20}',
      mergedScore: 0.88,
      deterministicScore: 0.84,
      llmScore: 0.92,
      llmStatus: 'consulted',
      rank: 1,
      createdAt: NOW + 101,
    });
    ctx.walkForward.linkTrialToWindow({
      trialId: eqTrial.id,
      windowId: eqWindow.id,
      windowType: WalkForwardWindowType.OutOfSample,
      totalReturn: 14,
      sharpeRatio: 1.8,
      maxDrawdown: 8,
      winRate: 0.6,
      tradeCount: 12,
      profitFactor: 1.7,
      metricsJson: null,
      createdAt: NOW + 102,
    });
    ctx.walkForward.insertWinner({
      runId: runEq.id,
      result: WalkForwardSelectionResult.Selected,
      selectedTrialId: eqTrial.id,
      selectionStrategy: WalkForwardSelectionStrategy.TopRanked,
      selectionConfigJson: '{"strategy":"top_ranked"}',
      rationale: 'EQ winner selected.',
      artifactPathsJson: null,
      selectedAt: NOW + 121,
    });

    const runFo = ctx.walkForward.insertRun({
      label: 'FO sweep',
      strategyId: 'momentum-core',
      strategyVersion: '2.1.0',
      marketId: 'INDIA_NSE_FO',
      replaySessionId: null,
      windowCount: 1,
      totalTrials: 0,
      status: WalkForwardStatus.Completed,
      createdAt: NOW + 130,
      startedAt: NOW + 131,
      completedAt: NOW + 140,
    });
    ctx.walkForward.insertWinner({
      runId: runFo.id,
      result: WalkForwardSelectionResult.NoWinner,
      selectedTrialId: null,
      selectionStrategy: WalkForwardSelectionStrategy.Threshold,
      selectionConfigJson: '{"strategy":"threshold","minMergedScore":0.8}',
      rationale: 'No FO trial passed threshold.',
      artifactPathsJson: null,
      selectedAt: NOW + 141,
    });

    const detail = ctx.readModel.getStrategyDetail('momentum-core', '2.1.0');
    expect(detail).not.toBeNull();
    expect(detail!.currentStates.map(state => state.marketId)).toEqual(['INDIA_NSE_EQ', 'INDIA_NSE_FO']);
    expect(detail!.governanceHistory.map(item => item.marketId)).toEqual(['INDIA_NSE_FO', 'INDIA_NSE_EQ']);
    expect(detail!.promotionHistory).toHaveLength(1);
    expect(detail!.walkForwardRuns).toHaveLength(2);
    expect(detail!.walkForwardRuns.some(run => run.marketId === 'INDIA_NSE_EQ' && run.result === WalkForwardSelectionResult.Selected)).toBe(true);
    expect(detail!.walkForwardRuns.some(run => run.marketId === 'INDIA_NSE_FO' && run.result === WalkForwardSelectionResult.NoWinner)).toBe(true);
    expect(detail!.recentDecisions.map(row => row.decisionId)).toEqual([decisionB.id, decisionA.id]);
    expect(detail!.diagnostics.some(item => item.includes('Malformed JSON ignored'))).toBe(true);
  });

  it('returns backtest detail for selected and no-winner runs without crashing on malformed optional JSON', () => {
    const run = ctx.walkForward.insertRun({
      label: 'Walk-forward selected',
      strategyId: 'swing-alpha',
      strategyVersion: '1.2.3',
      marketId: 'INDIA_NSE_EQ',
      replaySessionId: null,
      windowCount: 2,
      totalTrials: 2,
      status: WalkForwardStatus.Completed,
      createdAt: NOW,
      startedAt: NOW + 1,
      completedAt: NOW + 200,
    });
    const w0 = ctx.walkForward.insertWindow({
      runId: run.id,
      windowIndex: 0,
      rangeStart: NOW - 20_000,
      rangeEnd: NOW - 10_000,
      windowLabel: 'W0',
      trialCountOptimized: 1,
      trialCountTested: 1,
      status: WalkForwardWindowStatus.Completed,
      createdAt: NOW + 2,
    });
    const w1 = ctx.walkForward.insertWindow({
      runId: run.id,
      windowIndex: 1,
      rangeStart: NOW - 10_000,
      rangeEnd: NOW,
      windowLabel: 'W1',
      trialCountOptimized: 1,
      trialCountTested: 1,
      status: WalkForwardWindowStatus.Completed,
      createdAt: NOW + 3,
    });
    const trialA = ctx.walkForward.insertTrial({
      runId: run.id,
      trialIndex: 0,
      label: 'Config A',
      paramsJson: '{"lookback":14}',
      mergedScore: 0.91,
      deterministicScore: 0.88,
      llmScore: 0.94,
      llmStatus: 'consulted',
      rank: 1,
      createdAt: NOW + 4,
    });
    const trialB = ctx.walkForward.insertTrial({
      runId: run.id,
      trialIndex: 1,
      label: 'Config B',
      paramsJson: '{bad json',
      mergedScore: 0.74,
      deterministicScore: 0.78,
      llmScore: null,
      llmStatus: 'skipped',
      rank: 2,
      createdAt: NOW + 5,
    });
    ctx.walkForward.linkTrialToWindow({
      trialId: trialA.id,
      windowId: w0.id,
      windowType: WalkForwardWindowType.InSample,
      totalReturn: 11,
      sharpeRatio: 1.5,
      maxDrawdown: 7,
      winRate: 0.58,
      tradeCount: 10,
      profitFactor: 1.6,
      metricsJson: '{"calmar":1.2}',
      createdAt: NOW + 6,
    });
    ctx.walkForward.linkTrialToWindow({
      trialId: trialA.id,
      windowId: w1.id,
      windowType: WalkForwardWindowType.OutOfSample,
      totalReturn: 9,
      sharpeRatio: 1.3,
      maxDrawdown: 9,
      winRate: 0.55,
      tradeCount: 8,
      profitFactor: 1.4,
      metricsJson: '{bad json',
      createdAt: NOW + 7,
    });
    ctx.walkForward.insertWinner({
      runId: run.id,
      result: WalkForwardSelectionResult.Selected,
      selectedTrialId: trialA.id,
      selectionStrategy: WalkForwardSelectionStrategy.Composite,
      selectionConfigJson: '{"strategy":"composite","minMergedScore":0.8}',
      rationale: 'Config A dominated on merged score and Sharpe.',
      artifactPathsJson: '["artifacts/winner.json"]',
      selectedAt: NOW + 201,
    });

    const noWinnerRun = ctx.walkForward.insertRun({
      label: 'Walk-forward hold',
      strategyId: 'swing-alpha',
      strategyVersion: '1.2.3',
      marketId: 'INDIA_NSE_EQ',
      replaySessionId: null,
      windowCount: 1,
      totalTrials: 0,
      status: WalkForwardStatus.Completed,
      createdAt: NOW + 300,
      startedAt: NOW + 301,
      completedAt: NOW + 320,
    });
    ctx.walkForward.insertWinner({
      runId: noWinnerRun.id,
      result: WalkForwardSelectionResult.NoWinner,
      selectedTrialId: null,
      selectionStrategy: WalkForwardSelectionStrategy.Threshold,
      selectionConfigJson: '{bad json',
      rationale: 'No trial cleared the minimum threshold.',
      artifactPathsJson: null,
      selectedAt: NOW + 321,
    });

    const selectedDetail = ctx.readModel.getBacktestDetail(run.id);
    expect(selectedDetail).not.toBeNull();
    expect(selectedDetail!.selectedTrial?.label).toBe('Config A');
    expect(selectedDetail!.rankedCandidates).toHaveLength(2);
    expect(selectedDetail!.rankedCandidates[1].params).toBeNull();
    expect(selectedDetail!.selectedTrial?.windowEvidence).toHaveLength(2);
    expect(selectedDetail!.selectedTrial?.windowEvidence[1].metrics).toBeNull();
    expect(selectedDetail!.diagnostics.some(item => item.includes('Malformed JSON ignored'))).toBe(true);

    const holdDetail = ctx.readModel.getBacktestDetail(noWinnerRun.id);
    expect(holdDetail).not.toBeNull();
    expect(holdDetail!.result).toBe(WalkForwardSelectionResult.NoWinner);
    expect(holdDetail!.selectedTrial).toBeNull();
    expect(holdDetail!.selectionConfig).toBeNull();
    expect(holdDetail!.diagnostics.some(item => item.includes('Malformed JSON ignored'))).toBe(true);
  });
});
