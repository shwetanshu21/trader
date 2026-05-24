import { getUpstoxTokenHealth } from './token-store.js';
import { requestUpstoxToken, UpstoxTokenRequestError } from './token-request-service.js';
import {
  createDefaultUpstoxTokenRefreshStatus,
  readUpstoxTokenRefreshStatus,
  snapshotCurrentTokenTimes,
  writeUpstoxTokenRefreshStatus,
  type UpstoxTokenRefreshStatus,
} from './token-refresh-status.js';

export interface UpstoxTokenRefreshTriggerResult {
  action: 'noop-fresh-token' | 'request-sent' | 'suppressed' | 'request-failed' | 'refreshed';
  status: UpstoxTokenRefreshStatus;
}

export interface UpstoxTokenRefreshCoordinatorOptions {
  env?: Record<string, string | undefined>;
  requestCooldownMs?: number;
}

const DEFAULT_REQUEST_COOLDOWN_MS = 60 * 60 * 1000;

export class UpstoxTokenRefreshCoordinator {
  private readonly _env: Record<string, string | undefined>;
  private readonly _requestCooldownMs: number;

  constructor(options: UpstoxTokenRefreshCoordinatorOptions = {}) {
    this._env = options.env ?? process.env;
    this._requestCooldownMs = options.requestCooldownMs ?? DEFAULT_REQUEST_COOLDOWN_MS;
  }

  getStatus(): UpstoxTokenRefreshStatus {
    return readUpstoxTokenRefreshStatus(this._env);
  }

  observeTokenRefresh(now: Date = new Date()): UpstoxTokenRefreshTriggerResult {
    const existing = readUpstoxTokenRefreshStatus(this._env);
    const token = getUpstoxTokenHealth(this._env);
    const current = snapshotCurrentTokenTimes(this._env);

    if (!token.exists || token.isExpired) {
      const stale = {
        ...existing,
        checkedAt: now.toISOString(),
        lastObservedTokenPersistedAt: current.persistedAt,
        lastObservedTokenIssuedAt: current.issuedAt,
        lastObservedTokenExpiresAt: current.expiresAt,
      };
      return {
        action: 'noop-fresh-token',
        status: writeUpstoxTokenRefreshStatus(stale, this._env),
      };
    }

    const wasPending = existing.state === 'awaiting_approval';
    const isNewer = Boolean(
      (current.persistedAt && current.persistedAt !== existing.pendingBaselinePersistedAt)
      || (current.issuedAt && current.issuedAt !== existing.pendingBaselineIssuedAt),
    );

    const refreshed = {
      ...existing,
      state: 'refreshed' as const,
      checkedAt: now.toISOString(),
      lastObservedTokenPersistedAt: current.persistedAt,
      lastObservedTokenIssuedAt: current.issuedAt,
      lastObservedTokenExpiresAt: current.expiresAt,
      lastError: null,
      message: wasPending && isNewer
        ? 'A newer Upstox token was observed after the last refresh request.'
        : 'A valid Upstox token is present.',
    };

    return {
      action: 'refreshed',
      status: writeUpstoxTokenRefreshStatus(refreshed, this._env),
    };
  }

  async triggerRequest(source: string, now: Date = new Date()): Promise<UpstoxTokenRefreshTriggerResult> {
    const observed = this.observeTokenRefresh(now);
    const token = getUpstoxTokenHealth(this._env);
    if (token.exists && !token.isExpired) {
      return {
        action: 'noop-fresh-token',
        status: observed.status,
      };
    }

    const existing = readUpstoxTokenRefreshStatus(this._env);
    const nowMs = now.getTime();
    const lastRequestMs = existing.lastRequestAt ? Date.parse(existing.lastRequestAt) : null;
    if (
      existing.state === 'awaiting_approval'
      && lastRequestMs !== null
      && (nowMs - lastRequestMs) < this._requestCooldownMs
    ) {
      const suppressed = {
        ...existing,
        state: 'suppressed' as const,
        checkedAt: now.toISOString(),
        message: 'A refresh request is already pending approval; suppressing duplicate request.',
      };
      return {
        action: 'suppressed',
        status: writeUpstoxTokenRefreshStatus(suppressed, this._env),
      };
    }

    const baseline = snapshotCurrentTokenTimes(this._env);

    try {
      const response = await requestUpstoxToken(this._env);
      const status: UpstoxTokenRefreshStatus = {
        ...createDefaultUpstoxTokenRefreshStatus(now),
        state: response.ok ? 'awaiting_approval' : 'request_failed',
        checkedAt: now.toISOString(),
        lastRequestAt: now.toISOString(),
        lastRequestSource: source,
        lastRequestStatus: response.status,
        notifierUrl: response.notifierUrl,
        pendingBaselinePersistedAt: baseline.persistedAt,
        pendingBaselineIssuedAt: baseline.issuedAt,
        lastObservedTokenPersistedAt: baseline.persistedAt,
        lastObservedTokenIssuedAt: baseline.issuedAt,
        lastObservedTokenExpiresAt: baseline.expiresAt,
        lastError: response.ok ? null : `Upstox token request failed with HTTP ${response.status}.`,
        message: response.ok
          ? 'Refresh request accepted by Upstox. Awaiting approval and token delivery.'
          : `Refresh request failed with HTTP ${response.status}.`,
      };
      return {
        action: response.ok ? 'request-sent' : 'request-failed',
        status: writeUpstoxTokenRefreshStatus(status, this._env),
      };
    } catch (error) {
      const message = error instanceof UpstoxTokenRequestError || error instanceof Error
        ? error.message
        : String(error);
      const failed: UpstoxTokenRefreshStatus = {
        ...existing,
        state: 'request_failed',
        checkedAt: now.toISOString(),
        lastRequestAt: now.toISOString(),
        lastRequestSource: source,
        lastError: message,
        message,
        pendingBaselinePersistedAt: baseline.persistedAt,
        pendingBaselineIssuedAt: baseline.issuedAt,
        lastObservedTokenPersistedAt: baseline.persistedAt,
        lastObservedTokenIssuedAt: baseline.issuedAt,
        lastObservedTokenExpiresAt: baseline.expiresAt,
      };
      return {
        action: 'request-failed',
        status: writeUpstoxTokenRefreshStatus(failed, this._env),
      };
    }
  }

  async runRecoveryCheck(now: Date = new Date()): Promise<UpstoxTokenRefreshTriggerResult> {
    const observed = this.observeTokenRefresh(now);
    const token = getUpstoxTokenHealth(this._env);
    if (token.exists && !token.isExpired) {
      return observed;
    }
    return this.triggerRequest('auto-recovery', now);
  }
}
