import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { UpstoxTokenStoreError, getUpstoxTokenHealth, readUpstoxTokenRecord } from '../src/upstox/token-store.js';

const tempDirs: string[] = [];

function makeTempFile(payload: unknown): { env: Record<string, string>; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-upstox-token-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'token.json');
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return {
    env: { TRADER_UPSTOX_TOKEN_PATH: filePath },
    filePath,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('upstox token store', () => {
  it('reads a valid token file', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { env, filePath } = makeTempFile({
      client_id: 'client-123',
      user_id: 'user-456',
      access_token: 'abcd1234efgh5678',
      expires_at: future,
      issued_at: new Date().toISOString(),
      message_type: 'token',
      persisted_at: Date.now(),
    });

    const record = readUpstoxTokenRecord(env);
    expect(record.absolutePath).toBe(filePath);
    expect(record.accessToken).toBe('abcd1234efgh5678');
    expect(record.isExpired).toBe(false);
    expect(record.expiresAt).not.toBeNull();
  });

  it('throws when token file is missing', () => {
    expect(() => readUpstoxTokenRecord({ TRADER_UPSTOX_TOKEN_PATH: '/definitely/missing/token.json' }))
      .toThrowError(UpstoxTokenStoreError);
  });

  it('throws when JSON is invalid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-upstox-token-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'token.json');
    fs.writeFileSync(filePath, '{invalid json');

    expect(() => readUpstoxTokenRecord({ TRADER_UPSTOX_TOKEN_PATH: filePath }))
      .toThrowError(UpstoxTokenStoreError);
  });

  it('throws when access token is missing', () => {
    const { env } = makeTempFile({ client_id: 'abc' });
    expect(() => readUpstoxTokenRecord(env)).toThrowError(UpstoxTokenStoreError);
  });

  it('throws when token is expired', () => {
    const { env } = makeTempFile({
      access_token: 'expired-token',
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });

    expect(() => readUpstoxTokenRecord(env)).toThrowError(UpstoxTokenStoreError);
  });

  it('returns health metadata without exposing the raw token', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { env } = makeTempFile({
      client_id: 'client-123',
      user_id: 'user-456',
      access_token: 'abcd1234efgh5678',
      expires_at: future,
      token_type: 'Bearer',
    });

    const health = getUpstoxTokenHealth(env);
    expect(health.exists).toBe(true);
    expect(health.clientId).toBe('client-123');
    expect(health.userId).toBe('user-456');
    expect(health.accessTokenMasked).toBe('abcd***5678');
  });
});
