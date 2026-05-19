import { type QuoteSnapshot, StrategyDecisionReasonCode, type StrategyDecisionReason } from '../types/runtime.js';
import type { StrategyInstrumentMeta } from './policy.js';

export interface PositionSizingConfig {
  defaultRiskBudgetRupees: number;
  maxPortfolioExposureRupees: number;
  maxPositionExposureRupees: number;
  trailingStopDistanceRatio: number;
  stopDistanceRatio: number;
}

export interface PositionSizingInput {
  exchange: string;
  tradingsymbol: string;
  quantity: number;
  quote: QuoteSnapshot | null;
  instrumentMeta: StrategyInstrumentMeta | null;
  side: string;
  requestedStopDistance: number | null;
  riskBudgetRupees: number | null;
  config: PositionSizingConfig;
}

export interface PositionSizingSuccess {
  ok: true;
  quantity: number;
  sizingBasis: string;
  riskBudgetRupees: number;
  stopDistance: number;
  stopPrice: number;
  trailingStopDistance: number;
  notional: number;
}

export interface PositionSizingFailure {
  ok: false;
  reasons: StrategyDecisionReason[];
}

export type PositionSizingResult = PositionSizingSuccess | PositionSizingFailure;

export function computePositionSizing(input: PositionSizingInput): PositionSizingResult {
  const quote = input.quote;
  const instrument = input.instrumentMeta;
  if (!quote || !quote.lastPrice || quote.lastPrice <= 0) {
    return refused(StrategyDecisionReasonCode.MissingQuoteData, `No valid last price for ${input.tradingsymbol}`);
  }
  if (!instrument || !instrument.lotSize || instrument.lotSize <= 0) {
    return refused(StrategyDecisionReasonCode.MissingInstrumentMetadata, `Missing lot size for ${input.tradingsymbol}`);
  }

  const entryPrice = quote.lastPrice;
  const configuredStopDistance = input.requestedStopDistance && input.requestedStopDistance > 0
    ? input.requestedStopDistance
    : Math.max(entryPrice * input.config.stopDistanceRatio, instrument.tickSize ?? 0.05);
  const riskBudget = input.riskBudgetRupees && input.riskBudgetRupees > 0
    ? input.riskBudgetRupees
    : input.config.defaultRiskBudgetRupees;

  const rawQty = Math.floor(riskBudget / configuredStopDistance);
  const lotRoundedQty = Math.floor(rawQty / instrument.lotSize) * instrument.lotSize;
  if (lotRoundedQty <= 0) {
    return refused(
      StrategyDecisionReasonCode.ZeroQuantityAfterRounding,
      `Risk budget ${riskBudget} with stop distance ${configuredStopDistance.toFixed(2)} rounds to 0 quantity for ${input.tradingsymbol}`,
    );
  }

  const notional = lotRoundedQty * entryPrice;
  if (input.config.maxPositionExposureRupees > 0 && notional > input.config.maxPositionExposureRupees) {
    const clippedQty = Math.floor((input.config.maxPositionExposureRupees / entryPrice) / instrument.lotSize) * instrument.lotSize;
    if (clippedQty <= 0) {
      return refused(
        StrategyDecisionReasonCode.BelowMinimumNotional,
        `Exposure cap ${input.config.maxPositionExposureRupees} yields zero executable quantity for ${input.tradingsymbol}`,
      );
    }
    return buildSuccess(input.side, entryPrice, configuredStopDistance, riskBudget, clippedQty, 'risk_budget_and_exposure_cap');
  }

  return buildSuccess(input.side, entryPrice, configuredStopDistance, riskBudget, lotRoundedQty, 'risk_budget');
}

function buildSuccess(
  side: string,
  entryPrice: number,
  stopDistance: number,
  riskBudgetRupees: number,
  quantity: number,
  sizingBasis: string,
): PositionSizingSuccess {
  const normalizedSide = side.toLowerCase();
  const stopPrice = normalizedSide === 'sell'
    ? entryPrice + stopDistance
    : entryPrice - stopDistance;
  return {
    ok: true,
    quantity,
    sizingBasis,
    riskBudgetRupees,
    stopDistance,
    stopPrice,
    trailingStopDistance: stopDistance,
    notional: quantity * entryPrice,
  };
}

function refused(code: StrategyDecisionReasonCode, message: string): PositionSizingFailure {
  return { ok: false, reasons: [{ reasonCode: code, reasonMessage: message }] };
}
