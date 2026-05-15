import {
  BrokerSessionState,
  type BrokerConfig,
  type BrokerSessionRow,
  type BrokerSessionHealth,
} from '../../types/runtime.js';
import type { BrokerSessionMaterial } from './ports.js';
import { BrokerRepository } from '../../persistence/broker-repo.js';
import type { KiteTokenResponse } from './types.js';

// ---------------------------------------------------------------------------
// SessionService — manages broker authentication/session lifecycle
// ---------------------------------------------------------------------------

/**
 * Seconds of buffer before expiry to treat a session as needing refresh.
 * Kite tokens live ~24h; we refresh 60 min before expiry to stay safe.
 */
const EXPIRY_BUFFER_S = 3600;

/** Default token lifetime in seconds (Kite tokens live 24 hours). */
const DEFAULT_TOKEN_TTL_S = 86_400;

export class SessionService {
  private readonly _config: BrokerConfig;
  private readonly _repo: BrokerRepository;
  /** Timestamp (epoch ms) of the last auth check. */
  private _lastAuthCheckAt: number = 0;

  constructor(config: BrokerConfig, repo: BrokerRepository) {
    this._config = config;
    this._repo = repo;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Return the persisted session row (includes token — use sparingly). */
  getSession(): BrokerSessionRow {
    return this._repo.getSession();
  }

  /**
   * Return a health-safe session snapshot (NEVER includes token values).
   * Updates lastAuthCheckAt timestamp for observability.
   */
  getSessionHealth(): BrokerSessionHealth {
    let row = this._repo.getSession();
    const now = Date.now();

    if (
      row.state === BrokerSessionState.Authenticated
      && row.expiresAt > 0
      && row.expiresAt <= now
    ) {
      row = this.markExpired(`Broker session expired at ${new Date(row.expiresAt).toISOString()}`);
    }

    this._lastAuthCheckAt = now;

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

    if (row.state !== BrokerSessionState.Authenticated) {
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
  handleTokenResponse(tokenResponse: KiteTokenResponse | null): BrokerSessionRow {
    if (!tokenResponse?.access_token || typeof tokenResponse.access_token !== 'string') {
      return this.applySessionMaterial(null, tokenResponse
        ? 'Token response missing access_token'
        : 'Token exchange returned null/error');
    }

    return this.applySessionMaterial({
      accessToken: tokenResponse.access_token,
      reason: 'Token exchange successful',
    });
  }

  /**
   * Persist transport-neutral session material.
   * Used by both direct Kite auth and MCP-backed auth/session checks.
   */
  applySessionMaterial(material: BrokerSessionMaterial | null, failureReason = 'Session refresh failed'): BrokerSessionRow {
    const now = Date.now();

    if (!material?.accessToken) {
      return this._persistFailure(BrokerSessionState.AuthFailed, failureReason);
    }

    const session: BrokerSessionRow = {
      accessToken: material.accessToken,
      obtainedAt: now,
      expiresAt: material.expiresAt ?? (now + DEFAULT_TOKEN_TTL_S * 1000),
      state: BrokerSessionState.Authenticated,
      reason: material.reason ?? 'Session refresh successful',
      lastError: null,
    };

    this._repo.upsertSession(session);
    return session;
  }

  /**
   * Persist an expired state (e.g. when token is known to be stale).
   * Replaces degraded/auth state with expired.
   */
  markExpired(reason: string): BrokerSessionRow {
    return this._persistFailure(BrokerSessionState.Expired, reason);
  }

  /**
   * Reset to missing_credentials (e.g. on first boot or after config change).
   */
  resetCredentials(): BrokerSessionRow {
    const session: BrokerSessionRow = {
      accessToken: '',
      obtainedAt: 0,
      expiresAt: 0,
      state: BrokerSessionState.MissingCredentials,
      reason: 'Credentials reset',
      lastError: null,
    };

    this._repo.upsertSession(session);
    return session;
  }

  /**
   * Determine whether broker integration is available (config present).
   * When false, later services should skip broker operations gracefully.
   */
  get isConfigured(): boolean {
    const transport = this._config.transport ?? 'direct';
    if (transport === 'mcp') {
      return Boolean(this._config.mcpUrl);
    }

    return Boolean(
      this._config.apiKey &&
      this._config.apiSecret &&
      this._config.userId &&
      this._config.totpKey,
    );
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private _persistFailure(
    state: BrokerSessionState.AuthFailed | BrokerSessionState.Expired,
    reason: string,
  ): BrokerSessionRow {
    const existing = this._repo.getSession();

    const session: BrokerSessionRow = {
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
