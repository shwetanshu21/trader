import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import http from 'node:http';

import type Database from 'better-sqlite3';
import { DatabaseManager } from '../persistence/sqlite.js';
import { HypothesisRepository } from '../persistence/hypothesis-repo.js';
import { HypothesisMemoryRepository } from '../persistence/hypothesis-memory-repo.js';
import { HypothesisGenerationRepository } from '../persistence/hypothesis-generation-repo.js';
import { StrategyLifecycleRepository } from '../persistence/strategy-lifecycle-repo.js';
import { WalkForwardRepository } from '../persistence/walk-forward-repo.js';
import { OperatorReadModel } from '../operator/operator-read-model.js';
import { OperatorDetailReadModel } from '../operator/operator-detail-read-model.js';
import { DashboardPayloadAssembler, type DashboardPayload } from '../operator-ui/dashboard-data.js';
import { createOperatorUIServer } from '../operator-ui/server.js';
import { Authenticator } from '../operator-ui/auth.js';
import type { OperatorUIConfig } from '../operator-ui/config.js';
import {
  GovernanceVerdict,
  HypothesisEvaluationStatus,
  HypothesisMemoryStatus,
  HypothesisStatus,
  HypothesisValidationReasonCode,
  ResearchPublicationStatus,
  StrategyLifecyclePhase,
  GenerationVerdict,
  type AssertionResult,
  type OperatorResearchLineageDetail,
  type OperatorResearchLineageEntry,
  type OperatorResearchLineageSummary,
} from '../types/runtime.js';
import {
  WalkForwardSelectionResult,
  WalkForwardSelectionStrategy,
  WalkForwardStatus,
  WalkForwardWindowType,
} from '../replay/walk-forward-types.js';

export const ARTIFACT_ROOT = 'data/artifacts/operator-lineage-proof';
const NOW = Date.now();
const DUPLICATE_HASH = 'm013-duplicate-lineage-hash';
const PUBLISHED_HASH = 'm013-published-lineage-hash';
const PUBLISHED_STRATEGY_ID = 'research-hypothesis-m013';
const PUBLISHED_STRATEGY_VERSION = '1.0.0';
const MARKET_ID = 'INDIA_NSE_EQ';

export interface OperatorLineageProofContext {
  tmpDir: string;
  dbPath: string;
  dbManager: DatabaseManager;
  db: Database.Database;
  hypothesisRepo: HypothesisRepository;
  memoryRepo: HypothesisMemoryRepository;
  generationRepo: HypothesisGenerationRepository;
  lifecycleRepo: StrategyLifecycleRepository;
  walkForwardRepo: WalkForwardRepository;
  readModel: OperatorReadModel;
  detailReadModel: OperatorDetailReadModel;
  dashboardAssembler: DashboardPayloadAssembler;
}

export interface SeededLineageState {
  duplicateHash: string;
  publishedHash: string;
  publishedStrategyId: string;
  publishedStrategyVersion: string;
  publishedDecisionId: number;
  publishedWalkForwardRunId: number;
  publishedDecisionCount: number;
  recentLineageLimit: number;
}

export interface StartedWitnessServer {
  server: http.Server;
  baseUrl: string;
  username: string;
  password: string;
  close: () => Promise<void>;
}

export interface WitnessFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const assertions: AssertionResult[] = [];

export function resetAssertions(): void {
  assertions.length = 0;
}

export function getAssertions(): AssertionResult[] {
  return [...assertions];
}

export function assert(name: string, condition: boolean, detail: string): void {
  assertions.push({ name, pass: condition, detail });
  if (condition) {
    console.log(`  ✅ PASS: ${name}`);
  } else {
    console.error(`  ❌ FAIL: ${name} — ${detail}`);
  }
}

export function report(): { passed: number; failed: number } {
  const passed = assertions.filter(entry => entry.pass).length;
  const failed = assertions.length - passed;
  console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
  return { passed, failed };
}

export function createOperatorLineageProofContext(): OperatorLineageProofContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-lineage-proof-'));
  const dbPath = path.join(tmpDir, 'operator-lineage-proof.db');
  const dbManager = new DatabaseManager(dbPath);
  const db = dbManager.db;

  return {
    tmpDir,
    dbPath,
    dbManager,
    db,
    hypothesisRepo: new HypothesisRepository(db),
    memoryRepo: new HypothesisMemoryRepository(db),
    generationRepo: new HypothesisGenerationRepository(db),
    lifecycleRepo: new StrategyLifecycleRepository(db),
    walkForwardRepo: new WalkForwardRepository(db),
    readModel: new OperatorReadModel(db),
    detailReadModel: new OperatorDetailReadModel(db),
    dashboardAssembler: new DashboardPayloadAssembler(),
  };
}

export function destroyOperatorLineageProofContext(ctx: OperatorLineageProofContext): void {
  try {
    ctx.db.close();
  } catch {
    // ignore
  }
  try {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export function seedOperatorLineageProof(ctx: OperatorLineageProofContext): SeededLineageState {
  seedDuplicateSkipBranch(ctx);
  const published = seedPublishedBranch(ctx);
  seedRecentPublishedGenerationRows(ctx, published.hypothesisGraphId, published.evaluationId, 2);

  return {
    duplicateHash: DUPLICATE_HASH,
    publishedHash: PUBLISHED_HASH,
    publishedStrategyId: PUBLISHED_STRATEGY_ID,
    publishedStrategyVersion: PUBLISHED_STRATEGY_VERSION,
    publishedDecisionId: published.decisionId,
    publishedWalkForwardRunId: published.runId,
    publishedDecisionCount: 3,
    recentLineageLimit: 3,
  };
}

function seedDuplicateSkipBranch(ctx: OperatorLineageProofContext): void {
  ctx.memoryRepo.recordFailure({
    canonicalHash: DUPLICATE_HASH,
    status: HypothesisMemoryStatus.Failed,
    reasonCode: HypothesisValidationReasonCode.ExactFailureMatch,
    reasonMessage: 'Seeded duplicate-skip branch for operator witness.',
    hypothesisGraphId: null,
    createdAt: NOW + 10,
  });

  const skipped = ctx.generationRepo.insertAttemptWithReasons({
    verdict: GenerationVerdict.Skipped,
    contextProvenance: {
      providerUrl: 'http://proof-provider.local/hypothesis',
      providerModel: 'proof-model',
      promptVersion: 'm013-s03',
      triggeredAt: NOW + 20,
      marketId: MARKET_ID,
      strategyId: 'research-proof',
    },
    rawProviderOutput: null,
    rawOutputContentHash: null,
    rawOutputPreview: null,
    canonicalHash: DUPLICATE_HASH,
    hypothesisGraphId: null,
    hypothesisEvaluationId: null,
    createdAt: NOW + 20,
  }, [
    {
      reasonCode: 'duplicate_skipped',
      reasonMessage: 'Exact duplicate of a known failed hypothesis was skipped.',
    },
  ]);

  assert(
    'Seed: duplicate generation attempt recorded as skipped',
    skipped.verdict === GenerationVerdict.Skipped,
    `verdict=${skipped.verdict}`,
  );
}

function seedPublishedBranch(ctx: OperatorLineageProofContext): {
  hypothesisGraphId: number;
  evaluationId: number;
  runId: number;
  decisionId: number;
} {
  const hypothesis = ctx.hypothesisRepo.insertHypothesis({
    canonicalHash: PUBLISHED_HASH,
    canonicalJson: JSON.stringify({ hypothesis: 'published witness branch' }),
    status: HypothesisStatus.Validated,
    graph: {
      schemaVersion: '1',
      signals: [{ type: 'ema_cross', params: { fast: 10, slow: 21 } }],
      filters: [{ type: 'volume_min', params: { min: 500000 } }],
      entryRules: [{ type: 'breakout_confirmed', params: { lookbackBars: 4 } }],
      exitRules: [{ type: 'time_stop', params: { maxBars: 10 } }],
      riskRules: [{ type: 'atr_stop', params: { period: 14, multiple: 2 } }],
      metadata: { branch: 'published-success', slice: 'M013/S03' },
    },
    createdAt: NOW + 100,
    updatedAt: NOW + 100,
  });

  const run = ctx.walkForwardRepo.insertRun({
    label: 'M013 operator lineage witness run',
    strategyId: PUBLISHED_STRATEGY_ID,
    strategyVersion: PUBLISHED_STRATEGY_VERSION,
    marketId: MARKET_ID,
    replaySessionId: null,
    windowCount: 2,
    totalTrials: 1,
    status: WalkForwardStatus.Completed,
    createdAt: NOW + 110,
    startedAt: NOW + 110,
    completedAt: NOW + 112,
  });

  const windowA = ctx.walkForwardRepo.insertWindow({
    runId: run.id,
    windowIndex: 0,
    rangeStart: NOW - 1_000_000,
    rangeEnd: NOW - 800_000,
    windowLabel: 'W0-in',
    trialCountOptimized: 1,
    trialCountTested: 0,
    status: 'completed',
    createdAt: NOW + 111,
  });
  const windowB = ctx.walkForwardRepo.insertWindow({
    runId: run.id,
    windowIndex: 1,
    rangeStart: NOW - 799_999,
    rangeEnd: NOW - 600_000,
    windowLabel: 'W1-out',
    trialCountOptimized: 0,
    trialCountTested: 1,
    status: 'completed',
    createdAt: NOW + 111,
  });

  const trial = ctx.walkForwardRepo.insertTrial({
    runId: run.id,
    trialIndex: 0,
    label: 'published-branch-trial',
    paramsJson: JSON.stringify({ canonicalHash: PUBLISHED_HASH }),
    mergedScore: 0.91,
    deterministicScore: 0.87,
    llmScore: 0.95,
    llmStatus: 'consulted',
    rank: 1,
    createdAt: NOW + 111,
  });

  ctx.walkForwardRepo.linkTrialToWindow({
    trialId: trial.id,
    windowId: windowA.id,
    windowType: WalkForwardWindowType.InSample,
    totalReturn: 11.5,
    sharpeRatio: 1.7,
    maxDrawdown: 9.2,
    winRate: 0.61,
    tradeCount: 18,
    profitFactor: 1.6,
    metricsJson: JSON.stringify({ replaySessionId: 9101 }),
    createdAt: NOW + 111,
  });
  ctx.walkForwardRepo.linkTrialToWindow({
    trialId: trial.id,
    windowId: windowB.id,
    windowType: WalkForwardWindowType.OutOfSample,
    totalReturn: 9.8,
    sharpeRatio: 1.5,
    maxDrawdown: 10.4,
    winRate: 0.58,
    tradeCount: 14,
    profitFactor: 1.4,
    metricsJson: JSON.stringify({ replaySessionId: 9101 }),
    createdAt: NOW + 111,
  });

  const winner = ctx.walkForwardRepo.insertWinner({
    runId: run.id,
    result: WalkForwardSelectionResult.Selected,
    selectedTrialId: trial.id,
    selectionStrategy: WalkForwardSelectionStrategy.TopRanked,
    selectionConfigJson: JSON.stringify({ minMergedScore: 0.8 }),
    rationale: 'Seeded winner cleared the promotion threshold.',
    artifactPathsJson: JSON.stringify(['artifacts/m013/winner.json', 'artifacts/m013/diagnostics.json']),
    selectedAt: NOW + 112,
  });

  const evaluation = ctx.hypothesisRepo.insertEvaluation({
    hypothesisGraphId: hypothesis.id,
    walkForwardRunId: run.id,
    status: HypothesisEvaluationStatus.Completed,
    winnerId: winner.id,
    rationale: 'Seeded evaluation completed successfully.',
    outcomeDetail: 'Operator lineage witness evaluation completed.',
    createdAt: NOW + 113,
    updatedAt: NOW + 113,
  });

  ctx.hypothesisRepo.insertResearchArtifact({
    hypothesisEvaluationId: evaluation.id,
    artifactType: 'promotion_artifact' as any,
    format: 'json',
    filePath: 'artifacts/m013/promotion.json',
    label: 'Promotion artifact',
    createdAt: NOW + 114,
  });
  ctx.hypothesisRepo.insertResearchArtifact({
    hypothesisEvaluationId: evaluation.id,
    artifactType: 'diagnostics_artifact' as any,
    format: 'json',
    filePath: 'artifacts/m013/diagnostics.json',
    label: 'Diagnostics artifact',
    createdAt: NOW + 115,
  });

  ctx.generationRepo.insertAttemptWithReasons({
    verdict: GenerationVerdict.Accepted,
    contextProvenance: {
      providerUrl: 'http://proof-provider.local/hypothesis',
      providerModel: 'proof-model',
      promptVersion: 'm013-s03',
      triggeredAt: NOW + 116,
      marketId: MARKET_ID,
      strategyId: PUBLISHED_STRATEGY_ID,
    },
    rawProviderOutput: JSON.stringify({ proposal: 'published witness hypothesis' }),
    rawOutputContentHash: 'published-output-hash',
    rawOutputPreview: '{"proposal":"published witness hypothesis"}',
    canonicalHash: PUBLISHED_HASH,
    hypothesisGraphId: hypothesis.id,
    hypothesisEvaluationId: evaluation.id,
    createdAt: NOW + 116,
  }, [
    {
      reasonCode: 'accepted_for_evaluation',
      reasonMessage: 'Hypothesis advanced into evaluation and publication witness flow.',
    },
  ]);

  const lifecycleState = ctx.lifecycleRepo.upsertCurrentState({
    strategyId: PUBLISHED_STRATEGY_ID,
    strategyVersion: PUBLISHED_STRATEGY_VERSION,
    marketId: MARKET_ID,
    phase: StrategyLifecyclePhase.Paper,
    updatedAt: NOW + 117,
  });

  const governanceDecision = ctx.lifecycleRepo.insertDecision({
    strategyId: PUBLISHED_STRATEGY_ID,
    strategyVersion: PUBLISHED_STRATEGY_VERSION,
    marketId: MARKET_ID,
    verdict: GovernanceVerdict.Promote,
    previousPhase: StrategyLifecyclePhase.Backtest,
    newPhase: StrategyLifecyclePhase.Paper,
    rationale: 'Seeded witness strategy cleared promotion review.',
    evidenceJson: JSON.stringify({ source: 'operator-lineage-proof', approval: 'ops-bot' }),
    winnerId: winner.id,
    recordedAt: NOW + 118,
  });

  ctx.hypothesisRepo.insertPublication({
    hypothesisEvaluationId: evaluation.id,
    hypothesisGraphId: hypothesis.id,
    status: ResearchPublicationStatus.Published,
    strategyId: PUBLISHED_STRATEGY_ID,
    strategyVersion: PUBLISHED_STRATEGY_VERSION,
    marketId: MARKET_ID,
    rationale: 'Published from seeded operator lineage proof branch.',
    evidenceJson: JSON.stringify({ publicationSource: 'M013/S03 operator witness', canonicalHash: PUBLISHED_HASH }),
    lifecycleStateId: lifecycleState.id,
    governanceDecisionId: governanceDecision.id,
    publishedAt: NOW + 119,
    createdAt: NOW + 119,
  });

  const decisionId = seedOperatorFacingRows(ctx);

  return {
    hypothesisGraphId: hypothesis.id,
    evaluationId: evaluation.id,
    runId: run.id,
    decisionId,
  };
}

function seedRecentPublishedGenerationRows(
  ctx: OperatorLineageProofContext,
  hypothesisGraphId: number,
  evaluationId: number,
  extraCount: number,
): void {
  for (let i = 0; i < extraCount; i += 1) {
    const hash = `m013-extra-lineage-${i + 1}`;
    const hypothesis = ctx.hypothesisRepo.insertHypothesis({
      canonicalHash: hash,
      canonicalJson: JSON.stringify({ extra: i + 1 }),
      status: HypothesisStatus.Validated,
      graph: {
        schemaVersion: '1',
        signals: [{ type: 'ema_cross', params: { fast: 5 + i, slow: 15 + i } }],
        filters: [],
        entryRules: [],
        exitRules: [],
        riskRules: [],
        metadata: { extraWindowSeed: i + 1 },
      },
      createdAt: NOW + 200 + i,
      updatedAt: NOW + 200 + i,
    });

    ctx.generationRepo.insertAttemptWithReasons({
      verdict: GenerationVerdict.Accepted,
      contextProvenance: {
        providerUrl: 'http://proof-provider.local/hypothesis',
        providerModel: 'proof-model',
        promptVersion: 'm013-s03',
        triggeredAt: NOW + 210 + i,
        marketId: MARKET_ID,
        strategyId: `extra-strategy-${i + 1}`,
      },
      rawProviderOutput: null,
      rawOutputContentHash: null,
      rawOutputPreview: null,
      canonicalHash: hash,
      hypothesisGraphId: hypothesis.id,
      hypothesisEvaluationId: i < 2 ? evaluationId : null,
      createdAt: NOW + 210 + i,
    }, [
      {
        reasonCode: 'accepted_for_history_window',
        reasonMessage: 'Extra accepted generation row to prove bounded recent evidence.',
      },
    ]);
  }

  assert(
    'Seed: published branch linked graph/evaluation rows persisted',
    hypothesisGraphId > 0 && evaluationId > 0,
    `hypothesisGraphId=${hypothesisGraphId}, evaluationId=${evaluationId}`,
  );
}

function seedOperatorFacingRows(ctx: OperatorLineageProofContext): number {
  const insertProposal = ctx.db.prepare(`
    INSERT INTO proposal_attempts
      (id, exchange, tradingsymbol, instrument_token, side, product, quantity, price,
       trigger_price, order_type, tag, proposal_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDecision = ctx.db.prepare(`
    INSERT INTO strategy_decisions
      (id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
       decided_at, exchange, tradingsymbol, side, product, quantity, price, trigger_price,
       order_type, quote_last_price, quote_bid, quote_ask, quote_volume, quote_received_at,
       risk_notional, risk_sizing_basis, risk_max_loss_rupees, risk_stop_distance,
       risk_stop_price, risk_trailing_stop_distance, risk_budget_rupees, risk_exposure_tag,
       india_research_evidence, execution_class, segment, instrument_type, expiry, strike,
       lot_size, tick_size, freeze_quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertExecutionAttempt = ctx.db.prepare(`
    INSERT INTO execution_attempts
      (id, strategy_decision_id, execution_mode, status, outcome_code, broker_order_id, message, attempted_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPaperOrder = ctx.db.prepare(`
    INSERT INTO paper_orders
      (id, execution_attempt_id, exchange, tradingsymbol, side, product, quantity, price,
       order_type, status, broker_order_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPaperFill = ctx.db.prepare(`
    INSERT INTO paper_fills
      (id, paper_order_id, execution_attempt_id, exchange, tradingsymbol, side, product,
       filled_quantity, filled_price, broker_order_id, filled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPositionEvent = ctx.db.prepare(`
    INSERT INTO position_events
      (id, paper_order_id, paper_fill_id, execution_attempt_id, event_type,
       exchange, tradingsymbol, product, quantity_delta, price,
       previous_quantity, previous_avg_cost, new_quantity, new_avg_cost,
       realized_pnl, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPaperPosition = ctx.db.prepare(`
    INSERT INTO paper_positions
      (exchange, tradingsymbol, product, side, quantity, avg_cost_price,
       realized_pnl, mark_price, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDecisionReason = ctx.db.prepare(`
    INSERT INTO strategy_decision_reasons
      (strategy_decision_id, reason_code, reason_message)
    VALUES (?, ?, ?)
  `);

  const rows = [
    {
      proposalId: 1,
      decisionId: 1,
      executionAttemptId: 1,
      paperOrderId: 1,
      paperFillId: 1,
      positionEventId: 1,
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      side: 'buy',
      quantity: 10,
      price: 2500,
      strategyId: PUBLISHED_STRATEGY_ID,
      strategyVersion: PUBLISHED_STRATEGY_VERSION,
      tag: 'published-seam',
      researchEvidence: JSON.stringify({
        summary: 'Published witness branch traces to refinery strength research.',
        tags: ['published', 'lineage', 'witness'],
        freshnessMs: 180_000,
        influenceContext: 'Linked to publication provenance for operator strategy detail.',
      }),
      markPrice: 2610,
      realizedPnl: 0,
    },
    {
      proposalId: 2,
      decisionId: 2,
      executionAttemptId: 2,
      paperOrderId: 2,
      paperFillId: 2,
      positionEventId: 2,
      exchange: 'NSE',
      tradingsymbol: 'TCS',
      side: 'sell',
      quantity: 5,
      price: 4010,
      strategyId: PUBLISHED_STRATEGY_ID,
      strategyVersion: PUBLISHED_STRATEGY_VERSION,
      tag: 'published-seam-2',
      researchEvidence: JSON.stringify({
        summary: 'Published witness branch retained a second decision on the same strategy surface.',
        tags: ['published', 'secondary'],
        freshnessMs: 240_000,
        influenceContext: 'Keeps strategy-detail decision count above one.',
      }),
      markPrice: null,
      realizedPnl: 1250,
    },
    {
      proposalId: 3,
      decisionId: 3,
      executionAttemptId: 3,
      paperOrderId: 3,
      paperFillId: 3,
      positionEventId: 3,
      exchange: 'NSE',
      tradingsymbol: 'SBIN',
      side: 'buy',
      quantity: 12,
      price: 820,
      strategyId: PUBLISHED_STRATEGY_ID,
      strategyVersion: PUBLISHED_STRATEGY_VERSION,
      tag: 'published-seam-3',
      researchEvidence: JSON.stringify({
        summary: 'Published witness branch keeps a third operator-visible decision to prove truthful strategy totals.',
        tags: ['published', 'totals'],
        freshnessMs: 300_000,
        influenceContext: 'Ensures strategy detail shows more persisted decisions than the bounded lineage window.',
      }),
      markPrice: 833,
      realizedPnl: 0,
    },
    {
      proposalId: 4,
      decisionId: 4,
      executionAttemptId: 4,
      paperOrderId: 4,
      paperFillId: 4,
      positionEventId: 4,
      exchange: 'NSE',
      tradingsymbol: 'HDFCBANK',
      side: 'buy',
      quantity: 12,
      price: 1710,
      strategyId: 'rotation-probe',
      strategyVersion: '2.1.0',
      tag: 'control-branch',
      researchEvidence: null,
      markPrice: 1735,
      realizedPnl: 0,
    },
  ] as const;

  for (const [index, row] of rows.entries()) {
    const at = NOW + 300 + index * 10;
    insertProposal.run(
      row.proposalId,
      row.exchange,
      row.tradingsymbol,
      100000 + row.proposalId,
      row.side,
      'MIS',
      row.quantity,
      row.price,
      null,
      'LIMIT',
      row.tag,
      'accepted',
      at,
    );

    insertDecision.run(
      row.decisionId,
      row.proposalId,
      'approved',
      row.strategyId,
      row.strategyVersion,
      at + 1,
      row.exchange,
      row.tradingsymbol,
      row.side,
      'MIS',
      row.quantity,
      row.price,
      null,
      'LIMIT',
      row.price - 1,
      row.price - 1.5,
      row.price - 0.5,
      900_000,
      at + 1,
      row.quantity * row.price,
      'last_price',
      5_000,
      12.5,
      row.price - 12,
      6,
      20_000,
      'witness-book',
      row.researchEvidence,
      'EQ',
      'NSE',
      'EQ',
      null,
      null,
      1,
      0.05,
      20_000,
    );

    insertDecisionReason.run(row.decisionId, 'witness_seed', 'Seeded operator witness decision reason.');

    insertExecutionAttempt.run(
      row.executionAttemptId,
      row.decisionId,
      'paper',
      'completed',
      'paper_simulated',
      `ORD-${row.decisionId}`,
      'Seeded operator witness execution attempt.',
      at + 2,
      at + 3,
    );

    insertPaperOrder.run(
      row.paperOrderId,
      row.executionAttemptId,
      row.exchange,
      row.tradingsymbol,
      row.side,
      'MIS',
      row.quantity,
      row.price,
      'LIMIT',
      'filled',
      `ORD-${row.decisionId}`,
      at + 3,
    );

    insertPaperFill.run(
      row.paperFillId,
      row.paperOrderId,
      row.executionAttemptId,
      row.exchange,
      row.tradingsymbol,
      row.side,
      'MIS',
      row.quantity,
      row.price,
      `ORD-${row.decisionId}`,
      at + 4,
    );

    insertPositionEvent.run(
      row.positionEventId,
      row.paperOrderId,
      row.paperFillId,
      row.executionAttemptId,
      'fill',
      row.exchange,
      row.tradingsymbol,
      'MIS',
      row.side === 'buy' ? row.quantity : -row.quantity,
      row.price,
      0,
      0,
      row.side === 'buy' ? row.quantity : 0,
      row.price,
      row.realizedPnl,
      at + 5,
    );

    insertPaperPosition.run(
      row.exchange,
      row.tradingsymbol,
      'MIS',
      row.side === 'buy' ? 'long' : 'flat',
      row.side === 'buy' ? row.quantity : 0,
      row.side === 'buy' ? row.price : 0,
      row.realizedPnl,
      row.markPrice,
      at + 6,
    );
  }

  return 1;
}

export function summarizeLineageEntry(entry: OperatorResearchLineageEntry | undefined): Record<string, unknown> | null {
  if (!entry) return null;
  return {
    canonicalHash: entry.canonicalHash,
    lineageType: entry.lineageType,
    status: entry.status,
    generationAttemptId: entry.generationAttempt?.id ?? null,
    evaluationId: entry.evaluation?.id ?? null,
    publicationStrategy: entry.publication ? `${entry.publication.strategyId}@${entry.publication.strategyVersion}` : null,
    duplicateReason: entry.duplicateSkip?.reasonCode ?? null,
    diagnostics: entry.diagnostics,
  };
}

export async function startWitnessServer(ctx: OperatorLineageProofContext): Promise<StartedWitnessServer> {
  const config: OperatorUIConfig = {
    host: '127.0.0.1',
    port: await getFreePort(),
    dbPath: ctx.dbPath,
    username: 'operator',
    password: 'operator-proof-password',
    pollIntervalMs: 1000,
    lockoutThreshold: 5,
    lockoutDurationMs: 60_000,
    rateLimitMax: 100,
    rateLimitWindowMs: 60_000,
  };

  const authenticator = new Authenticator(config);
  authenticator.startCleanup();

  const server = createOperatorUIServer({
    config,
    authenticator,
    db: ctx.db,
    dbError: null,
    readModel: ctx.readModel,
    detailReadModel: ctx.detailReadModel,
    dbOpenBootstrap: {
      status: 'ready',
      attempts: 1,
      recoveredAfterRetry: false,
      lastError: null,
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });

  const close = async () => {
    authenticator.stopCleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    server,
    baseUrl: `http://${config.host}:${config.port}`,
    username: config.username,
    password: config.password,
    close,
  };
}

export function fetchDashboardPayload(ctx: OperatorLineageProofContext): DashboardPayload {
  return ctx.dashboardAssembler.fetchDashboardPayload(ctx.readModel, null, NOW + 999);
}

export function fetchResearchLineageSummary(
  ctx: OperatorLineageProofContext,
  limit: number,
): OperatorResearchLineageSummary {
  return ctx.readModel.getResearchLineageSummary(limit);
}

export function readLineageDetail(ctx: OperatorLineageProofContext, canonicalHash: string): OperatorResearchLineageDetail {
  return ctx.detailReadModel.getResearchLineageDetail(canonicalHash);
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

export async function fetchWithAuth(
  server: StartedWitnessServer,
  pathname: string,
  accept = 'text/html',
): Promise<WitnessFetchResponse> {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    headers: {
      Authorization: basicAuthHeader(server.username, server.password),
      Accept: accept,
    },
  });

  const body = await response.text();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to acquire ephemeral port.'));
        return;
      }
      const { port } = address;
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}
