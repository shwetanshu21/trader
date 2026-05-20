// ── Operator UI configuration ──
// Parses OPERATOR_UI_* environment variables for the standalone operator console.
// All values have safe defaults except OPERATOR_UI_PASSWORD which must be set.
//
// Redaction guarantee: this module exposes a .redact() method that strips
// credential values from any object for safe logging.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OperatorUIConfig {
  /** Bind host for the HTTP server. Default: 127.0.0.1 */
  host: string;
  /** HTTP port. Default: 3100 */
  port: number;
  /** Path to the operator database file (read-only). Default: ./data/trader.db */
  dbPath: string;
  /** Basic-auth username. Default: operator */
  username: string;
  /** Basic-auth password. REQUIRED — startup fails if unset. */
  password: string;
  /** Dashboard JSON refresh poll interval hint (ms). Default: 30000 */
  pollIntervalMs: number;
  /** Consecutive failed auth attempts before IP lockout. Default: 5 */
  lockoutThreshold: number;
  /** Lockout duration in ms. Default: 300_000 (5 min). */
  lockoutDurationMs: number;
  /** Max requests per rate-limit window per client IP. Default: 60 */
  rateLimitMax: number;
  /** Rate-limit sliding window in ms. Default: 60_000 (1 min). */
  rateLimitWindowMs: number;
}

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

export class OperatorUIConfigError extends Error {
  public readonly field: string;
  public readonly provided: string | undefined;

  constructor(field: string, message: string, provided?: string) {
    super(message);
    this.name = 'OperatorUIConfigError';
    this.field = field;
    this.provided = provided;
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const VALIDATED_HOST_RE = /^[\w.:[\]]+$/;

/**
 * Parse and validate operator UI configuration from environment.
 *
 * Throws OperatorUIConfigError on hard validation failures (missing password,
 * invalid port, invalid host). Warnings are logged to console.warn but
 * do not prevent startup.
 */
export function loadOperatorUIConfig(
  env: Record<string, string | undefined>,
): OperatorUIConfig {
  // ── Host ──────────────────────────────────────────────────────────────
  const hostRaw = env.OPERATOR_UI_HOST?.trim() || '';
  const host = hostRaw || '127.0.0.1';
  if (hostRaw && !VALIDATED_HOST_RE.test(hostRaw)) {
    throw new OperatorUIConfigError(
      'OPERATOR_UI_HOST',
      `Invalid bind host "${hostRaw}". Expected a valid hostname or IP address.`,
      hostRaw,
    );
  }

  // ── Port ──────────────────────────────────────────────────────────────
  const portRaw = env.OPERATOR_UI_PORT ?? '3100';
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new OperatorUIConfigError(
      'OPERATOR_UI_PORT',
      `Must be a valid port number (1–65535), got "${portRaw}".`,
      portRaw,
    );
  }

  // ── DB path ───────────────────────────────────────────────────────────
  const dbPath = env.OPERATOR_UI_DB_PATH?.trim() || './data/trader.db';

  // ── Credentials ───────────────────────────────────────────────────────
  const username = env.OPERATOR_UI_USERNAME?.trim() || 'operator';
  const password = env.OPERATOR_UI_PASSWORD?.trim() || '';

  if (!password) {
    throw new OperatorUIConfigError(
      'OPERATOR_UI_PASSWORD',
      'OPERATOR_UI_PASSWORD is required. Set it to a non-empty value.',
      '',
    );
  }

  // ── Poll interval ─────────────────────────────────────────────────────
  const pollRaw = env.OPERATOR_UI_POLL_INTERVAL_MS ?? '30000';
  const pollIntervalMs = Number(pollRaw);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
    console.warn(
      `[operator-ui/config] Warning: OPERATOR_UI_POLL_INTERVAL_MS must be ≥ 1000, got "${pollRaw}". Falling back to 30000.`,
    );
  }
  const resolvedPoll = Number.isFinite(pollIntervalMs) && pollIntervalMs >= 1000
    ? pollIntervalMs
    : 30000;

  // ── Lockout threshold ─────────────────────────────────────────────────
  const lockoutRaw = env.OPERATOR_UI_LOCKOUT_THRESHOLD ?? '5';
  const lockoutThreshold = Number(lockoutRaw);
  if (!Number.isFinite(lockoutThreshold) || lockoutThreshold < 1 || lockoutThreshold > 100) {
    console.warn(
      `[operator-ui/config] Warning: OPERATOR_UI_LOCKOUT_THRESHOLD must be 1–100, got "${lockoutRaw}". Falling back to 5.`,
    );
  }
  const resolvedLockoutThreshold = Number.isFinite(lockoutThreshold) && lockoutThreshold >= 1 && lockoutThreshold <= 100
    ? lockoutThreshold
    : 5;

  // ── Lockout duration ──────────────────────────────────────────────────
  const lockoutDurRaw = env.OPERATOR_UI_LOCKOUT_DURATION_MS ?? '300000';
  const lockoutDurationMs = Number(lockoutDurRaw);
  if (!Number.isFinite(lockoutDurationMs) || lockoutDurationMs < 1000) {
    console.warn(
      `[operator-ui/config] Warning: OPERATOR_UI_LOCKOUT_DURATION_MS must be ≥ 1000, got "${lockoutDurRaw}". Falling back to 300000.`,
    );
  }
  const resolvedLockoutDuration = Number.isFinite(lockoutDurationMs) && lockoutDurationMs >= 1000
    ? lockoutDurationMs
    : 300000;

  // ── Rate limit max ────────────────────────────────────────────────────
  const rlMaxRaw = env.OPERATOR_UI_RATE_LIMIT_MAX ?? '60';
  const rateLimitMax = Number(rlMaxRaw);
  if (!Number.isFinite(rateLimitMax) || rateLimitMax < 1 || rateLimitMax > 10000) {
    console.warn(
      `[operator-ui/config] Warning: OPERATOR_UI_RATE_LIMIT_MAX must be 1–10000, got "${rlMaxRaw}". Falling back to 60.`,
    );
  }
  const resolvedRlMax = Number.isFinite(rateLimitMax) && rateLimitMax >= 1 && rateLimitMax <= 10000
    ? rateLimitMax
    : 60;

  // ── Rate limit window ─────────────────────────────────────────────────
  const rlWinRaw = env.OPERATOR_UI_RATE_LIMIT_WINDOW_MS ?? '60000';
  const rateLimitWindowMs = Number(rlWinRaw);
  if (!Number.isFinite(rateLimitWindowMs) || rateLimitWindowMs < 1000) {
    console.warn(
      `[operator-ui/config] Warning: OPERATOR_UI_RATE_LIMIT_WINDOW_MS must be ≥ 1000, got "${rlWinRaw}". Falling back to 60000.`,
    );
  }
  const resolvedRlWindow = Number.isFinite(rateLimitWindowMs) && rateLimitWindowMs >= 1000
    ? rateLimitWindowMs
    : 60000;

  return {
    host,
    port,
    dbPath,
    username,
    password,
    pollIntervalMs: resolvedPoll,
    lockoutThreshold: resolvedLockoutThreshold,
    lockoutDurationMs: resolvedLockoutDuration,
    rateLimitMax: resolvedRlMax,
    rateLimitWindowMs: resolvedRlWindow,
  };
}

/** Convenience: load from process.env directly. */
export function loadOperatorUIConfigFromEnv(): OperatorUIConfig {
  return loadOperatorUIConfig(process.env);
}

// ---------------------------------------------------------------------------
// Redaction helper
// ---------------------------------------------------------------------------

const SENSITIVE_KEYS = new Set([
  'password',
  'OPERATOR_UI_PASSWORD',
  'authorization',
  'Authorization',
]);

/**
 * Return a redacted copy of an object — replaces sensitive values with
 * `'***'` so they never appear in error messages, logs, or health surfaces.
 */
export function redact(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = '***';
    } else if (typeof val === 'object' && val !== null) {
      result[key] = redact(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}
