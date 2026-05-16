import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UpstoxRestClient } from '../src/upstox/upstox-rest-client.js';
import type { UpstoxHistoricalCandlesResponse } from '../src/upstox/upstox-rest-client.js';

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.TRADER_UPSTOX_TOKEN_PATH;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-upstox-rest-'));
  tempDirs.push(dir);
  return dir;
}

function writeTokenFile(dir: string): void {
  const tokenPath = path.join(dir, 'token.json');
  fs.writeFileSync(tokenPath, JSON.stringify({
    client_id: 'client-123',
    user_id: 'user-456',
    access_token: 'token-abc-123',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    issued_at: new Date().toISOString(),
    message_type: 'token',
  }, null, 2));
  process.env.TRADER_UPSTOX_TOKEN_PATH = tokenPath;
}

const SAMPLE_CANDLES: UpstoxHistoricalCandlesResponse = {
  status: 'success',
  data: {
    candles: [
      [1704067200000, 2180, 2190, 2175, 2185, 12345, 0],
      [1704067260000, 2185, 2195, 2182, 2190, 8765, 0],
      [1704067320000, 2190, 2198, 2188, 2195, 6543, 0],
    ],
  },
};

function installFetchMock(): void {
  globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    // Pass through to localhost (for the MCP server in integration tests)
    if (url.startsWith('http://localhost:')) {
      return originalFetch(input as RequestInfo, _init);
    }

    // Handle profile (needed for other methods, not used here but for completeness)
    if (url === 'https://api.upstox.com/v2/user/profile') {
      return new Response(JSON.stringify({
        status: 'success',
        data: { email: 'user@test.com' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Handle historical candles
    if (url.includes('/v2/historical-candles/')) {
      // Extract the URL path to verify construction in tests
      return new Response(JSON.stringify(SAMPLE_CANDLES), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  }) as typeof globalThis.fetch;
}

function installErrorFetchMock(status: number): void {
  globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url.includes('/v2/historical-candles/')) {
      return new Response(JSON.stringify({ status: 'error', message: 'Request failed' }), {
        status,
        statusText: status === 401 ? 'Unauthorized' : 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  }) as typeof globalThis.fetch;
}

function installUrlCaptureMock(capturedUrl: { value: string }): void {
  globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    capturedUrl.value = url;

    if (url.includes('/v2/historical-candles/')) {
      return new Response(JSON.stringify(SAMPLE_CANDLES), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  }) as typeof globalThis.fetch;
}

describe('UpstoxRestClient.fetchHistoricalCandles', () => {
  it('returns candle data matching UpstoxHistoricalCandlesResponse shape', async () => {
    const dir = makeTempDir();
    writeTokenFile(dir);
    installFetchMock();

    const client = new UpstoxRestClient();
    const result = await client.fetchHistoricalCandles(
      'NSE_EQ|INE002A01018',
      '1minute',
      '2024-01-01',
      '2024-01-02',
    );

    expect(result.status).toBe('success');
    expect(result.data.candles).toBeInstanceOf(Array);
    expect(result.data.candles.length).toBe(3);
    expect(result.data.candles[0]).toBeInstanceOf(Array);
    expect(result.data.candles[0].length).toBe(7);

    // Verify a candle has expected types (timestamp, OHLCV, OI)
    const candle = result.data.candles[0];
    expect(typeof candle[0]).toBe('number'); // timestamp_ms
    expect(typeof candle[1]).toBe('number'); // open
    expect(typeof candle[2]).toBe('number'); // high
    expect(typeof candle[3]).toBe('number'); // low
    expect(typeof candle[4]).toBe('number'); // close
    expect(typeof candle[5]).toBe('number'); // volume
    expect(typeof candle[6]).toBe('number'); // open_interest
  });

  it('constructs URL with instrument key, interval, fromDate, toDate', async () => {
    const dir = makeTempDir();
    writeTokenFile(dir);
    const captured = { value: '' };
    installUrlCaptureMock(captured);

    const client = new UpstoxRestClient();
    await client.fetchHistoricalCandles(
      'NSE_EQ|INE002A01018',
      '1minute',
      '2024-01-01',
      '2024-01-02',
    );

    expect(captured.value).toContain('/v2/historical-candles/');
    expect(captured.value).toContain('NSE_EQ|INE002A01018');
    expect(captured.value).toContain('1minute');
    expect(captured.value).toContain('2024-01-02');
    expect(captured.value).toContain('2024-01-01');
    // Verify the URL pattern: .../historical-candles/{instrument_key}/{interval}/{to_date}/{from_date}
    expect(captured.value).toMatch(
      /\/v2\/historical-candles\/NSE_EQ\|INE002A01018\/1minute\/2024-01-02\/2024-01-01$/,
    );
  });

  it('propagates error for 401 response', async () => {
    const dir = makeTempDir();
    writeTokenFile(dir);
    installErrorFetchMock(401);

    const client = new UpstoxRestClient();
    await expect(
      client.fetchHistoricalCandles('NSE_EQ|INE002A01018', '1minute', '2024-01-01', '2024-01-02'),
    ).rejects.toThrow('Upstox API request failed (401)');
  });

  it('propagates error for 400 response', async () => {
    const dir = makeTempDir();
    writeTokenFile(dir);
    installErrorFetchMock(400);

    const client = new UpstoxRestClient();
    await expect(
      client.fetchHistoricalCandles('NSE_EQ|INE002A01018', '1minute', '2024-01-01', '2024-01-02'),
    ).rejects.toThrow('Upstox API request failed (400)');
  });

  it('handles pipe character in instrument key in URL path', async () => {
    const dir = makeTempDir();
    writeTokenFile(dir);
    const captured = { value: '' };
    installUrlCaptureMock(captured);

    const client = new UpstoxRestClient();
    await client.fetchHistoricalCandles(
      'NSE_FO|INE123456789',
      'day',
      '2024-03-01',
      '2024-03-31',
    );

    expect(captured.value).toContain('NSE_FO|INE123456789');
    expect(captured.value).toMatch(
      /\/v2\/historical-candles\/NSE_FO\|INE123456789\/day\/2024-03-31\/2024-03-01$/,
    );
  });
});
