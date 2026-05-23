import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_WALK_FORWARD_DB_PATH = './data/trader-upstox-static.db';
const ENV_CANDIDATES = [
  'TRADER_WALK_FORWARD_DB_PATH',
  'OPERATOR_UI_DB_PATH',
  'TRADER_DB_PATH',
] as const;

function hasCliDbPath(argv: readonly string[]): boolean {
  return argv.includes('--db-path');
}

export function loadProjectEnvFile(cwd: string = process.cwd()): void {
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const processWithLoader = process as typeof process & {
    loadEnvFile?: (file?: string) => void;
  };
  processWithLoader.loadEnvFile?.(envPath);
}

export function resolveDefaultWalkForwardDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  for (const key of ENV_CANDIDATES) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return DEFAULT_WALK_FORWARD_DB_PATH;
}

export function resolveWalkForwardDbPath(
  explicitPath: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const trimmed = explicitPath?.trim();
  return trimmed ? trimmed : resolveDefaultWalkForwardDbPath(env);
}

/**
 * Resolve a research DB path from an explicit argument only.
 * Returns `null` when no explicit path is supplied — no env fallback.
 * This prevents research tooling from silently drifting to the live
 * runtime DB when the caller forgot to supply an isolated path.
 */
export function resolveResearchDbPath(
  explicitPath: string | undefined,
): string | null {
  const trimmed = explicitPath?.trim();
  return trimmed ? trimmed : null;
}

export function injectDefaultDbPathArg(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (hasCliDbPath(argv)) {
    return [...argv];
  }
  return [...argv, '--db-path', resolveDefaultWalkForwardDbPath(env)];
}
