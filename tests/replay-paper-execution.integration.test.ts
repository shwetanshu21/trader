import { describe, it, expect } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { runReplay } from '../src/replay/replay-runner.js';
import { FixtureHistoricalDataProvider } from '../src/replay/historical-data-provider.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';

const BASE_CANDIDATES = [{
  exchange: 'NSE',
  tradingsymbol: 'RELIANCE',
  instrumentToken: 738561,
  side: 'buy',
  lastPrice: 100,
  bid: 100,
  ask: 100,
  volume: 1000000,
  instrumentType: 'EQ',
  lotSize: 1,
  tickSize: 0.05,
  expiry: null,
  strike: null,
  freezeQuantity: null,
}];

describe('runReplay with paper execution', () => {
  it('persists replay-owned execution and position state', async () => {
    const dbm = new DatabaseManager(':memory:');
    const monday = new Date('2025-01-06T00:00:00Z');
    const mondayPlus = new Date('2025-01-06T09:35:00Z');

    const result = await runReplay({
      db: dbm.db,
      marketProfile: INDIA_NSE_EQ_MARKET,
      dataProvider: new FixtureHistoricalDataProvider({
        candidates: BASE_CANDIDATES,
        rangeStart: monday.getTime(),
        rangeEnd: mondayPlus.getTime(),
        priceDrift: 0.05,
      }),
      maxCandidates: 1,
      cadenceMinutes: 5,
      rangeStart: monday.getTime(),
      rangeEnd: mondayPlus.getTime(),
      enablePaperExecution: true,
    });

    expect(result.session.status).toBe('completed');

    const attempts = dbm.db.prepare('SELECT COUNT(*) AS cnt FROM execution_attempts').get() as { cnt: number };
    const fills = dbm.db.prepare('SELECT COUNT(*) AS cnt FROM paper_fills').get() as { cnt: number };
    const checkpoints = dbm.db.prepare('SELECT metadata_json FROM replay_checkpoints ORDER BY id DESC LIMIT 1').get() as { metadata_json: string };
    const meta = JSON.parse(checkpoints.metadata_json);

    expect(attempts.cnt).toBeGreaterThan(0);
    expect(fills.cnt).toBeGreaterThan(0);
    expect(meta.executionSnapshot).toBeTruthy();
    expect(typeof meta.executionSnapshot.executionAttempts).toBe('number');
  });
});
