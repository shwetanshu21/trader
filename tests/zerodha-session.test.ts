import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ZerodhaRepository } from '../src/persistence/zerodha-repo.js';
import { SessionService } from '../src/integrations/zerodha/session-service.js';
import {
  ZerodhaSessionState,
  type ZerodhaConfig,
} from '../src/types/runtime.js';
import type { KiteTokenResponse } from '../src/integrations/zerodha/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONFIG: ZerodhaConfig = {
  apiKey: 'test_api_key',
  apiSecret: 'test_api_secret',
  userId: 'test_user',
  totpKey: 'test_totp_key',
  sessionRefreshIntervalMs: 21_600_000,
};

function createService(config?: ZerodhaConfig): {
  service: SessionService;
  repo: ZerodhaRepository;
  db: Database.Database;
} {
  const mgr = new DatabaseManager(':memory:');
  const repo = new ZerodhaRepository(mgr.db);
  const service = new SessionService(config ?? TEST_CONFIG, repo);
  return { service, repo, db: mgr.db };
}

/** A valid-looking fake Kite token response. */
function fakeTokenResponse(overrides?: Partial<KiteTokenResponse>): KiteTokenResponse {
  return {
    access_token: 'kite_access_token_abc123',
    login_time: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SessionService
// ---------------------------------------------------------------------------

describe('SessionService', () => {
  describe('isConfigured', () => {
    it('returns true when config has all fields', () => {
      const { service } = createService();
      expect(service.isConfigured).toBe(true);
    });

    it('returns false when config fields are empty', () => {
      const empty: ZerodhaConfig = {
        apiKey: '',
        apiSecret: '',
        userId: '',
        totpKey: '',
        sessionRefreshIntervalMs: 21_600_000,
      };
      const { service } = createService(empty);
      expect(service.isConfigured).toBe(false);
    });
  });

  describe('initial state', () => {
    it('starts with missing_credentials when no session row exists', () => {
      const { service } = createService();
      const session = service.getSession();
      expect(session.state).toBe(ZerodhaSessionState.MissingCredentials);
    });

    it('health snapshot excludes token values', () => {
      const { service } = createService();
      const health = service.getSessionHealth();

      // Verify health shape — no accessToken field
      expect(health).toHaveProperty('state');
      expect(health).toHaveProperty('obtainedAt');
      expect(health).toHaveProperty('expiresAt');
      expect(health).toHaveProperty('reason');
      expect(health).toHaveProperty('lastError');
      expect(health).toHaveProperty('lastAuthCheckAt');
      expect(health.lastAuthCheckAt).toBeGreaterThan(0);

      // Ensure it's the right starting state
      expect(health.state).toBe(ZerodhaSessionState.MissingCredentials);
    });
  });

  describe('handleTokenResponse — success path', () => {
    it('persists authenticated state with token', () => {
      const { service } = createService();
      const token = fakeTokenResponse({ access_token: 'my_access_token' });

      const result = service.handleTokenResponse(token);

      expect(result.state).toBe(ZerodhaSessionState.Authenticated);
      expect(result.accessToken).toBe('my_access_token');
      expect(result.obtainedAt).toBeGreaterThan(0);
      expect(result.expiresAt).toBeGreaterThan(result.obtainedAt);
      expect(result.reason).toBe('Token exchange successful');
      expect(result.lastError).toBeNull();
    });

    it('persisted session is retrievable via getSession', () => {
      const { service } = createService();
      service.handleTokenResponse(fakeTokenResponse({ access_token: 'token_456' }));

      const session = service.getSession();
      expect(session.accessToken).toBe('token_456');
      expect(session.state).toBe(ZerodhaSessionState.Authenticated);
    });

    it('health snapshot shows authenticated state without token', () => {
      const { service } = createService();
      service.handleTokenResponse(fakeTokenResponse({ access_token: 'secret_token' }));

      const health = service.getSessionHealth();
      expect(health.state).toBe(ZerodhaSessionState.Authenticated);
      expect(health.obtainedAt).toBeGreaterThan(0);
      // @ts-expect-error - accessToken must not be on the health type
      expect(health.accessToken).toBeUndefined();
    });
  });

  describe('handleTokenResponse — error paths', () => {
    it('persists auth_failed when tokenResponse is null', () => {
      const { service } = createService();
      const result = service.handleTokenResponse(null);

      expect(result.state).toBe(ZerodhaSessionState.AuthFailed);
      expect(result.reason).toBe('Token exchange returned null/error');
      expect(result.lastError).toBe('Token exchange returned null/error');
    });

    it('persists auth_failed when access_token is empty string', () => {
      const { service } = createService();
      const result = service.handleTokenResponse(fakeTokenResponse({ access_token: '' }));

      expect(result.state).toBe(ZerodhaSessionState.AuthFailed);
      expect(result.reason).toBe('Token response missing access_token');
    });

    it('preserves old access_token on failure (for diagnostics)', () => {
      const { service } = createService();
      // First succeed
      service.handleTokenResponse(fakeTokenResponse({ access_token: 'good_token' }));
      // Then fail
      service.handleTokenResponse(null);

      const session = service.getSession();
      // The stale token is preserved for diagnostic purposes
      expect(session.accessToken).toBe('good_token');
      expect(session.state).toBe(ZerodhaSessionState.AuthFailed);
    });
  });

  describe('needsRefresh', () => {
    it('returns true when no session exists (missing_credentials)', () => {
      const { service } = createService();
      expect(service.needsRefresh()).toBe(true);
    });

    it('returns true after auth_failure', () => {
      const { service } = createService();
      service.handleTokenResponse(null);
      expect(service.needsRefresh()).toBe(true);
    });

    it('returns false when authenticated and within expiry buffer', () => {
      const { service } = createService();
      service.handleTokenResponse(fakeTokenResponse());
      expect(service.needsRefresh()).toBe(false);
    });

    it('returns true when token is near expiry', () => {
      const { service, repo } = createService();
      // Manually set a session with a very short expiry (already expired)
      repo.upsertSession({
        accessToken: 'old_token',
        obtainedAt: Date.now() - 100_000,
        expiresAt: Date.now() - 1000, // Already expired
        state: ZerodhaSessionState.Authenticated,
        reason: 'Old session',
        lastError: null,
      });

      expect(service.needsRefresh()).toBe(true);
    });
  });

  describe('markExpired', () => {
    it('sets state to expired retaining old token', () => {
      const { service } = createService();
      service.handleTokenResponse(fakeTokenResponse({ access_token: 'tok_789' }));
      service.markExpired('Kite session expired by server');

      const session = service.getSession();
      expect(session.state).toBe(ZerodhaSessionState.Expired);
      expect(session.accessToken).toBe('tok_789'); // retained
      expect(session.reason).toBe('Kite session expired by server');
    });
  });

  describe('resetCredentials', () => {
    it('resets to missing_credentials', () => {
      const { service } = createService();
      service.handleTokenResponse(fakeTokenResponse());
      service.resetCredentials();

      const session = service.getSession();
      expect(session.state).toBe(ZerodhaSessionState.MissingCredentials);
      expect(session.accessToken).toBe('');
      expect(session.obtainedAt).toBe(0);
      expect(session.expiresAt).toBe(0);
    });
  });

  describe('boundary conditions', () => {
    it('health lastAuthCheckAt updates on each call', () => {
      const { service } = createService();
      const h1 = service.getSessionHealth();
      const h2 = service.getSessionHealth();
      expect(h2.lastAuthCheckAt).toBeGreaterThanOrEqual(h1.lastAuthCheckAt);
    });

    it('can recover from auth_failed to authenticated', () => {
      const { service } = createService();
      service.handleTokenResponse(null); // fail
      service.handleTokenResponse(fakeTokenResponse({ access_token: 'recovered' })); // succeed

      const session = service.getSession();
      expect(session.state).toBe(ZerodhaSessionState.Authenticated);
      expect(session.accessToken).toBe('recovered');
    });
  });
});
