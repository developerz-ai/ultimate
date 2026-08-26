// Single responsibility: the typed-driver-failure half of the error registry. A `fix:` an operator
// copies has to be true, and until this shipped every driver failure carried the same one — "set
// DATABASE_URL to a reachable Postgres url" — including the unique violations, the timeouts and
// the lost serialization races, none of which is a reachability problem.

import { describe, expect, test } from 'bun:test';
import {
  DB_ERROR_TITLES,
  DB_OWNED_ERROR_CODES,
  driverError,
  poolAcquireTimeout,
  poolMaxInvalid,
  serializationExhausted,
} from './errors';
import { migrateConcurrent } from './migration-errors';
import { DB_SQLSTATE_CODES } from './sqlstate';

describe('DB_OWNED_ERROR_CODES', () => {
  test('is exactly the set this package declares and can throw', () => {
    // A code is a shipped promise: `x errors explain` answers from this registry and
    // `wiki/Error-Codes.md` carries its row, so one arriving or leaving is a deliberate edit here.
    // No `X_READONLY_VIOLATION`: it was thrown only by `readOnly()`, a regex-gated client wrapper
    // with zero callers whose keyword list was materially weaker than the guard the one real
    // consumer uses (`@ultimat3/mcp`'s parse guard, over `readOnlyQuery`'s `BEGIN READ ONLY`).
    expect([...DB_OWNED_ERROR_CODES].sort()).toEqual([
      'X_BRANCH_EXISTS',
      'X_DB_DRIFT',
      'X_DB_FOREIGN_KEY_VIOLATION',
      'X_DB_LOCK_TIMEOUT',
      'X_DB_POOL_EXHAUSTED',
      'X_DB_SERIALIZATION_FAILURE',
      'X_DB_STATEMENT_TIMEOUT',
      'X_DB_UNAVAILABLE',
      'X_DB_UNIQUE_VIOLATION',
      'X_MIGRATE_CONCURRENT',
      'X_MIGRATION_CONFLICT',
      'X_MIGRATION_DESTRUCTIVE',
      'X_MIGRATION_IRREVERSIBLE',
      'X_MIGRATION_SNAPSHOT_MISSING',
      'X_MIGRATION_VIEW_DEPENDS',
      'X_SQL_UNSAFE',
    ]);
  });

  test('every owned code carries a title', () => {
    // Widened to `string[]` on purpose: the two sides are the SAME set read two ways, and the
    // question is whether the title map has a hole, which a literal-union actual cannot ask.
    const owned: readonly string[] = [...DB_OWNED_ERROR_CODES].sort();
    expect(owned).toEqual(Object.keys(DB_ERROR_TITLES).sort());
  });
});

const serverError = (state: string, extra: Record<string, unknown> = {}): unknown =>
  Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
    name: 'PostgresError',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: state,
    ...extra,
  });

describe('driverError', () => {
  test('a unique violation is NOT reported as an unreachable database', () => {
    // The whole finding: two clicks race a signup, Postgres answers 23505, and the operator was
    // told the database could not be reached — a page for an outage that never happened.
    const error = driverError('statement failed: insert into users', serverError('23505'));

    expect(error.code).toBe('X_DB_UNIQUE_VIOLATION');
    expect(error.fix).not.toContain('DATABASE_URL');
    expect(error.cause).toContain('SQLSTATE 23505');
    expect(error.cause).toContain('users_email_key');
  });

  test('the violated constraint reaches the fix, so it names one index and not the idea of one', () => {
    const error = driverError('insert', serverError('23505', { constraint: 'users_email_key' }));

    expect(error.fix).toContain('users_email_key');
    expect(error.meta).toMatchObject({ sqlState: '23505', constraint: 'users_email_key' });
  });

  test('a constraint holding a $ pattern lands verbatim, never expanded into the fix', () => {
    // `$` is legal in a Postgres identifier, and `String.replace` expands `$&` / `$`` / `$'` / `$$`
    // inside a REPLACEMENT literal — so the server's own name spliced the matched placeholder back
    // into the line an author is meant to paste.
    const named = 'posts_$&_$`_$$_key';
    const error = driverError('insert', serverError('23505', { constraint: named }));
    expect(error.fix).toContain(named);
    expect(error.fix).not.toContain('{constraint}');
  });

  test('a driver that named no constraint still produces a fix that reads', () => {
    const error = driverError('insert', serverError('23505'));

    expect(error.fix).not.toContain('{constraint}');
    expect(error.fix).toContain('the constraint named in cause');
  });

  test('every classified state maps to its code, and each carries a distinct fix', () => {
    const fixes = new Map<string, string>();
    for (const [state, code] of Object.entries(DB_SQLSTATE_CODES)) {
      const error = driverError('statement failed', serverError(state));
      expect(error.code).toBe(code);
      expect(DB_ERROR_TITLES[code]).toBeString();
      fixes.set(code, error.fix);
    }
    // A fix repeated across two codes is the defect this table replaced, one level up.
    expect(new Set(fixes.values()).size).toBe(fixes.size);
  });

  test('a serialization failure names the retry option that exists', () => {
    const error = driverError('statement failed', serverError('40001'));

    expect(error.code).toBe('X_DB_SERIALIZATION_FAILURE');
    expect(error.fix).toContain('withTransaction(fn, { retry: 3 })');
  });

  test('an unclassified state, and a failure that never reached the server, stay X_DB_UNAVAILABLE', () => {
    expect(driverError('statement failed', serverError('42703')).code).toBe('X_DB_UNAVAILABLE');
    expect(driverError('could not connect', new Error('econnrefused')).code).toBe(
      'X_DB_UNAVAILABLE',
    );
    // Byte-for-byte the wording that shipped, because that code's meaning has not changed.
    expect(driverError('x', new Error('y')).fix).toBe(
      'set DATABASE_URL to a reachable Postgres url, or run `x dev` to use the embedded PGlite',
    );
  });

  test('--json carries the code and the fix, like every other Ultimate error', () => {
    const json = driverError('statement failed', serverError('57014')).toJSON();

    expect(json.code).toBe('X_DB_STATEMENT_TIMEOUT');
    expect(json.fix.length).toBeGreaterThan(0);
  });
});

describe('the pool and lock errors', () => {
  test('an acquire deadline names the pool size it exhausted', () => {
    const error = poolAcquireTimeout(5_000, 20);

    expect(error.code).toBe('X_DB_POOL_EXHAUSTED');
    expect(error.cause).toContain('5000ms');
    expect(error.cause).toContain('20');
    expect(error.fix).toContain('DATABASE_POOL_MAX');
  });

  test('a bad DATABASE_POOL_MAX refuses with the variable name in the fix', () => {
    const error = poolMaxInvalid('twenty');

    expect(error.code).toBe('X_ENV_MISSING');
    expect(error.cause).toContain('"twenty"');
    expect(error.fix).toStartWith('DATABASE_POOL_MAX=');
  });

  test('an exhausted retry budget names the count, because 4 in a row is a different problem', () => {
    const error = serializationExhausted(4, serverError('40001'));

    expect(error.code).toBe('X_DB_SERIALIZATION_FAILURE');
    expect(error.cause).toContain('all 4 attempts');
    expect(error.fix).toContain('retry: 8');
  });

  test('a held migration lock names the key and the wait, and its fix is runnable', () => {
    const error = migrateConcurrent(4_919_202_607, 60_000);

    expect(error.code).toBe('X_MIGRATE_CONCURRENT');
    expect(error.cause).toContain('4919202607');
    expect(error.cause).toContain('60000ms');
    expect(error.fix).toStartWith('psql "$DATABASE_URL"');
    expect(error.fix).toContain('pg_terminate_backend');
  });
});

describe('the registry', () => {
  test('every owned code has a title', () => {
    for (const [code, title] of Object.entries(DB_ERROR_TITLES)) {
      expect(code).toStartWith('X_');
      expect(title.length).toBeGreaterThan(0);
    }
  });
});
