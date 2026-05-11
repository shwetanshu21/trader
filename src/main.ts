import { loadConfigFromEnv } from './config/env.js';
import { DatabaseManager } from './persistence/sqlite.js';
import { RuntimeStateRepository } from './persistence/runtime-state-repo.js';
import { LifecycleManager } from './runtime/lifecycle.js';
import { HealthService } from './runtime/health-service.js';
import { MarketClock } from './runtime/market-clock.js';
import { Scheduler } from './runtime/scheduler.js';
import { Telemetry } from './runtime/telemetry.js';
import { INDIA_NSE_EQ_MARKET } from './market/india-profile.js';
import { createHealthServer } from './runtime/health-server.js';

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

  // ── Phase 2: initialise persistence and lifecycle ──────────────────────
  const dbManager = new DatabaseManager(config.dbPath);
  const repo = new RuntimeStateRepository(dbManager.db);
  const lifecycle = new LifecycleManager(repo);
  const healthService = new HealthService(lifecycle, repo, Date.now());
  const telemetry = new Telemetry(repo);

  // Transition to Running
  const bootEvent = lifecycle.start('Runtime boot completed');
  console.log(`[boot] lifecycle → ${bootEvent.state} (${bootEvent.reason})`);

  // Record initial health check
  const initialHealth = healthService.recordHealthCheck();
  console.log(`[boot] initial health: ${initialHealth.verdict} (uptime ${initialHealth.uptimeMs}ms)`);

  // ── Phase 3: start scheduler loop ──────────────────────────────────────
  const clock = new MarketClock(INDIA_NSE_EQ_MARKET);
  const scheduler = new Scheduler({
    clock,
    lifecycle,
    repo,
    health: healthService,
    telemetry,
    intervalMs: config.schedulerIntervalMs,
  });

  scheduler.start();
  console.log(`[boot] scheduler started — phase: ${scheduler.getState().marketPhase}`);

  // ── Phase 4: start health HTTP server ──────────────────────────────────
  const server = createHealthServer(healthService, scheduler, telemetry, dbManager);
  server.listen(config.port, () => {
    console.log(`[boot] health HTTP server listening on port ${config.port}`);
  });

  // ── Graceful shutdown on process signals ───────────────────────────────
  const shutdown = (signal: string) => {
    console.log(`[boot] received ${signal} — shutting down gracefully`);
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
