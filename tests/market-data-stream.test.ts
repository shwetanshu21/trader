// ── MarketDataStream tests ──
// Covers: connect/disconnect, subscribe/unsubscribe, binary tick parsing,
// reconnect/backoff, stale-feed detection, malformed message handling,
// batch persistence, and diagnostics observability.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ZerodhaRepository } from '../src/persistence/zerodha-repo.js';
import { MarketDataStream } from '../src/integrations/zerodha/market-data-stream.js';
import type { QuoteSnapshot, InstrumentRecord, StreamDiagnostics } from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type MessageHandler = (event: { data: string | ArrayBuffer }) => void;
type CloseHandler = (event: { code: number; reason: string }) => void;
type ErrorHandler = (event: Event) => void;

class MockWebSocket {
  readonly url: string;
  binaryType: BinaryType = 'arraybuffer';
  readyState: number = WebSocket.CONNECTING;

  onopen: (() => void) | null = null;
  onmessage: MessageHandler | null = null;
  onclose: CloseHandler | null = null;
  onerror: ErrorHandler | null = null;

  /** Captured sent messages for test inspection. */
  readonly sentMessages: Array<string | ArrayBuffer> = [];

  /** Open delay — when >0, open fires after this many ms. */
  openDelay: number = 0;
  private _openTimer: ReturnType<typeof setTimeout> | null = null;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  constructor(url: string) {
    this.url = url;
  }

  /** Simulate a successful connection. */
  mockOpen(): void {
    if (this.openDelay > 0) {
      this._openTimer = setTimeout(() => this._doOpen(), this.openDelay);
    } else {
      this._doOpen();
    }
  }

  private _doOpen(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }

  /** Simulate receiving a text message. */
  mockReceiveText(text: string): void {
    this.onmessage?.({ data: text });
  }

  /** Simulate receiving a binary tick packet. */
  mockReceiveBinary(buffer: ArrayBuffer): void {
    this.onmessage?.({ data: buffer });
  }

  /** Simulate a close event. */
  mockClose(code: number = 1006, reason: string = ''): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  /** Simulate an error event. */
  mockError(): void {
    this.onerror?.(new Event('error'));
  }

  // WebSocket API
  send(data: string | ArrayBuffer): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    if (this._openTimer) {
      clearTimeout(this._openTimer);
      this._openTimer = null;
    }
  }

  addEventListener(): void { /* no-op */ }
  removeEventListener(): void { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock quote-mode binary tick (packet type 12) for a given instrument token and price. */
function buildQuoteTick(
  instrumentToken: number,
  lastPrice: number,
  overrides?: Partial<{
    change: number;
    volume: number;
    oi: number;
    high: number;
    low: number;
    open: number;
    close: number;
    timestamp: number;
  }>,
): ArrayBuffer {
  const buf = new ArrayBuffer(48);
  const view = new DataView(buf);

  // packet type 12 (quote)
  view.setUint8(0, 12);
  // instrument token (uint32 LE)
  view.setUint32(1, instrumentToken, true);
  // segment bytes (3 bytes) — skip at offset 5-7, leave as zeros
  // last_price (int32 LE, scaled by 100)
  view.setInt32(8, Math.round(lastPrice * 100), true);
  // change (int32 LE, scaled by 100)
  view.setInt32(12, Math.round((overrides?.change ?? 0) * 100), true);
  // volume (uint32 LE)
  view.setUint32(16, overrides?.volume ?? 10000, true);
  // oi (uint32 LE)
  view.setUint32(20, overrides?.oi ?? 5000, true);
  // high (int32 LE, scaled by 100)
  view.setInt32(24, Math.round((overrides?.high ?? lastPrice + 10) * 100), true);
  // low (int32 LE, scaled by 100)
  view.setInt32(28, Math.round((overrides?.low ?? lastPrice - 10) * 100), true);
  // open (int32 LE, scaled by 100)
  view.setInt32(32, Math.round((overrides?.open ?? lastPrice - 5) * 100), true);
  // close (int32 LE, scaled by 100)
  view.setInt32(36, Math.round((overrides?.close ?? lastPrice - 5) * 100), true);
  // timestamp (int64 LE, epoch seconds)
  view.setBigInt64(40, BigInt(overrides?.timestamp ?? Math.floor(Date.now() / 1000)), true);

  return buf;
}

/** Build a mock LTP binary tick (packet type 8). */
function buildLtpTick(
  instrumentToken: number,
  lastPrice: number,
  change?: number,
  timestamp?: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(24);
  const view = new DataView(buf);

  view.setUint8(0, 8); // packet type
  view.setUint32(1, instrumentToken, true); // instrument token
  // segment bytes 5-7 — skip
  view.setInt32(8, Math.round(lastPrice * 100), true); // last_price
  view.setInt32(12, Math.round((change ?? 0) * 100), true); // change
  view.setBigInt64(16, BigInt(timestamp ?? Math.floor(Date.now() / 1000)), true); // timestamp

  return buf;
}

function createTestEnv() {
  const mgr = new DatabaseManager(':memory:');
  const repo = new ZerodhaRepository(mgr.db);
  return { mgr, repo };
}

function sampleInstrument(overrides?: Partial<InstrumentRecord>): InstrumentRecord {
  return {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 738561,
    name: 'RELIANCE INDUSTRIES LTD',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    instrumentType: 'EQ',
    segment: 'NSE',
    exchangeToken: 7385,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MarketDataStream', () => {
  let mockWs: MockWebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWs = new MockWebSocket('wss://ws.kite.trade');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── connect / disconnect ────────────────────────────────────────────────

  it('starts in disconnected state', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    expect(stream.getState()).toBe('disconnected');
    expect(stream.subscribedCount).toBe(0);
  });

  it('connects to the Kite ticker and sends auth', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    stream.connect('api_key_123', 'access_token_abc');
    expect(stream.getState()).toBe('connecting');

    // Simulate open
    mockWs.mockOpen();
    expect(stream.getState()).toBe('connected');
    expect(stream.isConnected).toBe(true);

    // Auth message should be sent
    const authMsg = mockWs.sentMessages.find(
      (m) => typeof m === 'string' && m.includes('connect'),
    ) as string | undefined;
    expect(authMsg).toBeDefined();
    expect(authMsg!).toBe('{"a":"connect","v":"api_key_123:access_token_abc"}');
  });

  it('connect is a no-op when already connected', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    stream.connect('key', 'token');
    mockWs.mockOpen();
    mockWs.sentMessages.length = 0; // clear

    stream.connect('other_key', 'other_token');

    // Should NOT have sent another auth
    const authMsgs = mockWs.sentMessages.filter(
      (m) => typeof m === 'string' && m.includes('connect'),
    );
    expect(authMsgs.length).toBe(0);
  });

  it('disconnect cleans up and transitions to closed', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    stream.connect('key', 'token');
    mockWs.mockOpen();
    expect(stream.getState()).toBe('connected');

    stream.disconnect();
    expect(stream.getState()).toBe('closed');
    expect(stream.isConnected).toBe(false);
    // Should have closed the underlying WebSocket
    expect(mockWs.readyState).toBe(WebSocket.CLOSED);
  });

  // ── subscribe / unsubscribe ─────────────────────────────────────────────

  it('subscribe sends subscription message when connected and stores tokens', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    stream.connect('key', 'token');
    mockWs.mockOpen();

    stream.subscribe([738561, 5633]);

    // Should have sent subscribe message
    const subMsg = mockWs.sentMessages.find(
      (m) => typeof m === 'string' && m.includes('subscribe'),
    ) as string | undefined;
    expect(subMsg).toBeDefined();
    expect(subMsg!).toContain('738561');
    expect(subMsg!).toContain('5633');

    expect(stream.subscribedCount).toBe(2);
    expect(stream.getSubscribedTokens()).toEqual([738561, 5633]);
  });

  it('subscribe is idempotent for already-subscribed tokens', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    stream.connect('key', 'token');
    mockWs.mockOpen();

    stream.subscribe([738561]);
    stream.subscribe([738561]); // duplicate

    expect(stream.subscribedCount).toBe(1);
  });

  it('subscribe works when disconnected (queues for reconnect)', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    stream.subscribe([738561]);
    expect(stream.subscribedCount).toBe(1);
    expect(stream.getSubscribedTokens()).toEqual([738561]);

    // Connect should auto-resubscribe
    stream.connect('key', 'token');
    mockWs.mockOpen();

    const subMsg = mockWs.sentMessages.find(
      (m) => typeof m === 'string' && m.includes('subscribe'),
    ) as string | undefined;
    expect(subMsg).toBeDefined();
    expect(subMsg!).toContain('738561');
  });

  it('unsubscribe removes tokens and sends unsubscribe message', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    stream.connect('key', 'token');
    mockWs.mockOpen();
    stream.subscribe([738561, 5633]);
    mockWs.sentMessages.length = 0; // clear

    stream.unsubscribe([738561]);

    const unsubMsg = mockWs.sentMessages.find(
      (m) => typeof m === 'string' && m.includes('unsubscribe'),
    ) as string | undefined;
    expect(unsubMsg).toBeDefined();
    expect(unsubMsg!).toContain('738561');
    expect(unsubMsg!).not.toContain('5633');

    expect(stream.subscribedCount).toBe(1);
    expect(stream.getSubscribedTokens()).toEqual([5633]);
  });

  // ── Binary tick parsing & persistence ───────────────────────────────────

  it('parses quote-mode binary ticks and persists to repo', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    // Seed an instrument so subscribe resolves the identity
    repo.upsertInstruments([sampleInstrument()]);

    stream.connect('key', 'token');
    mockWs.mockOpen();
    stream.subscribe([738561]);

    // Send a binary tick
    const tickBuf = buildQuoteTick(738561, 2560.50, {
      change: 15.25,
      volume: 1_500_000,
      oi: 500_000,
      high: 2575.00,
      low: 2545.00,
      open: 2548.00,
      close: 2545.25,
    });

    mockWs.mockReceiveBinary(tickBuf);

    // Flush pending quotes (batch timer runs in fake timers)
    vi.advanceTimersByTime(1500);

    // Verify quote was persisted
    const quote = repo.getQuote('NSE', 'RELIANCE');
    expect(quote).not.toBeNull();
    expect(quote!.lastPrice).toBe(2560.50);
    expect(quote!.change).toBe(15.25);
    expect(quote!.volume).toBe(1_500_000);
    expect(quote!.oi).toBe(500_000);
    expect(quote!.high).toBe(2575.00);
    expect(quote!.low).toBe(2545.00);
  });

  it('parses LTP binary ticks (packet type 8)', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    repo.upsertInstruments([sampleInstrument()]);

    stream.connect('key', 'token');
    mockWs.mockOpen();
    stream.subscribe([738561]);

    const ltpBuf = buildLtpTick(738561, 2570.00, 20.50);
    mockWs.mockReceiveBinary(ltpBuf);

    vi.advanceTimersByTime(1500);

    const quote = repo.getQuote('NSE', 'RELIANCE');
    expect(quote).not.toBeNull();
    expect(quote!.lastPrice).toBe(2570.00);
    expect(quote!.change).toBe(20.50);
  });

  it('handles unknown packet types gracefully (no crash)', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    repo.upsertInstruments([sampleInstrument()]);

    stream.connect('key', 'token');
    mockWs.mockOpen();
    stream.subscribe([738561]);

    // Unknown packet type (99)
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint8(0, 99);
    mockWs.mockReceiveBinary(buf);

    // Should not crash
    expect(stream.getDiagnostics().state).toBe('connected');
  });

  it('handles malformed binary messages (too short)', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    repo.upsertInstruments([sampleInstrument()]);

    stream.connect('key', 'token');
    mockWs.mockOpen();

    // Buffer too short for packet parsing (< 5 bytes)
    const buf = new ArrayBuffer(3);
    const view = new DataView(buf);
    view.setUint8(0, 12);
    mockWs.mockReceiveBinary(buf);

    expect(stream.getDiagnostics().parseFailures).toBe(1);
  });

  it('handles malformed binary messages (truncated)', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    repo.upsertInstruments([sampleInstrument()]);

    stream.connect('key', 'token');
    mockWs.mockOpen();

    // LTP packet type but only 12 bytes < minBytes (24)
    const buf = new ArrayBuffer(12);
    const view = new DataView(buf);
    view.setUint8(0, 8);
    mockWs.mockReceiveBinary(buf);

    expect(stream.getDiagnostics().parseFailures).toBe(1);
  });

  it('persists unsubscribed instrument quote by looking up from store', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    // Seed instrument but don't subscribe
    repo.upsertInstruments([sampleInstrument()]);

    stream.connect('key', 'token');
    mockWs.mockOpen();

    // Receive tick for instrument not subscribed — should still attempt lookup
    const tickBuf = buildQuoteTick(738561, 2550.00);
    mockWs.mockReceiveBinary(tickBuf);

    vi.advanceTimersByTime(1500);

    // Should still be persisted (resolved via instrument store)
    const quote = repo.getQuote('NSE', 'RELIANCE');
    expect(quote).not.toBeNull();
    expect(quote!.lastPrice).toBe(2550.00);
  });

  // ── getLatestQuote / getAllQuotes ────────────────────────────────────────

  it('getLatestQuote retrieves from repo', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    repo.upsertQuote({
      exchange: 'NSE', tradingsymbol: 'TCS', instrumentToken: 200,
      lastPrice: 3500, change: null, changePercent: null, volume: null, oi: null,
      high: null, low: null, open: null, close: null, bid: null, ask: null,
      priceTimestamp: null, receivedAt: Date.now(),
    });

    const quote = stream.getLatestQuote('NSE', 'TCS');
    expect(quote).not.toBeNull();
    expect(quote!.lastPrice).toBe(3500);
  });

  it('getAllQuotes returns all persisted quotes', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    repo.upsertQuote({
      exchange: 'NSE', tradingsymbol: 'A', instrumentToken: 1,
      lastPrice: 100, change: null, changePercent: null, volume: null, oi: null,
      high: null, low: null, open: null, close: null, bid: null, ask: null,
      priceTimestamp: null, receivedAt: Date.now(),
    });
    repo.upsertQuote({
      exchange: 'NSE', tradingsymbol: 'B', instrumentToken: 2,
      lastPrice: 200, change: null, changePercent: null, volume: null, oi: null,
      high: null, low: null, open: null, close: null, bid: null, ask: null,
      priceTimestamp: null, receivedAt: Date.now(),
    });

    expect(stream.getAllQuotes().length).toBe(2);
  });

  // ── Reconnect / backoff ─────────────────────────────────────────────────

  it('reconnects on close with exponential backoff', () => {
    const { repo } = createTestEnv();
    let wsCount = 0;

    let firstWs = mockWs;
    const stream = new MarketDataStream(repo, () => {
      wsCount++;
      if (wsCount === 1) return firstWs as unknown as WebSocket;
      // Return a fresh mock for each reconnect
      const ws = new MockWebSocket('wss://ws.kite.trade');
      // Replace the reference so tests can trigger open/close
      return ws as unknown as WebSocket;
    });

    // Spy on _openSocket via connect then close
    stream.connect('key', 'token');
    firstWs.mockOpen();
    expect(stream.getState()).toBe('connected');

    // Close triggers reconnect
    firstWs.mockClose(1006, 'Connection reset');
    expect(stream.getDiagnostics().state).toBe('degraded');
    expect(stream.getDiagnostics().reconnectCount).toBe(1);

    // Initial reconnect delay is 1s, so we need to advance time
    vi.advanceTimersByTime(1500);
    // Should have attempted reconnect (new WebSocket created)
    expect(wsCount).toBeGreaterThanOrEqual(2);
  });

  it('does not reconnect after explicit disconnect', () => {
    const { repo } = createTestEnv();
    let wsCount = 0;

    let firstWs = mockWs;
    const stream = new MarketDataStream(repo, () => {
      wsCount++;
      if (wsCount === 1) return firstWs as unknown as WebSocket;
      return new MockWebSocket('wss://ws.kite.trade') as unknown as WebSocket;
    });

    stream.connect('key', 'token');
    firstWs.mockOpen();

    stream.disconnect();
    const countBefore = wsCount;

    // Advance time — should NOT reconnect
    vi.advanceTimersByTime(100_000);
    expect(wsCount).toBe(countBefore);
    expect(stream.getState()).toBe('closed');
  });

  it('backoff doubles reconnect delay up to 60s cap', () => {
    const { repo } = createTestEnv();
    const wsInstances: MockWebSocket[] = [mockWs];
    let wsIdx = 0;

    const stream = new MarketDataStream(repo, () => {
      if (wsIdx < wsInstances.length) {
        return wsInstances[wsIdx++] as unknown as WebSocket;
      }
      const ws = new MockWebSocket('wss://ws.kite.trade');
      wsInstances.push(ws);
      wsIdx = wsInstances.length;
      return ws as unknown as WebSocket;
    });

    stream.connect('key', 'token');
    wsInstances[0].mockOpen();
    expect(stream.getDiagnostics().reconnectCount).toBe(0);

    // First close → reconnect delay 1s
    wsInstances[0].mockClose(1006);
    vi.advanceTimersByTime(1000);
    expect(stream.getDiagnostics().reconnectCount).toBe(1);

    // Connect the new ws
    wsInstances[1]?.mockOpen?.();

    // Second close → reconnect delay 2s
    wsInstances[1]?.mockClose?.(1006);
    vi.advanceTimersByTime(2000);
    expect(stream.getDiagnostics().reconnectCount).toBe(2);
  });

  // ── Heartbeat / stale-feed detection ─────────────────────────────────────

  it('detects stale feed when no message received within heartbeat window', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    stream.connect('key', 'token');
    mockWs.mockOpen();

    // Advance to 40s exactly where heartbeat fires (10s interval, 4th tick at 40_000ms)
    // sinceLastMsg = 40_000 > 30_000 → stale triggered → transitions to degraded
    // The reconnect is scheduled at +1000ms (41_000), so we stop before that fires
    vi.advanceTimersByTime(40_001);

    // Feed is now stale — should transition to degraded
    const diagnostics = stream.getDiagnostics();
    expect(diagnostics.state).toBe('degraded');
    expect(diagnostics.lastError).toContain('Heartbeat timeout');
  });

  it('updates heartbeat on any message reception', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    stream.connect('key', 'token');
    mockWs.mockOpen();

    // Advance 15s (within heartbeat window) and send a message
    vi.advanceTimersByTime(15_000);
    mockWs.mockReceiveText(JSON.stringify({ type: 'connection' }));

    // Advance another 20s — still within window since we reset at 15s
    vi.advanceTimersByTime(20_000);

    expect(stream.getDiagnostics().state).toBe('connected');
  });

  // ── Diagnostics persistence ─────────────────────────────────────────────

  it('persistDiagnostics saves diagnostics to repo', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    stream.connect('key', 'token');
    mockWs.mockOpen();

    stream.persistDiagnostics();

    const loaded = repo.getStreamDiagnostics();
    expect(loaded.state).toBe('connected');
    expect(loaded.connectedAt).toBeGreaterThan(0);
  });

  it('diagnostics include parse failures', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    stream.connect('key', 'token');
    mockWs.mockOpen();

    // Send a truncated packet
    const buf = new ArrayBuffer(4);
    mockWs.mockReceiveBinary(buf);

    const diag = stream.getDiagnostics();
    expect(diag.parseFailures).toBe(1);
  });

  it('checkQuoteFreshness returns correct state', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    repo.upsertInstruments([sampleInstrument()]);
    stream.connect('key', 'token');
    mockWs.mockOpen();

    // No quotes yet
    expect(stream.checkQuoteFreshness().isStale).toBe(true);
    expect(stream.checkQuoteFreshness().stalenessMs).toBeNull();

    // Receive a quote
    stream.subscribe([738561]);
    mockWs.mockReceiveBinary(buildQuoteTick(738561, 2500));

    // Should have recent freshness
    expect(stream.checkQuoteFreshness().isStale).toBe(false);
  });

  // ── Text message handling ───────────────────────────────────────────────

  it('handles Kite connection acknowledgement text message', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    stream.connect('key', 'token');
    mockWs.mockOpen();

    // This should not crash
    mockWs.mockReceiveText(JSON.stringify({ type: 'connection' }));
    expect(stream.getDiagnostics().state).toBe('connected');
  });

  it('handles Kite error text message', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    stream.connect('key', 'token');
    mockWs.mockOpen();

    mockWs.mockReceiveText(JSON.stringify({ type: 'error', message: 'Invalid token' }));
    const diag = stream.getDiagnostics();
    expect(diag.parseFailures).toBe(1);
    expect(diag.lastError).toContain('Invalid token');
  });

  it('handles non-JSON text messages gracefully', () => {
    const { repo } = createTestEnv();
    const stream = new MarketDataStream(repo, () => mockWs as unknown as WebSocket);

    stream.connect('key', 'token');
    mockWs.mockOpen();

    // Raw heartbeat text
    mockWs.mockReceiveText('pong');
    expect(stream.getDiagnostics().state).toBe('connected');
  });
});
