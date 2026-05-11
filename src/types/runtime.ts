// ── Runtime type definitions ──
// Shared DTOs used across the Pi runtime shell, scheduler, persistence, and health surface.
// No implementation here — these are pure data shapes consumed by later tasks.

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Ordered lifecycle states the runtime transitions through. */
export enum LifecycleState {
  /** Process started, loading config and initializing subsystems. */
  Booting = 'booting',
  /** All subsystems healthy, scheduler loop active. */
  Running = 'running',
  /** One or more non-critical subsystems have failed; loop continues in limited capacity. */
  Degraded = 'degraded',
  /** Graceful shutdown complete or fatal error — process will exit or has exited. */
  Stopped = 'stopped',
}

/** A structured lifecycle transition event. */
export interface LifecycleEvent {
  /** Timestamp (epoch ms) when the transition occurred. */
  timestamp: number;
  /** The state the runtime transitioned to. */
  state: LifecycleState;
  /** Human-readable reason for the transition. */
  reason: string;
  /** Optional diagnostic context (not rendered on health surfaces). */
  diagnostic?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Market phase
// ---------------------------------------------------------------------------

/** India NSE market session phases used by the scheduler. */
export enum MarketPhase {
  /** Before market open (9:00–9:15 IST). */
  PreMarket = 'pre_market',
  /** Regular trading session (9:15–15:30 IST). */
  Regular = 'regular',
  /** Post-market / closing session (15:30–16:00 IST). */
  PostMarket = 'post_market',
  /** Market closed. */
  Closed = 'closed',
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** Current state of the supervised scheduler loop. */
export enum SchedulerStatus {
  /** Loop has not started yet. */
  Idle = 'idle',
  /** Loop is actively running iterations. */
  Running = 'running',
  /** Loop is paused (operator intervention or degraded condition). */
  Paused = 'paused',
  /** Loop encountered an unrecoverable error and stopped. */
  Stopped = 'stopped',
}

/** Snapshot of the scheduler's current state suitable for health surfaces. */
export interface SchedulerState {
  status: SchedulerStatus;
  /** Current market phase the scheduler is operating in. */
  marketPhase: MarketPhase;
  /** Unix timestamp (ms) of the last completed tick iteration. */
  lastTickTimestamp: number | null;
  /** Unix timestamp (ms) when the scheduler loop started. */
  startedAt: number | null;
  /** Total number of tick iterations completed since start. */
  tickCount: number;
  /** Error message from the most recent failure, if any. */
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** Overall runtime health classification. */
export enum HealthVerdict {
  Healthy = 'healthy',
  Degraded = 'degraded',
  Unhealthy = 'unhealthy',
}

/** Machine-readable health check response. */
export interface HealthStatus {
  verdict: HealthVerdict;
  uptimeMs: number;
  lifecycleState: LifecycleState;
  scheduler: SchedulerState;
  /** List of active degradation reasons (empty when healthy). */
  degradedReasons: string[];
  /** ISO‑8601 timestamp of this health snapshot. */
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Zerodha — config, session, health
// ---------------------------------------------------------------------------

/** Zerodha-specific configuration (null when env vars are absent). */
export interface ZerodhaConfig {
  /** Zerodha Kite Connect API key. */
  apiKey: string;
  /** Zerodha Kite Connect API secret. */
  apiSecret: string;
  /** Zerodha user ID. */
  userId: string;
  /** TOTP key used for daily 2FA session creation. */
  totpKey: string;
  /** Session refresh interval in ms (default: 21_600_000 = 6h, shorter than the 24h Kite limit). */
  sessionRefreshIntervalMs: number;
}

/** Machine-readable Zerodha session state. */
export enum ZerodhaSessionState {
  /** Valid session material present. */
  Authenticated = 'authenticated',
  /** No session material or persisted row. */
  MissingCredentials = 'missing_credentials',
  /** Token exchange was attempted and failed. */
  AuthFailed = 'auth_failed',
  /** Previous session has expired and refresh has not been attempted or failed. */
  Expired = 'expired',
}

/** Persisted session row shape (full — includes token material for internal use). */
export interface ZerodhaSessionRow {
  /** Kite access token obtained after login. */
  accessToken: string;
  /** Unix timestamp (ms) when the token was obtained. */
  obtainedAt: number;
  /** Unix timestamp (ms) when the token expires. */
  expiresAt: number;
  /** Current session state. */
  state: ZerodhaSessionState;
  /** Human-readable reason for the current state. */
  reason: string;
  /** Last error detail, if any. */
  lastError: string | null;
}

/** Health-facing session snapshot — NEVER includes token values. */
export interface ZerodhaSessionHealth {
  /** Current session state. */
  state: ZerodhaSessionState;
  /** Unix timestamp (ms) when the token was obtained (0 if never). */
  obtainedAt: number;
  /** Unix timestamp (ms) when the token expires (0 if unknown). */
  expiresAt: number;
  /** Human-readable reason for the current state. */
  reason: string;
  /** Last error detail, if any (not emitted on health surfaces). */
  lastError: string | null;
  /** Unix timestamp (ms) of the last auth check. */
  lastAuthCheckAt: number;
}

/** A single ingestion event record. */
export interface IngestionEvent {
  id: number;
  /** Type of ingestion (e.g. 'instrument_master', 'quote', 'tick'). */
  eventType: string;
  /** Unix timestamp (ms) when the event was recorded. */
  recordedAt: number;
  /** Duration of the ingestion in ms, or null. */
  durationMs: number | null;
  /** Number of items ingested, or null. */
  itemCount: number | null;
  /** Error message if the ingestion failed, or null. */
  error: string | null;
  /** Additional diagnostic JSON. */
  diagnostic: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Runtime configuration loaded from environment at startup. */
export interface RuntimeConfig {
  /** HTTP health server port. Default: 3000. */
  port: number;
  /** Runtime environment label. */
  nodeEnv: 'development' | 'production' | 'test';
  /** IANA timezone for the active market (default: Asia/Kolkata). */
  marketTimezone: string;
  /** Scheduler loop interval in milliseconds. Default: 60_000. */
  schedulerIntervalMs: number;
  /** Path to SQLite database file. Default: ./data/trader.db. */
  dbPath: string;
  /** Logging level. Default: info. */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Zerodha integration config. Null when env vars are absent. */
  zerodha: ZerodhaConfig | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Parsed and structured configuration validation error. */
export interface ConfigValidationError {
  field: string;
  message: string;
  provided: unknown;
}
