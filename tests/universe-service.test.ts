// ── UniverseService tests ──
// Covers deterministic ordering, missing instruments, missing quotes,
// stale quotes, threshold transitions, and empty-universe edge cases.

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { BrokerRepository } from '../src/persistence/broker-repo.js';
import { UniverseRepository } from '../src/persistence/universe-repo.js';
import { UniverseService } from '../src/universe/universe-service.js';
import {
  UniverseCoverageVerdict,
  type UniversePolicyConfig,
} from '../src/types/runtime.js';
import { INDIA_UNIVERSE_POLICY } from '../src/universe/policy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createService(
  policyOverride?: Partial<UniversePolicyConfig>,
): {
  service: UniverseService;
  brokerRepo: BrokerRepository;
  universeRepo: UniverseRepository;
  dbMgr: DatabaseManager;
} {
  const dbMgr = new DatabaseManager(':memory:');
  const brokerRepo = new BrokerRepository(dbMgr.db);
  const universeRepo = new UniverseRepository(dbMgr.db);
  const policy: UniversePolicyConfig = {
    ...INDIA_UNIVERSE_POLICY,
    ...policyOverride,
    // Ensure a small allowlist for deterministic testing
    allowlist: policyOverride?.allowlist ?? {
      NSE: ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK'],
    },
  };
  const service = new UniverseService(brokerRepo, universeRepo, policy);
  return { service, brokerRepo, universeRepo, dbMgr };
}

/** Seed instruments into the broker store. */
function seedInstruments(
  brokerRepo: BrokerRepository,
  symbols: Array<{ exchange: string; tradingsymbol: string; token: number }>,
): void {
  brokerRepo.upsertInstruments(
    symbols.map(s => ({
      exchange: s.exchange,
      tradingsymbol: s.tradingsymbol,
      instrumentToken: s.token,
      name: s.tradingsymbol,
      expiry: null,
      strike: null,
      lotSize: 1,
      tickSize: 0.05,
      instrumentType: 'EQ' as const,
      segment: 'NSE' as const,
      exchangeToken: Math.floor(s.token / 100),
    })),
  );
}

/** Seed a quote for a given symbol. */
function seedQuote(
  brokerRepo: BrokerRepository,
  exchange: string,
  tradingsymbol: string,
  token: number,
  receivedAt?: number,
): void {
  brokerRepo.upsertQuote({
    exchange,
    tradingsymbol,
    instrumentToken: token,
    lastPrice: 2500,
    change: 10,
    changePercent: 0.4,
    volume: 100000,
    oi: null,
    high: 2520,
    low: 2480,
    open: 2490,
    close: 2490,
    bid: 2499,
    ask: 2501,
    priceTimestamp: receivedAt ? Math.floor(receivedAt / 1000) : Math.floor(Date.now() / 1000),
    receivedAt: receivedAt ?? Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UniverseService — basic computation', () => {
  let ctx: ReturnType<typeof createService>;

  beforeEach(() => {
    ctx = createService();
  });

  it('should produce a deterministic snapshot with eligible and ineligible members', () => {
    // Seed 5 NSE instruments; 4 are in the allowlist, 1 is not
    seedInstruments(ctx.brokerRepo, [
      { exchange: 'NSE', tradingsymbol: 'RELIANCE', token: 1001 },
      { exchange: 'NSE', tradingsymbol: 'TCS', token: 1002 },
      { exchange: 'NSE', tradingsymbol: 'INFY', token: 1003 },
      { exchange: 'NSE', tradingsymbol: 'HDFCBANK', token: 1004 },
      { exchange: 'NSE', tradingsymbol: 'ADANIENT', token: 1005 }, // not in test allowlist
    ]);

    // Seed quotes for all eligible
    seedQuote(ctx.brokerRepo, 'NSE', 'RELIANCE', 1001);
    seedQuote(ctx.brokerRepo, 'NSE', 'TCS', 1002);
    seedQuote(ctx.brokerRepo, 'NSE', 'INFY', 1003);
    seedQuote(ctx.brokerRepo, 'NSE', 'HDFCBANK', 1004);

    const snapshot = ctx.service.computeSnapshot();

    // Check structure
    expect(snapshot.policyVersion).toBeTruthy();
    expect(snapshot.computedAt).toBeGreaterThan(0);
    expect(snapshot.id).toBeGreaterThan(0);

    // 4 eligible (in allowlist + in instrument master) + 1 ineligible (not in allowlist)
    expect(snapshot.eligibleCount).toBe(4);
    expect(snapshot.ineligibleCount).toBe(1);
    expect(snapshot.freshQuoteCount).toBe(4);
    expect(snapshot.staleQuoteCount).toBe(0);
    expect(snapshot.missingQuoteCount).toBe(0);
    expect(snapshot.verdict).toBe(UniverseCoverageVerdict.Sufficient);

    // All members should be present
    expect(snapshot.members).toHaveLength(5);

    // Deterministic ordering: alphabetical by tradingsymbol
    expect(snapshot.members[0].tradingsymbol).toBe('ADANIENT');
    expect(snapshot.members[1].tradingsymbol).toBe('HDFCBANK');
    expect(snapshot.members[2].tradingsymbol).toBe('INFY');
    expect(snapshot.members[3].tradingsymbol).toBe('RELIANCE');
    expect(snapshot.members[4].tradingsymbol).toBe('TCS');

    // Ineligible members should have reason
    expect(snapshot.members[0].isEligible).toBe(false);
    expect(snapshot.members[0].ineligibilityReason).toBe('not_in_allowlist');

    // Eligible members should have quotes
    const reliance = snapshot.members[3];
    expect(reliance.isEligible).toBe(true);
    expect(reliance.hasQuote).toBe(true);
    expect(reliance.ineligibilityReason).toBeNull();
  });

  it('should persist snapshot and make it retrievable via getLatestSnapshot', () => {
    seedInstruments(ctx.brokerRepo, [
      { exchange: 'NSE', tradingsymbol: 'RELIANCE', token: 1001 },
    ]);
    seedQuote(ctx.brokerRepo, 'NSE', 'RELIANCE', 1001);

    ctx.service.computeSnapshot();

    const latest = ctx.service.getLatestSnapshot();
    expect(latest).not.toBeNull();
    // 4 eligible: all from allowlist (RELIANCE, TCS, INFY, HDFCBANK),
    // even though only RELIANCE is in the instrument master
    expect(latest!.eligibleCount).toBe(4);
    expect(latest!.freshQuoteCount).toBe(1);
  });

  it('should populate universe_members table after computation', () => {
    seedInstruments(ctx.brokerRepo, [
      { exchange: 'NSE', tradingsymbol: 'RELIANCE', token: 1001 },
      { exchange: 'NSE', tradingsymbol: 'TCS', token: 1002 },
    ]);
    seedQuote(ctx.brokerRepo, 'NSE', 'RELIANCE', 1001);
    seedQuote(ctx.brokerRepo, 'NSE', 'TCS', 1002);

    ctx.service.computeSnapshot();

    const members = ctx.universeRepo.getAllMembers();
    // All 4 allowlist symbols are eligible (allowlist defines eligibility)
    expect(members).toHaveLength(4);
    // Deterministic alphabetical order
    expect(members[0].tradingsymbol).toBe('HDFCBANK');
    expect(members[1].tradingsymbol).toBe('INFY');
    expect(members[2].tradingsymbol).toBe('RELIANCE');
    expect(members[3].tradingsymbol).toBe('TCS');
  });
});

describe('UniverseService — missing instruments (sync never completed)', () => {
  let ctx: ReturnType<typeof createService>;

  beforeEach(() => {
    ctx = createService();
  });

  it('should return degraded verdict when no instruments are in the broker store', () => {
    // Do NOT seed any instruments — simulates sync never completed

    const snapshot = ctx.service.computeSnapshot();

    // Allowlist defines eligibility — all 4 symbols are eligible even without instrument records
    expect(snapshot.eligibleCount).toBe(4);
    expect(snapshot.verdict).toBe(UniverseCoverageVerdict.Degraded);
    // All 4 have no quotes → missingQuoteCount = 4
    expect(snapshot.missingQuoteCount).toBe(4);

    // Even with 0 quotes, the snapshot is persisted
    expect(snapshot.id).toBeGreaterThan(0);

    // Coverage summary should reflect degraded state
    const summary = ctx.service.getCoverageSummary();
    expect(summary).not.toBeNull();
    expect(summary!.verdict).toBe(UniverseCoverageVerdict.Degraded);
  });

  it('should return degraded when allowlist symbols are missing from instrument master', () => {
    // Seed only some instruments — missing RELIANCE
    seedInstruments(ctx.brokerRepo, [
      { exchange: 'NSE', tradingsymbol: 'TCS', token: 1002 },
    ]);
    seedQuote(ctx.brokerRepo, 'NSE', 'TCS', 1002);

    const snapshot = ctx.service.computeSnapshot();

    // All 4 allowlist symbols are eligible even if not in instrument master
    expect(snapshot.eligibleCount).toBe(4);
    expect(snapshot.ineligibleCount).toBe(0); // no additional NSE instruments outside allowlist
    expect(snapshot.missingQuoteCount).toBe(3); // RELIANCE, HDFCBANK, INFY have no quote
    expect(snapshot.freshQuoteCount).toBe(1); // TCS has a quote
    // missingRatio = 3/4 = 0.75 > 0.50 → Degraded
    expect(snapshot.verdict).toBe(UniverseCoverageVerdict.Degraded);
  });
});

describe('UniverseService — missing and stale quotes', () => {
  let ctx: ReturnType<typeof createService>;

  beforeEach(() => {
    ctx = createService();
  });

  it('should report missing quotes when eligible members have no quote', () => {
    seedInstruments(ctx.brokerRepo, [
      { exchange: 'NSE', tradingsymbol: 'RELIANCE', token: 1001 },
      { exchange: 'NSE', tradingsymbol: 'TCS', token: 1002 },
      { exchange: 'NSE', tradingsymbol: 'INFY', token: 1003 },
      { exchange: 'NSE', tradingsymbol: 'HDFCBANK', token: 1004 },
    ]);

    // Seed quote for only 2 of 4 eligible members
    seedQuote(ctx.brokerRepo, 'NSE', 'RELIANCE', 1001);
    seedQuote(ctx.brokerRepo, 'NSE', 'TCS', 1002);

    const snapshot = ctx.service.computeSnapshot();

    expect(snapshot.eligibleCount).toBe(4);
    expect(snapshot.freshQuoteCount).toBe(2);
    expect(snapshot.staleQuoteCount).toBe(0);
    expect(snapshot.missingQuoteCount).toBe(2);
    // 2/4 = 50% fresh, 50% missing → missingRatio = 0.50 → not > 0.50, freshRatio = 0.50 → >= 0.50 → Stale
    // Actually: missingRatio = 2/4 = 0.50 → not > 0.50 → continues
    // freshRatio = 2/4 = 0.50 → not >= 0.90 → falls to second check: freshRatio >= 0.50 → Stale
    expect(snapshot.verdict).toBe(UniverseCoverageVerdict.Stale);

    // Members should reflect quote availability
    const reliance = snapshot.members.find(m => m.tradingsymbol === 'RELIANCE')!;
    expect(reliance.hasQuote).toBe(true);

    const hdfc = snapshot.members.find(m => m.tradingsymbol === 'HDFCBANK')!;
    expect(hdfc.hasQuote).toBe(false);
    expect(hdfc.quoteStalenessMs).toBe(0);
    expect(hdfc.lastQuoteAt).toBeNull();
  });

  it('should report stale quotes when eligible member quotes exceed max staleness', () => {
    seedInstruments(ctx.brokerRepo, [
      { exchange: 'NSE', tradingsymbol: 'RELIANCE', token: 1001 },
      { exchange: 'NSE', tradingsymbol: 'TCS', token: 1002 },
      { exchange: 'NSE', tradingsymbol: 'INFY', token: 1003 },
      { exchange: 'NSE', tradingsymbol: 'HDFCBANK', token: 1004 },
    ]);

    // Seed quotes — 3 fresh, 1 stale (old timestamp)
    const now = Date.now();
    seedQuote(ctx.brokerRepo, 'NSE', 'RELIANCE', 1001, now - 5_000); // fresh (within 120s)
    seedQuote(ctx.brokerRepo, 'NSE', 'TCS', 1002, now - 3_000); // fresh
    seedQuote(ctx.brokerRepo, 'NSE', 'INFY', 1003, now - 2_000); // fresh
    seedQuote(ctx.brokerRepo, 'NSE', 'HDFCBANK', 1004, now - 300_000); // stale (5 min > 120s)

    const snapshot = ctx.service.computeSnapshot();

    expect(snapshot.eligibleCount).toBe(4);
    expect(snapshot.freshQuoteCount).toBe(3);
    expect(snapshot.staleQuoteCount).toBe(1);
    expect(snapshot.missingQuoteCount).toBe(0);
    // freshRatio = 3/4 = 0.75, not >= 0.90, but staleQuoteCount > 0
    // Since freshRatio >= 0.50 → Stale
    expect(snapshot.verdict).toBe(UniverseCoverageVerdict.Stale);

    // The stale member
    const hdfc = snapshot.members.find(m => m.tradingsymbol === 'HDFCBANK')!;
    expect(hdfc.hasQuote).toBe(true);
    expect(hdfc.quoteStalenessMs).toBeGreaterThan(120_000);
  });

  it('should return degraded when most eligible members have no quotes', () => {
    seedInstruments(ctx.brokerRepo, [
      { exchange: 'NSE', tradingsymbol: 'RELIANCE', token: 1001 },
      { exchange: 'NSE', tradingsymbol: 'TCS', token: 1002 },
      { exchange: 'NSE', tradingsymbol: 'INFY', token: 1003 },
      { exchange: 'NSE', tradingsymbol: 'HDFCBANK', token: 1004 },
    ]);

    // Seed quote for only 1 of 4
    seedQuote(ctx.brokerRepo, 'NSE', 'RELIANCE', 1001);

    const snapshot = ctx.service.computeSnapshot();

    expect(snapshot.eligibleCount).toBe(4);
    expect(snapshot.missingQuoteCount).toBe(3);
    expect(snapshot.freshQuoteCount).toBe(1);
    // missingRatio = 3/4 = 0.75 > 0.50 → Degraded
    expect(snapshot.verdict).toBe(UniverseCoverageVerdict.Degraded);
  });
});

describe('UniverseService — threshold transitions', () => {
  let ctx: ReturnType<typeof createService>;

  beforeEach(() => {
    // Use a very strict threshold so we can hit Degraded easily
    ctx = createService({
      sufficientThresholdRatio: 1.0, // require 100% fresh
      maxQuoteStalenessMs: 60_000,
      allowlist: { NSE: ['RELIANCE', 'TCS'] },
    });
  });

  it('should be sufficient when 100% have fresh quotes', () => {
    seedInstruments(ctx.brokerRepo, [
      { exchange: 'NSE', tradingsymbol: 'RELIANCE', token: 1001 },
      { exchange: 'NSE', tradingsymbol: 'TCS', token: 1002 },
    ]);
    seedQuote(ctx.brokerRepo, 'NSE', 'RELIANCE', 1001);
    seedQuote(ctx.brokerRepo, 'NSE', 'TCS', 1002);

    const snapshot = ctx.service.computeSnapshot();
    expect(snapshot.verdict).toBe(UniverseCoverageVerdict.Sufficient);
  });

  it('should be stale when any eligible member has a stale quote', () => {
    seedInstruments(ctx.brokerRepo, [
      { exchange: 'NSE', tradingsymbol: 'RELIANCE', token: 1001 },
      { exchange: 'NSE', tradingsymbol: 'TCS', token: 1002 },
    ]);
    const now = Date.now();
    seedQuote(ctx.brokerRepo, 'NSE', 'RELIANCE', 1001, now - 5_000); // fresh
    seedQuote(ctx.brokerRepo, 'NSE', 'TCS', 1002, now - 120_000); // stale (2min > 60s)

    const snapshot = ctx.service.computeSnapshot();
    // freshRatio = 1/2 = 0.50, not >= 1.0, not >= 0.50 (... actually it is >= 0.50)
    // Wait: freshRatio = 1/2 = 0.5, so freshRatio >= 0.50 → Stale
    expect(snapshot.verdict).toBe(UniverseCoverageVerdict.Stale);
    expect(snapshot.staleQuoteCount).toBe(1);
  });

  it('should be stale when not 100% have quotes', () => {
    seedInstruments(ctx.brokerRepo, [
      { exchange: 'NSE', tradingsymbol: 'RELIANCE', token: 1001 },
      { exchange: 'NSE', tradingsymbol: 'TCS', token: 1002 },
    ]);
    seedQuote(ctx.brokerRepo, 'NSE', 'RELIANCE', 1001);
    // TCS has no quote

    const snapshot = ctx.service.computeSnapshot();
    // freshRatio = 1/2 = 0.50, >= 0.50 → Stale
    expect(snapshot.verdict).toBe(UniverseCoverageVerdict.Stale);
    expect(snapshot.missingQuoteCount).toBe(1);
  });
});

describe('UniverseService — empty / edge cases', () => {
  it('should handle empty allowlist gracefully', () => {
    const ctx = createService({
      allowlist: { NSE: [] },
    });

    // No eligible symbols defined
    seedInstruments(ctx.brokerRepo, [
      { exchange: 'NSE', tradingsymbol: 'RELIANCE', token: 1001 },
    ]);

    const snapshot = ctx.service.computeSnapshot();

    expect(snapshot.eligibleCount).toBe(0);
    // The ineligible should include RELIANCE since it's in the instrument master
    // but not in the allowlist
    expect(snapshot.ineligibleCount).toBe(1);
    expect(snapshot.verdict).toBe(UniverseCoverageVerdict.Degraded);
  });

  it('should return null coverage summary when no snapshot exists', () => {
    const ctx = createService();
    expect(ctx.service.getCoverageSummary()).toBeNull();
  });

  it('should provide policy access', () => {
    const ctx = createService();
    const policy = ctx.service.getPolicy();
    expect(policy.version).toBeTruthy();
    expect(policy.allowlist['NSE']).toBeDefined();
  });

  it('should return recent snapshots via getRecentSnapshots', () => {
    const ctx = createService();
    seedInstruments(ctx.brokerRepo, [
      { exchange: 'NSE', tradingsymbol: 'RELIANCE', token: 1001 },
    ]);
    seedQuote(ctx.brokerRepo, 'NSE', 'RELIANCE', 1001);

    ctx.service.computeSnapshot();
    ctx.service.computeSnapshot();
    ctx.service.computeSnapshot();

    const recent = ctx.service.getRecentSnapshots(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].id).toBeGreaterThan(recent[1].id);
  });
});
