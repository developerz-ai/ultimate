// "Which store backs this seam" was a per-app ternary with three different predicates — the
// environment in two places, `DATABASE_URL` in a third — so under `x dev` one seam sat in memory
// while every repository read the embedded Postgres. One answer, decided once.

import { describe, expect, test } from 'bun:test';
import { STORE_MODES, storeMode } from './store-mode';

describe('storeMode', () => {
  test('`bun test` is memory: no database client is installed there', () => {
    expect(storeMode({ NODE_ENV: 'test' })).toBe('memory');
    expect(storeMode({ ULTIMATE_ENV: 'test', NODE_ENV: 'production' })).toBe('memory');
  });

  test('every other environment is the database, with or without a DATABASE_URL', () => {
    // `x dev` installs the embedded PGlite as the process client and sets no DATABASE_URL, which
    // is exactly the case the `DATABASE_URL` predicate answered wrong.
    expect(storeMode({})).toBe('database');
    expect(storeMode({ NODE_ENV: 'development' })).toBe('database');
    expect(storeMode({ ULTIMATE_ENV: 'staging' })).toBe('database');
    expect(storeMode({ NODE_ENV: 'production', DATABASE_URL: '' })).toBe('database');
  });

  test('a DATABASE_URL does not move a test onto the database', () => {
    expect(storeMode({ NODE_ENV: 'test', DATABASE_URL: 'postgres://db/app' })).toBe('memory');
  });

  test('an unknown ULTIMATE_ENV is refused, the same refusal resolveEnvironment makes', () => {
    expect(() => storeMode({ ULTIMATE_ENV: 'prod' })).toThrow(
      expect.objectContaining({ code: 'X_ENVIRONMENT_INVALID' }),
    );
  });

  test('names exactly two modes', () => {
    expect(STORE_MODES).toEqual(['memory', 'database']);
  });
});
