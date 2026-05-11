import { loadConfigFromEnv } from './config/env.js';
import { DatabaseManager } from './persistence/sqlite.js';
import { RuntimeStateRepository } from './persistence/runtime-state-repo.js';
import { ZerodhaRepository } from './persistence/zerodha-repo.js';
import { ProposalRepository } from './persistence/proposal-repo.js';
import { LifecycleManager } from './runtime/lifecycle.js';
import { HealthService } from './runtime/health-service.js';
import { MarketClock } from './runtime/market-clock.js';
import { Scheduler } from './runtime/scheduler.js';
import { Telemetry } from './runtime/telemetry.js';
import { INDIA_NSE_EQ_MARKET } from './market/india-profile.js';
import { createHealthServer } from './runtime/health-server.js';
import { SessionService } from './integrations/zerodha/session-service.js';
import { InstrumentsService } from './integrations/zerodha/instruments-service.js';
import { MarketDataStream } from './integrations/zerodha/market-data-stream.js';
import { ZerodhaSupervisor } from './integrations/zerodha/zerodha-supervisor.js';
import { ProposalEngine } from './proposals/proposal-engine.js';
import { IndiaProposalValidator } from './proposals/india-validator.js';
import { ProposalSupervisor } from './proposals/proposal-supervisor.js';
import { BlockedOrderRepository } from './persistence/blocked-order-repo.js';
import { ExecutionGateSupervisor } from './execution/execution-gate-supervisor.js';
import fs from 'node:fs';
import path from 'node:path';

/** Boot the runtime: load config, initialise subsystems, and start scheduler + health server. */
async function main(): Promise<void> {
  // ── Phase 1: load validated configuration ───────────────────────────────
  const config = loadConfigFromEnv();

  console.log(`[boot] trader v0.1.0 starting`);
  console.log(`[boot] environment : ${config.nodeEnv}`);
  console.log(`[boot] market tz    : ${config.marketTimezone}`);
  console.log(`[boot] health port  : ${config.port}`);
  console.log(`[boot] interval     : ${config.schedulerIntervalMs}ms`);
  console.log(`[boot] db path      : ${config.dbPath}`);
  console.log(`[boot] log level    : ${config.logLevel}`);

  // ── Phase 2: ensure data directory exists ───────────────────────────────
  const dbDir = path.dirname(config.dbPath);
  if (dbDir && dbDir !== '.') {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`[boot] data directory: ${dbDir}`);
  }

  // ── Phase 3: initialise persistence and lifecycle ──────────────────────
  const dbManager = new DatabaseManager(config.dbPath);
  const repo = new RuntimeStateRepository(dbManager.db);
  const zerodhaRepo = new ZerodhaRepository(dbManager.db);
  const lifecycle = new LifecycleManager(repo);
  const healthService = new HealthService(lifecycle, repo, Date.now());
  const telemetry = new Telemetry(repo);

  // Transition to Running
  const bootEvent = lifecycle.start('Runtime boot completed');
  console.log(`[boot] lifecycle → ${bootEvent.state} (${bootEvent.reason})`);

  // Record initial health check
  const initialHealth = healthService.recordHealthCheck();
  console.log(`[boot] initial health: ${initialHealth.verdict} (uptime ${initialHealth.uptimeMs}ms)`);

  // ── Phase 4: initialise Zerodha services ────────────────────────────────
  let zerodhaSupervisor: ZerodhaSupervisor | null = null;
  let sessionService: SessionService | null = null;
  let instrumentsService: InstrumentsService | null = null;
  let marketDataStream: MarketDataStream | null = null;

  if (config.zerodha) {
    console.log(`[boot] Zerodha integration: configured (user=${config.zerodha.userId})`);

    sessionService = new SessionService(config.zerodha, zerodhaRepo);
    instrumentsService = new InstrumentsService(zerodhaRepo);
    marketDataStream = new MarketDataStream(zerodhaRepo);

    zerodhaSupervisor = new ZerodhaSupervisor(
      sessionService,
      instrumentsService,
      zerodhaRepo,
      marketDataStream,
    );

    // Register supervisor on the health service
    healthService.setZerodhaSupervisor(zerodhaSupervisor);

    console.log('[boot] Zerodha services initialised');
  } else {
    console.log('[boot] Zerodha integration: not configured (degraded broker mode)');
  }

  // ── Phase 5: create market clock (shared by scheduler and proposal supervisor) ──
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);

  // ── Phase 5a: initialise Proposal subsystem ─────────────────────────────
  let proposalSupervisor: ProposalSupervisor | null = null;
  let executionGateSupervisor: ExecutionGateSupervisor | null = null;

  if (config.proposalEngine) {
    console.log('[boot] Proposal engine: configured');

    const proposalRepo = new ProposalRepository(dbManager.db);
    const engine = new ProposalEngine(config.proposalEngine);
    const validator = new IndiaProposalValidator();

    proposalSupervisor = new ProposalSupervisor({
      engine,
      validator,
      repo: proposalRepo,
      session: sessionService,
      instruments: instrumentsService,
      stream: marketDataStream,
      clock,
      maxProposals: config.proposalEngine.maxProposalsPerTick,
    });

    // ── Phase 5b: initialise ExecutionGateSupervisor ──────────────────────
    const blockedRepo = new BlockedOrderRepository(dbManager.db);
    executionGateSupervisor = new ExecutionGateSupervisor({ blockedRepo });

    console.log('[boot] Proposal supervisor initialised');
    console.log('[boot] Execution gate supervisor initialised');
  } else {
    console.log('[boot] Proposal engine: not configured (proposal generation disabled)');
  }

  // ── Phase 6: start scheduler loop ──────────────────────────────────────
  const tickWork = [
    ...(zerodhaSupervisor ? [zerodhaSupervisor] : []),
    ...(proposalSupervisor ? [proposalSupervisor] : []),
    ...(executionGateSupervisor ? [executionGateSupervisor] : []),
  ];
  const scheduler = new Scheduler({
    clock,
    lifecycle,
    repo,
    health: healthService,
    telemetry,
    intervalMs: config.schedulerIntervalMs,
    tickWork,
  });

  scheduler.start();
  console.log(`[boot] scheduler started — phase: ${scheduler.getState().marketPhase}`);

  // ── Phase 6: start health HTTP server ──────────────────────────────────
  const server = createHealthServer(healthService, scheduler, telemetry, dbManager);
  server.listen(config.port, () => {
    console.log(`[boot] health HTTP server listening on port ${config.port}`);
  });

  // ── Graceful shutdown on process signals ───────────────────────────────
  const shutdown = (signal: string) => {
    console.log(`[boot] received ${signal} — shutting down gracefully`);

    // Disconnect market data stream if active
    if (zerodhaSupervisor) {
      try {
        // The supervisor doesn't expose the stream directly for shutdown
        // Stream cleanup happens via its own disconnect/close lifecycle
      } catch { /* ignore */ }
    }

    scheduler.stop(`${signal} received`);
    server.close(() => {
      dbManager.close();
      console.log('[boot] shutdown complete');
      process.exit(0);
    });

    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
      console.error('[boot] forced exit after shutdown timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log(`[boot] startup complete. Health endpoint: http://localhost:${config.port}/health`);
}

// ── Run ──────────────────────────────────────────────────────────────────────
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[boot] Fatal: ${message}`);
  process.exitCode = 1;
});
