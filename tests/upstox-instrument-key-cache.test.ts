import { describe, expect, it, vi, afterEach } from 'vitest';

import { KiteMcpClient } from '../src/integrations/broker/mcp/kite-mcp-client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KiteMcpClient instrument key cache', () => {
  it('retains distinct instrument keys for distinct exchange tokens across a large NSE EQ set', async () => {
    const client = new KiteMcpClient({
      transport: 'mcp',
      mcpUrl: 'http://localhost:8787/mcp',
      mcpTimeoutMs: 1000,
      quotePollIntervalMs: 5000,
      instrumentRefreshIntervalMs: 60_000,
      sessionRefreshIntervalMs: 60_000,
    } as never);

    vi.spyOn(client as never, '_ensureConnected').mockResolvedValue(undefined);
    vi.spyOn(client as never, '_resolveToolName').mockResolvedValue('get-instruments-bod');

    const rows = Array.from({ length: 50 }, (_, i) => ({
      exchange: 'NSE',
      segment: 'NSE_EQ',
      trading_symbol: `SYM${i}`,
      instrument_key: `NSE_EQ|KEY${i}`,
      exchange_token: String(1000 + i),
      instrument_type: 'EQ',
      lot_size: 1,
      tick_size: 10,
      name: `SYM${i}`,
    }));

    vi.spyOn(client as never, '_callTool').mockResolvedValue(rows);

    const records = await client.fetchInstrumentCatalog();

    expect(records).toHaveLength(50);
    expect(client.getCachedInstrumentKeyCount()).toBe(50);
  });
});
