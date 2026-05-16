// ── DashboardReadModel — typed operator snapshot assembler ──
// Joins live HealthService state with persisted runtime, broker, proposal,
// and blocked-order evidence into a single bounded, token-safe snapshot
// that operators (and future UI routes) can inspect without log scraping.
//
// Bounded lists: recent proposals (max 20), blocked orders (max 20),
// lifecycle events (max 10). All timestamps converted to ISO-8601 strings.

import type {
  DashboardSnapshot,
  DashboardMarketProfile,
  DashboardHealth,
  DashboardRuntime,
  DashboardBroker,
  DashboardUniverse,
  DashboardRecentProposal,
  DashboardBlockedOrder,
  DashboardLifecycleEvent,
  DashboardStrategyDecision,
  DashboardHybridEvidence,
  HybridScoreSummaryWithComponents,
  DashboardPaperOrder,
  DashboardPaperFill,
  DashboardPaperPosition,
  DashboardPositionEvent,
  ProposalAttemptWithReasons,
  BlockedOrderRow,
  LifecycleEvent,
} from '../types/runtime.js';
import type { HealthService } from './health-service.js';
import type { RuntimeStateRepository } from '../persistence/runtime-state-repo.js';
import type { ZerodhaRepository } from '../persistence/broker-repo.js';
import type { ProposalRepository } from '../persistence/proposal-repo.js';
import type { BlockedOrderRepository } from '../persistence/blocked-order-repo.js';
import type { StrategyDecisionRepository } from '../persistence/strategy-decision-repo.js';
import type { ExecutionAttemptRepository } from '../persistence/execution-attempt-repo.js';
import type { MarketClock } from './market-clock.js';
import type { UniverseService } from '../universe/universe-service.js';
import type { StrategyLifecycleRepository } from '../persistence/strategy-lifecycle-repo.js';
import { ExecutionMode, StrategyDecisionStatus, type ExecutionHealth, type DashboardRiskState, type DashboardRiskEvent, type DashboardLifecycleGovernance, type DashboardGovernanceDecision } from '../types/runtime.js';
import type { PaperOrderRepository } from '../persistence/paper-order-repo.js';
import type { PaperFillRepository } from '../persistence/paper-fill-repo.js';
import type { PaperPositionRepository } from '../persistence/paper-position-repo.js';
import type { ExecutionRiskRepository } from '../persistence/execution-risk-repo.js';
import type { HybridScoreRepository } from '../persistence/hybrid-score-repo.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_RECENT_PROPOSALS = 20;
const MAX_RECENT_BLOCKED_ORDERS = 20;
const MAX_RECENT_LIFECYCLE_EVENTS = 10;
const MAX_RECENT_STRATEGY_DECISIONS = 20;

// ---------------------------------------------------------------------------
// DashboardReadModel
// ---------------------------------------------------------------------------

export interface DashboardReadModelOptions {
  healthService: HealthService;
  runtimeStateRepo: RuntimeStateRepository;
  zerodhaRepo: ZerodhaRepository;
  proposalRepo: ProposalRepository | null;
  blockedOrderRepo: BlockedOrderRepository | null;
  strategyDecisionRepo: StrategyDecisionRepository | null;
  clock: MarketClock;
  universeService: UniverseService;
  attemptRepo: ExecutionAttemptRepository | null;
  executionMode: ExecutionMode;
  /** Optional — paper trading repositories for execution evidence enrichment. */
  paperOrderRepo?: PaperOrderRepository | null;
  /** Optional — paper trading repositories for execution evidence enrichment. */
  paperFillRepo?: PaperFillRepository | null;
  /** Optional — paper trading repositories for execution evidence enrichment. */
  paperPositionRepo?: PaperPositionRepository | null;
  /** Optional — execution risk repository for halt state and risk events. */
  riskRepo?: ExecutionRiskRepository | null;
  /** Optional — hybrid score repository for strategy decision hybrid evidence. */
  hybridScoreRepo?: HybridScoreRepository | null;
  /** Optional — strategy lifecycle repository for governance evidence. */
  strategyLifecycleRepo?: StrategyLifecycleRepository | null;
}

export class DashboardReadModel {
  private readonly _healthService: HealthService;
  private readonly _runtimeStateRepo: RuntimeStateRepository;
  private readonly _zerodhaRepo: ZerodhaRepository;
  private readonly _proposalRepo: ProposalRepository | null;
  private readonly _blockedOrderRepo: BlockedOrderRepository | null;
  private readonly _strategyDecisionRepo: StrategyDecisionRepository | null;
  private readonly _clock: MarketClock;
  private readonly _universeService: UniverseService;
  private readonly _attemptRepo: ExecutionAttemptRepository | null;
  private readonly _executionMode: ExecutionMode;
  private readonly _paperOrderRepo: PaperOrderRepository | null;
  private readonly _paperFillRepo: PaperFillRepository | null;
  private readonly _paperPositionRepo: PaperPositionRepository | null;
  private readonly _riskRepo: ExecutionRiskRepository | null;
  private readonly _hybridScoreRepo: HybridScoreRepository | null;
  private readonly _lifecycleRepo: StrategyLifecycleRepository | null;

  constructor(options: DashboardReadModelOptions) {
    this._healthService = options.healthService;
    this._runtimeStateRepo = options.runtimeStateRepo;
    this._zerodhaRepo = options.zerodhaRepo;
    this._proposalRepo = options.proposalRepo;
    this._blockedOrderRepo = options.blockedOrderRepo;
    this._strategyDecisionRepo = options.strategyDecisionRepo;
    this._clock = options.clock;
    this._universeService = options.universeService;
    this._attemptRepo = options.attemptRepo;
    this._executionMode = options.executionMode;
    this._paperOrderRepo = options.paperOrderRepo ?? null;
    this._paperFillRepo = options.paperFillRepo ?? null;
    this._paperPositionRepo = options.paperPositionRepo ?? null;
    this._riskRepo = options.riskRepo ?? null;
    this._hybridScoreRepo = options.hybridScoreRepo ?? null;
    this._lifecycleRepo = options.strategyLifecycleRepo ?? null;
  }

  /** Assemble a full dashboard snapshot. */
  getSnapshot(): DashboardSnapshot {
    const now = new Date();
    const health = this._healthService.getHealth();
    const scheduler = this._runtimeStateRepo.getSchedulerState();

    return {
      assembledAt: now.toISOString(),
      marketProfile: this._getMarketProfile(now),
      health: this._getDashboardHealth(health),
      runtime: this._getDashboardRuntime(scheduler),
      broker: this._getDashboardBroker(),
      recentProposals: this._getRecentProposals(),
      recentBlockedOrders: this._getRecentBlockedOrders(),
      recentLifecycleEvents: this._getRecentLifecycleEvents(),
      recentStrategyDecisions: this._getRecentStrategyDecisions(),
      universe: this._getDashboardUniverse(),
      execution: this._getExecutionEvidence(),
      lifecycleGovernance: this._getLifecycleGovernance(),
    };
  }

  // ── Private builders ──────────────────────────────────────────────────

  private _getMarketProfile(now: Date): DashboardMarketProfile {
    const profile = this._clock.getProfile();
    return {
      marketId: profile.marketId,
      displayName: profile.displayName,
      timezone: profile.timezone,
      currentPhase: this._clock.getPhase(now),
      isTradingDay: profile.isTradingDay(now),
      settlementCycle: profile.settlementCycle,
    };
  }

  private _getDashboardHealth(health: ReturnType<HealthService['getHealth']>): DashboardHealth {
    return {
      verdict: health.verdict,
      uptimeMs: health.uptimeMs,
      lifecycleState: health.lifecycleState,
      degradedReasons: [...health.degradedReasons],
      checkedAt: health.checkedAt,
    };
  }

  private _getDashboardRuntime(
    scheduler: ReturnType<RuntimeStateRepository['getSchedulerState']>,
  ): DashboardRuntime {
    return {
      schedulerStatus: scheduler.status,
      marketPhase: scheduler.marketPhase,
      lastTickTimestamp: scheduler.lastTickTimestamp,
      startedAt: scheduler.startedAt,
      tickCount: scheduler.tickCount,
      lastError: scheduler.lastError,
    };
  }

  private _getDashboardBroker(): DashboardBroker | null {
    const health = this._healthService.getHealth();
    const broker = health.broker ?? health.zerodha;
    if (!broker) return null;

    return {
      sessionState: broker.session.state,
      instruments: {
        count: broker.instruments.instrumentCount,
        isStale: broker.instruments.isStale,
      },
      stream: {
        state: broker.stream.state,
        isStale: broker.stream.isStale,
        lastQuoteAt: broker.stream.lastQuoteAt,
      },
      recentEventCount: broker.recentEvents.length,
    };
  }

  private _getRecentProposals(): DashboardRecentProposal[] {
    if (!this._proposalRepo) return [];

    try {
      const attempts = this._proposalRepo.getRecentAttemptsWithReasons(MAX_RECENT_PROPOSALS);
      return attempts.map(a => ({
        id: a.id,
        exchange: a.exchange,
        tradingsymbol: a.tradingsymbol,
        side: a.side,
        product: a.product,
        status: a.proposalStatus,
        reasons: a.reasons.map(r => r.reasonMessage),
        createdAt: new Date(a.createdAt).toISOString(),
      }));
    } catch {
      // Repo access failure — return empty list rather than crashing dashboard
      return [];
    }
  }

  private _getRecentBlockedOrders(): DashboardBlockedOrder[] {
    if (!this._blockedOrderRepo) return [];

    try {
      const orders = this._blockedOrderRepo.getRecent(MAX_RECENT_BLOCKED_ORDERS);
      return orders.map(o => ({
        id: o.id,
        proposalAttemptId: o.proposalAttemptId,
        blockedAt: new Date(o.blockedAt).toISOString(),
        blockCode: o.blockCode,
        blockMessage: o.blockMessage,
        exchange: o.exchange,
        tradingsymbol: o.tradingsymbol,
        side: o.side,
      }));
    } catch {
      return [];
    }
  }

  private _getRecentLifecycleEvents(): DashboardLifecycleEvent[] {
    try {
      const events = this._runtimeStateRepo.getLifecycleEvents(MAX_RECENT_LIFECYCLE_EVENTS);
      return events.map(e => ({
        timestamp: new Date(e.timestamp).toISOString(),
        state: e.state,
        reason: e.reason,
      }));
    } catch {
      return [];
    }
  }

  private _getRecentStrategyDecisions(): DashboardStrategyDecision[] {
    if (!this._strategyDecisionRepo) return [];

    try {
      const decisions = this._strategyDecisionRepo.getRecentDecisions(MAX_RECENT_STRATEGY_DECISIONS);

      // Batch load hybrid evidence for all decisions in one pass
      const proposalIds = decisions.map(d => d.proposalAttemptId);
      const hybridMap = this._hybridScoreRepo
        ? this._hybridScoreRepo.getByProposalAttemptIds(proposalIds)
        : new Map<number, HybridScoreSummaryWithComponents>();

      return decisions.map(d => {
        const reasons = this._strategyDecisionRepo!.getReasonsForDecision(d.id);
        const hybrid = hybridMap.get(d.proposalAttemptId) ?? null;
        return {
          id: d.id,
          proposalAttemptId: d.proposalAttemptId,
          decisionStatus: d.decisionStatus,
          strategyId: d.strategyId,
          strategyVersion: d.strategyVersion,
          decidedAt: new Date(d.decidedAt).toISOString(),
          exchange: d.exchange,
          tradingsymbol: d.tradingsymbol,
          side: d.side,
          product: d.product,
          quantity: d.quantity,
          price: d.price,
          triggerPrice: d.triggerPrice,
          orderType: d.orderType,
          notional: d.riskNotional,
          sizingBasis: d.riskSizingBasis,
          exposureTag: d.riskExposureTag,
          lastPrice: d.quoteLastPrice,
          reasons: reasons.map(r => r.reasonMessage),
          hybrid: hybrid ? this._toHybridEvidence(hybrid) : null,
        };
      });
    } catch {
      // Repo access failure — return empty list rather than crashing dashboard
      return [];
    }
  }

  /**
   * Convert a hybrid score summary with components into the operator-facing
   * DashboardHybridEvidence DTO, deriving downgrade metadata.
   */
  private _toHybridEvidence(summary: HybridScoreSummaryWithComponents): DashboardHybridEvidence {
    const DETERMINISTIC_PENALTY_THRESHOLD = 0.05; // 5% gap = downgrade
    const llmScore = summary.llmScore;
    const detScore = summary.deterministicScore;

    // Downgrade when: LLM failed/degraded, OR LLM score is meaningfully lower
    let isDowngraded = false;
    let downgradeContext: string | null = null;

    if (summary.llmStatus === 'error' || summary.llmStatus === 'degraded') {
      isDowngraded = true;
      downgradeContext = `LLM consultation ${summary.llmStatus}${summary.llmRationale ? `: ${summary.llmRationale}` : ''}`;
    } else if (llmScore !== null && detScore !== null && (detScore - llmScore) > DETERMINISTIC_PENALTY_THRESHOLD) {
      isDowngraded = true;
      const gap = ((detScore - llmScore) * 100).toFixed(1);
      downgradeContext = `LLM score (${(llmScore * 100).toFixed(1)}%) is ${gap}% below deterministic score (${(detScore * 100).toFixed(1)}%)`;
    } else if (summary.llmStatus === 'skipped') {
      // Skipped LLM is informational, not a degradation
      downgradeContext = 'LLM consultation skipped (deterministic-only scoring)';
    }

    return {
      deterministicScore: summary.deterministicScore,
      llmScore: summary.llmScore,
      llmStatus: summary.llmStatus,
      llmRationale: summary.llmRationale,
      mergedScore: summary.mergedScore,
      mergePolicy: summary.mergePolicy,
      components: summary.components.map(c => ({
        componentName: c.componentName,
        score: c.score,
        weight: c.weight,
      })),
      isDowngraded,
      downgradeContext,
    };
  }

  /**
   * Return repository-backed strategy evidence aggregates alongside bounded
   * recent decisions. This is the canonical operator-review seam for strategy
   * evidence — totals come from persisted COUNT queries, not from the bounded
   * recent list, so they remain accurate even when the cap is exceeded.
   */
  getStrategyEvidence(): {
    totalDecisions: number;
    approvedCount: number;
    refusedCount: number;
    recentDecisions: DashboardStrategyDecision[];
  } {
    if (!this._strategyDecisionRepo) {
      return { totalDecisions: 0, approvedCount: 0, refusedCount: 0, recentDecisions: [] };
    }

    try {
      const totalDecisions = this._strategyDecisionRepo.countDecisions();
      const approvedCount = this._strategyDecisionRepo.countByStatus(StrategyDecisionStatus.Approved);
      const refusedCount = this._strategyDecisionRepo.countByStatus(StrategyDecisionStatus.Refused);
      const recentDecisions = this._getRecentStrategyDecisions();
      return { totalDecisions, approvedCount, refusedCount, recentDecisions };
    } catch {
      return { totalDecisions: 0, approvedCount: 0, refusedCount: 0, recentDecisions: [] };
    }
  }

  private _getDashboardUniverse(): DashboardUniverse | null {
    try {
      const summary = this._universeService.getCoverageSummary();
      if (!summary) return null;
      return {
        policyVersion: summary.policyVersion,
        computedAt: summary.computedAt ? new Date(summary.computedAt).toISOString() : null,
        verdict: summary.verdict,
        eligibleCount: summary.eligibleCount,
        freshQuoteCount: summary.freshQuoteCount,
        staleQuoteCount: summary.staleQuoteCount,
        missingQuoteCount: summary.missingQuoteCount,
        thresholdLabel: summary.thresholdLabel,
      };
    } catch {
      return null;
    }
  }

  private _getExecutionEvidence(): ExecutionHealth | null {
    if (!this._attemptRepo || !this._strategyDecisionRepo) return null;

    const MAX_RECENT_PAPER_ITEMS = 10;

    try {
      const totalAttempts = this._attemptRepo.count();
      const recent = this._attemptRepo.getRecent(5);
      const isGateRefusing = this._executionMode === ExecutionMode.Blocked;

      // ── Paper order/fill/position evidence ────────────────────────────
      let totalOrders = 0;
      let totalFills = 0;
      let openPositionCount = 0;
      let recentPaperOrders: DashboardPaperOrder[] = [];
      let recentPaperFills: DashboardPaperFill[] = [];
      let currentPositions: DashboardPaperPosition[] = [];
      let recentPositionEvents: DashboardPositionEvent[] = [];

      if (this._paperOrderRepo) {
        totalOrders = this._paperOrderRepo.count();
        recentPaperOrders = this._paperOrderRepo.getRecent(MAX_RECENT_PAPER_ITEMS).map(o => ({
          id: o.id,
          createdAt: new Date(o.createdAt).toISOString(),
          exchange: o.exchange,
          tradingsymbol: o.tradingsymbol,
          side: o.side,
          product: o.product,
          quantity: o.quantity,
          price: o.price,
          orderType: o.orderType,
          status: o.status,
          brokerOrderId: o.brokerOrderId,
        }));
      }

      if (this._paperFillRepo) {
        totalFills = this._paperFillRepo.count();
        recentPaperFills = this._paperFillRepo.getRecent(MAX_RECENT_PAPER_ITEMS).map(f => ({
          id: f.id,
          filledAt: new Date(f.filledAt).toISOString(),
          paperOrderId: f.paperOrderId,
          exchange: f.exchange,
          tradingsymbol: f.tradingsymbol,
          side: f.side,
          filledQuantity: f.filledQuantity,
          filledPrice: f.filledPrice,
          brokerOrderId: f.brokerOrderId,
        }));
      }

      if (this._paperPositionRepo) {
        openPositionCount = this._paperPositionRepo.countOpenPositions();
        currentPositions = this._paperPositionRepo.getAllPositions().map(p => ({
          exchange: p.exchange,
          tradingsymbol: p.tradingsymbol,
          product: p.product,
          side: p.side,
          quantity: p.quantity,
          avgCostPrice: p.avgCostPrice,
          realizedPnl: p.realizedPnl,
          updatedAt: new Date(p.updatedAt).toISOString(),
        }));
        recentPositionEvents = this._paperPositionRepo.getRecentEvents(MAX_RECENT_PAPER_ITEMS).map(e => ({
          id: e.id,
          createdAt: new Date(e.createdAt).toISOString(),
          eventType: e.eventType,
          exchange: e.exchange,
          tradingsymbol: e.tradingsymbol,
          product: e.product,
          quantityDelta: e.quantityDelta,
          price: e.price,
          newQuantity: e.newQuantity,
          realizedPnl: e.realizedPnl,
        }));
      }

      return {
        mode: this._executionMode,
        totalAttempts,
        recentAttempts: recent.map(a => {
          const decision = this._strategyDecisionRepo!.getDecisionById(a.strategyDecisionId);
          const reasons = this._attemptRepo!.getRefusalReasons(a.id);
          return {
            id: a.id,
            strategyDecisionId: a.strategyDecisionId,
            executionMode: a.executionMode,
            status: a.status,
            outcomeCode: a.outcomeCode,
            brokerOrderId: a.brokerOrderId,
            message: a.message,
            attemptedAt: new Date(a.attemptedAt).toISOString(),
            completedAt: a.completedAt ? new Date(a.completedAt).toISOString() : null,
            tradingsymbol: decision?.tradingsymbol ?? 'unknown',
            exchange: decision?.exchange ?? 'unknown',
            refusalReasons: reasons.map(r => r.reasonMessage),
          };
        }),
        isGateRefusing,
        gateRefusalReason: isGateRefusing
          ? 'Execution mode is blocked: all attempts refused'
          : null,
        openPositionCount,
        totalOrders,
        totalFills,
        recentPaperOrders,
        recentPaperFills,
        currentPositions,
        recentPositionEvents,
        riskState: this._getRiskState(),
        recentRiskEvents: this._getRecentRiskEvents(),
      };
    } catch {
      return null;
    }
  }

  private _getRiskState(): DashboardRiskState | null {
    if (!this._riskRepo) return null;
    try {
      const state = this._riskRepo.getCurrentState();
      return {
        haltState: state.haltState,
        haltSource: state.haltSource,
        haltReason: state.haltReason,
        haltedAt: state.haltedAt ? new Date(state.haltedAt).toISOString() : null,
        isRefusing: state.haltState === 'active_halt',
        latchCount: state.latchCount,
        openPositionCountAtHalt: state.openPositionCountAtHalt,
        dailyPnlAtHalt: state.dailyPnlAtHalt,
      };
    } catch {
      return null;
    }
  }

  private _getRecentRiskEvents(): DashboardRiskEvent[] {
    if (!this._riskRepo) return [];
    try {
      return this._riskRepo.getRecentEvents(10).map(e => ({
        id: e.id,
        recordedAt: new Date(e.recordedAt).toISOString(),
        eventType: e.eventType,
        source: e.source,
        severity: e.severity,
        message: e.message,
      }));
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle governance
  // -----------------------------------------------------------------------

  /**
   * Assemble lifecycle governance evidence block.
   *
   * Returns null when no lifecycle repo is wired (graceful degradation).
   * Totals come from repository COUNT queries, not from bounded lists.
   */
  private _getLifecycleGovernance(): DashboardLifecycleGovernance | null {
    if (!this._lifecycleRepo) return null;

    try {
      const totalStates = this._lifecycleRepo.countStates();
      const totalDecisions = this._lifecycleRepo.decisionCount();
      const currentStates = this._lifecycleRepo.getAllCurrentStates();
      const recentDecisions = this._lifecycleRepo.getAllDecisions(20);

      return {
        totalStates,
        totalDecisions,
        currentStates: currentStates.map(s => ({
          strategyId: s.strategyId,
          strategyVersion: s.strategyVersion,
          marketId: s.marketId,
          phase: s.phase,
          updatedAt: new Date(s.updatedAt).toISOString(),
        })),
        recentDecisions: recentDecisions.map(d => ({
          id: d.id,
          strategyId: d.strategyId,
          strategyVersion: d.strategyVersion,
          marketId: d.marketId,
          verdict: d.verdict,
          previousPhase: d.previousPhase,
          newPhase: d.newPhase,
          rationale: d.rationale,
          recordedAt: new Date(d.recordedAt).toISOString(),
        })),
      };
    } catch {
      // Repo access failure — return null rather than crashing dashboard
      return null;
    }
  }
}
