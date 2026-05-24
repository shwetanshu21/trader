// ── HypothesisGenerationService ──
//
// Calls the configured LLM provider with a hypothesis-generation prompt,
// distinguishes transport failure vs malformed JSON vs non-graph vs
// duplicate-skip vs accepted, persists a typed generation-attempt row
// first (before validation), then runs HypothesisValidator.validateAndPersist()
// and optionally HypothesisResearchEvaluator.evaluate() for accepted graphs.
//
// Reuses the existing provider transport/env seam from ProposalEngine
// and internal strategy-run context for prompt enrichment.
//
// Every provider output path produces a typed HypothesisGenerationResult
// with an already-persisted generation attempt — raw provider output is
// never lost.

import { canonicalizeHypothesis } from './hypothesis-canonicalizer.js';
import { HypothesisValidator, type ValidatorResult } from './hypothesis-validator.js';
import { HypothesisResearchEvaluator } from './hypothesis-evaluator.js';
import { HypothesisGenerationRepository } from '../persistence/hypothesis-generation-repo.js';
import { HypothesisRepository } from '../persistence/hypothesis-repo.js';
import { HypothesisMemoryRepository } from '../persistence/hypothesis-memory-repo.js';
import { StrategyRunRepository } from '../persistence/strategy-run-repo.js';
import { IndiaResearchBuilder } from '../strategy/india-research.js';
import * as crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  GenerationVerdict,
  GenerationReasonCode,
  type GenerationReason,
  type GenerationContextProvenance,
  type HypothesisGenerationResult,
  type HypothesisGenerationConfig,
  type HypothesisGraph,
  type HypothesisGraphRow,
  type HypothesisEvaluationResult,
  type HypothesisGenerationAttemptWithReasons,
  type HypothesisGenerationAttemptRow,
  type ProposalEngineConfig,
} from '../types/runtime.js';
import {
  applyGenerationOutcomeToBudget,
  decideGenerationBudget,
  initialBudgetState,
  type OvernightBudgetPolicy,
  type OvernightBudgetState,
} from './hypothesis-generation-budget.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MARKET_ID = 'INDIA_NSE_EQ';
const DEFAULT_STRATEGY_ID = 'research-hypothesis-generator';
const DEFAULT_PROMPT_VERSION = '1.0.0';
const DEFAULT_MAX_CONTEXT_CANDIDATES = 5;

/**
 * Maximum raw provider output body size in bytes before capping for DB storage.
 * Full output can be reconstructed from hash verification and the preview allows
 * operator inspection without dumping potentially large payloads.
 */
const MAX_RAW_OUTPUT_BYTES = 50_000;

/** Number of characters to retain for the safe display preview. */
const OUTPUT_PREVIEW_CHARS = 2_000;

// ---------------------------------------------------------------------------
// HypothesisGenerationService
// ---------------------------------------------------------------------------

export class HypothesisGenerationService {
  private readonly _db: Database.Database;
  private readonly _config: ProposalEngineConfig;
  private readonly _hypothesisRepo: HypothesisRepository;
  private readonly _generationRepo: HypothesisGenerationRepository;
  private readonly _memoryRepo: HypothesisMemoryRepository;
  private readonly _validator: HypothesisValidator;
  private readonly _evaluator?: HypothesisResearchEvaluator;
  private readonly _strategyRunRepo?: StrategyRunRepository;
  private readonly _indiaResearchBuilder?: IndiaResearchBuilder;
  private _budgetState: OvernightBudgetState;

  constructor(deps: {
    db: Database.Database;
    config: ProposalEngineConfig;
    hypothesisRepo?: HypothesisRepository;
    generationRepo?: HypothesisGenerationRepository;
    memoryRepo?: HypothesisMemoryRepository;
    validator?: HypothesisValidator;
    evaluator?: HypothesisResearchEvaluator;
    strategyRunRepo?: StrategyRunRepository;
    indiaResearchBuilder?: IndiaResearchBuilder;
  }) {
    this._db = deps.db;
    this._config = deps.config;
    this._hypothesisRepo = deps.hypothesisRepo ?? new HypothesisRepository(deps.db);
    this._generationRepo = deps.generationRepo ?? new HypothesisGenerationRepository(deps.db);
    this._memoryRepo = deps.memoryRepo ?? new HypothesisMemoryRepository(deps.db);
    this._validator = deps.validator ?? new HypothesisValidator({
      memoryRepo: this._memoryRepo,
      hypothesisRepo: this._hypothesisRepo,
    });
    this._evaluator = deps.evaluator;
    this._strategyRunRepo = deps.strategyRunRepo;
    this._indiaResearchBuilder = deps.indiaResearchBuilder;
    this._budgetState = initialBudgetState();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Generate a hypothesis by calling the configured LLM provider.
   *
   * Flow:
   *   1. Build bounded context from recent strategy-run candidates and
   *      India research evidence (when wired).
   *   2. Build a structured prompt and call the provider.
   *   3. On transport failure: persist a ProviderError generation attempt
   *      and return `provider_error`.
   *   4. On empty/null response: persist an EmptyResponse attempt and
   *      return `rejected`.
   *   5. On non-JSON response: persist a MalformedResponse attempt and
   *      return `rejected`.
   *   6. On valid JSON that is not a HypothesisGraph shape: persist a
   *      NonGraphResponse attempt and return `rejected`.
   *   7. On a valid HypothesisGraph:
   *      a. Canonicalize the graph.
   *      b. Check for a prior accepted attempt with the same canonical hash.
   *         If found, persist a DuplicateSkipped attempt and return `skipped`.
   *      c. Run HypothesisValidator.validate() — structural + exact-failure
   *         dedupe. If rejected or skipped, persist accordingly.
   *      d. If validated: persist an Accepted generation attempt, then run
   *         validateAndPersist() and optionally evaluate().
   *      e. Return `accepted` with the persisted hypothesis and optional
   *         evaluation result.
   *
   * The generation attempt is ALWAYS persisted first (step 3–7b), before
   * any downstream validation. This ensures raw provider output is never lost.
   *
   * @param config - Generation configuration including instruction text.
   * @returns A typed HypothesisGenerationResult for all provider branches.
   */
  async generate(config: HypothesisGenerationConfig): Promise<HypothesisGenerationResult> {
    return this.generateWithBudget(config);
  }

  async generateWithBudget(
    config: HypothesisGenerationConfig,
    budgetPolicy?: OvernightBudgetPolicy,
  ): Promise<HypothesisGenerationResult> {
    const gate = decideGenerationBudget(budgetPolicy, this._budgetState);
    if (gate.kind === 'skipped') {
      const now = Date.now();
      const attempt = this._persistAttempt({
        verdict: GenerationVerdict.Skipped,
        contextProvenance: this._buildContextProvenance(config, now),
        rawProviderOutput: null,
        rawOutputContentHash: null,
        rawOutputPreview: null,
        canonicalHash: null,
        hypothesisGraphId: null,
        hypothesisEvaluationId: null,
        createdAt: now,
      }, [gate.reason]);

      return {
        kind: 'skipped',
        attempt,
        rawProviderOutput: '',
        reason: gate.reason,
      };
    }

    this._budgetState = gate.state;
    const result = await this._generateInternal(config);
    this._budgetState = applyGenerationOutcomeToBudget(this._budgetState, result.attempt);
    return result;
  }

  getBudgetState(): OvernightBudgetState {
    return { ...this._budgetState };
  }

  resetBudgetState(): void {
    this._budgetState = initialBudgetState();
  }

  private async _generateInternal(config: HypothesisGenerationConfig): Promise<HypothesisGenerationResult> {
    const now = Date.now();

    // ── 1. Build context provenance ─────────────────────────────────────
    const contextProvenance = this._buildContextProvenance(config, now);

    // ── 2. Build prompt and call provider ──────────────────────────────
    const context = this._buildProviderContext(config);
    const payload = this._buildPrompt(config.instruction, context);
    const rawOutput = await this._callProvider(payload, config, now);
    const rawOutputStr = rawOutput.text;

    // ── Cap raw output for durable storage — compute SHA-256 hash on     ──
    //     the full body BEFORE truncating, then cap and derive preview.    ──
    const outputCapping = this._capRawOutput(rawOutputStr);

    // ── 3. Transport failure ──────────────────────────────────────────
    if (rawOutput.error) {
      const reasons: GenerationReason[] = [
        {
          reasonCode: GenerationReasonCode.ProviderError,
          reasonMessage: `Provider transport error: ${rawOutput.error}`,
        },
      ];

      const attempt = this._persistAttempt({
        verdict: GenerationVerdict.Rejected,
        contextProvenance,
        rawProviderOutput: outputCapping.rawProviderOutput,
        rawOutputContentHash: outputCapping.rawOutputContentHash,
        rawOutputPreview: outputCapping.rawOutputPreview,
        canonicalHash: null,
        hypothesisGraphId: null,
        hypothesisEvaluationId: null,
        createdAt: now,
      }, reasons);

      return {
        kind: 'provider_error',
        error: rawOutput.error,
        attempt,
      };
    }

    // ── 4. Empty/null response ────────────────────────────────────────
    if (rawOutputStr == null || rawOutputStr.trim().length === 0) {
      const reasons: GenerationReason[] = [
        {
          reasonCode: GenerationReasonCode.EmptyResponse,
          reasonMessage: 'Provider returned empty or null response.',
        },
      ];

      const attempt = this._persistAttempt({
        verdict: GenerationVerdict.Rejected,
        contextProvenance,
        rawProviderOutput: null,
        rawOutputContentHash: null,
        rawOutputPreview: null,
        canonicalHash: null,
        hypothesisGraphId: null,
        hypothesisEvaluationId: null,
        createdAt: now,
      }, reasons);

      return {
        kind: 'rejected',
        attempt,
        rawProviderOutput: null,
      };
    }

    // ── 5. Parse JSON ─────────────────────────────────────────────────
    let parsed: unknown;
    try {
      parsed = JSON.parse(normalizeJsonLikeText(rawOutputStr));
    } catch {
      const reasons: GenerationReason[] = [
        {
          reasonCode: GenerationReasonCode.MalformedResponse,
          reasonMessage: 'Provider returned output that is not valid JSON.',
        },
      ];

      const attempt = this._persistAttempt({
        verdict: GenerationVerdict.Rejected,
        contextProvenance,
        rawProviderOutput: outputCapping.rawProviderOutput,
        rawOutputContentHash: outputCapping.rawOutputContentHash,
        rawOutputPreview: outputCapping.rawOutputPreview,
        canonicalHash: null,
        hypothesisGraphId: null,
        hypothesisEvaluationId: null,
        createdAt: now,
      }, reasons);

      return {
        kind: 'rejected',
        attempt,
        rawProviderOutput: rawOutputStr,
      };
    }

    // ── 6. Validate as HypothesisGraph ─────────────────────────────────
    if (!isHypothesisGraph(parsed)) {
      const reasons: GenerationReason[] = [
        {
          reasonCode: GenerationReasonCode.NonGraphResponse,
          reasonMessage: 'Provider returned valid JSON that is not a valid hypothesis graph shape. '
            + 'Expected object with schemaVersion, signals, filters, entryRules, exitRules, riskRules arrays.',
        },
      ];

      const attempt = this._persistAttempt({
        verdict: GenerationVerdict.Rejected,
        contextProvenance,
        rawProviderOutput: outputCapping.rawProviderOutput,
        rawOutputContentHash: outputCapping.rawOutputContentHash,
        rawOutputPreview: outputCapping.rawOutputPreview,
        canonicalHash: null,
        hypothesisGraphId: null,
        hypothesisEvaluationId: null,
        createdAt: now,
      }, reasons);

      return {
        kind: 'rejected',
        attempt,
        rawProviderOutput: rawOutputStr,
      };
    }

    const graph = parsed as unknown as HypothesisGraph;

    // ── 7a. Canonicalize ───────────────────────────────────────────────
    let canonical:
      | { canonicalHash: string; canonicalJson: string }
      | null = null;
    try {
      const rec = canonicalizeHypothesis(graph);
      canonical = { canonicalHash: rec.canonicalHash, canonicalJson: rec.canonicalJson };
    } catch {
      // Canonicalization failure — treat as rejected
      const reasons: GenerationReason[] = [
        {
          reasonCode: GenerationReasonCode.NonGraphResponse,
          reasonMessage: 'Provider returned a hypothesis graph that could not be canonicalized.',
        },
      ];

      const attempt = this._persistAttempt({
        verdict: GenerationVerdict.Rejected,
        contextProvenance,
        rawProviderOutput: outputCapping.rawProviderOutput,
        rawOutputContentHash: outputCapping.rawOutputContentHash,
        rawOutputPreview: outputCapping.rawOutputPreview,
        canonicalHash: null,
        hypothesisGraphId: null,
        hypothesisEvaluationId: null,
        createdAt: now,
      }, reasons);

      return {
        kind: 'rejected',
        attempt,
        rawProviderOutput: rawOutputStr,
      };
    }

    // ── 7b. Check for prior accepted duplicate ─────────────────────────
    const priorAccepted = this._generationRepo.getByCanonicalHash(canonical.canonicalHash);

    if (priorAccepted) {
      const reason: GenerationReason = {
        reasonCode: GenerationReasonCode.DuplicateSkipped,
        reasonMessage: `Exact duplicate of prior accepted hypothesis (generation attempt id=${priorAccepted.id}).`,
      };

      const attempt = this._persistAttempt({
        verdict: GenerationVerdict.Skipped,
        contextProvenance,
        rawProviderOutput: outputCapping.rawProviderOutput,
        rawOutputContentHash: outputCapping.rawOutputContentHash,
        rawOutputPreview: outputCapping.rawOutputPreview,
        canonicalHash: canonical.canonicalHash,
        hypothesisGraphId: null,
        hypothesisEvaluationId: null,
        createdAt: now,
      }, [reason]);

      return {
        kind: 'skipped',
        attempt,
        rawProviderOutput: rawOutputStr,
        reason,
      };
    }

    // ── 7c. Run validator (structural + exact-failure dedupe) ──────────
    const validationResult = this._validator.validate(graph);

    switch (validationResult.kind) {
      case 'rejected': {
        // Graph failed structural validation
        const reasons: GenerationReason[] = validationResult.reasons.map(r => ({
          reasonCode: GenerationReasonCode.NonGraphResponse,
          reasonMessage: `Hypothesis validation failed: ${r.reasonMessage}`,
        }));

        const attempt = this._persistAttempt({
          verdict: GenerationVerdict.Rejected,
          contextProvenance,
          rawProviderOutput: outputCapping.rawProviderOutput,
          rawOutputContentHash: outputCapping.rawOutputContentHash,
          rawOutputPreview: outputCapping.rawOutputPreview,
          canonicalHash: canonical.canonicalHash,
          hypothesisGraphId: null,
          hypothesisEvaluationId: null,
          createdAt: now,
        }, reasons);

        return {
          kind: 'rejected',
          attempt,
          rawProviderOutput: rawOutputStr,
        };
      }

      case 'skipped': {
        // Exact-failure match — duplicate of a prior failed/rejected hypothesis
        const reasons: GenerationReason[] = validationResult.reasons.map(r => ({
          reasonCode: GenerationReasonCode.DuplicateSkipped,
          reasonMessage: `Exact failure match: ${r.reasonMessage}`,
        }));

        const attempt = this._persistAttempt({
          verdict: GenerationVerdict.Skipped,
          contextProvenance,
          rawProviderOutput: outputCapping.rawProviderOutput,
          rawOutputContentHash: outputCapping.rawOutputContentHash,
          rawOutputPreview: outputCapping.rawOutputPreview,
          canonicalHash: canonical.canonicalHash,
          hypothesisGraphId: null,
          hypothesisEvaluationId: null,
          createdAt: now,
        }, reasons);

        return {
          kind: 'skipped',
          attempt,
          rawProviderOutput: rawOutputStr,
          reason: reasons[0],
        };
      }

      case 'validated': {
        // ── 7d. Accepted path: persist generation, then validateAndPersist ──
        const persistResult = this._validator.persistResult(graph, validationResult, { now });

        const attempt = this._persistAttempt({
          verdict: GenerationVerdict.Accepted,
          contextProvenance,
          rawProviderOutput: outputCapping.rawProviderOutput,
          rawOutputContentHash: outputCapping.rawOutputContentHash,
          rawOutputPreview: outputCapping.rawOutputPreview,
          canonicalHash: canonical.canonicalHash,
          hypothesisGraphId: persistResult ?? null,
          hypothesisEvaluationId: null,
          createdAt: now,
        }, []);

        // Update linkage if we have a hypothesis graph id
        if (persistResult != null) {
          this._generationRepo.updateLinkage(attempt.id, {
            canonicalHash: canonical.canonicalHash,
            hypothesisGraphId: persistResult,
          });
        }

        // ── 7e. Optionally evaluate ─────────────────────────────────
        let evaluation: HypothesisEvaluationResult | null = null;
        let evaluationError: string | null = null;

        if (this._evaluator && !config.skipEvaluation && persistResult != null) {
          try {
            evaluation = await this._evaluator.evaluate(persistResult);

            // Link evaluation to generation attempt
            if (evaluation && evaluation.evaluation && evaluation.evaluation.id) {
              this._generationRepo.updateLinkage(attempt.id, {
                hypothesisEvaluationId: evaluation.evaluation.id,
              });
            } else if (evaluation && evaluation.evaluation) {
              // Evaluation returned but without a valid id — treat as failure
              evaluationError = `Evaluation returned without a valid hypothesis_evaluation_id. Status: ${evaluation.evaluation.status}. Rationale: ${evaluation.rationale || 'none'}`;
            } else if (evaluation) {
              // Evaluation returned but no evaluation row at all
              evaluationError = 'Evaluation returned without an evaluation row.';
            }
          } catch (err) {
            // Evaluation failure — do NOT silently swallow; surface as
            // accepted_without_evaluation so callers can react with
            // persisted evidence and exit code.
            evaluationError = err instanceof Error
              ? `Evaluation threw: ${err.message}`
              : `Evaluation threw: ${String(err)}`;
          }
        }

        // If evaluation was requested but did not produce a linked
        // hypothesis_evaluation_id, return accepted_without_evaluation
        // instead of accepted. The hypothesis IS persisted but the
        // evaluation linkage is missing — callers (especially CLI) can
        // decide to fail closed with persisted evidence.
        if (evaluationError && persistResult != null) {
          const hypothesis = this._hypothesisRepo.getHypothesisById(persistResult);

          return {
            kind: 'accepted_without_evaluation',
            attempt,
            hypothesis: hypothesis!,
            evaluationError,
          } as const;
        }

        const hypothesis = persistResult != null
          ? this._hypothesisRepo.getHypothesisById(persistResult)
          : null;

        return {
          kind: 'accepted',
          attempt,
          hypothesis: hypothesis!,
          evaluation,
        };
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private — provider transport
  // -----------------------------------------------------------------------

  /**
   * Call the configured LLM provider and return the raw response text.
   *
   * Supports both 'custom' and 'openai-compatible' provider modes.
   * Returns { text: string | null, error: string | null } so the caller
   * always has the raw output (or failure reason) regardless of outcome.
   */
  private async _callProvider(
    promptPayload: Record<string, unknown>,
    _config: HypothesisGenerationConfig,
    _now: number,
  ): Promise<{ text: string | null; error: string | null }> {
    try {
      let responseText: string;

      if (this._config.providerMode === 'openai-compatible') {
        responseText = await this._sendOpenAiRequest(promptPayload);
      } else {
        responseText = await this._sendCustomRequest(promptPayload);
      }

      return { text: responseText, error: null };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { text: null, error: errorMessage };
    }
  }

  /**
   * Send a custom JSON payload to the provider URL.
   * Returns the raw response text.
   */
  private async _sendCustomRequest(payload: Record<string, unknown>): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this._config.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this._config.apiKey) {
        headers['Authorization'] = `Bearer ${this._config.apiKey}`;
      }

      const response = await fetch(this._config.providerUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const statusText = `${response.status} ${response.statusText}`;
        let body = '';
        try { body = await response.text(); } catch { /* ignore */ }
        throw new Error(`Provider returned HTTP ${statusText}${body ? ': ' + body.slice(0, 500) : ''}`);
      }

      return await response.text();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Send an OpenAI-compatible chat completions request.
   * Extracts the assistant content text from the response.
   */
  private async _sendOpenAiRequest(payload: Record<string, unknown>): Promise<string> {
    const models = [
      this._config.providerModel ?? 'default',
      this._config.fallbackProviderModel,
    ].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);

    const errors: string[] = [];
    for (const model of models) {
      try {
        return await this._sendOpenAiRequestWithModel(payload, model);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        errors.push(`${model}: ${errorMessage}`);
      }
    }

    throw new Error(errors.length > 0
      ? `All configured OpenAI-compatible models failed. ${errors.join(' | ')}`
      : 'No OpenAI-compatible model configured.');
  }

  private async _sendOpenAiRequestWithModel(payload: Record<string, unknown>, model: string): Promise<string> {
    // Build an OpenAI-compatible chat completions payload
    const openAiPayload: Record<string, unknown> = {
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a trading strategy research assistant. Generate structured hypothesis graphs for backtesting. Return only valid JSON.',
        },
        {
          role: 'user',
          content: JSON.stringify(payload),
        },
      ],
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this._config.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this._config.apiKey) {
        headers['Authorization'] = `Bearer ${this._config.apiKey}`;
      }

      const response = await fetch(this._config.providerUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(openAiPayload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const statusText = `${response.status} ${response.statusText}`;
        let body = '';
        try { body = await response.text(); } catch { /* ignore */ }
        throw new Error(`Provider returned HTTP ${statusText}${body ? ': ' + body.slice(0, 500) : ''}`);
      }

      const responseText = await response.text();
      const outer = JSON.parse(responseText) as {
        choices?: Array<{
          message?: {
            content?: unknown;
            reasoning_content?: unknown;
            reasoning?: unknown;
          };
        }>;
      };

      const contentText = extractAssistantMessageText(outer.choices?.[0]?.message);
      if (!contentText) {
        throw new Error('OpenAI-compatible response missing assistant content in choices[0].message.content or reasoning fields');
      }

      return contentText;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // -----------------------------------------------------------------------
  // Private — context and prompt building
  // -----------------------------------------------------------------------

  /** Build context provenance for the generation attempt. */
  private _buildContextProvenance(
    config: HypothesisGenerationConfig,
    now: number,
  ): GenerationContextProvenance {
    return {
      providerUrl: this._config.providerUrl,
      providerModel: this._config.providerModel ?? null,
      promptVersion: config.promptVersion ?? DEFAULT_PROMPT_VERSION,
      triggeredAt: now,
      marketId: config.marketId ?? DEFAULT_MARKET_ID,
      strategyId: config.strategyId ?? DEFAULT_STRATEGY_ID,
    };
  }

  /**
   * Build bounded internal context from strategy-run candidates and India
   * research evidence for prompt enrichment.
   */
  private _buildProviderContext(
    config: HypothesisGenerationConfig,
  ): Record<string, unknown> {
    const context: Record<string, unknown> = {};

    // Load recent strategy-run candidates when the repo is wired
    if (this._strategyRunRepo) {
      const maxCandidates = config.maxContextCandidates ?? DEFAULT_MAX_CONTEXT_CANDIDATES;
      const recentRuns = this._strategyRunRepo.getRecentRuns(1);

      if (recentRuns.length > 0) {
        const latestRun = recentRuns[0];
        const limitedCandidates = latestRun.candidates.slice(0, maxCandidates);

        const candidateSummaries = limitedCandidates.map(c => ({
          exchange: c.exchange,
          tradingsymbol: c.tradingsymbol,
          instrumentType: c.instrumentType,
          side: c.side,
          lastPrice: c.lastPrice,
          volume: c.volume,
          deterministicScore: c.deterministicScore,
          mergedScore: c.mergedScore,
          llmStatus: c.llmStatus,
          rank: c.rank,
        }));

        context.recentCandidates = candidateSummaries;
        context.runId = latestRun.id;
        context.runFramework = latestRun.frameworkConfig;

        // Include India research evidence when available and builder is wired
        if (this._indiaResearchBuilder && limitedCandidates.length > 0) {
          // Build bounded candidates for India research
          const boundedCandidates = limitedCandidates.map(c => ({
            exchange: c.exchange,
            tradingsymbol: c.tradingsymbol,
            instrumentToken: c.instrumentToken,
            side: c.side as 'buy' | 'sell',
            lastPrice: c.lastPrice,
            bid: c.bid,
            ask: c.ask,
            volume: c.volume,
            instrumentType: c.instrumentType,
            lotSize: c.lotSize,
            tickSize: c.tickSize,
            expiry: c.expiry,
            strike: c.strike,
            freezeQuantity: c.freezeQuantity,
          }));

          const indiaEvidence = this._indiaResearchBuilder.build(boundedCandidates as any);
          const evidenceSummaries: Array<{
            candidateKey: string;
            summary: string;
            tags: string[];
            influenceScore: number | null;
          }> = [];

          for (const [key, ev] of indiaEvidence) {
            evidenceSummaries.push({
              candidateKey: key,
              summary: ev.summary,
              tags: ev.tags,
              influenceScore: ev.influenceScore,
            });
          }

          context.indiaResearchEvidence = evidenceSummaries;
        }
      }
    }

    return context;
  }

  /**
   * Build the generation prompt payload.
   *
   * Combines the instruction text with bounded internal context into a
   * structured JSON payload for the provider.
   */
  private _buildPrompt(
    instruction: string,
    context: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      version: '1.0',
      task: 'generate_hypothesis',
      instruction,
      context: Object.keys(context).length > 0 ? context : undefined,
      outputFormat: {
        description: 'Return a single JSON object representing a trading strategy hypothesis graph.',
        schema: {
          schemaVersion: 'string (e.g. "1")',
          signals: 'array of rule objects (signal-generation rules)',
          filters: 'array of rule objects (candidate filtering rules)',
          entryRules: 'array of rule objects (entry rules)',
          exitRules: 'array of rule objects (exit rules)',
          riskRules: 'array of rule objects (risk rules)',
          metadata: 'optional object with additional context',
        },
        ruleSchema: {
          type: 'string (machine-readable, e.g. "ema_cross", "volume_min", "atr_stop")',
          params: 'object with rule-specific parameters',
        },
      },
    };
  }

  // -----------------------------------------------------------------------
  // Private — persistence helper
  // -----------------------------------------------------------------------

  /**
   * Persist a generation attempt with its reasons atomically.
   *
   * Used by every provider branch to ensure raw provider output is never
   * lost before downstream validation.
   */
  private _persistAttempt(
    attemptData: {
      verdict: GenerationVerdict;
      contextProvenance: GenerationContextProvenance;
      rawProviderOutput: string | null;
      rawOutputContentHash: string | null;
      rawOutputPreview: string | null;
      canonicalHash: string | null;
      hypothesisGraphId: number | null;
      hypothesisEvaluationId: number | null;
      createdAt: number;
    },
    reasons: GenerationReason[],
  ): HypothesisGenerationAttemptWithReasons {
    return this._generationRepo.insertAttemptWithReasons(
      {
        verdict: attemptData.verdict,
        contextProvenance: attemptData.contextProvenance,
        rawProviderOutput: attemptData.rawProviderOutput,
        rawOutputContentHash: attemptData.rawOutputContentHash,
        rawOutputPreview: attemptData.rawOutputPreview,
        canonicalHash: attemptData.canonicalHash,
        hypothesisGraphId: attemptData.hypothesisGraphId,
        hypothesisEvaluationId: attemptData.hypothesisEvaluationId,
        createdAt: attemptData.createdAt,
      },
      reasons,
    );
  }

  /**
   * Cap a raw provider output string for durable storage.
   *
   * Computes the SHA-256 hex digest of the FULL (untruncated) body first,
   * then truncates the body at MAX_RAW_OUTPUT_BYTES and derives a safe
   * display preview (first OUTPUT_PREVIEW_CHARS chars).
   *
   * When the input is null (transport failure with no body), returns null
   * for all three fields.
   */
  private _capRawOutput(raw: string | null): {
    rawProviderOutput: string | null;
    rawOutputContentHash: string | null;
    rawOutputPreview: string | null;
  } {
    if (raw == null) {
      return { rawProviderOutput: null, rawOutputContentHash: null, rawOutputPreview: null };
    }

    // SHA-256 of the full body (computed BEFORE truncation)
    const hash = crypto.createHash('sha256').update(raw, 'utf-8').digest('hex');

    // Cap the stored body
    const capped = raw.length > MAX_RAW_OUTPUT_BYTES
      ? raw.slice(0, MAX_RAW_OUTPUT_BYTES)
      : raw;

    // Safe display preview
    const preview = raw.length > OUTPUT_PREVIEW_CHARS
      ? raw.slice(0, OUTPUT_PREVIEW_CHARS)
      : raw;

    return {
      rawProviderOutput: capped,
      rawOutputContentHash: hash,
      rawOutputPreview: preview,
    };
  }
}

// ---------------------------------------------------------------------------
// Helper: validate parsed JSON as a HypothesisGraph shape
// ---------------------------------------------------------------------------

/**
 * Check whether a parsed JSON value is a structurally valid HypothesisGraph.
 *
 * This is a shape check only — it verifies the required keys exist and are
 * arrays. Full structural validation (rule groups non-empty, per-rule-node
 * validity) is performed by HypothesisValidator.
 */
function isHypothesisGraph(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  // schemaVersion must be a string
  if (typeof obj.schemaVersion !== 'string' || obj.schemaVersion.length === 0) {
    return false;
  }

  // Required rule groups must be arrays
  const requiredGroups = ['signals', 'filters', 'entryRules', 'exitRules', 'riskRules'];
  for (const group of requiredGroups) {
    if (!Array.isArray(obj[group])) {
      return false;
    }
  }

  return true;
}

/**
 * Extract text content from an OpenAI-compatible assistant content field.
 * Supports string content and content arrays (text parts).
 */
function extractAssistantContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map(part => {
        if (typeof part === 'string') return part;
        if (
          part
          && typeof part === 'object'
          && 'type' in part
          && (part as { type?: unknown }).type === 'text'
          && 'text' in part
        ) {
          const value = (part as { text?: unknown }).text;
          return typeof value === 'string' ? value : '';
        }
        return '';
      })
      .join('')
      .trim();
    return text || null;
  }

  return null;
}

function extractAssistantMessageText(message: unknown): string | null {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const contentText = extractAssistantContent((message as { content?: unknown }).content);
  if (contentText) {
    return contentText;
  }

  const reasoningText = extractAssistantContent((message as { reasoning_content?: unknown }).reasoning_content);
  if (reasoningText) {
    return reasoningText;
  }

  const alternateReasoningText = extractAssistantContent((message as { reasoning?: unknown }).reasoning);
  if (alternateReasoningText) {
    return alternateReasoningText;
  }

  return null;
}

function normalizeJsonLikeText(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed;
}
