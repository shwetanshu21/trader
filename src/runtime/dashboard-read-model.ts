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
import type { MarketClock } from './market-clock.js';
import type { UniverseService } from '../universe/universe-service.js';

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

  constructor(options: DashboardReadModelOptions) {
    this._healthService = options.healthService;
    this._runtimeStateRepo = options.runtimeStateRepo;
    this._zerodhaRepo = options.zerodhaRepo;
    this._proposalRepo = options.proposalRepo;
    this._blockedOrderRepo = options.blockedOrderRepo;
    this._strategyDecisionRepo = options.strategyDecisionRepo;
    this._clock = options.clock;
    this._universeService = options.universeService;
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
      return decisions.map(d => {
        const reasons = this._strategyDecisionRepo!.getReasonsForDecision(d.id);
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
        };
      });
    } catch {
      return [];
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
}
