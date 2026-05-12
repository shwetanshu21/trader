// ── UniverseRepository tests ──
// Covers member CRUD, snapshot insert/read, idempotent upserts, pruning, and edge cases.

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { UniverseRepository } from '../src/persistence/universe-repo.js';
import {
  UniverseCoverageVerdict,
  type NewUniverseSnapshot,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRepo(): { repo: UniverseRepository; dbMgr: DatabaseManager } {
  const dbMgr = new DatabaseManager(':memory:');
  const repo = new UniverseRepository(dbMgr.db);
  return { repo, dbMgr };
}

function makeSnapshot(overrides?: Partial<NewUniverseSnapshot>): NewUniverseSnapshot {
  return {
    policyVersion: '1.0.0',
    computedAt: Date.now(),
    verdict: UniverseCoverageVerdict.Sufficient,
    eligibleCount: 3,
    ineligibleCount: 1,
    freshQuoteCount: 3,
    staleQuoteCount: 0,
    missingQuoteCount: 0,
    thresholdLabel: 'fresh≥90%_stale≤120000ms',
    thresholdRatio: 0.9,
    maxStalenessMs: 120_000,
    members: [
      {
        exchange: 'NSE',
        tradingsymbol: 'RELIANCE',
        instrumentToken: 12345,
        isEligible: true,
        hasQuote: true,
        quoteStalenessMs: 5_000,
        lastQuoteAt: Date.now() - 5_000,
        ineligibilityReason: null,
      },
      {
        exchange: 'NSE',
        tradingsymbol: 'TCS',
        instrumentToken: 67890,
        isEligible: true,
        hasQuote: true,
        quoteStalenessMs: 10_000,
        lastQuoteAt: Date.now() - 10_000,
        ineligibilityReason: null,
      },
      {
        exchange: 'NSE',
        tradingsymbol: 'INFY',
        instrumentToken: 11111,
        isEligible: true,
        hasQuote: true,
        quoteStalenessMs: 2_000,
        lastQuoteAt: Date.now() - 2_000,
        ineligibilityReason: null,
      },
      {
        exchange: 'NSE',
        tradingsymbol: 'UNLISTED_CORP',
        instrumentToken: 22222,
        isEligible: false,
        hasQuote: false,
        quoteStalenessMs: 0,
        lastQuoteAt: null,
        ineligibilityReason: 'not_in_allowlist',
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UniverseRepository — member CRUD', () => {
  let repo: UniverseRepository;
  let dbMgr: DatabaseManager;

  beforeEach(() => {
    const created = createRepo();
    repo = created.repo;
    dbMgr = created.dbMgr;
  });

  it('should start with zero members', () => {
    expect(repo.countMembers()).toBe(0);
    expect(repo.getAllMembers()).toEqual([]);
  });

  it('should upsert a member', () => {
    repo.upsertMember('NSE', 'RELIANCE', 'EQ');
    expect(repo.countMembers()).toBe(1);

    const members = repo.getAllMembers();
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      instrumentType: 'EQ',
    });
    expect(members[0].addedAt).toBeGreaterThan(0);
  });

  it('should be idempotent on duplicate upsert (same exchange + tradingsymbol)', () => {
    repo.upsertMember('NSE', 'RELIANCE', 'EQ');
    repo.upsertMember('NSE', 'RELIANCE', 'EQ'); // duplicate
    expect(repo.countMembers()).toBe(1);
  });

  it('should handle multiple members and return deterministic order', () => {
    repo.upsertMember('NSE', 'TCS', 'EQ', 100);
    repo.upsertMember('NSE', 'RELIANCE', 'EQ', 200);
    repo.upsertMember('NSE', 'INFY', 'EQ', 300);

    const members = repo.getAllMembers();
    expect(members).toHaveLength(3);
    // Deterministic: alphabetical by exchange, then tradingsymbol
    expect(members[0].tradingsymbol).toBe('INFY');
    expect(members[1].tradingsymbol).toBe('RELIANCE');
    expect(members[2].tradingsymbol).toBe('TCS');
  });

  it('should remove a member', () => {
    repo.upsertMember('NSE', 'RELIANCE', 'EQ');
    expect(repo.countMembers()).toBe(1);

    repo.removeMember('NSE', 'RELIANCE');
    expect(repo.countMembers()).toBe(0);
  });

  it('should handle remove of non-existent member gracefully', () => {
    repo.removeMember('NSE', 'NONEXISTENT');
    expect(repo.countMembers()).toBe(0);
  });

  it('should clear all members', () => {
    repo.upsertMember('NSE', 'RELIANCE', 'EQ');
    repo.upsertMember('NSE', 'TCS', 'EQ');
    expect(repo.countMembers()).toBe(2);

    repo.clearMembers();
    expect(repo.countMembers()).toBe(0);
  });
});

describe('UniverseRepository — snapshot persistence', () => {
  let repo: UniverseRepository;
  let dbMgr: DatabaseManager;

  beforeEach(() => {
    const created = createRepo();
    repo = created.repo;
    dbMgr = created.dbMgr;
  });

  it('should start with no snapshots', () => {
    expect(repo.getLatestSnapshot()).toBeNull();
    expect(repo.countSnapshots()).toBe(0);
  });

  it('should insert and retrieve a snapshot', () => {
    const snapshot = makeSnapshot();
    const inserted = repo.insertSnapshot(snapshot);

    expect(inserted.id).toBeGreaterThan(0);
    expect(inserted.verdict).toBe(UniverseCoverageVerdict.Sufficient);
    expect(inserted.members).toHaveLength(4);
    expect(inserted.eligibleCount).toBe(3);
    expect(inserted.freshQuoteCount).toBe(3);

    // Retrieve latest
    const latest = repo.getLatestSnapshot();
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(inserted.id);
    expect(latest!.verdict).toBe(UniverseCoverageVerdict.Sufficient);
    expect(latest!.members).toHaveLength(4);
  });

  it('should retrieve multiple snapshots in order', () => {
    const s1 = makeSnapshot({ computedAt: 1000 });
    const s2 = makeSnapshot({ computedAt: 2000 });
    const s3 = makeSnapshot({ computedAt: 3000 });

    repo.insertSnapshot(s1);
    repo.insertSnapshot(s2);
    repo.insertSnapshot(s3);

    expect(repo.countSnapshots()).toBe(3);

    const snapshots = repo.getSnapshots(3);
    expect(snapshots).toHaveLength(3);
    // Newest first
    expect(snapshots[0].computedAt).toBe(3000);
    expect(snapshots[1].computedAt).toBe(2000);
    expect(snapshots[2].computedAt).toBe(1000);
  });

  it('should respect limit on getSnapshots', () => {
    for (let i = 0; i < 5; i++) {
      repo.insertSnapshot(makeSnapshot({ computedAt: i * 1000 }));
    }

    const two = repo.getSnapshots(2);
    expect(two).toHaveLength(2);
  });

  it('should handle degraded verdict snapshots', () => {
    const snapshot = makeSnapshot({
      verdict: UniverseCoverageVerdict.Degraded,
      eligibleCount: 0,
      freshQuoteCount: 0,
      staleQuoteCount: 0,
      missingQuoteCount: 0,
      members: [],
    });

    const inserted = repo.insertSnapshot(snapshot);
    expect(inserted.verdict).toBe(UniverseCoverageVerdict.Degraded);

    const latest = repo.getLatestSnapshot();
    expect(latest!.verdict).toBe(UniverseCoverageVerdict.Degraded);
    expect(latest!.members).toHaveLength(0);
  });

  it('should prune old snapshots keeping only recent N', () => {
    for (let i = 0; i < 10; i++) {
      repo.insertSnapshot(makeSnapshot({ computedAt: i * 1000 }));
    }

    expect(repo.countSnapshots()).toBe(10);

    const deleted = repo.pruneSnapshots(3);
    expect(deleted).toBe(7);
    expect(repo.countSnapshots()).toBe(3);

    // The remaining should be the 3 most recent
    const remaining = repo.getSnapshots(10);
    expect(remaining).toHaveLength(3);
    expect(remaining[0].computedAt).toBe(9000);
    expect(remaining[2].computedAt).toBe(7000);
  });

  it('should survive JSON round-trip for members', () => {
    const snapshot = makeSnapshot();
    const inserted = repo.insertSnapshot(snapshot);
    const latest = repo.getLatestSnapshot()!;

    expect(latest.members).toEqual(snapshot.members);
    expect(latest.members[0].tradingsymbol).toBe('RELIANCE');
    expect(latest.members[3].ineligibilityReason).toBe('not_in_allowlist');
  });
});

describe('UniverseRepository — empty / edge cases', () => {
  let repo: UniverseRepository;
  let dbMgr: DatabaseManager;

  beforeEach(() => {
    const created = createRepo();
    repo = created.repo;
    dbMgr = created.dbMgr;
  });

  it('should handle getSnapshots with limit 0 gracefully', () => {
    const snapshots = repo.getSnapshots(0);
    expect(snapshots).toEqual([]);
  });

  it('should count 0 snapshots after prune on empty table', () => {
    const deleted = repo.pruneSnapshots(10);
    expect(deleted).toBe(0);
  });
});
