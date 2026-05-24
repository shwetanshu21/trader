#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ARTIFACT_ROOT,
  assert,
  createOperatorLineageProofContext,
  destroyOperatorLineageProofContext,
  fetchDashboardPayload,
  fetchResearchLineageSummary,
  fetchWithAuth,
  getAssertions,
  readLineageDetail,
  report,
  resetAssertions,
  seedOperatorLineageProof,
  startWitnessServer,
  summarizeLineageEntry,
} from './operator-lineage-proof-support.js';

async function main(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('  M013/S03 — Operator Lineage Witness Harness');
  console.log('═'.repeat(60));
  console.log('');

  resetAssertions();

  const ctx = createOperatorLineageProofContext();
  let server: Awaited<ReturnType<typeof startWitnessServer>> | null = null;

  try {
    console.log(`DB: ${ctx.dbPath}`);
    const seeded = seedOperatorLineageProof(ctx);

    console.log('\n── Phase 1: read-model lineage totals and bounded recent evidence ──');
    const dashboardPayload = fetchDashboardPayload(ctx);
    const lineageSummary = fetchResearchLineageSummary(ctx, seeded.recentLineageLimit);

    assert(
      'Dashboard lineage section is available',
      dashboardPayload.researchLineage.state === 'ok',
      `state=${dashboardPayload.researchLineage.state}`,
    );
    assert(
      'Dashboard lineage totals count all persisted generation attempts',
      lineageSummary.totals.generationAttempts === 4,
      `generationAttempts=${lineageSummary.totals.generationAttempts}`,
    );
    assert(
      'Dashboard lineage totals count one duplicate skip',
      lineageSummary.totals.duplicateSkips === 1,
      `duplicateSkips=${lineageSummary.totals.duplicateSkips}`,
    );
    assert(
      'Dashboard lineage totals count one publication',
      lineageSummary.totals.publications === 1,
      `publications=${lineageSummary.totals.publications}`,
    );
    assert(
      'Dashboard recent lineage is bounded below truthful totals',
      lineageSummary.recent.length === seeded.recentLineageLimit && lineageSummary.totals.generationAttempts > lineageSummary.recent.length,
      `recent=${lineageSummary.recent.length}, total=${lineageSummary.totals.generationAttempts}`,
    );
    assert(
      'Bounded recent window omits duplicate skip while total still counts it',
      !lineageSummary.recent.some(entry => entry.canonicalHash === seeded.duplicateHash) && lineageSummary.totals.duplicateSkips === 1,
      `recent hashes=${lineageSummary.recent.map(entry => entry.canonicalHash).join(',')}`,
    );
    const publishedRow = lineageSummary.recent.find(entry => entry.canonicalHash === seeded.publishedHash);
    assert(
      'Recent lineage includes published branch provenance',
      Boolean(publishedRow?.publication?.strategyId === seeded.publishedStrategyId),
      JSON.stringify(summarizeLineageEntry(publishedRow)),
    );
    assert(
      'Published recent row carries governance verdict provenance',
      publishedRow?.publication?.governanceVerdict === 'promote',
      JSON.stringify(summarizeLineageEntry(publishedRow)),
    );

    console.log('\n── Phase 2: duplicate and published lineage detail semantics ──');
    const duplicateDetail = readLineageDetail(ctx, seeded.duplicateHash);
    const publishedDetail = readLineageDetail(ctx, seeded.publishedHash);

    assert(
      'Duplicate lineage detail is ready',
      duplicateDetail.status.availability === 'ready',
      `availability=${duplicateDetail.status.availability}`,
    );
    assert(
      'Duplicate lineage detail has no hypothesis entry',
      duplicateDetail.entries.every(entry => entry.hypothesis === null),
      JSON.stringify(duplicateDetail.entries.map(summarizeLineageEntry)),
    );
    assert(
      'Duplicate lineage detail exposes duplicate-skip reason and absence semantics',
      duplicateDetail.entries.some(entry => entry.lineageType === 'duplicate_skip' && entry.duplicateSkip?.reasonCode === 'exact_failure_match')
        && duplicateDetail.entries.some(entry => entry.lineageType === 'duplicate_skip' && entry.generationAttempt?.verdict === 'skipped' && entry.publication === null),
      JSON.stringify(duplicateDetail.entries.map(summarizeLineageEntry)),
    );

    assert(
      'Published lineage detail is ready',
      publishedDetail.status.availability === 'ready',
      `availability=${publishedDetail.status.availability}`,
    );
    assert(
      'Published lineage detail includes publication provenance',
      publishedDetail.entries.some(entry => entry.publication?.strategyId === seeded.publishedStrategyId),
      JSON.stringify(publishedDetail.entries.map(summarizeLineageEntry)),
    );
    assert(
      'Published lineage detail includes evaluation linkage to walk-forward run',
      publishedDetail.entries.some(entry => entry.evaluation?.walkForwardRunId === seeded.publishedWalkForwardRunId),
      JSON.stringify(publishedDetail.entries.map(summarizeLineageEntry)),
    );

    const strategyDetail = ctx.detailReadModel.getStrategyDetail(seeded.publishedStrategyId, seeded.publishedStrategyVersion);
    assert(
      'Strategy detail exists for published branch',
      strategyDetail !== null,
      'strategy detail missing',
    );
    assert(
      'Strategy detail shows published research provenance',
      Boolean(strategyDetail?.publishedResearchProvenance?.canonicalHash === seeded.publishedHash),
      JSON.stringify(strategyDetail?.publishedResearchProvenance ?? null),
    );
    assert(
      'Strategy detail retains truthful decision count distinct from lineage recent window',
      strategyDetail?.recentDecisions.length === seeded.publishedDecisionCount,
      `recentDecisions=${strategyDetail?.recentDecisions.length}`,
    );

    console.log('\n── Phase 3: real operator HTTP routes ──');
    server = await startWitnessServer(ctx);

    const dashboardHtml = await fetchWithAuth(server, '/');
    const governanceHtml = await fetchWithAuth(server, '/governance');
    const strategyHtml = await fetchWithAuth(server, `/strategy?strategyId=${encodeURIComponent(seeded.publishedStrategyId)}&strategyVersion=${encodeURIComponent(seeded.publishedStrategyVersion)}`);
    const refreshJson = await fetchWithAuth(server, '/api/refresh', 'application/json');

    assert('Dashboard route responds 200', dashboardHtml.status === 200, `status=${dashboardHtml.status}`);
    assert(
      'Dashboard route renders research-lineage totals messaging',
      dashboardHtml.body.includes('Repository-backed totals stay truthful even when recent lineage rows remain bounded for operator payloads.'),
      'missing dashboard totals note',
    );
    assert(
      'Governance route renders bounded evidence label and truthful totals lead note',
      governanceHtml.status === 200
        && governanceHtml.body.includes('Recent evidence window')
        && governanceHtml.body.includes('Repository-backed totals lead this section so operators can inspect the truthful full lineage first'),
      `status=${governanceHtml.status}`,
    );
    assert(
      'Governance route renders published strategy provenance and duplicate total',
      governanceHtml.body.includes(seeded.publishedStrategyId)
        && governanceHtml.body.includes('Duplicate Skip Total')
        && governanceHtml.body.includes('Published Research Total'),
      'governance page missing expected lineage copy',
    );
    assert(
      'Strategy route renders publication provenance and absence language does not claim skipped branch published',
      strategyHtml.status === 200
        && strategyHtml.body.includes('Published Research Provenance')
        && strategyHtml.body.includes(seeded.publishedHash)
        && !strategyHtml.body.includes(seeded.duplicateHash),
      `status=${strategyHtml.status}`,
    );

    const refreshPayload = JSON.parse(refreshJson.body) as {
      sections?: {
        summaryCards?: { count?: number; state?: string };
        governanceHistory?: { count?: number; state?: string };
        walkForwardLeaderboard?: { count?: number; state?: string };
      };
    };
    assert('Refresh API responds 200', refreshJson.status === 200, `status=${refreshJson.status}`);
    assert(
      'Refresh API exposes real operator sections with persisted counts',
      (refreshPayload.sections?.summaryCards?.count ?? 0) > 0
        && (refreshPayload.sections?.governanceHistory?.count ?? 0) > 0
        && (refreshPayload.sections?.walkForwardLeaderboard?.count ?? 0) > 0,
      JSON.stringify(refreshPayload.sections ?? null),
    );
    assert(
      'Refresh API returns section state metadata for operator surfaces',
      refreshPayload.sections?.summaryCards?.state === 'ok'
        && refreshPayload.sections?.governanceHistory?.state === 'ok'
        && refreshPayload.sections?.walkForwardLeaderboard?.state === 'ok',
      JSON.stringify(refreshPayload.sections ?? null),
    );

    console.log('\n── Phase 4: durable artifact ──');
    const { passed, failed } = report();
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const artifactDir = path.join(ARTIFACT_ROOT, stamp);
    fs.mkdirSync(artifactDir, { recursive: true });

    const artifact = {
      harness: 'M013/S03 operator lineage witness',
      completedAt: new Date().toISOString(),
      verdict: failed === 0 ? 'PASS' : 'FAIL',
      dbPath: ctx.dbPath,
      branchCoverage: {
        duplicateSkip: {
          canonicalHash: seeded.duplicateHash,
          lineageAvailability: duplicateDetail.status.availability,
          entryCount: duplicateDetail.entries.length,
          duplicateOnly: duplicateDetail.entries.every(entry => entry.publication === null && entry.hypothesis === null),
        },
        publishSuccess: {
          canonicalHash: seeded.publishedHash,
          strategyId: seeded.publishedStrategyId,
          strategyVersion: seeded.publishedStrategyVersion,
          walkForwardRunId: seeded.publishedWalkForwardRunId,
          lineageAvailability: publishedDetail.status.availability,
          publicationPresent: publishedDetail.entries.some(entry => entry.publication?.strategyId === seeded.publishedStrategyId),
        },
      },
      operatorSurfaces: {
        dashboard: {
          state: dashboardPayload.researchLineage.state,
          totals: lineageSummary.totals,
          boundedRecentCount: lineageSummary.recent.length,
          duplicateVisibleInRecentWindow: lineageSummary.recent.some(entry => entry.canonicalHash === seeded.duplicateHash),
        },
        strategyDetail: strategyDetail ? {
          publishedCanonicalHash: strategyDetail.publishedResearchProvenance?.canonicalHash ?? null,
          recentDecisionCount: strategyDetail.recentDecisions.length,
          publicationProvenanceVisible: strategyDetail.publishedResearchProvenance !== null,
        } : null,
        serverRoutes: {
          dashboardStatus: dashboardHtml.status,
          governanceStatus: governanceHtml.status,
          strategyStatus: strategyHtml.status,
          refreshStatus: refreshJson.status,
          governanceContainsBoundedLabel: governanceHtml.body.includes('Recent evidence window'),
          governanceContainsTruthfulTotalsLead: governanceHtml.body.includes('Repository-backed totals lead this section so operators can inspect the truthful full lineage first'),
        },
      },
      degradedSemantics: {
        duplicateBranchPublicationAbsent: duplicateDetail.entries.every(entry => entry.publication === null),
        duplicateBranchHypothesisAbsent: duplicateDetail.entries.every(entry => entry.hypothesis === null),
      },
      assertions: getAssertions(),
    };

    const artifactPath = path.join(artifactDir, 'operator-lineage-proof.json');
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf-8');
    console.log(`Artifact written: ${artifactPath}`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(`\n❌ FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  } finally {
    if (server) {
      await server.close();
    }
    destroyOperatorLineageProofContext(ctx);
  }
}

main();
