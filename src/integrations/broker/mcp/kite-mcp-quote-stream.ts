import { ZerodhaRepository } from '../../../persistence/broker-repo.js';
import type { QuoteFreshnessConfig, QuoteSnapshot, StreamDiagnostics, StreamState } from '../types.js';
import { StreamState as StreamStateEnum } from '../types.js';
import type { QuoteFreshness } from '../types.js';
import type { QuoteStreamPort } from '../ports.js';
import { KiteMcpClient } from './kite-mcp-client.js';

const DEFAULT_QUOTE_FRESHNESS_MS = 60_000;

export class KiteMcpQuoteStream implements QuoteStreamPort {
  private readonly _repo: ZerodhaRepository;
  private readonly _client: KiteMcpClient;
  private readonly _freshnessConfig: QuoteFreshnessConfig;
  private readonly _pollIntervalMs: number;

  private _state: StreamState = StreamStateEnum.Disconnected;
  private _connectedAt: number | null = null;
  private _lastHeartbeatAt: number | null = null;
  private _lastQuoteReceivedAt: number | null = null;
  private _reconnectCount = 0;
  private _parseFailures = 0;
  private _lastError: string | null = null;
  private _createdAt = Date.now();
  private readonly _subscriptions = new Set<number>();
  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    repo: ZerodhaRepository,
    client: KiteMcpClient,
    pollIntervalMs = 15_000,
    freshnessConfig?: Partial<QuoteFreshnessConfig>,
  ) {
    this._repo = repo;
    this._client = client;
    this._pollIntervalMs = pollIntervalMs;
    this._freshnessConfig = {
      maxStalenessMs: freshnessConfig?.maxStalenessMs ?? DEFAULT_QUOTE_FRESHNESS_MS,
    };
  }

  async connect(): Promise<void> {
    if (this._state === StreamStateEnum.Connected) return;

    try {
      await this._client.refreshSession();
      this._state = StreamStateEnum.Connected;
      this._connectedAt = Date.now();
      this._lastHeartbeatAt = this._connectedAt;
      this._lastError = null;
      this._startPolling();
      this.persistDiagnostics();
    } catch (error) {
      this._state = StreamStateEnum.Degraded;
      this._reconnectCount += 1;
      this._lastError = error instanceof Error ? error.message : String(error);
      this.persistDiagnostics();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this._stopPolling();
    await this._client.disconnect();
    this._state = StreamStateEnum.Closed;
    this.persistDiagnostics();
  }

  subscribe(tokens: number[]): void {
    for (const token of tokens) {
      if (Number.isFinite(token) && token > 0) {
        this._subscriptions.add(token);
      }
    }
    this.persistDiagnostics();
  }

  unsubscribe(tokens: number[]): void {
    for (const token of tokens) {
      this._subscriptions.delete(token);
    }
    this.persistDiagnostics();
  }

  getLatestQuote(exchange: string, tradingsymbol: string): QuoteSnapshot | null {
    return this._repo.getQuote(exchange, tradingsymbol);
  }

  getAllQuotes(): QuoteSnapshot[] {
    return this._repo.getAllQuotes();
  }

  getState(): StreamState {
    return this._state;
  }

  getDiagnostics(): StreamDiagnostics {
    return {
      state: this._state,
      connectedAt: this._connectedAt,
      lastHeartbeatAt: this._lastHeartbeatAt,
      lastQuoteReceivedAt: this._lastQuoteReceivedAt,
      reconnectCount: this._reconnectCount,
      parseFailures: this._parseFailures,
      subscribedCount: this._subscriptions.size,
      lastError: this._lastError,
      createdAt: this._createdAt,
    };
  }

  persistDiagnostics(): void {
    this._repo.upsertStreamDiagnostics(this.getDiagnostics());
  }

  checkQuoteFreshness(): QuoteFreshness {
    if (this._lastQuoteReceivedAt === null) {
      return { isStale: true, stalenessMs: null, lastQuoteAt: null };
    }

    const stalenessMs = Date.now() - this._lastQuoteReceivedAt;
    return {
      isStale: stalenessMs > this._freshnessConfig.maxStalenessMs,
      stalenessMs,
      lastQuoteAt: this._lastQuoteReceivedAt,
    };
  }

  async syncNow(): Promise<void> {
    const tokens = Array.from(this._subscriptions);
    if (tokens.length === 0) return;

    try {
      const quotes = await this._client.fetchQuotes(tokens);
      let persisted = 0;

      for (const item of quotes) {
        const instrument = this._repo.getInstrumentByToken(item.instrumentToken);
        if (!instrument) continue;

        const quote = mapQuoteSnapshot(instrument.exchange, instrument.tradingsymbol, item.instrumentToken, item.quote);
        if (!quote) {
          this._parseFailures += 1;
          continue;
        }

        this._repo.upsertQuote(quote);
        persisted += 1;
      }

      if (persisted > 0) {
        this._lastHeartbeatAt = Date.now();
        this._lastQuoteReceivedAt = Date.now();
        this._lastError = null;
        this._state = StreamStateEnum.Connected;
      }

      this.persistDiagnostics();
    } catch (error) {
      this._state = StreamStateEnum.Degraded;
      this._lastError = error instanceof Error ? error.message : String(error);
      this._reconnectCount += 1;
      this.persistDiagnostics();
      throw error;
    }
  }

  private _startPolling(): void {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => {
      void this.syncNow().catch(() => {
        // surfaced via diagnostics on the next health poll
      });
    }, this._pollIntervalMs);
  }

  private _stopPolling(): void {
    if (!this._pollTimer) return;
    clearInterval(this._pollTimer);
    this._pollTimer = null;
  }
}

function mapQuoteSnapshot(
  exchange: string,
  tradingsymbol: string,
  instrumentToken: number,
  row: Record<string, unknown>,
): QuoteSnapshot | null {
  const lastPrice = numberOrNull(row.lastPrice ?? row.last_price ?? row.ltp ?? row.price);
  if (lastPrice === null) return null;

  const receivedAt = Date.now();
  return {
    exchange,
    tradingsymbol,
    instrumentToken,
    lastPrice,
    change: numberOrNull(row.change ?? row.net_change),
    changePercent: numberOrNull(row.changePercent ?? row.change_percent),
    volume: numberOrNull(row.volume),
    oi: numberOrNull(row.oi ?? row.open_interest),
    high: numberOrNull(row.high ?? nestedNumber(row, 'ohlc', 'high')),
    low: numberOrNull(row.low ?? nestedNumber(row, 'ohlc', 'low')),
    open: numberOrNull(row.open ?? nestedNumber(row, 'ohlc', 'open')),
    close: numberOrNull(row.close ?? row.cp ?? nestedNumber(row, 'ohlc', 'close')),
    bid: numberOrNull(row.bid ?? row.best_bid_price ?? nestedNumber(row, 'depth', 'buy', 0, 'price')),
    ask: numberOrNull(row.ask ?? row.best_ask_price ?? nestedNumber(row, 'depth', 'sell', 0, 'price')),
    priceTimestamp: numberOrNull(row.priceTimestamp ?? row.price_timestamp ?? row.timestamp ?? row.last_trade_time),
    receivedAt,
  };
}

function nestedNumber(value: Record<string, unknown>, ...path: Array<string | number>): number | null {
  let current: unknown = value;
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(current) || current.length <= key) return null;
      current = current[key];
    } else {
      if (!current || typeof current !== 'object' || !(key in current)) return null;
      current = (current as Record<string, unknown>)[key];
    }
  }
  return numberOrNull(current);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
