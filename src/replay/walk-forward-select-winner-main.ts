import { DatabaseManager } from '../persistence/sqlite.js';
import { WalkForwardEvaluator, type WalkForwardTrialConfig } from './walk-forward-evaluator.js';
import { FixtureHistoricalDataProvider } from './historical-data-provider.js';
import { WalkForwardRepository } from '../persistence/walk-forward-repo.js';
import { WinnerSelector } from './winner-selection.js';
import { ArtifactEmitter } from './artifact-emitter.js';
import {
  WalkForwardSelectionStrategy,
  WalkForwardSelectionResult,
  WalkForwardWindowType,
  type WalkForwardSelectionConfig,
  type WalkForwardTrialWindowRow,
} from './walk-forward-types.js';
import { ReplayFidelity } from './types.js';
import { INDIA_NSE_EQ_MARKET } from '../market/india-profile.js';
import type { BoundedCandidate } from '../types/runtime.js';
import { createOptionalProposalEngine } from './proposal-engine-factory.js';

interface SelectOptions {
  days: number;
  window: number;
  step: number;
  ratio: number;
  trials: string;
  strategy: string;
  minScore: number;
  minWindows: number;
  minSharpe: number;
  maxDrawdown: number;
  dbPath: string;
  label: string;
  executionResolutionMinutes?: number;
}

function parseArgs(argv: string[]): SelectOptions {
  const options: SelectOptions = {
    days: 14,
    window: 4,
    step: 2,
    ratio: 0.75,
    trials: 'default',
    strategy: 'composite',
    minScore: 0.7,
    minWindows: 1,
    minSharpe: 0.8,
    maxDrawdown: 25,
    dbPath: ':memory:',
    label: 'cli-select-winner',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case '--days': options.days = Number(value); i++; break;
      case '--window': options.window = Number(value); i++; break;
      case '--step': options.step = Number(value); i++; break;
      case '--ratio': options.ratio = Number(value); i++; break;
      case '--trials': options.trials = value; i++; break;
      case '--strategy': options.strategy = value; i++; break;
      case '--min-score': options.minScore = Number(value); i++; break;
      case '--min-windows': options.minWindows = Number(value); i++; break;
      case '--min-sharpe': options.minSharpe = Number(value); i++; break;
      case '--max-drawdown': options.maxDrawdown = Number(value); i++; break;
      case '--db-path': options.dbPath = value; i++; break;
      case '--label': options.label = value; i++; break;
      case '--execution-resolution': options.executionResolutionMinutes = Number(value); i++; break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function createFixtureCandidates(): BoundedCandidate[] {
  return [
    {
      exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 738561, side: 'buy',
      lastPrice: 2450.5, bid: 2450, ask: 2451, volume: 1_250_000, instrumentType: 'EQ', lotSize: 1, tickSize: 0.05,
      expiry: null, strike: null, freezeQuantity: null,
    },
    {
      exchange: 'NSE', tradingsymbol: 'TCS', instrumentToken: 2953217, side: 'buy',
      lastPrice: 3890, bid: 3889.5, ask: 3890.5, volume: 850_000, instrumentType: 'EQ', lotSize: 1, tickSize: 0.05,
      expiry: null, strike: null, freezeQuantity: null,
    },
    {
      exchange: 'NSE', tradingsymbol: 'HDFCBANK', instrumentToken: 341249, side: 'buy',
      lastPrice: 1680.25, bid: 1680, ask: 1680.5, volume: 2_100_000, instrumentType: 'EQ', lotSize: 1, tickSize: 0.05,
      expiry: null, strike: null, freezeQuantity: null,
    },
  ];
}

function buildTrialConfigs(preset: string): WalkForwardTrialConfig[] {
  switch (preset) {
    case 'grid':
      return [
        { label: 'Config A (3 cands)', params: { maxCandidates: 3 } },
        { label: 'Config B (5 cands)', params: { maxCandidates: 5 } },
        { label: 'Config C (7 cands)', params: { maxCandidates: 7 } },
        { label: 'Config D (10 cands)', params: { maxCandidates: 10 } },
      ];
    case 'llm':
      return [
        { label: 'Config A (no LLM)', params: { maxCandidates: 5 } },
        { label: 'Config B (LLM metadata)', params: { maxCandidates: 5 }, llmConfig: { enabled: true, maxCandidates: 5, weight: 0.5, temperature: 0.7 } },
      ];
    default:
      return [
        { label: 'Config A (3 cands)', params: { maxCandidates: 3 } },
        { label: 'Config B (5 cands)', params: { maxCandidates: 5 } },
      ];
  }
}

function toSelectionStrategy(value: string): WalkForwardSelectionStrategy {
  switch (value) {
    case 'top_ranked': return WalkForwardSelectionStrategy.TopRanked;
    case 'threshold': return WalkForwardSelectionStrategy.Threshold;
    default: return WalkForwardSelectionStrategy.Composite;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const now = Date.now();
  const rangeEnd = now;
  const rangeStart = now - options.days * 86_400_000;
  const dbManager = new DatabaseManager(options.dbPath);
  const repo = new WalkForwardRepository(dbManager.db);

  const dataProvider = new FixtureHistoricalDataProvider({
    candidates: createFixtureCandidates(),
    rangeStart,
    rangeEnd,
    priceDrift: 0.001,
    executionResolutionMinutes: options.executionResolutionMinutes ?? null,
  });

  const evaluator = new WalkForwardEvaluator({
    db: dbManager.db,
    marketProfile: INDIA_NSE_EQ_MARKET,
    dataProvider,
    proposalEngine: createOptionalProposalEngine(),
  });

  const result = await evaluator.evaluate({
    rangeStart,
    rangeEnd,
    windowSizeMs: options.window * 86_400_000,
    stepSizeMs: options.step * 86_400_000,
    inSampleRatio: options.ratio,
    label: options.label,
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    trialConfigs: buildTrialConfigs(options.trials),
  });

  const selectionStrategy = toSelectionStrategy(options.strategy);
  const selectionConfig: WalkForwardSelectionConfig = {
    strategy: selectionStrategy,
    minMergedScore: options.minScore,
    minWindowCount: options.minWindows,
  };
  if (selectionStrategy === WalkForwardSelectionStrategy.Composite) {
    selectionConfig.minSharpeRatio = options.minSharpe;
    selectionConfig.maxDrawdown = options.maxDrawdown;
  }

  const trialEvidence = new Map<number, WalkForwardTrialWindowRow[]>();
  for (const trial of result.trials) {
    trialEvidence.set(trial.trialId, trial.windowEvidence);
  }

  const selector = new WinnerSelector();
  const selection = selector.selectWinner(result.rankedCandidates, selectionConfig, trialEvidence);

  let oosWindowCount = 0;
  for (const evidence of trialEvidence.values()) {
    const count = evidence.filter(item => item.windowType === WalkForwardWindowType.OutOfSample).length;
    oosWindowCount = Math.max(oosWindowCount, count);
  }

  const tradeLog = result.trials.flatMap(trial => trial.windowEvidence.map(evidence => {
    const window = result.windows.find(item => item.id === evidence.windowId);
    return {
      trialId: trial.trialId,
      windowIndex: window?.windowIndex ?? -1,
      windowType: evidence.windowType,
      tradeCount: evidence.tradeCount,
      totalReturn: evidence.totalReturn,
      winRate: evidence.winRate,
      sharpeRatio: evidence.sharpeRatio,
      maxDrawdown: evidence.maxDrawdown,
    };
  }));

  const emitter = new ArtifactEmitter({ dataProvider });
  const artifactPaths = emitter.emitWinnerArtifacts({
    run: result.run,
    selection,
    selectionConfig,
    rankedCandidates: result.rankedCandidates,
    aggregateMetrics: {
      scoreStability: result.aggregateMetrics.scoreStability,
      topKOverlap: result.aggregateMetrics.topKOverlap,
      llmConsultationRate: result.aggregateMetrics.llmConsultationRate,
      llmDivergence: result.aggregateMetrics.llmDivergence,
    },
    tradeLog,
    dataProvider,
    windowCount: result.windows.length,
    trialCount: result.trials.length,
    oosWindowCount,
    selectedAt: now,
    dataRangeStart: result.windows[0]?.rangeStart ?? rangeStart,
    dataRangeEnd: result.windows[result.windows.length - 1]?.rangeEnd ?? rangeEnd,
  });

  repo.insertWinner({
    runId: result.run.id,
    result: selection.result,
    selectedTrialId: selection.selectedTrialId,
    selectionStrategy: selection.selectionStrategy,
    selectionConfigJson: selection.selectionConfigJson,
    rationale: selection.rationale,
    artifactPathsJson: JSON.stringify([artifactPaths.winnerPath, artifactPaths.diagnosticsPath, artifactPaths.tradeLogPath]),
    selectedAt: now,
  });

  const winnerName = selection.result === WalkForwardSelectionResult.Selected
    ? result.rankedCandidates.find(candidate => candidate.trialId === selection.selectedTrialId)?.label ?? 'N/A'
    : '—';

  console.log('─────────────────────────────────────────────────────────────');
  console.log('  Walk-Forward Winner Selector');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`  DB path:        ${options.dbPath}`);
  console.log(`  Run ID:         ${result.run.id}`);
  console.log(`  Status:         ${result.run.status}`);
  console.log(`  Windows:        ${result.windows.length}`);
  console.log(`  Trials:         ${result.trials.length}`);
  console.log(`  Verdict:        ${selection.result === WalkForwardSelectionResult.Selected ? 'SELECTED' : 'HOLD'}`);
  console.log(`  Strategy:       ${selection.selectionStrategy}`);
  console.log(`  Winner trial:   ${winnerName}`);
  console.log(`  Winner JSON:    ${artifactPaths.winnerPath}`);
  console.log(`  Diagnostics:    ${artifactPaths.diagnosticsPath}`);
  console.log(`  Trade log:      ${artifactPaths.tradeLogPath}`);
  console.log('');
  console.log('  Fidelity Proof:');
  console.log(`    provider=${dataProvider.label}`);
  console.log(`    effective=${dataProvider.getEffectiveFidelity({ index: 0, timestamp: now, fidelity: ReplayFidelity.Synthetic })}`);
  const resolution = dataProvider.getResolutionMetadata?.();
  if (resolution) {
    console.log(`    screeningCadenceMinutes=${resolution.screeningCadenceMinutes}`);
    console.log(`    executionResolutionMinutes=${resolution.executionResolutionMinutes ?? 'none'}`);
    console.log(`    supportsFineGrainedExecution=${resolution.supportsFineGrainedExecution}`);
  }
  console.log('');
  console.log('  Aggregate Diagnostics:');
  console.log(`    scoreStability=${result.aggregateMetrics.scoreStability.toFixed(4)}`);
  console.log(`    topKOverlap=${result.aggregateMetrics.topKOverlap.toFixed(4)}`);
  if (result.aggregateMetrics.llmConsultationRate != null) {
    console.log(`    llmConsultationRate=${result.aggregateMetrics.llmConsultationRate.toFixed(4)}`);
  }

  dbManager.close();
}

main().catch(error => {
  console.error('Winner selection failed:', error);
  process.exit(1);
});
