import type { RuntimeConfig, ConfigValidationError, BrokerConfig, ProposalEngineConfig } from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Parsed env accessor — reads `process.env` once at startup.
// ---------------------------------------------------------------------------

const VALID_NODE_ENVS = ['development', 'production', 'test'] as const;
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/// Default session refresh: 6 hours (session material lives ~24h; refresh well before expiry).
const DEFAULT_BROKER_SESSION_REFRESH_MS = 21_600_000;

function firstDefined(env: Record<string, string | undefined>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (env[key] !== undefined) return env[key];
  }
  return undefined;
}

function firstTrimmed(env: Record<string, string | undefined>, keys: readonly string[]): string | undefined {
  const value = firstDefined(env, keys);
  return value?.trim();
}

function aliasLabel(keys: readonly string[]): string {
  const [preferred, ...aliases] = keys;
  return aliases.length > 0
    ? `${preferred} (aliases: ${aliases.join(', ')})`
    : preferred;
}

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

  // ── BROKER ─────────────────────────────────────────────────────────────
  const broker = parseBrokerConfig(env, errors);

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
    broker,
    zerodha: broker,
    proposalEngine,
  };
}

/**
 * Parse broker transport configuration.
 * Returns null if all legacy broker env vars are absent (graceful degraded mode).
 * Returns a populated config if all required fields are present.
 * Pushes to errors array if some but not all required fields are present.
 */
function parseBrokerConfig(
  env: Record<string, string | undefined>,
  errors: ConfigValidationError[],
): BrokerConfig | null {
  const keysets = {
    transport: ['TRADER_BROKER_TRANSPORT', 'TRADER_UPSTOX_TRANSPORT', 'TRADER_ZERODHA_TRANSPORT'],
    apiKey: ['TRADER_BROKER_API_KEY', 'TRADER_UPSTOX_API_KEY', 'TRADER_ZERODHA_API_KEY'],
    apiSecret: ['TRADER_BROKER_API_SECRET', 'TRADER_UPSTOX_API_SECRET', 'TRADER_ZERODHA_API_SECRET'],
    userId: ['TRADER_BROKER_USER_ID', 'TRADER_UPSTOX_USER_ID', 'TRADER_ZERODHA_USER_ID'],
    totpKey: ['TRADER_BROKER_TOTP_KEY', 'TRADER_UPSTOX_TOTP_KEY', 'TRADER_ZERODHA_TOTP_KEY'],
    sessionRefreshMs: ['TRADER_BROKER_SESSION_REFRESH_MS', 'TRADER_UPSTOX_SESSION_REFRESH_MS', 'TRADER_ZERODHA_SESSION_REFRESH_MS'],
    mcpUrl: ['TRADER_BROKER_MCP_URL', 'TRADER_UPSTOX_MCP_URL', 'TRADER_ZERODHA_MCP_URL'],
    mcpAuthToken: ['TRADER_BROKER_MCP_AUTH_TOKEN', 'TRADER_UPSTOX_MCP_AUTH_TOKEN', 'TRADER_ZERODHA_MCP_AUTH_TOKEN'],
    mcpSessionTool: ['TRADER_BROKER_MCP_TOOL_SESSION', 'TRADER_UPSTOX_MCP_TOOL_SESSION', 'TRADER_ZERODHA_MCP_TOOL_SESSION'],
    mcpInstrumentsTool: ['TRADER_BROKER_MCP_TOOL_INSTRUMENTS', 'TRADER_UPSTOX_MCP_TOOL_INSTRUMENTS', 'TRADER_ZERODHA_MCP_TOOL_INSTRUMENTS'],
    mcpQuotesTool: ['TRADER_BROKER_MCP_TOOL_QUOTES', 'TRADER_UPSTOX_MCP_TOOL_QUOTES', 'TRADER_ZERODHA_MCP_TOOL_QUOTES'],
    mcpTimeoutMs: ['TRADER_BROKER_MCP_TIMEOUT_MS', 'TRADER_UPSTOX_MCP_TIMEOUT_MS', 'TRADER_ZERODHA_MCP_TIMEOUT_MS'],
    quotePollIntervalMs: ['TRADER_BROKER_QUOTE_POLL_INTERVAL_MS', 'TRADER_UPSTOX_QUOTE_POLL_INTERVAL_MS', 'TRADER_ZERODHA_QUOTE_POLL_INTERVAL_MS'],
    instrumentRefreshIntervalMs: ['TRADER_BROKER_INSTRUMENT_REFRESH_MS', 'TRADER_UPSTOX_INSTRUMENT_REFRESH_MS', 'TRADER_ZERODHA_INSTRUMENT_REFRESH_MS'],
  } as const;

  const transportRaw = firstTrimmed(env, keysets.transport)?.toLowerCase();
  const transport = (transportRaw === 'mcp' || transportRaw === 'direct')
    ? transportRaw
    : undefined;

  const apiKey = firstTrimmed(env, keysets.apiKey) ?? '';
  const apiSecret = firstTrimmed(env, keysets.apiSecret) ?? '';
  const userId = firstTrimmed(env, keysets.userId) ?? '';
  const totpKey = firstTrimmed(env, keysets.totpKey) ?? '';

  const mcpUrl = firstTrimmed(env, keysets.mcpUrl) ?? '';
  const mcpAuthToken = firstTrimmed(env, keysets.mcpAuthToken) || undefined;
  const mcpSessionTool = firstTrimmed(env, keysets.mcpSessionTool) || undefined;
  const mcpInstrumentsTool = firstTrimmed(env, keysets.mcpInstrumentsTool) || undefined;
  const mcpQuotesTool = firstTrimmed(env, keysets.mcpQuotesTool) || undefined;

  const anyDirect = Boolean(apiKey || apiSecret || userId || totpKey);
  const anyMcp = Boolean(mcpUrl || mcpAuthToken || mcpSessionTool || mcpInstrumentsTool || mcpQuotesTool || transport === 'mcp');

  if (!anyDirect && !anyMcp && transport !== 'direct') {
    return null; // Graceful degraded mode — no broker integration
  }

  const intervalRaw = firstDefined(env, keysets.sessionRefreshMs) ?? String(DEFAULT_BROKER_SESSION_REFRESH_MS);
  const sessionRefreshIntervalMs = Number(intervalRaw);
  if (!Number.isFinite(sessionRefreshIntervalMs) || sessionRefreshIntervalMs < 60_000) {
    errors.push({
      field: keysets.sessionRefreshMs[0],
      message: `Must be ≥ 60_000ms, got "${intervalRaw}". Also accepts ${keysets.sessionRefreshMs.slice(1).join(', ')}.`,
      provided: intervalRaw,
    });
    return null;
  }

  const resolvedTransport = transport ?? (anyMcp ? 'mcp' : 'direct');

  if (resolvedTransport === 'direct') {
    const missing: string[] = [];
    if (!apiKey) missing.push(aliasLabel(keysets.apiKey));
    if (!apiSecret) missing.push(aliasLabel(keysets.apiSecret));
    if (!userId) missing.push(aliasLabel(keysets.userId));
    if (!totpKey) missing.push(aliasLabel(keysets.totpKey));

    if (missing.length > 0) {
      errors.push({
        field: 'BROKER',
        message: `Partial broker direct config: missing ${missing.join(', ')}. Set all four or switch ${aliasLabel(keysets.transport)}=mcp.`,
        provided: {
          transport: resolvedTransport,
          missing,
        },
      });
      return null;
    }

    return {
      transport: 'direct',
      apiKey,
      apiSecret,
      userId,
      totpKey,
      sessionRefreshIntervalMs,
    };
  }

  const resolvedMcpUrl = mcpUrl || 'https://mcp.kite.trade/mcp';
  try {
    new URL(resolvedMcpUrl);
  } catch {
    errors.push({
      field: keysets.mcpUrl[0],
      message: `Invalid MCP URL: "${resolvedMcpUrl}". Also accepts ${keysets.mcpUrl.slice(1).join(', ')}.`,
      provided: resolvedMcpUrl,
    });
    return null;
  }

  const timeoutRaw = firstDefined(env, keysets.mcpTimeoutMs) ?? '30000';
  const mcpTimeoutMs = Number(timeoutRaw);
  if (!Number.isFinite(mcpTimeoutMs) || mcpTimeoutMs < 1000 || mcpTimeoutMs > 300_000) {
    errors.push({
      field: keysets.mcpTimeoutMs[0],
      message: `Must be between 1000 and 300000, got "${timeoutRaw}". Also accepts ${keysets.mcpTimeoutMs.slice(1).join(', ')}.`,
      provided: timeoutRaw,
    });
    return null;
  }

  const quotePollRaw = firstDefined(env, keysets.quotePollIntervalMs) ?? '15000';
  const quotePollIntervalMs = Number(quotePollRaw);
  if (!Number.isFinite(quotePollIntervalMs) || quotePollIntervalMs < 1000 || quotePollIntervalMs > 300_000) {
    errors.push({
      field: keysets.quotePollIntervalMs[0],
      message: `Must be between 1000 and 300000, got "${quotePollRaw}". Also accepts ${keysets.quotePollIntervalMs.slice(1).join(', ')}.`,
      provided: quotePollRaw,
    });
    return null;
  }

  const instrumentRefreshRaw = firstDefined(env, keysets.instrumentRefreshIntervalMs) ?? '86400000';
  const instrumentRefreshIntervalMs = Number(instrumentRefreshRaw);
  if (!Number.isFinite(instrumentRefreshIntervalMs) || instrumentRefreshIntervalMs < 60_000) {
    errors.push({
      field: keysets.instrumentRefreshIntervalMs[0],
      message: `Must be ≥ 60_000ms, got "${instrumentRefreshRaw}". Also accepts ${keysets.instrumentRefreshIntervalMs.slice(1).join(', ')}.`,
      provided: instrumentRefreshRaw,
    });
    return null;
  }

  return {
    transport: 'mcp',
    mcpUrl: resolvedMcpUrl,
    mcpAuthToken,
    mcpTimeoutMs,
    quotePollIntervalMs,
    instrumentRefreshIntervalMs,
    sessionRefreshIntervalMs,
    mcpTools: {
      session: mcpSessionTool,
      instruments: mcpInstrumentsTool,
      quotes: mcpQuotesTool,
    },
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
