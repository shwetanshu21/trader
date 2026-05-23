// ── M011/S04 — Research Proof Harness Test ──
// Executes the standalone proof entrypoint and asserts the durable artifact
// shape: verdict, assertion counts, duplicate-skip evidence, publication
// linkage, and artifact enumeration.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACT_DIR = 'data/artifacts/research-proof';

function newestProofArtifact(): string | null {
  if (!fs.existsSync(ARTIFACT_DIR)) return null;
  const files = fs.readdirSync(ARTIFACT_DIR)
    .filter(f => f.startsWith('research-proof-') && f.endsWith('.json'))
    .map(f => ({ f, t: fs.statSync(path.join(ARTIFACT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0] ? path.join(ARTIFACT_DIR, files[0].f) : null;
}

describe('verify-m011-s04-research-proof', () => {
  it('passes end to end and writes a passing artifact with full lineage evidence', () => {
    // Execute the standalone proof harness
    execFileSync('node', [
      '--import', 'tsx',
      'src/deployment/verify-m011-s04-research-proof.ts',
    ], { stdio: 'pipe' });

    // Find the artifact written by the latest run
    const artifact = newestProofArtifact();
    expect(artifact).toBeTruthy();

    const json = JSON.parse(fs.readFileSync(artifact!, 'utf-8'));
    expect(json.harness).toBe('M011/S04 Research Proof Harness');
    expect(json.verdict).toBe('PASS');
    expect(json.failed).toBe(0);
    expect(json.totalAssertions).toBeGreaterThan(0);

    // Verify both branches were tested
    expect(json.branchesTested).toContain('duplicate-skip (exact-failure ledger -> validator -> skipped)');
    expect(json.branchesTested).toContain('publish-success (validate -> evaluate -> publish -> audit lineage)');

    // Verify duplicate-skip evidence
    expect(json.evidenceBlocks.duplicateSkip.validatorReturnedSkipped).toBe(true);
    expect(json.evidenceBlocks.duplicateSkip.noHypothesisPersisted).toBe(true);

    // Verify publish-success evidence
    expect(json.evidenceBlocks.publishSuccess.publishVerdict).toBe('publish');
    expect(json.evidenceBlocks.publishSuccess.publicationId).toBeGreaterThan(0);
    expect(json.evidenceBlocks.publishSuccess.lifecycleStateId).toBeGreaterThan(0);
    expect(json.evidenceBlocks.publishSuccess.governanceDecisionId).toBeGreaterThan(0);

    // Verify lineage coverage — all segments should be present
    const coverage = json.evidenceBlocks.publishSuccess.lineageCoverage;
    expect(coverage.hypothesisPresent).toBe(true);
    expect(coverage.evaluationPresent).toBe(true);
    expect(coverage.artifactsPresent).toBe(true);
    expect(coverage.publicationPresent).toBe(true);
    expect(coverage.lifecyclePresent).toBe(true);
    expect(coverage.governancePresent).toBe(true);

    // Verify assertion detail — all individual assertions should be present
    expect(json.assertions.length).toBe(json.totalAssertions);
    const failedAssertions = json.assertions.filter((a: any) => !a.pass);
    expect(failedAssertions.length).toBe(0);
  });
});
