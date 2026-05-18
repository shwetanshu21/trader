// ── Artifact Emitter ──
// Writes stable JSON artifacts under data/artifacts/walk-forward/<run-id>/
// containing winner selection details, aggregate diagnostics, per-window
// evidence, and proof-fidelity fields derived from provider/evaluator contracts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  WalkForwardSelectionResult,
  WalkForwardWindowType,
  type WalkForwardRunRow,
  type WalkForwardRankedCandidate,
  type WalkForwardSelectionConfig,
  type WalkForwardSelectionOutput,
  type WalkForwardCandidateComparison,
  type WalkForwardWinnerArtifact,
  type WalkForwardDiagnosticsArtifact,
  type WalkForwardTradeLogArtifact,
} from './walk-forward-types.js';
import type { HistoricalDataProvider } from './historical-data-provider.js';
import { ReplayFidelity, type ReplayTick } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Root directory for walk-forward artifacts. */
const ARTIFACTS_ROOT = 'data/artifacts/walk-forward';

// ---------------------------------------------------------------------------
// ArtifactEmitter
// ---------------------------------------------------------------------------

export class ArtifactEmitter {
  private readonly _dataProvider: HistoricalDataProvider;

  constructor(options: {
    dataProvider: HistoricalDataProvider;
  }) {
    this._dataProvider = options.dataProvider;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Emit all artifacts for a winner-selection decision.
   *
   * Writes three JSON files:
   *   1. winner.json — selection decision with rationale and comparisons.
   *   2. diagnostics.json — aggregate metrics, ranked candidates, evidence.
   *   3. trade-log.json — standalone compact trade-log evidence.
   *
   * @returns Object containing paths to the emitted artifacts.
   */
  emitWinnerArtifacts(options: {
    run: WalkForwardRunRow;
    selection: WalkForwardSelectionOutput;
    selectionConfig: WalkForwardSelectionConfig;
    rankedCandidates: WalkForwardRankedCandidate[];
    aggregateMetrics: WalkForwardDiagnosticsArtifact['aggregateMetrics'];
    tradeLog: WalkForwardDiagnosticsArtifact['tradeLog'];
    dataProvider: HistoricalDataProvider;
    windowCount: number;
    trialCount: number;
    oosWindowCount: number;
    selectedAt: number;
    /** Start of the historical data range evaluated (ms). When provided, used for hasData check instead of wall-clock timestamps. */
    dataRangeStart?: number;
    /** End of the historical data range evaluated (ms). When provided, used for hasData check instead of wall-clock timestamps. */
    dataRangeEnd?: number;
  }): { winnerPath: string; diagnosticsPath: string; tradeLogPath: string } {
    const artifactDir = this._ensureArtifactDir(options.run.id);

    const winnerPath = path.join(artifactDir, 'winner.json');
    const diagnosticsPath = path.join(artifactDir, 'diagnostics.json');
    const tradeLogPath = path.join(artifactDir, 'trade-log.json');

    // Build winner artifact
    const winnerArtifact = this._buildWinnerArtifact(options);
    this._writeJSON(winnerPath, winnerArtifact);

    // Build diagnostics artifact
    const diagnosticsArtifact = this._buildDiagnosticsArtifact(options);
    this._writeJSON(diagnosticsPath, diagnosticsArtifact);

    // Build standalone trade-log artifact
    const tradeLogArtifact = this._buildTradeLogArtifact(options);
    this._writeJSON(tradeLogPath, tradeLogArtifact);

    return { winnerPath, diagnosticsPath, tradeLogPath };
  }

  // -----------------------------------------------------------------------
  // Winner artifact builder
  // -----------------------------------------------------------------------

  /**
   * Build the winner selection artifact.
   */
  private _buildWinnerArtifact(options: {
    run: WalkForwardRunRow;
    selection: WalkForwardSelectionOutput;
    selectionConfig: WalkForwardSelectionConfig;
    rankedCandidates: WalkForwardRankedCandidate[];
    selectedAt: number;
  }): WalkForwardWinnerArtifact {
    const { run, selection, selectionConfig, selectedAt } = options;

    // Find the winning candidate details
    const winningCandidate = selection.selectedTrialId != null
      ? options.rankedCandidates.find(c => c.trialId === selection.selectedTrialId) ?? null
      : null;

    return {
      schemaVersion: 1,
      artifactType: 'winner-selection',
      runId: run.id,
      runLabel: run.label,
      selectionTimestamp: new Date(selectedAt).toISOString(),
      selectionConfig,
      result: selection.result,
      winner: winningCandidate
        ? {
            trialId: winningCandidate.trialId,
            trialLabel: winningCandidate.label,
            paramsJson: winningCandidate.paramsJson,
            mergedScore: winningCandidate.mergedScore,
            deterministicScore: winningCandidate.deterministicScore,
            llmScore: winningCandidate.llmScore,
          }
        : null,
      rationale: selection.rationale,
      comparisons: selection.comparisons,
    };
  }

  // -----------------------------------------------------------------------
  // Diagnostics artifact builder
  // -----------------------------------------------------------------------

  /**
   * Build the diagnostics artifact.
   */
  private _buildDiagnosticsArtifact(options: {
    run: WalkForwardRunRow;
    selection: WalkForwardSelectionOutput;
    rankedCandidates: WalkForwardRankedCandidate[];
    aggregateMetrics: WalkForwardDiagnosticsArtifact['aggregateMetrics'];
    tradeLog: WalkForwardDiagnosticsArtifact['tradeLog'];
    dataProvider: HistoricalDataProvider;
    windowCount: number;
    trialCount: number;
    oosWindowCount: number;
    selectedAt: number;
    dataRangeStart?: number;
    dataRangeEnd?: number;
  }): WalkForwardDiagnosticsArtifact {
    const {
      run, selection, rankedCandidates, aggregateMetrics, tradeLog,
      dataProvider, windowCount, trialCount, oosWindowCount, selectedAt,
    } = options;

    // Determine effective fidelity from the provider
    const effectiveFidelity = this._getEffectiveFidelityLabel(dataProvider);
    const resolution = dataProvider.getResolutionMetadata?.() ?? {
      screeningCadenceMinutes: null,
      executionResolutionMinutes: null,
      supportsFineGrainedExecution: false,
    };

    return {
      schemaVersion: 1,
      artifactType: 'winner-diagnostics',
      runId: run.id,
      runLabel: run.label,
      generatedAt: new Date(selectedAt).toISOString(),
      selection: {
        result: selection.result,
        rationale: selection.rationale,
        comparisonsCount: selection.comparisons.length,
      },
      aggregateMetrics,
      rankedCandidates: rankedCandidates.map(c => ({
        trialId: c.trialId,
        rank: c.rank,
        label: c.label,
        paramsJson: c.paramsJson,
        mergedScore: c.mergedScore,
        deterministicScore: c.deterministicScore,
        llmScore: c.llmScore,
        llmStatus: c.llmStatus,
        windowCount: c.windowCount,
      })),
      tradeLog,
      evidenceFidelity: {
        providerLabel: dataProvider.label,
        effectiveFidelity,
        hasData: dataProvider.hasData(
          options.dataRangeStart ?? run.createdAt,
          options.dataRangeEnd ?? (run.completedAt ?? Date.now()),
        ),
        windowCount,
        trialCount,
        outOfSampleWindows: oosWindowCount,
        screeningCadenceMinutes: resolution.screeningCadenceMinutes,
        executionResolutionMinutes: resolution.executionResolutionMinutes,
        supportsFineGrainedExecution: resolution.supportsFineGrainedExecution,
      },
    };
  }

  /**
   * Build the standalone trade-log artifact.
   */
  private _buildTradeLogArtifact(options: {
    run: WalkForwardRunRow;
    tradeLog: WalkForwardDiagnosticsArtifact['tradeLog'];
    selectedAt: number;
  }): WalkForwardTradeLogArtifact {
    return {
      schemaVersion: 1,
      artifactType: 'trade-log',
      runId: options.run.id,
      runLabel: options.run.label,
      generatedAt: new Date(options.selectedAt).toISOString(),
      entries: options.tradeLog,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Ensure the artifact directory exists for a given run.
   * Creates parent directories as needed.
   */
  private _ensureArtifactDir(runId: number): string {
    const dir = path.join(ARTIFACTS_ROOT, String(runId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Write a JSON object to a file with pretty-printing.
   */
  private _writeJSON(filePath: string, data: unknown): void {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, json, 'utf-8');
  }

  /**
   * Get the effective fidelity from the data provider.
   *
   * Consults the provider's getEffectiveFidelity with a minimal tick to
   * surface the actual fidelity level (full, synthetic, approximate) rather
   * than a human-readable label.
   */
  private _getEffectiveFidelityLabel(provider: HistoricalDataProvider): string {
    // Create a minimal tick to query the provider's characteristic fidelity
    const tick: ReplayTick = {
      index: 0,
      timestamp: Date.now(),
      fidelity: ReplayFidelity.Synthetic,
    };
    return provider.getEffectiveFidelity(tick);
  }
}
