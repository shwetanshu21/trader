// ── Strategy Framework — pluggable screening and ranking coordinator ──
//
// The framework defines the contract layer between the runtime and
// strategy plugins. The StrategyCoordinator accepts already-bounded
// instrument+quote entries (BoundedCandidate[]), runs one or more
// StrategyPlugin instances, groups results by candidate identity,
// computes hybrid scoring evidence, applies deterministic tie-breaking
// and max-candidate limits, and returns a normalized HybridCoordinatorResult
// with auditable per-candidate plugin evidence.
//
// Plugin lifecycle:
//   1. Coordinator receives bounded candidates (filtered through eligible
//      universe, with quote snapshots attached).
//   2. Each sync plugin independently scores/ranks the full candidate set.
//   3. Coordinator detects plugins that support async evaluation (e.g. LLM)
//      and calls their evaluateAsync() for enriched scoring.
//   4. Coordinator groups results by candidate identity (exchange:tradingsymbol),
//      one record per unique candidate with all plugin evidence aggregated.
//   5. Coordinator caps to maxCandidates and returns hybrid evidence.
//
// Plugin errors are non-fatal: a failing plugin is skipped, its error
// is recorded in pluginErrors, and remaining plugins still contribute.

import {
  LLMStatus,
  MergePolicy,
  DEFAULT_GOVERNANCE_THRESHOLDS,
  type BoundedCandidate,
  type RankedCandidate,
  type CoordinatorResult,
  type StrategyPlugin,
  type StrategyPluginIdentity,
  type StrategyFrameworkConfig,
  type HybridCoordinatorResult,
  type HybridCandidateEvidence,
  type PluginScoreEvidence,
} from '../types/runtime.js';
import type { LlmEvaluationResult } from './llm-ranking-strategy.js';

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_FRAMEWORK_CONFIG: StrategyFrameworkConfig = {
  maxCandidates: 5,
  parallelPlugins: true,
  promotion: { ...DEFAULT_GOVERNANCE_THRESHOLDS },
};

// ---------------------------------------------------------------------------
// StrategyCoordinator
// ---------------------------------------------------------------------------

export class StrategyCoordinator {
  private readonly _plugins: StrategyPlugin[];
  private readonly _config: StrategyFrameworkConfig;

  constructor(
    plugins: StrategyPlugin[],
    config?: Partial<StrategyFrameworkConfig>,
  ) {
    this._plugins = plugins;
    this._config = { ...DEFAULT_FRAMEWORK_CONFIG, ...config };
  }

  /** Return a copy of the current config (for inspection). */
  get config(): StrategyFrameworkConfig {
    return { ...this._config };
  }

  /** Return the registered plugin identities (copy). */
  get plugins(): StrategyPluginIdentity[] {
    return this._plugins.map(p => ({ ...p.identity }));
  }

  /**
   * Evaluate bounded candidates through all registered plugins and produce
   * grouped hybrid scoring evidence.
   *
   * Algorithm:
   * 1. Run each sync plugin's evaluate() on the full candidate set.
   * 2. Run async evaluate on plugins that support it (e.g. LLM ranking).
   * 3. Collect all per-plugin scores and group by candidate identity.
   * 4. For each group, build HybridCandidateEvidence with:
   *    - Individual plugin score evidence (component scores)
   *    - Aggregated deterministic score (mean of non-LLM scores)
   *    - LLM status/score/rationale (if an LLM plugin participated)
   *    - Final merged score using policy (Average if LLM consulted, DeterministicOnly otherwise)
   * 5. Sort by mergedScore descending.
   * 6. Cap to maxCandidates.
   * 7. Return HybridCoordinatorResult.
   *
   * Merge policy:
   *  - When LLM was consulted: mergedScore = (deterministicScore + llmScore) / 2
   *  - When LLM was skipped/degraded/error: mergedScore = deterministicScore
   *
   * Deterministic secondary ordering:
   *   - By exchange (alphabetical)
   *   - By tradingsymbol (alphabetical)
   *
   * Plugin errors: caught individually, logged in pluginErrors,
   * evaluation continues with remaining plugins.
   */
  async evaluate(candidates: BoundedCandidate[]): Promise<HybridCoordinatorResult> {
    const startedAt = Date.now();
    const pluginErrors: Record<string, string> = {};
    const allRanked: RankedCandidate[] = [];
    let llmResult: LlmEvaluationResult | null = null;

    if (this._plugins.length === 0) {
      return {
        candidates: [],
        plugins: [],
        totalEvaluated: 0,
        hasPluginErrors: false,
        pluginErrors: {},
        durationMs: Date.now() - startedAt,
      };
    }

    // ── Phase 1: Run sync plugins ──
    if (this._config.parallelPlugins) {
      const results = await Promise.allSettled(
        this._plugins.map(plugin => this._safeEvaluate(plugin, candidates)),
      );

      for (let i = 0; i < results.length; i++) {
        const plugin = this._plugins[i];
        const result = results[i];

        if (result.status === 'fulfilled') {
          allRanked.push(...result.value);
        } else {
          pluginErrors[plugin.identity.id] = result.reason?.message ?? String(result.reason);
        }
      }
    } else {
      for (const plugin of this._plugins) {
        try {
          const ranked = await this._safeEvaluate(plugin, candidates);
          allRanked.push(...ranked);
        } catch (err) {
          pluginErrors[plugin.identity.id] = err instanceof Error ? err.message : String(err);
        }
      }
    }

    // ── Phase 2: Run async evaluation on plugins that support it ──
    // Check for async-evaluation-capable plugins (e.g. LlmRankingStrategy).
    // We detect these by checking if the plugin has an evaluateAsync method.
    for (const plugin of this._plugins) {
      const asyncPlugin = (plugin as unknown) as { evaluateAsync?: (candidates: BoundedCandidate[]) => Promise<LlmEvaluationResult> };
      if (typeof asyncPlugin.evaluateAsync === 'function') {
        try {
          llmResult = await asyncPlugin.evaluateAsync(candidates);
        } catch (err) {
          // If async evaluation fails entirely, preserve the sync results
          const errMsg = err instanceof Error ? err.message : String(err);
          pluginErrors[plugin.identity.id] = pluginErrors[plugin.identity.id]
            ? `${pluginErrors[plugin.identity.id]}; async error: ${errMsg}`
            : `Async evaluation error: ${errMsg}`;
        }
      }
    }

    // ── Phase 3: Group by candidate identity ──
    const groups = this._groupByCandidateKey(allRanked, llmResult);

    // ── Phase 4: Build hybrid evidence for each group ──
    const evidenceList = this._buildHybridEvidence(groups, llmResult);

    // ── Phase 5: Sort by mergedScore descending, exchange, symbol ──
    evidenceList.sort((a, b) => {
      if (b.mergedScore !== a.mergedScore) return b.mergedScore - a.mergedScore;
      const exchCmp = a.candidate.exchange.localeCompare(b.candidate.exchange);
      if (exchCmp !== 0) return exchCmp;
      return a.candidate.tradingsymbol.localeCompare(b.candidate.tradingsymbol);
    });

    // ── Phase 6: Cap to maxCandidates ──
    const capped = evidenceList.slice(0, this._config.maxCandidates);

    const elapsed = Date.now() - startedAt;

    return {
      candidates: capped,
      plugins: this._plugins.map(p => ({ ...p.identity })),
      totalEvaluated: candidates.length,
      hasPluginErrors: Object.keys(pluginErrors).length > 0,
      pluginErrors,
      durationMs: elapsed,
    };
  }

  /**
   * Group ranked candidates by their candidate identity key (exchange:tradingsymbol).
   *
   * Returns a Map where each key maps to all RankedCandidate entries from
   * sync plugins that scored that candidate.
   */
  private _groupByCandidateKey(
    allRanked: RankedCandidate[],
    _llmResult: LlmEvaluationResult | null,
  ): Map<string, RankedCandidate[]> {
    const groups = new Map<string, RankedCandidate[]>();

    for (const ranked of allRanked) {
      const key = `${ranked.candidate.exchange}:${ranked.candidate.tradingsymbol}`;
      const existing = groups.get(key);
      if (existing) {
        existing.push(ranked);
      } else {
        groups.set(key, [ranked]);
      }
    }

    return groups;
  }

  /**
   * Build HybridCandidateEvidence entries from grouped sync scores and
   * optional async LLM evaluation results.
   */
  private _buildHybridEvidence(
    groups: Map<string, RankedCandidate[]>,
    llmResult: LlmEvaluationResult | null,
  ): HybridCandidateEvidence[] {
    const evidenceList: HybridCandidateEvidence[] = [];

    // Build a lookup of LLM rankings by candidate key for quick access
    const llmRankingMap = new Map<string, RankedCandidate>();
    const llmPluginId = 'llm-ranking-v1';
    if (llmResult) {
      for (const r of llmResult.rankings) {
        const key = `${r.candidate.exchange}:${r.candidate.tradingsymbol}`;
        llmRankingMap.set(key, r);
      }
    }

    for (const [candidateKey, rankings] of groups) {
      if (rankings.length === 0) continue;

      // Use the first candidate as the reference (all entries for same key share candidate data)
      const candidate = rankings[0].candidate;

      // Separate LLM scores from deterministic plugin scores
      const llmRanking = llmRankingMap.get(candidateKey);
      const deterministicScores = rankings.filter(r => r.plugin.id !== llmPluginId);

      // Build plugin score evidence from deterministic plugins only
      const pluginScores: PluginScoreEvidence[] = deterministicScores.map(r => ({
        plugin: { ...r.plugin },
        score: r.score,
        rationale: r.rationale,
        metadata: r.metadata ? { ...r.metadata } : undefined,
      }));

      // Also add LLM plugin's score as a separate plugin evidence if available
      if (llmRanking) {
        pluginScores.push({
          plugin: { ...llmRanking.plugin },
          score: llmRanking.score,
          rationale: llmRanking.rationale,
          metadata: llmRanking.metadata ? { ...llmRanking.metadata } : undefined,
        });
      }

      // Compute deterministic aggregate score (average of non-LLM plugin scores)
      const deterministicScore = deterministicScores.length > 0
        ? deterministicScores.reduce((sum, r) => sum + r.score, 0) / deterministicScores.length
        : 0;

      // Extract LLM evidence
      let llmScore: number | null = null;
      let llmStatus: LLMStatus = LLMStatus.Skipped;
      let llmRationale: string | null = null;
      let proposalParams: Record<string, unknown> | undefined;

      if (llmResult) {
        llmStatus = llmResult.llmStatus;
        llmRationale = llmResult.llmRationale;

        // Only use per-candidate LLM scores if the LLM was actually consulted
        // AND returned a score for this specific candidate.
        // (Error/Degraded states return fallback rankings, not true LLM scores.)
        // Candidates not individually ranked by the LLM get llmScore=null so the
        // merge falls through to DeterministicOnly for that specific candidate.
        if (llmStatus === LLMStatus.Consulted && llmRanking) {
          llmScore = llmRanking.score;
          llmRationale = llmRanking.rationale;
          if (llmRanking.metadata?.proposalParams) {
            proposalParams = llmRanking.metadata.proposalParams as Record<string, unknown>;
          }
        }
      }

      // Compute merged score based on LLM status
      let mergedScore: number;
      let mergePolicy: MergePolicy;

      if (llmStatus === LLMStatus.Consulted && llmScore != null) {
        // LLM was consulted and returned a score: use Average merge
        mergedScore = (deterministicScore + llmScore) / 2;
        mergePolicy = MergePolicy.Average;
      } else if (llmStatus === LLMStatus.Degraded || llmStatus === LLMStatus.Error) {
        // LLM degraded/error: use DeterministicOnly, but mark the policy
        if (deterministicScores.length > 0) {
          mergedScore = deterministicScore;
          mergePolicy = MergePolicy.DeterministicOnly;
        } else {
          // No deterministic scores either — use 0
          mergedScore = 0;
          mergePolicy = MergePolicy.DeterministicOnly;
        }
      } else {
        // LLM was skipped or no LLM configured: use DeterministicOnly
        mergedScore = deterministicScore;
        mergePolicy = MergePolicy.DeterministicOnly;
      }

      evidenceList.push({
        candidate,
        candidateKey,
        pluginScores,
        deterministicScore,
        llmScore,
        llmStatus,
        llmRationale,
        mergedScore,
        mergePolicy,
        proposalParams,
        hasPluginErrors: false, // Plugin errors are tracked at coordinator level
        pluginErrors: {},
      });
    }

    return evidenceList;
  }

  /**
   * Legacy evaluate method returning CoordinatorResult for backward compat.
   *
   * Runs the same evaluation but returns flat ranked candidates with the old
   * CoordinatorResult shape. New code should prefer evaluate() which returns
   * grouped hybrid evidence.
   *
   * @deprecated Use evaluate() which returns HybridCoordinatorResult.
   */
  async evaluateLegacy(candidates: BoundedCandidate[]): Promise<CoordinatorResult> {
    const hybridResult = await this.evaluate(candidates);

    // Flatten hybrid evidence back to ranked candidates (one per plugin score)
    const flatCandidates: RankedCandidate[] = [];
    for (const evidence of hybridResult.candidates) {
      for (const ps of evidence.pluginScores) {
        flatCandidates.push({
          candidate: evidence.candidate,
          plugin: ps.plugin,
          score: evidence.mergedScore,
          rationale: ps.rationale,
          metadata: ps.metadata,
        });
      }
    }

    return {
      candidates: flatCandidates,
      plugins: hybridResult.plugins,
      totalEvaluated: hybridResult.totalEvaluated,
      hasPluginErrors: hybridResult.hasPluginErrors,
      pluginErrors: hybridResult.pluginErrors,
      durationMs: hybridResult.durationMs,
    };
  }

  /**
   * Safely invoke a plugin's evaluate method, returning its results
   * or throwing if the plugin itself throws synchronously.
   */
  private async _safeEvaluate(
    plugin: StrategyPlugin,
    candidates: BoundedCandidate[],
  ): Promise<RankedCandidate[]> {
    // The plugin's evaluate() is synchronous per the contract,
    // but we wrap in Promise to handle both sync and async plugins.
    const results = await Promise.resolve(plugin.evaluate(candidates));
    return results ?? [];
  }
}
