// ── India Tradable Universe Policy ──
// Deterministic allowlist and coverage threshold configuration.
// This is the single source of truth for "what is tradable" in the India runtime.
//
// The allowlist defines the explicit set of exchange + tradingsymbol pairs
// that the runtime considers eligible for trading. Symbols not in this list
// are excluded from proposal generation regardless of instrument sync state.
//
// Thresholds control when quote coverage is considered sufficient, stale,
// or degraded for operator dashboard and health surfaces.

import {
  type UniversePolicyConfig,
  type UniverseMemberCoverage,
  UniverseCoverageVerdict,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Policy version
// ---------------------------------------------------------------------------

/**
 * Current policy version.
 * Bump when the allowlist or thresholds change materially.
 * Format: semver (major.minor.patch).
 */
const POLICY_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// NSE EQ Allowlist — actively traded equities
// ---------------------------------------------------------------------------
// Sourced from NSE 50-index constituents plus liquid additional symbols.
// Sorted alphabetically for deterministic ordering.

const NSE_EQ_ALLOWLIST: string[] = [
  'ADANIENT',
  'ADANIPORTS',
  'APOLLOHOSP',
  'ASIANPAINT',
  'AXISBANK',
  'BAJAJ-AUTO',
  'BAJFINANCE',
  'BAJAJFINSV',
  'BEL',
  'BHARTIARTL',
  'BPCL',
  'BRITANNIA',
  'CIPLA',
  'COALINDIA',
  'DIVISLAB',
  'DRREDDY',
  'EICHERMOT',
  'GRASIM',
  'HCLTECH',
  'HDFCBANK',
  'HDFCLIFE',
  'HEROMOTOCO',
  'HINDALCO',
  'HINDUSTAN_UNILEVER',
  'ICICIBANK',
  'INDUSINDBK',
  'INFY',
  'ITC',
  'JSW_STEEL',
  'KOTAKBANK',
  'LT',
  'M&M',
  'MARUTI',
  'NESTLEIND',
  'NTPC',
  'ONGC',
  'POWERGRID',
  'RELIANCE',
  'SBILIFE',
  'SBIN',
  'SHRIRAMFIN',
  'SUNPHARMA',
  'TATACONSUM',
  'TATAMOTORS',
  'TATASTEEL',
  'TCS',
  'TECHM',
  'TITAN',
  'ULTRACEMCO',
  'WIPRO',
];

// ---------------------------------------------------------------------------
// NFO FUT Allowlist — actively traded futures (top NSE 50 underlyings)
// ---------------------------------------------------------------------------
// Futures symbols typically follow the pattern <STOCK><YYYYMMDFUT>.
// The policy tracks the underlying stock name; the actual tradingsymbol
// is resolved from the instrument master at runtime.
//
// For the M003 scope, we only include EQ selectable members.
// F&O selection will be added in a later milestone.

const NFO_FUT_ALLOWLIST: string[] = [];

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Minimum ratio of eligible members with fresh quotes required for
 * coverage to be considered "sufficient".
 * 0.90 = 90% of eligible instruments must have a fresh quote.
 */
const SUFFICIENT_THRESHOLD_RATIO = 0.90;

/**
 * Quote staleness threshold in milliseconds.
 * A quote older than this is considered stale.
 * Default: 120_000ms = 2 minutes (allowing for batch flush + network variance).
 */
const MAX_QUOTE_STALENESS_MS = 120_000;

// ---------------------------------------------------------------------------
// Policy singleton
// ---------------------------------------------------------------------------

/** The single India tradable universe policy instance. */
export const INDIA_UNIVERSE_POLICY: UniversePolicyConfig = {
  version: POLICY_VERSION,
  label: 'India NSE Equity Universe v1',
  allowlist: {
    NSE: NSE_EQ_ALLOWLIST,
    NFO: NFO_FUT_ALLOWLIST,
  },
  sufficientThresholdRatio: SUFFICIENT_THRESHOLD_RATIO,
  maxQuoteStalenessMs: MAX_QUOTE_STALENESS_MS,
};

// ---------------------------------------------------------------------------
// Coverage verdict helper
// ---------------------------------------------------------------------------

/**
 * Determine the coverage verdict from member coverage data.
 *
 * - `degraded`: fewer than 50% of eligible members have any quote, OR
 *   the eligible count is 0 (instrument sync never completed).
 * - `stale`: 50–89% have fresh quotes, or any eligible quote is stale.
 * - `sufficient`: >= 90% of eligible members have fresh quotes.
 * - `unknown` is reserved; the service returns `degraded` for empty eligible set.
 */
export function determineCoverageVerdict(
  eligibleCount: number,
  missingQuoteCount: number,
  staleQuoteCount: number,
  freshQuoteCount: number,
  policy: UniversePolicyConfig = INDIA_UNIVERSE_POLICY,
): UniverseCoverageVerdict {
  if (eligibleCount === 0) {
    // No eligible members → unknown/degraded (instrument sync never completed)
    return UniverseCoverageVerdict.Degraded;
  }

  // If more than half the eligible members have no quote at all → degraded
  const missingRatio = missingQuoteCount / eligibleCount;
  if (missingRatio > 0.50) {
    return UniverseCoverageVerdict.Degraded;
  }

  // If any eligible member has a stale quote, that's at least "stale"
  const freshRatio = freshQuoteCount / eligibleCount;
  if (freshRatio >= policy.sufficientThresholdRatio && staleQuoteCount === 0) {
    return UniverseCoverageVerdict.Sufficient;
  }

  if (freshRatio >= 0.50) {
    return UniverseCoverageVerdict.Stale;
  }

  // Less than 50% fresh → degraded
  return UniverseCoverageVerdict.Degraded;
}

/**
 * Build a human-readable label for the threshold configuration.
 */
export function thresholdLabel(policy: UniversePolicyConfig = INDIA_UNIVERSE_POLICY): string {
  return `fresh≥${Math.round(policy.sufficientThresholdRatio * 100)}%_stale≤${policy.maxQuoteStalenessMs}ms`;
}

/**
 * Return all eligible symbols for a given exchange from the policy.
 * Result is a Set for fast membership checks.
 */
export function getEligibleSymbols(exchange: string, policy: UniversePolicyConfig = INDIA_UNIVERSE_POLICY): Set<string> {
  const symbols = policy.allowlist[exchange];
  if (!symbols || symbols.length === 0) return new Set();
  return new Set(symbols);
}
