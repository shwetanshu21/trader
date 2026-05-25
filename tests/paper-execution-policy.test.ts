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
    maxLossRupees: null,
    stopDistance: null,
    stopPrice: null,
    trailingStopDistance: null,
    riskBudgetRupees: null,
    executionClass: overrides?.exchange === 'NFO' ? 'FO' : 'EQ',
    segment: overrides?.exchange === 'NFO' ? 'NFO' : 'NSE',
    instrumentType: overrides?.exchange === 'NFO'
      ? String(overrides?.tradingsymbol ?? '').endsWith('CE')
        ? 'CE'
        : String(overrides?.tradingsymbol ?? '').endsWith('PE')
          ? 'PE'
          : 'FUT'
      : 'EQ',
    expiry: overrides?.exchange === 'NFO' ? '2026-12-31' : null,
    strike: overrides?.exchange === 'NFO' ? 3000 : null,
    lotSize: overrides?.exchange === 'NFO' ? 25 : 1,
    tickSize: 0.05,
    freezeQuantity: null,
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
      // Market order uses the prevailing ask plus adverse slippage.
      expect(result.fillPrice).toBeCloseTo(2851.30);
      expect(result.referencePrice).toBeCloseTo(2851.00);
      expect(result.slippageAmount).toBeGreaterThan(0);
      expect(result.fees).toBeGreaterThan(0);
      expect(result.simulatedBrokerOrderId).toContain('paper-');
      expect(result.simulatedBrokerOrderId).toContain('-buy');
      expect(result.refusalReasons).toHaveLength(0);
    });

    it('uses lastPrice as fallback when ask is null', () => {
      const quote = sampleQuote({ ask: null, lastPrice: 2845.00 });
      const result = policy.evaluate(sampleCandidate(), quote, sampleInstrument());
      expect(result.canFill).toBe(true);
      expect(result.fillPrice).toBeCloseTo(2845.30);
      expect(result.referencePrice).toBeCloseTo(2845.00);
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
      expect(result.fillPrice).toBeCloseTo(2851.00);
      expect(result.slippageAmount).toBe(0);
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
      expect(result.fillPrice).toBeCloseTo(2849.70);
      expect(result.referencePrice).toBeCloseTo(2850.00);
      expect(result.simulatedBrokerOrderId).toContain('-sell');
      expect(result.refusalReasons).toHaveLength(0);
    });

    it('uses lastPrice as fallback when bid is null', () => {
      const candidate = sampleCandidate({ side: 'sell' });
      const quote = sampleQuote({ bid: null, lastPrice: 2845.00 });
      const result = policy.evaluate(candidate, quote, sampleInstrument());
      expect(result.canFill).toBe(true);
      expect(result.fillPrice).toBeCloseTo(2844.70);
      expect(result.referencePrice).toBeCloseTo(2845.00);
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
      expect(result.fillPrice).toBeCloseTo(2850.00);
      expect(result.slippageAmount).toBe(0);
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

  // -----------------------------------------------------------------------
  // FO paper evaluation — same path, FO symbols
  // -----------------------------------------------------------------------
  // FO candidates flow through the same paper evaluation path as EQ.
  // The PaperExecutionPolicy has no FO-specific logic — it evaluates
  // any candidate against quote/instrument data regardless of execution class.
  // These tests prove FO symbols can fill through the shared seam.

  describe('FO paper evaluation', () => {
    it('evaluates FO limit buy that crosses ask as fillable', () => {
      // FO buy LIMIT at 50, ask at 50.00 → fills (limit >= ask)
      const candidate = sampleCandidate({
        exchange: 'NFO',
        tradingsymbol: 'RELIANCE24DEC3000CE',
        price: 50.00,
        orderType: 'LIMIT',
      });
      const quote = sampleQuote({
        exchange: 'NFO',
        tradingsymbol: 'RELIANCE24DEC3000CE',
        ask: 50.00,
        bid: 49.80,
        lastPrice: 49.85,
      });
      const result = policy.evaluate(candidate, quote, sampleInstrument());
      expect(result.canFill).toBe(true);
      expect(result.outcomeCode).toBe(ExecutionOutcomeCode.PaperSimulated);
      expect(result.refusalReasons).toHaveLength(0);
      expect(result.fillPrice).toBeCloseTo(50.00);
    });

    it('refuses FO limit buy below ask', () => {
      // FO buy LIMIT at 48.50, ask at 50.00 → no fill
      const candidate = sampleCandidate({
        exchange: 'NFO',
        tradingsymbol: 'RELIANCE24DEC3000CE',
        price: 48.50,
        orderType: 'LIMIT',
      });
      const quote = sampleQuote({
        exchange: 'NFO',
        tradingsymbol: 'RELIANCE24DEC3000CE',
        ask: 50.00,
      });
      const result = policy.evaluate(candidate, quote, sampleInstrument());
      expect(result.canFill).toBe(false);
      expect(result.outcomeCode).toBe(ExecutionOutcomeCode.PaperRejected);
    });

    it('evaluates FO market buy with valid ask as fillable', () => {
      const candidate = sampleCandidate({
        exchange: 'NFO',
        tradingsymbol: 'NIFTY24DECFUT',
        price: null,
        orderType: 'MARKET',
      });
      const quote = sampleQuote({
        exchange: 'NFO',
        tradingsymbol: 'NIFTY24DECFUT',
        ask: 21500.00,
        bid: 21480.00,
        lastPrice: 21490.00,
      });
      const result = policy.evaluate(candidate, quote, sampleInstrument());
      expect(result.canFill).toBe(true);
      expect(result.outcomeCode).toBe(ExecutionOutcomeCode.PaperSimulated);
      // Market buy uses ask price plus adverse slippage.
      expect(result.fillPrice).toBeCloseTo(21502.15);
      expect(result.referencePrice).toBeCloseTo(21500.00);
    });

    it('evaluates FO market sell with valid bid as fillable', () => {
      const candidate = sampleCandidate({
        exchange: 'NFO',
        tradingsymbol: 'NIFTY24DECFUT',
        side: 'sell',
        price: null,
        orderType: 'MARKET',
      });
      const quote = sampleQuote({
        exchange: 'NFO',
        tradingsymbol: 'NIFTY24DECFUT',
        bid: 21480.00,
        ask: 21500.00,
        lastPrice: 21490.00,
      });
      const result = policy.evaluate(candidate, quote, sampleInstrument());
      expect(result.canFill).toBe(true);
      expect(result.outcomeCode).toBe(ExecutionOutcomeCode.PaperSimulated);
      // Market sell uses bid price minus adverse slippage.
      expect(result.fillPrice).toBeCloseTo(21477.85);
      expect(result.referencePrice).toBeCloseTo(21480.00);
    });

    it('refuses FO candidate when quote is missing (same as EQ)', () => {
      const candidate = sampleCandidate({
        exchange: 'NFO',
        tradingsymbol: 'BANKNIFTY24DECFUT',
      });
      const result = policy.evaluate(candidate, null, sampleInstrument());
      expect(result.canFill).toBe(false);
      expect(result.refusalReasons[0].reasonCode).toBe(ExecutionRefusalCode.StaleOrMissingQuote);
    });

    it('uses quote timestamp so replay-era futures sells get historical fee schedules', () => {
      const candidate = sampleCandidate({
        exchange: 'NFO',
        tradingsymbol: 'NIFTY26MAYFUT',
        side: 'sell',
        product: 'NRML',
        quantity: 25,
        executionClass: 'FO',
        segment: 'NFO',
        instrumentType: 'FUT',
        expiry: '2026-05-28',
        lotSize: 25,
      });
      const quote2025 = sampleQuote({
        exchange: 'NFO',
        tradingsymbol: 'NIFTY26MAYFUT',
        bid: 21500.00,
        ask: 21520.00,
        lastPrice: 21510.00,
        receivedAt: Date.parse('2025-12-15T12:00:00+05:30'),
      });
      const quote2026 = sampleQuote({
        exchange: 'NFO',
        tradingsymbol: 'NIFTY26MAYFUT',
        bid: 21500.00,
        ask: 21520.00,
        lastPrice: 21510.00,
        receivedAt: Date.parse('2026-05-25T12:00:00+05:30'),
      });

      const beforeRateChange = new PaperExecutionPolicy(() => quote2025.receivedAt + 1_000).evaluate(candidate, quote2025, sampleInstrument({
        exchange: 'NFO',
        tradingsymbol: 'NIFTY26MAYFUT',
        instrumentType: 'FUT' as any,
        segment: 'NFO' as any,
        lotSize: 25,
      }));
      const afterRateChange = new PaperExecutionPolicy(() => quote2026.receivedAt + 1_000).evaluate(candidate, quote2026, sampleInstrument({
        exchange: 'NFO',
        tradingsymbol: 'NIFTY26MAYFUT',
        instrumentType: 'FUT' as any,
        segment: 'NFO' as any,
        lotSize: 25,
      }));

      expect(afterRateChange.fees!).toBeGreaterThan(beforeRateChange.fees!);
    });
  });
});
