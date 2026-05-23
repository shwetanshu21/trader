// ── Generate Hypothesis CLI Entrypoint ──
// Env-aware entrypoint that loads .env, resolves the project DB path,
// builds ProposalEngineConfig from the existing config/env seam, selects
// recent internal strategy-run context, invokes the real
// HypothesisGenerationService, and emits operator-readable JSON.
//
// Usage:
//   npx tsx src/research/generate-hypothesis-main.ts [options]
//
// Options:
//   --db-path <string>        Path to SQLite database (default: from env or auto-resolved).
//   --instruction <string>    Instruction text for the provider prompt (default: see below).
//   --skip-evaluation         Skip the evaluation step even when configured.
//   --max-candidates <number> Max context candidates from recent strategy run.
//   --dry-run                 Validate env/config without calling the provider.
//   --show-raw-output         Include full raw provider output in JSON (omitted by default;
//                             output preview + content hash are always included).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../config/env.js';
import { DatabaseManager } from '../persistence/sqlite.js';
import { HypothesisGenerationRepository } from '../persistence/hypothesis-generation-repo.js';
import { HypothesisRepository } from '../persistence/hypothesis-repo.js';
import { HypothesisMemoryRepository } from '../persistence/hypothesis-memory-repo.js';
import { StrategyRunRepository } from '../persistence/strategy-run-repo.js';
import { StrategyLifecycleRepository } from '../persistence/strategy-lifecycle-repo.js';
import { WalkForwardRepository } from '../persistence/walk-forward-repo.js';
import { ResearchAuditService } from './research-audit-service.js';
import { HypothesisValidator } from './hypothesis-validator.js';
import { HypothesisResearchEvaluator } from './hypothesis-evaluator.js';
import { ResearchArtifactWriter } from './artifact-writer.js';
import { HypothesisGenerationService } from './hypothesis-generation-service.js';
import { IndiaResearchBuilder } from '../strategy/india-research.js';
import { FixtureHistoricalDataProvider } from '../replay/historical-data-provider.js';
import { WalkForwardEvaluator } from '../replay/walk-forward-evaluator.js';
import { WinnerSelector } from '../replay/winner-selection.js';
import { INDIA_NSE_EQ_MARKET } from '../market/india-profile.js';
import { loadProjectEnvFile, resolveWalkForwardDbPath } from '../replay/walk-forward-db-path.js';
import {
  GenerationVerdict,
  type ProposalEngineConfig,
  type HypothesisGenerationConfig,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INSTRUCTION = 'Generate one novel trading hypothesis for NSE India equities using mean-reversion or trend-following signals. Focus on liquid stocks (volume > 500k). Combine entry and exit rules with an ATR-based risk stop. Return a valid hypothesis graph JSON object.';

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------

interface GenerateOptions {
  dbPath: string;
  instruction: string;
  skipEvaluation: boolean;
  maxCandidates: number;
  dryRun: boolean;
  showRawOutput: boolean;
}

function parseArgs(argv: string[]): GenerateOptions {
  const options: GenerateOptions = {
    dbPath: '',
    instruction: DEFAULT_INSTRUCTION,
    skipEvaluation: false,
    maxCandidates: 5,
    dryRun: false,
    showRawOutput: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];

    switch (arg) {
      case '--db-path':
        options.dbPath = value;
        i++;
        break;
      case '--instruction':
        options.instruction = value;
        i++;
        break;
      case '--skip-evaluation':
        options.skipEvaluation = true;
        break;
      case '--max-candidates':
        options.maxCandidates = Number(value);
        if (!Number.isFinite(options.maxCandidates) || options.maxCandidates < 1) {
          throw new Error('--max-candidates must be a positive integer.');
        }
        i++;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--show-raw-output':
        options.showRawOutput = true;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        // positional arguments are ignored
        break;
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Build ProposalEngineConfig from env (reuses the canonical config loader)
// ---------------------------------------------------------------------------

function buildProposalConfigFromEnv(): ProposalEngineConfig | null {
  const config = loadConfig(process.env);
  return config.proposalEngine;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Load .env file
  loadProjectEnvFile();

  // 2. Parse CLI options
  const options = parseArgs(process.argv.slice(2));

  // 3. Build ProposalEngineConfig from env
  const proposalConfig = buildProposalConfigFromEnv();

  if (!proposalConfig) {
    console.log(JSON.stringify({
      status: 'skipped',
      reason: 'No proposal engine configuration found in environment. Set TRADER_PROPOSAL_PROVIDER_URL and related env vars.',
      timestamp: new Date().toISOString(),
    }, null, 2));
    process.exit(0);
  }

  // 4. Resolve DB path
  const dbPath = resolveWalkForwardDbPath(options.dbPath || undefined, process.env);

  if (!fs.existsSync(dbPath)) {
    console.log(JSON.stringify({
      status: 'error',
      reason: `Database path does not exist: ${dbPath}`,
      timestamp: new Date().toISOString(),
    }, null, 2));
    process.exit(1);
  }

  if (options.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      providerUrl: proposalConfig.providerUrl,
      providerMode: proposalConfig.providerMode,
      providerModel: proposalConfig.providerModel ?? null,
      dbPath,
      instruction: options.instruction,
      skipEvaluation: options.skipEvaluation,
      maxCandidates: options.maxCandidates,
      timestamp: new Date().toISOString(),
    }, null, 2));
    process.exit(0);
  }

  // 5. Open DB and create services
  const dbManager = new DatabaseManager(dbPath);
  const db = dbManager.db;

  try {
    const hypothesisRepo = new HypothesisRepository(db);
    const memoryRepo = new HypothesisMemoryRepository(db);
    const generationRepo = new HypothesisGenerationRepository(db);
    const strategyRunRepo = new StrategyRunRepository(db);
    const walkForwardRepo = new WalkForwardRepository(db);

    const validator = new HypothesisValidator({ memoryRepo, hypothesisRepo });

    // Wire optional evaluator when not skipped
    let evaluator: HypothesisResearchEvaluator | undefined;

    if (!options.skipEvaluation) {
      const dataProvider = new FixtureHistoricalDataProvider({
        candidates: [],
        rangeStart: Date.now() - 30 * 86_400_000,
        rangeEnd: Date.now(),
      });

      const walkForwardEval = new WalkForwardEvaluator({
        db,
        marketProfile: INDIA_NSE_EQ_MARKET,
        dataProvider,
      });

      const artifactWriter = new ResearchArtifactWriter();
      const winnerSelector = new WinnerSelector();

      evaluator = new HypothesisResearchEvaluator({
        db,
        dataProvider,
        marketProfile: INDIA_NSE_EQ_MARKET,
        hypothesisRepo,
        walkForwardRepo,
        artifactWriter,
        winnerSelector,
        walkForwardEvaluator: walkForwardEval,
      });
    }

    // 6. Build generation config
    const config: HypothesisGenerationConfig = {
      instruction: options.instruction,
      skipEvaluation: options.skipEvaluation,
      maxContextCandidates: options.maxCandidates,
      marketId: 'INDIA_NSE_EQ',
    };

    // Wire India research evidence builder
    const indiaResearchBuilder = new IndiaResearchBuilder();

    // 7. Create generation service
    const generationService = new HypothesisGenerationService({
      db,
      config: proposalConfig,
      hypothesisRepo,
      generationRepo,
      memoryRepo,
      validator,
      evaluator,
      strategyRunRepo,
      indiaResearchBuilder,
    });

    // 8. Generate hypothesis
    console.error('Calling provider...');
    const startTime = Date.now();
    const result = await generationService.generate(config);
    const elapsed = Date.now() - startTime;

    // 9. Build output
    const output: Record<string, unknown> = {
      status: result.kind,
      timestamp: new Date().toISOString(),
      durationMs: elapsed,
      provider: {
        url: proposalConfig.providerUrl,
        mode: proposalConfig.providerMode,
        model: proposalConfig.providerModel ?? null,
      },
      attempt: {
        id: result.attempt.id,
        verdict: result.attempt.verdict,
        createdAt: result.attempt.createdAt,
        reasons: result.attempt.reasons,
        outputPreview: result.attempt.rawOutputPreview,
        outputContentHash: result.attempt.rawOutputContentHash,
      },
    };

    if (result.kind === 'accepted') {
      output.hypothesisId = result.hypothesis.id;
      output.hypothesisStatus = result.hypothesis.status;
      output.canonicalHash = result.hypothesis.canonicalHash;
      output.evaluationId = result.evaluation?.evaluation?.id ?? null;
      output.evaluationStatus = result.evaluation?.evaluation?.status ?? null;

      // Load audit snapshot for full lineage
      if (result.hypothesis.canonicalHash) {
        const lifecycleRepo = new StrategyLifecycleRepository(db);
        const auditService = new ResearchAuditService({
          hypothesisRepo,
          memoryRepo,
          lifecycleRepo,
          generationRepo,
        });
        output.lineage = auditService.assembleLineage(result.hypothesis.canonicalHash);
      }
    } else if (result.kind === 'rejected') {
      // By default emit preview + hash instead of full raw output
      // Use --show-raw-output to include the full provider body
      if (options.showRawOutput) {
        output.rawProviderOutput = result.rawProviderOutput;
      }
      output.reasons = result.attempt.reasons;
    } else if (result.kind === 'skipped') {
      if (options.showRawOutput) {
        output.rawProviderOutput = result.rawProviderOutput;
      }
      output.reason = result.reason;
    } else if (result.kind === 'provider_error') {
      output.error = result.error;
    } else if (result.kind === 'accepted_without_evaluation') {
      output.hypothesisId = result.hypothesis.id;
      output.hypothesisStatus = result.hypothesis.status;
      output.canonicalHash = result.hypothesis.canonicalHash;
      output.evaluationError = result.evaluationError;

      // Load audit snapshot for full lineage
      if (result.hypothesis.canonicalHash) {
        const lifecycleRepo = new StrategyLifecycleRepository(db);
        const auditService = new ResearchAuditService({
          hypothesisRepo,
          memoryRepo,
          lifecycleRepo,
          generationRepo,
        });
        output.lineage = auditService.assembleLineage(result.hypothesis.canonicalHash);
      }
    }

    // 10. Emit operator-readable JSON
    console.log(JSON.stringify(output, null, 2));

    // Exit with error for provider errors or missing evaluation linkage
    if (result.kind === 'provider_error' || result.kind === 'accepted_without_evaluation') {
      process.exit(1);
    }
  } finally {
    dbManager.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString(),
  }, null, 2));
  process.exit(1);
});
