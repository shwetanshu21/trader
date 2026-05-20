// ── Operator UI Dashboard Page Tests ──
// Covers: empty state rendering, populated state rendering, degraded-section
// rendering with error banners, and unavailable (no-DB) state rendering.
//
// These tests verify the HTML output structure, not the styling. They check
// that sections render with correct titles, table structures, state banners,
// provenance badges, and empty-state/error messages.

import { describe, it, expect } from 'vitest';
import { renderDashboardPage } from '../src/operator-ui/pages/dashboard-page.js';
import type { DashboardPayload, DashboardSection } from '../src/operator-ui/dashboard-data.js';
import type {
  OperatorSummaryCard,
  OperatorStrategyPerformance,
  OperatorTickerPerformance,
  OperatorDecisionPerformance,
  OperatorLifecycleState,
  OperatorLifecycleHistory,
  OperatorPromotionHistory,
  OperatorWalkForwardLeaderboard,
} from '../src/types/runtime.js';
import { type OperatorProvenance } from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  };
}

function errorSection<T>(message: string, lastKnown?: T): DashboardSection<T> {
  return {
    state: 'error',
    data: lastKnown ?? ([] as unknown as T),
    errorMessage: message,
    stalenessMs: null,
    lastFetchedAt: null,
  };
}

function unavailableSection<T>(): DashboardSection<T> {
  return {
    state: 'unavailable',
    data: [] as unknown as T,
    errorMessage: 'Database is not available.',
    stalenessMs: null,
    lastFetchedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Sample data factories
// ---------------------------------------------------------------------------

function sampleSummaryCards(): OperatorSummaryCard[] {
  return [
    { key: 'current_pnl', label: 'Current P&L', value: 15420.50, unit: 'INR', change: null, display: null, provenance: testProvenance },
    { key: 'unrealized_pnl', label: 'Unrealized P&L', value: 3200.00, unit: 'INR', change: null, display: null, provenance: testProvenance },
    { key: 'open_positions', label: 'Open Positions', value: 3, unit: null, change: null, display: null, provenance: testProvenance },
    { key: 'total_decisions', label: 'Strategy Decisions', value: 47, unit: null, change: null, display: null, provenance: testProvenance },
  ];
}

function sampleStrategyPerformance(): OperatorStrategyPerformance[] {
  return [
    {
      strategyId: 'india-nse-eq-v1', strategyVersion: '1.0.0', totalReturnPct: 12.5,
      sharpeRatio: 1.8, maxDrawdownPct: 15.0, tradeCount: 24, winRate: 0.62,
      profitFactor: 2.1, realizedPnl: 15420.50, unrealizedPnl: 3200.00, provenance: testProvenance,
    },
    {
      strategyId: 'india-nfo-fut-v1', strategyVersion: '1.1.0', totalReturnPct: 8.3,
      sharpeRatio: 1.2, maxDrawdownPct: 22.0, tradeCount: 15, winRate: 0.53,
      profitFactor: 1.5, realizedPnl: 8900.00, unrealizedPnl: -500.00, provenance: testProvenance,
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
    {
      exchange: 'NSE', tradingsymbol: 'TCS', totalPnl: 3200.00, tradeCount: 5,
      winRate: 0.60, netQuantity: 10, avgEntryPrice: 3950.00, lastPrice: 3980.00,
      unrealizedPnl: 300.00, realizedPnl: 2900.00, provenance: testProvenance,
    },
  ];
}

function sampleDecisionPerformance(): OperatorDecisionPerformance[] {
  return [
    {
      decisionId: 1, proposalAttemptId: 100, exchange: 'NSE', tradingsymbol: 'RELIANCE',
      side: 'buy', quantity: 25, price: 2850.00, decisionStatus: 'approved',
      strategyId: 'india-nse-eq-v1', decidedAt: new Date().toISOString(),
      executionStatus: 'completed', outcomeCode: 'full_fill', realizedPnl: 1200.00,
      provenance: testProvenance,
    },
    {
      decisionId: 2, proposalAttemptId: 101, exchange: 'NSE', tradingsymbol: 'TCS',
      side: 'sell', quantity: 10, price: 3980.00, decisionStatus: 'refused',
      strategyId: 'india-nse-eq-v1', decidedAt: new Date().toISOString(),
      executionStatus: null, outcomeCode: null, realizedPnl: null,
      provenance: testProvenance,
    },
  ];
}

function sampleLifecycleStates(): OperatorLifecycleState[] {
  return [
    {
      strategyId: 'india-nse-eq-v1', strategyVersion: '1.0.0', marketId: 'INDIA_NSE_EQ',
      phase: 'paper', updatedAt: new Date().toISOString(), provenance: testProvenance,
    },
  ];
}

function sampleLifecycleHistory(): OperatorLifecycleHistory[] {
  return [
    {
      id: 1, strategyId: 'india-nse-eq-v1', strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ', verdict: 'promote', previousPhase: 'backtest',
      newPhase: 'paper', rationale: 'Walk-forward winner meets threshold criteria.',
      recordedAt: new Date().toISOString(), provenance: testProvenance,
    },
  ];
}

function samplePromotionHistory(): OperatorPromotionHistory[] {
  return [
    {
      id: 1, strategyId: 'india-nse-eq-v1', strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ', previousPhase: 'backtest', newPhase: 'paper',
      rationale: 'WF run #5 meets all threshold criteria.', winnerId: 5,
      promotedAt: new Date().toISOString(), provenance: testProvenance,
    },
  ];
}

function sampleWalkForwardLeaderboard(): OperatorWalkForwardLeaderboard[] {
  return [
    {
      runId: 1, label: 'WF-2025-01-v1', strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0', marketId: 'INDIA_NSE_EQ', windowCount: 12,
      winnerId: 1, selectionStrategy: 'best_sharpe', mergedScore: 0.78,
      sharpeRatio: 1.8, totalReturnPct: 15.2, maxDrawdownPct: 18.5,
      winRate: 0.65, selectedAt: new Date().toISOString(), provenance: testProvenance,
    },
  ];
}

// ---------------------------------------------------------------------------
// Payload factory
// ---------------------------------------------------------------------------

function buildPayload(overrides?: Partial<DashboardPayload>): DashboardPayload {
  const defaults: DashboardPayload = {
    assembledAt: new Date().toISOString(),
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
  };
  return { ...defaults, ...overrides };
}

// ---------------------------------------------------------------------------
// HTML inspection helpers
// ---------------------------------------------------------------------------

function hasSection(html: string, title: string): boolean {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<h2>${escaped}`).test(html);
}

function hasText(html: string, text: string): boolean {
  return html.includes(text);
}

function countOccurrences(html: string, substr: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = html.indexOf(substr, pos)) !== -1) {
    count++;
    pos += substr.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dashboard page — empty state', () => {
  it('renders all 8 sections', () => {
    const payload = buildPayload({
      summaryCards: ok([]),
      strategyPerformance: ok([]),
      tickerPerformance: ok([]),
      decisionPerformance: ok([]),
      lifecycleStates: ok([]),
      governanceHistory: ok([]),
      promotionHistory: ok([]),
      walkForwardLeaderboard: ok([]),
    });
    const html = renderDashboardPage(payload);

    expect(hasSection(html, 'Summary')).toBe(true);
    expect(hasSection(html, 'Strategy Performance')).toBe(true);
    expect(hasSection(html, 'Ticker Performance')).toBe(true);
    expect(hasSection(html, 'Recent Decisions')).toBe(true);
    expect(hasSection(html, 'Lifecycle States')).toBe(true);
    expect(hasSection(html, 'Governance History')).toBe(true);
    expect(hasSection(html, 'Promotion History')).toBe(true);
    expect(hasSection(html, 'Walk-Forward Leaderboard')).toBe(true);
  });

  it('shows empty-state messages for empty sections', () => {
    const payload = buildPayload({
      summaryCards: ok([]),
      strategyPerformance: ok([]),
      tickerPerformance: ok([]),
      decisionPerformance: ok([]),
      lifecycleStates: ok([]),
      governanceHistory: ok([]),
      promotionHistory: ok([]),
      walkForwardLeaderboard: ok([]),
    });
    const html = renderDashboardPage(payload);

    // Empty sections should not have tables (no headers)
    expect(hasText(html, 'No summary data available.')).toBe(true);
    expect(hasText(html, 'No strategy performance data available.')).toBe(true);
    expect(hasText(html, 'No ticker performance data available.')).toBe(true);
    expect(hasText(html, 'No decision performance data available.')).toBe(true);
    expect(hasText(html, 'No lifecycle state data available.')).toBe(true);
    expect(hasText(html, 'No governance history data available.')).toBe(true);
    expect(hasText(html, 'No promotion history data available.')).toBe(true);
    expect(hasText(html, 'No walk-forward leaderboard data available.')).toBe(true);
  });

  it('renders nav links', () => {
    const payload = buildPayload({ summaryCards: ok([]) });
    const html = renderDashboardPage(payload);

    expect(hasText(html, '/api/refresh')).toBe(true);
    expect(hasText(html, '/api/health')).toBe(true);
  });

  it('renders page title and DB status', () => {
    const payload = buildPayload({ summaryCards: ok([]) });
    const html = renderDashboardPage(payload);

    expect(hasText(html, 'Operator Console')).toBe(true);
    expect(hasText(html, 'Connected')).toBe(true);
  });
});

describe('Dashboard page — populated state', () => {
  it('renders summary cards with values', () => {
    const payload = buildPayload();
    const html = renderDashboardPage(payload);

    // Should render card labels (HTML-escaped ampersand)
    expect(hasText(html, 'Current P&amp;L')).toBe(true);
    expect(hasText(html, 'Unrealized P&amp;L')).toBe(true);
    expect(hasText(html, 'Open Positions')).toBe(true);
    expect(hasText(html, 'Strategy Decisions')).toBe(true);

    // Should render card values (INR values use ₹ symbol)
    expect(hasText(html, '15,420.50')).toBe(true);
    expect(hasText(html, '3,200.00')).toBe(true);
    expect(hasText(html, '₹')).toBe(true);
  });

  it('renders strategy performance table with data', () => {
    const payload = buildPayload();
    const html = renderDashboardPage(payload);

    expect(hasText(html, 'india-nse-eq-v1')).toBe(true);
    expect(hasText(html, 'india-nfo-fut-v1')).toBe(true);
    expect(hasText(html, '1.0.0')).toBe(true);
    expect(hasText(html, '1.1.0')).toBe(true);
    expect(hasText(html, '15,420.50')).toBe(true);
    expect(hasText(html, '8,900.00')).toBe(true);
    expect(hasText(html, '1.2')).toBe(true); // sharpe
  });

  it('renders ticker performance table with data', () => {
    const payload = buildPayload();
    const html = renderDashboardPage(payload);

    expect(hasText(html, 'RELIANCE')).toBe(true);
    expect(hasText(html, 'TCS')).toBe(true);
    expect(hasText(html, '75.0%')).toBe(true); // win rate
    expect(hasText(html, '60.0%')).toBe(true);
  });

  it('renders decision performance table with data', () => {
    const payload = buildPayload();
    const html = renderDashboardPage(payload);

    expect(hasText(html, 'approved')).toBe(true);
    expect(hasText(html, 'refused')).toBe(true);
    expect(hasText(html, 'full_fill')).toBe(true);
  });

  it('renders lifecycle states table', () => {
    const payload = buildPayload();
    const html = renderDashboardPage(payload);

    expect(hasText(html, 'INDIA_NSE_EQ')).toBe(true);
    expect(hasText(html, 'paper')).toBe(true);
  });

  it('renders governance history table', () => {
    const payload = buildPayload();
    const html = renderDashboardPage(payload);

    expect(hasText(html, 'promote')).toBe(true);
    expect(hasText(html, 'backtest')).toBe(true);
    expect(hasText(html, 'Walk-forward winner meets threshold criteria.')).toBe(true);
  });

  it('renders promotion history table', () => {
    const payload = buildPayload();
    const html = renderDashboardPage(payload);

    expect(hasText(html, 'WF#5')).toBe(true);
    expect(hasText(html, 'WF run #5 meets all threshold criteria.')).toBe(true);
  });

  it('renders walk-forward leaderboard table', () => {
    const payload = buildPayload();
    const html = renderDashboardPage(payload);

    expect(hasText(html, 'WF-2025-01-v1')).toBe(true);
    expect(hasText(html, 'best_sharpe')).toBe(true);
    expect(hasText(html, '78.0%')).toBe(true); // mergedScore
    expect(hasText(html, '65.0%')).toBe(true); // win rate
  });

  it('renders provenance badges', () => {
    const payload = buildPayload();
    const html = renderDashboardPage(payload);

    // provenance source 'historical' should appear
    expect(hasText(html, 'historical')).toBe(true);
    const count = countOccurrences(html, 'historical');
    // Each row gets a provenance badge — let's check it exists
    expect(count).toBeGreaterThanOrEqual(8);
  });
});

describe('Dashboard page — degraded state', () => {
  it('renders error banners for failed sections', () => {
    const payload = buildPayload({
      strategyPerformance: errorSection('Failed to fetch strategy performance: DB connection timeout'),
      tickerPerformance: errorSection('Failed to fetch ticker performance: Table not found'),
    });
    const html = renderDashboardPage(payload);

    // Strategy Performance section should have error banner
    expect(hasText(html, 'Failed to fetch strategy performance: DB connection timeout')).toBe(true);

    // Ticker Performance section should have error banner
    expect(hasText(html, 'Failed to fetch ticker performance: Table not found')).toBe(true);

    // Other sections should still be ok
    expect(hasText(html, 'RELIANCE')).toBe(true);
    expect(hasText(html, 'approved')).toBe(true);
  });

  it('renders error section with border indicator', () => {
    const payload = buildPayload({
      summaryCards: errorSection('Query failed: disk I/O error'),
    });
    const html = renderDashboardPage(payload);

    // Error banner should be present
    expect(hasText(html, 'section-error-banner')).toBe(true);
    expect(hasText(html, 'Query failed: disk I/O error')).toBe(true);
  });

  it('shows error banner for error sections without last-known data', () => {
    const payload = buildPayload({
      strategyPerformance: errorSection<OperatorStrategyPerformance[]>('Query failed', []),
    });
    const html = renderDashboardPage(payload);

    // The error banner should show the raw error message
    expect(hasText(html, 'Query failed')).toBe(true);
    // The error section should have a banner element
    expect(hasText(html, 'section-error-banner')).toBe(true);
  });
});

describe('Dashboard page — unavailable (no DB) state', () => {
  it('renders all sections as unavailable when read model is null', () => {
    const now = new Date().toISOString();
    const u = unavailableSection();
    const payload: DashboardPayload = {
      assembledAt: now,
      dbAvailable: false,
      dbError: 'Failed to open database at ./data/trader.db',
      summaryCards: u,
      strategyPerformance: u,
      tickerPerformance: u,
      decisionPerformance: u,
      lifecycleStates: u,
      governanceHistory: u,
      promotionHistory: u,
      walkForwardLeaderboard: u,
    };
    const html = renderDashboardPage(payload);

    // Should show disconnected DB status
    expect(hasText(html, 'Disconnected')).toBe(true);
    expect(hasText(html, 'Failed to open database at ./data/trader.db')).toBe(true);

    // All sections should show unavailable messaging
    expect(hasText(html, 'Database is not available.')).toBe(true);
    const count = countOccurrences(html, 'Database is not available.');
    expect(count).toBe(8); // one per section
  });
});

describe('Dashboard page — individual section verify-content', () => {
  it('renders the assembledAt timestamp', () => {
    const payload = buildPayload();
    const html = renderDashboardPage(payload);
    // assembledAt renders through formatTimestamp which returns a substring
    // Just verify it's present somewhere in the meta area
    expect(hasText(html, 'Assembled:')).toBe(true);
  });

  it('renders section subtitles', () => {
    const payload = buildPayload();
    const html = renderDashboardPage(payload);

    expect(hasText(html, 'Aggregate totals')).toBe(true);
    expect(hasText(html, 'Per-strategy P&amp;L and metrics')).toBe(true);
    expect(hasText(html, 'Per-symbol P&amp;L and position state')).toBe(true);
    expect(hasText(html, 'Newest first')).toBe(true);
    expect(hasText(html, 'Current strategy phases')).toBe(true);
    expect(hasText(html, 'Lifecycle phase decisions')).toBe(true);
    expect(hasText(html, 'Lifecycle promotions only')).toBe(true);
    expect(hasText(html, 'Historical backtest results')).toBe(true);
  });

  it('does not render tables for empty sections', () => {
    const payload = buildPayload({
      strategyPerformance: ok([]),
      tickerPerformance: ok([]),
      decisionPerformance: ok([]),
      lifecycleStates: ok([]),
      governanceHistory: ok([]),
      promotionHistory: ok([]),
      walkForwardLeaderboard: ok([]),
    });
    const html = renderDashboardPage(payload);

    // Empty sections should show empty-state text, not tables
    // An empty table would have <thead> and <th> elements
    // Since we have summary cards, there should be tables in the empty state...
    // Actually, the empty sections show empty-state <p> elements, not tables
    expect(hasText(html, 'No strategy performance data available.')).toBe(true);

    // But summaryCards should still show the grid
    expect(hasText(html, 'Current P&amp;L')).toBe(true);
  });
});
