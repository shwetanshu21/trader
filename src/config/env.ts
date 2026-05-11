import type { RuntimeConfig, ConfigValidationError } from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Parsed env accessor — reads `process.env` once at startup.
// ---------------------------------------------------------------------------

const VALID_NODE_ENVS = ['development', 'production', 'test'] as const;
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** Parse and validate runtime configuration from environment variables. */
export function loadConfig(env: Record<string, string | undefined>): RuntimeConfig {
  const errors: ConfigValidationError[] = [];
  const warn: ConfigValidationError[] = [];

  // ── PORT ────────────────────────────────────────────────────────────────
  const portRaw = env.TRADER_PORT ?? env.PORT ?? '3000';
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    errors.push({
      field: 'PORT',
      message: `Must be a valid port number (1–65535), got "${portRaw}".`,
      provided: portRaw,
    });
  }

  // ── NODE_ENV ────────────────────────────────────────────────────────────
  const nodeEnvRaw = env.NODE_ENV ?? 'development';
  const nodeEnv = nodeEnvRaw as RuntimeConfig['nodeEnv'];
  if (!(VALID_NODE_ENVS as readonly string[]).includes(nodeEnvRaw)) {
    errors.push({
      field: 'NODE_ENV',
      message: `Must be one of ${VALID_NODE_ENVS.join(', ')}, got "${nodeEnvRaw}".`,
      provided: nodeEnvRaw,
    });
  }

  // ── MARKET_TIMEZONE ─────────────────────────────────────────────────────
  const marketTimezone = env.TRADER_MARKET_TIMEZONE ?? 'Asia/Kolkata';
  try {
    Intl.DateTimeFormat(undefined, { timeZone: marketTimezone });
  } catch {
    warn.push({
      field: 'TRADER_MARKET_TIMEZONE',
      message: `Unrecognised timezone "${marketTimezone}". Falling back to Asia/Kolkata.`,
      provided: marketTimezone,
    });
  }
  // Use the validated/fallback value
  const resolvedTimezone = (() => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: marketTimezone });
      return marketTimezone;
    } catch {
      return 'Asia/Kolkata';
    }
  })();

  // ── SCHEDULER_INTERVAL_MS ───────────────────────────────────────────────
  const intervalRaw = env.TRADER_SCHEDULER_INTERVAL_MS ?? '60000';
  const schedulerIntervalMs = Number(intervalRaw);
  if (!Number.isFinite(schedulerIntervalMs) || schedulerIntervalMs < 1000) {
    errors.push({
      field: 'TRADER_SCHEDULER_INTERVAL_MS',
      message: `Must be a positive integer ≥ 1000, got "${intervalRaw}".`,
      provided: intervalRaw,
    });
  }

  // ── DB_PATH ─────────────────────────────────────────────────────────────
  const dbPath = env.TRADER_DB_PATH ?? './data/trader.db';

  // ── LOG_LEVEL ───────────────────────────────────────────────────────────
  const logLevelRaw = env.TRADER_LOG_LEVEL ?? 'info';
  const logLevel = logLevelRaw as RuntimeConfig['logLevel'];
  if (!(VALID_LOG_LEVELS as readonly string[]).includes(logLevelRaw)) {
    warn.push({
      field: 'TRADER_LOG_LEVEL',
      message: `Unrecognised log level "${logLevelRaw}". Falling back to "info".`,
      provided: logLevelRaw,
    });
  }
  const resolvedLogLevel: RuntimeConfig['logLevel'] = (
    VALID_LOG_LEVELS as readonly string[]).includes(logLevelRaw)
    ? logLevel
    : 'info';

  // ── Fail on hard errors ─────────────────────────────────────────────────
  if (errors.length > 0) {
    const summary = errors.map(e => `  — ${e.field}: ${e.message}`).join('\n');
    throw new ConfigValidationErrorImpl(
      `Configuration validation failed:\n${summary}`,
      errors,
    );
  }

  // Log warnings but don't fail
  if (warn.length > 0) {
    for (const w of warn) {
      console.warn(`[config] Warning — ${w.field}: ${w.message}`);
    }
  }

  return {
    port,
    nodeEnv,
    marketTimezone: resolvedTimezone,
    schedulerIntervalMs,
    dbPath,
    logLevel: resolvedLogLevel,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export class ConfigValidationErrorImpl extends Error {
  public readonly errors: ConfigValidationError[];

  constructor(message: string, errors: ConfigValidationError[]) {
    super(message);
    this.name = 'ConfigValidationError';
    this.errors = errors;
  }
}

/** Convenience: load config from `process.env` directly. */
export function loadConfigFromEnv(): RuntimeConfig {
  return loadConfig(process.env);
}
