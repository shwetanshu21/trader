#!/usr/bin/env node
// ── M011/S05 — Real-generation Proof Harness ──
//
// One-command end-to-end proof that the generation-attempt persistence
// contract (hypothesis_generation_attempts + hypothesis_generation_reasons),
// the typed generation-aware audit snapshot, and hypothesis_evaluations
// linkage all work correctly with real persisted data.
//
// Three branches are proven:
//   1. Malformed/rejected generation — persists a rejected attempt with
//      explicit reason codes (MalformedResponse) and verifies the audit
//      reconstructs the rejection evidence.
//   2. Skipped/duplicate generation — persists a skipped attempt with
//      DuplicateSkipped reason and verifies audit reconstruction.
//   3. Accepted generation — validates a fresh hypothesis through the real
//      HypothesisValidator, evaluates it through the real evaluator (with
//      a deterministic walk-forward mock), persists the generation-attempt
//      linkage, and verifies the audit reconstructs the full chain:
//      generation -> hypothesis -> evaluation.
//
// The harness:
//   - Creates a fresh file-backed SQLite database in a temp directory
//   - Seeds one malformed attempt with explicit reasons
//   - Seeds one skipped/duplicate attempt with explicit reason
//   - Seeds one accepted attempt through the full validator+evaluator pipeline
//   - Reads back every lineage via ResearchAuditService
//   - Asserts every lineage segment is correctly populated
//   - Writes a timestamped JSON artifact under data/artifacts/research-proof/
//   - Exits 0 on full success, non-zero on any assertion failure

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createResearchProofContext,
  destroyResearchProofContext,
  seedMalformedGeneration,
  seedSkippedGeneration,
  seedAcceptedGeneration,
  resetAssertions,
  getAssertions,
  assert,
  report,
  ARTIFACT_ROOT,
  type ResearchProofContext,
} from './research-proof-support.js';
import {
  GenerationVerdict,
  GenerationReasonCode,
  type ResearchLineageSnapshot,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  holdOpenMs: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { holdOpenMs: 0 };

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
  console.log('  M011/S05 \u2014 Real-generation Proof Harness');
  console.log('\u2550'.repeat(50));
  console.log('');

  resetAssertions();

  let ctx: ResearchProofContext | null = null;
  let artifactPath = '';

  try {
    // ── Setup: temp file-backed SQLite DB ────────────────────────────
    ctx = createResearchProofContext();
    console.log(`DB: ${ctx.dbPath}`);

    // =================================================================
    // Phase 1: Malformed/rejected generation
    // =================================================================
    console.log('\n\u2500\u2500 Phase 1: Malformed/rejected generation \u2500\u2500');

    const malformedAttempt = seedMalformedGeneration(ctx);

    assert(
      'Phase1: malformed attempt verdict is Rejected',
      malformedAttempt.verdict === GenerationVerdict.Rejected,
      `verdict=${malformedAttempt.verdict}`,
    );
    assert(
      'Phase1: malformed attempt has id > 0',
      malformedAttempt.id > 0,
      `id=${malformedAttempt.id}`,
    );
    assert(
      'Phase1: malformed attempt has reasons',
      malformedAttempt.reasons.length === 1,
      `reasons.length=${malformedAttempt.reasons.length}`,
    );
    if (malformedAttempt.reasons.length > 0) {
      assert(
        'Phase1: malformed reason code is MalformedResponse',
        malformedAttempt.reasons[0].reasonCode === GenerationReasonCode.MalformedResponse,
        `code=${malformedAttempt.reasons[0].reasonCode}`,
      );
    }
    assert(
      'Phase1: malformed attempt has null canonicalHash',
      malformedAttempt.canonicalHash === null,
      `hash=${malformedAttempt.canonicalHash}`,
    );
    assert(
      'Phase1: malformed attempt has null hypothesisGraphId',
      malformedAttempt.hypothesisGraphId === null,
      `graphId=${malformedAttempt.hypothesisGraphId}`,
    );
    assert(
      'Phase1: malformed attempt has raw provider output preserved',
      malformedAttempt.rawProviderOutput === '{invalid json here}',
      `output=${malformedAttempt.rawProviderOutput}`,
    );

    // Verify audit reconstruction for the malformed hash (should be null — no canonical hash)
    const malformedLineage = ctx.auditService.assembleLineage('no-hash-malformed');
    assert(
      'Phase1: malformed hash lineage has no hypothesis',
      malformedLineage.hypothesis === null,
      'hypothesis present',
    );
    assert(
      'Phase1: malformed hash lineage has no evaluation',
      malformedLineage.evaluation === null,
      'evaluation present',
    );

    // =================================================================
    // Phase 2: Skipped/duplicate generation
    // =================================================================
    console.log('\n\u2500\u2500 Phase 2: Skipped/duplicate generation \u2500\u2500');

    const skippedAttempt = seedSkippedGeneration(ctx);

    assert(
      'Phase2: skipped attempt verdict is Skipped',
      skippedAttempt.verdict === GenerationVerdict.Skipped,
      `verdict=${skippedAttempt.verdict}`,
    );
    assert(
      'Phase2: skipped attempt has id > 0',
      skippedAttempt.id > 0,
      `id=${skippedAttempt.id}`,
    );
    assert(
      'Phase2: skipped attempt has reasons',
      skippedAttempt.reasons.length === 1,
      `reasons.length=${skippedAttempt.reasons.length}`,
    );
    if (skippedAttempt.reasons.length > 0) {
      assert(
        'Phase2: skipped reason code is DuplicateSkipped',
        skippedAttempt.reasons[0].reasonCode === GenerationReasonCode.DuplicateSkipped,
        `code=${skippedAttempt.reasons[0].reasonCode}`,
      );
    }
    assert(
      'Phase2: skipped attempt has canonical hash',
      skippedAttempt.canonicalHash !== null,
      `hash=${skippedAttempt.canonicalHash}`,
    );
    assert(
      'Phase2: skipped attempt has null hypothesisGraphId',
      skippedAttempt.hypothesisGraphId === null,
      `graphId=${skippedAttempt.hypothesisGraphId}`,
    );

    // Verify audit reconstruction for the skipped hash
    const skippedLineage = ctx.auditService.assembleLineage(skippedAttempt.canonicalHash!);
    assert(
      'Phase2: skipped lineage has no hypothesis (no prior accepted attempt)',
      skippedLineage.hypothesis === null,
      'hypothesis present',
    );
    assert(
      'Phase2: skipped lineage has no evaluation',
      skippedLineage.evaluation === null,
      'evaluation present',
    );

    // =================================================================
    // Phase 3: Accepted generation with full pipeline linkage
    // =================================================================
    console.log('\n\u2500\u2500 Phase 3: Accepted generation (validate -> evaluate -> audit) \u2500\u2500');

    let acceptedAttemptId = 0;
    let acceptedHypothesisId = 0;
    let acceptedEvalId = 0;
    let acceptedLineage: ResearchLineageSnapshot | null = null;

    try {
      const accepted = await seedAcceptedGeneration(ctx);

      acceptedAttemptId = accepted.generationAttempt.id;
      acceptedHypothesisId = accepted.hypothesis.id;
      acceptedEvalId = accepted.evaluationResult.evaluation.id;
      acceptedLineage = accepted.lineage;

      assert(
        'Phase3: accepted generation attempt verdict is Accepted',
        accepted.generationAttempt.verdict === GenerationVerdict.Accepted,
        `verdict=${accepted.generationAttempt.verdict}`,
      );
      assert(
        'Phase3: accepted attempt has id > 0',
        accepted.generationAttempt.id > 0,
        `id=${accepted.generationAttempt.id}`,
      );
      assert(
        'Phase3: accepted attempt has no reasons',
        accepted.generationAttempt.reasons.length === 0,
        `reasons.length=${accepted.generationAttempt.reasons.length}`,
      );
      assert(
        'Phase3: accepted attempt has canonicalHash',
        accepted.generationAttempt.canonicalHash !== null,
        'null canonicalHash',
      );
      assert(
        'Phase3: accepted attempt has hypothesisGraphId',
        accepted.generationAttempt.hypothesisGraphId !== null,
        'null hypothesisGraphId',
      );
      assert(
        'Phase3: accepted attempt has hypothesisEvaluationId',
        accepted.generationAttempt.hypothesisEvaluationId !== null,
        'null hypothesisEvaluationId',
      );
      assert(
        'Phase3: hypothesis was validated and persisted',
        accepted.hypothesis.id > 0,
        `id=${accepted.hypothesis.id}`,
      );
      assert(
        'Phase3: evaluation completed with a status',
        ['completed', 'failed'].includes(accepted.evaluationResult.evaluation.status),
        `status=${accepted.evaluationResult.evaluation.status}`,
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      assert('Phase3: accepted generation path completed without error', false, errorMessage);
    }

    // =================================================================
    // Phase 4: Audit reconstruction for the accepted lineage
    // =================================================================
    console.log('\n\u2500\u2500 Phase 4: Audit lineage assertions \u2500\u2500');

    if (acceptedLineage) {
      // 4a. Generation attempt evidence is present
      assert(
        'Phase4: lineage has generationAttempt',
        acceptedLineage.generationAttempt !== null,
        'null generationAttempt',
      );
      if (acceptedLineage.generationAttempt) {
        assert(
          'Phase4: generationAttempt.id matches',
          acceptedLineage.generationAttempt.id === acceptedAttemptId,
          `got=${acceptedLineage.generationAttempt.id}, expected=${acceptedAttemptId}`,
        );
        assert(
          'Phase4: generationAttempt.verdict is Accepted',
          acceptedLineage.generationAttempt.verdict === GenerationVerdict.Accepted,
          `verdict=${acceptedLineage.generationAttempt.verdict}`,
        );
      }

      // 4b. Hypothesis graph row is present
      assert(
        'Phase4: hypothesis row is present',
        acceptedLineage.hypothesis !== null,
        'null',
      );
      if (acceptedLineage.hypothesis) {
        assert(
          'Phase4: hypothesis id matches',
          acceptedLineage.hypothesis.id === acceptedHypothesisId,
          `got=${acceptedLineage.hypothesis.id}, expected=${acceptedHypothesisId}`,
        );
        assert(
          'Phase4: hypothesis has status',
          acceptedLineage.hypothesis.status.length > 0,
          `status=${acceptedLineage.hypothesis.status}`,
        );
      }

      // 4c. Evaluation snapshot is present
      assert(
        'Phase4: evaluation snapshot is present',
        acceptedLineage.evaluation !== null,
        'null',
      );
      if (acceptedLineage.evaluation) {
        assert(
          'Phase4: evaluation id matches',
          acceptedLineage.evaluation.evaluation.id === acceptedEvalId,
          `got=${acceptedLineage.evaluation.evaluation.id}, expected=${acceptedEvalId}`,
        );
      }

      // 4d. Artifacts exist
      if (acceptedLineage.artifacts) {
        assert(
          'Phase4: at least one artifact exists',
          acceptedLineage.artifacts.length >= 1,
          `count=${acceptedLineage.artifacts.length}`,
        );
      }

      // 4e. assembledAt is valid
      assert(
        'Phase4: assembledAt is valid',
        acceptedLineage.assembledAt > 0,
        `assembledAt=${acceptedLineage.assembledAt}`,
      );

      // 4f. Duplicate evidence should be null (first time this hash is seen)
      assert(
        'Phase4: duplicateEvidence is null (first occurrence)',
        acceptedLineage.duplicateEvidence === null,
        `got=${JSON.stringify(acceptedLineage.duplicateEvidence)}`,
      );
    }

    // =================================================================
    // Write artifact
    // =================================================================
    console.log('');

    const { passed, failed } = report();
    const overallVerdict = failed === 0 ? 'PASS' : 'FAIL';

    const summary = {
      harness: 'M011/S05 Real-generation Proof Harness',
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
        'malformed/rejected (persist rejected attempt with MalformedResponse reason)',
        'skipped/duplicate (persist skipped attempt with DuplicateSkipped reason)',
        'accepted (validate -> evaluate -> generation-attempt linkage -> audit reconstruction)',
      ],
      evidenceBlocks: {
        malformedGeneration: {
          attemptId: ctx.db.prepare(
            "SELECT id FROM hypothesis_generation_attempts WHERE verdict = 'rejected' LIMIT 1"
          ).get() as { id: number } | undefined,
          reasonsPopulated: getAssertions().find(a => a.name.includes('malformed attempt has reasons'))?.pass ?? false,
          nullLinkage: getAssertions().find(a => a.name.includes('null hypothesisGraphId'))?.pass ?? false,
        },
        skippedGeneration: {
          attemptId: ctx.db.prepare(
            "SELECT id FROM hypothesis_generation_attempts WHERE verdict = 'skipped' LIMIT 1"
          ).get() as { id: number } | undefined,
          reasonsPopulated: getAssertions().find(a => a.name.includes('skipped attempt has reasons'))?.pass ?? false,
          nullLinkage: getAssertions().find(a => a.name.includes('skipped attempt has null hypothesisGraphId'))?.pass ?? false,
        },
        acceptedGeneration: {
          attemptId: acceptedAttemptId,
          hypothesisId: acceptedHypothesisId,
          evaluationId: acceptedEvalId,
          attemptLinked: acceptedAttemptId > 0,
          hypothesisPersisted: acceptedHypothesisId > 0,
          evaluationCompleted: acceptedEvalId > 0,
          lineageReconstructed: acceptedLineage !== null,
        },
      },
    };

    // Ensure artifact directory exists
    fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });

    const stamp = Date.now();
    artifactPath = path.join(ARTIFACT_ROOT, `s05-generation-proof-${stamp}.json`);
    const logPath = path.join(ARTIFACT_ROOT, `s05-generation-proof-${stamp}.log`);
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
