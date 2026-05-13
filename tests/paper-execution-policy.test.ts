// ── Paper execution policy unit tests ──
//
// Covers:
//   - Missing quote → refused with StaleOrMissingQuote
//   - Missing instrument → refused with MissingInstrumentData
//   - Stale quote → refused with StaleOrMissingQuote
//   - Buy with valid ask → simulated fill
//   - Buy with lastPrice fallback (no ask) → simulated fill
//   - Buy with no ask and no lastPrice → refused
//   - Sell with valid bid → simulated fill
//   - Sell with lastPrice fallback (no bid) → simulated fill
//   - Sell with no bid and no lastPrice → refused
//   - Buy limit below ask → refused
//   - Buy limit crossing ask → simulated fill
//   - Sell limit above bid → refused
//   - Sell limit crossing bid → simulated fill
//   - Unknown side → refused

import { describe, it, expect } from 'vitest';
import {
  ExecutionOutcomeCode,
  ExecutionRefusalCode,
  type StrategyApprovedCandidate,
} from '../src/types/runtime.js';
import type { QuoteSnapshot, InstrumentRecord } from '../src/integrations/broker/types.js';
import { PaperExecutionPolicy } from '../src/execution/paper-execution-policy.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.now();

function sampleCandidate(overrides?: Partial<StrategyApprovedCandidate>): StrategyApprovedCandidate {
  return {
    id: 1001,
    proposalAttemptId: 42,
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    decidedAt: NOW - 60_000,
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    side: 'buy',
    product: 'MIS',
    quantity: 75,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    lastPrice: 2850.50,
    bid: 2850.00,
    ask: 2851.00,
    notional: 213787.50,
    sizingBasis: 'last_price',
    ...overrides,
  };
}

function sampleQuote(overrides?: Partial<QuoteSnapshot>): QuoteSnapshot {
  return {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    lastPrice: 2850.50,
    change: 10.20,
    changePercent: 0.36,
    volume: 1250000,
    oi: null,
    high: 2860.00,
    low: 2840.00,
    open: 2845.00,
    close: 2840.30,
    bid: 2850.00,
    ask: 2851.00,
    priceTimestamp: Math.floor(NOW / 1000) - 30,
    receivedAt: NOW - 5000,
    ...overrides,
  };
}

function sampleInstrument(overrides?: Partial<InstrumentRecord>): InstrumentRecord {
  return {
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    name: 'RELIANCE INDUSTRIES LTD',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    instrumentType: 'EQ' as any,
    segment: 'NSE_EQ' as any,
    exchangeToken: 12345,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaperExecutionPolicy', () => {
  const policy = new PaperExecutionPolicy();

  describe('quote/instrument validation', () => {
    it('refuses when quote is null', () => {
      const result = policy.evaluate(sampleCandidate(), null, sampleInstrument());
      expect(result.canFill).toBe(false);
      expect(result.outcomeCode).toBe(ExecutionOutcomeCode.PaperRejected);
      expect(result.refusalReasons).toHaveLength(1);
      expect(result.refusalReasons[0].reasonCode).toBe(ExecutionRefusalCode.StaleOrMissingQuote);
    });

    it('refuses when instrument is null', () => {
      const result = policy.evaluate(sampleCandidate(), sampleQuote(), null);
      expect(result.canFill).toBe(false);
      expect(result.outcomeCode).toBe(ExecutionOutcomeCode.PaperRejected);
      expect(result.refusalReasons).toHaveLength(1);
      expect(result.refusalReasons[0].reasonCode).toBe(ExecutionRefusalCode.MissingInstrumentData);
    });

    it('refuses when quote is stale (>5 min)', () => {
      const staleQuote = sampleQuote({ receivedAt: NOW - 6 * 60 * 1000 });
      const result = policy.evaluate(sampleCandidate(), staleQuote, sampleInstrument());
      expect(result.canFill).toBe(false);
      expect(result.refusalReasons[0].reasonCode).toBe(ExecutionRefusalCode.StaleOrMissingQuote);
    });

    it('allows when quote is within staleness threshold', () => {
      const freshQuote = sampleQuote({ receivedAt: NOW - 60_000 });
      const result = policy.evaluate(sampleCandidate(), freshQuote, sampleInstrument());
      expect(result.canFill).toBe(true);
    });

    it('refuses when side is unknown', () => {
      const candidate = sampleCandidate({ side: 'unknown' });
      const result = policy.evaluate(candidate, sampleQuote(), sampleInstrument());
      expect(result.canFill).toBe(false);
      expect(result.refusalReasons).toHaveLength(1);
      expect(result.refusalReasons[0].reasonCode).toBe(ExecutionRefusalCode.StaleOrMissingQuote);
    });
  });

  describe('buy evaluation', () => {
    it('simulates fill for market buy with valid ask', () => {
      const result = policy.evaluate(sampleCandidate(), sampleQuote(), sampleInstrument());
      expect(result.canFill).toBe(true);
      expect(result.outcomeCode).toBe(ExecutionOutcomeCode.PaperSimulated);
      // Market order with valid ask: fillPrice = quote.ask = 2851
      expect(result.fillPrice).toBeCloseTo(2851.00);
      expect(result.simulatedBrokerOrderId).toContain('paper-');
      expect(result.simulatedBrokerOrderId).toContain('-buy');
      expect(result.refusalReasons).toHaveLength(0);
    });

    it('uses lastPrice as fallback when ask is null', () => {
      const quote = sampleQuote({ ask: null, lastPrice: 2845.00 });
      const result = policy.evaluate(sampleCandidate(), quote, sampleInstrument());
      expect(result.canFill).toBe(true);
      expect(result.fillPrice).toBeCloseTo(2845.00);
    });

    it('refuses when both ask and lastPrice are null/zero', () => {
      const quote = sampleQuote({ ask: null, lastPrice: null });
      const result = policy.evaluate(sampleCandidate(), quote, sampleInstrument());
      expect(result.canFill).toBe(false);
      expect(result.refusalReasons[0].reasonCode).toBe(ExecutionRefusalCode.StaleOrMissingQuote);
    });

    it('simulates fill for buy limit that crosses ask', () => {
      const candidate = sampleCandidate({ price: 2852.00, orderType: 'LIMIT' });
      const result = policy.evaluate(candidate, sampleQuote(), sampleInstrument());
      expect(result.canFill).toBe(true);
      expect(result.fillPrice).toBeCloseTo(2852.00); // candidate.price used directly
    });

    it('refuses buy limit below ask', () => {
      const candidate = sampleCandidate({ price: 2849.00, orderType: 'LIMIT' });
      const result = policy.evaluate(candidate, sampleQuote(), sampleInstrument());
      expect(result.canFill).toBe(false);
      expect(result.refusalReasons[0].reasonCode).toBe(ExecutionRefusalCode.StaleOrMissingQuote);
    });

    it('refuses buy limit without a valid price', () => {
      const candidate = sampleCandidate({ price: null, orderType: 'LIMIT' });
      const result = policy.evaluate(candidate, sampleQuote(), sampleInstrument());
      expect(result.canFill).toBe(false);
    });

    it('refuses buy with zero or negative limit price', () => {
      const candidate = sampleCandidate({ price: -1, orderType: 'LIMIT' });
      const result = policy.evaluate(candidate, sampleQuote(), sampleInstrument());
      expect(result.canFill).toBe(false);
    });
  });

  describe('sell evaluation', () => {
    it('simulates fill for market sell with valid bid', () => {
      const candidate = sampleCandidate({ side: 'sell' });
      const result = policy.evaluate(candidate, sampleQuote(), sampleInstrument());
      expect(result.canFill).toBe(true);
      expect(result.outcomeCode).toBe(ExecutionOutcomeCode.PaperSimulated);
      expect(result.fillPrice).toBeCloseTo(2850.00);
      expect(result.simulatedBrokerOrderId).toContain('-sell');
      expect(result.refusalReasons).toHaveLength(0);
    });

    it('uses lastPrice as fallback when bid is null', () => {
      const candidate = sampleCandidate({ side: 'sell' });
      const quote = sampleQuote({ bid: null, lastPrice: 2845.00 });
      const result = policy.evaluate(candidate, quote, sampleInstrument());
      expect(result.canFill).toBe(true);
      expect(result.fillPrice).toBeCloseTo(2845.00);
    });

    it('refuses when both bid and lastPrice are null/zero', () => {
      const candidate = sampleCandidate({ side: 'sell' });
      const quote = sampleQuote({ bid: null, lastPrice: null });
      const result = policy.evaluate(candidate, quote, sampleInstrument());
      expect(result.canFill).toBe(false);
      expect(result.refusalReasons[0].reasonCode).toBe(ExecutionRefusalCode.StaleOrMissingQuote);
    });

    it('simulates fill for sell limit that crosses bid', () => {
      const candidate = sampleCandidate({ side: 'sell', price: 2849.00, orderType: 'LIMIT' });
      const result = policy.evaluate(candidate, sampleQuote(), sampleInstrument());
      expect(result.canFill).toBe(true);
      expect(result.fillPrice).toBeCloseTo(2849.00);
    });

    it('refuses sell limit above bid', () => {
      const candidate = sampleCandidate({ side: 'sell', price: 2852.00, orderType: 'LIMIT' });
      const result = policy.evaluate(candidate, sampleQuote(), sampleInstrument());
      expect(result.canFill).toBe(false);
      expect(result.refusalReasons[0].reasonCode).toBe(ExecutionRefusalCode.StaleOrMissingQuote);
    });
  });

  describe('SL/SLM orders', () => {
    it('treats SL buy like limit buy below ask', () => {
      const candidate = sampleCandidate({ price: 2849.00, orderType: 'SL' });
      const result = policy.evaluate(candidate, sampleQuote(), sampleInstrument());
      expect(result.canFill).toBe(false); // 2849 < 2851 ask
    });

    it('treats SLM sell like a market sell (null price)', () => {
      const candidate = sampleCandidate({ side: 'sell', price: null, orderType: 'SLM' });
      const quote = sampleQuote({ bid: 2850.50 });
      const result = policy.evaluate(candidate, quote, sampleInstrument());
      expect(result.canFill).toBe(true);
    });
  });

  describe('idempotency — policy result shape', () => {
    it('returns simulatedBrokerOrderId for successful fills', () => {
      const result = policy.evaluate(sampleCandidate(), sampleQuote(), sampleInstrument());
      expect(result.simulatedBrokerOrderId).toBeTruthy();
      expect(result.simulatedBrokerOrderId).toMatch(/^paper-\d+-1001-buy$/);
    });

    it('returns null simulatedBrokerOrderId for refusals', () => {
      const result = policy.evaluate(sampleCandidate(), null, sampleInstrument());
      expect(result.simulatedBrokerOrderId).toBeNull();
    });

    it('includes descriptive message for fills', () => {
      const result = policy.evaluate(sampleCandidate(), sampleQuote(), sampleInstrument());
      expect(result.message).toContain('Paper buy');
      expect(result.message).toContain('75');
      expect(result.message).toContain('RELIANCE');
    });
  });
});
