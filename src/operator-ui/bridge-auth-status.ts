import fs from 'node:fs';
import path from 'node:path';
import type { OperatorSummaryCard, OperatorProvenance } from '../types/runtime.js';
import { getUpstoxTokenHealth } from '../upstox/token-store.js';

interface BridgeStatusToken {
  exists?: boolean;
  isExpired?: boolean;
  checkedAt?: string;
}

interface BridgeRecentCall {
  at?: string;
  error?: string | null;
}

interface BridgeStatusFile {
  token?: BridgeStatusToken;
  lastSuccess?: BridgeRecentCall | null;
  lastFailure?: BridgeRecentCall | null;
}

type BridgeAuthState = 'healthy' | 'approval-needed' | 'token-expired' | 'token-rejected' | 'token-present' | 'unknown';

function resolveBridgeStatusPath(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.TRADER_UPSTOX_MCP_LOCAL_STATUS_PATH?.trim() || './tmp/upstox/mcp-local/status.json');
}

function safeReadBridgeStatus(env: Record<string, string | undefined> = process.env): BridgeStatusFile | null {
  const absolutePath = resolveBridgeStatusPath(env);
  if (!fs.existsSync(absolutePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as BridgeStatusFile;
  } catch {
    return null;
  }
}

function parseIso(value: string | undefined | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function classifyBridgeAuthState(env: Record<string, string | undefined> = process.env): {
  state: BridgeAuthState;
  checkedAt: number;
  sourceLabel: string;
} {
  const status = safeReadBridgeStatus(env);
  const tokenHealth = getUpstoxTokenHealth(env);
  const checkedAt = parseIso(status?.token?.checkedAt ?? tokenHealth.checkedAt) ?? Date.now();

  if (status?.token?.exists === false || tokenHealth.exists === false) {
    return { state: 'approval-needed', checkedAt, sourceLabel: 'mcp-local-status+token-store' };
  }

  if (status?.token?.isExpired === true || tokenHealth.isExpired) {
    return { state: 'token-expired', checkedAt, sourceLabel: 'mcp-local-status+token-store' };
  }

  const successAt = parseIso(status?.lastSuccess?.at);
  const failureAt = parseIso(status?.lastFailure?.at);
  if (successAt !== null && (failureAt === null || successAt >= failureAt)) {
    return { state: 'healthy', checkedAt, sourceLabel: 'mcp-local-status' };
  }

  const failure = status?.lastFailure?.error?.toLowerCase() ?? '';
  if (failure.includes('expired')) {
    return { state: 'token-expired', checkedAt, sourceLabel: 'mcp-local-status' };
  }
  if (
    failure.includes('invalid token')
    || failure.includes('unauthorized')
    || failure.includes('401')
    || failure.includes('auth failed')
    || failure.includes('authentication required')
  ) {
    return { state: 'token-rejected', checkedAt, sourceLabel: 'mcp-local-status' };
  }

  if (tokenHealth.exists && !tokenHealth.isExpired) {
    return { state: 'token-present', checkedAt, sourceLabel: status ? 'mcp-local-status+token-store' : 'token-store' };
  }

  return { state: 'unknown', checkedAt, sourceLabel: status ? 'mcp-local-status' : 'token-store' };
}

function displayForState(state: BridgeAuthState): string {
  switch (state) {
    case 'healthy':
      return 'Healthy';
    case 'approval-needed':
      return 'Approval needed';
    case 'token-expired':
      return 'Token expired';
    case 'token-rejected':
      return 'Token rejected';
    case 'token-present':
      return 'Token present';
    case 'unknown':
    default:
      return 'Unknown';
  }
}

export function getBridgeAuthSummaryCard(env: Record<string, string | undefined> = process.env): OperatorSummaryCard {
  const status = classifyBridgeAuthState(env);
  const provenance: OperatorProvenance = {
    source: 'runtime',
    asOf: status.checkedAt,
    sourceLabel: status.sourceLabel,
  };

  return {
    key: 'upstox_auth',
    label: 'Upstox Auth',
    value: 0,
    unit: null,
    change: null,
    display: displayForState(status.state),
    provenance,
  };
}
