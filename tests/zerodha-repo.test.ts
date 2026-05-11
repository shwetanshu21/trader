import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ZerodhaRepository } from '../src/persistence/zerodha-repo.js';
import {
  ZerodhaSessionState,
  type ZerodhaSessionRow,
  type IngestionEvent,
  type InstrumentRecord,
  type InstrumentSyncState,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRepo(): ZerodhaRepository {
  const mgr = new DatabaseManager(':memory:');
  return new ZerodhaRepository(mgr.db);
}

function sampleInstrument(overrides?: Partial<InstrumentRecord>): InstrumentRecord {
  return {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    name: 'RELIANCE INDUSTRIES LTD',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    instrumentType: 'EQ',
    segment: 'NSE',
    exchangeToken: 1234,
    ...overrides,
  };
}

function sampleFoInstrument(overrides?: Partial<InstrumentRecord>): InstrumentRecord {
  return {
    exchange: 'NFO',
    tradingsymbol: 'RELIANCE24DEC3000CE',
    instrumentToken: 789012,
    name: 'RELIANCE INDUSTRIES LTD',
    expiry: '2024-12-26',
    strike: 3000,
    lotSize: 250,
    tickSize: 0.05,
    instrumentType: 'CE',
    segment: 'NFO',
    exchangeToken: 7890,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ZerodhaRepository
// ---------------------------------------------------------------------------

describe('ZerodhaRepository', () => {
  describe('session (singleton upsert)', () => {
    it('returns default missing-credentials row when no session exists', () => {
      const repo = createRepo();
      const session = repo.getSession();

      expect(session.state).toBe(ZerodhaSessionState.MissingCredentials);
      expect(session.accessToken).toBe('');
      expect(session.obtainedAt).toBe(0);
      expect(session.expiresAt).toBe(0);
      expect(session.reason).toBe('No session row persisted yet');
      expect(session.lastError).toBeNull();
    });

    it('persists and retrieves a session row', () => {
      const repo = createRepo();
      const session: ZerodhaSessionRow = {
        accessToken: 'token_abc123',
        obtainedAt: 1000,
        expiresAt: 1000 + 86_400_000,
        state: ZerodhaSessionState.Authenticated,
        reason: 'Login successful',
        lastError: null,
      };

      repo.upsertSession(session);
      const loaded = repo.getSession();

      expect(loaded.accessToken).toBe('token_abc123');
      expect(loaded.obtainedAt).toBe(1000);
      expect(loaded.expiresAt).toBe(1000 + 86_400_000);
      expect(loaded.state).toBe(ZerodhaSessionState.Authenticated);
      expect(loaded.reason).toBe('Login successful');
      expect(loaded.lastError).toBeNull();
    });

    it('upsert replaces previous session state', () => {
      const repo = createRepo();

      repo.upsertSession({
        accessToken: 'old_token',
        obtainedAt: 100,
        expiresAt: 1000,
        state: ZerodhaSessionState.Authenticated,
        reason: 'First login',
        lastError: null,
      });

      repo.upsertSession({
        accessToken: 'new_token',
        obtainedAt: 2000,
        expiresAt: 2000 + 86_400_000,
        state: ZerodhaSessionState.Authenticated,
        reason: 'Refreshed',
        lastError: null,
      });

      const loaded = repo.getSession();
      expect(loaded.accessToken).toBe('new_token');
      expect(loaded.obtainedAt).toBe(2000);
      expect(loaded.reason).toBe('Refreshed');
    });

    it('persists auth_failed state with error reason', () => {
      const repo = createRepo();

      repo.upsertSession({
        accessToken: '',
        obtainedAt: 0,
        expiresAt: 0,
        state: ZerodhaSessionState.AuthFailed,
        reason: 'Token exchange returned HTTP 401',
        lastError: '401 Unauthorized: Invalid API key',
      });

      const loaded = repo.getSession();
      expect(loaded.state).toBe(ZerodhaSessionState.AuthFailed);
      expect(loaded.lastError).toBe('401 Unauthorized: Invalid API key');
    });

    it('persists expired state', () => {
      const repo = createRepo();

      repo.upsertSession({
        accessToken: 'stale_token',
        obtainedAt: 0,
        expiresAt: 100,
        state: ZerodhaSessionState.Expired,
        reason: 'Token expired',
        lastError: null,
      });

      const loaded = repo.getSession();
      expect(loaded.state).toBe(ZerodhaSessionState.Expired);
      expect(loaded.accessToken).toBe('stale_token');
    });
  });

  describe('ingestion events', () => {
    it('inserts and retrieves an ingestion event', () => {
      const repo = createRepo();
      const event = repo.insertIngestionEvent({
        eventType: 'instrument_master',
        recordedAt: 1000,
        durationMs: 500,
        itemCount: 150,
        error: null,
        diagnostic: null,
      });

      expect(event.id).toBeGreaterThan(0);
      expect(event.eventType).toBe('instrument_master');
      expect(event.recordedAt).toBe(1000);
      expect(event.durationMs).toBe(500);
      expect(event.itemCount).toBe(150);
      expect(event.error).toBeNull();
      expect(event.diagnostic).toBeNull();
    });

    it('stores and retrieves diagnostic data', () => {
      const repo = createRepo();
      repo.insertIngestionEvent({
        eventType: 'quote',
        recordedAt: 2000,
        durationMs: 50,
        itemCount: 5,
        error: null,
        diagnostic: { source: 'ticker', symbols: ['RELIANCE', 'TCS'] },
      });

      const events = repo.getIngestionEvents();
      expect(events.length).toBe(1);
      expect(events[0].diagnostic).toEqual({ source: 'ticker', symbols: ['RELIANCE', 'TCS'] });
    });

    it('stores failed ingestion events', () => {
      const repo = createRepo();
      repo.insertIngestionEvent({
        eventType: 'instrument_master',
        recordedAt: 3000,
        durationMs: null,
        itemCount: null,
        error: 'Network timeout fetching NSE contract master',
        diagnostic: null,
      });

      const events = repo.getIngestionEvents();
      expect(events.length).toBe(1);
      expect(events[0].error).toBe('Network timeout fetching NSE contract master');
      expect(events[0].eventType).toBe('instrument_master');
    });

    it('returns events newest first', () => {
      const repo = createRepo();
      repo.insertIngestionEvent({
        eventType: 'first', recordedAt: 100, durationMs: null, itemCount: null, error: null, diagnostic: null,
      });
      repo.insertIngestionEvent({
        eventType: 'second', recordedAt: 200, durationMs: null, itemCount: null, error: null, diagnostic: null,
      });

      const events = repo.getIngestionEvents();
      expect(events.length).toBe(2);
      expect(events[0].eventType).toBe('second');
      expect(events[1].eventType).toBe('first');
    });

    it('respects limit parameter', () => {
      const repo = createRepo();
      for (let i = 0; i < 10; i++) {
        repo.insertIngestionEvent({
          eventType: `event_${i}`, recordedAt: i, durationMs: null, itemCount: null, error: null, diagnostic: null,
        });
      }

      expect(repo.getIngestionEvents(3).length).toBe(3);
    });

    it('prunes old events keeping N most recent', () => {
      const repo = createRepo();
      for (let i = 0; i < 10; i++) {
        repo.insertIngestionEvent({
          eventType: `e_${i}`, recordedAt: i, durationMs: null, itemCount: null, error: null, diagnostic: null,
        });
      }

      const deleted = repo.pruneIngestionEvents(3);
      expect(deleted).toBe(7);
      expect(repo.getIngestionEvents().length).toBe(3);
    });

    it('prune with keep >= count deletes nothing', () => {
      const repo = createRepo();
      for (let i = 0; i < 5; i++) {
        repo.insertIngestionEvent({
          eventType: `e_${i}`, recordedAt: i, durationMs: null, itemCount: null, error: null, diagnostic: null,
        });
      }

      const deleted = repo.pruneIngestionEvents(100);
      expect(deleted).toBe(0);
      expect(repo.getIngestionEvents().length).toBe(5);
    });
  });

  describe('instruments', () => {
    it('starts with zero instruments', () => {
      const repo = createRepo();
      expect(repo.countInstruments()).toBe(0);
    });

    it('batch upserts instruments', () => {
      const repo = createRepo();
      const instruments = [
        sampleInstrument(),
        sampleInstrument({ tradingsymbol: 'TCS', instrumentToken: 654321, name: 'TATA CONSULTANCY SERVICES LTD' }),
      ];

      repo.upsertInstruments(instruments);
      expect(repo.countInstruments()).toBe(2);
    });

    it('upsert is idempotent (same exchange + tradingsymbol replaces)', () => {
      const repo = createRepo();
      repo.upsertInstruments([sampleInstrument({ name: 'OLD NAME' })]);
      repo.upsertInstruments([sampleInstrument({ name: 'NEW NAME' })]);

      expect(repo.countInstruments()).toBe(1);
      const loaded = repo.getInstrument('NSE', 'RELIANCE');
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('NEW NAME');
    });

    it('looks up instrument by exchange + tradingsymbol', () => {
      const repo = createRepo();
      repo.upsertInstruments([sampleInstrument()]);

      const found = repo.getInstrument('NSE', 'RELIANCE');
      expect(found).not.toBeNull();
      expect(found!.instrumentToken).toBe(123456);
      expect(found!.instrumentType).toBe('EQ');
    });

    it('returns null for unknown instrument', () => {
      const repo = createRepo();
      expect(repo.getInstrument('NSE', 'UNKNOWN')).toBeNull();
    });

    it('looks up instrument by token', () => {
      const repo = createRepo();
      repo.upsertInstruments([
        sampleInstrument(),
        sampleFoInstrument(),
      ]);

      const found = repo.getInstrumentByToken(789012);
      expect(found).not.toBeNull();
      expect(found!.tradingsymbol).toBe('RELIANCE24DEC3000CE');
      expect(found!.segment).toBe('NFO');
    });

    it('returns null for unknown token', () => {
      const repo = createRepo();
      expect(repo.getInstrumentByToken(999999)).toBeNull();
    });

    it('retrieves all instruments by exchange', () => {
      const repo = createRepo();
      repo.upsertInstruments([
        sampleInstrument({ exchange: 'NSE', tradingsymbol: 'RELIANCE' }),
        sampleInstrument({ exchange: 'NSE', tradingsymbol: 'TCS', instrumentToken: 200 }),
        sampleFoInstrument({ exchange: 'NFO', tradingsymbol: 'BANKNIFTY24DEC50000CE', instrumentToken: 300 }),
      ]);

      const nse = repo.getInstrumentsByExchange('NSE');
      expect(nse.length).toBe(2);
      expect(nse.map(i => i.tradingsymbol).sort()).toEqual(['RELIANCE', 'TCS']);

      const nfo = repo.getInstrumentsByExchange('NFO');
      expect(nfo.length).toBe(1);
      expect(nfo[0].tradingsymbol).toBe('BANKNIFTY24DEC50000CE');
    });

    it('retrieves all instruments by segment', () => {
      const repo = createRepo();
      repo.upsertInstruments([
        sampleInstrument({ segment: 'NSE' }),
        sampleFoInstrument({ segment: 'NFO' }),
      ]);

      const segmentNse = repo.getInstrumentsBySegment('NSE');
      expect(segmentNse.length).toBe(1);

      const segmentNfo = repo.getInstrumentsBySegment('NFO');
      expect(segmentNfo.length).toBe(1);
    });

    it('empty upsert does nothing', () => {
      const repo = createRepo();
      repo.upsertInstruments([]);
      expect(repo.countInstruments()).toBe(0);
    });

    it('preserves FO-specific fields (expiry, strike, lotSize)', () => {
      const repo = createRepo();
      repo.upsertInstruments([sampleFoInstrument()]);

      const loaded = repo.getInstrument('NFO', 'RELIANCE24DEC3000CE');
      expect(loaded).not.toBeNull();
      expect(loaded!.expiry).toBe('2024-12-26');
      expect(loaded!.strike).toBe(3000);
      expect(loaded!.lotSize).toBe(250);
      expect(loaded!.tickSize).toBe(0.05);
      expect(loaded!.instrumentType).toBe('CE');
    });
  });

  describe('instrument sync state', () => {
    it('starts with null sync state when never synced', () => {
      const repo = createRepo();
      const state = repo.getInstrumentSyncState();
      expect(state.lastSuccessAt).toBeNull();
      expect(state.lastInstrumentCount).toBeNull();
      expect(state.lastSkippedCount).toBeNull();
      expect(state.lastStatus).toBeNull();
      expect(state.lastError).toBeNull();
    });

    it('persists and retrieves sync state', () => {
      const repo = createRepo();
      const state: InstrumentSyncState = {
        lastSuccessAt: 1000,
        lastInstrumentCount: 1500,
        lastSkippedCount: 3,
        lastStatus: 'success',
        lastError: null,
      };

      repo.upsertInstrumentSyncState(state);
      const loaded = repo.getInstrumentSyncState();
      expect(loaded.lastSuccessAt).toBe(1000);
      expect(loaded.lastInstrumentCount).toBe(1500);
      expect(loaded.lastSkippedCount).toBe(3);
      expect(loaded.lastStatus).toBe('success');
      expect(loaded.lastError).toBeNull();
    });

    it('upsert replaces previous sync state', () => {
      const repo = createRepo();
      repo.upsertInstrumentSyncState({
        lastSuccessAt: 100, lastInstrumentCount: 500, lastSkippedCount: 0, lastStatus: 'success', lastError: null,
      });
      repo.upsertInstrumentSyncState({
        lastSuccessAt: 200, lastInstrumentCount: 600, lastSkippedCount: 1, lastStatus: 'partial', lastError: 'some skips',
      });

      const loaded = repo.getInstrumentSyncState();
      expect(loaded.lastSuccessAt).toBe(200);
      expect(loaded.lastInstrumentCount).toBe(600);
      expect(loaded.lastSkippedCount).toBe(1);
      expect(loaded.lastStatus).toBe('partial');
    });

    it('computes staleness correctly', () => {
      const repo = createRepo();
      const now = 5000;

      // Never synced
      expect(repo.getInstrumentStalenessMs(now)).toBeNull();

      // Synced recently
      repo.upsertInstrumentSyncState({
        lastSuccessAt: 4000, lastInstrumentCount: 100, lastSkippedCount: 0, lastStatus: 'success', lastError: null,
      });
      expect(repo.getInstrumentStalenessMs(now)).toBe(1000);

      // Synced long ago
      expect(repo.getInstrumentStalenessMs(100_000)).toBe(96_000);
    });
  });

  describe('latest quotes', () => {
    it('starts with zero quotes', () => {
      const repo = createRepo();
      expect(repo.countQuotes()).toBe(0);
    });

    it('returns null for unknown quote', () => {
      const repo = createRepo();
      expect(repo.getQuote('NSE', 'UNKNOWN')).toBeNull();
      expect(repo.getQuoteByToken(999)).toBeNull();
    });

    it('upserts and retrieves a quote snapshot', () => {
      const repo = createRepo();
      const now = Date.now();

      repo.upsertQuote({
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        instrumentToken: 123456,
        lastPrice: 2560.50,
        change: 15.25,
        changePercent: 0.60,
        volume: 1_500_000,
        oi: null,
        high: 2575.00,
        low: 2545.00,
        open: 2548.00,
        close: 2545.25,
        bid: 2559.50,
        ask: 2561.00,
        priceTimestamp: Math.floor(now / 1000),
        receivedAt: now,
      });

      expect(repo.countQuotes()).toBe(1);
      const loaded = repo.getQuote('NSE', 'RELIANCE');
      expect(loaded).not.toBeNull();
      expect(loaded!.lastPrice).toBe(2560.50);
      expect(loaded!.change).toBe(15.25);
      expect(loaded!.volume).toBe(1_500_000);
      expect(loaded!.bid).toBe(2559.50);
      expect(loaded!.ask).toBe(2561.00);
    });

    it('upsert replaces previous quote for the same instrument', () => {
      const repo = createRepo();
      const t1 = 1000;

      repo.upsertQuote({
        exchange: 'NSE', tradingsymbol: 'TCS', instrumentToken: 200,
        lastPrice: 3500, change: null, changePercent: null, volume: null, oi: null,
        high: null, low: null, open: null, close: null, bid: null, ask: null,
        priceTimestamp: null, receivedAt: t1,
      });

      repo.upsertQuote({
        exchange: 'NSE', tradingsymbol: 'TCS', instrumentToken: 200,
        lastPrice: 3510, change: 10, changePercent: 0.29, volume: null, oi: null,
        high: null, low: null, open: null, close: null, bid: null, ask: null,
        priceTimestamp: null, receivedAt: t1 + 1000,
      });

      expect(repo.countQuotes()).toBe(1);
      const loaded = repo.getQuoteByToken(200);
      expect(loaded).not.toBeNull();
      expect(loaded!.lastPrice).toBe(3510);
      expect(loaded!.change).toBe(10);
    });

    it('retrieves all quotes', () => {
      const repo = createRepo();
      const now = Date.now();

      repo.upsertQuote({
        exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 1,
        lastPrice: 2500, change: null, changePercent: null, volume: null, oi: null,
        high: null, low: null, open: null, close: null, bid: null, ask: null,
        priceTimestamp: null, receivedAt: now,
      });
      repo.upsertQuote({
        exchange: 'NSE', tradingsymbol: 'TCS', instrumentToken: 2,
        lastPrice: 3500, change: null, changePercent: null, volume: null, oi: null,
        high: null, low: null, open: null, close: null, bid: null, ask: null,
        priceTimestamp: null, receivedAt: now,
      });

      const all = repo.getAllQuotes();
      expect(all.length).toBe(2);
    });

    it('reports staleness correctly', () => {
      const repo = createRepo();
      const now = 100_000;

      // No quotes yet — stale
      const fresh1 = repo.getQuoteStalenessMs(now);
      expect(fresh1.isStale).toBe(true);
      expect(fresh1.stalenessMs).toBeNull();
      expect(fresh1.lastQuoteAt).toBeNull();

      // Add a recent quote
      repo.upsertQuote({
        exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 1,
        lastPrice: 2500, change: null, changePercent: null, volume: null, oi: null,
        high: null, low: null, open: null, close: null, bid: null, ask: null,
        priceTimestamp: null, receivedAt: now - 5_000,
      });

      // 5 seconds old — not stale (< 60s)
      const fresh2 = repo.getQuoteStalenessMs(now);
      expect(fresh2.isStale).toBe(false);
      expect(fresh2.stalenessMs).toBe(5_000);

      // 120 seconds old — stale
      const fresh3 = repo.getQuoteStalenessMs(now + 120_000);
      expect(fresh3.isStale).toBe(true);
      expect(fresh3.stalenessMs).toBe(125_000);
    });

    it('looks up quote by instrument token', () => {
      const repo = createRepo();
      repo.upsertQuote({
        exchange: 'NFO', tradingsymbol: 'BANKNIFTY24DEC50000CE', instrumentToken: 789,
        lastPrice: 150.50, change: null, changePercent: null, volume: null, oi: null,
        high: null, low: null, open: null, close: null, bid: null, ask: null,
        priceTimestamp: null, receivedAt: Date.now(),
      });

      const found = repo.getQuoteByToken(789);
      expect(found).not.toBeNull();
      expect(found!.exchange).toBe('NFO');
      expect(found!.tradingsymbol).toBe('BANKNIFTY24DEC50000CE');
      expect(found!.lastPrice).toBe(150.50);
    });
  });

  describe('stream diagnostics', () => {
    it('returns default disconnected state when no diagnostics exist', () => {
      const repo = createRepo();
      const diag = repo.getStreamDiagnostics();

      expect(diag.state).toBe('disconnected');
      expect(diag.connectedAt).toBeNull();
      expect(diag.lastHeartbeatAt).toBeNull();
      expect(diag.reconnectCount).toBe(0);
      expect(diag.parseFailures).toBe(0);
      expect(diag.subscribedCount).toBe(0);
      expect(diag.lastError).toBeNull();
      expect(diag.createdAt).toBeGreaterThan(0);
    });

    it('persists and retrieves stream diagnostics', () => {
      const repo = createRepo();
      const now = Date.now();

      repo.upsertStreamDiagnostics({
        state: 'connected',
        connectedAt: now - 10_000,
        lastHeartbeatAt: now - 1_000,
        lastQuoteReceivedAt: now - 500,
        reconnectCount: 2,
        parseFailures: 1,
        subscribedCount: 5,
        lastError: null,
        createdAt: now,
      });

      const loaded = repo.getStreamDiagnostics();
      expect(loaded.state).toBe('connected');
      expect(loaded.connectedAt).toBe(now - 10_000);
      expect(loaded.reconnectCount).toBe(2);
      expect(loaded.parseFailures).toBe(1);
      expect(loaded.subscribedCount).toBe(5);
      expect(loaded.lastError).toBeNull();
    });

    it('upsert replaces previous diagnostics', () => {
      const repo = createRepo();
      const now = Date.now();

      repo.upsertStreamDiagnostics({
        state: 'disconnected', connectedAt: null, lastHeartbeatAt: null,
        lastQuoteReceivedAt: null, reconnectCount: 0, parseFailures: 0,
        subscribedCount: 0, lastError: null, createdAt: now,
      });

      repo.upsertStreamDiagnostics({
        state: 'connected', connectedAt: now, lastHeartbeatAt: now,
        lastQuoteReceivedAt: now, reconnectCount: 1, parseFailures: 3,
        subscribedCount: 10, lastError: null, createdAt: now,
      });

      const loaded = repo.getStreamDiagnostics();
      expect(loaded.state).toBe('connected');
      expect(loaded.reconnectCount).toBe(1);
      expect(loaded.parseFailures).toBe(3);
      expect(loaded.subscribedCount).toBe(10);
    });

    it('persists error state', () => {
      const repo = createRepo();
      const now = Date.now();

      repo.upsertStreamDiagnostics({
        state: 'degraded', connectedAt: null, lastHeartbeatAt: null,
        lastQuoteReceivedAt: null, reconnectCount: 3, parseFailures: 5,
        subscribedCount: 0, lastError: 'WebSocket closed: code=1006 reason=Abnormal Closure',
        createdAt: now,
      });

      const loaded = repo.getStreamDiagnostics();
      expect(loaded.state).toBe('degraded');
      expect(loaded.reconnectCount).toBe(3);
      expect(loaded.parseFailures).toBe(5);
      expect(loaded.lastError).toContain('WebSocket closed');
    });
  });
});
