import type Database from 'better-sqlite3';

import {
  GenerationVerdict,
  type GenerationReason,
  type GenerationReasonCode,
  type GenerationContextProvenance,
  type HypothesisGenerationAttemptRow,
  type HypothesisGenerationAttemptWithReasons,
  type NewHypothesisGenerationAttempt,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// HypothesisGenerationRepository — typed CRUD over generation-attempt
// evidence for LLM provider invocations.
//
// One row per provider invocation. Accepted rows carry downstream linkage
// (canonicalHash, hypothesisGraphId, hypothesisEvaluationId); rejected/skipped
// rows carry null linkage and a non-empty reasons array.
// ---------------------------------------------------------------------------

export class HypothesisGenerationRepository {
  private readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
  }

  /**
   * Insert a generation attempt row.
   *
   * Returns the full row including the assigned id. Reasons are stored
   * as child rows in hypothesis_generation_reasons.
   */
  insertAttempt(
    attempt: NewHypothesisGenerationAttempt,
  ): HypothesisGenerationAttemptRow {
    const stmt = this._db.prepare(`
      INSERT INTO hypothesis_generation_attempts
        (verdict,
         provider_url, provider_model, prompt_version, triggered_at,
         market_id, strategy_id,
         raw_provider_output, raw_output_content_hash, raw_output_preview,
         canonical_hash,
         hypothesis_graph_id, hypothesis_evaluation_id,
         created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      attempt.verdict,
      attempt.contextProvenance.providerUrl,
      attempt.contextProvenance.providerModel,
      attempt.contextProvenance.promptVersion,
      attempt.contextProvenance.triggeredAt,
      attempt.contextProvenance.marketId,
      attempt.contextProvenance.strategyId,
      attempt.rawProviderOutput,
      attempt.rawOutputContentHash ?? null,
      attempt.rawOutputPreview ?? null,
      attempt.canonicalHash,
      attempt.hypothesisGraphId,
      attempt.hypothesisEvaluationId,
      attempt.createdAt,
    );

    return {
      id: Number(result.lastInsertRowid),
      ...attempt,
    };
  }

  /**
   * Insert a generation attempt with its reasons in a single transaction.
   * Returns the full attempt row including the assigned id.
   */
  insertAttemptWithReasons(
    attempt: NewHypothesisGenerationAttempt,
    reasons: GenerationReason[],
  ): HypothesisGenerationAttemptWithReasons {
    const tx = this._db.transaction(() => {
      const row = this.insertAttempt(attempt);
      for (const reason of reasons) {
        this._insertReason(row.id, reason);
      }
      return row;
    });

    const row = tx();
    return { ...row, reasons };
  }

  /** Retrieve a generation attempt by id. */
  getById(id: number): HypothesisGenerationAttemptRow | null {
    const row = this._db.prepare(`
      SELECT * FROM hypothesis_generation_attempts WHERE id = ?
    `).get(id) as GenerationAttemptDbRow | undefined;

    return row ? mapAttemptRow(row) : null;
  }

  /** Retrieve a generation attempt with its reasons loaded. */
  getByIdWithReasons(id: number): HypothesisGenerationAttemptWithReasons | null {
    const row = this.getById(id);
    if (!row) {
      return null;
    }

    return {
      ...row,
      reasons: this.getReasons(row.id),
    };
  }

  /** Retrieve recent generation attempts, newest first. */
  getRecent(limit = 50): HypothesisGenerationAttemptRow[] {
    const rows = this._db.prepare(`
      SELECT * FROM hypothesis_generation_attempts
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(limit) as GenerationAttemptDbRow[];

    return rows.map(mapAttemptRow);
  }

  /** Retrieve recent generation attempts with reasons loaded, newest first. */
  getRecentWithReasons(limit = 50): HypothesisGenerationAttemptWithReasons[] {
    return this.getRecent(limit).map(row => ({
      ...row,
      reasons: this.getReasons(row.id),
    }));
  }

  /** Retrieve recent generation attempts by verdict, newest first. */
  getByVerdict(
    verdict: GenerationVerdict,
    limit = 50,
  ): HypothesisGenerationAttemptRow[] {
    const rows = this._db.prepare(`
      SELECT * FROM hypothesis_generation_attempts
      WHERE verdict = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(verdict, limit) as GenerationAttemptDbRow[];

    return rows.map(mapAttemptRow);
  }

  /**
   * Retrieve the most recent accepted generation attempt for a canonical hash.
   * Returns null when no accepted attempt exists for this hash.
   *
   * Used by the generation service to detect duplicate-skip scenarios where
   * an identical hypothesis graph was already generated and accepted in a
   * prior attempt.
   */
  getByCanonicalHash(canonicalHash: string): HypothesisGenerationAttemptRow | null {
    const row = this._db.prepare(`
      SELECT * FROM hypothesis_generation_attempts
      WHERE canonical_hash = ? AND verdict = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(canonicalHash, GenerationVerdict.Accepted) as GenerationAttemptDbRow | undefined;

    return row ? mapAttemptRow(row) : null;
  }

  /**
   * Retrieve the most recent generation attempt for a canonical hash,
   * regardless of verdict.
   *
   * Used by the audit service to find any generation attempt (accepted,
   * rejected, or skipped) that produced the given canonical hash.
   */
  getByCanonicalHashAnyVerdict(canonicalHash: string): HypothesisGenerationAttemptRow | null {
    const row = this._db.prepare(`
      SELECT * FROM hypothesis_generation_attempts
      WHERE canonical_hash = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(canonicalHash) as GenerationAttemptDbRow | undefined;

    return row ? mapAttemptRow(row) : null;
  }

  /**
   * Retrieve the generation attempt linked to a hypothesis graph row.
   * Returns null when the graph was not created via a generation attempt
   * (e.g. manually seeded).
   */
  getByHypothesisGraphId(hypothesisGraphId: number): HypothesisGenerationAttemptRow | null {
    const row = this._db.prepare(`
      SELECT * FROM hypothesis_generation_attempts
      WHERE hypothesis_graph_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(hypothesisGraphId) as GenerationAttemptDbRow | undefined;

    return row ? mapAttemptRow(row) : null;
  }

  /**
   * Update downstream linkage fields after a hypothesis graph is created
   * and evaluation is linked.
   *
   * Returns the updated row, or null when the attempt id does not exist.
   */
  updateLinkage(
    id: number,
    fields: {
      canonicalHash?: string;
      hypothesisGraphId?: number;
      hypothesisEvaluationId?: number | null;
    },
  ): HypothesisGenerationAttemptRow | null {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (fields.canonicalHash !== undefined) {
      sets.push('canonical_hash = ?');
      params.push(fields.canonicalHash);
    }
    if (fields.hypothesisGraphId !== undefined) {
      sets.push('hypothesis_graph_id = ?');
      params.push(fields.hypothesisGraphId);
    }
    if (fields.hypothesisEvaluationId !== undefined) {
      sets.push('hypothesis_evaluation_id = ?');
      params.push(fields.hypothesisEvaluationId);
    }

    if (sets.length === 0) {
      return this.getById(id);
    }

    params.push(id);

    const result = this._db.prepare(
      `UPDATE hypothesis_generation_attempts SET ${sets.join(', ')} WHERE id = ?`,
    ).run(...params);

    if (result.changes === 0) {
      return null;
    }

    return this.getById(id);
  }

  // -----------------------------------------------------------------------
  // Reasons
  // -----------------------------------------------------------------------

  /** Insert a single reason for a generation attempt. */
  private _insertReason(generationAttemptId: number, reason: GenerationReason): void {
    this._db.prepare(`
      INSERT INTO hypothesis_generation_reasons
        (generation_attempt_id, reason_code, reason_message)
      VALUES (?, ?, ?)
    `).run(generationAttemptId, reason.reasonCode, reason.reasonMessage);
  }

  /** Add a reason to an existing generation attempt. */
  addReason(generationAttemptId: number, reason: GenerationReason): void {
    this._insertReason(generationAttemptId, reason);
  }

  /** Retrieve reasons for a generation attempt, ordered by insertion. */
  getReasons(generationAttemptId: number): GenerationReason[] {
    const rows = this._db.prepare(`
      SELECT reason_code, reason_message
      FROM hypothesis_generation_reasons
      WHERE generation_attempt_id = ?
      ORDER BY id
    `).all(generationAttemptId) as Array<{ reason_code: string; reason_message: string }>;

    return rows.map(r => ({
      reasonCode: r.reason_code as GenerationReasonCode,
      reasonMessage: r.reason_message,
    }));
  }

  // -----------------------------------------------------------------------
  // Count methods
  // -----------------------------------------------------------------------

  /** Count total generation attempts. */
  count(): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM hypothesis_generation_attempts',
    ).get() as { cnt: number };
    return row.cnt;
  }

  /** Count generation attempts by verdict. */
  countByVerdict(verdict: GenerationVerdict): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM hypothesis_generation_attempts WHERE verdict = ?',
    ).get(verdict) as { cnt: number };
    return row.cnt;
  }

  /** Count total reason rows. */
  countReasons(): number {
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM hypothesis_generation_reasons',
    ).get() as { cnt: number };
    return row.cnt;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface GenerationAttemptDbRow {
  id: number;
  verdict: string;
  provider_url: string;
  provider_model: string | null;
  prompt_version: string | null;
  triggered_at: number;
  market_id: string;
  strategy_id: string | null;
  raw_provider_output: string | null;
  raw_output_content_hash: string | null;
  raw_output_preview: string | null;
  canonical_hash: string | null;
  hypothesis_graph_id: number | null;
  hypothesis_evaluation_id: number | null;
  created_at: number;
}

function mapAttemptRow(row: GenerationAttemptDbRow): HypothesisGenerationAttemptRow {
  const contextProvenance: GenerationContextProvenance = {
    providerUrl: row.provider_url,
    providerModel: row.provider_model,
    promptVersion: row.prompt_version,
    triggeredAt: row.triggered_at,
    marketId: row.market_id,
    strategyId: row.strategy_id,
  };

  return {
    id: row.id,
    verdict: row.verdict as GenerationVerdict,
    contextProvenance,
    rawProviderOutput: row.raw_provider_output,
    rawOutputContentHash: row.raw_output_content_hash,
    rawOutputPreview: row.raw_output_preview,
    canonicalHash: row.canonical_hash,
    hypothesisGraphId: row.hypothesis_graph_id,
    hypothesisEvaluationId: row.hypothesis_evaluation_id,
    createdAt: row.created_at,
  };
}
