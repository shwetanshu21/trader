import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ProposalStatus,
  ValidationReasonCode,
  MarketPhase,
  ZerodhaSessionState,
  type NewProposalAttempt,
} from '../src/types/runtime.js';
import { IndiaProposalValidator } from '../src/proposals/india-validator.js';
import type { InstrumentRecord, QuoteSnapshot, InstrumentSyncState } from '../src/integrations/zerodha/types.js';
import type { MarketProfile, MarketCalendar } from '../src/market/market-profile.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createValidator(config?: { quoteStalenessMs?: number; instrumentStalenessMs?: number }) {
  return new IndiaProposalValidator(config);
}

function sampleEqProposal(overrides?: Partial<NewProposalAttempt>): NewProposalAttempt {
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
    proposalStatus: ProposalStatus.Pending,
    createdAt: Date.now(),
    ...overrides,
  };
}

function sampleNfoProposal(overrides?: Partial<NewProposalAttempt>): NewProposalAttempt {
  return {
    exchange: 'NFO',
    tradingsymbol: 'BANKNIFTY24DEC50000CE',
    instrumentToken: 789012,
    side: 'sell',
    product: 'NRML',
    quantity: 25, // lot size 25
    price: 150.50,
    triggerPrice: null,
    orderType: 'LIMIT',
    tag: 'weekly-expiry',
    proposalStatus: ProposalStatus.Pending,
    createdAt: Date.now(),
    ...overrides,
  };
}

function sampleEqInstrument(overrides?: Partial<InstrumentRecord>): InstrumentRecord {
  return {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    name: 'RELIANCE INDUSTRIES LTD',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    instrumentType: 'EQ',
    segment: 'NSE',
    exchangeToken: 1234,
    ...overrides,
  };
}

function sampleNfoInstrument(overrides?: Partial<InstrumentRecord>): InstrumentRecord {
  return {
    exchange: 'NFO',
    tradingsymbol: 'BANKNIFTY24DEC50000CE',
    instrumentToken: 789012,
    name: 'BANKNIFTY',
    expiry: '2024-12-26',
    strike: 50000,
    lotSize: 25,
    tickSize: 0.05,
    instrumentType: 'CE',
    segment: 'NFO',
    exchangeToken: 7891,
    ...overrides,
  };
}

function sampleQuote(overrides?: Partial<QuoteSnapshot>): QuoteSnapshot {
  return {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    lastPrice: 2950.00,
    change: 15.50,
    changePercent: 0.53,
    volume: 1_000_000,
    oi: null,
    high: 2960.00,
    low: 2930.00,
    open: 2940.00,
    close: 2934.50,
    bid: 2949.50,
    ask: 2950.00,
    priceTimestamp: Math.floor(Date.now() / 1000),
    receivedAt: Date.now(),
    ...overrides,
  };
}

function sampleSyncState(overrides?: Partial<InstrumentSyncState>): InstrumentSyncState {
  return {
    lastSuccessAt: Date.now(),
    lastInstrumentCount: 5000,
    lastSkippedCount: 12,
    lastStatus: 'success',
    lastError: null,
    ...overrides,
  };
}

function configuredSession(overrides?: {
  state?: ZerodhaSessionState;
  expiresAt?: number;
}): { state: ZerodhaSessionState; expiresAt: number } {
  return {
    state: overrides?.state ?? ZerodhaSessionState.Authenticated,
    expiresAt: overrides?.expiresAt ?? Date.now() + 86_400_000, // 24h from now
  };
}

/** Stub market profile for pre-market NFO tests. */
const preMarketProfiles = createPreMarketProfiles();

function createPreMarketProfiles(): readonly MarketProfile[] {
  const baseProfile: MarketProfile = {
    marketId: 'INDIA_NSE_EQ',
    displayName: 'NSE India Equities',
    timezone: 'Asia/Kolkata',
    regularSession: { open: '09:15', close: '15:30' },
    preMarketSession: { open: '09:00', close: '09:15' },
    postMarketSession: { open: '15:30', close: '16:00' },
    settlementCycle: 'T+1',
    lotSizeType: 'exchange_defined',
    maxOrdersPerSecond: 10,
    extendedHoursAllowed: false,
    observesDst: false,
    calendar: makeCalendar(),
    getPhase() { return MarketPhase.PreMarket; },
    isTradingDay() { return true; },
  };

  const foProfile: MarketProfile = {
    ...baseProfile,
    marketId: 'INDIA_NSE_FO',
    displayName: 'NSE India F&O',
    settlementCycle: 'T+2',
  };

  return [baseProfile, foProfile];
}

function makeCalendar(): MarketCalendar {
  return {
    getHoliday() { return null; },
    listHolidays() { return []; },
  };
}

const closedMarketProfiles: readonly MarketProfile[] = [
  {
    marketId: 'INDIA_NSE_EQ',
    displayName: 'NSE India Equities',
    timezone: 'Asia/Kolkata',
    regularSession: { open: '09:15', close: '15:30' },
    preMarketSession: null,
    postMarketSession: null,
    settlementCycle: 'T+1',
    lotSizeType: 'exchange_defined',
    maxOrdersPerSecond: 10,
    extendedHoursAllowed: false,
    observesDst: false,
    calendar: makeCalendar(),
    getPhase() { return MarketPhase.Closed; },
    isTradingDay() { return true; },
  },
  {
    marketId: 'INDIA_NSE_FO',
    displayName: 'NSE India F&O',
    timezone: 'Asia/Kolkata',
    regularSession: { open: '09:15', close: '15:30' },
    preMarketSession: null,
    postMarketSession: null,
    settlementCycle: 'T+2',
    lotSizeType: 'exchange_defined',
    maxOrdersPerSecond: 10,
    extendedHoursAllowed: false,
    observesDst: false,
    calendar: makeCalendar(),
    getPhase() { return MarketPhase.Closed; },
    isTradingDay() { return true; },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IndiaProposalValidator', () => {
  describe('session validation', () => {
    it('returns accepted when session is authenticated and within expiry', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
      expect(result.reasons).toEqual([]);
    });

    it('refuses when session has missing credentials', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: { state: ZerodhaSessionState.MissingCredentials, expiresAt: 0 },
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.SessionNotAuthenticated)).toBe(true);
    });

    it('refuses when session auth failed', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: { state: ZerodhaSessionState.AuthFailed, expiresAt: 0 },
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.SessionNotAuthenticated)).toBe(true);
    });

    it('refuses when session is expired', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: { state: ZerodhaSessionState.Expired, expiresAt: 0 },
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.SessionExpired)).toBe(true);
    });

    it('refuses when token has zero remaining time', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: { state: ZerodhaSessionState.Authenticated, expiresAt: Date.now() - 1000 },
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.SessionExpired)).toBe(true);
    });

    it('refuses when token expires imminently (< 5 min)', () => {
      const validator = createValidator();
      // Expires 2 min from now
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: { state: ZerodhaSessionState.Authenticated, expiresAt: Date.now() + 120_000 },
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      const expiryReason = result.reasons.find(r => r.reasonCode === ValidationReasonCode.SessionExpired);
      expect(expiryReason).toBeDefined();
    });

    it('skips session checks when sessionHealth is null (Zerodha not configured)', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: null,
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      // No session reason; other checks pass
      expect(result.reasons.some(r =>
        r.reasonCode === ValidationReasonCode.SessionNotAuthenticated ||
        r.reasonCode === ValidationReasonCode.SessionExpired,
      )).toBe(false);
      expect(result.status).toBe(ProposalStatus.Accepted);
    });
  });

  describe('exchange and product validation', () => {
    it('refuses unsupported exchange', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ exchange: 'BSE' }),
        sessionHealth: configuredSession(),
        instrument: null,
        quote: null,
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.InvalidSegment)).toBe(true);
    });

    it('refuses empty exchange', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ exchange: '' }),
        sessionHealth: configuredSession(),
        instrument: null,
        quote: null,
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.InvalidSegment)).toBe(true);
    });

    it('refuses invalid product for NSE (NRML not allowed)', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ product: 'NRML' }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.MissingProduct)).toBe(true);
    });

    it('refuses invalid product for NFO (CNC not allowed)', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleNfoProposal({ product: 'CNC' }),
        sessionHealth: configuredSession(),
        instrument: sampleNfoInstrument(),
        quote: sampleQuote({
          exchange: 'NFO',
          tradingsymbol: 'BANKNIFTY24DEC50000CE',
          instrumentToken: 789012,
        }),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.MissingProduct)).toBe(true);
    });

    it('accepts CNC product for NSE', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ product: 'CNC' }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
    });

    it('accepts MRML product for NFO', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleNfoProposal({ product: 'NRML' }),
        sessionHealth: configuredSession(),
        instrument: sampleNfoInstrument(),
        quote: sampleQuote({
          exchange: 'NFO',
          tradingsymbol: 'BANKNIFTY24DEC50000CE',
          instrumentToken: 789012,
        }),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
    });
  });

  describe('side validation', () => {
    it('refuses empty side', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ side: '' }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.MissingSide)).toBe(true);
    });

    it('refuses invalid side', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ side: 'hold' }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.MissingSide)).toBe(true);
    });

    it('accepts buy and sell', () => {
      const validator = createValidator();
      const buy = validator.validate({
        proposal: sampleEqProposal({ side: 'buy' }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });
      expect(buy.status).toBe(ProposalStatus.Accepted);

      const sell = validator.validate({
        proposal: sampleEqProposal({ side: 'sell' }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });
      expect(sell.status).toBe(ProposalStatus.Accepted);
    });
  });

  describe('order type validation', () => {
    it('refuses unsupported order type', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ orderType: 'BO' }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.InvalidOrderType)).toBe(true);
    });

    it('accepts all valid order types', () => {
      const validator = createValidator();
      const validTypes = ['MARKET', 'LIMIT', 'SL', 'SLM'];

      for (const orderType of validTypes) {
        const result = validator.validate({
          proposal: sampleEqProposal({ orderType }),
          sessionHealth: configuredSession(),
          instrument: sampleEqInstrument(),
          quote: sampleQuote(),
          syncState: sampleSyncState(),
          marketPhase: MarketPhase.Regular,
        });
        expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.InvalidOrderType)).toBe(false);
      }
    });
  });

  describe('instrument validation', () => {
    it('refuses when instrument not found', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: configuredSession(),
        instrument: null,
        quote: null,
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.InstrumentLookupFailed)).toBe(true);
    });

    it('refuses when instrument sync never completed', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: { lastSuccessAt: null, lastInstrumentCount: null, lastSkippedCount: null, lastStatus: null, lastError: null },
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.InstrumentStale)).toBe(true);
    });

    it('refuses when instrument sync is stale', () => {
      const validator = createValidator({ instrumentStalenessMs: 86_400_000 });
      const staleSync = sampleSyncState({
        lastSuccessAt: Date.now() - 200_000_000, // ~2.3 days
      });

      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: staleSync,
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.InstrumentStale)).toBe(true);
    });

    it('refuses when last sync failed', () => {
      const validator = createValidator();
      const failedSync = sampleSyncState({
        lastSuccessAt: Date.now(),
        lastStatus: 'failed' as const,
        lastError: 'Network error',
      });

      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: failedSync,
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.InstrumentStale)).toBe(true);
    });
  });

  describe('quote validation', () => {
    it('refuses when quote is missing', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: null,
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.QuoteMissing)).toBe(true);
    });

    it('refuses when quote is stale', () => {
      const validator = createValidator({ quoteStalenessMs: 60_000 });
      const staleQuote = sampleQuote({
        receivedAt: Date.now() - 300_000, // 5 min old
      });

      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: staleQuote,
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.QuoteStale)).toBe(true);
    });

    it('accepts fresh quote within tolerance', () => {
      const validator = createValidator({ quoteStalenessMs: 60_000 });
      const freshQuote = sampleQuote({
        receivedAt: Date.now() - 10_000, // 10s old
      });

      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: freshQuote,
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
    });
  });

  describe('market phase validation', () => {
    it('refuses when market is closed', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Closed,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.MarketClosed)).toBe(true);
    });

    it('refuses during post-market', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.PostMarket,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.MarketClosed)).toBe(true);
    });

    it('accepts during pre-market for EQ', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.PreMarket,
        marketProfiles: preMarketProfiles,
      });

      // Pre-market EQ is allowed
      const marketClosed = result.reasons.find(r => r.reasonCode === ValidationReasonCode.MarketClosed);
      expect(marketClosed).toBeUndefined();
    });

    it('refuses NFO during pre-market', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleNfoProposal(),
        sessionHealth: configuredSession(),
        instrument: sampleNfoInstrument(),
        quote: sampleQuote({
          exchange: 'NFO',
          tradingsymbol: 'BANKNIFTY24DEC50000CE',
          instrumentToken: 789012,
        }),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.PreMarket,
        marketProfiles: preMarketProfiles,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.MarketClosed)).toBe(true);
    });

    it('accepts during regular market', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
    });
  });

  describe('cross-market profile mismatch', () => {
    it('refuses when no market profile matches instrument segment', () => {
      const emptyProfiles: readonly MarketProfile[] = [];
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal(),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
        marketProfiles: emptyProfiles,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.CrossMarketMismatch)).toBe(true);
    });
  });

  describe('quantity validation', () => {
    it('refuses zero quantity', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ quantity: 0 }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.ZeroQuantity)).toBe(true);
    });

    it('refuses negative quantity', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ quantity: -5 }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.ZeroQuantity)).toBe(true);
    });

    it('refuses non-integer quantity', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ quantity: 2.5 }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.ZeroQuantity)).toBe(true);
    });

    it('refuses NFO quantity not multiple of lot size', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleNfoProposal({ quantity: 10 }), // lot size is 25
        sessionHealth: configuredSession(),
        instrument: sampleNfoInstrument(),
        quote: sampleQuote({
          exchange: 'NFO',
          tradingsymbol: 'BANKNIFTY24DEC50000CE',
          instrumentToken: 789012,
        }),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.LotSizeMismatch)).toBe(true);
    });

    it('accepts NFO quantity that is exact lot size multiple', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleNfoProposal({ quantity: 25 }), // 1x lot of 25
        sessionHealth: configuredSession(),
        instrument: sampleNfoInstrument(),
        quote: sampleQuote({
          exchange: 'NFO',
          tradingsymbol: 'BANKNIFTY24DEC50000CE',
          instrumentToken: 789012,
        }),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
    });

    it('accepts NFO quantity that is multiple lot size', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleNfoProposal({ quantity: 75 }), // 3x lot of 25
        sessionHealth: configuredSession(),
        instrument: sampleNfoInstrument(),
        quote: sampleQuote({
          exchange: 'NFO',
          tradingsymbol: 'BANKNIFTY24DEC50000CE',
          instrumentToken: 789012,
        }),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
    });

    it('refuses NFO quantity with insufficient lot size metadata', () => {
      const validator = createValidator();
      const badInstrument = sampleNfoInstrument({ lotSize: 0 });

      const result = validator.validate({
        proposal: sampleNfoProposal({ quantity: 25 }),
        sessionHealth: configuredSession(),
        instrument: badInstrument,
        quote: sampleQuote({
          exchange: 'NFO',
          tradingsymbol: 'BANKNIFTY24DEC50000CE',
          instrumentToken: 789012,
        }),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.InsufficientMetadata)).toBe(true);
    });

    it('accepts EQ quantity with value 1', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ quantity: 1 }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
    });

    it('accepts EQ with larger quantity', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ quantity: 100 }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
    });
  });

  describe('tick-size rounding', () => {
    it('accepts MARKET order without price checking', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ orderType: 'MARKET', price: null }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
    });

    it('accepts price rounded to tick size', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ orderType: 'LIMIT', price: 2950.00 }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
    });

    it('accepts price at tick boundary (0.05 tick)', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ orderType: 'LIMIT', price: 2950.05 }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
    });

    it('refuses price not rounded to tick size', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ orderType: 'LIMIT', price: 2950.07 }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.PriceNotRounded)).toBe(true);
    });

    it('refuses zero price', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ orderType: 'LIMIT', price: 0 }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.PriceNotRounded)).toBe(true);
    });

    it('refuses negative price', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ orderType: 'LIMIT', price: -10 }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.PriceNotRounded)).toBe(true);
    });

    it('checks trigger price rounding for SL orders', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({
          orderType: 'SL',
          price: 2550.00,
          triggerPrice: 2540.07, // Not rounded
        }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.PriceNotRounded)).toBe(true);
    });

    it('refuses with insufficient tick size metadata', () => {
      const validator = createValidator();
      const badInstrument = sampleNfoInstrument({ tickSize: 0 });

      const result = validator.validate({
        proposal: sampleNfoProposal({ orderType: 'LIMIT', price: 150.50 }),
        sessionHealth: configuredSession(),
        instrument: badInstrument,
        quote: sampleQuote({
          exchange: 'NFO',
          tradingsymbol: 'BANKNIFTY24DEC50000CE',
          instrumentToken: 789012,
        }),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.InsufficientMetadata)).toBe(true);
    });
  });

  describe('NFO expiry requirements', () => {
    it('refuses NFO instrument without expiry in metadata', () => {
      const validator = createValidator();
      const noExpiryInstrument = sampleNfoInstrument({ expiry: null });

      const result = validator.validate({
        proposal: sampleNfoProposal(),
        sessionHealth: configuredSession(),
        instrument: noExpiryInstrument,
        quote: sampleQuote({
          exchange: 'NFO',
          tradingsymbol: 'BANKNIFTY24DEC50000CE',
          instrumentToken: 789012,
        }),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Refused);
      expect(result.reasons.some(r => r.reasonCode === ValidationReasonCode.MissingExpiry)).toBe(true);
    });

    it('accepts NFO instrument with valid expiry', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleNfoProposal(),
        sessionHealth: configuredSession(),
        instrument: sampleNfoInstrument({ expiry: '2024-12-26' }),
        quote: sampleQuote({
          exchange: 'NFO',
          tradingsymbol: 'BANKNIFTY24DEC50000CE',
          instrumentToken: 789012,
        }),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
    });
  });

  describe('validation reason ordering and determinism', () => {
    it('produces identical results for identical inputs', () => {
      const validator = createValidator();
      const input = {
        proposal: sampleEqProposal({
          exchange: 'NSE',
          tradingsymbol: 'RELIANCE',
          side: 'buy',
          product: 'MIS',
          quantity: 1,
          orderType: 'LIMIT',
          price: 2950.00,
        }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      };

      const r1 = validator.validate(input);
      const r2 = validator.validate(input);

      expect(r1.status).toBe(r2.status);
      expect(r1.reasons.length).toBe(r2.reasons.length);
      for (let i = 0; i < r1.reasons.length; i++) {
        expect(r1.reasons[i].reasonCode).toBe(r2.reasons[i].reasonCode);
        expect(r1.reasons[i].reasonMessage).toBe(r2.reasons[i].reasonMessage);
      }
    });

    it('orders reasons consistently (session before exchange before instrument)', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ exchange: 'BSE', product: 'NRML', side: 'buy', quantity: 0 }),
        sessionHealth: { state: ZerodhaSessionState.Expired, expiresAt: 0 },
        instrument: null,
        quote: null,
        syncState: sampleSyncState({ lastSuccessAt: null }),
        marketPhase: MarketPhase.Closed,
      });

      // Should have: SessionExpired, InvalidSegment, MissingProduct, ZeroQuantity, InstrumentLookupFailed, InstrumentStale, MarketClosed
      // Session checks come first
      expect(result.reasons.length).toBeGreaterThanOrEqual(4);
      const codes = result.reasons.map(r => r.reasonCode);
      const sessionIdx = codes.findIndex(c => c === ValidationReasonCode.SessionExpired);
      const segmentIdx = codes.findIndex(c => c === ValidationReasonCode.InvalidSegment);
      const instrumentIdx = codes.findIndex(c => c === ValidationReasonCode.InstrumentLookupFailed);

      expect(sessionIdx).toBeLessThan(segmentIdx);
      expect(segmentIdx).toBeLessThan(instrumentIdx);
    });
  });

  describe('NFO success path (full valid proposal)', () => {
    it('validates a complete valid NFO proposal', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleNfoProposal({
          quantity: 50, // 2x lot of 25
          price: 150.50,
          orderType: 'LIMIT',
          product: 'NRML',
        }),
        sessionHealth: configuredSession(),
        instrument: sampleNfoInstrument({
          lotSize: 25,
          tickSize: 0.05,
        }),
        quote: sampleQuote({
          exchange: 'NFO',
          tradingsymbol: 'BANKNIFTY24DEC50000CE',
          instrumentToken: 789012,
          lastPrice: 152.00,
        }),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
      expect(result.reasons).toEqual([]);
    });
  });

  describe('EQ success path (market order, minimal)', () => {
    it('validates a minimal valid EQ market proposal', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({
          quantity: 1,
          orderType: 'MARKET',
          price: null,
          product: 'MIS',
        }),
        sessionHealth: configuredSession(),
        instrument: sampleEqInstrument(),
        quote: sampleQuote(),
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      expect(result.status).toBe(ProposalStatus.Accepted);
      expect(result.reasons).toEqual([]);
    });
  });

  describe('quote checks skip when instrument is null', () => {
    it('does not emit quote_missing when instrument is already null', () => {
      const validator = createValidator();
      const result = validator.validate({
        proposal: sampleEqProposal({ exchange: 'NSE' }),
        sessionHealth: configuredSession(),
        instrument: null,
        quote: null,
        syncState: sampleSyncState(),
        marketPhase: MarketPhase.Regular,
      });

      // Should NOT have quote-related reasons since instrument is null
      expect(result.reasons.some(r =>
        r.reasonCode === ValidationReasonCode.QuoteMissing,
      )).toBe(false);
      expect(result.reasons.some(r =>
        r.reasonCode === ValidationReasonCode.InstrumentLookupFailed,
      )).toBe(true);
    });
  });
});
