import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { BrokerConfig } from '../../../types/runtime.js';
import type { InstrumentRecord } from '../types.js';
import type { BrokerSessionMaterial } from '../ports.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const QUOTE_BATCH_SIZE = 200;

const TOOL_ALIASES = {
  session: [
    'get-profile',
    'kite_account_profile',
    'kite_profile',
    'account_profile',
    'profile',
    'account',
    'session',
  ],
  instruments: [
    'get-instruments-bod',
    'search_instruments',
    'kite_instruments',
    'instrument_master',
    'instruments',
    'list_instruments',
  ],
  quotes: [
    'get-full-market-quote',
    'get-full-market-quotes',
    'get_quotes',
    'get_ltp',
    'kite_quotes',
    'kite_quote',
    'quotes',
    'quote',
    'ltp',
  ],
} as const;

type ToolKind = keyof typeof TOOL_ALIASES;

export class KiteMcpClient {
  private readonly _config: BrokerConfig;
  private _client: Client | null = null;
  private _transport: StreamableHTTPClientTransport | null = null;
  private _resolvedTools: Partial<Record<ToolKind, string>> = {};
  private readonly _instrumentKeysByToken = new Map<number, string>();

  constructor(config: BrokerConfig) {
    this._config = config;
  }

  async refreshSession(): Promise<BrokerSessionMaterial | null> {
    await this._ensureConnected();

    const sessionTool = await this._resolveToolName('session');
    if (!sessionTool) {
      return {
        accessToken: 'mcp-session',
        reason: 'MCP transport connected (no explicit session tool exposed)',
      };
    }

    await this._callTool(sessionTool, {});
    return {
      accessToken: 'mcp-session',
      reason: `MCP session probe succeeded via ${sessionTool}`,
    };
  }

  async fetchInstrumentCatalog(): Promise<InstrumentRecord[]> {
    await this._ensureConnected();

    const toolName = await this._resolveToolName('instruments');
    if (!toolName) {
      throw new Error('No MCP instrument tool could be discovered');
    }

    const raw = await this._callTool(toolName, {
      exchanges: ['NSE'],
      segments: ['EQ', 'FO'],
      instrumentTypes: ['EQ', 'FUT', 'CE', 'PE'],
    });

    const records = normalizeInstrumentRecords(raw, this._instrumentKeysByToken);
    if (records.length === 0) {
      throw new Error(`MCP tool "${toolName}" returned zero instrument records`);
    }

    return records;
  }

  hasCachedInstrumentKeys(): boolean {
    return this._instrumentKeysByToken.size > 0;
  }

  getCachedInstrumentKeyCount(): number {
    return this._instrumentKeysByToken.size;
  }

  async fetchQuotes(tokens: number[]): Promise<Array<{ instrumentToken: number; quote: Record<string, unknown> }>> {
    await this._ensureConnected();

    if (tokens.length === 0) return [];

    const toolName = await this._resolveToolName('quotes');
    if (!toolName) {
      throw new Error('No MCP quote tool could be discovered');
    }

    const instrumentKeys = tokens
      .map(token => this._instrumentKeysByToken.get(token))
      .filter((value): value is string => Boolean(value));

    if (process.env.TRADER_UPSTOX_DEBUG_QUOTE_KEYS_PATH?.trim()) {
      const debugPath = process.env.TRADER_UPSTOX_DEBUG_QUOTE_KEYS_PATH.trim();
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.mkdirSync(path.dirname(debugPath), { recursive: true });
      fs.writeFileSync(debugPath, JSON.stringify({ tokens, instrumentKeys }, null, 2));
    }

    if (instrumentKeys.length === 0) {
      throw new Error('No Upstox instrument keys are cached for requested quote tokens');
    }

    const keyToToken = new Map<string, number>();
    for (const token of tokens) {
      const key = this._instrumentKeysByToken.get(token);
      if (!key) continue;
      keyToToken.set(key, token);
      keyToToken.set(key.replace('|', ':'), token);
    }

    const out: Array<{ instrumentToken: number; quote: Record<string, unknown> }> = [];
    for (let index = 0; index < instrumentKeys.length; index += QUOTE_BATCH_SIZE) {
      const batch = instrumentKeys.slice(index, index + QUOTE_BATCH_SIZE);
      const raw = await this._callTool(toolName, {
        instrumentKeys: batch,
        instrument_keys: batch,
        instrument_key: batch.join(','),
      });
      out.push(...normalizeQuotes(raw, batch, keyToToken));
    }

    return out;
  }

  async disconnect(): Promise<void> {
    await this._transport?.close();
    this._transport = null;
    this._client = null;
  }

  private async _ensureConnected(): Promise<void> {
    if (this._client) return;

    const url = this._config.mcpUrl;
    if (!url) {
      throw new Error('TRADER_ZERODHA_MCP_URL is required in MCP mode');
    }

    const requestInit: RequestInit = {};
    if (this._config.mcpAuthToken) {
      requestInit.headers = {
        Authorization: `Bearer ${this._config.mcpAuthToken}`,
      };
    }

    this._transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit,
    });
    this._client = new Client({ name: 'trader-broker-mcp', version: '0.1.0' });
    await this._client.connect(this._transport, { timeout: this._config.mcpTimeoutMs ?? DEFAULT_TIMEOUT_MS });
  }

  private async _resolveToolName(kind: ToolKind): Promise<string | null> {
    const cached = this._resolvedTools[kind];
    if (cached) return cached;

    const override = this._config.mcpTools?.[kind];
    if (override) {
      this._resolvedTools[kind] = override;
      return override;
    }

    const client = this._client;
    if (!client) throw new Error('MCP client not connected');

    const listing = await client.listTools(undefined, { timeout: this._config.mcpTimeoutMs ?? DEFAULT_TIMEOUT_MS });
    const names = new Set((listing.tools ?? []).map(tool => tool.name));

    for (const alias of TOOL_ALIASES[kind]) {
      if (names.has(alias)) {
        this._resolvedTools[kind] = alias;
        return alias;
      }
    }

    return null;
  }

  private async _callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = this._client;
    if (!client) throw new Error('MCP client not connected');

    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: this._config.mcpTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    if ('isError' in result && result.isError) {
      const detail = extractContentPayload(result.content);
      throw new Error(`MCP tool "${name}" returned an error: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }

    if ('structuredContent' in result && result.structuredContent) {
      return result.structuredContent;
    }

    if ('toolResult' in result && result.toolResult) {
      return result.toolResult;
    }

    return extractContentPayload(result.content);
  }
}

function extractContentPayload(content: unknown): unknown {
  if (!Array.isArray(content)) return content;

  const texts = content
    .filter((item): item is { type: string; text?: string } => Boolean(item && typeof item === 'object' && 'type' in item))
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text);

  if (texts.length === 1 && texts[0]) {
    const text = texts[0].trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return texts;
}

function normalizeInstrumentRecords(raw: unknown, tokenToKey: Map<number, string>): InstrumentRecord[] {
  const candidates = extractArray(raw);
  const records: InstrumentRecord[] = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const row = candidate as Record<string, unknown>;

    const exchange = stringOrNull(row.exchange)?.toUpperCase();
    const segment = stringOrNull(row.segment)?.toUpperCase();
    const tradingsymbol = stringOrNull(row.trading_symbol ?? row.tradingsymbol ?? row.symbol)?.toUpperCase();
    const instrumentKey = stringOrNull(row.instrument_key ?? row.instrumentKey ?? row.instrument_token);
    const instrumentToken = numberOrNull(row.exchange_token ?? row.exchangeToken ?? row.token ?? row.instrumentToken);
    const lotSize = numberOrNull(row.lot_size ?? row.lotSize ?? row.minimum_lot) ?? 1;
    const rawTickSize = numberOrNull(row.tick_size ?? row.tickSize) ?? 5;
    const strike = numberOrNull(row.strike_price ?? row.strike);

    if (!exchange || !segment || !tradingsymbol || !instrumentToken || !instrumentKey) continue;
    if (exchange !== 'NSE') continue;
    if (segment !== 'NSE_EQ' && segment !== 'NSE_FO') continue;

    const instrumentType = classifyInstrumentType(segment, String(row.instrument_type ?? ''), tradingsymbol);
    const tickSize = rawTickSize >= 1 ? rawTickSize / 100 : rawTickSize;

    const existingKey = tokenToKey.get(instrumentToken);
    if (existingKey && existingKey !== instrumentKey) {
      continue;
    }
    tokenToKey.set(instrumentToken, instrumentKey);

    records.push({
      exchange: instrumentType === 'EQ' ? 'NSE' : 'NFO',
      tradingsymbol,
      instrumentToken,
      name: stringOrNull(row.name ?? row.short_name) ?? tradingsymbol,
      expiry: normalizeEpochDate(numberOrNull(row.expiry)) ?? normalizeDate(stringOrNull(row.expiry)),
      strike,
      lotSize,
      tickSize,
      instrumentType,
      segment: instrumentType === 'EQ' ? 'NSE' : 'NFO',
      exchangeToken: instrumentToken,
      freezeQuantity: numberOrNull(row.freeze_quantity ?? row.minimum_lot),
    });
  }

  return records;
}

function normalizeQuotes(
  raw: unknown,
  _requestedInstrumentKeys: string[],
  keyToToken: Map<string, number>,
): Array<{ instrumentToken: number; quote: Record<string, unknown> }> {
  const dataMap = isObject(raw)
    ? (isObject((raw as Record<string, unknown>).data)
      ? (raw as Record<string, unknown>).data as Record<string, unknown>
      : raw as Record<string, unknown>)
    : null;

  const out: Array<{ instrumentToken: number; quote: Record<string, unknown> }> = [];

  if (dataMap) {
    for (const [responseKey, value] of Object.entries(dataMap)) {
      if (!isObject(value)) continue;

      const payloadInstrumentKey = stringOrNull(value.instrument_token ?? value.instrument_key);
      const instrumentToken = (payloadInstrumentKey
        ? keyToToken.get(payloadInstrumentKey) ?? keyToToken.get(payloadInstrumentKey.replace('|', ':'))
        : null)
        ?? keyToToken.get(responseKey)
        ?? numberOrNull(value.exchange_token ?? value.exchangeToken)
        ?? extractNumericToken(String(value.instrument_token ?? ''));

      if (!instrumentToken) continue;
      out.push({ instrumentToken, quote: value });
    }
  }

  if (out.length > 0) return out;

  const rows = extractArray(raw);
  for (const row of rows) {
    if (!isObject(row)) continue;
    const instrumentKey = stringOrNull(row.instrument_key ?? row.instrument_token);
    const instrumentToken = (instrumentKey ? keyToToken.get(instrumentKey) ?? keyToToken.get(instrumentKey.replace('|', ':')) : null)
      ?? numberOrNull(row.exchange_token ?? row.exchangeToken ?? row.token)
      ?? extractNumericToken(String(row.instrument_token ?? ''));
    if (!instrumentToken) continue;
    out.push({ instrumentToken, quote: row });
  }

  return out;
}

function extractArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isObject(raw)) {
    for (const key of ['items', 'data', 'records', 'instruments', 'quotes', 'result']) {
      const value = raw[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function normalizeEpochDate(value: number | null): string | null {
  if (!value || !Number.isFinite(value)) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function classifyInstrumentType(segment: string, rawType: string, tradingsymbol: string): 'EQ' | 'FUT' | 'CE' | 'PE' {
  const type = rawType.toUpperCase();
  if (segment === 'NSE_EQ') return 'EQ';
  if (type === 'CE' || tradingsymbol.endsWith('CE')) return 'CE';
  if (type === 'PE' || tradingsymbol.endsWith('PE')) return 'PE';
  return 'FUT';
}

function extractNumericToken(value: string): number | null {
  const match = value.match(/\|(\d+)$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}
