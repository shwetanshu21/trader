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
import { ZerodhaRepository } from '../persistence/zerodha-repo.js';
import { ProposalRepository } from '../persistence/proposal-repo.js';
import { BlockedOrderRepository } from '../persistence/blocked-order-repo.js';
import { LifecycleManager } from './lifecycle.js';
import { HealthService } from './health-service.js';
import { MarketClock } from './market-clock.js';
import { Scheduler } from './scheduler.js';
import { Telemetry } from './telemetry.js';
import { createHealthServer } from './health-server.js';
import { DashboardReadModel } from './dashboard-read-model.js';
import { SessionService } from '../integrations/zerodha/session-service.js';
import { InstrumentsService } from '../integrations/zerodha/instruments-service.js';
import { MarketDataStream } from '../integrations/zerodha/market-data-stream.js';
import { ZerodhaSupervisor } from '../integrations/zerodha/zerodha-supervisor.js';
import { ProposalEngine } from '../proposals/proposal-engine.js';
import { IndiaProposalValidator } from '../proposals/india-validator.js';
import { ProposalSupervisor } from '../proposals/proposal-supervisor.js';
import { ExecutionGateSupervisor } from '../execution/execution-gate-supervisor.js';
import { INDIA_NSE_EQ_MARKET } from '../market/india-profile.js';
import type { RuntimeConfig } from '../types/runtime.js';

// ---------------------------------------------------------------------------
// RuntimeAppHandles — typed references to all composed subsystems
// ---------------------------------------------------------------------------

export interface RuntimeAppHandles {
  dbManager: DatabaseManager;
  runtimeStateRepo: RuntimeStateRepository;
  zerodhaRepo: ZerodhaRepository;
  proposalRepo: ProposalRepository | null;
  blockedOrderRepo: BlockedOrderRepository | null;
  lifecycle: LifecycleManager;
  healthService: HealthService;
  telemetry: Telemetry;
  scheduler: Scheduler;
  server: http.Server;
  clock: MarketClock;
  zerodhaSupervisor: ZerodhaSupervisor | null;
  proposalSupervisor: ProposalSupervisor | null;
  executionGateSupervisor: ExecutionGateSupervisor | null;
  dashboard: DashboardReadModel;
}

// ---------------------------------------------------------------------------
// Bootstrap logging helper
// ---------------------------------------------------------------------------

function logBoot(message: string): void {
  console.log(`[boot] ${message}`);
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
    const zerodhaRepo = new ZerodhaRepository(dbManager.db);
    const lifecycle = new LifecycleManager(runtimeStateRepo);

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

    // ── Phase 4: initialise Zerodha services ──────────────────────────────
    let zerodhaSupervisor: ZerodhaSupervisor | null = null;
    let sessionService: SessionService | null = null;
    let instrumentsService: InstrumentsService | null = null;
    let marketDataStream: MarketDataStream | null = null;

    if (this.config.zerodha) {
      logBoot(`Zerodha integration: configured (user=${this.config.zerodha.userId})`);

      sessionService = new SessionService(this.config.zerodha, zerodhaRepo);
      instrumentsService = new InstrumentsService(zerodhaRepo);
      marketDataStream = new MarketDataStream(zerodhaRepo);

      zerodhaSupervisor = new ZerodhaSupervisor(
        sessionService,
        instrumentsService,
        zerodhaRepo,
        marketDataStream,
      );

      healthService.setZerodhaSupervisor(zerodhaSupervisor);
      logBoot('Zerodha services initialised');
    } else {
      logBoot('Zerodha integration: not configured (degraded broker mode)');
    }

    // ── Phase 5: initialise Proposal subsystem ────────────────────────────
    let proposalRepo: ProposalRepository | null = null;
    let blockedOrderRepo: BlockedOrderRepository | null = null;
    let proposalSupervisor: ProposalSupervisor | null = null;
    let executionGateSupervisor: ExecutionGateSupervisor | null = null;

    if (this.config.proposalEngine) {
      logBoot('Proposal engine: configured');

      proposalRepo = new ProposalRepository(dbManager.db);
      blockedOrderRepo = new BlockedOrderRepository(dbManager.db);
      const engine = new ProposalEngine(this.config.proposalEngine);
      const validator = new IndiaProposalValidator();

      proposalSupervisor = new ProposalSupervisor({
        engine,
        validator,
        repo: proposalRepo,
        session: sessionService,
        instruments: instrumentsService,
        stream: marketDataStream,
        clock,
        maxProposals: this.config.proposalEngine.maxProposalsPerTick,
      });

      executionGateSupervisor = new ExecutionGateSupervisor({ blockedRepo: blockedOrderRepo });

      logBoot('Proposal supervisor initialised');
      logBoot('Execution gate supervisor initialised');
    } else {
      logBoot('Proposal engine: not configured (proposal generation disabled)');
    }

    // ── Phase 6: build scheduler ─────────────────────────────────────────
    const tickWork = [
      ...(zerodhaSupervisor ? [zerodhaSupervisor] : []),
      ...(proposalSupervisor ? [proposalSupervisor] : []),
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

    // ── Phase 7: create dashboard read-model ──────────────────────────────
    const dashboard = new DashboardReadModel({
      healthService,
      runtimeStateRepo,
      zerodhaRepo,
      proposalRepo,
      blockedOrderRepo,
      clock,
    });

    // ── Phase 8: create health HTTP server with dashboard routes ───────────
    const server = createHealthServer(healthService, scheduler, telemetry, dbManager, dashboard);

    // Build handles
    this._handles = {
      dbManager,
      runtimeStateRepo,
      zerodhaRepo,
      proposalRepo,
      blockedOrderRepo,
      lifecycle,
      healthService,
      telemetry,
      scheduler,
      server,
      clock,
      zerodhaSupervisor,
      proposalSupervisor,
      executionGateSupervisor,
      dashboard,
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
    h.server.listen(this.config.port, () => {
      logBoot(`health HTTP server listening on port ${this.config.port}`);
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
