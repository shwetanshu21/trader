import type { StrategyApprovedCandidate } from '../types/runtime.js';

// ── India / Upstox paper-trading charge model ────────────────────────────
//
// Purpose:
//   Provide a broker-aware transaction-cost model for paper trading and
//   replay/backtests so persisted P&L reflects more realistic India costs.
//
// Source of rates:
//   https://upstox.com/brokerage-charges/
//   Fetched during implementation on 2026-05-25.
//
// Notes:
//   - The system currently supports NSE cash + NFO derivatives. BSE-specific
//     scrip-group pricing is intentionally not modeled here.
//   - Options exercise-specific STT is not modeled because the paper engine
//     does not simulate assignment/exercise lifecycle events yet.
//   - DP charges are modeled on delivery sells only and should be applied once
//     per scrip per India trading day. The caller decides whether they apply.

const ONE_CRORE = 10_000_000;
const GST_RATE = 0.18;
const SEBI_RATE = 10 / ONE_CRORE; // ₹10 / crore
const IPFT_RATE = 0.01 / ONE_CRORE; // ₹0.01 / crore
const DP_CHARGE_DELIVERY_SELL = 20;
const INDIA_UTC_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const STT_CHANGE_2026_MS = Date.parse('2026-04-01T00:00:00+05:30');
const EXCHANGE_CHANGE_2026_MS = Date.parse('2026-03-01T00:00:00+05:30');
const STT_CHANGE_2024_MS = Date.parse('2024-10-01T00:00:00+05:30');

type UpstoxChargeSegment =
  | 'equity_delivery'
  | 'equity_intraday'
  | 'equity_futures'
  | 'equity_options';

export interface IndiaUpstoxChargeBreakdown {
  segment: UpstoxChargeSegment;
  chargedAt: number;
  turnover: number;
  brokerage: number;
  stt: number;
  exchangeTransactionCharge: number;
  ipftCharge: number;
  sebiCharge: number;
  stampDuty: number;
  gst: number;
  dpCharge: number;
  totalFees: number;
}

export interface IndiaUpstoxChargeOptions {
  candidate: StrategyApprovedCandidate;
  fillPrice: number;
  filledAt: number;
  applyDpCharge?: boolean;
}

export interface IndiaTradingDayBounds {
  startMs: number;
  endMs: number;
}

export function calculateIndiaUpstoxCharges(
  options: IndiaUpstoxChargeOptions,
): IndiaUpstoxChargeBreakdown {
  const { candidate, fillPrice, filledAt } = options;
  const applyDpCharge = options.applyDpCharge ?? true;

  const segment = classifyIndiaUpstoxChargeSegment(candidate);
  const side = candidate.side.toLowerCase();
  const turnover = round4(fillPrice * candidate.quantity);
  const premiumTurnover = turnover;
  const basis = segment === 'equity_options' ? premiumTurnover : turnover;

  const brokerage = round4(calculateBrokerage(segment, turnover));
  const stt = round4(calculateStt(segment, side, basis, filledAt));
  const exchangeTransactionCharge = round4(calculateExchangeCharge(segment, candidate.exchange, basis, filledAt));
  const ipftCharge = round4(calculateIpftCharge(segment, basis));
  const sebiCharge = round4(basis * SEBI_RATE);
  const stampDuty = round4(calculateStampDuty(segment, side, basis));
  const dpCharge = round4(shouldApplyDpCharge(segment, side, applyDpCharge) ? DP_CHARGE_DELIVERY_SELL : 0);
  const gstBase = brokerage + exchangeTransactionCharge + ipftCharge + dpCharge;
  const gst = round4(gstBase * GST_RATE);
  const totalFees = round4(
    brokerage + stt + exchangeTransactionCharge + ipftCharge + sebiCharge + stampDuty + gst + dpCharge,
  );

  return {
    segment,
    chargedAt: filledAt,
    turnover,
    brokerage,
    stt,
    exchangeTransactionCharge,
    ipftCharge,
    sebiCharge,
    stampDuty,
    gst,
    dpCharge,
    totalFees,
  };
}

export function classifyIndiaUpstoxChargeSegment(
  candidate: Pick<StrategyApprovedCandidate, 'executionClass' | 'instrumentType' | 'product' | 'exchange' | 'segment'>,
): UpstoxChargeSegment {
  const instrumentType = String(candidate.instrumentType ?? '').toUpperCase();
  const product = String(candidate.product ?? '').toUpperCase();
  const exchange = String(candidate.exchange ?? '').toUpperCase();
  const segment = String(candidate.segment ?? '').toUpperCase();

  if (exchange === 'NFO' || segment === 'NFO' || instrumentType === 'FUT' || instrumentType === 'CE' || instrumentType === 'PE') {
    if (instrumentType === 'CE' || instrumentType === 'PE') return 'equity_options';
    return 'equity_futures';
  }

  if (product === 'MIS') return 'equity_intraday';
  return 'equity_delivery';
}

export function isDeliverySellDpCandidate(
  candidate: Pick<StrategyApprovedCandidate, 'side' | 'executionClass' | 'instrumentType' | 'product' | 'exchange' | 'segment'>,
): boolean {
  return classifyIndiaUpstoxChargeSegment(candidate) === 'equity_delivery'
    && String(candidate.side ?? '').toLowerCase() === 'sell';
}

export function getIndiaTradingDayBounds(atMs: number): IndiaTradingDayBounds {
  const indiaEpochMs = atMs + INDIA_UTC_OFFSET_MS;
  const dayStartIndiaEpochMs = Math.floor(indiaEpochMs / 86_400_000) * 86_400_000;
  const startMs = dayStartIndiaEpochMs - INDIA_UTC_OFFSET_MS;
  return { startMs, endMs: startMs + 86_400_000 };
}

function calculateBrokerage(segment: UpstoxChargeSegment, turnover: number): number {
  switch (segment) {
    case 'equity_delivery':
      return 20;
    case 'equity_intraday':
      return Math.min(20, turnover * 0.001);
    case 'equity_futures':
      return Math.min(20, turnover * 0.0005);
    case 'equity_options':
      return 20;
  }
}

function calculateStt(
  segment: UpstoxChargeSegment,
  side: string,
  basis: number,
  filledAt: number,
): number {
  switch (segment) {
    case 'equity_delivery':
      return basis * 0.001;
    case 'equity_intraday':
      return side === 'sell' ? basis * 0.00025 : 0;
    case 'equity_futures': {
      if (side !== 'sell') return 0;
      const rate = filledAt >= STT_CHANGE_2026_MS ? 0.0005 : filledAt >= STT_CHANGE_2024_MS ? 0.0002 : 0.000125;
      return basis * rate;
    }
    case 'equity_options': {
      if (side !== 'sell') return 0;
      const rate = filledAt >= STT_CHANGE_2026_MS ? 0.0015 : filledAt >= STT_CHANGE_2024_MS ? 0.001 : 0.000625;
      return basis * rate;
    }
  }
}

function calculateExchangeCharge(
  segment: UpstoxChargeSegment,
  exchange: string,
  basis: number,
  filledAt: number,
): number {
  const normalizedExchange = exchange.toUpperCase();
  const usePost2026Rates = filledAt >= EXCHANGE_CHANGE_2026_MS;

  switch (segment) {
    case 'equity_delivery':
    case 'equity_intraday': {
      if (normalizedExchange !== 'NSE') return 0;
      return basis * (usePost2026Rates ? 0.0000307 : 0.0000297);
    }
    case 'equity_futures': {
      if (normalizedExchange !== 'NFO') return 0;
      return basis * (usePost2026Rates ? 0.0000183 : 0.0000173);
    }
    case 'equity_options': {
      if (normalizedExchange === 'NFO') {
        return basis * (usePost2026Rates ? 0.0003553 : 0.0003503);
      }
      return 0;
    }
  }
}

function calculateIpftCharge(segment: UpstoxChargeSegment, basis: number): number {
  switch (segment) {
    case 'equity_delivery':
    case 'equity_intraday':
    case 'equity_futures':
    case 'equity_options':
      return basis * IPFT_RATE;
  }
}

function calculateStampDuty(segment: UpstoxChargeSegment, side: string, basis: number): number {
  if (side !== 'buy') return 0;
  switch (segment) {
    case 'equity_delivery':
      return basis * 0.00015;
    case 'equity_intraday':
      return basis * 0.00003;
    case 'equity_futures':
      return basis * 0.00002;
    case 'equity_options':
      return basis * 0.00003;
  }
}

function shouldApplyDpCharge(
  segment: UpstoxChargeSegment,
  side: string,
  applyDpCharge: boolean,
): boolean {
  return segment === 'equity_delivery' && side === 'sell' && applyDpCharge;
}

function round4(value: number): number {
  return +value.toFixed(4);
}
