// ── Main entrypoint ──
// Thin boot wrapper over the reusable RuntimeApp harness.
// Configuration → RuntimeApp → start → wait for shutdown signal.

import { loadConfigFromEnv } from './config/env.js';
import { RuntimeApp } from './runtime/runtime-app.js';

/** Boot the runtime: load config, build RuntimeApp, register signal handlers. */
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

  // ── Phase 2: build and start the composed runtime ─────────────────────
  const app = new RuntimeApp(config);
  app.start();

  // ── Graceful shutdown on process signals ───────────────────────────────
  const shutdown = (signal: string) => {
    console.log(`[boot] received ${signal} — shutting down gracefully`);
    app.stop(signal);

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
