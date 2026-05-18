// ── RuntimeApp — reusable runtime harness ──
// Extracts one-shot boot composition from src/main.ts into a class that
// tests, witness scripts, and the real entrypoint can use to build, start,
// and stop the real composed runtime. Returns typed handles for all
// subsystems so consumers can inspect health, request snapshots, or
// wire custom shutdown logic.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { DatabaseManager } from '../persistence/sqlite.js';
import { RuntimeStateRepository } from '../persistence/runtime-state-repo.js';
import { BrokerRepository } from '../persistence/broker-repo.js';
import { UniverseRepository } from '../persistence/universe-repo.js';
import { ProposalRepository } from '../persistence/proposal-repo.js';
import { StrategyDecisionRepository } from '../persistence/strategy-decision-repo.js';
import { StrategyRunRepository } from '../persistence/strategy-run-repo.js';
import { ExecutionAttemptRepository } from '../persistence/execution-attempt-repo.js';
import { BlockedOrderRepository } from '../persistence/blocked-order-repo.js';
import { StrategyLifecycleRepository } from '../persistence/strategy-lifecycle-repo.js';
import { LifecycleManager } from './lifecycle.js';
import { HealthService } from './health-service.js';
import { MarketClock } from './market-clock.js';
import { Scheduler } from './scheduler.js';
import { Telemetry } from './telemetry.js';
import { createHealthServer } from './health-server.js';
import { DashboardReadModel } from './dashboard-read-model.js';
import { SessionService } from '../integrations/broker/session-service.js';
import { InstrumentsService } from '../integrations/broker/instruments-service.js';
import { MarketDataStream } from '../integrations/broker/market-data-stream.js';
import { BrokerSupervisor } from '../integrations/broker/broker-supervisor.js';
import { KiteMcpClient } from '../integrations/broker/mcp/kite-mcp-client.js';
import { KiteMcpQuoteStream } from '../integrations/broker/mcp/kite-mcp-quote-stream.js';
import { ProposalEngine } from '../proposals/proposal-engine.js';
import { IndiaProposalValidator } from '../proposals/india-validator.js';
import { ProposalSupervisor } from '../proposals/proposal-supervisor.js';
import { ExecutionGateSupervisor } from '../execution/execution-gate-supervisor.js';
import { ModeAwareExecutionService } from '../execution/mode-aware-execution-service.js';
import { PaperExecutionPolicy } from '../execution/paper-execution-policy.js';
import { PaperExecutionLedger } from '../execution/paper-execution-ledger.js';
import { ExecutionRiskGuard } from '../execution/execution-risk-guard.js';
import { ExecutionRiskRepository } from '../persistence/execution-risk-repo.js';
import { PaperOrderRepository } from '../persistence/paper-order-repo.js';
import { PaperFillRepository } from '../persistence/paper-fill-repo.js';
import { PaperPositionRepository } from '../persistence/paper-position-repo.js';
import { BlockedExecutionAdapter, LiveExecutionAdapter } from '../execution/execution-adapters.js';
import { HybridScoreRepository } from '../persistence/hybrid-score-repo.js';
import {
  StrategyRiskSupervisor,
  type StrategyRiskPort,
  type StrategyEvaluationInput,
  type StrategyEvaluationResult,
} from '../strategy-risk/strategy-risk-supervisor.js';
import { createStrategyCoordinator } from '../strategy/coordinator-factory.js';
import { UniverseService } from '../universe/universe-service.js';
import { UniverseSupervisor } from '../universe/universe-supervisor.js';
import { INDIA_NSE_EQ_MARKET } from '../market/india-profile.js';
import { ExecutionMode, SchedulerStatus, type RuntimeConfig } from '../types/runtime.js';

// ---------------------------------------------------------------------------
// RuntimeAppHandles — typed references to all composed subsystems
// ---------------------------------------------------------------------------

export interface RuntimeAppHandles {
  dbManager: DatabaseManager;
  runtimeStateRepo: RuntimeStateRepository;
  brokerRepo: BrokerRepository;
  zerodhaRepo: BrokerRepository;
  universeRepo: UniverseRepository;
  universeService: UniverseService;
  universeSupervisor: UniverseSupervisor;
  proposalRepo: ProposalRepository | null;
  blockedOrderRepo: BlockedOrderRepository | null;
  strategyDecisionRepo: StrategyDecisionRepository | null;
  hybridScoreRepo: HybridScoreRepository | null;
  strategyRunRepo: StrategyRunRepository | null;
  executionAttemptRepo: ExecutionAttemptRepository | null;
  executionService: ModeAwareExecutionService | null;
  lifecycle: LifecycleManager;
  healthService: HealthService;
  telemetry: Telemetry;
  scheduler: Scheduler;
  server: http.Server;
  clock: MarketClock;
  brokerSupervisor: BrokerSupervisor | null;
  zerodhaSupervisor: BrokerSupervisor | null;
  /** Repo-backed instrument catalog service, available even in degraded broker mode. */
  instrumentsService: InstrumentsService | null;
  /** Repo-backed quote stream facade, available even in degraded broker mode. */
  marketDataStream: import('../integrations/broker/ports.js').QuoteStreamPort | null;
  proposalSupervisor: ProposalSupervisor | null;
  executionGateSupervisor: ExecutionGateSupervisor | null;
  strategyRiskSupervisor: StrategyRiskSupervisor | null;
  dashboard: DashboardReadModel;
  /** Paper order repository (available when proposal engine is configured). */
  orderRepo: PaperOrderRepository | null;
  /** Paper fill repository (available when proposal engine is configured). */
  fillRepo: PaperFillRepository | null;
  /** Paper position repository (available when proposal engine is configured). */
  positionRepo: PaperPositionRepository | null;
  /** Execution risk repository (available when proposal engine is configured). */
  riskRepo: ExecutionRiskRepository | null;
  /** Strategy lifecycle repository (available when proposal engine is configured). */
  lifecycleRepo: StrategyLifecycleRepository | null;
}

// ---------------------------------------------------------------------------
// Bootstrap logging helper
// ---------------------------------------------------------------------------

function logBoot(message: string): void {
  console.log(`[boot] ${message}`);
}

// ---------------------------------------------------------------------------
// LazyStrategyRiskPort — deferred initialization of the risk service
// The StrategyRiskService is created by sibling task T02 and may not exist
// at build() time. This wrapper lazily imports and instantiates it on the
// first evaluateProposal() call, allowing the sync build() to complete.
// ---------------------------------------------------------------------------

class LazyStrategyRiskPort implements StrategyRiskPort {
  private _service: StrategyRiskPort | null = null;

  constructor(
    private readonly _strategyRepo: StrategyDecisionRepository,
    private readonly _brokerRepo: BrokerRepository,
    private readonly _universeService: UniverseService,
    private readonly _strategyRunRepo: StrategyRunRepository | null,
  ) {}

  async evaluateProposal(input: StrategyEvaluationInput): Promise<StrategyEvaluationResult> {
    if (!this._service) {
      try {
        const { StrategyRiskService } = await import(
          '../strategy-risk/strategy-risk-service.js'
        );
        this._service = new StrategyRiskService({
          strategyRepo: this._strategyRepo,
          brokerRepo: this._brokerRepo,
          universeService: this._universeService,
          strategyRunRepo: this._strategyRunRepo ?? undefined,
        });
      } catch {
        throw new Error(
          'StrategyRiskService not available (T02 not yet complete)',
        );
      }
    }
    return this._service.evaluateProposal(input);
  }
}

// ---------------------------------------------------------------------------
// RuntimeApp
// ---------------------------------------------------------------------------

export class RuntimeApp {
  private _handles: RuntimeAppHandles | null = null;
  private _shutdownHooks: Array<() => void> = [];

  constructor(private readonly config: RuntimeConfig) {}

  /** Build all subsystems without starting the scheduler or server. */
  build(): RuntimeAppHandles {
    if (this._handles) return this._handles;

    // ── Phase 1: ensure data directory exists ──────────────────────────────
    const dbDir = path.dirname(this.config.dbPath);
    if (dbDir && dbDir !== '.') {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // ── Phase 2: initialise persistence and lifecycle ─────────────────────
    const dbManager = new DatabaseManager(this.config.dbPath);
    const runtimeStateRepo = new RuntimeStateRepository(dbManager.db);
    const brokerRepo = new BrokerRepository(dbManager.db);
    const lifecycle = new LifecycleManager(runtimeStateRepo);

    const persistedScheduler = runtimeStateRepo.getSchedulerState();
    if (persistedScheduler.status === SchedulerStatus.Stopped) {
      runtimeStateRepo.upsertSchedulerState({
        status: SchedulerStatus.Idle,
        marketPhase: persistedScheduler.marketPhase,
        lastTickTimestamp: null,
        startedAt: null,
        tickCount: 0,
        lastError: null,
      });
    }

    const healthService = new HealthService(lifecycle, runtimeStateRepo, Date.now());
    const telemetry = new Telemetry(runtimeStateRepo);

    // Transition to Running
    const bootEvent = lifecycle.start('Runtime boot completed');
    logBoot(`lifecycle → ${bootEvent.state} (${bootEvent.reason})`);

    // Record initial health check
    const initialHealth = healthService.recordHealthCheck();
    logBoot(`initial health: ${initialHealth.verdict} (uptime ${initialHealth.uptimeMs}ms)`);

    // ── Phase 3: market clock ─────────────────────────────────────────────
    const clock = new MarketClock(INDIA_NSE_EQ_MARKET);

    // ── Phase 4: initialise broker services ───────────────────────────────
    let brokerSupervisor: BrokerSupervisor | null = null;
    let sessionService: SessionService | null = null;
    // Keep repo-backed catalog/quote services available even without a live
    // broker transport so local proofs and integration tests can exercise the
    // canonical runtime proposal path against seeded brokerRepo state.
    let instrumentsService: InstrumentsService | null = new InstrumentsService(brokerRepo);
    let marketDataStream: import('../integrations/broker/ports.js').QuoteStreamPort | null = new MarketDataStream(brokerRepo);

    let brokerConfig = this.config.broker ?? this.config.zerodha;

    if (brokerConfig) {
      const transport = brokerConfig.transport ?? 'direct';
      const transportLabel = transport === 'mcp'
        ? `configured (upstox-mcp=${brokerConfig.mcpUrl ?? 'http://localhost:8787/mcp'})`
        : `configured (user=${brokerConfig.userId ?? 'unknown'})`;
      logBoot(`Broker integration: ${transportLabel}`);

      sessionService = new SessionService(brokerConfig, brokerRepo);
      instrumentsService = new InstrumentsService(brokerRepo);

      if (transport === 'mcp') {
        const mcpClient = new KiteMcpClient(brokerConfig);
        marketDataStream = new KiteMcpQuoteStream(
          brokerRepo,
          mcpClient,
          brokerConfig.quotePollIntervalMs,
        );

        brokerSupervisor = new BrokerSupervisor(
          sessionService,
          instrumentsService,
          brokerRepo,
          marketDataStream,
          mcpClient,
        );
      } else {
        marketDataStream = new MarketDataStream(brokerRepo);
        brokerSupervisor = new BrokerSupervisor(
          sessionService,
          instrumentsService,
          brokerRepo,
          marketDataStream,
        );
      }

      healthService.setBrokerSupervisor(brokerSupervisor);
      logBoot('Broker services initialised');
    } else {
      logBoot('Broker integration: not configured (degraded broker mode)');
    }

    // ── Phase 4b: execution services (standalone DB wrapper) ────────────
    const executionAttemptRepo = new ExecutionAttemptRepository(dbManager.db);

    // ── Phase 5: initialise Universe subsystem ────────────────────────────
    const universeRepo = new UniverseRepository(dbManager.db);
    const universeService = new UniverseService(brokerRepo, universeRepo);
    const universeSupervisor = new UniverseSupervisor(universeService);
    logBoot('Universe services initialised');

    // ── Phase 6: initialise Proposal subsystem ────────────────────────────
    let proposalRepo: ProposalRepository | null = null;
    let blockedOrderRepo: BlockedOrderRepository | null = null;
    let proposalSupervisor: ProposalSupervisor | null = null;
    let executionGateSupervisor: ExecutionGateSupervisor | null = null;
    let strategyRiskSupervisor: StrategyRiskSupervisor | null = null;
    let strategyDecisionRepo: StrategyDecisionRepository | null = null;
    let hybridScoreRepo: HybridScoreRepository | null = null;
    let strategyRunRepo: StrategyRunRepository | null = null;
    let executionService: ModeAwareExecutionService | null = null;
    let riskRepo: ExecutionRiskRepository | null = null;
    let riskGuard: ExecutionRiskGuard | null = null;
    let lifecycleRepo: StrategyLifecycleRepository | null = null;
    // Paper trading repos (available when proposal engine is configured)
    let orderRepo: PaperOrderRepository | null = null;
    let fillRepo: PaperFillRepository | null = null;
    let positionRepo: PaperPositionRepository | null = null;

    if (this.config.proposalEngine) {
      logBoot('Proposal engine: configured');

      proposalRepo = new ProposalRepository(dbManager.db);
      blockedOrderRepo = new BlockedOrderRepository(dbManager.db);
      strategyDecisionRepo = new StrategyDecisionRepository(dbManager.db);
      hybridScoreRepo = new HybridScoreRepository(dbManager.db);
      strategyRunRepo = new StrategyRunRepository(dbManager.db);
      const engine = new ProposalEngine(this.config.proposalEngine);
      const validator = new IndiaProposalValidator();

      // Construct the strategy coordinator via the shared factory seam.
      // The factory always includes the deterministic screener plugin
      // for truthful fallback behavior, and optionally adds the LLM
      // ranking plugin when a proposal engine is provided.
      const strategyCfg = this.config.strategy ?? { maxCandidates: 5, parallelPlugins: true };
      const strategyCoordinator = createStrategyCoordinator({
        proposalEngine: engine,
        maxCandidates: strategyCfg.maxCandidates,
        parallelPlugins: strategyCfg.parallelPlugins,
      });

      proposalSupervisor = new ProposalSupervisor({
        engine,
        validator,
        repo: proposalRepo,
        session: sessionService,
        instruments: instrumentsService,
        stream: marketDataStream,
        clock,
        maxProposals: this.config.proposalEngine.maxProposalsPerTick,
        universeService,
        coordinator: strategyCoordinator,
        hybridScoreRepo,
        strategyRunRepo,
      });

      // Build ModeAwareExecutionService with the configured mode
      // and the paper execution ledger for atomic downstream persistence
      const paperPolicy = new PaperExecutionPolicy();
      orderRepo = new PaperOrderRepository(dbManager.db);
      fillRepo = new PaperFillRepository(dbManager.db);
      positionRepo = new PaperPositionRepository(dbManager.db);
      const paperLedger = new PaperExecutionLedger({
        db: dbManager.db,
        attemptRepo: executionAttemptRepo,
        orderRepo,
        fillRepo,
        positionRepo,
      });
      const liveAdapter = new LiveExecutionAdapter(null);
      const blockedAdapter = new BlockedExecutionAdapter();
      executionService = new ModeAwareExecutionService({
        attemptRepo: executionAttemptRepo,
        paperPolicy,
        paperLedger,
        liveAdapter,
        blockedAdapter,
        mode: this.config.execution.mode,
      });

      // ExecutionRiskGuard — market-hours, kill-switch, duplicate,
      // exposure-cap, and daily-loss checks before execution
      riskRepo = new ExecutionRiskRepository(dbManager.db);
      riskGuard = new ExecutionRiskGuard({
        riskRepo,
        marketClock: clock,
        riskLimits: this.config.execution.riskLimits,
        positionRepo,
        orderRepo,
        brokerRepo,
      });

      // Strategy lifecycle repository for lifecycle gating (M006)
      lifecycleRepo = new StrategyLifecycleRepository(dbManager.db);

      executionGateSupervisor = new ExecutionGateSupervisor({
        strategyDecisionRepo,
        executionService,
        attemptRepo: executionAttemptRepo,
        brokerRepo,
        riskGuard,
        lifecycleRepo,
      });

      // StrategyRiskSupervisor — evaluates accepted proposals via the
      // strategy-risk service (T02). Uses a lazy port wrapper so build()
      // stays synchronous even if the service module doesn't exist yet.
      const riskPort = new LazyStrategyRiskPort(
        strategyDecisionRepo,
        brokerRepo,
        universeService,
        strategyRunRepo,
      );
      strategyRiskSupervisor = new StrategyRiskSupervisor({
        strategyRepo: strategyDecisionRepo,
        brokerRepo,
        riskService: riskPort,
      });

      logBoot('Proposal supervisor initialised');
      logBoot('Strategy risk supervisor initialised');
      logBoot(`Execution gate supervisor initialised (mode: ${this.config.execution.mode})`);
    } else {
      logBoot('Proposal engine: not configured (proposal generation disabled)');
    }

    // ── Phase 7: build scheduler with ordered tick work ────────────────── ──────────────────
    // Order: broker -> universe -> proposal -> strategy-risk -> execution gate
    const tickWork = [
      ...(brokerSupervisor ? [brokerSupervisor] : []),
      universeSupervisor,
      ...(proposalSupervisor ? [proposalSupervisor] : []),
      ...(strategyRiskSupervisor ? [strategyRiskSupervisor] : []),
      ...(executionGateSupervisor ? [executionGateSupervisor] : []),
    ];

    const scheduler = new Scheduler({
      clock,
      lifecycle,
      repo: runtimeStateRepo,
      health: healthService,
      telemetry,
      intervalMs: this.config.schedulerIntervalMs,
      tickWork,
    });

    // ── Phase 8: create dashboard read-model ──────────────────────────────
    const dashboard = new DashboardReadModel({
      healthService,
      runtimeStateRepo,
      zerodhaRepo: brokerRepo,
      proposalRepo,
      blockedOrderRepo,
      strategyDecisionRepo,
      clock,
      universeService,
      attemptRepo: executionAttemptRepo,
      executionMode: this.config.execution.mode,
      paperOrderRepo: orderRepo,
      paperFillRepo: fillRepo,
      paperPositionRepo: positionRepo,
      riskRepo,
      hybridScoreRepo,
      strategyLifecycleRepo: lifecycleRepo,
    });

    // ── Phase 9: create health HTTP server with dashboard routes ───────────
    const server = createHealthServer(healthService, scheduler, telemetry, dbManager, dashboard, this.config.execution.operatorBindHost);

    // Build handles
    this._handles = {
      dbManager,
      runtimeStateRepo,
      brokerRepo,
      zerodhaRepo: brokerRepo,
      universeRepo,
      universeService,
      universeSupervisor,
      proposalRepo,
      blockedOrderRepo,
      strategyDecisionRepo,
      hybridScoreRepo,
      strategyRunRepo,
      executionAttemptRepo,
      executionService,
      lifecycle,
      healthService,
      telemetry,
      scheduler,
      server,
      clock,
      brokerSupervisor,
      zerodhaSupervisor: brokerSupervisor,
      instrumentsService,
      marketDataStream,
      proposalSupervisor,
      executionGateSupervisor,
      strategyRiskSupervisor,
      dashboard,
      orderRepo: orderRepo ?? null,
      fillRepo: fillRepo ?? null,
      positionRepo: positionRepo ?? null,
      riskRepo,
      lifecycleRepo: lifecycleRepo ?? null,
    };

    return this._handles;
  }

  /** Start the scheduler and health server. */
  start(): RuntimeAppHandles {
    const h = this.build();

    // Start scheduler
    h.scheduler.start();
    logBoot(`scheduler started — phase: ${h.scheduler.getState().marketPhase}`);

    // Start health HTTP server
    h.server.listen(this.config.port, this.config.execution.operatorBindHost, () => {
      logBoot(`health HTTP server listening on ${this.config.execution.operatorBindHost}:${this.config.port}`);
    });

    logBoot(`startup complete. Health endpoint: http://localhost:${this.config.port}/health`);

    return h;
  }

  /**
   * Graceful shutdown: stop scheduler, close server, close DB.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  stop(reason = 'Shutdown'): void {
    if (!this._handles) return;

    const h = this._handles;

    // Run shutdown hooks
    for (const hook of this._shutdownHooks) {
      try {
        hook();
      } catch {
        // Best-effort shutdown
      }
    }

    // Stop scheduler
    try {
      h.scheduler.stop(`${reason} received`);
    } catch {
      // Already stopped
    }

    // Close health server
    try {
      h.server.close();
    } catch {
      // Already closed
    }

    // Close DB
    try {
      h.dbManager.close();
    } catch {
      // Already closed
    }

    this._handles = null;
    logBoot('shutdown complete');
  }

  /** Register a shutdown hook that runs before scheduler/server/DB close. */
  onShutdown(hook: () => void): void {
    this._shutdownHooks.push(hook);
  }

  /** Access the handles (throws if not yet built). */
  get handles(): RuntimeAppHandles {
    if (!this._handles) {
      throw new Error('RuntimeApp not yet built. Call build() or start() first.');
    }
    return this._handles;
  }
}

/** Build and start a RuntimeApp from a config object. */
export function createRuntimeApp(config: RuntimeConfig): RuntimeApp {
  const app = new RuntimeApp(config);
  app.start();
  return app;
}
