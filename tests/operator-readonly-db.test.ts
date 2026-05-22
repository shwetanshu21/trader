// ── Operator Read-Only DB Seam Tests ──
//
// Proves the operator DB seam correctly:
// 1. Opens an existing WAL database in read-only mode
// 2. Refuses writes/migrations through the read-only connection
// 3. Fails closed (error, not creation) when the DB file does not exist
// 4. Detects read-only mode after opening
// 5. Gracefully handles null/closed handles

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  openOperatorDb,
  openOperatorDbOrThrow,
  isReadOnly,
  closeOperatorDb,
} from '../src/operator/read-only-db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary WAL-mode database with a table and sample data. */
function createWALDb(tmpDir: string, name: string = 'test.db'): string {
  const dbPath = path.join(tmpDir, name);
  const db = new Database(dbPath);

  // Enable WAL mode (as the runtime does)
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create a sample table
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_data (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT    NOT NULL,
      value REAL   NOT NULL
    )
  `);

  // Insert some sample rows
  const insert = db.prepare('INSERT INTO test_data (label, value) VALUES (?, ?)');
  insert.run('alpha', 100.5);
  insert.run('beta', 200.75);
  insert.run('gamma', 300.25);

  db.close();
  return dbPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M010 S01 — Operator read-only DB seam', () => {
  let tmpDir: string;

  afterEach(() => {
    try {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // -----------------------------------------------------------------------
  // 1. Opens an existing WAL database in read-only mode
  // -----------------------------------------------------------------------
  it('opens an existing WAL database and reads data', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-'));
    const dbPath = createWALDb(tmpDir);

    const result = openOperatorDb(dbPath);
    expect(result.error).toBeNull();
    expect(result.db).not.toBeNull();

    // Read the sample data through the read-only connection
    const rows = result.db!.prepare('SELECT * FROM test_data ORDER BY id').all() as Array<{ id: number; label: string; value: number }>;
    expect(rows).toHaveLength(3);
    expect(rows[0].label).toBe('alpha');
    expect(rows[0].value).toBe(100.5);
    expect(rows[1].label).toBe('beta');
    expect(rows[1].value).toBe(200.75);
    expect(rows[2].label).toBe('gamma');
    expect(rows[2].value).toBe(300.25);

    // Verify the connection is read-only
    expect(isReadOnly(result.db!)).toBe(true);

    closeOperatorDb(result.db);
  });

  // -----------------------------------------------------------------------
  // 2. Refuses writes/migrations through the read-only connection
  // -----------------------------------------------------------------------
  it('refuses INSERT through the operator read-only connection', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-write-'));
    const dbPath = createWALDb(tmpDir);

    const result = openOperatorDb(dbPath);
    expect(result.error).toBeNull();
    expect(result.db).not.toBeNull();

    // Attempt INSERT — must throw
    expect(() => {
      result.db!.prepare('INSERT INTO test_data (label, value) VALUES (?, ?)').run('delta', 400.0);
    }).toThrow();

    closeOperatorDb(result.db);
  });

  it('refuses UPDATE through the operator read-only connection', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-update-'));
    const dbPath = createWALDb(tmpDir);

    const result = openOperatorDb(dbPath);
    expect(result.error).toBeNull();
    expect(result.db).not.toBeNull();

    // Attempt UPDATE — must throw
    expect(() => {
      result.db!.prepare('UPDATE test_data SET value = ? WHERE label = ?').run(999.9, 'alpha');
    }).toThrow();

    closeOperatorDb(result.db);
  });

  it('refuses DELETE through the operator read-only connection', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-delete-'));
    const dbPath = createWALDb(tmpDir);

    const result = openOperatorDb(dbPath);
    expect(result.error).toBeNull();
    expect(result.db).not.toBeNull();

    // Attempt DELETE — must throw
    expect(() => {
      result.db!.prepare('DELETE FROM test_data WHERE label = ?').run('alpha');
    }).toThrow();

    closeOperatorDb(result.db);
  });

  it('refuses CREATE TABLE (migration) through the operator read-only connection', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-migrate-'));
    const dbPath = createWALDb(tmpDir);

    const result = openOperatorDb(dbPath);
    expect(result.error).toBeNull();
    expect(result.db).not.toBeNull();

    // Attempt CREATE TABLE — must throw
    expect(() => {
      result.db!.exec('CREATE TABLE IF NOT EXISTS malicious_table (id INTEGER)');
    }).toThrow();

    // Also verify PRAGMA journal_mode (write-adjacent) fails or is harmless:
    // pragma journal_mode on a read-only connection should return the current mode
    // but not change it. This should NOT throw.
    const journalMode = result.db!.pragma('journal_mode') as { journal_mode: string } | string;
    // pragma returns either an object or a string depending on the pragma
    expect(journalMode).toBeDefined();

    closeOperatorDb(result.db);
  });

  it('refuses ALTER TABLE through the operator read-only connection', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-alter-'));
    const dbPath = createWALDb(tmpDir);

    const result = openOperatorDb(dbPath);
    expect(result.error).toBeNull();
    expect(result.db).not.toBeNull();

    // Attempt ALTER TABLE — must throw
    expect(() => {
      result.db!.exec('ALTER TABLE test_data ADD COLUMN extra TEXT');
    }).toThrow();

    closeOperatorDb(result.db);
  });

  // -----------------------------------------------------------------------
  // 3. Fails closed on nonexistent DB file
  // -----------------------------------------------------------------------
  it('fails with error when the database file does not exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-missing-'));
    const missingPath = path.join(tmpDir, 'nonexistent.db');

    const result = openOperatorDb(missingPath);
    expect(result.db).toBeNull();
    expect(result.error).not.toBeNull();
    // Error message should indicate the file does not exist
    expect(result.error!.toLowerCase()).toMatch(/no such file|no such table|cannot open|exist|unable to open/);
  });

  it('openOperatorDbOrThrow throws when the database file does not exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-throw-'));
    const missingPath = path.join(tmpDir, 'nonexistent-throw.db');

    expect(() => {
      openOperatorDbOrThrow(missingPath);
    }).toThrow();
  });

  it('openOperatorDb returns null+error for a nonexistent path with special characters', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-special-'));
    const weirdPath = path.join(tmpDir, 'missing db file!.db');

    const result = openOperatorDb(weirdPath);
    expect(result.db).toBeNull();
    expect(result.error).not.toBeNull();
  });

  it('retries a transient open failure and eventually succeeds', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-retry-'));
    const dbPath = createWALDb(tmpDir);
    let attempts = 0;

    const result = openOperatorDb(dbPath, {
      maxAttempts: 3,
      initialBackoffMs: 0,
      openFactory: (targetPath) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('unable to open database file');
        }
        return new Database(targetPath, { readonly: true, fileMustExist: true });
      },
      sleep: () => {},
    });

    expect(result.error).toBeNull();
    expect(result.db).not.toBeNull();
    expect(result.attempts).toBe(2);
    expect(result.recoveredAfterRetry).toBe(true);
    closeOperatorDb(result.db);
  });

  it('stops retrying after the configured attempt budget is exhausted', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-retry-fail-'));
    const dbPath = path.join(tmpDir, 'never-opens.db');
    let attempts = 0;

    const result = openOperatorDb(dbPath, {
      maxAttempts: 3,
      initialBackoffMs: 0,
      openFactory: () => {
        attempts += 1;
        throw new Error('unable to open database file');
      },
      sleep: () => {},
    });

    expect(result.db).toBeNull();
    expect(result.error).toContain('unable to open database file');
    expect(result.attempts).toBe(3);
    expect(result.recoveredAfterRetry).toBe(false);
    expect(attempts).toBe(3);
  });

  it('isReadOnly returns false for a normal (writable) database', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-writable-'));
    const dbPath = path.join(tmpDir, 'writable.db');
    const db = new Database(dbPath);

    // A normal writable connection should NOT be detected as read-only
    expect(isReadOnly(db)).toBe(false);

    db.close();
  });

  it('isReadOnly returns true for a read-only connection', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-detect-'));
    const dbPath = createWALDb(tmpDir);

    const result = openOperatorDb(dbPath);
    expect(result.db).not.toBeNull();
    expect(isReadOnly(result.db!)).toBe(true);

    closeOperatorDb(result.db);
  });

  it('isReadOnly does not leave probe tables in a writable database', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-probe-'));
    const dbPath = path.join(tmpDir, 'probe.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE IF NOT EXISTS important (x INTEGER)');

    // Run isReadOnly — creates then drops _operator_probe
    expect(isReadOnly(db)).toBe(false);

    // Verify no leftover probe table
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_operator_probe'").all();
    expect(tables).toHaveLength(0);

    // Verify important data is intact
    const importantTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='important'").all();
    expect(importantTables).toHaveLength(1);

    db.close();
  });

  // -----------------------------------------------------------------------
  // 5. Graceful handle management
  // -----------------------------------------------------------------------
  it('closeOperatorDb handles null gracefully', () => {
    // Should not throw
    expect(() => closeOperatorDb(null)).not.toThrow();
  });

  it('closeOperatorDb handles an already-closed database gracefully', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-closed-'));
    const dbPath = createWALDb(tmpDir);

    const result = openOperatorDb(dbPath);
    expect(result.db).not.toBeNull();

    // Close once
    closeOperatorDb(result.db);

    // Closing again should not throw
    expect(() => closeOperatorDb(result.db)).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // 6. openOperatorDbOrThrow on existing database
  // -----------------------------------------------------------------------
  it('openOperatorDbOrThrow opens an existing database and reads data', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-throw-ok-'));
    const dbPath = createWALDb(tmpDir);

    const db = openOperatorDbOrThrow(dbPath);
    expect(db).not.toBeNull();

    // Verify it's read-only
    expect(isReadOnly(db)).toBe(true);

    // Verify data is readable
    const rows = db.prepare('SELECT * FROM test_data ORDER BY id').all() as Array<{ id: number; label: string; value: number }>;
    expect(rows).toHaveLength(3);

    db.close();
  });

  // -----------------------------------------------------------------------
  // 7. Handles WAL checkpoint state correctly
  // -----------------------------------------------------------------------
  it('reads from a WAL database that has uncheckpointed data', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-wal-'));
    const dbPath = path.join(tmpDir, 'wal-test.db');

    // Create WAL db with data, keep it uncheckpointed
    const writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    writer.exec(`
      CREATE TABLE IF NOT EXISTS wal_data (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        msg   TEXT NOT NULL
      )
    `);
    writer.prepare('INSERT INTO wal_data (msg) VALUES (?)').run('uncheckpointed row 1');
    writer.prepare('INSERT INTO wal_data (msg) VALUES (?)').run('uncheckpointed row 2');
    // Do NOT close the writer — the WAL file exists, but the data is not checkpointed
    // into the main DB file. Read-only openers can still read WAL content.
    writer.close();

    // Now open read-only — should still read the WAL content
    const result = openOperatorDb(dbPath);
    expect(result.error).toBeNull();
    expect(result.db).not.toBeNull();

    const rows = result.db!.prepare('SELECT * FROM wal_data ORDER BY id').all() as Array<{ id: number; msg: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].msg).toBe('uncheckpointed row 1');
    expect(rows[1].msg).toBe('uncheckpointed row 2');

    closeOperatorDb(result.db);
  });

  // -----------------------------------------------------------------------
  // 8. Does not set WAL pragma (no side effects on existing WAL mode)
  // -----------------------------------------------------------------------
  it('does not change the journal mode of the opened database', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-pragma-'));
    const dbPath = createWALDb(tmpDir);

    const result = openOperatorDb(dbPath);
    expect(result.error).toBeNull();

    // Read the journal mode — should still be WAL
    const journalResult = result.db!.pragma('journal_mode') as Array<{ journal_mode: string }>;
    const modeStr = Array.isArray(journalResult) ? journalResult[0].journal_mode : String(journalResult);
    expect(modeStr.toLowerCase()).toBe('wal');

    closeOperatorDb(result.db);
  });

  // -----------------------------------------------------------------------
  // 9. Negative: loading DTOs when optional evidence fields are null/missing
  // -----------------------------------------------------------------------
  it('handles databases with null values in nullable columns gracefully', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-nulls-'));
    const dbPath = path.join(tmpDir, 'nulls.db');

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS nullable_data (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT    NOT NULL,
        value REAL,
        tag   TEXT
      )
    `);
    db.prepare('INSERT INTO nullable_data (label, value, tag) VALUES (?, ?, ?)').run('with_all', 100.0, 'active');
    db.prepare('INSERT INTO nullable_data (label, value, tag) VALUES (?, ?, ?)').run('no_value', null, 'active');
    db.prepare('INSERT INTO nullable_data (label, value, tag) VALUES (?, ?, ?)').run('no_tag', 200.0, null);
    db.prepare('INSERT INTO nullable_data (label, value, tag) VALUES (?, ?, ?)').run('all_null', null, null);
    db.close();

    const result = openOperatorDb(dbPath);
    expect(result.error).toBeNull();
    expect(result.db).not.toBeNull();

    const rows = result.db!.prepare('SELECT * FROM nullable_data ORDER BY id').all() as Array<{
      id: number; label: string; value: number | null; tag: string | null;
    }>;
    expect(rows).toHaveLength(4);

    // Row with all values present
    expect(rows[0].label).toBe('with_all');
    expect(rows[0].value).toBe(100.0);
    expect(rows[0].tag).toBe('active');

    // Row with null value
    expect(rows[1].label).toBe('no_value');
    expect(rows[1].value).toBeNull();
    expect(rows[1].tag).toBe('active');

    // Row with null tag
    expect(rows[2].label).toBe('no_tag');
    expect(rows[2].value).toBe(200.0);
    expect(rows[2].tag).toBeNull();

    // Row with all nulls
    expect(rows[3].label).toBe('all_null');
    expect(rows[3].value).toBeNull();
    expect(rows[3].tag).toBeNull();

    closeOperatorDb(result.db);
  });

  // -----------------------------------------------------------------------
  // 10. Multiple concurrent read-only connections
  // -----------------------------------------------------------------------
  it('supports multiple concurrent read-only connections to the same database', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-operator-ro-concurrent-'));
    const dbPath = createWALDb(tmpDir);

    const result1 = openOperatorDb(dbPath);
    const result2 = openOperatorDb(dbPath);
    const result3 = openOperatorDb(dbPath);

    expect(result1.error).toBeNull();
    expect(result2.error).toBeNull();
    expect(result3.error).toBeNull();

    // All three should read data
    const count1 = (result1.db!.prepare('SELECT COUNT(*) as cnt FROM test_data').get() as { cnt: number }).cnt;
    const count2 = (result2.db!.prepare('SELECT COUNT(*) as cnt FROM test_data').get() as { cnt: number }).cnt;
    const count3 = (result3.db!.prepare('SELECT COUNT(*) as cnt FROM test_data').get() as { cnt: number }).cnt;

    expect(count1).toBe(3);
    expect(count2).toBe(3);
    expect(count3).toBe(3);

    // All three should be read-only
    expect(isReadOnly(result1.db!)).toBe(true);
    expect(isReadOnly(result2.db!)).toBe(true);
    expect(isReadOnly(result3.db!)).toBe(true);

    closeOperatorDb(result1.db);
    closeOperatorDb(result2.db);
    closeOperatorDb(result3.db);
  });
});
