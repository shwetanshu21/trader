// ── Lifecycle promotion CLI (Upstox walk-forward winner) ──
// Reads the latest walk-forward winner from the project DB and evaluates
// whether the strategy should be promoted through the lifecycle governance
// pipeline (backtest → paper → live).
//
// Exit codes:
//   0 — Evaluation completed (PROMOTE or HOLD, both are valid outcomes)
//   1 — Error during evaluation (DB connection, missing winner, etc.)

import { DatabaseManager } from '../persistence/sqlite.js';
import { WalkForwardRepository } from '../persistence/walk-forward-repo.js';
import { StrategyLifecycleRepository } from '../persistence/strategy-lifecycle-repo.js';
import { StrategyLifecycleEvaluator } from '../lifecycle/strategy-lifecycle-evaluator.js';
import { GovernanceVerdict } from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface PromoteOptions {
  dbPath: string;
  runId: number | null;
  strategyId: string;
  strategyVersion: string;
  marketId: string;
  minMergedScore: number;
  minSharpeRatio: number;
  maxDrawdown: number;
  minWindowCount: number;
  minOutOfSampleWindows: number;
}

function parseArgs(argv: string[]): PromoteOptions {
  const options: PromoteOptions = {
    dbPath: 'data/trader-upstox.db',
    runId: null,
    strategyId: 'india-nse-eq-v1',
    strategyVersion: '1.0.0',
    marketId: 'INDIA_NSE_EQ',
    minMergedScore: 0.7,
    minSharpeRatio: 1.0,
    maxDrawdown: 30,
    minWindowCount: 2,
    minOutOfSampleWindows: 1,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      case '--db-path':
        options.dbPath = value; i++; break;
      case '--run-id':
        options.runId = Number(value); i++; break;
      case '--strategy-id':
        options.strategyId = value; i++; break;
      case '--strategy-version':
        options.strategyVersion = value; i++; break;
      case '--market-id':
        options.marketId = value; i++; break;
      case '--min-merged-score':
        options.minMergedScore = Number(value); i++; break;
      case '--min-sharpe':
        options.minSharpeRatio = Number(value); i++; break;
      case '--max-drawdown':
        options.maxDrawdown = Number(value); i++; break;
      case '--min-windows':
        options.minWindowCount = Number(value); i++; break;
      case '--min-oos-windows':
        options.minOutOfSampleWindows = Number(value); i++; break;
      default:
        console.error(`Unknown option: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return options;
}

function printUsage(): void {
  console.log(`
Usage: npx tsx src/replay/walk-forward-promote-upstox-main.ts [options]

Evaluate and promote a walk-forward winner through the lifecycle governance pipeline.

Options:
  --db-path <path>          Project SQLite database path (default: data/trader-upstox.db)
  --run-id <n>              Walk-forward run ID (default: latest winner's run)
  --strategy-id <s>         Strategy identity (default: india-nse-eq-v1)
  --strategy-version <s>    Strategy version (default: 1.0.0)
  --market-id <s>           Market profile ID (default: INDIA_NSE_EQ)
  --min-merged-score <n>    Minimum merged score threshold (default: 0.7)
  --min-sharpe <n>          Minimum Sharpe ratio threshold (default: 1.0)
  --max-drawdown <n>        Maximum drawdown % threshold (default: 30)
  --min-windows <n>         Minimum total window count (default: 2)
  --min-oos-windows <n>     Minimum out-of-sample window count (default: 1)
  --help, -h                Show this help
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dbManager = new DatabaseManager(options.dbPath);
  const walkForwardRepo = new WalkForwardRepository(dbManager.db);
  const lifecycleRepo = new StrategyLifecycleRepository(dbManager.db);
  const evaluator = new StrategyLifecycleEvaluator({
    walkForwardRepo,
    lifecycleRepo,
  });

  // Resolve run ID: use the provided one, or find the latest winner
  let runId = options.runId;
  if (runId === null) {
    const winners = dbManager.db.prepare(
      'SELECT run_id FROM walk_forward_winners ORDER BY selected_at DESC LIMIT 1',
    ).get() as { run_id: number } | undefined;

    if (!winners) {
      console.error('No walk-forward winner found. Run walk-forward-select-winner-upstox first.');
      dbManager.close();
      process.exit(0); // Not an error — just nothing to promote
    }
    runId = winners.run_id;
  }

  // Build threshold config
  const thresholds = {
    minMergedScore: options.minMergedScore,
    minSharpeRatio: options.minSharpeRatio,
    maxDrawdown: options.maxDrawdown,
    minWindowCount: options.minWindowCount,
    minOutOfSampleWindows: options.minOutOfSampleWindows,
  };

  // Run evaluation
  const result = evaluator.evaluate({
    runId,
    strategyId: options.strategyId,
    strategyVersion: options.strategyVersion,
    marketId: options.marketId,
    thresholds,
  });

  // ── Banner ──
  const verdictLabel = result.verdict === GovernanceVerdict.Promote ? 'PROMOTE' : 'HOLD';
  const phaseArrow =
    result.previousPhase !== result.newPhase
      ? `${result.previousPhase} → ${result.newPhase}`
      : `${result.previousPhase} (no change)`;

  console.log('─────────────────────────────────────────────────────────────');
  console.log('  Lifecycle Promotion Evaluation');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`  DB path:         ${options.dbPath}`);
  console.log(`  Run ID:          ${runId}`);
  console.log(`  Strategy:        ${options.strategyId}@${options.strategyVersion}:${options.marketId}`);
  console.log(`  Verdict:         ${verdictLabel}`);
  console.log(`  Phase:           ${phaseArrow}`);
  console.log(`  State updated:   ${result.stateUpdated}`);
  console.log('');
  console.log('  Rationale:');
  console.log(`    ${result.rationale}`);
  console.log('');
  console.log('  Evidence Snapshot:');
  const ev = result.evidenceSnapshot;
  console.log(`    mergedScore:           ${ev.mergedScore?.toFixed(4) ?? 'N/A'}`);
  console.log(`    avgSharpeRatio:        ${ev.avgSharpeRatio?.toFixed(4) ?? 'N/A'}`);
  console.log(`    maxDrawdown:           ${ev.maxDrawdown?.toFixed(2) ?? 'N/A'}%`);
  console.log(`    oosWindowCount:        ${ev.outOfSampleWindowCount}`);
  console.log(`    totalWindowCount:      ${ev.totalWindowCount}`);
  console.log(`    winnerResult:          ${ev.winnerResult}`);
  console.log(`    selectedTrialLabel:    ${ev.selectedTrialLabel ?? 'N/A'}`);
  console.log('');
  console.log('  Thresholds:');
  console.log(`    minMergedScore:        ${thresholds.minMergedScore}`);
  console.log(`    minSharpeRatio:        ${thresholds.minSharpeRatio}`);
  console.log(`    maxDrawdown:           ${thresholds.maxDrawdown}%`);
  console.log(`    minWindowCount:        ${thresholds.minWindowCount}`);
  console.log(`    minOutOfSampleWindows: ${thresholds.minOutOfSampleWindows}`);

  // Print decision ID when promoted
  if (result.verdict === GovernanceVerdict.Promote) {
    console.log('');
    console.log(`  Decision ID:     ${result.decision.id}`);
    console.log(`  New lifecycle:   ${result.currentState.phase} (updated at ${new Date(result.currentState.updatedAt).toISOString()})`);
  }

  dbManager.close();
}

main().catch(error => {
  console.error('Lifecycle promotion failed:', error);
  process.exit(1);
});
