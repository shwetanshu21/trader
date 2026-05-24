import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpstoxTokenRefreshCoordinator } from '../src/upstox/token-refresh-coordinator.js';
import { readUpstoxTokenRefreshStatus } from '../src/upstox/token-refresh-status.js';

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-upstox-refresh-'));
  tempDirs.push(dir);
  return {
    dir,
    env: {
      TRADER_UPSTOX_TOKEN_PATH: path.join(dir, 'latest-token.json'),
      TRADER_UPSTOX_TOKEN_REFRESH_STATUS_PATH: path.join(dir, 'refresh-status.json'),
      UPSTOX_CLIENT_ID: 'client-123',
      UPSTOX_CLIENT_SECRET: 'secret-123',
      UPSTOX_NOTIFIER_URL: 'https://example.com/upstox/notifier',
    } as Record<string, string>,
  };
}

function writeToken(env: Record<string, string>, overrides: Record<string, unknown> = {}): void {
  fs.writeFileSync(env.TRADER_UPSTOX_TOKEN_PATH, JSON.stringify({
    client_id: 'client-123',
    user_id: 'user-456',
    access_token: 'token-abc-123',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    issued_at: new Date().toISOString(),
    message_type: 'access_token',
    persisted_at: Date.now(),
    ...overrides,
  }, null, 2));
}

beforeEach(() => {
  globalThis.fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ status: 'success' }), { status: 200 })) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('UpstoxTokenRefreshCoordinator', () => {
  it('suppresses duplicate requests while awaiting approval inside the cooldown window', async () => {
    const { env } = makeEnv();
    const coordinator = new UpstoxTokenRefreshCoordinator({ env, requestCooldownMs: 60 * 60 * 1000 });

    const first = await coordinator.triggerRequest('operator-ui', new Date('2025-01-01T00:00:00.000Z'));
    expect(first.action).toBe('request-sent');

    const second = await coordinator.triggerRequest('operator-ui', new Date('2025-01-01T00:30:00.000Z'));
    expect(second.action).toBe('suppressed');
    expect(second.status.message).toContain('already pending approval');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('requests again after the cooldown when the token is still expired or missing', async () => {
    const { env } = makeEnv();
    const coordinator = new UpstoxTokenRefreshCoordinator({ env, requestCooldownMs: 60 * 60 * 1000 });

    const first = await coordinator.triggerRequest('auto-recovery', new Date('2025-01-01T00:00:00.000Z'));
    expect(first.action).toBe('request-sent');

    const second = await coordinator.runRecoveryCheck(new Date('2025-01-01T01:05:00.000Z'));
    expect(second.action).toBe('request-sent');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('marks status refreshed when a newer valid token is observed after a request', async () => {
    const { env } = makeEnv();
    const coordinator = new UpstoxTokenRefreshCoordinator({ env, requestCooldownMs: 60 * 60 * 1000 });

    const initial = await coordinator.triggerRequest('operator-ui', new Date('2025-01-01T00:00:00.000Z'));
    expect(initial.action).toBe('request-sent');

    writeToken(env, {
      issued_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      persisted_at: Date.now() + 10 * 60_000,
    });

    const observed = coordinator.observeTokenRefresh(new Date());
    expect(observed.action).toBe('refreshed');
    expect(observed.status.state).toBe('refreshed');
    expect(observed.status.message).toContain('newer Upstox token was observed');
  });

  it('does nothing when a fresh token already exists', async () => {
    const { env } = makeEnv();
    writeToken(env);
    const coordinator = new UpstoxTokenRefreshCoordinator({ env, requestCooldownMs: 60 * 60 * 1000 });

    const result = await coordinator.runRecoveryCheck(new Date('2025-01-01T00:00:00.000Z'));
    expect(result.action).toBe('refreshed');
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const persisted = readUpstoxTokenRefreshStatus(env);
    expect(persisted.state).toBe('refreshed');
  });
});
