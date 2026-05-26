import { describe, it, expect } from 'vitest';
import { renderBacktestDetailPage } from '../src/operator-ui/pages/backtest-detail-page.js';
import { renderDashboardPage } from '../src/operator-ui/pages/dashboard-page.js';
import { renderDecisionDetailPage } from '../src/operator-ui/pages/decision-detail-page.js';
import { renderStrategyDetailPage } from '../src/operator-ui/pages/strategy-detail-page.js';
import { renderPositionsPage } from '../src/operator-ui/pages/positions-page.js';
import { renderStrategiesPage } from '../src/operator-ui/pages/strategies-page.js';
import { renderDecisionsPage } from '../src/operator-ui/pages/decisions-page.js';
import { renderGovernancePage } from '../src/operator-ui/pages/governance-page.js';
import { renderSystemHealthPage } from '../src/operator-ui/pages/system-health-page.js';
import { renderEvidenceChecklist } from '../src/operator-ui/components/evidence-checklist.js';
import { renderWhyNarrativeCard } from '../src/operator-ui/components/why-narrative.js';
import { renderStatusPage } from '../src/operator-ui/render-utils.js';
import type { DashboardPayload, DashboardSection } from '../src/operator-ui/dashboard-data.js';
import type { OperatorShellStatusViewModel } from '../src/operator-ui/components/status-strip.js';
import type {
  OperatorBacktestDetail,
  OperatorDecisionDetail,
  OperatorDecisionPerformance,
  OperatorLifecycleHistory,
  OperatorLifecycleState,
  OperatorPromotionHistory,
  OperatorProvenance,
  OperatorStrategyDetail,
  OperatorStrategyExposure,
  OperatorStrategyPerformance,
  OperatorSummaryCard,
  OperatorTickerPerformance,
  OperatorWalkForwardLeaderboard,
  OperatorResearchLineageSummary,
} from '../src/types/runtime.js';

const testProvenance: OperatorProvenance = {
  source: 'historical',
  asOf: Date.now(),
  sourceLabel: 'test',
};

function sampleShellStatus(): OperatorShellStatusViewModel {
  return {
    assembledAt: '2025-01-11T10:00:00.000Z',
    headline: 'Operator attention required: one or more global surfaces are degraded.',
    items: [
      { key: 'market', label: 'Market', tone: 'unavailable', summary: 'Unavailable', detail: 'No scheduler proof is persisted on operator routes.', evidence: 'no persisted scheduler phase', asOf: '2025-01-11T10:00:00.000Z' },
      { key: 'execution', label: 'Execution', tone: 'warning', summary: 'pending', detail: 'Historical attempts exist but current mode is not proven.', evidence: 'decision performance', asOf: '2025-01-11T09:59:30.000Z' },
      { key: 'broker', label: 'Broker', tone: 'critical', summary: 'Refresh failed', detail: 'Broker auth is degraded.', evidence: 'upstox auth summary card', asOf: '2025-01-11T09:59:00.000Z' },
      { key: 'risk', label: 'Risk', tone: 'unavailable', summary: 'Unavailable', detail: 'No global risk halt surface is wired yet.', evidence: 'no persisted global risk posture', asOf: '2025-01-11T10:00:00.000Z' },
      { key: 'freshness', label: 'Freshness', tone: 'warning', summary: '1 stale section(s)', detail: 'Showing last-known cached data for one or more sections.', evidence: 'dashboard section refresh metadata', asOf: '2025-01-11T09:59:15.000Z' },
    ],
  };
}

function expectSharedShell(html: string, activeHref?: string): void {
  expect(html).toContain('class="console-shell"');
  expect(html).toContain('data-shell-status-strip');
  expect(html).toContain('data-shell-status-key="market"');
  expect(html).toContain('data-shell-status-key="execution"');
  expect(html).toContain('data-shell-status-key="broker"');
  expect(html).toContain('data-shell-status-key="risk"');
  expect(html).toContain('data-shell-status-key="freshness"');
  expect(html).toContain('Operator Console Navigation');
  if (activeHref) {
    expect(html).toContain(`href="${activeHref}" data-active="true" aria-current="page"`);
  }
}

function expectExplainabilityHierarchy(html: string): void {
  expect(html).toContain('<h3>What</h3>');
  expect(html).toContain('<h3>Why</h3>');
  expect(html).toContain('<h3>Evidence</h3>');
}

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
    { key: 'upstox_auth', label: 'Upstox Auth', value: 0, unit: null, change: null, display: 'Healthy', provenance: testProvenance },
    { key: 'current_pnl', label: 'Current P&L', value: 15420.50, unit: 'INR', change: null, display: null, provenance: testProvenance },
    { key: 'unrealized_pnl', label: 'Unrealized P&L', value: 3200.00, unit: 'INR', change: null, display: null, provenance: testProvenance },
    { key: 'open_positions', label: 'Open Positions', value: 3, unit: null, change: null, display: null, provenance: testProvenance },
    { key: 'invested_capital', label: 'Invested Capital', value: 71250.00, unit: 'INR', change: null, display: null, provenance: testProvenance },
    { key: 'current_value', label: 'Current Value', value: 74450.00, unit: 'INR', change: null, display: null, provenance: testProvenance },
    { key: 'net_pnl', label: 'Net P&L', value: 18620.50, unit: 'INR', change: null, display: null, provenance: testProvenance },
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
      executionStatus: 'completed', outcomeCode: 'paper_simulated', fees: 12.34,
      llmStatus: 'degraded', llmRationale: 'LLM returned empty rankings — using deterministic fallback',
      realizedPnl: 1200.00, provenance: testProvenance,
    },
  ];
}

function sampleStrategyExposure(): OperatorStrategyExposure[] {
  return [
    {
      bucketType: 'strategy',
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      label: 'india-nse-eq-v1@1.0.0',
      openPositionCount: 1,
      grossOpenCostBasis: 71250,
      grossOpenMarketValue: 72250,
      unrealizedPnl: 1000,
      attributionNote: null,
      provenance: testProvenance,
    },
    {
      bucketType: 'unattributed',
      strategyId: null,
      strategyVersion: null,
      label: 'Unattributed Exposure',
      openPositionCount: 1,
      grossOpenCostBasis: 50000,
      grossOpenMarketValue: 51000,
      unrealizedPnl: 1000,
      attributionNote: 'Multiple strategies traded one or more open positions, so exposure is withheld from per-strategy attribution.',
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


function sampleResearchLineage(): OperatorResearchLineageSummary {
  return {
    totals: { generationAttempts: 4, hypotheses: 3, evaluations: 2, duplicateSkips: 1, publications: 1 },
    recent: [{
      canonicalHash: 'abc123',
      lineageType: 'publication',
      status: 'published',
      happenedAt: '2025-01-11T09:30:00.000Z',
      generationAttempt: { id: 8, verdict: 'accepted', reasonCodes: [], providerLabel: 'test-model' },
      duplicateSkip: null,
      hypothesis: { id: 2, status: 'validated', createdAt: '2025-01-11T09:00:00.000Z' },
      evaluation: { id: 3, status: 'persisted', walkForwardRunId: 42, winnerId: 4 },
      publication: { publicationId: 5, publicationStatus: 'published', strategyId: 'india-nse-eq-v1', strategyVersion: '1.0.0', marketId: 'INDIA_NSE_EQ', lifecyclePhase: 'paper', governanceVerdict: 'promote', publishedAt: '2025-01-11T09:30:00.000Z' },
      diagnostics: [],
    }],
    status: {
      availability: 'ready',
      diagnostics: [],
      provenance: [{ sourceLabel: 'research_publications', detail: 'publication provenance' }],
    },
    provenance: testProvenance,
  };
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
    researchLineage: ok(sampleResearchLineage()),
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
    publishedResearchProvenance: {
      publicationId: 5,
      publicationStatus: 'published',
      hypothesisGraphId: 2,
      canonicalHash: 'abc123<script>',
      hypothesisEvaluationId: 3,
      evaluationStatus: 'completed',
      walkForwardRunId: 42,
      winnerId: 4,
      marketId: 'INDIA_NSE_EQ',
      lifecyclePhase: 'paper',
      governanceVerdict: 'promote',
      rationale: 'Published after review <b>approved</b>.',
      evidence: { actualMergedScore: 0.88 },
      publishedAt: '2025-01-11T09:30:00.000Z',
      createdAt: '2025-01-11T09:30:00.000Z',
      provenance: testProvenance,
    },
    hostEvidencePresence: {
      lifecycleStates: true,
      governanceHistory: true,
      promotionHistory: true,
      walkForwardRuns: true,
      researchPublications: true,
    },
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

describe('Shared explainability components', () => {
  it('render bounded empty evidence states with truthful recent-window wording', () => {
    const html = renderEvidenceChecklist({
      title: 'Recent evidence window',
      criteria: [],
      emptyMessage: 'No recent <script> lineage evidence was persisted.',
      boundedWindow: { count: 0, noun: 'lineage row' },
    });

    expect(html).toContain('Recent evidence below is intentionally bounded to the newest 0 lineage rows for operator readability.');
    expect(html).toContain('No recent &lt;script&gt; lineage evidence was persisted.');
  });

  it('render escaped why narratives with explicit missing execution evidence states', () => {
    const html = renderWhyNarrativeCard({
      decisionId: 7,
      decisionStatus: 'approved',
      strategyId: 'alpha<script>',
      strategyVersion: '1.0.0',
      trade: {
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE<script>',
        side: 'buy',
      },
      reasons: [
        {
          reasonCode: 'policy_constraint',
          reasonMessage: 'Trend <strong>passed</strong>.',
        },
      ],
      executionAttempt: null,
    });

    expect(html).toContain('Trend &lt;strong&gt;passed&lt;/strong&gt;.');
    expect(html).toContain('alpha&lt;script&gt;@1.0.0');
    expect(html).toContain('RELIANCE&lt;script&gt;');
    expect(html).toContain('No execution attempt has been recorded for this decision yet.');
    expect(html).not.toContain('Trend <strong>passed</strong>.');
  });

  it('render escaped checklist criteria details without leaking unsafe HTML', () => {
    const html = renderEvidenceChecklist({
      criteria: [
        {
          name: 'Research freshness <img>',
          result: 'warn',
          observedValue: '<60m',
          threshold: '≤15m',
          note: 'Latest summary came from <script>alert(1)</script>.',
          source: {
            label: 'Decision <b>detail</b>',
            href: '/decision?id=7&source=<script>',
          },
        },
      ],
    });

    expect(html).toContain('Research freshness &lt;img&gt;');
    expect(html).toContain('Latest summary came from &lt;script&gt;alert(1)&lt;/script&gt;.');
    expect(html).toContain('Decision &lt;b&gt;detail&lt;/b&gt;');
    expect(html).toContain('/decision?id=7&amp;source=&lt;script&gt;');
    expect(html).not.toContain('<img>');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

describe('Shared shell status contract', () => {
  it('renders the shared shell-status strip across dashboard, list, detail, and status pages', () => {
    const shellStatus = sampleShellStatus();
    const payload = buildPayload();

    const dashboardHtml = renderDashboardPage(payload, { pollIntervalMs: 1_500, shellStatus });
    expectSharedShell(dashboardHtml, '/');
    expect(dashboardHtml).toContain('data-shell-status-tone="critical"');
    expect(dashboardHtml).toContain('Refresh failed');

    const positionsHtml = renderPositionsPage(payload, sampleStrategyExposure(), { shellStatus });
    expectSharedShell(positionsHtml, '/positions');

    const strategiesHtml = renderStrategiesPage(payload, sampleStrategyExposure(), { shellStatus });
    expectSharedShell(strategiesHtml, '/strategies');

    const decisionsHtml = renderDecisionsPage(payload, { shellStatus });
    expectSharedShell(decisionsHtml, '/decisions');

    const governanceHtml = renderGovernancePage(payload, { shellStatus });
    expectSharedShell(governanceHtml, '/governance');

    const systemHealthHtml = renderSystemHealthPage({
      status: 'healthy',
      version: '0.1.0',
      service: 'operator-ui',
      dbConnected: true,
      dbError: null,
      pollIntervalMs: 1000,
      authClients: [],
      dbOpenBootstrap: { status: 'ready', lastError: null },
      detailReadModelBootstrap: { status: 'ready', lastError: null },
      upstoxTokenRefresh: { refresh: { state: 'awaiting_approval' } },
      sections: { summaryCards: { status: 'ok', count: 3 } },
    }, { shellStatus });
    expectSharedShell(systemHealthHtml, '/system-health');

    const decisionHtml = renderDecisionDetailPage(sampleDecisionDetail(), { shellStatus });
    expectSharedShell(decisionHtml, '/decisions');

    const strategyHtml = renderStrategyDetailPage(sampleStrategyDetail(), { shellStatus });
    expectSharedShell(strategyHtml, '/strategies');

    const backtestHtml = renderBacktestDetailPage(sampleBacktestDetail(), { shellStatus });
    expectSharedShell(backtestHtml, '/governance');

    const statusHtml = renderStatusPage({
      title: 'Decision Not Found',
      detail: 'No persisted decision detail exists for id=9999.',
      statusLabel: '404 Not Found',
      kicker: 'Operator Decision Detail',
      navActive: 'decisions',
      actions: '<a href="/decisions">Back to decision ledger</a>',
      shellStatus,
    });
    expectSharedShell(statusHtml, '/decisions');
  });
});

describe('Top-level operator pages', () => {
  it('renders dedicated positions and strategies pages with truthful exposure language', () => {
    const payload = buildPayload();
    const positionsHtml = renderPositionsPage(payload, sampleStrategyExposure());
    expectExplainabilityHierarchy(positionsHtml);
    expect(positionsHtml).toContain('Positions &amp; Exposure');
    expect(positionsHtml).toContain('Exposure Summary');
    expect(positionsHtml).toContain('Exposure by Strategy');
    expect(positionsHtml).toContain('Unattributed Exposure');
    expect(positionsHtml).toContain('This page reports exposure only from persisted paper positions');
    expect(positionsHtml).toContain('Ambiguous or unlinked positions are withheld from strategy buckets instead of guessed.');
    expect(positionsHtml).toContain('/positions');

    const strategiesHtml = renderStrategiesPage(payload, sampleStrategyExposure());
    expectExplainabilityHierarchy(strategiesHtml);
    expect(strategiesHtml).toContain('Strategy Summary');
    expect(strategiesHtml).toContain('Attributed Open Exposure');
    expect(strategiesHtml).toContain('Invested Capital');
    expect(strategiesHtml).toContain('Current Value');
    expect(strategiesHtml).toContain('Net P&amp;L');
    expect(strategiesHtml).toContain('Unattributed Open Market Value');
    expect(strategiesHtml).toContain('This page separates whole-book paper-ledger capital from strategy-level attribution');
    expect(strategiesHtml).toContain('/strategies');
  });

  it('renders dedicated decisions, governance, and system-health pages', () => {
    const payload = buildPayload();
    const decisionsHtml = renderDecisionsPage(payload);
    expectExplainabilityHierarchy(decisionsHtml);
    expect(decisionsHtml).toContain('Decision Ledger');
    expect(decisionsHtml).toContain('Decision Explainability');
    expect(decisionsHtml).toContain('This page stays within the existing persisted decision window');
    const governanceHtml = renderGovernancePage(payload);
    expectExplainabilityHierarchy(governanceHtml);
    expect(governanceHtml).toContain('Governance &amp; Backtests');
    expect(governanceHtml).toContain('Governance Explainability');
    expect(governanceHtml).toContain('Research Lineage');
    expect(governanceHtml).toContain('Published Research Total');
    expect(governanceHtml).toContain('Repository-backed totals lead this section so operators can inspect the truthful full lineage first');
    expect(governanceHtml).toContain('Recent evidence window');
    expect(governanceHtml).toContain('Recent evidence below is intentionally bounded to the newest 1 lineage row for operator readability.');

    const healthHtml = renderSystemHealthPage({
      status: 'healthy',
      version: '0.1.0',
      service: 'operator-ui',
      dbConnected: true,
      dbError: null,
      pollIntervalMs: 1000,
      authClients: [],
      dbOpenBootstrap: { status: 'ready', lastError: null },
      detailReadModelBootstrap: { status: 'ready', lastError: null },
      upstoxTokenRefresh: { exists: true, statusPath: './tmp/upstox/notifier/refresh-status.json', refresh: { state: 'awaiting_approval' }, token: { exists: true, expiresAt: '2025-01-11T12:00:00.000Z', isExpired: false } },
      sections: { summaryCards: { status: 'ok', count: 3 } },
    });
    expectExplainabilityHierarchy(healthHtml);
    expect(healthHtml).toContain('System Health');
    expect(healthHtml).toContain('/api/health');
    expect(healthHtml).toContain('Health Summary');
    expect(healthHtml).toContain('Broker Token and Refresh Recovery');
    expect(healthHtml).toContain('Subsystem Evidence');
    expect(healthHtml).toContain('Operator Auth');
    expect(healthHtml).toContain('Database Open Bootstrap');
    expect(healthHtml).toContain('Detail Read Model Bootstrap');
    expect(healthHtml).toContain('Request Upstox Token Refresh');
  });

  it('renders degraded system-health states with explicit bootstrap and refresh failure evidence', () => {
    const healthHtml = renderSystemHealthPage({
      status: 'degraded',
      version: '0.1.0',
      service: 'operator-ui',
      dbConnected: false,
      dbError: 'open failed',
      pollIntervalMs: 1000,
      authClients: [{ clientIp: '127.0.0.1', failures: 2, lockedUntilTimestamp: Date.now() + 60_000, activeRequestsInWindow: 4 }],
      dbOpenBootstrap: { status: 'failed', lastError: 'unable to open database file' },
      detailReadModelBootstrap: { status: 'retrying', lastError: 'detail read model retry pending' },
      upstoxTokenRefresh: {
        exists: true,
        statusPath: './tmp/upstox/notifier/refresh-status.json',
        refresh: { state: 'request_failed', lastError: 'notifier timeout', message: 'Notifier timed out.' },
        token: { exists: false, expiresAt: null, isExpired: false },
      },
      sections: {
        summaryCards: { status: 'unavailable', error: 'open failed' },
        recentDecisions: { status: 'error', error: 'query failed' },
      },
    });

    expect(healthHtml).toContain('Degraded: open failed');
    expect(healthHtml).toContain('data-section-state="error"');
    expect(healthHtml).toContain('data-section-state="stale"');
    expect(healthHtml).toContain('unable to open database file');
    expect(healthHtml).toContain('detail read model retry pending');
    expect(healthHtml).toContain('Notifier timed out.');
    expect(healthHtml).toContain('Request Upstox Token Refresh');
  });

  it('renders explicit missing-evidence copy for absent decision LLM evidence and empty governance lineage', () => {
    const decisionsHtml = renderDecisionsPage(buildPayload({
      decisionPerformance: ok(sampleDecisionPerformance().map(decision => ({
        ...decision,
        llmStatus: null,
        llmRationale: null,
      }))),
    }));
    expect(decisionsHtml).toContain('No persisted hybrid LLM evidence exists in this bounded recent window, so the page keeps deterministic decision truth without speculative rationale.');
    expect(decisionsHtml).toContain('No decision in this recent window persisted hybrid LLM evidence.');

    const governanceHtml = renderGovernancePage(buildPayload({
      researchLineage: ok({
        totals: { generationAttempts: 0, hypotheses: 0, evaluations: 0, duplicateSkips: 0, publications: 0 },
        recent: [],
        status: { availability: 'empty', diagnostics: [], provenance: [{ sourceLabel: 'hypothesis_generation_attempts', detail: 'recent generation lineage rows' }] },
        provenance: testProvenance,
      }),
    }));
    expect(governanceHtml).toContain('No recent lineage rows are persisted, so the page keeps the missing-evidence state explicit instead of inferring governance context.');
    expect(governanceHtml).toContain('No recent research lineage rows are persisted, so governance keeps an explicit missing-evidence state.');
  });
});

describe('Dashboard page', () => {
  it('renders drill-down links, stable section hooks, and polling bootstrap metadata', () => {
    const html = renderDashboardPage(buildPayload(), { pollIntervalMs: 1_500 });
    expect(html).toContain('/strategy?strategyId=india-nse-eq-v1&strategyVersion=1.0.0');
    expect(html).toContain('/decision?id=7');
    expect(html).toContain('/backtest?runId=42');
    expect(html).toContain('WF#5');
    expect(html).toContain('Invested Capital');
    expect(html).toContain('Current Value');
    expect(html).toContain('Net P&amp;L');
    expect(html).toContain('Healthy');
    expect(html).toContain('Overview prioritizes persisted paper-ledger aggregates and refresh health');
    expect(html).toContain('Overview copy keeps invested capital and current value explicitly scoped to open paper positions.');
    expect(html).toContain('data-dashboard-section="summaryCards"');
    expect(html).toContain('id="dashboard-section-strategyPerformance"');
    expect(html).toContain('id="dashboard-bootstrap"');
    expect(html).toContain('"pollIntervalMs":1500');
    expect(html).toContain('window.setTimeout(pollOnce, pollIntervalMs);');
    expect(html).toContain(`replaceFragment('[data-shell-status-strip]', payload.shellStatusHtml);`);
    expect(html).toContain('<div class="page-kicker">Overview</div>');
    expect(html).toContain('Recent hybrid LLM status in this bounded decision window');
    expect(html).toContain('LLM Status');
    expect(html).toContain('degraded 1');
  });

  it('renders degraded and unavailable states with explicit state metadata', () => {
    const html = renderDashboardPage(buildPayload({ strategyPerformance: errorSection('Query failed'), promotionHistory: unavailableSection() }));
    expect(html).toContain('Query failed');
    expect(html).toContain('Database is not available.');
    expect(html).toContain('data-section-state="error"');
    expect(html).toContain('data-section-state="unavailable"');
    expect(html).toContain('No database snapshot available.');
  });

  it('uses host-scoped empty copy for lifecycle and governance evidence', () => {
    const html = renderDashboardPage(buildPayload({
      lifecycleStates: ok([]),
      governanceHistory: ok([]),
      promotionHistory: ok([]),
      walkForwardLeaderboard: ok([]),
    }));
    expect(html).toContain('No lifecycle state evidence has been produced on this host yet.');
    expect(html).toContain('No governance history has been produced on this host yet.');
    expect(html).toContain('No promotion history has been produced on this host yet.');
    expect(html).toContain('No walk-forward leaderboard entries are available yet.');
  });

  it('renders stale sections with preserved rows, last-known copy, and timestamps', () => {
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
    expect(html).toContain('Showing last known data from 2025-01-11 09:59:15.');
    expect(html).toContain('Last successful snapshot is 45s old.');
    expect(html).toContain('india-nse-eq-v1');
    expect(html).toContain('data-section-state="stale"');
    expect(html).toContain('data-is-cached-data="true"');
  });

  it('tolerates stale sections whose freshness metadata is missing', () => {
    const html = renderDashboardPage(buildPayload({
      tickerPerformance: {
        state: 'stale',
        data: sampleTickerPerformance(),
        errorMessage: 'Failed to refresh ticker performance: malformed rows',
        stalenessMs: null,
        lastFetchedAt: null,
        isCachedData: true,
      },
    }));
    expect(html).toContain('Refresh freshness is unknown.');
    expect(html).toContain('Showing last known data from the most recent successful refresh.');
    expect(html).toContain('RELIANCE');
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
    expect(html).toContain('Published Research Provenance');
    expect(html).toContain('abc123&lt;script&gt;');
    expect(html).toContain('Published after review &lt;b&gt;approved&lt;/b&gt;.');
    expect(html).toContain('No candidate cleared thresholds.');
    expect(html).toContain('No winner recorded');
    expect(html).toContain('Escaped &lt;b&gt;safe&lt;/b&gt;.');
  });

  it('distinguishes host-wide absence from strategy-local absence for empty sections', () => {
    const detail = sampleStrategyDetail();
    detail.currentStates = [];
    detail.governanceHistory = [];
    detail.promotionHistory = [];
    detail.walkForwardRuns = [];
    detail.publishedResearchProvenance = null;
    detail.hostEvidencePresence = {
      lifecycleStates: false,
      governanceHistory: true,
      promotionHistory: false,
      walkForwardRuns: true,
      researchPublications: true,
    };

    const html = renderStrategyDetailPage(detail);
    expect(html).toContain('No lifecycle evidence has been produced on this host yet.');
    expect(html).toContain('Governance evidence exists on this host, but none has been persisted for this strategy version.');
    expect(html).toContain('No promotion history has been produced on this host yet.');
    expect(html).toContain('Walk-forward evidence exists on this host, but no persisted run is linked to this strategy version.');
    expect(html).toContain('Research publication evidence exists on this host, but no published-research provenance is linked to this strategy version.');
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


it('renders research-lineage degradation states and bounded repository totals on governance pages', () => {
  const stalePayload = buildPayload({
    researchLineage: {
      state: 'stale',
      data: sampleResearchLineage(),
      errorMessage: 'Failed to refresh research lineage: timeout',
      stalenessMs: 45_000,
      lastFetchedAt: '2025-01-11T09:59:15.000Z',
      isCachedData: true,
    },
  });
  const staleHtml = renderGovernancePage(stalePayload);
  expect(staleHtml).toContain('Research Lineage');
  expect(staleHtml).toContain('Published Research Total');
  expect(staleHtml).toContain('Repository-backed totals lead this section so operators can inspect the truthful full lineage first');
  expect(staleHtml).toContain('Recent evidence window');
  expect(staleHtml).toContain('Recent evidence below is intentionally bounded to the newest 1 lineage row for operator readability.');
  expect(staleHtml).toContain('Failed to refresh research lineage: timeout');
  expect(staleHtml).toContain('Showing last known data from 2025-01-11 09:59:15.');
  expect(staleHtml).toContain('abc123');

  const unavailableHtml = renderGovernancePage(buildPayload({
    researchLineage: unavailableSection(),
  }));
  expect(unavailableHtml).toContain('No database snapshot available.');

  const emptyHtml = renderGovernancePage(buildPayload({
    researchLineage: ok({
      totals: { generationAttempts: 0, hypotheses: 0, evaluations: 0, duplicateSkips: 0, publications: 0 },
      recent: [],
      status: { availability: 'empty', diagnostics: [], provenance: [{ sourceLabel: 'hypothesis_generation_attempts', detail: 'recent generation lineage rows' }] },
      provenance: testProvenance,
    }),
  }));
  expect(emptyHtml).toContain('Recent evidence below is intentionally bounded to the newest 0 lineage rows for operator readability.');
  expect(emptyHtml).toContain('No persisted research lineage has been produced on this host yet.');
});
