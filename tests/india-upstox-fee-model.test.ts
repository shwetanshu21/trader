import { describe, expect, it } from 'vitest';
import {
  calculateIndiaUpstoxCharges,
  classifyIndiaUpstoxChargeSegment,
  getIndiaTradingDayBounds,
} from '../src/execution/india-upstox-fee-model.js';
import type { StrategyApprovedCandidate } from '../src/types/runtime.js';

function candidate(overrides?: Partial<StrategyApprovedCandidate>): StrategyApprovedCandidate {
  return {
    id: 1,
    proposalAttemptId: 1,
    strategyId: 'strat',
    strategyVersion: '1.0.0',
    decidedAt: Date.parse('2026-05-25T09:30:00+05:30'),
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    side: 'buy',
    product: 'MIS',
    quantity: 75,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    lastPrice: 2850.5,
    bid: 2850,
    ask: 2851,
    notional: 213_847.5,
    sizingBasis: 'last_price',
    maxLossRupees: null,
    stopDistance: null,
    stopPrice: null,
    trailingStopDistance: null,
    riskBudgetRupees: null,
    executionClass: 'EQ',
    segment: 'NSE',
    instrumentType: 'EQ',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    freezeQuantity: null,
    ...overrides,
  };
}

describe('india-upstox-fee-model', () => {
  it('classifies EQ MIS as equity intraday', () => {
    expect(classifyIndiaUpstoxChargeSegment(candidate())).toBe('equity_intraday');
  });

  it('calculates current NSE equity intraday buy charges', () => {
    const result = calculateIndiaUpstoxCharges({
      candidate: candidate(),
      fillPrice: 2851.3,
      filledAt: Date.parse('2026-05-25T10:00:00+05:30'),
    });

    expect(result.segment).toBe('equity_intraday');
    expect(result.brokerage).toBeCloseTo(20, 4);
    expect(result.stt).toBeCloseTo(0, 4);
    expect(result.exchangeTransactionCharge).toBeCloseTo(6.5651, 4);
    expect(result.ipftCharge).toBeCloseTo(0.0002, 4);
    expect(result.sebiCharge).toBeCloseTo(0.2138, 4);
    expect(result.stampDuty).toBeCloseTo(6.4154, 4);
    expect(result.gst).toBeCloseTo(4.7818, 4);
    expect(result.dpCharge).toBeCloseTo(0, 4);
    expect(result.totalFees).toBeCloseTo(37.9763, 4);
  });

  it('applies DP charges only when caller says a delivery sell is the chargeable sell of the day', () => {
    const deliverySell = candidate({
      side: 'sell',
      product: 'CNC',
      quantity: 10,
    });

    const withDp = calculateIndiaUpstoxCharges({
      candidate: deliverySell,
      fillPrice: 3000,
      filledAt: Date.parse('2026-05-25T13:00:00+05:30'),
      applyDpCharge: true,
    });
    const withoutDp = calculateIndiaUpstoxCharges({
      candidate: deliverySell,
      fillPrice: 3000,
      filledAt: Date.parse('2026-05-25T14:00:00+05:30'),
      applyDpCharge: false,
    });

    expect(withDp.dpCharge).toBeCloseTo(20, 4);
    expect(withoutDp.dpCharge).toBeCloseTo(0, 4);
    expect(withDp.totalFees - withoutDp.totalFees).toBeCloseTo(23.6, 4);
  });

  it('uses the higher post-2026 STT rate for futures sells', () => {
    const futuresSell = candidate({
      exchange: 'NFO',
      segment: 'NFO',
      instrumentType: 'FUT',
      executionClass: 'FO',
      tradingsymbol: 'NIFTY26MAYFUT',
      side: 'sell',
      product: 'NRML',
      quantity: 25,
      expiry: '2026-05-28',
      lotSize: 25,
    });

    const pre2026 = calculateIndiaUpstoxCharges({
      candidate: futuresSell,
      fillPrice: 21_500,
      filledAt: Date.parse('2025-12-15T12:00:00+05:30'),
    });
    const post2026 = calculateIndiaUpstoxCharges({
      candidate: futuresSell,
      fillPrice: 21_500,
      filledAt: Date.parse('2026-05-25T12:00:00+05:30'),
    });

    expect(pre2026.segment).toBe('equity_futures');
    expect(pre2026.stt).toBeCloseTo(107.5, 4);
    expect(post2026.stt).toBeCloseTo(268.75, 4);
    expect(post2026.totalFees).toBeGreaterThan(pre2026.totalFees);
  });

  it('prices options on premium rather than notional underlying value', () => {
    const optionBuy = candidate({
      exchange: 'NFO',
      segment: 'NFO',
      instrumentType: 'CE',
      executionClass: 'FO',
      tradingsymbol: 'RELIANCE26MAY3000CE',
      product: 'NRML',
      quantity: 25,
      expiry: '2026-05-28',
      strike: 3000,
      lotSize: 25,
    });

    const result = calculateIndiaUpstoxCharges({
      candidate: optionBuy,
      fillPrice: 150,
      filledAt: Date.parse('2026-05-25T11:00:00+05:30'),
    });

    expect(result.segment).toBe('equity_options');
    expect(result.brokerage).toBeCloseTo(20, 4);
    expect(result.stt).toBeCloseTo(0, 4);
    expect(result.exchangeTransactionCharge).toBeCloseTo(1.3324, 4);
    expect(result.stampDuty).toBeCloseTo(0.1125, 4);
    expect(result.totalFees).toBeCloseTo(25.2884, 4);
  });

  it('computes India trading-day bounds in IST', () => {
    const bounds = getIndiaTradingDayBounds(Date.parse('2026-05-25T00:15:00+05:30'));
    expect(new Date(bounds.startMs).toISOString()).toBe('2026-05-24T18:30:00.000Z');
    expect(new Date(bounds.endMs).toISOString()).toBe('2026-05-25T18:30:00.000Z');
  });
});
