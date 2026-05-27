import type Database from 'better-sqlite3';
import {
  type IndiaResearchDecisionEvidence,
  type OperatorBacktestDetail,
  type OperatorBacktestSelectedTrialDetail,
  type OperatorBacktestWindowEvidenceDetail,
  type OperatorDecisionDetail,
  type OperatorDecisionPerformance,
  type OperatorDecisionReasonDetail,
  type OperatorExecutionAttemptDetail,
  type OperatorGovernanceDecisionDetail,
  type OperatorHybridEvidenceDetail,
  type OperatorLifecycleState,
  type OperatorPromotionHistory,
  type OperatorProvenance,
  type OperatorStrategyDetail,
  type OperatorStrategyWalkForwardDetail,
  type OperatorResearchLineageDetail,
  type OperatorResearchLineageEntry,
  type OperatorResearchLineageTotals,
  type OperatorLineageSectionStatus,
  type OperatorResearchPublicationProvenance,
} from '../types/runtime.js';
import { StrategyDecisionRepository } from '../persistence/strategy-decision-repo.js';
import { HybridScoreRepository } from '../persistence/hybrid-score-repo.js';
import { ExecutionAttemptRepository } from '../persistence/execution-attempt-repo.js';
import { PaperFillRepository } from '../persistence/paper-fill-repo.js';
import { PaperPositionRepository } from '../persistence/paper-position-repo.js';
import { WalkForwardRepository } from '../persistence/walk-forward-repo.js';
import { calculatePersistedPaperFillChargeBreakdown } from '../execution/india-upstox-fee-visibility.js';
import { getIndiaTradingDayBounds, isDeliverySellDpCandidate } from '../execution/india-upstox-fee-model.js';

interface StrategyDecisionRawRow {
  id: number;
  proposal_attempt_id: number;
  decision_status: string;
  strategy_id: string;
  strategy_version: string;
  decided_at: number;
  exchange: string;
  tradingsymbol: string;
  side: string;
  product: string;
  quantity: number;
  price: number | null;
  trigger_price: number | null;
  order_type: string;
  quote_last_price: number | null;
  quote_bid: number | null;
  quote_ask: number | null;
  quote_volume: number | null;
  quote_received_at: number | null;
  risk_notional: number | null;
  risk_sizing_basis: string;
  risk_max_loss_rupees: number | null;
  risk_stop_distance: number | null;
  risk_stop_price: number | null;
  risk_trailing_stop_distance: number | null;
  risk_budget_rupees: number | null;
  risk_exposure_tag: string | null;
  india_research_evidence: string | null;
  execution_class: string;
  segment: string;
  instrument_type: string;
  expiry: string | null;
  strike: number | null;
  lot_size: number;
  tick_size: number;
  freeze_quantity: number | null;
}

interface StrategyLifecycleStateDbRow {
  strategy_id: string;
  strategy_version: string;
  market_id: string;
  phase: string;
  updated_at: number;
}

interface GovernanceDecisionDbRow {
  id: number;
  strategy_id: string;
  strategy_version: string;
  market_id: string;
  verdict: string;
  previous_phase: string;
  new_phase: string;
  rationale: string;
  evidence_json: string | null;
  winner_id: number | null;
  recorded_at: number;
}

interface StrategyPerformanceRow {
  trade_count: number;
  realized_pnl: number;
  total_fees: number;
  unrealized_pnl: number;
  total_return_pct: number | null;
  avg_sharpe: number | null;
  avg_max_drawdown: number | null;
  avg_win_rate: number | null;
  avg_profit_factor: number | null;
}

interface RecentDecisionRow {
  sd_id: number;
  sd_proposal_attempt_id: number;
  sd_exchange: string;
  sd_tradingsymbol: string;
  sd_side: string;
  sd_quantity: number;
  sd_price: number | null;
  sd_decision_status: string;
  sd_strategy_id: string;
  sd_decided_at: number;
  ea_status: string | null;
  ea_outcome_code: string | null;
  pf_fees: number | null;
  pe_realized_pnl: number | null;
}

interface StrategyWalkForwardRunRow {
  id: number;
  label: string;
  strategy_id: string;
  strategy_version: string;
  market_id: string;
  window_count: number;
  total_trials: number;
  status: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

interface StrategyPublicationRow {
  publication_id: number;
  publication_status: string;
  strategy_id: string;
  strategy_version: string;
  market_id: string;
  rationale: string;
  evidence_json: string;
  lifecycle_phase: string | null;
  governance_verdict: string | null;
  published_at: number | null;
  created_at: number;
  hypothesis_graph_id: number;
  canonical_hash: string;
  hypothesis_evaluation_id: number;
  evaluation_status: string;
  walk_forward_run_id: number | null;
  winner_id: number | null;
}

interface CountRow {
  cnt: number;
}

export class OperatorDetailReadModelError extends Error {
  readonly operation: 'decision' | 'strategy' | 'backtest';

  constructor(operation: 'decision' | 'strategy' | 'backtest', message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'OperatorDetailReadModelError';
    this.operation = operation;
    if (options && 'cause' in options) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        enumerable: false,
        configurable: true,
      });
    }
  }
}

export class OperatorDetailReadModel {
  private readonly _db: Database.Database;
  private readonly _strategyDecisionRepo: StrategyDecisionRepository;
  private readonly _hybridScoreRepo: HybridScoreRepository;
  private readonly _executionAttemptRepo: ExecutionAttemptRepository;
  private readonly _paperFillRepo: PaperFillRepository;
  private readonly _paperPositionRepo: PaperPositionRepository;
  private readonly _walkForwardRepo: WalkForwardRepository;

  constructor(db: Database.Database) {
    this._db = db;
    this._strategyDecisionRepo = new StrategyDecisionRepository(db);
    this._hybridScoreRepo = new HybridScoreRepository(db);
    this._executionAttemptRepo = new ExecutionAttemptRepository(db);
    this._paperFillRepo = new PaperFillRepository(db);
    this._paperPositionRepo = new PaperPositionRepository(db);
    this._walkForwardRepo = new WalkForwardRepository(db);
  }

  getDecisionDetail(decisionId: number): OperatorDecisionDetail | null {
    try {
      const decision = this._getStrategyDecisionRawById(decisionId);
      if (!decision) return null;

      const diagnostics: string[] = [];
      const reasons = this._strategyDecisionRepo.getReasonsForDecision(decisionId).map<OperatorDecisionReasonDetail>(reason => ({
        reasonCode: reason.reasonCode,
        reasonMessage: reason.reasonMessage,
      }));
      const indiaResearchEvidence = this._safeParseJson<IndiaResearchDecisionEvidence>(
        decision.india_research_evidence,
        `strategy_decisions.id=${decisionId}.india_research_evidence`,
        diagnostics,
      );

      const hybrid = this._hybridScoreRepo.getByProposalAttemptId(decision.proposal_attempt_id);
      const executionAttempt = this._executionAttemptRepo.getByStrategyDecisionId(decision.id);

      let executionDetail: OperatorExecutionAttemptDetail | null = null;
      let paperFill: OperatorDecisionDetail['paperFill'] = null;
      let realizedPnl: OperatorDecisionDetail['realizedPnl'] = null;
      if (executionAttempt) {
        const refusalReasons = this._executionAttemptRepo.getRefusalReasons(executionAttempt.id).map<OperatorDecisionReasonDetail>(reason => ({
          reasonCode: reason.reasonCode,
          reasonMessage: reason.reasonMessage,
        }));
        executionDetail = {
          id: executionAttempt.id,
          executionMode: executionAttempt.executionMode,
          status: executionAttempt.status,
          outcomeCode: executionAttempt.outcomeCode,
          brokerOrderId: executionAttempt.brokerOrderId,
          message: executionAttempt.message,
          attemptedAt: this._iso(executionAttempt.attemptedAt),
          completedAt: this._isoNullable(executionAttempt.completedAt),
          refusalReasons,
        };

        const fill = this._paperFillRepo.getByExecutionAttemptId(executionAttempt.id);
        if (fill) {
          const breakdown = calculatePersistedPaperFillChargeBreakdown({
            exchange: decision.exchange,
            tradingsymbol: decision.tradingsymbol,
            side: decision.side,
            product: decision.product,
            quantity: fill.filledQuantity,
            executionClass: decision.execution_class as 'EQ' | 'FO',
            segment: decision.segment,
            instrumentType: decision.instrument_type,
            expiry: decision.expiry,
            strike: decision.strike,
            lotSize: decision.lot_size,
            tickSize: decision.tick_size,
            freezeQuantity: decision.freeze_quantity,
            fillPrice: fill.filledPrice,
            filledAt: fill.filledAt,
            applyDpCharge: this._isFirstDeliverySellFillForDay(fill.id, decision),
          });
          paperFill = {
            filledAt: this._iso(fill.filledAt),
            filledQuantity: fill.filledQuantity,
            filledPrice: fill.filledPrice,
            referencePrice: fill.referencePrice,
            slippageAmount: fill.slippageAmount,
            fees: fill.fees,
            feeBreakdown: {
              segment: breakdown.segment,
              turnover: breakdown.turnover,
              brokerage: breakdown.brokerage,
              stt: breakdown.stt,
              exchangeTransactionCharge: breakdown.exchangeTransactionCharge,
              ipftCharge: breakdown.ipftCharge,
              sebiCharge: breakdown.sebiCharge,
              stampDuty: breakdown.stampDuty,
              gst: breakdown.gst,
              dpCharge: breakdown.dpCharge,
              totalFees: breakdown.totalFees,
            },
          };
        }

        const linkedEvents = this._paperPositionRepo.getEventsByExecutionAttemptId(executionAttempt.id);
        const currentPosition = this._paperPositionRepo.getPosition(decision.exchange, decision.tradingsymbol, decision.product);
        realizedPnl = {
          realizedPnl: linkedEvents.reduce((sum, event) => sum + event.realizedPnl, 0),
          eventCount: linkedEvents.length,
          latestEventAt: linkedEvents.length > 0
            ? this._iso(Math.max(...linkedEvents.map(event => event.createdAt)))
            : null,
          currentPosition: currentPosition
            ? {
                exchange: currentPosition.exchange,
                tradingsymbol: currentPosition.tradingsymbol,
                product: currentPosition.product,
                side: currentPosition.side,
                quantity: currentPosition.quantity,
                avgCostPrice: currentPosition.avgCostPrice,
                realizedPnl: currentPosition.realizedPnl,
                markPrice: currentPosition.markPrice,
                updatedAt: this._iso(currentPosition.updatedAt),
              }
            : null,
        };
      }

      const hybridDetail: OperatorHybridEvidenceDetail | null = hybrid
        ? {
            summaryId: hybrid.id,
            deterministicScore: hybrid.deterministicScore,
            llmScore: hybrid.llmScore,
            llmStatus: hybrid.llmStatus,
            llmRationale: hybrid.llmRationale,
            mergedScore: hybrid.mergedScore,
            mergePolicy: hybrid.mergePolicy,
            createdAt: this._iso(hybrid.createdAt),
            components: hybrid.components.map(component => ({
              componentName: component.componentName,
              score: component.score,
              weight: component.weight,
              sortOrder: component.sortOrder,
            })),
          }
        : null;

      return {
        decisionId: decision.id,
        proposalAttemptId: decision.proposal_attempt_id,
        decisionStatus: decision.decision_status,
        strategyId: decision.strategy_id,
        strategyVersion: decision.strategy_version,
        decidedAt: this._iso(decision.decided_at),
        reasons,
        indiaResearchEvidence,
        trade: {
          exchange: decision.exchange,
          tradingsymbol: decision.tradingsymbol,
          side: decision.side,
          product: decision.product,
          quantity: decision.quantity,
          price: decision.price,
          triggerPrice: decision.trigger_price,
          orderType: decision.order_type,
        },
        quote: {
          lastPrice: decision.quote_last_price,
          bid: decision.quote_bid,
          ask: decision.quote_ask,
          volume: decision.quote_volume,
          receivedAt: this._isoNullable(decision.quote_received_at),
        },
        risk: {
          notional: decision.risk_notional,
          sizingBasis: decision.risk_sizing_basis,
          maxLossRupees: decision.risk_max_loss_rupees,
          stopDistance: decision.risk_stop_distance,
          stopPrice: decision.risk_stop_price,
          trailingStopDistance: decision.risk_trailing_stop_distance,
          riskBudgetRupees: decision.risk_budget_rupees,
          exposureTag: decision.risk_exposure_tag,
        },
        instrument: {
          executionClass: decision.execution_class,
          segment: decision.segment,
          instrumentType: decision.instrument_type,
          expiry: decision.expiry,
          strike: decision.strike,
          lotSize: decision.lot_size,
          tickSize: decision.tick_size,
          freezeQuantity: decision.freeze_quantity,
        },
        hybrid: hybridDetail,
        executionAttempt: executionDetail,
        paperFill,
        realizedPnl,
        diagnostics,
        provenance: this._provenance('historical', 'strategy_decisions+reasons+hybrid_score+execution_attempts+position_events'),
      };
    } catch (error) {
      throw new OperatorDetailReadModelError('decision', `Failed to compose operator decision detail for decision ${decisionId}`, {
        cause: error,
      });
    }
  }

  getStrategyDetail(strategyId: string, strategyVersion: string): OperatorStrategyDetail | null {
    try {
      if (!this._strategyIdentityExists(strategyId, strategyVersion)) return null;

      const diagnostics: string[] = [];
      const performanceRow = this._getStrategyPerformance(strategyId, strategyVersion);
      const currentStates = this._db.prepare(`
        SELECT strategy_id, strategy_version, market_id, phase, updated_at
        FROM strategy_lifecycle_state
        WHERE strategy_id = ? AND strategy_version = ?
        ORDER BY market_id ASC
      `).all(strategyId, strategyVersion) as StrategyLifecycleStateDbRow[];

      const governanceRows = this._db.prepare(`
        SELECT id, strategy_id, strategy_version, market_id, verdict,
               previous_phase, new_phase, rationale, evidence_json, winner_id, recorded_at
        FROM governance_decisions
        WHERE strategy_id = ? AND strategy_version = ?
        ORDER BY recorded_at DESC, id DESC
      `).all(strategyId, strategyVersion) as GovernanceDecisionDbRow[];

      const recentDecisions = this._getRecentDecisionPerformance(strategyId, strategyVersion);
      const publishedResearchProvenance = this._getStrategyPublicationProvenance(strategyId, strategyVersion, diagnostics);
      const promotionHistory: OperatorPromotionHistory[] = governanceRows
        .filter(row => row.verdict === 'promote')
        .map(row => ({
          id: row.id,
          strategyId: row.strategy_id,
          strategyVersion: row.strategy_version,
          marketId: row.market_id,
          previousPhase: row.previous_phase,
          newPhase: row.new_phase,
          rationale: row.rationale,
          winnerId: row.winner_id,
          promotedAt: this._iso(row.recorded_at),
          provenance: this._provenance('historical', 'governance_decisions'),
        }));

      const walkForwardRuns = this._db.prepare(`
        SELECT id, label, strategy_id, strategy_version, market_id,
               window_count, total_trials, status, created_at, started_at, completed_at
        FROM walk_forward_runs
        WHERE strategy_id = ? AND strategy_version = ?
        ORDER BY COALESCE(completed_at, created_at) DESC, id DESC
      `).all(strategyId, strategyVersion) as StrategyWalkForwardRunRow[];

      const walkForwardDetails: OperatorStrategyWalkForwardDetail[] = walkForwardRuns.map(run => {
        const context = this._walkForwardRepo.getWinnerWithContext(run.id);
        const selectedWindowEvidence = context?.selectedTrial?.windowEvidence ?? [];
        return {
          runId: run.id,
          label: run.label,
          marketId: run.market_id,
          status: run.status,
          windowCount: run.window_count,
          totalTrials: run.total_trials,
          winnerId: context?.id ?? null,
          result: context?.result ?? null,
          selectionStrategy: context?.selectionStrategy ?? null,
          selectedTrialId: context?.selectedTrialId ?? null,
          selectedTrialLabel: context?.selectedTrial?.label ?? null,
          mergedScore: context?.selectedTrial?.mergedScore ?? null,
          sharpeRatio: this._averageNullable(selectedWindowEvidence.map(window => window.sharpeRatio)),
          totalReturnPct: this._averageNullable(selectedWindowEvidence.map(window => window.totalReturn)),
          maxDrawdownPct: this._averageNullable(selectedWindowEvidence.map(window => window.maxDrawdown)),
          winRate: this._averageNullable(selectedWindowEvidence.map(window => window.winRate)),
          rationale: context?.rationale ?? null,
          selectedAt: context ? this._iso(context.selectedAt) : null,
        };
      });

      const governanceHistory: OperatorGovernanceDecisionDetail[] = governanceRows.map(row => ({
        id: row.id,
        marketId: row.market_id,
        verdict: row.verdict,
        previousPhase: row.previous_phase,
        newPhase: row.new_phase,
        rationale: row.rationale,
        winnerId: row.winner_id,
        evidence: this._safeParseJson<Record<string, unknown>>(
          row.evidence_json,
          `governance_decisions.id=${row.id}.evidence_json`,
          diagnostics,
        ),
        recordedAt: this._iso(row.recorded_at),
      }));

      const hostEvidencePresence = {
        lifecycleStates: this._countRows('SELECT COUNT(*) AS cnt FROM strategy_lifecycle_state') > 0,
        governanceHistory: this._countRows('SELECT COUNT(*) AS cnt FROM governance_decisions') > 0,
        promotionHistory: this._countRows("SELECT COUNT(*) AS cnt FROM governance_decisions WHERE verdict = 'promote'") > 0,
        walkForwardRuns: this._countRows('SELECT COUNT(*) AS cnt FROM walk_forward_runs') > 0,
        researchPublications: this._countRows('SELECT COUNT(*) AS cnt FROM research_publications') > 0,
      };

      return {
        strategyId,
        strategyVersion,
        performance: {
          totalReturnPct: performanceRow.total_return_pct,
          sharpeRatio: performanceRow.avg_sharpe,
          maxDrawdownPct: performanceRow.avg_max_drawdown,
          tradeCount: performanceRow.trade_count,
          winRate: performanceRow.avg_win_rate,
          profitFactor: performanceRow.avg_profit_factor,
          realizedPnl: performanceRow.realized_pnl,
          totalFees: performanceRow.total_fees,
          unrealizedPnl: performanceRow.unrealized_pnl,
        },
        recentDecisions,
        publishedResearchProvenance,
        hostEvidencePresence,
        currentStates: currentStates.map<OperatorLifecycleState>(row => ({
          strategyId: row.strategy_id,
          strategyVersion: row.strategy_version,
          marketId: row.market_id,
          phase: row.phase,
          updatedAt: this._iso(row.updated_at),
          provenance: this._provenance('historical', 'strategy_lifecycle_state'),
        })),
        governanceHistory,
        promotionHistory,
        walkForwardRuns: walkForwardDetails,
        diagnostics,
        provenance: this._provenance('historical', 'strategy_decisions+execution_attempts+strategy_lifecycle_state+governance_decisions+walk_forward_runs'),
      };
    } catch (error) {
      throw new OperatorDetailReadModelError('strategy', `Failed to compose operator strategy detail for ${strategyId}@${strategyVersion}`, {
        cause: error,
      });
    }
  }

  getBacktestDetail(runId: number): OperatorBacktestDetail | null {
    try {
      const context = this._walkForwardRepo.getWinnerWithContext(runId);
      if (!context) return null;

      const diagnostics: string[] = [];
      const selectedTrial: OperatorBacktestSelectedTrialDetail | null = context.selectedTrial
        ? {
            id: context.selectedTrial.id,
            runId: context.selectedTrial.runId,
            trialIndex: context.selectedTrial.trialIndex,
            label: context.selectedTrial.label,
            params: this._safeParseJson<Record<string, unknown>>(
              context.selectedTrial.paramsJson,
              `walk_forward_trials.id=${context.selectedTrial.id}.params_json`,
              diagnostics,
            ),
            mergedScore: context.selectedTrial.mergedScore,
            deterministicScore: context.selectedTrial.deterministicScore,
            llmScore: context.selectedTrial.llmScore,
            llmStatus: context.selectedTrial.llmStatus,
            rank: context.selectedTrial.rank,
            windowEvidence: context.selectedTrial.windowEvidence.map<OperatorBacktestWindowEvidenceDetail>(window => ({
              id: window.id,
              trialId: window.trialId,
              windowId: window.windowId,
              windowType: window.windowType,
              totalReturnPct: window.totalReturn,
              sharpeRatio: window.sharpeRatio,
              maxDrawdownPct: window.maxDrawdown,
              winRate: window.winRate,
              tradeCount: window.tradeCount,
              profitFactor: window.profitFactor,
              metrics: this._safeParseJson<Record<string, unknown>>(
                window.metricsJson,
                `walk_forward_trial_windows.id=${window.id}.metrics_json`,
                diagnostics,
              ),
            })),
          }
        : null;

      return {
        runId: context.run.id,
        label: context.run.label,
        strategyId: context.run.strategyId,
        strategyVersion: context.run.strategyVersion,
        marketId: context.run.marketId,
        status: context.run.status,
        windowCount: context.run.windowCount,
        totalTrials: context.run.totalTrials,
        createdAt: this._iso(context.run.createdAt),
        startedAt: this._isoNullable(context.run.startedAt),
        completedAt: this._isoNullable(context.run.completedAt),
        winnerId: context.id,
        result: context.result,
        selectedTrialId: context.selectedTrialId,
        selectionStrategy: context.selectionStrategy,
        selectionConfig: this._safeParseJson<Record<string, unknown>>(
          context.selectionConfigJson,
          `walk_forward_winners.id=${context.id}.selection_config_json`,
          diagnostics,
        ),
        rationale: context.rationale,
        artifactPaths: this._safeParseStringArray(
          context.artifactPathsJson,
          `walk_forward_winners.id=${context.id}.artifact_paths_json`,
          diagnostics,
        ),
        selectedAt: this._iso(context.selectedAt),
        selectedTrial,
        rankedCandidates: context.rankedCandidates.map(candidate => ({
          trialId: candidate.trialId,
          rank: candidate.rank,
          label: candidate.label,
          params: this._safeParseJson<Record<string, unknown>>(
            candidate.paramsJson,
            `walk_forward_ranked_candidate.trialId=${candidate.trialId}.params_json`,
            diagnostics,
          ),
          mergedScore: candidate.mergedScore,
          deterministicScore: candidate.deterministicScore,
          llmScore: candidate.llmScore,
          llmStatus: candidate.llmStatus,
          windowCount: candidate.windowCount,
        })),
        diagnostics,
        provenance: this._provenance('historical', 'walk_forward_runs+winners+trials+trial_windows'),
      };
    } catch (error) {
      throw new OperatorDetailReadModelError('backtest', `Failed to compose operator backtest detail for run ${runId}`, {
        cause: error,
      });
    }
  }

  getResearchLineageDetail(canonicalHash: string): OperatorResearchLineageDetail {
    const totals = this._getResearchLineageTotals();
    const provenance = this._provenance('historical', 'hypothesis_generation_attempts+hypothesis_memory_ledger+hypothesis_graphs+hypothesis_evaluations+research_publications');

    try {
      const entries = this._composeResearchLineageEntries(canonicalHash);
      return {
        canonicalHash,
        totals,
        entries,
        status: {
          availability: entries.length === 0 ? (this._hasAnyResearchLineageEvidence(totals) ? 'empty' : 'unavailable') : 'ready',
          diagnostics: [],
          provenance: this._lineageSourceProvenance(),
        },
        provenance,
      };
    } catch {
      return {
        canonicalHash,
        totals,
        entries: [],
        status: {
          availability: this._hasAnyResearchLineageEvidence(totals) ? 'error' : 'unavailable',
          diagnostics: [{ code: 'research_lineage_detail_failed', message: 'Research lineage detail is temporarily unavailable.' }],
          provenance: this._lineageSourceProvenance(),
        },
        provenance,
      };
    }
  }

  private _composeResearchLineageEntries(canonicalHash: string): OperatorResearchLineageEntry[] {
    const entries: OperatorResearchLineageEntry[] = [];
    const diagnostics: string[] = [];

    const generationRows = this._db.prepare(`
      SELECT id, verdict, provider_url, provider_model, hypothesis_graph_id, hypothesis_evaluation_id, created_at
      FROM hypothesis_generation_attempts
      WHERE canonical_hash = ?
      ORDER BY created_at ASC, id ASC
    `).all(canonicalHash) as Array<{
      id: number;
      verdict: string;
      provider_url: string;
      provider_model: string | null;
      hypothesis_graph_id: number | null;
      hypothesis_evaluation_id: number | null;
      created_at: number;
    }>;

    for (const row of generationRows) {
      const reasonCodes = this._db.prepare(`
        SELECT reason_code FROM hypothesis_generation_reasons
        WHERE generation_attempt_id = ?
        ORDER BY id ASC
      `).all(row.id) as Array<{ reason_code: string }>;

      entries.push({
        canonicalHash,
        lineageType: row.hypothesis_evaluation_id !== null
          ? 'evaluation'
          : row.hypothesis_graph_id !== null
            ? 'hypothesis'
            : row.verdict === 'skipped'
              ? 'duplicate_skip'
              : 'generation',
        status: row.verdict,
        happenedAt: this._iso(row.created_at),
        generationAttempt: {
          id: row.id,
          verdict: row.verdict,
          reasonCodes: reasonCodes.map(reason => reason.reason_code),
          providerLabel: row.provider_model ?? row.provider_url,
        },
        duplicateSkip: row.verdict === 'skipped'
          ? {
              memoryEntryId: 0,
              memoryStatus: 'skipped',
              reasonCode: reasonCodes[0]?.reason_code ?? 'duplicate_skipped',
              hasLaterHypothesis: row.hypothesis_graph_id !== null,
            }
          : null,
        hypothesis: row.hypothesis_graph_id !== null
          ? { id: row.hypothesis_graph_id, status: row.verdict === 'accepted' ? 'validated' : row.verdict, createdAt: this._iso(row.created_at) }
          : null,
        evaluation: row.hypothesis_evaluation_id !== null
          ? { id: row.hypothesis_evaluation_id, status: 'persisted', walkForwardRunId: null, winnerId: null }
          : null,
        publication: null,
        diagnostics: [],
      });
    }

    const memory = this._db.prepare(`
      SELECT id, status, reason_code, created_at
      FROM hypothesis_memory_ledger
      WHERE canonical_hash = ?
      ORDER BY created_at ASC, id ASC
    `).all(canonicalHash) as Array<{ id: number; status: string; reason_code: string; created_at: number }>;

    for (const row of memory) {
      entries.push({
        canonicalHash,
        lineageType: 'duplicate_skip',
        status: row.status,
        happenedAt: this._iso(row.created_at),
        generationAttempt: null,
        duplicateSkip: {
          memoryEntryId: row.id,
          memoryStatus: row.status,
          reasonCode: row.reason_code,
          hasLaterHypothesis: generationRows.some(g => g.hypothesis_graph_id !== null),
        },
        hypothesis: null,
        evaluation: null,
        publication: null,
        diagnostics: [],
      });
    }

    const publications = this._db.prepare(`
      SELECT rp.id, rp.status, rp.strategy_id, rp.strategy_version, rp.market_id, rp.published_at, sls.phase AS lifecycle_phase,
             (
               SELECT gd.verdict
               FROM governance_decisions gd
               WHERE gd.strategy_id = rp.strategy_id
                 AND gd.strategy_version = rp.strategy_version
                 AND gd.market_id = rp.market_id
               ORDER BY gd.recorded_at DESC, gd.id DESC
               LIMIT 1
             ) AS governance_verdict,
             he.hypothesis_graph_id,
             hg.canonical_hash,
             he.id AS evaluation_id,
             he.status AS evaluation_status,
             he.walk_forward_run_id,
             he.winner_id,
             rp.created_at
      FROM research_publications rp
      INNER JOIN hypothesis_evaluations he ON he.id = rp.hypothesis_evaluation_id
      INNER JOIN hypothesis_graphs hg ON hg.id = he.hypothesis_graph_id
      LEFT JOIN strategy_lifecycle_state sls ON sls.id = rp.lifecycle_state_id
      WHERE hg.canonical_hash = ?
      ORDER BY rp.created_at ASC, rp.id ASC
    `).all(canonicalHash) as Array<{
      id: number;
      status: string;
      strategy_id: string;
      strategy_version: string;
      market_id: string;
      published_at: number | null;
      lifecycle_phase: string | null;
      governance_verdict: string | null;
      hypothesis_graph_id: number;
      canonical_hash: string;
      evaluation_id: number;
      evaluation_status: string;
      walk_forward_run_id: number | null;
      winner_id: number | null;
      created_at: number;
    }>;

    for (const row of publications) {
      entries.push({
        canonicalHash: row.canonical_hash,
        lineageType: 'publication',
        status: row.status,
        happenedAt: this._iso(row.created_at),
        generationAttempt: null,
        duplicateSkip: null,
        hypothesis: { id: row.hypothesis_graph_id, status: 'persisted', createdAt: this._iso(row.created_at) },
        evaluation: {
          id: row.evaluation_id,
          status: row.evaluation_status,
          walkForwardRunId: row.walk_forward_run_id,
          winnerId: row.winner_id,
        },
        publication: {
          publicationId: row.id,
          publicationStatus: row.status,
          strategyId: row.strategy_id,
          strategyVersion: row.strategy_version,
          marketId: row.market_id,
          lifecyclePhase: row.lifecycle_phase,
          governanceVerdict: row.governance_verdict,
          publishedAt: this._isoNullable(row.published_at),
        },
        diagnostics: diagnostics.slice(),
      });
    }

    return entries.sort((a, b) => a.happenedAt.localeCompare(b.happenedAt));
  }

  private _getResearchLineageTotals(): OperatorResearchLineageTotals {
    return {
      generationAttempts: this._countRows('SELECT COUNT(*) AS cnt FROM hypothesis_generation_attempts'),
      hypotheses: this._countRows('SELECT COUNT(*) AS cnt FROM hypothesis_graphs'),
      evaluations: this._countRows('SELECT COUNT(*) AS cnt FROM hypothesis_evaluations'),
      duplicateSkips: this._countRows('SELECT COUNT(*) AS cnt FROM hypothesis_memory_ledger'),
      publications: this._countRows('SELECT COUNT(*) AS cnt FROM research_publications'),
    };
  }

  private _lineageSourceProvenance(): OperatorLineageSectionStatus['provenance'] {
    return [
      { sourceLabel: 'hypothesis_generation_attempts', detail: 'recent generation lineage rows' },
      { sourceLabel: 'hypothesis_memory_ledger', detail: 'duplicate-skip lineage rows' },
      { sourceLabel: 'hypothesis_graphs', detail: 'persisted hypothesis linkage' },
      { sourceLabel: 'hypothesis_evaluations', detail: 'persisted evaluation linkage' },
      { sourceLabel: 'research_publications', detail: 'publication provenance' },
      { sourceLabel: 'strategy_lifecycle_state', detail: 'publication lifecycle phase' },
      { sourceLabel: 'governance_decisions', detail: 'latest publication governance verdict' },
    ];
  }

  private _hasAnyResearchLineageEvidence(totals: OperatorResearchLineageTotals): boolean {
    return totals.generationAttempts > 0
      || totals.hypotheses > 0
      || totals.evaluations > 0
      || totals.duplicateSkips > 0
      || totals.publications > 0;
  }

  private _getStrategyDecisionRawById(id: number): StrategyDecisionRawRow | null {
    const row = this._db.prepare(`
      SELECT id, proposal_attempt_id, decision_status, strategy_id, strategy_version,
             decided_at, exchange, tradingsymbol, side, product, quantity, price,
             trigger_price, order_type, quote_last_price, quote_bid, quote_ask,
             quote_volume, quote_received_at, risk_notional, risk_sizing_basis,
             risk_max_loss_rupees, risk_stop_distance, risk_stop_price,
             risk_trailing_stop_distance, risk_budget_rupees, risk_exposure_tag,
             india_research_evidence, execution_class, segment, instrument_type,
             expiry, strike, lot_size, tick_size, freeze_quantity
      FROM strategy_decisions
      WHERE id = ?
    `).get(id) as StrategyDecisionRawRow | undefined;

    return row ?? null;
  }

  private _strategyIdentityExists(strategyId: string, strategyVersion: string): boolean {
    const sources = [
      'SELECT COUNT(*) AS cnt FROM strategy_decisions WHERE strategy_id = ? AND strategy_version = ?',
      'SELECT COUNT(*) AS cnt FROM strategy_lifecycle_state WHERE strategy_id = ? AND strategy_version = ?',
      'SELECT COUNT(*) AS cnt FROM governance_decisions WHERE strategy_id = ? AND strategy_version = ?',
      'SELECT COUNT(*) AS cnt FROM walk_forward_runs WHERE strategy_id = ? AND strategy_version = ?',
    ];

    return sources.some(sql => {
      const row = this._db.prepare(sql).get(strategyId, strategyVersion) as CountRow;
      return row.cnt > 0;
    });
  }

  private _getStrategyPerformance(strategyId: string, strategyVersion: string): StrategyPerformanceRow {
    const hasQuoteTable = this._tableExists('zerodha_latest_quotes');
    const quoteJoin = hasQuoteTable
      ? 'LEFT JOIN zerodha_latest_quotes q ON q.exchange = pp.exchange AND q.tradingsymbol = pp.tradingsymbol'
      : '';
    const effectivePrice = hasQuoteTable
      ? 'COALESCE(pp.mark_price, q.last_price)'
      : 'pp.mark_price';

    const row = this._db.prepare(`
      SELECT
        COALESCE(COUNT(pf.id), 0) AS trade_count,
        COALESCE(SUM(DISTINCT pp.realized_pnl), 0) AS realized_pnl,
        COALESCE(SUM(pf.fees), 0) AS total_fees,
        COALESCE(SUM(DISTINCT CASE
          WHEN pp.quantity != 0 AND ${effectivePrice} IS NOT NULL AND pp.avg_cost_price != 0
            THEN (${effectivePrice} - pp.avg_cost_price) * ABS(pp.quantity)
          ELSE 0
        END), 0) AS unrealized_pnl,
        AVG(wtw.total_return) AS total_return_pct,
        AVG(wtw.sharpe_ratio) AS avg_sharpe,
        AVG(wtw.max_drawdown) AS avg_max_drawdown,
        AVG(wtw.win_rate) AS avg_win_rate,
        AVG(wtw.profit_factor) AS avg_profit_factor
      FROM strategy_decisions sd
      LEFT JOIN execution_attempts ea ON ea.strategy_decision_id = sd.id
      LEFT JOIN paper_fills pf ON pf.execution_attempt_id = ea.id
      LEFT JOIN paper_positions pp
        ON pp.exchange = sd.exchange
       AND pp.tradingsymbol = sd.tradingsymbol
       AND pp.product = sd.product
      ${quoteJoin}
      LEFT JOIN walk_forward_runs wr
        ON wr.strategy_id = sd.strategy_id
       AND wr.strategy_version = sd.strategy_version
      LEFT JOIN walk_forward_winners ww ON ww.run_id = wr.id
      LEFT JOIN walk_forward_trials wt ON wt.id = ww.selected_trial_id
      LEFT JOIN walk_forward_trial_windows wtw ON wtw.trial_id = wt.id
      WHERE sd.strategy_id = ?
        AND sd.strategy_version = ?
    `).get(strategyId, strategyVersion) as StrategyPerformanceRow | undefined;

    return row ?? {
      trade_count: 0,
      realized_pnl: 0,
      total_fees: 0,
      unrealized_pnl: 0,
      total_return_pct: null,
      avg_sharpe: null,
      avg_max_drawdown: null,
      avg_win_rate: null,
      avg_profit_factor: null,
    };
  }

  private _getRecentDecisionPerformance(strategyId: string, strategyVersion: string, limit = 20): OperatorDecisionPerformance[] {
    const rows = this._db.prepare(`
      SELECT
        sd.id AS sd_id,
        sd.proposal_attempt_id AS sd_proposal_attempt_id,
        sd.exchange AS sd_exchange,
        sd.tradingsymbol AS sd_tradingsymbol,
        sd.side AS sd_side,
        sd.quantity AS sd_quantity,
        sd.price AS sd_price,
        sd.decision_status AS sd_decision_status,
        sd.strategy_id AS sd_strategy_id,
        sd.decided_at AS sd_decided_at,
        ea.status AS ea_status,
        ea.outcome_code AS ea_outcome_code,
        pf.fees AS pf_fees,
        (
          SELECT COALESCE(SUM(pe.realized_pnl), 0)
          FROM position_events pe
          WHERE pe.execution_attempt_id = ea.id
        ) AS pe_realized_pnl
      FROM strategy_decisions sd
      LEFT JOIN execution_attempts ea ON ea.strategy_decision_id = sd.id
      LEFT JOIN paper_fills pf ON pf.execution_attempt_id = ea.id
      WHERE sd.strategy_id = ?
        AND sd.strategy_version = ?
      ORDER BY sd.decided_at DESC, sd.id DESC
      LIMIT ?
    `).all(strategyId, strategyVersion, limit) as RecentDecisionRow[];

    return rows.map(row => ({
      decisionId: row.sd_id,
      proposalAttemptId: row.sd_proposal_attempt_id,
      exchange: row.sd_exchange,
      tradingsymbol: row.sd_tradingsymbol,
      side: row.sd_side,
      quantity: row.sd_quantity,
      price: row.sd_price,
      decisionStatus: row.sd_decision_status,
      strategyId: row.sd_strategy_id,
      decidedAt: this._iso(row.sd_decided_at),
      executionStatus: row.ea_status,
      outcomeCode: row.ea_outcome_code,
      fees: row.pf_fees,
      realizedPnl: row.ea_status ? row.pe_realized_pnl : null,
      provenance: this._provenance('historical', 'strategy_decisions+execution_attempts+position_events'),
    }));
  }

  private _getStrategyPublicationProvenance(
    strategyId: string,
    strategyVersion: string,
    diagnostics: string[],
  ): OperatorStrategyDetail['publishedResearchProvenance'] {
    const row = this._db.prepare(`
      SELECT rp.id AS publication_id,
             rp.status AS publication_status,
             rp.strategy_id,
             rp.strategy_version,
             rp.market_id,
             rp.rationale,
             rp.evidence_json,
             sls.phase AS lifecycle_phase,
             gd.verdict AS governance_verdict,
             rp.published_at,
             rp.created_at,
             hg.id AS hypothesis_graph_id,
             hg.canonical_hash,
             he.id AS hypothesis_evaluation_id,
             he.status AS evaluation_status,
             he.walk_forward_run_id,
             he.winner_id
      FROM research_publications rp
      INNER JOIN hypothesis_evaluations he ON he.id = rp.hypothesis_evaluation_id
      INNER JOIN hypothesis_graphs hg ON hg.id = he.hypothesis_graph_id
      LEFT JOIN strategy_lifecycle_state sls ON sls.id = rp.lifecycle_state_id
      LEFT JOIN governance_decisions gd ON gd.id = rp.governance_decision_id
      WHERE rp.strategy_id = ?
        AND rp.strategy_version = ?
      ORDER BY COALESCE(rp.published_at, rp.created_at) DESC, rp.id DESC
      LIMIT 1
    `).get(strategyId, strategyVersion) as StrategyPublicationRow | undefined;

    if (!row) return null;

    return {
      publicationId: row.publication_id,
      publicationStatus: row.publication_status,
      hypothesisGraphId: row.hypothesis_graph_id,
      canonicalHash: row.canonical_hash,
      hypothesisEvaluationId: row.hypothesis_evaluation_id,
      evaluationStatus: row.evaluation_status,
      walkForwardRunId: row.walk_forward_run_id,
      winnerId: row.winner_id,
      marketId: row.market_id,
      lifecyclePhase: row.lifecycle_phase,
      governanceVerdict: row.governance_verdict,
      rationale: row.rationale,
      evidence: this._safeParseJson<Record<string, unknown>>(
        row.evidence_json,
        `research_publications.id=${row.publication_id}.evidence_json`,
        diagnostics,
      ),
      publishedAt: this._isoNullable(row.published_at),
      createdAt: this._iso(row.created_at),
      provenance: this._provenance('historical', 'research_publications+hypothesis_evaluations+hypothesis_graphs+strategy_lifecycle_state+governance_decisions'),
    };
  }

  private _isFirstDeliverySellFillForDay(
    fillId: number,
    decision: {
      exchange: string;
      tradingsymbol: string;
      product: string;
      side: string;
      execution_class: string;
      instrument_type: string;
      segment: string;
    },
  ): boolean {
    if (!isDeliverySellDpCandidate({
      exchange: decision.exchange,
      side: decision.side,
      product: decision.product,
      executionClass: decision.execution_class as 'EQ' | 'FO',
      instrumentType: decision.instrument_type,
      segment: decision.segment,
    })) {
      return false;
    }

    const fill = this._paperFillRepo.getById(fillId);
    if (!fill) return false;
    const { startMs, endMs } = getIndiaTradingDayBounds(fill.filledAt);
    const sameDaySells = this._paperFillRepo.getByWindow(
      fill.exchange,
      fill.tradingsymbol,
      fill.product,
      'sell',
      startMs,
      endMs,
    );

    return sameDaySells.length > 0 && sameDaySells[0].id === fill.id;
  }

  private _countRows(sql: string, ...params: Array<string | number>): number {
    const row = this._db.prepare(sql).get(...params) as CountRow | undefined;
    return row?.cnt ?? 0;
  }

  private _safeParseJson<T>(raw: string | null, label: string, diagnostics: string[]): T | null {
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      diagnostics.push(`Malformed JSON ignored at ${label}.`);
      return null;
    }
  }

  private _safeParseStringArray(raw: string | null, label: string, diagnostics: string[]): string[] | null {
    const parsed = this._safeParseJson<unknown>(raw, label, diagnostics);
    if (parsed === null) return raw === null ? null : null;
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
      diagnostics.push(`Expected string[] at ${label}; treating value as absent.`);
      return null;
    }
    return parsed;
  }

  private _averageNullable(values: Array<number | null>): number | null {
    const present = values.filter((value): value is number => value !== null);
    if (present.length === 0) return null;
    return present.reduce((sum, value) => sum + value, 0) / present.length;
  }

  private _iso(timestamp: number): string {
    return new Date(timestamp).toISOString();
  }

  private _isoNullable(timestamp: number | null): string | null {
    return timestamp === null ? null : this._iso(timestamp);
  }

  private _provenance(source: OperatorProvenance['source'], sourceLabel: string | null): OperatorProvenance {
    return { source, asOf: Date.now(), sourceLabel };
  }

  private _tableExists(tableName: string): boolean {
    try {
      const row = this._db.prepare(
        'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
      ).get('table', tableName) as { name: string } | undefined;
      return row !== undefined;
    } catch {
      return false;
    }
  }
}
