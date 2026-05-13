// ── Universe Service ──
// Derives a deterministic eligible/ineligible member set with quote-coverage
// evidence from instrument sync state + latest quotes + universe policy.
//
// The service is the single point where the runtime computes the bounded
// tradable universe. Every proposal tick and health check consumes this
// service output rather than scanning the full instrument catalog.

import {
  type UniverseSnapshot,
  type NewUniverseSnapshot,
  type UniverseMemberCoverage,
  type UniversePolicyConfig,
  UniverseCoverageVerdict,
} from '../types/runtime.js';
import { BrokerRepository } from '../persistence/broker-repo.js';
import { UniverseRepository } from '../persistence/universe-repo.js';
import {
  INDIA_UNIVERSE_POLICY,
  determineCoverageVerdict,
  thresholdLabel,
  getEligibleSymbols,
} from './policy.js';

// ---------------------------------------------------------------------------
// UniverseService
// ---------------------------------------------------------------------------

export class UniverseService {
  private readonly _brokerRepo: BrokerRepository;
  private readonly _universeRepo: UniverseRepository;
  private readonly _policy: UniversePolicyConfig;

  constructor(
    brokerRepo: BrokerRepository,
    universeRepo: UniverseRepository,
    policy?: UniversePolicyConfig,
  ) {
    this._brokerRepo = brokerRepo;
    this._universeRepo = universeRepo;
    this._policy = policy ?? INDIA_UNIVERSE_POLICY;
  }

  /** Return the active policy config. */
  getPolicy(): UniversePolicyConfig {
    return this._policy;
  }

  /**
   * Compute a fresh universe coverage snapshot.
   *
   * Algorithm:
   * 1. Load all instruments from the broker store (by NSE exchange).
   * 2. Cross-reference against the policy allowlist to determine eligibility.
   * 3. For each eligible member, look up the latest quote snapshot.
   * 4. Classify each member's quote coverage.
   * 5. Compute aggregate verdict.
   * 6. Persist the snapshot to the universe_snapshots table.
   *
   * Deterministic ordering: by exchange, then tradingsymbol (alphabetical).
   *
   * Failure mode (instrument sync never completed):
   * If no instruments are in the broker store, the eligible set will be empty
   * and the verdict will be Degraded. The snapshot is still persisted so
   * operators can see the gap.
   */
  computeSnapshot(): UniverseSnapshot {
    const now = Date.now();
    const threshold = thresholdLabel(this._policy);
    const eligibleSet = getEligibleSymbols('NSE', this._policy);

    // Load all NSE instruments from the broker store
    const nseInstruments = this._brokerRepo.getInstrumentsByExchange('NSE');

    // Build a lookup map: tradingsymbol → instrument
    const instrumentMap = new Map<string, { instrumentToken: number; instrumentType: string }>();
    for (const inst of nseInstruments) {
      instrumentMap.set(inst.tradingsymbol, {
        instrumentToken: inst.instrumentToken,
        instrumentType: inst.instrumentType,
      });
    }

    // Collect all candidate members from the policy allowlist
    const allCandidates: Array<{
      exchange: string;
      tradingsymbol: string;
      instrumentToken: number | null;
      instrumentType: string;
    }> = [];

    // NSE allowlist members
    for (const symbol of (this._policy.allowlist['NSE'] ?? [])) {
      const inst = instrumentMap.get(symbol);
      allCandidates.push({
        exchange: 'NSE',
        tradingsymbol: symbol,
        instrumentToken: inst?.instrumentToken ?? null,
        instrumentType: inst?.instrumentType ?? 'EQ',
      });
    }

    // Also include any instruments not in the allowlist but in the master
    // for the ineligible count — gives operators visibility into what's available vs allowed
    for (const inst of nseInstruments) {
      if (!eligibleSet.has(inst.tradingsymbol)) {
        allCandidates.push({
          exchange: 'NSE',
          tradingsymbol: inst.tradingsymbol,
          instrumentToken: inst.instrumentToken,
          instrumentType: inst.instrumentType,
        });
      }
    }

    // Build quote freshness lookup
    const allQuotes = this._brokerRepo.getAllQuotes();
    const quoteMap = new Map<string, { receivedAt: number; priceTimestamp: number | null }>();
    for (const q of allQuotes) {
      const key = `${q.exchange}:${q.tradingsymbol}`;
      quoteMap.set(key, { receivedAt: q.receivedAt, priceTimestamp: q.priceTimestamp });
    }

    // Compute per-member coverage — deterministic sort by exchange, then tradingsymbol
    const sortedCandidates = allCandidates.sort((a, b) => {
      if (a.exchange !== b.exchange) return a.exchange.localeCompare(b.exchange);
      return a.tradingsymbol.localeCompare(b.tradingsymbol);
    });

    const members: UniverseMemberCoverage[] = [];
    let eligibleCount = 0;
    let ineligibleCount = 0;
    let freshQuoteCount = 0;
    let staleQuoteCount = 0;
    let missingQuoteCount = 0;

    for (const candidate of sortedCandidates) {
      const isEligible = eligibleSet.has(candidate.tradingsymbol);
      const quoteKey = `NSE:${candidate.tradingsymbol}`;
      const quote = quoteMap.get(quoteKey);

      let hasQuote = false;
      let quoteStalenessMs = 0;
      let lastQuoteAt: number | null = null;

      if (quote) {
        hasQuote = true;
        lastQuoteAt = quote.receivedAt;
        quoteStalenessMs = now - quote.receivedAt;
      }

      if (isEligible) {
        eligibleCount++;
        if (hasQuote && quoteStalenessMs <= this._policy.maxQuoteStalenessMs) {
          freshQuoteCount++;
        } else if (hasQuote && quoteStalenessMs > this._policy.maxQuoteStalenessMs) {
          staleQuoteCount++;
        } else {
          missingQuoteCount++;
        }
      } else {
        ineligibleCount++;
      }

      members.push({
        exchange: candidate.exchange,
        tradingsymbol: candidate.tradingsymbol,
        instrumentToken: candidate.instrumentToken,
        isEligible,
        hasQuote,
        quoteStalenessMs,
        lastQuoteAt,
        ineligibilityReason: isEligible
          ? null
          : !eligibleSet.has(candidate.tradingsymbol)
            ? 'not_in_allowlist'
            : 'not_in_instrument_master',
      });
    }

    // If no eligible members, the verdict is degraded
    const verdict = eligibleCount === 0
      ? UniverseCoverageVerdict.Degraded
      : determineCoverageVerdict(eligibleCount, missingQuoteCount, staleQuoteCount, freshQuoteCount, this._policy);

    // Persist snapshot
    const newSnapshot: NewUniverseSnapshot = {
      policyVersion: this._policy.version,
      computedAt: now,
      verdict,
      eligibleCount,
      ineligibleCount,
      freshQuoteCount,
      staleQuoteCount,
      missingQuoteCount,
      thresholdLabel: threshold,
      thresholdRatio: this._policy.sufficientThresholdRatio,
      maxStalenessMs: this._policy.maxQuoteStalenessMs,
      members,
    };

    const snapshot = this._universeRepo.insertSnapshot(newSnapshot);

    // Sync the eligible members into the universe_members table for fast lookup
    this._syncEligibleMembers(members);

    return snapshot;
  }

  /**
   * Get the latest persisted snapshot without re-computing.
   * Returns null if no snapshot exists.
   */
  getLatestSnapshot(): UniverseSnapshot | null {
    return this._universeRepo.getLatestSnapshot();
  }

  /**
   * Get recent snapshots (newest first).
   */
  getRecentSnapshots(limit: number = 10): UniverseSnapshot[] {
    return this._universeRepo.getSnapshots(limit);
  }

  /**
   * Convenience: summarise the latest snapshot for health/dashboard surfaces.
   */
  /**
   * Check whether a symbol is eligible for trading in a given exchange,
   * according to the active bounded-universe policy allowlist.
   *
   * This is the primary query seam for downstream consumers (strategy-risk service,
   * proposal engine) that need to filter proposals by universe membership.
   *
   * @returns true if the symbol is in the policy allowlist for the given exchange.
   */
  isSymbolEligible(tradingsymbol: string, exchange: string): boolean {
    const eligibleSet = getEligibleSymbols(exchange, this._policy);
    return eligibleSet.has(tradingsymbol);
  }

  getCoverageSummary(): UniverseCoverageSummary | null {
    const snapshot = this._universeRepo.getLatestSnapshot();
    if (!snapshot) return null;

    return {
      policyVersion: snapshot.policyVersion,
      computedAt: snapshot.computedAt,
      verdict: snapshot.verdict,
      eligibleCount: snapshot.eligibleCount,
      freshQuoteCount: snapshot.freshQuoteCount,
      staleQuoteCount: snapshot.staleQuoteCount,
      missingQuoteCount: snapshot.missingQuoteCount,
      thresholdLabel: snapshot.thresholdLabel,
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /**
   * Sync the eligible universe members into the universe_members table.
   * This ensures the repo table matches the policy allowlist.
   *
   * Strategy: clear all existing members, then re-insert eligible ones.
   * Safe because this runs within a single snapshot computation.
   */
  private _syncEligibleMembers(members: UniverseMemberCoverage[]): void {
    const eligible = members.filter(m => m.isEligible);
    this._universeRepo.clearMembers();
    for (const m of eligible) {
      this._universeRepo.upsertMember(
        m.exchange,
        m.tradingsymbol,
        undefined, // instrument type will use default 'EQ'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Lightweight summary type for health/dashboard surfaces
// ---------------------------------------------------------------------------

export interface UniverseCoverageSummary {
  policyVersion: string;
  computedAt: number;
  verdict: UniverseCoverageVerdict;
  eligibleCount: number;
  freshQuoteCount: number;
  staleQuoteCount: number;
  missingQuoteCount: number;
  thresholdLabel: string;
}
