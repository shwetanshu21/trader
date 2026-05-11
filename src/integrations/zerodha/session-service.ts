import {
  ZerodhaSessionState,
  type ZerodhaConfig,
  type ZerodhaSessionRow,
  type ZerodhaSessionHealth,
} from '../../types/runtime.js';
import { ZerodhaRepository } from '../../persistence/zerodha-repo.js';
import type { KiteTokenResponse } from './types.js';

// ---------------------------------------------------------------------------
// SessionService — manages Zerodha Kite Connect authentication lifecycle
// ---------------------------------------------------------------------------

/**
 * Seconds of buffer before expiry to treat a session as needing refresh.
 * Kite tokens live ~24h; we refresh 60 min before expiry to stay safe.
 */
const EXPIRY_BUFFER_S = 3600;

/** Default token lifetime in seconds (Kite tokens live 24 hours). */
const DEFAULT_TOKEN_TTL_S = 86_400;

export class SessionService {
  private readonly _config: ZerodhaConfig;
  private readonly _repo: ZerodhaRepository;
  /** Timestamp (epoch ms) of the last auth check. */
  private _lastAuthCheckAt: number = 0;

  constructor(config: ZerodhaConfig, repo: ZerodhaRepository) {
    this._config = config;
    this._repo = repo;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Return the persisted session row (includes token — use sparingly). */
  getSession(): ZerodhaSessionRow {
    return this._repo.getSession();
  }

  /**
   * Return a health-safe session snapshot (NEVER includes token values).
   * Updates lastAuthCheckAt timestamp for observability.
   */
  getSessionHealth(): ZerodhaSessionHealth {
    const row = this._repo.getSession();
    this._lastAuthCheckAt = Date.now();

    return {
      state: row.state,
      obtainedAt: row.obtainedAt,
      expiresAt: row.expiresAt,
      reason: row.reason,
      lastError: row.lastError,
      lastAuthCheckAt: this._lastAuthCheckAt,
    };
  }

  /**
   * Determine whether a session refresh is needed.
   * Returns true when:
   *  - No valid session exists (missing_credentials, auth_failed, expired)
   *  - The current token is within EXPIRY_BUFFER_S of its expiry
   */
  needsRefresh(): boolean {
    const row = this._repo.getSession();

    if (row.state !== ZerodhaSessionState.Authenticated) {
      return true;
    }

    const now = Date.now();
    const remainingMs = row.expiresAt - now;
    return remainingMs < EXPIRY_BUFFER_S * 1000;
  }

  /**
   * Attempt a token exchange / login using the Kite Connect API.
   *
   * In this task we implement the persistence boundary and state machine.
   * The actual HTTP call to Kite Connect will be wired in a later task
   * when the HTTP client abstraction is available. For now, callers pass
   * the raw token response (or null on failure).
   *
   * When called with null (simulating a network error / timeout / 401),
   * the service persists the degraded state.
   *
   * @param tokenResponse - Parsed response from Kite Connect,
   *   or null to simulate/persist a failure.
   */
  handleTokenResponse(tokenResponse: KiteTokenResponse | null): ZerodhaSessionRow {
    const now = Date.now();

    if (!tokenResponse) {
      return this._persistFailure(ZerodhaSessionState.AuthFailed, 'Token exchange returned null/error');
    }

    if (!tokenResponse.access_token || typeof tokenResponse.access_token !== 'string') {
      return this._persistFailure(ZerodhaSessionState.AuthFailed, 'Token response missing access_token');
    }

    const session: ZerodhaSessionRow = {
      accessToken: tokenResponse.access_token,
      obtainedAt: now,
      expiresAt: now + DEFAULT_TOKEN_TTL_S * 1000,
      state: ZerodhaSessionState.Authenticated,
      reason: 'Token exchange successful',
      lastError: null,
    };

    this._repo.upsertSession(session);
    return session;
  }

  /**
   * Persist an expired state (e.g. when token is known to be stale).
   * Replaces degraded/auth state with expired.
   */
  markExpired(reason: string): ZerodhaSessionRow {
    return this._persistFailure(ZerodhaSessionState.Expired, reason);
  }

  /**
   * Reset to missing_credentials (e.g. on first boot or after config change).
   */
  resetCredentials(): ZerodhaSessionRow {
    const session: ZerodhaSessionRow = {
      accessToken: '',
      obtainedAt: 0,
      expiresAt: 0,
      state: ZerodhaSessionState.MissingCredentials,
      reason: 'Credentials reset',
      lastError: null,
    };

    this._repo.upsertSession(session);
    return session;
  }

  /**
   * Determine whether Zerodha integration is available (config present).
   * When false, later services should skip Zerodha operations gracefully.
   */
  get isConfigured(): boolean {
    return Boolean(
      this._config.apiKey &&
      this._config.apiSecret &&
      this._config.userId &&
      this._config.totpKey,
    );
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private _persistFailure(
    state: ZerodhaSessionState.AuthFailed | ZerodhaSessionState.Expired,
    reason: string,
  ): ZerodhaSessionRow {
    const existing = this._repo.getSession();

    const session: ZerodhaSessionRow = {
      accessToken: existing.accessToken, // Keep old token (may still be useful for diagnostics)
      obtainedAt: existing.obtainedAt,
      expiresAt: existing.expiresAt,
      state,
      reason,
      lastError: reason,
    };

    this._repo.upsertSession(session);
    return session;
  }
}
