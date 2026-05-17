import { describe, expect, it, vi, afterEach } from 'vitest';

import { KiteMcpClient } from '../src/integrations/broker/mcp/kite-mcp-client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KiteMcpClient instrument catalog fetch', () => {
  it('does not truncate the MCP instrument request with maxRecords', async () => {
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

    const callTool = vi.spyOn(client as never, '_callTool').mockResolvedValue([
      {
        exchange: 'NSE',
        segment: 'NSE_EQ',
        trading_symbol: 'RELIANCE',
        instrument_key: 'NSE_EQ|INE002A01018',
        exchange_token: '2885',
        instrument_type: 'EQ',
        lot_size: 1,
        tick_size: 10,
        name: 'RELIANCE INDUSTRIES LTD',
      },
    ]);

    const records = await client.fetchInstrumentCatalog();

    expect(records).toHaveLength(1);
    expect(records[0]?.tradingsymbol).toBe('RELIANCE');
    expect(callTool).toHaveBeenCalledWith('get-instruments-bod', {
      exchanges: ['NSE'],
      segments: ['EQ', 'FO'],
      instrumentTypes: ['EQ', 'FUT', 'CE', 'PE'],
    });
  });
});
