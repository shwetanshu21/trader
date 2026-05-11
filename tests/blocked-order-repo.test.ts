import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import { BlockedOrderRepository } from '../src/persistence/blocked-order-repo.js';
import {
  BlockCode,
  ProposalStatus,
  type NewBlockedOrder,
  type NewProposalAttempt,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestContext {
  proposalRepo: ProposalRepository;
  blockedRepo: BlockedOrderRepository;
  db: Database.Database;
}

function createContext(): TestContext {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;
  return {
    proposalRepo: new ProposalRepository(db),
    blockedRepo: new BlockedOrderRepository(db),
    db,
  };
}

function sampleAcceptedAttempt(overrides?: Partial<NewProposalAttempt>): NewProposalAttempt {
  return {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    side: 'buy',
    product: 'MIS',
    quantity: 1,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: null,
    proposalStatus: ProposalStatus.Accepted,
    createdAt: Date.now(),
    ...overrides,
  };
}

function sampleRefusedAttempt(overrides?: Partial<NewProposalAttempt>): NewProposalAttempt {
  return {
    exchange: 'NFO',
    tradingsymbol: 'BANKNIFTY24DEC50000CE',
    instrumentToken: 789012,
    side: 'sell',
    product: 'NRML',
    quantity: 25,
    price: 150.50,
    triggerPrice: null,
    orderType: 'LIMIT',
    tag: 'weekly-expiry',
    proposalStatus: ProposalStatus.Refused,
    createdAt: Date.now(),
    ...overrides,
  };
}

function sampleSkippedAttempt(overrides?: Partial<NewProposalAttempt>): NewProposalAttempt {
  return {
    exchange: 'NSE',
    tradingsymbol: 'TCS',
    instrumentToken: 654321,
    side: 'buy',
    product: 'CNC',
    quantity: 10,
    price: 3500.00,
    triggerPrice: null,
    orderType: 'LIMIT',
    tag: 'overlap-skip',
    proposalStatus: ProposalStatus.Skipped,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeBlockedOrder(
  proposalAttemptId: number,
  overrides?: Partial<NewBlockedOrder>,
): NewBlockedOrder {
  return {
    proposalAttemptId,
    blockedAt: Date.now(),
    blockCode: BlockCode.MilestoneExecutionBlockM001,
    blockMessage: 'M001 hard block: live order placement is disabled for this milestone',
    gateTag: 'M001-hard-block',
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    side: 'buy',
    product: 'MIS',
    quantity: 1,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// BlockedOrderRepository
// ---------------------------------------------------------------------------

describe('BlockedOrderRepository', () => {
  describe('insertBlockedOrder', () => {
    it('inserts and returns a blocked-order row for an accepted proposal', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const proposal = proposalRepo.insertAttempt(sampleAcceptedAttempt());

      const blocked = blockedRepo.insertBlockedOrder(
        makeBlockedOrder(proposal.id),
      );

      expect(blocked.id).toBeGreaterThan(0);
      expect(blocked.proposalAttemptId).toBe(proposal.id);
      expect(blocked.blockCode).toBe(BlockCode.MilestoneExecutionBlockM001);
      expect(blocked.blockMessage).toContain('M001 hard block');
      expect(blocked.gateTag).toBe('M001-hard-block');
      expect(blocked.blockedAt).toBeGreaterThan(0);
      expect(blocked.exchange).toBe('NSE');
      expect(blocked.tradingsymbol).toBe('RELIANCE');
      expect(blocked.side).toBe('buy');
      expect(blocked.product).toBe('MIS');
      expect(blocked.quantity).toBe(1);
      expect(blocked.price).toBeNull();
      expect(blocked.triggerPrice).toBeNull();
      expect(blocked.orderType).toBe('MARKET');
      expect(blockedRepo.count()).toBe(1);
    });

    it('stores proposal snapshot fields faithfully at block time', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const proposal = proposalRepo.insertAttempt(sampleAcceptedAttempt({
        exchange: 'NFO',
        tradingsymbol: 'SENSEX24DEC55000CE',
        instrumentToken: 999888,
        side: 'sell',
        product: 'NRML',
        quantity: 50,
        price: 250.75,
        triggerPrice: null,
        orderType: 'LIMIT',
      }));

      const blocked = blockedRepo.insertBlockedOrder(
        makeBlockedOrder(proposal.id, {
          exchange: 'NFO',
          tradingsymbol: 'SENSEX24DEC55000CE',
          instrumentToken: 999888,
          side: 'sell',
          product: 'NRML',
          quantity: 50,
          price: 250.75,
          triggerPrice: null,
          orderType: 'LIMIT',
        }),
      );

      expect(blocked.exchange).toBe('NFO');
      expect(blocked.tradingsymbol).toBe('SENSEX24DEC55000CE');
      expect(blocked.instrumentToken).toBe(999888);
      expect(blocked.side).toBe('sell');
      expect(blocked.product).toBe('NRML');
      expect(blocked.quantity).toBe(50);
      expect(blocked.price).toBe(250.75);
      expect(blocked.orderType).toBe('LIMIT');
    });

    it('stores SL order snapshot fields (price + triggerPrice)', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const proposal = proposalRepo.insertAttempt(sampleAcceptedAttempt({
        orderType: 'SL',
        price: 2550,
        triggerPrice: 2540,
      }));

      const blocked = blockedRepo.insertBlockedOrder(
        makeBlockedOrder(proposal.id, {
          price: 2550,
          triggerPrice: 2540,
          orderType: 'SL',
        }),
      );

      expect(blocked.price).toBe(2550);
      expect(blocked.triggerPrice).toBe(2540);
      expect(blocked.orderType).toBe('SL');
    });
  });

  describe('idempotent insert — UNIQUE(proposal_attempt_id)', () => {
    it('returns existing row on duplicate insert instead of crashing', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const proposal = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'IDEMPOTENT' }));

      const first = blockedRepo.insertBlockedOrder(
        makeBlockedOrder(proposal.id),
      );
      const second = blockedRepo.insertBlockedOrder(
        makeBlockedOrder(proposal.id),
      );

      // Both should return a row with the same id (first write wins)
      expect(first.id).toBeGreaterThan(0);
      expect(second.id).toBe(first.id);
      expect(second.proposalAttemptId).toBe(proposal.id);
      expect(blockedRepo.count()).toBe(1);
    });

    it('does not increment row count on repeated insert attempts', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const proposal = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'DUP_COUNT' }));

      blockedRepo.insertBlockedOrder(makeBlockedOrder(proposal.id));
      blockedRepo.insertBlockedOrder(makeBlockedOrder(proposal.id));
      blockedRepo.insertBlockedOrder(makeBlockedOrder(proposal.id));

      expect(blockedRepo.count()).toBe(1);
    });

    it('allows distinct proposals to each create their own blocked row', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const p1 = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'DISTINCT_A' }));
      const p2 = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'DISTINCT_B' }));

      const b1 = blockedRepo.insertBlockedOrder(makeBlockedOrder(p1.id));
      const b2 = blockedRepo.insertBlockedOrder(makeBlockedOrder(p2.id));

      expect(b1.id).not.toBe(b2.id);
      expect(blockedRepo.count()).toBe(2);
    });
  });

  describe('getById', () => {
    it('returns null for unknown id', () => {
      const { blockedRepo } = createContext();
      expect(blockedRepo.getById(999)).toBeNull();
    });

    it('returns the blocked-order row by id', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const proposal = proposalRepo.insertAttempt(sampleAcceptedAttempt());
      const inserted = blockedRepo.insertBlockedOrder(makeBlockedOrder(proposal.id));

      const loaded = blockedRepo.getById(inserted.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(inserted.id);
      expect(loaded!.proposalAttemptId).toBe(proposal.id);
      expect(loaded!.blockCode).toBe(BlockCode.MilestoneExecutionBlockM001);
    });
  });

  describe('getByProposalAttemptId', () => {
    it('returns null when no block exists for the proposal', () => {
      const { blockedRepo } = createContext();
      expect(blockedRepo.getByProposalAttemptId(999)).toBeNull();
    });

    it('returns the blocked-order row by proposal attempt id', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const proposal = proposalRepo.insertAttempt(sampleAcceptedAttempt());
      const inserted = blockedRepo.insertBlockedOrder(makeBlockedOrder(proposal.id));

      const loaded = blockedRepo.getByProposalAttemptId(proposal.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(inserted.id);
      expect(loaded!.proposalAttemptId).toBe(proposal.id);
    });
  });

  describe('getRecent', () => {
    it('returns empty array when no blocked orders exist', () => {
      const { blockedRepo } = createContext();
      expect(blockedRepo.getRecent()).toEqual([]);
    });

    it('returns blocked orders newest first', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const p1 = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'FIRST', createdAt: 100 }));
      const p2 = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'SECOND', createdAt: 200 }));

      blockedRepo.insertBlockedOrder(makeBlockedOrder(p1.id, { blockedAt: 100 }));
      blockedRepo.insertBlockedOrder(makeBlockedOrder(p2.id, { blockedAt: 200 }));

      const recent = blockedRepo.getRecent();
      expect(recent.length).toBe(2);
      expect(recent[0].proposalAttemptId).toBe(p2.id);
      expect(recent[1].proposalAttemptId).toBe(p1.id);
    });

    it('respects limit parameter', () => {
      const { proposalRepo, blockedRepo } = createContext();
      for (let i = 0; i < 5; i++) {
        const p = proposalRepo.insertAttempt(
          sampleAcceptedAttempt({ tradingsymbol: `SYM_${i}`, createdAt: i }),
        );
        blockedRepo.insertBlockedOrder(makeBlockedOrder(p.id, { blockedAt: i }));
      }

      expect(blockedRepo.getRecent(2).length).toBe(2);
      expect(blockedRepo.getRecent(10).length).toBe(5);
    });
  });

  describe('getAcceptedUnblockedAttempts', () => {
    it('returns empty array when no proposals exist', () => {
      const { blockedRepo } = createContext();
      expect(blockedRepo.getAcceptedUnblockedAttempts()).toEqual([]);
    });

    it('returns accepted proposals not yet blocked', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const p1 = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'UNBLOCKED', createdAt: 100 }));

      const unblocked = blockedRepo.getAcceptedUnblockedAttempts();
      expect(unblocked.length).toBe(1);
      expect(unblocked[0].proposalAttemptId).toBe(p1.id);
      expect(unblocked[0].tradingsymbol).toBe('UNBLOCKED');
    });

    it('excludes accepted proposals that are already blocked', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const p1 = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'BLOCKED', createdAt: 100 }));
      blockedRepo.insertBlockedOrder(makeBlockedOrder(p1.id));

      const unblocked = blockedRepo.getAcceptedUnblockedAttempts();
      expect(unblocked.length).toBe(0);
    });

    it('excludes refused proposals', () => {
      const { proposalRepo, blockedRepo } = createContext();
      proposalRepo.insertAttempt(sampleRefusedAttempt({ tradingsymbol: 'REFUSED', createdAt: 100 }));

      const unblocked = blockedRepo.getAcceptedUnblockedAttempts();
      expect(unblocked.length).toBe(0);
    });

    it('excludes skipped proposals', () => {
      const { proposalRepo, blockedRepo } = createContext();
      proposalRepo.insertAttempt(sampleSkippedAttempt({ tradingsymbol: 'SKIPPED', createdAt: 100 }));

      const unblocked = blockedRepo.getAcceptedUnblockedAttempts();
      expect(unblocked.length).toBe(0);
    });

    it('returns only unblocked accepted proposals when mixed with blocked/refused/skipped', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const pAccepted = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'ACCEPTED_READY', createdAt: 100 }));
      const pBlocked = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'ACCEPTED_BLOCKED', createdAt: 200 }));
      proposalRepo.insertAttempt(sampleRefusedAttempt({ tradingsymbol: 'REFUSED', createdAt: 300 }));
      proposalRepo.insertAttempt(sampleSkippedAttempt({ tradingsymbol: 'SKIPPED', createdAt: 400 }));

      // Block one of the accepted
      blockedRepo.insertBlockedOrder(makeBlockedOrder(pBlocked.id));

      const unblocked = blockedRepo.getAcceptedUnblockedAttempts();
      expect(unblocked.length).toBe(1);
      expect(unblocked[0].proposalAttemptId).toBe(pAccepted.id);
      expect(unblocked[0].tradingsymbol).toBe('ACCEPTED_READY');
    });

    it('returns proposals ordered by created_at ASC (oldest first)', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const p1 = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'OLD', createdAt: 100 }));
      const p2 = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'MID', createdAt: 200 }));
      const p3 = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'NEW', createdAt: 300 }));

      const unblocked = blockedRepo.getAcceptedUnblockedAttempts();
      expect(unblocked.length).toBe(3);
      expect(unblocked[0].proposalAttemptId).toBe(p1.id);
      expect(unblocked[1].proposalAttemptId).toBe(p2.id);
      expect(unblocked[2].proposalAttemptId).toBe(p3.id);
    });

    it('returns snapshot fields for each unblocked proposal', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const p = proposalRepo.insertAttempt(sampleAcceptedAttempt({
        exchange: 'NFO',
        tradingsymbol: 'SNAPSHOT_TEST',
        instrumentToken: 555666,
        side: 'sell',
        product: 'NRML',
        quantity: 75,
        price: 500.00,
        triggerPrice: null,
        orderType: 'LIMIT',
        createdAt: 100,
      }));

      const unblocked = blockedRepo.getAcceptedUnblockedAttempts();
      expect(unblocked.length).toBe(1);
      expect(unblocked[0].exchange).toBe('NFO');
      expect(unblocked[0].tradingsymbol).toBe('SNAPSHOT_TEST');
      expect(unblocked[0].instrumentToken).toBe(555666);
      expect(unblocked[0].side).toBe('sell');
      expect(unblocked[0].product).toBe('NRML');
      expect(unblocked[0].quantity).toBe(75);
      expect(unblocked[0].price).toBe(500.00);
      expect(unblocked[0].orderType).toBe('LIMIT');
    });

    it('respects limit parameter', () => {
      const { proposalRepo, blockedRepo } = createContext();
      for (let i = 0; i < 10; i++) {
        proposalRepo.insertAttempt(
          sampleAcceptedAttempt({ tradingsymbol: `LIMIT_${i}`, createdAt: i }),
        );
      }

      expect(blockedRepo.getAcceptedUnblockedAttempts(3).length).toBe(3);
      expect(blockedRepo.getAcceptedUnblockedAttempts(100).length).toBe(10);
    });
  });

  describe('count', () => {
    it('starts at zero', () => {
      const { blockedRepo } = createContext();
      expect(blockedRepo.count()).toBe(0);
    });

    it('counts multiple blocked orders', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const p1 = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'A' }));
      const p2 = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'B' }));
      const p3 = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'C' }));

      blockedRepo.insertBlockedOrder(makeBlockedOrder(p1.id));
      blockedRepo.insertBlockedOrder(makeBlockedOrder(p2.id));
      blockedRepo.insertBlockedOrder(makeBlockedOrder(p3.id));

      expect(blockedRepo.count()).toBe(3);
    });
  });

  describe('negative tests — malformed inputs', () => {
    it('persists block with empty block_message and gate_tag', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const proposal = proposalRepo.insertAttempt(sampleAcceptedAttempt({ tradingsymbol: 'EMPTY_TAG' }));

      const blocked = blockedRepo.insertBlockedOrder(makeBlockedOrder(proposal.id, {
        blockMessage: '',
        gateTag: '',
      }));

      expect(blocked.id).toBeGreaterThan(0);
      expect(blocked.blockMessage).toBe('');
      expect(blocked.gateTag).toBe('');
    });

    it('persists block with null snapshot prices', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const proposal = proposalRepo.insertAttempt(
        sampleAcceptedAttempt({ tradingsymbol: 'NULL_PRICE', price: null, triggerPrice: null }),
      );

      const blocked = blockedRepo.insertBlockedOrder(makeBlockedOrder(proposal.id, {
        price: null,
        triggerPrice: null,
      }));

      expect(blocked.price).toBeNull();
      expect(blocked.triggerPrice).toBeNull();
    });

    it('persists block with null instrument token', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const proposal = proposalRepo.insertAttempt(
        sampleAcceptedAttempt({ tradingsymbol: 'NULL_TOKEN', instrumentToken: null }),
      );

      const blocked = blockedRepo.insertBlockedOrder(makeBlockedOrder(proposal.id, {
        instrumentToken: null,
      }));

      expect(blocked.instrumentToken).toBeNull();
    });

    it('persists block with zero quantity (defensive — should not occur in practice)', () => {
      const { proposalRepo, blockedRepo } = createContext();
      const proposal = proposalRepo.insertAttempt(
        sampleAcceptedAttempt({ tradingsymbol: 'ZERO_QTY', quantity: 0 }),
      );

      const blocked = blockedRepo.insertBlockedOrder(makeBlockedOrder(proposal.id, {
        quantity: 0,
      }));

      expect(blocked.quantity).toBe(0);
    });
  });
});
