// `x doctor`'s statement bound, the rule half: what a reading becomes, and the one line a worker on
// a transaction pooler owes. The I/O half runs in `doctor-pooler-probe` below against no socket.

import { describe, expect, test } from 'bun:test';
import { codes, probe } from './cmd-doctor-fixture';
import {
  NO_POOLER_FACT,
  type PoolerFact,
  poolerFindings,
  poolerProbe,
  withPoolerReport,
} from './doctor-pooler';
import type { CommandResult } from './output';

const result: CommandResult = { ok: true, command: 'doctor', summary: 's', data: { count: 0 } };

const fact = (over: Partial<PoolerFact> = {}): PoolerFact => ({
  role: 'web',
  pooler: 'transaction',
  bound: {
    statementTimeout: { applied: 10_000, expected: 10_000 },
    idleInTransaction: { applied: 30_000, expected: 30_000 },
  },
  refused: undefined,
  ...over,
});

const LOST = {
  statementTimeout: { applied: 0, expected: 10_000 },
  idleInTransaction: { applied: 0, expected: 30_000 },
};

describe('poolerFindings', () => {
  test('a bound in force is nothing', () => {
    expect(poolerFindings(fact())).toEqual([]);
  });

  test('a bound gone under a pooler is X_DB_STATEMENT_BOUND_LOST', () => {
    expect(poolerFindings(fact({ bound: LOST })).map((entry) => entry.code)).toEqual([
      'X_DB_STATEMENT_BOUND_LOST',
    ]);
  });

  test('a bound gone with no switch set is the same finding, and its fix names the switch', () => {
    const [finding] = poolerFindings(fact({ bound: LOST, pooler: undefined }));

    expect(finding?.code).toBe('X_DB_STATEMENT_BOUND_LOST');
    expect(finding?.fix).toContain('DATABASE_POOLER');
  });

  test('nothing read is nothing to say', () => {
    expect(poolerFindings(NO_POOLER_FACT)).toEqual([]);
  });
});

describe('runDoctor', () => {
  const REFUSED = {
    code: 'X_DB_POOLER_OPTIONS_REFUSED',
    cause: 'unsupported startup parameter',
    fix: 'DATABASE_POOLER=transaction',
  };

  test('a pooler refusal is one finding, not also an unavailable database', async () => {
    const answered = await codes(
      probe({
        pooler: async () => ({ ...NO_POOLER_FACT, refused: REFUSED }),
        database: async () => ({
          code: 'X_DB_UNAVAILABLE',
          cause: 'does not answer',
          fix: 'set DATABASE_URL',
        }),
      }),
    );

    expect(answered).toEqual(['X_DB_POOLER_OPTIONS_REFUSED']);
  });

  test('with no refusal, the database is still asked', async () => {
    const answered = await codes(
      probe({
        database: async () => ({ code: 'X_DB_UNAVAILABLE', cause: 'c', fix: 'f' }),
      }),
    );

    expect(answered).toEqual(['X_DB_UNAVAILABLE']);
  });
});

describe('withPoolerReport', () => {
  test('reports the applied bound through a pooler, and leaves the verdict alone', () => {
    const reported = withPoolerReport(result, fact());

    expect(reported.ok).toBe(true);
    expect(reported.data).toEqual({
      count: 0,
      statementBound: {
        role: 'web',
        pooler: 'transaction',
        statementTimeout: { appliedMs: 10_000, expectedMs: 10_000 },
        idleInTransaction: { appliedMs: 30_000, expectedMs: 30_000 },
      },
    });
    expect(reported.lines?.join('\n')).toContain('statement_timeout 10000 ms');
  });

  test('a worker under transaction is told the wake is off, in data and in a line', () => {
    const reported = withPoolerReport(result, fact({ role: 'worker' }));

    expect((reported.data as { wake?: unknown }).wake).toEqual({
      off: true,
      pickupWithinMs: 2_000,
    });
    expect(reported.lines?.join('\n')).toContain('wake off, pickup within idlePollMaxMs');
  });

  test.each([
    ['worker', 'session'],
    ['worker', undefined],
    ['web', 'transaction'],
  ] as const)('%s under %s keeps its wake, and says nothing about one', (role, pooler) => {
    const reported = withPoolerReport(result, fact({ role, pooler }));

    expect((reported.data as { wake?: unknown }).wake).toBeUndefined();
  });

  test('with no pooler the bound is data, and the page stays quiet', () => {
    const reported = withPoolerReport(result, fact({ pooler: undefined }));

    expect((reported.data as { statementBound?: unknown }).statementBound).toBeDefined();
    expect(reported.lines ?? []).toEqual([]);
  });

  test('nothing read adds nothing', () => {
    expect(withPoolerReport(result, NO_POOLER_FACT)).toEqual(result);
  });
});

describe('poolerProbe, before any socket', () => {
  const URL = 'postgres://app@127.0.0.1:1/app';

  test('no DATABASE_URL is no fact', async () => {
    expect(await poolerProbe(undefined, {})).toEqual(NO_POOLER_FACT);
    expect(await poolerProbe('  ', { DATABASE_POOLER: 'transaction' })).toEqual(NO_POOLER_FACT);
  });

  test('a typo in the switch is a refusal, with core code', async () => {
    const answered = await poolerProbe(URL, { DATABASE_POOLER: 'txn' });

    expect(answered.refused?.code).toBe('X_ENV_MISSING');
  });

  test('ROLE=migrate under transaction is the refusal the role would boot into', async () => {
    const answered = await poolerProbe(URL, { ROLE: 'migrate', DATABASE_POOLER: 'transaction' });

    expect(answered.refused?.code).toBe('X_DB_POOLER_SESSION_REQUIRED');
  });

  test('an unreachable server is the database probe finding, not this one', async () => {
    const answered = await poolerProbe(URL, { DATABASE_POOLER: 'transaction', ROLE: 'web' });

    expect(answered.refused).toBeUndefined();
    expect(answered.bound).toBeUndefined();
    expect(answered.pooler).toBe('transaction');
  });
});
