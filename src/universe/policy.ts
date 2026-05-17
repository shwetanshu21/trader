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
// NSE EQ Allowlist — all NSE equities
// ---------------------------------------------------------------------------
// Sentinel value '*' means all NSE EQ instruments synced from the broker
// are eligible. The UniverseService resolves this to the full instrument set
// at snapshot computation time.

const FALLBACK_NSE_CORE_ALLOWLIST: string[] = [
  'RELIANCE',
  'TCS',
  'INFY',
  'HDFCBANK',
  'ICICIBANK',
  'SBIN',
  'LT',
  'ITC',
  'BHARTIARTL',
  'AXISBANK',
  'KOTAKBANK',
  'HINDUNILVR',
  'BAJFINANCE',
  'ASIANPAINT',
  'MARUTI',
  'HCLTECH',
  'SUNPHARMA',
  'ULTRACEMCO',
  'TITAN',
  'WIPRO',
  'NESTLEIND',
  'POWERGRID',
  'NTPC',
  'ONGC',
  'TECHM',
  'M&M',
  'TMCV',
  'BAJAJFINSV',
  'ADANIPORTS',
  'JSWSTEEL',
  'TATASTEEL',
  'COALINDIA',
  'GRASIM',
  'HINDALCO',
  'ADANIENT',
  'EICHERMOT',
  'HEROMOTOCO',
  'INDUSINDBK',
  'BAJAJ-AUTO',
  'BRITANNIA',
  'CIPLA',
  'DRREDDY',
  'APOLLOHOSP',
  'DIVISLAB',
  'SHRIRAMFIN',
  'BPCL',
  'UPL',
  'PIDILITIND',
  'HDFCLIFE',
  'SBILIFE',
];

function loadBoundedNseAllowlist(): string[] {
  return FALLBACK_NSE_CORE_ALLOWLIST;
}

const NSE_EQ_ALLOWLIST: string[] = loadBoundedNseAllowlist();

// ---------------------------------------------------------------------------
// NFO FUT Allowlist — disabled by default for bounded live universe
// ---------------------------------------------------------------------------

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
  label: `India Bounded Equity Universe v${POLICY_VERSION}`,
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
