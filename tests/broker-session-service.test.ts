import { describe, expect, it } from 'vitest';

import { DatabaseManager } from '../src/persistence/sqlite.js';
import { BrokerRepository } from '../src/persistence/broker-repo.js';
import { SessionService } from '../src/integrations/broker/session-service.js';
import { BrokerSessionState, type BrokerConfig } from '../src/types/runtime.js';

function createService(config?: Partial<BrokerConfig>) {
  const manager = new DatabaseManager(':memory:');
  const repo = new BrokerRepository(manager.db);
  const service = new SessionService({
    transport: 'mcp',
    mcpUrl: 'http://localhost:8787/mcp',
    sessionRefreshIntervalMs: 21_600_000,
    ...config,
  }, repo);

  return { manager, repo, service };
}

describe('Broker SessionService', () => {
  it('marks an authenticated-but-expired session as expired in health snapshots', () => {
    const { repo, service } = createService();
    const expiredAt = Date.now() - 60_000;

    repo.upsertSession({
      accessToken: 'expired-token',
      obtainedAt: expiredAt - 3_600_000,
      expiresAt: expiredAt,
      state: BrokerSessionState.Authenticated,
      reason: 'Persisted from an earlier successful probe',
      lastError: null,
    });

    const health = service.getSessionHealth();
    const persisted = service.getSession();

    expect(health.state).toBe(BrokerSessionState.Expired);
    expect(health.reason).toContain('Broker session expired at');
    expect(persisted.state).toBe(BrokerSessionState.Expired);
    expect(persisted.accessToken).toBe('expired-token');
  });

  it('keeps a fresh authenticated session healthy', () => {
    const { service } = createService();

    service.applySessionMaterial({
      accessToken: 'fresh-token',
      expiresAt: Date.now() + 60_000,
      reason: 'Fresh session probe',
    });

    const health = service.getSessionHealth();

    expect(health.state).toBe(BrokerSessionState.Authenticated);
    expect(health.reason).toBe('Fresh session probe');
  });
});
