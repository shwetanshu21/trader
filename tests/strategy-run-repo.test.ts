import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { StrategyRunRepository } from '../src/persistence/strategy-run-repo.js';
import { ProposalRepository } from '../src/persistence/proposal-repo.js';
import { UniverseRepository } from '../src/persistence/universe-repo.js';
import {
  ProposalStatus,
  UniverseCoverageVerdict,
  type NewStrategyRun,
  type NewStrategyRunCandidate,
  type NewProposalAttempt,
  type NewUniverseSnapshot,
  type IndiaResearchCandidateEvidence,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Test context helpers
// ---------------------------------------------------------------------------

interface TestContext {
  runRepo: StrategyRunRepository;
  proposalRepo: ProposalRepository;
  universeRepo: UniverseRepository;
  db: Database.Database;
}

function createContext(): TestContext {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;
  return {
    runRepo: new StrategyRunRepository(db),
    proposalRepo: new ProposalRepository(db),
    universeRepo: new UniverseRepository(db),
    db,
  };
}

function insertProposal(
  proposalRepo: ProposalRepository,
  overrides?: Partial<NewProposalAttempt>,
): number {
  const row = proposalRepo.insertAttempt({
    exchange: 'NSE',
    tradingsymbol: 'RELIANCE',
    instrumentToken: 123456,
    side: 'buy',
    product: 'MIS',
    quantity: 1,
    price: null,
    triggerPrice: null,
    orderType: 'MARKET',
    tag: null,
    proposalStatus: ProposalStatus.Accepted,
    createdAt: Date.now(),
    ...overrides,
  });
  return row.id;
}

function insertUniverseSnapshot(
  universeRepo: UniverseRepository,
  overrides?: Partial<NewUniverseSnapshot>,
): number {
  const row = universeRepo.insertSnapshot({
    policyVersion: 'v1',
    computedAt: Date.now(),
    verdict: UniverseCoverageVerdict.Sufficient,
    eligibleCount: 10,
    ineligibleCount: 0,
    freshQuoteCount: 10,
    staleQuoteCount: 0,
    missingQuoteCount: 0,
    thresholdLabel: 'default',
    thresholdRatio: 0.8,
    maxStalenessMs: 60000,
    members: [],
    ...overrides,
  });
  return row.id;
}

function sampleRun(overrides?: Partial<NewStrategyRun>): NewStrategyRun {
  return {
    frameworkConfig: JSON.stringify({ maxCandidates: 5, parallelPlugins: true }),
    pluginsJson: JSON.stringify([
      { id: 'momentum-v1', name: 'Momentum Screener', version: '1.0.0' },
      { id: 'volume-v1', name: 'Volume Screener', version: '1.0.0' },
    ]),
    pluginErrorsJson: null,
    universeSnapshotId: null,
    totalEvaluated: 3,
    hasPluginErrors: false,
    durationMs: 150,
    createdAt: Date.now(),
    ...overrides,
  };
}

function sampleCandidates(
  runIdOverride?: number,
): NewStrategyRunCandidate[] {
  const runId = runIdOverride ?? 0; // placeholder — set during insert
  return [
    {
      strategyRunId: runId,
      candidateKey: 'NSE:RELIANCE',
      rank: 1,
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      instrumentToken: 123456,
      instrumentType: 'EQ',
      lotSize: 1,
      tickSize: 0.05,
      side: 'buy',
      lastPrice: 2850.50,
      bid: 2849.00,
      ask: 2851.00,
      volume: 1250000,
      scoresJson: JSON.stringify([
        { plugin: { id: 'momentum-v1', name: 'Momentum Screener', version: '1.0.0' }, score: 0.85, rationale: 'Strong upward trend' },
        { plugin: { id: 'volume-v1', name: 'Volume Screener', version: '1.0.0' }, score: 0.72, rationale: 'Above average volume' },
      ]),
      deterministicScore: 0.78,
      llmScore: 0.82,
      llmStatus: 'consulted',
      llmRationale: 'Strong momentum with volume confirmation',
      mergedScore: 0.82,
      mergePolicy: 'llm_override',
      proposalParamsJson: null,
      pluginErrorsJson: null,
      hasPluginErrors: false,
      emitted: false,
      proposalAttemptId: null,
    },
    {
      strategyRunId: runId,
      candidateKey: 'NSE:TCS',
      rank: 2,
      exchange: 'NSE',
      tradingsymbol: 'TCS',
      instrumentToken: 789012,
      instrumentType: 'EQ',
      lotSize: 1,
      tickSize: 0.05,
      side: 'buy',
      lastPrice: 3890.00,
      bid: 3888.00,
      ask: 3892.00,
      volume: 850000,
      scoresJson: JSON.stringify([
        { plugin: { id: 'momentum-v1', name: 'Momentum Screener', version: '1.0.0' }, score: 0.65, rationale: 'Moderate trend' },
      ]),
      deterministicScore: 0.65,
      llmScore: null,
      llmStatus: 'skipped',
      llmRationale: null,
      mergedScore: 0.65,
      mergePolicy: 'deterministic_only',
      proposalParamsJson: null,
      pluginErrorsJson: null,
      hasPluginErrors: false,
      emitted: false,
      proposalAttemptId: null,
    },
    {
      strategyRunId: runId,
      candidateKey: 'NSE:INFY',
      rank: 3,
      exchange: 'NSE',
      tradingsymbol: 'INFY',
      instrumentToken: 345678,
      instrumentType: 'EQ',
      lotSize: 1,
      tickSize: 0.05,
      side: 'buy',
      lastPrice: 1650.00,
      bid: 1649.00,
      ask: 1651.00,
      volume: 500000,
      scoresJson: JSON.stringify([
        { plugin: { id: 'momentum-v1', name: 'Momentum Screener', version: '1.0.0' }, score: 0.45, rationale: 'Weak trend' },
      ]),
      deterministicScore: 0.45,
      llmScore: null,
      llmStatus: null,
      llmRationale: null,
      mergedScore: 0.45,
      mergePolicy: 'deterministic_only',
      proposalParamsJson: null,
      pluginErrorsJson: null,
      hasPluginErrors: false,
      emitted: false,
      proposalAttemptId: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// StrategyRunRepository
// ---------------------------------------------------------------------------

describe('StrategyRunRepository', () => {
  describe('insertRunWithCandidates', () => {
    it('atomically inserts a run with three ordered candidates', () => {
      const ctx = createContext();
      const run = sampleRun();
      const candidates = sampleCandidates();

      const result = ctx.runRepo.insertRunWithCandidates(run, candidates);

      // Verify run fields
      expect(result.id).toBeGreaterThan(0);
      expect(result.totalEvaluated).toBe(3);
      expect(result.hasPluginErrors).toBe(false);
      expect(result.durationMs).toBe(150);
      expect(result.universeSnapshotId).toBeNull();

      // Verify parsed JSON payloads
      const plugins = JSON.parse(result.pluginsJson) as Array<{ id: string }>;
      expect(plugins.length).toBe(2);
      expect(plugins[0].id).toBe('momentum-v1');

      const config = JSON.parse(result.frameworkConfig) as { maxCandidates: number };
      expect(config.maxCandidates).toBe(5);

      // Verify candidates
      expect(result.candidates.length).toBe(3);
      expect(result.candidates[0].candidateKey).toBe('NSE:RELIANCE');
      expect(result.candidates[1].candidateKey).toBe('NSE:TCS');
      expect(result.candidates[2].candidateKey).toBe('NSE:INFY');

      // Verify persistence counts
      expect(ctx.runRepo.countRuns()).toBe(1);
      expect(ctx.runRepo.countCandidates()).toBe(3);
    });

    it('atomically inserts a run with no candidates (empty screening round)', () => {
      const ctx = createContext();
      const run = sampleRun({ totalEvaluated: 0 });

      const result = ctx.runRepo.insertRunWithCandidates(run, []);

      expect(result.id).toBeGreaterThan(0);
      expect(result.candidates).toEqual([]);
      expect(ctx.runRepo.countRuns()).toBe(1);
      expect(ctx.runRepo.countCandidates()).toBe(0);
    });

    it('atomically inserts a run with a single candidate', () => {
      const ctx = createContext();
      const run = sampleRun({ totalEvaluated: 1 });
      const candidates = [sampleCandidates()[0]];

      const result = ctx.runRepo.insertRunWithCandidates(run, candidates);

      expect(result.id).toBeGreaterThan(0);
      expect(result.candidates.length).toBe(1);
      expect(result.candidates[0].candidateKey).toBe('NSE:RELIANCE');
      expect(result.candidates[0].rank).toBe(1);
    });

    it('preserves candidate ordering by rank when read back from DB', () => {
      const ctx = createContext();
      const candidates = sampleCandidates();

      // Insert in reverse rank order
      const reversed = [candidates[2], candidates[1], candidates[0]];
      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), reversed);

      // In-memory return preserves input order
      expect(inserted.candidates[0].candidateKey).toBe('NSE:INFY');

      // Reload from DB — should be ordered by rank ascending
      const loaded = ctx.runRepo.getRunById(inserted.id);
      expect(loaded!.candidates[0].rank).toBe(1);
      expect(loaded!.candidates[0].candidateKey).toBe('NSE:RELIANCE');
      expect(loaded!.candidates[1].rank).toBe(2);
      expect(loaded!.candidates[1].candidateKey).toBe('NSE:TCS');
      expect(loaded!.candidates[2].rank).toBe(3);
      expect(loaded!.candidates[2].candidateKey).toBe('NSE:INFY');
    });

    it('rolls back on FK violation (invalid universe_snapshot_id)', () => {
      const ctx = createContext();
      const run = sampleRun({ universeSnapshotId: 99999 }); // non-existent
      const candidates = sampleCandidates();

      expect(() => {
        ctx.runRepo.insertRunWithCandidates(run, candidates);
      }).toThrow();

      // Nothing persisted
      expect(ctx.runRepo.countRuns()).toBe(0);
      expect(ctx.runRepo.countCandidates()).toBe(0);
    });

    it('inserts a run with a valid universe_snapshot_id', () => {
      const ctx = createContext();
      const sid = insertUniverseSnapshot(ctx.universeRepo);

      const run = sampleRun({ universeSnapshotId: sid });
      const candidates = sampleCandidates();

      const result = ctx.runRepo.insertRunWithCandidates(run, candidates);

      expect(result.id).toBeGreaterThan(0);
      expect(result.universeSnapshotId).toBe(sid);
    });

    it('inserts a run with plugin_errors_json populated', () => {
      const ctx = createContext();
      const pluginErrors = { 'volume-v1': 'Timed out after 5000ms' };
      const run = sampleRun({
        hasPluginErrors: true,
        pluginErrorsJson: JSON.stringify(pluginErrors),
      });

      const result = ctx.runRepo.insertRunWithCandidates(run, []);

      expect(result.hasPluginErrors).toBe(true);
      const loaded = JSON.parse(result.pluginErrorsJson!);
      expect(loaded['volume-v1']).toBe('Timed out after 5000ms');
    });

    it('handles duplicate candidate_key within the same run', () => {
      const ctx = createContext();
      const candidates = sampleCandidates();
      // Duplicate the first candidate with same key but different rank
      const dup = { ...candidates[0], rank: 4, lastPrice: 2900 };
      const all = [...candidates, dup];

      // Should succeed — no UNIQUE constraint on (run_id, candidate_key)
      const result = ctx.runRepo.insertRunWithCandidates(sampleRun(), all);

      expect(result.candidates.length).toBe(4);
      const keyCount = result.candidates.filter(c => c.candidateKey === 'NSE:RELIANCE').length;
      expect(keyCount).toBe(2);
    });
  });

  describe('getRunById', () => {
    it('returns null for unknown run id', () => {
      const ctx = createContext();
      expect(ctx.runRepo.getRunById(99999)).toBeNull();
    });

    it('returns the full run with ordered candidates', () => {
      const ctx = createContext();
      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), sampleCandidates());

      const loaded = ctx.runRepo.getRunById(inserted.id);

      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(inserted.id);
      expect(loaded!.totalEvaluated).toBe(3);
      expect(loaded!.durationMs).toBe(150);
      expect(loaded!.hasPluginErrors).toBe(false);
      expect(loaded!.universeSnapshotId).toBeNull();

      // Candidates are ordered by rank
      expect(loaded!.candidates.length).toBe(3);
      expect(loaded!.candidates[0].rank).toBe(1);
      expect(loaded!.candidates[1].rank).toBe(2);
      expect(loaded!.candidates[2].rank).toBe(3);

      // Full candidate field verification
      const first = loaded!.candidates[0];
      expect(first.candidateKey).toBe('NSE:RELIANCE');
      expect(first.exchange).toBe('NSE');
      expect(first.tradingsymbol).toBe('RELIANCE');
      expect(first.instrumentToken).toBe(123456);
      expect(first.instrumentType).toBe('EQ');
      expect(first.lotSize).toBe(1);
      expect(first.tickSize).toBe(0.05);
      expect(first.side).toBe('buy');
      expect(first.lastPrice).toBe(2850.50);
      expect(first.bid).toBe(2849.00);
      expect(first.ask).toBe(2851.00);
      expect(first.volume).toBe(1250000);
      expect(first.deterministicScore).toBe(0.78);
      expect(first.llmScore).toBe(0.82);
      expect(first.llmStatus).toBe('consulted');
      expect(first.llmRationale).toBe('Strong momentum with volume confirmation');
      expect(first.mergedScore).toBe(0.82);
      expect(first.mergePolicy).toBe('llm_override');
      expect(first.emitted).toBe(false);
      expect(first.proposalAttemptId).toBeNull();
    });

    it('returns run with empty candidates when none were inserted', () => {
      const ctx = createContext();
      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), []);

      const loaded = ctx.runRepo.getRunById(inserted.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.candidates).toEqual([]);
    });
  });

  describe('getRecentRuns', () => {
    it('returns empty array when no runs exist', () => {
      const ctx = createContext();
      expect(ctx.runRepo.getRecentRuns()).toEqual([]);
    });

    it('returns runs newest first with their candidates', () => {
      const ctx = createContext();

      const result1 = ctx.runRepo.insertRunWithCandidates(
        sampleRun({ createdAt: 100 }),
        [sampleCandidates()[0]],
      );
      const result2 = ctx.runRepo.insertRunWithCandidates(
        sampleRun({ createdAt: 200 }),
        [sampleCandidates()[1]],
      );

      const recent = ctx.runRepo.getRecentRuns();

      expect(recent.length).toBe(2);
      expect(recent[0].id).toBe(result2.id);
      expect(recent[1].id).toBe(result1.id);

      // Both have their candidates loaded
      expect(recent[0].candidates.length).toBe(1);
      expect(recent[0].candidates[0].candidateKey).toBe('NSE:TCS');
      expect(recent[1].candidates.length).toBe(1);
      expect(recent[1].candidates[0].candidateKey).toBe('NSE:RELIANCE');
    });

    it('respects limit parameter', () => {
      const ctx = createContext();
      for (let i = 0; i < 10; i++) {
        ctx.runRepo.insertRunWithCandidates(
          sampleRun({ createdAt: i }),
          [],
        );
      }

      expect(ctx.runRepo.getRecentRuns(3).length).toBe(3);
      expect(ctx.runRepo.getRecentRuns(100).length).toBe(10);
    });
  });

  describe('getRunByProposalAttemptId', () => {
    it('returns null when no candidate has the given proposal attempt id', () => {
      const ctx = createContext();
      expect(ctx.runRepo.getRunByProposalAttemptId(99999)).toBeNull();
    });

    it('returns the run containing a candidate linked to a proposal attempt', () => {
      const ctx = createContext();

      // Insert a run with candidates that have no proposal linkage
      ctx.runRepo.insertRunWithCandidates(sampleRun({ createdAt: 100 }), sampleCandidates());

      // Insert a proposal attempt
      const paId = insertProposal(ctx.proposalRepo, { tradingsymbol: 'EMITTED_SYM' });

      // Insert a second run where one candidate is emitted (has proposal linkage)
      const emittedCandidate: NewStrategyRunCandidate = {
        ...sampleCandidates()[0],
        candidateKey: 'NSE:EMITTED_SYM',
        tradingsymbol: 'EMITTED_SYM',
        emitted: true,
        proposalAttemptId: paId,
      };
      const run2 = ctx.runRepo.insertRunWithCandidates(
        sampleRun({ createdAt: 200 }),
        [emittedCandidate, sampleCandidates()[1]],
      );

      const loaded = ctx.runRepo.getRunByProposalAttemptId(paId);

      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(run2.id);
      // All candidates from that run are loaded
      expect(loaded!.candidates.length).toBe(2);

      // The emitted candidate has the linkage
      const match = loaded!.candidates.find(c => c.proposalAttemptId === paId);
      expect(match).not.toBeUndefined();
      expect(match!.emitted).toBe(true);
      expect(match!.tradingsymbol).toBe('EMITTED_SYM');
    });

    it('returns the correct run when multiple runs exist with emitted candidates', () => {
      const ctx = createContext();

      const paId1 = insertProposal(ctx.proposalRepo, { tradingsymbol: 'FIRST', createdAt: 100 });
      const paId2 = insertProposal(ctx.proposalRepo, { tradingsymbol: 'SECOND', createdAt: 200 });

      const run1 = ctx.runRepo.insertRunWithCandidates(
        sampleRun({ createdAt: 100 }),
        [{
          ...sampleCandidates()[0],
          candidateKey: 'NSE:FIRST',
          tradingsymbol: 'FIRST',
          emitted: true,
          proposalAttemptId: paId1,
        }],
      );

      const run2 = ctx.runRepo.insertRunWithCandidates(
        sampleRun({ createdAt: 200 }),
        [{
          ...sampleCandidates()[0],
          candidateKey: 'NSE:SECOND',
          tradingsymbol: 'SECOND',
          emitted: true,
          proposalAttemptId: paId2,
        }],
      );

      const loaded1 = ctx.runRepo.getRunByProposalAttemptId(paId1);
      expect(loaded1).not.toBeNull();
      expect(loaded1!.id).toBe(run1.id);

      const loaded2 = ctx.runRepo.getRunByProposalAttemptId(paId2);
      expect(loaded2).not.toBeNull();
      expect(loaded2!.id).toBe(run2.id);
    });
  });

  describe('count methods', () => {
    it('starts at zero', () => {
      const ctx = createContext();
      expect(ctx.runRepo.countRuns()).toBe(0);
      expect(ctx.runRepo.countCandidates()).toBe(0);
    });

    it('counts runs and candidates', () => {
      const ctx = createContext();

      ctx.runRepo.insertRunWithCandidates(sampleRun({ createdAt: 100 }), sampleCandidates());
      ctx.runRepo.insertRunWithCandidates(sampleRun({ createdAt: 200 }), [sampleCandidates()[0]]);

      expect(ctx.runRepo.countRuns()).toBe(2);
      expect(ctx.runRepo.countCandidates()).toBe(4);
    });
  });

  // -----------------------------------------------------------------------
  // JSON payload round-trip tests
  // -----------------------------------------------------------------------

  describe('JSON payload round-trip', () => {
    it('round-trips plugin identities JSON', () => {
      const ctx = createContext();
      const plugins = [
        { id: 'momentum-v1', name: 'Momentum Screener', version: '1.0.0' },
        { id: 'volume-v1', name: 'Volume Screener', version: '2.0.0' },
        { id: 'volatility-v1', name: 'Volatility Analyzer', version: '0.5.0' },
      ];

      const run = sampleRun({ pluginsJson: JSON.stringify(plugins) });
      const inserted = ctx.runRepo.insertRunWithCandidates(run, []);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      const loadedPlugins = JSON.parse(loaded!.pluginsJson);
      expect(loadedPlugins).toEqual(plugins);
    });

    it('round-trips framework config JSON', () => {
      const ctx = createContext();
      const config = { maxCandidates: 10, parallelPlugins: false, debugMode: true, thresholds: { minScore: 0.3 }, custom: { nested: { value: 42 } } };

      const run = sampleRun({ frameworkConfig: JSON.stringify(config) });
      const inserted = ctx.runRepo.insertRunWithCandidates(run, []);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      const loadedConfig = JSON.parse(loaded!.frameworkConfig);
      expect(loadedConfig).toEqual(config);
    });

    it('round-trips plugin errors JSON', () => {
      const ctx = createContext();
      const errors = { 'volume-v1': 'Timed out after 5000ms', 'momentum-v1': 'Plugin crashed with OOM' };

      const run = sampleRun({
        hasPluginErrors: true,
        pluginErrorsJson: JSON.stringify(errors),
      });
      const inserted = ctx.runRepo.insertRunWithCandidates(run, []);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      const loadedErrors = JSON.parse(loaded!.pluginErrorsJson!);
      expect(loadedErrors).toEqual(errors);
    });

    it('round-trips null plugin errors JSON', () => {
      const ctx = createContext();
      const run = sampleRun({ pluginErrorsJson: null });
      const inserted = ctx.runRepo.insertRunWithCandidates(run, []);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      expect(loaded!.pluginErrorsJson).toBeNull();
    });

    it('round-trips candidate scores JSON', () => {
      const ctx = createContext();
      const scores = [
        { plugin: { id: 'momentum-v1', name: 'Momentum', version: '1.0.0' }, score: 0.95, rationale: 'Very strong trend', metadata: { lookback: 20, signal: 'buy' } },
        { plugin: { id: 'volume-v1', name: 'Volume', version: '1.0.0' }, score: 0.88, rationale: 'High volume spike' },
      ];

      const candidate: NewStrategyRunCandidate = {
        ...sampleCandidates()[0],
        scoresJson: JSON.stringify(scores),
        candidateKey: 'NSE:JSON_TEST',
        tradingsymbol: 'JSON_TEST',
      };

      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), [candidate]);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      const loadedScores = JSON.parse(loaded!.candidates[0].scoresJson);
      expect(loadedScores).toEqual(scores);
      expect(loadedScores[0].metadata.lookback).toBe(20);
    });

    it('round-trips candidate proposal params JSON', () => {
      const ctx = createContext();
      const params = { exchange: 'NSE', product: 'MIS', tag: 'momentum-screened' };

      const candidate: NewStrategyRunCandidate = {
        ...sampleCandidates()[0],
        proposalParamsJson: JSON.stringify(params),
        candidateKey: 'NSE:PARAMS_TEST',
        tradingsymbol: 'PARAMS_TEST',
      };

      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), [candidate]);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      const loadedParams = JSON.parse(loaded!.candidates[0].proposalParamsJson!);
      expect(loadedParams).toEqual(params);
    });

    it('round-trips null proposal params JSON', () => {
      const ctx = createContext();
      const candidate: NewStrategyRunCandidate = {
        ...sampleCandidates()[0],
        proposalParamsJson: null,
        candidateKey: 'NSE:NULLPARAM',
        tradingsymbol: 'NULLPARAM',
      };

      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), [candidate]);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      expect(loaded!.candidates[0].proposalParamsJson).toBeNull();
    });

    it('round-trips candidate plugin errors JSON', () => {
      const ctx = createContext();
      const errors = { 'volume-v1': 'Timed out' };

      const candidate: NewStrategyRunCandidate = {
        ...sampleCandidates()[0],
        pluginErrorsJson: JSON.stringify(errors),
        hasPluginErrors: true,
        candidateKey: 'NSE:ERR_TEST',
        tradingsymbol: 'ERR_TEST',
      };

      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), [candidate]);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      const loadedErrors = JSON.parse(loaded!.candidates[0].pluginErrorsJson!);
      expect(loadedErrors).toEqual(errors);
      expect(loaded!.candidates[0].hasPluginErrors).toBe(true);
    });

    it('round-trips null candidate plugin errors JSON', () => {
      const ctx = createContext();
      const candidate: NewStrategyRunCandidate = {
        ...sampleCandidates()[0],
        pluginErrorsJson: null,
        hasPluginErrors: false,
        candidateKey: 'NSE:NULLERR',
        tradingsymbol: 'NULLERR',
      };

      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), [candidate]);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      expect(loaded!.candidates[0].pluginErrorsJson).toBeNull();
      expect(loaded!.candidates[0].hasPluginErrors).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Null linkage tests — non-emitted candidates
  // -----------------------------------------------------------------------

  describe('null linkage for non-emitted candidates', () => {
    it('persists non-emitted candidate with null proposal_attempt_id', () => {
      const ctx = createContext();
      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), sampleCandidates());

      for (const c of inserted.candidates) {
        expect(c.emitted).toBe(false);
        expect(c.proposalAttemptId).toBeNull();
      }
    });

    it('persists a mix of emitted and non-emitted candidates', () => {
      const ctx = createContext();
      const paId = insertProposal(ctx.proposalRepo, { tradingsymbol: 'EMITTED' });

      const candidates: NewStrategyRunCandidate[] = [
        {
          ...sampleCandidates()[0],
          candidateKey: 'NSE:EMITTED',
          tradingsymbol: 'EMITTED',
          emitted: true,
          proposalAttemptId: paId,
        },
        {
          ...sampleCandidates()[1],
          candidateKey: 'NSE:NOT_EMITTED',
          tradingsymbol: 'NOT_EMITTED',
          emitted: false,
          proposalAttemptId: null,
        },
      ];

      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), candidates);

      const emitted = inserted.candidates.find(c => c.emitted);
      const nonEmitted = inserted.candidates.find(c => !c.emitted);

      expect(emitted).not.toBeUndefined();
      expect(emitted!.proposalAttemptId).toBe(paId);
      expect(nonEmitted).not.toBeUndefined();
      expect(nonEmitted!.proposalAttemptId).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Negative tests — malformed/edge-case inputs
  // -----------------------------------------------------------------------

  describe('negative tests', () => {
    it('rejects insert with non-existent proposal_attempt_id (FK violation)', () => {
      const ctx = createContext();
      const candidate: NewStrategyRunCandidate = {
        ...sampleCandidates()[0],
        emitted: true,
        proposalAttemptId: 99999, // non-existent
      };

      expect(() => {
        ctx.runRepo.insertRunWithCandidates(sampleRun(), [candidate]);
      }).toThrow();

      expect(ctx.runRepo.countRuns()).toBe(0);
    });

    it('handles empty results for unknown run id', () => {
      const ctx = createContext();
      expect(ctx.runRepo.getRunById(99999)).toBeNull();
    });

    it('handles empty results for unknown proposal attempt id', () => {
      const ctx = createContext();
      expect(ctx.runRepo.getRunByProposalAttemptId(99999)).toBeNull();
    });

    it('handles empty results from getRecentRuns when no runs exist', () => {
      const ctx = createContext();
      expect(ctx.runRepo.getRecentRuns()).toEqual([]);
    });

    it('handles deterministic ordering when scores tie (same merged_score)', () => {
      const ctx = createContext();

      // Two candidates with same merged score — order preserved by rank
      const candidates: NewStrategyRunCandidate[] = [
        {
          ...sampleCandidates()[0],
          candidateKey: 'NSE:ALPHA',
          tradingsymbol: 'ALPHA',
          rank: 1,
          mergedScore: 0.5,
        },
        {
          ...sampleCandidates()[0],
          candidateKey: 'NSE:BETA',
          tradingsymbol: 'BETA',
          rank: 2,
          mergedScore: 0.5,
        },
      ];

      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), candidates);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      expect(loaded!.candidates[0].rank).toBe(1);
      expect(loaded!.candidates[0].candidateKey).toBe('NSE:ALPHA');
      expect(loaded!.candidates[1].rank).toBe(2);
      expect(loaded!.candidates[1].candidateKey).toBe('NSE:BETA');
    });

    it('preserves candidate fields through insert-and-reload for all data types', () => {
      const ctx = createContext();
      const candidate: NewStrategyRunCandidate = {
        strategyRunId: 0,
        candidateKey: 'NFO:BANKNIFTY24DEC30000CE',
        rank: 1,
        exchange: 'NFO',
        tradingsymbol: 'BANKNIFTY24DEC30000CE',
        instrumentToken: 987654,
        instrumentType: 'CE',
        lotSize: 25,
        tickSize: 0.10,
        side: 'buy',
        lastPrice: 150.00,
        bid: 149.50,
        ask: 150.50,
        volume: 250000,
        scoresJson: '[]',
        deterministicScore: 0.92,
        llmScore: null,
        llmStatus: null,
        llmRationale: null,
        mergedScore: 0.92,
        mergePolicy: null,
        proposalParamsJson: null,
        pluginErrorsJson: null,
        hasPluginErrors: false,
        emitted: false,
        proposalAttemptId: null,
      };

      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), [candidate]);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      const c = loaded!.candidates[0];
      expect(c.candidateKey).toBe('NFO:BANKNIFTY24DEC30000CE');
      expect(c.exchange).toBe('NFO');
      expect(c.tradingsymbol).toBe('BANKNIFTY24DEC30000CE');
      expect(c.instrumentToken).toBe(987654);
      expect(c.instrumentType).toBe('CE');
      expect(c.lotSize).toBe(25);
      expect(c.tickSize).toBe(0.10);
      expect(c.side).toBe('buy');
      expect(c.lastPrice).toBe(150.00);
      expect(c.bid).toBe(149.50);
      expect(c.ask).toBe(150.50);
      expect(c.volume).toBe(250000);
      expect(c.deterministicScore).toBe(0.92);
      expect(c.llmScore).toBeNull();
      expect(c.llmStatus).toBeNull();
      expect(c.llmRationale).toBeNull();
      expect(c.mergedScore).toBe(0.92);
      expect(c.mergePolicy).toBeNull();
      expect(c.proposalParamsJson).toBeNull();
      expect(c.pluginErrorsJson).toBeNull();
      expect(c.hasPluginErrors).toBe(false);
      expect(c.emitted).toBe(false);
      expect(c.proposalAttemptId).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // India research evidence — candidate-level persistence
  // -----------------------------------------------------------------------

  describe('India research evidence (candidate-level)', () => {
    it('round-trips a candidate with India research evidence', () => {
      const ctx = createContext();
      const evidence: IndiaResearchCandidateEvidence = {
        summary: 'India GDP growth revised to 7.2% for FY25, RBI maintains repo rate at 6.5%. FII inflows in August crossed $3B.',
        tags: ['gdp-growth', 'rbi-policy', 'fi-inflows', 'macro'],
        freshnessMs: 300_000, // 5 min old
        influenceScore: 0.85,
      };

      const candidate: NewStrategyRunCandidate = {
        ...sampleCandidates()[0],
        candidateKey: 'NSE:RESEARCH_TEST',
        tradingsymbol: 'RESEARCH_TEST',
        indiaResearchEvidence: evidence,
      };

      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), [candidate]);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      const loadedEvidence = loaded!.candidates[0].indiaResearchEvidence;
      expect(loadedEvidence).not.toBeNull();
      expect(loadedEvidence!.summary).toBe(evidence.summary);
      expect(loadedEvidence!.tags).toEqual(evidence.tags);
      expect(loadedEvidence!.freshnessMs).toBe(evidence.freshnessMs);
      expect(loadedEvidence!.influenceScore).toBe(evidence.influenceScore);
    });

    it('round-trips a candidate with minimal India research evidence (no tags, null freshness)', () => {
      const ctx = createContext();
      const evidence: IndiaResearchCandidateEvidence = {
        summary: 'Sector rotation from IT to banking observed.',
        tags: [],
        freshnessMs: null,
        influenceScore: null,
      };

      const candidate: NewStrategyRunCandidate = {
        ...sampleCandidates()[0],
        candidateKey: 'NSE:MINIMAL',
        tradingsymbol: 'MINIMAL',
        indiaResearchEvidence: evidence,
      };

      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), [candidate]);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      const loadedEvidence = loaded!.candidates[0].indiaResearchEvidence;
      expect(loadedEvidence).not.toBeNull();
      expect(loadedEvidence!.summary).toBe('Sector rotation from IT to banking observed.');
      expect(loadedEvidence!.tags).toEqual([]);
      expect(loadedEvidence!.freshnessMs).toBeNull();
      expect(loadedEvidence!.influenceScore).toBeNull();
    });

    it('persists null indiaResearchEvidence for backward compatibility', () => {
      const ctx = createContext();
      // Uses existing sampleCandidates which have no indiaResearchEvidence field set
      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), sampleCandidates());
      const loaded = ctx.runRepo.getRunById(inserted.id);

      for (const c of loaded!.candidates) {
        expect(c.indiaResearchEvidence).toBeNull();
      }
    });

    it('round-trips a mix of candidates with and without India research evidence', () => {
      const ctx = createContext();
      const evidence: IndiaResearchCandidateEvidence = {
        summary: 'Nifty IT index shows strong momentum after TCS results.',
        tags: ['nifty-it', 'tcs-results', 'sector-momentum'],
        freshnessMs: 180_000,
        influenceScore: 0.75,
      };

      const candidates: NewStrategyRunCandidate[] = [
        {
          ...sampleCandidates()[0],
          candidateKey: 'NSE:WITH_EVIDENCE',
          tradingsymbol: 'WITH_EVIDENCE',
          rank: 1,
          indiaResearchEvidence: evidence,
        },
        {
          ...sampleCandidates()[1],
          candidateKey: 'NSE:NO_EVIDENCE',
          tradingsymbol: 'NO_EVIDENCE',
          rank: 2,
          indiaResearchEvidence: null,
        },
        {
          ...sampleCandidates()[2],
          candidateKey: 'NSE:ALSO_NO_EVIDENCE',
          tradingsymbol: 'ALSO_NO_EVIDENCE',
          rank: 3,
          // Explicitly undefined — should be treated as null by the insert path
          indiaResearchEvidence: undefined as unknown as null,
        },
      ];

      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), candidates);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      expect(loaded!.candidates.length).toBe(3);
      expect(loaded!.candidates[0].indiaResearchEvidence).not.toBeNull();
      expect(loaded!.candidates[0].indiaResearchEvidence!.summary).toBe(evidence.summary);
      expect(loaded!.candidates[1].indiaResearchEvidence).toBeNull();
      expect(loaded!.candidates[2].indiaResearchEvidence).toBeNull();
    });

    it('handles India research evidence with bounded tags array (max 10)', () => {
      const ctx = createContext();
      const tags = Array.from({ length: 10 }, (_, i) => `tag-${i + 1}`);
      const evidence: IndiaResearchCandidateEvidence = {
        summary: 'Ten-tag research summary.',
        tags,
        freshnessMs: null,
        influenceScore: 0.5,
      };

      const candidate: NewStrategyRunCandidate = {
        ...sampleCandidates()[0],
        candidateKey: 'NSE:TEN_TAGS',
        tradingsymbol: 'TEN_TAGS',
        indiaResearchEvidence: evidence,
      };

      const inserted = ctx.runRepo.insertRunWithCandidates(sampleRun(), [candidate]);
      const loaded = ctx.runRepo.getRunById(inserted.id);

      const loadedEvidence = loaded!.candidates[0].indiaResearchEvidence!;
      expect(loadedEvidence.tags.length).toBe(10);
      expect(loadedEvidence.tags[0]).toBe('tag-1');
      expect(loadedEvidence.tags[9]).toBe('tag-10');
    });
  });
});
