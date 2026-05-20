import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createOperatorUIServer } from '../src/operator-ui/server.js';
import { OperatorDetailReadModelError } from '../src/operator/operator-detail-read-model.js';
import type { OperatorUIConfig } from '../src/operator-ui/config.js';

const baseConfig: OperatorUIConfig = {
  host: '127.0.0.1',
  port: 3100,
  dbPath: ':memory:',
  username: 'operator',
  password: 'secret',
  pollIntervalMs: 1000,
  lockoutThreshold: 5,
  lockoutDurationMs: 60_000,
  rateLimitMax: 100,
  rateLimitWindowMs: 60_000,
};

const authOk = {
  extractClientIp: () => '127.0.0.1',
  authenticate: () => ({ ok: true, status: 200, message: 'Authenticated.', clientIp: '127.0.0.1' }),
  getStateSummary: () => [],
};

const authMissing = {
  extractClientIp: () => '127.0.0.1',
  authenticate: () => ({ ok: false, status: 401, message: 'Missing Authorization header.', clientIp: '127.0.0.1' }),
  getStateSummary: () => [],
};

const decisionDetail = {
  decisionId: 7,
  proposalAttemptId: 100,
  decisionStatus: 'approved',
  strategyId: 'alpha',
  strategyVersion: '1.0.0',
  decidedAt: '2025-01-10T10:20:30.000Z',
  reasons: [],
  indiaResearchEvidence: null,
  trade: { exchange: 'NSE', tradingsymbol: 'RELIANCE', side: 'buy', product: 'MIS', quantity: 25, price: 2850, triggerPrice: null, orderType: 'LIMIT' },
  quote: { lastPrice: null, bid: null, ask: null, volume: null, receivedAt: null },
  risk: { notional: null, sizingBasis: 'last_price', maxLossRupees: null, stopDistance: null, stopPrice: null, trailingStopDistance: null, riskBudgetRupees: null, exposureTag: null },
  instrument: { executionClass: 'EQ', segment: 'NSE', instrumentType: 'EQ', expiry: null, strike: null, lotSize: 1, tickSize: 0.05, freezeQuantity: null },
  hybrid: null,
  executionAttempt: null,
  realizedPnl: null,
  diagnostics: [],
  provenance: { source: 'historical', asOf: Date.now(), sourceLabel: 'test' },
};

const strategyDetail = {
  strategyId: 'alpha',
  strategyVersion: '1.0.0',
  performance: { totalReturnPct: 12.5, sharpeRatio: 1.2, maxDrawdownPct: 10, tradeCount: 2, winRate: 0.5, profitFactor: 1.2, realizedPnl: 100, unrealizedPnl: 0 },
  recentDecisions: [],
  currentStates: [],
  governanceHistory: [],
  promotionHistory: [],
  walkForwardRuns: [],
  diagnostics: [],
  provenance: { source: 'historical', asOf: Date.now(), sourceLabel: 'test' },
};

const backtestDetail = {
  runId: 42,
  label: 'WF-42',
  strategyId: 'alpha',
  strategyVersion: '1.0.0',
  marketId: 'INDIA_NSE_EQ',
  status: 'completed',
  windowCount: 4,
  totalTrials: 8,
  createdAt: '2025-01-10T10:00:00.000Z',
  startedAt: '2025-01-10T10:01:00.000Z',
  completedAt: '2025-01-10T10:05:00.000Z',
  winnerId: 4,
  result: 'selected',
  selectedTrialId: 9,
  selectionStrategy: 'best_sharpe',
  selectionConfig: null,
  rationale: 'Selected winner.',
  artifactPaths: null,
  selectedAt: '2025-01-10T10:05:00.000Z',
  selectedTrial: null,
  rankedCandidates: [],
  diagnostics: [],
  provenance: { source: 'historical', asOf: Date.now(), sourceLabel: 'test' },
};

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return `http://127.0.0.1:${address.port}`;
}

describe('operator-ui server detail routes', () => {
  it('preserves dashboard auth behavior on detail routes', async () => {
    const server = createOperatorUIServer({
      config: baseConfig,
      authenticator: authMissing as any,
      db: null,
      dbError: 'db unavailable',
      readModel: null,
      detailReadModel: null,
    });
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/decision?id=7`);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Basic realm="Operator Console"');
  });

  it('renders decision, strategy, and backtest detail pages for valid authenticated requests', async () => {
    const server = createOperatorUIServer({
      config: baseConfig,
      authenticator: authOk as any,
      db: null,
      dbError: null,
      readModel: null,
      detailReadModel: {
        getDecisionDetail: () => decisionDetail,
        getStrategyDetail: () => strategyDetail,
        getBacktestDetail: () => backtestDetail,
      } as any,
    });
    const baseUrl = await listen(server);

    const decisionResponse = await fetch(`${baseUrl}/decision?id=7`, { headers: { Authorization: 'Basic ok' } });
    expect(decisionResponse.status).toBe(200);
    expect(await decisionResponse.text()).toContain('Decision #7');

    const strategyResponse = await fetch(`${baseUrl}/strategy?strategyId=alpha&strategyVersion=1.0.0`, { headers: { Authorization: 'Basic ok' } });
    expect(strategyResponse.status).toBe(200);
    expect(await strategyResponse.text()).toContain('Operator Strategy Detail');

    const backtestResponse = await fetch(`${baseUrl}/backtest?runId=42`, { headers: { Authorization: 'Basic ok' } });
    expect(backtestResponse.status).toBe(200);
    expect(await backtestResponse.text()).toContain('Operator Backtest Detail');
  });

  it('maps malformed params to 400 without touching the read model', async () => {
    const server = createOperatorUIServer({
      config: baseConfig,
      authenticator: authOk as any,
      db: null,
      dbError: null,
      readModel: null,
      detailReadModel: {
        getDecisionDetail: () => { throw new Error('should not be called'); },
        getStrategyDetail: () => { throw new Error('should not be called'); },
        getBacktestDetail: () => { throw new Error('should not be called'); },
      } as any,
    });
    const baseUrl = await listen(server);

    expect((await fetch(`${baseUrl}/decision`, { headers: { Authorization: 'Basic ok' } })).status).toBe(400);
    expect((await fetch(`${baseUrl}/backtest?runId=abc`, { headers: { Authorization: 'Basic ok' } })).status).toBe(400);
    expect((await fetch(`${baseUrl}/strategy?strategyId=&strategyVersion=1.0.0`, { headers: { Authorization: 'Basic ok' } })).status).toBe(400);
    expect((await fetch(`${baseUrl}/strategy?strategyId=alpha`, { headers: { Authorization: 'Basic ok' } })).status).toBe(400);
  });

  it('maps missing detail rows to 404', async () => {
    const server = createOperatorUIServer({
      config: baseConfig,
      authenticator: authOk as any,
      db: null,
      dbError: null,
      readModel: null,
      detailReadModel: {
        getDecisionDetail: () => null,
        getStrategyDetail: () => null,
        getBacktestDetail: () => null,
      } as any,
    });
    const baseUrl = await listen(server);

    expect((await fetch(`${baseUrl}/decision?id=9`, { headers: { Authorization: 'Basic ok' } })).status).toBe(404);
    expect((await fetch(`${baseUrl}/strategy?strategyId=alpha&strategyVersion=9.9.9`, { headers: { Authorization: 'Basic ok' } })).status).toBe(404);
    expect((await fetch(`${baseUrl}/backtest?runId=999`, { headers: { Authorization: 'Basic ok' } })).status).toBe(404);
  });

  it('maps db-unavailable and read-model failures to truthful 503 HTML', async () => {
    const unavailableServer = createOperatorUIServer({
      config: baseConfig,
      authenticator: authOk as any,
      db: null,
      dbError: 'open failed',
      readModel: null,
      detailReadModel: null,
    });
    const unavailableBaseUrl = await listen(unavailableServer);
    const unavailableResponse = await fetch(`${unavailableBaseUrl}/decision?id=7`, { headers: { Authorization: 'Basic ok' } });
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.text()).toContain('Decision Detail Unavailable');

    const failingServer = createOperatorUIServer({
      config: baseConfig,
      authenticator: authOk as any,
      db: null,
      dbError: null,
      readModel: null,
      detailReadModel: {
        getDecisionDetail: () => { throw new OperatorDetailReadModelError('decision', 'compose failed'); },
        getStrategyDetail: () => { throw new OperatorDetailReadModelError('strategy', 'compose failed'); },
        getBacktestDetail: () => { throw new OperatorDetailReadModelError('backtest', 'compose failed'); },
      } as any,
    });
    const failingBaseUrl = await listen(failingServer);
    const failingResponse = await fetch(`${failingBaseUrl}/backtest?runId=42`, { headers: { Authorization: 'Basic ok' } });
    expect(failingResponse.status).toBe(503);
    const html = await failingResponse.text();
    expect(html).toContain('Backtest Detail Unavailable');
    expect(html).toContain('temporarily unavailable');
    expect(html).not.toContain('compose failed');
  });
});
