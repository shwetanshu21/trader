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
  /** Neutral broker health block. Present when any broker transport is configured. */
  broker?: BrokerHealth;
  /** Backward-compatible alias for older Zerodha-shaped consumers. */
  zerodha?: BrokerHealth;
  /** ISO‑8601 timestamp of this health snapshot. */
  checkedAt: string;
}

/** Broker health block — published on /health for agent observability. */
export interface BrokerHealth {
  /** Session authentication state. */
  session: BrokerSessionHealth;
  /** Instrument master freshness summary. */
  instruments: {
    /** Last successful sync timestamp (ms), or null. */
    lastSuccessAt: number | null;
    /** Number of instruments in the last successful sync. */
    instrumentCount: number | null;
    /** Staleness in ms, or null if never synced. */
    stalenessMs: number | null;
    /** Whether the instrument store is stale. */
    isStale: boolean;
  };
  /** Quote stream status. */
  stream: {
    /** Stream connection state. */
    state: string;
    /** Number of reconnection attempts. */
    reconnectCount: number;
    /** Whether the quote feed is stale. */
    isStale: boolean;
    /** Staleness in ms, or null if no quote ever received. */
    stalenessMs: number | null;
    /** Last quote received timestamp (ms), or null. */
    lastQuoteAt: number | null;
  };
  /** Recent ingestion event summaries (newest first, max 5). */
  recentEvents: Array<{
    eventType: string;
    recordedAt: number;
    durationMs: number | null;
    itemCount: number | null;
    error: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Broker transport — config, session, health
// ---------------------------------------------------------------------------

/** Broker transport configuration (null when env vars are absent). */
export interface BrokerConfig {
  /** Broker transport mode: direct Kite auth or remote Kite MCP. */
  transport?: 'direct' | 'mcp';
  /** Session refresh interval in ms (default: 21_600_000 = 6h). */
  sessionRefreshIntervalMs: number;
  /** Zerodha Kite Connect API key (direct mode). */
  apiKey?: string;
  /** Zerodha Kite Connect API secret (direct mode). */
  apiSecret?: string;
  /** Zerodha user ID (direct mode). */
  userId?: string;
  /** TOTP key used for daily 2FA session creation (direct mode). */
  totpKey?: string;
  /** Zerodha Kite MCP endpoint URL (MCP mode). */
  mcpUrl?: string;
  /** Optional bearer token or session token for the MCP endpoint. */
  mcpAuthToken?: string;
  /** Per-request timeout for MCP calls in ms. */
  mcpTimeoutMs?: number;
  /** Quote polling interval used by the MCP-backed quote stream in ms. */
  quotePollIntervalMs?: number;
  /** Instrument refresh interval in ms for MCP-backed sync. */
  instrumentRefreshIntervalMs?: number;
  /** Optional explicit MCP tool overrides when auto-discovery is insufficient. */
  mcpTools?: {
    session?: string;
    instruments?: string;
    quotes?: string;
  };
}

/** Machine-readable broker session state. */
export enum BrokerSessionState {
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
export interface BrokerSessionRow {
  /** Kite access token obtained after login. */
  accessToken: string;
  /** Unix timestamp (ms) when the token was obtained. */
  obtainedAt: number;
  /** Unix timestamp (ms) when the token expires. */
  expiresAt: number;
  /** Current session state. */
  state: BrokerSessionState;
  /** Human-readable reason for the current state. */
  reason: string;
  /** Last error detail, if any. */
  lastError: string | null;
}

/** Health-facing session snapshot — NEVER includes token values. */
export interface BrokerSessionHealth {
  /** Current session state. */
  state: BrokerSessionState;
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
  /** Broker transport config. Null when env vars are absent. */
  broker?: BrokerConfig | null;
  /** Backward-compatible alias during the rename. */
  zerodha: BrokerConfig | null;
  /** Proposal engine config. Null when env vars are absent (graceful degraded mode). */
  proposalEngine: ProposalEngineConfig | null;
}

// ---------------------------------------------------------------------------
// Proposal engine config
// ---------------------------------------------------------------------------

/** Supported transport shapes for the proposal-generation provider. */
export type ProposalProviderMode = 'custom' | 'openai-compatible';

/** Configuration for the proposal-generation provider (LLM). Null when not configured. */
export interface ProposalEngineConfig {
  /** Provider transport shape. Defaults to the legacy custom JSON contract. */
  providerMode: ProposalProviderMode;
  /** Base URL of the proposal-generation provider API. */
  providerUrl: string;
  /** Model identifier for OpenAI-compatible providers. */
  providerModel?: string;
  /** Request timeout in ms. */
  timeoutMs: number;
  /** Maximum proposals to generate per tick. */
  maxProposalsPerTick: number;
  /** API key for the provider. */
  apiKey?: string;
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

// ---------------------------------------------------------------------------
// Proposal engine — DTOs for trade proposal generation, validation, persistence
// ---------------------------------------------------------------------------

/** Status of a proposal attempt. */
export enum ProposalStatus {
  /** Proposal was accepted (passed all validation checks). */
  Accepted = 'accepted',
  /** Proposal was refused (one or more validation failures). */
  Refused = 'refused',
  /** Proposal was skipped (overlap with prior attempt, no re-evaluation needed). */
  Skipped = 'skipped',
  /** Proposal is pending validation (intermediate state during evaluation). */
  Pending = 'pending',
}

/**
 * Machine-readable validation reason codes.
 * Determined by the validator — downstream slices consume these without reinterpretation.
 */
export enum ValidationReasonCode {
  /** The instrument symbol is unknown / not in the instrument master. */
  UnknownSymbol = 'unknown_symbol',
  /** Quantity is zero or negative. */
  ZeroQuantity = 'zero_quantity',
  /** Trade side is missing or invalid. */
  MissingSide = 'missing_side',
  /** Product type is missing or invalid (MIS/CNC/NRML). */
  MissingProduct = 'missing_product',
  /** The order type is unsupported. */
  InvalidOrderType = 'invalid_order_type',
  /** Price violates exchange price band. */
  PriceBandViolation = 'price_band_violation',
  /** Position or exposure limit would be exceeded. */
  PositionLimitExceeded = 'position_limit_exceeded',
  /** Market is closed for this segment. */
  MarketClosed = 'market_closed',
  /** Duplicate proposal attempt (same symbol+side already processed this tick). */
  DuplicateAttempt = 'duplicate_attempt',
  /** Segment is not supported for trading. */
  InvalidSegment = 'invalid_segment',
  /** Lot size constraint not met (quantity not multiple of lot size). */
  LotSizeMismatch = 'lot_size_mismatch',
  /** Instrument metadata lookup failed. */
  InstrumentLookupFailed = 'instrument_lookup_failed',
  /** Session is not authenticated / missing credentials. */
  SessionNotAuthenticated = 'session_not_authenticated',
  /** Session has expired or will expire imminently. */
  SessionExpired = 'session_expired',
  /** No quote snapshot available for the instrument. */
  QuoteMissing = 'quote_missing',
  /** Existing quote snapshot is stale. */
  QuoteStale = 'quote_stale',
  /** Instrument master sync is stale or has never completed. */
  InstrumentStale = 'instrument_stale',
  /** Price is not rounded to the instrument's tick size. */
  PriceNotRounded = 'price_not_rounded',
  /** Insufficient metadata to validate the proposal (e.g. missing lot size or tick size). */
  InsufficientMetadata = 'insufficient_metadata',
  /** Proposed exchange/profile does not match the active market profile. */
  CrossMarketMismatch = 'cross_market_mismatch',
  /** F&O proposal is missing expiry context (required for NFO). */
  MissingExpiry = 'missing_expiry',
}

/** A single validation reason attached to a proposal attempt. */
export interface ValidationReason {
  /** Machine-readable reason code. */
  reasonCode: ValidationReasonCode;
  /** Human-readable explanation. */
  reasonMessage: string;
}

/**
 * Normalized proposal attempt — the canonical payload persisted for each supervised tick.
 * Stable identity is exchange + tradingsymbol. instrumentToken is a trace snapshot only.
 */
export interface ProposalAttemptRow {
  /** Auto-increment row ID. */
  id: number;
  /** Exchange (e.g. 'NSE', 'NFO'). */
  exchange: string;
  /** Trading symbol (e.g. 'RELIANCE', 'RELIANCE24DEC3000CE'). */
  tradingsymbol: string;
  /** Kite instrument token (trace snapshot — not stable identity). */
  instrumentToken: number | null;
  /** Trade side: 'buy' or 'sell'. */
  side: string;
  /** Product: 'MIS', 'CNC', 'NRML'. */
  product: string;
  /** Order quantity (always positive). */
  quantity: number;
  /** Limit price, or null for market orders. */
  price: number | null;
  /** Trigger price for SL/SLM orders, or null. */
  triggerPrice: number | null;
  /** Order type: 'MARKET', 'LIMIT', 'SL', 'SLM'. */
  orderType: string;
  /** Optional tag for grouping/identification. */
  tag: string | null;
  /** Current proposal status. */
  proposalStatus: ProposalStatus;
  /** Unix timestamp (ms) when this attempt was created. */
  createdAt: number;
}

/** Shape for inserting a new proposal attempt (without id). */
export type NewProposalAttempt = Omit<ProposalAttemptRow, 'id'>;

/** Validation verdict bundle attached to a proposal attempt. */
export interface ProposalVerdict {
  /** The final proposal status. */
  status: ProposalStatus;
  /** Validation reasons (empty list for Accepted, 1+ for Refused/Skipped). */
  reasons: ValidationReason[];
}

/** A proposal attempt with its full validation trail. */
export interface ProposalAttemptWithReasons extends ProposalAttemptRow {
  reasons: ValidationReason[];
}

// ---------------------------------------------------------------------------
// Provider proposal response types
// ---------------------------------------------------------------------------

/** A single proposal candidate from the provider (before normalization). */
export interface ProviderProposal {
  exchange: string;
  tradingsymbol: string;
  side: 'buy' | 'sell';
  product: string;
  quantity: number;
  price: number | null;
  triggerPrice: number | null;
  orderType: string;
  tag?: string;
}

/** Full response from the proposal-generation provider. */
export interface ProviderProposalResponse {
  proposals: ProviderProposal[];
  reasoning?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Re-export Zerodha instrument types for convenience from runtime boundary
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Execution gate — blocked-order ledger DTOs
// ---------------------------------------------------------------------------

/**
 * Machine-readable block codes for the execution gate.
 * M001 uses a single invariant block code — all proposals are blocked.
 */
export enum BlockCode {
  /** Hard block applied because milestone M001 forbids live order placement. */
  MilestoneExecutionBlockM001 = 'milestone_execution_block_m001',
}

/**
 * A single blocked-order ledger row — persisted for every accepted proposal
 * attempt that reaches the execution gate in M001.
 *
 * Snapshot fields (exchange, tradingsymbol, side, product, quantity, price,
 * trigger_price, order_type, instrument_token) are copied from the source
 * proposal at block time so the ledger remains self-describing even if the
 * proposal row is later GC'd or updated.
 */
export interface BlockedOrderRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → proposal_attempts(id). UNIQUE — idempotency key. */
  proposalAttemptId: number;
  /** Unix timestamp (ms) when this block was recorded. */
  blockedAt: number;
  /** Machine-readable block code. */
  blockCode: BlockCode;
  /** Human-readable block message. */
  blockMessage: string;
  /** Policy/phase tag for grouping (e.g. 'M001-hard-block'). */
  gateTag: string;

  // ── Proposal snapshot fields (copied at block time) ──
  /** Exchange (e.g. 'NSE', 'NFO'). */
  exchange: string;
  /** Trading symbol (e.g. 'RELIANCE'). */
  tradingsymbol: string;
  /** Kite instrument token at time of block (may be null for synthetic proposals). */
  instrumentToken: number | null;
  /** Trade side: 'buy' or 'sell'. */
  side: string;
  /** Product: 'MIS', 'CNC', 'NRML'. */
  product: string;
  /** Order quantity (always positive in a valid proposal). */
  quantity: number;
  /** Limit price, or null for market orders. */
  price: number | null;
  /** Trigger price for SL/SLM orders, or null. */
  triggerPrice: number | null;
  /** Order type: 'MARKET', 'LIMIT', 'SL', 'SLM'. */
  orderType: string;
}

/** Shape for inserting a new blocked-order row (without id). */
export type NewBlockedOrder = Omit<BlockedOrderRow, 'id'>;

// ---------------------------------------------------------------------------
// Operator Dashboard — typed snapshot / read-model DTOs
// ---------------------------------------------------------------------------

/**
 * Top-level operator dashboard snapshot.
 *
 * Joins live health, market profile, runtime lifecycle, broker status,
 * recent proposals, blocked-order ledger, and recent lifecycle events.
 * Token-safe: never includes access tokens, API keys, or raw secret-bearing config.
 * Bounded: recent lists are limited to the most recent entries only.
 */
export interface DashboardSnapshot {
  /** ISO‑8601 timestamp when this snapshot was assembled. */
  assembledAt: string;
  /** Market profile identity and current session metadata. */
  marketProfile: DashboardMarketProfile;
  /** Runtime health verdict and degradation reasons. */
  health: DashboardHealth;
  /** Scheduler and lifecycle runtime state. */
  runtime: DashboardRuntime;
  /** Neutral broker health block — null when broker not configured. */
  broker: DashboardBroker | null;
  /** Recent proposal attempts with outcome/reasons (newest first, max 20). */
  recentProposals: DashboardRecentProposal[];
  /** Recent blocked-order ledger entries (newest first, max 20). */
  recentBlockedOrders: DashboardBlockedOrder[];
  /** Recent lifecycle transition events (newest first, max 10). */
  recentLifecycleEvents: DashboardLifecycleEvent[];
  /** Recent strategy decisions (newest first, max 20). */
  recentStrategyDecisions: DashboardStrategyDecision[];
  /** Universe coverage summary — null when no snapshot has been computed. */
  universe: DashboardUniverse | null;
}

/** Market profile identity and session metadata. */
export interface DashboardMarketProfile {
  /** Unique market identifier (e.g. 'INDIA_NSE_EQ'). */
  marketId: string;
  /** Human-readable label (e.g. 'NSE India Equities'). */
  displayName: string;
  /** IANA timezone (e.g. 'Asia/Kolkata'). */
  timezone: string;
  /** Current market phase string. */
  currentPhase: string;
  /** Whether today is a trading day. */
  isTradingDay: boolean;
  /** Settlement cycle label (e.g. 'T+1'). */
  settlementCycle: string;
}

/** Runtime health — verdict, lifecycle, degradation reasons. */
export interface DashboardHealth {
  /** Health verdict: 'healthy', 'degraded', or 'unhealthy'. */
  verdict: string;
  /** Process uptime in milliseconds. */
  uptimeMs: number;
  /** Current lifecycle state. */
  lifecycleState: string;
  /** Active degradation reasons (empty when healthy). */
  degradedReasons: string[];
  /** ISO‑8601 timestamp of the health check. */
  checkedAt: string;
}

/** Scheduler and lifecycle runtime state. */
export interface DashboardRuntime {
  /** Scheduler status: 'idle', 'running', 'paused', or 'stopped'. */
  schedulerStatus: string;
  /** Current market phase the scheduler is operating in. */
  marketPhase: string;
  /** Unix timestamp (ms) of the last completed tick, or null. */
  lastTickTimestamp: number | null;
  /** Unix timestamp (ms) when the scheduler started, or null. */
  startedAt: number | null;
  /** Total tick iterations since start. */
  tickCount: number;
  /** Most recent scheduler error, or null. */
  lastError: string | null;
}

/** Broker health block — redacted, token-safe. */
export interface DashboardBroker {
  /** Session authentication state string. */
  sessionState: string;
  /** Instrument master summary. */
  instruments: {
    /** Number of instruments in the last successful sync, or null. */
    count: number | null;
    /** Whether the instrument store is stale. */
    isStale: boolean;
  };
  /** Quote stream status. */
  stream: {
    /** Stream connection state string. */
    state: string;
    /** Whether the quote feed is stale. */
    isStale: boolean;
    /** Last quote received timestamp (ms), or null. */
    lastQuoteAt: number | null;
  };
  /** Number of recent ingestion events. */
  recentEventCount: number;
}

/** Universe coverage summary as shown on the dashboard. */
export interface DashboardUniverse {
  /** Policy version that was applied. */
  policyVersion: string;
  /** ISO‑8601 timestamp when the snapshot was computed (or null if never). */
  computedAt: string | null;
  /** Coverage verdict string. */
  verdict: string;
  /** Number of eligible (tradable) members. */
  eligibleCount: number;
  /** Number of eligible members with a fresh quote. */
  freshQuoteCount: number;
  /** Number of eligible members with a stale quote. */
  staleQuoteCount: number;
  /** Number of eligible members with no quote at all. */
  missingQuoteCount: number;
  /** Threshold configuration label. */
  thresholdLabel: string;
}

/** A recent proposal attempt for the dashboard (redacted — no tokens). */
export interface DashboardRecentProposal {
  /** Proposal attempt row ID. */
  id: number;
  /** Exchange (e.g. 'NSE', 'NFO'). */
  exchange: string;
  /** Trading symbol (e.g. 'RELIANCE'). */
  tradingsymbol: string;
  /** Trade side. */
  side: string;
  /** Product type. */
  product: string;
  /** Final proposal status. */
  status: string;
  /** Validation reason messages (empty for accepted proposals). */
  reasons: string[];
  /** ISO‑8601 timestamp when the proposal was created. */
  createdAt: string;
}

/** A blocked-order ledger entry for the dashboard. */
export interface DashboardBlockedOrder {
  /** Blocked-order row ID. */
  id: number;
  /** Source proposal attempt ID. */
  proposalAttemptId: number;
  /** ISO‑8601 timestamp when the block was recorded. */
  blockedAt: string;
  /** Machine-readable block code. */
  blockCode: string;
  /** Human-readable block message. */
  blockMessage: string;
  /** Exchange. */
  exchange: string;
  /** Trading symbol. */
  tradingsymbol: string;
  /** Trade side. */
  side: string;
}

/** A lifecycle transition event for the dashboard. */
export interface DashboardLifecycleEvent {
  /** ISO‑8601 timestamp of the transition. */
  timestamp: string;
  /** The state the runtime transitioned to. */
  state: string;
  /** Human-readable reason for the transition. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Strategy decision — dashboard read-model DTOs
// ---------------------------------------------------------------------------

/**
 * A single strategy decision for the operator dashboard.
 * Covers both approved candidates and refused decisions with reasons.
 * Token-safe: never includes access tokens, API keys, or secret-bearing material.
 */
export interface DashboardStrategyDecision {
  /** Strategy decision row ID. */
  id: number;
  /** Source proposal attempt ID. */
  proposalAttemptId: number;
  /** Decision status: 'approved' or 'refused'. */
  decisionStatus: string;
  /** Strategy identity (e.g. 'india-nse-eq-v1'). */
  strategyId: string;
  /** Strategy version (e.g. '1.0.0'). */
  strategyVersion: string;
  /** ISO‑8601 timestamp when the decision was made. */
  decidedAt: string;
  /** Determined exchange (e.g. 'NSE'). */
  exchange: string;
  /** Determined trading symbol. */
  tradingsymbol: string;
  /** Trade side. */
  side: string;
  /** Deterministic product. */
  product: string;
  /** Deterministic order quantity (lot-size rounded). */
  quantity: number;
  /** Limit price, or null for market orders. */
  price: number | null;
  /** Trigger price for SL/SLM orders, or null. */
  triggerPrice: number | null;
  /** Deterministic order type. */
  orderType: string;
  /** Estimated notional value, or null. */
  notional: number | null;
  /** The basis used for sizing (e.g. 'last_price'). */
  sizingBasis: string;
  /** Exposure category tag (e.g. 'intraday'), or null. */
  exposureTag: string | null;
  /** Reference last price at decision time, or null. */
  lastPrice: number | null;
  /** Ordered refusal reason messages (empty when approved). */
  reasons: string[];
}

export type ZerodhaConfig = BrokerConfig;
export const ZerodhaSessionState = BrokerSessionState;
export type ZerodhaSessionState = BrokerSessionState;
export type ZerodhaSessionRow = BrokerSessionRow;
export type ZerodhaSessionHealth = BrokerSessionHealth;

// ---------------------------------------------------------------------------
// Universe selection — tradable bounded-universe DTOs
// ---------------------------------------------------------------------------

/** Coverage verdict for the tradable universe. */
export enum UniverseCoverageVerdict {
  /** All or nearly all eligible members have fresh quotes. */
  Sufficient = 'sufficient',
  /** Most eligible members have quotes but some are stale. */
  Stale = 'stale',
  /** Significant number of eligible members have missing or stale quotes. */
  Degraded = 'degraded',
  /** Universe has never been evaluated (instrument sync never completed). */
  Unknown = 'unknown',
}

/** Per-member coverage status within a universe snapshot. */
export interface UniverseMemberCoverage {
  exchange: string;
  tradingsymbol: string;
  instrumentToken: number | null;
  /** Whether this member is in the eligible (tradable) set. */
  isEligible: boolean;
  /** Whether a quote snapshot exists for this member. */
  hasQuote: boolean;
  /** Staleness of the quote in ms. 0 when no quote exists. */
  quoteStalenessMs: number;
  /** Timestamp (ms) of the last quote received, or null. */
  lastQuoteAt: number | null;
  /** Human-readable reason if ineligible (e.g. 'not_in_allowlist', 'not_in_instrument_master'). */
  ineligibilityReason: string | null;
}

/** Complete universe coverage snapshot. */
export interface UniverseSnapshot {
  /** Auto-increment row ID. */
  id: number;
  /** Policy version that was applied. */
  policyVersion: string;
  /** Unix timestamp (ms) when this snapshot was computed. */
  computedAt: number;
  /** Coverage verdict. */
  verdict: UniverseCoverageVerdict;
  /** Number of eligible (tradable) members. */
  eligibleCount: number;
  /** Number of ineligible members. */
  ineligibleCount: number;
  /** Number of eligible members with a fresh quote. */
  freshQuoteCount: number;
  /** Number of eligible members with a stale quote. */
  staleQuoteCount: number;
  /** Number of eligible members with no quote at all. */
  missingQuoteCount: number;
  /** Threshold configuration label that was used. */
  thresholdLabel: string;
  /** Minimum fresh quote ratio required (0..1). */
  thresholdRatio: number;
  /** Maximum stale quote staleness in ms. */
  maxStalenessMs: number;
  /** Per-member coverage details. */
  members: UniverseMemberCoverage[];
}

/** Shape for inserting a new universe snapshot (without id). */
export type NewUniverseSnapshot = Omit<UniverseSnapshot, 'id'>;

/** Universe policy — the deterministic allowlist and threshold rules. */
export interface UniversePolicyConfig {
  /** Policy version string (semver-style). */
  version: string;
  /** Human-readable label for the policy. */
  label: string;
  /** Map of exchange → array of eligible tradingsymbols. */
  allowlist: Record<string, string[]>;
  /** Minimum ratio of eligible members with fresh quotes to consider coverage sufficient. */
  sufficientThresholdRatio: number;
  /** Quote staleness in ms beyond which a quote is considered stale. */
  maxQuoteStalenessMs: number;
}

// ---------------------------------------------------------------------------
// Strategy decision — deterministic authority layer between proposal and execution
// ---------------------------------------------------------------------------

/** Status of a deterministic strategy decision. */
export enum StrategyDecisionStatus {
  /** Strategy approved this proposal as a trade candidate with derived risk/sizing. */
  Approved = 'approved',
  /** Strategy refused this proposal with machine-readable reasons. */
  Refused = 'refused',
}

/**
 * Machine-readable strategy refusal reason codes.
 * These are deterministic — the strategy layer produces these based on policy,
 * market data, and risk rules, distinct from pre-strategy validation codes.
 */
export enum StrategyDecisionReasonCode {
  /** The proposal's segment is not supported by the active strategy policy. */
  UnsupportedSegment = 'unsupported_segment',
  /** Quote data required for deterministic sizing is missing. */
  MissingQuoteData = 'missing_quote_data',
  /** Quote data is stale beyond the strategy's freshness threshold. */
  StaleQuoteData = 'stale_quote_data',
  /** Instrument metadata (lot size, tick size) is missing or incomplete. */
  MissingInstrumentMetadata = 'missing_instrument_metadata',
  /** Calculated notional value is below the minimum threshold. */
  BelowMinimumNotional = 'below_minimum_notional',
  /** Derived quantity rounds to zero after lot-size adjustment. */
  ZeroQuantityAfterRounding = 'zero_quantity_after_rounding',
  /** The instrument is not in the bounded universe allowlist. */
  NotInUniverse = 'not_in_universe',
  /** The proposal's exchange does not match the active market profile. */
  ProfileMismatch = 'profile_mismatch',
  /** Insufficient liquidity based on quote depth (bid/ask spread or volume). */
  InsufficientLiquidity = 'insufficient_liquidity',
  /** Strategy-specific constraint not covered by other codes. */
  PolicyConstraint = 'policy_constraint',
}

/** A single strategy decision reason (code + human-readable message). */
export interface StrategyDecisionReason {
  /** Machine-readable reason code. */
  reasonCode: StrategyDecisionReasonCode;
  /** Human-readable explanation. */
  reasonMessage: string;
}

/** Reference quote snapshot fields captured at strategy-decision time. */
export interface StrategyQuoteSnapshot {
  lastPrice: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  /** Unix timestamp (ms) when the quote was received by the system. */
  receivedAt: number | null;
}

/** Risk metadata computed at strategy-decision time. */
export interface StrategyRiskMetadata {
  /** Estimated notional value (quantity × reference price). */
  notional: number | null;
  /** The basis used for sizing (e.g. 'last_price', 'bid', 'ask'). */
  sizingBasis: string;
  /** Max loss for this position in rupees, if computable. */
  maxLossRupees: number | null;
  /** Stop-loss distance from entry, if applicable. */
  stopDistance: number | null;
  /** Exposure category tag (e.g. 'intraday', 'delivery'). */
  exposureTag: string | null;
}

/**
 * Full persisted strategy decision row.
 *
 * One row per proposal attempt (UNIQUE on proposal_attempt_id).
 * Carries deterministic strategy-approved fields that override raw proposal values.
 */
export interface StrategyDecisionRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → proposal_attempts(id). UNIQUE — idempotency key. */
  proposalAttemptId: number;
  /** Decision status. */
  decisionStatus: StrategyDecisionStatus;
  /** Strategy identity (e.g. 'india-nse-eq-v1'). */
  strategyId: string;
  /** Strategy version (semver-style, e.g. '1.0.0'). */
  strategyVersion: string;
  /** Unix timestamp (ms) when this decision was recorded. */
  decidedAt: number;

  // ── Canonical deterministic fields (override raw proposal values) ──
  /** Determined exchange (e.g. 'NSE'). */
  exchange: string;
  /** Determined trading symbol. */
  tradingsymbol: string;
  /** Trade side: 'buy' or 'sell' (carried from proposal). */
  side: string;
  /** Deterministic product (e.g. 'MIS', 'CNC'). */
  product: string;
  /** Deterministic order quantity (lot-size rounded, always positive). */
  quantity: number;
  /** Deterministic limit price, or null for market orders. */
  price: number | null;
  /** Deterministic trigger price for SL/SLM orders, or null. */
  triggerPrice: number | null;
  /** Deterministic order type (e.g. 'MARKET', 'LIMIT'). */
  orderType: string;

  // ── Reference quote snapshot at decision time ──
  quoteLastPrice: number | null;
  quoteBid: number | null;
  quoteAsk: number | null;
  quoteVolume: number | null;
  quoteReceivedAt: number | null;

  // ── Risk metadata ──
  riskNotional: number | null;
  riskSizingBasis: string;
  riskMaxLossRupees: number | null;
  riskStopDistance: number | null;
  riskExposureTag: string | null;
}

/** Shape for inserting a new strategy decision (without id). */
export type NewStrategyDecision = Omit<StrategyDecisionRow, 'id'>;

/**
 * Read-model DTO — a strategy-approved trade candidate ready for downstream
 * execution consumption. Contains only the fields an execution gate needs.
 */
export interface StrategyApprovedCandidate {
  /** Strategy decision row ID. */
  id: number;
  /** Source proposal attempt ID. */
  proposalAttemptId: number;
  /** Strategy identity. */
  strategyId: string;
  /** Strategy version. */
  strategyVersion: string;
  /** Unix timestamp (ms) when the decision was made. */
  decidedAt: number;

  // ── Canonical deterministic order fields ──
  exchange: string;
  tradingsymbol: string;
  side: string;
  product: string;
  quantity: number;
  price: number | null;
  triggerPrice: number | null;
  orderType: string;

  // ── Reference quote snapshot ──
  lastPrice: number | null;
  bid: number | null;
  ask: number | null;

  // ── Risk summary ──
  notional: number | null;
  sizingBasis: string;
}

/**
 * Read-model DTO — a strategy refusal with its ordered reasons.
 */
export interface StrategyRefusal {
  /** Strategy decision row ID. */
  id: number;
  /** Source proposal attempt ID. */
  proposalAttemptId: number;
  /** Unix timestamp (ms) when the decision was made. */
  decidedAt: number;
  /** Ordered refusal reasons. */
  reasons: StrategyDecisionReason[];
}

export type {
  InstrumentRecord,
  InstrumentSyncState,
  InstrumentSyncResult,
  InstrumentType,
  SupportedSegment,
  RawInstrumentCsvRow,
  InstrumentFreshnessConfig,
  QuoteSnapshot,
  StreamDiagnostics,
  StreamState,
  QuoteFreshness,
  QuoteFreshnessConfig,
  KiteTick,
  WebSocketFactory,
  SubscribedInstrument,
} from '../integrations/broker/types.js';
