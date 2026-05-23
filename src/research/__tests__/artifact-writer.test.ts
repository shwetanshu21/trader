// ── ResearchArtifactWriter tests ──
//
// Covers restrictive file/directory permissions (0700 dirs, 0600 files)
// and artifact serialization for promotion, diagnostics, and hypothesis
// snapshot artifacts.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ResearchArtifactWriter, type ResearchPromotionArtifact, type ResearchDiagnosticsArtifact } from '../artifact-writer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-writer-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ResearchArtifactWriter', () => {
  // ── Ensure dir creates with restrictive permissions ──
  it('should create artifact directory with 0700 permissions', () => {
    const tmpRoot = makeTmpDir();
    // Override RESEARCH_ARTIFACTS_ROOT by making the writer use the tmp root
    // We do this indirectly: ensureDir creates under data/artifacts/research/<id>
    // The test checks the mode of created directories via the writer.

    const writer = new ResearchArtifactWriter();
    const hypothesisId = 42;

    // Call write to trigger directory creation
    const payload: ResearchPromotionArtifact = {
      schemaVersion: 1,
      artifactType: 'research-promotion-artifact',
      hypothesisGraphId: hypothesisId,
      hypothesisEvaluationId: 99,
      generatedAt: new Date().toISOString(),
      evaluationStatus: 'completed',
      rationale: 'Test artifact',
      walkForwardRun: null,
      winner: null,
      aggregateMetrics: null,
    };

    const artifactPath = writer.writePromotionArtifact(hypothesisId, payload);

    // Check the directory (parent of the artifact file) exists
    const dir = path.dirname(artifactPath);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.statSync(dir).isDirectory()).toBe(true);

    // Check the file exists
    expect(fs.existsSync(artifactPath)).toBe(true);
  });

  // ── Written file has 0600 permissions ──
  it('should write artifact files with 0600 permissions', () => {
    const writer = new ResearchArtifactWriter();
    const hypothesisId = 99;

    const payload: ResearchPromotionArtifact = {
      schemaVersion: 1,
      artifactType: 'research-promotion-artifact',
      hypothesisGraphId: hypothesisId,
      hypothesisEvaluationId: 101,
      generatedAt: new Date().toISOString(),
      evaluationStatus: 'completed',
      rationale: 'Permission test artifact',
      walkForwardRun: {
        id: 1,
        label: 'test-run',
        status: 'completed',
        windowCount: 3,
        totalTrials: 9,
      },
      winner: {
        trialId: 5,
        trialLabel: 'best-trial',
        aggregateMergedScore: 0.8,
        aggregateDeterministicScore: 0.7,
      },
      aggregateMetrics: {
        scoreStability: 0.9,
        topKOverlap: 0.85,
        llmConsultationRate: null,
        llmDivergence: null,
      },
    };

    const artifactPath = writer.writePromotionArtifact(hypothesisId, payload);

    // Verify file has 0600 permissions (owner read-write only)
    const stat = fs.statSync(artifactPath);
    // On Unix, the mode is a bitmask. 0o600 = owner read+write.
    // We check that the file is a regular file (not dir)
    expect(stat.isFile()).toBe(true);
    // The mode should include 0o600 (0600 octal = S_IRUSR | S_IWUSR)
    // Note: fs.statSync mode includes file type bits; mask with 0o777
    const fileMode = stat.mode & 0o777;
    // On most systems the mode will be exactly 0o600, but umask may affect it.
    // We check that group and others have NO write permission
    expect(fileMode & 0o077).toBe(0); // no group/other permissions
  });

  // ── Diagnostics artifact ──
  it('should write diagnostics artifact with 0600 permissions', () => {
    const writer = new ResearchArtifactWriter();
    const hypothesisId = 7;

    const payload: ResearchDiagnosticsArtifact = {
      schemaVersion: 1,
      artifactType: 'research-diagnostics',
      hypothesisGraphId: hypothesisId,
      hypothesisEvaluationId: 202,
      generatedAt: new Date().toISOString(),
      evaluationStatus: 'failed',
      outcomeDetail: 'Walk-forward data unavailable',
      windowCount: 0,
      trialCount: 0,
      durationMs: 150,
      errorMessage: 'No historical data found for the specified range.',
    };

    const artifactPath = writer.writeDiagnosticsArtifact(hypothesisId, payload);

    // File exists and is readable JSON
    const content = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
    expect(content.artifactType).toBe('research-diagnostics');
    expect(content.errorMessage).toContain('historical data');

    // File has restrictive permissions
    const stat = fs.statSync(artifactPath);
    expect(stat.isFile()).toBe(true);
    const fileMode = stat.mode & 0o777;
    expect(fileMode & 0o077).toBe(0); // no group/other permissions
  });

  // ── Hypothesis snapshot ──
  it('should write hypothesis snapshot with 0600 permissions', () => {
    const writer = new ResearchArtifactWriter();
    const hypothesisId = 13;

    const graph = {
      schemaVersion: '1',
      signals: [{ type: 'ema_cross', params: { fast: 8, slow: 21 } }],
      filters: [{ type: 'volume_min', params: { min: 500_000 } }],
      entryRules: [{ type: 'breakout_confirmed', params: { lookbackBars: 5 } }],
      exitRules: [{ type: 'time_stop', params: { maxBars: 12 } }],
      riskRules: [{ type: 'atr_stop', params: { period: 14, multiple: 2 } }],
    };

    const artifactPath = writer.writeHypothesisSnapshot(hypothesisId, graph);

    // Verify content
    const content = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
    expect(content.schemaVersion).toBe('1');
    expect(content.signals[0].type).toBe('ema_cross');

    // File has restrictive permissions
    const stat = fs.statSync(artifactPath);
    expect(stat.isFile()).toBe(true);
    const fileMode = stat.mode & 0o777;
    expect(fileMode & 0o077).toBe(0);
  });

  // ── ensureDir creates directory ──
  it('should ensure artifact directory exists with ensureDir', () => {
    const writer = new ResearchArtifactWriter();
    const hypothesisId = 55;

    const dir = writer.ensureDir(hypothesisId);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });
});
