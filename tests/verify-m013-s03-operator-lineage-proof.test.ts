import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACT_ROOT = 'data/artifacts/operator-lineage-proof';
const createdArtifactDirs: string[] = [];

function newestProofArtifactDir(): string | null {
  if (!fs.existsSync(ARTIFACT_ROOT)) return null;
  const dirs = fs.readdirSync(ARTIFACT_ROOT)
    .map(name => path.join(ARTIFACT_ROOT, name))
    .filter(fullPath => fs.statSync(fullPath).isDirectory())
    .map(fullPath => ({
      path: fullPath,
      mtimeMs: fs.statSync(fullPath).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return dirs[0]?.path ?? null;
}

afterAll(() => {
  for (const dir of createdArtifactDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('verify-m013-s03-operator-lineage-proof', () => {
  it('passes end to end and writes a witness artifact with truthful totals, bounded evidence, and provenance semantics', () => {
    execFileSync('node', [
      '--import', 'tsx',
      'src/deployment/verify-m013-s03-operator-lineage-proof.ts',
    ], { stdio: 'pipe' });

    const artifactDir = newestProofArtifactDir();
    expect(artifactDir).toBeTruthy();
    createdArtifactDirs.push(artifactDir!);

    const artifactPath = path.join(artifactDir!, 'operator-lineage-proof.json');
    expect(fs.existsSync(artifactPath)).toBe(true);

    const json = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
    expect(json.harness).toBe('M013/S03 operator lineage witness');
    expect(json.verdict).toBe('PASS');

    expect(json.branchCoverage).toMatchObject({
      duplicateSkip: {
        canonicalHash: 'm013-duplicate-lineage-hash',
        lineageAvailability: 'ready',
        duplicateOnly: true,
      },
      publishSuccess: {
        canonicalHash: 'm013-published-lineage-hash',
        strategyId: 'research-hypothesis-m013',
        strategyVersion: '1.0.0',
        walkForwardRunId: expect.any(Number),
        lineageAvailability: 'ready',
        publicationPresent: true,
      },
    });
    expect(json.branchCoverage.duplicateSkip.entryCount).toBeGreaterThan(0);

    expect(json.operatorSurfaces.dashboard).toMatchObject({
      state: 'ok',
      totals: {
        generationAttempts: 4,
        duplicateSkips: 1,
        publications: 1,
      },
      boundedRecentCount: 3,
      duplicateVisibleInRecentWindow: false,
    });

    expect(json.operatorSurfaces.strategyDetail).toMatchObject({
      publishedCanonicalHash: 'm013-published-lineage-hash',
      recentDecisionCount: 3,
      publicationProvenanceVisible: true,
    });

    expect(json.operatorSurfaces.serverRoutes).toMatchObject({
      dashboardStatus: 200,
      governanceStatus: 200,
      strategyStatus: 200,
      refreshStatus: 200,
      governanceContainsBoundedLabel: true,
      governanceContainsTruthfulTotalsLead: true,
    });

    expect(json.degradedSemantics).toEqual({
      duplicateBranchPublicationAbsent: true,
      duplicateBranchHypothesisAbsent: true,
    });

    expect(Array.isArray(json.assertions)).toBe(true);
    expect(json.assertions.length).toBeGreaterThan(0);
    expect(json.assertions.every((assertion: { pass: boolean }) => assertion.pass)).toBe(true);

    const assertionNames = json.assertions.map((assertion: { name: string }) => assertion.name);
    expect(assertionNames).toContain('Dashboard lineage totals count one duplicate skip');
    expect(assertionNames).toContain('Published lineage detail includes publication provenance');
    expect(assertionNames).toContain('Governance route renders bounded evidence label and truthful totals lead note');
    expect(assertionNames).toContain('Strategy route renders publication provenance and absence language does not claim skipped branch published');
  });
});
