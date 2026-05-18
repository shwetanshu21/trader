// ── Replay Runner ──
// Composes and runs a replay session offline, without hooking into the
// live scheduler loop. Provides a factory function that wires replay
// dependencies (clock, data provider, coordinator, session repo, and
// strategy run repo) and drives the engine.

import { ReplayClock } from './replay-clock.js';
import { ReplayEngine, type ReplayEngineResult } from './replay-engine.js';
import { ReplaySessionRepository } from '../persistence/replay-session-repo.js';
import { StrategyRunRepository } from '../persistence/strategy-run-repo.js';
import { createStrategyCoordinator } from '../strategy/coordinator-factory.js';
import { ProposalEngine } from '../proposals/proposal-engine.js';
import {
  ReplaySessionStatus,
  ReplayFidelity,
  type ReplaySessionRow,
} from './types.js';
import type { HistoricalDataProvider } from './historical-data-provider.js';
import type { MarketProfile } from '../market/market-profile.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// ReplayRunnerOptions
// ---------------------------------------------------------------------------

export interface ReplayRunnerOptions {
  db: Database.Database;
  /** Market profile for clock generation. */
  marketProfile: MarketProfile;
  /** Historical data provider. */
  dataProvider: HistoricalDataProvider;
  /** Proposal engine for LLM ranking (reused from the live runtime). */
  proposalEngine?: ProposalEngine;
  /** Maximum candidates per tick (default: 5). */
  maxCandidates?: number;
  /** Tick cadence in minutes (default: 5). */
  cadenceMinutes?: number;
  /** Label for the replay session (auto-generated if omitted). */
  label?: string;
  /** Strategy identity (default: 'india-nse-eq-v1'). */
  strategyId?: string;
  /** Strategy version (default: '1.0.0'). */
  strategyVersion?: string;
  /** Market ID (default: 'INDIA_NSE_EQ'). */
  marketId?: string;
  /** Explicit replay range start (epoch ms). Defaults to 7 days before now. */
  rangeStart?: number;
  /** Explicit replay range end (epoch ms). Defaults to now. */
  rangeEnd?: number;
}

// ---------------------------------------------------------------------------
// ReplayRunnerResult
// ---------------------------------------------------------------------------

export interface ReplayRunnerResult {
  /** The persisted session row. */
  session: ReplaySessionRow;
  /** The engine result from processing ticks. */
  engineResult: ReplayEngineResult;
  /** Total duration of the entire run including setup, in ms. */
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// runReplay — create a session, run the engine, return results
// ---------------------------------------------------------------------------

/**
 * Create a replay session, run the engine over the given date range, and
 * return the results.
 *
 * This is the primary entrypoint for offline replay. It composes all replay
 * dependencies, creates a new session, drives the engine, and handles
 * the complete lifecycle (pending → running → completed/failed).
 */
export async function runReplay(options: ReplayRunnerOptions): Promise<ReplayRunnerResult> {
  const startedAt = Date.now();
  const {
    db,
    marketProfile,
    dataProvider,
    proposalEngine,
    maxCandidates = 5,
    cadenceMinutes = 5,
    label,
    strategyId = 'india-nse-eq-v1',
    strategyVersion = '1.0.0',
    marketId = 'INDIA_NSE_EQ',
  } = options;

  // Determine date range: prefer explicit options, fall back to past week
  const rangeStart = options.rangeStart ?? (startedAt - 7 * 86_400_000);
  const rangeEnd = options.rangeEnd ?? startedAt;

  // ── Step 1: Create clock and count ticks ──────────────────────────────
  const clock = new ReplayClock(marketProfile, cadenceMinutes);
  const totalTicks = clock.countTicks(rangeStart, rangeEnd);

  // ── Step 2: Create repositories ────────────────────────────────────────
  const sessionRepo = new ReplaySessionRepository(db);
  const strategyRunRepo = new StrategyRunRepository(db);

  // ── Step 3: Create the strategy coordinator via the shared factory ─────
  // The factory always includes the deterministic screener plugin for
  // truthful fallback behavior (non-empty deterministic scores even when
  // no LLM provider is configured), and optionally adds the LLM ranking
  // plugin when a proposal engine is available.
  const coordinator = createStrategyCoordinator({
    proposalEngine,
    maxCandidates,
    parallelPlugins: true,
  });

  // ── Step 4: Create a new replay session ────────────────────────────────
  const sessionId = Date.now(); // Use timestamp for rough ordering
  const sessionLabel = label ?? `replay-${new Date(startedAt).toISOString().slice(0, 10)}`;

  const session = sessionRepo.createSession({
    label: sessionLabel,
    strategyId,
    strategyVersion,
    marketId,
    cadenceMinutes,
    rangeStart,
    rangeEnd,
    requestedFidelity: ReplayFidelity.Synthetic,
    effectiveFidelity: null,
    status: ReplaySessionStatus.Pending,
    totalTicks,
    completedTicks: 0,
    errorMessage: null,
    createdAt: startedAt,
    startedAt: null,
    completedAt: null,
  });

  // ── Step 5: Create and run the engine ──────────────────────────────────
  const engine = new ReplayEngine({
    clock,
    dataProvider,
    coordinator,
    sessionRepo,
    strategyRunRepo,
    sessionId: session.id,
    rangeStart,
    rangeEnd,
    maxCandidates,
  });

  const engineResult = await engine.run();

  return {
    session: engineResult.session,
    engineResult,
    totalDurationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// createReplaySession — just create a session without running the engine
// ---------------------------------------------------------------------------

/**
 * Create a replay session row without running the engine.
 * Useful when the caller wants to control engine execution separately.
 */
export function createReplaySession(options: {
  db: Database.Database;
  marketProfile: MarketProfile;
  cadenceMinutes?: number;
  rangeStart: number;
  rangeEnd: number;
  label?: string;
  strategyId?: string;
  strategyVersion?: string;
  marketId?: string;
}): ReplaySessionRow {
  const {
    db,
    marketProfile,
    cadenceMinutes = 5,
    rangeStart,
    rangeEnd,
    label,
    strategyId = 'india-nse-eq-v1',
    strategyVersion = '1.0.0',
    marketId = 'INDIA_NSE_EQ',
  } = options;

  const now = Date.now();
  const clock = new ReplayClock(marketProfile, cadenceMinutes);
  const totalTicks = clock.countTicks(rangeStart, rangeEnd);
  const sessionRepo = new ReplaySessionRepository(db);
  const sessionLabel = label ?? `replay-${new Date(rangeStart).toISOString().slice(0, 10)}`;

  return sessionRepo.createSession({
    label: sessionLabel,
    strategyId,
    strategyVersion,
    marketId,
    cadenceMinutes,
    rangeStart,
    rangeEnd,
    requestedFidelity: ReplayFidelity.Synthetic,
    effectiveFidelity: null,
    status: ReplaySessionStatus.Pending,
    totalTicks,
    completedTicks: 0,
    errorMessage: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
  });
}
