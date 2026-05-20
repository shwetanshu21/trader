// ── Dashboard data orchestrator ──
// Per-section query isolation so failures in one section don't crash the page.
// The server-owned assembler below preserves the last successful rows for each
// section and truthfully degrades later section failures to `stale` while still
// reserving `error` for no-cache failures and `unavailable` for DB-open/read-
// model absence.

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

export type SectionState = 'ok' | 'error' | 'stale' | 'unavailable';

export interface DashboardSection<T> {
  state: SectionState;
  data: T;
  errorMessage: string | null;
  stalenessMs: number | null;
  lastFetchedAt: string | null;
  isCachedData: boolean;
}

export interface DashboardPayload {
  assembledAt: string;
  summaryCards: DashboardSection<OperatorSummaryCard[]>;
  strategyPerformance: DashboardSection<OperatorStrategyPerformance[]>;
  tickerPerformance: DashboardSection<OperatorTickerPerformance[]>;
  decisionPerformance: DashboardSection<OperatorDecisionPerformance[]>;
  lifecycleStates: DashboardSection<OperatorLifecycleState[]>;
  governanceHistory: DashboardSection<OperatorLifecycleHistory[]>;
  promotionHistory: DashboardSection<OperatorPromotionHistory[]>;
  walkForwardLeaderboard: DashboardSection<OperatorWalkForwardLeaderboard[]>;
  dbAvailable: boolean;
  dbError: string | null;
}

type DashboardSectionMap = Pick<
  DashboardPayload,
  | 'summaryCards'
  | 'strategyPerformance'
  | 'tickerPerformance'
  | 'decisionPerformance'
  | 'lifecycleStates'
  | 'governanceHistory'
  | 'promotionHistory'
  | 'walkForwardLeaderboard'
>;

type SectionKey = keyof DashboardSectionMap;

type CachedSectionValue<T> = {
  data: T;
  lastFetchedAtMs: number;
};

type SectionDefinition<K extends SectionKey, T extends DashboardSectionMap[K]['data']> = {
  key: K;
  label: string;
  empty: T;
  fetch: (readModel: OperatorReadModel) => T;
};

const SECRET_PATTERN = /(authorization|token|secret|password|api[-_ ]?key)\s*[:=]\s*([^,;\s]+)/gi;
const BEARER_PATTERN = /bearer\s+[a-z0-9._-]+/gi;
const BASIC_PATTERN = /basic\s+[a-z0-9+/=._-]+/gi;

function sanitizeDiagnostic(label: string, err: unknown): string {
  const rawMessage = err instanceof Error
    ? err.message
    : typeof err === 'string'
      ? err
      : 'Unknown operator read failure';

  const redacted = rawMessage
    .replace(SECRET_PATTERN, (_match, key) => `${String(key)}=[redacted]`)
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(BASIC_PATTERN, 'Basic [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);

  return redacted.length > 0
    ? `Failed to refresh ${label}: ${redacted}`
    : `Failed to refresh ${label}.`;
}

function ensureArrayResult<T>(label: string, value: T[] | null | undefined): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} query returned malformed rows.`);
  }
  return value;
}

function toIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function okSection<T>(data: T, fetchedAtMs: number): DashboardSection<T> {
  return {
    state: 'ok',
    data,
    errorMessage: null,
    stalenessMs: 0,
    lastFetchedAt: toIso(fetchedAtMs),
    isCachedData: false,
  };
}

function staleSection<T>(cached: CachedSectionValue<T>, message: string, nowMs: number): DashboardSection<T> {
  return {
    state: 'stale',
    data: cached.data,
    errorMessage: message,
    stalenessMs: Math.max(0, nowMs - cached.lastFetchedAtMs),
    lastFetchedAt: toIso(cached.lastFetchedAtMs),
    isCachedData: true,
  };
}

function errorSection<T>(empty: T, message: string): DashboardSection<T> {
  return {
    state: 'error',
    data: empty,
    errorMessage: message,
    stalenessMs: null,
    lastFetchedAt: null,
    isCachedData: false,
  };
}

function unavailableSection<T>(empty: T, message: string): DashboardSection<T> {
  return {
    state: 'unavailable',
    data: empty,
    errorMessage: message,
    stalenessMs: null,
    lastFetchedAt: null,
    isCachedData: false,
  };
}

const SECTION_DEFINITIONS: {
  [K in SectionKey]: SectionDefinition<K, DashboardSectionMap[K]['data']>;
} = {
  summaryCards: {
    key: 'summaryCards',
    label: 'summary cards',
    empty: [],
    fetch: readModel => ensureArrayResult('summary cards', readModel.getSummaryCards()),
  },
  strategyPerformance: {
    key: 'strategyPerformance',
    label: 'strategy performance',
    empty: [],
    fetch: readModel => ensureArrayResult('strategy performance', readModel.getStrategyPerformance()),
  },
  tickerPerformance: {
    key: 'tickerPerformance',
    label: 'ticker performance',
    empty: [],
    fetch: readModel => ensureArrayResult('ticker performance', readModel.getTickerPerformance()),
  },
  decisionPerformance: {
    key: 'decisionPerformance',
    label: 'decision performance',
    empty: [],
    fetch: readModel => ensureArrayResult('decision performance', readModel.getDecisionPerformance(50)),
  },
  lifecycleStates: {
    key: 'lifecycleStates',
    label: 'lifecycle states',
    empty: [],
    fetch: readModel => ensureArrayResult('lifecycle states', readModel.getLifecycleStates()),
  },
  governanceHistory: {
    key: 'governanceHistory',
    label: 'governance history',
    empty: [],
    fetch: readModel => ensureArrayResult('governance history', readModel.getLifecycleHistory(20)),
  },
  promotionHistory: {
    key: 'promotionHistory',
    label: 'promotion history',
    empty: [],
    fetch: readModel => ensureArrayResult('promotion history', readModel.getPromotionHistory(20)),
  },
  walkForwardLeaderboard: {
    key: 'walkForwardLeaderboard',
    label: 'walk-forward leaderboard',
    empty: [],
    fetch: readModel => ensureArrayResult('walk-forward leaderboard', readModel.getWalkForwardLeaderboard()),
  },
};

function buildUnavailablePayload(assembledAt: string, dbError: string | null): DashboardPayload {
  const message = dbError ?? 'Database is not available.';
  return {
    assembledAt,
    dbAvailable: false,
    dbError,
    summaryCards: unavailableSection(SECTION_DEFINITIONS.summaryCards.empty, message),
    strategyPerformance: unavailableSection(SECTION_DEFINITIONS.strategyPerformance.empty, message),
    tickerPerformance: unavailableSection(SECTION_DEFINITIONS.tickerPerformance.empty, message),
    decisionPerformance: unavailableSection(SECTION_DEFINITIONS.decisionPerformance.empty, message),
    lifecycleStates: unavailableSection(SECTION_DEFINITIONS.lifecycleStates.empty, message),
    governanceHistory: unavailableSection(SECTION_DEFINITIONS.governanceHistory.empty, message),
    promotionHistory: unavailableSection(SECTION_DEFINITIONS.promotionHistory.empty, message),
    walkForwardLeaderboard: unavailableSection(SECTION_DEFINITIONS.walkForwardLeaderboard.empty, message),
  };
}

export class DashboardPayloadAssembler {
  private readonly cache = new Map<SectionKey, CachedSectionValue<unknown>>();

  fetchDashboardPayload(
    readModel: OperatorReadModel | null,
    dbError: string | null,
    nowMs = Date.now(),
  ): DashboardPayload {
    const assembledAt = toIso(nowMs);

    if (readModel === null) {
      return buildUnavailablePayload(assembledAt, dbError);
    }

    return {
      assembledAt,
      dbAvailable: true,
      dbError: null,
      summaryCards: this.fetchSection(SECTION_DEFINITIONS.summaryCards, readModel, nowMs),
      strategyPerformance: this.fetchSection(SECTION_DEFINITIONS.strategyPerformance, readModel, nowMs),
      tickerPerformance: this.fetchSection(SECTION_DEFINITIONS.tickerPerformance, readModel, nowMs),
      decisionPerformance: this.fetchSection(SECTION_DEFINITIONS.decisionPerformance, readModel, nowMs),
      lifecycleStates: this.fetchSection(SECTION_DEFINITIONS.lifecycleStates, readModel, nowMs),
      governanceHistory: this.fetchSection(SECTION_DEFINITIONS.governanceHistory, readModel, nowMs),
      promotionHistory: this.fetchSection(SECTION_DEFINITIONS.promotionHistory, readModel, nowMs),
      walkForwardLeaderboard: this.fetchSection(SECTION_DEFINITIONS.walkForwardLeaderboard, readModel, nowMs),
    };
  }

  private fetchSection<K extends SectionKey>(
    definition: SectionDefinition<K, DashboardSectionMap[K]['data']>,
    readModel: OperatorReadModel,
    nowMs: number,
  ): DashboardSectionMap[K] {
    try {
      const data = definition.fetch(readModel);
      this.cache.set(definition.key, { data, lastFetchedAtMs: nowMs });
      return okSection(data, nowMs) as DashboardSectionMap[K];
    } catch (err) {
      const message = sanitizeDiagnostic(definition.label, err);
      const cached = this.cache.get(definition.key) as CachedSectionValue<DashboardSectionMap[K]['data']> | undefined;
      if (cached) {
        return staleSection(cached, message, nowMs) as DashboardSectionMap[K];
      }
      return errorSection(definition.empty, message) as DashboardSectionMap[K];
    }
  }
}

export function fetchDashboardPayload(
  readModel: OperatorReadModel | null,
  dbError: string | null,
): DashboardPayload {
  return new DashboardPayloadAssembler().fetchDashboardPayload(readModel, dbError);
}
