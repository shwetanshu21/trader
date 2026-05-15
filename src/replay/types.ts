// ── Replay subsystem types ──
// DTOs, enums, and contracts specific to historical replay.
// Shared runtime-facing replay types (e.g. RuntimeConfig extensions) live in
// src/types/runtime.ts instead.

// ---------------------------------------------------------------------------
// Fidelity — how truthfully the replay reflects real market conditions
// ---------------------------------------------------------------------------

/**
 * Fidelity label for a replay session or individual tick.
 *
 * - `full`: Historical tick data from the actual market at the given timestamp.
 * - `synthetic`: Tick generated from synthetic/derived data (e.g. last known
 *   quote, interpolation, or simulated order-book state).
 * - `approximate`: Tick uses approximate data (e.g. opening range, VWAP-based
 *   projection, or fixture data that is representative but not identical to
 *   the actual market state at that moment).
 */
export enum ReplayFidelity {
  Full = 'full',
  Synthetic = 'synthetic',
  Approximate = 'approximate',
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/** Lifecycle status of a replay session. */
export enum ReplaySessionStatus {
  /** Session has been created but not yet started. */
  Pending = 'pending',
  /** Session is actively executing replay ticks. */
  Running = 'running',
  /** Session has completed all ticks successfully. */
  Completed = 'completed',
  /** Session encountered an error and stopped. */
  Failed = 'failed',
  /** Session was interrupted (e.g. process killed, operator abort). */
  Interrupted = 'interrupted',
}

// ---------------------------------------------------------------------------
// Replay session — top-level DTO
// ---------------------------------------------------------------------------

/**
 * Full persisted replay session row.
 *
 * Carries identity, time range, requested/effective fidelity, completion
 * state, and enough metadata for later walk-forward slices and audit
 * comparison against live strategy-run artifacts.
 */
export interface ReplaySessionRow {
  /** Auto-increment row ID. */
  id: number;
  /** Human-readable session label (e.g. '2025-01-06 replay'). */
  label: string;
  /** Strategy identity that was used (e.g. 'india-nse-eq-v1'). */
  strategyId: string;
  /** Strategy version used (e.g. '1.0.0'). */
  strategyVersion: string;
  /** Market profile ID used (e.g. 'INDIA_NSE_EQ'). */
  marketId: string;
  /** Requested tick cadence in minutes (default: 5). */
  cadenceMinutes: number;
  /** Unix timestamp (ms) of the first tick in the replay range. */
  rangeStart: number;
  /** Unix timestamp (ms) of the last tick in the replay range. */
  rangeEnd: number;
  /** Requested fidelity at session creation. */
  requestedFidelity: ReplayFidelity;
  /** Effective fidelity after execution (may differ from requested). */
  effectiveFidelity: ReplayFidelity | null;
  /** Current session status. */
  status: ReplaySessionStatus;
  /** Total number of ticks that should be executed in this session. */
  totalTicks: number;
  /** Number of ticks completed so far. */
  completedTicks: number;
  /** Human-readable error message if failed, or null. */
  errorMessage: string | null;
  /** Unix timestamp (ms) when the session was created. */
  createdAt: number;
  /** Unix timestamp (ms) when the session started executing, or null. */
  startedAt: number | null;
  /** Unix timestamp (ms) when the session completed or failed, or null. */
  completedAt: number | null;
}

/** Shape for inserting a new replay session (without id, timestamps). */
export interface NewReplaySession {
  label: string;
  strategyId: string;
  strategyVersion: string;
  marketId: string;
  cadenceMinutes: number;
  rangeStart: number;
  rangeEnd: number;
  requestedFidelity: ReplayFidelity;
  effectiveFidelity: ReplayFidelity | null;
  status: ReplaySessionStatus;
  totalTicks: number;
  completedTicks: number;
  errorMessage: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

// ---------------------------------------------------------------------------
// Checkpoint — resumable position within a replay session
// ---------------------------------------------------------------------------

/**
 * A single checkpoint row — records which tick position was last completed
 * and any associated metadata so the replay runner can resume from the
 * correct position after interruption.
 */
export interface ReplayCheckpointRow {
  /** Auto-increment row ID. */
  id: number;
  /** FK → replay_sessions(id). */
  sessionId: number;
  /** The 1-based tick index that was last completed (0 = no ticks completed). */
  tickIndex: number;
  /** Unix timestamp (ms) of the last completed tick. */
  tickTimestamp: number;
  /** FK → strategy_runs(id) for the strategy run produced by this tick, or null. */
  strategyRunId: number | null;
  /** Arbitrary JSON metadata for the checkpoint (e.g. diagnostic state). */
  metadataJson: string | null;
  /** Unix timestamp (ms) when this checkpoint was saved. */
  savedAt: number;
}

/** Shape for inserting a new checkpoint (without id). */
export interface NewReplayCheckpoint {
  sessionId: number;
  tickIndex: number;
  tickTimestamp: number;
  strategyRunId: number | null;
  metadataJson: string | null;
  savedAt: number;
}

// ---------------------------------------------------------------------------
// Replay tick — a single historical tick generated by the replay clock
// ---------------------------------------------------------------------------

/**
 * A single replay tick — represents one iteration of the replay engine
 * at a specific historical timestamp with a fidelity label.
 *
 * The range of each tick is from `timestamp` to `timestamp + cadence`.
 * Candidates screened during this tick reflect market state at
 * (or near) `timestamp`, as determined by the historical data provider.
 */
export interface ReplayTick {
  /** 1-based tick index within the session (monotonic across checkpoints). */
  index: number;
  /** Unix timestamp (ms) of this tick's start (aligned to cadence boundary). */
  timestamp: number;
  /** Fidelity of data available for this tick (may differ from session fidelity). */
  fidelity: ReplayFidelity;
}

// ---------------------------------------------------------------------------
// Replay session — read-model DTO for operator surfaces
// ---------------------------------------------------------------------------

/** A replay session summary suitable for operator surfaces and health endpoints. */
export interface DashboardReplaySession {
  id: number;
  label: string;
  strategyId: string;
  status: string;
  cadenceMinutes: number;
  /** ISO‑8601 timestamp of range start. */
  rangeStart: string;
  /** ISO‑8601 timestamp of range end. */
  rangeEnd: string;
  requestedFidelity: string;
  effectiveFidelity: string | null;
  totalTicks: number;
  completedTicks: number;
  errorMessage: string | null;
  /** ISO‑8601 timestamp when created. */
  createdAt: string;
  /** ISO‑8601 timestamp when started, or null. */
  startedAt: string | null;
  /** ISO‑8601 timestamp when completed/failed, or null. */
  completedAt: string | null;
  /** Latest checkpoint position, or null. */
  checkpointTickIndex: number | null;
}
