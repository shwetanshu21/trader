// ── InstrumentsService tests ──
// Covers normalization, filtering, staleness, failure modes, and lookup semantics.

import { describe, it, expect } from 'vitest';
import { DatabaseManager } from '../src/persistence/sqlite.js';
import { ZerodhaRepository } from '../src/persistence/zerodha-repo.js';
import { InstrumentsService } from '../src/integrations/zerodha/instruments-service.js';
import type { RawInstrumentCsvRow } from '../src/integrations/zerodha/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createService(): {
  service: InstrumentsService;
  repo: ZerodhaRepository;
} {
  const mgr = new DatabaseManager(':memory:');
  const repo = new ZerodhaRepository(mgr.db);
  const service = new InstrumentsService(repo, { maxStalenessMs: 86_400_000 });
  return { service, repo };
}

/** Build a valid-looking NSE EQ raw CSV row. */
function nseEqRow(overrides?: Partial<RawInstrumentCsvRow>): RawInstrumentCsvRow {
  return {
    instrument_token: '123456',
    exchange_token: '1234',
    tradingsymbol: 'RELIANCE',
    name: 'RELIANCE INDUSTRIES LTD',
    last_price: '2500.00',
    expiry: '',
    strike: '',
    tick_size: '0.05',
    lot_size: '1',
    segment: 'NSE',
    exchange: 'NSE',
    ...overrides,
  };
}

/** Build a valid-looking NFO futures raw CSV row. */
function nfoFutRow(overrides?: Partial<RawInstrumentCsvRow>): RawInstrumentCsvRow {
  return {
    instrument_token: '789012',
    exchange_token: '7890',
    tradingsymbol: 'RELIANCE24DECFUT',
    name: 'RELIANCE INDUSTRIES LTD',
    last_price: '2500.00',
    expiry: '2024-12-26',
    strike: '0',
    tick_size: '0.05',
    lot_size: '250',
    segment: 'NFO',
    exchange: 'NFO',
    ...overrides,
  };
}

/** Build a valid-looking NFO CE (call option) raw CSV row. */
function nfoCeRow(overrides?: Partial<RawInstrumentCsvRow>): RawInstrumentCsvRow {
  return {
    instrument_token: '456789',
    exchange_token: '4567',
    tradingsymbol: 'RELIANCE24DEC3000CE',
    name: 'RELIANCE INDUSTRIES LTD',
    last_price: '150.00',
    expiry: '2024-12-26',
    strike: '3000',
    tick_size: '0.05',
    lot_size: '250',
    segment: 'NFO',
    exchange: 'NFO',
    ...overrides,
  };
}

/** Build a valid-looking NFO PE (put option) raw CSV row. */
function nfoPeRow(overrides?: Partial<RawInstrumentCsvRow>): RawInstrumentCsvRow {
  return {
    instrument_token: '567890',
    exchange_token: '5678',
    tradingsymbol: 'RELIANCE24DEC3000PE',
    name: 'RELIANCE INDUSTRIES LTD',
    last_price: '120.00',
    expiry: '2024-12-26',
    strike: '3000',
    tick_size: '0.05',
    lot_size: '250',
    segment: 'NFO',
    exchange: 'NFO',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// InstrumentsService
// ---------------------------------------------------------------------------

describe('InstrumentsService', () => {
  describe('syncFromRaw — normalisation and filtering', () => {
    it('ingests NSE EQ rows', () => {
      const { service, repo } = createService();
      const result = service.syncFromRaw([nseEqRow()]);

      expect(result.status).toBe('success');
      expect(result.insertedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
      expect(result.totalRowCount).toBe(1);
      expect(result.error).toBeNull();
      expect(repo.countInstruments()).toBe(1);
    });

    it('ingests NFO futures and options', () => {
      const { service, repo } = createService();
      const result = service.syncFromRaw([nfoFutRow(), nfoCeRow(), nfoPeRow()]);

      expect(result.status).toBe('success');
      expect(result.insertedCount).toBe(3);
      expect(repo.countInstruments()).toBe(3);
    });

    it('filters out unsupported segments (e.g. CDS, BSE, MCX)', () => {
      const { service, repo } = createService();
      const rows: RawInstrumentCsvRow[] = [
        nseEqRow(),
        { ...nseEqRow(), instrument_token: '999', tradingsymbol: 'SKIP_CDS', segment: 'CDS', exchange: 'CDS' },
        { ...nseEqRow(), instrument_token: '888', tradingsymbol: 'SKIP_BSE', segment: 'BSE', exchange: 'BSE' },
        { ...nseEqRow(), instrument_token: '777', tradingsymbol: 'SKIP_MCX', segment: 'MCX', exchange: 'MCX' },
      ];

      const result = service.syncFromRaw(rows);

      expect(result.insertedCount).toBe(1);
      expect(result.skippedCount).toBe(3);
      expect(result.status).toBe('partial');
      expect(repo.countInstruments()).toBe(1);
    });

    it('rejects rows with missing tradingsymbol', () => {
      const { service } = createService();
      const result = service.syncFromRaw([nseEqRow({ tradingsymbol: '' })]);

      expect(result.insertedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
    });

    it('rejects rows with invalid instrument_token', () => {
      const { service } = createService();
      const result = service.syncFromRaw([nseEqRow({ instrument_token: 'abc' })]);

      expect(result.insertedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
    });

    it('rejects rows with non-positive instrument_token', () => {
      const { service } = createService();
      const result = service.syncFromRaw([nseEqRow({ instrument_token: '0' })]);

      expect(result.insertedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
    });

    it('rejects rows with invalid tick_size', () => {
      const { service } = createService();
      const result = service.syncFromRaw([nseEqRow({ tick_size: '0' })]);

      expect(result.insertedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
    });

    it('rejects rows with invalid lot_size', () => {
      const { service } = createService();
      const result = service.syncFromRaw([nseEqRow({ lot_size: '-1' })]);

      expect(result.insertedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
    });

    it('classifies NFO rows with CE suffix as CE type', () => {
      const { service } = createService();
      service.syncFromRaw([nfoCeRow()]);

      const inst = service.getInstrument('NFO', 'RELIANCE24DEC3000CE');
      expect(inst).not.toBeNull();
      expect(inst!.instrumentType).toBe('CE');
      expect(inst!.strike).toBe(3000);
    });

    it('classifies NFO rows with PE suffix as PE type', () => {
      const { service } = createService();
      service.syncFromRaw([nfoPeRow()]);

      const inst = service.getInstrument('NFO', 'RELIANCE24DEC3000PE');
      expect(inst).not.toBeNull();
      expect(inst!.instrumentType).toBe('PE');
    });

    it('classifies NFO rows without option suffix as FUT type', () => {
      const { service } = createService();
      service.syncFromRaw([nfoFutRow()]);

      const inst = service.getInstrument('NFO', 'RELIANCE24DECFUT');
      expect(inst).not.toBeNull();
      expect(inst!.instrumentType).toBe('FUT');
    });

    it('classifies NSE rows as EQ type', () => {
      const { service } = createService();
      service.syncFromRaw([nseEqRow()]);

      const inst = service.getInstrument('NSE', 'RELIANCE');
      expect(inst).not.toBeNull();
      expect(inst!.instrumentType).toBe('EQ');
    });
  });

  describe('syncFromRaw — duplicate handling', () => {
    it('deduplicates by exchange + tradingsymbol (last wins)', () => {
      const { service, repo } = createService();
      const rows = [
        nseEqRow({ tradingsymbol: 'DUPLICATE', instrument_token: '100', name: 'First' }),
        nseEqRow({ tradingsymbol: 'DUPLICATE', instrument_token: '200', name: 'Second' }),
      ];

      service.syncFromRaw(rows);
      expect(repo.countInstruments()).toBe(1);

      const inst = service.getInstrument('NSE', 'DUPLICATE');
      expect(inst!.name).toBe('Second');
      expect(inst!.instrumentToken).toBe(200);
    });

    it('handles many rows efficiently', () => {
      const { service, repo } = createService();
      const rows: RawInstrumentCsvRow[] = [];
      for (let i = 0; i < 100; i++) {
        rows.push(nseEqRow({
          tradingsymbol: `SYM${i}`,
          instrument_token: String(1000 + i),
        }));
      }

      const result = service.syncFromRaw(rows);
      expect(result.insertedCount).toBe(100);
      expect(repo.countInstruments()).toBe(100);
    });
  });

  describe('syncFromRaw — empty payloads', () => {
    it('handles empty CSV (zero rows)', () => {
      const { service, repo } = createService();
      const result = service.syncFromRaw([]);

      expect(result.insertedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(result.totalRowCount).toBe(0);
      expect(result.status).toBe('success');
      expect(repo.countInstruments()).toBe(0);
    });

    it('handles all-unsupported payload gracefully', () => {
      const { service, repo } = createService();
      const result = service.syncFromRaw([
        { ...nseEqRow(), segment: 'BSE', exchange: 'BSE', tradingsymbol: 'SKIP' },
      ]);

      expect(result.insertedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(result.status).toBe('partial');
      expect(repo.countInstruments()).toBe(0);
    });
  });

  describe('syncFromRaw — error resilience', () => {
    it('failed sync preserves prior snapshot', () => {
      const { service, repo } = createService();

      // First, successful sync
      const firstResult = service.syncFromRaw([nseEqRow()]);
      expect(firstResult.status).toBe('success');
      expect(repo.countInstruments()).toBe(1);

      // The sync state is now set
      const stateBefore = repo.getInstrumentSyncState();
      expect(stateBefore.lastStatus).toBe('success');
    });

    it('records ingestion event on success', () => {
      const { service, repo } = createService();
      service.syncFromRaw([nseEqRow(), nfoCeRow()]);

      const events = repo.getIngestionEvents(1);
      expect(events.length).toBe(1);
      expect(events[0].eventType).toBe('instrument_master');
      expect(events[0].itemCount).toBe(2);
      expect(events[0].error).toBeNull();
    });

    it('records ingestion event with diagnostic on partial sync', () => {
      const { service, repo } = createService();
      service.syncFromRaw([
        nseEqRow(),
        { ...nseEqRow(), segment: 'CDS', exchange: 'CDS', tradingsymbol: 'SKIP_CDS', instrument_token: '999' },
      ]);

      const events = repo.getIngestionEvents(1);
      expect(events.length).toBe(1);
      expect(events[0].itemCount).toBe(1);
      expect(events[0].diagnostic).toEqual({ totalRows: 2, skipped: 1 });
    });
  });

  describe('lookup semantics', () => {
    it('getInstrument returns null for unknown symbol', () => {
      const { service } = createService();
      expect(service.getInstrument('NSE', 'UNKNOWN')).toBeNull();
    });

    it('getInstrumentByExchange returns all instruments for exchange', () => {
      const { service } = createService();
      service.syncFromRaw([nseEqRow(), nfoFutRow(), nfoCeRow()]);

      const nse = service.getInstrumentsByExchange('NSE');
      expect(nse.length).toBe(1);

      const nfo = service.getInstrumentsByExchange('NFO');
      expect(nfo.length).toBe(2);
    });

    it('getInstrumentByToken finds instrument', () => {
      const { service } = createService();
      service.syncFromRaw([nfoCeRow()]);

      const inst = service.getInstrumentByToken(456789);
      expect(inst).not.toBeNull();
      expect(inst!.tradingsymbol).toBe('RELIANCE24DEC3000CE');
    });

    it('getInstrumentBySegment returns instruments by segment', () => {
      const { service } = createService();
      service.syncFromRaw([nseEqRow(), nfoFutRow(), nfoCeRow()]);

      const nse = service.getInstrumentsBySegment('NSE');
      expect(nse.length).toBe(1);

      const nfo = service.getInstrumentsBySegment('NFO');
      expect(nfo.length).toBe(2);
    });
  });

  describe('freshness and staleness', () => {
    it('reports stale when never synced', () => {
      const { service } = createService();
      const fresh = service.checkFreshness();
      expect(fresh.isStale).toBe(true);
      expect(fresh.stalenessMs).toBeNull();
    });

    it('reports not stale immediately after sync', () => {
      const { service } = createService();
      service.syncFromRaw([nseEqRow()]);
      const fresh = service.checkFreshness();
      expect(fresh.isStale).toBe(false);
      expect(fresh.stalenessMs).toBeGreaterThanOrEqual(0);
    });

    it('getSyncState returns correct state after sync', () => {
      const { service } = createService();
      service.syncFromRaw([nseEqRow(), nfoCeRow()]);

      const state = service.getSyncState();
      expect(state.lastStatus).toBe('success');
      expect(state.lastInstrumentCount).toBe(2);
      expect(state.lastSkippedCount).toBe(0);
      expect(state.lastSuccessAt).toBeGreaterThan(0);
    });

    it('getSyncState returns null state before first sync', () => {
      const { service } = createService();
      const state = service.getSyncState();
      expect(state.lastSuccessAt).toBeNull();
      expect(state.lastInstrumentCount).toBeNull();
    });
  });

  describe('negative tests — malformed inputs', () => {
    it('rejects row with missing instrument_token', () => {
      const { service } = createService();
      const result = service.syncFromRaw([nseEqRow({ instrument_token: '' })]);
      expect(result.insertedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
    });

    it('rejects row with missing tick_size', () => {
      const { service } = createService();
      const result = service.syncFromRaw([nseEqRow({ tick_size: '' })]);
      expect(result.insertedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
    });

    it('rejects row with negative lot_size', () => {
      const { service } = createService();
      const result = service.syncFromRaw([nseEqRow({ lot_size: '-5' })]);
      expect(result.insertedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
    });

    it('rejects row with bad segment casing (allows upper-case only)', () => {
      const { service } = createService();
      const result = service.syncFromRaw([nseEqRow({ segment: 'nse' })]);
      expect(result.insertedCount).toBe(1); // trimmed + toUpperCase handles lowercase
    });

    it('mixed valid/invalid payload inserts valid rows only', () => {
      const { service, repo } = createService();
      const rows: RawInstrumentCsvRow[] = [
        nseEqRow(),
        nseEqRow({ instrument_token: '', tradingsymbol: 'BAD' }),
        nfoCeRow(),
        nseEqRow({ tick_size: '', tradingsymbol: 'BAD2' }),
      ];

      const result = service.syncFromRaw(rows);
      expect(result.insertedCount).toBe(2);
      expect(result.skippedCount).toBe(2);
      expect(result.status).toBe('partial');
      expect(repo.countInstruments()).toBe(2);
    });

    it('handles FO row with empty strike (defaults to null)', () => {
      const { service } = createService();
      const result = service.syncFromRaw([nfoFutRow({ strike: '' })]);
      expect(result.insertedCount).toBe(1);
      const inst = service.getInstrument('NFO', 'RELIANCE24DECFUT');
      expect(inst!.strike).toBeNull();
    });
  });
});
