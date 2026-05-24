import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getBridgeAuthSummaryCard } from '../src/operator-ui/bridge-auth-status.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-auth-status-'));
  tempDirs.push(dir);
  return {
    dir,
    env: {
      TRADER_UPSTOX_TOKEN_PATH: path.join(dir, 'latest-token.json'),
      TRADER_UPSTOX_MCP_LOCAL_STATUS_PATH: path.join(dir, 'status.json'),
    } as Record<string, string>,
  };
}

describe('getBridgeAuthSummaryCard', () => {
  it('reports approval needed when no token exists', () => {
    const { env } = makeEnv();
    const card = getBridgeAuthSummaryCard(env);
    expect(card.label).toBe('Upstox Auth');
    expect(card.display).toBe('Approval needed');
  });

  it('reports token expired from persisted bridge status', () => {
    const { env } = makeEnv();
    fs.writeFileSync(env.TRADER_UPSTOX_TOKEN_PATH, JSON.stringify({
      access_token: 'abcd1234token',
      expires_at: Date.now() + 60_000,
      message_type: 'access_token',
    }));
    fs.writeFileSync(env.TRADER_UPSTOX_MCP_LOCAL_STATUS_PATH, JSON.stringify({
      token: { exists: true, isExpired: true, checkedAt: new Date().toISOString() },
      lastFailure: { at: new Date().toISOString(), error: 'expired token' },
    }));

    const card = getBridgeAuthSummaryCard(env);
    expect(card.display).toBe('Token expired');
  });

  it('reports refresh pending when a request is awaiting approval', () => {
    const { env, dir } = makeEnv();
    fs.writeFileSync(env.TRADER_UPSTOX_MCP_LOCAL_STATUS_PATH, JSON.stringify({
      token: { exists: false, isExpired: false, checkedAt: new Date().toISOString() },
    }));
    fs.writeFileSync(path.join(dir, 'refresh-status.json'), JSON.stringify({
      state: 'awaiting_approval',
      checkedAt: new Date().toISOString(),
      message: 'Awaiting approval.',
    }));
    env.TRADER_UPSTOX_TOKEN_REFRESH_STATUS_PATH = path.join(dir, 'refresh-status.json');

    const card = getBridgeAuthSummaryCard(env);
    expect(card.display).toBe('Refresh pending');
  });

  it('reports refresh failed when the latest refresh request failed', () => {
    const { env, dir } = makeEnv();
    fs.writeFileSync(path.join(dir, 'refresh-status.json'), JSON.stringify({
      state: 'request_failed',
      checkedAt: new Date().toISOString(),
      lastError: 'bad request',
    }));
    env.TRADER_UPSTOX_TOKEN_REFRESH_STATUS_PATH = path.join(dir, 'refresh-status.json');

    const card = getBridgeAuthSummaryCard(env);
    expect(card.display).toBe('Refresh failed');
  });
  it('reports healthy when bridge has a newer quote success than failure, even if the older failure mentioned expiry', () => {
    const { env } = makeEnv();
    fs.writeFileSync(env.TRADER_UPSTOX_TOKEN_PATH, JSON.stringify({
      access_token: 'abcd1234token',
      expires_at: Date.now() + 60_000,
      issued_at: Date.now(),
      message_type: 'access_token',
    }));
    fs.writeFileSync(env.TRADER_UPSTOX_MCP_LOCAL_STATUS_PATH, JSON.stringify({
      token: { exists: true, isExpired: false, checkedAt: new Date().toISOString() },
      lastFailure: { at: '2025-01-01T00:00:00.000Z', error: 'expired token' },
      lastSuccess: { at: '2025-01-01T00:01:00.000Z', error: null },
    }));

    const card = getBridgeAuthSummaryCard(env);
    expect(card.display).toBe('Healthy');
  });
});
