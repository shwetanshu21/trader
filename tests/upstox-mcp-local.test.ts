import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createUpstoxMcpLocalServer, type UpstoxMcpLocalServer } from '../src/upstox/mcp-local-server.js';
import { KiteMcpClient } from '../src/integrations/broker/mcp/kite-mcp-client.js';

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

let server: UpstoxMcpLocalServer | null = null;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  globalThis.fetch = originalFetch;
  delete process.env.TRADER_UPSTOX_TOKEN_PATH;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-upstox-mcp-'));
  tempDirs.push(dir);
  return dir;
}

function writeTokenFile(dir: string): string {
  const tokenPath = path.join(dir, 'token.json');
  fs.writeFileSync(tokenPath, JSON.stringify({
    client_id: 'client-123',
    user_id: 'user-456',
    access_token: 'token-abc-123',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    issued_at: new Date().toISOString(),
    message_type: 'token',
  }, null, 2));
  return tokenPath;
}

function installFetchMock(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url.startsWith('http://localhost:')) {
      return originalFetch(input as RequestInfo, init);
    }

    if (url === 'https://api.upstox.com/v2/user/profile') {
      return new Response(JSON.stringify({
        status: 'success',
        data: {
          email: 'user@example.com',
          exchanges: ['NSE'],
          products: ['CNC'],
          broker: 'UPSTOX',
          user_id: 'user-456',
          user_name: 'Trader User',
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url === 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz') {
      const payload = [
        {
          segment: 'NSE_EQ',
          name: 'RELIANCE INDUSTRIES',
          exchange: 'NSE',
          instrument_type: 'EQ',
          instrument_key: 'NSE_EQ|INE002A01018',
          lot_size: 1,
          exchange_token: '2885',
          tick_size: 5,
          trading_symbol: 'RELIANCE',
          short_name: 'RELIANCE',
        },
        {
          segment: 'NSE_EQ',
          name: 'INFOSYS LIMITED',
          exchange: 'NSE',
          instrument_type: 'EQ',
          instrument_key: 'NSE_EQ|INE009A01021',
          lot_size: 1,
          exchange_token: '1594',
          tick_size: 5,
          trading_symbol: 'INFY',
          short_name: 'INFY',
        },
      ];
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
      return new Response(gz, { status: 200 });
    }

    if (url.startsWith('https://api.upstox.com/v2/market-quote/quotes?')) {
      return new Response(JSON.stringify({
        status: 'success',
        data: {
          'NSE_EQ:RELIANCE': {
            instrument_token: 'NSE_EQ|INE002A01018',
            symbol: 'RELIANCE',
            last_price: 3001.5,
            volume: 123456,
            oi: 0,
            net_change: 12.5,
            ohlc: {
              open: 2980,
              high: 3010,
              low: 2972,
              close: 2989,
            },
            depth: {
              buy: [{ quantity: 10, price: 3001.4, orders: 1 }],
              sell: [{ quantity: 12, price: 3001.6, orders: 1 }],
            },
            last_trade_time: String(Date.now()),
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.startsWith('https://api.upstox.com/v2/historical-candle/')) {
      return new Response(JSON.stringify({
        status: 'success',
        data: {
          candles: [
            [1700000000000, 150.5, 152.0, 149.8, 151.2, 10000, 0],
            [1700000060000, 151.2, 153.5, 150.9, 152.8, 15000, 0],
            [1700000120000, 152.8, 154.0, 152.0, 153.5, 12000, 0],
          ],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  }) as typeof globalThis.fetch;
}

describe('upstox local MCP bridge', () => {
  it('supports the runtime MCP client contract', async () => {
    const dir = makeTempDir();
    const tokenPath = writeTokenFile(dir);
    process.env.TRADER_UPSTOX_TOKEN_PATH = tokenPath;
    installFetchMock();

    server = createUpstoxMcpLocalServer({
      port: 0,
      statusPath: path.join(dir, 'status.json'),
      logger: { log() {}, warn() {}, error() {} },
    });
    await server.start();

    const client = new KiteMcpClient({
      transport: 'mcp',
      mcpUrl: `http://localhost:${server.port}/mcp`,
      mcpTimeoutMs: 10_000,
      quotePollIntervalMs: 5_000,
      instrumentRefreshIntervalMs: 60_000,
      sessionRefreshIntervalMs: 60_000,
    });

    const material = await client.refreshSession();
    expect(material?.accessToken).toBe('mcp-session');

    const records = await client.fetchInstrumentCatalog();
    expect(records.length).toBe(2);
    expect(records[0]?.tradingsymbol).toBe('RELIANCE');
    expect(records[0]?.instrumentToken).toBe(2885);

    const quotes = await client.fetchQuotes([2885]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.instrumentToken).toBe(2885);
    expect(quotes[0]?.quote.last_price).toBe(3001.5);

    await client.disconnect();

    const status = server.getStatus();
    expect(status.lastFailure).toBeNull();
    expect(status.lastSuccess?.tool).toBe('get-full-market-quote');
    expect(status.recentCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('exposes get-historical-candles via MCP protocol', async () => {
    const dir = makeTempDir();
    const tokenPath = writeTokenFile(dir);
    process.env.TRADER_UPSTOX_TOKEN_PATH = tokenPath;
    installFetchMock();

    server = createUpstoxMcpLocalServer({
      port: 0,
      statusPath: path.join(dir, 'status.json'),
      logger: { log() {}, warn() {}, error() {} },
    });
    await server.start();

    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${server.port}/mcp`));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport, { timeout: 10_000 });

    const result = await client.callTool({
      name: 'get-historical-candles',
      arguments: {
        instrumentKey: 'NSE_EQ|INE002A01018',
        interval: '1minute',
        fromDate: '2024-01-01',
        toDate: '2024-01-02',
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    const data = JSON.parse(result.content[0].text as string);
    expect(data.status).toBe('success');
    expect(data.data.candles).toHaveLength(3);
    expect(data.data.candles[0]).toEqual([1700000000000, 150.5, 152.0, 149.8, 151.2, 10000, 0]);
    expect(data.data.candles[1]).toEqual([1700000060000, 151.2, 153.5, 150.9, 152.8, 15000, 0]);
    expect(data.data.candles[2]).toEqual([1700000120000, 152.8, 154.0, 152.0, 153.5, 12000, 0]);

    await client.close();

    const status = server.getStatus();
    expect(status.lastFailure).toBeNull();
    expect(status.recentCalls.some(c => c.tool === 'get-historical-candles' && c.error === null)).toBe(true);
  });
});
