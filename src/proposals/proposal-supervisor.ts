// ── ProposalSupervisor — TickWork hook that orchestrates proposal generation ──
// Runs on every scheduler tick: acquires the in-flight guard, reads market
// context, builds bounded candidates via the eligible universe, runs them
// through the pluggable strategy coordinator, validates each ranked candidate
// deterministically, and persists every outcome (accepted, refused, timeout,
// malformed, missing config, or overlap skip).
//
// Overlapping scheduler ticks cannot execute concurrent proposal generations.
// The in-flight guard ensures only one run at a time; concurrent ticks skip
// with an explicit overlap reason persisted to the proposal repository.
//
// Proposal context is bounded to the eligible universe members rather than
// scanning the full instrument catalog. When coverage is insufficient
// (Degraded or Stale), the supervisor skips deterministically instead of
// falling back to the full catalog.

import type { TickWork } from '../runtime/scheduler.js';
import type {
  HealthStatus,
  ProposalEngineConfig,
  NewProposalAttempt,
  BoundedCandidate,
  HybridCandidateEvidence,
  ProposalAttemptWithReasons,
} from '../types/runtime.js';
import {
  ProposalStatus,
  ValidationReasonCode,
  MarketPhase,
  UniverseCoverageVerdict,
} from '../types/runtime.js';
import type { SessionRuntimePort, InstrumentCatalogPort, QuoteStreamPort } from '../integrations/broker/ports.js';
import type { MarketClock } from '../runtime/market-clock.js';
import type { QuoteSnapshot } from '../integrations/broker/types.js';
import { ProposalRepository } from '../persistence/proposal-repo.js';
import { HybridScoreRepository } from '../persistence/hybrid-score-repo.js';
import { StrategyRunRepository } from '../persistence/strategy-run-repo.js';
import type { NewStrategyRun, NewStrategyRunCandidate } from '../types/runtime.js';
import { ProposalEngine, type EngineContext, type NormalizedProposal } from './proposal-engine.js';
import { IndiaProposalValidator, type ValidatorInput } from './india-validator.js';
import { UniverseService, type UniverseCoverageSummary } from '../universe/universe-service.js';
import { StrategyCoordinator } from '../strategy/framework.js';
import { createStrategyCoordinator } from '../strategy/coordinator-factory.js';

// ---------------------------------------------------------------------------
// ProposalSupervisor
// ---------------------------------------------------------------------------

export class ProposalSupervisor implements TickWork {
  readonly label = 'proposal-engine';

  private readonly _engine: ProposalEngine;
  private readonly _validator: IndiaProposalValidator;
  private readonly _repo: ProposalRepository;
  private readonly _session: SessionRuntimePort | null;
  private readonly _instruments: InstrumentCatalogPort | null;
  private readonly _stream: QuoteStreamPort | null;
  private readonly _clock: MarketClock;
  private readonly _universeService: UniverseService | null;
  private readonly _maxProposals: number;

  /** Strategy coordinator with the LLM ranking plugin. */
  private readonly _coordinator: StrategyCoordinator;
  /** Optional hybrid score repository for atomic proposal + hybrid evidence persistence. */
  private readonly _hybridScoreRepo: HybridScoreRepository | null;
  /** Optional strategy run repository for append-only screening-round artifacts. */
  private readonly _strategyRunRepo: StrategyRunRepository | null;

  /** Local in-flight guard — true while a proposal generation is active. */
  private _inFlight: boolean = false;
  /** Count of overlap skips for diagnostics. */
  private _overlapSkipCount: number = 0;
  /** Timestamp of the last successful proposal tick, or null. */
  private _lastTickAt: number | null = null;

  constructor(options: {
    engine: ProposalEngine;
    validator: IndiaProposalValidator;
    repo: ProposalRepository;
    session: SessionRuntimePort | null;
    instruments: InstrumentCatalogPort | null;
    stream: QuoteStreamPort | null;
    clock: MarketClock;
    maxProposals?: number;
    universeService?: UniverseService | null;
    /** Optional externally-constructed strategy coordinator. When provided,
     *  the supervisor uses this coordinator instead of building one internally.
     *  This is the production path — the runtime composition root constructs
     *  and injects the coordinator. */
    coordinator?: StrategyCoordinator;
    /** Optional hybrid score repository for atomic proposal + evidence persistence. */
    hybridScoreRepo?: HybridScoreRepository | null;
    /** Optional strategy run repository for append-only screening-round artifacts. */
    strategyRunRepo?: StrategyRunRepository | null;
  }) {
    this._engine = options.engine;
    this._validator = options.validator;
    this._repo = options.repo;
    this._session = options.session;
    this._instruments = options.instruments;
    this._stream = options.stream;
    this._clock = options.clock;
    this._maxProposals = options.maxProposals ?? 5;
    this._universeService = options.universeService ?? null;
    this._hybridScoreRepo = options.hybridScoreRepo ?? null;
    this._strategyRunRepo = options.strategyRunRepo ?? null;

    // Use externally-constructed coordinator when provided (production path).
    // Otherwise build one via the shared factory (backward compatibility for tests).
    if (options.coordinator) {
      this._coordinator = options.coordinator;
    } else {
      this._coordinator = createStrategyCoordinator({
        proposalEngine: this._engine,
        maxCandidates: this._maxProposals,
        parallelPlugins: true,
      });
    }
  }

  // ── TickWork ────────────────────────────────────────────────────────────

  async doWork(_now: Date, _health: HealthStatus): Promise<void> {
    // ── Check 1: In-flight guard ──────────────────────────────────────────
    if (this._inFlight) {
      this._persistOverlapSkip();
      return;
    }

    // ── Acquire in-flight guard ──────────────────────────────────────────
    this._inFlight = true;

    try {
      await this._runTick();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[proposal-supervisor] Tick error: ${errorMsg}`);

      // Persist a generic failure record
      try {
        this._repo.insertAttemptWithReasons(
          {
            exchange: '',
            tradingsymbol: '',
            instrumentToken: null,
            side: '',
            product: '',
            quantity: 0,
            price: null,
            triggerPrice: null,
            orderType: '',
            tag: 'supervisor-error',
            proposalStatus: ProposalStatus.Skipped,
            createdAt: Date.now(),
          },
          [{
            reasonCode: ValidationReasonCode.QuoteMissing,
            reasonMessage: `Proposal supervisor tick error: ${errorMsg}`,
          }],
        );
      } catch {
        // Best-effort — persistence failure should not crash the scheduler
      }
    } finally {
      this._inFlight = false;
    }
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────

  /** Return supervisor diagnostics for health/observability surfaces. */
  getDiagnostics(): {
    inFlight: boolean;
    overlapSkipCount: number;
    lastTickAt: number | null;
    coordinatorPlugins: Array<{ id: string; name: string; version: string }>;
  } {
    return {
      inFlight: this._inFlight,
      overlapSkipCount: this._overlapSkipCount,
      lastTickAt: this._lastTickAt,
      coordinatorPlugins: this._coordinator.plugins,
    };
  }

  // ── Internal: single tick execution ────────────────────────────────────

  private async _runTick(): Promise<void> {
    const now = Date.now();
    this._lastTickAt = now;

    // ── Phase 1: Read market phase ──────────────────────────────────────
    const phase = this._clock.getPhase(new Date(now));

    // ── Phase 2: Read session state ─────────────────────────────────────
    let sessionHealth: { state: string; expiresAt: number } | null = null;
    if (this._session) {
      const health = this._session.getSessionHealth();
      sessionHealth = {
        state: health.state,
        expiresAt: health.expiresAt,
      };
    }

    // ── Phase 3: Check universe coverage and build bounded context ──────
    const coverageSummary = this._universeService
      ? this._universeService.getCoverageSummary()
      : null;

    // If universe service is available and coverage is insufficient,
    // skip deterministically instead of falling back to the full catalog.
    if (coverageSummary) {
      const verdict = coverageSummary.verdict;
      if (verdict === UniverseCoverageVerdict.Degraded) {
        this._persistCoverageSkip('Degraded', `Universe coverage is degraded: ${coverageSummary.freshQuoteCount}/${coverageSummary.eligibleCount} fresh quotes`);
        return;
      }
      if (verdict === UniverseCoverageVerdict.Stale) {
        this._persistCoverageSkip('Stale', `Universe coverage is stale: ${coverageSummary.freshQuoteCount}/${coverageSummary.eligibleCount} fresh quotes, ${coverageSummary.staleQuoteCount} stale`);
        return;
      }
    }

    // ── Phase 4: Build bounded candidates from eligible universe ────────
    const candidates = this._buildBoundedCandidates(phase);

    if (candidates.length === 0) {
      // No instruments to propose on — persist a skip
      this._repo.insertAttemptWithReasons(
        {
          exchange: '',
          tradingsymbol: '',
          instrumentToken: null,
          side: '',
          product: '',
          quantity: 0,
          price: null,
          triggerPrice: null,
          orderType: '',
          tag: 'no-instruments',
          proposalStatus: ProposalStatus.Skipped,
          createdAt: now,
        },
        [{
          reasonCode: ValidationReasonCode.InstrumentLookupFailed,
          reasonMessage: 'No eligible universe members available for proposal generation',
        }],
      );
      return;
    }

    // ── Phase 5: Run through the pluggable strategy pipeline ────────────
    const coordinatorResult = await this._coordinator.evaluate(candidates);

    if (coordinatorResult.candidates.length === 0) {
      // Coordinator returned nothing (all plugins declined) — persist refusal
      const reasons: string[] = [];
      if (coordinatorResult.hasPluginErrors) {
        for (const [id, err] of Object.entries(coordinatorResult.pluginErrors)) {
          reasons.push(`Plugin ${id} error: ${err}`);
        }
      }

      this._repo.insertAttemptWithReasons(
        {
          exchange: '',
          tradingsymbol: '',
          instrumentToken: null,
          side: '',
          product: '',
          quantity: 0,
          price: null,
          triggerPrice: null,
          orderType: '',
          tag: 'coordinator-empty',
          proposalStatus: ProposalStatus.Refused,
          createdAt: now,
        },
        [{
          reasonCode: ValidationReasonCode.QuoteMissing,
          reasonMessage: reasons.length > 0
            ? `Strategy coordinator returned no candidates: ${reasons.join('; ')}`
            : 'Strategy coordinator returned no candidates — all plugins declined',
        }],
      );
      return;
    }

    // ── Phase 6: Map ranked candidates to proposal attempts ────────────
    const proposals = this._mapHybridToProposals(coordinatorResult.candidates, now);

    if (proposals.length === 0) {
      this._repo.insertAttemptWithReasons(
        {
          exchange: '',
          tradingsymbol: '',
          instrumentToken: null,
          side: '',
          product: '',
          quantity: 0,
          price: null,
          triggerPrice: null,
          orderType: '',
          tag: 'mapping-failed',
          proposalStatus: ProposalStatus.Refused,
          createdAt: now,
        },
        [{
          reasonCode: ValidationReasonCode.QuoteMissing,
          reasonMessage: 'Failed to map any ranked candidates to valid proposal attempts',
        }],
      );
      return;
    }

    // Build a candidate key → evidence lookup for hybrid score persistence
    const evidenceByKey = new Map<string, HybridCandidateEvidence>();
    for (const evidence of coordinatorResult.candidates) {
      evidenceByKey.set(evidence.candidateKey, evidence);
    }

    // Track proposal attempt IDs for strategy run candidate linkage
    const emittedKeyToProposalId = new Map<string, number>();

    // ── Phase 7: Resolve instrument tokens and validate each proposal ───
    for (const prop of proposals) {
      const { attempt } = prop;

      // Resolve instrument token from local instrument master
      const instrument = this._instruments
        ? this._instruments.getInstrument(attempt.exchange, attempt.tradingsymbol)
        : null;

      // Attach instrument token if found
      if (instrument) {
        attempt.instrumentToken = instrument.instrumentToken;
      }

      // Get latest quote
      const quote = this._stream
        ? this._stream.getLatestQuote(attempt.exchange, attempt.tradingsymbol)
        : null;

      // Get sync state
      const syncState = this._instruments
        ? this._instruments.getSyncState()
        : null;

      // Validate deterministically
      const verdict = this._validator.validate({
        proposal: attempt,
        sessionHealth: sessionHealth as {
          state: import('../types/runtime.js').ZerodhaSessionState;
          expiresAt: number;
        } | null,
        instrument,
        quote,
        syncState,
        marketPhase: phase,
      });

      // Set the proposal status to match the verdict before persisting
      attempt.proposalStatus = verdict.status;

      // Look up hybrid evidence for this candidate
      const candidateKey = `${attempt.exchange}:${attempt.tradingsymbol}`;
      const evidence = evidenceByKey.get(candidateKey);

      let persistedId: number | null = null;

      if (this._hybridScoreRepo && evidence) {
        // Persist proposal + reasons + hybrid score evidence atomically
        const hybridComponents = evidence.pluginScores.map((ps, idx) => ({
          summaryId: 0, // placeholder — assigned by the insert
          componentName: ps.plugin.id,
          score: ps.score,
          weight: 1.0,
          sortOrder: idx,
        }));

        const result = this._repo.insertAttemptWithReasonsAndHybridScore(
          attempt,
          verdict.status === ProposalStatus.Accepted ? [] : verdict.reasons,
          {
            proposalAttemptId: 0, // placeholder — assigned by the insert
            deterministicScore: evidence.deterministicScore,
            llmScore: evidence.llmScore,
            llmStatus: evidence.llmStatus,
            llmRationale: evidence.llmRationale,
            mergedScore: evidence.mergedScore,
            mergePolicy: evidence.mergePolicy,
            createdAt: now,
          },
          hybridComponents,
        );
        persistedId = result.id;
      } else {
        // Fallback to basic persistence when hybrid repo is not wired
        let result: ProposalAttemptWithReasons;
        if (verdict.status === ProposalStatus.Accepted) {
          result = this._repo.insertAttemptWithReasons(attempt, []);
        } else {
          result = this._repo.insertAttemptWithReasons(attempt, verdict.reasons);
        }
        persistedId = result.id;
      }

      // Track emitted candidates for strategy run linkage
      if (verdict.status === ProposalStatus.Accepted && persistedId != null) {
        emittedKeyToProposalId.set(candidateKey, persistedId);
      }
    }

    // ── Phase 8: Persist strategy run artifact (if strategyRunRepo is wired) ──
    if (this._strategyRunRepo) {
      this._persistStrategyRun(
        coordinatorResult,
        proposals,
        evidenceByKey,
        emittedKeyToProposalId,
        now,
      );
    }

    // Log tick summary if debugging
    if (proposals.length > 0) {
      console.log(
        `[proposal-supervisor] tick: ${proposals.length} proposals`
        + ` (${coordinatorResult.durationMs}ms coordinator time)`,
      );
    }
  }

  /**
   * Build bounded candidates from the eligible universe members.
   *
   * Gathers only eligible instruments with their latest quotes and
   * maps them to BoundedCandidate[] for strategy pipeline consumption.
   * Falls back to scanning the full instrument catalog when the
   * universe service is not available (legacy mode).
   */
  private _buildBoundedCandidates(phase: MarketPhase): BoundedCandidate[] {
    // If universe service is available, use eligible members only
    if (this._universeService && this._instruments) {
      const eligibleMembers = this._universeService.getLatestSnapshot();
      if (eligibleMembers) {
        const eligibleSymbols = eligibleMembers.members
          .filter(m => m.isEligible)
          .map(m => ({ exchange: m.exchange, tradingsymbol: m.tradingsymbol }));

        const candidates: BoundedCandidate[] = [];
        for (const { exchange, tradingsymbol } of eligibleSymbols) {
          const instrument = this._instruments.getInstrument(exchange, tradingsymbol);
          const quote = this._stream
            ? this._stream.getLatestQuote(exchange, tradingsymbol)
            : null;

          if (instrument) {
            candidates.push(this._toBoundedCandidate(instrument, quote));
          }
        }

        // Deterministic sort: exchange alphabetical, then symbol alphabetical
        candidates.sort((a, b) => {
          const exchCmp = a.exchange.localeCompare(b.exchange);
          if (exchCmp !== 0) return exchCmp;
          return a.tradingsymbol.localeCompare(b.tradingsymbol);
        });

        return candidates;
      }

      // No snapshot yet
      return [];
    }

    // Legacy fallback: scan all NSE/NFO instruments
    if (!this._instruments) {
      return [];
    }

    const nseInstruments = this._instruments.getInstrumentsBySegment('NSE');
    const nfoInstruments = this._instruments.getInstrumentsBySegment('NFO');
    const allInstruments = [...nseInstruments, ...nfoInstruments];

    if (allInstruments.length === 0) {
      return [];
    }

    const candidates: BoundedCandidate[] = [];
    for (const instrument of allInstruments) {
      const quote = this._stream
        ? this._stream.getLatestQuote(instrument.exchange, instrument.tradingsymbol)
        : null;
      candidates.push(this._toBoundedCandidate(instrument, quote));
    }

    candidates.sort((a, b) => {
      const exchCmp = a.exchange.localeCompare(b.exchange);
      if (exchCmp !== 0) return exchCmp;
      return a.tradingsymbol.localeCompare(b.tradingsymbol);
    });

    return candidates;
  }

  /**
   * Map an InstrumentRecord + optional QuoteSnapshot to a BoundedCandidate.
   */
  private _toBoundedCandidate(
    instrument: import('../integrations/broker/types.js').InstrumentRecord,
    quote: QuoteSnapshot | null,
  ): BoundedCandidate {
    return {
      exchange: instrument.exchange,
      tradingsymbol: instrument.tradingsymbol,
      instrumentToken: instrument.instrumentToken,
      side: 'buy', // Default — the LLM plugin will determine actual side
      lastPrice: quote?.lastPrice ?? null,
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      volume: quote?.volume ?? null,
      instrumentType: instrument.instrumentType,
      lotSize: instrument.lotSize,
      tickSize: instrument.tickSize,
    };
  }

  /**
   * Map hybrid candidate evidence from the coordinator to NormalizedProposal entries.
   *
   * Each HybridCandidateEvidence produces one proposal attempt using the candidate's
   * instrument details and default order parameters. If the evidence carries
   * proposalParams (typically from the LLM plugin), those override defaults.
   */
  private _mapHybridToProposals(
    candidates: import('../types/runtime.js').HybridCandidateEvidence[],
    now: number,
  ): NormalizedProposal[] {
    const proposals: NormalizedProposal[] = [];

    for (const entry of candidates) {
      const c = entry.candidate;

      // Check for LLM-provided proposal params in the evidence
      let side = 'buy';
      let product = 'MIS';
      let quantity = 1;
      let price: number | null = null;
      let triggerPrice: number | null = null;
      let orderType = 'MARKET';
      let tag: string | null = null;

      const proposalParams = entry.proposalParams;
      if (proposalParams) {
        // Use LLM-provided params if available and valid
        const pSide = String(proposalParams.side ?? '').toLowerCase();
        if (pSide === 'buy' || pSide === 'sell') side = pSide;

        const pProduct = String(proposalParams.product ?? '').toUpperCase();
        if (['MIS', 'CNC', 'NRML'].includes(pProduct)) product = pProduct;

        const pQty = Number(proposalParams.quantity);
        if (Number.isFinite(pQty) && pQty > 0) quantity = Math.floor(pQty);

        if (proposalParams.price != null && Number.isFinite(Number(proposalParams.price))) {
          price = Number(proposalParams.price);
        }
        if (proposalParams.triggerPrice != null && Number.isFinite(Number(proposalParams.triggerPrice))) {
          triggerPrice = Number(proposalParams.triggerPrice);
        }
        const pOrderType = String(proposalParams.orderType ?? '').toUpperCase();
        if (['MARKET', 'LIMIT', 'SL', 'SLM'].includes(pOrderType)) orderType = pOrderType;
      }

      // Use deterministic defaults based on instrument type
      if (!proposalParams) {
        // For F&O, use NRML; for EQ, use MIS
        product = c.instrumentType === 'EQ' ? 'MIS' : 'NRML';
        // Default quantity: lot size for F&O, 1 for EQ
        quantity = Math.max(1, c.lotSize);
        // Default side: buy
        side = 'buy';
        // Default order: MARKET
        orderType = 'MARKET';
        price = null;
        triggerPrice = null;
      }

      // Use the first plugin's id for tagging
      const pluginId = entry.pluginScores.length > 0 ? entry.pluginScores[0].plugin.id : 'unknown';
      tag = `strategy-${pluginId}`;

      // Build the NewProposalAttempt
      const attempt: NewProposalAttempt = {
        exchange: c.exchange,
        tradingsymbol: c.tradingsymbol,
        instrumentToken: c.instrumentToken,
        side,
        product,
        quantity,
        price,
        triggerPrice,
        orderType,
        tag,
        proposalStatus: ProposalStatus.Pending,
        createdAt: now,
      };

      proposals.push({
        attempt,
        raw: {
          exchange: c.exchange,
          tradingsymbol: c.tradingsymbol,
          side,
          product,
          quantity,
          price,
          triggerPrice,
          orderType,
        },
      });
    }

    return proposals;
  }

  /**
   * Persist a skip record when universe coverage is insufficient.
   */
  private _persistCoverageSkip(verdictLabel: string, message: string): void {
    try {
      this._repo.insertAttemptWithReasons(
        {
          exchange: '',
          tradingsymbol: '',
          instrumentToken: null,
          side: '',
          product: '',
          quantity: 0,
          price: null,
          triggerPrice: null,
          orderType: '',
          tag: `coverage-skip-${verdictLabel.toLowerCase()}`,
          proposalStatus: ProposalStatus.Skipped,
          createdAt: Date.now(),
        },
        [{
          reasonCode: ValidationReasonCode.QuoteMissing,
          reasonMessage: message,
        }],
      );
    } catch {
      // Best-effort — persistence failure should not crash the scheduler
    }

    console.warn(`[proposal-supervisor] Coverage skip (${verdictLabel}): ${message}`);
  }

  /**
   * Persist an overlap-skip record when a concurrent tick is detected.
   */
  private _persistOverlapSkip(): void {
    this._overlapSkipCount++;

    try {
      this._repo.insertAttemptWithReasons(
        {
          exchange: '',
          tradingsymbol: '',
          instrumentToken: null,
          side: '',
          product: '',
          quantity: 0,
          price: null,
          triggerPrice: null,
          orderType: '',
          tag: 'overlap-skip',
          proposalStatus: ProposalStatus.Skipped,
          createdAt: Date.now(),
        },
        [{
          reasonCode: ValidationReasonCode.DuplicateAttempt,
          reasonMessage: 'Proposal generation skipped: previous tick still in flight (overlap)',
        }],
      );
    } catch {
      // Best-effort — persistence failure should not crash the scheduler
    }

    console.warn('[proposal-supervisor] Overlap skip: previous tick still in flight');
  }

  /**
   * Persist one append-only strategy run artifact with all evaluated candidates
   * and downstream proposal linkage.
   *
   * Builds the run from coordinator result metadata and maps each hybrid candidate
   * evidence entry to a strategy run candidate row. Emitted (accepted) candidates
   * carry their proposal_attempt_id linkage; non-selected and refused candidates
   * remain explicitly unlinked.
   *
   * Uses the repository's atomic insert — a failure here does not roll back
   * the already-persisted proposals (run persistence is best-effort additive).
   */
  private _persistStrategyRun(
    coordinatorResult: import('../types/runtime.js').HybridCoordinatorResult,
    proposals: NormalizedProposal[],
    evidenceByKey: Map<string, HybridCandidateEvidence>,
    emittedKeyToProposalId: Map<string, number>,
    now: number,
  ): void {
    try {
      // Build the run from coordinator metadata
      const run: NewStrategyRun = {
        frameworkConfig: JSON.stringify(coordinatorResult.candidates.length > 0
          ? { maxCandidates: coordinatorResult.candidates.length }
          : { maxCandidates: 0 }),
        pluginsJson: JSON.stringify(
          coordinatorResult.plugins.map(p => ({
            id: p.id,
            name: p.name,
            version: p.version,
          })),
        ),
        pluginErrorsJson: coordinatorResult.hasPluginErrors
          ? JSON.stringify(coordinatorResult.pluginErrors)
          : null,
        universeSnapshotId: null, // Not yet wired — set when universe snapshot linkage is available
        totalEvaluated: coordinatorResult.totalEvaluated,
        hasPluginErrors: coordinatorResult.hasPluginErrors,
        durationMs: coordinatorResult.durationMs,
        createdAt: now,
      };

      // Build candidates from coordinator evidence
      // Rank is assigned below based on index order
      const candidates: NewStrategyRunCandidate[] = coordinatorResult.candidates.map(evidence => {
        const isEmitted = emittedKeyToProposalId.has(evidence.candidateKey);
        const proposalAttemptId = emittedKeyToProposalId.get(evidence.candidateKey) ?? null;

        return {
          strategyRunId: 0, // placeholder — assigned by insert
          candidateKey: evidence.candidateKey,
          rank: 0, // placeholder — assigned below
          exchange: evidence.candidate.exchange,
          tradingsymbol: evidence.candidate.tradingsymbol,
          instrumentToken: evidence.candidate.instrumentToken,
          instrumentType: evidence.candidate.instrumentType,
          lotSize: evidence.candidate.lotSize,
          tickSize: evidence.candidate.tickSize,
          side: evidence.candidate.side,
          lastPrice: evidence.candidate.lastPrice,
          bid: evidence.candidate.bid,
          ask: evidence.candidate.ask,
          volume: evidence.candidate.volume,
          scoresJson: JSON.stringify(
            evidence.pluginScores.map(ps => ({
              plugin: ps.plugin,
              score: ps.score,
              rationale: ps.rationale,
              metadata: ps.metadata ?? null,
            })),
          ),
          deterministicScore: evidence.deterministicScore,
          llmScore: evidence.llmScore,
          llmStatus: evidence.llmStatus,
          llmRationale: evidence.llmRationale,
          mergedScore: evidence.mergedScore,
          mergePolicy: evidence.mergePolicy,
          proposalParamsJson: evidence.proposalParams
            ? JSON.stringify(evidence.proposalParams)
            : null,
          pluginErrorsJson: evidence.hasPluginErrors
            ? JSON.stringify(evidence.pluginErrors)
            : null,
          hasPluginErrors: evidence.hasPluginErrors,
          emitted: isEmitted,
          proposalAttemptId,
        };
      });

      // Assign ranks based on coordinator ordering
      for (let i = 0; i < candidates.length; i++) {
        candidates[i].rank = i + 1;
      }

      this._strategyRunRepo!.insertRunWithCandidates(run, candidates);
    } catch (err) {
      // Strategy run persistence is best-effort — it should not crash the tick
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[proposal-supervisor] Failed to persist strategy run: ${errorMsg}`);
    }
  }
}
