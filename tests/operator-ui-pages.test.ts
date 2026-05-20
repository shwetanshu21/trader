import { describe, it, expect } from 'vitest';
import { renderBacktestDetailPage } from '../src/operator-ui/pages/backtest-detail-page.js';
import { renderDashboardPage } from '../src/operator-ui/pages/dashboard-page.js';
import { renderDecisionDetailPage } from '../src/operator-ui/pages/decision-detail-page.js';
import { renderStrategyDetailPage } from '../src/operator-ui/pages/strategy-detail-page.js';
import type { DashboardPayload, DashboardSection } from '../src/operator-ui/dashboard-data.js';
import type {
  OperatorBacktestDetail,
  OperatorDecisionDetail,
  OperatorDecisionPerformance,
  OperatorLifecycleHistory,
  OperatorLifecycleState,
  OperatorPromotionHistory,
  OperatorProvenance,
  OperatorStrategyDetail,
  OperatorStrategyPerformance,
  OperatorSummaryCard,
  OperatorTickerPerformance,
  OperatorWalkForwardLeaderboard,
} from '../src/types/runtime.js';

const testProvenance: OperatorProvenance = {
  source: 'historical',
  asOf: Date.now(),
  sourceLabel: 'test',
};

function ok<T>(data: T): DashboardSection<T> {
  return {
    state: 'ok',
    data,
    errorMessage: null,
    stalenessMs: null,
    lastFetchedAt: new Date().toISOString(),
    isCachedData: false,
  };
}

function errorSection<T>(message: string, lastKnown?: T): DashboardSection<T> {
  return {
    state: 'error',
    data: lastKnown ?? ([] as unknown as T),
    errorMessage: message,
    stalenessMs: null,
    lastFetchedAt: null,
    isCachedData: false,
  };
}

function unavailableSection<T>(): DashboardSection<T> {
  return {
    state: 'unavailable',
    data: [] as unknown as T,
    errorMessage: 'Database is not available.',
    stalenessMs: null,
    lastFetchedAt: null,
    isCachedData: false,
  };
}

function sampleSummaryCards(): OperatorSummaryCard[] {
  return [
    { key: 'current_pnl', label: 'Current P&L', value: 15420.50, unit: 'INR', change: null, display: null, provenance: testProvenance },
    { key: 'open_positions', label: 'Open Positions', value: 3, unit: null, change: null, display: null, provenance: testProvenance },
  ];
}

function sampleStrategyPerformance(): OperatorStrategyPerformance[] {
  return [
    {
      strategyId: 'india-nse-eq-v1', strategyVersion: '1.0.0', totalReturnPct: 12.5,
      sharpeRatio: 1.8, maxDrawdownPct: 15.0, tradeCount: 24, winRate: 0.62,
      profitFactor: 2.1, realizedPnl: 15420.50, unrealizedPnl: 3200.00, provenance: testProvenance,
    },
  ];
}

function sampleTickerPerformance(): OperatorTickerPerformance[] {
  return [
    {
      exchange: 'NSE', tradingsymbol: 'RELIANCE', totalPnl: 5200.00, tradeCount: 8,
      winRate: 0.75, netQuantity: 25, avgEntryPrice: 2850.00, lastPrice: 2890.00,
      unrealizedPnl: 1000.00, realizedPnl: 4200.00, provenance: testProvenance,
    },
  ];
}

function sampleDecisionPerformance(): OperatorDecisionPerformance[] {
  return [
    {
      decisionId: 7, proposalAttemptId: 100, exchange: 'NSE', tradingsymbol: 'RELIANCE',
      side: 'buy', quantity: 25, price: 2850.00, decisionStatus: 'approved',
      strategyId: 'india-nse-eq-v1', decidedAt: '2025-01-10T10:20:30.000Z',
      executionStatus: 'completed', outcomeCode: 'paper_simulated', realizedPnl: 1200.00,
      provenance: testProvenance,
    },
  ];
}

function sampleLifecycleStates(): OperatorLifecycleState[] {
  return [
    {
      strategyId: 'india-nse-eq-v1', strategyVersion: '1.0.0', marketId: 'INDIA_NSE_EQ',
      phase: 'paper', updatedAt: '2025-01-11T09:15:00.000Z', provenance: testProvenance,
    },
  ];
}

function sampleLifecycleHistory(): OperatorLifecycleHistory[] {
  return [
    {
      id: 1, strategyId: 'india-nse-eq-v1', strategyVersion: '1.0.0', marketId: 'INDIA_NSE_EQ',
      verdict: 'promote', previousPhase: 'backtest', newPhase: 'paper', rationale: 'Winner met thresholds.',
      recordedAt: '2025-01-11T09:20:00.000Z', provenance: testProvenance,
    },
  ];
}

function samplePromotionHistory(): OperatorPromotionHistory[] {
  return [
    {
      id: 1, strategyId: 'india-nse-eq-v1', strategyVersion: '1.0.0', marketId: 'INDIA_NSE_EQ',
      previousPhase: 'backtest', newPhase: 'paper', rationale: 'WF run promoted.', winnerId: 5,
      promotedAt: '2025-01-11T09:20:00.000Z', provenance: testProvenance,
    },
  ];
}

function sampleWalkForwardLeaderboard(): OperatorWalkForwardLeaderboard[] {
  return [
    {
      runId: 42, label: 'WF-2025-01-v1', strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0', marketId: 'INDIA_NSE_EQ', windowCount: 12,
      winnerId: 4, selectionStrategy: 'best_sharpe', mergedScore: 0.78,
      sharpeRatio: 1.8, totalReturnPct: 15.2, maxDrawdownPct: 18.5,
      winRate: 0.65, selectedAt: '2025-01-11T09:30:00.000Z', provenance: testProvenance,
    },
  ];
}

function buildPayload(overrides?: Partial<DashboardPayload>): DashboardPayload {
  return {
    assembledAt: '2025-01-11T10:00:00.000Z',
    dbAvailable: true,
    dbError: null,
    summaryCards: ok(sampleSummaryCards()),
    strategyPerformance: ok(sampleStrategyPerformance()),
    tickerPerformance: ok(sampleTickerPerformance()),
    decisionPerformance: ok(sampleDecisionPerformance()),
    lifecycleStates: ok(sampleLifecycleStates()),
    governanceHistory: ok(sampleLifecycleHistory()),
    promotionHistory: ok(samplePromotionHistory()),
    walkForwardLeaderboard: ok(sampleWalkForwardLeaderboard()),
    ...overrides,
  };
}

function sampleDecisionDetail(): OperatorDecisionDetail {
  return {
    decisionId: 7,
    proposalAttemptId: 100,
    decisionStatus: 'approved',
    strategyId: 'alpha<script>',
    strategyVersion: '1.0.0',
    decidedAt: '2025-01-10T10:20:30.000Z',
    reasons: [{ reasonCode: 'policy_constraint', reasonMessage: 'Trend <strong>passed</strong>.' }],
    indiaResearchEvidence: {
      summary: 'Breadth <script>alert(1)</script> improved.',
      tags: ['macro', 'breadth'],
      freshnessMs: 60000,
      influenceContext: 'Raised conviction.',
    },
    trade: { exchange: 'NSE', tradingsymbol: 'RELIANCE', side: 'buy', product: 'MIS', quantity: 25, price: 2850, triggerPrice: null, orderType: 'LIMIT' },
    quote: { lastPrice: 2851.4, bid: 2851.2, ask: 2851.6, volume: 120000, receivedAt: '2025-01-10T10:20:00.000Z' },
    risk: {
      notional: 71250, sizingBasis: 'last_price', maxLossRupees: 1800, stopDistance: 12, stopPrice: 2839.4,
      trailingStopDistance: 8, riskBudgetRupees: 2000, exposureTag: 'intraday',
    },
    instrument: { executionClass: 'EQ', segment: 'NSE', instrumentType: 'EQ', expiry: null, strike: null, lotSize: 1, tickSize: 0.05, freezeQuantity: null },
    hybrid: {
      summaryId: 9, deterministicScore: 0.71, llmScore: 0.82, llmStatus: 'consulted', llmRationale: 'Momentum held.',
      mergedScore: 0.765, mergePolicy: 'weighted', createdAt: '2025-01-10T10:20:31.000Z', components: [{ componentName: 'momentum', score: 0.8, weight: 0.5, sortOrder: 1 }],
    },
    executionAttempt: {
      id: 11, executionMode: 'paper', status: 'completed', outcomeCode: 'paper_simulated', brokerOrderId: 'paper-1',
      message: 'Filled successfully.', attemptedAt: '2025-01-10T10:21:00.000Z', completedAt: '2025-01-10T10:21:03.000Z', refusalReasons: [],
    },
    realizedPnl: {
      realizedPnl: 250, eventCount: 2, latestEventAt: '2025-01-10T10:22:00.000Z',
      currentPosition: {
        exchange: 'NSE', tradingsymbol: 'RELIANCE', product: 'MIS', side: 'flat', quantity: 0,
        avgCostPrice: 0, realizedPnl: 250, markPrice: 2862, updatedAt: '2025-01-10T10:22:00.000Z',
      },
    },
    diagnostics: ['Malformed JSON ignored at hybrid.components_json.'],
    provenance: testProvenance,
  };
}

function sampleStrategyDetail(): OperatorStrategyDetail {
  return {
    strategyId: 'alpha<script>',
    strategyVersion: '1.0.0',
    performance: { totalReturnPct: 12.5, sharpeRatio: 1.8, maxDrawdownPct: 15, tradeCount: 24, winRate: 0.62, profitFactor: 2.1, realizedPnl: 15420.5, unrealizedPnl: 3200 },
    recentDecisions: sampleDecisionPerformance(),
    currentStates: sampleLifecycleStates(),
    governanceHistory: [{ id: 8, marketId: 'INDIA_NSE_EQ', verdict: 'promote', previousPhase: 'backtest', newPhase: 'paper', rationale: 'Escaped <b>safe</b>.', winnerId: null, evidence: { why: 'thresholds' }, recordedAt: '2025-01-11T09:20:00.000Z' }],
    promotionHistory: [{ id: 1, strategyId: 'alpha<script>', strategyVersion: '1.0.0', marketId: 'INDIA_NSE_EQ', previousPhase: 'backtest', newPhase: 'paper', rationale: 'Promoted without winner context.', winnerId: null, promotedAt: '2025-01-11T09:20:00.000Z', provenance: testProvenance }],
    walkForwardRuns: [{ runId: 42, label: 'WF-A', marketId: 'INDIA_NSE_EQ', status: 'completed', windowCount: 12, totalTrials: 24, winnerId: null, result: 'no_winner', selectionStrategy: 'best_sharpe', selectedTrialId: null, selectedTrialLabel: null, mergedScore: null, sharpeRatio: null, totalReturnPct: null, maxDrawdownPct: null, winRate: null, rationale: 'No candidate cleared thresholds.', selectedAt: null }],
    diagnostics: ['Malformed governance evidence ignored.'],
    provenance: testProvenance,
  };
}

function sampleBacktestDetail(): OperatorBacktestDetail {
  return {
    runId: 42, label: 'WF-A', strategyId: 'alpha<script>', strategyVersion: '1.0.0', marketId: 'INDIA_NSE_EQ', status: 'completed', windowCount: 12, totalTrials: 24,
    createdAt: '2025-01-01T09:00:00.000Z', startedAt: '2025-01-01T09:05:00.000Z', completedAt: '2025-01-01T10:05:00.000Z', winnerId: 4, result: 'selected',
    selectedTrialId: 99, selectionStrategy: 'best_sharpe', selectionConfig: { threshold: 0.7 }, rationale: 'Selected best overall candidate.', artifactPaths: ['reports/wf-a.json'], selectedAt: '2025-01-01T10:05:00.000Z',
    selectedTrial: { id: 99, runId: 42, trialIndex: 1, label: 'trial<script>', params: { stopLoss: 2 }, mergedScore: 0.88, deterministicScore: 0.84, llmScore: 0.92, llmStatus: 'consulted', rank: 1, windowEvidence: [{ id: 1, trialId: 99, windowId: 5, windowType: 'out_of_sample', totalReturnPct: 15.2, sharpeRatio: 1.8, maxDrawdownPct: 12.1, winRate: 0.64, tradeCount: 22, profitFactor: 1.9, metrics: { pnl: 1200 } }] },
    rankedCandidates: [{ trialId: 99, rank: 1, label: 'trial<script>', params: { stopLoss: 2 }, mergedScore: 0.88, deterministicScore: 0.84, llmScore: 0.92, llmStatus: 'consulted', windowCount: 12 }],
    diagnostics: [], provenance: testProvenance,
  };
}

describe('Dashboard page', () => {
  it('renders drill-down links from persisted identifiers', () => {
    const html = renderDashboardPage(buildPayload());
    expect(html).toContain('/strategy?strategyId=india-nse-eq-v1&strategyVersion=1.0.0');
    expect(html).toContain('/decision?id=7');
    expect(html).toContain('/backtest?runId=42');
    expect(html).toContain('WF#5');
  });

  it('renders degraded and unavailable states', () => {
    const html = renderDashboardPage(buildPayload({ strategyPerformance: errorSection('Query failed'), promotionHistory: unavailableSection() }));
    expect(html).toContain('Query failed');
    expect(html).toContain('Database is not available.');
  });

  it('renders stale sections with preserved rows and warning banner', () => {
    const html = renderDashboardPage(buildPayload({
      strategyPerformance: {
        state: 'stale',
        data: sampleStrategyPerformance(),
        errorMessage: 'Failed to refresh strategy performance: timeout',
        stalenessMs: 45_000,
        lastFetchedAt: '2025-01-11T09:59:15.000Z',
        isCachedData: true,
      },
    }));
    expect(html).toContain('Data may be stale');
    expect(html).toContain('india-nse-eq-v1');
    expect(html).toContain('45s ago');
  });
});

describe('Decision detail page', () => {
  it('renders rationale-first evidence and escapes unsafe HTML', () => {
    const html = renderDecisionDetailPage(sampleDecisionDetail());
    expect(html).toContain('Decision #7');
    expect(html).toContain('Rationale-first evidence');
    expect(html).toContain('Trend &lt;strong&gt;passed&lt;/strong&gt;.');
    expect(html).toContain('Breadth &lt;script&gt;alert(1)&lt;/script&gt; improved.');
    expect(html).toContain('/strategy?strategyId=alpha%3Cscript%3E&strategyVersion=1.0.0');
    expect(html).toContain('No refusal reasons were recorded for this execution attempt.');
  });

  it('renders explicit empty states when execution and research evidence are absent', () => {
    const detail = sampleDecisionDetail();
    detail.executionAttempt = null;
    detail.realizedPnl = null;
    detail.indiaResearchEvidence = null;
    detail.hybrid = null;
    const html = renderDecisionDetailPage(detail);
    expect(html).toContain('No execution attempt has been recorded for this decision yet.');
    expect(html).toContain('No realized P&amp;L evidence is available because this decision has not produced linked execution evidence yet.');
    expect(html).toContain('No India research evidence was persisted for this decision.');
    expect(html).toContain('No hybrid scoring evidence was persisted for this decision.');
  });
});

describe('Strategy detail page', () => {
  it('renders linked decisions and explicit no-winner context', () => {
    const html = renderStrategyDetailPage(sampleStrategyDetail());
    expect(html).toContain('/decision?id=7');
    expect(html).toContain('/backtest?runId=42');
    expect(html).toContain('No candidate cleared thresholds.');
    expect(html).toContain('No winner recorded');
    expect(html).toContain('Escaped &lt;b&gt;safe&lt;/b&gt;.');
  });
});

describe('Backtest detail page', () => {
  it('renders selected-trial evidence and escapes trial labels', () => {
    const html = renderBacktestDetailPage(sampleBacktestDetail());
    expect(html).toContain('Selected best overall candidate.');
    expect(html).toContain('trial&lt;script&gt;');
    expect(html).toContain('reports/wf-a.json');
    expect(html).toContain('/strategy?strategyId=alpha%3Cscript%3E&strategyVersion=1.0.0');
  });

  it('renders explicit no-winner and empty evidence states', () => {
    const detail = sampleBacktestDetail();
    detail.result = 'no_winner';
    detail.selectedTrialId = null;
    detail.selectedTrial = null;
    detail.rankedCandidates = [];
    detail.selectionConfig = null;
    detail.artifactPaths = null;
    const html = renderBacktestDetailPage(detail);
    expect(html).toContain('No winner selected for this run.');
    expect(html).toContain('No selected trial evidence was persisted because this run has no winner context.');
    expect(html).toContain('No ranked candidates were persisted for this run.');
    expect(html).toContain('No selection config JSON was persisted for this run.');
  });
});
