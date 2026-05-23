#!/usr/bin/env node
// ── M011/S04 — Research Proof Harness ──
//
// One-command end-to-end proof that the assembled research pipeline
// (HypothesisValidator -> HypothesisResearchEvaluator -> ResearchPublishBackService
// -> ResearchAuditService) produces a durable, operator-reviewable artifact.
//
// Two branches are proven:
//   1. Duplicate-skip -- records an exact-failure ledger entry, then validates
//      the same hypothesis shape; asserts the validator returns 'skipped'.
//   2. Publish-success -- validates a fresh hypothesis, evaluates it through
//      the real evaluator (with a deterministic walk-forward mock), publishes
//      the result through the real publish-back service, then reads back the
//      full lineage snapshot and asserts every segment is populated.
//
// The harness:
//   - Creates a fresh file-backed SQLite database in a temp directory
//   - Seeds the exact-failure ledger for duplicate-skip
//   - Runs the real HypothesisValidator through both branches
//   - Runs the real HypothesisResearchEvaluator with a mocked walk-forward evaluator
//   - Runs the real ResearchPublishBackService
//   - Reads back the assembled lineage via ResearchAuditService
//   - Asserts every lineage segment is correctly populated
//   - Writes a timestamped JSON artifact under data/artifacts/research-proof/
//   - Exits 0 on full success, non-zero on any assertion failure

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createResearchProofContext,
  destroyResearchProofContext,
  seedDuplicateSkip,
  runDuplicateSkipValidation,
  runSuccessPath,
  resetAssertions,
  getAssertions,
  assert,
  report,
  ARTIFACT_ROOT,
  type ResearchProofContext,
} from './research-proof-support.js';
import {
  HypothesisStatus,
  ResearchArtifactType,
  type ResearchPublishBackResult,
  type ResearchLineageSnapshot,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOLD_OPEN_MS_DEFAULT = 0;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  holdOpenMs: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { holdOpenMs: HOLD_OPEN_MS_DEFAULT };

  for (const arg of argv) {
    if (arg.startsWith('--hold-open-ms=')) {
      options.holdOpenMs = Number(arg.slice('--hold-open-ms='.length));
      if (!Number.isFinite(options.holdOpenMs) || options.holdOpenMs < 0) {
        throw new Error(`Invalid --hold-open-ms value: ${arg.slice('--hold-open-ms='.length)}`);
      }
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  console.log('\u2550'.repeat(50));
  console.log('  M011/S04 \u2014 Research Proof Harness');
  console.log('\u2550'.repeat(50));
  console.log('');

  resetAssertions();

  let ctx: ResearchProofContext | null = null;
  let artifactPath = '';
  let publishResult: ResearchPublishBackResult | null = null;
  let lineage: ResearchLineageSnapshot | null = null;

  try {
    // ── Setup: temp file-backed SQLite DB ────────────────────────────
    ctx = createResearchProofContext();
    console.log(`DB: ${ctx.dbPath}`);

    // =================================================================
    // Phase 1: Duplicate-skip branch
    // =================================================================
    console.log('\n\u2500\u2500 Phase 1: Duplicate-skip proof \u2500\u2500');

    const dupeSeed = seedDuplicateSkip(ctx);

    const dupeResult = runDuplicateSkipValidation(ctx, dupeSeed.canonicalHash);

    assert(
      'Phase1: validator returns skipped for duplicate hash',
      dupeResult.kind === 'skipped',
      `kind=${dupeResult.kind}`,
    );
    assert(
      'Phase1: skipped status is Skipped',
      dupeResult.status === HypothesisStatus.Skipped,
      `status=${dupeResult.status}`,
    );

    // Narrow discriminated union for skipped result access
    if (dupeResult.kind === 'skipped') {
      assert(
        'Phase1: skip reasons contain exact prior match',
        dupeResult.reasons.some(r =>
          r.reasonMessage && r.reasonMessage.toLowerCase().includes('exact prior'),
        ),
        `reasons=${JSON.stringify(dupeResult.reasons)}`,
      );
      assert(
        'Phase1: skip reason message references prior failure',
        dupeResult.reasons[0]?.reasonMessage?.includes('failed') === true,
        `message=${dupeResult.reasons[0]?.reasonMessage}`,
      );
      assert(
        'Phase1: canonical hash is preserved',
        dupeResult.canonical.canonicalHash === dupeSeed.canonicalHash,
        `got=${dupeResult.canonical.canonicalHash}, expected=${dupeSeed.canonicalHash}`,
      );
    }

    // Verify no hypothesis row was persisted for the skipped hash
    const skippedHypothesis = ctx.hypothesisRepo.getHypothesisByCanonicalHash(dupeSeed.canonicalHash);
    assert(
      'Phase1: no hypothesis row persisted for skipped duplicate',
      skippedHypothesis === null,
      `found hypothesis id=${skippedHypothesis?.id}`,
    );

    // =================================================================
    // Phase 2: Full success path -- validate -> evaluate -> publish -> audit
    // =================================================================
    console.log('\n\u2500\u2500 Phase 2: Success path (validate -> evaluate -> publish -> audit) \u2500\u2500');

    try {
      const successPath = await runSuccessPath(ctx);
      publishResult = successPath.publishResult;
      lineage = successPath.lineage;

      assert(
        'Phase2: publish-back verdict is publish',
        publishResult.verdict === 'publish',
        `verdict=${publishResult.verdict}`,
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      assert('Phase2: success path completed without error', false, errorMessage);
    }

    // =================================================================
    // Phase 3: Lineage audit assertions
    // =================================================================
    console.log('\n\u2500\u2500 Phase 3: Lineage audit assertions \u2500\u2500');

    if (lineage) {
      // 3a. Duplicate evidence -- should be null for the success hash since
      // no memory entry was recorded for it
      assert(
        'Phase3: success hash has no duplicate evidence',
        lineage.duplicateEvidence === null,
        `got evidence: ${JSON.stringify(lineage.duplicateEvidence)}`,
      );

      // 3b. Hypothesis graph row is present
      assert(
        'Phase3: hypothesis row is present',
        lineage.hypothesis !== null,
        'null',
      );
      if (lineage.hypothesis) {
        assert(
          'Phase3: hypothesis has valid id',
          lineage.hypothesis.id > 0,
          `id=${lineage.hypothesis.id}`,
        );
        assert(
          'Phase3: hypothesis status is failed_evaluation (post-evaluation lifecycle)',
          lineage.hypothesis.status === HypothesisStatus.FailedEvaluation,
          `status=${lineage.hypothesis.status}`,
        );
      }

      // 3c. Evaluation snapshot is present
      assert(
        'Phase3: evaluation snapshot is present',
        lineage.evaluation !== null,
        'null',
      );
      if (lineage.evaluation) {
        assert(
          'Phase3: evaluation has status Completed',
          lineage.evaluation.evaluation.status === 'completed',
          `status=${lineage.evaluation.evaluation.status}`,
        );
        assert(
          'Phase3: evaluation has walk-forward run linkage',
          lineage.evaluation.walkForwardRun !== null,
          'null walkForwardRun',
        );
        assert(
          'Phase3: evaluation has winner linkage',
          lineage.evaluation.winner !== null,
          'null winner',
        );
        if (lineage.evaluation.winner) {
          assert(
            'Phase3: evaluation winner has selectedTrialId',
            lineage.evaluation.winner.selectedTrialId !== null && lineage.evaluation.winner.selectedTrialId > 0,
            `selectedTrialId=${lineage.evaluation.winner.selectedTrialId}`,
          );
        }
      }

      // 3d. Artifacts are enumerated
      assert(
        'Phase3: artifacts array is present',
        lineage.artifacts !== null,
        'null',
      );
      if (lineage.artifacts) {
        assert(
          'Phase3: at least one artifact exists',
          lineage.artifacts.length >= 1,
          `count=${lineage.artifacts.length}`,
        );

        const artifactTypes = lineage.artifacts.map(a => a.artifactType);
        assert(
          'Phase3: promotion artifact is present among artifacts',
          artifactTypes.includes(ResearchArtifactType.PromotionArtifact),
          `types=${JSON.stringify(artifactTypes)}`,
        );
      }

      // 3e. Publication evidence is present
      assert(
        'Phase3: publication evidence is present',
        lineage.publicationEvidence !== null,
        'null',
      );
      if (lineage.publicationEvidence) {
        assert(
          'Phase3: publication status is Published',
          lineage.publicationEvidence.publication.status === 'published',
          `status=${lineage.publicationEvidence.publication.status}`,
        );
        assert(
          'Phase3: publication has strategy identity',
          lineage.publicationEvidence.publication.strategyId.length > 0,
          `strategyId=${lineage.publicationEvidence.publication.strategyId}`,
        );

        // 3f. Lifecycle state linkage
        assert(
          'Phase3: lifecycle state is linked',
          lineage.publicationEvidence.lifecycleState !== null,
          'null lifecycleState',
        );
        if (lineage.publicationEvidence.lifecycleState) {
          assert(
            'Phase3: lifecycle state has phase',
            lineage.publicationEvidence.lifecycleState.phase.length > 0,
            `phase=${lineage.publicationEvidence.lifecycleState.phase}`,
          );
        }

        // 3g. Governance decisions
        assert(
          'Phase3: governance decisions array is non-empty',
          lineage.publicationEvidence.governanceDecisions.length >= 1,
          `count=${lineage.publicationEvidence.governanceDecisions.length}`,
        );
        if (lineage.publicationEvidence.governanceDecisions.length > 0) {
          assert(
            'Phase3: governance decision has verdict',
            lineage.publicationEvidence.governanceDecisions[0].verdict.length > 0,
            `verdict=${lineage.publicationEvidence.governanceDecisions[0].verdict}`,
          );
        }
      }

      // 3h. assembledAt is a valid timestamp
      assert(
        'Phase3: assembledAt is a valid timestamp',
        lineage.assembledAt > 0,
        `assembledAt=${lineage.assembledAt}`,
      );

      // 3j. Verification of Phase 1 duplicate-skip through the audit service
      const dupeLineage = ctx.auditService.assembleLineage(dupeSeed.canonicalHash);
      assert(
        'Phase3: duplicate-skip lineage has duplicateEvidence',
        dupeLineage.duplicateEvidence !== null,
        'null duplicateEvidence',
      );
      if (dupeLineage.duplicateEvidence) {
        assert(
          'Phase3: duplicate-skip duplicateEvidence hasLaterHypothesis is false',
          dupeLineage.duplicateEvidence.hasLaterHypothesis === false,
          `hasLaterHypothesis=${dupeLineage.duplicateEvidence.hasLaterHypothesis}`,
        );
      }
      assert(
        'Phase3: duplicate-skip lineage has no hypothesis row',
        dupeLineage.hypothesis === null,
        `hypothesis=${JSON.stringify(dupeLineage.hypothesis)}`,
      );
      assert(
        'Phase3: duplicate-skip lineage has no evaluation',
        dupeLineage.evaluation === null,
        'evaluation present',
      );
    }

    // =================================================================
    // Write artifact
    // =================================================================
    console.log('');

    const { passed, failed } = report();
    const overallVerdict = failed === 0 ? 'PASS' : 'FAIL';

    const coverage = lineage
      ? {
          hypothesisPresent: lineage.hypothesis !== null,
          evaluationPresent: lineage.evaluation !== null,
          artifactsPresent: (lineage.artifacts?.length ?? 0) > 0,
          publicationPresent: lineage.publicationEvidence !== null,
          lifecyclePresent: lineage.publicationEvidence?.lifecycleState !== null,
          governancePresent: (lineage.publicationEvidence?.governanceDecisions?.length ?? 0) > 0,
        }
      : null;

    const summary = {
      harness: 'M011/S04 Research Proof Harness',
      completedAt: new Date().toISOString(),
      verdict: overallVerdict,
      totalAssertions: passed + failed,
      passed,
      failed,
      assertions: getAssertions().map(a => ({
        name: a.name,
        pass: a.pass,
        detail: a.detail,
      })),
      branchesTested: [
        'duplicate-skip (exact-failure ledger -> validator -> skipped)',
        'publish-success (validate -> evaluate -> publish -> audit lineage)',
      ],
      evidenceBlocks: {
        duplicateSkip: {
          hashSeeded: true,
          validatorReturnedSkipped: getAssertions().find(a => a.name.includes('validator returns skipped'))?.pass ?? false,
          noHypothesisPersisted: getAssertions().find(a => a.name.includes('no hypothesis row persisted'))?.pass ?? false,
        },
        publishSuccess: {
          publishVerdict: publishResult?.verdict ?? 'unknown',
          publicationId: publishResult?.publication?.id ?? null,
          lifecycleStateId: publishResult?.lifecycleStateId ?? null,
          governanceDecisionId: publishResult?.governanceDecisionId ?? null,
          lineageCoverage: coverage,
        },
      },
    };

    // Ensure artifact directory exists
    fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });

    const stamp = Date.now();
    artifactPath = path.join(ARTIFACT_ROOT, `research-proof-${stamp}.json`);
    const logPath = path.join(ARTIFACT_ROOT, `research-proof-${stamp}.log`);
    fs.writeFileSync(artifactPath, JSON.stringify(summary, null, 2), 'utf-8');
    fs.writeFileSync(logPath, `${passed + failed} assertions, ${overallVerdict}\n`, 'utf-8');
    console.log(`Artifact written: ${artifactPath}`);

    // ── Hold open if requested ──
    if (options.holdOpenMs > 0) {
      console.log(`Holding for ${options.holdOpenMs} ms...`);
      await new Promise(resolve => setTimeout(resolve, options.holdOpenMs));
    }

    // ── Exit ──
    console.log(`\n${overallVerdict}: ${passed}/${passed + failed} assertions passed`);
    if (failed > 0) {
      process.exit(1);
    }
    process.exit(0);

  } catch (err) {
    console.error(`\n\u274c FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  } finally {
    if (ctx) {
      destroyResearchProofContext(ctx);
    }
  }
}

main();
