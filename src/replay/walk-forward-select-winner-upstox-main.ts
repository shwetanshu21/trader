// ── Walk-forward winner selector (Upstox data) ──
// Dedicated CLI entrypoint using real Upstox historical data (locally cached)
// instead of fixture data. Runs the full evaluation + selection pipeline and
// persists the winner decision to SQLite.

import { DatabaseManager } from '../persistence/sqlite.js';
import { WalkForwardEvaluator, WalkForwardInterruptionError, type WalkForwardTrialConfig } from './walk-forward-evaluator.js';
import { UpstoxRestClient } from '../upstox/upstox-rest-client.js';
import { UpstoxHistoricalDataProvider } from './upstox-historical-data-provider.js';
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
import { resolveIndiaMarketProfile, resolveIndiaMarketConfigPath } from '../market/india-profile.js';
import { ReplayClock } from './replay-clock.js';
import { createOptionalProposalEngine } from './proposal-engine-factory.js';
import { parseCliDateEnd, parseCliDateStart } from './upstox-date-range.js';
import { loadProjectEnvFile, resolveWalkForwardDbPath } from './walk-forward-db-path.js';
import { readWalkForwardResumeConfig } from './walk-forward-resume.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

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
  maxInstruments?: number;
  cacheDir?: string;
  fromDate?: string;
  toDate?: string;
  marketId: string;
  strategyId: string;
  strategyVersion: string;
  configPath: string;
  cadenceMinutes?: number;
  trialLimit?: number;
  resumeRunId?: number;
  stopAfterTrialCount?: number;
  disableProposalEngine: boolean;
}

function parseArgs(argv: string[]): SelectOptions {
  const options: SelectOptions = {
    days: 30,
    window: 7,
    step: 1,
    ratio: 0.8,
    trials: 'default',
    strategy: 'composite',
    minScore: 0.7,
    minWindows: 1,
    minSharpe: 0.8,
    maxDrawdown: 25,
    dbPath: resolveWalkForwardDbPath(undefined),
    label: 'cli-select-winner-upstox',
    maxInstruments: 20,
    marketId: 'INDIA_NSE_EQ',
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    configPath: 'data/nifty-500.json',
    disableProposalEngine: false,
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
      case '--max-instruments': options.maxInstruments = Number(value); i++; break;
      case '--cache-dir': options.cacheDir = value; i++; break;
      case '--from-date': options.fromDate = value; i++; break;
      case '--to-date': options.toDate = value; i++; break;
      case '--market-id': options.marketId = value; i++; break;
      case '--strategy-id': options.strategyId = value; i++; break;
      case '--strategy-version': options.strategyVersion = value; i++; break;
      case '--config-path': options.configPath = value; i++; break;
      case '--cadence-minutes': options.cadenceMinutes = Number(value); i++; break;
      case '--trial-limit': options.trialLimit = Number(value); i++; break;
      case '--resume-run-id': options.resumeRunId = Number(value); i++; break;
      case '--stop-after-trial': options.stopAfterTrialCount = Number(value); i++; break;
      case '--disable-proposal-engine': options.disableProposalEngine = true; break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Trial config builder
// ---------------------------------------------------------------------------

function buildTrialConfigs(preset: string): WalkForwardTrialConfig[] {
  switch (preset) {
    case 'grid':
      return [
        { label: 'Config A (3 candidates)', params: { maxCandidates: 3 } },
        { label: 'Config B (5 candidates)', params: { maxCandidates: 5 } },
        { label: 'Config C (7 candidates)', params: { maxCandidates: 7 } },
        { label: 'Config D (10 candidates)', params: { maxCandidates: 10 } },
      ];
    case 'llm':
      return [
        { label: 'Config A (no LLM)', params: { maxCandidates: 5 } },
        { label: 'Config B (LLM metadata)', params: { maxCandidates: 5 }, llmConfig: { enabled: true, maxCandidates: 5, weight: 0.5, temperature: 0.7 } },
      ];
    default:
      return [
        { label: 'Config A (3 candidates)', params: { maxCandidates: 3 } },
        { label: 'Config B (5 candidates)', params: { maxCandidates: 5 } },
      ];
  }
}

function applyTrialLimit(configs: WalkForwardTrialConfig[], trialLimit?: number): WalkForwardTrialConfig[] {
  if (trialLimit == null || !Number.isFinite(trialLimit) || trialLimit <= 0) {
    return configs;
  }
  return configs.slice(0, trialLimit);
}

// ---------------------------------------------------------------------------
// Selection strategy mapper
// ---------------------------------------------------------------------------

function toSelectionStrategy(value: string): WalkForwardSelectionStrategy {
  switch (value) {
    case 'top_ranked': return WalkForwardSelectionStrategy.TopRanked;
    case 'threshold': return WalkForwardSelectionStrategy.Threshold;
    default: return WalkForwardSelectionStrategy.Composite;
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Compute range start/end from CLI options. */
function computeDateRange(options: SelectOptions): { rangeStart: number; rangeEnd: number } {
  const now = Date.now();
  const rangeEnd = options.toDate
    ? parseCliDateEnd(options.toDate)
    : now;
  const rangeStart = options.fromDate
    ? parseCliDateStart(options.fromDate)
    : now - options.days * 86_400_000;
  return { rangeStart, rangeEnd };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadProjectEnvFile();
  const options = parseArgs(process.argv.slice(2));
  const now = Date.now();

  const dbManager = new DatabaseManager(options.dbPath);
  const repo = new WalkForwardRepository(dbManager.db);
  const resumeConfig = options.resumeRunId != null
    ? readWalkForwardResumeConfig(repo, options.resumeRunId)
    : null;
  if (options.resumeRunId != null && !resumeConfig) {
    throw new Error(
      `Run ${options.resumeRunId} is missing durable resume config. Re-run with the original range/window/trial arguments.`,
    );
  }

  const effectiveMarketId = resumeConfig?.marketId ?? options.marketId;
  const effectiveStrategyId = resumeConfig?.strategyId ?? options.strategyId;
  const effectiveStrategyVersion = resumeConfig?.strategyVersion ?? options.strategyVersion;
  const effectiveLabel = resumeConfig?.label ?? options.label;
  const effectiveCadenceMinutes = resumeConfig?.cadenceMinutes ?? options.cadenceMinutes ?? 5;
  const effectiveTrialConfigs = resumeConfig?.trialConfigs ?? applyTrialLimit(buildTrialConfigs(options.trials), options.trialLimit);
  const rangeStart = resumeConfig?.rangeStart ?? computeDateRange(options).rangeStart;
  const rangeEnd = resumeConfig?.rangeEnd ?? computeDateRange(options).rangeEnd;
  const windowSizeMs = resumeConfig?.windowSizeMs ?? options.window * 86_400_000;
  const stepSizeMs = resumeConfig?.stepSizeMs ?? options.step * 86_400_000;
  const inSampleRatio = resumeConfig?.inSampleRatio ?? options.ratio;

  // Resolve market profile and config path
  const marketProfile = resolveIndiaMarketProfile(effectiveMarketId);
  const resolvedConfigPath = options.configPath === 'data/nifty-500.json'
    ? resolveIndiaMarketConfigPath(effectiveMarketId)
    : options.configPath;

  // ── Create Upstox-backed data provider ──
  const restClient = new UpstoxRestClient();
  const dataProvider = new UpstoxHistoricalDataProvider({
    restClient,
    configPath: resolvedConfigPath,
    rangeStart,
    rangeEnd,
    cacheDir: options.cacheDir ?? './data/cache/upstox-candles',
    maxInstruments: options.maxInstruments,
    options: {
      screeningCadenceMinutes: effectiveCadenceMinutes,
      executionResolutionMinutes: options.executionResolutionMinutes ?? null,
    },
  });

  const evaluator = new WalkForwardEvaluator({
    db: dbManager.db,
    marketProfile,
    dataProvider,
    proposalEngine: options.disableProposalEngine ? undefined : createOptionalProposalEngine(),
    clock: new ReplayClock(marketProfile, effectiveCadenceMinutes),
  });

  try {
    // ── Run walk-forward evaluation ──
    const result = await evaluator.evaluate({
      rangeStart,
      rangeEnd,
      windowSizeMs,
      stepSizeMs,
      inSampleRatio,
      label: effectiveLabel,
      strategyId: effectiveStrategyId,
      strategyVersion: effectiveStrategyVersion,
      marketId: effectiveMarketId,
      trialConfigs: effectiveTrialConfigs,
      cadenceMinutes: effectiveCadenceMinutes,
      resumeRunId: options.resumeRunId,
      stopAfterTrialCount: options.stopAfterTrialCount,
    });

    // ── Winner selection ──
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
    const selection = selector.selectWinner(
      result.rankedCandidates,
      selectionConfig,
      trialEvidence,
    );

    // ── Build trade log ──
    let oosWindowCount = 0;
    for (const evidence of trialEvidence.values()) {
      const count = evidence.filter(
        item => item.windowType === WalkForwardWindowType.OutOfSample,
      ).length;
      oosWindowCount = Math.max(oosWindowCount, count);
    }

    const tradeLog = result.trials.flatMap(trial =>
      trial.windowEvidence.map(evidence => {
        const window = result.windows.find(
          item => item.id === evidence.windowId,
        );
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
      }),
    );

    // ── Emit artifacts ──
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
      dataRangeStart:
        result.windows[0]?.rangeStart ?? rangeStart,
      dataRangeEnd:
        result.windows[result.windows.length - 1]?.rangeEnd ?? rangeEnd,
    });

    // ── Persist winner to SQLite ──
    repo.insertWinner({
      runId: result.run.id,
      result: selection.result,
      selectedTrialId: selection.selectedTrialId,
      selectionStrategy: selection.selectionStrategy,
      selectionConfigJson: selection.selectionConfigJson,
      rationale: selection.rationale,
      artifactPathsJson: JSON.stringify([
        artifactPaths.winnerPath,
        artifactPaths.diagnosticsPath,
        artifactPaths.tradeLogPath,
      ]),
      selectedAt: now,
    });

    // ── Banner ──
    const winnerName =
      selection.result === WalkForwardSelectionResult.Selected
        ? (result.rankedCandidates.find(
              c => c.trialId === selection.selectedTrialId,
            )?.label ?? 'N/A')
        : '\u2014';

    console.log('─────────────────────────────────────────────────────────────');
    console.log('  Walk-Forward Winner Selector (Upstox)');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(`  DB path:         ${options.dbPath}`);
    console.log(`  Config path:     ${resolvedConfigPath}`);
    console.log(`  Market:          ${effectiveMarketId}`);
    console.log(`  Strategy:        ${effectiveStrategyId}@${effectiveStrategyVersion}`);
    console.log(`  Run ID:          ${result.run.id}`);
    console.log(`  Status:          ${result.run.status}`);
    console.log(`  Windows:         ${result.windows.length}`);
    console.log(`  Trials:          ${result.trials.length}`);
    console.log(`  Trial limit:     ${resumeConfig ? effectiveTrialConfigs.length : (options.trialLimit ?? 'none')}`);
    console.log(`  Cadence:         ${effectiveCadenceMinutes}m`);
    console.log(`  Proposal engine: ${options.disableProposalEngine ? 'disabled (deterministic only)' : 'enabled when env is configured'}`);
    console.log(`  Verdict:         ${selection.result === WalkForwardSelectionResult.Selected ? 'SELECTED' : 'HOLD'}`);
    console.log(`  Sel Strategy:    ${selection.selectionStrategy}`);
    console.log(`  Winner trial:    ${winnerName}`);
    console.log(`  Winner JSON:     ${artifactPaths.winnerPath}`);
    console.log(`  Diagnostics:     ${artifactPaths.diagnosticsPath}`);
    console.log(`  Trade log:       ${artifactPaths.tradeLogPath}`);
    console.log(`  Progress file:   data/artifacts/walk-forward/${result.run.id}/progress.json`);
    console.log('');
    console.log('  Fidelity Proof:');
    console.log(`    provider=${dataProvider.label}`);
    console.log(
      `    effective=${dataProvider.getEffectiveFidelity({
        index: 0,
        timestamp: now,
        fidelity: ReplayFidelity.Synthetic,
      })}`,
    );
    const resolution = dataProvider.getResolutionMetadata?.();
    if (resolution) {
      console.log(
        `    screeningCadenceMinutes=${resolution.screeningCadenceMinutes}`,
      );
      console.log(
        `    executionResolutionMinutes=${resolution.executionResolutionMinutes ?? 'none'}`,
      );
      console.log(
        `    supportsFineGrainedExecution=${resolution.supportsFineGrainedExecution}`,
      );
    }
    console.log('');
    console.log('  Aggregate Diagnostics:');
    console.log(
      `    scoreStability=${result.aggregateMetrics.scoreStability.toFixed(4)}`,
    );
    console.log(
      `    topKOverlap=${result.aggregateMetrics.topKOverlap.toFixed(4)}`,
    );
    if (result.aggregateMetrics.llmConsultationRate != null) {
      console.log(
        `    llmConsultationRate=${result.aggregateMetrics.llmConsultationRate.toFixed(4)}`,
      );
    }
  } catch (error) {
    if (error instanceof WalkForwardInterruptionError) {
      const checkpoint = repo.getLatestCheckpoint(error.runId);
      console.log('');
      console.log('─────────────────────────────────────────────────────────────');
      console.log('  Walk-Forward Selection Interrupted');
      console.log('─────────────────────────────────────────────────────────────');
      console.log(`  Run ID:          ${error.runId}`);
      console.log(`  Checkpoints:     ${repo.countCheckpoints(error.runId)}`);
      console.log(`  Last CP trial:   ${checkpoint?.lastCompletedTrialIndex ?? 'none'}`);
      console.log(`  Progress file:   data/artifacts/walk-forward/${error.runId}/progress.json`);
      console.log(`  Resume cmd:      npm run select:winner:upstox -- --resume-run-id ${error.runId}`);
      console.log(`  Message:         ${error.message}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  } finally {
    dbManager.close();
  }
}

main().catch(error => {
  console.error('Winner selection (Upstox) failed:', error);
  process.exit(1);
});
