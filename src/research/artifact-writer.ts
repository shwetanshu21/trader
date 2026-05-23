// ── Research Artifact Writer ──
// Minimal helper for writing hypothesis-centric research artifacts to disk
// under data/artifacts/research/<hypothesis-id>/.
//
// Research artifacts are promotion-ready, hypothesis-centric outputs that
// carry evaluation evidence, winner selection details, and the hypothesis
// graph snapshot so downstream promotion governance can inspect the full
// research path without reconstructing it from database rows or walk-forward
// artifact directories.

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Root directory for research artifacts. */
const RESEARCH_ARTIFACTS_ROOT = path.join('data', 'artifacts', 'research');

// ---------------------------------------------------------------------------
// Research artifact content shapes
// ---------------------------------------------------------------------------

/** Schema version for research artifacts. */
export type ResearchArtifactSchemaVersion = 1;

/** Promotion-ready research artifact written after a successful hypothesis evaluation. */
export interface ResearchPromotionArtifact {
  schemaVersion: ResearchArtifactSchemaVersion;
  artifactType: 'research-promotion-artifact';
  /** FK → hypothesis_graphs(id). */
  hypothesisGraphId: number;
  /** FK → hypothesis_evaluations(id). */
  hypothesisEvaluationId: number;
  /** ISO-8601 timestamp of artifact generation. */
  generatedAt: string;
  /** Final evaluation status. */
  evaluationStatus: string;
  /** Evaluation rationale summary. */
  rationale: string;
  /** Walk-forward run reference, or null when unavailable. */
  walkForwardRun: {
    id: number;
    label: string;
    status: string;
    windowCount: number;
    totalTrials: number;
  } | null;
  /** Winner selection details, or null for no-winner/failed outcomes. */
  winner: {
    trialId: number;
    trialLabel: string;
    aggregateMergedScore: number;
    aggregateDeterministicScore: number;
  } | null;
  /** Aggregate walk-forward metrics. */
  aggregateMetrics: {
    scoreStability: number;
    topKOverlap: number;
    llmConsultationRate: number | null;
    llmDivergence: number | null;
  } | null;
}

/** Diagnostics artifact written alongside the promotion artifact for debugging. */
export interface ResearchDiagnosticsArtifact {
  schemaVersion: ResearchArtifactSchemaVersion;
  artifactType: 'research-diagnostics';
  hypothesisGraphId: number;
  hypothesisEvaluationId: number;
  generatedAt: string;
  evaluationStatus: string;
  outcomeDetail: string;
  /** Number of windows evaluated. */
  windowCount: number;
  /** Number of trials evaluated. */
  trialCount: number;
  /** Timing: total evaluation duration in ms. */
  durationMs: number;
  /** Error message, or null when evaluation succeeded. */
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// ArtifactWriter
// ---------------------------------------------------------------------------

export class ResearchArtifactWriter {
  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Ensure the artifact directory exists for a given hypothesis.
   * Creates parent directories as needed.
   */
  ensureDir(hypothesisGraphId: number): string {
    const dir = this._artifactDir(hypothesisGraphId);
    this._ensureRestrictiveDir(dir);
    return dir;
  }

  /**
   * Write a promotion-ready research artifact.
   *
   * @param hypothesisGraphId - FK into hypothesis_graphs.
   * @param payload - The promotion artifact content.
   * @returns The absolute path to the written file.
   */
  writePromotionArtifact(
    hypothesisGraphId: number,
    payload: ResearchPromotionArtifact,
  ): string {
    const dir = this._artifactDir(hypothesisGraphId);
    this._ensureRestrictiveDir(dir);
    const filePath = path.join(dir, 'promotion-artifact.json');
    this._writeJSON(filePath, payload);
    return filePath;
  }

  /**
   * Write a research diagnostics artifact.
   *
   * @param hypothesisGraphId - FK into hypothesis_graphs.
   * @param payload - The diagnostics artifact content.
   * @returns The absolute path to the written file.
   */
  writeDiagnosticsArtifact(
    hypothesisGraphId: number,
    payload: ResearchDiagnosticsArtifact,
  ): string {
    const dir = this._artifactDir(hypothesisGraphId);
    this._ensureRestrictiveDir(dir);
    const filePath = path.join(dir, 'diagnostics.json');
    this._writeJSON(filePath, payload);
    return filePath;
  }

  /**
   * Write a hypothesis graph snapshot as formatted JSON.
   *
   * @param hypothesisGraphId - FK into hypothesis_graphs.
   * @param graph - The hypothesis graph payload to snapshot.
   * @returns The absolute path to the written file.
   */
  writeHypothesisSnapshot(
    hypothesisGraphId: number,
    graph: Record<string, unknown>,
  ): string {
    const dir = this._artifactDir(hypothesisGraphId);
    this._ensureRestrictiveDir(dir);
    const filePath = path.join(dir, 'hypothesis.json');
    this._writeJSON(filePath, graph);
    return filePath;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Compute the artifact directory for a hypothesis.
   */
  private _artifactDir(hypothesisGraphId: number): string {
    return path.join(RESEARCH_ARTIFACTS_ROOT, String(hypothesisGraphId));
  }

  /**
   * Write a JSON object to a file with pretty-printing and restrictive permissions.
   * Files are created with 0600 (owner read-write only) to prevent accidental
   * exposure of research artifacts.
   */
  private _writeJSON(filePath: string, data: unknown): void {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, json, 'utf-8');
    fs.chmodSync(filePath, 0o600);
  }

  /**
   * Ensure the directory exists with restrictive owner-only permissions (0700).
   */
  private _ensureRestrictiveDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
