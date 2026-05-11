import { loadConfigFromEnv } from './config/env.js';

/** Boot the runtime: load config, initialise subsystems, and hand to the scheduler. */
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

  // ── Phase 2: future — initialise persistence (S01/T03) ─────────────────
  // ── Phase 3: future — start scheduler loop (S01/T04) ───────────────────
  // ── Phase 4: future — start health HTTP server (S01/T04) ───────────────

  console.log(`[boot] startup complete. Ready for scheduler wiring.`);
}

// ── Run ──────────────────────────────────────────────────────────────────────
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[boot] Fatal: ${message}`);
  process.exitCode = 1;
});
