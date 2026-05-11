import type { RuntimeConfig, ConfigValidationError, ZerodhaConfig, ProposalEngineConfig } from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Parsed env accessor — reads `process.env` once at startup.
// ---------------------------------------------------------------------------

const VALID_NODE_ENVS = ['development', 'production', 'test'] as const;
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/// Default session refresh: 6 hours (Kite tokens live 24h; refresh well before expiry).
const DEFAULT_ZERODHA_SESSION_REFRESH_MS = 21_600_000;

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

  // ── ZERODHA ────────────────────────────────────────────────────────────
  const zerodha = parseZerodhaConfig(env, errors);

  // ── PROPOSAL ENGINE ────────────────────────────────────────────────────
  const proposalEngine = parseProposalEngineConfig(env, errors);

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
    zerodha,
    proposalEngine,
  };
}

/**
 * Parse Zerodha configuration.
 * Returns null if all Zerodha env vars are absent (graceful degraded mode).
 * Returns a populated config if all required fields are present.
 * Pushes to errors array if some but not all required fields are present.
 */
function parseZerodhaConfig(
  env: Record<string, string | undefined>,
  errors: ConfigValidationError[],
): ZerodhaConfig | null {
  const apiKey = env.TRADER_ZERODHA_API_KEY ?? '';
  const apiSecret = env.TRADER_ZERODHA_API_SECRET ?? '';
  const userId = env.TRADER_ZERODHA_USER_ID ?? '';
  const totpKey = env.TRADER_ZERODHA_TOTP_KEY ?? '';

  const allAbsent = !apiKey && !apiSecret && !userId && !totpKey;

  if (allAbsent) {
    return null; // Graceful degraded mode — no Zerodha integration
  }

  // Partial presence is an error
  const missing: string[] = [];
  if (!apiKey) missing.push('TRADER_ZERODHA_API_KEY');
  if (!apiSecret) missing.push('TRADER_ZERODHA_API_SECRET');
  if (!userId) missing.push('TRADER_ZERODHA_USER_ID');
  if (!totpKey) missing.push('TRADER_ZERODHA_TOTP_KEY');

  if (missing.length > 0) {
    errors.push({
      field: 'ZERODHA',
      message: `Partial Zerodha config: missing ${missing.join(', ')}. Set all four or none.`,
      provided: { present: ['TRADER_ZERODHA_API_KEY', 'TRADER_ZERODHA_API_SECRET', 'TRADER_ZERODHA_USER_ID', 'TRADER_ZERODHA_TOTP_KEY'].filter(k => env[k]), missing },
    });
    return null;
  }

  // Optional refresh interval
  const intervalRaw = env.TRADER_ZERODHA_SESSION_REFRESH_MS ?? String(DEFAULT_ZERODHA_SESSION_REFRESH_MS);
  const sessionRefreshIntervalMs = Number(intervalRaw);
  if (!Number.isFinite(sessionRefreshIntervalMs) || sessionRefreshIntervalMs < 60_000) {
    errors.push({
      field: 'TRADER_ZERODHA_SESSION_REFRESH_MS',
      message: `Must be ≥ 60_000ms, got "${intervalRaw}".`,
      provided: intervalRaw,
    });
    return null;
  }

  return {
    apiKey,
    apiSecret,
    userId,
    totpKey,
    sessionRefreshIntervalMs,
  };
}

/**
 * Parse proposal-generation provider configuration.
 * Returns null if no proposal-provider env vars are set (graceful degraded mode).
 * Requires at minimum TRADER_PROPOSAL_PROVIDER_URL; partial config pushes an error.
 */
function parseProposalEngineConfig(
  env: Record<string, string | undefined>,
  errors: ConfigValidationError[],
): ProposalEngineConfig | null {
  const providerUrl = env.TRADER_PROPOSAL_PROVIDER_URL?.trim() || '';

  // All absent = graceful degraded mode (no LLM proposals)
  if (!providerUrl) {
    return null;
  }

  // Validate URL
  try {
    new URL(providerUrl);
  } catch {
    errors.push({
      field: 'TRADER_PROPOSAL_PROVIDER_URL',
      message: `Invalid URL: "${providerUrl}".`,
      provided: providerUrl,
    });
    return null;
  }

  // Optional: API key
  const apiKey = env.TRADER_PROPOSAL_API_KEY?.trim() || undefined;

  // Optional: timeout (default 30s)
  const timeoutRaw = env.TRADER_PROPOSAL_TIMEOUT_MS ?? '30000';
  const timeoutMs = Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
    errors.push({
      field: 'TRADER_PROPOSAL_TIMEOUT_MS',
      message: `Must be between 1000 and 300000, got "${timeoutRaw}".`,
      provided: timeoutRaw,
    });
    return null;
  }

  // Optional: max proposals per tick (default 5)
  const maxRaw = env.TRADER_PROPOSAL_MAX_PER_TICK ?? '5';
  const maxProposalsPerTick = Number(maxRaw);
  if (!Number.isFinite(maxProposalsPerTick) || maxProposalsPerTick < 1 || maxProposalsPerTick > 50) {
    errors.push({
      field: 'TRADER_PROPOSAL_MAX_PER_TICK',
      message: `Must be between 1 and 50, got "${maxRaw}".`,
      provided: maxRaw,
    });
    return null;
  }

  return {
    providerUrl,
    timeoutMs,
    maxProposalsPerTick,
    apiKey,
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
