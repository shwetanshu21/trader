import type { StrategyApprovedCandidate } from '../types/runtime.js';
import {
  calculateIndiaUpstoxCharges,
  type IndiaUpstoxChargeBreakdown,
} from './india-upstox-fee-model.js';

export interface PersistedPaperFillChargeInput {
  exchange: string;
  tradingsymbol: string;
  side: string;
  product: string;
  quantity: number;
  executionClass: 'EQ' | 'FO';
  segment: string;
  instrumentType: string;
  expiry: string | null;
  strike: number | null;
  lotSize: number;
  tickSize: number;
  freezeQuantity: number | null;
  fillPrice: number;
  filledAt: number;
  applyDpCharge: boolean;
}

export function calculatePersistedPaperFillChargeBreakdown(
  input: PersistedPaperFillChargeInput,
): IndiaUpstoxChargeBreakdown {
  const candidate: StrategyApprovedCandidate = {
    id: 0,
    proposalAttemptId: 0,
    strategyId: 'persisted-paper-fill',
    strategyVersion: '0',
    decidedAt: input.filledAt,
    exchange: input.exchange,
    tradingsymbol: input.tradingsymbol,
    side: input.side,
    product: input.product,
    quantity: input.quantity,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    lastPrice: input.fillPrice,
    bid: input.fillPrice,
    ask: input.fillPrice,
    notional: input.fillPrice * input.quantity,
    sizingBasis: 'filled_price',
    maxLossRupees: null,
    stopDistance: null,
    stopPrice: null,
    trailingStopDistance: null,
    riskBudgetRupees: null,
    executionClass: input.executionClass,
    segment: input.segment,
    instrumentType: input.instrumentType,
    expiry: input.expiry,
    strike: input.strike,
    lotSize: input.lotSize,
    tickSize: input.tickSize,
    freezeQuantity: input.freezeQuantity,
  };

  return calculateIndiaUpstoxCharges({
    candidate,
    fillPrice: input.fillPrice,
    filledAt: input.filledAt,
    applyDpCharge: input.applyDpCharge,
  });
}
