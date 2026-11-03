// Single responsibility: which code a pooler's refusal and a server-closed idle transaction become.
// `08P01` is the wire protocol's general complaint, so the code rests on the pooler's own words, and
// the fix on the code: a generic "fix the SQL" reads as nonsense to the operator of a healthy query.

import { describe, expect, test } from 'bun:test';
import { DbError, driverError } from './errors';
import { poolerSessionRequired, statementBoundLost } from './pooler';

const serverError = (errno: string, message: string): object => ({
  name: 'PostgresError',
  code: 'ERR_POSTGRES_SERVER_ERROR',
  errno,
  severity: 'FATAL',
  message,
});

describe('driverError · a pooler refusing libpq options at startup', () => {
  test('the sentence a stock pooler answers is the new code, with the alter role line', () => {
    const error = driverError(
      'select 1',
      serverError('08P01', 'unsupported startup parameter in options: statement_timeout'),
    );

    expect(error).toBeInstanceOf(DbError);
    expect(error.code).toBe('X_DB_POOLER_OPTIONS_REFUSED');
    expect(error.fix).toContain('DATABASE_POOLER=transaction');
    expect(error.fix).toContain("alter role <user> set statement_timeout = '10s'");
    expect(error.fix).toContain(
      "alter role <user> set idle_in_transaction_session_timeout = '30s'",
    );
    expect(error.meta?.['sqlState']).toBe('08P01');
  });

  test('a startup parameter named outside options is the same refusal', () => {
    const error = driverError(
      'select 1',
      serverError('08P01', 'unsupported startup parameter: statement_timeout'),
    );

    expect(error.code).toBe('X_DB_POOLER_OPTIONS_REFUSED');
  });

  test('an option of the operator own is named in the URL, never answered with the switch', () => {
    const error = driverError(
      'select 1',
      serverError('08P01', 'unsupported startup parameter in options: lock_timeout'),
    );

    expect(error.code).toBe('X_DB_POOLER_OPTIONS_REFUSED');
    expect(error.fix).toContain('-c lock_timeout=');
    expect(error.fix).toContain("DATABASE_URL's options");
    expect(error.fix).not.toContain('DATABASE_POOLER=transaction');
  });

  test('a parameter name that is not an identifier is left out of the fix', () => {
    const error = driverError(
      'select 1',
      serverError('08P01', 'unsupported startup parameter in options: x;rm'),
    );

    expect(error.fix).not.toContain('x;rm');
    expect(error.fix).toContain("DATABASE_URL's options");
  });

  test('another 08P01 stays the server verdict it always was', () => {
    const error = driverError('select 1', serverError('08P01', 'invalid message format'));

    expect(error.code).toBe('X_DB_STATEMENT_FAILED');
    expect(error.fix).not.toContain('DATABASE_POOLER');
  });

  test('those words under another SQLSTATE are not the pooler', () => {
    const error = driverError(
      'select 1',
      serverError('42601', 'unsupported startup parameter in options: x'),
    );

    expect(error.code).toBe('X_DB_STATEMENT_FAILED');
  });
});

describe('driverError · 25P03, the server closing an idle transaction', () => {
  test('stays X_DB_STATEMENT_FAILED, and the fix names the slow await', () => {
    const error = driverError(
      'select 1',
      serverError('25P03', 'terminating connection due to idle-in-transaction timeout'),
    );

    expect(error.code).toBe('X_DB_STATEMENT_FAILED');
    expect(error.cause).toContain('idle');
    expect(error.fix).toContain('before opening the transaction');
    expect(error.fix).not.toContain('fix the SQL');
  });
});

describe('the two pooler refusals built by hand', () => {
  test('X_DB_POOLER_SESSION_REQUIRED names who was refused and the way out', () => {
    const error = poolerSessionRequired('ROLE=migrate');

    expect(error.code).toBe('X_DB_POOLER_SESSION_REQUIRED');
    expect(error.cause).toContain('ROLE=migrate');
    expect(error.fix).toContain('DATABASE_URL');
    expect(error.fix).toContain('unset DATABASE_POOLER');
  });

  test('X_DB_STATEMENT_BOUND_LOST carries both readings of each setting lost', () => {
    const error = statementBoundLost('web', [
      { setting: 'statement_timeout', appliedMs: 0, expectedMs: 10_000 },
    ]);

    expect(error.code).toBe('X_DB_STATEMENT_BOUND_LOST');
    expect(error.cause).toContain('statement_timeout is 0ms, the web role expects 10000ms');
    expect(error.fix).toContain("alter role <user> set statement_timeout = '10s'");
    expect(error.fix).toContain('DATABASE_POOLER');
    // What a lost bound costs besides the bound: the unanswered-statement deadline still runs on the
    // profile's number, so a long healthy statement is taken for a dead path.
    expect(error.cause).toContain('X_DB_UNAVAILABLE');
    expect(error.cause).toContain('the pool is replaced');
  });
});
