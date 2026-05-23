// ── Evaluate Hypothesis CLI Entrypoint ──
// Runs the full hypothesis research evaluation pipeline for a single stored
// hypothesis by ID. Uses fixture historical data and in-memory or on-disk
// SQLite. Modeled after walk-forward-select-winner-upstox-main.ts patterns.
//
// Usage:
//   npx tsx src/research/evaluate-hypothesis-main.ts --hypothesis-id <id>
//
// Options:
//   --hypothesis-id <number>   Required: FK into hypothesis_graphs for a validated row.
//   --db-path <string>         Path to SQLite database (default: :memory: for testing).
//   --days <number>            Evaluation date range in days (default: 30).
//   --window <number>          Window size in days (default: 7).
//   --step <number>            Step size in days (default: 1).
//   --ratio <number>           In-sample ratio (default: 0.8).
//   --strategy <string>        Selection strategy: top_ranked | threshold | composite (default: threshold).
//   --min-score <number>       Minimum merged score (default: 0.7).
//   --min-windows <number>     Minimum window count (default: 1).
//   --min-sharpe <number>      Minimum Sharpe for composite (default: 0.8).
//   --max-drawdown <number>    Max drawdown % for composite (default: 25).
//   --label <string>           Optional run label (default: auto-generated).
//   --work-dir <string>        Working directory for artifact output (default: current dir).
//   --max-candidates <number>  Max candidates per replay tick (default: 5).
//   --cadence-minutes <number> Tick cadence (default: 5).
//   --from-date <string>       Override range start (ISO date).
//   --to-date <string>         Override range end (ISO date).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseManager } from '../persistence/sqlite.js';
import { resolveResearchDbPath, resolveWalkForwardDbPath } from '../replay/walk-forward-db-path.js';
import { HypothesisRepository } from '../persistence/hypothesis-repo.js';
import { WalkForwardRepository } from '../persistence/walk-forward-repo.js';
import { HypothesisResearchEvaluator } from './hypothesis-evaluator.js';
import { WalkForwardEvaluator } from '../replay/walk-forward-evaluator.js';
import { FixtureHistoricalDataProvider } from '../replay/historical-data-provider.js';
import { WinnerSelector } from '../replay/winner-selection.js';
import { ResearchArtifactWriter } from './artifact-writer.js';
import { INDIA_NSE_EQ_MARKET } from '../market/india-profile.js';
import {
  HypothesisEvaluationStatus,
  type BoundedCandidate,
  type HypothesisResearchConfig,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  hypothesisId: number;
  dbPath: string;
  researchDbPath: string | null;
  days: number;
  window: number;
  step: number;
  ratio: number;
  strategy: 'top_ranked' | 'threshold' | 'composite';
  minScore: number;
  minWindows: number;
  minSharpe: number;
  maxDrawdown: number;
  label: string;
  workDir: string;
  maxCandidates: number;
  cadenceMinutes: number;
  fromDate?: string;
  toDate?: string;
}

export function parseArgs(argv: string[]): EvaluateOptions {
  const options: EvaluateOptions = {
    hypothesisId: 0,
    dbPath: ':memory:',
    researchDbPath: null,
    days: 30,
    window: 7,
    step: 1,
    ratio: 0.8,
    strategy: 'threshold',
    minScore: 0.7,
    minWindows: 1,
    minSharpe: 0.8,
    maxDrawdown: 25,
    label: '',
    workDir: process.cwd(),
    maxCandidates: 5,
    cadenceMinutes: 5,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];

    switch (arg) {
      case '--hypothesis-id':
        options.hypothesisId = Number(value);
        i++;
        break;
      case '--db-path':
        options.dbPath = value;
        i++;
        break;
      case '--research-db-path':
        options.researchDbPath = value;
        i++;
        break;
      case '--days':
        options.days = Number(value);
        i++;
        break;
      case '--window':
        options.window = Number(value);
        i++;
        break;
      case '--step':
        options.step = Number(value);
        i++;
        break;
      case '--ratio':
        options.ratio = Number(value);
        i++;
        break;
      case '--strategy':
        if (!['top_ranked', 'threshold', 'composite'].includes(value)) {
          throw new Error(
            `Invalid strategy: "${value}". Must be top_ranked, threshold, or composite.`,
          );
        }
        options.strategy = value as EvaluateOptions['strategy'];
        i++;
        break;
      case '--min-score':
        options.minScore = Number(value);
        i++;
        break;
      case '--min-windows':
        options.minWindows = Number(value);
        i++;
        break;
      case '--min-sharpe':
        options.minSharpe = Number(value);
        i++;
        break;
      case '--max-drawdown':
        options.maxDrawdown = Number(value);
        i++;
        break;
      case '--label':
        options.label = value;
        i++;
        break;
      case '--work-dir':
        options.workDir = value;
        i++;
        break;
      case '--max-candidates':
        options.maxCandidates = Number(value);
        i++;
        break;
      case '--cadence-minutes':
        options.cadenceMinutes = Number(value);
        i++;
        break;
      case '--from-date':
        options.fromDate = value;
        i++;
        break;
      case '--to-date':
        options.toDate = value;
        i++;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.hypothesisId || options.hypothesisId <= 0) {
    throw new Error('--hypothesis-id is required and must be a positive integer.');
  }

  return options;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function computeDateRange(options: EvaluateOptions): { rangeStart: number; rangeEnd: number } {
  const now = Date.now();
  const rangeEnd = options.toDate
    ? Date.parse(options.toDate + 'T18:30:00Z') // IST end-of-day
    : now;
  const rangeStart = options.fromDate
    ? Date.parse(options.fromDate + 'T00:00:00Z')
    : now - options.days * 86_400_000;
  return { rangeStart, rangeEnd };
}

// ---------------------------------------------------------------------------
// Fixture candidates (basic NSE equities for testing)
// ---------------------------------------------------------------------------

function buildFixtureCandidates(): BoundedCandidate[] {
  return [
    {
      exchange: 'NSE', tradingsymbol: 'RELIANCE', instrumentToken: 738561, side: 'buy',
      lastPrice: 2450.5, bid: 2450, ask: 2451, volume: 1_250_000, instrumentType: 'EQ',
      lotSize: 1, tickSize: 0.05, expiry: null, strike: null, freezeQuantity: null,
    },
    {
      exchange: 'NSE', tradingsymbol: 'TCS', instrumentToken: 2953217, side: 'buy',
      lastPrice: 3890, bid: 3889.5, ask: 3890.5, volume: 850_000, instrumentType: 'EQ',
      lotSize: 1, tickSize: 0.05, expiry: null, strike: null, freezeQuantity: null,
    },
    {
      exchange: 'NSE', tradingsymbol: 'HDFCBANK', instrumentToken: 341249, side: 'buy',
      lastPrice: 1680, bid: 1679.5, ask: 1680.5, volume: 2_100_000, instrumentType: 'EQ',
      lotSize: 1, tickSize: 0.05, expiry: null, strike: null, freezeQuantity: null,
    },
    {
      exchange: 'NSE', tradingsymbol: 'INFY', instrumentToken: 408065, side: 'sell',
      lastPrice: 1850, bid: 1849.5, ask: 1850.5, volume: 950_000, instrumentType: 'EQ',
      lotSize: 1, tickSize: 0.05, expiry: null, strike: null, freezeQuantity: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // Resolve DB path: research mode uses explicit path only (fail-closed).
  // Standalone mode falls back to --db-path or :memory: default.
  const dbPath = options.researchDbPath
    ? resolveResearchDbPath(options.researchDbPath)
    : (options.dbPath ? options.dbPath : ':memory:');

  if (!dbPath) {
    console.error('No database path resolved. Provide --research-db-path for research mode.');
    process.exit(1);
  }

  const { rangeStart, rangeEnd } = computeDateRange(options);

  // Validate the range
  if (rangeStart >= rangeEnd) {
    throw new Error(
      `Invalid date range: start (${new Date(rangeStart).toISOString()}) ` +
      `must be before end (${new Date(rangeEnd).toISOString()}).`,
    );
  }

  // Change to working directory
  const originalCwd = process.cwd();
  process.chdir(options.workDir);

  const dbManager = new DatabaseManager(dbPath);
  const hypothesisRepo = new HypothesisRepository(dbManager.db);
  const walkForwardRepo = new WalkForwardRepository(dbManager.db);

  try {
    // ── Validate the hypothesis exists and is in Validated status ──
    const hypothesis = hypothesisRepo.getHypothesisById(options.hypothesisId);
    if (!hypothesis) {
      console.error(`Hypothesis graph ${options.hypothesisId} does not exist in the database.`);
      console.error(`DB path: ${dbPath}`);
      process.exitCode = 1;
      return;
    }

    console.log('─────────────────────────────────────────────────────────────');
    console.log('  Hypothesis Research Evaluator (CLI)');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(`  Hypothesis ID:   ${hypothesis.id}`);
    console.log(`  Status:          ${hypothesis.status}`);
    console.log(`  Canonical hash:  ${hypothesis.canonicalHash.slice(0, 16)}...`);
    console.log(`  DB path:         ${dbPath}`);
    console.log(`  Date range:      ${new Date(rangeStart).toISOString().slice(0, 10)} → ${new Date(rangeEnd).toISOString().slice(0, 10)}`);
    console.log(`  Window:          ${options.window}d, Step: ${options.step}d, Ratio: ${options.ratio}`);
    console.log(`  Strategy:        ${options.strategy}`);
    console.log(`  Min score:       ${options.minScore}`);
    console.log(`  Max candidates:  ${options.maxCandidates}`);
    console.log(`  Cadence:         ${options.cadenceMinutes}m`);
    console.log('');

    // ── Build data provider and evaluator ──
    const candidates = buildFixtureCandidates();
    const dataProvider = new FixtureHistoricalDataProvider({
      candidates,
      rangeStart,
      rangeEnd,
    });

    const walkForwardEval = new WalkForwardEvaluator({
      db: dbManager.db,
      marketProfile: INDIA_NSE_EQ_MARKET,
      dataProvider,
    });

    const artifactWriter = new ResearchArtifactWriter();
    const winnerSelector = new WinnerSelector();

    const evaluator = new HypothesisResearchEvaluator({
      db: dbManager.db,
      dataProvider,
      marketProfile: INDIA_NSE_EQ_MARKET,
      hypothesisRepo,
      walkForwardRepo,
      artifactWriter,
      winnerSelector,
      walkForwardEvaluator: walkForwardEval,
    });

    // ── Build config with CLI overrides ──
    const config: HypothesisResearchConfig = {
      rangeStart,
      rangeEnd,
      windowSizeMs: options.window * 86_400_000,
      stepSizeMs: options.step * 86_400_000,
      inSampleRatio: options.ratio,
      maxCandidates: options.maxCandidates,
      cadenceMinutes: options.cadenceMinutes,
      selectionStrategy: options.strategy,
      minMergedScore: options.minScore,
      minWindowCount: options.minWindows,
    };

    if (options.strategy === 'composite') {
      config.minSharpeRatio = options.minSharpe;
      config.maxDrawdown = options.maxDrawdown;
    }

    if (options.label) {
      config.label = options.label;
    }

    // ── Run evaluation ──
    console.log('  Running evaluation...');
    const startTime = Date.now();
    const result = await evaluator.evaluate(options.hypothesisId, config);
    const elapsed = Date.now() - startTime;

    // ── Banner ──
    console.log('');
    console.log('─────────────────────────────────────────────────────────────');
    console.log('  Evaluation Complete');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(`  Evaluation ID:   ${result.evaluation.id}`);
    console.log(`  Final Status:    ${result.finalStatus}`);
    console.log(`  Duration:        ${elapsed}ms`);
    console.log('');

    if (result.walkForwardRun) {
      console.log('  Walk-Forward Run:');
      console.log(`    Run ID:        ${result.walkForwardRun.id}`);
      console.log(`    Label:         ${result.walkForwardRun.label}`);
      console.log(`    Status:        ${result.walkForwardRun.status}`);
      console.log(`    Windows:       ${result.walkForwardRun.windowCount}`);
      console.log(`    Trials:        ${result.walkForwardRun.totalTrials}`);
      console.log('');
    }

    if (result.winner) {
      console.log('  Winner:');
      console.log(`    Trial ID:      ${result.winner.trialId}`);
      console.log(`    Label:         ${result.winner.trialLabel}`);
      console.log(`    Merged Score:  ${result.winner.aggregateMergedScore.toFixed(4)}`);
      console.log(`    Det Score:     ${result.winner.aggregateDeterministicScore.toFixed(4)}`);
      if (result.winner.aggregateLlmScore != null) {
        console.log(`    LLM Score:     ${result.winner.aggregateLlmScore.toFixed(4)}`);
      }
      console.log('');
    }

    if (result.aggregateMetrics) {
      console.log('  Aggregate Metrics:');
      console.log(`    Score Stability:  ${result.aggregateMetrics.scoreStability.toFixed(4)}`);
      console.log(`    Top-K Overlap:    ${result.aggregateMetrics.topKOverlap.toFixed(4)}`);
      if (result.aggregateMetrics.llmConsultationRate != null) {
        console.log(`    LLM Consult Rate: ${result.aggregateMetrics.llmConsultationRate.toFixed(4)}`);
      }
      if (result.aggregateMetrics.llmDivergence != null) {
        console.log(`    LLM Divergence:   ${result.aggregateMetrics.llmDivergence.toFixed(4)}`);
      }
      console.log('');
    }

    console.log('  Rationale:');
    console.log(`    ${result.rationale}`);
    console.log('');

    console.log('  Artifact Paths:');
    for (const p of result.artifactPaths) {
      const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
      const relPath = path.relative(options.workDir, p);
      console.log(`    ${relPath} (${size} bytes)`);
    }
    console.log('');

    // Count and show artifact rows in DB
    const artifacts = hypothesisRepo.getResearchArtifactsByEvaluationId(result.evaluation.id);
    console.log(`  DB Artifact Rows: ${artifacts.length}`);
    for (const a of artifacts) {
      console.log(`    [${a.artifactType}] ${a.filePath} — ${a.label}`);
    }

    console.log('');
    console.log('  Done.');

    process.exitCode = result.finalStatus === HypothesisEvaluationStatus.Failed ? 1 : 0;
  } catch (error) {
    console.error('Hypothesis evaluation failed:', error);
    process.exitCode = 1;
  } finally {
    dbManager.close();
    process.chdir(originalCwd);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
