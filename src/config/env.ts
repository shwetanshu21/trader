import type { RuntimeConfig, ConfigValidationError, BrokerConfig, ProposalEngineConfig, ExecutionConfig, StrategyFrameworkConfig, GovernanceThresholdConfig, DemotionThresholdConfig, OvernightConfig } from '../types/runtime.js';
import { ExecutionMode, DEFAULT_GOVERNANCE_THRESHOLDS, DEFAULT_DEMOTION_THRESHOLDS } from '../types/runtime.js';

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

  // ── EXECUTION MODE ─────────────────────────────────────────────────────
  const execution = parseExecutionConfig(env, errors);

  // ── STRATEGY FRAMEWORK ────────────────────────────────────────────────
  const strategy = parseStrategyFrameworkConfig(env, errors);

  // ── OVERNIGHT RESEARCH ────────────────────────────────────────────────
  const overnight = parseOvernightConfig(env, errors);

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
    execution,
    strategy,
    overnight,
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

  const providerModeRaw = env.TRADER_PROPOSAL_PROVIDER_MODE?.trim().toLowerCase() || 'custom';
  if (providerModeRaw !== 'custom' && providerModeRaw !== 'openai-compatible') {
    errors.push({
      field: 'TRADER_PROPOSAL_PROVIDER_MODE',
      message: `Must be one of custom, openai-compatible, got "${providerModeRaw}".`,
      provided: providerModeRaw,
    });
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

  const providerModel = env.TRADER_PROPOSAL_PROVIDER_MODEL?.trim() || undefined;
  const fallbackProviderModel = env.TRADER_PROPOSAL_FALLBACK_PROVIDER_MODEL?.trim() || undefined;
  const fallbackProviderModels = (env.TRADER_PROPOSAL_FALLBACK_PROVIDER_MODELS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (providerModeRaw === 'openai-compatible' && !providerModel) {
    errors.push({
      field: 'TRADER_PROPOSAL_PROVIDER_MODEL',
      message: 'TRADER_PROPOSAL_PROVIDER_MODEL is required when TRADER_PROPOSAL_PROVIDER_MODE=openai-compatible.',
      provided: providerModel,
    });
    return null;
  }

  // Optional: fallback provider URL (cross-provider failover)
  const fallbackProviderUrl = env.TRADER_PROPOSAL_FALLBACK_PROVIDER_URL?.trim() || undefined;
  if (fallbackProviderUrl) {
    try {
      new URL(fallbackProviderUrl);
    } catch {
      errors.push({
        field: 'TRADER_PROPOSAL_FALLBACK_PROVIDER_URL',
        message: `Invalid URL: "${fallbackProviderUrl}".`,
        provided: fallbackProviderUrl,
      });
      return null;
    }
  }

  // Optional: API keys
  const apiKey = env.TRADER_PROPOSAL_API_KEY?.trim() || undefined;
  const fallbackApiKey = env.TRADER_PROPOSAL_FALLBACK_API_KEY?.trim() || undefined;

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
    providerMode: providerModeRaw,
    providerUrl,
    providerModel,
    fallbackProviderModel,
    fallbackProviderModels: fallbackProviderModels.length > 0 ? fallbackProviderModels : undefined,
    fallbackProviderUrl,
    fallbackApiKey,
    timeoutMs,
    maxProposalsPerTick,
    apiKey,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse execution mode configuration.
 * TRADER_EXECUTION_MODE defaults to 'blocked' and accepts 'blocked', 'paper', or 'live'.
 */
function parseExecutionConfig(
  env: Record<string, string | undefined>,
  errors: ConfigValidationError[],
): ExecutionConfig {
  const modeRaw = env.TRADER_EXECUTION_MODE?.trim().toLowerCase() ?? 'blocked';
  let mode: ExecutionMode;

  switch (modeRaw) {
    case 'blocked':
      mode = ExecutionMode.Blocked;
      break;
    case 'paper':
      mode = ExecutionMode.Paper;
      break;
    case 'live':
      mode = ExecutionMode.Live;
      break;
    default:
      errors.push({
        field: 'TRADER_EXECUTION_MODE',
        message: `Must be one of 'blocked', 'paper', 'live', got "${modeRaw}". Defaulting to blocked.`,
        provided: modeRaw,
      });
      mode = ExecutionMode.Blocked;
      break;
  }

  const maxRetriesRaw = env.TRADER_EXECUTION_MAX_RETRIES ?? '0';
  const maxRetries = Number(maxRetriesRaw);
  if (!Number.isFinite(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    errors.push({
      field: 'TRADER_EXECUTION_MAX_RETRIES',
      message: `Must be between 0 and 10, got "${maxRetriesRaw}". Defaulting to 0.`,
      provided: maxRetriesRaw,
    });
  }

  const paperBrokerUrl = env.TRADER_EXECUTION_PAPER_BROKER_URL?.trim() || undefined;
  if (paperBrokerUrl) {
    try {
      new URL(paperBrokerUrl);
    } catch {
      errors.push({
        field: 'TRADER_EXECUTION_PAPER_BROKER_URL',
        message: `Invalid URL: "${paperBrokerUrl}". Ignoring.`,
        provided: paperBrokerUrl,
      });
    }
  }

  // ── Operator bind host ──────────────────────────────────────────────────
  const operatorBindHostRaw = env.TRADER_EXECUTION_OPERATOR_BIND_HOST?.trim() ?? '';
  let operatorBindHost = operatorBindHostRaw || '127.0.0.1';

  // Validate explicit bind host (if set to something non-empty, it must look valid)
  if (operatorBindHostRaw && !/^[\w.:[\]]+$/.test(operatorBindHostRaw)) {
    errors.push({
      field: 'TRADER_EXECUTION_OPERATOR_BIND_HOST',
      message: `Invalid bind host "${operatorBindHostRaw}". Expected a valid hostname or IP address (e.g. "127.0.0.1", "localhost", "0.0.0.0").`,
      provided: operatorBindHostRaw,
    });
    operatorBindHost = '127.0.0.1';
  }

  // ── Risk limits ─────────────────────────────────────────────────────────
  const maxOpenPositionsRaw = env.TRADER_EXECUTION_MAX_OPEN_POSITIONS ?? '10';
  const maxOpenPositions = Number(maxOpenPositionsRaw);
  if (!Number.isFinite(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > 1000) {
    errors.push({
      field: 'TRADER_EXECUTION_MAX_OPEN_POSITIONS',
      message: `Must be between 1 and 1000, got "${maxOpenPositionsRaw}". Defaulting to 10.`,
      provided: maxOpenPositionsRaw,
    });
  }

  const maxOrdersPerInstrumentRaw = env.TRADER_EXECUTION_MAX_ORDERS_PER_INSTRUMENT ?? '1';
  const maxOrdersPerInstrument = Number(maxOrdersPerInstrumentRaw);
  if (!Number.isFinite(maxOrdersPerInstrument) || maxOrdersPerInstrument < 1 || maxOrdersPerInstrument > 100) {
    errors.push({
      field: 'TRADER_EXECUTION_MAX_ORDERS_PER_INSTRUMENT',
      message: `Must be between 1 and 100, got "${maxOrdersPerInstrumentRaw}". Defaulting to 1.`,
      provided: maxOrdersPerInstrumentRaw,
    });
  }

  const maxDailyLossRupeesRaw = env.TRADER_EXECUTION_MAX_DAILY_LOSS_RUPEES ?? '0';
  const maxDailyLossRupees = Number(maxDailyLossRupeesRaw);
  if (!Number.isFinite(maxDailyLossRupees) || maxDailyLossRupees < 0 || maxDailyLossRupees > 10_000_000) {
    errors.push({
      field: 'TRADER_EXECUTION_MAX_DAILY_LOSS_RUPEES',
      message: `Must be between 0 and 10000000, got "${maxDailyLossRupeesRaw}". Defaulting to 0 (no limit).`,
      provided: maxDailyLossRupeesRaw,
    });
  }

  const maxExposureRupeesRaw = env.TRADER_EXECUTION_MAX_EXPOSURE_RUPEES ?? '0';
  const maxExposureRupees = Number(maxExposureRupeesRaw);
  if (!Number.isFinite(maxExposureRupees) || maxExposureRupees < 0 || maxExposureRupees > 100_000_000) {
    errors.push({
      field: 'TRADER_EXECUTION_MAX_EXPOSURE_RUPEES',
      message: `Must be between 0 and 100000000, got "${maxExposureRupeesRaw}". Defaulting to 0 (no limit).`,
      provided: maxExposureRupeesRaw,
    });
  }

  const marketHoursStalenessMsRaw = env.TRADER_EXECUTION_MARKET_HOURS_STALENESS_MS ?? '120000';
  const marketHoursStalenessMs = Number(marketHoursStalenessMsRaw);
  if (!Number.isFinite(marketHoursStalenessMs) || marketHoursStalenessMs < 1000 || marketHoursStalenessMs > 3_600_000) {
    errors.push({
      field: 'TRADER_EXECUTION_MARKET_HOURS_STALENESS_MS',
      message: `Must be between 1000 and 3600000, got "${marketHoursStalenessMsRaw}". Defaulting to 120000.`,
      provided: marketHoursStalenessMsRaw,
    });
  }

  return {
    mode,
    paperBrokerUrl,
    maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 && maxRetries <= 10
      ? maxRetries
      : 0,
    operatorBindHost,
    riskLimits: {
      maxOpenPositions: Number.isFinite(maxOpenPositions) && maxOpenPositions >= 1 && maxOpenPositions <= 1000
        ? maxOpenPositions
        : 10,
      maxOrdersPerInstrument: Number.isFinite(maxOrdersPerInstrument) && maxOrdersPerInstrument >= 1 && maxOrdersPerInstrument <= 100
        ? maxOrdersPerInstrument
        : 1,
      maxDailyLossRupees: Number.isFinite(maxDailyLossRupees) && maxDailyLossRupees >= 0 && maxDailyLossRupees <= 10_000_000
        ? maxDailyLossRupees
        : 0,
      maxExposureRupees: Number.isFinite(maxExposureRupees) && maxExposureRupees >= 0 && maxExposureRupees <= 100_000_000
        ? maxExposureRupees
        : 0,
      marketHoursStalenessMs: Number.isFinite(marketHoursStalenessMs) && marketHoursStalenessMs >= 1000 && marketHoursStalenessMs <= 3_600_000
        ? marketHoursStalenessMs
        : 120_000,
    },
  };
}

/**
 * Parse strategy framework configuration.
 * TRADER_STRATEGY_MAX_CANDIDATES defaults to 5.
 * TRADER_STRATEGY_PARALLEL_PLUGINS defaults to 'true'.
 */
function parseStrategyFrameworkConfig(
  env: Record<string, string | undefined>,
  errors: ConfigValidationError[],
): StrategyFrameworkConfig {
  // ── Max candidates per tick ─────────────────────────────────────────────
  const maxRaw = env.TRADER_STRATEGY_MAX_CANDIDATES ?? '5';
  const maxCandidates = Number(maxRaw);
  if (!Number.isFinite(maxCandidates) || maxCandidates < 1 || maxCandidates > 100) {
    errors.push({
      field: 'TRADER_STRATEGY_MAX_CANDIDATES',
      message: `Must be between 1 and 100, got "${maxRaw}". Defaulting to 5.`,
      provided: maxRaw,
    });
  }
  const resolvedMax = Number.isFinite(maxCandidates) && maxCandidates >= 1 && maxCandidates <= 100
    ? maxCandidates
    : 5;

  // ── Parallel plugins ────────────────────────────────────────────────────
  const parallelRaw = env.TRADER_STRATEGY_PARALLEL_PLUGINS?.toLowerCase() ?? 'true';
  const parallelPlugins = parallelRaw !== 'false';

  // ── Promotion governance thresholds ─────────────────────────────────────
  const promotion = parseGovernanceThresholds(env, errors);

  // ── Demotion governance thresholds ──────────────────────────────────────
  const demotion = parseDemotionThresholds(env, errors);

  return {
    maxCandidates: resolvedMax,
    parallelPlugins,
    promotion,
    demotion,
  };
}

/**
 * Parse promotion governance threshold configuration from environment variables.
 *
 * All thresholds are optional and fall back to DEFAULT_GOVERNANCE_THRESHOLDS.
 */
function parseGovernanceThresholds(
  env: Record<string, string | undefined>,
  errors: ConfigValidationError[],
): GovernanceThresholdConfig {
  const thresholds: GovernanceThresholdConfig = { ...DEFAULT_GOVERNANCE_THRESHOLDS };

  // ── Min merged score (0–1) ──────────────────────────────────────────────
  const mergedScoreRaw = env.TRADER_STRATEGY_PROMOTION_MIN_MERGED_SCORE;
  if (mergedScoreRaw !== undefined) {
    const val = Number(mergedScoreRaw);
    if (!Number.isFinite(val) || val < 0 || val > 1) {
      errors.push({
        field: 'TRADER_STRATEGY_PROMOTION_MIN_MERGED_SCORE',
        message: `Must be between 0 and 1, got "${mergedScoreRaw}". Defaulting to ${thresholds.minMergedScore}.`,
        provided: mergedScoreRaw,
      });
    } else {
      thresholds.minMergedScore = val;
    }
  }

  // ── Min Sharpe ratio ────────────────────────────────────────────────────
  const sharpeRaw = env.TRADER_STRATEGY_PROMOTION_MIN_SHARPE_RATIO;
  if (sharpeRaw !== undefined) {
    const val = Number(sharpeRaw);
    if (!Number.isFinite(val) || val < -10 || val > 10) {
      errors.push({
        field: 'TRADER_STRATEGY_PROMOTION_MIN_SHARPE_RATIO',
        message: `Must be between -10 and 10, got "${sharpeRaw}". Defaulting to ${thresholds.minSharpeRatio}.`,
        provided: sharpeRaw,
      });
    } else {
      thresholds.minSharpeRatio = val;
    }
  }

  // ── Max drawdown (0–100) ────────────────────────────────────────────────
  const ddRaw = env.TRADER_STRATEGY_PROMOTION_MAX_DRAWDOWN;
  if (ddRaw !== undefined) {
    const val = Number(ddRaw);
    if (!Number.isFinite(val) || val < 0 || val > 100) {
      errors.push({
        field: 'TRADER_STRATEGY_PROMOTION_MAX_DRAWDOWN',
        message: `Must be between 0 and 100, got "${ddRaw}". Defaulting to ${thresholds.maxDrawdown}.`,
        provided: ddRaw,
      });
    } else {
      thresholds.maxDrawdown = val;
    }
  }

  // ── Min window count ────────────────────────────────────────────────────
  const winCountRaw = env.TRADER_STRATEGY_PROMOTION_MIN_WINDOW_COUNT;
  if (winCountRaw !== undefined) {
    const val = Number(winCountRaw);
    if (!Number.isFinite(val) || val < 1 || val > 1000) {
      errors.push({
        field: 'TRADER_STRATEGY_PROMOTION_MIN_WINDOW_COUNT',
        message: `Must be between 1 and 1000, got "${winCountRaw}". Defaulting to ${thresholds.minWindowCount}.`,
        provided: winCountRaw,
      });
    } else {
      thresholds.minWindowCount = val;
    }
  }

  // ── Min out-of-sample windows ───────────────────────────────────────────
  const oosRaw = env.TRADER_STRATEGY_PROMOTION_MIN_OUT_OF_SAMPLE_WINDOWS;
  if (oosRaw !== undefined) {
    const val = Number(oosRaw);
    if (!Number.isFinite(val) || val < 0 || val > 1000) {
      errors.push({
        field: 'TRADER_STRATEGY_PROMOTION_MIN_OUT_OF_SAMPLE_WINDOWS',
        message: `Must be between 0 and 1000, got "${oosRaw}". Defaulting to ${thresholds.minOutOfSampleWindows}.`,
        provided: oosRaw,
      });
    } else {
      thresholds.minOutOfSampleWindows = val;
    }
  }

  // ── Min replay fidelity (0–1) ─────────────────────────────────────────
  const fidelityRaw = env.TRADER_STRATEGY_PROMOTION_MIN_REPLAY_FIDELITY;
  if (fidelityRaw !== undefined) {
    const val = Number(fidelityRaw);
    if (!Number.isFinite(val) || val < 0 || val > 1) {
      errors.push({
        field: 'TRADER_STRATEGY_PROMOTION_MIN_REPLAY_FIDELITY',
        message: `Must be between 0 and 1, got "${fidelityRaw}". Defaulting to ${thresholds.minReplayFidelity}.`,
        provided: fidelityRaw,
      });
    } else {
      thresholds.minReplayFidelity = val;
    }
  }

  return thresholds;
}

/**
 * Parse demotion governance threshold configuration from environment variables.
 *
 * All thresholds are optional and fall back to DEFAULT_DEMOTION_THRESHOLDS.
 */
function parseDemotionThresholds(
  env: Record<string, string | undefined>,
  errors: ConfigValidationError[],
): DemotionThresholdConfig {
  const thresholds: DemotionThresholdConfig = { ...DEFAULT_DEMOTION_THRESHOLDS };

  // ── Min Sharpe ratio (demotion) ─────────────────────────────────────────
  const sharpeRaw = env.TRADER_STRATEGY_DEMOTION_MIN_SHARPE_RATIO;
  if (sharpeRaw !== undefined) {
    const val = Number(sharpeRaw);
    if (!Number.isFinite(val) || val < -10 || val > 10) {
      errors.push({
        field: 'TRADER_STRATEGY_DEMOTION_MIN_SHARPE_RATIO',
        message: `Must be between -10 and 10, got "${sharpeRaw}". Defaulting to ${thresholds.minSharpeRatio}.`,
        provided: sharpeRaw,
      });
    } else {
      thresholds.minSharpeRatio = val;
    }
  }

  // ── Max drawdown (demotion) ─────────────────────────────────────────────
  const ddRaw = env.TRADER_STRATEGY_DEMOTION_MAX_DRAWDOWN;
  if (ddRaw !== undefined) {
    const val = Number(ddRaw);
    if (!Number.isFinite(val) || val < 0 || val > 100) {
      errors.push({
        field: 'TRADER_STRATEGY_DEMOTION_MAX_DRAWDOWN',
        message: `Must be between 0 and 100, got "${ddRaw}". Defaulting to ${thresholds.maxDrawdown}.`,
        provided: ddRaw,
      });
    } else {
      thresholds.maxDrawdown = val;
    }
  }

  // ── Min trade count ─────────────────────────────────────────────────────
  const tradeRaw = env.TRADER_STRATEGY_DEMOTION_MIN_TRADE_COUNT;
  if (tradeRaw !== undefined) {
    const val = Number(tradeRaw);
    if (!Number.isFinite(val) || val < 0 || val > 100000) {
      errors.push({
        field: 'TRADER_STRATEGY_DEMOTION_MIN_TRADE_COUNT',
        message: `Must be between 0 and 100000, got "${tradeRaw}". Defaulting to ${thresholds.minTradeCount}.`,
        provided: tradeRaw,
      });
    } else {
      thresholds.minTradeCount = val;
    }
  }

  // ── Halt triggers demotion ──────────────────────────────────────────────
  const haltRaw = env.TRADER_STRATEGY_DEMOTION_HALT_TRIGGERS_DEMOTION;
  if (haltRaw !== undefined) {
    thresholds.haltTriggersDemotion = haltRaw.toLowerCase() !== 'false';
  }

  // ── Min critical risk events ────────────────────────────────────────────
  const eventsRaw = env.TRADER_STRATEGY_DEMOTION_MIN_CRITICAL_RISK_EVENTS;
  if (eventsRaw !== undefined) {
    const val = Number(eventsRaw);
    if (!Number.isFinite(val) || val < 0 || val > 1000) {
      errors.push({
        field: 'TRADER_STRATEGY_DEMOTION_MIN_CRITICAL_RISK_EVENTS',
        message: `Must be between 0 and 1000, got "${eventsRaw}". Defaulting to ${thresholds.minCriticalRiskEvents}.`,
        provided: eventsRaw,
      });
    } else {
      thresholds.minCriticalRiskEvents = val;
    }
  }

  // ── Risk event lookback ms ──────────────────────────────────────────────
  const lookbackRaw = env.TRADER_STRATEGY_DEMOTION_RISK_EVENT_LOOKBACK_MS;
  if (lookbackRaw !== undefined) {
    const val = Number(lookbackRaw);
    if (!Number.isFinite(val) || val < 0 || val > 365 * 24 * 60 * 60 * 1000) {
      errors.push({
        field: 'TRADER_STRATEGY_DEMOTION_RISK_EVENT_LOOKBACK_MS',
        message: `Must be between 0 and 31536000000, got "${lookbackRaw}". Defaulting to ${thresholds.riskEventLookbackMs}.`,
        provided: lookbackRaw,
      });
    } else {
      thresholds.riskEventLookbackMs = val;
    }
  }

  return thresholds;
}

/**
 * Parse overnight research trigger configuration.
 * Returns null when TRADER_OVERNIGHT_ENABLED is not set or not "true".
 */
function parseOvernightConfig(
  env: Record<string, string | undefined>,
  errors: ConfigValidationError[],
): OvernightConfig | null {
  const enabledRaw = env.TRADER_OVERNIGHT_ENABLED?.trim().toLowerCase();
  if (!enabledRaw || enabledRaw === 'false' || enabledRaw === '0') {
    return null;
  }
  if (enabledRaw !== 'true' && enabledRaw !== '1') {
    errors.push({
      field: 'TRADER_OVERNIGHT_ENABLED',
      message: `Must be one of true, false, 1, 0, or unset. Got "${enabledRaw}".`,
      provided: enabledRaw,
    });
    return null;
  }

  const workspacePath = env.TRADER_OVERNIGHT_WORKSPACE_PATH?.trim() ?? './data/artifacts/overnight';
  const researchDbPath = env.TRADER_OVERNIGHT_RESEARCH_DB_PATH?.trim() || undefined;

  const simulateRaw = env.TRADER_OVERNIGHT_SIMULATE_PHASES?.trim().toLowerCase() ?? 'true';
  const simulatePhases = simulateRaw !== 'false' && simulateRaw !== '0';

  const genCountRaw = env.TRADER_OVERNIGHT_SIMULATE_GEN_COUNT ?? '3';
  const simulateGenCount = Number(genCountRaw);
  if (!Number.isFinite(simulateGenCount) || simulateGenCount < 1 || simulateGenCount > 100) {
    errors.push({
      field: 'TRADER_OVERNIGHT_SIMULATE_GEN_COUNT',
      message: `Must be between 1 and 100, got "${genCountRaw}". Defaulting to 3.`,
      provided: genCountRaw,
    });
  }

  const evalCountRaw = env.TRADER_OVERNIGHT_SIMULATE_EVAL_COUNT ?? '5';
  const simulateEvalCount = Number(evalCountRaw);
  if (!Number.isFinite(simulateEvalCount) || simulateEvalCount < 1 || simulateEvalCount > 100) {
    errors.push({
      field: 'TRADER_OVERNIGHT_SIMULATE_EVAL_COUNT',
      message: `Must be between 1 and 100, got "${evalCountRaw}". Defaulting to 5.`,
      provided: evalCountRaw,
    });
  }

  const maxCandidatesRaw = env.TRADER_OVERNIGHT_MAX_ACCEPTED_CANDIDATES;
  let maxAcceptedCandidates: number | undefined;
  if (maxCandidatesRaw !== undefined) {
    const val = Number(maxCandidatesRaw);
    if (!Number.isFinite(val) || val < 1 || val > 100) {
      errors.push({
        field: 'TRADER_OVERNIGHT_MAX_ACCEPTED_CANDIDATES',
        message: `Must be between 1 and 100, got "${maxCandidatesRaw}".`,
        provided: maxCandidatesRaw,
      });
    } else {
      maxAcceptedCandidates = val;
    }
  }

  const maxLlmCallsRaw = env.TRADER_OVERNIGHT_MAX_LLM_CALLS;
  let maxLlmCalls: number | undefined;
  if (maxLlmCallsRaw !== undefined) {
    const val = Number(maxLlmCallsRaw);
    if (!Number.isFinite(val) || val < 1 || val > 1000) {
      errors.push({
        field: 'TRADER_OVERNIGHT_MAX_LLM_CALLS',
        message: `Must be between 1 and 1000, got "${maxLlmCallsRaw}".`,
        provided: maxLlmCallsRaw,
      });
    } else {
      maxLlmCalls = val;
    }
  }

  return {
    enabled: true,
    workspacePath,
    researchDbPath,
    simulatePhases,
    simulateGenCount: Number.isFinite(simulateGenCount) && simulateGenCount >= 1 && simulateGenCount <= 100
      ? simulateGenCount
      : 3,
    simulateEvalCount: Number.isFinite(simulateEvalCount) && simulateEvalCount >= 1 && simulateEvalCount <= 100
      ? simulateEvalCount
      : 5,
    maxAcceptedCandidates,
    maxLlmCalls,
  };
}

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
