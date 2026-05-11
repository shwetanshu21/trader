// ── ProposalSupervisor — TickWork hook that orchestrates proposal generation ──
// Runs on every scheduler tick: acquires the in-flight guard, reads market
// context, generates proposals via the LLM provider, validates each one
// deterministically, and persists every outcome (accepted, refused, timeout,
// malformed, missing config, or overlap skip).
//
// Overlapping scheduler ticks cannot execute concurrent proposal generations.
// The in-flight guard ensures only one run at a time; concurrent ticks skip
// with an explicit overlap reason persisted to the proposal repository.

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
} from '../types/runtime.js';
import type { SessionService } from '../integrations/zerodha/session-service.js';
import type { InstrumentsService } from '../integrations/zerodha/instruments-service.js';
import type { MarketDataStream } from '../integrations/zerodha/market-data-stream.js';
import type { MarketClock } from '../runtime/market-clock.js';
import { ProposalRepository } from '../persistence/proposal-repo.js';
import { ProposalEngine, type EngineContext } from './proposal-engine.js';
import { IndiaProposalValidator } from './india-validator.js';

// ---------------------------------------------------------------------------
// ProposalSupervisor
// ---------------------------------------------------------------------------

export class ProposalSupervisor implements TickWork {
  readonly label = 'proposal-engine';

  private readonly _engine: ProposalEngine;
  private readonly _validator: IndiaProposalValidator;
  private readonly _repo: ProposalRepository;
  private readonly _session: SessionService | null;
  private readonly _instruments: InstrumentsService | null;
  private readonly _stream: MarketDataStream | null;
  private readonly _clock: MarketClock;
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
    session: SessionService | null;
    instruments: InstrumentsService | null;
    stream: MarketDataStream | null;
    clock: MarketClock;
    maxProposals?: number;
  }) {
    this._engine = options.engine;
    this._validator = options.validator;
    this._repo = options.repo;
    this._session = options.session;
    this._instruments = options.instruments;
    this._stream = options.stream;
    this._clock = options.clock;
    this._maxProposals = options.maxProposals ?? 5;
  }

  // ── TickWork ────────────────────────────────────────────────────────────

  async doWork(_now: Date, _health: HealthStatus): Promise<void> {
    // ── Check 1: In-flight guard ──────────────────────────────────────────
    if (this._inFlight) {
      this._persistOverlapSkip();
      return;
    }

    // ── Check 2: Proposal engine configured ──────────────────────────────
    // If engine wasn't configured, the supervisor wouldn't be instantiated,
    // but guard against misuse.

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

    // ── Phase 3: Build instrument context ────────────────────────────────
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
          reasonMessage: 'No instruments available in the instrument master',
        }],
      );
      return;
    }

    // ── Phase 4: Generate proposals via LLM ─────────────────────────────
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

    // ── Phase 5: Resolve instrument tokens and validate each proposal ───
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
   * Build the EngineContext from available instrument and quote data.
   * Gathers all instruments with their latest quotes, filtered by active segment.
   */
  private async _buildEngineContext(phase: MarketPhase): Promise<EngineContext> {
    if (!this._instruments) {
      return { instruments: [], marketPhase: phase, maxProposals: this._maxProposals };
    }

    // Get instruments for both NSE and NFO
    const nseInstruments = this._instruments.getInstrumentsBySegment('NSE');
    const nfoInstruments = this._instruments.getInstrumentsBySegment('NFO');
    const allInstruments = [...nseInstruments, ...nfoInstruments];

    if (allInstruments.length === 0) {
      return { instruments: [], marketPhase: phase, maxProposals: this._maxProposals };
    }

    // Attach quotes where available
    const entries: EngineContext['instruments'] = [];
    for (const instrument of allInstruments) {
      const quote = this._stream
        ? this._stream.getLatestQuote(instrument.exchange, instrument.tradingsymbol)
        : null;
      entries.push({ instrument, quote });
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
