// ── Walk-forward runner (Upstox data) ──
// Dedicated CLI entrypoint using real Upstox historical data (locally cached)
// instead of fixture data. Composes UpstoxRestClient + UpstoxHistoricalDataProvider
// with the existing WalkForwardEvaluator without modifying either.

import { DatabaseManager } from '../persistence/sqlite.js';
import { WalkForwardEvaluator, WalkForwardInterruptionError, type WalkForwardTrialConfig } from './walk-forward-evaluator.js';
import { UpstoxRestClient } from '../upstox/upstox-rest-client.js';
import { UpstoxHistoricalDataProvider } from './upstox-historical-data-provider.js';
import { WalkForwardRepository } from '../persistence/walk-forward-repo.js';
import { INDIA_NSE_EQ_MARKET } from '../market/india-profile.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface RunnerOptions {
  days: number;
  window: number;
  step: number;
  ratio: number;
  trials: string;
  dbPath: string;
  label: string;
  resumeRunId?: number;
  interruptAfterTrial?: number;
  executionResolutionMinutes?: number;
  maxInstruments?: number;
  cacheDir?: string;
  fromDate?: string;
  toDate?: string;
}

function parseArgs(argv: string[]): RunnerOptions {
  const options: RunnerOptions = {
    days: 30,
    window: 7,
    step: 1,
    ratio: 0.8,
    trials: 'default',
    dbPath: ':memory:',
    label: 'cli-walk-forward-upstox',
    maxInstruments: 20,
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
      case '--db-path': options.dbPath = value; i++; break;
      case '--label': options.label = value; i++; break;
      case '--resume-run-id': options.resumeRunId = Number(value); i++; break;
      case '--interrupt-after-trial': options.interruptAfterTrial = Number(value); i++; break;
      case '--execution-resolution': options.executionResolutionMinutes = Number(value); i++; break;
      case '--max-instruments': options.maxInstruments = Number(value); i++; break;
      case '--cache-dir': options.cacheDir = value; i++; break;
      case '--from-date': options.fromDate = value; i++; break;
      case '--to-date': options.toDate = value; i++; break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Trial config builder (same as fixture runner)
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

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Parse an ISO date string (YYYY-MM-DD) to epoch ms (start of day UTC). */
function dateStrToEpochMs(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getTime();
}

/** Compute range start/end from CLI options. */
function computeDateRange(options: RunnerOptions): { rangeStart: number; rangeEnd: number } {
  const now = Date.now();
  const rangeEnd = options.toDate ? dateStrToEpochMs(options.toDate) : now;
  const rangeStart = options.fromDate
    ? dateStrToEpochMs(options.fromDate)
    : now - options.days * 86_400_000;
  return { rangeStart, rangeEnd };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { rangeStart, rangeEnd } = computeDateRange(options);
  const dbManager = new DatabaseManager(options.dbPath);
  const repo = new WalkForwardRepository(dbManager.db);

  // ── Create Upstox-backed data provider ──
  const restClient = new UpstoxRestClient();
  const dataProvider = new UpstoxHistoricalDataProvider({
    restClient,
    configPath: 'data/nifty-500.json',
    rangeStart,
    rangeEnd,
    cacheDir: options.cacheDir ?? './data/cache/upstox-candles',
    maxInstruments: options.maxInstruments,
    options: {
      executionResolutionMinutes: options.executionResolutionMinutes ?? null,
    },
  });

  const evaluator = new WalkForwardEvaluator({
    db: dbManager.db,
    marketProfile: INDIA_NSE_EQ_MARKET,
    dataProvider,
  });

  const trialConfigs = buildTrialConfigs(options.trials);
  const windowSizeMs = options.window * 86_400_000;
  const stepSizeMs = options.step * 86_400_000;

  // ── Banner ──
  console.log('─────────────────────────────────────────────────────────────');
  console.log('  Walk-Forward Runner (Upstox)');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`  DB path:         ${options.dbPath}`);
  console.log(`  Days:            ${options.days}`);
  console.log(`  Window:          ${options.window}d`);
  console.log(`  Step:            ${options.step}d`);
  console.log(`  In-sample:       ${options.ratio}`);
  console.log(`  Trials preset:   ${options.trials}`);
  console.log(`  Resume run id:   ${options.resumeRunId ?? 'new run'}`);
  console.log(`  Exec fidelity:   ${options.executionResolutionMinutes != null ? `${options.executionResolutionMinutes}m` : 'synthetic only'}`);
  console.log(`  Data provider:   ${dataProvider.label}`);
  console.log(`  Max instruments: ${options.maxInstruments ?? 'unlimited (default 20)'}`);
  console.log(`  Cache dir:       ${options.cacheDir ?? './data/cache/upstox-candles'}`);
  console.log(`  Range:           ${new Date(rangeStart).toISOString().slice(0, 10)} → ${new Date(rangeEnd).toISOString().slice(0, 10)}`);
  console.log('─────────────────────────────────────────────────────────────');

  try {
    const result = await evaluator.evaluate({
      rangeStart,
      rangeEnd,
      windowSizeMs,
      stepSizeMs,
      inSampleRatio: options.ratio,
      label: options.label,
      strategyId: 'india-nse-eq-v1',
      strategyVersion: '1.0.0',
      marketId: 'INDIA_NSE_EQ',
      trialConfigs,
      resumeRunId: options.resumeRunId,
      stopAfterTrialCount: options.interruptAfterTrial,
    });

    const checkpoint = repo.getLatestCheckpoint(result.run.id);
    console.log('');
    console.log('─────────────────────────────────────────────────────────────');
    console.log('  Walk-Forward Complete');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(`  Run ID:        ${result.run.id}`);
    console.log(`  Status:        ${result.run.status}`);
    console.log(`  Windows:       ${result.windows.length}`);
    console.log(`  Trials:        ${result.trials.length}`);
    console.log(`  Checkpoints:   ${repo.countCheckpoints(result.run.id)}`);
    console.log(`  Last CP trial: ${checkpoint?.lastCompletedTrialIndex ?? 'none'}`);
    console.log('');
    console.log('  Ranked Candidates:');
    for (const candidate of result.rankedCandidates) {
      console.log(
        `    #${candidate.rank} ${candidate.label} merged=${candidate.mergedScore.toFixed(4)} det=${candidate.deterministicScore.toFixed(4)}` +
        `${candidate.llmScore != null ? ` llm=${candidate.llmScore.toFixed(4)}` : ''} windows=${candidate.windowCount}`,
      );
    }
    console.log('');
    console.log('  Aggregate Metrics:');
    console.log(`    scoreStability=${result.aggregateMetrics.scoreStability.toFixed(4)}`);
    console.log(`    topKOverlap=${result.aggregateMetrics.topKOverlap.toFixed(4)}`);
    if (result.aggregateMetrics.llmConsultationRate != null) {
      console.log(`    llmConsultationRate=${result.aggregateMetrics.llmConsultationRate.toFixed(4)}`);
    }
  } catch (error) {
    if (error instanceof WalkForwardInterruptionError) {
      const checkpoint = repo.getLatestCheckpoint(error.runId);
      console.log('');
      console.log('─────────────────────────────────────────────────────────────');
      console.log('  Walk-Forward Intentionally Interrupted');
      console.log('─────────────────────────────────────────────────────────────');
      console.log(`  Run ID:        ${error.runId}`);
      console.log(`  Checkpoints:   ${repo.countCheckpoints(error.runId)}`);
      console.log(`  Last CP trial: ${checkpoint?.lastCompletedTrialIndex ?? 'none'}`);
      console.log(`  Message:       ${error.message}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  } finally {
    dbManager.close();
  }
}

main().catch(error => {
  console.error('Walk-forward runner (Upstox) failed:', error);
  process.exit(1);
});
