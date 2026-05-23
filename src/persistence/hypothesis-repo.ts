import type Database from 'better-sqlite3';

import {
  type HypothesisEvaluationRow,
  type HypothesisEvaluationStatus,
  type HypothesisEvaluationWithLinked,
  type HypothesisGraph,
  type HypothesisGraphRow,
  type HypothesisStatus,
  type NewHypothesisEvaluation,
  type NewHypothesisGraph,
  type NewResearchArtifact,
  type ResearchArtifactFormat,
  type ResearchArtifactRow,
  type ResearchArtifactType,
  type ResearchPublicationRow,
  type NewResearchPublication,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// HypothesisRepository — typed CRUD over structured hypothesis graphs,
// hypothesis evaluations, and research artifacts
// ---------------------------------------------------------------------------

export class HypothesisRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  /** Insert a structured hypothesis graph row. */
  insertHypothesis(input: NewHypothesisGraph): HypothesisGraphRow {
    const stmt = this._db.prepare(`
      INSERT INTO hypothesis_graphs
        (canonical_hash, canonical_json, status, schema_version,
         signals_json, filters_json, entry_rules_json, exit_rules_json,
         risk_rules_json, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      input.canonicalHash,
      input.canonicalJson,
      input.status,
      input.graph.schemaVersion,
      JSON.stringify(input.graph.signals),
      JSON.stringify(input.graph.filters),
      JSON.stringify(input.graph.entryRules),
      JSON.stringify(input.graph.exitRules),
      JSON.stringify(input.graph.riskRules),
      input.graph.metadata == null ? null : JSON.stringify(input.graph.metadata),
      input.createdAt,
      input.updatedAt,
    );

    return {
      id: Number(result.lastInsertRowid),
      ...input,
    };
  }

  /** Retrieve a hypothesis row by id. */
  getHypothesisById(id: number): HypothesisGraphRow | null {
    const row = this._db.prepare(`
      SELECT * FROM hypothesis_graphs WHERE id = ?
    `).get(id) as HypothesisDbRow | undefined;

    return row ? mapHypothesisRow(row) : null;
  }

  /**
   * Retrieve the most recent hypothesis row for a canonical hash.
   * Returns null when the hash has never been seen.
   */
  getHypothesisByCanonicalHash(canonicalHash: string): HypothesisGraphRow | null {
    const row = this._db.prepare(`
      SELECT *
      FROM hypothesis_graphs
      WHERE canonical_hash = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(canonicalHash) as HypothesisDbRow | undefined;

    return row ? mapHypothesisRow(row) : null;
  }

  /** Update the durable lifecycle status for a hypothesis row. */
  updateStatus(
    id: number,
    status: HypothesisStatus,
    updatedAt: number = Date.now(),
  ): HypothesisGraphRow | null {
    const result = this._db.prepare(`
      UPDATE hypothesis_graphs
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(status, updatedAt, id);

    if (result.changes === 0) {
      return null;
    }

    return this.getHypothesisById(id);
  }

  /** Retrieve recent hypothesis rows, newest first. */
  getRecentHypotheses(
    limit = 50,
    status?: HypothesisStatus,
  ): HypothesisGraphRow[] {
    let sql: string;
    let params: unknown[];

    if (status !== undefined) {
      sql = `
        SELECT *
        FROM hypothesis_graphs
        WHERE status = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
      params = [status, limit];
    } else {
      sql = `
        SELECT *
        FROM hypothesis_graphs
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
      params = [limit];
    }

    const rows = this._db.prepare(sql).all(...params) as HypothesisDbRow[];
    return rows.map(mapHypothesisRow);
  }

  /** Count total hypothesis rows. */
  count(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM hypothesis_graphs').get() as { cnt: number };
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Hypothesis evaluation CRUD
  // -----------------------------------------------------------------------

  /** Insert a hypothesis evaluation row. */
  insertEvaluation(input: NewHypothesisEvaluation): HypothesisEvaluationRow {
    const now = input.createdAt ?? Date.now();

    const stmt = this._db.prepare(`
      INSERT INTO hypothesis_evaluations
        (hypothesis_graph_id, walk_forward_run_id, status, winner_id,
         rationale, outcome_detail, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      input.hypothesisGraphId,
      input.walkForwardRunId ?? null,
      input.status,
      input.winnerId ?? null,
      input.rationale,
      input.outcomeDetail,
      now,
      input.updatedAt ?? now,
    );

    return this.getEvaluationById(Number(result.lastInsertRowid))!;
  }

  /** Retrieve a hypothesis evaluation by id. */
  getEvaluationById(id: number): HypothesisEvaluationRow | null {
    const row = this._db.prepare(`
      SELECT * FROM hypothesis_evaluations WHERE id = ?
    `).get(id) as HypothesisEvalDbRow | undefined;

    return row ? mapEvalRow(row) : null;
  }

  /** Retrieve the evaluation for a hypothesis graph row. */
  getEvaluationByHypothesisId(hypothesisGraphId: number): HypothesisEvaluationRow | null {
    const row = this._db.prepare(`
      SELECT * FROM hypothesis_evaluations WHERE hypothesis_graph_id = ?
    `).get(hypothesisGraphId) as HypothesisEvalDbRow | undefined;

    return row ? mapEvalRow(row) : null;
  }

  /** Update evaluation status, rationale, outcome detail, and linked entities. */
  updateEvaluation(
    id: number,
    fields: {
      status?: HypothesisEvaluationStatus;
      walkForwardRunId?: number | null;
      winnerId?: number | null;
      rationale?: string;
      outcomeDetail?: string;
      updatedAt?: number;
    },
  ): HypothesisEvaluationRow | null {
    const now = fields.updatedAt ?? Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (fields.status !== undefined) {
      sets.push('status = ?');
      params.push(fields.status);
    }
    if (fields.walkForwardRunId !== undefined) {
      sets.push('walk_forward_run_id = ?');
      params.push(fields.walkForwardRunId);
    }
    if (fields.winnerId !== undefined) {
      sets.push('winner_id = ?');
      params.push(fields.winnerId);
    }
    if (fields.rationale !== undefined) {
      sets.push('rationale = ?');
      params.push(fields.rationale);
    }
    if (fields.outcomeDetail !== undefined) {
      sets.push('outcome_detail = ?');
      params.push(fields.outcomeDetail);
    }

    params.push(id);

    const result = this._db.prepare(
      `UPDATE hypothesis_evaluations SET ${sets.join(', ')} WHERE id = ?`,
    ).run(...params);

    if (result.changes === 0) {
      return null;
    }

    return this.getEvaluationById(id);
  }

  /** Retrieve recent hypothesis evaluations, newest first. */
  getRecentEvaluations(
    limit = 50,
    status?: HypothesisEvaluationStatus,
  ): HypothesisEvaluationRow[] {
    let sql: string;
    let params: unknown[];

    if (status !== undefined) {
      sql = `
        SELECT *
        FROM hypothesis_evaluations
        WHERE status = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
      params = [status, limit];
    } else {
      sql = `
        SELECT *
        FROM hypothesis_evaluations
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
      params = [limit];
    }

    const rows = this._db.prepare(sql).all(...params) as HypothesisEvalDbRow[];
    return rows.map(mapEvalRow);
  }

  /**
   * Retrieve a hypothesis evaluation with linked walk-forward run and
   * winner snapshots. Returns null when the evaluation does not exist.
   */
  getEvaluationWithLinked(id: number): HypothesisEvaluationWithLinked | null {
    const evalRow = this.getEvaluationById(id);
    if (!evalRow) {
      return null;
    }

    let walkForwardRun: HypothesisEvaluationWithLinked['walkForwardRun'] = null;
    let winner: HypothesisEvaluationWithLinked['winner'] = null;

    if (evalRow.walkForwardRunId != null) {
      const run = this._db.prepare(`
        SELECT id, label, status, window_count, total_trials
        FROM walk_forward_runs
        WHERE id = ?
      `).get(evalRow.walkForwardRunId) as {
        id: number; label: string; status: string;
        window_count: number; total_trials: number;
      } | undefined;

      if (run) {
        walkForwardRun = {
          id: run.id,
          label: run.label,
          status: run.status,
          windowCount: run.window_count,
          totalTrials: run.total_trials,
        };
      }
    }

    if (evalRow.winnerId != null) {
      const w = this._db.prepare(`
        SELECT id, result, selected_trial_id, selection_strategy, rationale
        FROM walk_forward_winners
        WHERE id = ?
      `).get(evalRow.winnerId) as {
        id: number; result: string; selected_trial_id: number | null;
        selection_strategy: string; rationale: string;
      } | undefined;

      if (w) {
        winner = {
          id: w.id,
          result: w.result,
          selectedTrialId: w.selected_trial_id,
          selectionStrategy: w.selection_strategy,
          rationale: w.rationale,
        };
      }
    }

    return { evaluation: evalRow, walkForwardRun, winner };
  }

  /** Count total hypothesis evaluations. */
  countEvaluations(): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM hypothesis_evaluations',
    ).get() as { cnt: number };
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Research artifact CRUD
  // -----------------------------------------------------------------------

  /** Insert a research artifact row. */
  insertResearchArtifact(input: NewResearchArtifact): ResearchArtifactRow {
    const now = input.createdAt ?? Date.now();

    const result = this._db.prepare(`
      INSERT INTO research_artifacts
        (hypothesis_evaluation_id, artifact_type, format, file_path, label, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.hypothesisEvaluationId,
      input.artifactType,
      input.format,
      input.filePath,
      input.label,
      now,
    );

    return this.getResearchArtifactById(Number(result.lastInsertRowid))!;
  }

  /** Retrieve a research artifact by id. */
  getResearchArtifactById(id: number): ResearchArtifactRow | null {
    const row = this._db.prepare(`
      SELECT * FROM research_artifacts WHERE id = ?
    `).get(id) as ResearchArtifactDbRow | undefined;

    return row ? mapArtifactRow(row) : null;
  }

  /** Retrieve all artifacts linked to a hypothesis evaluation, oldest first. */
  getResearchArtifactsByEvaluationId(hypothesisEvaluationId: number): ResearchArtifactRow[] {
    const rows = this._db.prepare(`
      SELECT *
      FROM research_artifacts
      WHERE hypothesis_evaluation_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(hypothesisEvaluationId) as ResearchArtifactDbRow[];

    return rows.map(mapArtifactRow);
  }

  /** Count total research artifacts. */
  countResearchArtifacts(): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM research_artifacts',
    ).get() as { cnt: number };
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Research publication CRUD (M011/S03 — governed publish-back handoff)
  // -----------------------------------------------------------------------

  /** Insert a research publication row. */
  insertPublication(input: NewResearchPublication): ResearchPublicationRow {
    const now = input.createdAt ?? Date.now();

    const result = this._db.prepare(`
      INSERT INTO research_publications
        (hypothesis_evaluation_id, hypothesis_graph_id, status,
         strategy_id, strategy_version, market_id, rationale,
         evidence_json, lifecycle_state_id, governance_decision_id,
         published_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.hypothesisEvaluationId,
      input.hypothesisGraphId,
      input.status,
      input.strategyId,
      input.strategyVersion,
      input.marketId,
      input.rationale,
      input.evidenceJson,
      input.lifecycleStateId,
      input.governanceDecisionId,
      input.publishedAt,
      now,
    );

    return this.getPublicationById(Number(result.lastInsertRowid))!;
  }

  /** Retrieve a research publication by id. */
  getPublicationById(id: number): ResearchPublicationRow | null {
    const row = this._db.prepare(`
      SELECT * FROM research_publications WHERE id = ?
    `).get(id) as ResearchPublicationDbRow | undefined;

    return row ? mapPublicationRow(row) : null;
  }

  /**
   * Retrieve the publication for a hypothesis evaluation.
   * Returns null when the evaluation has not been published.
   * Used for idempotency checks in the publish-back service.
   */
  getPublicationByEvaluationId(hypothesisEvaluationId: number): ResearchPublicationRow | null {
    const row = this._db.prepare(`
      SELECT * FROM research_publications WHERE hypothesis_evaluation_id = ?
    `).get(hypothesisEvaluationId) as ResearchPublicationDbRow | undefined;

    return row ? mapPublicationRow(row) : null;
  }

  /** Retrieve recent research publications, newest first. */
  getRecentPublications(
    limit = 50,
    status?: string,
  ): ResearchPublicationRow[] {
    let sql: string;
    let params: unknown[];

    if (status !== undefined) {
      sql = `
        SELECT *
        FROM research_publications
        WHERE status = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
      params = [status, limit];
    } else {
      sql = `
        SELECT *
        FROM research_publications
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
      params = [limit];
    }

    const rows = this._db.prepare(sql).all(...params) as ResearchPublicationDbRow[];
    return rows.map(mapPublicationRow);
  }

  /** Update publication status and linkage fields. */
  updatePublication(
    id: number,
    fields: {
      status?: string;
      lifecycleStateId?: number | null;
      governanceDecisionId?: number | null;
      publishedAt?: number | null;
      rationale?: string;
      evidenceJson?: string;
    },
  ): ResearchPublicationRow | null {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (fields.status !== undefined) {
      sets.push('status = ?');
      params.push(fields.status);
    }
    if (fields.lifecycleStateId !== undefined) {
      sets.push('lifecycle_state_id = ?');
      params.push(fields.lifecycleStateId);
    }
    if (fields.governanceDecisionId !== undefined) {
      sets.push('governance_decision_id = ?');
      params.push(fields.governanceDecisionId);
    }
    if (fields.publishedAt !== undefined) {
      sets.push('published_at = ?');
      params.push(fields.publishedAt);
    }
    if (fields.rationale !== undefined) {
      sets.push('rationale = ?');
      params.push(fields.rationale);
    }
    if (fields.evidenceJson !== undefined) {
      sets.push('evidence_json = ?');
      params.push(fields.evidenceJson);
    }

    if (sets.length === 0) {
      return this.getPublicationById(id);
    }

    params.push(id);

    const result = this._db.prepare(
      `UPDATE research_publications SET ${sets.join(', ')} WHERE id = ?`,
    ).run(...params);

    if (result.changes === 0) {
      return null;
    }

    return this.getPublicationById(id);
  }

  /** Count total research publications. */
  countPublications(): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM research_publications',
    ).get() as { cnt: number };
    return row.cnt;
  }
}

interface HypothesisDbRow {
  id: number;
  canonical_hash: string;
  canonical_json: string;
  status: string;
  schema_version: string;
  signals_json: string;
  filters_json: string;
  entry_rules_json: string;
  exit_rules_json: string;
  risk_rules_json: string;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface HypothesisEvalDbRow {
  id: number;
  hypothesis_graph_id: number;
  walk_forward_run_id: number | null;
  status: string;
  winner_id: number | null;
  rationale: string;
  outcome_detail: string;
  created_at: number;
  updated_at: number;
}

interface ResearchArtifactDbRow {
  id: number;
  hypothesis_evaluation_id: number;
  artifact_type: string;
  format: string;
  file_path: string;
  label: string;
  created_at: number;
}

interface ResearchPublicationDbRow {
  id: number;
  hypothesis_evaluation_id: number;
  hypothesis_graph_id: number;
  status: string;
  strategy_id: string;
  strategy_version: string;
  market_id: string;
  rationale: string;
  evidence_json: string;
  lifecycle_state_id: number | null;
  governance_decision_id: number | null;
  published_at: number | null;
  created_at: number;
}

function mapHypothesisRow(row: HypothesisDbRow): HypothesisGraphRow {
  const graph: HypothesisGraph = {
    schemaVersion: row.schema_version,
    signals: JSON.parse(row.signals_json) as HypothesisGraph['signals'],
    filters: JSON.parse(row.filters_json) as HypothesisGraph['filters'],
    entryRules: JSON.parse(row.entry_rules_json) as HypothesisGraph['entryRules'],
    exitRules: JSON.parse(row.exit_rules_json) as HypothesisGraph['exitRules'],
    riskRules: JSON.parse(row.risk_rules_json) as HypothesisGraph['riskRules'],
    ...(row.metadata_json == null
      ? {}
      : { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> }),
  };

  return {
    id: row.id,
    canonicalHash: row.canonical_hash,
    canonicalJson: row.canonical_json,
    status: row.status as HypothesisStatus,
    graph,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvalRow(row: HypothesisEvalDbRow): HypothesisEvaluationRow {
  return {
    id: row.id,
    hypothesisGraphId: row.hypothesis_graph_id,
    walkForwardRunId: row.walk_forward_run_id,
    status: row.status as HypothesisEvaluationStatus,
    winnerId: row.winner_id,
    rationale: row.rationale,
    outcomeDetail: row.outcome_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapArtifactRow(row: ResearchArtifactDbRow): ResearchArtifactRow {
  return {
    id: row.id,
    hypothesisEvaluationId: row.hypothesis_evaluation_id,
    artifactType: row.artifact_type as ResearchArtifactType,
    format: row.format as ResearchArtifactFormat,
    filePath: row.file_path,
    label: row.label,
    createdAt: row.created_at,
  };
}

function mapPublicationRow(row: ResearchPublicationDbRow): ResearchPublicationRow {
  return {
    id: row.id,
    hypothesisEvaluationId: row.hypothesis_evaluation_id,
    hypothesisGraphId: row.hypothesis_graph_id,
    status: row.status as ResearchPublicationRow['status'],
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    marketId: row.market_id,
    rationale: row.rationale,
    evidenceJson: row.evidence_json,
    lifecycleStateId: row.lifecycle_state_id,
    governanceDecisionId: row.governance_decision_id,
    publishedAt: row.published_at,
    createdAt: row.created_at,
  };
}
