import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { StrategyLifecycleRepository } from '../src/persistence/strategy-lifecycle-repo.js';
import {
  StrategyLifecyclePhase,
  GovernanceVerdict,
  DEFAULT_GOVERNANCE_THRESHOLDS,
} from '../src/types/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STRATEGY_A = { strategyId: 'india-nse-eq-v1', strategyVersion: '1.0.0', marketId: 'INDIA_NSE_EQ' };
const STRATEGY_B = { strategyId: 'india-nfo-op-v1', strategyVersion: '1.0.0', marketId: 'INDIA_NFO_EQ' };

function createContext(): { repo: StrategyLifecycleRepository; db: Database.Database } {
  const mgr = new DatabaseManager(':memory:');
  const db = mgr.db;
  return { repo: new StrategyLifecycleRepository(db), db };
}

/** Helper: seed a promoted state for tests that need non-default phase. */
function seedPromoted(repo: StrategyLifecycleRepository): StrategyLifecyclePhase {
  repo.upsertCurrentState({
    ...STRATEGY_A,
    phase: StrategyLifecyclePhase.Paper,
    updatedAt: 1000000,
  });
  return StrategyLifecyclePhase.Paper;
}

/** Helper: insert a governance decision. */
function seedDecision(
  repo: StrategyLifecycleRepository,
  overrides: Partial<{
    verdict: GovernanceVerdict;
    previousPhase: StrategyLifecyclePhase;
    newPhase: StrategyLifecyclePhase;
    rationale: string;
    evidenceJson: string | null;
    winnerId: number | null;
    recordedAt: number;
  }> = {},
) {
  return repo.insertDecision({
    strategyId: STRATEGY_A.strategyId,
    strategyVersion: STRATEGY_A.strategyVersion,
    marketId: STRATEGY_A.marketId,
    verdict: GovernanceVerdict.Promote,
    previousPhase: StrategyLifecyclePhase.Backtest,
    newPhase: StrategyLifecyclePhase.Paper,
    rationale: 'Walk-forward winner met promotion thresholds',
    evidenceJson: JSON.stringify({
      minMergedScore: DEFAULT_GOVERNANCE_THRESHOLDS.minMergedScore,
      mergedScore: 0.85,
      minSharpeRatio: DEFAULT_GOVERNANCE_THRESHOLDS.minSharpeRatio,
      sharpeRatio: 1.5,
    }),
    winnerId: null,
    recordedAt: 2000000,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StrategyLifecycleRepository — empty-state defaults', () => {
  it('returns backtest phase when no state row exists', () => {
    const { repo } = createContext();
    const state = repo.getCurrentState(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );
    expect(state.phase).toBe(StrategyLifecyclePhase.Backtest);
    expect(state.strategyId).toBe(STRATEGY_A.strategyId);
    expect(state.strategyVersion).toBe(STRATEGY_A.strategyVersion);
    expect(state.marketId).toBe(STRATEGY_A.marketId);
    expect(state.id).toBe(0);
    expect(state.updatedAt).toBe(0);
  });

  it('countStates is 0 when no state rows exist', () => {
    const { repo } = createContext();
    expect(repo.countStates()).toBe(0);
  });

  it('getAllCurrentStates returns empty array when no state rows exist', () => {
    const { repo } = createContext();
    expect(repo.getAllCurrentStates()).toEqual([]);
  });

  it('getDecisionsForStrategy returns empty array when no decisions exist', () => {
    const { repo } = createContext();
    const decisions = repo.getDecisionsForStrategy(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );
    expect(decisions).toEqual([]);
  });

  it('getLatestDecision returns null when no decisions exist', () => {
    const { repo } = createContext();
    const decision = repo.getLatestDecision(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );
    expect(decision).toBeNull();
  });

  it('decisionCount is 0 when no decisions exist', () => {
    const { repo } = createContext();
    expect(repo.decisionCount()).toBe(0);
  });
});

describe('StrategyLifecycleRepository — upsert state behavior', () => {
  it('upserts a new state row for a strategy', () => {
    const { repo } = createContext();
    const state = repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Backtest,
      updatedAt: 500000,
    });
    expect(state.phase).toBe(StrategyLifecyclePhase.Backtest);
    expect(state.id).toBeGreaterThan(0);
    expect(state.updatedAt).toBe(500000);
  });

  it('reloads state after upsert', () => {
    const { repo } = createContext();
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: 1000000,
    });

    const state = repo.getCurrentState(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );
    expect(state.phase).toBe(StrategyLifecyclePhase.Paper);
    expect(state.updatedAt).toBe(1000000);
  });

  it('updates existing state row with new phase', () => {
    const { repo } = createContext();
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Backtest,
      updatedAt: 500000,
    });

    // Promote to paper
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: 1000000,
    });

    const state = repo.getCurrentState(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );
    expect(state.phase).toBe(StrategyLifecyclePhase.Paper);
    expect(state.updatedAt).toBe(1000000);
  });

  it('promotes from paper to live', () => {
    const { repo } = createContext();
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Backtest,
      updatedAt: 500000,
    });
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: 1000000,
    });
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: 1500000,
    });

    const state = repo.getCurrentState(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );
    expect(state.phase).toBe(StrategyLifecyclePhase.Live);
  });

  it('returns updatedAt from upsert', () => {
    const { repo } = createContext();
    const state = repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: 2000000,
    });
    expect(state.updatedAt).toBe(2000000);
  });
});

describe('StrategyLifecycleRepository — identity isolation', () => {
  it('cross-strategy writes do not bleed between identities', () => {
    const { repo } = createContext();

    // Strategy A: backtest → paper
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: 1000000,
    });

    // Strategy B: stays at backtest (never upserted)
    const stateB = repo.getCurrentState(
      STRATEGY_B.strategyId,
      STRATEGY_B.strategyVersion,
      STRATEGY_B.marketId,
    );
    expect(stateB.phase).toBe(StrategyLifecyclePhase.Backtest);

    // Strategy A is still paper
    const stateA = repo.getCurrentState(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );
    expect(stateA.phase).toBe(StrategyLifecyclePhase.Paper);
  });

  it('multiple strategies have independent state', () => {
    const { repo } = createContext();

    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: 1000000,
    });
    repo.upsertCurrentState({
      ...STRATEGY_B,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: 2000000,
    });

    const states = repo.getAllCurrentStates();
    expect(states).toHaveLength(2);

    const stateA = states.find(s => s.strategyId === STRATEGY_A.strategyId)!;
    expect(stateA.phase).toBe(StrategyLifecyclePhase.Paper);

    const stateB = states.find(s => s.strategyId === STRATEGY_B.strategyId)!;
    expect(stateB.phase).toBe(StrategyLifecyclePhase.Live);
  });

  it('countStates returns correct count', () => {
    const { repo } = createContext();
    expect(repo.countStates()).toBe(0);

    repo.upsertCurrentState({ ...STRATEGY_A, phase: StrategyLifecyclePhase.Paper, updatedAt: 1000000 });
    expect(repo.countStates()).toBe(1);

    repo.upsertCurrentState({ ...STRATEGY_B, phase: StrategyLifecyclePhase.Backtest, updatedAt: 2000000 });
    expect(repo.countStates()).toBe(2);
  });
});

describe('StrategyLifecycleRepository — governance decisions (append-only)', () => {
  it('inserts a governance decision', () => {
    const { repo } = createContext();
    const decision = seedDecision(repo);

    expect(decision.id).toBeGreaterThan(0);
    expect(decision.verdict).toBe(GovernanceVerdict.Promote);
    expect(decision.previousPhase).toBe(StrategyLifecyclePhase.Backtest);
    expect(decision.newPhase).toBe(StrategyLifecyclePhase.Paper);
    expect(decision.rationale).toBe('Walk-forward winner met promotion thresholds');
    expect(decision.recordedAt).toBe(2000000);
  });

  it('preserves evidence snapshot JSON in governance decision', () => {
    const { repo } = createContext();
    const decision = seedDecision(repo);

    expect(decision.evidenceJson).not.toBeNull();
    const evidence = JSON.parse(decision.evidenceJson!);
    expect(evidence.mergedScore).toBe(0.85);
    expect(evidence.minMergedScore).toBe(DEFAULT_GOVERNANCE_THRESHOLDS.minMergedScore);
    expect(evidence.sharpeRatio).toBe(1.5);
  });

  it('allows null evidence and null winnerId', () => {
    const { repo } = createContext();
    const decision = repo.insertDecision({
      strategyId: STRATEGY_A.strategyId,
      strategyVersion: STRATEGY_A.strategyVersion,
      marketId: STRATEGY_A.marketId,
      verdict: GovernanceVerdict.Hold,
      previousPhase: StrategyLifecyclePhase.Backtest,
      newPhase: StrategyLifecyclePhase.Backtest,
      rationale: 'Did not meet thresholds',
      evidenceJson: null,
      winnerId: null,
      recordedAt: 3000000,
    });

    expect(decision.evidenceJson).toBeNull();
    expect(decision.winnerId).toBeNull();
    expect(decision.verdict).toBe(GovernanceVerdict.Hold);
  });

  it('append-only ordering is preserved (newest first)', () => {
    const { repo } = createContext();

    // Insert three decisions in chronological order
    seedDecision(repo, { recordedAt: 1000000 });
    seedDecision(repo, { recordedAt: 2000000, verdict: GovernanceVerdict.Hold });
    seedDecision(repo, { recordedAt: 3000000 });

    const decisions = repo.getDecisionsForStrategy(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
      5,
    );

    expect(decisions).toHaveLength(3);
    expect(decisions[0].recordedAt).toBe(3000000);
    expect(decisions[1].recordedAt).toBe(2000000);
    expect(decisions[1].verdict).toBe(GovernanceVerdict.Hold);
    expect(decisions[2].recordedAt).toBe(1000000);
  });

  it('getLatestDecision returns the most recent decision', () => {
    const { repo } = createContext();

    seedDecision(repo, { recordedAt: 1000000 });
    seedDecision(repo, { recordedAt: 2000000, verdict: GovernanceVerdict.Hold });
    seedDecision(repo, { recordedAt: 3000000 });

    const latest = repo.getLatestDecision(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );

    expect(latest).not.toBeNull();
    expect(latest!.recordedAt).toBe(3000000);
    expect(latest!.verdict).toBe(GovernanceVerdict.Promote);
  });

  it('getLatestDecision returns null when no decisions for a different strategy', () => {
    const { repo } = createContext();

    // Only decisions for STRATEGY_A
    seedDecision(repo, { recordedAt: 1000000 });

    // Query STRATEGY_B — no decisions
    const latest = repo.getLatestDecision(
      STRATEGY_B.strategyId,
      STRATEGY_B.strategyVersion,
      STRATEGY_B.marketId,
    );
    expect(latest).toBeNull();
  });

  it('decisionCount returns correct count', () => {
    const { repo } = createContext();
    expect(repo.decisionCount()).toBe(0);

    seedDecision(repo, { recordedAt: 1000000 });
    expect(repo.decisionCount()).toBe(1);

    seedDecision(repo, { recordedAt: 2000000 });
    expect(repo.decisionCount()).toBe(2);
  });

  it('getAllDecisions returns decisions across all strategies', () => {
    const { repo } = createContext();

    // Decision for STRATEGY_A
    seedDecision(repo, { recordedAt: 1000000 });

    // Decision for STRATEGY_B
    repo.insertDecision({
      strategyId: STRATEGY_B.strategyId,
      strategyVersion: STRATEGY_B.strategyVersion,
      marketId: STRATEGY_B.marketId,
      verdict: GovernanceVerdict.Hold,
      previousPhase: StrategyLifecyclePhase.Backtest,
      newPhase: StrategyLifecyclePhase.Backtest,
      rationale: 'Insufficient evidence',
      evidenceJson: null,
      winnerId: null,
      recordedAt: 2000000,
    });

    const all = repo.getAllDecisions(10);
    expect(all).toHaveLength(2);
    expect(all[0].strategyId).toBe(STRATEGY_B.strategyId); // newest first
    expect(all[1].strategyId).toBe(STRATEGY_A.strategyId);
  });

  it('getDecisionsForStrategy respects limit parameter', () => {
    const { repo } = createContext();

    seedDecision(repo, { recordedAt: 1000000 });
    seedDecision(repo, { recordedAt: 2000000 });
    seedDecision(repo, { recordedAt: 3000000 });

    const limited = repo.getDecisionsForStrategy(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
      2,
    );
    expect(limited).toHaveLength(2);
    expect(limited[0].recordedAt).toBe(3000000);
    expect(limited[1].recordedAt).toBe(2000000);
  });
});

describe('StrategyLifecycleRepository — hold verdict behavior', () => {
  it('hold verdict keeps phase unchanged', () => {
    const { repo } = createContext();

    // First promote to paper
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: 1000000,
    });

    // Then hold
    const decision = repo.insertDecision({
      strategyId: STRATEGY_A.strategyId,
      strategyVersion: STRATEGY_A.strategyVersion,
      marketId: STRATEGY_A.marketId,
      verdict: GovernanceVerdict.Hold,
      previousPhase: StrategyLifecyclePhase.Paper,
      newPhase: StrategyLifecyclePhase.Paper, // stays same
      rationale: 'Sharpe ratio below threshold',
      evidenceJson: JSON.stringify({ sharpeRatio: 0.8, minSharpeRatio: 1.0 }),
      winnerId: null,
      recordedAt: 2000000,
    });

    expect(decision.previousPhase).toBe(StrategyLifecyclePhase.Paper);
    expect(decision.newPhase).toBe(StrategyLifecyclePhase.Paper);

    // State remains paper
    const state = repo.getCurrentState(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );
    expect(state.phase).toBe(StrategyLifecyclePhase.Paper);
  });

  it('hold verdict with backtest keeps at backtest', () => {
    const { repo } = createContext();

    // State is backtest (default)
    const decision = repo.insertDecision({
      strategyId: STRATEGY_A.strategyId,
      strategyVersion: STRATEGY_A.strategyVersion,
      marketId: STRATEGY_A.marketId,
      verdict: GovernanceVerdict.Hold,
      previousPhase: StrategyLifecyclePhase.Backtest,
      newPhase: StrategyLifecyclePhase.Backtest,
      rationale: 'Walk-forward not completed',
      evidenceJson: null,
      winnerId: null,
      recordedAt: 3000000,
    });

    expect(decision.previousPhase).toBe(StrategyLifecyclePhase.Backtest);
    expect(decision.newPhase).toBe(StrategyLifecyclePhase.Backtest);
  });
});

describe('StrategyLifecycleRepository — lifecycle phase ordering invariants', () => {
  it.each([
    [StrategyLifecyclePhase.Backtest, 'backtest'],
    [StrategyLifecyclePhase.Paper, 'paper'],
    [StrategyLifecyclePhase.Live, 'live'],
  ])('phase %s has correct string value "%s"', (phase, expected) => {
    expect(phase).toBe(expected);
  });

  it('GovernanceVerdict.Hold has correct value', () => {
    expect(GovernanceVerdict.Hold).toBe('hold');
  });

  it('GovernanceVerdict.Promote has correct value', () => {
    expect(GovernanceVerdict.Promote).toBe('promote');
  });

  it('GovernanceVerdict.Demote has correct value', () => {
    expect(GovernanceVerdict.Demote).toBe('demote');
  });
});

// ---------------------------------------------------------------------------
// DEMOTE verdict persistence
// ---------------------------------------------------------------------------

describe('StrategyLifecycleRepository — demote verdict behavior', () => {
  it('persists a DEMOTE governance decision with phase transition', () => {
    const { repo } = createContext();

    // Seed state at live
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: 1000000,
    });

    // Demote from live to paper
    const decision = repo.insertDecision({
      strategyId: STRATEGY_A.strategyId,
      strategyVersion: STRATEGY_A.strategyVersion,
      marketId: STRATEGY_A.marketId,
      verdict: GovernanceVerdict.Demote,
      previousPhase: StrategyLifecyclePhase.Live,
      newPhase: StrategyLifecyclePhase.Paper,
      rationale: 'Risk breach triggered demotion from live to paper.',
      evidenceJson: JSON.stringify({
        trigger: 'risk_breach',
        haltSource: 'daily_loss',
      }),
      winnerId: null,
      recordedAt: 2000000,
    });

    expect(decision.verdict).toBe(GovernanceVerdict.Demote);
    expect(decision.previousPhase).toBe(StrategyLifecyclePhase.Live);
    expect(decision.newPhase).toBe(StrategyLifecyclePhase.Paper);
    expect(decision.rationale).toContain('Risk breach');
    expect(decision.evidenceJson).toContain('risk_breach');

    // Verify via read-back
    const decisions = repo.getDecisionsForStrategy(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0].verdict).toBe(GovernanceVerdict.Demote);
  });

  it('persists a DEMOTE from paper to backtest', () => {
    const { repo } = createContext();

    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: 1000000,
    });

    const decision = repo.insertDecision({
      strategyId: STRATEGY_A.strategyId,
      strategyVersion: STRATEGY_A.strategyVersion,
      marketId: STRATEGY_A.marketId,
      verdict: GovernanceVerdict.Demote,
      previousPhase: StrategyLifecyclePhase.Paper,
      newPhase: StrategyLifecyclePhase.Backtest,
      rationale: 'Performance drift triggered demotion from paper to backtest.',
      evidenceJson: null,
      winnerId: null,
      recordedAt: 2000000,
    });

    expect(decision.previousPhase).toBe(StrategyLifecyclePhase.Paper);
    expect(decision.newPhase).toBe(StrategyLifecyclePhase.Backtest);
  });

  it('DEMOTE decisions are append-only and do not overwrite prior decisions', () => {
    const { repo } = createContext();

    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: 1000000,
    });

    // Two demote decisions
    repo.insertDecision({
      strategyId: STRATEGY_A.strategyId,
      strategyVersion: STRATEGY_A.strategyVersion,
      marketId: STRATEGY_A.marketId,
      verdict: GovernanceVerdict.Demote,
      previousPhase: StrategyLifecyclePhase.Live,
      newPhase: StrategyLifecyclePhase.Paper,
      rationale: 'First demotion',
      evidenceJson: null,
      winnerId: null,
      recordedAt: 2000000,
    });

    repo.insertDecision({
      strategyId: STRATEGY_A.strategyId,
      strategyVersion: STRATEGY_A.strategyVersion,
      marketId: STRATEGY_A.marketId,
      verdict: GovernanceVerdict.Demote,
      previousPhase: StrategyLifecyclePhase.Paper,
      newPhase: StrategyLifecyclePhase.Backtest,
      rationale: 'Second demotion',
      evidenceJson: null,
      winnerId: null,
      recordedAt: 3000000,
    });

    const decisions = repo.getDecisionsForStrategy(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
      10,
    );
    expect(decisions).toHaveLength(2);
    expect(decisions[0].verdict).toBe(GovernanceVerdict.Demote);
    expect(decisions[0].newPhase).toBe(StrategyLifecyclePhase.Backtest);
    expect(decisions[1].verdict).toBe(GovernanceVerdict.Demote);
    expect(decisions[1].newPhase).toBe(StrategyLifecyclePhase.Paper);
  });

  it('DEMOTE decisions respect identity isolation — different strategies have independent demotion history', () => {
    const { repo } = createContext();

    // Seed both strategies
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: 1000000,
    });
    repo.upsertCurrentState({
      ...STRATEGY_B,
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: 1000000,
    });

    // Demote A: live → paper
    repo.insertDecision({
      strategyId: STRATEGY_A.strategyId,
      strategyVersion: STRATEGY_A.strategyVersion,
      marketId: STRATEGY_A.marketId,
      verdict: GovernanceVerdict.Demote,
      previousPhase: StrategyLifecyclePhase.Live,
      newPhase: StrategyLifecyclePhase.Paper,
      rationale: 'A demoted',
      evidenceJson: null,
      winnerId: null,
      recordedAt: 2000000,
    });

    // B stays at paper — no demotion decision for B
    const decisionsA = repo.getDecisionsForStrategy(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );
    expect(decisionsA).toHaveLength(1);
    expect(decisionsA[0].verdict).toBe(GovernanceVerdict.Demote);

    const decisionsB = repo.getDecisionsForStrategy(
      STRATEGY_B.strategyId,
      STRATEGY_B.strategyVersion,
      STRATEGY_B.marketId,
    );
    expect(decisionsB).toHaveLength(0);
  });

  it('updates lifecycle state on demotion via upsertCurrentState', () => {
    const { repo } = createContext();

    // Seed at live
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: 1000000,
    });

    // Demote: live → paper
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: 2000000,
    });

    const state = repo.getCurrentState(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );
    expect(state.phase).toBe(StrategyLifecyclePhase.Paper);
    expect(state.updatedAt).toBe(2000000);
  });

  it('repeated demotion correctly steps down through phases', () => {
    const { repo } = createContext();

    // Start at live
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Live,
      updatedAt: 1000000,
    });

    // Demote 1: live → paper
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Paper,
      updatedAt: 2000000,
    });
    let state = repo.getCurrentState(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );
    expect(state.phase).toBe(StrategyLifecyclePhase.Paper);

    // Demote 2: paper → backtest
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Backtest,
      updatedAt: 3000000,
    });
    state = repo.getCurrentState(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );
    expect(state.phase).toBe(StrategyLifecyclePhase.Backtest);

    // Cannot demote below backtest — stays at backtest
    repo.upsertCurrentState({
      ...STRATEGY_A,
      phase: StrategyLifecyclePhase.Backtest,
      updatedAt: 4000000,
    });
    state = repo.getCurrentState(
      STRATEGY_A.strategyId,
      STRATEGY_A.strategyVersion,
      STRATEGY_A.marketId,
    );
    expect(state.phase).toBe(StrategyLifecyclePhase.Backtest);
  });
});
