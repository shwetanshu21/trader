// ── M011/S05 — Real-generation Proof Harness Test ──
// Executes the standalone S05 proof entrypoint and asserts the durable
// artifact shape: verdict, assertion counts, malformed evidence, skipped
// evidence, accepted evidence with hypothesis/evaluation linkage, and
// audit reconstruction.
//
// This test verifies that the proof harness exercises the REAL
// HypothesisGenerationService.generate() ingress (not seed helpers that
// bypass the service). The contextProvenance.providerUrl field is checked
// against PROOF_PROVIDER_CONFIG for each branch — if someone edits the
// harness to skip the service, this check catches it.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACT_DIR = 'data/artifacts/research-proof';

function newestProofArtifact(label: string): string | null {
  if (!fs.existsSync(ARTIFACT_DIR)) return null;
  const files = fs.readdirSync(ARTIFACT_DIR)
    .filter(f => f.startsWith(label) && f.endsWith('.json'))
    .map(f => ({ f, t: fs.statSync(path.join(ARTIFACT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0] ? path.join(ARTIFACT_DIR, files[0].f) : null;
}

describe('verify-m011-s05-real-generation-proof', () => {
  it('passes end to end through real HypothesisGenerationService.generate() ingress', () => {
    // Execute the standalone proof harness
    execFileSync('node', [
      '--import', 'tsx',
      'src/deployment/verify-m011-s05-real-generation-proof.ts',
    ], { stdio: 'pipe' });

    // Find the artifact written by the latest run
    const artifact = newestProofArtifact('s05-generation-proof-');
    expect(artifact).toBeTruthy();

    const json = JSON.parse(fs.readFileSync(artifact!, 'utf-8'));
    expect(json.harness).toBe('M011/S05 Real-generation Proof Harness');
    expect(json.verdict).toBe('PASS');
    expect(json.failed).toBe(0);
    expect(json.totalAssertions).toBeGreaterThan(0);

    // Verify all three branches were tested through the real service
    expect(json.branchesTested).toContain('malformed/rejected (via HypothesisGenerationService.generate() with mocked provider returning non-JSON)');
    expect(json.branchesTested).toContain('skipped/duplicate (via HypothesisGenerationService.generate() — first accept, then duplicate-skip)');
    expect(json.branchesTested).toContain('accepted with evaluation (via HypothesisGenerationService.generate() through real validator + evaluator)');

    // Verify malformed generation evidence
    expect(json.evidenceBlocks.malformedGeneration.reasonsPopulated).toBe(true);
    expect(json.evidenceBlocks.malformedGeneration.nullLinkage).toBe(true);

    // Verify skipped generation evidence
    expect(json.evidenceBlocks.skippedGeneration.reasonsPopulated).toBe(true);
    expect(json.evidenceBlocks.skippedGeneration.nullLinkage).toBe(true);

    // Verify accepted generation evidence
    expect(json.evidenceBlocks.acceptedGeneration.attemptLinked).toBe(true);
    expect(json.evidenceBlocks.acceptedGeneration.hypothesisPersisted).toBe(true);
    expect(json.evidenceBlocks.acceptedGeneration.evaluationCompleted).toBe(true);
    expect(json.evidenceBlocks.acceptedGeneration.lineageReconstructed).toBe(true);
    expect(json.evidenceBlocks.acceptedGeneration.hypothesisId).toBeGreaterThan(0);
    expect(json.evidenceBlocks.acceptedGeneration.evaluationId).toBeGreaterThan(0);

    // Verify ingress was through HypothesisGenerationService.generate()
    // contextProvenance.providerUrl assertion must pass for all three branches
    expect(json.evidenceBlocks.malformedGeneration.ingressVerified).toBe(true);
    expect(json.evidenceBlocks.skippedGeneration.ingressVerified).toBe(true);
    expect(json.evidenceBlocks.acceptedGeneration.ingressVerified).toBe(true);

    // Verify the realIngress summary section
    expect(json.realIngress).toBeTruthy();
    expect(json.realIngress.malformedIngressVerified).toBe(true);
    expect(json.realIngress.skippedIngressVerified).toBe(true);
    expect(json.realIngress.acceptedIngressVerified).toBe(true);

    // Verify assertion detail — all individual assertions should be present
    expect(json.assertions.length).toBe(json.totalAssertions);
    const failedAssertions = json.assertions.filter((a: any) => !a.pass);
    expect(failedAssertions.length).toBe(0);
  });
});
