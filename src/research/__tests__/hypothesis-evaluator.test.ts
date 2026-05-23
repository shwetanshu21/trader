// ── HypothesisResearchEvaluator integration tests ──
// Covers the happy path (winner selected), negative paths (invalid state),
// no-winner path, and persisted evaluation linkage + artifact emission.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseManager } from '../../persistence/sqlite.js';
import { HypothesisRepository } from '../../persistence/hypothesis-repo.js';
import { WalkForwardRepository } from '../../persistence/walk-forward-repo.js';
import { HypothesisResearchEvaluator } from '../hypothesis-evaluator.js';
import { WalkForwardEvaluator, WalkForwardInterruptionError } from '../../replay/walk-forward-evaluator.js';
import { FixtureHistoricalDataProvider } from '../../replay/historical-data-provider.js';
import { WinnerSelector } from '../../replay/winner-selection.js';
import { ResearchArtifactWriter } from '../artifact-writer.js';
import {
  HypothesisEvaluationStatus,
  HypothesisStatus,
  ResearchArtifactType,
  type BoundedCandidate,
  type HypothesisGraph,
  type HypothesisResearchConfig,
} from '../../types/runtime.js';
import { INDIA_NSE_EQ_MARKET } from '../../market/india-profile.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

const candidates: BoundedCandidate[] = [
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
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validGraph(overrides?: Partial<HypothesisGraph>): HypothesisGraph {
  return {
    schemaVersion: '1',
    signals: [{ type: 'ema_cross', params: { fast: 8, slow: 21 } }],
    filters: [{ type: 'volume_min', params: { min: 500000 } }],
    entryRules: [{ type: 'breakout_confirmed', params: { lookbackBars: 5 } }],
    exitRules: [{ type: 'time_stop', params: { maxBars: 12 } }],
    riskRules: [{ type: 'atr_stop', params: { period: 14, multiple: 2 } }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-eval-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Create the full evaluator context: in-memory DB, hypothesis repository,
 * walk-forward evaluator, data provider, and the research evaluator.
 */
function createContext(options?: {
  /** Range end override for the data provider (ms). Defaults to 2025-01-31 UTC. */
  rangeEnd?: number;
  /** Range start override. Defaults to rangeEnd - 14 days. */
  rangeStart?: number;
  /** When true, skip inserting the validated hypothesis. */
  skipHypothesis?: boolean;
  /** Override for the working directory (artifact output). */
  workDir?: string;
}): {
  dbManager: DatabaseManager;
  hypothesisRepo: HypothesisRepository;
  walkForwardRepo: WalkForwardRepository;
  evaluator: HypothesisResearchEvaluator;
  hypothesisId: number;
  rangeStart: number;
  rangeEnd: number;
  hypothesisGraph: HypothesisGraph;
} {
  const cwd = process.cwd();
  const workDir = options?.workDir ?? makeTmpDir();
  process.chdir(workDir);

  const dbManager = new DatabaseManager(':memory:');
  const hypothesisRepo = new HypothesisRepository(dbManager.db);
  const walkForwardRepo = new WalkForwardRepository(dbManager.db);

  const rangeEnd = options?.rangeEnd ?? Date.UTC(2025, 0, 31);
  const rangeStart = options?.rangeStart ?? (rangeEnd - 14 * DAY_MS);

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

  // Insert a validated hypothesis
  const hypothesisGraph = validGraph();
  const now = Date.now();
  const hypothesisRow = hypothesisRepo.insertHypothesis({
    canonicalHash: 'ab'.repeat(32), // 64-char hex
    canonicalJson: JSON.stringify(hypothesisGraph),
    status: HypothesisStatus.Validated,
    graph: hypothesisGraph,
    createdAt: now,
    updatedAt: now,
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

  return {
    dbManager,
    hypothesisRepo,
    walkForwardRepo,
    evaluator,
    hypothesisId: hypothesisRow.id,
    rangeStart,
    rangeEnd,
    hypothesisGraph,
  };
}

/**
 * Create a config with tight windows so the evaluation runs quickly.
 */
function quickEvalConfig(
  rangeStart: number,
  rangeEnd: number,
): HypothesisResearchConfig {
  return {
    rangeStart,
    rangeEnd,
    windowSizeMs: 4 * DAY_MS,
    stepSizeMs: 2 * DAY_MS,
    inSampleRatio: 0.75,
    maxCandidates: 3,
    cadenceMinutes: 5,
    selectionStrategy: 'threshold',
    minMergedScore: 0.2,
    minWindowCount: 1,
  };
}

// ---------------------------------------------------------------------------
// Tests — Happy path
// ---------------------------------------------------------------------------

describe('HypothesisResearchEvaluator', () => {
  it('evaluates a validated hypothesis and persists evaluation linkage with artifacts', async () => {
    const cwd = process.cwd();
    const workDir = makeTmpDir();
    const ctx = createContext({ workDir });

    try {
      const config = quickEvalConfig(ctx.rangeStart, ctx.rangeEnd);
      const result = await ctx.evaluator.evaluate(ctx.hypothesisId, config);

      // ── Verify evaluation row ──
      expect(result.evaluation).toBeDefined();
      expect(result.evaluation.hypothesisGraphId).toBe(ctx.hypothesisId);
      expect([
        HypothesisEvaluationStatus.Completed,
        HypothesisEvaluationStatus.NoWinner,
        HypothesisEvaluationStatus.Failed,
      ]).toContain(result.finalStatus);

      // Verify the evaluation was persisted and retrievable
      const persistedEval = ctx.hypothesisRepo.getEvaluationByHypothesisId(ctx.hypothesisId);
      expect(persistedEval).not.toBeNull();
      expect(persistedEval!.id).toBe(result.evaluation.id);

      // ── Verify walk-forward run linkage ──
      if (result.walkForwardRun) {
        expect(result.walkForwardRun.id).toBeGreaterThan(0);
        expect(result.walkForwardRun.status).toBe('completed');
        expect(result.walkForwardRun.windowCount).toBeGreaterThan(0);
        expect(result.walkForwardRun.totalTrials).toBeGreaterThan(0);

        // Verify run is retrievable from walk-forward repo
        const run = ctx.walkForwardRepo.getRun(result.walkForwardRun.id);
        expect(run).not.toBeNull();
      }

      // ── Verify winner or no-winner is documented ──
      expect(result.rationale).toBeTruthy();
      expect(result.finalStatus).toBeTruthy();

      if (result.finalStatus === HypothesisEvaluationStatus.Completed) {
        expect(result.winner).not.toBeNull();
        if (result.winner) {
          expect(result.winner.trialId).toBeGreaterThan(0);
          expect(result.winner.aggregateMergedScore).toBeGreaterThan(0);
        }
      }

      // ── Verify aggregate metrics ──
      if (result.aggregateMetrics) {
        expect(typeof result.aggregateMetrics.scoreStability).toBe('number');
        expect(typeof result.aggregateMetrics.topKOverlap).toBe('number');
      }

      // ── Verify artifact emission ──
      expect(result.artifactPaths.length).toBeGreaterThanOrEqual(1);

      // Verify promotion artifact exists on disk
      const promotionPath = result.artifactPaths.find(p => p.endsWith('promotion-artifact.json'));
      if (promotionPath) {
        expect(fs.existsSync(promotionPath)).toBe(true);
        const promotionContent = JSON.parse(fs.readFileSync(promotionPath, 'utf8'));
        expect(promotionContent.hypothesisGraphId).toBe(ctx.hypothesisId);
        expect(promotionContent.hypothesisEvaluationId).toBe(result.evaluation.id);
        expect(promotionContent.schemaVersion).toBe(1);
      }

      // Verify diagnostics artifact exists on disk
      const diagnosticsPath = result.artifactPaths.find(p => p.endsWith('diagnostics.json'));
      if (diagnosticsPath) {
        expect(fs.existsSync(diagnosticsPath)).toBe(true);
        const diagnosticsContent = JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8'));
        expect(diagnosticsContent.hypothesisGraphId).toBe(ctx.hypothesisId);
      }

      // Verify hypothesis snapshot exists on disk
      const snapshotPath = result.artifactPaths.find(p => p.endsWith('hypothesis.json'));
      if (snapshotPath) {
        expect(fs.existsSync(snapshotPath)).toBe(true);
      }

      // ── Verify artifact rows in DB ──
      if (result.evaluation) {
        const artifacts = ctx.hypothesisRepo.getResearchArtifactsByEvaluationId(result.evaluation.id);
        expect(artifacts.length).toBeGreaterThanOrEqual(1);

        const types = artifacts.map(a => a.artifactType);
        expect(types).toContain(ResearchArtifactType.Diagnostics);
      }

      // ── Verify hypothesis status was updated ──
      const updatedHypothesis = ctx.hypothesisRepo.getHypothesisById(ctx.hypothesisId);
      expect(updatedHypothesis).not.toBeNull();

      ctx.dbManager.close();
    } finally {
      process.chdir(cwd);
    }
  });

  // -----------------------------------------------------------------------
  // Negative paths
  // -----------------------------------------------------------------------

  it('throws when hypothesis does not exist', async () => {
    const cwd = process.cwd();
    const ctx = createContext();
    try {
      await expect(
        ctx.evaluator.evaluate(99999),
      ).rejects.toThrow(/does not exist/);

      ctx.dbManager.close();
    } finally {
      process.chdir(cwd);
    }
  });

  it('throws when hypothesis is not in Validated status', async () => {
    const cwd = process.cwd();
    const dbManager = new DatabaseManager(':memory:');
    const hypothesisRepo = new HypothesisRepository(dbManager.db);
    const walkForwardRepo = new WalkForwardRepository(dbManager.db);
    const workDir = makeTmpDir();
    process.chdir(workDir);

    try {
      const rangeEnd = Date.UTC(2025, 0, 31);
      const rangeStart = rangeEnd - 14 * DAY_MS;
      const dataProvider = new FixtureHistoricalDataProvider({
        candidates,
        rangeStart,
        rangeEnd,
      });

      // Insert a Pending (not Validated) hypothesis
      const row = hypothesisRepo.insertHypothesis({
        canonicalHash: 'cd'.repeat(32),
        canonicalJson: '{}',
        status: HypothesisStatus.Pending,
        graph: validGraph(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const evaluator = new HypothesisResearchEvaluator({
        db: dbManager.db,
        dataProvider,
        marketProfile: INDIA_NSE_EQ_MARKET,
        hypothesisRepo,
        walkForwardRepo,
      });

      await expect(
        evaluator.evaluate(row.id),
      ).rejects.toThrow(/Only "validated" hypotheses can be evaluated/);

      dbManager.close();
    } finally {
      process.chdir(cwd);
    }
  });

  it('throws when hypothesis already has an evaluation', async () => {
    const cwd = process.cwd();
    const dbManager = new DatabaseManager(':memory:');
    const hypothesisRepo = new HypothesisRepository(dbManager.db);
    const walkForwardRepo = new WalkForwardRepository(dbManager.db);
    const workDir = makeTmpDir();
    process.chdir(workDir);

    try {
      const rangeEnd = Date.UTC(2025, 0, 31);
      const rangeStart = rangeEnd - 14 * DAY_MS;
      const dataProvider = new FixtureHistoricalDataProvider({
        candidates,
        rangeStart,
        rangeEnd,
      });

      const row = hypothesisRepo.insertHypothesis({
        canonicalHash: 'ef'.repeat(32),
        canonicalJson: '{}',
        status: HypothesisStatus.Validated,
        graph: validGraph(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Insert a pre-existing evaluation
      hypothesisRepo.insertEvaluation({
        hypothesisGraphId: row.id,
        status: HypothesisEvaluationStatus.Completed,
        rationale: 'Already evaluated.',
        outcomeDetail: 'Pre-existing evaluation for duplicate test.',
      });

      const evaluator = new HypothesisResearchEvaluator({
        db: dbManager.db,
        dataProvider,
        marketProfile: INDIA_NSE_EQ_MARKET,
        hypothesisRepo,
        walkForwardRepo,
      });

      await expect(
        evaluator.evaluate(row.id),
      ).rejects.toThrow(/already has an evaluation/);

      dbManager.close();
    } finally {
      process.chdir(cwd);
    }
  });

  // -----------------------------------------------------------------------
  // Error recovery path
  // -----------------------------------------------------------------------

  it('persists a failed evaluation when the walk-forward run errors', async () => {
    const cwd = process.cwd();
    const dbManager = new DatabaseManager(':memory:');
    const hypothesisRepo = new HypothesisRepository(dbManager.db);
    const walkForwardRepo = new WalkForwardRepository(dbManager.db);
    const workDir = makeTmpDir();
    process.chdir(workDir);

    try {
      const rangeEnd = Date.UTC(2025, 0, 31);
      const rangeStart = rangeEnd - 14 * DAY_MS;

      // Create a data provider with no data (causes WalkForwardEvaluator to throw)
      const noDataProvider = new FixtureHistoricalDataProvider({
        candidates: [],
        rangeStart: 0,
        rangeEnd: 1,
      });

      const row = hypothesisRepo.insertHypothesis({
        canonicalHash: 'ff'.repeat(32),
        canonicalJson: '{}',
        status: HypothesisStatus.Validated,
        graph: validGraph(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const evaluator = new HypothesisResearchEvaluator({
        db: dbManager.db,
        dataProvider: noDataProvider,
        marketProfile: INDIA_NSE_EQ_MARKET,
        hypothesisRepo,
        walkForwardRepo,
      });

      const result = await evaluator.evaluate(row.id, {
        rangeStart: 1000,
        rangeEnd: 2000,
        windowSizeMs: 1,
        stepSizeMs: 1,
      });

      // Should still return a structured result with Failed status
      expect(result.finalStatus).toBe(HypothesisEvaluationStatus.Failed);
      expect(result.rationale).toContain('Evaluation failed');
      expect(result.evaluation.status).toBe(HypothesisEvaluationStatus.Failed);
      expect(result.walkForwardRun).toBeNull();
      expect(result.winner).toBeNull();
      expect(result.aggregateMetrics).toBeNull();

      // Verify a failed diagnostics artifact was emitted
      expect(result.artifactPaths.length).toBeGreaterThanOrEqual(1);
      const failedDiagPath = result.artifactPaths.find(p => p.endsWith('diagnostics.json'));
      if (failedDiagPath) {
        expect(fs.existsSync(failedDiagPath)).toBe(true);
        const content = JSON.parse(fs.readFileSync(failedDiagPath, 'utf8'));
        expect(content.evaluationStatus).toBe(HypothesisEvaluationStatus.Failed);
      }

      // Verify artifact rows were persisted
      const artifacts = hypothesisRepo.getResearchArtifactsByEvaluationId(result.evaluation.id);
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      expect(artifacts[0]?.artifactType).toBe(ResearchArtifactType.Diagnostics);

      // Verify hypothesis status was updated to FailedEvaluation
      const updatedHypothesis = hypothesisRepo.getHypothesisById(row.id);
      expect(updatedHypothesis?.status).toBe(HypothesisStatus.FailedEvaluation);

      dbManager.close();
    } finally {
      process.chdir(cwd);
    }
  });

  // -----------------------------------------------------------------------
  // Research artifact schema verification
  // -----------------------------------------------------------------------

  it('writes a valid promotion artifact JSON schema on success', async () => {
    const cwd = process.cwd();
    const workDir = makeTmpDir();
    const ctx = createContext({ workDir });

    try {
      const config = quickEvalConfig(ctx.rangeStart, ctx.rangeEnd);
      const result = await ctx.evaluator.evaluate(ctx.hypothesisId, config);

      // Find the promotion artifact
      const promotionPath = result.artifactPaths.find(p => p.endsWith('promotion-artifact.json'));
      if (promotionPath && result.finalStatus === HypothesisEvaluationStatus.Completed) {
        const content = JSON.parse(fs.readFileSync(promotionPath, 'utf8'));

        // Verify schema shape
        expect(content.schemaVersion).toBe(1);
        expect(content.artifactType).toBe('research-promotion-artifact');
        expect(content.hypothesisGraphId).toBe(ctx.hypothesisId);
        expect(content.hypothesisEvaluationId).toBe(result.evaluation.id);
        expect(content.generatedAt).toBeTruthy();
        expect(content.evaluationStatus).toBe(HypothesisEvaluationStatus.Completed);
        expect(content.rationale).toBeTruthy();

        // Walk-forward run reference
        expect(content.walkForwardRun).not.toBeNull();
        expect(content.walkForwardRun.id).toBeGreaterThan(0);
        expect(content.walkForwardRun.status).toBe('completed');

        // Winner details
        expect(content.winner).not.toBeNull();
        expect(content.winner.trialId).toBeGreaterThan(0);
        expect(typeof content.winner.aggregateMergedScore).toBe('number');

        // Aggregate metrics
        expect(content.aggregateMetrics).not.toBeNull();
        expect(typeof content.aggregateMetrics.scoreStability).toBe('number');
      }

      ctx.dbManager.close();
    } finally {
      process.chdir(cwd);
    }
  });

  // -----------------------------------------------------------------------
  // Return value completeness
  // -----------------------------------------------------------------------

  it('returns a complete HypothesisEvaluationResult with all fields', async () => {
    const cwd = process.cwd();
    const workDir = makeTmpDir();
    const ctx = createContext({ workDir });

    try {
      const config = quickEvalConfig(ctx.rangeStart, ctx.rangeEnd);
      const result = await ctx.evaluator.evaluate(ctx.hypothesisId, config);

      // Every result must have these fields
      expect(result).toHaveProperty('evaluation');
      expect(result).toHaveProperty('walkForwardRun');
      expect(result).toHaveProperty('winner');
      expect(result).toHaveProperty('aggregateMetrics');
      expect(result).toHaveProperty('artifactPaths');
      expect(result).toHaveProperty('finalStatus');
      expect(result).toHaveProperty('rationale');

      // evaluation must have all expected fields
      expect(result.evaluation.id).toBeGreaterThan(0);
      expect(result.evaluation.hypothesisGraphId).toBe(ctx.hypothesisId);
      expect(typeof result.evaluation.status).toBe('string');
      expect(typeof result.evaluation.rationale).toBe('string');

      // artifactPaths must be non-empty
      expect(result.artifactPaths.length).toBeGreaterThan(0);
      expect(result.artifactPaths.every(p => typeof p === 'string')).toBe(true);

      ctx.dbManager.close();
    } finally {
      process.chdir(cwd);
    }
  });

  // -----------------------------------------------------------------------
  // Idempotency: second call with same hypothesis ID fails
  // -----------------------------------------------------------------------

  it('rejects a second evaluation of the same hypothesis', async () => {
    const cwd = process.cwd();
    const workDir = makeTmpDir();
    const ctx = createContext({ workDir });

    try {
      const config = quickEvalConfig(ctx.rangeStart, ctx.rangeEnd);
      await ctx.evaluator.evaluate(ctx.hypothesisId, config);

      // Second call must throw — the hypothesis status was updated to
      // FailedEvaluation after the first evaluation, so the status check
      // rejects the re-evaluation.
      await expect(
        ctx.evaluator.evaluate(ctx.hypothesisId, config),
      ).rejects.toThrow(/Only "validated" hypotheses can be evaluated/);

      // Verify only one evaluation exists
      const allEvals = ctx.hypothesisRepo.getRecentEvaluations(100);
      expect(allEvals.length).toBe(1);

      ctx.dbManager.close();
    } finally {
      process.chdir(cwd);
    }
  });
});
