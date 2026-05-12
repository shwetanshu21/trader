import zlib from 'node:zlib';

import { readUpstoxTokenRecord } from './token-store.js';

const UPSTOX_API_BASE_URL = 'https://api.upstox.com';
const UPSTOX_PROFILE_URL = `${UPSTOX_API_BASE_URL}/v2/user/profile`;
const UPSTOX_FULL_QUOTES_URL = `${UPSTOX_API_BASE_URL}/v2/market-quote/quotes`;
const UPSTOX_INSTRUMENTS_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INSTRUMENT_CACHE_MS = 60 * 60 * 1000;

export interface UpstoxBridgeProfile {
  status: string;
  data: Record<string, unknown>;
}

export interface UpstoxBridgeConfig {
  timeoutMs?: number;
  instrumentCacheTtlMs?: number;
}

export interface UpstoxInstrumentRecord {
  segment: string;
  exchange: string;
  name: string;
  instrument_type: string;
  instrument_key: string;
  lot_size: number;
  freeze_quantity?: number;
  exchange_token: string;
  tick_size: number;
  trading_symbol: string;
  short_name?: string;
  expiry?: number;
  strike_price?: number;
  minimum_lot?: number;
  [key: string]: unknown;
}

export interface UpstoxQuoteResponse {
  status: string;
  data: Record<string, Record<string, unknown>>;
}

export interface UpstoxRestClientStatus {
  lastProfileAt: string | null;
  lastInstrumentFetchAt: string | null;
  lastQuoteFetchAt: string | null;
  lastInstrumentCount: number | null;
  instrumentCacheAgeMs: number | null;
}

export class UpstoxRestClient {
  private readonly _timeoutMs: number;
  private readonly _instrumentCacheTtlMs: number;
  private _instrumentCache: { fetchedAt: number; records: UpstoxInstrumentRecord[] } | null = null;
  private _lastProfileAt: number | null = null;
  private _lastInstrumentFetchAt: number | null = null;
  private _lastQuoteFetchAt: number | null = null;

  constructor(config?: UpstoxBridgeConfig) {
    this._timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._instrumentCacheTtlMs = config?.instrumentCacheTtlMs ?? DEFAULT_INSTRUMENT_CACHE_MS;
  }

  getStatus(): UpstoxRestClientStatus {
    return {
      lastProfileAt: this._lastProfileAt ? new Date(this._lastProfileAt).toISOString() : null,
      lastInstrumentFetchAt: this._lastInstrumentFetchAt ? new Date(this._lastInstrumentFetchAt).toISOString() : null,
      lastQuoteFetchAt: this._lastQuoteFetchAt ? new Date(this._lastQuoteFetchAt).toISOString() : null,
      lastInstrumentCount: this._instrumentCache?.records.length ?? null,
      instrumentCacheAgeMs: this._instrumentCache ? Date.now() - this._instrumentCache.fetchedAt : null,
    };
  }

  async fetchProfile(): Promise<UpstoxBridgeProfile> {
    const token = readUpstoxTokenRecord();
    const response = await this._fetchJson<UpstoxBridgeProfile>(UPSTOX_PROFILE_URL, {
      headers: authHeaders(token.accessToken),
    });
    this._lastProfileAt = Date.now();
    return response;
  }

  async fetchInstruments(filters?: {
    exchanges?: string[];
    segments?: string[];
    instrumentTypes?: string[];
    maxRecords?: number;
  }): Promise<UpstoxInstrumentRecord[]> {
    const records = await this._getInstrumentCache();

    const exchangeSet = new Set((filters?.exchanges ?? []).map(v => v.toUpperCase()));
    const segmentSet = new Set((filters?.segments ?? []).map(v => normalizeSegmentFilter(v)));
    const typeSet = new Set((filters?.instrumentTypes ?? []).map(v => v.toUpperCase()));
    const maxRecords = filters?.maxRecords && filters.maxRecords > 0 ? filters.maxRecords : records.length;

    return records
      .filter(record => exchangeSet.size === 0 || exchangeSet.has(String(record.exchange).toUpperCase()))
      .filter(record => segmentSet.size === 0 || segmentSet.has(String(record.segment).toUpperCase()))
      .filter(record => typeSet.size === 0 || typeSet.has(String(record.instrument_type).toUpperCase()))
      .slice(0, maxRecords);
  }

  async fetchFullMarketQuotes(instrumentKeys: string[]): Promise<UpstoxQuoteResponse> {
    if (instrumentKeys.length === 0) {
      return { status: 'success', data: {} };
    }

    const token = readUpstoxTokenRecord();
    const url = new URL(UPSTOX_FULL_QUOTES_URL);
    url.searchParams.set('instrument_key', instrumentKeys.join(','));

    const data = await this._fetchJson<UpstoxQuoteResponse>(url.toString(), {
      headers: authHeaders(token.accessToken),
    });
    this._lastQuoteFetchAt = Date.now();
    return data;
  }

  private async _getInstrumentCache(): Promise<UpstoxInstrumentRecord[]> {
    if (this._instrumentCache && (Date.now() - this._instrumentCache.fetchedAt) < this._instrumentCacheTtlMs) {
      return this._instrumentCache.records;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this._timeoutMs);

    try {
      const response = await fetch(UPSTOX_INSTRUMENTS_URL, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Instrument download failed with HTTP ${response.status}`);
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      const raw = zlib.gunzipSync(bytes).toString('utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('Instrument download did not return an array');
      }

      const records = parsed.filter(isInstrumentRecord);
      this._instrumentCache = {
        fetchedAt: Date.now(),
        records,
      };
      this._lastInstrumentFetchAt = this._instrumentCache.fetchedAt;
      return records;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Instrument download timed out after ${this._timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async _fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this._timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Upstox API request failed (${response.status}): ${truncate(text)}`);
      }

      return await response.json() as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Upstox API request timed out after ${this._timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function authHeaders(accessToken: string): HeadersInit {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };
}

function isInstrumentRecord(value: unknown): value is UpstoxInstrumentRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.segment === 'string'
    && typeof row.exchange === 'string'
    && typeof row.instrument_key === 'string'
    && typeof row.exchange_token === 'string'
    && typeof row.trading_symbol === 'string'
    && typeof row.instrument_type === 'string';
}

function normalizeSegmentFilter(value: string): string {
  const upper = value.toUpperCase();
  if (upper === 'EQ') return 'NSE_EQ';
  if (upper === 'FO') return 'NSE_FO';
  return upper;
}

function truncate(value: string, max = 300): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
