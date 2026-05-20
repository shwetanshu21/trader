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
  /** Execution mode config. Default: blocked. */
  execution: ExecutionConfig;
  /** Strategy framework config. */
  strategy: StrategyFrameworkConfig;
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
  /** Execution evidence block — null when no attempt repo is wired. */
  execution: ExecutionHealth | null;
  /** Lifecycle governance evidence — null when no lifecycle repo is wired. */
  lifecycleGovernance: DashboardLifecycleGovernance | null;
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
 * Operator-facing hybrid evidence for a strategy decision.
 *
 * Nested block within DashboardStrategyDecision that carries deterministic
 * component scores, LLM status/rationale, merged score, and derived
 * downgrade context. Set to null when no persisted hybrid evidence exists.
 *
 * Reuses S02 hybrid primitives (LLMStatus, MergePolicy) rather than
 * inventing parallel enums. Token-safe.
 */
export interface DashboardHybridEvidence {
  /** Final aggregated deterministic score (0–1). */
  deterministicScore: number;
  /** LLM-provided score (0–1), or null when LLM was not consulted or failed. */
  llmScore: number | null;
  /** LLM provider consultation status (reuses LLMStatus enum values). */
  llmStatus: string;
  /** Human-readable LLM rationale, or null. */
  llmRationale: string | null;
  /** Final merged score (0–1) after applying the merge policy. */
  mergedScore: number;
  /** The merge policy that was applied (reuses MergePolicy enum values). */
  mergePolicy: string;
  /** Ordered deterministic component scores. */
  components: Array<{
    /** Component name (e.g. 'momentum', 'volume'). */
    componentName: string;
    /** Component score (0–1). */
    score: number;
    /** Component weight in the deterministic aggregation. */
    weight: number;
  }>;
  /** Whether the decision was effectively downgraded by hybrid scoring. */
  isDowngraded: boolean;
  /** Human-readable downgrade explanation, or null. */
  downgradeContext: string | null;
}

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
  /** Hybrid scoring evidence, or null when no persisted hybrid evidence exists. */
  hybrid: DashboardHybridEvidence | null;
  /**
   * Compact India research evidence — null when no research evidence influenced
   * this decision. Carries bounded summary, semantic tags, freshness marker,
   * and influence context so operators can see why India-specific context
   * changed rankings without reconstructing prompt text from logs.
   *
   * All fields are bounded per IndiaResearchDecisionEvidence contract.
   * Null-safe: older decisions without evidence render cleanly.
   */
  indiaResearchEvidence: IndiaResearchDecisionEvidence | null;
  // ── Execution-class metadata (S03) ──
  /** High-level execution class: 'EQ' or 'FO'. */
  executionClass: string;
  /** Market segment (e.g. 'NSE', 'NFO'). */
  segment: string;
  /** Instrument type (e.g. 'EQ', 'FUT', 'CE', 'PE'). */
  instrumentType: string;
  /** Expiry date in YYYY-MM-DD format, or null for EQ. */
  expiry: string | null;
  /** Strike price, or null for EQ. */
  strike: number | null;
  /** Lot size (1 for EQ). */
  lotSize: number;
  /** Tick size (minimum price increment). */
  tickSize: number;
  /** Freeze quantity from broker instrument master, or null when unavailable. */
  freezeQuantity: number | null;
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
// Execution class — distinguishes cash-equity (EQ) from F&O (FO) execution
// ---------------------------------------------------------------------------

/**
 * High-level execution class that governs class-aware safeguards.
 *
 * - `EQ`: Cash-equity execution (NSE EQ segment).
 * - `FO`: Futures & Options execution (NFO segment).
 */
export type ExecutionClass = 'EQ' | 'FO';

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
  /** The derived execution class is not supported by the active policy. */
  ExecutionClassNotSupported = 'execution_class_not_supported',
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
  /** The basis used for sizing (e.g. 'last_price', 'bid', 'ask', 'risk_budget'). */
  sizingBasis: string;
  /** Max loss for this position in rupees, if computable. */
  maxLossRupees: number | null;
  /** Stop-loss distance from entry, if applicable. */
  stopDistance: number | null;
  /** Initial stop-loss price, if computable. */
  stopPrice: number | null;
  /** Trailing-stop distance from the best favorable price, if enabled. */
  trailingStopDistance: number | null;
  /** Current per-trade risk budget in rupees used for sizing, if any. */
  riskBudgetRupees: number | null;
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
  /** Initial stop-loss price at decision time, or null. */
  riskStopPrice: number | null;
  /** Trailing-stop distance in price units, or null. */
  riskTrailingStopDistance: number | null;
  /** Per-trade risk budget used for sizing, or null. */
  riskBudgetRupees: number | null;
  riskExposureTag: string | null;
  /** India research evidence — null when no research evidence influenced this decision. */
  indiaResearchEvidence: IndiaResearchDecisionEvidence | null;

  // ── Execution-class metadata (S03) ──
  /** High-level execution class: 'EQ' or 'FO'. */
  executionClass: ExecutionClass;
  /** Market segment (e.g. 'NSE', 'NFO'). */
  segment: string;
  /** Instrument type (e.g. 'EQ', 'FUT', 'CE', 'PE'). */
  instrumentType: string;
  /** Expiry date in YYYY-MM-DD format, or null for EQ. */
  expiry: string | null;
  /** Strike price, or null for EQ. */
  strike: number | null;
  /** Lot size (1 for EQ). */
  lotSize: number;
  /** Tick size (minimum price increment). */
  tickSize: number;
  /** Freeze quantity from broker instrument master, or null when unavailable. */
  freezeQuantity: number | null;
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
  /** Max loss in rupees implied by entry sizing/stop, or null. */
  maxLossRupees: number | null;
  /** Initial stop distance in price units, or null. */
  stopDistance: number | null;
  /** Initial stop price, or null. */
  stopPrice: number | null;
  /** Trailing-stop distance in price units, or null. */
  trailingStopDistance: number | null;
  /** Per-trade risk budget used for sizing, or null. */
  riskBudgetRupees: number | null;

  // ── Execution-class metadata (S03) ──
  /** High-level execution class: 'EQ' or 'FO'. */
  executionClass: ExecutionClass;
  /** Market segment (e.g. 'NSE', 'NFO'). */
  segment: string;
  /** Instrument type (e.g. 'EQ', 'FUT', 'CE', 'PE'). */
  instrumentType: string;
  /** Expiry date in YYYY-MM-DD format, or null for EQ. */
  expiry: string | null;
  /** Strike price, or null for EQ. */
  strike: number | null;
  /** Lot size (1 for EQ). */
  lotSize: number;
  /** Tick size (minimum price increment). */
  tickSize: number;
  /** Freeze quantity from broker instrument master, or null when unavailable. */
  freezeQuantity: number | null;
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

// ---------------------------------------------------------------------------
// Execution — mode config, attempt/outcome DTOs, and broker placement seam
// ---------------------------------------------------------------------------

/**
 * Execution mode for the runtime.
 * - `blocked`: All execution attempts are recorded as refused with a milestone-hard-block
 *   reason (fallback while M003 hard block is active).
 * - `paper`: Execution attempts proceed through paper-broker simulation; no real orders placed.
 * - `live`: Execution attempts proceed through the live broker transport.
 */
export enum ExecutionMode {
  Blocked = 'blocked',
  Paper = 'paper',
  Live = 'live',
}

/** Status of a single execution attempt. */
export enum ExecutionAttemptStatus {
  /** Attempt is pending (intermediate state before dispatch). */
  Pending = 'pending',
  /** Attempt was dispatched to the broker placement seam. */
  Dispatched = 'dispatched',
  /** Attempt completed with a definitive outcome. */
  Completed = 'completed',
  /** Attempt failed before or during broker dispatch. */
  Failed = 'failed',
  /** Attempt was refused by the execution gate (mode check, invariant violation). */
  Refused = 'refused',
}

/** Machine-readable outcome codes for completed execution attempts. */
export enum ExecutionOutcomeCode {
  /** Order was placed successfully (live or paper). */
  OrderPlaced = 'order_placed',
  /** Order was rejected by the broker. */
  OrderRejected = 'order_rejected',
  /** Order was accepted but partially filled. */
  PartialFill = 'partial_fill',
  /** Order was fully filled. */
  FullFill = 'full_fill',
  /** Order was cancelled before execution. */
  Cancelled = 'cancelled',
  /** Order expired (GTD / day order). */
  Expired = 'expired',
  /** Paper broker simulated a successful placement. */
  PaperSimulated = 'paper_simulated',
  /** Paper broker simulated a rejection. */
  PaperRejected = 'paper_rejected',
}

/** Machine-readable refusal reason codes for execution gate refusals. */
export enum ExecutionRefusalCode {
  /** Execution mode is set to 'blocked' — all attempts refused. */
  ModeBlocked = 'mode_blocked',
  /** Execution mode is 'paper' but no paper broker is configured. */
  PaperBrokerNotConfigured = 'paper_broker_not_configured',
  /** Execution mode is 'live' but no live broker is configured. */
  LiveBrokerNotConfigured = 'live_broker_not_configured',
  /** The strategy decision has already been consumed (idempotency guard). */
  AlreadyConsumed = 'already_consumed',
  /** Market is closed for the instrument's segment. */
  MarketClosed = 'market_closed',
  /** Session is not authenticated for the target broker. */
  SessionNotAuthenticated = 'session_not_authenticated',
  /** Quote is stale or missing for execution. */
  StaleOrMissingQuote = 'stale_or_missing_quote',
  /** Instrument metadata is missing. */
  MissingInstrumentData = 'missing_instrument_data',
  /** Notional or risk check failed at execution time. */
  RiskCheckFailed = 'risk_check_failed',
  /** Candidate was held by lifecycle governance (strategy phase caps global mode). */
  LifecycleHold = 'lifecycle_hold',
  /** The execution class is not supported by the active execution policy. */
  ClassNotSupported = 'class_not_supported',
  /** FO candidate is missing required metadata (expiry, lot size). */
  FOMetadataIncomplete = 'fo_metadata_incomplete',
  /** FO quantity is not a valid multiple of the instrument lot size. */
  FOLotSizeMismatch = 'fo_lot_size_mismatch',
  /** FO quantity exceeds the broker freeze quantity for this instrument. */
  FOFreezeQuantityBreach = 'fo_freeze_quantity_breach',
  /** FO order price/notional exceeds market protection bounds. */
  FOMarketProtectionBound = 'fo_market_protection_bound',
}

/** A single refusal reason attached to an execution attempt. */
export interface ExecutionRefusalReason {
  /** Machine-readable refusal code. */
  reasonCode: ExecutionRefusalCode;
  /** Human-readable explanation. */
  reasonMessage: string;
}

/**
 * Full persisted execution attempt row.
 *
 * One row per strategy decision (UNIQUE on strategy_decision_id).
 * Immutable after insert — represents a single consumption attempt.
 */
export interface ExecutionAttemptRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → strategy_decisions(id). UNIQUE — idempotency key. */
  strategyDecisionId: number;
  /** Execution mode that was active when this attempt was created. */
  executionMode: ExecutionMode;
  /** Current status of the attempt. */
  status: ExecutionAttemptStatus;
  /** Machine-readable outcome code (null until completed). */
  outcomeCode: ExecutionOutcomeCode | null;
  /** Broker order ID if one was obtained (null for refusals/failures). */
  brokerOrderId: string | null;
  /** Human-readable result message. */
  message: string;
  /** Unix timestamp (ms) when this attempt was created. */
  attemptedAt: number;
  /** Unix timestamp (ms) when this attempt completed or failed, or null. */
  completedAt: number | null;
}

/** Shape for inserting a new execution attempt (without id, timestamps). */
export interface NewExecutionAttempt {
  strategyDecisionId: number;
  executionMode: ExecutionMode;
  status: ExecutionAttemptStatus;
  outcomeCode: ExecutionOutcomeCode | null;
  brokerOrderId: string | null;
  message: string;
  attemptedAt: number;
  completedAt: number | null;
}

/** A refusal reason linked to an execution attempt row. */
export interface ExecutionAttemptRefusalRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → execution_attempts(id). */
  executionAttemptId: number;
  /** Machine-readable refusal code. */
  reasonCode: ExecutionRefusalCode;
  /** Human-readable explanation. */
  reasonMessage: string;
}

// ---------------------------------------------------------------------------
// Execution dashboard/health DTOs
// ---------------------------------------------------------------------------

/** A recent execution attempt for the operator dashboard. */
export interface DashboardExecutionAttempt {
  /** Execution attempt row ID. */
  id: number;
  /** Source strategy decision ID. */
  strategyDecisionId: number;
  /** Execution mode at attempt time. */
  executionMode: string;
  /** Current status. */
  status: string;
  /** Outcome code, or null. */
  outcomeCode: string | null;
  /** Broker order ID, or null. */
  brokerOrderId: string | null;
  /** Human-readable message. */
  message: string;
  /** ISO‑8601 timestamp when attempted. */
  attemptedAt: string;
  /** ISO‑8601 timestamp when completed/failed, or null. */
  completedAt: string | null;
  /** Trading symbol for display. */
  tradingsymbol: string;
  /** Exchange. */
  exchange: string;
  /** Refusal reasons, if any. */
  refusalReasons: string[];
}

/** Execution health summary block — published on /health. */
export interface ExecutionHealth {
  /** Current execution mode. */
  mode: string;
  /** Total attempts recorded. */
  totalAttempts: number;
  /** Recent attempts for diagnostics (newest first, max 5). */
  recentAttempts: DashboardExecutionAttempt[];
  /** Whether the execution gate is actively refusing (mode-blocked). */
  isGateRefusing: boolean;
  /** Current gate refusal reason, if any. */
  gateRefusalReason: string | null;
  /** Total open paper positions count. */
  openPositionCount: number;
  /** Total paper orders recorded. */
  totalOrders: number;
  /** Total paper fills recorded. */
  totalFills: number;
  /** Recent paper orders (newest first, max 10). */
  recentPaperOrders: DashboardPaperOrder[];
  /** Recent paper fills (newest first, max 10). */
  recentPaperFills: DashboardPaperFill[];
  /** Current open positions. */
  currentPositions: DashboardPaperPosition[];
  /** Recent position events (newest first, max 10). */
  recentPositionEvents: DashboardPositionEvent[];
  /** Current risk state — null when no risk state has been loaded. */
  riskState: DashboardRiskState | null;
  /** Recent risk events (newest first, max 10). */
  recentRiskEvents: DashboardRiskEvent[];
}

/** Execution config block within RuntimeConfig. */
export interface ExecutionConfig {
  /** Execution mode. Default: 'blocked'. */
  mode: ExecutionMode;
  /** Paper broker endpoint (optional, for paper mode). */
  paperBrokerUrl?: string;
  /** Max retry attempts for failed dispatches. */
  maxRetries: number;
  /** Operator HTTP bind host (loopback-first). Default: '127.0.0.1'. */
  operatorBindHost: string;
  /** Risk limits for execution gating. */
  riskLimits: RiskLimits;
}

// ---------------------------------------------------------------------------
// Execution risk — halt state, risk events, limits
// ---------------------------------------------------------------------------

/** Current halt state of the execution boundary. */
export enum HaltState {
  /** No halt is active — execution proceeds through normal gating. */
  NoHalt = 'no_halt',
  /** A halt condition has been triggered — execution is stopped. */
  ActiveHalt = 'active_halt',
  /** Halt was acknowledged by operator; resume is pending approval. */
  PendingResume = 'pending_resume',
}

/** Source/trigger of a halt condition. */
export enum HaltSource {
  /** Operator manually triggered the kill-switch. */
  Operator = 'operator',
  /** Market hours gate: outside regular session. */
  MarketHours = 'market_hours',
  /** Duplicate order / exposure cap exceeded. */
  DuplicateCap = 'duplicate_cap',
  /** Position exposure limit exceeded. */
  ExposureLimit = 'exposure_limit',
  /** Daily loss limit exceeded. */
  DailyLoss = 'daily_loss',
  /** System-level halt (e.g. config error, unrecoverable state). */
  System = 'system',
}

/** Configurable risk limits for the execution boundary. */
export interface RiskLimits {
  /** Maximum number of open positions across all symbols. */
  maxOpenPositions: number;
  /** Maximum number of concurrent orders per instrument. */
  maxOrdersPerInstrument: number;
  /** Maximum intraday drawdown (absolute rupees). 0 = no limit. */
  maxDailyLossRupees: number;
  /** Maximum notional exposure across all positions (rupees). 0 = no limit. */
  maxExposureRupees: number;
  /** Maximum timestamp staleness for market-hours checks (ms). Default: 120_000. */
  marketHoursStalenessMs: number;
}

/** Durable risk-latch state persisted in the singleton execution_risk_state table. */
export interface ExecutionRiskStateRow {
  /** Singular row (id = 1). */
  id: number;
  /** Current halt state. */
  haltState: HaltState;
  /** Halt source that triggered the current state, or null if no halt. */
  haltSource: HaltSource | null;
  /** Human-readable reason for the current halt state, or null. */
  haltReason: string | null;
  /** Unix timestamp (ms) when the halt was triggered, or null. */
  haltedAt: number | null;
  /** Unix timestamp (ms) when the halt was last acknowledged, or null. */
  acknowledgedAt: number | null;
  /** Open position count at halt time, or null. */
  openPositionCountAtHalt: number | null;
  /** Running daily P&L at halt time, or null. */
  dailyPnlAtHalt: number | null;
  /** Counter of repeated latch on the same source (for backoff). */
  latchCount: number;
  /** Unix timestamp (ms) when this row was last updated. */
  updatedAt: number;
}

/** A single append-only risk event. */
export interface RiskEventRow {
  /** Auto-increment row ID. */
  id: number;
  /** Event type (e.g. 'halt', 'resume', 'refusal', 'limit_breach', 'daily_loss'). */
  eventType: string;
  /** Halt source that produced this event, or null. */
  source: HaltSource | null;
  /** Event severity: 'info', 'warning', 'critical'. */
  severity: string;
  /** Human-readable event message. */
  message: string;
  /** Optional diagnostic JSON payload. */
  diagnostic: string | null;
  /** Unix timestamp (ms) when this event was recorded. */
  recordedAt: number;
}

/** Shape for inserting a new risk event (without id). */
export type NewRiskEvent = Omit<RiskEventRow, 'id'>;

/** Risk state block for the operator dashboard. */
export interface DashboardRiskState {
  /** Current halt state string. */
  haltState: string;
  /** Halt source string, or null. */
  haltSource: string | null;
  /** Halt reason, or null. */
  haltReason: string | null;
  /** ISO‑8601 timestamp when halted, or null. */
  haltedAt: string | null;
  /** Whether the execution boundary is actively refusing. */
  isRefusing: boolean;
  /** Counter of repeated latch on the same source. */
  latchCount: number;
  /** Open position count at halt time, or null. */
  openPositionCountAtHalt: number | null;
  /** Running daily P&L at halt time, or null. */
  dailyPnlAtHalt: number | null;
}

/** A recent risk event for the operator dashboard. */
export interface DashboardRiskEvent {
  id: number;
  /** ISO‑8601 timestamp when the event was recorded. */
  recordedAt: string;
  /** Event type. */
  eventType: string;
  /** Source string, or null. */
  source: string | null;
  /** Severity. */
  severity: string;
  /** Human-readable message. */
  message: string;
}

// ---------------------------------------------------------------------------
// Paper trading — durable order, fill, position-event, and position DTOs
// ---------------------------------------------------------------------------

/** Status of a paper order. */
export enum PaperOrderStatus {
  /** Order has been recorded but not yet filled. */
  Pending = 'pending',
  /** Order is open (for future resting-order support). */
  Open = 'open',
  /** Order has been fully filled. */
  Filled = 'filled',
  /** Order was cancelled before fill. */
  Cancelled = 'cancelled',
  /** Order was rejected by paper broker policy. */
  Rejected = 'rejected',
}

/**
 * Full persisted paper order row.
 *
 * One row per successful paper execution attempt (one-to-one with
 * execution_attempts where outcome_code is PaperSimulated).
 */
export interface PaperOrderRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → execution_attempts(id). UNIQUE — one order per attempt. */
  executionAttemptId: number;
  /** Exchange (e.g. 'NSE', 'NFO'). */
  exchange: string;
  /** Trading symbol (e.g. 'RELIANCE'). */
  tradingsymbol: string;
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
  /** Current order status. */
  status: PaperOrderStatus;
  /** Broker-generated paper order ID for traceability. */
  brokerOrderId: string;
  /** Unix timestamp (ms) when the order was created. */
  createdAt: number;
  /** Unix timestamp (ms) when the order was last updated, or null. */
  updatedAt: number | null;
}

/** Shape for inserting a new paper order (without id). */
export type NewPaperOrder = Omit<PaperOrderRow, 'id'>;

/**
 * Full persisted paper fill row.
 *
 * One fill per successful order (current paper policy is immediate full fill).
 */
export interface PaperFillRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → paper_orders(id). */
  paperOrderId: number;
  /** FK → execution_attempts(id). UNIQUE — one fill per attempt. */
  executionAttemptId: number;
  /** Exchange. */
  exchange: string;
  /** Trading symbol. */
  tradingsymbol: string;
  /** Trade side: 'buy' or 'sell'. */
  side: string;
  /** Product. */
  product: string;
  /** Quantity actually filled (always positive). */
  filledQuantity: number;
  /** Price at which the fill occurred. */
  filledPrice: number;
  /** Broker-generated paper order ID from the parent order. */
  brokerOrderId: string;
  /** Unix timestamp (ms) when the fill occurred. */
  filledAt: number;
}

/** Shape for inserting a new paper fill (without id). */
export type NewPaperFill = Omit<PaperFillRow, 'id'>;

/** Type of a position event. */
export enum PositionEventType {
  /** Position was opened (first fill, net position became non-zero). */
  Open = 'open',
  /** Position was increased or decreased by a partial fill. */
  Adjust = 'adjust',
  /** Position was closed fully (net quantity became zero). */
  Close = 'close',
  /** Initial fill on a new position. */
  Fill = 'fill',
}

/**
 * Full persisted position event row.
 *
 * Append-only log of every position-modifying operation.
 * Used for audit and reconstruction of current positions.
 */
export interface PositionEventRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → paper_orders(id). */
  paperOrderId: number;
  /** FK → paper_fills(id). May be null for non-fill events. */
  paperFillId: number | null;
  /** FK → execution_attempts(id). */
  executionAttemptId: number;
  /** Event type. */
  eventType: PositionEventType;
  /** Exchange. */
  exchange: string;
  /** Trading symbol. */
  tradingsymbol: string;
  /** Product. */
  product: string;
  /** Quantity delta: positive for buy (increases long / reduces short), negative for sell. */
  quantityDelta: number;
  /** Fill price or reference price for the event. */
  price: number;
  /** Quantity before this event. */
  previousQuantity: number;
  /** Average cost before this event. */
  previousAvgCost: number;
  /** Quantity after this event. */
  newQuantity: number;
  /** Average cost after this event. */
  newAvgCost: number;
  /** Realized P&L from this event (0 for fills that don't close a position). */
  realizedPnl: number;
  /** Stop price after this event, or null. */
  stopPrice: number | null;
  /** Trailing anchor price after this event, or null. */
  trailingAnchorPrice: number | null;
  /** Trailing-stop distance after this event, or null. */
  trailingStopDistance: number | null;
  /** Unix timestamp (ms) when this event was recorded. */
  createdAt: number;
}

/** Shape for inserting a new position event (without id). */
export type NewPositionEvent = Omit<PositionEventRow, 'id'>;

/** Net position side. */
export enum PositionSide {
  /** Net quantity is zero (flat / no position). */
  Flat = 'flat',
  /** Net quantity is positive (long). */
  Long = 'long',
  /** Net quantity is negative (short). */
  Short = 'short',
}

/**
 * Current-state paper position projection.
 *
 * One row per (exchange, tradingsymbol, product) composite key.
 * Reconstructed from position_events on restart if missing.
 */
export interface PaperPositionRow {
  /** Auto-increment row ID. */
  id: number;
  /** Exchange (e.g. 'NSE'). */
  exchange: string;
  /** Trading symbol (e.g. 'RELIANCE'). */
  tradingsymbol: string;
  /** Product (e.g. 'MIS'). */
  product: string;
  /** Current position side. */
  side: PositionSide;
  /** Net quantity (positive for long, negative for short, 0 for flat). */
  quantity: number;
  /** Average cost price of the position. */
  avgCostPrice: number;
  /** Cumulative realized P&L in rupees. */
  realizedPnl: number;
  /** Initial stop price for the currently open leg, or null. */
  stopPrice: number | null;
  /** Current trailing reference price (high-water for long / low-water for short), or null. */
  trailingAnchorPrice: number | null;
  /** Trailing-stop distance in price units, or null when trailing is disabled. */
  trailingStopDistance: number | null;
  /** Last marked quote price used for stop management, or null. */
  markPrice: number | null;
  /** Unix timestamp (ms) when markPrice was last updated, or null. */
  markedAt: number | null;
  /** Unix timestamp (ms) when this position was last updated. */
  updatedAt: number;
}

/** Shape for upserting a paper position (without id). */
export type NewPaperPosition = Omit<PaperPositionRow, 'id'>;

// ---------------------------------------------------------------------------
// Paper trading — dashboard/health read-model DTOs
// ---------------------------------------------------------------------------

/** A recent paper order for the operator dashboard. */
export interface DashboardPaperOrder {
  id: number;
  /** ISO‑8601 timestamp when the order was created. */
  createdAt: string;
  /** Exchange. */
  exchange: string;
  /** Trading symbol. */
  tradingsymbol: string;
  /** Trade side. */
  side: string;
  /** Product. */
  product: string;
  /** Order quantity. */
  quantity: number;
  /** Limit price, or null. */
  price: number | null;
  /** Order type. */
  orderType: string;
  /** Current order status. */
  status: string;
  /** Broker order ID for traceability. */
  brokerOrderId: string;
}

/** A recent paper fill for the operator dashboard. */
export interface DashboardPaperFill {
  id: number;
  /** ISO‑8601 timestamp when the fill occurred. */
  filledAt: string;
  /** Parent paper order ID. */
  paperOrderId: number;
  /** Exchange. */
  exchange: string;
  /** Trading symbol. */
  tradingsymbol: string;
  /** Trade side. */
  side: string;
  /** Filled quantity. */
  filledQuantity: number;
  /** Fill price. */
  filledPrice: number;
  /** Broker order ID for traceability. */
  brokerOrderId: string;
}

/** A position for the operator dashboard. */
export interface DashboardPaperPosition {
  exchange: string;
  tradingsymbol: string;
  product: string;
  /** Position side string. */
  side: string;
  /** Net quantity. */
  quantity: number;
  /** Average cost price. */
  avgCostPrice: number;
  /** Cumulative realized P&L. */
  realizedPnl: number;
  /** ISO‑8601 timestamp of last update. */
  updatedAt: string;
}

/** A recent position event for the operator dashboard. */
export interface DashboardPositionEvent {
  id: number;
  /** ISO‑8601 timestamp when the event was recorded. */
  createdAt: string;
  /** Event type. */
  eventType: string;
  /** Exchange. */
  exchange: string;
  /** Trading symbol. */
  tradingsymbol: string;
  /** Product. */
  product: string;
  /** Quantity delta. */
  quantityDelta: number;
  /** Price. */
  price: number;
  /** Quantity after the event. */
  newQuantity: number;
  /** Realized P&L from this event. */
  realizedPnl: number;
}

// ---------------------------------------------------------------------------
// Broker placement seam — abstract port for order execution
// ---------------------------------------------------------------------------

/** Parameters for a broker order placement call. */
export interface OrderPlacementParams {
  exchange: string;
  tradingsymbol: string;
  side: string;
  product: string;
  quantity: number;
  price: number | null;
  triggerPrice: number | null;
  orderType: string;
  tag?: string;
}

/** Result of a broker order placement call. */
export interface OrderPlacementResult {
  /** Whether the placement was successful. */
  success: boolean;
  /** Broker order ID if placed successfully. */
  brokerOrderId: string | null;
  /** Outcome code for the execution attempt. */
  outcomeCode: ExecutionOutcomeCode;
  /** Human-readable message. */
  message: string;
  /** Broker response metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Broker placement port — the seam where execution attempts cross from
 * the execution service into broker-specific transport.
 *
 * Implementations live in broker packages (paper, live). This port ensures
 * no execution path reaches the broker without going through the mode-aware
 * execution gate.
 */
export interface BrokerPlacementPort {
  /** Place an order. Returns a result with outcome and broker order ID. */
  placeOrder(params: OrderPlacementParams): Promise<OrderPlacementResult>;
  /** Whether this port is configured and ready. */
  readonly isReady: boolean;
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

// ---------------------------------------------------------------------------
// Strategy run — append-only replay-ready artifact for screening rounds
// ---------------------------------------------------------------------------

/**
 * Full persisted strategy run row.
 *
 * One run per screening round (coordinator evaluation). Carries plugin
 * identities, framework config, universe snapshot linkage, plugin errors,
 * and duration metadata so future replay code can reconstruct the round
 * without re-executing plugins.
 */
export interface StrategyRunRow {
  /** Auto-increment row ID. */
  id: number;
  /** Framework config stored as JSON (StrategyFrameworkConfig). */
  frameworkConfig: string;
  /** Plugin identities stored as JSON (StrategyPluginIdentity[]). */
  pluginsJson: string;
  /** Plugin errors stored as JSON (Record<string, string>), or null. */
  pluginErrorsJson: string | null;
  /** FK → universe_snapshots(id). Null when no snapshot was used. */
  universeSnapshotId: number | null;
  /** Total number of unique candidates evaluated in this round. */
  totalEvaluated: number;
  /** Whether any plugin errors occurred. */
  hasPluginErrors: boolean;
  /** Total wall-clock duration of the evaluation round in ms. */
  durationMs: number;
  /** Unix timestamp (ms) when this run was recorded. */
  createdAt: number;
}

/** Shape for inserting a new strategy run (without id). */
export type NewStrategyRun = Omit<StrategyRunRow, 'id'>;

/**
 * Full persisted strategy run candidate row.
 *
 * One row per candidate identity (exchange + tradingsymbol) within a run.
 * Carries the full scoring evidence (plugin scores, LLM status, merged score),
 * emitted state tracking, and optional forward-link to proposal_attempts
 * when the candidate was selected for proposal generation.
 */
export interface StrategyRunCandidateRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → strategy_runs(id). */
  strategyRunId: number;
  /** Unique candidate key (e.g. 'NSE:RELIANCE'). */
  candidateKey: string;
  /** 1-based rank within this run (deterministic ordering by merged score). */
  rank: number;
  /** Exchange (e.g. 'NSE', 'NFO'). */
  exchange: string;
  /** Trading symbol (e.g. 'RELIANCE'). */
  tradingsymbol: string;
  /** Kite instrument token, or null. */
  instrumentToken: number | null;
  /** Instrument type (e.g. 'EQ', 'CE', 'PE'). */
  instrumentType: string;
  /** Lot size for the instrument. */
  lotSize: number;
  /** Tick size (minimum price increment). */
  tickSize: number;
  /** Expiry date in YYYY-MM-DD format, or null for EQ. */
  expiry: string | null;
  /** Strike price, or null for EQ. */
  strike: number | null;
  /** Freeze quantity from broker instrument master, or null when unavailable. */
  freezeQuantity: number | null;
  /** Trade side determined by upstream context. */
  side: string;
  /** Last traded price, or null. */
  lastPrice: number | null;
  /** Best bid price, or null. */
  bid: number | null;
  /** Best ask price, or null. */
  ask: number | null;
  /** Trading volume, or null. */
  volume: number | null;
  /** Plugin scoring evidence stored as JSON (PluginScoreEvidence[]). */
  scoresJson: string;
  /** Aggregated deterministic score (0–1). */
  deterministicScore: number;
  /** LLM-provided score (0–1), or null. */
  llmScore: number | null;
  /** LLM provider consultation status, or null. */
  llmStatus: string | null;
  /** Human-readable LLM rationale, or null. */
  llmRationale: string | null;
  /** Final merged score (0–1). */
  mergedScore: number;
  /** Merge policy string, or null. */
  mergePolicy: string | null;
  /** Proposal params stored as JSON (Record<string, unknown>), or null. */
  proposalParamsJson: string | null;
  /** Plugin errors keyed by plugin ID stored as JSON, or null. */
  pluginErrorsJson: string | null;
  /** Whether any plugin errors occurred for this candidate. */
  hasPluginErrors: boolean;
  /** Whether this candidate was emitted as a proposal attempt. */
  emitted: boolean;
  /** FK → proposal_attempts(id). Non-null when emitted. */
  proposalAttemptId: number | null;
  /** India research evidence — null when no research was evaluated for this candidate. */
  indiaResearchEvidence: IndiaResearchCandidateEvidence | null;
}

/** Shape for inserting a new strategy run candidate (without id). */
export type NewStrategyRunCandidate = Omit<StrategyRunCandidateRow, 'id'>;

/**
 * Joined artifact — a strategy run with its ordered candidate rows loaded.
 */
export interface StrategyRunWithCandidates extends StrategyRunRow {
  /** Ordered candidates (by rank ascending). */
  candidates: StrategyRunCandidateRow[];
}

// ---------------------------------------------------------------------------
// Strategy Framework — pluggable screening and ranking DTOs
// ---------------------------------------------------------------------------

/**
 * Identity metadata for a strategy plugin.
 * Uniquely identifies a plugin instance across evaluation rounds.
 */
export interface StrategyPluginIdentity {
  /** Unique plugin identifier (e.g. 'momentum-screener-v1'). */
  id: string;
  /** Human-readable plugin name. */
  name: string;
  /** Plugin version (semver-style, e.g. '1.0.0'). */
  version: string;
}

/**
 * A bounded candidate — an instrument+quote pair that has already been
 * filtered through the eligible universe, ready for strategy plugin evaluation.
 *
 * Contains only the data a deterministic strategy plugin needs to score and
 * rank the candidate, without exposing raw provider output or full instrument
 * catalog metadata.
 */
export interface BoundedCandidate {
  /** Exchange (e.g. 'NSE', 'NFO'). */
  exchange: string;
  /** Trading symbol (e.g. 'RELIANCE'). */
  tradingsymbol: string;
  /** Kite instrument token (may be null for synthetic candidates). */
  instrumentToken: number | null;
  /** Trade side determined by upstream context. */
  side: 'buy' | 'sell';
  /** Last traded price, or null if unavailable. */
  lastPrice: number | null;
  /** Best bid price, or null if unavailable. */
  bid: number | null;
  /** Best ask price, or null if unavailable. */
  ask: number | null;
  /** Trading volume, or null if unavailable. */
  volume: number | null;
  /** Instrument type (e.g. 'EQ', 'CE', 'PE'). */
  instrumentType: string;
  /** Lot size for the instrument. */
  lotSize: number;
  /** Tick size (minimum price increment). */
  tickSize: number;
  /** Expiry date in YYYY-MM-DD format, or null for EQ. */
  expiry: string | null;
  /** Strike price, or null for EQ. */
  strike: number | null;
  /** Freeze quantity from broker instrument master, or null when unavailable. */
  freezeQuantity: number | null;
}

/**
 * Configuration for the strategy framework coordinator.
 */
export interface StrategyFrameworkConfig {
  /** Maximum number of ranked candidates to include in the result. */
  maxCandidates: number;
  /** When true, plugins run in parallel. When false, sequential (default: true). */
  parallelPlugins: boolean;
}

/**
 * A single ranked candidate produced by a strategy plugin.
 * Score is normalized 0–1 (higher = more favorable).
 */
export interface RankedCandidate {
  /** The bounded candidate this ranking applies to. */
  candidate: BoundedCandidate;
  /** Plugin identity that produced this ranking. */
  plugin: StrategyPluginIdentity;
  /** Normalized score in 0–1 range (higher = more favorable). */
  score: number;
  /** Human-readable justification for the score. */
  rationale: string;
  /** Optional additional metadata for diagnostics. */
  metadata?: Record<string, unknown>;
}

/**
 * Full result from the strategy framework coordinator.
 *
 * Contains the final ranked candidate list (deterministically ordered,
 * capped at maxCandidates), plugin identities that participated, and
 * any non-fatal plugin errors.
 */
export interface CoordinatorResult {
  /** Ranked candidates, ordered by score descending, capped at maxCandidates. */
  candidates: RankedCandidate[];
  /** Plugins that participated in this evaluation round. */
  plugins: StrategyPluginIdentity[];
  /** Total number of candidates that were evaluated across all plugins. */
  totalEvaluated: number;
  /** Whether any plugin errors occurred (non-fatal — errors are collected, evaluation continues). */
  hasPluginErrors: boolean;
  /** Plugin errors keyed by plugin ID, if any. */
  pluginErrors: Record<string, string>;
  /** Total wall-clock duration of the evaluation round in ms. */
  durationMs: number;
}

/**
 * The contract each strategy plugin must fulfill.
 *
 * A plugin receives a full set of bounded candidates and returns scored/
 * ranked results. Empty return means the plugin declined to rank (no matches).
 * Plugins are deterministic given the same input — same candidates always
 * produce the same scores and rankings.
 */
export interface StrategyPlugin {
  /** Plugin identity — unique across the plugin set. */
  readonly identity: StrategyPluginIdentity;
  /**
   * Evaluate a set of bounded candidates and produce ranked results.
   *
   * @param candidates - The full set of bounded candidates available this round.
   * @returns An array of RankedCandidate entries. Empty array means no
   *          candidates met this plugin's criteria.
   */
  evaluate(candidates: BoundedCandidate[]): RankedCandidate[];
}

// ---------------------------------------------------------------------------
// Hybrid scoring — audit trail DTOs for S02
// ---------------------------------------------------------------------------

/** LLM provider status for a hybrid scoring evaluation. */
export enum LLMStatus {
  /** LLM was consulted and returned a valid score. */
  Consulted = 'consulted',
  /** LLM was consulted but returned degraded quality (timeout, partial response). */
  Degraded = 'degraded',
  /** LLM was consulted but returned an error. */
  Error = 'error',
  /** LLM was skipped (deterministic-only scoring, policy decision, or rate-limit avoidance). */
  Skipped = 'skipped',
}

/** Merge policy used to combine deterministic and LLM scores. */
export enum MergePolicy {
  /** LLM score replaces deterministic score entirely. */
  LLMOverride = 'llm_override',
  /** Only deterministic scoring was used (LLM was skipped). */
  DeterministicOnly = 'deterministic_only',
  /** Arithmetic mean of deterministic and LLM scores. */
  Average = 'average',
  /** Maximum of deterministic and LLM scores. */
  Max = 'max',
  /** Weighted average (component weights govern the blend). */
  Weighted = 'weighted',
}

/**
 * Summary row for hybrid scoring evidence — one per proposal attempt.
 *
 * Carries deterministic component scores, LLM status/rationale, and a final
 * merged score so downstream runtime paths and operator read models can audit
 * truthfully without inferring hybrid evidence from downstream tables.
 */
export interface HybridScoreSummaryRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → proposal_attempts(id). UNIQUE — one summary per proposal attempt. */
  proposalAttemptId: number;
  /** Final aggregated deterministic score (0–1), computed from child components. */
  deterministicScore: number;
  /** LLM-provided score (0–1), or null when LLM was not consulted or failed. */
  llmScore: number | null;
  /** LLM provider consultation status. */
  llmStatus: LLMStatus;
  /** Human-readable LLM rationale, or null. */
  llmRationale: string | null;
  /** Final merged score (0–1) after applying the merge policy. */
  mergedScore: number;
  /** The merge policy that was applied to produce mergedScore. */
  mergePolicy: MergePolicy;
  /** Unix timestamp (ms) when this summary was created. */
  createdAt: number;
}

/** Shape for inserting a new hybrid score summary (without id). */
export type NewHybridScoreSummary = Omit<HybridScoreSummaryRow, 'id'>;

/**
 * A single ordered component score within a hybrid evaluation.
 *
 * Components represent individual deterministic scoring signals
 * (e.g. momentum, volume, volatility) that feed into the aggregated
 * deterministic score. Order is preserved by sort_order.
 */
export interface HybridScoreComponentRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → hybrid_score_summary(id). */
  summaryId: number;
  /** Component name (e.g. 'momentum', 'volume', 'volatility'). */
  componentName: string;
  /** Component score (0–1). */
  score: number;
  /** Component weight in the deterministic aggregation (0–1). */
  weight: number;
  /** Ordering position within the component set. */
  sortOrder: number;
}

/** Shape for inserting a new hybrid score component (without id). */
export type NewHybridScoreComponent = Omit<HybridScoreComponentRow, 'id'>;

/** A hybrid score summary with its ordered component rows loaded. */
export interface HybridScoreSummaryWithComponents extends HybridScoreSummaryRow {
  /** Ordered component scores (sorted by sort_order). */
  components: HybridScoreComponentRow[];
}

// ---------------------------------------------------------------------------
// Strategy coordinator — grouped hybrid candidate evidence (S02 / T02)
// ---------------------------------------------------------------------------

/**
 * Plugin scoring evidence — one per plugin that scored a candidate.
 *
 * Captures the individual plugin score, rationale, and optional metadata
 * that feeds into the grouped hybrid evaluation record.
 */
export interface PluginScoreEvidence {
  /** Plugin identity that produced this score. */
  plugin: StrategyPluginIdentity;
  /** Normalized score from this plugin (0–1). */
  score: number;
  /** Human-readable justification for the score. */
  rationale: string;
  /** Optional additional metadata for diagnostics. */
  metadata?: Record<string, unknown>;
}

/**
 * Grouped hybrid evaluation record — one per unique candidate identity.
 *
 * Replaces the flat `RankedCandidate[]` model where the same candidate could
 * appear multiple times (once per plugin). Each `HybridCandidateEvidence` entry
 * carries deterministic component scores from each plugin, an aggregated
 * deterministic score, explicit LLM status/rationale, and a final merged score.
 *
 * Downstream paths (runtime, persistence, operator surfaces) can audit
 * hybrid scoring truthfully without inferring evidence from downstream tables.
 */
export interface HybridCandidateEvidence {
  /** The bounded candidate this evidence applies to. */
  candidate: BoundedCandidate;
  /** Unique candidate key (exchange:tradingsymbol). */
  candidateKey: string;
  /** Plugin scoring evidence — one entry per plugin that scored this candidate. */
  pluginScores: PluginScoreEvidence[];
  /** Aggregated deterministic score (0–1) from non-LLM plugin scores. */
  deterministicScore: number;
  /** LLM-provided score (0–1), or null when LLM was not consulted or failed. */
  llmScore: number | null;
  /** LLM provider consultation status. */
  llmStatus: LLMStatus;
  /** Human-readable LLM rationale, or null. */
  llmRationale: string | null;
  /** Final merged score (0–1) after applying the merge policy. */
  mergedScore: number;
  /** The merge policy that was applied to produce mergedScore. */
  mergePolicy: MergePolicy;
  /** Optional proposal params from the highest-priority source (e.g. LLM plugin). */
  proposalParams?: Record<string, unknown>;
  /** Whether any plugin errors occurred for this candidate. */
  hasPluginErrors: boolean;
  /** Plugin errors keyed by plugin ID, if any. */
  pluginErrors: Record<string, string>;
  /** India research evidence — null when no research was evaluated for this candidate.
   *  Carries bounded summary, semantic tags, freshness markers, and per-candidate
   *  influence so runtime, replay, and operator surfaces can inspect why India-specific
   *  context changed rankings. */
  indiaResearchEvidence: IndiaResearchCandidateEvidence | null;
}

/**
 * Full result from the strategy framework coordinator with grouped hybrid scoring.
 *
 * Replaces `CoordinatorResult` in the evaluation path. Each candidate identity
 * (exchange + tradingsymbol) appears exactly once, carrying all plugin scoring
 * evidence, LLM status, and a final merged score.
 */
export interface HybridCoordinatorResult {
  /** Grouped hybrid evidence, one entry per unique candidate identity, ordered by mergedScore descending. */
  candidates: HybridCandidateEvidence[];
  /** Plugins that participated in this evaluation round. */
  plugins: StrategyPluginIdentity[];
  /** Total number of unique candidates that were evaluated. */
  totalEvaluated: number;
  /** Whether any plugin errors occurred across all candidates. */
  hasPluginErrors: boolean;
  /** Plugin-level error messages captured during evaluation, keyed by plugin id. */
  pluginErrors: Record<string, string>;
  /** Total wall-clock duration of the evaluation round in ms. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Strategy lifecycle governance — DTOs for M006 lifecycle phase management
// ---------------------------------------------------------------------------

/**
 * Ordered lifecycle phase for a strategy.
 *
 * Each phase acts as an execution ceiling beneath the global execution mode:
 * - `backtest`: Strategy is in backtest/validation — no execution allowed.
 * - `paper`: Strategy may execute via paper broker only.
 * - `live`: Strategy may execute via live broker (subject to global mode cap).
 *
 * Ordering: backtest (0) < paper (1) < live (2).
 * A strategy's effective execution ceiling is MIN(globalMode, lifecyclePhase).
 */
export enum StrategyLifecyclePhase {
  /** Default starting phase — backtest only, no execution beyond data collection. */
  Backtest = 'backtest',
  /** Approved for paper trading — paper execution only. */
  Paper = 'paper',
  /** Approved for live trading — subject to global execution mode cap. */
  Live = 'live',
}

/**
 * Governance verdict for a strategy lifecycle evaluation.
 *
 * - `hold`: Do not change the current lifecycle phase.
 * - `promote`: Advance the strategy to the next lifecycle phase.
 * - `demote`: Regress the strategy to a lower lifecycle phase.
 */
export enum GovernanceVerdict {
  /** Keep the current lifecycle phase — evaluation criteria not met. */
  Hold = 'hold',
  /** Advance to the next lifecycle phase — promotion criteria met. */
  Promote = 'promote',
  /** Regress to a lower lifecycle phase — demotion criteria triggered. */
  Demote = 'demote',
}

/**
 * Persisted current-state row for a strategy's lifecycle phase.
 *
 * One row per (strategyId, strategyVersion, marketId) composite identity.
 * Uses ON CONFLICT REPLACE for upsert semantics.
 */
export interface StrategyLifecycleStateRow {
  /** Auto-increment row ID. */
  id: number;
  /** Strategy identity (e.g. 'india-nse-eq-v1'). */
  strategyId: string;
  /** Strategy version (e.g. '1.0.0'). */
  strategyVersion: string;
  /** Market profile ID (e.g. 'INDIA_NSE_EQ'). */
  marketId: string;
  /** Current lifecycle phase. */
  phase: StrategyLifecyclePhase;
  /** Unix timestamp (ms) when this row was last updated. */
  updatedAt: number;
}

/** Shape for upserting a strategy lifecycle state (without id). */
export interface NewStrategyLifecycleState {
  strategyId: string;
  strategyVersion: string;
  marketId: string;
  phase: StrategyLifecyclePhase;
  updatedAt: number;
}

/**
 * Append-only governance decision row.
 *
 * Each governance evaluation produces one row, keyed by strategy identity
 * and recorded-at. Carries verdict, phase transition context, rationale,
 * and an evidence snapshot (JSON) of the threshold/scores that informed
 * the decision — enabling historical audit of why promotions were held or granted.
 */
export interface GovernanceDecisionRow {
  /** Auto-increment row ID. */
  id: number;
  /** Strategy identity (e.g. 'india-nse-eq-v1'). */
  strategyId: string;
  /** Strategy version (e.g. '1.0.0'). */
  strategyVersion: string;
  /** Market profile ID (e.g. 'INDIA_NSE_EQ'). */
  marketId: string;
  /** Governance verdict. */
  verdict: GovernanceVerdict;
  /** Strategy lifecycle phase before this governance evaluation. */
  previousPhase: StrategyLifecyclePhase;
  /** Strategy lifecycle phase after this governance evaluation. */
  newPhase: StrategyLifecyclePhase;
  /** Human-readable rationale explaining the verdict. */
  rationale: string;
  /** Evidence snapshot — JSON blob of threshold config values, scores, and supporting data. */
  evidenceJson: string | null;
  /** Optional FK → walk_forward_winners(id). Set when the evaluation references a walk-forward winner. */
  winnerId: number | null;
  /** Unix timestamp (ms) when this decision was recorded. */
  recordedAt: number;
}

/** Shape for inserting a new governance decision (without id). */
export interface NewGovernanceDecision {
  strategyId: string;
  strategyVersion: string;
  marketId: string;
  verdict: GovernanceVerdict;
  previousPhase: StrategyLifecyclePhase;
  newPhase: StrategyLifecyclePhase;
  rationale: string;
  evidenceJson: string | null;
  winnerId: number | null;
  recordedAt: number;
}

/**
 * Threshold configuration for the first governance promotion rule set.
 *
 * Governs whether a strategy may be promoted from backtest → paper or
 * paper → live based on walk-forward winner evidence.
 */
export interface GovernanceThresholdConfig {
  /** Minimum merged score (0–1) required for promotion. Default: 0.7. */
  minMergedScore: number;
  /** Minimum Sharpe ratio required for promotion. Default: 1.0. */
  minSharpeRatio: number;
  /** Maximum allowed drawdown percentage (0–100). Default: 30. */
  maxDrawdown: number;
  /** Minimum number of walk-forward windows with evidence. Default: 2. */
  minWindowCount: number;
  /** Minimum number of out-of-sample windows with evidence. Default: 1. */
  minOutOfSampleWindows: number;
  /**
   * Minimum replay fidelity (0–1) required for promotion.
   *
   * Replay fidelity measures how faithfully the walk-forward replay evidence
   * represents the LLM-first runtime path. A value of 1.0 means all candidates
   * were presented to the LLM without cap-induced truncation and LLM consultation
   * was active. Lower values indicate cap degradation, missing metrics, or
   * skipped LLM consultation.
   * Default: 1.0 (full fidelity required).
   */
  minReplayFidelity: number;
}

/**
 * Default promotion threshold configuration.
 */
export const DEFAULT_GOVERNANCE_THRESHOLDS: GovernanceThresholdConfig = {
  minMergedScore: 0.7,
  minSharpeRatio: 1.0,
  maxDrawdown: 30,
  minWindowCount: 2,
  minOutOfSampleWindows: 1,
  minReplayFidelity: 1.0,
};

// ---------------------------------------------------------------------------
// India research evidence — bounded DTOs for S02 M009
// ---------------------------------------------------------------------------

/**
 * Bounded India research evidence attached to a strategy run candidate.
 *
 * Captures the India-specific research summary, semantic tags, freshness
 * metadata, and per-candidate influence so runtime, replay, and operator
 * surfaces can inspect why India-specific context changed rankings without
 * reconstructing prompt text from logs.
 *
 * All text fields are bounded by character limits to prevent oversized
 * operator payloads. Null/absent evidence is valid — legacy candidates
 * without research evidence load cleanly.
 */
export interface IndiaResearchCandidateEvidence {
  /** Bounded summary text (max 500 chars) of India-specific research findings. */
  summary: string;
  /** Bounded semantic tags — max 10, each max 80 chars. */
  tags: string[];
  /** Freshness metadata — staleness in ms, or null if unknown. */
  freshnessMs: number | null;
  /** Per-candidate influence score (0–1) indicating how much India research affected the ranking. */
  influenceScore: number | null;
}

/**
 * Bounded India research evidence attached to a strategy decision.
 *
 * Compact operator summary so evidence of India-specific influence is visible
 * on the dashboard without reconstructing prompt text from logs.
 *
 * All text fields are bounded. Null/absent evidence is valid for backward
 * compatibility with decisions made before research evidence was tracked.
 */
export interface IndiaResearchDecisionEvidence {
  /** Bounded summary text (max 800 chars). */
  summary: string;
  /** Bounded semantic tags — max 10, each max 80 chars. */
  tags: string[];
  /** Freshness metadata — staleness in ms, or null if unknown. */
  freshnessMs: number | null;
  /** Per-decision influence context explaining how research affected the decision. */
  influenceContext: string | null;
}

// ---------------------------------------------------------------------------
// Strategy lifecycle demotion — DTOs for M006/S02 demotion governance
// ---------------------------------------------------------------------------

/**
 * Trigger type for a demotion evaluation.
 *
 * - `performance_drift`: Degraded paper/live performance evidence (Sharpe, drawdown, returns).
 * - `risk_breach`: Persisted risk-breach evidence (halt state, risk events).
 */
export type DemotionTriggerEdge = 'performance_drift' | 'risk_breach';

/**
 * Threshold configuration for demotion evaluation.
 *
 * Defines the boundaries beyond which a strategy is demoted to a lower
 * lifecycle phase. Each threshold is independently evaluated — if any
 * trigger condition is met, the strategy is considered for demotion.
 */
export interface DemotionThresholdConfig {
  /**
   * Minimum Sharpe ratio sustained before performance-drift demotion.
   * When the actual Sharpe is below this value, performance drift is triggered.
   * Default: 0.5.
   */
  minSharpeRatio: number;
  /**
   * Maximum drawdown percentage (0–100) before performance-drift demotion.
   * When actual drawdown exceeds this percentage, performance drift is triggered.
   * Default: 40.
   */
  maxDrawdown: number;
  /**
   * Minimum number of trade observations required to consider performance-drift evidence
   * meaningful. When trade count is below this, the evaluator holds rather than demotes
   * on sparse evidence.
   * Default: 5.
   */
  minTradeCount: number;
  /**
   * Whether a persisted active halt (HaltState.ActiveHalt) automatically triggers
   * a risk-breach demotion. When false, risk-breach evaluation requires explicit
   * risk events rather than halt state alone.
   * Default: true.
   */
  haltTriggersDemotion: boolean;
  /**
   * Minimum number of critical-severity risk events within the lookback window
   * to trigger a risk-breach demotion.
   * Default: 1.
   */
  minCriticalRiskEvents: number;
  /**
   * Lookback window in milliseconds for risk events. Events older than this
   * are not considered for demotion.
   * Default: 7 days (604800000 ms).
   */
  riskEventLookbackMs: number;
}

/**
 * Default demotion threshold configuration.
 */
export const DEFAULT_DEMOTION_THRESHOLDS: DemotionThresholdConfig = {
  minSharpeRatio: 0.5,
  maxDrawdown: 40,
  minTradeCount: 5,
  haltTriggersDemotion: true,
  minCriticalRiskEvents: 1,
  riskEventLookbackMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

/**
 * Performance summary for a strategy over a recent window.
 *
 * Captures the evidence needed to evaluate performance-drift demotion.
 * This is a pure DTO — the evaluator does not compute these values,
 * it only reads them.
 */
export interface LifecyclePerformanceSummary {
  /** Strategy identity. */
  strategyId: string;
  /** Strategy version. */
  strategyVersion: string;
  /** Market ID. */
  marketId: string;
  /** Average Sharpe ratio over the evaluation window, or null if not computable. */
  sharpeRatio: number | null;
  /** Maximum drawdown percentage (0–100) over the evaluation window, or null. */
  maxDrawdown: number | null;
  /** Total return over the evaluation window. */
  totalReturn: number;
  /** Number of trades in the evaluation window. */
  tradeCount: number;
  /** Start of the evaluation window (epoch ms). */
  windowStartMs: number;
  /** End of the evaluation window (epoch ms). */
  windowEndMs: number;
}

/**
 * Evidence snapshot persisted with each demotion governance decision.
 *
 * Captures the trigger edge(s), threshold config, actual metrics, and
 * supporting evidence so the decision can be audited without replay.
 */
export interface DemotionEvidenceSnapshot {
  /** Threshold configuration used for this evaluation. */
  thresholds: DemotionThresholdConfig;
  /** Which trigger(s) caused the demotion, or hold_rationale if no demotion. */
  trigger: DemotionTriggerEdge | 'hold' | 'multiple';
  /** Human-readable detail on what triggered the demotion. */
  triggerDetail: string;
  /** Performance summary inputs, if provided. Null when not applicable. */
  performanceSummary: LifecyclePerformanceSummary | null;
  /** Risk state at evaluation time, serialized for audit. Null when not applicable. */
  riskState: Record<string, unknown> | null;
  /** Count of critical risk events within the lookback window. */
  criticalRiskEventCount: number;
  /** Current lifecycle phase before evaluation. */
  previousPhase: string;
  /** Proposed/new lifecycle phase after evaluation. */
  newPhase: string;
}

/**
 * Input to a demotion evaluation.
 */
export interface DemotionEvaluationInput {
  /** Strategy identity (e.g. 'india-nse-eq-v1'). */
  strategyId: string;
  /** Strategy version (e.g. '1.0.0'). */
  strategyVersion: string;
  /** Market profile ID (e.g. 'INDIA_NSE_EQ'). */
  marketId: string;
  /** Optional performance summary for drift evaluation. When null, only risk breach is checked. */
  performanceSummary?: LifecyclePerformanceSummary | null;
  /** Threshold config to use. Falls back to DEFAULT_DEMOTION_THRESHOLDS when not provided. */
  thresholds?: DemotionThresholdConfig;
  /** Timestamp for the evaluation. Default: Date.now(). */
  evaluatedAt?: number;
}

/**
 * Structured output of a demotion evaluation.
 */
export interface DemotionEvaluationResult {
  /** Governance verdict: hold or demote. */
  verdict: GovernanceVerdict;
  /** Strategy lifecycle phase before this evaluation. */
  previousPhase: StrategyLifecyclePhase;
  /** Strategy lifecycle phase after this evaluation (same as previous on HOLD). */
  newPhase: StrategyLifecyclePhase;
  /** Human-readable rationale explaining the verdict. */
  rationale: string;
  /** Evidence snapshot persisted with the decision. */
  evidenceSnapshot: DemotionEvidenceSnapshot;
  /** Whether the lifecycle state was updated (only true on DEMOTE). */
  stateUpdated: boolean;
  /** The governance decision row that was persisted. */
  decision: GovernanceDecisionRow;
  /** Current state of the strategy after this evaluation. */
  currentState: StrategyLifecycleStateRow;
}

/** Extended strategy framework config with promotion governance settings. */
export interface StrategyFrameworkConfig {
  /** Maximum number of ranked candidates to include in the result. */
  maxCandidates: number;
  /** When true, plugins run in parallel. When false, sequential (default: true). */
  parallelPlugins: boolean;
  /** Promotion governance threshold configuration. */
  promotion: GovernanceThresholdConfig;
  /** Demotion governance threshold configuration. */
  demotion: DemotionThresholdConfig;
}

// ---------------------------------------------------------------------------
// Strategy lifecycle governance — dashboard/health DTOs for operator surfaces
// ---------------------------------------------------------------------------

/**
 * A governance decision row for the operator dashboard.
 *
 * Token-safe: never includes evidence snapshots or internal diagnostic data.
 * All timestamps converted to ISO-8601 strings.
 */
export interface DashboardGovernanceDecision {
  /** Governance decision row ID. */
  id: number;
  /** Strategy identity (e.g. 'india-nse-eq-v1'). */
  strategyId: string;
  /** Strategy version (e.g. '1.0.0'). */
  strategyVersion: string;
  /** Market profile ID (e.g. 'INDIA_NSE_EQ'). */
  marketId: string;
  /** Governance verdict: 'hold', 'promote', or 'demote'. */
  verdict: string;
  /** Previous lifecycle phase before this evaluation. */
  previousPhase: string;
  /** New lifecycle phase after this evaluation. */
  newPhase: string;
  /** Human-readable rationale. */
  rationale: string;
  /** ISO‑8601 timestamp when the decision was recorded. */
  recordedAt: string;
}

/**
 * Lifecycle governance evidence block for the operator dashboard.
 *
 * Block-level metadata (total states, total decisions) comes from persisted
 * COUNT queries, not from bounded recent lists, so they remain accurate even
 * when the cap is exceeded. Recent decisions are bounded (max 20).
 */
export interface DashboardLifecycleGovernance {
  /** Total number of lifecycle state rows across all strategies. */
  totalStates: number;
  /** Total number of governance decisions in the append-only log. */
  totalDecisions: number;
  /** Current lifecycle states across all strategies. */
  currentStates: Array<{
    /** Strategy identity. */
    strategyId: string;
    /** Strategy version. */
    strategyVersion: string;
    /** Market profile ID. */
    marketId: string;
    /** Current lifecycle phase. */
    phase: string;
    /** ISO‑8601 timestamp of last update. */
    updatedAt: string;
  }>;
  /** Recent governance decisions across all strategies (newest first, max 20). */
  recentDecisions: DashboardGovernanceDecision[];
}

// ---------------------------------------------------------------------------
// Operator read model DTOs — trustworthy query-backed read models
// These are UI-agnostic contracts consumed by S02's authenticated console.
// Every DTO carries explicit provenance/as-of metadata so the caller can
// distinguish runtime (live process state) from historical (persisted evidence).
// ---------------------------------------------------------------------------

/** Provenance metadata for operator read model rows. */
export interface OperatorProvenance {
  /**
   * Source of the data:
   * - 'runtime': live in-process state (e.g. current P&L computed from open positions).
   * - 'historical': persisted evidence from tables (e.g. governance decisions, walk-forward winners).
   * - 'synthetic': derived/computed value from multiple sources.
   */
  source: 'runtime' | 'historical' | 'synthetic';
  /** Epoch ms when this data was computed/queried. */
  asOf: number;
  /** Optional label identifying the data source (e.g. table name, query identity, plugin name). */
  sourceLabel: string | null;
}

/**
 * Summary card — a single key-value metric for the operator dashboard.
 *
 * Examples: current P&L, daily P&L, open positions count, total orders, total fills.
 * Provenance distinguishes runtime-computed P&L from historical audit rollups.
 */
export interface OperatorSummaryCard {
  /** Machine-readable metric key (e.g. 'current_pnl', 'daily_pnl', 'open_positions'). */
  key: string;
  /** Human-readable label for display (e.g. 'Current P&L', 'Open Positions'). */
  label: string;
  /** Numeric value. */
  value: number;
  /** Optional unit (e.g. 'INR', '%', 'trades', null for dimensionless). */
  unit: string | null;
  /** Optional change from previous measurement period. */
  change: number | null;
  /** Optional pre-formatted display string (overrides default formatting). */
  display: string | null;
  /** Provenance metadata so callers know whether this is live or historical. */
  provenance: OperatorProvenance;
}

/**
 * Per-strategy performance summary row.
 *
 * Aggregated from paper fills, position events, and walk-forward evidence.
 * Provenance distinguishes live paper-trading performance from backtest evidence.
 */
export interface OperatorStrategyPerformance {
  /** Strategy identity (e.g. 'india-nse-eq-v1'). */
  strategyId: string;
  /** Strategy version (e.g. '1.0.0'). */
  strategyVersion: string;
  /** Total return as a percentage (e.g. 12.5 for 12.5%). */
  totalReturnPct: number;
  /** Sharpe ratio, or null when not computable. */
  sharpeRatio: number | null;
  /** Maximum drawdown as a percentage (0-100), or null. */
  maxDrawdownPct: number | null;
  /** Total number of trades (fills) across all tickers. */
  tradeCount: number;
  /** Win rate as a decimal 0-1 (winning trades / total trades), or null. */
  winRate: number | null;
  /** Profit factor (gross profit / gross loss), or null. */
  profitFactor: number | null;
  /** Total realized P&L in rupees. */
  realizedPnl: number;
  /** Total unrealized P&L in rupees (0 for flat positions). */
  unrealizedPnl: number;
  /** Provenance metadata. */
  provenance: OperatorProvenance;
}

/**
 * Per-ticker performance row.
 *
 * Aggregated from paper fills and position events for a single instrument.
 */
export interface OperatorTickerPerformance {
  /** Exchange (e.g. 'NSE', 'NFO'). */
  exchange: string;
  /** Trading symbol (e.g. 'RELIANCE', 'RELIANCE24DEC3000CE'). */
  tradingsymbol: string;
  /** Total P&L in rupees (realized + unrealized). */
  totalPnl: number;
  /** Total number of trades (fills) for this ticker. */
  tradeCount: number;
  /** Win rate as a decimal 0-1, or null when no trades. */
  winRate: number | null;
  /** Net quantity (positive for long, negative for short, 0 for flat). */
  netQuantity: number;
  /** Average entry price across all fills, or null when no position history. */
  avgEntryPrice: number | null;
  /** Last fill or mark price, or null when no price data. */
  lastPrice: number | null;
  /** Unrealized P&L in rupees (0 for flat positions). */
  unrealizedPnl: number;
  /** Realized P&L in rupees. */
  realizedPnl: number;
  /** Provenance metadata. */
  provenance: OperatorProvenance;
}

/**
 * Per-decision performance summary row.
 *
 * Links a strategy decision to its execution outcome and resulting P&L.
 * Decisions that were refused or not consumed carry null execution/outcome fields.
 */
export interface OperatorDecisionPerformance {
  /** Strategy decision row ID. */
  decisionId: number;
  /** Source proposal attempt ID. */
  proposalAttemptId: number;
  /** Exchange (e.g. 'NSE', 'NFO'). */
  exchange: string;
  /** Trading symbol. */
  tradingsymbol: string;
  /** Trade side. */
  side: string;
  /** Decision quantity (lot-size rounded). */
  quantity: number;
  /** Decision price, or null for market orders. */
  price: number | null;
  /** Decision status: 'approved' or 'refused'. */
  decisionStatus: string;
  /** Strategy identity. */
  strategyId: string;
  /** ISO-8601 timestamp when the decision was made. */
  decidedAt: string;
  /** Execution status, or null when not consumed. */
  executionStatus: string | null;
  /** Execution outcome code, or null when not consumed or not completed. */
  outcomeCode: string | null;
  /** Realized P&L from this decision in rupees, or null when no fill. */
  realizedPnl: number | null;
  /** Provenance metadata. */
  provenance: OperatorProvenance;
}

/**
 * Current lifecycle state row for an operator surface.
 *
 * Shows where each strategy is in its lifecycle (backtest/paper/live).
 */
export interface OperatorLifecycleState {
  /** Strategy identity. */
  strategyId: string;
  /** Strategy version. */
  strategyVersion: string;
  /** Market profile ID. */
  marketId: string;
  /** Current lifecycle phase: 'backtest', 'paper', or 'live'. */
  phase: string;
  /** ISO-8601 timestamp of the last phase update. */
  updatedAt: string;
  /** Provenance metadata. */
  provenance: OperatorProvenance;
}

/**
 * Lifecycle governance history row.
 *
 * One row per governance evaluation (promote, demote, or hold).
 */
export interface OperatorLifecycleHistory {
  /** Governance decision row ID. */
  id: number;
  /** Strategy identity. */
  strategyId: string;
  /** Strategy version. */
  strategyVersion: string;
  /** Market profile ID. */
  marketId: string;
  /** Governance verdict: 'hold', 'promote', or 'demote'. */
  verdict: string;
  /** Previous lifecycle phase before the evaluation. */
  previousPhase: string;
  /** New lifecycle phase after the evaluation. */
  newPhase: string;
  /** Human-readable rationale explaining the decision. */
  rationale: string;
  /** ISO-8601 timestamp when the decision was recorded. */
  recordedAt: string;
  /** Provenance metadata. */
  provenance: OperatorProvenance;
}

/**
 * Promotion history row.
 *
 * Subset of lifecycle history filtered to promotion-only verdicts,
 * enriched with walk-forward winner reference for traceability.
 */
export interface OperatorPromotionHistory {
  /** Governance decision row ID. */
  id: number;
  /** Strategy identity. */
  strategyId: string;
  /** Strategy version. */
  strategyVersion: string;
  /** Market profile ID. */
  marketId: string;
  /** Previous lifecycle phase before promotion. */
  previousPhase: string;
  /** New (promoted to) lifecycle phase. */
  newPhase: string;
  /** Human-readable rationale explaining the promotion. */
  rationale: string;
  /** Reference walk-forward winner row ID, or null when no winner was referenced. */
  winnerId: number | null;
  /** ISO-8601 timestamp when the promotion was granted. */
  promotedAt: string;
  /** Provenance metadata. */
  provenance: OperatorProvenance;
}

/**
 * Walk-forward leaderboard row.
 *
 * One row per completed walk-forward run that produced a winner selection.
 * Used to display historical backtest leaderboard data alongside live
 * paper/live performance for comparison.
 */
export interface OperatorWalkForwardLeaderboard {
  /** Walk-forward run row ID. */
  runId: number;
  /** Run label (e.g. 'WF-2025-01-v1'). */
  label: string;
  /** Strategy identity. */
  strategyId: string;
  /** Strategy version. */
  strategyVersion: string;
  /** Market ID. */
  marketId: string;
  /** Number of windows in the walk-forward run. */
  windowCount: number;
  /** Walk-forward winner row ID, or null when no winner was selected. */
  winnerId: number | null;
  /** Selection strategy (e.g. 'best_sharpe', 'best_return', 'ensemble'), or null. */
  selectionStrategy: string | null;
  /** Merged score of the selected trial (0-1), or null. */
  mergedScore: number | null;
  /** Sharpe ratio of the selected trial, or null. */
  sharpeRatio: number | null;
  /** Total return percentage of the selected trial, or null. */
  totalReturnPct: number | null;
  /** Max drawdown percentage of the selected trial, or null. */
  maxDrawdownPct: number | null;
  /** Win rate (0-1) of the selected trial, or null. */
  winRate: number | null;
  /** ISO-8601 timestamp when the winner was selected, or null. */
  selectedAt: string | null;
  /** Provenance metadata. */
  provenance: OperatorProvenance;
}
