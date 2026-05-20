import { describe, expect, it } from 'vitest';
import { DashboardPayloadAssembler } from '../src/operator-ui/dashboard-data.js';

function createReadModel(options?: {
  summaryCards?: () => unknown;
  strategyPerformance?: () => unknown;
  tickerPerformance?: () => unknown;
  decisionPerformance?: () => unknown;
  lifecycleStates?: () => unknown;
  governanceHistory?: () => unknown;
  promotionHistory?: () => unknown;
  walkForwardLeaderboard?: () => unknown;
}) {
  return {
    getSummaryCards: () => options?.summaryCards ? options.summaryCards() : [{ key: 'current_pnl', label: 'Current P&L', value: 1234, unit: 'INR', change: null, display: null, provenance: null }],
    getStrategyPerformance: () => options?.strategyPerformance ? options.strategyPerformance() : [{ strategyId: 'alpha', strategyVersion: '1.0.0', totalReturnPct: 12.5, sharpeRatio: 1.4, maxDrawdownPct: 9.2, tradeCount: 8, winRate: 0.5, profitFactor: 1.8, realizedPnl: 500, unrealizedPnl: 0, provenance: null }],
    getTickerPerformance: () => options?.tickerPerformance ? options.tickerPerformance() : [{ exchange: 'NSE', tradingsymbol: 'RELIANCE', totalPnl: 200, tradeCount: 2, winRate: 0.5, netQuantity: 1, avgEntryPrice: 100, lastPrice: 101, unrealizedPnl: 1, realizedPnl: 199, provenance: null }],
    getDecisionPerformance: () => options?.decisionPerformance ? options.decisionPerformance() : [{ decisionId: 1, proposalAttemptId: 10, exchange: 'NSE', tradingsymbol: 'RELIANCE', side: 'buy', quantity: 1, price: 100, decisionStatus: 'approved', strategyId: 'alpha', decidedAt: '2025-01-10T10:00:00.000Z', executionStatus: 'completed', outcomeCode: 'paper_simulated', realizedPnl: 10, provenance: null }],
    getLifecycleStates: () => options?.lifecycleStates ? options.lifecycleStates() : [{ strategyId: 'alpha', strategyVersion: '1.0.0', marketId: 'INDIA_NSE_EQ', phase: 'paper', updatedAt: '2025-01-10T10:00:00.000Z', provenance: null }],
    getLifecycleHistory: () => options?.governanceHistory ? options.governanceHistory() : [{ id: 1, strategyId: 'alpha', strategyVersion: '1.0.0', marketId: 'INDIA_NSE_EQ', verdict: 'promote', previousPhase: 'backtest', newPhase: 'paper', rationale: 'Passed gates.', recordedAt: '2025-01-10T10:00:00.000Z', provenance: null }],
    getPromotionHistory: () => options?.promotionHistory ? options.promotionHistory() : [{ id: 1, strategyId: 'alpha', strategyVersion: '1.0.0', marketId: 'INDIA_NSE_EQ', previousPhase: 'backtest', newPhase: 'paper', rationale: 'Promoted.', winnerId: 3, promotedAt: '2025-01-10T10:00:00.000Z', provenance: null }],
    getWalkForwardLeaderboard: () => options?.walkForwardLeaderboard ? options.walkForwardLeaderboard() : [{ runId: 99, label: 'WF-99', strategyId: 'alpha', strategyVersion: '1.0.0', marketId: 'INDIA_NSE_EQ', windowCount: 4, winnerId: 3, selectionStrategy: 'best_sharpe', mergedScore: 0.7, sharpeRatio: 1.5, totalReturnPct: 11.2, maxDrawdownPct: 5.5, winRate: 0.6, selectedAt: '2025-01-10T10:00:00.000Z', provenance: null }],
  };
}

describe('DashboardPayloadAssembler', () => {
  it('returns ok sections with freshness metadata on initial success', () => {
    const assembler = new DashboardPayloadAssembler();
    const payload = assembler.fetchDashboardPayload(createReadModel() as any, null, 1_000);

    expect(payload.dbAvailable).toBe(true);
    expect(payload.summaryCards.state).toBe('ok');
    expect(payload.summaryCards.data).toHaveLength(1);
    expect(payload.summaryCards.lastFetchedAt).toBe('1970-01-01T00:00:01.000Z');
    expect(payload.summaryCards.stalenessMs).toBe(0);
    expect(payload.summaryCards.isCachedData).toBe(false);
    expect(payload.summaryCards.errorMessage).toBeNull();
  });

  it('preserves last-known rows as stale when a later section refresh fails', () => {
    const assembler = new DashboardPayloadAssembler();
    let failStrategy = false;
    const readModel = createReadModel({
      strategyPerformance: () => {
        if (failStrategy) {
          throw new Error('token=shh timeout');
        }
        return [{ strategyId: 'alpha', strategyVersion: '1.0.0', totalReturnPct: 12.5, sharpeRatio: 1.4, maxDrawdownPct: 9.2, tradeCount: 8, winRate: 0.5, profitFactor: 1.8, realizedPnl: 500, unrealizedPnl: 0, provenance: null }];
      },
    });

    const first = assembler.fetchDashboardPayload(readModel as any, null, 10_000);
    failStrategy = true;
    const second = assembler.fetchDashboardPayload(readModel as any, null, 15_000);

    expect(first.strategyPerformance.state).toBe('ok');
    expect(second.strategyPerformance.state).toBe('stale');
    expect(second.strategyPerformance.data).toEqual(first.strategyPerformance.data);
    expect(second.strategyPerformance.lastFetchedAt).toBe(first.strategyPerformance.lastFetchedAt);
    expect(second.strategyPerformance.stalenessMs).toBe(5_000);
    expect(second.strategyPerformance.isCachedData).toBe(true);
    expect(second.strategyPerformance.errorMessage).toContain('Failed to refresh strategy performance');
    expect(second.strategyPerformance.errorMessage).toContain('token=[redacted]');
    expect(second.summaryCards.state).toBe('ok');
  });

  it('returns error when the first read fails and no cache exists', () => {
    const assembler = new DashboardPayloadAssembler();
    const payload = assembler.fetchDashboardPayload(createReadModel({
      summaryCards: () => {
        throw new Error('db busy');
      },
    }) as any, null, 5_000);

    expect(payload.summaryCards.state).toBe('error');
    expect(payload.summaryCards.data).toEqual([]);
    expect(payload.summaryCards.lastFetchedAt).toBeNull();
    expect(payload.summaryCards.stalenessMs).toBeNull();
    expect(payload.summaryCards.isCachedData).toBe(false);
    expect(payload.summaryCards.errorMessage).toContain('Failed to refresh summary cards');
  });

  it('treats malformed section results as errors instead of fabricating stale data', () => {
    const assembler = new DashboardPayloadAssembler();
    const payload = assembler.fetchDashboardPayload(createReadModel({
      summaryCards: () => null,
    }) as any, null, 5_000);

    expect(payload.summaryCards.state).toBe('error');
    expect(payload.summaryCards.data).toEqual([]);
    expect(payload.summaryCards.errorMessage).toContain('malformed rows');
  });

  it('returns unavailable sections for DB-open/read-model absence without using cache', () => {
    const assembler = new DashboardPayloadAssembler();
    assembler.fetchDashboardPayload(createReadModel() as any, null, 5_000);

    const payload = assembler.fetchDashboardPayload(null, 'open failed', 9_000);

    expect(payload.dbAvailable).toBe(false);
    expect(payload.dbError).toBe('open failed');
    expect(payload.summaryCards.state).toBe('unavailable');
    expect(payload.summaryCards.data).toEqual([]);
    expect(payload.summaryCards.lastFetchedAt).toBeNull();
    expect(payload.summaryCards.stalenessMs).toBeNull();
    expect(payload.summaryCards.isCachedData).toBe(false);
    expect(payload.summaryCards.errorMessage).toBe('open failed');
  });
});
