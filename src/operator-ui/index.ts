#!/usr/bin/env node
// ── Operator UI entrypoint ──
// Standalone authenticated operator console service.
//
// Usage:
//   node --import tsx src/operator-ui/index.ts
//
// Required env:
//   OPERATOR_UI_PASSWORD=<password>
//
// Optional env:
//   OPERATOR_UI_HOST=127.0.0.1
//   OPERATOR_UI_PORT=3100
//   OPERATOR_UI_DB_PATH=./data/trader.db
//   OPERATOR_UI_USERNAME=operator
//   OPERATOR_UI_POLL_INTERVAL_MS=30000
//   OPERATOR_UI_LOCKOUT_THRESHOLD=5
//   OPERATOR_UI_LOCKOUT_DURATION_MS=300000
//   OPERATOR_UI_RATE_LIMIT_MAX=60
//   OPERATOR_UI_RATE_LIMIT_WINDOW_MS=60000

import { loadOperatorUIConfigFromEnv, redact, OperatorUIConfigError } from './config.js';
import { Authenticator } from './auth.js';
import { createOperatorUIServer } from './server.js';
import { openOperatorDb, closeOperatorDb, OperatorReadModel } from '../operator/index.js';

const FAULT_METHODS = {
  summaryCards: 'getSummaryCards',
  strategyPerformance: 'getStrategyPerformance',
  tickerPerformance: 'getTickerPerformance',
  decisionPerformance: 'getDecisionPerformance',
  lifecycleStates: 'getLifecycleStates',
  governanceHistory: 'getLifecycleHistory',
  promotionHistory: 'getPromotionHistory',
  walkForwardLeaderboard: 'getWalkForwardLeaderboard',
} as const;

type FaultSection = keyof typeof FAULT_METHODS;

type ReadModelMethod = keyof OperatorReadModel;

function maybeWrapReadModelForInjectedFailures(readModel: OperatorReadModel | null): OperatorReadModel | null {
  if (readModel === null) {
    return null;
  }

  const rawSection = process.env.OPERATOR_UI_TEST_FAIL_SECTION?.trim() ?? '';
  if (!rawSection) {
    return readModel;
  }

  if (!(rawSection in FAULT_METHODS)) {
    console.warn(`[operator-ui] Ignoring unknown OPERATOR_UI_TEST_FAIL_SECTION="${rawSection}".`);
    return readModel;
  }

  const section = rawSection as FaultSection;
  const methodName = FAULT_METHODS[section] as ReadModelMethod;
  const failAfterSuccesses = Number(process.env.OPERATOR_UI_TEST_FAIL_AFTER_SUCCESS_COUNT ?? '1');
  const injectedMessage = process.env.OPERATOR_UI_TEST_FAIL_MESSAGE?.trim()
    || `Injected ${section} refresh failure for proof flow: authorization=Basic proof-secret-token`;
  const counters = new Map<string, number>();

  console.warn(
    `[operator-ui] Test-only failure injection active for ${section} after ${Number.isFinite(failAfterSuccesses) ? failAfterSuccesses : 1} successful calls.`,
  );

  return new Proxy(readModel, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== methodName || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }

      return (...args: unknown[]) => {
        const invocationCount = (counters.get(section) ?? 0) + 1;
        counters.set(section, invocationCount);
        if (invocationCount > (Number.isFinite(failAfterSuccesses) ? failAfterSuccesses : 1)) {
          throw new Error(injectedMessage);
        }
        return Reflect.apply(value as (...callArgs: unknown[]) => unknown, target, args);
      };
    },
  }) as OperatorReadModel;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  // ── Parse config ──────────────────────────────────────────────────────
  let config;
  try {
    config = loadOperatorUIConfigFromEnv();
  } catch (err) {
    if (err instanceof OperatorUIConfigError) {
      console.error(`[operator-ui] Configuration error — ${err.field}: ${err.message}`);
      process.exit(1);
    }
    console.error('[operator-ui] Unexpected config error:', err);
    process.exit(1);
  }

  // Redact password for startup log
  const redacted = redact({ ...config }) as Record<string, unknown>;
  console.log('[operator-ui] Starting with config:', JSON.stringify(redacted, null, 2));

  // ── Open operator database ────────────────────────────────────────────
  const { db, error: dbError, attempts: dbOpenAttempts, recoveredAfterRetry } = openOperatorDb(config.dbPath);
  if (db === null) {
    console.warn(`[operator-ui] WARNING: Failed to open operator database at "${config.dbPath}" after ${dbOpenAttempts} attempt(s): ${dbError}`);
    console.warn('[operator-ui] HTTP server will start in degraded mode — DB-backed routes return 503.');
  } else {
    const retryMeta = recoveredAfterRetry ? ` after ${dbOpenAttempts} attempts` : '';
    console.log(`[operator-ui] Operator database opened (read-only): ${config.dbPath}${retryMeta}`);
  }

  // ── Create read model (null when DB is unavailable) ───────────────────
  const dbOpenBootstrap = {
    status: db !== null ? (recoveredAfterRetry ? 'recovered' : 'ready') : 'failed',
    attempts: dbOpenAttempts,
    recoveredAfterRetry,
    lastError: dbError,
  } as const;

  const readModel = maybeWrapReadModelForInjectedFailures(
    db !== null ? new OperatorReadModel(db) : null,
  );

  // ── Create authenticator ──────────────────────────────────────────────
  const authenticator = new Authenticator(config);
  authenticator.startCleanup();

  // ── Create and start server ──────────────────────────────────────────
  const server = createOperatorUIServer({
    config,
    authenticator,
    db,
    dbError,
    readModel,
    dbOpenBootstrap,
  });

  server.listen(config.port, config.host, () => {
    console.log(`[operator-ui] HTTP server listening on http://${config.host}:${config.port}`);
    console.log(`[operator-ui]   GET /health        — Unauthenticated liveness`);
    console.log(`[operator-ui]   GET /              — Dashboard HTML (auth required)`);
    console.log(`[operator-ui]   GET /api/refresh   — JSON refresh (auth required)`);
    console.log(`[operator-ui]   GET /api/health    — API health + diagnostics (auth required)`);
    if (db === null) {
      console.log('[operator-ui] ⚠ Running in degraded mode — database unavailable.');
    }
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────
  function shutdown(signal: string): void {
    console.log(`\n[operator-ui] Received ${signal}. Shutting down...`);
    authenticator.stopCleanup();
    server.close(() => {
      console.log('[operator-ui] HTTP server closed.');
      closeOperatorDb(db);
      console.log('[operator-ui] Database connection closed.');
      process.exit(0);
    });

    // Force exit after 5s if shutdown hangs
    setTimeout(() => {
      console.error('[operator-ui] Forced exit after shutdown timeout.');
      process.exit(1);
    }, 5000);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
