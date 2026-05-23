// ── Publish Hypothesis CLI Entrypoint ──
// Governed publish-back handoff for a completed hypothesis evaluation.
// Loads the evaluation, runs governance checks (thresholds, prerequisites),
// and persists publication evidence + lifecycle state + governance decision
// inside one SQLite transaction. Modeled after evaluate-hypothesis-main.ts.
//
// Usage:
//   npx tsx src/research/publish-hypothesis-main.ts --hypothesis-id <id>
//
// Options:
//   --hypothesis-id <number>   Required: FK into hypothesis_evaluations for a completed row.
//   --db-path <string>         Path to SQLite database (default: :memory: for testing).
//   --min-score <number>       Minimum merged score threshold (default: 0.7).
//   --label <string>           Optional run label.
//   --dry-run                  Validate without persisting (default: false).

import { DatabaseManager } from '../persistence/sqlite.js';
import { HypothesisRepository } from '../persistence/hypothesis-repo.js';
import { StrategyLifecycleRepository } from '../persistence/strategy-lifecycle-repo.js';
import { ResearchPublishBackService } from './publish-back-service.js';
import {
  ResearchPublishBackVerdict,
  ResearchPublicationStatus,
  type ResearchPublishBackConfig,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------

interface PublishOptions {
  hypothesisId: number;
  dbPath: string;
  minScore: number;
  label: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): PublishOptions {
  const options: PublishOptions = {
    hypothesisId: 0,
    dbPath: ':memory:',
    minScore: 0.7,
    label: '',
    dryRun: false,
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
      case '--min-score':
        options.minScore = Number(value);
        i++;
        break;
      case '--label':
        options.label = value;
        i++;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.hypothesisId || options.hypothesisId <= 0) {
    throw new Error('--hypothesis-id is required and must be a positive integer.');
  }

  if (options.minScore < 0 || options.minScore > 1) {
    throw new Error('--min-score must be between 0 and 1.');
  }

  return options;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const dbManager = new DatabaseManager(options.dbPath);
  const hypothesisRepo = new HypothesisRepository(dbManager.db);
  const lifecycleRepo = new StrategyLifecycleRepository(dbManager.db);
  const publishBack = new ResearchPublishBackService({
    db: dbManager.db,
    hypothesisRepo,
    lifecycleRepo,
  });

  try {
    // ── Load the evaluation first for display ──
    const evaluation = hypothesisRepo.getEvaluationById(options.hypothesisId);
    if (!evaluation) {
      console.error(`Hypothesis evaluation ${options.hypothesisId} does not exist in the database.`);
      console.error(`DB path: ${options.dbPath}`);
      process.exitCode = 1;
      return;
    }

    console.log('─────────────────────────────────────────────────────────────');
    console.log('  Hypothesis Publish-Back (CLI)');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(`  Evaluation ID:   ${evaluation.id}`);
    console.log(`  Hypothesis ID:   ${evaluation.hypothesisGraphId}`);
    console.log(`  Status:          ${evaluation.status}`);
    console.log(`  DB path:         ${options.dbPath}`);
    console.log(`  Min score:       ${options.minScore}`);
    console.log(`  Dry run:         ${options.dryRun}`);
    if (options.label) {
      console.log(`  Label:           ${options.label}`);
    }
    console.log('');

    // ── Build config with CLI overrides ──
    const config: ResearchPublishBackConfig = {
      minMergedScore: options.minScore,
      dryRun: options.dryRun,
    };

    if (options.label) {
      config.label = options.label;
    }

    // ── Run publish-back ──
    console.log('  Running publish-back governance...');
    const startTime = Date.now();
    const result = publishBack.publish(options.hypothesisId, config);
    const elapsed = Date.now() - startTime;

    // ── Banner ──
    console.log('');
    console.log('─────────────────────────────────────────────────────────────');
    console.log('  Publish-Back Complete');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(`  Verdict:         ${result.verdict}`);
    console.log(`  Duration:        ${elapsed}ms`);
    console.log(`  Dry run:         ${result.isDryRun}`);
    console.log('');

    // ── Evaluation summary ──
    console.log('  Source Evaluation:');
    console.log(`    ID:            ${result.evaluation.id}`);
    console.log(`    Status:        ${result.evaluation.status}`);
    console.log(`    Hypothesis:    ${result.evaluation.hypothesisGraphId}`);
    console.log(`    Rationale:     ${result.evaluation.rationale}`);
    console.log('');

    // ── Winner details ──
    if (result.winner) {
      console.log('  Winner:');
      console.log(`    Merged Score:  ${result.winner.mergedScore?.toFixed(4) ?? 'N/A'}`);
      console.log(`    Det Score:     ${result.winner.deterministicScore?.toFixed(4) ?? 'N/A'}`);
      console.log('');
    }

    // ── Publication details ──
    if (result.publication) {
      console.log('  Publication:');
      console.log(`    ID:            ${result.publication.id}`);
      console.log(`    Status:        ${result.publication.status}`);
      console.log(`    Published At:  ${result.publication.publishedAt ? new Date(result.publication.publishedAt).toISOString() : 'N/A'}`);

      if (result.publication.strategyId) {
        console.log(`    Strategy ID:   ${result.publication.strategyId}`);
        console.log(`    Version:       ${result.publication.strategyVersion}`);
        console.log(`    Market ID:     ${result.publication.marketId}`);
      }

      if (result.publication.lifecycleStateId != null) {
        console.log(`    Lifecycle ID:  ${result.publication.lifecycleStateId}`);
      }
      if (result.publication.governanceDecisionId != null) {
        console.log(`    Governance ID: ${result.publication.governanceDecisionId}`);
      }
      console.log('');
    } else if (result.isDryRun) {
      console.log('  (No records persisted — dry run)');
      console.log('');
    }

    // ── Rationale ──
    console.log('  Rationale:');
    console.log(`    ${result.rationale}`);
    console.log('');

    // ── Evidence snapshot (when publication exists) ──
    if (result.publication && result.publication.evidenceJson) {
      try {
        const evidence = JSON.parse(result.publication.evidenceJson);
        console.log('  Evidence Snapshot:');
        console.log(`    Min Score:        ${evidence.minMergedScore}`);
        console.log(`    Actual Score:     ${evidence.actualMergedScore ?? 'N/A'}`);
        console.log(`    Promotion Artifact: ${evidence.hasPromotionArtifact}`);
        console.log(`    Artifact Count:   ${evidence.artifactCount}`);
        console.log(`    Has Winner:       ${evidence.hasWinner}`);
        if (evidence.holdReasons?.length > 0) {
          console.log(`    Hold Reasons (${evidence.holdReasons.length}):`);
          for (const reason of evidence.holdReasons) {
            console.log(`      - ${reason}`);
          }
        }
        console.log('');
      } catch {
        // evidence JSON parse error — skip display
      }
    }

    // ── Outcome ──
    if (result.verdict === ResearchPublishBackVerdict.Publish) {
      if (result.isDryRun) {
        console.log('  ✓ Dry-run would publish.');
      } else {
        console.log('  ✓ Published successfully.');
      }
    } else {
      console.log('  ✗ Publication withheld (hold/reject).');
      process.exitCode = 1;
    }

    console.log('');
    console.log('  Done.');
  } catch (error) {
    console.error('Publish-back failed:', error);
    process.exitCode = 1;
  } finally {
    dbManager.close();
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
