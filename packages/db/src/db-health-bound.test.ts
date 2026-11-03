// Single responsibility (`pooler.ts`): reading the two bounds off a session, and the verdict on that reading.
// The verdict decides whether a fleet logs an error line at every boot, so both of its readings
// are pinned: with no pooler any difference counts, with one only a bound that is gone.

import { describe, expect, test } from 'bun:test';
import type { DbClient } from './client';
import { POOL_PROFILES } from './pool-profile';
import { lostStatementBound, type StatementBound, statementBound } from './pooler';

const reading = (statement: number, idle: number): StatementBound => ({
  statementTimeout: { applied: statement, expected: 10_000 },
  idleInTransaction: { applied: idle, expected: 30_000 },
});

const sessionReading = (statement: string, idle: string): DbClient =>
  ({
    query: async () => [
      { name: 'idle_in_transaction_session_timeout', setting: idle },
      { name: 'statement_timeout', setting: statement },
    ],
  }) as unknown as DbClient;

describe('statementBound', () => {
  test('answers both settings beside the role, in milliseconds', async () => {
    const bound = await statementBound({
      ...sessionReading('10000', '0'),
      profile: POOL_PROFILES.web,
    });

    expect(bound).toEqual({
      statementTimeout: { applied: 10_000, expected: 10_000 },
      idleInTransaction: { applied: 0, expected: 30_000 },
    });
  });
});

describe('lostStatementBound', () => {
  test('with no pooler, the values sent and read back agree: nothing to report', () => {
    expect(lostStatementBound(reading(10_000, 30_000), 'web', undefined)).toBeUndefined();
  });

  test('with no pooler, a dropped bound is reported, each setting named', () => {
    const error = lostStatementBound(reading(0, 0), 'web', undefined);

    expect(error?.code).toBe('X_DB_STATEMENT_BOUND_LOST');
    expect(error?.cause).toContain('statement_timeout is 0ms');
    expect(error?.cause).toContain('idle_in_transaction_session_timeout is 0ms');
  });

  test('with no pooler, a raised bound is reported too: it is still not the bound of the role', () => {
    const cause = lostStatementBound(reading(10_000, 60_000), 'web', undefined)?.cause ?? '';

    expect(cause).toStartWith(
      'idle_in_transaction_session_timeout is 60000ms, the web role expects 30000ms.',
    );
    expect(cause).not.toContain('statement_timeout is');
  });

  test.each(['session', 'transaction'] as const)(
    'under %s, an alter role the role does not match is still a bound',
    (pooler) => {
      expect(lostStatementBound(reading(15_000, 90_000), 'web', pooler)).toBeUndefined();
    },
  );

  test.each(['session', 'transaction'] as const)('under %s, a 0 is lost', (pooler) => {
    expect(lostStatementBound(reading(10_000, 0), 'web', pooler)?.code).toBe(
      'X_DB_STATEMENT_BOUND_LOST',
    );
  });

  test('a role with no bound of its own loses none at 0, pooler or not', () => {
    const unbounded: StatementBound = {
      statementTimeout: { applied: 0, expected: 0 },
      idleInTransaction: { applied: 0, expected: 0 },
    };

    expect(lostStatementBound(unbounded, 'migrate', 'session')).toBeUndefined();
    expect(lostStatementBound(unbounded, 'migrate', undefined)).toBeUndefined();
  });
});
