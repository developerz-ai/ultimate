// The retry budget `withTransaction` opens against: what a lost serialization race re-runs, what
// it refuses to re-run, and what a budget that is not a whole count does before anything opens.
// Its own file because `transaction.test.ts` is at the 500-line ceiling.

import { beforeEach, describe, expect, test } from 'bun:test';
import { setDbClient } from './client';
import { type DbError, driverError } from './errors';
import { createRecordingClient, type RecordingClient } from './fake';
import { withTransaction } from './transaction';

let client: RecordingClient;

beforeEach(() => {
  client = createRecordingClient();
  setDbClient(client);
});

describe('retry', () => {
  /** A driver failure as the funnel produces one: typed, with the server's SQLSTATE underneath. */
  const serialization = (): unknown =>
    driverError(
      'statement failed: update ledger',
      Object.assign(new Error('could not serialize access'), {
        code: 'ERR_POSTGRES_SERVER_ERROR',
        errno: '40001',
      }),
    );

  test('no retry by default, so adding the option changed nothing that already shipped', async () => {
    let attempts = 0;

    const caught = (await withTransaction(async () => {
      attempts += 1;
      throw serialization();
    }).catch((error: unknown) => error)) as DbError;

    expect(attempts).toBe(1);
    expect(caught.code).toBe('X_DB_SERIALIZATION_FAILURE');
    // The driver's own error, unwrapped: nothing was exhausted, so the instruction is "add a
    // budget", never "raise the one you have".
    expect(caught.fix).toContain('withTransaction(fn, { retry: 3 })');
    expect(caught.cause).not.toContain('attempts');
  });

  test('a lost serialization race re-runs fn from the top and can succeed', async () => {
    // Under SERIALIZABLE a 40001 is normal traffic: at 200 tps ~3% of transactions hit one, and
    // before this every one of them surfaced to the user as "cannot reach the database".
    let attempts = 0;

    const result = await withTransaction(
      async () => {
        attempts += 1;
        if (attempts < 3) throw serialization();
        return 'committed';
      },
      { retry: 3, isolation: 'serializable' },
    );

    expect(result).toBe('committed');
    expect(attempts).toBe(3);
    expect(client.texts.filter((text) => text.startsWith('BEGIN'))).toHaveLength(3);
    expect(client.texts.filter((text) => text === 'ROLLBACK')).toHaveLength(2);
    expect(client.texts.filter((text) => text === 'COMMIT')).toHaveLength(1);
  });

  test('the undos of a failed attempt fire before the next one starts', async () => {
    const order: string[] = [];
    let attempts = 0;

    await withTransaction(
      async (tx) => {
        attempts += 1;
        order.push(`attempt ${attempts}`);
        tx.onRollback(() => order.push(`undo ${attempts}`));
        if (attempts === 1) throw serialization();
      },
      { retry: 1 },
    );

    // An undo that ran after the retry had already started would be reverting the retry's work.
    expect(order).toEqual(['attempt 1', 'undo 1', 'attempt 2']);
  });

  test('anything that is not a serialization failure is thrown on the first attempt', async () => {
    let attempts = 0;
    const unique = driverError(
      'statement failed: insert into users',
      Object.assign(new Error('duplicate key'), {
        code: 'ERR_POSTGRES_SERVER_ERROR',
        errno: '23505',
      }),
    );

    await expect(
      withTransaction(
        async () => {
          attempts += 1;
          throw unique;
        },
        { retry: 5 },
      ),
    ).rejects.toBe(unique);

    // Re-running a unique violation produces the same unique violation, five more times.
    expect(attempts).toBe(1);
  });

  test('an exhausted budget names the attempt count and keeps the last driver error', async () => {
    let attempts = 0;

    const caught = await withTransaction(
      async () => {
        attempts += 1;
        throw serialization();
      },
      { retry: 2 },
    ).catch((error: unknown) => error as DbError);

    expect(attempts).toBe(3);
    expect(caught.code).toBe('X_DB_SERIALIZATION_FAILURE');
    expect(caught.cause).toContain('all 3 attempts');
    expect(caught.meta).toMatchObject({ attempts: 3 });
  });

  test('retry inside another transaction is refused, never silently dropped', async () => {
    // Measured against Postgres 17: a 40001 aborts the WHOLE transaction, so the
    // `ROLLBACK TO SAVEPOINT` that would start attempt two answers `25P01`. There is nothing to
    // retry into, and an author who believes they have a budget they do not have is worse off.
    await expect(
      withTransaction(async () => {
        await withTransaction(async () => undefined, { retry: 3 });
      }),
    ).rejects.toThrow('X_INVARIANT');
  });

  test('a retry budget that is not a whole count is refused before the BEGIN', async () => {
    // `attempts = retry + 1` made the loop body unreachable for anything <= -1: `fn` ran ZERO
    // times, nothing was opened, and the caller got X_DB_SERIALIZATION_FAILURE reading "lost its
    // serialization race on all 0 attempts" for a transaction that never existed. `NaN` is the
    // arrival that matters — it is `Number(process.env.DB_RETRY)` when the var is unset.
    for (const retry of [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      let ran = 0;
      const caught = (await withTransaction(
        async () => {
          ran += 1;
        },
        { retry },
      ).catch((error: unknown) => error)) as DbError;

      expect(caught.code).toBe('X_INVARIANT');
      expect(ran).toBe(0);
      expect(client.texts).toEqual([]);
    }
  });

  test('retry: 0 nested is fine — it is the default, not a request', async () => {
    await withTransaction(async () => {
      await withTransaction(async () => undefined, { retry: 0 });
    });

    expect(client.texts).toContain('SAVEPOINT x_sp_1');
  });
});
