import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UpstoxRestClient } from '../src/upstox/upstox-rest-client.js';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-upstox-quotes-batch-'));
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

describe('UpstoxRestClient.fetchFullMarketQuotes batching', () => {
  it('splits large quote requests into smaller batches and merges results', async () => {
    const dir = makeTempDir();
    writeTokenFile(dir);
    const seen: string[] = [];

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      seen.push(url);
      const parsed = new URL(url);
      const keys = (parsed.searchParams.get('instrument_key') ?? '').split(',').filter(Boolean);
      const data = Object.fromEntries(keys.map((key, index) => [key.replace('|', ':'), {
        instrument_key: key,
        last_price: 100 + index,
      }]));
      return Promise.resolve(new Response(JSON.stringify({ status: 'success', data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }) as typeof globalThis.fetch;

    const client = new UpstoxRestClient();
    const keys = Array.from({ length: 23 }, (_, i) => `NSE_EQ|KEY${i}`);
    const result = await client.fetchFullMarketQuotes(keys);

    expect(seen).toHaveLength(3);
    expect(Object.keys(result.data)).toHaveLength(23);
    expect(new URL(seen[0]!).searchParams.get('instrument_key')?.split(',')).toHaveLength(10);
    expect(new URL(seen[1]!).searchParams.get('instrument_key')?.split(',')).toHaveLength(10);
    expect(new URL(seen[2]!).searchParams.get('instrument_key')?.split(',')).toHaveLength(3);
  });
});
