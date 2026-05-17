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
          if (url.includes('/v2/historical-candle/')) {
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

          if (url.includes('/v2/historical-candle/')) {
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

          if (url.includes('/v2/historical-candle/')) {
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

  describe('maxInstruments', () => {
    it('limits the number of instruments loaded from config', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const configPath = writeConfigFile(dir, [
        ...INSTRUMENTS,
        {
          instrument_key: 'NSE_EQ|INE090A01021',
          exchange: 'NSE',
          trading_symbol: 'TCS',
          instrument_type: 'EQ',
          lot_size: 1,
          tick_size: 0.05,
        },
      ]);
      const client = new UpstoxRestClient();

      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (input: RequestInfo | URL) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;

          if (url.includes('/v2/historical-candle/')) {
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
        maxInstruments: 1,
      });

      const tick: ReplayTick = {
        index: 1,
        timestamp: 1704067260000,
        fidelity: ReplayFidelity.Full,
      };

      const candidates = await provider.getCandidates(tick);

      // Should only have 1 candidate (limited by maxInstruments)
      expect(candidates).toHaveLength(1);
      expect(provider.instrumentCount).toBe(1);
    });
  });

  describe('candle cache', () => {
    it('writes JSON cache files after first fetch with cacheDir', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const cacheDir = path.join(dir, 'cache');
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
        cacheDir,
      });

      const tick: ReplayTick = {
        index: 1,
        timestamp: 1704067260000,
        fidelity: ReplayFidelity.Full,
      };

      const candidates = await provider.getCandidates(tick);
      expect(candidates).toHaveLength(2);

      // Verify cache files exist on disk with sanitized names
      const file1 = path.join(cacheDir, 'NSE_EQ_INE002A01018.json');
      const file2 = path.join(cacheDir, 'NSE_EQ_INE009A01021.json');
      expect(fs.existsSync(file1)).toBe(true);
      expect(fs.existsSync(file2)).toBe(true);

      // Verify cache file content is valid JSON and matches candles
      const cached1 = JSON.parse(fs.readFileSync(file1, 'utf8'));
      expect(cached1).toEqual(SAMPLE_CANDLES.data.candles);

      const cached2 = JSON.parse(fs.readFileSync(file2, 'utf8'));
      expect(cached2).toEqual(SAMPLE_CANDLES_B.data.candles);
    });

    it('reads from cache on second provider instance (no API calls for cached instruments)', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const cacheDir = path.join(dir, 'cache');
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const client = new UpstoxRestClient();

      // First instance: fetch from API, write cache
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (input: RequestInfo | URL) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;

          if (url.includes('/v2/historical-candle/')) {
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

      const provider1 = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath,
        rangeStart: 1704067200000,
        rangeEnd: 1704153600000,
        cacheDir,
      });

      const tick: ReplayTick = {
        index: 1,
        timestamp: 1704067260000,
        fidelity: ReplayFidelity.Full,
      };

      await provider1.getCandidates(tick);

      // Reset the spy counter for the second provider
      const historicalCandleUrls = fetchSpy.mock.calls.filter(
        call => String(call[0]).includes('/v2/historical-candle/'),
      ).length;
      expect(historicalCandleUrls).toBe(2); // 2 API calls for 2 instruments

      // Second instance: should read from cache, no API calls
      fetchSpy.mockClear();

      const provider2 = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath,
        rangeStart: 1704067200000,
        rangeEnd: 1704153600000,
        cacheDir,
      });

      const candidates2 = await provider2.getCandidates(tick);
      expect(candidates2).toHaveLength(2);

      // Verify NO historical-candle API calls were made
      const historicalCallsAfterCache = fetchSpy.mock.calls.filter(
        call => String(call[0]).includes('/v2/historical-candle/'),
      ).length;
      expect(historicalCallsAfterCache).toBe(0);
    });

    it('handles partial cache: cached instruments skip API, uncached ones fetch and save', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const cacheDir = path.join(dir, 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });

      // Pre-write cache for RELIANCE only
      const relianceCachePath = path.join(cacheDir, 'NSE_EQ_INE002A01018.json');
      fs.writeFileSync(relianceCachePath, JSON.stringify(SAMPLE_CANDLES.data.candles));

      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const client = new UpstoxRestClient();

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (input: RequestInfo | URL) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;

          // Only INFY should be fetched via API
          if (url.includes('NSE_EQ|INE009A01021')) {
            return Promise.resolve(
              new Response(JSON.stringify(SAMPLE_CANDLES_B), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
          }
          if (url.includes('NSE_EQ|INE002A01018')) {
            return Promise.reject(new Error('Should not fetch cached instrument'));
          }

          if (url.includes('/v2/historical-candle/')) {
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
        cacheDir,
      });

      const tick: ReplayTick = {
        index: 1,
        timestamp: 1704067260000,
        fidelity: ReplayFidelity.Full,
      };

      const candidates = await provider.getCandidates(tick);
      expect(candidates).toHaveLength(2);

      // Only INFY should have made historical-candle API calls
      const historicalCalls = fetchSpy.mock.calls.filter(
        call => String(call[0]).includes('/v2/historical-candle/'),
      ).length;
      expect(historicalCalls).toBe(1);

      // Verify INFY was also cached to disk
      const infyCachePath = path.join(cacheDir, 'NSE_EQ_INE009A01021.json');
      expect(fs.existsSync(infyCachePath)).toBe(true);
    });

    it('falls back to API fetch when cache file is corrupt', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const cacheDir = path.join(dir, 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });

      // Write corrupt cache file
      const corruptPath = path.join(cacheDir, 'NSE_EQ_INE002A01018.json');
      fs.writeFileSync(corruptPath, 'not valid json {{');

      // Write valid cache for INFY (should work normally)
      const infyCachePath = path.join(cacheDir, 'NSE_EQ_INE009A01021.json');
      fs.writeFileSync(infyCachePath, JSON.stringify(SAMPLE_CANDLES_B.data.candles));

      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const client = new UpstoxRestClient();

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (input: RequestInfo | URL) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;

          // RELIANCE should still be fetched since its cache is corrupt
          if (url.includes('/v2/historical-candle/')) {
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
        cacheDir,
      });

      const tick: ReplayTick = {
        index: 1,
        timestamp: 1704067260000,
        fidelity: ReplayFidelity.Full,
      };

      const candidates = await provider.getCandidates(tick);
      expect(candidates).toHaveLength(2);

      // Should have logged a warning about corrupt cache
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cache read failed for NSE_EQ|INE002A01018'),
      );

      // RELIANCE data should still be fetched via API (1 call for RELIANCE, INFY from cache)
      const historicalCalls = fetchSpy.mock.calls.filter(
        call => String(call[0]).includes('/v2/historical-candle/'),
      ).length;
      expect(historicalCalls).toBe(1);

      // Corrupt cache file should have been overwritten with valid data
      const overwritten = JSON.parse(fs.readFileSync(corruptPath, 'utf8'));
      expect(overwritten).toEqual(SAMPLE_CANDLES.data.candles);

      consoleWarnSpy.mockRestore();
    });

    it('does not use cache when cacheDir is not provided', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const client = new UpstoxRestClient();

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (input: RequestInfo | URL) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;

          if (url.includes('/v2/historical-candle/')) {
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
      expect(candidates).toHaveLength(2);

      // All fetches should be API calls (no cache)
      const historicalCalls = fetchSpy.mock.calls.filter(
        call => String(call[0]).includes('/v2/historical-candle/'),
      ).length;
      expect(historicalCalls).toBe(2);
    });

    it('sanitizes instrument keys with pipe characters in cache filenames', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const cacheDir = path.join(dir, 'cache');
      const configPath = writeConfigFile(dir, [
        {
          instrument_key: 'NSE_FO|12345',
          exchange: 'NSE',
          trading_symbol: 'NIFTY_FUT',
          instrument_type: 'FUT',
          lot_size: 50,
          tick_size: 5,
        },
      ]);
      const client = new UpstoxRestClient();

      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (input: RequestInfo | URL) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;

          if (url.includes('/v2/historical-candle/')) {
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
        cacheDir,
      });

      const tick: ReplayTick = {
        index: 1,
        timestamp: 1704067260000,
        fidelity: ReplayFidelity.Full,
      };

      const candidates = await provider.getCandidates(tick);
      expect(candidates).toHaveLength(1);

      // Verify cache file uses sanitized name (| replaced with _)
      const cacheFilePath = path.join(cacheDir, 'NSE_FO_12345.json');
      expect(fs.existsSync(cacheFilePath)).toBe(true);
    });
  });

  describe('chunked historical fetches', () => {
    it('splits long ranges into multiple historical-candle requests and merges them', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const configPath = writeConfigFile(dir, [INSTRUMENTS[0]]);
      const client = new UpstoxRestClient();

      const calls: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

        if (url.includes('/v2/historical-candle/')) {
          calls.push(url);
          const isFirstChunk = url.includes('/2026-04-28/2026-04-01');
          return Promise.resolve(new Response(JSON.stringify({
            status: 'success',
            data: {
              candles: isFirstChunk
                ? [['2026-04-28T15:29:00+05:30', 100, 101, 99, 100.5, 10, 0]]
                : [['2026-05-16T15:29:00+05:30', 110, 111, 109, 110.5, 12, 0]],
            },
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }

        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const provider = new UpstoxHistoricalDataProvider({
        restClient: client,
        configPath,
        rangeStart: Date.parse('2026-04-01T00:00:00.000Z'),
        rangeEnd: Date.parse('2026-05-16T23:59:59.999Z'),
      });

      const earlyTick: ReplayTick = {
        index: 1,
        timestamp: Date.parse('2026-04-28T12:00:00.000Z'),
        fidelity: ReplayFidelity.Full,
      };
      const lateTick: ReplayTick = {
        index: 2,
        timestamp: Date.parse('2026-05-16T12:00:00.000Z'),
        fidelity: ReplayFidelity.Full,
      };

      const earlyCandidates = await provider.getCandidates(earlyTick);
      const lateCandidates = await provider.getCandidates(lateTick);

      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('/2026-04-28/2026-04-01');
      expect(calls[1]).toContain('/2026-05-16/2026-04-29');
      expect(earlyCandidates).toHaveLength(1);
      expect(lateCandidates).toHaveLength(1);
      expect(earlyCandidates[0].lastPrice).toBe(100.5);
      expect(lateCandidates[0].lastPrice).toBe(110.5);
    });
  });
});
