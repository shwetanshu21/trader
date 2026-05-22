// ── Operator read-only SQLite seam ──
//
// Opens the configured SQLite database in read-only/file-must-exist mode.
// No WAL pragma, no foreign-keys pragma, no schema migrations — the operator
// seam is a pure reader. Any attempted write through this connection will
// error deterministically.

import Database from 'better-sqlite3';

interface OpenOperatorDbOptions {
  maxAttempts?: number;
  initialBackoffMs?: number;
  backoffMultiplier?: number;
  openFactory?: (dbPath: string) => Database.Database;
  sleep?: (ms: number) => void;
}

/** Result of attempting to open the operator database. */
export interface OpenOperatorDbResult {
  /** The database handle, or null on failure. */
  db: Database.Database | null;
  /** Error message when db is null. */
  error: string | null;
  /** Number of open attempts that were made. */
  attempts: number;
  /** True when the DB eventually opened only after retrying. */
  recoveredAfterRetry: boolean;
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
export function openOperatorDb(dbPath: string, options?: OpenOperatorDbOptions): OpenOperatorDbResult {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
  const initialBackoffMs = Math.max(0, options?.initialBackoffMs ?? 50);
  const backoffMultiplier = Math.max(1, options?.backoffMultiplier ?? 2);
  const openFactory = options?.openFactory ?? ((targetPath: string) => new Database(targetPath, {
    readonly: true,
    fileMustExist: true,
  }));
  const sleep = options?.sleep ?? sleepSync;

  let attempts = 0;
  let lastError: string | null = null;
  let backoffMs = initialBackoffMs;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const db = openFactory(dbPath);
      return {
        db,
        error: null,
        attempts,
        recoveredAfterRetry: attempts > 1,
      };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempts >= maxAttempts || !isRetryableOpenError(lastError)) {
        break;
      }
      sleep(backoffMs);
      backoffMs *= backoffMultiplier;
    }
  }

  return {
    db: null,
    error: lastError,
    attempts,
    recoveredAfterRetry: false,
  };
}

function isRetryableOpenError(message: string | null): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes('unable to open database file') || lower.includes('sqlite_cantopen');
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
