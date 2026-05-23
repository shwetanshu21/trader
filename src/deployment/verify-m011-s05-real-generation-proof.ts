#!/usr/bin/env node
// ── M011/S05 — Real-generation Proof Harness ──
//
// One-command end-to-end proof that the generation-attempt persistence
// contract (hypothesis_generation_attempts + hypothesis_generation_reasons),
// the typed generation-aware audit snapshot, and hypothesis_evaluations
// linkage all work correctly through the REAL HypothesisGenerationService
// ingress (NOT seed helpers that bypass the service).
//
// Three branches are proven, ALL through HypothesisGenerationService.generate():
//   1. Malformed/rejected generation — mocked provider returns non-JSON;
//      the service persists a Rejected attempt with MalformedResponse reason.
//   2. Skipped/duplicate generation — mocked provider returns a valid graph;
//      first call accepts it, second call with the same graph skips it via
//      DuplicateSkipped (real duplicate detection).
//   3. Accepted generation — mocked provider returns a valid graph; the
//      service runs the real validator, persists the hypothesis, runs the
//      real evaluator (with a mocked walk-forward evaluator for deterministic
//      output), persists the generation-attempt linkage, and returns the
//      accepted result with hypothesis + evaluation IDs.
//
// Then ResearchAuditService reconstructs the full lineage from persisted
// state alone — proving the chain survives restart without replaying stdout.
//
// The harness:
//   - Creates a fresh file-backed SQLite database in a temp directory
//   - Creates real HypothesisGenerationService instances with mocked fetch
//   - Exercises all three branches through generate() — the real ingress
//   - Reads back every lineage via ResearchAuditService
//   - Asserts every lineage segment is correctly populated
//   - Writes a timestamped JSON artifact under data/artifacts/research-proof/
//   - Exits 0 on full success, non-zero on any assertion failure
//
// If someone edits this harness to bypass HypothesisGenerationService.generate()
// and call seed helpers or repo methods directly, the contextProvenance.providerUrl
// assertion will fail — it checks that each persisted attempt came through the
// PROOF_PROVIDER_CONFIG seam, not a hardcoded seed URL.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createResearchProofContext,
  destroyResearchProofContext,
  createProofGenerationService,
  createMockWalkForwardEvaluator,
  setMockFetchResponse,
  resetAssertions,
  getAssertions,
  assert,
  report,
  ARTIFACT_ROOT,
  PROOF_PROVIDER_CONFIG,
  type ResearchProofContext,
} from './research-proof-support.js';
import { HypothesisResearchEvaluator } from '../research/hypothesis-evaluator.js';
import { ResearchArtifactWriter } from '../research/artifact-writer.js';
import { FakeDataProvider, FakeMarketProfile } from './research-proof-support.js';
import {
  GenerationVerdict,
  GenerationReasonCode,
  type ResearchLineageSnapshot,
  type HypothesisGraph,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Constants — hypothesis graphs for each branch
// ---------------------------------------------------------------------------

/**
 * A valid hypothesis graph used for the duplicate-skip path.
 * The same JSON mock response is returned for both the first (accept) and
 * second (skip) call so the service's real duplicate detection fires.
 */
function dupeGraph(): HypothesisGraph {
  return {
    schemaVersion: '1',
    signals: [{ type: 'ema_cross', params: { fast: 8, slow: 21 } }],
    filters: [{ type: 'volume_min', params: { min: 500000 } }],
    entryRules: [{ type: 'breakout_confirmed', params: { lookbackBars: 5 } }],
    exitRules: [{ type: 'time_stop', params: { maxBars: 12 } }],
    riskRules: [{ type: 'atr_stop', params: { period: 14, multiple: 2 } }],
  };
}

/**
 * A valid hypothesis graph used for the accepted + evaluation path.
 * Different rule structure ensures no hash collision with dupeGraph.
 */
function evalGraph(): HypothesisGraph {
  return {
    schemaVersion: '1',
    signals: [{ type: 'sma_cross', params: { fast: 10, slow: 30 } }],
    filters: [{ type: 'volume_min', params: { min: 300000 } }],
    entryRules: [{ type: 'range_breakout', params: { lookbackBars: 10, multiplier: 1.5 } }],
    exitRules: [{ type: 'trailing_stop', params: { atrPeriod: 14, atrMultiplier: 3 } }],
    riskRules: [{ type: 'position_size', params: { riskPercent: 1 } }],
  };
}

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
  console.log('  (exercises HypothesisGenerationService.generate() as ingress)');
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
    // Phase 1: Malformed/rejected generation via HypothesisGenerationService
    // =================================================================
    console.log('\n\u2500\u2500 Phase 1: Malformed/rejected via service.generate() \u2500\u2500');

    const svcNoEval = createProofGenerationService(ctx);

    const malformedFetchRestore = setMockFetchResponse('not valid json');
    let malformedResult;
    try {
      malformedResult = await svcNoEval.generate({
        instruction: 'Generate a momentum hypothesis.',
        marketId: 'INDIA_NSE_EQ',
        skipEvaluation: true,
      });
    } finally {
      malformedFetchRestore();
    }

    assert(
      'Phase1: malformed result kind is rejected',
      malformedResult.kind === 'rejected',
      `kind=${malformedResult.kind}`,
    );

    if (malformedResult.kind === 'rejected') {
      assert(
        'Phase1: malformed attempt verdict is Rejected',
        malformedResult.attempt.verdict === GenerationVerdict.Rejected,
        `verdict=${malformedResult.attempt.verdict}`,
      );
      assert(
        'Phase1: malformed attempt has id > 0',
        malformedResult.attempt.id > 0,
        `id=${malformedResult.attempt.id}`,
      );
      assert(
        'Phase1: malformed attempt has reasons',
        malformedResult.attempt.reasons.length >= 1,
        `reasons.length=${malformedResult.attempt.reasons.length}`,
      );
      if (malformedResult.attempt.reasons.length > 0) {
        assert(
          'Phase1: malformed reason code is MalformedResponse',
          malformedResult.attempt.reasons[0].reasonCode === GenerationReasonCode.MalformedResponse,
          `code=${malformedResult.attempt.reasons[0].reasonCode}`,
        );
      }
      assert(
        'Phase1: malformed attempt has null canonicalHash',
        malformedResult.attempt.canonicalHash === null,
        `hash=${malformedResult.attempt.canonicalHash}`,
      );
      assert(
        'Phase1: malformed attempt has null hypothesisGraphId',
        malformedResult.attempt.hypothesisGraphId === null,
        `graphId=${malformedResult.attempt.hypothesisGraphId}`,
      );
      assert(
        'Phase1: malformed raw provider output preserved',
        malformedResult.rawProviderOutput === 'not valid json',
        `output=${malformedResult.rawProviderOutput}`,
      );
      assert(
        'Phase1: contextProvenance.providerUrl matches proof config (real ingress)',
        malformedResult.attempt.contextProvenance.providerUrl === PROOF_PROVIDER_CONFIG.providerUrl,
        `url=${malformedResult.attempt.contextProvenance.providerUrl}`,
      );
    }

    // =================================================================
    // Phase 2: Skipped/duplicate generation via HypothesisGenerationService
    // =================================================================
    console.log('\n\u2500\u2500 Phase 2: Skipped/duplicate via service.generate() \u2500\u2500');

    const svcSkip = createProofGenerationService(ctx);
    const dupeGraphJson = JSON.stringify(dupeGraph());

    // First call — accept the graph
    const acceptRestore = setMockFetchResponse(dupeGraphJson);
    let acceptResult;
    try {
      acceptResult = await svcSkip.generate({
        instruction: 'Generate a momentum hypothesis.',
        marketId: 'INDIA_NSE_EQ',
        skipEvaluation: true,
      });
    } finally {
      acceptRestore();
    }

    assert(
      'Phase2: first call with graph is accepted',
      acceptResult.kind === 'accepted',
      `kind=${acceptResult.kind}`,
    );

    // Second call with same graph — should be skipped (duplicate)
    const skipRestore = setMockFetchResponse(dupeGraphJson);
    let skipResult;
    try {
      skipResult = await svcSkip.generate({
        instruction: 'Generate a momentum hypothesis.',
        marketId: 'INDIA_NSE_EQ',
        skipEvaluation: true,
      });
    } finally {
      skipRestore();
    }

    assert(
      'Phase2: second call with same graph is skipped',
      skipResult.kind === 'skipped',
      `kind=${skipResult.kind}`,
    );

    if (skipResult.kind === 'skipped') {
      assert(
        'Phase2: skipped attempt verdict is Skipped',
        skipResult.attempt.verdict === GenerationVerdict.Skipped,
        `verdict=${skipResult.attempt.verdict}`,
      );
      assert(
        'Phase2: skipped attempt has id > 0',
        skipResult.attempt.id > 0,
        `id=${skipResult.attempt.id}`,
      );
      assert(
        'Phase2: skipped attempt has reasons',
        skipResult.attempt.reasons.length >= 1,
        `reasons.length=${skipResult.attempt.reasons.length}`,
      );
      if (skipResult.attempt.reasons.length > 0) {
        assert(
          'Phase2: skipped reason code is DuplicateSkipped',
          skipResult.attempt.reasons[0].reasonCode === GenerationReasonCode.DuplicateSkipped,
          `code=${skipResult.attempt.reasons[0].reasonCode}`,
        );
      }
      assert(
        'Phase2: skipped attempt has canonical hash',
        skipResult.attempt.canonicalHash !== null,
        `hash=${skipResult.attempt.canonicalHash}`,
      );
      assert(
        'Phase2: skipped attempt has null hypothesisGraphId',
        skipResult.attempt.hypothesisGraphId === null,
        `graphId=${skipResult.attempt.hypothesisGraphId}`,
      );
      assert(
        'Phase2: contextProvenance.providerUrl matches proof config (real ingress)',
        skipResult.attempt.contextProvenance.providerUrl === PROOF_PROVIDER_CONFIG.providerUrl,
        `url=${skipResult.attempt.contextProvenance.providerUrl}`,
      );
    }

    // =================================================================
    // Phase 3: Accepted generation with evaluation via service.generate()
    // =================================================================
    console.log('\n\u2500\u2500 Phase 3: Accepted with evaluation via service.generate() \u2500\u2500');

    let acceptedAttemptId = 0;
    let acceptedHypothesisId = 0;
    let acceptedEvalId = 0;
    let acceptedLineage: ResearchLineageSnapshot | null = null;

    try {
      // Wire a real evaluator with a mocked walk-forward evaluator
      const { walkForwardEvaluator: mockEvaluator } = createMockWalkForwardEvaluator(ctx);
      const dataProvider = new FakeDataProvider();
      const marketProfile = new FakeMarketProfile();
      const artifactWriter = new ResearchArtifactWriter();

      const evaluator = new HypothesisResearchEvaluator({
        db: ctx.db,
        dataProvider,
        marketProfile,
        hypothesisRepo: ctx.hypothesisRepo,
        walkForwardRepo: ctx.walkForwardRepo,
        artifactWriter,
        walkForwardEvaluator: mockEvaluator,
      });

      const svcEval = createProofGenerationService(ctx, { evaluator });
      const evalGraphJson = JSON.stringify(evalGraph());

      const evalFetchRestore = setMockFetchResponse(evalGraphJson);
      let acceptedResult;
      try {
        acceptedResult = await svcEval.generate({
          instruction: 'Generate a hypothesis with evaluation.',
          marketId: 'INDIA_NSE_EQ',
          skipEvaluation: false,
        });
      } finally {
        evalFetchRestore();
      }

      if (acceptedResult.kind === 'accepted') {
        acceptedAttemptId = acceptedResult.attempt.id;
        acceptedHypothesisId = acceptedResult.hypothesis.id;
        acceptedEvalId = acceptedResult.evaluation?.evaluation?.id ?? 0;

        // Reload the attempt from DB to get post-linkage state — the service
        // captures the attempt object before updating hypothesisEvaluationId.
        const reloadedAttempt = ctx.generationRepo.getByIdWithReasons(acceptedResult.attempt.id);

        // Assemble lineage for the accepted hash
        if (acceptedResult.attempt.canonicalHash) {
          acceptedLineage = ctx.auditService.assembleLineage(
            acceptedResult.attempt.canonicalHash,
          );
        }

        assert(
          'Phase3: accepted result kind is accepted',
          acceptedResult.kind === 'accepted',
          `kind=${acceptedResult.kind}`,
        );
        assert(
          'Phase3: accepted attempt verdict is Accepted',
          acceptedResult.attempt.verdict === GenerationVerdict.Accepted,
          `verdict=${acceptedResult.attempt.verdict}`,
        );
        assert(
          'Phase3: accepted attempt has id > 0',
          acceptedResult.attempt.id > 0,
          `id=${acceptedResult.attempt.id}`,
        );
        assert(
          'Phase3: accepted attempt has no reasons',
          acceptedResult.attempt.reasons.length === 0,
          `reasons.length=${acceptedResult.attempt.reasons.length}`,
        );
        assert(
          'Phase3: accepted attempt has canonicalHash',
          acceptedResult.attempt.canonicalHash !== null,
          'null canonicalHash',
        );
        assert(
          'Phase3: accepted attempt has hypothesisGraphId',
          acceptedResult.attempt.hypothesisGraphId !== null,
          'null hypothesisGraphId',
        );
        assert(
          'Phase3: accepted attempt has hypothesisEvaluationId in DB',
          reloadedAttempt != null && reloadedAttempt.hypothesisEvaluationId !== null,
          `reloaded.hypothesisEvaluationId=${reloadedAttempt?.hypothesisEvaluationId}`,
        );
        assert(
          'Phase3: hypothesis was validated and persisted',
          acceptedResult.hypothesis.id > 0,
          `id=${acceptedResult.hypothesis.id}`,
        );
        assert(
          'Phase3: evaluation completed with a status',
          acceptedResult.evaluation !== null
            && ['completed', 'failed'].includes(acceptedResult.evaluation.evaluation.status),
          `eval=${acceptedResult.evaluation?.evaluation?.status ?? 'null'}`,
        );
        assert(
          'Phase3: contextProvenance.providerUrl matches proof config (real ingress)',
          acceptedResult.attempt.contextProvenance.providerUrl === PROOF_PROVIDER_CONFIG.providerUrl,
          `url=${acceptedResult.attempt.contextProvenance.providerUrl}`,
        );
      } else {
        // If the service returned non-accepted, report what happened
        assert('Phase3: accepted result kind is accepted', false, `got kind=${acceptedResult.kind}`);
      }
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
        'malformed/rejected (via HypothesisGenerationService.generate() with mocked provider returning non-JSON)',
        'skipped/duplicate (via HypothesisGenerationService.generate() — first accept, then duplicate-skip)',
        'accepted with evaluation (via HypothesisGenerationService.generate() through real validator + evaluator)',
      ],
      evidenceBlocks: {
        malformedGeneration: {
          attemptId: ctx.db.prepare(
            "SELECT id FROM hypothesis_generation_attempts WHERE verdict = 'rejected' LIMIT 1"
          ).get() as { id: number } | undefined,
          reasonsPopulated: getAssertions().find(a => a.name.includes('malformed attempt has reasons'))?.pass ?? false,
          nullLinkage: getAssertions().find(a => a.name.includes('null hypothesisGraphId'))?.pass ?? false,
          ingressVerified: getAssertions().find(
            a => a.name.includes('contextProvenance.providerUrl matches proof config')
              && a.name.startsWith('Phase1')
          )?.pass ?? false,
        },
        skippedGeneration: {
          attemptId: ctx.db.prepare(
            "SELECT id FROM hypothesis_generation_attempts WHERE verdict = 'skipped' LIMIT 1"
          ).get() as { id: number } | undefined,
          reasonsPopulated: getAssertions().find(a => a.name.includes('skipped attempt has reasons'))?.pass ?? false,
          nullLinkage: getAssertions().find(a => a.name.includes('skipped attempt has null hypothesisGraphId'))?.pass ?? false,
          ingressVerified: getAssertions().find(
            a => a.name.includes('contextProvenance.providerUrl matches proof config')
              && a.name.startsWith('Phase2')
          )?.pass ?? false,
        },
        acceptedGeneration: {
          attemptId: acceptedAttemptId,
          hypothesisId: acceptedHypothesisId,
          evaluationId: acceptedEvalId,
          attemptLinked: acceptedAttemptId > 0,
          hypothesisPersisted: acceptedHypothesisId > 0,
          evaluationCompleted: acceptedEvalId > 0,
          lineageReconstructed: acceptedLineage !== null,
          ingressVerified: getAssertions().find(
            a => a.name.includes('contextProvenance.providerUrl matches proof config')
              && a.name.startsWith('Phase3')
          )?.pass ?? false,
        },
      },
      realIngress: {
        description: 'All three branches exercised through HypothesisGenerationService.generate() with mocked fetch transport. ' +
          'contextProvenance.providerUrl verified against PROOF_PROVIDER_CONFIG for each branch.',
        malformedIngressVerified: getAssertions().find(
          a => a.name.includes('contextProvenance.providerUrl matches proof config') && a.name.startsWith('Phase1')
        )?.pass ?? false,
        skippedIngressVerified: getAssertions().find(
          a => a.name.includes('contextProvenance.providerUrl matches proof config') && a.name.startsWith('Phase2')
        )?.pass ?? false,
        acceptedIngressVerified: getAssertions().find(
          a => a.name.includes('contextProvenance.providerUrl matches proof config') && a.name.startsWith('Phase3')
        )?.pass ?? false,
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
