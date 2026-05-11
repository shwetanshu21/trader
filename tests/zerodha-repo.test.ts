import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ZerodhaRepository } from '../src/persistence/zerodha-repo.js';
import { ZerodhaSessionState, type ZerodhaSessionRow, type IngestionEvent } from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRepo(): ZerodhaRepository {
  const mgr = new DatabaseManager(':memory:');
  return new ZerodhaRepository(mgr.db);
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
});
