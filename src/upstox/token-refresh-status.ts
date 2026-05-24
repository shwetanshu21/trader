import fs from 'node:fs';
import path from 'node:path';

import { getUpstoxTokenHealth, readUpstoxTokenRecord } from './token-store.js';

export type UpstoxTokenRefreshState =
  | 'idle'
  | 'awaiting_approval'
  | 'refreshed'
  | 'request_failed'
  | 'suppressed';

export interface UpstoxTokenRefreshStatus {
  schemaVersion: number;
  state: UpstoxTokenRefreshState;
  checkedAt: string;
  lastRequestAt: string | null;
  lastRequestSource: string | null;
  lastRequestStatus: number | null;
  notifierUrl: string | null;
  pendingBaselinePersistedAt: string | null;
  pendingBaselineIssuedAt: string | null;
  lastObservedTokenPersistedAt: string | null;
  lastObservedTokenIssuedAt: string | null;
  lastObservedTokenExpiresAt: string | null;
  lastError: string | null;
  message: string | null;
}

export interface UpstoxTokenRefreshHealth {
  statusPath: string;
  absolutePath: string;
  exists: boolean;
  refresh: UpstoxTokenRefreshStatus;
  token: ReturnType<typeof getUpstoxTokenHealth>;
}

const DEFAULT_STATUS_PATH = './tmp/upstox/notifier/refresh-status.json';

export function resolveUpstoxTokenRefreshStatusPath(env: Record<string, string | undefined> = process.env): {
  statusPath: string;
  absolutePath: string;
} {
  const statusPath = env.TRADER_UPSTOX_TOKEN_REFRESH_STATUS_PATH?.trim() || DEFAULT_STATUS_PATH;
  return {
    statusPath,
    absolutePath: path.resolve(statusPath),
  };
}

export function createDefaultUpstoxTokenRefreshStatus(now: Date = new Date()): UpstoxTokenRefreshStatus {
  return {
    schemaVersion: 1,
    state: 'idle',
    checkedAt: now.toISOString(),
    lastRequestAt: null,
    lastRequestSource: null,
    lastRequestStatus: null,
    notifierUrl: null,
    pendingBaselinePersistedAt: null,
    pendingBaselineIssuedAt: null,
    lastObservedTokenPersistedAt: null,
    lastObservedTokenIssuedAt: null,
    lastObservedTokenExpiresAt: null,
    lastError: null,
    message: null,
  };
}

export function readUpstoxTokenRefreshStatus(
  env: Record<string, string | undefined> = process.env,
): UpstoxTokenRefreshStatus {
  const { absolutePath } = resolveUpstoxTokenRefreshStatusPath(env);
  if (!fs.existsSync(absolutePath)) {
    return createDefaultUpstoxTokenRefreshStatus();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as Partial<UpstoxTokenRefreshStatus>;
    return {
      ...createDefaultUpstoxTokenRefreshStatus(),
      ...parsed,
    };
  } catch {
    return {
      ...createDefaultUpstoxTokenRefreshStatus(),
      state: 'request_failed',
      message: 'Refresh status file contained invalid JSON.',
      lastError: 'Refresh status file contained invalid JSON.',
    };
  }
}

export function writeUpstoxTokenRefreshStatus(
  status: UpstoxTokenRefreshStatus,
  env: Record<string, string | undefined> = process.env,
): UpstoxTokenRefreshStatus {
  const { absolutePath } = resolveUpstoxTokenRefreshStatusPath(env);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolutePath, JSON.stringify(status, null, 2), { mode: 0o600 });
  fs.chmodSync(absolutePath, 0o600);
  return status;
}

export function getUpstoxTokenRefreshHealth(
  env: Record<string, string | undefined> = process.env,
): UpstoxTokenRefreshHealth {
  const { statusPath, absolutePath } = resolveUpstoxTokenRefreshStatusPath(env);
  const exists = fs.existsSync(absolutePath);
  return {
    statusPath,
    absolutePath,
    exists,
    refresh: readUpstoxTokenRefreshStatus(env),
    token: getUpstoxTokenHealth(env),
  };
}

export function snapshotCurrentTokenTimes(env: Record<string, string | undefined> = process.env): {
  persistedAt: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
} {
  try {
    const record = readUpstoxTokenRecord(env);
    return {
      persistedAt: record.persistedAt ? new Date(record.persistedAt).toISOString() : null,
      issuedAt: record.issuedAt ? new Date(record.issuedAt).toISOString() : null,
      expiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
    };
  } catch {
    return {
      persistedAt: null,
      issuedAt: null,
      expiresAt: null,
    };
  }
}
