// ── Kite Connect WebSocket live quote stream supervisor ──
// Connects/disconnects/subscribes to the Kite Ticker binary feed,
// parses binary tick packets, persists latest-quote snapshots +
// freshness metadata, and exposes reconnect / degraded health
// diagnostics WITHOUT turning quote ingestion into an unbounded
// event ledger.

import { ZerodhaRepository } from '../../persistence/broker-repo.js';
import {
  type QuoteSnapshot,
  type StreamDiagnostics,
  type StreamState,
  type KiteTick,
  type WebSocketFactory,
  type SubscribedInstrument,
  type QuoteFreshness,
  type QuoteFreshnessConfig,
  defaultWebSocketFactory,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Kite Connect ticker WebSocket URL. */
const KITE_TICKER_URL = 'wss://ws.kite.trade';

/** Interval (ms) for the heartbeat watcher. */
const HEARTBEAT_CHECK_MS = 10_000;

/**
 * If no message (tick or heartbeat) received within this window,
 * the feed is considered stale and the stream transitions to Degraded.
 */
const HEARTBEAT_TIMEOUT_MS = 30_000;

/** Initial reconnect delay (ms). */
const INITIAL_RECONNECT_DELAY_MS = 1_000;

/** Maximum reconnect delay (cap) in ms. */
const MAX_RECONNECT_DELAY_MS = 60_000;

/** Reconnect delay multiplier (exponential backoff). */
const RECONNECT_BACKOFF_MULTIPLIER = 2;

/** Default quote freshness: 60 seconds without an update = stale. */
const DEFAULT_QUOTE_FRESHNESS_MS = 60_000;

/** Atomic packet-type constants. */
const PACKET_LTP_TIMESTAMP = 8;
const PACKET_QUOTE = 12;
// const PACKET_FULL_TIMESTAMP = 16;

// ---------------------------------------------------------------------------
// Known Kite Ticker v3 binary packet offset templates
// Maps packet type → { label, offsets }
// Fields are parsed only when the buffer is large enough.
// ---------------------------------------------------------------------------

interface PacketLayout {
  readonly label: string;
  /** Minimum buffer bytes required. */
  readonly minBytes: number;
  /** Parse a KiteTick from the DataView at the given offset. */
  readonly parse: (view: DataView, instrumentToken: number) => Partial<KiteTick>;
}

const PACKET_LAYOUTS: Record<number, PacketLayout> = {
  /** LTP with timestamp (packet 8): last_price + change + timestamp. */
  [PACKET_LTP_TIMESTAMP]: {
    label: 'ltp_timestamp',
    minBytes: 24,
    parse(view: DataView, instrumentToken: number): Partial<KiteTick> {
      return {
        instrumentToken,
        lastPrice: view.getInt32(8, true) / 100,
        change: view.getInt32(12, true) / 100,
        timestamp: Number(view.getBigInt64(16, true)),
      };
    },
  },

  /** Quote (packet 12): full quote data with segment + OI + timestamp. */
  [PACKET_QUOTE]: {
    label: 'quote',
    minBytes: 48,
    parse(view: DataView, _instrumentToken: number): Partial<KiteTick> {
      const lastPrice = view.getInt32(8, true) / 100;
      const change = view.getInt32(12, true) / 100;
      const volume = view.getUint32(16, true);
      const oi = view.getUint32(20, true);
      const high = view.getInt32(24, true) / 100;
      const low = view.getInt32(28, true) / 100;
      const open = view.getInt32(32, true) / 100;
      const close = view.getInt32(36, true) / 100;

      let timestamp: number | null = null;
      if (view.byteLength >= 48) {
        timestamp = Number(view.getBigInt64(40, true));
      }

      return {
        lastPrice,
        change,
        changePercent: close !== 0 ? (change / close) * 100 : null,
        volume,
        oi,
        high,
        low,
        open,
        close,
        timestamp,
      };
    },
  },
};

// ---------------------------------------------------------------------------
// MarketDataStream
// ---------------------------------------------------------------------------

export class MarketDataStream {
  // ── Dependencies ────────────────────────────────────────────────────────

  private readonly _repo: ZerodhaRepository;
  private readonly _wsFactory: WebSocketFactory;
  private readonly _freshnessConfig: QuoteFreshnessConfig;

  // ── WebSocket state ─────────────────────────────────────────────────────

  private _ws: WebSocket | null = null;
  private _apiKey: string = '';
  private _accessToken: string = '';
  private _intendedUrl: string = KITE_TICKER_URL;

  // ── Connection state machine ───────────────────────────────────────────

  private _state: StreamState = 'disconnected' as StreamState;
  private _connectedAt: number | null = null;
  private _lastHeartbeatAt: number | null = null;
  private _lastQuoteReceivedAt: number | null = null;
  private _reconnectCount: number = 0;
  private _parseFailures: number = 0;
  private _lastError: string | null = null;
  private _createdAt: number = Date.now();

  // ── Subscription tracking ──────────────────────────────────────────────

  /** Active subscriptions keyed by instrument token. */
  private readonly _subscriptions: Map<number, SubscribedInstrument> = new Map();

  /** Reverse lookup: exchange+tradingsymbol → instrument token. */
  private readonly _symbolToToken: Map<string, number> = new Map();

  // ── Timers ──────────────────────────────────────────────────────────────

  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _currentReconnectDelay: number = INITIAL_RECONNECT_DELAY_MS;

  // ── Batch persistence ──────────────────────────────────────────────────

  /** Accumulate quotes and batch-persist to reduce write amplification. */
  private _pendingQuotes: Map<string, QuoteSnapshot> = new Map();
  private _batchTimer: ReturnType<typeof setInterval> | null = null;
  private _batchIntervalMs: number = 1_000; // flush every 1s

  // ── Constructor ─────────────────────────────────────────────────────────

  constructor(
    repo: ZerodhaRepository,
    wsFactory?: WebSocketFactory,
    freshnessConfig?: Partial<QuoteFreshnessConfig>,
  ) {
    this._repo = repo;
    this._wsFactory = wsFactory ?? defaultWebSocketFactory;
    this._freshnessConfig = {
      maxStalenessMs: freshnessConfig?.maxStalenessMs ?? DEFAULT_QUOTE_FRESHNESS_MS,
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Open a WebSocket connection to the Kite Ticker feed.
   * No-op if already connected or connecting.
   */
  connect(apiKey: string, accessToken: string): void {
    if (this._state === 'connected' as StreamState || this._state === 'connecting' as StreamState) {
      return;
    }

    this._cancelReconnect();
    this._apiKey = apiKey;
    this._accessToken = accessToken;
    this._transitionState('connecting' as StreamState);
    this._openSocket();
  }

  /** Gracefully close the WebSocket and stop all timers. */
  disconnect(): void {
    this._cancelReconnect();
    this._stopHeartbeat();
    this._stopBatchFlush();
    this._flushPendingQuotes();

    if (this._ws) {
      // Remove handlers first to avoid reconnection on our own close
      this._ws.onopen = null;
      this._ws.onmessage = null;
      this._ws.onclose = null;
      this._ws.onerror = null;
      this._ws.close();
      this._ws = null;
    }

    this._transitionState('closed' as StreamState);
  }

  /**
   * Subscribe to one or more instrument tokens.
   * Idempotent — already-subscribed tokens are not re-subscribed.
   * Looks up the instrument identity from the local store to build
   * the symbol→token mapping for getLatestQuote().
   */
  subscribe(tokens: number[]): void {
    const newTokens: number[] = [];

    for (const token of tokens) {
      if (this._subscriptions.has(token)) continue;

      // Resolve instrument identity from local store
      const instrument = this._repo.getInstrumentByToken(token);
      const key = instrument
        ? `${instrument.exchange}:${instrument.tradingsymbol}`
        : `raw:${token}`;

      this._subscriptions.set(token, {
        instrumentToken: token,
        exchange: instrument?.exchange ?? '',
        tradingsymbol: instrument?.tradingsymbol ?? `token_${token}`,
        subscribedAt: Date.now(),
      });

      if (instrument) {
        this._symbolToToken.set(`${instrument.exchange}:${instrument.tradingsymbol}`, token);
      }

      newTokens.push(token);
    }

    if (newTokens.length === 0) return;

    // Send subscribe message if connected
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._sendSubscribe(newTokens);
    }

    this._updateSubscribedCount();
  }

  /**
   * Unsubscribe from one or more instrument tokens.
   * Idempotent.
   */
  unsubscribe(tokens: number[]): void {
    let removed = false;

    for (const token of tokens) {
      const sub = this._subscriptions.get(token);
      if (!sub) continue;

      if (sub.exchange && sub.tradingsymbol) {
        this._symbolToToken.delete(`${sub.exchange}:${sub.tradingsymbol}`);
      }
      this._subscriptions.delete(token);
      removed = true;

      // Remove its pending quote if any
      const key = sub.exchange
        ? `${sub.exchange}:${sub.tradingsymbol}`
        : `raw:${token}`;
      this._pendingQuotes.delete(key);
    }

    if (!removed) return;

    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._sendUnsubscribe(tokens);
    }

    this._updateSubscribedCount();
  }

  /**
   * Retrieve the latest persisted quote for a given instrument.
   * Uses the stable identity (exchange + tradingsymbol) from the T02 store.
   */
  getLatestQuote(exchange: string, tradingsymbol: string): QuoteSnapshot | null {
    return this._repo.getQuote(exchange, tradingsymbol);
  }

  /**
   * Retrieve all latest quotes.
   */
  getAllQuotes(): QuoteSnapshot[] {
    return this._repo.getAllQuotes();
  }

  /** Return current stream state. */
  getState(): StreamState {
    return this._state;
  }

  /** Return a snapshot of current stream diagnostics. */
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

  /** Persist current diagnostics to the stream_state table. */
  persistDiagnostics(): void {
    this._repo.upsertStreamDiagnostics(this.getDiagnostics());
  }

  /** Check whether quote feed is stale according to freshness config. */
  checkQuoteFreshness(): QuoteFreshness {
    const now = Date.now();
    if (this._lastQuoteReceivedAt === null) {
      return { isStale: true, stalenessMs: null, lastQuoteAt: null };
    }
    const stalenessMs = now - this._lastQuoteReceivedAt;
    return {
      isStale: stalenessMs > this._freshnessConfig.maxStalenessMs,
      stalenessMs,
      lastQuoteAt: this._lastQuoteReceivedAt,
    };
  }

  /**
   * Return the list of currently subscribed instrument tokens.
   * Read-only snapshot.
   */
  getSubscribedTokens(): number[] {
    return Array.from(this._subscriptions.keys());
  }

  /**
   * Return the number of currently subscribed tokens.
   */
  get subscribedCount(): number {
    return this._subscriptions.size;
  }

  /**
   * Whether the stream is currently connected and receiving data.
   */
  get isConnected(): boolean {
    return this._state === 'connected' as StreamState;
  }

  // ── Internal: WebSocket lifecycle ────────────────────────────────────────

  private _openSocket(): void {
    try {
      const ws = this._wsFactory(this._intendedUrl);
      this._ws = ws;

      ws.binaryType = 'arraybuffer';

      ws.onopen = () => this._handleOpen();
      ws.onmessage = (event: MessageEvent) => this._handleMessage(event);
      ws.onclose = (event: CloseEvent) => this._handleClose(event);
      ws.onerror = () => this._handleError();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._lastError = `WebSocket construction failed: ${msg}`;
      this._scheduleReconnect();
    }
  }

  private _handleOpen(): void {
    this._state = 'connected' as StreamState;
    this._connectedAt = Date.now();
    this._lastHeartbeatAt = this._connectedAt;
    this._currentReconnectDelay = INITIAL_RECONNECT_DELAY_MS;

    // Authenticate with Kite
    this._sendAuth();

    // Resubscribe any existing subscriptions
    const tokens = Array.from(this._subscriptions.keys());
    if (tokens.length > 0) {
      this._sendSubscribe(tokens);
      this._sendSetMode(tokens, 'quote');
    }

    // Start heartbeat watcher and batch flush
    this._startHeartbeat();
    this._startBatchFlush();

    // Persist diagnostics
    this.persistDiagnostics();

    // Record ingestion event
    this._repo.insertIngestionEvent({
      eventType: 'stream_connect',
      recordedAt: Date.now(),
      durationMs: null,
      itemCount: tokens.length,
      error: null,
      diagnostic: { reconnectCount: this._reconnectCount },
    });
  }

  private _handleMessage(event: MessageEvent): void {
    // Update heartbeat on ANY message
    this._lastHeartbeatAt = Date.now();

    const data = event.data;

    // Handle text messages (authentication success/error, heartbeat)
    if (typeof data === 'string') {
      this._handleTextMessage(data);
      return;
    }

    // Handle binary messages (tick packets)
    if (data instanceof ArrayBuffer) {
      this._handleBinaryMessage(data);
      return;
    }

    // Blob — should not happen with 'arraybuffer' binaryType, but handle gracefully
    this._parseFailures++;
    this._lastError = 'Received non-arraybuffer binary message';
  }

  private _handleTextMessage(text: string): void {
    try {
      const msg = JSON.parse(text);
      if (msg.type === 'connection') {
        // Kite sends a connection acknowledgement
        return;
      }
      // Check for error responses
      if (msg.type === 'error') {
        this._lastError = `Kite ticker error: ${msg.message ?? JSON.stringify(msg)}`;
        this._parseFailures++;
      }
    } catch {
      // Non-JSON text message (e.g. raw heartbeat pong)
      // Kite ticker sends occasional text heartbeats
    }
  }

  private _handleBinaryMessage(buffer: ArrayBuffer): void {
    const view = new DataView(buffer);
    if (view.byteLength < 5) {
      this._parseFailures++;
      return;
    }

    const packetType = view.getUint8(0);
    const instrumentToken = view.getUint32(1, true);

    // Look up the packet layout
    const layout = PACKET_LAYOUTS[packetType];
    if (!layout) {
      // Unknown packet type — not a failure, just not handled
      return;
    }

    if (view.byteLength < layout.minBytes) {
      this._parseFailures++;
      return;
    }

    // Parse the tick
    const parsed = layout.parse(view, instrumentToken);

    // Build a full KiteTick
    const tick: KiteTick = {
      packetType,
      instrumentToken,
      lastPrice: parsed.lastPrice ?? 0,
      change: parsed.change ?? null,
      changePercent: parsed.changePercent ?? null,
      volume: parsed.volume ?? null,
      oi: parsed.oi ?? null,
      high: parsed.high ?? null,
      low: parsed.low ?? null,
      open: parsed.open ?? null,
      close: parsed.close ?? null,
      bid: parsed.bid ?? null,
      ask: parsed.ask ?? null,
      timestamp: parsed.timestamp ?? null,
    };

    // Resolve instrument identity
    const sub = this._subscriptions.get(instrumentToken);
    let exchange = sub?.exchange ?? '';
    let tradingsymbol = sub?.tradingsymbol ?? `token_${instrumentToken}`;

    // Try reverse lookup from the instrument store if not subscribed
    if (!sub) {
      const instrument = this._repo.getInstrumentByToken(instrumentToken);
      if (instrument) {
        exchange = instrument.exchange;
        tradingsymbol = instrument.tradingsymbol;
      }
    }

    const now = Date.now();
    const quote: QuoteSnapshot = {
      exchange,
      tradingsymbol,
      instrumentToken,
      lastPrice: tick.lastPrice,
      change: tick.change,
      changePercent: tick.changePercent,
      volume: tick.volume,
      oi: tick.oi,
      high: tick.high,
      low: tick.low,
      open: tick.open,
      close: tick.close,
      bid: tick.bid,
      ask: tick.ask,
      priceTimestamp: tick.timestamp,
      receivedAt: now,
    };

    this._lastQuoteReceivedAt = now;

    // Accumulate in pending batch map
    this._pendingQuotes.set(`${exchange}:${tradingsymbol}`, quote);
  }

  private _handleClose(event: CloseEvent): void {
    this._ws = null;
    this._stopHeartbeat();
    this._stopBatchFlush();
    this._flushPendingQuotes();

    if (this._state === 'closed' as StreamState) {
      // Intentional disconnect — do not reconnect
      return;
    }

    this._lastError = `WebSocket closed: code=${event.code} reason=${event.reason}`;
    this._transitionState('degraded' as StreamState);
    this._scheduleReconnect();

    this._repo.insertIngestionEvent({
      eventType: 'stream_disconnect',
      recordedAt: Date.now(),
      durationMs: null,
      itemCount: null,
      error: this._lastError,
      diagnostic: { code: event.code, reason: event.reason, reconnectCount: this._reconnectCount },
    });
  }

  private _handleError(): void {
    // onerror typically precedes onclose, so just capture a pending error
    // If ws.readyState is still OPEN, schedule reconnect
    if (this._ws && this._ws.readyState !== WebSocket.CLOSED && this._ws.readyState !== WebSocket.CLOSING) {
      this._lastError = 'WebSocket error event received';
      this._ws.close();
    }
  }

  // ── Internal: Reconnect ─────────────────────────────────────────────────

  private _scheduleReconnect(): void {
    if (this._reconnectTimer) return; // Already scheduled

    this._reconnectCount++;
    const delay = this._currentReconnectDelay;

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._transitionState('connecting' as StreamState);
      this._openSocket();
    }, delay);

    // Exponential backoff with cap
    this._currentReconnectDelay = Math.min(
      this._currentReconnectDelay * RECONNECT_BACKOFF_MULTIPLIER,
      MAX_RECONNECT_DELAY_MS,
    );
  }

  private _cancelReconnect(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._currentReconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  }

  // ── Internal: Heartbeat ─────────────────────────────────────────────────

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this._checkHeartbeat();
    }, HEARTBEAT_CHECK_MS);
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  private _checkHeartbeat(): void {
    const now = Date.now();
    const sinceLastMsg = this._lastHeartbeatAt ? now - this._lastHeartbeatAt : Number.POSITIVE_INFINITY;

    if (sinceLastMsg > HEARTBEAT_TIMEOUT_MS) {
      // Feed is stale — transition to degraded
      this._lastError = `Heartbeat timeout: no message for ${sinceLastMsg}ms`;
      this._transitionToDegraded();
      this.persistDiagnostics();

      // Force close and reconnect
      if (this._ws) {
        try { this._ws.close(); } catch { /* ignore */ }
        this._ws = null;
      }
      this._scheduleReconnect();
    }
  }

  // ── Internal: Batch persistence ─────────────────────────────────────────

  private _startBatchFlush(): void {
    this._stopBatchFlush();
    this._batchTimer = setInterval(() => {
      this._flushPendingQuotes();
    }, this._batchIntervalMs);
  }

  private _stopBatchFlush(): void {
    if (this._batchTimer) {
      clearInterval(this._batchTimer);
      this._batchTimer = null;
    }
  }

  /** Flush all accumulated pending quotes to the DB. */
  private _flushPendingQuotes(): void {
    if (this._pendingQuotes.size === 0) return;

    // Use a single transaction for the batch
    const quotes = Array.from(this._pendingQuotes.values());
    this._pendingQuotes.clear();

    for (const quote of quotes) {
      this._repo.upsertQuote(quote);
    }
  }

  // ── Internal: State transitions ─────────────────────────────────────────

  private _transitionState(newState: StreamState): void {
    this._state = newState;
    this.persistDiagnostics();
  }

  private _transitionToDegraded(): void {
    if (this._state !== 'degraded' as StreamState) {
      this._state = 'degraded' as StreamState;
      this.persistDiagnostics();
    }
  }

  // ── Internal: Kite protocol helpers ─────────────────────────────────────

  private _sendAuth(): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({
      a: 'connect',
      v: `${this._apiKey}:${this._accessToken}`,
    }));
  }

  private _sendSubscribe(tokens: number[]): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({
      a: 'subscribe',
      v: tokens,
    }));
  }

  private _sendUnsubscribe(tokens: number[]): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({
      a: 'unsubscribe',
      v: tokens,
    }));
  }

  private _sendSetMode(tokens: number[], mode: 'ltp' | 'quote' | 'full'): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({
      a: 'mode',
      v: [mode, tokens],
    }));
  }

  // ── Internal: Helpers ───────────────────────────────────────────────────

  private _updateSubscribedCount(): void {
    this.persistDiagnostics();
  }
}
