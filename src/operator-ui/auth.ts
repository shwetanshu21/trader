// ── Operator UI authentication ──
// HTTP Basic Auth verification with in-memory consecutive-failure lockout
// and per-client request rate limiting.
//
// All state is in-memory — resets on process restart. No persistence layer.

import type { OperatorUIConfig } from './config.js';

// ---------------------------------------------------------------------------
// Auth result
// ---------------------------------------------------------------------------

export interface AuthResult {
  /** true if the request is authenticated and within rate limits. */
  ok: boolean;
  /** HTTP status code to return when ok is false. */
  status: number;
  /** Human-readable message for the response body. */
  message: string;
  /** Client IP used for lockout/rate-limit diagnostics. */
  clientIp: string;
}

// ---------------------------------------------------------------------------
// Per-client state
// ---------------------------------------------------------------------------

interface ClientState {
  /** Consecutive failed auth attempts (resets on success). */
  failures: number;
  /** Lockout expiration timestamp (ms), or 0 if not locked out. */
  lockedUntil: number;
  /** Rate-limit window entries (timestamps of recent requests). */
  requestTimestamps: number[];
  /** Last cleanup tick for this client. */
  lastCleanup: number;
}

// ---------------------------------------------------------------------------
// Authenticator
// ---------------------------------------------------------------------------

export class Authenticator {
  private readonly config: OperatorUIConfig;
  /** Map<clientIp, state> */
  private readonly clients = new Map<string, ClientState>();
  /** Cleanup interval handle. */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: OperatorUIConfig) {
    this.config = config;
  }

  /**
   * Extract client IP from the request socket remote address, or req headers
   * if behind a proxy. Falls back to 'unknown' when no address is available.
   */
  extractClientIp(remoteAddress: string | undefined, forwardedFor?: string): string {
    // Trust X-Forwarded-For first when present (reverse proxy support).
    if (forwardedFor) {
      const first = forwardedFor.split(',')[0].trim();
      if (first) return first;
    }
    return remoteAddress ?? 'unknown';
  }

  /**
   * Verify credentials extracted from the request's Authorization header.
   *
   * Returns an AuthResult with ok=true for valid credentials, or ok=false
   * with the appropriate HTTP status and message.
   *
   * Status codes:
   *   401 — Missing or invalid Authorization header format
   *   403 — Invalid credentials (counts as a failure)
   *   429 — Rate limit exceeded or locked out
   *
   * On successful auth: resets the failure count for that client.
   */
  authenticate(
    authHeader: string | undefined,
    clientIp: string,
  ): AuthResult {
    // ── Rate-limit check (applied regardless of auth state) ──────────
    const rlResult = this.checkRateLimit(clientIp);
    if (!rlResult.passed) {
      return {
        ok: false,
        status: 429,
        message: rlResult.message,
        clientIp,
      };
    }

    // ── Lockout check ───────────────────────────────────────────────
    const state = this.getOrCreateState(clientIp);
    const now = Date.now();

    if (state.lockedUntil > now) {
      const remainingMs = state.lockedUntil - now;
      return {
        ok: false,
        status: 429,
        message: `Too many failed attempts. Locked out for ${Math.ceil(remainingMs / 1000)} more seconds.`,
        clientIp,
      };
    }

    // ── Parse Authorization header ──────────────────────────────────
    if (!authHeader) {
      return {
        ok: false,
        status: 401,
        message: 'Missing Authorization header.',
        clientIp,
      };
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'basic') {
      return {
        ok: false,
        status: 401,
        message: 'Invalid Authorization header format. Expected: Basic <base64-credentials>.',
        clientIp,
      };
    }

    let decoded: string;
    try {
      decoded = Buffer.from(parts[1], 'base64').toString('utf-8');
    } catch {
      return {
        ok: false,
        status: 401,
        message: 'Invalid base64 encoding in Authorization header.',
        clientIp,
      };
    }

    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) {
      // No colon — not valid Basic auth format.
      return {
        ok: false,
        status: 401,
        message: 'Invalid credentials format.',
        clientIp,
      };
    }

    const providedUser = decoded.slice(0, colonIdx);
    const providedPass = decoded.slice(colonIdx + 1);

    // ── Credential comparison (constant-time-ish per-key length) ─────
    const userMatch = providedUser === this.config.username;
    const passMatch = providedPass === this.config.password;

    if (!userMatch || !passMatch) {
      // Increment failure count
      state.failures++;
      state.lastCleanup = now;

      // Check if lockout threshold is reached
      if (state.failures >= this.config.lockoutThreshold) {
        state.lockedUntil = now + this.config.lockoutDurationMs;
        state.failures = 0; // Reset counter; lockout timer takes over.

        return {
          ok: false,
          status: 429,
          message: `Account locked due to ${this.config.lockoutThreshold} consecutive failed attempts. Try again later.`,
          clientIp,
        };
      }

      const remaining = this.config.lockoutThreshold - state.failures;
      return {
        ok: false,
        status: 401,
        message: `Invalid credentials. ${remaining} attempt(s) remaining before lockout.`,
        clientIp,
      };
    }

    // ── Success — reset failure count ───────────────────────────────
    state.failures = 0;
    state.lockedUntil = 0;
    state.lastCleanup = now;

    return {
      ok: true,
      status: 200,
      message: 'Authenticated.',
      clientIp,
    };
  }

  // -----------------------------------------------------------------------
  // Rate limiting
  // -----------------------------------------------------------------------

  /**
   * Check whether the given client IP is within the rate limit window.
   *
   * Uses a sliding-window counter: purges timestamps older than
   * rateLimitWindowMs, then checks if the count exceeds rateLimitMax.
   */
  private checkRateLimit(clientIp: string): { passed: boolean; message: string } {
    const state = this.getOrCreateState(clientIp);
    const now = Date.now();
    const windowStart = now - this.config.rateLimitWindowMs;

    // Purge expired timestamps
    state.requestTimestamps = state.requestTimestamps.filter(t => t > windowStart);

    // Check limit
    if (state.requestTimestamps.length >= this.config.rateLimitMax) {
      const oldest = state.requestTimestamps[0] ?? now;
      const retryAfter = Math.ceil((oldest + this.config.rateLimitWindowMs - now) / 1000);
      return {
        passed: false,
        message: `Rate limit exceeded. Try again in ${retryAfter} second(s).`,
      };
    }

    // Record this request
    state.requestTimestamps.push(now);
    state.lastCleanup = now;

    return { passed: true, message: 'OK' };
  }

  // -----------------------------------------------------------------------
  // State management
  // -----------------------------------------------------------------------

  private getOrCreateState(ip: string): ClientState {
    let state = this.clients.get(ip);
    if (!state) {
      state = { failures: 0, lockedUntil: 0, requestTimestamps: [], lastCleanup: Date.now() };
      this.clients.set(ip, state);
    }
    return state;
  }

  /**
   * Get auth state summary for diagnostics (no credential values exposed).
   * Returns an array of { clientIp, failures, lockedUntil, activeRequests } objects.
   */
  getStateSummary(): Array<{
    clientIp: string;
    failures: number;
    lockedUntilTimestamp: number;
    activeRequestsInWindow: number;
  }> {
    const now = Date.now();
    const windowStart = now - this.config.rateLimitWindowMs;
    const results: Array<{
      clientIp: string;
      failures: number;
      lockedUntilTimestamp: number;
      activeRequestsInWindow: number;
    }> = [];

    for (const [clientIp, state] of this.clients) {
      // Prune expired rate-limit entries for accurate count
      state.requestTimestamps = state.requestTimestamps.filter(t => t > windowStart);
      const activeRequests = state.requestTimestamps.length;

      // Skip idle clients with zero failures and no recent requests
      if (state.failures === 0 && activeRequests === 0 && state.lockedUntil <= now) {
        continue;
      }

      results.push({
        clientIp,
        failures: state.failures,
        lockedUntilTimestamp: state.lockedUntil,
        activeRequestsInWindow: activeRequests,
      });
    }

    return results;
  }

  /**
   * Periodically purge stale client state to prevent memory leaks.
   * Call startCleanup() to begin periodic cleanup; call stopCleanup() to stop.
   */
  startCleanup(intervalMs = 300_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.purgeStale(), intervalMs);
    this.cleanupTimer.unref();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Purge clients with zero failures, no active requests, and no active lockout.
   */
  private purgeStale(): void {
    const now = Date.now();
    for (const [ip, state] of this.clients) {
      if (state.failures === 0 && state.requestTimestamps.length === 0 && state.lockedUntil <= now) {
        this.clients.delete(ip);
      }
    }
  }

  /** Exposed for testing — return the raw client state map size. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Exposed for testing — manually set a client's state. */
  _setClientState(ip: string, state: { failures: number; lockedUntil: number }): void {
    const existing = this.getOrCreateState(ip);
    existing.failures = state.failures;
    existing.lockedUntil = state.lockedUntil;
  }
}

// ---------------------------------------------------------------------------
// Header name constants
// ---------------------------------------------------------------------------

export const WWW_AUTHENTICATE_HEADER = 'WWW-Authenticate';
export const RETRY_AFTER_HEADER = 'Retry-After';
export const RATE_LIMIT_LIMIT_HEADER = 'X-RateLimit-Limit';
export const RATE_LIMIT_REMAINING_HEADER = 'X-RateLimit-Remaining';
