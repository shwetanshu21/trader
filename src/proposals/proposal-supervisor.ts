// ── ProposalSupervisor — TickWork hook that orchestrates proposal generation ──
// Runs on every scheduler tick: acquires the in-flight guard, reads market
// context, generates proposals via the LLM provider, validates each one
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
} from '../types/runtime.js';
import {
  ProposalStatus,
  ValidationReasonCode,
  MarketPhase,
  UniverseCoverageVerdict,
} from '../types/runtime.js';
import type { SessionRuntimePort, InstrumentCatalogPort, QuoteStreamPort } from '../integrations/broker/ports.js';
import type { MarketClock } from '../runtime/market-clock.js';
import { ProposalRepository } from '../persistence/proposal-repo.js';
import { ProposalEngine, type EngineContext } from './proposal-engine.js';
import { IndiaProposalValidator } from './india-validator.js';
import { UniverseService } from '../universe/universe-service.js';

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
  } {
    return {
      inFlight: this._inFlight,
      overlapSkipCount: this._overlapSkipCount,
      lastTickAt: this._lastTickAt,
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

    // ── Phase 4: Build instrument context from eligible universe ────────
    const context = await this._buildEngineContext(phase);

    if (context.instruments.length === 0) {
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

    // ── Phase 5: Generate proposals via LLM ─────────────────────────────
    const engineResult = await this._engine.generateProposals(context);

    if (engineResult.refusal) {
      // Engine couldn't produce proposals — persist refusal
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
          tag: 'engine-refusal',
          proposalStatus: ProposalStatus.Refused,
          createdAt: now,
        },
        [engineResult.refusal],
      );
      return;
    }

    // ── Phase 6: Resolve instrument tokens and validate each proposal ───
    for (const normalized of engineResult.proposals) {
      const { attempt, raw } = normalized;

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

      // Persist the attempt with its validation reasons
      if (verdict.status === ProposalStatus.Accepted) {
        this._repo.insertAttemptWithReasons(attempt, []);
      } else {
        this._repo.insertAttemptWithReasons(attempt, verdict.reasons);
      }
    }

    // Log tick summary if debugging
    if (engineResult.proposals.length > 0) {
      console.log(
        `[proposal-supervisor] tick: ${engineResult.proposals.length} proposals`
        + ` (${engineResult.durationMs ?? 0}ms provider time)`,
      );
    }
  }

  /**
   * Build the EngineContext from eligible universe members.
   * Gathers only eligible instruments with their latest quotes.
   * If universe service is not available, falls back to scanning the
   * full instrument catalog (legacy mode).
   */
  private async _buildEngineContext(phase: MarketPhase): Promise<EngineContext> {
    // If universe service is available, use eligible members only
    if (this._universeService && this._instruments) {
      const eligibleMembers = this._universeService.getLatestSnapshot();
      if (eligibleMembers) {
        const eligibleSymbols = eligibleMembers.members
          .filter(m => m.isEligible)
          .map(m => ({ exchange: m.exchange, tradingsymbol: m.tradingsymbol }));

        const entries: EngineContext['instruments'] = [];
        for (const { exchange, tradingsymbol } of eligibleSymbols) {
          const instrument = this._instruments.getInstrument(exchange, tradingsymbol);
          const quote = this._stream
            ? this._stream.getLatestQuote(exchange, tradingsymbol)
            : null;
          if (instrument) {
            entries.push({ instrument, quote });
          }
        }

        // Sort: instruments with quotes first, then by volume if available
        entries.sort((a, b) => {
          const aHasQuote = a.quote !== null ? 1 : 0;
          const bHasQuote = b.quote !== null ? 1 : 0;
          if (aHasQuote !== bHasQuote) return bHasQuote - aHasQuote;
          return (b.quote?.volume ?? 0) - (a.quote?.volume ?? 0);
        });

        return {
          instruments: entries,
          marketPhase: phase,
          maxProposals: this._maxProposals,
        };
      }

      // No snapshot yet — or no eligible members — return empty
      return { instruments: [], marketPhase: phase, maxProposals: this._maxProposals };
    }

    // Legacy fallback: scan all NSE/NFO instruments
    if (!this._instruments) {
      return { instruments: [], marketPhase: phase, maxProposals: this._maxProposals };
    }

    const nseInstruments = this._instruments.getInstrumentsBySegment('NSE');
    const nfoInstruments = this._instruments.getInstrumentsBySegment('NFO');
    const allInstruments = [...nseInstruments, ...nfoInstruments];

    if (allInstruments.length === 0) {
      return { instruments: [], marketPhase: phase, maxProposals: this._maxProposals };
    }

    const entries: EngineContext['instruments'] = [];
    for (const instrument of allInstruments) {
      const quote = this._stream
        ? this._stream.getLatestQuote(instrument.exchange, instrument.tradingsymbol)
        : null;
      entries.push({ instrument, quote });
    }

    entries.sort((a, b) => {
      const aHasQuote = a.quote !== null ? 1 : 0;
      const bHasQuote = b.quote !== null ? 1 : 0;
      if (aHasQuote !== bHasQuote) return bHasQuote - aHasQuote;
      return (b.quote?.volume ?? 0) - (a.quote?.volume ?? 0);
    });

    return {
      instruments: entries,
      marketPhase: phase,
      maxProposals: this._maxProposals,
    };
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
}
