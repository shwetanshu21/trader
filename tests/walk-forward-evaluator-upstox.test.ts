// ── Walk-forward evaluator integration tests (Upstox) ──
// Tests the full pipeline composition: UpstoxHistoricalDataProvider +
// WalkForwardEvaluator + WinnerSelector + ArtifactEmitter + WalkForwardRepository
// with mocked fetch to avoid real API calls.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseManager } from '../src/persistence/sqlite.js';
import { WalkForwardEvaluator, type WalkForwardTrialConfig } from '../src/replay/walk-forward-evaluator.js';
import { WalkForwardRepository } from '../src/persistence/walk-forward-repo.js';
import { UpstoxRestClient } from '../src/upstox/upstox-rest-client.js';
import { UpstoxHistoricalDataProvider } from '../src/replay/upstox-historical-data-provider.js';
import { WinnerSelector } from '../src/replay/winner-selection.js';
import { ArtifactEmitter } from '../src/replay/artifact-emitter.js';
import { ReplayClock } from '../src/replay/replay-clock.js';
import {
  WalkForwardSelectionStrategy,
  WalkForwardSelectionResult,
  WalkForwardWindowType,
  type WalkForwardSelectionConfig,
} from '../src/replay/walk-forward-types.js';
import { INDIA_NSE_EQ_MARKET } from '../src/market/india-profile.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Trading session start/end on 2024-01-01 in IST (09:15-15:30 = 03:45-10:00 UTC). */
const SESSION_START_MS = 1704080700000; // 2024-01-01T03:45:00.000Z = 09:15 IST
const SESSION_END_MS = 1704103200000;   // 2024-01-01T10:00:00.000Z = 15:30 IST

/** Sample instruments. */
const INSTRUMENTS = [
  {
    instrument_key: 'NSE_EQ|INE002A01018',
    exchange: 'NSE',
    trading_symbol: 'RELIANCE',
    instrument_type: 'EQ',
    lot_size: 1,
    tick_size: 0.05,
  },
  {
    instrument_key: 'NSE_EQ|INE009A01021',
    exchange: 'NSE',
    trading_symbol: 'INFY',
    instrument_type: 'EQ',
    lot_size: 1,
    tick_size: 0.05,
  },
  {
    instrument_key: 'NSE_EQ|INE090A01021',
    exchange: 'NSE',
    trading_symbol: 'TCS',
    instrument_type: 'EQ',
    lot_size: 1,
    tick_size: 0.05,
  },
];

/** 5 instruments for maxInstruments test. */
const FIVE_INSTRUMENTS = [
  ...INSTRUMENTS,
  {
    instrument_key: 'NSE_EQ|INE000A01031',
    exchange: 'NSE',
    trading_symbol: 'HDFCBANK',
    instrument_type: 'EQ',
    lot_size: 1,
    tick_size: 0.05,
  },
  {
    instrument_key: 'NSE_EQ|INE030A01027',
    exchange: 'NSE',
    trading_symbol: 'SBIN',
    instrument_type: 'EQ',
    lot_size: 1,
    tick_size: 0.05,
  },
];

/** Generate 1-min candles for a single instrument over a date range. */
function generateCandles(
  startMs: number,
  endMs: number,
  basePrice: number,
  volume: number,
): Array<[number, number, number, number, number, number, number]> {
  const candles: Array<[number, number, number, number, number, number, number]> = [];
  const intervalMs = 60_000; // 1 minute
  let price = basePrice;

  for (let ts = startMs; ts < endMs; ts += intervalMs) {
    const open = price;
    const high = +(price * (1 + Math.random() * 0.002)).toFixed(2);
    const low = +(price * (1 - Math.random() * 0.002)).toFixed(2);
    const close = +((open + high + low) / 3).toFixed(2);
    const vol = Math.floor(volume * (0.8 + Math.random() * 0.4));
    candles.push([ts, open, high, low, close, vol, 0]);
    // Trending price for deterministic scores
    price = close;
  }

  return candles;
}

/** Deterministic candles (no randomness) for reproducible tests. */
function generateDeterministicCandles(
  startMs: number,
  endMs: number,
  basePrice: number,
  volume: number,
): Array<[number, number, number, number, number, number, number]> {
  const candles: Array<[number, number, number, number, number, number, number]> = [];
  const intervalMs = 60_000; // 1 minute
  const count = Math.max(0, Math.floor((endMs - startMs) / intervalMs));

  for (let i = 0; i < count; i++) {
    const ts = startMs + i * intervalMs;
    // Slight upward trend with small variance
    const price = +(basePrice * (1 + (i / count) * 0.01 + (Math.sin(i) * 0.001))).toFixed(2);
    const open = price;
    const high = +(price * 1.001).toFixed(2);
    const low = +(price * 0.999).toFixed(2);
    const close = price;
    candles.push([ts, open, high, low, close, volume, 0]);
  }

  return candles;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-wf-int-'));
  tempDirs.push(dir);
  return dir;
}

function writeTokenFile(dir: string): void {
  const tokenPath = path.join(dir, 'token.json');
  fs.writeFileSync(
    tokenPath,
    JSON.stringify({
      client_id: 'client-123',
      user_id: 'user-456',
      access_token: 'token-abc-123',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      issued_at: new Date().toISOString(),
      message_type: 'token',
    }),
  );
  process.env.TRADER_UPSTOX_TOKEN_PATH = tokenPath;
}

function writeConfigFile(
  dir: string,
  records: Array<{
    instrument_key: string;
    exchange: string;
    trading_symbol: string;
    instrument_type: string;
    lot_size: number;
    tick_size: number;
  }>,
): string {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(records, null, 2));
  return configPath;
}

/** Build a mock fetch implementation that returns synthetic candles. */
function buildMockFetch(candlesPerInstrument: Map<string, Array<[number, number, number, number, number, number, number]>>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      // Profile endpoint — called during UpstoxRestClient token validation
      if (url.includes('/v2/user/profile')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ status: 'success', data: { email: 'test@test.com' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      // Historical candles endpoint
      if (url.includes('/v2/historical-candles/')) {
        // Extract instrument key from URL
        // URL pattern: /v2/historical-candles/{instrument_key}/{interval}/{from}/{to}
        const match = url.match(/\/v2\/historical-candles\/([^/]+)/);
        const instrumentKey = match ? decodeURIComponent(match[1]) : '';

        const candles = candlesPerInstrument.get(instrumentKey);

        if (candles) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                status: 'success',
                data: { candles },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }

        // Unknown instrument — return empty candles
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'success',
              data: { candles: [] },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WalkForwardEvaluator (Upstox integration)', () => {
  describe('full pipeline smoke test', () => {
    it('completes evaluation and produces ranked candidates with deterministic scores', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const cacheDir = path.join(dir, 'cache');

      // Generate deterministic candles for each instrument
      const candles = new Map<string, Array<[number, number, number, number, number, number, number]>>();
      for (const instr of INSTRUMENTS) {
        candles.set(
          instr.instrument_key,
          generateDeterministicCandles(SESSION_START_MS, SESSION_END_MS, 2000, 100_000),
        );
      }
      // Give RELIANCE higher volume for better scores
      candles.set(
        INSTRUMENTS[0].instrument_key,
        generateDeterministicCandles(SESSION_START_MS, SESSION_END_MS, 2000, 500_000),
      );

      const mockFetch = buildMockFetch(candles);

      const dbManager = new DatabaseManager(':memory:');
      const restClient = new UpstoxRestClient();
      const dataProvider = new UpstoxHistoricalDataProvider({
        restClient,
        configPath,
        rangeStart: SESSION_START_MS,
        rangeEnd: SESSION_END_MS,
        cacheDir,
        maxInstruments: 3,
        options: { screeningCadenceMinutes: 5, executionResolutionMinutes: null },
      });

      // Use a high cadence clock to keep the test fast
      const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 60);
      const evaluator = new WalkForwardEvaluator({
        db: dbManager.db,
        marketProfile: INDIA_NSE_EQ_MARKET,
        dataProvider,
        clock,
      });

      const trialConfigs: WalkForwardTrialConfig[] = [
        { label: 'Config A (3 candidates)', params: { maxCandidates: 3 } },
        { label: 'Config B (5 candidates)', params: { maxCandidates: 5 } },
      ];

      const result = await evaluator.evaluate({
        rangeStart: SESSION_START_MS,
        rangeEnd: SESSION_END_MS,
        windowSizeMs: 3 * 3_600_000, // 3 hours
        stepSizeMs: 3 * 3_600_000,
        inSampleRatio: 0.5,
        label: 'int-test-smoke',
        strategyId: 'test-strategy-v1',
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
        trialConfigs,
      });

      // Verify evaluation completed
      expect(result.run.status).toBe('completed');
      expect(result.windows.length).toBeGreaterThanOrEqual(1);
      expect(result.trials.length).toBe(2);
      expect(result.rankedCandidates.length).toBe(2);

      // Verify deterministic scores are computed (non-negative, within [0,1])
      for (const candidate of result.rankedCandidates) {
        expect(candidate.deterministicScore).toBeGreaterThanOrEqual(0);
        expect(candidate.deterministicScore).toBeLessThanOrEqual(1);
        // merged score should match deterministic since no LLM
        expect(candidate.mergedScore).toBe(candidate.deterministicScore);
        expect(candidate.llmScore).toBeNull();
        expect(candidate.windowCount).toBeGreaterThanOrEqual(1);
      }

      // Verify candidates are sorted by rank
      for (let i = 0; i < result.rankedCandidates.length - 1; i++) {
        expect(result.rankedCandidates[i].rank).toBeLessThan(
          result.rankedCandidates[i + 1].rank,
        );
        expect(result.rankedCandidates[i].mergedScore).toBeGreaterThanOrEqual(
          result.rankedCandidates[i + 1].mergedScore,
        );
      }

      // Verify aggregate metrics
      expect(result.aggregateMetrics.scoreStability).toBeGreaterThanOrEqual(0);
      expect(result.aggregateMetrics.topKOverlap).toBeGreaterThanOrEqual(0);

      // Verify API calls were made for candle data
      const historicalCalls = mockFetch.mock.calls.filter(
        call => String(call[0]).includes('/v2/historical-candles/'),
      ).length;
      expect(historicalCalls).toBe(3); // 3 instruments

      dbManager.close();
    });

    it('handles instruments with no candle data gracefully (non-fatal)', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const cacheDir = path.join(dir, 'cache');

      // Only provide candles for 2 of 3 instruments
      const candles = new Map<string, Array<[number, number, number, number, number, number, number]>>();
      candles.set(
        INSTRUMENTS[0].instrument_key, // RELIANCE
        generateDeterministicCandles(SESSION_START_MS, SESSION_END_MS, 2000, 500_000),
      );
      candles.set(
        INSTRUMENTS[1].instrument_key, // INFY — no data, should produce empty
        [],
      );
      candles.set(
        INSTRUMENTS[2].instrument_key, // TCS
        generateDeterministicCandles(SESSION_START_MS, SESSION_END_MS, 3000, 200_000),
      );

      const mockFetch = buildMockFetch(candles);

      const dbManager = new DatabaseManager(':memory:');
      const restClient = new UpstoxRestClient();
      const dataProvider = new UpstoxHistoricalDataProvider({
        restClient,
        configPath,
        rangeStart: SESSION_START_MS,
        rangeEnd: SESSION_END_MS,
        cacheDir,
        maxInstruments: 3,
      });

      const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 60);
      const evaluator = new WalkForwardEvaluator({
        db: dbManager.db,
        marketProfile: INDIA_NSE_EQ_MARKET,
        dataProvider,
        clock,
      });

      const result = await evaluator.evaluate({
        rangeStart: SESSION_START_MS,
        rangeEnd: SESSION_END_MS,
        windowSizeMs: 3 * 3_600_000,
        stepSizeMs: 3 * 3_600_000,
        inSampleRatio: 0.5,
        label: 'int-test-missing-data',
        trialConfigs: [
          { label: 'Config A', params: { maxCandidates: 3 } },
        ],
      });

      expect(result.run.status).toBe('completed');
      // Even with missing data, evaluation completes
      expect(result.rankedCandidates.length).toBe(1);

      dbManager.close();
    });
  });

  describe('winner selection', () => {
    it('produces SELECTED or HOLD verdict with artifact emission and DB persistence', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const cacheDir = path.join(dir, 'cache');
      const artifactRoot = path.join(dir, 'artifacts');
      // Override the default artifacts root via a subdir that ArtifactEmitter writes to
      const actualArtifactDir = path.join(dir, 'data', 'artifacts', 'walk-forward');

      const candles = new Map<string, Array<[number, number, number, number, number, number, number]>>();
      for (const instr of INSTRUMENTS) {
        candles.set(
          instr.instrument_key,
          generateDeterministicCandles(SESSION_START_MS, SESSION_END_MS, 2000, 100_000),
        );
      }
      candles.set(
        INSTRUMENTS[0].instrument_key,
        generateDeterministicCandles(SESSION_START_MS, SESSION_END_MS, 2000, 500_000),
      );

      buildMockFetch(candles);

      const dbManager = new DatabaseManager(':memory:');
      const repo = new WalkForwardRepository(dbManager.db);
      const restClient = new UpstoxRestClient();
      const dataProvider = new UpstoxHistoricalDataProvider({
        restClient,
        configPath,
        rangeStart: SESSION_START_MS,
        rangeEnd: SESSION_END_MS,
        cacheDir,
        maxInstruments: 3,
      });

      const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 60);
      const evaluator = new WalkForwardEvaluator({
        db: dbManager.db,
        marketProfile: INDIA_NSE_EQ_MARKET,
        dataProvider,
        clock,
      });

      // Run the evaluation
      const result = await evaluator.evaluate({
        rangeStart: SESSION_START_MS,
        rangeEnd: SESSION_END_MS,
        windowSizeMs: 3 * 3_600_000,
        stepSizeMs: 3 * 3_600_000,
        inSampleRatio: 0.5,
        label: 'int-test-winner',
        strategyId: 'test-strategy-v1',
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
        trialConfigs: [
          { label: 'Config A (3 candidates)', params: { maxCandidates: 3 } },
          { label: 'Config B (5 candidates)', params: { maxCandidates: 5 } },
        ],
      });

      // ── Winner selection ──
      const selector = new WinnerSelector();
      const selectionConfig: WalkForwardSelectionConfig = {
        strategy: WalkForwardSelectionStrategy.Composite,
        minMergedScore: 0.5,
        minWindowCount: 1,
        minSharpeRatio: 0.5,
        maxDrawdown: 50,
      };

      // Build trialEvidence map
      const trialEvidence = new Map<number, Array<{
        id: number;
        trialId: number;
        windowId: number;
        windowType: string;
        totalReturn: number;
        sharpeRatio: number | null;
        maxDrawdown: number | null;
        winRate: number | null;
        tradeCount: number;
        profitFactor: number | null;
        metricsJson: string | null;
        createdAt: number;
      }>>();
      for (const trial of result.trials) {
        trialEvidence.set(trial.trialId, trial.windowEvidence);
      }

      const selection = selector.selectWinner(
        result.rankedCandidates,
        selectionConfig,
        trialEvidence,
      );

      // Verify selection produced a verdict
      expect([WalkForwardSelectionResult.Selected, WalkForwardSelectionResult.NoWinner]).toContain(selection.result);
      expect(selection.rationale).toBeTruthy();
      expect(selection.selectionStrategy).toBe(WalkForwardSelectionStrategy.Composite);
      expect(selection.comparisons.length).toBeGreaterThanOrEqual(1);

      // ── Artifact emission ──
      // Build trade log
      let oosWindowCount = 0;
      for (const evidence of trialEvidence.values()) {
        const count = evidence.filter(
          item => item.windowType === WalkForwardWindowType.OutOfSample,
        ).length;
        oosWindowCount = Math.max(oosWindowCount, count);
      }

      const tradeLog = result.trials.flatMap(trial =>
        trial.windowEvidence.map(evidence => {
          const window = result.windows.find(w => w.id === evidence.windowId);
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
        selectedAt: Date.now(),
        dataRangeStart: result.windows[0]?.rangeStart ?? SESSION_START_MS,
        dataRangeEnd: result.windows[result.windows.length - 1]?.rangeEnd ?? SESSION_END_MS,
      });

      // Verify artifact files exist
      expect(fs.existsSync(artifactPaths.winnerPath)).toBe(true);
      expect(fs.existsSync(artifactPaths.diagnosticsPath)).toBe(true);
      expect(fs.existsSync(artifactPaths.tradeLogPath)).toBe(true);

      // Verify artifact content
      const winnerArtifact = JSON.parse(fs.readFileSync(artifactPaths.winnerPath, 'utf8'));
      expect(winnerArtifact.artifactType).toBe('winner-selection');
      expect(winnerArtifact.runId).toBe(result.run.id);
      expect(winnerArtifact.result).toBe(selection.result);
      expect(winnerArtifact.rationale).toBeTruthy();

      const diagnosticsArtifact = JSON.parse(fs.readFileSync(artifactPaths.diagnosticsPath, 'utf8'));
      expect(diagnosticsArtifact.artifactType).toBe('winner-diagnostics');
      expect(diagnosticsArtifact.rankedCandidates.length).toBe(2);

      const tradeLogArtifact = JSON.parse(fs.readFileSync(artifactPaths.tradeLogPath, 'utf8'));
      expect(tradeLogArtifact.artifactType).toBe('trade-log');
      expect(tradeLogArtifact.entries.length).toBeGreaterThan(0);

      // ── DB persistence ──
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
        selectedAt: Date.now(),
      });

      // Verify winner was persisted
      const winner = repo.getWinnerForRun(result.run.id);
      expect(winner).not.toBeNull();
      expect(winner!.runId).toBe(result.run.id);
      expect(winner!.result).toBe(selection.result);

      dbManager.close();
    });
  });

  describe('LLM trial graceful skip', () => {
    it('completes evaluation with LLM config pointing to unreachable URL', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const cacheDir = path.join(dir, 'cache');

      const candles = new Map<string, Array<[number, number, number, number, number, number, number]>>();
      for (const instr of INSTRUMENTS) {
        candles.set(
          instr.instrument_key,
          generateDeterministicCandles(SESSION_START_MS, SESSION_END_MS, 2000, 100_000),
        );
      }
      candles.set(
        INSTRUMENTS[0].instrument_key,
        generateDeterministicCandles(SESSION_START_MS, SESSION_END_MS, 2000, 500_000),
      );

      buildMockFetch(candles);

      const dbManager = new DatabaseManager(':memory:');
      const restClient = new UpstoxRestClient();
      const dataProvider = new UpstoxHistoricalDataProvider({
        restClient,
        configPath,
        rangeStart: SESSION_START_MS,
        rangeEnd: SESSION_END_MS,
        cacheDir,
        maxInstruments: 3,
      });

      const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 60);
      const evaluator = new WalkForwardEvaluator({
        db: dbManager.db,
        marketProfile: INDIA_NSE_EQ_MARKET,
        dataProvider,
        clock,
      });

      // Include an LLM trial config (ProposalEngine not provided, so LLM will be skipped)
      const trialConfigs: WalkForwardTrialConfig[] = [
        { label: 'No LLM', params: { maxCandidates: 3 } },
        {
          label: 'LLM Trial (will skip)',
          params: { maxCandidates: 5 },
          llmConfig: {
            enabled: true,
            maxCandidates: 5,
            weight: 0.5,
            temperature: 0.7,
            // No ProposalEngine provided — evaluator gracefully degrades
          },
        },
      ];

      const result = await evaluator.evaluate({
        rangeStart: SESSION_START_MS,
        rangeEnd: SESSION_END_MS,
        windowSizeMs: 3 * 3_600_000,
        stepSizeMs: 3 * 3_600_000,
        inSampleRatio: 0.5,
        label: 'int-test-llm-skip',
        strategyId: 'test-strategy-v1',
        strategyVersion: '1.0.0',
        marketId: 'INDIA_NSE_EQ',
        trialConfigs,
      });

      // Verify evaluation completed without crashing
      expect(result.run.status).toBe('completed');
      expect(result.trials.length).toBe(2);

      // The LLM trial should have deterministic-only scores since no ProposalEngine
      const llmTrial = result.trials.find(t => t.trialIndex === 1);
      expect(llmTrial).toBeDefined();
      // Without ProposalEngine, LLM scores MAY be null (graceful degradation)
      // The evaluator sets llmScore only when ProposalEngine is present
      // Since we didn't provide one, there's no LLM score
      if (llmTrial!.llmScore != null) {
        // If evaluator sets a synthetic LLM score, it should be reasonable
        expect(llmTrial!.llmScore).toBeGreaterThanOrEqual(0);
        expect(llmTrial!.llmScore).toBeLessThanOrEqual(1);
      }

      // All candidates should have valid deterministic scores
      for (const candidate of result.rankedCandidates) {
        expect(candidate.deterministicScore).toBeGreaterThanOrEqual(0);
        expect(candidate.deterministicScore).toBeLessThanOrEqual(1);
      }

      dbManager.close();
    });
  });

  describe('cache integration', () => {
    it('second run uses cache and produces identical ranked candidates without API calls', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const configPath = writeConfigFile(dir, INSTRUMENTS);
      const cacheDir = path.join(dir, 'cache');

      const candles = new Map<string, Array<[number, number, number, number, number, number, number]>>();
      // Use random-like but reproducible candles
      for (const instr of INSTRUMENTS) {
        candles.set(
          instr.instrument_key,
          generateDeterministicCandles(SESSION_START_MS, SESSION_END_MS, 2000, 100_000),
        );
      }
      candles.set(
        INSTRUMENTS[0].instrument_key,
        generateDeterministicCandles(SESSION_START_MS, SESSION_END_MS, 2000, 500_000),
      );

      const mockFetch = buildMockFetch(candles);

      // ── First run: fetch from mock API, write cache ──
      const dbManager1 = new DatabaseManager(':memory:');
      const restClient1 = new UpstoxRestClient();
      const dataProvider1 = new UpstoxHistoricalDataProvider({
        restClient: restClient1,
        configPath,
        rangeStart: SESSION_START_MS,
        rangeEnd: SESSION_END_MS,
        cacheDir,
        maxInstruments: 3,
      });

      const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 60);
      const evaluator1 = new WalkForwardEvaluator({
        db: dbManager1.db,
        marketProfile: INDIA_NSE_EQ_MARKET,
        dataProvider: dataProvider1,
        clock,
      });

      const result1 = await evaluator1.evaluate({
        rangeStart: SESSION_START_MS,
        rangeEnd: SESSION_END_MS,
        windowSizeMs: 3 * 3_600_000,
        stepSizeMs: 3 * 3_600_000,
        inSampleRatio: 0.5,
        label: 'int-test-cache-run1',
        trialConfigs: [
          { label: 'Config A', params: { maxCandidates: 3 } },
        ],
      });

      const historicalCallsRun1 = mockFetch.mock.calls.filter(
        call => String(call[0]).includes('/v2/historical-candles/'),
      ).length;
      expect(historicalCallsRun1).toBe(3); // 3 instruments fetched

      // ── Second run: should read from cache, not call API ──
      mockFetch.mockClear();

      const dbManager2 = new DatabaseManager(':memory:');
      const restClient2 = new UpstoxRestClient();
      const dataProvider2 = new UpstoxHistoricalDataProvider({
        restClient: restClient2,
        configPath,
        rangeStart: SESSION_START_MS,
        rangeEnd: SESSION_END_MS,
        cacheDir,
        maxInstruments: 3,
      });

      const evaluator2 = new WalkForwardEvaluator({
        db: dbManager2.db,
        marketProfile: INDIA_NSE_EQ_MARKET,
        dataProvider: dataProvider2,
        clock,
      });

      const result2 = await evaluator2.evaluate({
        rangeStart: SESSION_START_MS,
        rangeEnd: SESSION_END_MS,
        windowSizeMs: 3 * 3_600_000,
        stepSizeMs: 3 * 3_600_000,
        inSampleRatio: 0.5,
        label: 'int-test-cache-run2',
        trialConfigs: [
          { label: 'Config A', params: { maxCandidates: 3 } },
        ],
      });

      // Verify no historical-candle API calls were made
      const historicalCallsRun2 = mockFetch.mock.calls.filter(
        call => String(call[0]).includes('/v2/historical-candles/'),
      ).length;
      expect(historicalCallsRun2).toBe(0);

      // Verify identical ranked candidates
      expect(result2.rankedCandidates.length).toBe(result1.rankedCandidates.length);
      for (let i = 0; i < result1.rankedCandidates.length; i++) {
        const c1 = result1.rankedCandidates[i];
        const c2 = result2.rankedCandidates[i];
        expect(c2.rank).toBe(c1.rank);
        expect(c2.label).toBe(c1.label);
        expect(c2.deterministicScore).toBe(c1.deterministicScore);
        expect(c2.mergedScore).toBe(c1.mergedScore);
        expect(c2.windowCount).toBe(c1.windowCount);
      }

      dbManager1.close();
      dbManager2.close();
    });
  });

  describe('maxInstruments', () => {
    it('limits candidates to maxInstruments when more instruments exist in config', async () => {
      const dir = makeTempDir();
      writeTokenFile(dir);
      const configPath = writeConfigFile(dir, FIVE_INSTRUMENTS);
      const cacheDir = path.join(dir, 'cache');

      const candles = new Map<string, Array<[number, number, number, number, number, number, number]>>();
      for (const instr of FIVE_INSTRUMENTS) {
        candles.set(
          instr.instrument_key,
          generateDeterministicCandles(SESSION_START_MS, SESSION_END_MS, 2000, 100_000),
        );
      }

      buildMockFetch(candles);

      const dbManager = new DatabaseManager(':memory:');
      const restClient = new UpstoxRestClient();
      const dataProvider = new UpstoxHistoricalDataProvider({
        restClient,
        configPath,
        rangeStart: SESSION_START_MS,
        rangeEnd: SESSION_END_MS,
        cacheDir,
        maxInstruments: 2, // Only 2 instruments
      });

      const clock = new ReplayClock(INDIA_NSE_EQ_MARKET, 60);
      const evaluator = new WalkForwardEvaluator({
        db: dbManager.db,
        marketProfile: INDIA_NSE_EQ_MARKET,
        dataProvider,
        clock,
      });

      const result = await evaluator.evaluate({
        rangeStart: SESSION_START_MS,
        rangeEnd: SESSION_END_MS,
        windowSizeMs: 3 * 3_600_000,
        stepSizeMs: 3 * 3_600_000,
        inSampleRatio: 0.5,
        label: 'int-test-max-instr',
        trialConfigs: [
          { label: 'Config A', params: { maxCandidates: 3 } },
        ],
      });

      // The data provider should only have loaded 2 instruments
      expect(dataProvider.instrumentCount).toBe(2);

      // The evaluator should complete with a reasonable result
      expect(result.run.status).toBe('completed');
      expect(result.rankedCandidates.length).toBe(1); // 1 trial config

      dbManager.close();
    });
  });
});
