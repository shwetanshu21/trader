import { WalkForwardRepository } from '../persistence/walk-forward-repo.js';
import type { WalkForwardTrialConfig } from './walk-forward-evaluator.js';

export interface WalkForwardResumeConfig {
  rangeStart: number;
  rangeEnd: number;
  windowSizeMs: number;
  stepSizeMs: number;
  inSampleRatio: number;
  label: string;
  strategyId: string;
  strategyVersion: string;
  marketId: string;
  cadenceMinutes: number;
  trialConfigs: WalkForwardTrialConfig[];
}

export function readWalkForwardResumeConfig(
  repo: WalkForwardRepository,
  runId: number,
): WalkForwardResumeConfig | null {
  const checkpoint = repo.getLatestCheckpoint(runId);
  if (!checkpoint?.metadataJson) {
    return null;
  }

  try {
    const raw = JSON.parse(checkpoint.metadataJson) as Partial<WalkForwardResumeConfig>;
    if (
      typeof raw.rangeStart !== 'number' ||
      typeof raw.rangeEnd !== 'number' ||
      typeof raw.windowSizeMs !== 'number' ||
      typeof raw.stepSizeMs !== 'number' ||
      typeof raw.inSampleRatio !== 'number' ||
      typeof raw.label !== 'string' ||
      typeof raw.strategyId !== 'string' ||
      typeof raw.strategyVersion !== 'string' ||
      typeof raw.marketId !== 'string' ||
      typeof raw.cadenceMinutes !== 'number' ||
      !Array.isArray(raw.trialConfigs)
    ) {
      return null;
    }

    return {
      rangeStart: raw.rangeStart,
      rangeEnd: raw.rangeEnd,
      windowSizeMs: raw.windowSizeMs,
      stepSizeMs: raw.stepSizeMs,
      inSampleRatio: raw.inSampleRatio,
      label: raw.label,
      strategyId: raw.strategyId,
      strategyVersion: raw.strategyVersion,
      marketId: raw.marketId,
      cadenceMinutes: raw.cadenceMinutes,
      trialConfigs: raw.trialConfigs,
    };
  } catch {
    return null;
  }
}
