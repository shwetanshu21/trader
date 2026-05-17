// ── BrokerSupervisor — TickWork hook that supervises broker lifecycle ──
// Runs on every scheduler tick: checks session freshness, instrument
// staleness, and stream connectivity. Persists diagnostics and exposes
// a BrokerHealth block for the health surface.
// Degraded subsystems are reported through health but do NOT stop the scheduler.

import type { TickWork } from '../../runtime/scheduler.js';
import type { HealthStatus, BrokerHealth } from '../../types/runtime.js';
import type { SessionRuntimePort, InstrumentCatalogPort, QuoteStreamPort, BrokerMcpDriver } from './ports.js';
import { BrokerRepository } from '../../persistence/broker-repo.js';
import { getEligibleSymbols } from '../../universe/policy.js';

export class BrokerSupervisor implements TickWork {
  readonly label = 'broker';

  private readonly _session: SessionRuntimePort;
  private readonly _instruments: InstrumentCatalogPort;
  private readonly _stream: QuoteStreamPort | null;
  private readonly _repo: BrokerRepository;
  private readonly _mcpDriver: BrokerMcpDriver | null;

  constructor(
    session: SessionRuntimePort,
    instruments: InstrumentCatalogPort,
    repo: BrokerRepository,
    stream: QuoteStreamPort | null,
    mcpDriver?: BrokerMcpDriver | null,
  ) {
    this._session = session;
    this._instruments = instruments;
    this._repo = repo;
    this._stream = stream;
    this._mcpDriver = mcpDriver ?? null;
  }

  // ── TickWork ────────────────────────────────────────────────────────────

  async doWork(_now: Date, _health: HealthStatus): Promise<void> {
    if (this._mcpDriver && this._session.isConfigured) {
      await this._runMcpMaintenance();
    }

    if (this._stream) {
      if (typeof this._stream.syncNow === 'function') {
        await this._stream.syncNow();
      }

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

    if (this._mcpDriver?.getCachedInstrumentKeyCount) {
      recentEvents.unshift({
        eventType: 'mcp_instrument_key_cache',
        recordedAt: Date.now(),
        durationMs: null,
        itemCount: this._mcpDriver.getCachedInstrumentKeyCount(),
        error: null,
      });
    }

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

  /** Whether broker integration is configured. */
  get isConfigured(): boolean {
    return this._session.isConfigured;
  }

  private async _runMcpMaintenance(): Promise<void> {
    if (this._session.needsRefresh()) {
      const material = await this._mcpDriver?.refreshSession() ?? null;
      this._session.applySessionMaterial(material, 'MCP session probe failed');

      if (!material) {
        throw new Error('Broker MCP session probe failed');
      }

      if (this._stream) {
        await this._stream.connect();
      }
    }

    const freshness = this._instruments.checkFreshness();
    const syncState = this._instruments.getSyncState();
    const refreshInterval = this._session.getSession().expiresAt > 0
      ? Math.max(60_000, this._session.getSession().expiresAt - Date.now())
      : null;

    const shouldRefreshInstruments = freshness.isStale
      || syncState.lastSuccessAt === null
      || refreshInterval === null
      || this._mcpDriver?.hasCachedInstrumentKeys?.() === false;
    if (shouldRefreshInstruments) {
      const records = await this._mcpDriver?.fetchInstrumentCatalog() ?? [];
      this._instruments.syncFromRecords(records);
    }

    this._ensureQuoteSubscriptions();
  }

  private _ensureQuoteSubscriptions(): void {
    if (!this._stream) return;

    const symbols = getEligibleSymbols('NSE');
    const sortedSymbols = [...symbols].sort();
    const tokens = sortedSymbols
      .map(symbol => this._instruments.getInstrument('NSE', symbol))
      .filter((instrument): instrument is NonNullable<typeof instrument> => Boolean(instrument))
      .map(instrument => instrument.instrumentToken);

    if (tokens.length === 0) {
      const fallback = this._instruments
        .getInstrumentsByExchange('NSE')
        .slice(0, 10)
        .map(instrument => instrument.instrumentToken);

      if (fallback.length > 0) {
        this._stream.subscribe(fallback);
      }
      return;
    }

    const diagnostics = this._stream.getDiagnostics();
    const expectedCount = new Set(tokens).size;
    if (diagnostics.subscribedCount === expectedCount) return;

    this._stream.subscribe(tokens);
  }
}

export { BrokerSupervisor as ZerodhaSupervisor };
