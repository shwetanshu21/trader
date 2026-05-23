import { describe, expect, it } from 'vitest';

import { canonicalizeHypothesis } from '../src/research/hypothesis-canonicalizer.js';
import { HypothesisRepository } from '../src/persistence/hypothesis-repo.js';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import {
  HypothesisStatus,
  type HypothesisGraph,
  type NewHypothesisGraph,
} from '../src/types/runtime.js';

function createRepo(): HypothesisRepository {
  const mgr = new DatabaseManager(':memory:');
  return new HypothesisRepository(mgr.db);
}

function sampleGraph(overrides?: Partial<HypothesisGraph>): HypothesisGraph {
  return {
    schemaVersion: '1',
    signals: [{ type: 'ema_cross', params: { fast: 8, slow: 21 } }],
    filters: [{ type: 'volume_min', params: { min: 500000 } }],
    entryRules: [{ type: 'breakout_confirmed', params: { lookbackBars: 5 } }],
    exitRules: [{ type: 'time_stop', params: { maxBars: 12 } }],
    riskRules: [{ type: 'atr_stop', params: { period: 14, multiple: 2 } }],
    metadata: { source: 'llm', promptVersion: 'v1' },
    ...overrides,
  };
}

function newHypothesis(
  status: HypothesisStatus = HypothesisStatus.Pending,
  graphOverrides?: Partial<HypothesisGraph>,
  timestamps?: { createdAt?: number; updatedAt?: number },
): NewHypothesisGraph {
  const graph = sampleGraph(graphOverrides);
  const canonical = canonicalizeHypothesis(graph);
  return {
    canonicalHash: canonical.canonicalHash,
    canonicalJson: canonical.canonicalJson,
    status,
    graph,
    createdAt: timestamps?.createdAt ?? Date.now(),
    updatedAt: timestamps?.updatedAt ?? timestamps?.createdAt ?? Date.now(),
  };
}

describe('HypothesisRepository', () => {
  it('inserts and round-trips a hypothesis graph row', () => {
    const repo = createRepo();
    const input = newHypothesis(HypothesisStatus.Pending);

    const row = repo.insertHypothesis(input);
    const fetched = repo.getHypothesisById(row.id);

    expect(row.id).toBeGreaterThan(0);
    expect(fetched).not.toBeNull();
    expect(fetched?.canonicalHash).toBe(input.canonicalHash);
    expect(fetched?.canonicalJson).toBe(input.canonicalJson);
    expect(fetched?.status).toBe(HypothesisStatus.Pending);
    expect(fetched?.graph.signals[0]?.type).toBe('ema_cross');
    expect(fetched?.graph.metadata).toEqual({ source: 'llm', promptVersion: 'v1' });
    expect(repo.count()).toBe(1);
  });

  it('retrieves the most recent row for a canonical hash', () => {
    const repo = createRepo();
    const createdAt = Date.now();
    const first = repo.insertHypothesis(newHypothesis(HypothesisStatus.Pending, undefined, {
      createdAt,
      updatedAt: createdAt,
    }));

    const second = repo.insertHypothesis(newHypothesis(HypothesisStatus.Validated, undefined, {
      createdAt: createdAt + 10,
      updatedAt: createdAt + 20,
    }));

    const fetched = repo.getHypothesisByCanonicalHash(first.canonicalHash);

    expect(fetched?.id).toBe(second.id);
    expect(fetched?.status).toBe(HypothesisStatus.Validated);
  });

  it('updates status and updatedAt without changing the stored graph', () => {
    const repo = createRepo();
    const row = repo.insertHypothesis(newHypothesis(HypothesisStatus.Pending));
    const updatedAt = row.updatedAt + 5_000;

    const updated = repo.updateStatus(row.id, HypothesisStatus.Validated, updatedAt);

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe(HypothesisStatus.Validated);
    expect(updated?.updatedAt).toBe(updatedAt);
    expect(updated?.graph.exitRules[0]?.type).toBe('time_stop');
  });

  it('returns recent hypotheses newest first and supports status filtering', () => {
    const repo = createRepo();
    const base = Date.now();

    repo.insertHypothesis(newHypothesis(HypothesisStatus.Pending, { metadata: { label: 'old' } }, {
      createdAt: base,
      updatedAt: base,
    }));
    repo.insertHypothesis(newHypothesis(HypothesisStatus.Rejected, { metadata: { label: 'mid' } }, {
      createdAt: base + 10,
      updatedAt: base + 10,
    }));
    repo.insertHypothesis(newHypothesis(HypothesisStatus.Validated, { metadata: { label: 'new' } }, {
      createdAt: base + 20,
      updatedAt: base + 20,
    }));

    const recent = repo.getRecentHypotheses(2);
    const rejected = repo.getRecentHypotheses(10, HypothesisStatus.Rejected);

    expect(recent).toHaveLength(2);
    expect(recent[0]?.graph.metadata).toEqual({ label: 'new' });
    expect(recent[1]?.graph.metadata).toEqual({ label: 'mid' });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status).toBe(HypothesisStatus.Rejected);
  });

  it('round-trips a graph with null metadata cleanly', () => {
    const repo = createRepo();
    const input = newHypothesis(HypothesisStatus.Pending, { metadata: undefined });

    const row = repo.insertHypothesis(input);
    const fetched = repo.getHypothesisById(row.id);

    expect(fetched?.graph.metadata).toBeUndefined();
  });
});

describe('HypothesisRepository — evaluation CRUD', () => {
  function seedHypothesis(repo: HypothesisRepository): number {
    const input = newHypothesis(HypothesisStatus.Validated);
    return repo.insertHypothesis(input).id;
  }

  it('inserts and round-trips a hypothesis evaluation row', () => {
    const repo = createRepo();
    const hypothesisId = seedHypothesis(repo);

    const evalRow = repo.insertEvaluation({
      hypothesisGraphId: hypothesisId,
      status: 'pending' as const,
      rationale: 'Starting evaluation for EMA crossover hypothesis.',
      outcomeDetail: '',
    });

    expect(evalRow.id).toBeGreaterThan(0);
    expect(evalRow.hypothesisGraphId).toBe(hypothesisId);
    expect(evalRow.status).toBe('pending');
    expect(evalRow.walkForwardRunId).toBeNull();
    expect(evalRow.winnerId).toBeNull();
    expect(evalRow.rationale).toBe('Starting evaluation for EMA crossover hypothesis.');
    expect(evalRow.createdAt).toBeGreaterThan(0);
    expect(evalRow.updatedAt).toBeGreaterThan(0);

    const fetched = repo.getEvaluationById(evalRow.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(evalRow.id);
  });

  it('enforces UNIQUE on hypothesis_graph_id', () => {
    const repo = createRepo();
    const hypothesisId = seedHypothesis(repo);

    repo.insertEvaluation({
      hypothesisGraphId: hypothesisId,
      status: 'pending',
      rationale: 'First attempt.',
      outcomeDetail: '',
    });

    expect(() => {
      repo.insertEvaluation({
        hypothesisGraphId: hypothesisId,
        status: 'pending',
        rationale: 'Second attempt should fail.',
        outcomeDetail: '',
      });
    }).toThrow();
  });

  it('retrieves evaluation by hypothesis graph id', () => {
    const repo = createRepo();
    const hypothesisId = seedHypothesis(repo);

    repo.insertEvaluation({
      hypothesisGraphId: hypothesisId,
      status: 'in_progress',
      rationale: 'Running walk-forward.',
      outcomeDetail: '',
    });

    const fetched = repo.getEvaluationByHypothesisId(hypothesisId);
    expect(fetched).not.toBeNull();
    expect(fetched?.status).toBe('in_progress');
  });

  it('returns null for non-existent evaluation lookups', () => {
    const repo = createRepo();
    expect(repo.getEvaluationById(999)).toBeNull();
    expect(repo.getEvaluationByHypothesisId(999)).toBeNull();
  });

  it('updateEvaluation applies partial field updates', () => {
    const repo = createRepo();
    const hypothesisId = seedHypothesis(repo);
    const createdAt = Date.now();
    const evalRow = repo.insertEvaluation({
      hypothesisGraphId: hypothesisId,
      status: 'pending',
      rationale: 'Initial.',
      outcomeDetail: '',
      createdAt,
    });

    // Advance clock by 5ms so updatedAt is observably different
    const updatedAt = createdAt + 5;
    const updated = repo.updateEvaluation(evalRow.id, {
      status: 'completed',
      rationale: 'Winner found.',
      outcomeDetail: 'Selected trial #3 with merged score 0.85',
      updatedAt,
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('completed');
    expect(updated?.rationale).toBe('Winner found.');
    expect(updated?.outcomeDetail).toBe('Selected trial #3 with merged score 0.85');
    expect(updated?.createdAt).toBe(evalRow.createdAt);
    expect(updated?.updatedAt).toBe(updatedAt);
  });

  it('updates walk_forward_run_id and winner_id via updateEvaluation', () => {
    const repo = createRepo();
    const hypothesisId = seedHypothesis(repo);
    const evalRow = repo.insertEvaluation({
      hypothesisGraphId: hypothesisId,
      status: 'in_progress',
      rationale: 'Linked to walk-forward run.',
      outcomeDetail: '',
    });

    // Seed FK-referenced rows in walk_forward_runs and walk_forward_winners
    const db = (repo as unknown as { _db: import('better-sqlite3').Database })._db;
    db.prepare(`
      INSERT INTO walk_forward_runs
        (label, strategy_id, strategy_version, market_id, window_count, total_trials, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('wf-fk-test', 'strat-v1', '1.0', 'INDIA_NSE_EQ', 3, 6, 'completed', Date.now());

    const runRow = db.prepare('SELECT id FROM walk_forward_runs WHERE label = ?').get('wf-fk-test') as { id: number };

    db.prepare(`
      INSERT INTO walk_forward_winners
        (run_id, result, selection_strategy, selection_config_json, rationale, selected_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(runRow.id, 'selected', 'best_sharpe', '{}', 'Won on Sharpe.', Date.now(), Date.now());

    const winnerRow = db.prepare('SELECT id FROM walk_forward_winners WHERE run_id = ?').get(runRow.id) as { id: number };

    const withRun = repo.updateEvaluation(evalRow.id, {
      walkForwardRunId: runRow.id,
    });
    expect(withRun?.walkForwardRunId).toBe(runRow.id);

    const withWinner = repo.updateEvaluation(evalRow.id, {
      winnerId: winnerRow.id,
      status: 'completed',
      rationale: 'Completed with winner.',
    });
    expect(withWinner?.winnerId).toBe(winnerRow.id);
    expect(withWinner?.walkForwardRunId).toBe(runRow.id);
    expect(withWinner?.status).toBe('completed');
  });

  it('returns recent evaluations newest first and supports status filtering', () => {
    const repo = createRepo();
    const base = Date.now();

    const h1 = repo.insertHypothesis(newHypothesis(HypothesisStatus.Validated, undefined, {
      createdAt: base, updatedAt: base,
    }));
    const h2 = repo.insertHypothesis(newHypothesis(HypothesisStatus.Validated, { metadata: { label: 'second' } }, {
      createdAt: base + 10, updatedAt: base + 10,
    }));
    const h3 = repo.insertHypothesis(newHypothesis(HypothesisStatus.Validated, { metadata: { label: 'third' } }, {
      createdAt: base + 20, updatedAt: base + 20,
    }));

    repo.insertEvaluation({
      hypothesisGraphId: h1.id, status: 'completed', rationale: 'Winner.', outcomeDetail: '',
    });
    repo.insertEvaluation({
      hypothesisGraphId: h2.id, status: 'in_progress', rationale: 'Running.', outcomeDetail: '',
    });
    repo.insertEvaluation({
      hypothesisGraphId: h3.id, status: 'no_winner', rationale: 'No winner.', outcomeDetail: 'All trials below threshold.',
    });

    const recent = repo.getRecentEvaluations(2);
    expect(recent).toHaveLength(2);

    const inProgressList = repo.getRecentEvaluations(10, 'in_progress');
    expect(inProgressList).toHaveLength(1);
    expect(inProgressList[0]?.status).toBe('in_progress');
  });

  it('countEvaluations returns accurate count', () => {
    const repo = createRepo();
    expect(repo.countEvaluations()).toBe(0);

    const h1 = repo.insertHypothesis(newHypothesis(HypothesisStatus.Validated));
    repo.insertEvaluation({
      hypothesisGraphId: h1.id, status: 'pending', rationale: 'Test.', outcomeDetail: '',
    });
    expect(repo.countEvaluations()).toBe(1);

    const h2 = repo.insertHypothesis(newHypothesis(HypothesisStatus.Validated, { metadata: { label: 'second' } }));
    repo.insertEvaluation({
      hypothesisGraphId: h2.id, status: 'completed', rationale: 'Done.', outcomeDetail: '',
    });
    expect(repo.countEvaluations()).toBe(2);
  });

  it('returns null for updateEvaluation on non-existent id', () => {
    const repo = createRepo();
    const result = repo.updateEvaluation(999, { status: 'completed' });
    expect(result).toBeNull();
  });
});

describe('HypothesisRepository — research artifact CRUD', () => {
  function seedEvaluation(repo: HypothesisRepository): number {
    const hypoId = repo.insertHypothesis(newHypothesis(HypothesisStatus.Validated)).id;
    return repo.insertEvaluation({
      hypothesisGraphId: hypoId,
      status: 'completed',
      rationale: 'Test evaluation.',
      outcomeDetail: 'Winner found.',
    }).id;
  }

  it('inserts and round-trips a research artifact row', () => {
    const repo = createRepo();
    const evalId = seedEvaluation(repo);

    const artifact = repo.insertResearchArtifact({
      hypothesisEvaluationId: evalId,
      artifactType: 'promotion_artifact',
      format: 'markdown',
      filePath: 'promotion-ready.md',
      label: 'Promotion-ready markdown report',
    });

    expect(artifact.id).toBeGreaterThan(0);
    expect(artifact.hypothesisEvaluationId).toBe(evalId);
    expect(artifact.artifactType).toBe('promotion_artifact');
    expect(artifact.format).toBe('markdown');
    expect(artifact.filePath).toBe('promotion-ready.md');
    expect(artifact.label).toBe('Promotion-ready markdown report');
    expect(artifact.createdAt).toBeGreaterThan(0);

    const fetched = repo.getResearchArtifactById(artifact.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.filePath).toBe('promotion-ready.md');
  });

  it('returns null for non-existent artifact lookup', () => {
    const repo = createRepo();
    expect(repo.getResearchArtifactById(999)).toBeNull();
  });

  it('lists artifacts by evaluation id, oldest first', () => {
    const repo = createRepo();
    const evalId = seedEvaluation(repo);

    const a1 = repo.insertResearchArtifact({
      hypothesisEvaluationId: evalId,
      artifactType: 'summary',
      format: 'markdown',
      filePath: 'summary.md',
      label: 'Summary',
      createdAt: 100,
    });
    const a2 = repo.insertResearchArtifact({
      hypothesisEvaluationId: evalId,
      artifactType: 'full_report',
      format: 'markdown',
      filePath: 'full-report.md',
      label: 'Full Report',
      createdAt: 200,
    });
    const a3 = repo.insertResearchArtifact({
      hypothesisEvaluationId: evalId,
      artifactType: 'winner_config',
      format: 'json',
      filePath: 'winner-config.json',
      label: 'Winner Config',
      createdAt: 150,
    });

    const artifacts = repo.getResearchArtifactsByEvaluationId(evalId);
    expect(artifacts).toHaveLength(3);
    // Oldest first (by createdAt, then id)
    expect(artifacts[0]?.id).toBe(a1.id);
    expect(artifacts[1]?.id).toBe(a3.id); // createdAt 150
    expect(artifacts[2]?.id).toBe(a2.id); // createdAt 200
  });

  it('countResearchArtifacts returns accurate count', () => {
    const repo = createRepo();
    expect(repo.countResearchArtifacts()).toBe(0);

    const evalId = seedEvaluation(repo);
    repo.insertResearchArtifact({
      hypothesisEvaluationId: evalId,
      artifactType: 'diagnostics',
      format: 'json',
      filePath: 'diag.json',
      label: 'Diagnostics',
    });
    expect(repo.countResearchArtifacts()).toBe(1);
  });

  it('returns empty array for evaluation with no artifacts', () => {
    const repo = createRepo();
    const evalId = seedEvaluation(repo);
    const artifacts = repo.getResearchArtifactsByEvaluationId(evalId);
    expect(artifacts).toEqual([]);
  });
});

describe('HypothesisRepository — evaluation with linked walk-forward run', () => {
  it('getEvaluationWithLinked returns evaluation with run and winner snapshots', () => {
    const repo = createRepo();
    const hypothesisId = repo.insertHypothesis(newHypothesis(HypothesisStatus.Validated)).id;

    // Seed a walk_forward_run row directly via SQL for the linked snapshot test
    const db = (repo as unknown as { _db: import('better-sqlite3').Database })._db;
    db.prepare(`
      INSERT INTO walk_forward_runs
        (label, strategy_id, strategy_version, market_id, window_count, total_trials, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('wf-test-run', 'strat-v1', '1.0', 'INDIA_NSE_EQ', 5, 10, 'completed', Date.now());

    const runRow = db.prepare('SELECT id FROM walk_forward_runs WHERE label = ?').get('wf-test-run') as { id: number };

    // Seed a walk_forward_winner row
    db.prepare(`
      INSERT INTO walk_forward_winners
        (run_id, result, selection_strategy, selection_config_json, rationale, selected_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(runRow.id, 'selected', 'best_sharpe', '{}', 'Best Sharpe ratio across windows.', Date.now(), Date.now());

    const winnerRow = db.prepare('SELECT id FROM walk_forward_winners WHERE run_id = ?').get(runRow.id) as { id: number };

    const evalRow = repo.insertEvaluation({
      hypothesisGraphId: hypothesisId,
      status: 'completed',
      walkForwardRunId: runRow.id,
      winnerId: winnerRow.id,
      rationale: 'Winner selected.',
      outcomeDetail: 'Selected via best_sharpe.',
    });

    const linked = repo.getEvaluationWithLinked(evalRow.id);
    expect(linked).not.toBeNull();
    expect(linked?.evaluation.hypothesisGraphId).toBe(hypothesisId);
    expect(linked?.walkForwardRun).not.toBeNull();
    expect(linked?.walkForwardRun?.id).toBe(runRow.id);
    expect(linked?.walkForwardRun?.label).toBe('wf-test-run');
    expect(linked?.walkForwardRun?.status).toBe('completed');
    expect(linked?.walkForwardRun?.windowCount).toBe(5);
    expect(linked?.walkForwardRun?.totalTrials).toBe(10);
    expect(linked?.winner).not.toBeNull();
    expect(linked?.winner?.result).toBe('selected');
    expect(linked?.winner?.selectionStrategy).toBe('best_sharpe');
    expect(linked?.winner?.selectedTrialId).toBeNull();
    expect(linked?.winner?.rationale).toBe('Best Sharpe ratio across windows.');
  });

  it('getEvaluationWithLinked returns null for non-existent id', () => {
    const repo = createRepo();
    expect(repo.getEvaluationWithLinked(999)).toBeNull();
  });

  it('getEvaluationWithLinked returns null walkForwardRun/winner when not linked', () => {
    const repo = createRepo();
    const hypothesisId = repo.insertHypothesis(newHypothesis(HypothesisStatus.Validated)).id;
    const evalRow = repo.insertEvaluation({
      hypothesisGraphId: hypothesisId,
      status: 'pending',
      rationale: 'No link yet.',
      outcomeDetail: '',
    });

    const linked = repo.getEvaluationWithLinked(evalRow.id);
    expect(linked).not.toBeNull();
    expect(linked?.walkForwardRun).toBeNull();
    expect(linked?.winner).toBeNull();
  });
});
