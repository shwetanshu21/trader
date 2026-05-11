import type {
  InstrumentRecord,
  InstrumentSyncResult,
  InstrumentSyncState,
  QuoteFreshness,
  QuoteSnapshot,
  StreamDiagnostics,
  StreamState,
  BrokerSessionHealth,
  BrokerSessionRow,
} from '../../types/runtime.js';

export interface BrokerSessionMaterial {
  accessToken: string;
  expiresAt?: number;
  reason?: string;
}

export interface SessionRuntimePort {
  getSession(): BrokerSessionRow;
  getSessionHealth(): BrokerSessionHealth;
  needsRefresh(): boolean;
  applySessionMaterial(material: BrokerSessionMaterial | null, failureReason?: string): BrokerSessionRow;
  markExpired(reason: string): BrokerSessionRow;
  resetCredentials(): BrokerSessionRow;
  readonly isConfigured: boolean;
}

export interface InstrumentCatalogPort {
  syncFromRecords(records: InstrumentRecord[]): InstrumentSyncResult;
  getSyncState(): InstrumentSyncState;
  checkFreshness(): { isStale: boolean; stalenessMs: number | null };
  getInstrument(exchange: string, tradingsymbol: string): InstrumentRecord | null;
  getInstrumentByToken(instrumentToken: number): InstrumentRecord | null;
  getInstrumentsByExchange(exchange: string): InstrumentRecord[];
  getInstrumentsBySegment(segment: string): InstrumentRecord[];
}

export interface QuoteStreamPort {
  connect(...args: unknown[]): Promise<void> | void;
  disconnect(): Promise<void> | void;
  subscribe(tokens: number[]): Promise<void> | void;
  unsubscribe(tokens: number[]): Promise<void> | void;
  getLatestQuote(exchange: string, tradingsymbol: string): QuoteSnapshot | null;
  getAllQuotes(): QuoteSnapshot[];
  getState(): StreamState;
  getDiagnostics(): StreamDiagnostics;
  persistDiagnostics(): void;
  checkQuoteFreshness(): QuoteFreshness;
  syncNow?(): Promise<void>;
}

export interface BrokerHealthSource {
  getBrokerHealth(): import('../../types/runtime.js').BrokerHealth;
  readonly isConfigured: boolean;
}

export interface BrokerMcpDriver {
  refreshSession(): Promise<BrokerSessionMaterial | null>;
  fetchInstrumentCatalog(): Promise<InstrumentRecord[]>;
  hasCachedInstrumentKeys?(): boolean;
}

export type ZerodhaMcpDriver = BrokerMcpDriver;
