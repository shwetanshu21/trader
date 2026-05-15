// ── Strategy Framework — pluggable screening and ranking coordinator ──
//
// The framework defines the contract layer between the runtime and
// strategy plugins. The StrategyCoordinator accepts already-bounded
// instrument+quote entries (BoundedCandidate[]), runs one or more
// StrategyPlugin instances, applies deterministic ordering and
// max-candidate limits, and returns a normalized CoordinatorResult
// that downstream slices can adapt to NewProposalAttempt without
// touching persistence semantics.
//
// Plugin lifecycle:
//   1. Coordinator receives bounded candidates (filtered through eligible
//      universe, with quote snapshots attached).
//   2. Each plugin independently scores/ranks the full candidate set.
//   3. Coordinator merges results with deterministic tie-breaking
//      (by plugin order, then score, then symbol alphabetically).
//   4. Coordinator caps to maxCandidates and returns the result.
//
// Plugin errors are non-fatal: a failing plugin is skipped, its error
// is recorded in pluginErrors, and remaining plugins still contribute.

import {
  type BoundedCandidate,
  type RankedCandidate,
  type CoordinatorResult,
  type StrategyPlugin,
  type StrategyPluginIdentity,
  type StrategyFrameworkConfig,
} from '../types/runtime.js';

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_FRAMEWORK_CONFIG: StrategyFrameworkConfig = {
  maxCandidates: 5,
  parallelPlugins: true,
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
   * Evaluate bounded candidates through all registered plugins.
   *
   * Algorithm:
   * 1. Run each plugin's evaluate() on the full candidate set.
   * 2. Collect results, merging deterministic tie-breaking order.
   * 3. Cap to maxCandidates.
   * 4. Return CoordinatorResult with aggregated metadata.
   *
   * Deterministic ordering:
   *   - By score (descending)
   *   - By plugin index (stable insertion order)
   *   - By exchange (alphabetical)
   *   - By tradingsymbol (alphabetical)
   *
   * Plugin errors: caught individually, logged in pluginErrors,
   * evaluation continues with remaining plugins.
   */
  async evaluate(candidates: BoundedCandidate[]): Promise<CoordinatorResult> {
    const startedAt = Date.now();
    const allRanked: RankedCandidate[] = [];
    const pluginErrors: Record<string, string> = {};
    const seenPluginIds = new Set<string>();

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

    // Run plugins
    if (this._config.parallelPlugins) {
      const results = await Promise.allSettled(
        this._plugins.map(plugin => this._safeEvaluate(plugin, candidates)),
      );

      for (let i = 0; i < results.length; i++) {
        const plugin = this._plugins[i];
        seenPluginIds.add(plugin.identity.id);
        const result = results[i];

        if (result.status === 'fulfilled') {
          allRanked.push(...result.value);
        } else {
          pluginErrors[plugin.identity.id] = result.reason?.message ?? String(result.reason);
        }
      }
    } else {
      for (const plugin of this._plugins) {
        seenPluginIds.add(plugin.identity.id);
        try {
          const ranked = await this._safeEvaluate(plugin, candidates);
          allRanked.push(...ranked);
        } catch (err) {
          pluginErrors[plugin.identity.id] = err instanceof Error ? err.message : String(err);
        }
      }
    }

    // Deterministic sort:
    // 1. Score descending (highest first)
    // 2. Plugin insertion order (stable index)
    // 3. Exchange alphabetical
    // 4. Tradingsymbol alphabetical
    const pluginOrder = new Map(
      this._plugins.map((p, i) => [p.identity.id, i]),
    );

    allRanked.sort((a, b) => {
      // Score descending
      if (b.score !== a.score) return b.score - a.score;

      // Plugin insertion order
      const aPluginIdx = pluginOrder.get(a.plugin.id) ?? 0;
      const bPluginIdx = pluginOrder.get(b.plugin.id) ?? 0;
      if (aPluginIdx !== bPluginIdx) return aPluginIdx - bPluginIdx;

      // Exchange alphabetical
      const exchCmp = a.candidate.exchange.localeCompare(b.candidate.exchange);
      if (exchCmp !== 0) return exchCmp;

      // Tradingsymbol alphabetical
      return a.candidate.tradingsymbol.localeCompare(b.candidate.tradingsymbol);
    });

    // Cap to maxCandidates
    const capped = allRanked.slice(0, this._config.maxCandidates);

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
