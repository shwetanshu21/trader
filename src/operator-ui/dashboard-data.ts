// ── Dashboard data orchestrator ──
// Per-section query isolation so failures in one section don't crash the page.
// Each section carries its own state (ok/error/stale/unavailable), error message,
// and last-known data for graceful degradation.
//
// Consumption: the HTML page and JSON refresh surface both call
// `fetchDashboardPayload()` and receive identical section-shaped results.

import type { OperatorReadModel } from '../operator/operator-read-model.js';
import type {
  OperatorSummaryCard,
  OperatorStrategyPerformance,
  OperatorTickerPerformance,
  OperatorDecisionPerformance,
  OperatorLifecycleState,
  OperatorLifecycleHistory,
  OperatorPromotionHistory,
  OperatorWalkForwardLeaderboard,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Section state types
// ---------------------------------------------------------------------------

/**
 * State of a single dashboard section.
 * - 'ok': Data was fetched successfully.
 * - 'error': Query failed; lastKnownData may be preserved.
 * - 'stale': Data is stale; re-query is needed.
 * - 'unavailable': Read model is not available (no DB connection).
 */
export type SectionState = 'ok' | 'error' | 'stale' | 'unavailable';

/**
 * A single dashboard section with state, data, and diagnostics.
 */
export interface DashboardSection<T> {
  /** Current section state. */
  state: SectionState;
  /** Fresh data for this section (null on error/unavailable). */
  data: T;
  /** Error message when state is 'error'. */
  errorMessage: string | null;
  /** Staleness in ms when state is 'stale'. */
  stalenessMs: number | null;
  /** ISO‑8601 timestamp when this section was last successfully fetched. */
  lastFetchedAt: string | null;
}

// ---------------------------------------------------------------------------
// Dashboard payload — one section per read model method
// ---------------------------------------------------------------------------

/**
 * Complete dashboard payload with section isolation.
 */
export interface DashboardPayload {
  /** ISO‑8601 timestamp when this payload was assembled. */
  assembledAt: string;
  /** Summary cards (aggregate totals). */
  summaryCards: DashboardSection<OperatorSummaryCard[]>;
  /** Per-strategy performance. */
  strategyPerformance: DashboardSection<OperatorStrategyPerformance[]>;
  /** Per-ticker performance. */
  tickerPerformance: DashboardSection<OperatorTickerPerformance[]>;
  /** Recent decision performance. */
  decisionPerformance: DashboardSection<OperatorDecisionPerformance[]>;
  /** Current lifecycle states. */
  lifecycleStates: DashboardSection<OperatorLifecycleState[]>;
  /** Lifecycle governance history. */
  governanceHistory: DashboardSection<OperatorLifecycleHistory[]>;
  /** Promotion-only history. */
  promotionHistory: DashboardSection<OperatorPromotionHistory[]>;
  /** Walk-forward leaderboard. */
  walkForwardLeaderboard: DashboardSection<OperatorWalkForwardLeaderboard[]>;
  /** Whether the database was accessible at assembly time. */
  dbAvailable: boolean;
  /** Database error message when unavailable. */
  dbError: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an ok section with fetched data. */
function ok<T>(data: T): DashboardSection<T> {
  return {
    state: 'ok',
    data,
    errorMessage: null,
    stalenessMs: null,
    lastFetchedAt: new Date().toISOString(),
  };
}

/** Create an error section, optionally preserving last-known data. */
function error<T>(message: string, lastKnown?: T): DashboardSection<T> {
  return {
    state: 'error',
    data: lastKnown ?? ([] as unknown as T),
    errorMessage: message,
    stalenessMs: null,
    lastFetchedAt: null,
  };
}

/** Create an unavailable section (read model is null). */
function unavailable<T>(): DashboardSection<T> {
  return {
    state: 'unavailable',
    data: [] as unknown as T,
    errorMessage: 'Database is not available.',
    stalenessMs: null,
    lastFetchedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Section fetch wrappers
// ---------------------------------------------------------------------------

/**
 * Fetch a section with try/catch isolation.
 *
 * Each query runs independently. If one query fails, the others still return
 * their results. The failed section carries an error message and the caller
 * can optionally provide last-known data for graceful degradation.
 *
 * @param fetch - A function that returns the section data.
 * @param label - Label for error messages (e.g. 'summary cards').
 * @returns A DashboardSection with state 'ok' or 'error'.
 */
function fetchSection<T>(
  fetch: () => T,
  label: string,
): DashboardSection<T> {
  try {
    const data = fetch();
    return ok(data);
  } catch (err) {
    const message = err instanceof Error
      ? `Failed to fetch ${label}: ${err.message}`
      : `Failed to fetch ${label}: Unknown error`;
    return error<T>(message);
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Fetch all dashboard sections from the operator read model.
 *
 * Each section is fetched independently with try/catch isolation. The read
 * model may be null (when the database is unavailable), in which case all
 * sections return 'unavailable' state.
 *
 * @param readModel - OperatorReadModel instance, or null when DB is unavailable.
 * @param dbError - Database error message when readModel is null.
 * @returns A complete DashboardPayload with per-section state.
 */
export function fetchDashboardPayload(
  readModel: OperatorReadModel | null,
  dbError: string | null,
): DashboardPayload {
  const assembledAt = new Date().toISOString();
  const dbAvailable = readModel !== null;

  if (!dbAvailable) {
    return {
      assembledAt,
      dbAvailable: false,
      dbError,
      summaryCards: unavailable(),
      strategyPerformance: unavailable(),
      tickerPerformance: unavailable(),
      decisionPerformance: unavailable(),
      lifecycleStates: unavailable(),
      governanceHistory: unavailable(),
      promotionHistory: unavailable(),
      walkForwardLeaderboard: unavailable(),
    };
  }

  return {
    assembledAt,
    dbAvailable: true,
    dbError: null,

    summaryCards: fetchSection(
      () => readModel.getSummaryCards(),
      'summary cards',
    ),

    strategyPerformance: fetchSection(
      () => readModel.getStrategyPerformance(),
      'strategy performance',
    ),

    tickerPerformance: fetchSection(
      () => readModel.getTickerPerformance(),
      'ticker performance',
    ),

    decisionPerformance: fetchSection(
      () => readModel.getDecisionPerformance(50),
      'decision performance',
    ),

    lifecycleStates: fetchSection(
      () => readModel.getLifecycleStates(),
      'lifecycle states',
    ),

    governanceHistory: fetchSection(
      () => readModel.getLifecycleHistory(20),
      'governance history',
    ),

    promotionHistory: fetchSection(
      () => readModel.getPromotionHistory(20),
      'promotion history',
    ),

    walkForwardLeaderboard: fetchSection(
      () => readModel.getWalkForwardLeaderboard(),
      'walk-forward leaderboard',
    ),
  };
}
