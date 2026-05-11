// ── ZerodhaSupervisor — TickWork hook that supervises broker lifecycle ──
// Runs on every scheduler tick: checks session freshness, instrument
// staleness, and stream connectivity. Persists diagnostics and exposes
// a BrokerHealth block for the health surface.
// Degraded subsystems are reported through health but do NOT stop the scheduler.

import type { TickWork } from '../../runtime/scheduler.js';
import type { HealthStatus, BrokerHealth } from '../../types/runtime.js';
import type { SessionService } from './session-service.js';
import type { InstrumentsService } from './instruments-service.js';
import type { MarketDataStream } from './market-data-stream.js';
import { ZerodhaRepository } from '../../persistence/zerodha-repo.js';

export class ZerodhaSupervisor implements TickWork {
  readonly label = 'zerodha';

  private readonly _session: SessionService;
  private readonly _instruments: InstrumentsService;
  private readonly _stream: MarketDataStream | null;
  private readonly _repo: ZerodhaRepository;

  constructor(
    session: SessionService,
    instruments: InstrumentsService,
    repo: ZerodhaRepository,
    stream: MarketDataStream | null,
  ) {
    this._session = session;
    this._instruments = instruments;
    this._repo = repo;
    this._stream = stream;
  }

  // ── TickWork ────────────────────────────────────────────────────────────

  async doWork(_now: Date, _health: HealthStatus): Promise<void> {
    // Currently TickWork is a no-op for supervised periodic work because:
    // - Session refresh requires real HTTP calls (wired in a later task)
    // - Instrument sync requires fetching the CSV from Kite (wired later)
    // - Stream connect/disconnect is event-driven, not polled
    //
    // However, we DO persist stream diagnostics on each tick so health
    // surfaces are fresh. This is a no-fail operation (degraded stream
    // state is valid — it means the stream is down, which is expected
    // outside market hours).
    if (this._stream) {
      try {
        this._stream.persistDiagnostics();
      } catch {
        // Best-effort — diagnostics persistence should never crash the tick
      }
    }
  }

  // ── Health block ────────────────────────────────────────────────────────

  /** Build the broker health block for the runtime health surface. */
  getBrokerHealth(): BrokerHealth {
    const sessionHealth = this._session.getSessionHealth();
    const instrumentFreshness = this._instruments.checkFreshness();
    const syncState = this._instruments.getSyncState();

    // Stream health
    let streamState = 'disconnected';
    let streamReconnectCount = 0;
    let streamQuoteFreshness: { isStale: boolean; stalenessMs: number | null; lastQuoteAt: number | null } = {
      isStale: true, stalenessMs: null, lastQuoteAt: null,
    };

    if (this._stream) {
      streamState = this._stream.getState();
      streamReconnectCount = this._stream.getDiagnostics().reconnectCount;
      streamQuoteFreshness = this._stream.checkQuoteFreshness();
    }

    // Recent ingestion events
    const recentEvents = this._repo.getIngestionEvents(5).map(e => ({
      eventType: e.eventType,
      recordedAt: e.recordedAt,
      durationMs: e.durationMs,
      itemCount: e.itemCount,
      error: e.error,
    }));

    return {
      session: sessionHealth,
      instruments: {
        lastSuccessAt: syncState.lastSuccessAt,
        instrumentCount: syncState.lastInstrumentCount,
        stalenessMs: instrumentFreshness.stalenessMs,
        isStale: instrumentFreshness.isStale,
      },
      stream: {
        state: streamState,
        reconnectCount: streamReconnectCount,
        isStale: streamQuoteFreshness.isStale,
        stalenessMs: streamQuoteFreshness.stalenessMs,
        lastQuoteAt: streamQuoteFreshness.lastQuoteAt,
      },
      recentEvents,
    };
  }

  /** Whether Zerodha integration is configured. */
  get isConfigured(): boolean {
    return this._session.isConfigured;
  }
}
