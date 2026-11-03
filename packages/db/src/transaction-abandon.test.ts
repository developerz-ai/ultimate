// A transaction whose caller was already answered does not land. A signal aborted with a CODED
// reason (the request deadline, a job's cancellation) rolls it back; an uncoded one (a client
// hang-up) changes nothing; `runToCompletion` and `completeTransaction` are the two ways through.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, runToCompletion, runWithContext, UltimateError } from '@ultimat3/core';
import { type DbClient, db, setDbClient } from './client';
import { pgliteClient } from './pglite';
import { type SqlFragment, sql } from './sql';
import { completeTransaction, withTransaction } from './transaction';
import { refuseAbandoned } from './transaction-guard';

const PGLITE_BOOT_MS = 30_000;

const timedOut = (): UltimateError =>
  new UltimateError({ code: 'X_TIMEOUT', cause: 'past the deadline', fix: 'raise it' });

const hangUp = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

/** A context whose signal the test fires, and the statements the transaction put on the wire. */
const scope = (): {
  readonly abort: (reason: unknown) => void;
  run<T>(fn: () => T): T;
} => {
  const controller = new AbortController();
  const ctx = ctxOf({ signal: controller.signal });
  return {
    abort: (reason) => controller.abort(reason),
    run: (fn) => runWithContext(ctx, fn),
  };
};

/** `client`, recording the text of every statement a pin sends. */
const spying = (client: DbClient & { reserve(): Promise<unknown> }, sent: string[]) => {
  const reserve = client.reserve.bind(client) as () => Promise<DbClient & Disposable>;
  return new Proxy(client, {
    get(target, member, receiver) {
      if (member !== 'reserve') return Reflect.get(target, member, receiver);
      return async () => {
        const pin = await reserve();
        return new Proxy(pin, {
          get(inner, name, innerReceiver) {
            const value = Reflect.get(inner, name, innerReceiver);
            if (name !== 'execute') return typeof value === 'function' ? value.bind(inner) : value;
            return (fragment: SqlFragment) => {
              sent.push(fragment.text);
              return inner.execute(fragment);
            };
          },
        });
      };
    },
  });
};

describe('a transaction whose scope was abandoned', () => {
  const client = pgliteClient();
  const count = async (): Promise<number> => {
    const rows = await client.query<{ total: number }>(
      sql`select count(*)::int as total from abandon_rows`,
    );
    return rows[0]?.total ?? -1;
  };

  beforeEach(async () => {
    setDbClient(client);
    await client.execute(sql`drop table if exists abandon_rows`);
    await client.execute(sql`create table abandon_rows (id int primary key)`);
  }, PGLITE_BOOT_MS);

  afterAll(async () => {
    setDbClient(undefined);
    await client.close();
  });

  const insert = (id: number) => db().execute(sql`insert into abandon_rows values (${id})`);

  test('a coded abort mid-body throws the signal reason, leaves 0 rows, and ROLLBACK is sent', async () => {
    const reason = timedOut();
    const request = scope();
    const sent: string[] = [];
    const error = await request.run(() =>
      withTransaction(
        async () => {
          await insert(1);
          request.abort(reason);
          await insert(2);
        },
        { client: spying(client, sent) },
      ).catch((thrown: unknown) => thrown),
    );
    expect(error).toBe(reason);
    expect(await count()).toBe(0);
    expect(sent.at(-1)).toBe('ROLLBACK');
    expect(sent).not.toContain('COMMIT');
  });

  test('an uncoded abort commits: a client hang-up must keep landing', async () => {
    const request = scope();
    await request.run(() =>
      withTransaction(
        async () => {
          await insert(1);
          request.abort(hangUp());
          await insert(2);
        },
        { client },
      ),
    );
    expect(await count()).toBe(2);
  });

  test('an abort between the last statement and COMMIT rolls back', async () => {
    const reason = timedOut();
    const request = scope();
    const error = await request.run(() =>
      withTransaction(
        async () => {
          await insert(1);
          request.abort(reason);
        },
        { client },
      ).catch((thrown: unknown) => thrown),
    );
    expect(error).toBe(reason);
    expect(await count()).toBe(0);
  });

  test('an abandoned scope opens nothing: no pin, no BEGIN', async () => {
    const reason = timedOut();
    const request = scope();
    request.abort(reason);
    const sent: string[] = [];
    const error = await request.run(() =>
      withTransaction(() => insert(1), { client: spying(client, sent) }).catch(
        (thrown: unknown) => thrown,
      ),
    );
    expect(error).toBe(reason);
    expect(sent).toEqual([]);
  });

  test('a nested scope refuses before it takes its turn; the failure rolls the root back', async () => {
    const reason = timedOut();
    const request = scope();
    const sent: string[] = [];
    const error = await request.run(() =>
      withTransaction(
        async () => {
          await insert(1);
          request.abort(reason);
          await withTransaction(() => insert(2));
        },
        { client: spying(client, sent) },
      ).catch((thrown: unknown) => thrown),
    );
    expect(error).toBe(reason);
    expect(sent.some((text) => text.startsWith('SAVEPOINT'))).toBe(false);
    expect(await count()).toBe(0);
  });

  test('a nested scope abandoned mid-body still answers ROLLBACK TO', async () => {
    const reason = timedOut();
    const request = scope();
    const sent: string[] = [];
    await request
      .run(() =>
        withTransaction(
          () =>
            withTransaction(async () => {
              await insert(1);
              request.abort(reason);
              await insert(2);
            }),
          { client: spying(client, sent) },
        ),
      )
      .catch(() => undefined);
    expect(sent.some((text) => text.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
    expect(await count()).toBe(0);
  });

  test('runToCompletion commits: the abort outside it does not reach the unit of work', async () => {
    const request = scope();
    await request.run(() => {
      request.abort(timedOut());
      return runToCompletion(() =>
        withTransaction(
          async () => {
            await insert(1);
            await insert(2);
          },
          { client },
        ),
      );
    });
    expect(await count()).toBe(2);
  });

  test('the pool stays unguarded: a statement outside any transaction is not this file’s to refuse', async () => {
    // `runOn` is how `settleFailure` and a job step's fenced write send past the abort.
    const request = scope();
    request.abort(timedOut());
    await request.run(() => client.execute(sql`insert into abandon_rows values (1)`));
    expect(await count()).toBe(1);
  });
});

describe('completeTransaction', () => {
  const client = pgliteClient();
  const count = async (): Promise<number> => {
    const rows = await client.query<{ total: number }>(
      sql`select count(*)::int as total from complete_rows`,
    );
    return rows[0]?.total ?? -1;
  };

  beforeEach(async () => {
    setDbClient(client);
    await client.execute(sql`drop table if exists complete_rows`);
    await client.execute(sql`create table complete_rows (id int primary key)`);
  }, PGLITE_BOOT_MS);

  afterAll(async () => {
    setDbClient(undefined);
    await client.close();
  });

  const insert = (id: number) => db().execute(sql`insert into complete_rows values (${id})`);

  test('a marked root runs its statements, its nested scopes and its COMMIT past the abort', async () => {
    const request = scope();
    await request.run(() =>
      withTransaction(
        async () => {
          completeTransaction();
          request.abort(timedOut());
          await insert(1);
          await withTransaction(() => insert(2));
          // The check a write path outside the handle asks answers the same.
          expect(() => refuseAbandoned()).not.toThrow();
        },
        { client },
      ),
    );
    expect(await count()).toBe(2);
  });

  test('called in a nested scope it marks the root', async () => {
    const request = scope();
    await request.run(() =>
      withTransaction(
        async () => {
          await withTransaction(async () => {
            completeTransaction();
            await insert(1);
          });
          request.abort(timedOut());
          await insert(2);
        },
        { client },
      ),
    );
    expect(await count()).toBe(2);
  });

  test('a retry attempt starts unmarked', async () => {
    const reason = timedOut();
    const request = scope();
    let attempt = 0;
    const error = await request.run(() =>
      withTransaction(
        async () => {
          attempt += 1;
          if (attempt === 1) {
            completeTransaction();
            throw Object.assign(new RangeError('lost the race'), {
              errno: '40001',
              severity: 'ERROR',
            });
          }
          // Attempt two: nothing marked it, so the abort stands.
          request.abort(reason);
          await insert(1);
        },
        { client, retry: 1, sleep: () => Promise.resolve() },
      ).catch((thrown: unknown) => thrown),
    );
    expect(attempt).toBe(2);
    expect(error).toBe(reason);
    expect(await count()).toBe(0);
  });

  test('outside a transaction it does nothing, and refuseAbandoned still refuses', async () => {
    const reason = timedOut();
    const request = scope();
    request.abort(reason);
    request.run(() => {
      completeTransaction();
      expect(() => refuseAbandoned()).toThrow(reason);
    });
  });

  test('a finished root does not stay exempt: its straggler is refused', async () => {
    const request = scope();
    const ended = Promise.withResolvers<void>();
    let late: Promise<unknown> = Promise.resolve();
    await request.run(() =>
      withTransaction(
        async () => {
          completeTransaction();
          late = ended.promise.then(() => insert(1));
          late.catch(() => undefined);
        },
        { client },
      ),
    );
    ended.resolve();
    const error = (await late.catch((thrown: unknown) => thrown)) as { code?: string };
    expect(error.code).toBe('X_DB_TRANSACTION_CLOSED');
    expect(await count()).toBe(0);
  });
});
