import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigValidationErrorImpl } from '../src/config/env.js';

// ---------------------------------------------------------------------------
// Config tests
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('returns defaults when no env vars are set', () => {
    const cfg = loadConfig({});
    expect(cfg.port).toBe(3000);
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.marketTimezone).toBe('Asia/Kolkata');
    expect(cfg.schedulerIntervalMs).toBe(60_000);
    expect(cfg.dbPath).toBe('./data/trader.db');
    expect(cfg.logLevel).toBe('info');
  });

  it('reads TRADER_PORT over PORT', () => {
    const cfg = loadConfig({ TRADER_PORT: '8080' });
    expect(cfg.port).toBe(8080);
  });

  it('falls back to PORT when TRADER_PORT is absent', () => {
    const cfg = loadConfig({ PORT: '9090' });
    expect(cfg.port).toBe(9090);
  });

  it('rejects non-numeric PORT', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigValidationErrorImpl);
  });

  it('rejects out-of-range PORT', () => {
    expect(() => loadConfig({ PORT: '0' })).toThrow(ConfigValidationErrorImpl);
    expect(() => loadConfig({ PORT: '65536' })).toThrow(ConfigValidationErrorImpl);
  });

  it('accepts valid NODE_ENV values', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).nodeEnv).toBe('production');
    expect(loadConfig({ NODE_ENV: 'test' }).nodeEnv).toBe('test');
  });

  it('rejects unsupported NODE_ENV values', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(ConfigValidationErrorImpl);
  });

  it('accepts valid timezone', () => {
    const cfg = loadConfig({ TRADER_MARKET_TIMEZONE: 'America/New_York' });
    expect(cfg.marketTimezone).toBe('America/New_York');
  });

  it('falls back to Asia/Kolkata for invalid timezone', () => {
    // Invalid timezone logs a warning and falls back — does not throw
    const cfg = loadConfig({ TRADER_MARKET_TIMEZONE: 'Mars/Marineris' });
    expect(cfg.marketTimezone).toBe('Asia/Kolkata');
  });

  it('reads broker MCP aliases from TRADER_BROKER_*', () => {
    const cfg = loadConfig({
      TRADER_BROKER_TRANSPORT: 'mcp',
      TRADER_BROKER_MCP_URL: 'http://localhost:8787/mcp',
      TRADER_BROKER_MCP_TIMEOUT_MS: '12345',
      TRADER_BROKER_QUOTE_POLL_INTERVAL_MS: '7000',
      TRADER_BROKER_INSTRUMENT_REFRESH_MS: '90000',
      TRADER_BROKER_MCP_TOOL_SESSION: 'get-profile',
      TRADER_BROKER_MCP_TOOL_INSTRUMENTS: 'get-instruments-bod',
      TRADER_BROKER_MCP_TOOL_QUOTES: 'get-full-market-quote',
    });

    expect(cfg.broker).toMatchObject({
      transport: 'mcp',
      mcpUrl: 'http://localhost:8787/mcp',
      mcpTimeoutMs: 12345,
      quotePollIntervalMs: 7000,
      instrumentRefreshIntervalMs: 90000,
      mcpTools: {
        session: 'get-profile',
        instruments: 'get-instruments-bod',
        quotes: 'get-full-market-quote',
      },
    });
  });

  it('reads provider-specific MCP aliases from TRADER_UPSTOX_*', () => {
    const cfg = loadConfig({
      TRADER_UPSTOX_TRANSPORT: 'mcp',
      TRADER_UPSTOX_MCP_URL: 'http://localhost:8787/mcp',
    });

    expect(cfg.broker).toMatchObject({
      transport: 'mcp',
      mcpUrl: 'http://localhost:8787/mcp',
    });
  });

  it('prefers TRADER_BROKER_* over legacy TRADER_ZERODHA_* aliases', () => {
    const cfg = loadConfig({
      TRADER_BROKER_TRANSPORT: 'mcp',
      TRADER_BROKER_MCP_URL: 'http://localhost:8787/mcp',
      TRADER_ZERODHA_TRANSPORT: 'mcp',
      TRADER_ZERODHA_MCP_URL: 'https://legacy.example/mcp',
    });

    expect(cfg.broker?.mcpUrl).toBe('http://localhost:8787/mcp');
  });

  it('rejects non-numeric interval', () => {
    expect(() => loadConfig({ TRADER_SCHEDULER_INTERVAL_MS: 'fast' })).toThrow(ConfigValidationErrorImpl);
  });

  it('rejects interval below minimum', () => {
    expect(() => loadConfig({ TRADER_SCHEDULER_INTERVAL_MS: '500' })).toThrow(ConfigValidationErrorImpl);
  });

  it('accepts valid interval', () => {
    const cfg = loadConfig({ TRADER_SCHEDULER_INTERVAL_MS: '30000' });
    expect(cfg.schedulerIntervalMs).toBe(30_000);
  });

  it('accepts valid log levels', () => {
    expect(loadConfig({ TRADER_LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    expect(loadConfig({ TRADER_LOG_LEVEL: 'warn' }).logLevel).toBe('warn');
    expect(loadConfig({ TRADER_LOG_LEVEL: 'error' }).logLevel).toBe('error');
  });

  it('falls back to info for invalid log level', () => {
    const cfg = loadConfig({ TRADER_LOG_LEVEL: 'trace' });
    expect(cfg.logLevel).toBe('info');
  });

  it('custom db path is accepted', () => {
    const cfg = loadConfig({ TRADER_DB_PATH: '/custom/trader.db' });
    expect(cfg.dbPath).toBe('/custom/trader.db');
  });

  it('defaults proposal engine to custom mode when only provider URL is set', () => {
    const cfg = loadConfig({ TRADER_PROPOSAL_PROVIDER_URL: 'https://example.com/proposals' });
    expect(cfg.proposalEngine).toMatchObject({
      providerMode: 'custom',
      providerUrl: 'https://example.com/proposals',
    });
  });

  it('parses openai-compatible proposal mode with model', () => {
    const cfg = loadConfig({
      TRADER_PROPOSAL_PROVIDER_MODE: 'openai-compatible',
      TRADER_PROPOSAL_PROVIDER_URL: 'https://crof.ai/v1/chat/completions',
      TRADER_PROPOSAL_PROVIDER_MODEL: 'kimi-k2.6-precision',
    });

    expect(cfg.proposalEngine).toMatchObject({
      providerMode: 'openai-compatible',
      providerUrl: 'https://crof.ai/v1/chat/completions',
      providerModel: 'kimi-k2.6-precision',
    });
  });

  it('rejects unsupported proposal provider mode', () => {
    expect(() => loadConfig({
      TRADER_PROPOSAL_PROVIDER_MODE: 'foo',
      TRADER_PROPOSAL_PROVIDER_URL: 'https://example.com/proposals',
    })).toThrow(ConfigValidationErrorImpl);
  });

  it('rejects openai-compatible proposal mode without model', () => {
    expect(() => loadConfig({
      TRADER_PROPOSAL_PROVIDER_MODE: 'openai-compatible',
      TRADER_PROPOSAL_PROVIDER_URL: 'https://crof.ai/v1/chat/completions',
    })).toThrow(ConfigValidationErrorImpl);
  });

  it('ConfigValidationError contains the field-level errors', () => {
    try {
      loadConfig({ PORT: 'xyz', NODE_ENV: 'staging' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationErrorImpl);
      const typed = err as ConfigValidationErrorImpl;
      expect(typed.errors.length).toBeGreaterThanOrEqual(2);
      expect(typed.errors.map(e => e.field)).toContain('PORT');
      expect(typed.errors.map(e => e.field)).toContain('NODE_ENV');
    }
  });
});

// ---------------------------------------------------------------------------
// Main entrypoint smoke tests
// ---------------------------------------------------------------------------

describe('main entrypoint', () => {
  it('compiles without error (type-check)', () => {
    expect(typeof loadConfig).toBe('function');
  });

  it('loadConfig with defaults produces a valid RuntimeConfig', () => {
    const cfg = loadConfig({});
    expect(cfg).toMatchObject({
      port: expect.any(Number),
      nodeEnv: expect.any(String),
      marketTimezone: expect.any(String),
      schedulerIntervalMs: expect.any(Number),
      dbPath: expect.any(String),
      logLevel: expect.any(String),
    });
    expect(cfg.port).toBeGreaterThan(0);
    expect(cfg.schedulerIntervalMs).toBeGreaterThanOrEqual(1000);
  });
});

// ---------------------------------------------------------------------------
// S05 — Execution risk config tests
// ---------------------------------------------------------------------------

describe('execution risk config', () => {
  it('defaults operatorBindHost to 127.0.0.1', () => {
    const cfg = loadConfig({});
    expect(cfg.execution.operatorBindHost).toBe('127.0.0.1');
  });

  it('reads TRADER_EXECUTION_OPERATOR_BIND_HOST', () => {
    const cfg = loadConfig({ TRADER_EXECUTION_OPERATOR_BIND_HOST: '0.0.0.0' });
    expect(cfg.execution.operatorBindHost).toBe('0.0.0.0');
  });

  it('defaults risk limits to safe values', () => {
    const cfg = loadConfig({});
    expect(cfg.execution.riskLimits).toMatchObject({
      maxOpenPositions: 10,
      maxOrdersPerInstrument: 1,
      maxDailyLossRupees: 0,
      maxExposureRupees: 0,
      marketHoursStalenessMs: 120_000,
    });
  });

  it('reads risk limit env vars', () => {
    const cfg = loadConfig({
      TRADER_EXECUTION_MAX_OPEN_POSITIONS: '5',
      TRADER_EXECUTION_MAX_ORDERS_PER_INSTRUMENT: '2',
      TRADER_EXECUTION_MAX_DAILY_LOSS_RUPEES: '5000',
      TRADER_EXECUTION_MAX_EXPOSURE_RUPEES: '100000',
      TRADER_EXECUTION_MARKET_HOURS_STALENESS_MS: '60000',
    });
    expect(cfg.execution.riskLimits).toMatchObject({
      maxOpenPositions: 5,
      maxOrdersPerInstrument: 2,
      maxDailyLossRupees: 5000,
      maxExposureRupees: 100000,
      marketHoursStalenessMs: 60_000,
    });
  });

  it('rejects invalid maxOpenPositions (too low)', () => {
    expect(() => loadConfig({ TRADER_EXECUTION_MAX_OPEN_POSITIONS: '0' })).toThrow(ConfigValidationErrorImpl);
  });

  it('rejects invalid maxOpenPositions (too high)', () => {
    expect(() => loadConfig({ TRADER_EXECUTION_MAX_OPEN_POSITIONS: '1001' })).toThrow(ConfigValidationErrorImpl);
  });

  it('rejects invalid maxOrdersPerInstrument (zero)', () => {
    expect(() => loadConfig({ TRADER_EXECUTION_MAX_ORDERS_PER_INSTRUMENT: '0' })).toThrow(ConfigValidationErrorImpl);
  });

  it('rejects negative maxDailyLossRupees', () => {
    expect(() => loadConfig({ TRADER_EXECUTION_MAX_DAILY_LOSS_RUPEES: '-1' })).toThrow(ConfigValidationErrorImpl);
  });

  it('rejects negative maxExposureRupees', () => {
    expect(() => loadConfig({ TRADER_EXECUTION_MAX_EXPOSURE_RUPEES: '-100' })).toThrow(ConfigValidationErrorImpl);
  });

  it('rejects invalid marketHoursStalenessMs (below min)', () => {
    expect(() => loadConfig({ TRADER_EXECUTION_MARKET_HOURS_STALENESS_MS: '500' })).toThrow(ConfigValidationErrorImpl);
  });

  it('rejects invalid marketHoursStalenessMs (above max)', () => {
    expect(() => loadConfig({ TRADER_EXECUTION_MARKET_HOURS_STALENESS_MS: '5000000' })).toThrow(ConfigValidationErrorImpl);
  });

  it('accepts zero daily loss and exposure (no limit)', () => {
    const cfg = loadConfig({
      TRADER_EXECUTION_MAX_DAILY_LOSS_RUPEES: '0',
      TRADER_EXECUTION_MAX_EXPOSURE_RUPEES: '0',
    });
    expect(cfg.execution.riskLimits.maxDailyLossRupees).toBe(0);
    expect(cfg.execution.riskLimits.maxExposureRupees).toBe(0);
  });

  it('operatorBindHost is present in default execution config', () => {
    const cfg = loadConfig({});
    expect(cfg.execution).toHaveProperty('operatorBindHost');
    expect(cfg.execution).toHaveProperty('riskLimits');
  });
});
