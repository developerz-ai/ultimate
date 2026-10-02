// Single responsibility: the SQLSTATE reader and its closed table. The shapes below are MEASURED,
// not imagined — `bun 1.3.14` against Postgres 17 and `@electric-sql/pglite` — because the bug this
// file exists to prevent is a reader that works on one driver and silently answers `false` on the
// other.

import { describe, expect, test } from 'bun:test';
import { DB_SQLSTATE_CODES, isRetryableState, SQLSTATE, sqlState, sqlStateCode } from './sqlstate';

/**
 * What `Bun.SQL` actually throws: `code` is the literal `ERR_POSTGRES_SERVER_ERROR` for every
 * server error and the SQLSTATE lives on `errno`. Reading `code` is the whole defect.
 */
const bunSqlError = (state: string, extra: Record<string, unknown> = {}): unknown =>
  Object.assign(new Error('server said no'), {
    name: 'PostgresError',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: state,
    ...extra,
  });

/** What PGlite throws — node-postgres' protocol, SQLSTATE on `code`, no `errno` at all. */
const pgliteError = (state: string): unknown =>
  Object.assign(new Error('server said no'), { name: 'error', code: state });

describe('sqlState', () => {
  test("reads Bun.SQL's errno, not its code — the code is never a SQLSTATE", () => {
    // The failure case first: before this, `code` was the only field read, so every production
    // Postgres answered `undefined` here and a missing ledger read as an unreachable database.
    expect(sqlState(bunSqlError(SQLSTATE.undefinedTable))).toBe('42P01');
    expect(sqlState(bunSqlError('23505'))).toBe('23505');
  });

  test("reads PGlite's code, so the embedded driver keeps working", () => {
    expect(sqlState(pgliteError('42P01'))).toBe('42P01');
  });

  test('unwraps the DbError the driver funnel already built', () => {
    const wrapped = { code: 'X_DB_UNAVAILABLE', sourceError: bunSqlError('40001') };
    expect(sqlState(wrapped)).toBe('40001');
  });

  test('a failure that never reached the server has no state', () => {
    expect(
      sqlState(Object.assign(new Error('closed'), { code: 'ERR_POSTGRES_CONNECTION_CLOSED' })),
    ).toBeUndefined();
    expect(sqlState(new Error('econnrefused'))).toBeUndefined();
    expect(sqlState(undefined)).toBeUndefined();
    expect(sqlState('42P01')).toBeUndefined();
  });

  test('an Ultimate code is not mistaken for a SQLSTATE, whatever its length', () => {
    expect(sqlState({ code: 'X_DB_UNAVAILABLE' })).toBeUndefined();
    // Five characters, but an underscore — no SQLSTATE has one.
    expect(sqlState({ code: 'X_A_B' })).toBeUndefined();
  });

  test('a value that fights being read answers undefined rather than throwing', () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error('nope');
        },
      },
    );
    expect(sqlState(hostile)).toBeUndefined();
  });

  test('stops rather than following a cycle', () => {
    const loop: { sourceError?: unknown } = {};
    loop.sourceError = loop;
    expect(sqlState(loop)).toBeUndefined();
  });
});

describe('sqlStateCode', () => {
  test('an unclassified state is undefined — driverError decides what that means', () => {
    // `42601` (syntax_error) has no row: the server answered, so `driverError` reports
    // X_DB_STATEMENT_FAILED rather than unavailability, but that is its call and not this table's.
    expect(sqlStateCode(bunSqlError('42601'))).toBeUndefined();
    expect(sqlStateCode(new Error('no socket'))).toBeUndefined();
  });

  test('every state in the table classifies, and nothing else does', () => {
    expect(sqlStateCode(bunSqlError('42P01'))).toBe('X_DB_SCHEMA_STALE');
    expect(sqlStateCode(bunSqlError('42703'))).toBe('X_DB_SCHEMA_STALE');
    expect(sqlStateCode(bunSqlError('23505'))).toBe('X_DB_UNIQUE_VIOLATION');
    expect(sqlStateCode(bunSqlError('23503'))).toBe('X_DB_FOREIGN_KEY_VIOLATION');
    expect(sqlStateCode(bunSqlError('40001'))).toBe('X_DB_SERIALIZATION_FAILURE');
    expect(sqlStateCode(bunSqlError('40P01'))).toBe('X_DB_SERIALIZATION_FAILURE');
    expect(sqlStateCode(bunSqlError('57014'))).toBe('X_DB_STATEMENT_TIMEOUT');
    expect(sqlStateCode(bunSqlError('55P03'))).toBe('X_DB_LOCK_TIMEOUT');
    expect(sqlStateCode(bunSqlError('53300'))).toBe('X_DB_POOL_EXHAUSTED');
    expect(sqlStateCode(bunSqlError('53200'))).toBe('X_DB_POOL_EXHAUSTED');
  });

  test('the table is closed — a new state is a new row here, never a new catch', () => {
    expect(Object.keys(DB_SQLSTATE_CODES).sort()).toEqual([
      '23503',
      '23505',
      '40001',
      '40P01',
      '42703',
      '42P01',
      '53200',
      '53300',
      '55P03',
      '57014',
    ]);
  });
});

describe('a SQLSTATE is told from an errno by PROVENANCE', () => {
  // What a server ErrorResponse looks like on each driver, measured against Postgres 17 and
  // PGlite: both carry `severity`, and only a server error does.
  const fromServer = (field: 'errno' | 'code', state: string): unknown => ({
    [field]: state,
    severity: 'ERROR',
    routine: 'exec_stmt_raise',
  });
  /** What the socket layer throws: a NAME on `code`, a NUMBER on `errno`, and the syscall. */
  const fromSocket = (name: string): unknown => ({ code: name, errno: -32, syscall: 'write' });

  // `raise exception … using errcode = 'ABCDE'` is legal, and so is every five-LETTER state: a
  // shape rule demanding a digit turned the server's own refusal into "cannot reach the database".
  test('a five-letter state the SERVER sent is the server refusal, on either field', () => {
    expect(sqlState(fromServer('errno', 'ABCDE'))).toBe('ABCDE');
    expect(sqlState(fromServer('code', 'ABCDE'))).toBe('ABCDE');
    expect(
      sqlState({ code: 'X_DB_STATEMENT_FAILED', sourceError: fromServer('code', 'EPIPE') }),
    ).toBe('EPIPE');
  });

  // Five uppercase letters with nothing saying a server sent them is what an errno NAME looks
  // like. Read as a state, `EPIPE` became `X_DB_STATEMENT_FAILED` — "fix the SQL" — for a dead
  // socket, and the replica fallback, which keys on unavailability, never ran.
  test.each(['EPIPE', 'EINTR', 'EPERM', 'ENXIO'])(
    '%s with no provenance is not a state',
    (name) => {
      expect(sqlState({ code: name })).toBeUndefined();
      expect(sqlState({ errno: name })).toBeUndefined();
      expect(sqlState(fromSocket(name))).toBeUndefined();
    },
  );

  // `E2BIG` carries a digit, so a digit alone proves nothing: the syscall beside it does.
  test('an errno that happens to carry a digit is still the socket layer', () => {
    expect(sqlState(fromSocket('E2BIG'))).toBeUndefined();
    expect(sqlState({ code: 'E2BIG', syscall: 'spawn' })).toBeUndefined();
  });

  test.each(['42P01', 'XX000', 'P0001', 'HV00A', '0A000'])('%s is still read unmarked', (state) => {
    expect(sqlState({ code: state })).toBe(state);
  });
});

describe('isRetryableState', () => {
  test('a unique violation is not retryable — re-running it fails identically', () => {
    expect(isRetryableState(bunSqlError('23505'))).toBe(false);
    expect(isRetryableState(bunSqlError('57014'))).toBe(false);
    expect(isRetryableState(new Error('the handler threw'))).toBe(false);
  });

  test('a serialization failure and a deadlock are', () => {
    expect(isRetryableState(bunSqlError('40001'))).toBe(true);
    expect(isRetryableState(bunSqlError('40P01'))).toBe(true);
  });
});
