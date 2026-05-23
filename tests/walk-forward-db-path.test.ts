import { describe, expect, it } from 'vitest';

import {
  injectDefaultDbPathArg,
  resolveDefaultWalkForwardDbPath,
  resolveWalkForwardDbPath,
  resolveResearchDbPath,
} from '../src/replay/walk-forward-db-path.js';

describe('walk-forward DB path resolution', () => {
  it('prefers explicit CLI path over environment defaults', () => {
    const result = resolveWalkForwardDbPath(' ./data/custom.db ', {
      TRADER_WALK_FORWARD_DB_PATH: './data/wf.db',
      OPERATOR_UI_DB_PATH: './data/operator.db',
      TRADER_DB_PATH: './data/runtime.db',
    });

    expect(result).toBe('./data/custom.db');
  });

  it('prefers dedicated walk-forward env, then operator UI, then runtime DB path', () => {
    expect(resolveDefaultWalkForwardDbPath({
      TRADER_WALK_FORWARD_DB_PATH: './data/wf.db',
      OPERATOR_UI_DB_PATH: './data/operator.db',
      TRADER_DB_PATH: './data/runtime.db',
    })).toBe('./data/wf.db');

    expect(resolveDefaultWalkForwardDbPath({
      OPERATOR_UI_DB_PATH: './data/operator.db',
      TRADER_DB_PATH: './data/runtime.db',
    })).toBe('./data/operator.db');

    expect(resolveDefaultWalkForwardDbPath({
      TRADER_DB_PATH: './data/runtime.db',
    })).toBe('./data/runtime.db');
  });

  it('falls back to the canonical static DB when no env vars are set', () => {
    expect(resolveDefaultWalkForwardDbPath({})).toBe('./data/trader-upstox-static.db');
  });

  it('injects --db-path when the CLI args omit it', () => {
    const argv = injectDefaultDbPathArg(['--days', '30'], {
      OPERATOR_UI_DB_PATH: './data/operator.db',
    });

    expect(argv).toEqual(['--days', '30', '--db-path', './data/operator.db']);
  });

  it('does not inject a default when --db-path is already present', () => {
    const argv = injectDefaultDbPathArg(['--db-path', './data/already.db', '--days', '30'], {
      OPERATOR_UI_DB_PATH: './data/operator.db',
    });

    expect(argv).toEqual(['--db-path', './data/already.db', '--days', '30']);
  });
});

describe('resolveResearchDbPath', () => {
  it('returns the explicit path when provided', () => {
    expect(resolveResearchDbPath('./data/research.db')).toBe('./data/research.db');
    expect(resolveResearchDbPath('  ./data/research.db  ')).toBe('./data/research.db');
  });

  it('returns null when no explicit path is supplied', () => {
    expect(resolveResearchDbPath(undefined)).toBeNull();
    expect(resolveResearchDbPath('')).toBeNull();
    expect(resolveResearchDbPath('   ')).toBeNull();
  });

  it('never falls back to environment variables', () => {
    // Even with env vars set, resolveResearchDbPath must return null
    // when no explicit path is given.
    expect(
      resolveResearchDbPath(undefined),
    ).toBeNull();
  });
});
