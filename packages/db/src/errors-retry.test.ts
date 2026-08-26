// May a client run this again? The classification every db code carries into `--json`, asserted on
// the RENDERED document rather than on the table — the table is a declaration, the JSON is the
// contract an HTTP client and a job worker read.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { ErrorRetry } from '@ultimat3/core';
import { declaredErrorRetry, registerErrorRetry } from '@ultimat3/core';
import {
  DB_ERROR_RETRY,
  DB_OWNED_ERROR_CODES,
  type DbError,
  dbUnavailable,
  driverError,
  poolAcquireTimeout,
} from './errors';
import { migrateConcurrent } from './migration-errors';

/**
 * Sampled at MODULE SCOPE — before any hook runs, and therefore before the `beforeEach` below.
 * The question "does IMPORTING this package classify its codes" cannot be asked after a hook has
 * re-registered the table: measured, commenting out `registerErrorRetry(DB_ERROR_RETRY)` left this
 * suite 9 of 9 green. A `Map`, not an object literal, because the key is a value on every read.
 */
const atImport = new Map<string, ErrorRetry | undefined>(
  DB_OWNED_ERROR_CODES.map((code) => [code, declaredErrorRetry(code)]),
);

beforeEach(() => {
  // Idempotent: re-registering the same value is allowed, so another file's `resetErrorRetry`
  // cannot leave this suite reading an empty registry. `execute-retry.test.ts` states the same.
  // It protects the RENDERED assertions below, which construct their errors at test time.
  registerErrorRetry(DB_ERROR_RETRY);
});

/** What a client actually receives — `toJSON` through a real serialisation, never the instance. */
const rendered = (error: DbError): unknown =>
  (JSON.parse(JSON.stringify(error)) as { retry?: unknown }).retry;

const driver = (state: string): DbError =>
  driverError(
    'statement failed: update ledger',
    Object.assign(new Error('the server said so'), {
      code: 'ERR_POSTGRES_SERVER_ERROR',
      errno: state,
    }),
  );

describe('the transient codes say so in --json', () => {
  test('a lost serialization race is retryable, where it rendered terminal', () => {
    // The whole point of the code: its own `fix:` is `withTransaction(fn, { retry: 3 })`, and it
    // told every client reading the document NOT to come back.
    expect(rendered(driver('40001'))).toBe('retryable');
    expect(rendered(driver('40P01'))).toBe('retryable');
  });

  test('a lock timeout is retryable — the blocker lets go', () => {
    expect(rendered(driver('55P03'))).toBe('retryable');
  });

  test('an exhausted pool is retryable, from the server and from the acquire timeout', () => {
    expect(rendered(driver('53300'))).toBe('retryable');
    expect(rendered(poolAcquireTimeout(5_000, 20))).toBe('retryable');
  });

  test('a concurrent migrator is retryable — the other one finishes', () => {
    expect(rendered(migrateConcurrent(4_242, 30_000))).toBe('retryable');
  });
});

describe('the permanent codes stay terminal, which is the point of failing closed', () => {
  test('a unique violation and a foreign key violation are the same answer forever', () => {
    expect(rendered(driver('23505'))).toBe('terminal');
    expect(rendered(driver('23503'))).toBe('terminal');
  });

  test('a statement timeout stays terminal — its own fix is an index, not a wait', () => {
    expect(rendered(driver('57014'))).toBe('terminal');
  });

  test('X_DB_UNAVAILABLE stays terminal: four of its six throw sites are config faults', () => {
    // `DATABASE_URL is not set`, `not a valid url`, `Bun.SQL is unavailable`, `no PGlite data
    // directory`. A client retrying any of them retries forever against a fault only an edit fixes.
    expect(rendered(dbUnavailable('DATABASE_URL is not set'))).toBe('terminal');
  });
});

describe('the table', () => {
  test('it lists the exceptions only, and every one of them is retryable', () => {
    expect(Object.keys(DB_ERROR_RETRY).sort()).toEqual([
      'X_DB_LOCK_TIMEOUT',
      'X_DB_POOL_EXHAUSTED',
      'X_DB_SERIALIZATION_FAILURE',
      'X_MIGRATE_CONCURRENT',
    ]);
    for (const [code, retry] of Object.entries(DB_ERROR_RETRY))
      expect(retry, code).toBe('retryable');
  });

  test('nothing is registered AS terminal, and that is the decision, not an oversight', () => {
    // A REGISTERED `terminal` is read by `@ultimat3/jobs` as "dead-letter on attempt 1", where an
    // unclassified code keeps the job's attempt count. Registering `X_DB_UNAVAILABLE: 'terminal'`
    // would dead-letter every in-flight job the moment Postgres fails over. Adding one here is a
    // decision that has to be made on purpose, so this test makes it a failing test first.
    const listed = new Set(Object.keys(DB_ERROR_RETRY));
    for (const code of DB_OWNED_ERROR_CODES) {
      if (listed.has(code)) continue;
      expect(atImport.get(code), code).toBeUndefined();
    }
  });

  test('IMPORTING the package registers every entry — a table nobody registers classifies nothing', () => {
    for (const [code, retry] of Object.entries(DB_ERROR_RETRY)) {
      expect(atImport.get(code), code).toBe(retry);
    }
  });
});
