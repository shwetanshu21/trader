// ── Strategy Coordinator Factory ──
//
// Canonical construction seam for the pluggable ranking coordinator.
// Used by both runtime (live scheduler) and replay (offline) paths to
// ensure consistent plugin assembly and configuration.
//
// Always includes a deterministic screener plugin for truthful fallback
// behavior. Optionally includes the LLM ranking plugin when a proposal
// engine (with a configured provider) is available.
//
// See also: src/strategy/deterministic-screener-plugin.ts
//           src/strategy/llm-ranking-strategy.ts
//           src/strategy/framework.ts

import { StrategyCoordinator } from './framework.js';
import { DeterministicScreenerPlugin } from './deterministic-screener-plugin.js';
import { LlmRankingStrategy } from './llm-ranking-strategy.js';
import type { ProposalEngine } from '../proposals/proposal-engine.js';

// ---------------------------------------------------------------------------
// CoordinatorFactoryOptions
// ---------------------------------------------------------------------------

export interface CoordinatorFactoryOptions {
  /** Proposal engine for LLM-enhanced ranking (optional).
   *  When provided, the LLM ranking plugin is included in the coordinator.
   *  When absent, only deterministic scoring is used and LLM evidence
   *  surfaces as LLMStatus.Skipped in persisted strategy-run rows. */
  proposalEngine?: ProposalEngine;

  /** Maximum candidates to output (default: 5). */
  maxCandidates?: number;

  /** Whether to run plugins in parallel (default: true). */
  parallelPlugins?: boolean;
}

// ---------------------------------------------------------------------------
// createStrategyCoordinator — canonical factory
// ---------------------------------------------------------------------------

/**
 * Build the canonical strategy coordinator with consistent plugin assembly.
 *
 * The coordinator always includes the DeterministicScreenerPlugin for
 * truthful fallback behavior. When a `proposalEngine` is provided, the
 * LlmRankingStrategy plugin is also included (for LLM-enhanced scoring).
 *
 * This is the single seam that runtime and replay should use instead of
 * open-coding plugin construction with `new StrategyCoordinator(...)`.
 *
 * @param options - Optional factory configuration.
 * @returns A fully-assembled StrategyCoordinator.
 */
export function createStrategyCoordinator(
  options?: CoordinatorFactoryOptions,
): StrategyCoordinator {
  const {
    proposalEngine,
    maxCandidates = 5,
    parallelPlugins = true,
  } = options ?? {};

  const plugins = [new DeterministicScreenerPlugin()];

  if (proposalEngine) {
    plugins.push(new LlmRankingStrategy(proposalEngine));
  }

  return new StrategyCoordinator(plugins, { maxCandidates, parallelPlugins });
}
