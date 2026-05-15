import type Database from 'better-sqlite3';
import {
  LLMStatus,
  MergePolicy,
  type HybridScoreSummaryRow,
  type HybridScoreComponentRow,
  type HybridScoreSummaryWithComponents,
  type NewHybridScoreSummary,
  type NewHybridScoreComponent,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// HybridScoreRepository — typed CRUD over hybrid_score_summary +
// hybrid_score_components tables, keyed by proposal_attempt_id.
//
// One summary row + N component rows per proposal attempt.
// Components are ordered by sort_order for deterministic round-tripping.
// ---------------------------------------------------------------------------

export class HybridScoreRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  /**
   * Insert a hybrid score summary row and return it with the assigned id.
   */
  insertSummary(summary: NewHybridScoreSummary): HybridScoreSummaryRow {
    const stmt = this._db.prepare(`
      INSERT INTO hybrid_score_summary
        (proposal_attempt_id, deterministic_score, llm_score, llm_status,
         llm_rationale, merged_score, merge_policy, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      summary.proposalAttemptId,
      summary.deterministicScore,
      summary.llmScore,
      summary.llmStatus,
      summary.llmRationale,
      summary.mergedScore,
      summary.mergePolicy,
      summary.createdAt,
    );

    return {
      id: Number(result.lastInsertRowid),
      proposalAttemptId: summary.proposalAttemptId,
      deterministicScore: summary.deterministicScore,
      llmScore: summary.llmScore,
      llmStatus: summary.llmStatus,
      llmRationale: summary.llmRationale,
      mergedScore: summary.mergedScore,
      mergePolicy: summary.mergePolicy,
      createdAt: summary.createdAt,
    };
  }

  /**
   * Insert a component row linked to a summary.
   */
  insertComponent(component: NewHybridScoreComponent): HybridScoreComponentRow {
    const stmt = this._db.prepare(`
      INSERT INTO hybrid_score_components
        (summary_id, component_name, score, weight, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      component.summaryId,
      component.componentName,
      component.score,
      component.weight,
      component.sortOrder,
    );

    return {
      id: Number(result.lastInsertRowid),
      summaryId: component.summaryId,
      componentName: component.componentName,
      score: component.score,
      weight: component.weight,
      sortOrder: component.sortOrder,
    };
  }

  /**
   * Insert a summary together with its component scores in a single transaction.
   * Returns the full summary row including assigned id and component rows.
   */
  insertFull(
    summary: NewHybridScoreSummary,
    components: NewHybridScoreComponent[],
  ): HybridScoreSummaryWithComponents {
    const tx = this._db.transaction(() => {
      const row = this.insertSummary(summary);
      const insertedComponents: HybridScoreComponentRow[] = [];
      for (const comp of components) {
        const inserted = this.insertComponent({ ...comp, summaryId: row.id });
        insertedComponents.push(inserted);
      }
      return { row, insertedComponents };
    });

    const { row, insertedComponents } = tx();

    return {
      ...row,
      components: insertedComponents,
    };
  }

  /**
   * Retrieve a hybrid score summary by proposal_attempt_id, with its
   * ordered component rows.
   */
  getByProposalAttemptId(proposalAttemptId: number): HybridScoreSummaryWithComponents | null {
    const row = this._db.prepare(`
      SELECT id, proposal_attempt_id, deterministic_score, llm_score, llm_status,
             llm_rationale, merged_score, merge_policy, created_at
      FROM hybrid_score_summary
      WHERE proposal_attempt_id = ?
    `).get(proposalAttemptId) as HybridScoreSummaryDbRow | undefined;

    if (!row) return null;

    const components = this._db.prepare(`
      SELECT id, summary_id, component_name, score, weight, sort_order
      FROM hybrid_score_components
      WHERE summary_id = ?
      ORDER BY sort_order ASC
    `).all(row.id) as HybridScoreComponentDbRow[];

    return {
      ...mapSummaryRow(row),
      components: components.map(mapComponentRow),
    };
  }

  /**
   * Retrieve hybrid score summaries by multiple proposal attempt ids.
   *
   * Batched lookup to avoid N+1 queries in the read model. Returns a Map
   * keyed by proposal_attempt_id for fast joining. Components are loaded
   * per summary via individual queries (bounded by the number of matched ids).
   */
  getByProposalAttemptIds(proposalAttemptIds: number[]): Map<number, HybridScoreSummaryWithComponents> {
    if (proposalAttemptIds.length === 0) return new Map();

    const placeholders = proposalAttemptIds.map(() => '?').join(',');
    const rows = this._db.prepare(`
      SELECT id, proposal_attempt_id, deterministic_score, llm_score, llm_status,
             llm_rationale, merged_score, merge_policy, created_at
      FROM hybrid_score_summary
      WHERE proposal_attempt_id IN (${placeholders})
    `).all(...proposalAttemptIds) as HybridScoreSummaryDbRow[];

    const result = new Map<number, HybridScoreSummaryWithComponents>();

    for (const row of rows) {
      const components = this._db.prepare(`
        SELECT id, summary_id, component_name, score, weight, sort_order
        FROM hybrid_score_components
        WHERE summary_id = ?
        ORDER BY sort_order ASC
      `).all(row.id) as HybridScoreComponentDbRow[];

      result.set(row.proposal_attempt_id, {
        ...mapSummaryRow(row),
        components: components.map(mapComponentRow),
      });
    }

    return result;
  }

  /**
   * Retrieve recent hybrid score summaries, newest first, with their
   * ordered component rows.
   */
  getRecent(limit = 50): HybridScoreSummaryWithComponents[] {
    const rows = this._db.prepare(`
      SELECT id, proposal_attempt_id, deterministic_score, llm_score, llm_status,
             llm_rationale, merged_score, merge_policy, created_at
      FROM hybrid_score_summary
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as HybridScoreSummaryDbRow[];

    return rows.map(row => {
      const components = this._db.prepare(`
        SELECT id, summary_id, component_name, score, weight, sort_order
        FROM hybrid_score_components
        WHERE summary_id = ?
        ORDER BY sort_order ASC
      `).all(row.id) as HybridScoreComponentDbRow[];

      return {
        ...mapSummaryRow(row),
        components: components.map(mapComponentRow),
      };
    });
  }

  /**
   * Count total summaries.
   */
  countSummaries(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM hybrid_score_summary').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Count total components.
   */
  countComponents(): number {
    const row = this._db.prepare('SELECT COUNT(*) AS cnt FROM hybrid_score_components').get() as { cnt: number };
    return row.cnt;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface HybridScoreSummaryDbRow {
  id: number;
  proposal_attempt_id: number;
  deterministic_score: number;
  llm_score: number | null;
  llm_status: string;
  llm_rationale: string | null;
  merged_score: number;
  merge_policy: string;
  created_at: number;
}

interface HybridScoreComponentDbRow {
  id: number;
  summary_id: number;
  component_name: string;
  score: number;
  weight: number;
  sort_order: number;
}

function mapSummaryRow(row: HybridScoreSummaryDbRow): HybridScoreSummaryRow {
  return {
    id: row.id,
    proposalAttemptId: row.proposal_attempt_id,
    deterministicScore: row.deterministic_score,
    llmScore: row.llm_score,
    llmStatus: row.llm_status as LLMStatus,
    llmRationale: row.llm_rationale,
    mergedScore: row.merged_score,
    mergePolicy: row.merge_policy as MergePolicy,
    createdAt: row.created_at,
  };
}

function mapComponentRow(row: HybridScoreComponentDbRow): HybridScoreComponentRow {
  return {
    id: row.id,
    summaryId: row.summary_id,
    componentName: row.component_name,
    score: row.score,
    weight: row.weight,
    sortOrder: row.sort_order,
  };
}
