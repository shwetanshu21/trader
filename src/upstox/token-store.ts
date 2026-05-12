import fs from 'node:fs';
import path from 'node:path';

export interface UpstoxTokenPayload {
  client_id?: string;
  user_id?: string;
  access_token?: string;
  token_type?: string;
  expires_at?: string;
  issued_at?: string;
  message_type?: string;
  persisted_at?: number;
  [key: string]: unknown;
}

export interface UpstoxTokenRecord {
  tokenPath: string;
  absolutePath: string;
  payload: UpstoxTokenPayload;
  accessToken: string;
  expiresAt: number | null;
  issuedAt: number | null;
  persistedAt: number | null;
  isExpired: boolean;
  checkedAt: number;
}

export interface UpstoxTokenHealth {
  tokenPath: string;
  absolutePath: string;
  exists: boolean;
  clientId: string | null;
  userId: string | null;
  expiresAt: string | null;
  issuedAt: string | null;
  persistedAt: string | null;
  messageType: string | null;
  tokenType: string | null;
  accessTokenMasked: string | null;
  isExpired: boolean;
  checkedAt: string;
}

export class UpstoxTokenStoreError extends Error {
  readonly code: 'TOKEN_FILE_MISSING' | 'TOKEN_FILE_INVALID_JSON' | 'TOKEN_MISSING_ACCESS_TOKEN' | 'TOKEN_EXPIRED';
  readonly absolutePath: string;

  constructor(
    code: UpstoxTokenStoreError['code'],
    message: string,
    absolutePath: string,
  ) {
    super(message);
    this.name = 'UpstoxTokenStoreError';
    this.code = code;
    this.absolutePath = absolutePath;
  }
}

export function resolveUpstoxTokenPath(env: Record<string, string | undefined> = process.env): {
  tokenPath: string;
  absolutePath: string;
} {
  const tokenPath = env.TRADER_UPSTOX_TOKEN_PATH?.trim() || './tmp/upstox/notifier/latest-token.json';
  return {
    tokenPath,
    absolutePath: path.resolve(tokenPath),
  };
}

export function readUpstoxTokenRecord(env: Record<string, string | undefined> = process.env): UpstoxTokenRecord {
  const { tokenPath, absolutePath } = resolveUpstoxTokenPath(env);

  if (!fs.existsSync(absolutePath)) {
    throw new UpstoxTokenStoreError(
      'TOKEN_FILE_MISSING',
      `Upstox token file not found at ${absolutePath}`,
      absolutePath,
    );
  }

  let payload: UpstoxTokenPayload;
  try {
    payload = JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as UpstoxTokenPayload;
  } catch (error) {
    throw new UpstoxTokenStoreError(
      'TOKEN_FILE_INVALID_JSON',
      `Upstox token file contains invalid JSON at ${absolutePath}`,
      absolutePath,
    );
  }

  const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
  if (!accessToken) {
    throw new UpstoxTokenStoreError(
      'TOKEN_MISSING_ACCESS_TOKEN',
      `Upstox token file at ${absolutePath} is missing access_token`,
      absolutePath,
    );
  }

  const checkedAt = Date.now();
  const expiresAt = parseTimestamp(payload.expires_at);
  const issuedAt = parseTimestamp(payload.issued_at);
  const persistedAt = typeof payload.persisted_at === 'number' && Number.isFinite(payload.persisted_at)
    ? payload.persisted_at
    : parseNumeric(payload.persisted_at);
  const isExpired = expiresAt !== null ? expiresAt <= checkedAt : false;

  if (isExpired) {
    throw new UpstoxTokenStoreError(
      'TOKEN_EXPIRED',
      `Upstox token at ${absolutePath} expired at ${new Date(expiresAt!).toISOString()}`,
      absolutePath,
    );
  }

  return {
    tokenPath,
    absolutePath,
    payload,
    accessToken,
    expiresAt,
    issuedAt,
    persistedAt,
    isExpired,
    checkedAt,
  };
}

export function getUpstoxTokenHealth(env: Record<string, string | undefined> = process.env): UpstoxTokenHealth {
  const { tokenPath, absolutePath } = resolveUpstoxTokenPath(env);
  const checkedAt = new Date().toISOString();

  if (!fs.existsSync(absolutePath)) {
    return {
      tokenPath,
      absolutePath,
      exists: false,
      clientId: null,
      userId: null,
      expiresAt: null,
      issuedAt: null,
      persistedAt: null,
      messageType: null,
      tokenType: null,
      accessTokenMasked: null,
      isExpired: false,
      checkedAt,
    };
  }

  try {
    const record = readUpstoxTokenRecord(env);
    return {
      tokenPath,
      absolutePath,
      exists: true,
      clientId: stringOrNull(record.payload.client_id),
      userId: stringOrNull(record.payload.user_id),
      expiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
      issuedAt: record.issuedAt ? new Date(record.issuedAt).toISOString() : null,
      persistedAt: record.persistedAt ? new Date(record.persistedAt).toISOString() : null,
      messageType: stringOrNull(record.payload.message_type),
      tokenType: stringOrNull(record.payload.token_type),
      accessTokenMasked: maskToken(record.accessToken),
      isExpired: record.isExpired,
      checkedAt,
    };
  } catch (error) {
    const payload = safeReadPayload(absolutePath);
    return {
      tokenPath,
      absolutePath,
      exists: true,
      clientId: stringOrNull(payload?.client_id),
      userId: stringOrNull(payload?.user_id),
      expiresAt: isoOrNull(payload?.expires_at),
      issuedAt: isoOrNull(payload?.issued_at),
      persistedAt: typeof payload?.persisted_at === 'number' ? new Date(payload.persisted_at).toISOString() : null,
      messageType: stringOrNull(payload?.message_type),
      tokenType: stringOrNull(payload?.token_type),
      accessTokenMasked: maskToken(typeof payload?.access_token === 'string' ? payload.access_token : undefined),
      isExpired: error instanceof UpstoxTokenStoreError && error.code === 'TOKEN_EXPIRED',
      checkedAt,
    };
  }
}

export function maskToken(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseNumeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isoOrNull(value: unknown): string | null {
  const parsed = parseTimestamp(value);
  return parsed ? new Date(parsed).toISOString() : null;
}

function safeReadPayload(absolutePath: string): UpstoxTokenPayload | null {
  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as UpstoxTokenPayload;
  } catch {
    return null;
  }
}
