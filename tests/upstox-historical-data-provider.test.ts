// ── UpstoxHistoricalDataProvider tests ──
// Tests the Upstox-backed historical data provider with mock fetch,
// verifying candle-to-BoundedCandidate mapping, bid/ask approximation,
// error resilience (per-instrument failure logged as warning, not abort),
// and metadata contract compliance.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpstoxRestClient } from '../src/upstox/upstox-rest-client.js';
import type { UpstoxHistoricalCandlesResponse } from '../src/upstox/upstox-rest-client.js';
import { UpstoxHistoricalDataProvider } from '../src/replay/upstox-historical-data-provider.js';
import { ReplayFidelity, type ReplayTick } from '../src/replay/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

beforeEach(() => {
  // Restore original fetch before each test
  vi.restoreAllMocks();
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-upstox-provider-'));
  tempDirs.push(dir);
  return dir;
}

function writeTokenFile(dir: string): void {
  const tokenPath = path.join(dir, 'token.json');
  fs.writeFileSync(
    tokenPath,
    JSON.stringify({
      client_id: 'client-123',
      user_id: 'user-456',
      access_token: 'token-abc-123',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      issued_at: new Date().toISOString(),
      message_type: 'token',
    }),
  );
  process.env.TRADER_UPSTOX_TOKEN_PATH = tokenPath;
}

/** Create a temp config JSON with a few instrument records. */
function writeConfigFile(
  dir: string,
  records: Array<{
    instrument_key: string;
    exchange: string;
    trading_symbol: string;
    instrument_type: string;
    lot_size: number;
    tick_size: number;
  }>,
): string {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(records, null, 2));
  return configPath;
}

/** Sample candle fixtures spanning a few minutes. */
const SAMPLE_CANDLES: UpstoxHistoricalCandlesResponse = {
  status: 'success',
  data: {
    candles: [
      [1704067200000, 2180, 2190, 2175, 2185, 12345, 0], // 2024-01-01T00:00:00.000Z
      [1704067260000, 2185, 2195, 2182, 2190, 8765, 0],   // +1min
      [1704067320000, 2190, 2198, 2188, 2195, 6543, 0],   // +2min
    ],
  },
};

/** Second instrument's candles — slightly different prices. */
const SAMPLE_CANDLES_B: UpstoxHistoricalCandlesResponse = {
  status: 'success',
  data: {
    candles: [
      [1704067200000, 3200, 3210, 3190, 3205, 5432, 0],
      [1704067260000, 3205, 3215, 3198, 3210, 4321, 0],
      [1704067320000, 3210, 3220, 3205, 3218, 3210, 0],
    ],
  },
};

const INSTRUMENTS = [
  {
    instrument_key: 'NSE_EQ|INE002A01018',
    exchange: 'NSE',
    trading_symbol: 'RELIANCE',
    instrument_type: 'EQ',
    lot_size: 1,
    tick_size: 0.05,
  },
  {
    instrument_key: 'NSE_EQ|INE009A01021',
    exchange: 'NSE',
    trading_symbol: 'INFY',
    instrument_type: 'EQ',
    lot_size: 1,
    tick_size: 0.05,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UpstoxHistoricalDataProvider', () => {
  describe('constructor and metadata', () => {
    it('has the correct label', () => {
      const dir = makeTempDir();
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const client = new UpstoxRestClient();
      const provider = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath,
        rangeStart: 1704067200000,
        rangeEnd: 1704153600000,
      });

      expect(provider.label).toBe('upstox-v1');
    });

    it('getEffectiveFidelity returns Full', () => {
      const dir = makeTempDir();
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const client = new UpstoxRestClient();
      const provider = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath,
        rangeStart: 1704067200000,
        rangeEnd: 1704153600000,
      });

      const tick: ReplayTick = {
        index: 1,
        timestamp: 1704067200000,
        fidelity: ReplayFidelity.Full,
      };

      expect(provider.getEffectiveFidelity(tick)).toBe(ReplayFidelity.Full);
    });

    it('hasData returns true', () => {
      const dir = makeTempDir();
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const client = new UpstoxRestClient();
      const provider = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath,
        rangeStart: 1704067200000,
        rangeEnd: 1704153600000,
      });

      expect(provider.hasData(1704067200000, 1704153600000)).toBe(true);
    });

    it('getResolutionMetadata returns configured values', () => {
      const dir = makeTempDir();
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const client = new UpstoxRestClient();
      const provider = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath,
        rangeStart: 1704067200000,
        rangeEnd: 1704153600000,
        options: {
          screeningCadenceMinutes: 10,
          executionResolutionMinutes: 1,
        },
      });

      const meta = provider.getResolutionMetadata();
      expect(meta.screeningCadenceMinutes).toBe(10);
      expect(meta.executionResolutionMinutes).toBe(1);
      expect(meta.supportsFineGrainedExecution).toBe(true);
    });

    it('getResolutionMetadata defaults to 5min screening, null execution', () => {
      const dir = makeTempDir();
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const client = new UpstoxRestClient();
      const provider = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath,
        rangeStart: 1704067200000,
        rangeEnd: 1704153600000,
      });

      const meta = provider.getResolutionMetadata();
      expect(meta.screeningCadenceMinutes).toBe(5);
      expect(meta.executionResolutionMinutes).toBeNull();
      expect(meta.supportsFineGrainedExecution).toBe(false);
    });

    it('instrumentCount and fetchFailureCount start at 0', () => {
      const dir = makeTempDir();
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const client = new UpstoxRestClient();
      const provider = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath,
        rangeStart: 1704067200000,
        rangeEnd: 1704153600000,
      });

      expect(provider.instrumentCount).toBe(0);
      expect(provider.fetchFailureCount).toBe(0);
      expect(provider.hasCompletedBulkFetch).toBe(false);
    });
  });

  describe('getCandidates with mock fetch', () => {
    it('returns bounded candidates mapped from candle data', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const client = new UpstoxRestClient();

      // Mock fetch for historical candles
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (input: RequestInfo | URL) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;

          if (url.includes('NSE_EQ|INE002A01018')) {
            return Promise.resolve(
              new Response(JSON.stringify(SAMPLE_CANDLES), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
          }
          if (url.includes('NSE_EQ|INE009A01021')) {
            return Promise.resolve(
              new Response(JSON.stringify(SAMPLE_CANDLES_B), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
          }
          // Profile endpoint (called during fetchHistoricalCandles auth)
          if (url.includes('/v2/user/profile')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({ status: 'success', data: { email: 'test@test.com' } }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              ),
            );
          }

          return Promise.reject(new Error(`Unexpected URL: ${url}`));
        },
      );

      const provider = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath,
        rangeStart: 1704067200000,
        rangeEnd: 1704153600000,
        options: {
          screeningCadenceMinutes: 5,
          executionResolutionMinutes: null,
        },
      });

      // First getCandidates triggers bulk fetch
      const tick: ReplayTick = {
        index: 1,
        timestamp: 1704067260000, // 1 min after start
        fidelity: ReplayFidelity.Full,
      };

      const candidates = await provider.getCandidates(tick);

      // Should have 2 candidates (one per instrument)
      expect(candidates).toHaveLength(2);

      // RELIANCE candle at <= 1704067260000 is index 1: [1704067260000, 2185, 2195, 2182, 2190, 8765, 0]
      const reliance = candidates.find(c => c.tradingsymbol === 'RELIANCE')!;
      expect(reliance).toBeDefined();
      expect(reliance.exchange).toBe('NSE');
      expect(reliance.instrumentToken).toBeNull();
      expect(reliance.side).toBe('buy');
      expect(reliance.lastPrice).toBe(2190); // close
      expect(reliance.bid).toBe(2182); // low (approximation)
      expect(reliance.ask).toBe(2195); // high (approximation)
      expect(reliance.volume).toBe(8765);
      expect(reliance.instrumentType).toBe('EQ');
      expect(reliance.lotSize).toBe(1);
      expect(reliance.tickSize).toBe(0.05);

      // INFY candle at same tick
      const infy = candidates.find(c => c.tradingsymbol === 'INFY')!;
      expect(infy).toBeDefined();
      expect(infy.lastPrice).toBe(3210);
      expect(infy.bid).toBe(3198);
      expect(infy.ask).toBe(3215);
      expect(infy.volume).toBe(4321);

      // Provider metadata should reflect loaded state
      expect(provider.instrumentCount).toBe(2);
      expect(provider.hasCompletedBulkFetch).toBe(true);
      expect(provider.fetchFailureCount).toBe(0);
    });

    it('skips instruments with no candle data for empty response', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const client = new UpstoxRestClient();

      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (input: RequestInfo | URL) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;

          // Return empty candle array for all instruments
          if (url.includes('/v2/historical-candles/')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  status: 'success',
                  data: { candles: [] },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              ),
            );
          }

          if (url.includes('/v2/user/profile')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({ status: 'success', data: { email: 'test@test.com' } }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              ),
            );
          }

          return Promise.reject(new Error(`Unexpected URL: ${url}`));
        },
      );

      const provider = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath,
        rangeStart: 1704067200000,
        rangeEnd: 1704153600000,
      });

      const tick: ReplayTick = {
        index: 1,
        timestamp: 1704067260000,
        fidelity: ReplayFidelity.Full,
      };

      const candidates = await provider.getCandidates(tick);
      expect(candidates).toHaveLength(0);
    });

    it('selects nearest candle with timestamp <= tick timestamp', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const configPath = writeConfigFile(dir, [INSTRUMENTS[0]]); // just RELIANCE
      const client = new UpstoxRestClient();

      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (input: RequestInfo | URL) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;

          if (url.includes('/v2/historical-candles/')) {
            return Promise.resolve(
              new Response(JSON.stringify(SAMPLE_CANDLES), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
          }

          if (url.includes('/v2/user/profile')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({ status: 'success', data: { email: 'test@test.com' } }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              ),
            );
          }

          return Promise.reject(new Error(`Unexpected URL: ${url}`));
        },
      );

      const provider = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath,
        rangeStart: 1704067200000,
        rangeEnd: 1704153600000,
      });

      // Tick at 1704067290000 (3.5 min after start; between candles 1 and 2)
      // Should select candle index 1 (<= 1704067290000)
      let tick: ReplayTick = {
        index: 2,
        timestamp: 1704067290000,
        fidelity: ReplayFidelity.Full,
      };

      let candidates = await provider.getCandidates(tick);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].lastPrice).toBe(2190); // candle[1] close

      // Tick at 1704067350000 (after all candles)
      tick = {
        index: 3,
        timestamp: 1704067350000,
        fidelity: ReplayFidelity.Full,
      };

      candidates = await provider.getCandidates(tick);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].lastPrice).toBe(2195); // candle[2] close (last)

      // Tick before any candle (no data)
      tick = {
        index: 0,
        timestamp: 1704067100000,
        fidelity: ReplayFidelity.Full,
      };

      candidates = await provider.getCandidates(tick);
      expect(candidates).toHaveLength(0);
    });
  });

  describe('error resilience', () => {
    it('continues with remaining instruments when one fetch fails', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const client = new UpstoxRestClient();

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      let fetchCallCount = 0;

      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (input: RequestInfo | URL) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;

          fetchCallCount++;

          // Make INFY (second instrument) fail
          if (url.includes('NSE_EQ|INE009A01021')) {
            return Promise.reject(new Error('Network error'));
          }

          if (url.includes('/v2/historical-candles/')) {
            return Promise.resolve(
              new Response(JSON.stringify(SAMPLE_CANDLES), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
          }

          if (url.includes('/v2/user/profile')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({ status: 'success', data: { email: 'test@test.com' } }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              ),
            );
          }

          return Promise.reject(new Error(`Unexpected URL: ${url}`));
        },
      );

      const provider = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath,
        rangeStart: 1704067200000,
        rangeEnd: 1704153600000,
      });

      const tick: ReplayTick = {
        index: 1,
        timestamp: 1704067260000,
        fidelity: ReplayFidelity.Full,
      };

      const candidates = await provider.getCandidates(tick);

      // Should still get the RELIANCE candidate
      expect(candidates).toHaveLength(1);
      expect(candidates[0].tradingsymbol).toBe('RELIANCE');

      // Should have recorded 1 failure
      expect(provider.fetchFailureCount).toBe(1);
      expect(provider.hasCompletedBulkFetch).toBe(true);

      // Should have logged a warning about the failure
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch candles for NSE_EQ|INE009A01021'),
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('config loading', () => {
    it('throws if config file is not a valid JSON array', async () => {
      const dir = makeTempDir();
      const configPath = path.join(dir, 'bad-config.json');
      fs.writeFileSync(configPath, '{"not": "an array"}');

      const client = new UpstoxRestClient();
      const provider = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath,
        rangeStart: 1704067200000,
        rangeEnd: 1704153600000,
      });

      const tick: ReplayTick = {
        index: 1,
        timestamp: 1704067200000,
        fidelity: ReplayFidelity.Full,
      };

      await expect(provider.getCandidates(tick)).rejects.toThrow(
        'did not contain a JSON array',
      );
    });

    it('throws if config file does not exist', async () => {
      const client = new UpstoxRestClient();
      const provider = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath: '/nonexistent/path.json',
        rangeStart: 1704067200000,
        rangeEnd: 1704153600000,
      });

      const tick: ReplayTick = {
        index: 1,
        timestamp: 1704067200000,
        fidelity: ReplayFidelity.Full,
      };

      await expect(provider.getCandidates(tick)).rejects.toThrow();
    });
  });
});
