// ── Operator read-only SQLite seam ──
//
// Opens the configured SQLite database in read-only/file-must-exist mode.
// No WAL pragma, no foreign-keys pragma, no schema migrations — the operator
// seam is a pure reader. Any attempted write through this connection will
// error deterministically.

import Database from 'better-sqlite3';

/** Result of attempting to open the operator database. */
export interface OpenOperatorDbResult {
  /** The database handle, or null on failure. */
  db: Database.Database | null;
  /** Error message when db is null. */
  error: string | null;
}

/**
 * Open a SQLite database file in read-only mode with no side effects.
 *
 * The database file MUST already exist (fileMustExist: true). No WAL,
 * foreign-key, or schema-migration pragmas are set — this is a pure reader.
 *
 * @param dbPath - Absolute or relative path to the SQLite database file.
 * @returns An OpenOperatorDbResult containing the handle (or null + error).
 */
export function openOperatorDb(dbPath: string): OpenOperatorDbResult {
  try {
    const db = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    return { db, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { db: null, error: message };
  }
}

/**
 * Open a SQLite database file in read-only mode, throwing on failure.
 *
 * Convenience wrapper around openOperatorDb for callers that prefer
 * exception-based control flow.
 *
 * @param dbPath - Absolute or relative path to the SQLite database file.
 * @returns The database handle.
 * @throws {Error} If the database file does not exist or cannot be opened.
 */
export function openOperatorDbOrThrow(dbPath: string): Database.Database {
  const result = openOperatorDb(dbPath);
  if (result.db === null) {
    throw new Error(`Failed to open operator database: ${result.error}`);
  }
  return result.db;
}

/**
 * Verify that a Database handle is operating in read-only mode.
 *
 * Probes by attempting to create a permanent (non-temp) table. On a read-only
 * connection this will throw because SQLite cannot modify the database file.
 * Does NOT leave any probe artifacts in the database — the CREATE fails before
 * any write occurs.
 *
 * @returns true if the connection rejects writes (read-only), false otherwise.
 */
export function isReadOnly(db: Database.Database): boolean {
  try {
    // Attempt to create a permanent table. This will fail deterministically
    // on a read-only connection because SQLite cannot modify the DB file.
    db.exec('CREATE TABLE IF NOT EXISTS _operator_probe (x INTEGER)');
    // If we get here without error, the connection IS writable.
    // Clean up the probe table.
    db.exec('DROP TABLE IF EXISTS _operator_probe');
    return false;
  } catch {
    // Write was rejected — this connection is read-only.
    return true;
  }
}

/**
 * Close the operator database connection gracefully.
 *
 * Safe to call when db is null (no-op).
 */
export function closeOperatorDb(db: Database.Database | null): void {
  if (db !== null) {
    db.close();
  }
}
